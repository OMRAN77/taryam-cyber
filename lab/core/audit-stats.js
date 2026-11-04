// Distribution-based tests of an observed play log against the exact probability
// distribution (pmf) of a game's win per round, in units of the bet.
//
//  * Goodness of fit: G-test and Pearson chi-square over the pmf's outcomes, with
//    P-values from seeded multinomial Monte Carlo (valid at any sample size; enough
//    replicates to reach Holm's alpha / m), and the minimum detectable effect at the
//    data's size and that level.
//  * Hit and feature-trigger frequency: exact binomial tests with Clopper-Pearson
//    intervals; big wins seen less often than the pmf says (exact binomial tails);
//    the chance the top prize never appeared, and the rule of three.
//  * Version identification among 2-5 candidate pmfs (e.g. one game at 96/94/92%):
//    log-likelihoods, posterior, Wald's SPRT and its expected sample number (KL).
//  * "RTP below declared": a betting e-process (Waudby-Smith & Ramdas, 2023), valid
//    for any variance once the win per round is bounded by M, with an anytime-valid
//    upper confidence bound (running intersection of a confidence sequence).
//  * A planner: rounds each method needs, as a function of sigma and M.
//  * For information: the chance of a total (sum of win / bet) this low, by seeded
//    Monte Carlo with its standard error.
//
// Passing never certifies anything: it means "not rejected with this many rounds",
// and every result carries the smallest effect the data could have detected.
import { lgamma, chiSquareP, normalQuantile } from './specfun.js';
import { forEachCsvRow, findColumn, detectDelimiter } from './csv.js';
import { makeNumberReader, flagSet } from './actual.js';
import { Fraction } from './fraction.js';

export const MAX_CANDIDATES = 5;
const fail = (en, ar) => Object.assign(new Error(en), { ar, en });

// ---------- random numbers ----------

// Uniform double in [0, 1) with 53 random bits, from two 32-bit outputs.
export function uniform01(rng) {
  const a = rng.nextU32() >>> 5, b = rng.nextU32() >>> 6;
  return (a * 67108864 + b) / 9007199254740992;
}

// ---------- binomial distribution ----------

// ln(n!) - ln(sqrt(2 pi n) (n/e)^n), the error of Stirling's formula (Loader, 2000).
function stirlerr(n) {
  if (n <= 15) return lgamma(n + 1) - (n + 0.5) * Math.log(n) + n - 0.5 * Math.log(2 * Math.PI);
  const nn = n * n;
  return (1 / 12 - (1 / 360 - (1 / 1260 - (1 / 1680 - 1 / (1188 * nn)) / nn) / nn) / nn) / n;
}

// x ln(x / m) + m - x without cancellation when x is close to m (Loader, 2000).
function bd0(x, m) {
  if (Math.abs(x - m) < 0.1 * (x + m)) {
    const v = (x - m) / (x + m);
    let s = (x - m) * v, ej = 2 * x * v;
    const v2 = v * v;
    for (let j = 1; j < 1000; j++) {
      ej *= v2;
      const s1 = s + ej / (2 * j + 1);
      if (s1 === s) return s;
      s = s1;
    }
    return s;
  }
  return x * Math.log(x / m) + m - x;
}

// ln P(X = k) for X ~ Binomial(n, p), accurate to ~1e-15 relative even for n ~ 1e9.
export function logDbinom(k, n, p) {
  if (k < 0 || k > n) return -Infinity;
  if (p <= 0) return k === 0 ? 0 : -Infinity;
  if (p >= 1) return k === n ? 0 : -Infinity;
  if (k === 0) return n * Math.log1p(-p);
  if (k === n) return n * Math.log(p);
  return stirlerr(n) - stirlerr(k) - stirlerr(n - k) - bd0(k, n * p) - bd0(n - k, n * (1 - p))
    + 0.5 * Math.log(n / (2 * Math.PI * k * (n - k)));
}

// Sum of P(X = j) from j = k away from the mode, until the terms stop mattering.
function tailFrom(k, n, p, dir) {
  let f = Math.exp(logDbinom(k, n, p));
  if (f === 0) return 0;
  let s = f;
  if (dir < 0) {
    const r = (1 - p) / p;
    for (let j = k; j > 0; j--) { f *= (j / (n - j + 1)) * r; s += f; if (f <= s * 1e-17) break; }
  } else {
    const r = p / (1 - p);
    for (let j = k; j < n; j++) { f *= ((n - j) / (j + 1)) * r; s += f; if (f <= s * 1e-17) break; }
  }
  return s;
}

// P(X <= k) and P(X >= k) for X ~ Binomial(n, p). The tail away from the mode is
// summed term by term; the other side is 1 minus that tail, so neither cancels.
export function binomCdf(k, n, p) {
  if (k < 0) return 0;
  if (k >= n || p <= 0) return 1;
  if (p >= 1) return 0;
  const mode = Math.floor((n + 1) * p);
  return k < mode ? Math.min(1, tailFrom(k, n, p, -1)) : Math.max(0, 1 - tailFrom(k + 1, n, p, 1));
}

export function binomSf(k, n, p) {
  if (k <= 0) return 1;
  if (k > n || p <= 0) return 0;
  if (p >= 1) return 1;
  const mode = Math.floor((n + 1) * p);
  return k > mode ? Math.min(1, tailFrom(k, n, p, 1)) : Math.max(0, 1 - tailFrom(k - 1, n, p, -1));
}

// Two-sided exact P-value, twice the smaller tail: rejects at alpha exactly when p0
// is outside the Clopper-Pearson interval at 1 - alpha.
export function binomTwoSidedP(k, n, p0) {
  return Math.min(1, 2 * Math.min(binomCdf(k, n, p0), binomSf(k, n, p0)));
}

function bisect(f, lo, hi, increasing) {
  for (let i = 0; i < 300 && hi - lo > 1e-15 * hi; i++) {
    const mid = (lo + hi) / 2;
    if ((f(mid) < 0) === increasing) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

// Clopper-Pearson ("exact") interval for a binomial proportion at `confidence`.
export function clopperPearson(k, n, confidence = 0.95) {
  const a = (1 - confidence) / 2;
  const lower = k === 0 ? 0 : k === n ? Math.exp(Math.log(a) / n) : bisect((p) => binomSf(k, n, p) - a, 0, k / n, true);
  const upper = k === n ? 1 : k === 0 ? -Math.expm1(Math.log(a) / n) : bisect((p) => binomCdf(k, n, p) - a, k / n, 1, false);
  return [lower, upper];
}

// Binomial(n, p) variate, exact: inversion from 0 when the mean is small, otherwise
// inversion that starts at the mode and alternates outward (Kemp, 1986), so the work
// is about the standard deviation, not n.
export function sampleBinomial(rng, n, p) {
  if (n <= 0 || p <= 0) return 0;
  if (p >= 1) return n;
  if (p > 0.5) return n - sampleBinomial(rng, n, 1 - p);
  const r = p / (1 - p);
  if (n * p < 25) {
    const f0 = Math.exp(n * Math.log1p(-p));
    for (;;) {
      let u = uniform01(rng), f = f0;
      for (let k = 0; k <= n; k++) {
        if (u < f) return k;
        u -= f;
        f *= ((n - k) / (k + 1)) * r;
        if (f < 1e-300) break; // rounding left a sliver of [0, 1) uncovered: draw again
      }
    }
  }
  const m = Math.floor((n + 1) * p);
  const fm = Math.exp(logDbinom(m, n, p));
  const tiny = fm * 1e-20;
  for (;;) {
    let u = uniform01(rng) - fm;
    if (u < 0) return m;
    let lo = m, hi = m, flo = fm, fhi = fm;
    while (fhi > tiny || flo > tiny) {
      if (hi < n) { fhi *= ((n - hi) / (hi + 1)) * r; hi++; u -= fhi; if (u < 0) return hi; } else fhi = 0;
      if (lo > 0) { flo *= (lo / (n - lo + 1)) / r; lo--; u -= flo; if (u < 0) return lo; } else flo = 0;
    }
  }
}

// Multinomial(n, probs) by conditional binomials; returns a reusable sampler.
export function multinomialSampler(probs) {
  const K = probs.length;
  const cond = new Float64Array(K);
  let tail = 0;
  for (let j = K - 1; j >= 0; j--) { tail += probs[j]; cond[j] = tail > 0 ? Math.min(1, probs[j] / tail) : 0; }
  return (rng, n, out = new Float64Array(K)) => {
    let rem = n;
    for (let j = 0; j < K - 1; j++) { const c = rem > 0 ? sampleBinomial(rng, rem, cond[j]) : 0; out[j] = c; rem -= c; }
    out[K - 1] = rem;
    return out;
  };
}

// ---------- chi-square helpers ----------

// x with P(chi2_df > x) = alpha.
export function chiSquareQuantile(alpha, df) {
  let hi = df + 10 * Math.sqrt(2 * df) + 50;
  while (chiSquareP(hi, df) > alpha) hi *= 2;
  return bisect((x) => alpha - chiSquareP(x, df), 0, hi, true);
}

// P(X > x) for a noncentral chi-square: Poisson(lambda/2) mixture of central ones.
export function ncChiSquareSf(x, df, lambda) {
  if (lambda <= 0) return chiSquareP(x, df);
  const h = lambda / 2;
  const j0 = Math.floor(h);
  const w0 = Math.exp(-h + j0 * Math.log(h) - lgamma(j0 + 1));
  let sum = 0, w = w0;
  for (let j = j0; j < j0 + 100000; j++) {
    sum += w * chiSquareP(x, df + 2 * j);
    w *= h / (j + 1);
    if (w < 1e-17 && j > j0) break;
  }
  w = w0;
  for (let j = j0 - 1; j >= 0; j--) {
    w *= (j + 1) / h;
    sum += w * chiSquareP(x, df + 2 * j);
    if (w < 1e-17) break;
  }
  return Math.min(1, sum);
}

// Noncentrality at which a chi-square test with df degrees of freedom at level
// alpha has the given power; with n rounds, Cohen's effect size w = sqrt(lambda / n).
export function noncentralityForPower(df, alpha, power) {
  const c = chiSquareQuantile(alpha, df);
  let hi = 10;
  while (ncChiSquareSf(c, df, hi) < power) hi *= 2;
  return bisect((l) => ncChiSquareSf(c, df, l) - power, 0, hi, true);
}

// ---------- pmf ----------

const X_NAMES = ['multiplier', 'mult', 'x', 'win', 'value', 'payout', 'المضاعف', 'مضاعف', 'الربح'];
// Probabilities must add up to 1; weights and counts are divided by their total.
const PROB_NAMES = ['probability', 'prob', 'p', 'الاحتمال', 'احتمال'];
const WEIGHT_NAMES = ['weight', 'count', 'frequency', 'combinations', 'الوزن', 'العدد', 'التكرار'];
const T_NAMES = ['trigger', 'triggered', 'feature', 'bonus', 'التفعيل', 'تفعيل', 'الميزة', 'ميزة'];
// How far a probability column may add up from 1 (rounding of the printed values).
export const PROBABILITY_SUM_TOLERANCE = 1e-6;

// Sorts and merges entries, normalizes the probabilities, and computes a summary.
// scope 'round': x is the whole round's win. scope 'baseSpin': x is the paid spin's
// own win and the spins flagged trigger also lead to a feature not modelled here.
export function makePmf({ label = 'pmf', scope = 'round', source = 'csv', entries, notes = [] }) {
  const map = new Map();
  for (const e of entries) {
    if (!(e.p > 0)) continue;
    const key = e.x + (e.trigger ? 'T' : '');
    const m = map.get(key);
    if (m) m.p += e.p; else map.set(key, { x: e.x, p: e.p, trigger: Boolean(e.trigger) });
  }
  const list = [...map.values()].sort((a, b) => a.x - b.x || a.trigger - b.trigger);
  const total = list.reduce((a, e) => a + e.p, 0);
  if (!(total > 0) || !list.length) throw fail('the distribution has no outcome with a positive probability', 'لا يحتوي التوزيع على أي نتيجة باحتمال موجب');
  for (const e of list) e.p /= total;
  let mean = 0, m2 = 0, pTrigger = 0, pHit = 0, maxX = 0;
  for (const e of list) {
    mean += e.x * e.p;
    if (e.trigger) pTrigger += e.p;
    if (e.x > 0 || (scope === 'baseSpin' && e.trigger)) pHit += e.p;
    maxX = Math.max(maxX, e.x);
  }
  for (const e of list) m2 += (e.x - mean) ** 2 * e.p;
  return {
    label, scope, source, entries: list, outcomes: list.length,
    hasTrigger: list.some((e) => e.trigger), pTrigger, pHit, mean, sd: Math.sqrt(m2), maxX,
    normalizedFrom: Math.abs(total - 1) > 1e-9 ? total : null, notes,
  };
}

// pmf exported by slot-exact.js (distribution.pmf, scope 'baseSpin' with free spins):
// exact counts over all combinations; or by round-dist.js (round.pmf, scope 'round':
// the whole round, free spins included), whose entries carry a probability p (from
// the transform for rounds with the feature, under its noise floor left out).
// The round pmf also states the game's true largest win (maxX; null when retriggers
// make it unbounded) and whether cells were left out (truncated): then its last cell is
// not a top prize, and only the true largest win may bound the e-process.
export function pmfFromExact(exact, label = 'model') {
  const total = exact.total ? BigInt(exact.total) : null;
  const pmf = makePmf({
    label, scope: exact.scope, source: 'model',
    entries: exact.entries.map((e) => ({ x: e.x, p: typeof e.p === 'number' ? e.p : new Fraction(BigInt(e.count), total).toNumber(), trigger: e.trigger })),
  });
  if ('maxX' in exact) Object.assign(pmf, { maxWin: exact.maxX, truncated: Boolean(exact.truncated) });
  return pmf;
}

// CSV with a multiplier column and a probability column ("a/b" fractions are read
// exactly), or a weight / count column, which is divided by its total; optionally a
// trigger flag, read like the play log's. Without a header the columns are
// multiplier, probability[, trigger]. A probability column must add up to 1: a
// missing or mistyped row would otherwise change the distribution (and its RTP)
// without a word. Every error names the file.
export function parsePmfCsv(text, label = 'pmf') {
  const where = (en, ar) => fail(`distribution file "${label}": ${en}`, `ملف التوزيع "${label}": ${ar}`);
  const delimiter = detectDelimiter(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  const readNumber = makeNumberReader(delimiter);
  const readP = (cell) => {
    const m = /^\s*([0-9.eE+-]+)\s*\/\s*([0-9.eE+-]+)\s*$/.exec(String(cell ?? ''));
    return m ? Number(m[1]) / Number(m[2]) : readNumber(cell);
  };
  let xCol = 0, pCol = 1, tCol = -1, first = true, weights = false;
  const entries = [];
  forEachCsvRow(text, (row, line) => {
    if (first) {
      first = false;
      // A header: the first row's multiplier or probability is not a number (a
      // trigger cell such as "true" says nothing either way).
      if (!(Number.isFinite(readNumber(row[0])) && Number.isFinite(readP(row[1])))) {
        xCol = findColumn(row, X_NAMES);
        pCol = findColumn(row, PROB_NAMES);
        if (pCol < 0) { pCol = findColumn(row, WEIGHT_NAMES); weights = pCol >= 0; }
        tCol = findColumn(row, T_NAMES);
        if (xCol < 0 || pCol < 0) {
          throw where('it needs a multiplier column and a probability column (e.g. "multiplier,probability")',
            'يحتاج عمودًا للمضاعف وعمودًا للاحتمال (مثل "multiplier,probability")');
        }
        return;
      }
      if (row.length >= 3) tCol = 2;
    }
    const x = readNumber(row[xCol]), p = readP(row[pCol]);
    if (!Number.isFinite(x) || x < 0 || !Number.isFinite(p) || p < 0) {
      throw where(`line ${line}: the multiplier and the probability must be numbers ≥ 0`,
        `السطر ${line}: يجب أن يكون المضاعف والاحتمال أعدادًا ≥ 0`);
    }
    entries.push({ x, p, trigger: tCol >= 0 && flagSet(row[tCol], readNumber) });
  });
  if (!weights) {
    const total = entries.reduce((a, e) => a + e.p, 0);
    if (!(Math.abs(total - 1) <= PROBABILITY_SUM_TOLERANCE)) {
      const s = +total.toPrecision(10);
      throw where(`the probabilities add up to ${s}, not 1: a row may be missing or mistyped. If the column holds weights or counts, name it "weight" or "count" and it will be divided by its total`,
        `مجموع الاحتمالات ${s} وليس 1: ربما ينقص سطر أو فيه خطأ. إذا كان العمود أوزانًا أو أعدادًا فسمِّه "weight" أو "count" ليُقسَم على مجموعه`);
    }
  }
  try {
    return makePmf({ label, scope: 'round', source: 'csv', entries });
  } catch (e) {
    throw where(e.en || e.message, e.ar || e.message);
  }
}

// ---------- cells: outcomes every candidate pmf is compared on ----------

function nearest(values, x) {
  let lo = 0, hi = values.length - 1;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (values[mid] < x) lo = mid + 1; else hi = mid; }
  if (lo > 0 && Math.abs(values[lo - 1] - x) <= Math.abs(values[lo] - x)) lo--;
  return lo;
}

// In 'round' scope a cell is a win value. In 'baseSpin' scope a cell is the win of a
// spin that did not trigger the feature, plus one cell "triggered" (what the feature
// paid is not modelled). probs[v][k] = P(cell k) under candidate v.
export function buildCells(pmfs) {
  const scope = pmfs[0].scope;
  if (pmfs.some((p) => p.scope !== scope)) {
    throw fail('candidates mix a whole-round distribution with a paid-spin-only one; compare like with like',
      'المرشحون يخلطون توزيع الجولة كاملة بتوزيع اللفة المدفوعة وحدها؛ قارن المتماثل فقط');
  }
  const xs = [];
  for (const pmf of pmfs) for (const e of pmf.entries) if (scope === 'round' || !e.trigger) xs.push(e.x);
  xs.sort((a, b) => a - b);
  const values = [];
  for (const x of xs) if (!values.length || x - values[values.length - 1] > 1e-12 * Math.max(1, x)) values.push(x);
  const triggerCell = scope === 'baseSpin' ? values.length : -1;
  const K = values.length + (triggerCell >= 0 ? 1 : 0);
  const probs = pmfs.map((pmf) => {
    const a = new Float64Array(K);
    for (const e of pmf.entries) a[scope === 'baseSpin' && e.trigger ? triggerCell : nearest(values, e.x)] += e.p;
    return a;
  });
  return { scope, values: Float64Array.from(values), triggerCell, K, probs };
}

// Decimal resolution of the log (0.01 for cents, 1e-6 for six decimals): the game
// rounded each win to it, so an observed win can sit up to half of it from v x bet.
export function logResolution(log) {
  for (let d = 0; d <= 8; d++) {
    const s = 10 ** d;
    let ok = true;
    for (const a of [log.bets, log.wins]) {
      for (let i = 0; i < a.length && ok; i++) {
        const v = a[i] * s;
        if (Math.abs(v - Math.round(v)) > Math.max(1e-6, Math.abs(v) * 1e-15)) ok = false;
      }
      if (!ok) break;
    }
    if (ok) return 10 ** -d;
  }
  return null;
}

// Cell of each round (-1: no candidate can produce that win).
export function classifyRounds(log, cells, resolution = logResolution(log)) {
  const n = log.bets.length;
  const out = new Int32Array(n);
  if (cells.triggerCell >= 0 && !log.triggers) {
    throw fail('this distribution covers the paid spin only; the log needs a trigger column (1 when the round triggered the feature)',
      'هذا التوزيع يغطي اللفة المدفوعة وحدها؛ يحتاج السجل عمود trigger (‏1 إذا فعّلت الجولة الميزة)');
  }
  const vals = cells.values;
  for (let i = 0; i < n; i++) {
    if (cells.triggerCell >= 0 && log.triggers[i]) { out[i] = cells.triggerCell; continue; }
    const x = log.wins[i] / log.bets[i];
    if (!vals.length) { out[i] = -1; continue; }
    const j = nearest(vals, x);
    const tol = Math.max(1e-9 * Math.max(1, x), resolution ? (resolution / 2 / log.bets[i]) * (1 + 1e-9) : 0);
    out[i] = Math.abs(vals[j] - x) <= tol ? j : -1;
  }
  return out;
}

// ---------- goodness of fit ----------

// Adjacent cells (in value order, "triggered" last) are pooled until each bin
// expects at least minExpected rounds; a short last bin joins the one before.
export function poolCells(probs, n, minExpected = 5) {
  const bins = [];
  let cur = null;
  for (let k = 0; k < probs.length; k++) {
    if (!cur) cur = { from: k, to: k, p: 0 };
    cur.to = k; cur.p += probs[k];
    if (cur.p * n >= minExpected) { bins.push(cur); cur = null; }
  }
  if (cur) {
    if (bins.length) { const last = bins[bins.length - 1]; last.to = cur.to; last.p += cur.p; } else bins.push(cur);
  }
  return bins;
}

function gStat(obs, exp) {
  let g = 0, x2 = 0;
  for (let j = 0; j < obs.length; j++) {
    const o = obs[j], e = exp[j];
    if (o > 0) g += o * Math.log(o / e);
    x2 += (o - e) * (o - e) / e;
  }
  return [2 * g, x2];
}

// ---------- Monte Carlo work ----------

// Rough work of one multinomial draw of n rounds over probs, in binomial-sampler
// steps: a fixed cost per cell plus about one standard deviation's walk from the
// mode. Measured at 13-25 ns per step in Node on this sampler.
export function drawCost(probs, n) {
  let c = 0;
  for (const p of probs) c += 3 + Math.sqrt(n * p);
  return c;
}
// Steps one Monte Carlo loop may take: a few seconds in a browser worker.
export const MC_BUDGET = 2e8;

// Replicates for a Monte Carlo P-value that must be able to reach `level`. Its
// smallest value is 1 / (R + 1), and with about 20 / level replicates the test loses
// little power against the exact one. At least `min`, and no more than the budget
// allows (at least `min` still): the caller checks 1 / (R + 1) against the level.
export function mcReplicates(probs, n, level, { min = 4999, budget = MC_BUDGET } = {}) {
  const want = Math.max(min, Math.ceil(20 / level) - 1);
  return Math.max(min, Math.min(want, Math.floor(budget / drawCost(probs, n))));
}

// counts: rounds per cell; probs: the reference candidate's cell probabilities.
// alpha is the test's own level; mdeAlpha the level the minimum detectable effect is
// computed at (Holm's first threshold alpha / m inside a family of m tests).
export function goodnessOfFit(counts, probs, { rng, replicates = 4999, minExpected = 5, alpha = 0.01, mdeAlpha = alpha, power = 0.8, onProgress = () => {} } = {}) {
  let n = 0;
  for (const c of counts) n += c;
  const bins = poolCells(probs, n, minExpected);
  const base = { n, minExpected, replicates, pFloor: 1 / (replicates + 1), alpha, power };
  if (bins.length < 2) return { ...base, applicable: false, reason: 'tooFewRounds', bins: [] };
  const K = bins.length, df = K - 1;
  const binP = Float64Array.from(bins, (b) => b.p);
  const expd = Float64Array.from(bins, (b) => b.p * n);
  const obs = new Float64Array(K);
  bins.forEach((b, j) => { for (let k = b.from; k <= b.to; k++) obs[j] += counts[k]; });
  const [G, X2] = gStat(obs, expd);
  const draw = multinomialSampler(binP);
  const sim = new Float64Array(K);
  let geG = 0, geX2 = 0;
  const tolG = 1e-9 * Math.max(1, G), tolX = 1e-9 * Math.max(1, X2);
  for (let r = 0; r < replicates; r++) {
    draw(rng, n, sim);
    const [g, x2] = gStat(sim, expd);
    if (g >= G - tolG) geG++;
    if (x2 >= X2 - tolX) geX2++;
    if ((r & 255) === 0) onProgress(r / replicates);
  }
  // Effect the test detects with the given power at mdeAlpha (asymptotic noncentral
  // chi-square): Cohen's w; and, if only the most likely bin (usually "no win")
  // changed, the relative change of its share.
  const lambda = noncentralityForPower(df, mdeAlpha, power);
  const w = Math.sqrt(lambda / n);
  let big = 0;
  for (let j = 1; j < K; j++) if (binP[j] > binP[big]) big = j;
  return {
    ...base, applicable: true, df, G, X2,
    pValue: (1 + geG) / (replicates + 1), pValueX2: (1 + geX2) / (replicates + 1),
    pAsymptotic: chiSquareP(G, df), pAsymptoticX2: chiSquareP(X2, df),
    bins: bins.map((b, j) => ({ from: b.from, to: b.to, p: b.p, expected: expd[j], observed: obs[j] })),
    mde: { alpha: mdeAlpha, lambda, w, bin: big, binShare: binP[big], relativeChange: binP[big] < 1 ? w * Math.sqrt((1 - binP[big]) / binP[big]) : null },
  };
}

// Exact binomial test of an observed rate against p0, its Clopper-Pearson interval
// at 1 - alpha, and the drop below p0 that this many rounds detects with `power` at
// mdeAlpha (two-sided, normal approximation).
export function frequencyTest(k, n, p0, { alpha = 0.01, mdeAlpha = alpha, power = 0.8 } = {}) {
  const za = normalQuantile(1 - mdeAlpha / 2), zb = normalQuantile(power);
  let d = 0;
  for (let i = 0; i < 50; i++) {
    const p1 = Math.max(0, p0 - d);
    d = (za * Math.sqrt(p0 * (1 - p0)) + zb * Math.sqrt(p1 * (1 - p1))) / Math.sqrt(n);
  }
  const pValue = p0 <= 0 ? (k === 0 ? 1 : 0) : p0 >= 1 ? (k === n ? 1 : 0) : binomTwoSidedP(k, n, p0);
  return {
    observed: k, n, rate: k / n, expected: p0, expectedCount: n * p0,
    ci: clopperPearson(k, n, 1 - alpha), confidence: 1 - alpha, pValue,
    mde: { alpha: mdeAlpha, absolute: Math.min(d, p0), relative: p0 > 0 ? Math.min(1, d / p0) : null },
  };
}

// Holm's step-down: which of the P-values are rejected at family level alpha.
export function holm(pValues, alpha) {
  const order = pValues.map((p, i) => [p, i]).sort((a, b) => a[0] - b[0]);
  const rejected = new Array(pValues.length).fill(false);
  for (let r = 0; r < order.length; r++) {
    if (order[r][0] > alpha / (order.length - r)) break;
    rejected[order[r][1]] = true;
  }
  return rejected;
}

// ---------- version identification ----------

function klDivergence(p, q) {
  let s = 0;
  for (let k = 0; k < p.length; k++) {
    if (p[k] <= 0) continue;
    if (q[k] <= 0) return Infinity;
    s += p[k] * Math.log(p[k] / q[k]);
  }
  return s;
}

// Variance of the per-round log-likelihood ratio ln(q/p) when rounds follow p.
function llrVariance(p, q) {
  let m = 0, m2 = 0;
  for (let k = 0; k < p.length; k++) {
    if (p[k] <= 0) continue;
    if (q[k] <= 0) return Infinity;
    const z = Math.log(q[k] / p[k]);
    m += p[k] * z; m2 += p[k] * z * z;
  }
  return Math.max(0, m2 - m * m);
}

// Wald's boundaries and his approximations of the expected number of rounds.
export function sprtPlan(alpha, beta, klRefAlt, klAltRef) {
  const A = Math.log((1 - beta) / alpha), B = Math.log(beta / (1 - alpha));
  return {
    A, B,
    asnRef: klRefAlt > 0 && Number.isFinite(klRefAlt) ? ((1 - alpha) * -B - alpha * A) / klRefAlt : klRefAlt === 0 ? Infinity : null,
    asnAlt: klAltRef > 0 && Number.isFinite(klAltRef) ? ((1 - beta) * A + beta * B) / klAltRef : klAltRef === 0 ? Infinity : null,
  };
}

// Wald's SPRT of "reference" (H0) against "alternative" (H1), over the rounds in log
// order. Meaningful when one of the two is the true version.
export function runSprt(cellIdx, p0, p1, { alpha = 0.01, beta = 0.2 } = {}) {
  const { A, B } = sprtPlan(alpha, beta, 0, 0);
  let llr = 0;
  for (let i = 0; i < cellIdx.length; i++) {
    const k = cellIdx[i];
    if (k < 0 || (p0[k] <= 0 && p1[k] <= 0)) continue;
    llr += p0[k] <= 0 ? Infinity : p1[k] <= 0 ? -Infinity : Math.log(p1[k] / p0[k]);
    if (llr >= A) return { decision: 'alternative', at: i + 1, llr };
    if (llr <= B) return { decision: 'reference', at: i + 1, llr };
  }
  return { decision: 'continue', at: null, llr };
}

// Matrix SPRT (Armitage, 1950) for 2-5 versions: stop at the first round where one
// candidate's log-likelihood beats every other one's by A = ln((V-1)/alpha).
// Whichever candidate is true, each likelihood ratio against it reaches e^A with
// probability at most alpha/(V-1) (Ville's inequality), so naming a wrong version
// has probability at most alpha, at any stopping time.
export function runMatrixSprt(cellIdx, probs, alpha) {
  const V = probs.length;
  const A = Math.log((V - 1) / alpha);
  const logp = probs.map((p) => Float64Array.from(p, (x) => (x > 0 ? Math.log(x) : -Infinity)));
  const ll = new Float64Array(V);
  for (let i = 0; i < cellIdx.length; i++) {
    const k = cellIdx[i];
    if (k < 0) continue;
    let b = 0;
    for (let v = 0; v < V; v++) { ll[v] += logp[v][k]; if (ll[v] > ll[b]) b = v; }
    let second = -Infinity;
    for (let v = 0; v < V; v++) if (v !== b && ll[v] > second) second = ll[v];
    if (ll[b] - second >= A) return { decision: b, at: i + 1, threshold: A };
  }
  return { decision: null, at: null, threshold: A };
}

// Log-likelihood and posterior (uniform prior) of each candidate, KL divergences,
// the matrix SPRT over the log, and for each candidate the expected rounds the SPRT
// needs if it is the true one (Wald's approximation A / min KL). Pairs (reference vs
// each other) carry Wald's two-hypothesis boundaries and expected rounds for
// planning; the two-hypothesis SPRT itself is run only with two candidates, since
// with more it can accept either of two wrong versions.
export function identifyVersion(cellIdx, cells, labels, { refIndex = 0, alpha = 0.01, beta = 0.2 } = {}) {
  const V = cells.probs.length, K = cells.K;
  const counts = new Float64Array(K);
  let unmatched = 0;
  for (const k of cellIdx) if (k < 0) unmatched++; else counts[k]++;
  const kl = cells.probs.map((p) => cells.probs.map((q) => klDivergence(p, q)));
  const threshold = Math.log((V - 1) / alpha);
  const models = cells.probs.map((p, v) => {
    let ll = 0, impossible = 0;
    for (let k = 0; k < K; k++) {
      if (!counts[k]) continue;
      if (p[k] <= 0) impossible += counts[k]; else ll += counts[k] * Math.log(p[k]);
    }
    const minKl = Math.min(...kl[v].filter((_, u) => u !== v));
    return { label: labels[v], logLik: impossible ? -Infinity : ll, impossible, minKl, asn: minKl > 0 && Number.isFinite(minKl) ? threshold / minKl : minKl === 0 ? Infinity : null };
  });
  const finite = models.filter((m) => Number.isFinite(m.logLik));
  const top = finite.length ? Math.max(...finite.map((m) => m.logLik)) : 0;
  const z = finite.reduce((a, m) => a + Math.exp(m.logLik - top), 0);
  for (const m of models) m.posterior = Number.isFinite(m.logLik) ? Math.exp(m.logLik - top) / z : 0;
  const ranked = models.map((m, v) => [m.logLik, v]).sort((a, b) => b[0] - a[0]);
  const ref = cells.probs[refIndex];
  const pairs = cells.probs.map((alt, v) => {
    if (v === refIndex) return null;
    const pair = { index: v, label: labels[v], klRefAlt: kl[refIndex][v], klAltRef: kl[v][refIndex], ...sprtPlan(alpha, beta, kl[refIndex][v], kl[v][refIndex]) };
    if (V === 2) pair.sprt = runSprt(cellIdx, ref, alt, { alpha, beta });
    return pair;
  }).filter(Boolean);
  return {
    rounds: cellIdx.length, unmatched, refIndex, alpha, beta, models, kl, threshold,
    best: ranked[0][1], margin: ranked[0][0] - ranked[1][0],
    sequential: runMatrixSprt(cellIdx, cells.probs, alpha),
    pairs,
  };
}

// ---------- betting e-process for "RTP below declared" ----------

// One run of the bettor's capital K_t = prod (1 + lambda_t (m - X_t)) for H0: E[X] >= m.
// lambda_t uses only earlier rounds (aGRAPA: the gap over the second moment, from
// running estimates shrunk toward m and sigma with k0 pseudo-rounds) and is capped
// at c / (M - m), so 1 + lambda (m - X) >= 1 - c > 0 for any X in [0, M]. Under H0
// the capital is a nonnegative supermartingale: P(it ever reaches 1/alpha) <= alpha.
function runBetting(xs, m, M, sigma, k0, c, threshold, points = 0) {
  const lamMax = c / (M - m);
  const s2 = sigma > 0 ? sigma * sigma : null;
  const n = xs.length;
  const every = points ? Math.max(1, Math.floor(n / points)) : 0;
  const traj = points ? [[0, 0]] : null;
  let logK = 0, maxLogK = 0, crossedAt = null, sum = 0, mean = 0, q = 0;
  for (let t = 0; t < n; t++) {
    let lam = 0;
    const gap = m - (k0 * m + sum) / (k0 + t);
    if (gap > 0) {
      const v = s2 !== null ? (k0 * s2 + q) / (k0 + t) : t >= 30 ? q / t : -1;
      if (v >= 0) lam = Math.min(lamMax, gap / (v + gap * gap));
    }
    const x = xs[t];
    logK += Math.log1p(lam * (m - x));
    if (logK > maxLogK) { maxLogK = logK; if (crossedAt === null && logK >= threshold) crossedAt = t + 1; }
    sum += x;
    const d = x - mean;
    mean += d / (t + 1);
    q += d * (x - mean);
    if (every && ((t + 1) % every === 0 || t === n - 1)) traj.push([t + 1, logK]);
  }
  return { logK, maxLogK, crossedAt, traj };
}

function csGrid(mu0, M) {
  const d = [-0.5, -0.4, -0.3, -0.25];
  for (let i = -20; i <= 20; i++) d.push(i / 100);
  d.push(0.25, 0.3, 0.4, 0.5, 0.75, 1, 1.5, 2, 3, 5);
  return d.map((x) => Math.round((mu0 + x) * 1e9) / 1e9).filter((m) => m > 0 && m < M);
}

// xs: win / bet of each round, in log order (all of it since release: a moving window
// is not covered by the guarantee). M: the most one round can pay, × bet.
export function bettingTest(xs, { mu0, M, alpha = 0.05, sigma = null, k0 = 1000, c = 0.5, grid = true, onProgress = () => {} } = {}) {
  if (!(mu0 > 0)) throw fail('the declared RTP is needed', 'يلزم RTP المعلن');
  if (!(M > mu0)) {
    throw fail('a max-win bound M above the declared RTP is needed (the game\'s cap, × bet)',
      'يلزم حد أعلى للربح M أكبر من RTP المعلن (سقف ربح اللعبة × الرهان)');
  }
  let maxX = 0;
  for (const x of xs) if (x > maxX) maxX = x;
  if (maxX > M * (1 + 1e-12)) {
    throw fail(`a round paid ${+maxX.toPrecision(8)}× the bet, above the bound M = ${M}×: the bound is wrong or the log is another game or mode`,
      `جولة دفعت ${+maxX.toPrecision(8)}× الرهان، أكثر من الحد M = ${M}×: الحد خاطئ أو السجل للعبة أو نمط آخر`);
  }
  const threshold = Math.log(1 / alpha);
  const main = runBetting(xs, mu0, M, sigma, k0, c, threshold, 60);
  let upperBound = null, belowGrid = false, gridTop = null;
  if (grid) {
    const points = csGrid(mu0, M);
    gridTop = points[points.length - 1];
    const rejected = points.map((m, i) => { onProgress((i + 1) / points.length); return runBetting(xs, m, M, sigma, k0, c, threshold).maxLogK >= threshold; });
    let i = points.length;
    while (i > 0 && rejected[i - 1]) i--;
    if (i < points.length) upperBound = points[i];
    belowGrid = i === 0;
  }
  return {
    rounds: xs.length, mu0, M, alpha, sigma, k0, c, maxObserved: maxX,
    logCapital: main.logK, maxLogCapital: main.maxLogK, eValue: Math.exp(main.logK), maxEValue: Math.exp(main.maxLogK),
    pValue: Math.min(1, Math.exp(-main.maxLogK)), threshold, rejected: main.maxLogK >= threshold, crossedAt: main.crossedAt,
    trajectory: main.traj, upperBound, belowGrid, gridTop,
  };
}

// ---------- how unusual is the log's total? ----------

// P(S <= s) for S the sum of n independent draws from the pmf (values, probs), by
// seeded Monte Carlo over multinomial counts: an estimate whose standard error is
// known whatever the shape of the distribution. (A Lugannani-Rice saddlepoint was
// tried first: for a game with rare big wins it was off by tens of percent in the
// body of the distribution and broke down next to the mean.) s should be computed
// like the simulated totals, sum over cells of count x value, so that ties compare
// equal. estimate = k / R with its standard error; pValue = (k + 1) / (R + 1) is a
// valid P-value.
export function totalLowerTail(values, probs, n, s, { rng, replicates = 9999, onProgress = () => {} } = {}) {
  const draw = multinomialSampler(probs);
  const sim = new Float64Array(probs.length);
  const limit = s + 1e-9 * Math.max(1, Math.abs(s));
  let k = 0;
  for (let r = 0; r < replicates; r++) {
    draw(rng, n, sim);
    let t = 0;
    for (let j = 0; j < sim.length; j++) t += sim[j] * values[j];
    if (t <= limit) k++;
    if ((r & 255) === 0) onProgress(r / replicates);
  }
  const estimate = k / replicates;
  return { method: 'montecarlo', replicates, count: k, estimate, se: Math.sqrt(estimate * (1 - estimate) / replicates), pValue: (k + 1) / (replicates + 1) };
}

// ---------- planner ----------

const zq = (p) => normalQuantile(p);

// Rounds for the one-sided mean z-test (declared sigma) to detect RTP lower by `gap`.
export function roundsMeanTest(sigma, gap, alpha, power) {
  return Math.ceil(((zq(1 - alpha) + zq(power)) * sigma / gap) ** 2);
}

// Rounds for a two-sided interval of half-width `margin` at confidence 1 - alpha.
export function roundsInterval(sigma, margin, alpha) {
  return Math.ceil((zq(1 - alpha / 2) * sigma / margin) ** 2);
}

// Rounds the betting e-process needs to reach 1/alpha when the RTP is `gap` below
// mu0, for a bettor who knew the best constant bet: ln(1/alpha) over the growth per
// round E[ln(1 + lambda Y)] ~ lambda gap - lambda^2 (sigma^2 + gap^2) / 2 (second
// order). A rough lower estimate: the adaptive bettor needs more.
export function roundsEProcess(sigma, M, mu0, gap, alpha, c = 0.5) {
  const lam = Math.min(gap / (sigma * sigma + gap * gap), c / (M - mu0));
  const g = lam * gap - lam * lam * (sigma * sigma + gap * gap) / 2;
  return g > 0 ? Math.ceil(Math.log(1 / alpha) / g) : null;
}

// One-sided test of a rate p0 against p1 (normal approximation).
export function roundsRate(p0, p1, alpha, power) {
  if (!(p0 > 0 && p0 < 1 && p1 >= 0 && p1 < 1) || p0 === p1) return null;
  return Math.ceil(((zq(1 - alpha) * Math.sqrt(p0 * (1 - p0)) + zq(power) * Math.sqrt(p1 * (1 - p1))) / Math.abs(p1 - p0)) ** 2);
}

// Fixed-n likelihood-ratio test between two pmfs (normal approximation of the sum).
export function roundsLikelihoodRatio(klRefAlt, klAltRef, varRef, varAlt, alpha, power) {
  if (!(klRefAlt + klAltRef > 0) || !Number.isFinite(klRefAlt + klAltRef)) return null;
  return Math.ceil(((zq(1 - alpha) * Math.sqrt(varRef) + zq(power) * Math.sqrt(varAlt)) / (klRefAlt + klAltRef)) ** 2);
}

// Rounds for a `prob` chance of seeing an outcome of probability p at least once.
export function roundsToSee(p, prob = 0.95) {
  return p > 0 && p < 1 ? Math.ceil(Math.log(1 - prob) / Math.log1p(-p)) : null;
}

export function planSampleSize({ mu0 = null, sigma = null, M = null, gap = 0.02, alpha = 0.05, power = 0.8, c = 0.5, pTop = null, versions = [], sigmas = [3, 8, 15, 25], maxWins = [1000, 5000, 50000] } = {}) {
  const has = (v) => Number.isFinite(v) && v > 0;
  const rows = [];
  rows.push({ id: 'meanTest', needs: 'sigma', rounds: has(sigma) ? roundsMeanTest(sigma, gap, alpha, power) : null });
  rows.push({ id: 'interval', needs: 'sigma', rounds: has(sigma) ? roundsInterval(sigma, gap, alpha) : null });
  rows.push({ id: 'eProcess', needs: 'sigmaM', rounds: has(sigma) && has(mu0) && M > mu0 ? roundsEProcess(sigma, M, mu0, gap, alpha, c) : null, approx: true });
  if (pTop > 0) rows.push({ id: 'topPrize', needs: 'pmf', rounds: roundsToSee(pTop) });
  for (const v of versions) {
    rows.push({ id: 'sprt', version: v.label, needs: 'pmfs', rounds: Number.isFinite(v.asnAlt) ? Math.ceil(v.asnAlt) : null, approx: true });
    rows.push({ id: 'lrFixed', version: v.label, needs: 'pmfs', rounds: roundsLikelihoodRatio(v.klRefAlt, v.klAltRef, v.varRef, v.varAlt, alpha, power), approx: true });
    if (v.pTriggerRef > 0 && v.pTriggerAlt >= 0) rows.push({ id: 'triggerRate', version: v.label, needs: 'trigger', rounds: roundsRate(v.pTriggerRef, v.pTriggerAlt, alpha, power), approx: true });
    if (has(sigma) && has(v.gap)) rows.push({ id: 'meanTestVersion', version: v.label, needs: 'sigma', rounds: roundsMeanTest(sigma, v.gap, alpha, power) });
  }
  // The grid's own sigma row is the exact sigma, so it repeats the rows table's numbers.
  const sList = [...new Set([...(has(sigma) ? [sigma] : []), ...sigmas])].sort((a, b) => a - b);
  const mList = [...new Set([...(M > 0 ? [M] : []), ...maxWins])].filter((m) => !has(mu0) || m > mu0).sort((a, b) => a - b);
  const grid = sList.map((s) => ({
    sigma: s, meanTest: roundsMeanTest(s, gap, alpha, power),
    eProcess: mList.map((m) => ({ M: m, rounds: has(mu0) ? roundsEProcess(s, m, mu0, gap, alpha, c) : null })),
  }));
  return { mu0, sigma, M, gap, alpha, power, c, rows, grid, maxWins: mList };
}

// ---------- the whole audit ----------

const TAIL_THRESHOLDS = [10, 100, 1000, 10000, 100000];

// log: parsePlayLog result; pmfs: 1-5 candidates (makePmf); rng: seeded generator.
// options: refIndex (the declared version), alpha, replicates (null: enough for the
// family's levels, within the work budget), totalReplicates (null: 9,999 within the
// budget), minExpected, mode, referenceRtp (the
// reference version's RTP when its pmf does not give it: a paid-spin pmf),
// declaredRtp (the declared field, compared with it), sigma and maxWin (M) with
// their sources, gap (planner), power.
export function auditDistribution(log, pmfs, options = {}, rng, onProgress = () => {}) {
  const {
    refIndex = 0, alpha = 0.01, replicates = null, totalReplicates = null, minExpected = 5, mode = '',
    declaredRtp = null, referenceRtp = null, sigma = null, sigmaSource = 'input', maxWin = null, maxWinSource = 'input',
    gap = 0.02, power = 0.8, beta = 0.2, bettingAlpha = alpha,
  } = options;
  if (!pmfs.length || pmfs.length > MAX_CANDIDATES) throw fail(`1 to ${MAX_CANDIDATES} distributions are needed`, `يلزم من 1 إلى ${MAX_CANDIDATES} توزيعات`);
  if (!(refIndex >= 0 && refIndex < pmfs.length)) throw fail('the reference distribution is not loaded', 'التوزيع المرجعي غير محمّل');
  // One mode at a time: each mode (base, bonus buy...) has its own distribution.
  let L = log;
  const modes = log.modes ? [...new Set(log.modes)] : null;
  if (mode && !modes) {
    throw fail(`the log has no mode column, so it cannot be limited to the mode "${mode}": clear the mode field or add a mode column`,
      `لا يحتوي السجل على عمود للنمط، فلا يمكن حصره في النمط "${mode}": امسح حقل النمط أو أضف عمود mode`);
  }
  if (modes && mode) {
    const keep = [];
    log.modes.forEach((m, i) => { if (m === mode) keep.push(i); });
    if (!keep.length) throw fail(`no round has the mode "${mode}"`, `لا توجد جولة بالنمط "${mode}"`);
    const pick = (a) => (a ? a.constructor.from(keep, (i) => a[i]) : null);
    L = { ...log, bets: pick(log.bets), wins: pick(log.wins), triggers: pick(log.triggers), modes: keep.map((i) => log.modes[i]) };
  }
  const n = L.bets.length;
  if (n < 2) throw fail('at least 2 rounds are needed', 'يلزم جولتان على الأقل');
  const xs = new Float64Array(n);
  for (let i = 0; i < n; i++) xs[i] = L.wins[i] / L.bets[i];
  const ref = pmfs[refIndex];
  const resolution = logResolution(L);
  const out = {
    rounds: n, mode: mode || null, modes: modes && modes.length > 1 ? modes : null, mixedModes: Boolean(modes && modes.length > 1 && !mode),
    triggerColumn: Boolean(L.triggers), resolution, scope: ref.scope, refIndex, alpha, power,
    candidates: pmfs.map((p) => ({ label: p.label, source: p.source, scope: p.scope, outcomes: p.outcomes, mean: p.mean, sd: p.sd, maxX: p.maxX, pTrigger: p.hasTrigger ? p.pTrigger : null, pHit: p.pHit, normalizedFrom: p.normalizedFrom })),
  };
  const stage = (from, to) => (v) => onProgress(from + (to - from) * v);

  // 1-2. Fit of the reference: GOF, hit and trigger frequency, tails, top prize.
  const needTrigger = ref.scope === 'baseSpin';
  const fit = { tests: [] };
  out.fit = fit;
  const fitCells = needTrigger && !L.triggers ? null : buildCells([ref]);
  let counts = null, p0 = null, hits = null, triggered = null;
  if (fitCells) {
    const refIdx = classifyRounds(L, fitCells, resolution);
    counts = new Float64Array(fitCells.K);
    p0 = fitCells.probs[0];
    const off = [];
    for (let i = 0; i < n; i++) if (refIdx[i] < 0 || p0[refIdx[i]] <= 0) off.push(i); else counts[refIdx[i]]++;
    fit.offSupport = { count: off.length, examples: off.slice(0, 10).map((i) => ({ round: i + 1, x: xs[i], triggered: Boolean(L.triggers && L.triggers[i]) })) };
    hits = 0;
    for (let i = 0; i < n; i++) if (xs[i] > 0 || (needTrigger && L.triggers[i])) hits++;
  } else {
    fit.unavailable = 'needTriggerColumn';
  }
  if (ref.hasTrigger && L.triggers) {
    triggered = 0;
    for (let i = 0; i < n; i++) if (L.triggers[i]) triggered++;
  }
  // Big wins seen less often than the pmf says (exact binomial lower tails), and the
  // top prize. With a paid-spin pmf only rounds without the feature are counted: their
  // win is the paid spin's own win.
  let maxObs = 0, minBet = Infinity;
  for (let i = 0; i < n; i++) { if (xs[i] > maxObs) maxObs = xs[i]; if (L.bets[i] < minBet) minBet = L.bets[i]; }
  if (fitCells) {
    const own = ref.scope === 'baseSpin' ? ref.entries.filter((e) => !e.trigger) : ref.entries;
    const counted = (i) => ref.scope !== 'baseSpin' || !L.triggers[i];
    // A win the game rounded to the log's resolution still counts as reaching T.
    const slack = (i, T) => Math.max(1e-9 * T, resolution ? resolution / 2 / L.bets[i] : 0);
    const tailAt = (T) => {
      let q = 0, k = 0;
      for (const e of own) if (e.x >= T * (1 - 1e-12)) q += e.p;
      for (let i = 0; i < n; i++) if (counted(i) && xs[i] >= T - slack(i, T)) k++;
      // Fewest-possible P-value (no such win at all): a tail too rare for this many
      // rounds cannot reject, so it is shown but kept out of the family.
      const minP = Math.exp(n * Math.log1p(-q));
      return { threshold: T, probability: q, expected: n * q, observed: k, pValue: binomCdf(k, n, q), powered: minP < alpha / 2 };
    };
    const top = own.reduce((a, e) => Math.max(a, e.x), 0);
    // Fixed thresholds well below the top prize (one close to it would repeat it). A
    // truncated pmf (cells under its noise floor left out) has no top prize to test.
    const thresholds = TAIL_THRESHOLDS.filter((T) => T <= top / 2);
    const hasTop = top > 0 && !ref.truncated;
    if (hasTop) thresholds.push(top);
    fit.tails = thresholds.map(tailAt);
    if (hasTop) {
      const last = fit.tails[fit.tails.length - 1];
      const pTop = last.probability, seen = last.observed;
      fit.topPrize = {
        x: top, probability: pTop, oneIn: 1 / pTop, expected: n * pTop, observed: seen, paidSpinOnly: ref.scope === 'baseSpin',
        pNeverSeen: Math.exp(n * Math.log1p(-pTop)),
        // Rule of three: with no occurrence in n rounds, the data alone put its frequency
        // below 3/n at about 95% (exactly 1 - 0.05^(1/n)).
        ruleOfThree: seen === 0 ? -Math.expm1(Math.log(0.05) / n) : null,
        rtpShare: ref.scope === 'round' && ref.mean > 0 ? (top * pTop) / ref.mean : null,
        roundsFor95: roundsToSee(pTop, 0.95),
      };
    }
  }

  // The family, known before anything random runs. Holm's first threshold is
  // alpha / m: a test that cannot reach it cannot reject on its own, so every minimum
  // detectable effect is computed there, and the G-test gets enough Monte Carlo
  // replicates for its smallest P-value, 1 / (R + 1), to be well below it. If the work
  // budget does not allow that, the G-test is shown but kept out of the family.
  const bins = fitCells ? poolCells(p0, n, minExpected) : [];
  let m = (hits !== null ? 1 : 0) + (triggered !== null ? 1 : 0) + (fit.tails || []).filter((t) => t.powered).length;
  let gofR = replicates ?? 4999, gofInFamily = false;
  if (bins.length >= 2) {
    m++;
    if (replicates === null) gofR = mcReplicates(bins.map((b) => b.p), n, alpha / m);
    gofInFamily = 1 / (gofR + 1) <= alpha / m;
    if (!gofInFamily) m--;
  }
  const mdeAlpha = alpha / Math.max(1, m);
  fit.family = { size: m, mdeAlpha };
  if (fitCells) {
    const gof = goodnessOfFit(counts, p0, { rng, replicates: gofR, minExpected, alpha, mdeAlpha, power, onProgress: stage(0, 0.4) });
    // Bin labels: the range of win values it pools, and whether it holds "triggered".
    const V = fitCells.values.length;
    gof.bins = gof.bins.map((b) => {
      const last = Math.min(b.to, V - 1);
      return { ...b, lo: b.from < V ? fitCells.values[b.from] : null, hi: last >= b.from ? fitCells.values[last] : null, triggered: fitCells.triggerCell >= b.from && fitCells.triggerCell <= b.to };
    });
    gof.inFamily = gof.applicable && gofInFamily;
    // Its P-value cannot reach alpha / m: no effect is "detectable" by it.
    if (gof.applicable && !gofInFamily) gof.mde = null;
    fit.gof = gof;
    if (gof.inFamily) fit.tests.push({ id: 'gof', p: gof.pValue });
    fit.hit = frequencyTest(hits, n, ref.pHit, { alpha, mdeAlpha, power });
    fit.tests.push({ id: 'hit', p: fit.hit.pValue });
  }
  if (triggered !== null) {
    fit.trigger = frequencyTest(triggered, n, ref.pTrigger, { alpha, mdeAlpha, power });
    fit.tests.push({ id: 'trigger', p: fit.trigger.pValue });
  }
  (fit.tails || []).forEach((t, i) => { if (t.powered) fit.tests.push({ id: 'tail', index: i, p: t.pValue }); });

  if (ref.scope === 'round') {
    // RTP carried by outcomes above the largest win in the log (what the log cannot show).
    let unseen = 0;
    const above = maxObs * (1 + 1e-9) + (resolution ? resolution / 2 / minBet : 0);
    for (const e of ref.entries) if (e.x > above) unseen += e.x * e.p;
    fit.unseen = { maxObserved: maxObs, rtpAbove: unseen, share: ref.mean > 0 ? unseen / ref.mean : null };
    // How unusual the log's total (sum of win / bet) is under the pmf, lower tail:
    // a Monte Carlo estimate with its standard error, shown for information and kept
    // out of the verdict. The total is taken over the pmf values the rounds matched,
    // like the simulated ones.
    if (fit.offSupport && !fit.offSupport.count) {
      let sum = 0, s = 0;
      for (const v of xs) sum += v;
      for (let k = 0; k < fitCells.K; k++) s += counts[k] * fitCells.values[k];
      const R = totalReplicates ?? Math.max(999, Math.min(9999, Math.floor(MC_BUDGET / drawCost(p0, n))));
      fit.total = { sum, expected: n * ref.mean, ...totalLowerTail(fitCells.values, p0, n, s, { rng, replicates: R, onProgress: stage(0.4, 0.5) }) };
    }
  }
  const rejected = holm(fit.tests.map((t) => t.p), alpha);
  fit.tests.forEach((t, i) => { t.rejected = rejected[i]; });
  fit.verdict = fit.offSupport && fit.offSupport.count ? 'impossible' : !fit.tests.length ? 'insufficient' : rejected.some(Boolean) ? 'mismatch' : 'consistent';

  // 3. Version identification.
  if (pmfs.length >= 2) {
    try {
      const cells = buildCells(pmfs);
      const idx = classifyRounds(L, cells, resolution);
      const v = identifyVersion(idx, cells, pmfs.map((p) => p.label), { refIndex, alpha, beta });
      v.pairs.forEach((pair) => {
        const alt = cells.probs[pair.index], r = cells.probs[refIndex];
        pair.varRef = llrVariance(r, alt);
        pair.varAlt = llrVariance(alt, r);
        pair.gap = pmfs[refIndex].scope === 'round' ? pmfs[refIndex].mean - pmfs[pair.index].mean : null;
        pair.pTriggerRef = pmfs[refIndex].hasTrigger ? pmfs[refIndex].pTrigger : null;
        pair.pTriggerAlt = pmfs[pair.index].hasTrigger ? pmfs[pair.index].pTrigger : null;
      });
      out.versions = v;
    } catch (e) {
      out.versions = { error: { ar: e.ar || e.message, en: e.en || e.message } };
    }
  }
  onProgress(0.5);

  // 4. Betting e-process: "is the RTP below the reference version's?" It tests the
  // version chosen as the declared one; the declared field is used only when that
  // version's RTP is unknown, and a different value there is reported.
  const refRtp = referenceRtp > 0 ? referenceRtp : ref.scope === 'round' ? ref.mean : null;
  const mu0 = refRtp ?? (declaredRtp > 0 ? declaredRtp : null);
  const why = {
    mu0, mu0Source: refRtp ? 'reference' : mu0 ? 'declared' : null,
    declaredDiffers: refRtp && declaredRtp > 0 && Math.abs(declaredRtp - refRtp) > 1e-6 ? declaredRtp : null,
  };
  // The pmf's own bound only when it is the game's true largest win (see pmfFromExact).
  const M = maxWin > 0 ? maxWin : ref.scope === 'round' ? (ref.maxWin !== undefined ? ref.maxWin : ref.maxX) : null;
  const mSource = maxWin > 0 ? maxWinSource : 'pmf';
  if (!(mu0 > 0)) out.betting = { needs: 'declared', ...why };
  else if (!(M > 0)) out.betting = { needs: 'maxWin', ...why };
  else {
    try {
      out.betting = { ...bettingTest(xs, { mu0, M, alpha: bettingAlpha, sigma, onProgress: stage(0.5, 0.98) }), ...why, maxWinSource: mSource };
    } catch (e) {
      out.betting = { error: { ar: e.ar || e.message, en: e.en || e.message }, M, maxWinSource: mSource, ...why };
    }
  }

  // 5. Planner.
  const sig = sigma > 0 ? sigma : ref.scope === 'round' ? ref.sd : null;
  out.planner = planSampleSize({
    mu0, sigma: sig, M, gap, alpha: bettingAlpha, power,
    pTop: fit.topPrize ? fit.topPrize.probability : null,
    versions: out.versions && out.versions.pairs ? out.versions.pairs.map((p) => ({ label: p.label, asnAlt: p.asnAlt, klRefAlt: p.klRefAlt, klAltRef: p.klAltRef, varRef: p.varRef, varAlt: p.varAlt, pTriggerRef: p.pTriggerRef, pTriggerAlt: p.pTriggerAlt, gap: p.gap })) : [],
  });
  out.planner.sigmaSource = sigma > 0 ? sigmaSource : sig ? 'pmf' : null;
  onProgress(1);
  return out;
}

// ---------- example data (generated locally) ----------

// A synthetic high-volatility game shipped in three RTP versions that differ only in
// how often the bonus triggers (one common way providers make RTP variants). Values
// are wins per round × bet; trigger marks rounds whose win came from the bonus.
const EXAMPLE_BASE = [[0.2, 0.1], [0.5, 0.08], [1, 0.06], [2, 0.04], [5, 0.02], [10, 0.006], [25, 0.002], [100, 0.0001]];
const EXAMPLE_BONUS = [[10, 0.4], [30, 0.3], [80, 0.2], [300, 0.08], [1000, 0.018], [5000, 0.002]];
export const EXAMPLE_MAX_WIN = 5000;
export function examplePmf(rtp) {
  const baseEv = EXAMPLE_BASE.reduce((a, [v, p]) => a + v * p, 0);
  const bonusEv = EXAMPLE_BONUS.reduce((a, [v, p]) => a + v * p, 0);
  const pTrig = (rtp - baseEv) / bonusEv;
  const entries = [...EXAMPLE_BASE.map(([x, p]) => ({ x, p })), ...EXAMPLE_BONUS.map(([x, p]) => ({ x, p: p * pTrig, trigger: true }))];
  entries.unshift({ x: 0, p: 1 - entries.reduce((a, e) => a + e.p, 0) });
  return entries;
}

export function pmfCsv(entries) {
  return 'multiplier,probability,trigger\n' + entries.map((e) => `${e.x},${e.p.toPrecision(17)},${e.trigger ? 1 : 0}`).join('\n') + '\n';
}

// A play log drawn from entries (bet 1 per round), with a trigger column.
export function samplePmfLog(entries, rounds, rng) {
  const cum = [];
  let s = 0;
  for (const e of entries) { s += e.p; cum.push(s); }
  const lines = ['bet,win,trigger'];
  for (let i = 0; i < rounds; i++) {
    const u = uniform01(rng) * s;
    let lo = 0, hi = cum.length - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (u < cum[mid]) hi = mid; else lo = mid + 1; }
    lines.push(`1,${entries[lo].x},${entries[lo].trigger ? 1 : 0}`);
  }
  return lines.join('\n') + '\n';
}

// Distribution-based observed-RTP tests (lab/core/audit-stats.js). Every expected
// number below comes from a hand calculation, a brute-force enumeration, a second
// implementation (SciPy 1.18.1, stated where used) or a published table; the
// simulations are seeded, so each run gives the same result.
import test from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import {
  logDbinom, binomCdf, binomSf, binomTwoSidedP, clopperPearson, sampleBinomial, multinomialSampler,
  chiSquareQuantile, ncChiSquareSf, noncentralityForPower, makePmf, pmfFromExact, parsePmfCsv, buildCells,
  classifyRounds, logResolution, poolCells, goodnessOfFit, frequencyTest, holm, identifyVersion, runSprt,
  runMatrixSprt, sprtPlan, bettingTest, roundsMeanTest, roundsInterval, roundsEProcess, roundsRate,
  roundsLikelihoodRatio, roundsToSee, planSampleSize, auditDistribution, examplePmf, pmfCsv, samplePmfLog, uniform01,
} from '../../lab/core/audit-stats.js';
import { parsePlayLog } from '../../lab/core/actual.js';
import { Xoshiro128ss, prngFromSeed } from '../../lab/core/prng.js';
import { normalizeModel } from '../../lab/core/slot-model.js';
import { analyzeExact } from '../../lab/core/slot-exact.js';
import { Fraction } from '../../lab/core/fraction.js';

const near = (a, b, tol, label = '') => assert.ok(Math.abs(a - b) <= tol, `${label} ${a} vs ${b} (tol ${tol})`);
const rel = (a, b, r, label = '') => assert.ok(Math.abs(a - b) <= r * Math.abs(b), `${label} ${a} vs ${b} (rel ${r})`);
const seeded = (i) => new Xoshiro128ss(0x9e3779b9 ^ i, 0x243f6a88 + i, 0xb7e15162, i * 2654435761);
// Allowed false-alarm rate in R seeded runs: alpha plus three binomial standard errors.
const bound = (alpha, R) => alpha + 3 * Math.sqrt(alpha * (1 - alpha) / R);

// Exact binomial probability with BigInt binomial coefficients (independent of the module).
function exactBinom(k, n, p) {
  let c = 1n;
  for (let i = 0; i < k; i++) c = (c * BigInt(n - i)) / BigInt(i + 1);
  return Number(c) * p ** k * (1 - p) ** (n - k);
}
// ln(k!) by summation, for the brute-force multinomial enumeration.
const LNF = [0];
for (let i = 1; i <= 5000; i++) LNF.push(LNF[i - 1] + Math.log(i));

// Draws a play log of `n` rounds (bet 1) from entries [{x, p, trigger}].
function drawLog(entries, n, rng, withTrigger = false) {
  const cum = [];
  let s = 0;
  for (const e of entries) { s += e.p; cum.push(s); }
  const bets = new Float64Array(n).fill(1), wins = new Float64Array(n), triggers = withTrigger ? new Uint8Array(n) : null;
  for (let i = 0; i < n; i++) {
    const u = uniform01(rng) * s;
    let lo = 0;
    while (u >= cum[lo]) lo++;
    wins[i] = entries[lo].x;
    if (triggers) triggers[i] = entries[lo].trigger ? 1 : 0;
  }
  return { bets, wins, triggers, modes: null };
}

// Toy game with max win 20x: P(0.5)=.3, P(1)=.15, P(2)=.1, P(5)=.04, P(20)=q, rest no win.
// Mean = .15 + .15 + .2 + .2 + 20q, so q = .013 gives 96% and q = .012 gives 94%.
const toy = (q) => {
  const e = [{ x: 0.5, p: 0.3 }, { x: 1, p: 0.15 }, { x: 2, p: 0.1 }, { x: 5, p: 0.04 }, { x: 20, p: q }];
  return [{ x: 0, p: 1 - e.reduce((a, b) => a + b.p, 0) }, ...e];
};
const TOY96 = toy(0.013), TOY94 = toy(0.012);
// "Shifted" game: 3 points of the 2x wins taken away (RTP 90%).
const TOY_SHIFTED = TOY96.map((e) => (e.x === 2 ? { x: 2, p: 0.07 } : e.x === 0 ? { x: 0, p: e.p + 0.03 } : e));

// ---------- binomial distribution ----------
test('binomial pmf: Loader form equals exact BigInt values, and a 60-digit value at n = 1e9', () => {
  for (const [k, n, p] of [[0, 10, 0.3], [3, 10, 0.3], [10, 10, 0.3], [17, 40, 0.37], [60, 200, 0.25], [1, 1000, 0.002]]) {
    rel(Math.exp(logDbinom(k, n, p)), exactBinom(k, n, p), 1e-12, `f(${k}; ${n}, ${p})`);
  }
  // Python decimal at 60 digits, ln m! from Stirling's series with four Bernoulli terms:
  // -6.780843348190544951... (SciPy's binom.logpmf gives -6.7808439513: its lgamma
  // differences lose ~6e-7 to cancellation at this n).
  near(logDbinom(123456, 1e9, 1.2345e-4), -6.780843348190545, 1e-12);
});

test('binomial tails: brute-force sums for small n and SciPy for large n', () => {
  for (const [n, p] of [[10, 0.5], [25, 0.13], [60, 0.81]]) {
    let cum = 0;
    for (let k = 0; k <= n; k++) {
      const f = exactBinom(k, n, p);
      near(binomCdf(k, n, p), cum + f, 1e-13, `cdf ${k}/${n}`);
      near(binomSf(k, n, p), 1 - cum, 1e-13, `sf ${k}/${n}`);
      cum += f;
    }
  }
  // SciPy 1.18.1 stats.binom: cdf(400000, 1e6, .4), cdf(5000, 1e7, 5e-4), sf(119, 10000, .01),
  // cdf(70, 10000, .01), cdf(9700, 1e6, .01), sf(10299, 1e6, .01).
  rel(binomCdf(400000, 1e6, 0.4), 0.5004343132067661, 1e-10);
  rel(binomCdf(5000, 1e7, 0.0005), 0.5037611678884426, 1e-10);
  rel(binomSf(120, 10000, 0.01), 0.027597256302066213, 1e-10);
  rel(binomCdf(70, 10000, 0.01), 0.0009255700234974386, 1e-10);
  rel(binomCdf(9700, 1e6, 0.01), 0.0012493412682678662, 1e-9);
  rel(binomSf(10300, 1e6, 0.01), 0.0013631150395316599, 1e-9);
  // Two-sided P = twice the smaller tail: 2 * P(X <= 3 | 10, .5) = 2 * 176/1024.
  near(binomTwoSidedP(3, 10, 0.5), 352 / 1024, 1e-13);
});

test('Clopper-Pearson: closed forms at k = 0 and k = n, SciPy beta quantiles, and the defining tails', () => {
  // k = 0: upper = 1 - (alpha/2)^(1/n); k = n: lower = (alpha/2)^(1/n).
  const [l0, u0] = clopperPearson(0, 100, 0.95);
  assert.strictEqual(l0, 0);
  near(u0, 1 - 0.025 ** (1 / 100), 1e-15);
  near(clopperPearson(3, 3, 0.95)[0], 0.025 ** (1 / 3), 1e-15); // SciPy: 0.29240177382128674
  // SciPy: beta.ppf(a/2, k, n-k+1) and beta.ppf(1-a/2, k+1, n-k).
  const cases = [
    [1, 10, 0.95, 0.0025285785444617865, 0.4450161170281954],
    [7, 1000, 0.99, 0.00204138657144476, 0.017046931835088576],
    [500, 100000, 0.95, 0.0045722441500705875, 0.005456841177010281],
    [6667, 1000000, 0.99, 0.006459228807809079, 0.0068794799100614056],
  ];
  for (const [k, n, c, lo, hi] of cases) {
    const [a, b] = clopperPearson(k, n, c);
    rel(a, lo, 1e-9, `lower ${k}/${n}`);
    rel(b, hi, 1e-9, `upper ${k}/${n}`);
  }
  // Defining property with brute-force sums: P(X >= k | lower) = P(X <= k | upper) = 0.025.
  const [lo, hi] = clopperPearson(4, 20, 0.95);
  let up = 0, down = 0;
  for (let j = 4; j <= 20; j++) up += exactBinom(j, 20, lo);
  for (let j = 0; j <= 4; j++) down += exactBinom(j, 20, hi);
  near(up, 0.025, 1e-12);
  near(down, 0.025, 1e-12);
});

test('binomial sampler: chi-square against the exact pmf in both branches, moments at n = 1e6', () => {
  const rng = seeded(1);
  for (const [n, p] of [[30, 0.2], [200, 0.4], [40, 0.85]]) {
    const R = 200000;
    const counts = new Float64Array(n + 1);
    for (let i = 0; i < R; i++) counts[sampleBinomial(rng, n, p)]++;
    // Pool the tails to expected >= 5 and compute Pearson's statistic by hand.
    let chi2 = 0, df = -1, o = 0, e = 0;
    for (let k = 0; k <= n; k++) {
      o += counts[k]; e += R * exactBinom(k, n, p);
      if (e >= 5 && R * (1 - binomCdf(k, n, p)) >= 5) { chi2 += (o - e) ** 2 / e; df++; o = 0; e = 0; }
    }
    chi2 += (o - e) ** 2 / e; df++;
    // P(chi2_df > df + 5 sqrt(2 df)) is about 1e-5 or less: a correct sampler stays below.
    assert.ok(chi2 < df + 5 * Math.sqrt(2 * df), `Binomial(${n}, ${p}): chi2 ${chi2} df ${df}`);
  }
  let s = 0, s2 = 0;
  const R = 20000;
  for (let i = 0; i < R; i++) { const k = sampleBinomial(rng, 1e6, 0.3); s += k; s2 += k * k; }
  const mean = s / R, v = s2 / R - mean * mean;
  near(mean, 300000, 5 * Math.sqrt(210000 / R)); // np, 5 standard errors
  rel(v, 210000, 0.05); // npq; the sample variance's SE is about 1%
  const draw = multinomialSampler([0.5, 0.3, 0.2]);
  const out = draw(rng, 1000);
  assert.strictEqual(out[0] + out[1] + out[2], 1000);
});

// ---------- chi-square helpers ----------
test('chi-square quantiles and the noncentrality for 80% power match tables and SciPy', () => {
  near(chiSquareQuantile(0.05, 1), 3.841459, 1e-6); // standard table
  near(chiSquareQuantile(0.05, 10), 18.307038, 1e-6);
  // Cohen (1988), Table 7.4.6: N for w = 0.10 at alpha .05, power .80 is 785 (df 1), 964 (2),
  // 1090 (3), 1194 (4), i.e. lambda = N w^2. SciPy brentq on ncx2.sf gives the decimals.
  const scipy = { 1: 7.848860509326201, 2: 9.634688867970242, 3: 10.90256329013327, 4: 11.935285837704754, 10: 16.241110284944167, 40: 27.557225512049143 };
  const cohen = { 1: 785, 2: 964, 3: 1090, 4: 1194 };
  for (const df of [1, 2, 3, 4, 10, 40]) {
    const lam = noncentralityForPower(df, 0.05, 0.8);
    rel(lam, scipy[df], 1e-6, `df ${df}`);
    if (cohen[df]) near(lam / 0.01, cohen[df], 1, `Cohen df ${df}`);
  }
  near(noncentralityForPower(1, 0.01, 0.8), 11.67896814857075, 1e-6); // SciPy
  // df = 1: noncentral chi-square is (Z + sqrt(lambda))^2, so P(> c) = Phi(-z - s) + Phi(s - z) by hand.
  rel(ncChiSquareSf(20, 7, 12.5), 0.4292248027508538, 1e-9); // SciPy ncx2.sf
});

// ---------- pmf from the exact engine ----------
test('pmf export: 3-reel game by hand ({0: 54, 1: 1, 2: 8, 10: 1} of 64 combinations)', () => {
  // Reels A B B C each; 3 of a kind pays A 10, B 2, C 1: AAA 1 combo, BBB 8, CCC 1, else 54.
  const r = analyzeExact(normalizeModel({ rows: 1, reels: [['A', 'B', 'B', 'C'], ['A', 'B', 'B', 'C'], ['A', 'B', 'B', 'C']], paytable: { A: [0, 0, 10], B: [0, 0, 2], C: [0, 0, 1] } }));
  const pmf = r.distribution.pmf;
  assert.strictEqual(pmf.scope, 'round');
  assert.strictEqual(pmf.total, '64');
  assert.deepStrictEqual(pmf.entries.map((e) => [e.x, e.count, e.trigger]), [[0, '54', false], [1, '1', false], [2, '8', false], [10, '1', false]]);
  const p = pmfFromExact(pmf);
  near(p.mean, 27 / 64, 1e-15);
  near(p.pHit, 10 / 64, 1e-15);
});

test('pmf export with free spins: scatter outcomes by hand, triggering spins kept apart', () => {
  // 3 reels of [S, A, B], one row, one line; AAA pays 4; scatters pay 0 / 2 / 5 for 1 / 2 / 3
  // and 2+ trigger free spins. Of 27 combos: 0 scatters 8 (AAA 1 of them), 1 scatter 12,
  // 2 scatters 6, 3 scatters 1.
  const model = { rows: 1, reels: [['S', 'A', 'B'], ['S', 'A', 'B'], ['S', 'A', 'B']], paytable: { A: [0, 0, 4], B: [0, 0, 0] }, scatter: { symbol: 'S', pays: [0, 2, 5], freeSpins: { trigger: 2, spins: 3, multiplier: 1 } } };
  const pmf = analyzeExact(normalizeModel(model)).distribution.pmf;
  assert.strictEqual(pmf.scope, 'baseSpin');
  assert.deepStrictEqual(pmf.entries.map((e) => [e.x, e.trigger, e.count]), [[0, false, '19'], [2, true, '6'], [4, false, '1'], [5, true, '1']]);
  const p = pmfFromExact(pmf);
  near(p.pTrigger, 7 / 27, 1e-15);
  near(p.pHit, 8 / 27, 1e-15); // AAA or a trigger
});

// Independent evaluation of every stop combination (same rules as the brute force in
// slot-exact.test.mjs): total win per spin in total bets, as a count per value.
function bruteForcePmf(raw) {
  const N = raw.reels.length, R = raw.rows, L = raw.lines.length;
  const wild = raw.wild ? raw.wild.symbol : null, sc = raw.scatter || null;
  const pt = (sym, n) => Fraction.of((raw.paytable[sym] || [])[n - 1] || 0);
  const wildPay = (n) => (wild && n > 0 ? Fraction.of((raw.wild.pays || [])[n - 1] || 0) : new Fraction(0n));
  const scPay = (c) => (!sc || c === 0 ? new Fraction(0n) : Fraction.of(c <= sc.pays.length ? sc.pays[c - 1] || 0 : sc.pays[sc.pays.length - 1]));
  const stops = raw.reels.map(() => 0);
  const counts = new Map();
  for (;;) {
    const at = (k, r) => raw.reels[k][(stops[k] + r) % raw.reels[k].length];
    let total = new Fraction(0n);
    for (const line of raw.lines) {
      const syms = line.map((row, k) => at(k, row - 1));
      let w0 = 0;
      while (w0 < N && syms[w0] === wild) w0++;
      let best = wildPay(w0);
      if (w0 < N && syms[w0] !== (sc && sc.symbol)) {
        let n = w0;
        while (n < N && (syms[n] === syms[w0] || syms[n] === wild)) n++;
        if (pt(syms[w0], n).cmp(best) > 0) best = pt(syms[w0], n);
      }
      total = total.add(best);
    }
    let c = 0;
    if (sc) for (let k = 0; k < N; k++) for (let r = 0; r < R; r++) if (at(k, r) === sc.symbol) c++;
    const key = total.add(scPay(c).mul(L)).div(L).toString();
    counts.set(key, (counts.get(key) || 0) + 1);
    let k = 0;
    while (k < N && ++stops[k] === raw.reels[k].length) { stops[k] = 0; k++; }
    if (k === N) break;
  }
  return counts;
}

test('pmf export equals brute force over all 10,584 combinations (wild, scatter, 7 lines)', () => {
  const SMALL = {
    rows: 3,
    reels: [['A', 'K', 'W', 'Q', 'S', 'K', 'B'], ['K', 'A', 'Q', 'W', 'B', 'S'], ['Q', 'S', 'A', 'K', 'W', 'B', 'K'], ['A', 'W', 'K', 'Q', 'B', 'S'], ['K', 'Q', 'A', 'B', 'S', 'W']],
    lines: [[2, 2, 2, 2, 2], [1, 1, 1, 1, 1], [3, 3, 3, 3, 3], [1, 2, 3, 2, 1], [3, 2, 1, 2, 3], [1, 1, 2, 3, 3], [2, 3, 2, 1, 2]],
    paytable: { A: [0, 2, 10, 40, 150], K: [0, 0, 5, 20, 75], Q: [0, 0, 2.5, 10, 50], B: [0, 0, 0, 0, 0] },
    wild: { symbol: 'W', pays: [0, 5, 25, 100, 500] },
    scatter: { symbol: 'S', pays: [0, 0, 2, 10, 40] },
  };
  const brute = bruteForcePmf(SMALL);
  const pmf = analyzeExact(normalizeModel(SMALL)).distribution.pmf;
  assert.strictEqual(pmf.total, String(7 * 6 * 7 * 6 * 6));
  const got = new Map(pmf.entries.map((e) => [new Fraction(BigInt(e.units), BigInt(pmf.unitsPerBet)).toString(), Number(e.count)]));
  assert.deepStrictEqual([...got].sort(), [...brute].sort());
});

test('Desert Gold: the pmf agrees exactly with the per-line PAR and scatter convolution (a second algorithm)', () => {
  const raw = JSON.parse(fs.readFileSync(new URL('../../lab/samples/desert-gold.json', import.meta.url), 'utf8'));
  const r = analyzeExact(normalizeModel(raw));
  const pmf = r.distribution.pmf;
  const total = BigInt(pmf.total), per = BigInt(pmf.unitsPerBet);
  let sum = 0n, ev = 0n, trig = 0n, hit = 0n;
  for (const e of pmf.entries) {
    const c = BigInt(e.count);
    sum += c; ev += c * BigInt(e.units);
    if (e.trigger) trig += c;
    if (e.units > 0 || e.trigger) hit += c;
  }
  assert.strictEqual(sum, total);
  // Paid-spin EV = line + scatter contributions (computed from linePar and scatterDistribution).
  const frac = (f) => new Fraction(...f.fraction.split('/').concat('1').slice(0, 2).map(BigInt));
  assert.strictEqual(new Fraction(ev, total * per).toString(), frac(r.contributions.lines).add(frac(r.contributions.scatter)).toString());
  assert.strictEqual(new Fraction(trig, total).toString(), r.freeSpins.triggerProbability.fraction);
  assert.strictEqual(new Fraction(hit, total).toString(), r.distribution.hitFrequency.fraction);
});

// ---------- parsing ----------
test('pmf CSV: headers, weights normalized, exact fractions, trigger column, errors', () => {
  const a = parsePmfCsv('multiplier,probability,trigger\n0,0.5,0\n2,1/4,0\n10,0.25,1\n', 'v');
  assert.deepStrictEqual(a.entries.map((e) => [e.x, e.p, e.trigger]), [[0, 0.5, false], [2, 0.25, false], [10, 0.25, true]]);
  near(a.mean, 3, 1e-15); // 2/4 + 10/4
  near(a.pTrigger, 0.25, 1e-15);
  const b = parsePmfCsv('x;count\n0;6\n1,5;2\n1,5;2\n');
  assert.strictEqual(b.normalizedFrom, 10);
  assert.deepStrictEqual(b.entries.map((e) => [e.x, e.p]), [[0, 0.6], [1.5, 0.4]]);
  const c = parsePmfCsv('0,0.9\n10,0.1\n');
  near(c.mean, 1, 1e-15);
  assert.throws(() => parsePmfCsv('value,odds\n1,2\n'), (e) => Boolean(e.ar && e.en));
  assert.throws(() => parsePmfCsv('x,p\n-1,0.5\n'), /line 2/);
});

test('play log: trigger column, a "feature" flag column, and "feature" as a mode', () => {
  const a = parsePlayLog('round,bet,win,trigger\n1,1,0,0\n2,1,3,1\n2,0,5,\n3,1,0,no\n4,1,2,\n4,0,1,1\n');
  assert.deepStrictEqual([...a.triggers], [0, 1, 0, 1]);
  assert.deepStrictEqual([...a.wins], [0, 8, 0, 3]);
  const b = parsePlayLog('bet,win,feature\n1,0,0\n1,2,true\n1,1,false\n');
  assert.deepStrictEqual([...b.triggers], [0, 1, 0]);
  assert.strictEqual(b.modes, null);
  const c = parsePlayLog('bet,win,feature\n1,0,base\n1,2,buy\n');
  assert.strictEqual(c.triggers, null);
  assert.deepStrictEqual(c.modes, ['base', 'buy']);
  const d = parsePlayLog('bet,win,mode,feature\n1,0,base,0\n1,2,base,1\n');
  assert.deepStrictEqual([...d.triggers], [0, 1]);
  assert.deepStrictEqual(d.modes, ['base', 'base']);
  assert.strictEqual(parsePlayLog('bet,win\n1,0\n').triggers, null);
});

test('log resolution and matching of observed wins to pmf outcomes', () => {
  assert.strictEqual(logResolution({ bets: [0.2, 1], wins: [0.07, 0.35] }), 0.01);
  assert.strictEqual(logResolution({ bets: [1], wins: [0.333333] }), 1e-6);
  assert.strictEqual(logResolution({ bets: [1], wins: [1 / 3] }), null);
  const cells = buildCells([makePmf({ entries: [{ x: 0, p: 0.5 }, { x: 1 / 3, p: 0.25 }, { x: 0.35, p: 0.25 }] })]);
  // Bet 0.20, game pays round(0.2/3, 2) = 0.07 -> 0.35 is nearer than 1/3 (0.35 vs 0.3333).
  // Bet 3, win 1.00 -> exactly 1/3. Bet 1, win 0.5 -> nothing near (off the pmf).
  const idx = classifyRounds({ bets: [0.2, 3, 1, 1], wins: [0.07, 1, 0, 0.5] }, cells);
  assert.deepStrictEqual([...idx], [2, 1, 0, -1]);
});

// ---------- goodness of fit ----------
test('G and Pearson statistics by hand; Monte Carlo P matches the exact multinomial enumeration', async () => {
  // probs (.5, .25, .25), counts (30, 10, 20): E = (30, 15, 15).
  // X2 = 25/15 + 25/15 = 3.3333; G = 2 (10 ln(10/15) + 20 ln(20/15)) = 3.397980.
  // With 2 df the chi-square tail is exp(-x/2).
  const g = goodnessOfFit([30, 10, 20], [0.5, 0.25, 0.25], { rng: seeded(2), replicates: 19999, minExpected: 5 });
  near(g.X2, 10 / 3, 1e-12);
  near(g.G, 2 * (10 * Math.log(10 / 15) + 20 * Math.log(20 / 15)), 1e-12);
  near(g.pAsymptotic, Math.exp(-g.G / 2), 1e-12);
  near(g.pAsymptoticX2, Math.exp(-5 / 3), 1e-12);
  assert.strictEqual(g.df, 2);
  // Exact P(G* >= G) over all 1,891 outcomes of Multinomial(60; .5, .25, .25).
  let exact = 0, exactX2 = 0;
  for (let a = 0; a <= 60; a++) {
    for (let b = 0; a + b <= 60; b++) {
      const c = 60 - a - b;
      const lp = LNF[60] - LNF[a] - LNF[b] - LNF[c] + a * Math.log(0.5) + (b + c) * Math.log(0.25);
      const gs = 2 * [[a, 30], [b, 15], [c, 15]].reduce((s, [o, e]) => s + (o ? o * Math.log(o / e) : 0), 0);
      const xs = (a - 30) ** 2 / 30 + (b - 15) ** 2 / 15 + (c - 15) ** 2 / 15;
      if (gs >= g.G - 1e-9) exact += Math.exp(lp);
      if (xs >= g.X2 - 1e-9) exactX2 += Math.exp(lp);
    }
  }
  near(g.pValue, exact, 0.01); // MC standard error ~0.003 at 19,999 replicates
  near(g.pValueX2, exactX2, 0.01);
});

test('pooling: adjacent cells until each expects 5 rounds; a short last bin joins the previous one', () => {
  // n = 100: expected 60, 3, 3, 30, 2, 2 -> [60], [3 + 3], [30], and the short [2 + 2]
  // joins [30]: bins (0), (1-2), (3-5).
  const bins = poolCells([0.6, 0.03, 0.03, 0.3, 0.02, 0.02], 100, 5);
  assert.deepStrictEqual(bins.map((b) => [b.from, b.to]), [[0, 0], [1, 2], [3, 5]]);
  near(bins[2].p, 0.34, 1e-15);
  // Too few rounds for two bins: not applicable.
  assert.strictEqual(goodnessOfFit([3, 1], [0.5, 0.5], { rng: seeded(1), replicates: 9 }).applicable, false);
});

test('minimum detectable effect: Cohen w and the relative change of the largest bin agree with a direct construction', () => {
  const p0 = [0.6, 0.25, 0.15];
  const g = goodnessOfFit([600, 250, 150], p0, { rng: seeded(3), replicates: 99, alpha: 0.05, power: 0.8 });
  // df 2: lambda = 9.634688867970242 (SciPy), w = sqrt(lambda / n).
  near(g.mde.w, Math.sqrt(9.634688867970242 / 1000), 1e-8);
  // Change bin 0 by delta and the rest proportionally: w^2 = sum (p1 - p0)^2 / p0 must equal lambda / n.
  const d = g.mde.relativeChange;
  const p1 = [0.6 * (1 + d), ...[0.25, 0.15].map((p) => p * (1 - 0.6 * d / 0.4))];
  const w2 = p1.reduce((s, p, i) => s + (p - p0[i]) ** 2 / p0[i], 0);
  near(w2, g.mde.w ** 2, 1e-12);
});

test('GOF false-alarm rate <= alpha on 400 seeded fair logs; power on a shifted game', () => {
  const pmf = makePmf({ entries: TOY96 });
  const cells = buildCells([pmf]);
  const run = (entries, i) => {
    const log = drawLog(entries, 3000, seeded(100 + i));
    const idx = classifyRounds(log, cells, 0.01);
    const counts = new Float64Array(cells.K);
    for (const k of idx) counts[k]++;
    return goodnessOfFit(counts, cells.probs[0], { rng: seeded(5000 + i), replicates: 199, alpha: 0.05 }).pValue;
  };
  let fa = 0, power = 0;
  for (let i = 0; i < 400; i++) if (run(TOY96, i) < 0.05) fa++;
  for (let i = 0; i < 100; i++) if (run(TOY_SHIFTED, i) < 0.05) power++;
  assert.ok(fa / 400 <= bound(0.05, 400), `false alarms ${fa}/400`);
  // w^2 = .03^2/.1 + .03^2/.397 = .01127; n w^2 = 33.8 >> 12.8 (lambda for 80% at df 5): power near 1.
  assert.ok(power >= 95, `power ${power}/100`);
});

test('frequency tests: exact binomial test and Clopper-Pearson coverage on seeded fair runs; MDE by hand', () => {
  const rng = seeded(7);
  let rejects = 0, covered = 0;
  const R = 2000, n = 1000, p = 0.3;
  for (let r = 0; r < R; r++) {
    const k = sampleBinomial(rng, n, p);
    const f = frequencyTest(k, n, p, { alpha: 0.05 });
    if (f.pValue < 0.05) rejects++;
    if (f.ci[0] <= p && p <= f.ci[1]) covered++;
  }
  assert.ok(rejects / R <= bound(0.05, R), `rejects ${rejects}`);
  assert.ok(covered / R >= 0.95 - 3 * Math.sqrt(0.05 * 0.95 / R), `coverage ${covered}`);
  // n = 10,000, p0 = .5, alpha .05 two-sided, power .8: d sqrt(n) = 1.959964 * .5 + 0.841621 sqrt(p1 q1),
  // p1 = .5 - d -> d = 0.0140061 (two fixed-point steps by hand).
  near(frequencyTest(5000, 10000, 0.5, { alpha: 0.05 }).mde.absolute, 0.0140061, 2e-6);
});

test('Holm step-down by hand', () => {
  // m = 4, alpha .05: sorted .001 < .0125 ok, .013 < .05/3 ok, .03 > .025 stop.
  assert.deepStrictEqual(holm([0.03, 0.001, 0.013, 0.2], 0.05), [false, true, true, false]);
});

// ---------- the whole fit family ----------
test('fit family: false-alarm rate <= alpha on 200 seeded fair logs of the example game (GOF, hit, trigger, tails)', () => {
  const entries = examplePmf(0.96);
  const pmf = parsePmfCsv(pmfCsv(entries), '96');
  let alarms = 0;
  const R = 200;
  for (let i = 0; i < R; i++) {
    const log = drawLog(entries, 20000, seeded(300 + i), true);
    const r = auditDistribution(log, [pmf], { alpha: 0.05, replicates: 199, declaredRtp: 0.96, maxWin: 5000 }, seeded(900 + i));
    assert.ok(r.fit.gof.applicable && r.fit.trigger && r.fit.hit);
    if (r.fit.verdict !== 'consistent') alarms++;
  }
  assert.ok(alarms / R <= bound(0.05, R), `family false alarms ${alarms}/${R}`);
});

test('fit family: missing top prizes, impossible wins and a paid-spin pmf without a trigger column', () => {
  const pmf = makePmf({ entries: TOY96 });
  // The 20x prize suppressed: expected 39 in 3,000 rounds, none seen: P = .987^3000 = e^-39.3.
  const noTop = TOY96.map((e) => (e.x === 20 ? { x: 20, p: 0 } : e.x === 0 ? { x: 0, p: e.p + 0.013 } : e));
  const r = auditDistribution(drawLog(noTop, 3000, seeded(11)), [pmf], { alpha: 0.01, replicates: 199 }, seeded(12));
  assert.strictEqual(r.fit.verdict, 'mismatch');
  const top = r.fit.tails[r.fit.tails.length - 1];
  assert.strictEqual(top.observed, 0);
  rel(top.pValue, 0.987 ** 3000, 1e-9);
  rel(r.fit.topPrize.pNeverSeen, 0.987 ** 3000, 1e-9);
  near(r.fit.topPrize.ruleOfThree, 1 - 0.05 ** (1 / 3000), 1e-15);
  near(r.fit.topPrize.rtpShare, 20 * 0.013 / 0.96, 1e-12);
  near(r.fit.unseen.rtpAbove, 0.26, 1e-12); // 20 x .013 never shown by this log
  // A win the pmf cannot produce.
  const log = drawLog(TOY96, 500, seeded(13));
  log.wins[10] = 3.7;
  const bad = auditDistribution(log, [pmf], { alpha: 0.01, replicates: 99 }, seeded(14));
  assert.strictEqual(bad.fit.verdict, 'impossible');
  assert.deepStrictEqual(bad.fit.offSupport.examples, [{ round: 11, x: 3.7, triggered: false }]);
  // Paid-spin pmf, no trigger column: no GOF, said so.
  const base = makePmf({ scope: 'baseSpin', entries: [{ x: 0, p: 0.7 }, { x: 1, p: 0.25 }, { x: 0, p: 0.05, trigger: true }] });
  const nb = auditDistribution(drawLog(TOY96, 200, seeded(15)), [base], {}, seeded(16));
  assert.strictEqual(nb.fit.unavailable, 'needTriggerColumn');
  assert.strictEqual(nb.fit.verdict, 'insufficient');
});

// ---------- version identification ----------
test('version identification: likelihood and posterior by hand', () => {
  // Two cells; p = (.5, .5), q = (.8, .2); counts (3, 1): L_p = 1/16, L_q = .8^3 x .2 = .1024,
  // posterior of q = .1024 / (.1024 + .0625) = 1024/1649.
  const cells = { K: 2, probs: [Float64Array.of(0.5, 0.5), Float64Array.of(0.8, 0.2)] };
  const v = identifyVersion(Int32Array.of(0, 0, 1, 0), cells, ['p', 'q']);
  near(v.models[0].logLik, Math.log(1 / 16), 1e-12);
  near(v.models[1].logLik, Math.log(0.1024), 1e-12);
  near(v.models[1].posterior, 1024 / 1649, 1e-12);
  // KL(p || q) = .5 ln(.5/.8) + .5 ln(.5/.2) = .5 ln(1.5625) = 0.2231436.
  near(v.kl[0][1], 0.5 * Math.log(0.625) + 0.5 * Math.log(2.5), 1e-12);
  // An outcome only one candidate allows decides it.
  const c2 = { K: 2, probs: [Float64Array.of(1, 0), Float64Array.of(0.9, 0.1)] };
  const w = identifyVersion(Int32Array.of(0, 1), c2, ['a', 'b']);
  assert.strictEqual(w.models[0].impossible, 1);
  assert.strictEqual(w.models[1].posterior, 1);
  assert.deepStrictEqual([w.sequential.decision, w.sequential.at], [1, 2]);
});

test('research figures for the synthetic 96% vs 94% game: KL, SPRT ASN, fixed-n LR, mean and trigger tests', () => {
  // The game of research/actual-rtp-stats.md (base wins + a bonus whose trigger rate sets the RTP),
  // rebuilt here from its published tables.
  const BASE = [[0.2, 0.1], [0.5, 0.08], [1, 0.06], [2, 0.04], [5, 0.02], [10, 0.006], [25, 0.002], [100, 0.0001]];
  const BONUS = [[10, 0.4], [30, 0.3], [80, 0.2], [300, 0.08], [1000, 0.018], [5000, 0.002]];
  const version = (rtp) => {
    const be = BASE.reduce((a, [v, p]) => a + v * p, 0), bo = BONUS.reduce((a, [v, p]) => a + v * p, 0);
    const t = (rtp - be) / bo;
    const e = [...BASE.map(([x, p]) => ({ x, p })), ...BONUS.map(([x, p]) => ({ x, p: p * t, trigger: true }))];
    return [{ x: 0, p: 1 - e.reduce((a, b) => a + b.p, 0) }, ...e];
  };
  const pm = [0.96, 0.94].map((r) => makePmf({ entries: version(r) }));
  // The lab's example generator builds the same game.
  assert.deepStrictEqual(makePmf({ entries: examplePmf(0.94) }).entries, pm[1].entries);
  const v = identifyVersion(new Int32Array(0), buildCells(pm), ['96', '94'], { alpha: 0.05, beta: 0.2 });
  const pair = v.pairs[0];
  // Fact-check: KL(94 || 96) = 3.387e-6; Wald ASN at alpha 5%, beta 20% = 562,805; at alpha = beta = 5%, 782,311.
  rel(pair.klAltRef, 3.387e-6, 1e-3);
  near(pair.asnAlt, 562805, 1);
  near(sprtPlan(0.05, 0.05, pair.klRefAlt, pair.klAltRef).asnAlt, 782311, 1);
  // Research (power.mjs, confirmed): fixed-n LR 912,436; mean z-test 7,953,948; trigger count 663,139.
  const cells = buildCells(pm);
  const lv = (p, q) => { let m = 0, m2 = 0; p.forEach((pk, k) => { const z = Math.log(q[k] / pk); m += pk * z; m2 += pk * z * z; }); return m2 - m * m; };
  near(roundsLikelihoodRatio(pair.klRefAlt, pair.klAltRef, lv(cells.probs[0], cells.probs[1]), lv(cells.probs[1], cells.probs[0]), 0.05, 0.8), 912436, 1);
  near(roundsMeanTest(pm[0].sd, 0.02, 0.05, 0.8), 7953948, 1);
  near(roundsRate(pm[0].pTrigger, pm[1].pTrigger, 0.05, 0.8), 663139, 1);
});

// Two 3-outcome versions with KL ~ 0.0033: Wald's SPRT stops after a few hundred rounds.
const P0 = Float64Array.of(0.5, 0.3, 0.2), P1 = Float64Array.of(0.46, 0.32, 0.22);
function drawCells(p, n, rng) {
  const out = new Int32Array(n);
  for (let i = 0; i < n; i++) { const u = uniform01(rng); out[i] = u < p[0] ? 0 : u < p[0] + p[1] ? 1 : 2; }
  return out;
}

test('Wald SPRT: expected rounds match a 2,000-run simulation; error rates within alpha and beta', () => {
  const alpha = 0.05, beta = 0.2;
  // KL by hand: KL(P1||P0) = .46 ln .92 + .32 ln(32/30) + .22 ln 1.1 = 0.0032648.
  const klAltRef = 0.46 * Math.log(0.92) + 0.32 * Math.log(0.32 / 0.3) + 0.22 * Math.log(1.1);
  const klRefAlt = 0.5 * Math.log(0.5 / 0.46) + 0.3 * Math.log(0.3 / 0.32) + 0.2 * Math.log(0.2 / 0.22);
  const plan = sprtPlan(alpha, beta, klRefAlt, klAltRef);
  near(plan.asnAlt, (0.8 * Math.log(0.8 / 0.05) + 0.2 * Math.log(0.2 / 0.95)) / klAltRef, 1e-9);
  for (const [truth, asn, wrong, limit] of [[P1, plan.asnAlt, 'reference', beta], [P0, plan.asnRef, 'alternative', alpha]]) {
    let sum = 0, errors = 0;
    const R = 2000;
    for (let r = 0; r < R; r++) {
      const s = runSprt(drawCells(truth, 20000, seeded(r + (truth === P0 ? 50000 : 0))), P0, P1, { alpha, beta });
      assert.notStrictEqual(s.decision, 'continue');
      sum += s.at;
      if (s.decision === wrong) errors++;
    }
    // Wald's approximation ignores the overshoot of the boundary; a few percent here.
    rel(sum / R, asn, 0.1, 'ASN');
    assert.ok(errors / R <= bound(limit, R), `errors ${errors}/${R}`);
  }
});

test('matrix SPRT over three versions: wrong decisions <= alpha, and the true one is found', () => {
  const P2 = Float64Array.of(0.42, 0.34, 0.24);
  const cells = { K: 3, probs: [P0, P1, P2] };
  let wrong = 0, decided = 0;
  const R = 600;
  for (let r = 0; r < R; r++) {
    const truth = r % 3;
    const s = runMatrixSprt(drawCells(cells.probs[truth], 40000, seeded(7000 + r)), cells.probs, 0.05);
    if (s.decision !== null) { decided++; if (s.decision !== truth) wrong++; }
  }
  assert.ok(decided >= 0.99 * R, `decided ${decided}`);
  assert.ok(wrong / R <= bound(0.05, R), `wrong ${wrong}`);
  // Threshold ln((V - 1) / alpha) = ln 40.
  near(runMatrixSprt(new Int32Array(0), cells.probs, 0.05).threshold, Math.log(40), 1e-15);
});

// ---------- betting e-process ----------
test('e-process: never crosses on 20 seeded fair runs; crosses on 94% vs declared 96% (toy game, M = 20)', () => {
  const run = (entries, i) => {
    const log = drawLog(entries, 400000, seeded(20000 + i));
    return bettingTest(log.wins, { mu0: 0.96, M: 20, alpha: 0.01, grid: false });
  };
  for (let i = 0; i < 20; i++) {
    const r = run(TOY96, i);
    assert.strictEqual(r.rejected, false, `fair run ${i}: max capital ${r.maxEValue}`);
    assert.ok(r.pValue > 0.01);
  }
  let caught = 0;
  for (let i = 0; i < 20; i++) if (run(TOY94, i).rejected) caught++;
  // sigma = 2.43, gap .02: the best constant bet needs ~ ln(100) / (gap^2 / (2 sigma^2)) = 136k rounds.
  assert.ok(caught >= 18, `caught ${caught}/20`);
});

test('e-process: anytime upper bound covers the true RTP on fair runs; M is enforced', () => {
  for (let i = 0; i < 4; i++) {
    const r = bettingTest(drawLog(TOY96, 100000, seeded(30000 + i)).wins, { mu0: 0.96, M: 20, alpha: 0.05 });
    assert.ok(r.upperBound === null || r.upperBound > 0.96, `upper bound ${r.upperBound}`);
    assert.strictEqual(r.trajectory[0][0], 0);
    assert.strictEqual(r.trajectory[r.trajectory.length - 1][0], 100000);
  }
  // On a game paying 80%, the bound drops below the declared value.
  const low = toy(0.005); // mean .7 + .1 = .8
  const r = bettingTest(drawLog(low, 100000, seeded(31000)).wins, { mu0: 0.96, M: 20, alpha: 0.05 });
  assert.ok(r.rejected && r.upperBound <= 0.9, `upper ${r.upperBound}`);
  assert.throws(() => bettingTest([0, 25], { mu0: 0.96, M: 20 }), (e) => Boolean(e.ar && /25/.test(e.en)));
  assert.throws(() => bettingTest([0, 1], { mu0: 0.96, M: 0.5 }), (e) => Boolean(e.ar && e.en));
});

// ---------- planner ----------
test('planner: closed forms and the research tables', () => {
  // Research (confirmed): +/-1% at 95% needs 345,731 / 2,458,534 / 8,643,282 / 24,009,118 rounds
  // for sigma 3 / 8 / 15 / 25; a 2-point gap (alpha 5% one-sided, power 80%) 139,108 / 989,209 /
  // 3,477,688 / 9,660,246. The research rounds to nearest; the planner rounds up
  // ((1.959964 x 3 / .01)^2 = 345,731.3 -> 345,732), so they differ by at most 1.
  [345731, 2458534, 8643282, 24009118].forEach((v, i) => near(roundsInterval([3, 8, 15, 25][i], 0.01, 0.05), v, 1));
  [139108, 989209, 3477688, 9660246].forEach((v, i) => near(roundsMeanTest([3, 8, 15, 25][i], 0.02, 0.05, 0.8), v, 1));
  assert.strictEqual(roundsInterval(3, 0.01, 0.05), 345732);
  // e-process, sigma 3, gap .02, M 1000, mu0 .96, alpha .05, c .5 (by hand):
  // lambda = min(.02 / 9.0004, .5 / 999.04) = 5.004804e-4 (the cap binds);
  // growth = lambda x .02 - lambda^2 x 9.0004 / 2 = 1.000961e-5 - 1.127206e-6 = 8.882403e-6;
  // rounds = ln 20 / growth = 2.995732 / 8.882403e-6 = 337,266.
  near(roundsEProcess(3, 1000, 0.96, 0.02, 0.05), 337266, 2);
  // Without the cap (M large enough not to bind at sigma 25): lambda = gap / (sigma^2 + gap^2),
  // growth = gap^2 / (2 (sigma^2 + gap^2)), rounds = 2 ln 20 (625.0004) / .0004 = 9,361,668.
  near(roundsEProcess(25, 1000, 0.96, 0.02, 0.05), 2 * Math.log(20) * 625.0004 / 0.0004, 2);
  // Seeing a 1-in-75,000 prize with 95% chance: ln .05 / ln(1 - 1/75000) = 224,679.
  assert.strictEqual(roundsToSee(1 / 75000), Math.ceil(Math.log(0.05) / Math.log1p(-1 / 75000)));
  near(roundsToSee(1 / 75000), 3 * 75000, 1000); // rule of three
  const plan = planSampleSize({ mu0: 0.96, sigma: 8, M: 5000, gap: 0.02, alpha: 0.05 });
  near(plan.rows.find((r) => r.id === 'meanTest').rounds, 989209, 1);
  assert.deepStrictEqual(plan.grid.map((g) => g.sigma), [3, 8, 15, 25]);
  assert.deepStrictEqual(plan.maxWins, [1000, 5000, 50000]);
  // A larger M never needs fewer rounds.
  for (const g of plan.grid) for (let i = 1; i < g.eProcess.length; i++) assert.ok(g.eProcess[i].rounds >= g.eProcess[i - 1].rounds);
});

// ---------- whole audit ----------
test('whole audit on the three example versions: candidates, identification, e-process, planner', async () => {
  const pmfs = [0.96, 0.94, 0.92].map((r) => parsePmfCsv(pmfCsv(examplePmf(r)), String(r * 100)));
  const log = parsePlayLog(samplePmfLog(examplePmf(0.94), 50000, await prngFromSeed('audit-test')));
  assert.strictEqual(log.bets.length, 50000);
  const r = auditDistribution(log, pmfs, { refIndex: 0, alpha: 0.01, declaredRtp: 0.96, maxWin: 5000, replicates: 199 }, seeded(1));
  assert.strictEqual(r.candidates.length, 3);
  assert.ok(r.versions.models.every((m) => m.posterior > 0));
  near(r.versions.models.reduce((a, m) => a + m.posterior, 0), 1, 1e-12);
  assert.strictEqual(r.versions.pairs.length, 2);
  assert.ok(!r.versions.pairs[0].sprt, 'two-hypothesis SPRT only with two candidates');
  assert.strictEqual(r.betting.M, 5000);
  assert.strictEqual(r.betting.rejected, false); // 50k rounds cannot show a 2-point gap at sigma 22
  assert.ok(r.planner.rows.some((x) => x.id === 'sprt'));
  // Mode filter keeps only that mode's rounds.
  const mixed = parsePlayLog('bet,win,mode\n1,0,base\n1,2,buy\n1,0,base\n');
  const m = auditDistribution(mixed, [makePmf({ entries: [{ x: 0, p: 0.5 }, { x: 2, p: 0.5 }] })], { mode: 'base', replicates: 9 }, seeded(2));
  assert.strictEqual(m.rounds, 2);
  assert.throws(() => auditDistribution(mixed, [makePmf({ entries: [{ x: 0, p: 1 }] })], { mode: 'ante' }, seeded(3)), (e) => Boolean(e.ar && e.en));
});

// Monte Carlo simulation of a normalized slot model (see slot-model.js) with the
// seeded generator in prng.js. Same model + seed + spin count => same numbers.
// Win amounts are kept in the model's integer units, so totals are exact.
// Unweighted reels draw each stop with rng.nextBelow(stops), exactly as before
// weights existed, so their runs (and fingerprints) are unchanged. Weighted models
// draw as described in PRNG_DESCRIPTION_WEIGHTED (prng.js).
import { PRNG_DESCRIPTION, PRNG_DESCRIPTION_WEIGHTED, PRNG_DESCRIPTION_WAYS } from './prng.js';
import { waysBoardEvaluator } from './ways-exact.js';

const BUCKETS = [0, 1, 2, 5, 10, 20, 50, 100, 500];
const FS_CAP = 100000; // free spins per trigger before the run is flagged

// Index of the first cumulative bound above u (cum is increasing).
function upperBound(cum, u) {
  let lo = 0, hi = cum.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cum[mid] > u) hi = mid; else lo = mid + 1;
  }
  return lo;
}

// Exact, unbiased draw of an index with probability weight / total (BigInt weights):
// u is uniform on [0, total), and the index is the first entry whose cumulative weight
// exceeds u. x joins k 32-bit draws (most significant first; k = 1 up to 2^32, two up
// to 2^64); x >= limit = 2^(32k) - (2^(32k) mod total) is drawn again (limit itself
// too), and u = x mod total. Up to 2^32 this is exactly rng.nextBelow(total), so with
// every weight 1 it picks the same index as rng.nextBelow(count). The rule is spelled
// out in PRNG_DESCRIPTION_WEIGHTED (prng.js), which weighted runs record.
export function weightedPicker(weights) {
  let total = 0n;
  const cum = weights.map((w) => (total += BigInt(w)));
  if (total <= 0x100000000n) {
    const t = Number(total), c = Float64Array.from(cum, Number);
    return (rng) => upperBound(c, rng.nextBelow(t));
  }
  const words = Math.ceil((total - 1n).toString(2).length / 32);
  const span = 1n << BigInt(32 * words);
  const limit = span - (span % total);
  return (rng) => {
    let x;
    do {
      x = 0n;
      for (let i = 0; i < words; i++) x = (x << 32n) | BigInt(rng.nextU32());
    } while (x >= limit);
    return upperBound(cum, x % total);
  };
}

// The generator text a run records (and its fingerprint covers).
export function generatorDescription(model) {
  if (model && model.evaluation === 'ways') return PRNG_DESCRIPTION_WAYS;
  return model && model.weighted ? PRNG_DESCRIPTION_WEIGHTED : PRNG_DESCRIPTION;
}

// Reel sets ready to draw from: a set picker when there are several, and a stop
// picker for each weighted reel (null = uniform stops).
function prepareSets(sets) {
  return {
    pickSet: sets.length > 1 ? weightedPicker(sets.map((s) => s.weight)) : null,
    sets: sets.map((s) => ({ reels: s.reels, pick: s.reels.map((_, k) => (s.weights && s.weights[k] ? weightedPicker(s.weights[k]) : null)) })),
  };
}

function makeEvaluator(model) {
  const N = model.nReels, R = model.rows, L = model.lines.length;
  const window = new Int32Array(N * R);
  const evalWindow = () => {
    let win = 0;
    for (let l = 0; l < L; l++) {
      const line = model.lines[l];
      let w0 = 0;
      while (w0 < N && window[w0 * R + line[w0]] === model.wild) w0++;
      let best = model.wildPays[w0] || 0;
      if (w0 < N) {
        const t = window[w0 * R + line[w0]];
        if (t !== model.scatter) {
          let n = w0 + 1;
          while (n < N) {
            const x = window[n * R + line[n]];
            if (x !== t && x !== model.wild) break;
            n++;
          }
          const p = model.linePays[t][n];
          if (p > best) best = p;
        }
      }
      win += best;
    }
    let sc = 0;
    if (model.scatter >= 0) for (let i = 0; i < N * R; i++) if (window[i] === model.scatter) sc++;
    return { win: win + model.scatterPays[sc], scatters: sc };
  };
  // One spin: the reel set first (if there are several), then reels 1..N in order.
  const spin = (rng, src) => {
    const set = src.pickSet ? src.sets[src.pickSet(rng)] : src.sets[0];
    for (let k = 0; k < N; k++) {
      const s = set.reels[k], pick = set.pick[k];
      const stop = pick ? pick(rng) : rng.nextBelow(s.length);
      for (let r = 0; r < R; r++) window[k * R + r] = s[(stop + r) % s.length];
    }
    return evalWindow();
  };
  return spin;
}

// One paid round including any free spins it triggers. play(rng) returns the win
// in model units; stats keeps feature counters across rounds (and, in baseWin, the
// paid spin's own win of the last round).
export function makeRoundPlayer(model) {
  const ways = model.evaluation === 'ways' ? makeWaysSpinner(model) : null;
  const spin = ways ? ways.spin : makeEvaluator(model);
  const fs = model.freeSpins;
  const baseSets = model.reelSets || [{ weight: 1n, reels: model.reels, weights: null }];
  const baseSrc = ways ? ways.prepare(model.ways.base) : prepareSets(baseSets);
  const fsSrc = !fs ? null : ways ? (fs.sameReels ? baseSrc : ways.prepare(model.ways.fs))
    : fs.reelSets === baseSets || (!fs.reelSets && fs.reels === model.reels) ? baseSrc
    : prepareSets(fs.reelSets || [{ weight: 1n, reels: fs.reels, weights: null }]);
  const mult = fs ? fs.multiplier.toNumber() : 1;
  const stats = { triggered: false, triggers: 0, fsPlayed: 0, capped: 0 };
  const play = (rng) => {
    const base = spin(rng, baseSrc);
    let win = base.win;
    stats.baseWin = base.win;
    stats.triggered = false;
    if (fs && base.scatters >= fs.trigger) {
      stats.triggered = true;
      stats.triggers++;
      let pending = fs.spins, played = 0, fsWin = 0;
      while (pending > 0) {
        pending--; played++;
        const r = spin(rng, fsSrc);
        fsWin += r.win;
        if (fs.retrigger && r.scatters >= fs.trigger) pending += fs.spins;
        if (played >= FS_CAP) { stats.capped++; break; }
      }
      stats.fsPlayed += played;
      win += fsWin * mult;
    }
    return win;
  };
  return { play, stats };
}

export function simulate(model, rng, spins, { onProgress = () => {}, progressEvery = 100000 } = {}) {
  const { play, stats } = makeRoundPlayer(model);
  let total = 0, sumSq = 0, hits = 0, maxWin = 0;
  // Ways models also keep the paid spin's own win X next to the round's win Y, so the
  // exact mean of X can serve as a control variate (controlVariate below).
  const paid = model.evaluation === 'ways' ? { total: 0, sumSq: 0, crossSum: 0 } : null;
  const buckets = new Array(BUCKETS.length + 1).fill(0);
  for (let i = 0; i < spins; i++) {
    const win = play(rng);
    total += win;
    sumSq += win * win;
    if (win > 0 || stats.triggered) hits++;
    if (win > maxWin) maxWin = win;
    if (paid) { const x = stats.baseWin; paid.total += x; paid.sumSq += x * x; paid.crossSum += x * win; }
    const x = win / model.totalBetUnits;
    let b = 0;
    if (x > 0) { b = BUCKETS.length; for (let j = 1; j < BUCKETS.length; j++) if (x < BUCKETS[j]) { b = j; break; } }
    buckets[b]++;
    if ((i + 1) % progressEvery === 0) onProgress((i + 1) / spins);
  }
  onProgress(1);
  const tb = model.totalBetUnits;
  const mean = total / spins;
  const variance = Math.max(0, sumSq / spins - mean * mean) * spins / Math.max(1, spins - 1);
  const sd = Math.sqrt(variance) / tb;
  const se = sd / Math.sqrt(spins);
  const rtp = mean / tb;
  return {
    spins, totalWinUnits: total, rtp, sd, standardError: se, ci95: [rtp - 1.959964 * se, rtp + 1.959964 * se],
    hitFrequency: hits / spins, maxWin: maxWin / tb, triggers: stats.triggers, freeSpinsPlayed: stats.fsPlayed, cappedFeatures: stats.capped,
    buckets: buckets.map((c, i) => ({ from: i === 0 ? 0 : BUCKETS[i - 1], to: i === 0 ? 0 : i < BUCKETS.length ? BUCKETS[i] : null, probability: c / spins })),
    ...(paid ? { scope: model.cascades ? 'firstDrop' : 'round', paidSpin: paid } : model.cascades ? { scope: 'firstDrop' } : {}),
  };
}

// ---- Ways models (P0-6) ----
// The spin of a ways model: reel set, then per reel the height and the stop (or a joint
// pair), then the top reel, as PRNG_DESCRIPTION_WAYS states; the board is paid by
// ways-exact.js in exact integer units.
function makeWaysSpinner(model) {
  const N = model.nReels;
  const evaluate = waysBoardEvaluator(model);
  const stride = 12; // up to 10 rows plus a top-reel cell
  const cells = new Int32Array(N * stride), lens = new Int32Array(N);
  const prepare = (src) => ({
    pickSet: src.sets.length > 1 ? weightedPicker(src.sets.map((s) => s.weight)) : null,
    sets: src.sets.map((set) => ({
      reels: set.reels,
      picks: set.reels.map((strip, i) => {
        const h = src.heights[i];
        if (h.joint) {
          const pairs = [];
          h.joint.forEach((row, p) => row.forEach((w, j) => { if (w > 0n) pairs.push({ p, rows: h.rows[j], w }); }));
          return { pairs, pick: weightedPicker(pairs.map((x) => x.w)) };
        }
        return {
          rows: h.rows, height: h.rows.length > 1 ? weightedPicker(h.weights || h.rows.map(() => 1n)) : null,
          stop: set.weights && set.weights[i] ? weightedPicker(set.weights[i]) : null,
        };
      }),
    })),
    top: src.top && { strip: src.top.strip, covers: src.top.covers, pick: src.top.weights ? weightedPicker(src.top.weights) : null },
  });
  const spin = (rng, src) => {
    const set = src.pickSet ? src.sets[src.pickSet(rng)] : src.sets[0];
    for (let k = 0; k < N; k++) {
      const strip = set.reels[k], pk = set.picks[k];
      let p, rows;
      if (pk.pairs) { const e = pk.pairs[pk.pick(rng)]; p = e.p; rows = e.rows; } else {
        rows = pk.height ? pk.rows[pk.height(rng)] : pk.rows[0];
        p = pk.stop ? pk.stop(rng) : rng.nextBelow(strip.length);
      }
      for (let r = 0; r < rows; r++) cells[k * stride + r] = strip[(p + r) % strip.length];
      lens[k] = rows;
    }
    const t = src.top;
    if (t) {
      const q = t.pick ? t.pick(rng) : rng.nextBelow(t.strip.length);
      t.covers.forEach((c, m) => { cells[c * stride + lens[c]] = t.strip[(q + m) % t.strip.length]; lens[c]++; });
    }
    return evaluate(cells, lens, stride);
  };
  return { prepare, spin };
}

// Control variate (Owen, Monte Carlo theory, methods and examples, ch. 8): with X the
// paid spin's own win, whose exact mean muX (x total bet) the theoretical tab gives,
// Y_cv = mean(Y) - beta (mean(X) - muX), beta = Cov(X, Y) / Var(X), and its standard
// error sd(Y) sqrt(1 - rho^2) / sqrt(n). For a game whose round is the paid spin alone
// (no free spins) X = Y and the estimate is muX itself.
export function controlVariate(sim, muX, totalBetUnits) {
  const p = sim.paidSpin;
  if (!p || !(sim.spins > 1)) return null;
  const n = sim.spins, tb = totalBetUnits;
  const mx = p.total / n / tb, my = sim.totalWinUnits / n / tb;
  const vx = Math.max(0, p.sumSq / n / (tb * tb) - mx * mx);
  const vy = (sim.sd * sim.sd) * (n - 1) / n;
  const cxy = p.crossSum / n / (tb * tb) - mx * my;
  if (!(vx > 0)) return null;
  const beta = cxy / vx;
  const rho2 = Math.min(1, vy > 0 ? (cxy * cxy) / (vx * vy) : 1);
  const rtp = my - beta * (mx - muX);
  const se = Math.sqrt(Math.max(0, vy * (1 - rho2)) / (n - 1));
  return { rtp, standardError: se, ci95: [rtp - 1.959964 * se, rtp + 1.959964 * se], beta, rho: Math.sign(cxy) * Math.sqrt(rho2), muX, paidSpinMean: mx };
}

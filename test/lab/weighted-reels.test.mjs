// Weighted stops and reel sets (P0-5). Every expected value below comes from a
// derivation that does not use the weighted code paths of slot-exact.js:
//  * expansion: with one row, a stop of weight w is the same as w copies of that
//    stop, so a weighted model must equal its expanded (unweighted) model;
//  * an independent brute force over every (reel set, stop combination), written
//    from the game rules in this file;
//  * the mixture identities RTP = sum pi_r RTP_r and E[W^2] = sum pi_r E_r[W^2];
//  * scale invariance (multiplying a reel's weights by c changes no probability);
//  * hand calculations, and digests produced by the code before weights existed.
import test from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import { normalizeModel, applyCsv, canonicalJson, isWeightedModel, ModelError } from '../../lab/core/slot-model.js';
import { analyzeExact } from '../../lab/core/slot-exact.js';
import { Fraction } from '../../lab/core/fraction.js';
import { simulate, weightedPicker, generatorDescription } from '../../lab/core/montecarlo.js';
import { prngFromSeed, PRNG_DESCRIPTION, PRNG_DESCRIPTION_WEIGHTED } from '../../lab/core/prng.js';
import { slotSampler } from '../../lab/core/casino.js';
import { sha256Hex } from '../../lab/core/fair.js';
import { pair } from '../../lab/i18n.js';

const SAMPLES = new URL('../../lab/samples/', import.meta.url);
const read = (f) => fs.readFileSync(new URL(f, SAMPLES), 'utf8');
const clone = (x) => JSON.parse(JSON.stringify(x));
const rtpOf = (raw) => analyzeExact(normalizeModel(raw));
const F = (s) => { const [n, d = '1'] = String(s).split('/'); return new Fraction(BigInt(n), BigInt(d)); };
function near(a, b, tol, msg) { assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b} (tol ${tol})`); }

// Every exact number of an analysis, as fraction strings.
function exactSummary(r, { combos = true } = {}) {
  const fr = (x) => x && x.fraction;
  const d = r.distribution;
  return {
    rtp: fr(r.rtp),
    contributions: Object.fromEntries(Object.entries(r.contributions).map(([k, v]) => [k, fr(v)])),
    freeSpins: r.freeSpins && Object.fromEntries(Object.entries(r.freeSpins).map(([k, v]) => [k, fr(v)])),
    distribution: d && { hit: fr(d.hitFrequency), variance: fr(d.variance), maxWin: d.maxWin, buckets: d.buckets.map((b) => [b.from, b.to, fr(b.probability)]) },
    symbols: r.symbols.map((s) => [s.symbol, fr(s.rtp), s.byCount.map((b) => [b.count, b.pay, combos ? b.combosPerLine : null, fr(b.probabilityPerLine), fr(b.rtp)])]),
    scatter: r.scatter.map((s) => [s.count, fr(s.probability), s.pay, s.triggers]),
  };
}

// ---- Expansion (one row): weight w = w copies of the stop ----
const expandReels = (reels, weights) => reels.map((reel, k) => reel.flatMap((s, p) => new Array(Number(weights && weights[k] ? weights[k][p] : 1)).fill(s)));
function expand(raw) {
  const out = clone(raw);
  out.reels = expandReels(raw.reels, raw.weights);
  delete out.weights;
  const f = out.scatter && out.scatter.freeSpins;
  if (f && f.reels) { f.reels = expandReels(raw.scatter.freeSpins.reels, raw.scatter.freeSpins.weights); delete f.weights; }
  return out;
}

const ONE_ROW = {
  name: 'weighted, one row', rows: 1,
  reels: [['A', 'K', 'W', 'Q', 'S', 'B'], ['K', 'A', 'Q', 'W', 'B', 'S'], ['Q', 'S', 'A', 'K', 'W', 'B', 'K']],
  weights: [[3, 1, 2, 5, 1, 4], [2, 2, 1, 3, 6, 1], [1, 2, 3, 1, 1, 2, 5]],
  lines: [[1, 1, 1]],
  paytable: { A: [0, 2, 10], K: [0, 0, 5], Q: [0, 0, 2.5], B: [0, 0, 0] },
  wild: { symbol: 'W', pays: [0, 5, 25] },
  scatter: {
    symbol: 'S', pays: [0, 2, 10],
    freeSpins: {
      trigger: 2, spins: 3, multiplier: 2, retrigger: true,
      reels: [['A', 'W', 'K', 'S', 'Q'], ['K', 'Q', 'W', 'S', 'A', 'B'], ['S', 'A', 'K', 'W', 'Q']],
      weights: [[2, 1, 4, 1, 3], [1, 5, 2, 1, 2, 3], [1, 3, 2, 2, 4]],
    },
  },
};

test('one row: a weighted model equals its expanded model, fraction for fraction', () => {
  const w = rtpOf(ONE_ROW);
  const e = rtpOf(expand(ONE_ROW));
  assert.strictEqual(w.model.weighted, true);
  assert.strictEqual(e.model.weighted, false);
  // The expanded model has sum(weights) stops per reel, so even the per-line weights
  // (combosPerLine) must match its combination counts.
  assert.deepStrictEqual(exactSummary(w), exactSummary(e));
  assert.strictEqual(w.model.totalWeight, e.model.combinations);
  assert.ok(w.freeSpins.retriggerProbability.value > 0, 'retrigger exercised');
});

test('one row: a reel without weights (null) keeps uniform stops', () => {
  const raw = clone(ONE_ROW);
  raw.weights[1] = null;
  const ex = clone(raw);
  ex.weights[1] = raw.reels[1].map(() => 1);
  assert.deepStrictEqual(exactSummary(rtpOf(raw)), exactSummary(rtpOf(expand(ex))));
});

// ---- Independent brute force over every (reel set, stop combination) ----
const big = (w) => BigInt(String(w));
function setsOf(o) {
  if (o.reelSets) return o.reelSets.map((s) => ({ weight: big(s.weight), reels: s.reels, weights: s.weights || null }));
  return [{ weight: 1n, reels: o.reels, weights: o.weights || null }];
}
function bruteForce(raw) {
  const N = raw.reels ? raw.reels.length : raw.reelSets[0].reels.length, R = raw.rows, L = raw.lines.length;
  const wild = raw.wild ? raw.wild.symbol : null;
  const sc = raw.scatter || null;
  const pt = (sym, n) => Fraction.of((raw.paytable[sym] || [])[n - 1] || 0);
  const wildPay = (n) => (wild && n > 0 ? Fraction.of((raw.wild.pays || [])[n - 1] || 0) : new Fraction(0n));
  const scPay = (c) => {
    if (!sc || !sc.pays || c === 0) return new Fraction(0n);
    const p = sc.pays;
    return Fraction.of(c <= p.length ? p[c - 1] || 0 : p[p.length - 1]);
  };
  // Win (x total bet) and scatter count of one window; win(k, r) = symbol on reel k, row r.
  const evalWindow = (win) => {
    let total = new Fraction(0n);
    for (const line of raw.lines) {
      const syms = line.map((row, k) => win(k, row - 1));
      let w0 = 0;
      while (w0 < N && syms[w0] === wild) w0++;
      let best = wildPay(w0);
      if (w0 < N && syms[w0] !== (sc && sc.symbol)) {
        const t = syms[w0];
        let n = w0;
        while (n < N && (syms[n] === t || syms[n] === wild)) n++;
        if (pt(t, n).cmp(best) > 0) best = pt(t, n);
      }
      total = total.add(best);
    }
    let count = 0;
    if (sc) for (let k = 0; k < N; k++) for (let r = 0; r < R; r++) if (win(k, r) === sc.symbol) count++;
    return { win: total.add(scPay(count).mul(L)).div(L), count };
  };
  // Probability-weighted moments over a reel source.
  const moments = (sets, trigger) => {
    const V = sets.reduce((a, s) => a + s.weight, 0n);
    let E = new Fraction(0n), E2 = new Fraction(0n), pJ = new Fraction(0n), EXJ = new Fraction(0n), hit = new Fraction(0n), max = 0;
    for (const set of sets) {
      const wOf = (k, p) => (set.weights && set.weights[k] ? big(set.weights[k][p]) : 1n);
      const den = set.reels.reduce((a, reel, k) => a * reel.reduce((b, _, p) => b + wOf(k, p), 0n), V);
      const stops = set.reels.map(() => 0);
      for (;;) {
        let w = set.weight;
        stops.forEach((p, k) => { w *= wOf(k, p); });
        const p = new Fraction(w, den);
        const o = evalWindow((k, r) => set.reels[k][(stops[k] + r) % set.reels[k].length]);
        const J = trigger !== null && o.count >= trigger;
        E = E.add(p.mul(o.win)); E2 = E2.add(p.mul(o.win).mul(o.win));
        if (J) { pJ = pJ.add(p); EXJ = EXJ.add(p.mul(o.win)); }
        if (o.win.cmp(0) > 0 || J) hit = hit.add(p);
        max = Math.max(max, o.win.toNumber());
        let k = 0;
        while (k < N && ++stops[k] === set.reels[k].length) { stops[k] = 0; k++; }
        if (k === N) break;
      }
    }
    return { E, E2, pJ, EXJ, hit, max };
  };
  const f = sc && sc.freeSpins;
  const base = moments(setsOf(raw), f ? f.trigger : null);
  if (!f) return { rtp: base.E, variance: base.E2.sub(base.E.mul(base.E)), hit: base.hit, max: base.max, pTrigger: base.pJ };
  if (f.retrigger) throw new Error('this brute force covers free spins without retrigger');
  const m = Fraction.of(f.multiplier || 1), Fs = BigInt(f.spins);
  const x = moments(f.reels || f.reelSets ? setsOf(f) : setsOf(raw), null);
  // F independent free spins of win m*X: E[sum] = F m E[X], E[sum^2] = F m^2 E[X^2] + F(F-1) m^2 E[X]^2.
  const EX = x.E.mul(m), EX2 = x.E2.mul(m).mul(m);
  const EFv = EX.mul(Fs), EFv2 = EX2.mul(Fs).add(EX.mul(EX).mul(Fs * (Fs - 1n)));
  const EW = base.E.add(base.pJ.mul(EFv));
  const EW2 = base.E2.add(base.EXJ.mul(EFv).mul(2n)).add(base.pJ.mul(EFv2));
  return { rtp: EW, variance: EW2.sub(EW.mul(EW)), hit: base.hit, max: base.max, pTrigger: base.pJ };
}

const THREE_ROWS = {
  name: 'weighted, three rows', rows: 3,
  reels: [['A', 'K', 'W', 'Q', 'S'], ['K', 'A', 'Q', 'W', 'B', 'S'], ['Q', 'S', 'A', 'K', 'W'], ['A', 'W', 'K', 'Q', 'B', 'S']],
  weights: [[5, 1, 2, 3, 1], [2, 4, 1, 1, 3, 2], [1, 2, 6, 3, 1], [3, 1, 2, 2, 5, 1]],
  // Lines on different rows: with weights each row has its own symbol frequencies.
  lines: [[2, 2, 2, 2], [1, 1, 1, 1], [3, 3, 3, 3], [1, 2, 3, 2], [3, 2, 1, 2]],
  paytable: { A: [0, 2, 10, 40], K: [0, 0, 5, 20], Q: [0, 0, 2.5, 10], B: [0, 0, 0, 0] },
  wild: { symbol: 'W', pays: [0, 5, 25, 100] },
  scatter: { symbol: 'S', pays: [0, 0, 2, 10], freeSpins: { trigger: 3, spins: 4, multiplier: 2, retrigger: false } },
};

function checkAgainstBruteForce(raw) {
  const r = rtpOf(raw);
  const b = bruteForce(raw);
  assert.strictEqual(r.rtp.fraction, b.rtp.toString(), 'RTP');
  assert.strictEqual(r.distribution.variance.fraction, b.variance.toString(), 'variance');
  assert.strictEqual(r.distribution.hitFrequency.fraction, b.hit.toString(), 'hit frequency');
  assert.strictEqual(r.distribution.maxWin.base, b.max, 'max win');
  if (r.freeSpins) assert.strictEqual(r.freeSpins.triggerProbability.fraction, b.pTrigger.toString(), 'trigger probability');
  return r;
}

test('three rows: weighted stops equal brute force (each line sees its own row frequencies)', () => {
  const r = checkAgainstBruteForce(THREE_ROWS);
  assert.strictEqual(r.model.weighted, true);
  // Sanity: the weights matter (the same strips unweighted give another RTP).
  const plain = clone(THREE_ROWS);
  delete plain.weights;
  assert.notStrictEqual(rtpOf(plain).rtp.fraction, r.rtp.fraction);
});

const SETS = clone(THREE_ROWS);
delete SETS.reels;
delete SETS.weights;
SETS.reelSets = [
  { weight: 3, reels: THREE_ROWS.reels, weights: THREE_ROWS.weights },
  { weight: 5, reels: [['K', 'S', 'A', 'W', 'Q', 'B'], ['A', 'A', 'K', 'S', 'W'], ['W', 'Q', 'K', 'S', 'A', 'B'], ['Q', 'K', 'S', 'A', 'W']] },
];
SETS.scatter.freeSpins.reelSets = [
  { weight: 2, reels: [['W', 'A', 'S', 'K'], ['S', 'K', 'W', 'A', 'Q'], ['A', 'S', 'W', 'K'], ['K', 'W', 'S', 'A', 'Q']], weights: [[1, 2, 3, 4], [2, 1, 1, 3, 2], [4, 1, 2, 1], [1, 1, 2, 3, 1]] },
  { weight: 1, reels: [['A', 'K', 'Q', 'S'], ['K', 'A', 'S', 'Q'], ['S', 'Q', 'A', 'K'], ['A', 'S', 'K', 'Q']] },
];

test('reel sets in the base game and the free spins equal brute force', () => {
  const r = checkAgainstBruteForce(SETS);
  assert.deepStrictEqual(r.model.reelSets.map((s) => [s.weight, s.probability.fraction, s.weightedStops]), [['3', '3/8', true], ['5', '5/8', false]]);
  assert.deepStrictEqual(r.model.freeSpinReelSets.map((s) => [s.weight, s.probability.fraction]), [['2', '2/3'], ['1', '1/3']]);
  // Stop combinations enumerated: 5*6*5*6 + 6*5*6*5.
  assert.strictEqual(r.model.combinations, String(900 + 900));
});

// ---- Mixture identities ----
// SMALL from slot-exact.test.mjs with weights on two reels; three rows, seven lines.
const SMALL_REELS = [
  ['A', 'K', 'W', 'Q', 'S', 'K', 'B'], ['K', 'A', 'Q', 'W', 'B', 'S'], ['Q', 'S', 'A', 'K', 'W', 'B', 'K'],
  ['A', 'W', 'K', 'Q', 'B', 'S'], ['K', 'Q', 'A', 'B', 'S', 'W'],
];
const ALT_REELS = [
  ['K', 'A', 'W', 'S', 'Q', 'B'], ['A', 'Q', 'K', 'W', 'S', 'B', 'K'], ['S', 'Q', 'K', 'A', 'W', 'B'],
  ['W', 'A', 'K', 'Q', 'S', 'B', 'A'], ['Q', 'K', 'A', 'S', 'W', 'B'],
];
const MIX_BASE = {
  rows: 3,
  lines: [[2, 2, 2, 2, 2], [1, 1, 1, 1, 1], [3, 3, 3, 3, 3], [1, 2, 3, 2, 1], [3, 2, 1, 2, 3], [1, 1, 2, 3, 3], [2, 3, 2, 1, 2]],
  paytable: { A: [0, 2, 10, 40, 150], K: [0, 0, 5, 20, 75], Q: [0, 0, 2.5, 10, 50], B: [0, 0, 0, 0, 0] },
  wild: { symbol: 'W', pays: [0, 5, 25, 100, 500] },
};
const SMALL_W = [null, [1, 4, 2, 2, 3, 1], null, [2, 1, 1, 5, 1, 3], null];
const FS_REELS = SMALL_REELS.map((r) => [...r, 'W']);

test('base reel sets: RTP, E[W^2], hit frequency, trigger probability and buckets mix with pi_r', () => {
  const fsC = { trigger: 4, spins: 3, multiplier: 2, retrigger: true, reels: FS_REELS };
  const scatter = { symbol: 'S', pays: [0, 0, 2, 10, 40], freeSpins: fsC };
  const A = { ...MIX_BASE, scatter, reels: SMALL_REELS, weights: SMALL_W };
  const B = { ...MIX_BASE, scatter, reels: ALT_REELS };
  const M = { ...MIX_BASE, scatter, reelSets: [{ weight: 3, reels: SMALL_REELS, weights: SMALL_W }, { weight: 5, reels: ALT_REELS }] };
  const [a, b, m] = [A, B, M].map(rtpOf);
  const mix = (fa, fb) => F(fa).mul(3n).add(F(fb).mul(5n)).div(8n);
  const ew2 = (r) => F(r.distribution.variance.fraction).add(F(r.rtp.fraction).mul(F(r.rtp.fraction)));
  assert.strictEqual(m.rtp.fraction, mix(a.rtp.fraction, b.rtp.fraction).toString());
  assert.strictEqual(ew2(m).toString(), ew2(a).mul(3n).add(ew2(b).mul(5n)).div(8n).toString());
  assert.strictEqual(m.distribution.hitFrequency.fraction, mix(a.distribution.hitFrequency.fraction, b.distribution.hitFrequency.fraction).toString());
  assert.strictEqual(m.freeSpins.triggerProbability.fraction, mix(a.freeSpins.triggerProbability.fraction, b.freeSpins.triggerProbability.fraction).toString());
  m.distribution.buckets.forEach((bk, i) => {
    assert.strictEqual(bk.probability.fraction, mix(a.distribution.buckets[i].probability.fraction, b.distribution.buckets[i].probability.fraction).toString(), 'bucket ' + i);
  });
  for (const k of ['lines', 'scatter', 'freeSpins', 'wildAssistedLines']) {
    assert.strictEqual(m.contributions[k].fraction, mix(a.contributions[k].fraction, b.contributions[k].fraction).toString(), k);
  }
  assert.strictEqual(m.distribution.maxWin.base, Math.max(a.distribution.maxWin.base, b.distribution.maxWin.base));
});

test('free-spin reel sets: each free spin picks its set, so per-spin moments mix', () => {
  const sets = [{ weight: 1, reels: FS_REELS }, { weight: 2, reels: ALT_REELS, weights: ALT_REELS.map((r) => r.map((s) => (s === 'W' ? 4 : 1))) }];
  const model = (fsPart, retrigger) => ({ ...MIX_BASE, reels: SMALL_REELS, scatter: { symbol: 'S', pays: [0, 0, 2, 10, 40], freeSpins: { trigger: 4, spins: 3, multiplier: 2, retrigger, ...fsPart } } });
  const mix = (fa, fb) => F(fa).add(F(fb).mul(2n)).div(3n);
  // Without retrigger the RTP is linear in the free-spin distribution.
  let [c, d, m] = [{ reels: sets[0].reels }, { reels: sets[1].reels, weights: sets[1].weights }, { reelSets: sets }].map((p) => rtpOf(model(p, false)));
  assert.strictEqual(m.rtp.fraction, mix(c.rtp.fraction, d.rtp.fraction).toString());
  // With retrigger, the per-spin EV and the retrigger probability mix, and the expected
  // number of spins per trigger is F / (1 - p F) with the mixed p (F = 3).
  [c, d, m] = [{ reels: sets[0].reels }, { reels: sets[1].reels, weights: sets[1].weights }, { reelSets: sets }].map((p) => rtpOf(model(p, true)));
  assert.strictEqual(m.freeSpins.spinEV.fraction, mix(c.freeSpins.spinEV.fraction, d.freeSpins.spinEV.fraction).toString());
  const p = mix(c.freeSpins.retriggerProbability.fraction, d.freeSpins.retriggerProbability.fraction);
  assert.strictEqual(m.freeSpins.retriggerProbability.fraction, p.toString());
  assert.strictEqual(m.freeSpins.expectedSpinsPerTrigger.fraction, new Fraction(3n).div(new Fraction(1n).sub(p.mul(3n))).toString());
  assert.ok(m.distribution, 'distribution computed');
});

test('identical reel sets with any weights equal the single set', () => {
  const one = { ...MIX_BASE, reels: SMALL_REELS, weights: SMALL_W };
  const two = { ...MIX_BASE, reelSets: [{ weight: 7, reels: SMALL_REELS, weights: SMALL_W }, { weight: 2, reels: SMALL_REELS, weights: SMALL_W }] };
  const a = rtpOf(one), b = rtpOf(two);
  // Weights per line are counted over the mixture's cycle, here (7 + 2) times the set's.
  assert.deepStrictEqual(exactSummary(b, { combos: false }), exactSummary(a, { combos: false }));
  assert.strictEqual(BigInt(b.model.totalWeight), 9n * BigInt(a.model.totalWeight));
});

// ---- Weights whose totals pass 2^53 ----
test('totals above 2^53: scaling every weight of a reel by c changes no probability', () => {
  // c_k = 2^61 + k: each reel total and the cycle (their product) are far above 2^53,
  // so the engine runs on BigInt counts; the probabilities w*c / (W*c) are unchanged.
  const scaled = clone(SETS);
  const scale = (set, k0) => { set.weights = set.reels.map((reel, k) => reel.map((_, p) => String(((set.weights && set.weights[k] ? BigInt(set.weights[k][p]) : 1n)) * ((1n << 61n) + BigInt(k + k0))))); };
  scaled.reelSets.forEach((s, j) => scale(s, j));
  scaled.scatter.freeSpins.reelSets.forEach((s, j) => scale(s, 10 + j));
  const a = rtpOf(SETS), b = rtpOf(scaled);
  assert.ok(BigInt(b.model.totalWeight) > 1n << 240n, 'cycle ' + b.model.totalWeight);
  assert.deepStrictEqual(exactSummary(b, { combos: false }), exactSummary(a, { combos: false }));
});

test('totals above 2^53: a two-stop reel computed by hand', () => {
  // Weights 2^53 + 1 (WIN, pays 2) and 2^53 - 1 (LOSE): p = (2^53 + 1) / 2^54,
  // RTP = 2p = (2^53 + 1) / 2^53, variance = 4p(1 - p) = (2^106 - 1) / 2^106.
  const p53 = 1n << 53n;
  const raw = { rows: 1, reels: [['WIN', 'LOSE']], weights: [[String(p53 + 1n), String(p53 - 1n)]], paytable: { WIN: [2] } };
  const r = rtpOf(raw);
  assert.strictEqual(r.rtp.fraction, `${p53 + 1n}/${p53}`);
  assert.strictEqual(r.distribution.hitFrequency.fraction, `${p53 + 1n}/${p53 * 2n}`);
  assert.strictEqual(r.distribution.variance.fraction, `${(1n << 106n) - 1n}/${1n << 106n}`);
  assert.strictEqual(r.model.totalWeight, String(p53 * 2n));
  assert.strictEqual(r.symbols[0].byCount[0].combosPerLine, String(p53 + 1n));
  // The same weights as BigInt are accepted too.
  raw.weights = [[p53 + 1n, p53 - 1n]];
  assert.strictEqual(rtpOf(raw).rtp.fraction, `${p53 + 1n}/${p53}`);
});

// ---- Validation ----
test('invalid weights and reel sets are rejected with a message in both languages', () => {
  const base = { rows: 1, reels: [['A', 'B'], ['A', 'B']], paytable: { A: [0, 5] } };
  const bad = [
    { ...base, weights: [[1, 0], [1, 1]] }, // zero weight
    { ...base, weights: [[1, -2], [1, 1]] }, // negative
    { ...base, weights: [[1, 1.5], [1, 1]] }, // not a whole number
    { ...base, weights: [[1, 'x'], [1, 1]] },
    { ...base, weights: [[1, '1e3'], [1, 1]] },
    { ...base, weights: [[1, 2 ** 53 + 2], [1, 1]] }, // a JSON number past 2^53 has lost digits
    { ...base, weights: [[1, '18446744073709551616'], [1, 1]] }, // 2^64, above uint64
    { ...base, weights: [[1, 1, 1], [1, 1]] }, // length mismatch
    { ...base, weights: [[1, 1]] }, // one list for two reels
    { ...base, weights: 'heavy' },
    { rows: 1, weights: [[1]], paytable: {} }, // weights without reels
    { ...base, reelSets: [{ weight: 1, reels: [['A'], ['A']] }] }, // reels and reelSets
    { rows: 1, reelSets: [{ weight: 1, reels: [['A'], ['A']] }], weights: [[1], [1]], paytable: {} }, // weights outside the sets
    { rows: 1, reelSets: [], paytable: {} },
    { rows: 1, reelSets: [{ reels: [['A'], ['A']] }], paytable: {} }, // set without weight
    { rows: 1, reelSets: [{ weight: 0, reels: [['A'], ['A']] }], paytable: {} },
    { rows: 1, reelSets: [{ weight: 1 }], paytable: {} },
    { rows: 1, reelSets: [{ weight: 1, reels: [['A'], ['A']] }, { weight: 1, reels: [['A']] }], paytable: {} }, // different reel counts
    { rows: 1, reelSets: Array.from({ length: 33 }, () => ({ weight: 1, reels: [['A']] })), paytable: {} }, // too many sets
    { rows: 1, reelSets: [[['A']]], paytable: {} },
    { ...base, scatter: { symbol: 'B', freeSpins: { trigger: 1, spins: 1, weights: [[1, 1], [1, 1]] } } }, // free-spin weights without free-spin reels
    { ...base, scatter: { symbol: 'B', freeSpins: { trigger: 1, spins: 1, reelSets: [{ weight: 1, reels: [['A']] }] } } }, // free-spin sets with another reel count
  ];
  bad.forEach((raw, i) => {
    assert.throws(() => normalizeModel(raw), (e) => e instanceof ModelError && Boolean(e.ar && e.en), 'case ' + i);
  });
  assert.throws(() => normalizeModel(bad[5]), (e) => /string/.test(e.en) && /نصًا/.test(e.ar));
  // Valid edge cases: a weight of 2^64 - 1 written as text, and a weight equal to 2^53 - 1.
  normalizeModel({ ...base, weights: [['18446744073709551615', 1], [Number.MAX_SAFE_INTEGER, 1]] });
});

test('isWeightedModel spots weights and reel sets anywhere, and existing models stay valid', () => {
  assert.strictEqual(isWeightedModel(ONE_ROW), true);
  assert.strictEqual(isWeightedModel(SETS), true);
  const fsOnly = clone(THREE_ROWS);
  delete fsOnly.weights;
  assert.strictEqual(isWeightedModel(fsOnly), false);
  fsOnly.scatter.freeSpins.reelSets = [{ weight: 1, reels: THREE_ROWS.reels }];
  assert.strictEqual(isWeightedModel(fsOnly), true);
  for (const f of ['desert-gold.json', 'roulette-european.json', 'roulette-american.json']) {
    const raw = JSON.parse(read(f));
    assert.strictEqual(isWeightedModel(raw), false, f);
    assert.strictEqual(normalizeModel(raw).weighted, false, f);
  }
});

// ---- CSV and the model fingerprint ----
test('CSV: a weight column after each reel gives the same model as JSON', () => {
  const json = JSON.parse(read('desert-gold-weighted.json'));
  let raw = { rows: 3, scatter: json.scatter };
  raw = applyCsv(raw, read('desert-gold-weighted-reels.csv'), 'reels');
  raw = applyCsv(raw, read('desert-gold-paytable.csv'), 'paytable');
  raw = applyCsv(raw, read('desert-gold-lines.csv'), 'lines');
  assert.deepStrictEqual(raw.reels, json.reels);
  assert.deepStrictEqual(raw.weights, json.weights);
  const a = rtpOf(json), b = rtpOf(raw);
  assert.strictEqual(b.rtp.fraction, a.rtp.fraction);
  assert.strictEqual(b.distribution.variance.fraction, a.distribution.variance.fraction);
  // Reels from a CSV without weight columns replace the weights and reel sets too.
  const plain = applyCsv({ ...json, reelSets: [] }, read('desert-gold-reels.csv'), 'reels');
  assert.strictEqual(plain.weights, undefined);
  assert.strictEqual(plain.reelSets, undefined);
});

test('CSV: big weights stay exact text; bad weight columns are rejected', () => {
  const raw = applyCsv({ rows: 1 }, 'reel1,weight1,reel2\nA,9007199254740993,A\nB,7,B\n', 'r.csv');
  assert.deepStrictEqual(raw.weights, [['9007199254740993', 7], null]);
  assert.deepStrictEqual(raw.reels, [['A', 'B'], ['A', 'B']]);
  const bad = [
    'reel1,weight1,weight2\nA,1,1\n', // weight column after a weight column
    'reel1,weight1\nA,\n', // symbol without weight
    'reel1,weight1\n,3\nA,1\n', // weight without symbol
  ];
  for (const text of bad) assert.throws(() => applyCsv({ rows: 1 }, text, 'r.csv'), (e) => e instanceof ModelError && Boolean(e.ar && e.en), text);
  for (const w of ['x', '0', '-1']) {
    const r = applyCsv({ rows: 1, paytable: { A: [1] } }, `reel1,weight1\nA,${w}\nB,1\n`, 'r.csv');
    assert.throws(() => normalizeModel(r), ModelError, w);
  }
});

test('the canonical model JSON (and so its SHA-256) covers the weights', async () => {
  const plain = clone(ONE_ROW);
  delete plain.weights;
  assert.notStrictEqual(await sha256Hex(canonicalJson(ONE_ROW)), await sha256Hex(canonicalJson(plain)));
  assert.ok(canonicalJson(ONE_ROW).includes('"weights":[[3,1,2,5,1,4]'));
  assert.strictEqual(canonicalJson({ w: 12345678901234567890n }), '{"w":"12345678901234567890"}');
});

// ---- Monte Carlo ----
// A generator that returns given 32-bit words, to check draws by hand.
const words = (list) => ({ nextU32: () => { if (!list.length) throw new Error('out of words'); return list.shift(); }, nextBelow(n) { const limit = 4294967296 - (4294967296 % n); let r; do r = this.nextU32(); while (r >= limit); return r % n; } });

test('weighted picker: draws checked by hand, one word and several words with rejection', () => {
  // Total 4 <= 2^32: u = word mod 4; cumulative bounds 1, 3, 4.
  const small = weightedPicker([1n, 2n, 1n]);
  assert.deepStrictEqual([4, 5, 6, 7].map((w) => small(words([w]))), [0, 1, 1, 2]);
  // Total 2^34: two words (2^64 is a multiple of 2^34, so nothing is rejected);
  // u = low 34 bits of hi*2^32 + lo; index 1 when u >= 2^33.
  const two = weightedPicker([1n << 33n, 1n << 33n]);
  assert.strictEqual(two(words([2, 0])), 1); // u = 2 * 2^32 = 2^33
  assert.strictEqual(two(words([1, 5])), 0); // u = 2^32 + 5
  assert.strictEqual(two(words([6, 9])), 1); // u = (6 mod 4) * 2^32 + 9 = 2^33 + 9
  // Total 3 * 2^32: 2^64 mod (3 * 2^32) = 2^32, so x >= 2^64 - 2^32 is rejected.
  const rej = weightedPicker([1n << 32n, 1n << 33n]);
  const stub = words([0xffffffff, 0, 0, 7]);
  assert.strictEqual(rej(stub), 0); // first x = 2^64 - 2^32 rejected; then u = 7 < 2^32
  assert.throws(() => stub.nextU32(), /out of words/, 'both words of the retry were used');
  // x = 2^64 - 2^32 - 1 is kept; since 2^64 = 2^32 (mod 3 * 2^32), u = 3 * 2^32 - 1: index 1.
  assert.strictEqual(rej(words([0xfffffffe, 0xffffffff])), 1);
  // With every weight 1 the index equals rng.nextBelow(count), so unweighted draws are unchanged.
  const ones = weightedPicker([1n, 1n, 1n, 1n, 1n]);
  // nextBelow(5) keeps words below 2^32 - 1 and returns word mod 5: 0, 3, 9 -> 4, 4294967294 -> 4.
  assert.deepStrictEqual([0, 3, 9, 4294967294].map((w) => ones(words([w]))), [0, 3, 4, 4]);
});

test('weighted picker: frequencies follow weights above 2^32', async () => {
  const pick = weightedPicker([1n << 40n, 1n << 40n, 1n << 41n]);
  const rng = await prngFromSeed('weighted-picker');
  const n = 200000, c = [0, 0, 0];
  for (let i = 0; i < n; i++) c[pick(rng)]++;
  [0.25, 0.25, 0.5].forEach((p, i) => near(c[i] / n, p, 4 * Math.sqrt(p * (1 - p) / n), 'index ' + i));
});

test('unweighted runs reproduce the fingerprints recorded before weights existed', async () => {
  // resultSha256 as the worker computes it, obtained by running lab/core/*.js at commit
  // 5863f5b (before weighted reels): the same seeds and models must give the same digests.
  const digest = async (raw, seed, spins) => {
    const model = normalizeModel(raw);
    const run = { modelSha256: await sha256Hex(canonicalJson(raw)), seed, spins, generator: generatorDescription(model), result: simulate(model, await prngFromSeed(seed), spins) };
    return sha256Hex(canonicalJson(run));
  };
  assert.strictEqual(generatorDescription(normalizeModel(JSON.parse(read('desert-gold.json')))), PRNG_DESCRIPTION);
  assert.strictEqual(await digest(JSON.parse(read('desert-gold.json')), 'taryam-audit', 100000), '8e79122334bdaa56ba83691377da33d99169ad369d9a9ef281b83695d9d509d0');
  assert.strictEqual(await digest(JSON.parse(read('roulette-european.json')), 'roulette', 100000), 'a85d17acf870104f703e940214df33a20993e0e3f7a8810596525b8243e6ab8a');
});

test('Monte Carlo of weighted models agrees with the exact engine within 4 standard errors', async () => {
  const raw = JSON.parse(read('desert-gold-weighted.json'));
  const model = normalizeModel(raw);
  assert.strictEqual(generatorDescription(model), PRNG_DESCRIPTION_WEIGHTED);
  const exact = analyzeExact(model);
  const sim = simulate(model, await prngFromSeed('weighted-desert'), 1000000);
  near(sim.rtp, exact.rtp.value, 4 * exact.distribution.sd / 1000, 'weighted Desert Gold RTP');
  const h = exact.distribution.hitFrequency.value;
  near(sim.hitFrequency, h, 4 * Math.sqrt(h * (1 - h) / 1e6), 'hit frequency');
  near(sim.sd, exact.distribution.sd, 0.1 * exact.distribution.sd, 'sd');
  // Reel sets in the base game and the free spins.
  const m2 = normalizeModel(SETS);
  const e2 = analyzeExact(m2);
  const s2 = simulate(m2, await prngFromSeed('weighted-sets'), 400000);
  near(s2.rtp, e2.rtp.value, 4 * e2.distribution.sd / Math.sqrt(400000), 'reel sets RTP');
  // Weights above 2^32 per reel (multi-word draws).
  const scaled = clone(ONE_ROW);
  scaled.weights = scaled.weights.map((w) => w.map((x) => String(BigInt(x) << 40n)));
  scaled.scatter.freeSpins.weights = scaled.scatter.freeSpins.weights.map((w) => w.map((x) => String(BigInt(x) << 40n)));
  const m3 = normalizeModel(scaled);
  const e3 = analyzeExact(m3);
  assert.strictEqual(e3.rtp.fraction, rtpOf(ONE_ROW).rtp.fraction);
  const s3 = simulate(m3, await prngFromSeed('weighted-big'), 200000);
  near(s3.rtp, e3.rtp.value, 4 * e3.distribution.sd / Math.sqrt(200000), 'big weights RTP');
});

test('Monte Carlo: same seed, same weighted run; all-ones weights draw like no weights', async () => {
  const model = normalizeModel(SETS);
  const a = simulate(model, await prngFromSeed('again'), 20000);
  const b = simulate(model, await prngFromSeed('again'), 20000);
  assert.deepStrictEqual(a, b);
  // Picking through cumulative bounds 1, 2, ..., n returns rng.nextBelow(n) itself, so the
  // spins (and every statistic) are the same as for the unweighted model.
  const dg = JSON.parse(read('desert-gold.json'));
  const ones = { ...clone(dg), weights: dg.reels.map((r) => r.map(() => 1)) };
  const u = simulate(normalizeModel(dg), await prngFromSeed('ones'), 30000);
  const w = simulate(normalizeModel(ones), await prngFromSeed('ones'), 30000);
  assert.deepStrictEqual(w, u);
});

test('casino slot sampler draws weighted models without bias', async () => {
  const model = normalizeModel(JSON.parse(read('desert-gold-weighted.json')));
  const exact = analyzeExact(model);
  const draw = slotSampler(model);
  const rng = await prngFromSeed('weighted-sampler');
  const n = 300000;
  let sum = 0;
  for (let i = 0; i < n; i++) sum += draw(rng);
  near(sum / n, exact.rtp.value, 4 * exact.distribution.sd / Math.sqrt(n), 'sampler RTP');
});

// ---- The weighted sample ----
// Second algorithm for the RTP of a line game: per payline, enumerate every tuple of
// symbols (one per reel) with probability prod(weight of the symbol at that row / reel
// total), instead of stop combinations; scatters by convolving per-reel window counts;
// free spins as a branching process (expected spins F / (1 - p F)).
// anchorRow j (1-based) reads each stop weight as the weight of the window that shows
// that stop in row j, applied directly here (not by converting the weights), so it can
// check the conversion formula the README gives for weights of another row.
function rtpBySymbolTuples(raw, anchorRow = 1) {
  const N = raw.reels.length, R = raw.rows, L = raw.lines.length;
  const wild = raw.wild.symbol, sc = raw.scatter, f = sc.freeSpins;
  const pays = (sym, n) => Fraction.of((sym === wild ? raw.wild.pays : raw.paytable[sym] || [])[n - 1] || 0);
  const linePay = (syms) => {
    let w0 = 0;
    while (w0 < N && syms[w0] === wild) w0++;
    let best = pays(wild, w0);
    if (w0 < N && syms[w0] !== sc.symbol) {
      let n = w0;
      while (n < N && (syms[n] === syms[w0] || syms[n] === wild)) n++;
      if (pays(syms[w0], n).cmp(best) > 0) best = pays(syms[w0], n);
    }
    return best;
  };
  const payCache = new Map();
  const cachedPay = (syms) => { const k = syms.join(' '); if (!payCache.has(k)) payCache.set(k, linePay(syms).toString()); return payCache.get(k); };
  // E[win of one spin] in total bets and P(scatters >= trigger), for one reel set.
  const spin = (set) => {
    const wOf = (k, p) => (set.weights && set.weights[k] ? big(set.weights[k][p]) : 1n);
    const totals = set.reels.map((reel, k) => reel.reduce((a, _, p) => a + wOf(k, p), 0n));
    const cycle = totals.reduce((a, b) => a * b, 1n);
    const byPay = new Map(); // pay (x line bet) -> total weight of the tuples paying it
    for (const line of raw.lines) {
      const freq = set.reels.map((reel, k) => {
        const m = new Map();
        // Window with stop p in row anchorRow: row line[k] shows stop p + line[k] - anchorRow.
        reel.forEach((_, p) => { const s = reel[(((p + line[k] - anchorRow) % reel.length) + reel.length) % reel.length]; m.set(s, (m.get(s) || 0n) + wOf(k, p)); });
        return [...m];
      });
      const walk = (k, syms, weight) => {
        if (k === N) { const pay = cachedPay(syms); byPay.set(pay, (byPay.get(pay) || 0n) + weight); return; }
        for (const [s, w] of freq[k]) walk(k + 1, [...syms, s], weight * w);
      };
      walk(0, [], 1n);
    }
    let lineSum = new Fraction(0n);
    for (const [pay, w] of byPay) lineSum = lineSum.add(F(pay).mul(w));
    let dist = [1n];
    set.reels.forEach((reel, k) => {
      const local = new Array(R + 1).fill(0n);
      reel.forEach((_, p) => { let c = 0; for (let r = 0; r < R; r++) if (reel[(((p + r + 1 - anchorRow) % reel.length) + reel.length) % reel.length] === sc.symbol) c++; local[c] += wOf(k, p); });
      const next = new Array(dist.length + R).fill(0n);
      dist.forEach((a, i) => local.forEach((b, j) => { next[i + j] += a * b; }));
      dist = next;
    });
    const scPay = (c) => (c === 0 ? new Fraction(0n) : Fraction.of(c <= sc.pays.length ? sc.pays[c - 1] : sc.pays[sc.pays.length - 1]));
    const scatterEV = dist.reduce((a, w, c) => a.add(scPay(c).mul(w)), new Fraction(0n)).div(cycle);
    const pTrig = new Fraction(dist.reduce((a, w, c) => a + (c >= f.trigger ? w : 0n), 0n), cycle);
    return { ev: lineSum.div(cycle).div(L).add(scatterEV), pTrig };
  };
  const mixed = (sets) => {
    const V = sets.reduce((a, s) => a + s.weight, 0n);
    return sets.map((s) => ({ s, x: spin(s) })).reduce((acc, { s, x }) => ({ ev: acc.ev.add(x.ev.mul(s.weight).div(V)), pTrig: acc.pTrig.add(x.pTrig.mul(s.weight).div(V)) }), { ev: new Fraction(0n), pTrig: new Fraction(0n) });
  };
  const base = mixed(setsOf(raw));
  const fsp = mixed(setsOf(f.reels || f.reelSets ? f : raw));
  const Fs = new Fraction(BigInt(f.spins));
  const spins = f.retrigger ? Fs.div(new Fraction(1n).sub(fsp.pTrig.mul(Fs))) : Fs;
  return base.ev.add(base.pTrig.mul(spins).mul(fsp.ev).mul(Fraction.of(f.multiplier)));
}

test('weighted Desert Gold sample: exact RTP equals the symbol-tuple enumeration', () => {
  const raw = JSON.parse(read('desert-gold-weighted.json'));
  const r = rtpOf(raw);
  const expected = rtpBySymbolTuples(raw);
  assert.strictEqual(r.rtp.fraction, expected.toString());
  // The percentage the page shows for this sample (test/ui/lab-weighted.test.js).
  assert.strictEqual(expected.toPercent(6), '95.743252');
  assert.strictEqual(r.model.weighted, true);
  assert.strictEqual(r.model.freeSpinReelSets.length, 2);
  // The same second algorithm on the unweighted Desert Gold gives its known 95.5175%.
  assert.strictEqual(rtpBySymbolTuples(JSON.parse(read('desert-gold.json'))).toPercent(6), '95.517500');
});

test('lab/samples.js carries the weighted sample (regenerate with scripts/make-lab-samples.mjs)', async () => {
  const samples = await import('../../lab/samples.js');
  assert.deepStrictEqual(samples.desertGoldWeighted, JSON.parse(read('desert-gold-weighted.json')));
});

// ---- Review fixes ----
test('a stop weight belongs to the window whose top row (row 1) shows that stop: exact engine and simulator', async () => {
  // One reel A, B, C with weights 5, 1, 1 (total 7) and three rows. By hand: the window
  // starting at A (weight 5) shows A in row 1; A is in row 2 only in the window starting
  // at C (weight 1) and in row 3 only in the one starting at B (weight 1). A pays 1.
  const raw = (row) => ({ rows: 3, reels: [['A', 'B', 'C']], weights: [[5, 1, 1]], lines: [[row]], paytable: { A: [1] } });
  assert.deepStrictEqual([1, 2, 3].map((row) => rtpOf(raw(row)).rtp.fraction), ['5/7', '1/7', '1/7']);
  // The simulator uses the same convention. nextBelow(7) on words 0 and 5 gives u = 0
  // (cumulative bounds 5, 6, 7: stop A on top, a win) and u = 5 (stop B on top, no win).
  const model = normalizeModel(raw(1));
  const sim = simulate(model, words([0, 5]), 2);
  assert.strictEqual(sim.totalWinUnits, model.totalBetUnits);
  assert.strictEqual(sim.rtp, 0.5);
});

test('the README conversion for weights of another row: weights[p] = sheet[(p + j - 1) mod n]', () => {
  // The second algorithm above applies weights read as middle-row (j = 2) weights directly;
  // the engine gets the converted weights. Both must agree, and both differ from row 1.
  const raw = JSON.parse(read('desert-gold-weighted.json'));
  const conv = (w) => w && w.map((_, p) => w[(p + 1) % w.length]);
  const mid = clone(raw);
  mid.weights = raw.weights.map(conv);
  for (const set of mid.scatter.freeSpins.reelSets) if (set.weights) set.weights = set.weights.map(conv);
  const direct = rtpBySymbolTuples(raw, 2);
  assert.strictEqual(rtpOf(mid).rtp.fraction, direct.toString());
  // The figure README.md quotes for the middle-row reading, from the second algorithm.
  assert.strictEqual(direct.toPercent(6), '94.093636');
  assert.notStrictEqual(direct.toString(), rtpOf(raw).rtp.fraction);
});

test('the recorded weighted-generator text pins the draw: a re-implementation from it matches the picker', async () => {
  // Written from PRNG_DESCRIPTION_WEIGHTED alone: k = max(1, ceil(bits(T-1)/32)) words joined
  // most significant first, drawn again while x >= 2^(32k) - (2^(32k) mod T), u = x mod T,
  // the pick is the first entry whose cumulative weight exceeds u.
  assert.ok(PRNG_DESCRIPTION_WEIGHTED.includes('u = x mod T'));
  assert.ok(PRNG_DESCRIPTION_WEIGHTED.includes('while x >= 2^(32k) - (2^(32k) mod T)'));
  assert.ok(PRNG_DESCRIPTION_WEIGHTED.includes('k = max(1, ceil(bits(T-1)/32))'));
  assert.ok(PRNG_DESCRIPTION_WEIGHTED.includes('row 1 (the top row)'));
  const documented = (ws) => {
    const T = ws.reduce((a, b) => a + b, 0n);
    const bits = T - 1n === 0n ? 0 : (T - 1n).toString(2).length;
    const k = Math.max(1, Math.ceil(bits / 32));
    const span = 1n << BigInt(32 * k);
    return (src) => {
      let x;
      do { x = 0n; for (let i = 0; i < k; i++) x = x * 4294967296n + BigInt(src.nextU32()); } while (x >= span - (span % T));
      const u = x % T;
      let c = 0n;
      for (let i = 0; i < ws.length; i++) { c += ws[i]; if (c > u) return i; }
      throw new Error('unreachable');
    };
  };
  // A generator that also counts the words used, so both sides must consume the same words.
  const counted = (list) => { const g = words(list); let n = 0; const f = g.nextU32; g.nextU32 = () => { n++; return f(); }; g.used = () => n; return g; };
  const M64 = (1n << 64n) - 1n;
  const cases = [
    [3n, 5n, 7n], [1n], [1n << 32n], [1n << 32n, 1n], [1n << 32n, 1n << 33n], [M64, 1n], [M64, M64], [M64, M64, M64, 5n],
  ];
  const rng = await prngFromSeed('documented-draw');
  for (const ws of cases) {
    // Random words, then words at the rejection boundary of 2- and 3-word totals.
    const streams = Array.from({ length: 200 }, () => Array.from({ length: 12 }, () => rng.nextU32()));
    streams.push([0xffffffff, 0, 1, 2, 3, 4], [0xffffffff, 0xffffffff, 0xffffffff, 0, 0, 0], [0xfffffffe, 0xffffffff, 7, 7, 7, 7]);
    for (const list of streams) {
      const a = counted([...list]), b = counted([...list]);
      let ia, ib;
      try { ia = weightedPicker(ws)(a); } catch (e) { ia = 'out of words'; }
      try { ib = documented(ws)(b); } catch (e) { ib = 'out of words'; }
      assert.strictEqual(ia, ib, `${ws} on ${list.slice(0, 4)}`);
      if (ia !== 'out of words') assert.strictEqual(a.used(), b.used(), `words used, ${ws}`);
    }
  }
  // x equal to the limit is rejected (it is not "below" it): T = 3 * 2^32, x = 2^64 - 2^32.
  const edge = counted([0xffffffff, 0, 0, 9]);
  assert.strictEqual(documented([1n << 32n, 1n << 33n])(edge), 0);
  assert.strictEqual(edge.used(), 4);
});

test('the weights / reelSets keys open the JSON editor even when they change no odds; such models run as unweighted', async () => {
  // isWeightedModel is about the keys (the form cannot show them); weighted is about the
  // odds. One reel set (any set weight) or only null weight lists change nothing, so the
  // analysis, the generator text and the simulation equal those of the plain model.
  const plain = { rows: 1, reels: [['A', 'B', 'C'], ['A', 'C', 'B', 'B']], paytable: { A: [0, 5], B: [0, 1] } };
  const oneSet = { rows: 1, reelSets: [{ weight: 5, reels: plain.reels }], paytable: plain.paytable };
  const nullWeights = { ...plain, weights: [null, null] };
  const ref = normalizeModel(plain);
  for (const raw of [oneSet, nullWeights]) {
    assert.strictEqual(isWeightedModel(raw), true);
    const m = normalizeModel(raw);
    assert.strictEqual(m.weighted, false);
    assert.deepStrictEqual(exactSummary(analyzeExact(m)), exactSummary(analyzeExact(ref)));
    assert.strictEqual(generatorDescription(m), PRNG_DESCRIPTION);
    assert.deepStrictEqual(simulate(m, await prngFromSeed('keys'), 5000), simulate(ref, await prngFromSeed('keys'), 5000));
  }
  // So the JSON editor's note names the keys instead of claiming weights or several sets.
  const [ar, en] = pair('jsonModeNote');
  assert.ok(en.includes('weights or reelSets keys') && !/more than one reel set/.test(en), en);
  assert.ok(ar.includes('weights') && ar.includes('reelSets') && !ar.includes('أكثر من مجموعة'), ar);
});

test('free spins: no reels key (or null) means the base reels; an empty list is an error', () => {
  // As before reel sets existed (commit 5863f5b: `if (f.reels)`, and [] is truthy in JS).
  const raw = (reels) => ({ rows: 1, reels: [['A', 'S'], ['A', 'S']], paytable: { A: [0, 2] }, scatter: { symbol: 'S', freeSpins: { trigger: 2, spins: 1, ...(reels === undefined ? {} : { reels }) } } });
  for (const reels of [undefined, null, '']) assert.strictEqual(normalizeModel(raw(reels)).freeSpins.sameReels, true, String(reels));
  assert.throws(() => normalizeModel(raw([])), (e) => e instanceof ModelError && /freeSpins\.reels: no reels/.test(e.en) && Boolean(e.ar));
});

test('CSV: weightN must follow reelN (or the Nth unnumbered reel column)', () => {
  const ok = [
    ['reel1,weight1,reel2,weight2\nA,9,A,1\nB,1,B,3\n', [[9, 1], [1, 3]]],
    ['reel1,reel2,weight2\nA,A,4\nB,B,1\n', [null, [4, 1]]],
    ['reel,weight,reel\nA,2,A\nB,1,B\n', [[2, 1], null]], // unnumbered weight: the reel before it
    ['reel,reel,weight2\nA,A,6\nB,B,1\n', [null, [6, 1]]], // reel columns without numbers count 1, 2, ...
    ['بكرة1,وزن1,بكرة2\nA,3,A\nB,1,B\n', [[3, 1], null]],
  ];
  for (const [text, weights] of ok) assert.deepStrictEqual(applyCsv({ rows: 1 }, text, 'r.csv').weights, weights, text);
  const bad = [
    'reel1,reel2,weight1\nA,A,9\nB,B,1\n', // reel 1's weights placed after reel 2
    'reel1,weight2,reel2,weight1\nA,9,A,1\nB,1,B,1\n', // swapped
    'reel,reel,weight1\nA,A,9\nB,B,1\n', // the second reel column is reel 2
    'بكرة1,بكرة2,وزن1\nA,A,9\nB,B,1\n',
  ];
  for (const text of bad) {
    assert.throws(() => applyCsv({ rows: 1 }, text, 'r.csv'), (e) => e instanceof ModelError && /same number/.test(e.en) && /برقمها نفسه/.test(e.ar), text);
  }
});

test('a JSON number weight of 2^53 or more: the message does not quote a rounded value or call 2^53 "above"', () => {
  const at = (literal) => { try { normalizeModel(JSON.parse(`{"rows":1,"reels":[["A","B"]],"weights":[[${literal},1]],"paytable":{"A":[1]}}`)); return null; } catch (e) { return e; } };
  // 2^53 + 1 is read by JSON.parse as 2^53, and 2^53 itself cannot be told apart from it.
  for (const literal of ['9007199254740993', '9007199254740992', '1e300']) {
    const e = at(literal);
    assert.ok(e instanceof ModelError, literal);
    assert.ok(/2\^53 or more/.test(e.en) && /2\^53 أو أكبر/.test(e.ar), e.en);
    assert.ok(!e.en.includes('9007199254740992') && !e.ar.includes('9007199254740992'), e.en);
  }
  assert.strictEqual(at('9007199254740991'), null); // 2^53 - 1 is exact and accepted
  // A large negative number is refused for being below 1, not for its size.
  const neg = at('-1e20');
  assert.ok(/at least 1/.test(neg.en) && !/2\^53/.test(neg.en), neg.en);
});

test('reel-set errors read "reelSets, set N" (1-based, no brackets) in both languages', () => {
  const msg = (raw) => { try { normalizeModel(raw); } catch (e) { return [e.ar, e.en]; } return null; };
  let [ar, en] = msg({ rows: 1, reelSets: [{ reels: [['A']] }], paytable: {} });
  assert.strictEqual(en, 'reelSets, set 1: the set has no weight');
  assert.strictEqual(ar, 'reelSets، المجموعة 1: لا يوجد وزن للمجموعة');
  [ar, en] = msg({ rows: 1, reelSets: [{ weight: 1, reels: [['A', 'B']] }, { weight: 1, reels: [['A', 'B']], weights: [[1, 0]] }], paytable: {} });
  assert.match(en, /^reelSets, set 2: reel 1, stop 2: a weight must be at least 1/);
  assert.match(ar, /^reelSets، المجموعة 2: البكرة 1، الموقع 2: الوزن يجب/);
  [ar, en] = msg({ rows: 1, reels: [['A', 'S']], paytable: { A: [1] }, scatter: { symbol: 'S', freeSpins: { trigger: 1, spins: 1, reelSets: [{ weight: 1, reels: [[]] }] } } });
  assert.strictEqual(en, 'freeSpins.reelSets, set 1: reel 1 is empty');
  for (const text of [ar, en]) assert.ok(!/[[\]]/.test(text), text);
});

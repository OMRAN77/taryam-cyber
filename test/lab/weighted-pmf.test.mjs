// The distribution tests (audit-stats.js, P0-9) read the exact pmf that slot-exact.js
// exports, and that pmf must come from the weighted engine (P0-5): its counts are stop
// weights over the cycle, mixed over every reel set. Expected values come from the
// expanded (unweighted) model, the mixture identity p = sum pi_r p_r, and exact sums.
import test from 'node:test';
import assert from 'node:assert';
import { normalizeModel } from '../../lab/core/slot-model.js';
import { analyzeExact } from '../../lab/core/slot-exact.js';
import { Fraction } from '../../lab/core/fraction.js';
import { pmfFromExact, auditDistribution } from '../../lab/core/audit-stats.js';
import { parsePlayLog } from '../../lab/core/actual.js';
import { prngFromSeed } from '../../lab/core/prng.js';

const clone = (x) => JSON.parse(JSON.stringify(x));
const pmfOf = (raw) => analyzeExact(normalizeModel(raw)).distribution.pmf;
const F = (s) => { const [n, d = '1'] = String(s).split('/'); return new Fraction(BigInt(n), BigInt(d)); };
// Outcome -> exact probability.
const probs = (pmf) => new Map(pmf.entries.map((e) => [`${e.units}|${e.trigger}`, new Fraction(BigInt(e.count), BigInt(pmf.total))]));

const ONE_ROW = {
  name: 'weighted pmf, one row', rows: 1,
  reels: [['A', 'K', 'W', 'Q', 'S', 'B'], ['K', 'A', 'Q', 'W', 'B', 'S'], ['Q', 'S', 'A', 'K', 'W', 'B', 'K']],
  weights: [[3, 1, 2, 5, 1, 4], [2, 2, 1, 3, 6, 1], [1, 2, 3, 1, 1, 2, 5]],
  lines: [[1, 1, 1]],
  paytable: { A: [0, 2, 10], K: [0, 0, 5], Q: [0, 0, 2.5], B: [0, 0, 0] },
  wild: { symbol: 'W', pays: [0, 5, 25] },
  scatter: { symbol: 'S', pays: [0, 2, 10], freeSpins: { trigger: 2, spins: 3, multiplier: 2 } },
};
// With one row a stop of weight w is w copies of that stop.
function expand(raw) {
  const out = clone(raw);
  out.reels = raw.reels.map((reel, k) => reel.flatMap((s, p) => new Array(raw.weights[k][p]).fill(s)));
  delete out.weights;
  return out;
}

test('weighted pmf: equals the pmf of the expanded model, count for count', () => {
  const w = pmfOf(ONE_ROW), e = pmfOf(expand(ONE_ROW));
  assert.strictEqual(w.scope, 'baseSpin');
  assert.strictEqual(w.total, e.total);
  assert.deepStrictEqual(w.entries, e.entries);
  // And it differs from the same strips without weights.
  const plain = clone(ONE_ROW);
  delete plain.weights;
  assert.notDeepStrictEqual(pmfOf(plain).entries, w.entries);
});

test('weighted pmf: reel sets mix with pi_r, outcome by outcome', () => {
  const A = clone(ONE_ROW);
  const B = { ...clone(ONE_ROW), reels: [['K', 'S', 'A', 'W', 'Q', 'B'], ['A', 'A', 'K', 'S', 'W'], ['W', 'Q', 'K', 'S', 'A', 'B']] };
  delete B.weights;
  const M = clone(ONE_ROW);
  delete M.reels; delete M.weights;
  M.reelSets = [{ weight: 3, reels: A.reels, weights: A.weights }, { weight: 5, reels: B.reels }];
  const [pa, pb, pm] = [A, B, M].map((m) => probs(pmfOf(m)));
  const keys = new Set([...pa.keys(), ...pb.keys()]);
  assert.deepStrictEqual(new Set(pm.keys()), keys);
  const zero = new Fraction(0n);
  for (const k of keys) {
    const mix = (pa.get(k) || zero).mul(3n).add((pb.get(k) || zero).mul(5n)).div(8n);
    assert.strictEqual(pm.get(k).toString(), mix.toString(), k);
  }
});

test('weighted pmf: uint64 weights stay exact (BigInt counts), and the pmf mean is the paid spin EV', () => {
  const big = clone(ONE_ROW);
  big.weights = big.weights.map((reel) => reel.map((w) => String(BigInt(w) * 1000000007n * 999999937n)));
  const r = analyzeExact(normalizeModel(big));
  const pmf = r.distribution.pmf;
  assert.ok(BigInt(pmf.total) > 2n ** 64n, 'total beyond 2^64');
  assert.strictEqual(pmf.entries.reduce((a, e) => a + BigInt(e.count), 0n).toString(), pmf.total);
  // Scaling every reel's weights changes no probability.
  const small = probs(pmfOf(ONE_ROW));
  for (const [k, p] of probs(pmf)) assert.strictEqual(p.toString(), small.get(k).toString(), k);
  // Sum of x * p over the pmf = line + scatter contributions; P(trigger) matches.
  const mean = pmf.entries.reduce((a, e) => a.add(new Fraction(BigInt(e.units) * BigInt(e.count), BigInt(pmf.total) * BigInt(pmf.unitsPerBet))), new Fraction(0n));
  assert.strictEqual(mean.toString(), F(r.contributions.lines.fraction).add(F(r.contributions.scatter.fraction)).toString());
  const trig = pmf.entries.filter((e) => e.trigger).reduce((a, e) => a + BigInt(e.count), 0n);
  assert.strictEqual(new Fraction(trig, BigInt(pmf.total)).toString(), r.freeSpins.triggerProbability.fraction);
  const p = pmfFromExact(pmf, 'big');
  assert.ok(Math.abs(p.pTrigger - r.freeSpins.triggerProbability.value) < 1e-15);
});

test('weighted pmf: the distribution tests accept it and pass a log drawn from it', async () => {
  const noFs = clone(ONE_ROW);
  delete noFs.scatter.freeSpins;
  const r = analyzeExact(normalizeModel(noFs));
  const pmf = pmfFromExact(r.distribution.pmf, 'weighted');
  assert.strictEqual(pmf.scope, 'round');
  // Inverse-CDF draws from the exact pmf with a seeded generator.
  const rng = await prngFromSeed('weighted-pmf');
  const cdf = [];
  let acc = 0;
  for (const e of r.distribution.pmf.entries) { acc += Number(e.count) / Number(r.distribution.pmf.total); cdf.push([acc, e.x]); }
  const rows = ['bet,win'];
  for (let i = 0; i < 4000; i++) {
    const u = rng.nextU32() / 2 ** 32;
    rows.push('1,' + (cdf.find(([c]) => u < c) || cdf[cdf.length - 1])[1]);
  }
  const res = auditDistribution(parsePlayLog(rows.join('\n') + '\n'), [pmf], { alpha: 0.01 }, await prngFromSeed('weighted-pmf-mc'), () => {});
  assert.strictEqual(res.rounds, 4000);
  assert.ok(!res.fit.offSupport || !res.fit.offSupport.count, 'every win is in the weighted support');
  assert.notStrictEqual(res.fit.verdict, 'impossible');
  assert.notStrictEqual(res.fit.verdict, 'mismatch');
});

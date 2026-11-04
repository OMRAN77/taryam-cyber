// Session funnel (lab/core/session.js) and the whole-round pmf in the distribution
// tests. Expected values: the exact binomial distribution (BigInt), explicit
// enumeration of every win/loss path, seeded Monte Carlo of the same game, and hand
// arithmetic for European roulette (bet on red: 18 of 37 pockets pay 2 bets).
import test from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import { normalizeModel } from '../../lab/core/slot-model.js';
import { analyzeExact } from '../../lab/core/slot-exact.js';
import { Fraction } from '../../lab/core/fraction.js';
import { attachRoundDistribution } from '../../lab/core/round-dist.js';
import { sessionFunnel, sessionInputs, sumDistribution, ruinProbability, aliasTable } from '../../lab/core/session.js';
import { prngFromSeed } from '../../lab/core/prng.js';
import { simulate } from '../../lab/core/montecarlo.js';
import { parsePlayLog } from '../../lab/core/actual.js';
import { auditDistribution, pmfFromExact } from '../../lab/core/audit-stats.js';

const SAMPLES = new URL('../../lab/samples/', import.meta.url);
const sample = (name) => JSON.parse(fs.readFileSync(new URL(name, SAMPLES), 'utf8'));
function withRound(raw) {
  const model = normalizeModel(raw);
  let spins = null;
  const result = analyzeExact(model, { onEntries: (e) => { spins = e; } });
  attachRoundDistribution(result, model, spins);
  return { model, result };
}
const RED = withRound(sample('roulette-european.json'));
const DG = withRound(sample('desert-gold.json'));

// C(n, k) 18^k 19^(n-k) / 37^n exactly: numerators over the common denominator 37^n,
// with the probability of each k, its cumulative sum and quantiles read off exactly.
function binomialPmf(n) {
  const den = 37n ** BigInt(n), nums = [];
  let c = 1n;
  for (let k = 0; k <= n; k++) {
    nums.push(c * 18n ** BigInt(k) * 19n ** BigInt(n - k));
    c = (c * BigInt(n - k)) / BigInt(k + 1);
  }
  const p = (k) => new Fraction(nums[k], den).toNumber();
  const tail = (from) => new Fraction(nums.slice(from).reduce((a, b) => a + b, 0n), den).toNumber();
  // smallest net 2k - n with P(K <= k) >= q (q has at most 2 decimals)
  const quantile = (q) => {
    const need = (BigInt(Math.round(q * 100)) * den + 99n) / 100n;
    let acc = 0n;
    for (let k = 0; k <= n; k++) { acc += nums[k]; if (acc >= need) return 2 * k - n; }
    return n;
  };
  return { p, tail, quantile };
}

test('two-outcome game: the n-round sum is the exact binomial distribution', () => {
  const inp = sessionInputs(RED.result.round.pmf);
  // Lattice step = one red (2 bets): a / b = 2 / 1.
  assert.deepStrictEqual([Array.from(inp.xs), inp.a, inp.b], [[0, 1], 2n, 1n]);
  for (const n of [1, 100, 1000]) {
    const s = sumDistribution(inp.xs, inp.ps, n);
    const exact = binomialPmf(n);
    let worstAbs = 0, worstRel = 0;
    for (let k = 0; k < s.N; k++) {
      const e = k <= n ? exact.p(k) : 0;
      worstAbs = Math.max(worstAbs, Math.abs(s.q[k] - e));
      if (e >= 1e-6) worstRel = Math.max(worstRel, Math.abs(s.q[k] - e) / e);
    }
    assert.ok(worstAbs < 1e-15 && worstRel < 1e-9, `n=${n}: abs ${worstAbs} rel ${worstRel}`);
  }
  // Funnel figures for 1000 rounds from the exact binomial: ahead when 2K > 1000.
  const f = sessionFunnel(RED.result.round.pmf, { rounds: 1000, rtp: RED.result.rtp.fraction, sd: RED.result.distribution.sd });
  const ex = binomialPmf(1000);
  const ahead = ex.tail(501);
  assert.ok(Math.abs(f.pAhead - ahead) < 1e-12, `P(ahead) ${f.pAhead} vs ${ahead}`);
  assert.ok(Math.abs(f.pEven - ex.p(500)) < 1e-14);
  // Percentiles of net = 2K - 1000 from the exact CDF.
  assert.deepStrictEqual(f.percentiles.map((p) => p.net), [0.05, 0.25, 0.5, 0.75, 0.95].map(ex.quantile));
  // Hand arithmetic: expected loss 1000 * (1 - 36/37) = 1000/37 bets; sigma^2 =
  // 4 * 18/37 - (36/37)^2 = 1368/1369, so N* = (1.645 * sqrt(1368/1369) * 37)^2 = 3701.97...
  assert.strictEqual(f.expectedLoss.fraction, '1000/37');
  assert.strictEqual(f.nStar.rounds, 3702);
  assert.strictEqual(f.method, 'fft');
  // The published-in-research figures for this game (median -28, 5-95% band -80..+24,
  // P(ahead) 18.76%) follow from the same binomial.
  assert.deepStrictEqual([f.median, f.percentiles[0].net, f.percentiles[4].net, +(f.pAhead * 100).toFixed(2)], [-28, -80, 24, 18.76]);
  // The funnel: 8 round counts up to n; at 500 rounds, the exact binomial percentiles.
  assert.deepStrictEqual(f.funnel.map((p) => p.rounds), [125, 250, 375, 500, 625, 750, 875, 1000]);
  assert.deepStrictEqual(f.funnel[3].percentiles.map((p) => p.net), [0.05, 0.25, 0.5, 0.75, 0.95].map(binomialPmf(500).quantile));
  assert.strictEqual(f.funnel[3].mean, -500 / 37);
});

// Every sequence of reds (+1 bet) and others (-1 bet), 2^n of them, with ruin when
// the money left is less than one bet after any round.
function ruinByPaths(n, budget) {
  let ruin = new Fraction(0n);
  for (let mask = 0; mask < 2 ** n; mask++) {
    let bank = budget, reds = 0, dead = false;
    for (let j = 0; j < n; j++) {
      const red = (mask >> j) & 1;
      reds += red;
      bank += red ? 1 : -1;
      if (bank < 1) { dead = true; break; }
    }
    if (dead) {
      // Each full-length path is counted once, with its own weight
      // 18^reds 19^(n - reds) / 37^n; what follows the ruin adds up to the ruin's share.
      const all = [...Array(n).keys()].reduce((a, j) => a + ((mask >> j) & 1), 0);
      ruin = ruin.add(new Fraction(18n ** BigInt(all) * 19n ** BigInt(n - all), 37n ** BigInt(n)));
    }
  }
  return ruin;
}

test('ruin: dynamic programming equals explicit path enumeration (roulette)', () => {
  const inp = sessionInputs(RED.result.round.pmf);
  for (const [n, budget] of [[12, 3], [14, 5], [16, 2]]) {
    const dp = ruinProbability(inp.xs, inp.ps, inp.a, inp.b, n, budget * Number(inp.b));
    const exact = ruinByPaths(n, budget).toNumber();
    assert.ok(Math.abs(dp.p - exact) < 1e-13, `n=${n} budget=${budget}: ${dp.p} vs ${exact}`);
  }
  // Edge cases: less than one bet is ruin at once; more than n + 1 bets cannot run out.
  assert.strictEqual(ruinProbability(inp.xs, inp.ps, inp.a, inp.b, 10, 0).p, 1);
  assert.strictEqual(ruinProbability(inp.xs, inp.ps, inp.a, inp.b, 10, 11).p, 0);
});

test('ruin and funnel: dynamic programming / FFT agree with seeded Monte Carlo', async () => {
  for (const [game, n, budget] of [[RED, 200, 20], [DG, 100, 10], [DG, 60, 25]]) {
    const r = game.result;
    const exact = sessionFunnel(r.round.pmf, { rounds: n, budget, rtp: r.rtp.fraction, sd: r.distribution.sd });
    const mc = sessionFunnel(r.round.pmf, { rounds: n, budget, rtp: r.rtp.fraction, sd: r.distribution.sd, rng: await prngFromSeed(`session ${n} ${budget}`), forceMonteCarlo: true });
    assert.strictEqual(exact.method, 'fft');
    assert.strictEqual(exact.ruin.method, 'dp');
    assert.strictEqual(mc.method, 'mc');
    assert.strictEqual(mc.ruin.method, 'mc');
    const label = `${r.model.name} n=${n} budget=${budget}`;
    assert.ok(Math.abs(exact.ruin.p - mc.ruin.p) <= 4 * Math.max(mc.ruin.se, 1 / mc.sessions), `${label}: ruin ${exact.ruin.p} vs MC ${mc.ruin.p} ± ${mc.ruin.se}`);
    assert.ok(Math.abs(exact.pAhead - mc.pAhead) <= 4 * mc.pAheadSe, `${label}: ahead ${exact.pAhead} vs MC ${mc.pAhead} ± ${mc.pAheadSe}`);
  }
});

test('session funnel: Monte Carlo of the pmf agrees with simulating the game itself', async () => {
  // Desert Gold, 100 rounds: P(ahead) from the FFT funnel against whole sessions
  // played by the slot simulator (montecarlo.js), seeded.
  const r = DG.result;
  const f = sessionFunnel(r.round.pmf, { rounds: 100, rtp: r.rtp.fraction, sd: r.distribution.sd });
  const rng = await prngFromSeed('desert gold sessions');
  const sessions = 4000;
  let ahead = 0;
  for (let s = 0; s < sessions; s++) {
    const sim = simulate(DG.model, rng, 100, { progressEvery: 1e9 });
    if (sim.totalWinUnits > 100 * DG.model.totalBetUnits) ahead++;
  }
  const p = ahead / sessions, se = Math.sqrt(p * (1 - p) / sessions);
  assert.ok(Math.abs(f.pAhead - p) <= 4 * se, `FFT ${f.pAhead} vs simulated ${p} ± ${se}`);
  // Normal approximation (labeled): Phi(-sqrt(n) edge / sigma).
  assert.ok(Math.abs(f.normal.pAhead - 0.44197) < 1e-4);
});

test('alias table draws each outcome with its probability', async () => {
  const ps = [0.5, 0.25, 0.125, 0.0625, 0.0625];
  const t = aliasTable(ps);
  const rng = await prngFromSeed('alias');
  const counts = new Array(ps.length).fill(0);
  const m = 200000;
  for (let i = 0; i < m; i++) counts[t.draw(rng)]++;
  ps.forEach((p, i) => assert.ok(Math.abs(counts[i] / m - p) < 4 * Math.sqrt(p * (1 - p) / m), `outcome ${i}`));
});

test('session funnel: input checks', () => {
  const r = RED.result;
  assert.throws(() => sessionFunnel(r.round.pmf, { rounds: 0, rtp: r.rtp.fraction, sd: 1 }), (e) => e.ar && /rounds/.test(e.en));
  assert.throws(() => sessionFunnel(r.round.pmf, { rounds: 10, budget: '-5', rtp: r.rtp.fraction, sd: 1 }), (e) => e.ar && /budget/.test(e.en));
  // Monte Carlo needs a seeded generator.
  assert.throws(() => sessionFunnel(r.round.pmf, { rounds: 10, rtp: r.rtp.fraction, sd: 1, forceMonteCarlo: true }), /seeded/);
});

// The distribution tests compare whole rounds once the model has a whole-round pmf.
test('distribution tests use the whole-round pmf; a log drawn from the game is not rejected', async () => {
  const r = DG.result;
  assert.strictEqual(r.round.pmf.scope, 'round');
  const ref = pmfFromExact(r.round.pmf, 'Desert Gold');
  assert.strictEqual(ref.scope, 'round');
  // Its mean is the RTP up to the far tail left under the noise floor (mass ~6e-11).
  assert.ok(Math.abs(ref.mean - r.rtp.value) < 1e-6, 'pmf mean = RTP');
  assert.ok(ref.hasTrigger);
  // A seeded log of whole rounds played by the simulator (free spins merged into their
  // round, like the worker's sample log), with a trigger column.
  const rng = await prngFromSeed('round log');
  const lines = ['bet,win,trigger'];
  for (let i = 0; i < 20000; i++) {
    const s = simulate(DG.model, rng, 1, { progressEvery: 1e9 });
    lines.push('1,' + +(s.totalWinUnits / DG.model.totalBetUnits).toFixed(6) + ',' + s.triggers);
  }
  const log = parsePlayLog(lines.join('\n') + '\n');
  const out = auditDistribution(log, [ref], { alpha: 0.01, replicates: 999, totalReplicates: 999 }, await prngFromSeed('audit'));
  assert.strictEqual(out.scope, 'round');
  assert.strictEqual(out.fit.offSupport.count, 0);
  assert.strictEqual(out.fit.verdict, 'consistent');
  // The paid-spin pmf (the fallback) still works, with the trigger column.
  const base = pmfFromExact(r.distribution.pmf, 'base');
  assert.strictEqual(base.scope, 'baseSpin');
  const out2 = auditDistribution(log, [base], { alpha: 0.01, replicates: 999, totalReplicates: 999 }, await prngFromSeed('audit'));
  assert.strictEqual(out2.fit.verdict, 'consistent');
});

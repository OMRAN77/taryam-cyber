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
  // Retriggers without a cap: no largest win, so the pmf's last cell (above the noise
  // floor) is neither a top prize nor a bound M for the e-process (it needs M).
  assert.deepStrictEqual([ref.maxWin, ref.truncated], [null, true]);
  assert.strictEqual(out.fit.topPrize, undefined);
  assert.strictEqual(out.betting.needs, 'maxWin');
  // European roulette: an exact pmf whose largest win, 2 bets, is the true bound.
  const red = pmfFromExact(RED.result.round.pmf, 'red');
  assert.deepStrictEqual([red.maxWin, red.truncated], [2, false]);
  // The paid-spin pmf (the fallback) still works, with the trigger column.
  const base = pmfFromExact(r.distribution.pmf, 'base');
  assert.strictEqual(base.scope, 'baseSpin');
  const out2 = auditDistribution(log, [base], { alpha: 0.01, replicates: 999, totalReplicates: 999 }, await prngFromSeed('audit'));
  assert.strictEqual(out2.fit.verdict, 'consistent');
});

// ---------- review fixes ----------

// log P(K > n/2), K ~ Binomial(n, 18/37), summed in log space term by term
// (log C(n, k) built up as a running sum of logs): an independent reference far below
// what a double-precision transform can resolve.
function logAhead(n) {
  const lp = Math.log(18 / 37), lq = Math.log(19 / 37);
  let logC = 0;
  const terms = [];
  for (let k = 0; k <= n; k++) {
    if (k > 0) logC += Math.log((n - k + 1) / k);
    if (2 * k > n) terms.push(logC + k * lp + (n - k) * lq);
  }
  const m = Math.max(...terms);
  return m + Math.log(terms.reduce((a, t) => a + Math.exp(t - m), 0));
}

test('session: a probability under the transform noise is an upper bound, not a value', () => {
  const r = RED.result;
  // 20,000 rounds: about 6.4e-5, far above the noise: a value, within 1e-6 relative.
  const f20 = sessionFunnel(r.round.pmf, { rounds: 20000, rtp: r.rtp.fraction, sd: r.distribution.sd });
  const e20 = Math.exp(logAhead(20000));
  assert.ok(Math.abs(f20.pAhead - e20) <= 1e-6 * e20, `${f20.pAhead} vs ${e20}`);
  assert.strictEqual(f20.pAheadBelow, null);
  // 100,000 rounds: about 6.1e-18, under the noise (the raw transform gave ~2.6e-12):
  // no value; the bound is true and informative (Chernoff, under 1e-15).
  for (const n of [100000, 200000]) {
    const f = sessionFunnel(r.round.pmf, { rounds: n, rtp: r.rtp.fraction, sd: r.distribution.sd });
    const exact = Math.exp(logAhead(n));
    assert.strictEqual(f.pAhead, null, `n=${n}`);
    assert.ok(f.pAheadBelow >= exact && f.pAheadBelow < 1e-15, `n=${n}: bound ${f.pAheadBelow} vs ${exact}`);
    assert.ok(f.precision.error > 0 && f.precision.floor >= 1e-13);
  }
});

test('session: ruin under the precision floor is a bound; the bound holds against a direct DP', () => {
  // Desert Gold, 100 rounds, budget 97 bets: a direct dynamic programme over the
  // bankroll (all terms positive, so tiny values keep their accuracy) gives about
  // 1.2e-19 for the round pmf; the true game differs by at most 100 x the mass the pmf
  // left out (each round can land there at most with that probability).
  const r = DG.result;
  const inp = sessionInputs(r.round.pmf);
  const A = Number(inp.a), B = Number(inp.b), n = 100, start = 97 * B;
  const top = (n + 1) * B;
  let cur = new Float64Array(top + 1);
  cur[start] = 1;
  let direct = 0;
  for (let k = 0; k < n; k++) {
    const nx = new Float64Array(top + 1);
    for (let y = 0; y <= top; y++) {
      const p = cur[y];
      if (!p) continue;
      for (let i = 0; i < inp.xs.length; i++) {
        const z = y - B + inp.xs[i] * A;
        if (z < B) direct += p * inp.ps[i]; else nx[Math.min(z, top)] += p * inp.ps[i];
      }
    }
    cur = nx;
  }
  assert.ok(direct < 1e-15, 'direct ' + direct);
  const f = sessionFunnel(r.round.pmf, { rounds: n, budget: '97', rtp: r.rtp.fraction, sd: r.distribution.sd });
  assert.strictEqual(f.ruin.method, 'dp');
  assert.strictEqual(f.ruin.p, null);
  assert.ok(f.ruin.below >= direct + n * inp.droppedMass, `bound ${f.ruin.below}`);
  assert.ok(f.ruin.below < 1e-7, 'still informative');
  // A large ruin chance is a value (budget 10 over 100 rounds: about 0.6).
  const g = sessionFunnel(r.round.pmf, { rounds: n, budget: '10', rtp: r.rtp.fraction, sd: r.distribution.sd });
  assert.ok(g.ruin.p > 0.1 && g.ruin.below === null);
  // Sums of positive terms on an exact pmf keep tiny values: roulette, 50 rounds with a
  // budget of 50 bets runs out only if all 50 are lost, (19/37)^50 = 3.3e-15 by hand.
  const red = RED.result;
  const h = sessionFunnel(red.round.pmf, { rounds: 50, budget: '50', rtp: red.rtp.fraction, sd: red.distribution.sd });
  const all = new Fraction(19n ** 50n, 37n ** 50n).toNumber();
  assert.ok(Math.abs(h.ruin.p - all) <= 1e-12 * all, `${h.ruin.p} vs ${all}`);
});

test('session Monte Carlo: no hit in m sessions is a 95% bound, not 0 ± 0', async () => {
  // A round paying 0 or half a bet can never finish ahead: by hand P(ahead) = 0, and a
  // budget of 50 bets cannot run out in 10 rounds (each round loses at most 1 bet).
  const pmf = { entries: [{ units: 0, p: 0.5 }, { units: 1, p: 0.5 }], unitBets: '1/2', droppedMass: 0 };
  const f = sessionFunnel(pmf, { rounds: 10, budget: '50', rtp: '1/4', sd: 0.25, rng: await prngFromSeed('none'), forceMonteCarlo: true });
  const m = f.sessions;
  // 1 - 0.05^(1/m): the exact one-sided 95% Clopper-Pearson bound for 0 of m.
  assert.strictEqual(f.pAhead, 0);
  assert.ok(Math.abs(f.pAheadUpper95 - (1 - Math.pow(0.05, 1 / m))) < 1e-15);
  assert.ok(Math.abs(f.ruin.upper95 - (1 - Math.pow(0.05, 1 / m))) < 1e-15);
  // Without simulation the same impossibility is an exact 0, not a bound.
  const exact = sessionFunnel(pmf, { rounds: 10, rtp: '1/4', sd: 0.25 });
  assert.deepStrictEqual([exact.method, exact.pAhead, exact.pAheadBelow], ['fft', 0, null]);
  // A game that never pays, budget 2 bets, 5 rounds: by hand every session runs out
  // (after the second round less than one bet is left), so the bound is the lower one.
  const zero = { entries: [{ units: 0, p: 1 }], unitBets: '1', droppedMass: 0 };
  const g = sessionFunnel(zero, { rounds: 5, budget: '2', rtp: '0', sd: 0, rng: await prngFromSeed('all'), forceMonteCarlo: true });
  assert.strictEqual(g.ruin.p, 1);
  assert.ok(Math.abs(g.ruin.lower95 - Math.pow(0.05, 1 / g.sessions)) < 1e-15);
});

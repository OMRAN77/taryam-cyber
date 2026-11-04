// Whole-round distribution (lab/core/round-dist.js). Every expected value comes from
// a brute-force reference written here, independent of the engine:
//  * a tiny 3-reel game whose 180 stop combinations are evaluated one by one by the
//    evaluator below (not the engine's line state machine);
//  * the feature by enumerating play sequences (each free spin's outcome in turn,
//    with the retrigger rule applied explicitly), i.e. every feature tree read in
//    play order, truncated when the mass still playing is below 1e-16 (that mass is
//    added to the error bound) - no transform, no fixed point;
//  * caps: the same enumeration in exact BigInt arithmetic, with the cap rule written
//    out again (not capGraph);
//  * Desert Gold's largest win: its probability from the published spin pmf by hand
//    (trigger spin with the largest win, then 10 free spins at the largest win).
import test from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import { normalizeModel } from '../../lab/core/slot-model.js';
import { analyzeExact } from '../../lab/core/slot-exact.js';
import { Fraction } from '../../lab/core/fraction.js';
import {
  roundDistribution, attachRoundDistribution, exactMomentsOf, featureDistribution, capStats, topAwardChecks,
  cappedFeature, GRID_LIMIT, FLOOR_MIN,
} from '../../lab/core/round-dist.js';
import { simulate } from '../../lab/core/montecarlo.js';
import { prngFromSeed } from '../../lab/core/prng.js';

const SAMPLES = new URL('../../lab/samples/', import.meta.url);
const sample = (name) => JSON.parse(fs.readFileSync(new URL(name, SAMPLES), 'utf8'));

// ---------- the tiny game, evaluated by brute force ----------
const TINY = {
  name: 'tiny retrigger', rows: 1,
  reels: [['A', 'B', 'S', 'C', 'A', 'B'], ['A', 'S', 'B', 'C', 'B'], ['S', 'A', 'B', 'C', 'A', 'C']],
  lines: [[1, 1, 1]],
  paytable: { A: [0, 2, 10], B: [0, 1, 5], C: [0.5, 1, 3] },
  scatter: { symbol: 'S', pays: [0, 2, 20], freeSpins: { trigger: 2, spins: 3, multiplier: 2, retrigger: true } },
};
const withFs = (raw, fsPatch) => ({ ...raw, scatter: { ...raw.scatter, freeSpins: { ...raw.scatter.freeSpins, ...fsPatch } } });

// Every stop combination: win in tenths of a bet (all pays are multiples of 0.5 and
// the line bet is the total bet), and the scatter count. One line, left to right:
// the run of the first symbol; a scatter pays by count anywhere and never on the line.
function spinOutcomes(raw) {
  const out = new Map();
  const [r1, r2, r3] = raw.reels;
  for (const a of r1) for (const b of r2) for (const c of r3) {
    const syms = [a, b, c];
    let line = 0;
    if (syms[0] !== 'S') {
      let run = 1;
      while (run < 3 && syms[run] === syms[0]) run++;
      line = raw.paytable[syms[0]][run - 1];
    }
    const scat = syms.filter((s) => s === 'S').length;
    const scatPay = scat ? raw.scatter.pays[scat - 1] : 0;
    const tenths = Math.round((line + scatPay) * 10);
    const key = tenths + ',' + scat;
    out.set(key, (out.get(key) || 0) + 1);
  }
  return [...out].map(([k, count]) => { const [t, s] = k.split(',').map(Number); return { tenths: t, scat: s, count }; });
}
const COMBOS = 6 * 5 * 6;

// The feature total (tenths of a bet) by enumerating play sequences, in floats.
// classes: [{ u, award, p }]; returns { pmf: Map total -> p, lost: mass not finished }.
function enumerateFeature(classes, f0, { eps = 1e-16 } = {}) {
  let live = new Map([[f0 + ',0', 1]]);
  const done = new Map();
  let lost = 0;
  for (let step = 0; step < 100000 && live.size; step++) {
    const next = new Map();
    for (const [key, p] of live) {
      const [pend, total] = key.split(',').map(Number);
      for (const c of classes) {
        const np = pend - 1 + c.award, nt = total + c.u, q = p * c.p;
        if (q < 1e-40) { lost += q; continue; }
        if (np === 0) done.set(nt, (done.get(nt) || 0) + q);
        else { const k = np + ',' + nt; next.set(k, (next.get(k) || 0) + q); }
      }
    }
    live = next;
    let alive = 0;
    for (const v of live.values()) alive += v;
    if (alive < eps) { lost += alive; break; }
  }
  return { pmf: done, lost };
}

// Whole-round pmf (tenths) from the spin outcomes and a feature pmf.
function bruteRound(raw, feature) {
  const fs = raw.scatter.freeSpins;
  const round = new Map();
  for (const o of spinOutcomes(raw)) {
    const p = o.count / COMBOS;
    if (o.scat < fs.trigger) { round.set(o.tenths, (round.get(o.tenths) || 0) + p); continue; }
    for (const [t, q] of feature) round.set(o.tenths + t, (round.get(o.tenths + t) || 0) + p * q);
  }
  return round;
}
// The tiny game's reference, enumerated once.
let tinyReference = null;
function tinyRef() {
  if (!tinyReference) {
    const feat = enumerateFeature(freeClasses(TINY), 3);
    tinyReference = { lost: feat.lost, round: bruteRound(TINY, feat.pmf) };
  }
  return tinyReference;
}
function freeClasses(raw) {
  const fs = raw.scatter.freeSpins;
  const m = Number(fs.multiplier);
  return spinOutcomes(raw).map((o) => ({ u: o.tenths * m, award: fs.retrigger && o.scat >= fs.trigger ? fs.spins : 0, p: o.count / COMBOS }));
}

function analyze(raw) {
  const model = normalizeModel(raw);
  let spins = null;
  const result = analyzeExact(model, { onEntries: (e) => { spins = e; } });
  return { model, spins, result };
}

// Compares the engine's round pmf with a reference Map (tenths of a bet -> p).
// Transform rounding is absolute, about 1e-16 of the total mass in every cell, so
// cells of 1e-6 or more are compared relatively (1e-9) and every cell absolutely
// (1e-15 of the mass, plus what the reference left out). A cell the engine leaves out
// (under its noise floor) must be under the floor in the reference too.
function compareRound(round, ref, refLost, label) {
  const got = new Map();
  for (const e of round.pmf.entries) { const t = Math.round(e.x * 10); got.set(t, (got.get(t) || 0) + e.p); }
  let worstRel = 0, worstAbs = 0;
  for (const [t, p] of ref) {
    const g = got.get(t);
    if (g === undefined) { assert.ok(p < round.floor + refLost + 1e-15, `${label}: cell ${t / 10} (p ${p}) missing`); continue; }
    if (p >= 1e-6) worstRel = Math.max(worstRel, Math.abs(g - p) / p);
    worstAbs = Math.max(worstAbs, Math.abs(g - p));
  }
  for (const [t, g] of got) if (!ref.has(t)) worstAbs = Math.max(worstAbs, g);
  assert.ok(worstRel <= 1e-9, `${label}: worst relative error ${worstRel}`);
  assert.ok(worstAbs <= 1e-15 + refLost, `${label}: worst absolute error ${worstAbs}`);
}

test('tiny game with retrigger: the round pmf matches play-sequence enumeration to 1e-9', () => {
  const { model, spins, result } = analyze(TINY);
  // c = P(retrigger) * F = (15/180) * 3 = 0.25: P(>= 2 scatters) = (14 + 1) / 180 by hand.
  assert.strictEqual(result.freeSpins.retriggerProbability.fraction, '1/12');
  const round = roundDistribution(model, spins, exactMomentsOf(result));
  assert.strictEqual(round.method, 'fft');
  assert.strictEqual(round.bounded, false);
  const { lost, round: ref } = tinyRef();
  assert.ok(lost < 1e-15, 'reference lost mass ' + lost);
  compareRound(round, ref, lost, 'retrigger');
  // Internal checks hold, and the solver reports a converged fixed point.
  for (const k of ['mass', 'mean', 'variance']) assert.ok(round.checks[k].relativeError <= 1e-9, k);
  assert.ok(round.grid.solver.contraction > 0.249 && round.grid.solver.contraction < 0.251);
  assert.ok(round.grid.solver.errorBound < 1e-14);
  assert.ok(round.aliasBound <= 1e-15);
  // The reference's mean and variance agree with the closed forms too (to its own error).
  let m1 = 0, m2 = 0;
  for (const [t, p] of ref) { m1 += (t / 10) * p; m2 += (t / 10) ** 2 * p; }
  assert.ok(Math.abs(m1 - result.rtp.value) < 1e-12, 'mean ' + m1);
  assert.ok(Math.abs(m2 - m1 * m1 - result.distribution.variance.value) / result.distribution.variance.value < 1e-12, 'variance');
});

test('tiny game without retrigger: F0-fold convolution, bounded, exact top prize', () => {
  const raw = withFs(TINY, { retrigger: false });
  const { model, spins, result } = analyze(raw);
  const round = roundDistribution(model, spins, exactMomentsOf(result));
  assert.strictEqual(round.bounded, true);
  const feat = enumerateFeature(freeClasses(raw), 3);
  assert.strictEqual(feat.lost, 0);
  compareRound(round, bruteRound(raw, feat.pmf), 0, 'no retrigger');
  // Largest win by hand: a trigger spin pays at most 20 (three scatters, line 0); a
  // free spin at most 2 x 20 = 40 (three scatters) - so 20 + 3 * 40 = 140 bets, with
  // probability (1/180) * (1/180)^3 (the only three-scatter combination each time).
  assert.strictEqual(round.maxWin.x, 140);
  assert.strictEqual(round.maxWin.method, 'exact');
  assert.strictEqual(round.maxWin.fraction, new Fraction(1n, 180n ** 4n).toString());
  assert.strictEqual(result.distribution.maxWin.withFeature, 140);
});

// Two award sizes: phi = A + B_2 phi^2 + B_4 phi^4 (featureDistribution), against
// sequence enumeration with the same rule.
test('several retrigger awards: phi = A + sum_j B_j phi^F_j matches enumeration', () => {
  const spin = [{ x: 0, p: 0.5, award: 0 }, { x: 1, p: 0.3, award: 0 }, { x: 3, p: 0.12, award: 2 }, { x: 5, p: 0.08, award: 4 }];
  const f = featureDistribution(spin, 3, 4096);
  assert.ok(Math.abs(f.solver.contraction - 0.56) < 1e-12); // 0.12 * 2 + 0.08 * 4
  const ref = enumerateFeature(spin.map((s) => ({ u: s.x, award: s.award, p: s.p })), 3);
  assert.ok(ref.lost < 1e-15);
  let worst = 0, worstAbs = 0, mass = 0;
  for (const [x, p] of ref.pmf) {
    mass += f.pmf[x];
    if (p >= 1e-6) worst = Math.max(worst, Math.abs(f.pmf[x] - p) / p);
    worstAbs = Math.max(worstAbs, Math.abs(f.pmf[x] - p));
  }
  assert.ok(worst < 1e-9, 'worst relative error ' + worst);
  assert.ok(worstAbs < 1e-15, 'worst absolute error ' + worstAbs);
  assert.ok(Math.abs(mass - 1) < 1e-12);
  // Mean by hand: E[spins] = 3 / (1 - 0.56); E[win per spin] = 0.3 + 0.36 + 0.4 = 1.06.
  let mean = 0;
  for (let x = 0; x < 4096; x++) mean += x * f.pmf[x];
  assert.ok(Math.abs(mean - (3 / 0.44) * 1.06) < 1e-10, 'mean ' + mean);
  assert.throws(() => featureDistribution([{ x: 1, p: 0.5, award: 0 }, { x: 0, p: 0.5, award: 2 }], 1, 64), /infinite/);
});

// ---------- caps: exact BigInt enumeration with the cap rule written out ----------
// Returns Map total (tenths) -> Fraction for the capped feature, and its largest total.
function exactCappedFeature(raw) {
  const fs = raw.scatter.freeSpins;
  const S = fs.maxSpins ?? Infinity, R = fs.maxRetriggers ?? Infinity, F = fs.spins, m = Number(fs.multiplier);
  const outs = spinOutcomes(raw).map((o) => ({ u: o.tenths * m, retrig: o.scat >= fs.trigger, count: BigInt(o.count) }));
  // A path of L spins weighs prod(count) / 180^L.
  const done = new Map();
  let live = [{ pending: F, awarded: F, retriggers: 0, total: 0, w: 1n, len: 0 }];
  while (live.length) {
    const next = [];
    for (const s of live) {
      for (const o of outs) {
        let { pending, awarded, retriggers } = s;
        pending -= 1;
        if (o.retrig && retriggers < R && awarded < S) {
          const add = Math.min(F, S - awarded);
          pending += add; awarded += add; retriggers += 1;
        }
        const n = { pending, awarded, retriggers, total: s.total + o.u, w: s.w * o.count, len: s.len + 1 };
        if (pending === 0) {
          const f = new Fraction(n.w, 180n ** BigInt(n.len));
          done.set(n.total, (done.get(n.total) || new Fraction(0n)).add(f));
        } else next.push(n);
      }
    }
    // merge identical states to keep the enumeration small (same weights per length)
    const merged = new Map();
    for (const n of next) {
      const k = [n.pending, n.awarded, n.retriggers, n.total, n.len].join(',');
      const e = merged.get(k);
      if (e) e.w += n.w; else merged.set(k, n);
    }
    live = [...merged.values()];
  }
  return done;
}

test('caps: RTP, variance, round pmf and top prize match exact enumeration; Monte Carlo agrees', async () => {
  for (const caps of [{ maxSpins: 7 }, { maxRetriggers: 1 }, { maxSpins: 8, maxRetriggers: 2 }]) {
    const raw = withFs(TINY, caps);
    const { model, spins, result } = analyze(raw);
    const feat = exactCappedFeature(raw);
    // Exact round moments from the enumeration (bets).
    let ew = new Fraction(0n), ew2 = new Fraction(0n), pTop = null, top = -1;
    const roundRef = new Map();
    for (const o of spinOutcomes(raw)) {
      const p = new Fraction(BigInt(o.count), BigInt(COMBOS));
      const add = (t, q) => {
        const w = new Fraction(BigInt(t), 10n);
        ew = ew.add(w.mul(q)); ew2 = ew2.add(w.mul(w).mul(q));
        roundRef.set(t, (roundRef.get(t) || 0) + q.toNumber());
        if (t > top) { top = t; pTop = q; } else if (t === top) pTop = pTop.add(q);
      };
      if (o.scat < 2) add(o.tenths, p);
      else for (const [t, q] of feat) add(o.tenths + t, p.mul(q));
    }
    const label = JSON.stringify(caps);
    assert.strictEqual(result.rtp.fraction, ew.toString(), label + ' RTP');
    assert.strictEqual(result.distribution.variance.fraction, ew2.sub(ew.mul(ew)).toString(), label + ' variance');
    assert.strictEqual(result.distribution.maxWin.unbounded, false);
    assert.strictEqual(result.distribution.maxWin.withFeature, top / 10, label + ' max win');
    const round = roundDistribution(model, spins, exactMomentsOf(result));
    assert.strictEqual(round.method, 'capsDp', label);
    compareRound(round, roundRef, 0, label);
    assert.strictEqual(round.maxWin.x, top / 10);
    assert.strictEqual(round.maxWin.fraction, pTop.toString(), label + ' P(top)');
    // Seeded Monte Carlo of the capped game: within 4 standard errors of the exact RTP.
    const sim = simulate(model, await prngFromSeed('caps ' + label), 200000);
    assert.ok(Math.abs(sim.rtp - result.rtp.value) < 4 * sim.standardError, `${label}: MC ${sim.rtp} vs ${result.rtp.value} (se ${sim.standardError})`);
  }
});

test('caps: validation, and a cap that allows more than pF >= 1 would', () => {
  assert.throws(() => normalizeModel(withFs(TINY, { maxSpins: 2 })), /maxSpins/); // below the 3 awarded spins
  assert.throws(() => normalizeModel(withFs(TINY, { maxRetriggers: -1 })), /maxRetriggers/);
  assert.throws(() => normalizeModel(withFs(TINY, { maxSpins: 1.5 })), /maxSpins/);
  assert.throws(() => normalizeModel(withFs(TINY, { retrigger: false, maxSpins: 9 })), /retrigger/);
  // Models without caps normalize without the keys (identical objects as before).
  assert.ok(!('maxSpins' in normalizeModel(TINY).freeSpins));
  // 12 spins awarded per retrigger with P = 1/12: pF = 1, infinite without a cap.
  assert.throws(() => analyzeExact(normalizeModel(withFs(TINY, { spins: 12 }))), /infinite|لا نهائي/);
  // With a cap the expectation is finite (more than the 12 first spins).
  const capped = analyzeExact(normalizeModel(withFs(TINY, { spins: 12, maxRetriggers: 3 })));
  assert.ok(capped.freeSpins.expectedSpinsPerTrigger.value > 12 && Number.isFinite(capped.rtp.value));
  // cappedFeature's expected spins by hand for maxRetriggers = 1, F = 3, p = 1/12:
  // 3 spins, and if one of them retriggers (prob 1 - (11/12)^3) 3 more: 3 + 3 (1 - (11/12)^3).
  const c = cappedFeature({ spins: 3, retrigger: true, maxRetriggers: 1 }, { D: 12n, c1: 1n });
  assert.strictEqual(c.expectedSpins.toString(), new Fraction(3n).add(new Fraction(3n).mul(new Fraction(1n).sub(new Fraction(1331n, 1728n)))).toString());
});

// ---------- Desert Gold (the shipped sample) ----------

test('Desert Gold: checks, precision floor, Chernoff bounds and the grid guard', () => {
  const { model, spins, result } = analyze(sample('desert-gold.json'));
  const round = roundDistribution(model, spins, exactMomentsOf(result));
  for (const k of ['mass', 'mean', 'variance']) assert.ok(round.checks[k].relativeError <= 1e-9, k);
  assert.strictEqual(round.bounded, false);
  assert.strictEqual(round.maxWin.x, null);
  assert.ok(round.floor >= FLOOR_MIN);
  // No probability under the floor is shown as a value.
  for (const t of round.thresholds) {
    if (t.method === 'fft') assert.ok(t.value >= round.floor);
    if (t.method === 'bound') assert.ok(t.value === null && t.below <= round.floor);
  }
  // 100x: the base game alone reaches it (101.8x) and the feature often; 10000x is
  // past the grid: a bound only.
  assert.strictEqual(round.thresholds[0].method, 'fft');
  assert.strictEqual(round.thresholds[3].method, 'bound');
  // Every pmf cell is at or above the floor (or exact), and mass left out is tiny.
  for (const e of round.pmf.entries) assert.ok(e.count !== undefined || e.p >= round.floor);
  assert.ok(round.pmf.droppedMass < 1e-9);
  // A wrong closed form fails loudly.
  const wrong = { ...exactMomentsOf(result), rtp: exactMomentsOf(result).rtp.add(new Fraction(1n, 1000000n)) };
  assert.throws(() => roundDistribution(model, spins, wrong), /internal check failed: whole-round mean/);
  // Grid guard: a limit below what the tail needs is refused with a Monte Carlo hint.
  assert.throws(() => roundDistribution(model, spins, exactMomentsOf(result), { gridLimit: 2048 }), (e) => e.tooLarge && /Monte Carlo/.test(e.en));
  assert.strictEqual(GRID_LIMIT, 2 ** 21);
  // attachRoundDistribution keeps the RTP and reports the reason.
  const r2 = attachRoundDistribution(analyze(sample('desert-gold.json')).result, model, null);
  assert.strictEqual(r2.round, null);
});

test('Desert Gold without retrigger: exact probability of the largest win', () => {
  const raw = sample('desert-gold.json');
  raw.scatter.freeSpins.retrigger = false;
  const { model, spins, result } = analyze(raw);
  const round = roundDistribution(model, spins, exactMomentsOf(result));
  // By hand from the published spin pmf (scope baseSpin): the largest free spin is the
  // largest spin win, 2036 units (101.8x; count 4 of 61,709,340), times 3; the round's
  // largest win is the largest trigger-spin win plus 10 such spins.
  const pmf = result.distribution.pmf;
  const T = BigInt(pmf.total);
  const top = pmf.entries.reduce((a, e) => (e.units > a.units ? e : a));
  const trig = pmf.entries.filter((e) => e.trigger);
  const tmax = Math.max(...trig.map((e) => e.units));
  const cTrig = trig.filter((e) => e.units === tmax).reduce((a, e) => a + BigInt(e.count), 0n);
  const expected = new Fraction(cTrig, T).mul(new Fraction(BigInt(top.count) ** 10n, T ** 10n));
  assert.strictEqual(round.maxWin.x, (tmax + 10 * 3 * top.units) / 20);
  assert.strictEqual(round.maxWin.fraction, expected.toString());
  assert.strictEqual(round.maxWin.x, result.distribution.maxWin.withFeature);
});

test('weighted Desert Gold (BigInt weights): checks pass', () => {
  const { model, spins, result } = analyze(sample('desert-gold-weighted.json'));
  const round = roundDistribution(model, spins, exactMomentsOf(result));
  for (const k of ['mass', 'mean', 'variance']) assert.ok(round.checks[k].relativeError <= 1e-9, k);
});

test('no free spins: the round pmf is exact (European roulette)', () => {
  const { model, spins, result } = analyze(sample('roulette-european.json'));
  const round = roundDistribution(model, spins, exactMomentsOf(result));
  assert.strictEqual(round.exact, true);
  // Red pays 2 bets with probability 18/37, else 0.
  assert.deepStrictEqual(round.pmf.entries.map((e) => [e.x, e.count]), [[0, '19'], [2, '18']]);
  assert.strictEqual(round.pmf.total, '37');
  assert.strictEqual(round.thresholds[0].fraction, '0');
  assert.strictEqual(round.maxWin.fraction, '18/37');
  // Cap at 1x: E[min(W, 1)] = 18/37, so 18/37 is lost of the RTP 36/37.
  const c = capStats(round, 1, result.rtp.fraction);
  assert.strictEqual(c.rtpCapped.fraction, '18/37');
  assert.strictEqual(c.lost.fraction, '18/37');
  assert.strictEqual(c.reach.fraction, '18/37');
});

test('max-win cap and top-award odds checks (unverified rules)', () => {
  const { model, spins, result } = analyze(TINY);
  const round = roundDistribution(model, spins, exactMomentsOf(result));
  const ref = tinyRef().round;
  for (const M of [5, 20, 60]) {
    // E[(W - M)+] and P(W >= M) from the reference pmf.
    let excess = 0, reach = 0;
    for (const [t, p] of ref) if (t / 10 >= M) { excess += (t / 10 - M) * p; reach += p; }
    const c = capStats(round, M, result.rtp.fraction);
    // The pmf leaves out cells under the noise floor (the far tail): the value is a
    // lower estimate and `upper` adds what they can contribute; the truth is between.
    assert.ok(c.lost.value <= excess + 1e-14 && excess <= c.lost.upper + 1e-14, `M=${M}: lost ${c.lost.value} .. ${c.lost.upper} vs ${excess}`);
    assert.ok(Math.abs(c.lost.value - excess) <= 1e-8 && c.lost.upper - c.lost.value <= 1e-8, `M=${M}: lost close to ${excess}`);
    assert.ok(c.rtpCapped.lower <= result.rtp.value - excess + 1e-14 && result.rtp.value - excess <= c.rtpCapped.value + 1e-14, `M=${M}: capped RTP`);
    assert.ok(Math.abs(c.reach.value - reach) <= 1e-8 * reach, `M=${M}: reach ${c.reach.value} vs ${reach}`);
  }
  // GLI-19: at least 1 in 100,000,000. PA: odds of at most 50,000,000 to 1, i.e. a
  // probability of at least 1 / 50,000,001 (stricter). Boundaries by hand.
  const exactProb = (f) => ({ value: f.toNumber(), fraction: f.toString(), method: 'exact', below: null });
  const atPa = topAwardChecks(exactProb(new Fraction(1n, 50000001n)));
  assert.deepStrictEqual([atPa.gli19.pass, atPa.pa.pass], [true, true]);
  const pastPa = topAwardChecks(exactProb(new Fraction(1n, 50000002n)));
  assert.deepStrictEqual([pastPa.gli19.pass, pastPa.pa.pass], [true, false]);
  const atGli = topAwardChecks(exactProb(new Fraction(1n, 100000000n)));
  assert.deepStrictEqual([atGli.gli19.pass, atGli.pa.pass], [true, false]);
  // A value from the transform is compared as a number.
  const fromFft = topAwardChecks({ value: 3e-8, fraction: null, method: 'fft', below: null });
  assert.deepStrictEqual([fromFft.gli19.pass, fromFft.pa.pass], [true, true]);
  const below = topAwardChecks(exactProb(new Fraction(1n, 100000001n)));
  assert.deepStrictEqual([below.gli19.pass, below.pa.pass], [false, false]);
  assert.strictEqual(below.gli19.unverified, true);
  // A bound under both thresholds fails both; a bound above them decides nothing.
  const tiny = topAwardChecks({ value: null, fraction: null, method: 'bound', below: 1e-13 });
  assert.deepStrictEqual([tiny.gli19.pass, tiny.pa.pass], [false, false]);
  const loose = topAwardChecks({ value: null, fraction: null, method: 'bound', below: 1e-3 });
  assert.deepStrictEqual([loose.gli19.pass, loose.pa.pass], [null, null]);
});

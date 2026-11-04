// Ways / Megaways engine (P0-6). Every expected value below comes from a derivation
// that does not use lab/core/ways-exact.js:
//  * a brute force written in this file from the game rules: it enumerates every
//    (reel set, height and stop of each reel, top-reel stop) with its weight, builds
//    the board, pays it, and adds up exact fractions (RTP, E[W^2], hit frequency, the
//    whole win distribution, trigger probability);
//  * the sum of F independent free spins (E = F E[X], E2 = F E[X^2] + F(F-1) E[X]^2)
//    for free spins without retrigger;
//  * a worked example published in the Stake Engine math-sdk documentation (URL below);
//  * hand calculations, and digests produced by the code at the base commit 2659225
//    (before ways existed) for the bundled line samples.
import test from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import crypto from 'node:crypto';
import { normalizeModel, canonicalJson, isWaysModel, ModelError } from '../../lab/core/slot-model.js';
import { analyzeExact } from '../../lab/core/slot-exact.js';
import { waysBoardEvaluator } from '../../lab/core/ways-exact.js';
import { Fraction } from '../../lab/core/fraction.js';
import { simulate, generatorDescription, controlVariate } from '../../lab/core/montecarlo.js';
import { prngFromSeed, PRNG_DESCRIPTION_WAYS } from '../../lab/core/prng.js';
import { slotSampler } from '../../lab/core/casino.js';
import { oasisCaravanWays } from '../../lab/samples.js';

const clone = (x) => JSON.parse(JSON.stringify(x));
const sha256 = (t) => crypto.createHash('sha256').update(t).digest('hex');
function near(a, b, tol, msg) { assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b} (tol ${tol})`); }
const F = (s) => { const [n, d = '1'] = String(s).split('/'); return new Fraction(BigInt(n), BigInt(d)); };
const big = (v) => BigInt(v);

// ---------------- brute force (independent of the engine) ----------------
// The boards of one source of a raw ways model: [{ w: BigInt weight, cells: [[names] per reel] }].
function boards(raw, fsMode = false) {
  const f = fsMode ? raw.scatter.freeSpins : null;
  const pickSets = (o) => (o && o.reelSets ? o.reelSets : o && o.reels ? [{ weight: 1, reels: o.reels, weights: o.weights }] : null);
  const sets = (f && pickSets(f)) || pickSets(raw);
  const heightsRaw = f && f.heights !== undefined && f.heights !== null ? f.heights : raw.heights;
  const top = f && f.topReel !== undefined ? f.topReel : raw.topReel;
  const N = sets[0].reels.length;
  const fixed = (i) => (Array.isArray(raw.rows) ? raw.rows[i] : raw.rows);
  // Per reel: list of (weight, height, stop).
  const choices = (set, i) => {
    const strip = set.reels[i];
    const sw = (p) => big(set.weights && set.weights[i] ? set.weights[i][p] : 1);
    const h = heightsRaw ? heightsRaw[i] : null;
    const out = [];
    if (h === null || h === undefined || typeof h === 'number') {
      const rows = h ?? fixed(i);
      for (let p = 0; p < strip.length; p++) out.push({ w: sw(p), rows, p });
    } else if (Array.isArray(h)) {
      for (const o of h) for (let p = 0; p < strip.length; p++) out.push({ w: big(o.weight ?? 1) * sw(p), rows: o.rows, p });
    } else {
      h.joint.forEach((row, p) => row.forEach((w, j) => { if (big(w) > 0n) out.push({ w: big(w), rows: h.rows[j], p }); }));
    }
    return out.map((c) => ({ w: c.w, cells: Array.from({ length: c.rows }, (_, r) => strip[(c.p + r) % strip.length]) }));
  };
  const out = [];
  // Mixture: P(set r) = weight_r / sum, then each reel's choice by its own weight.
  const sumSets = sets.reduce((a, s) => a + big(s.weight), 0n);
  const perSet = sets.map((set) => {
    const ch = Array.from({ length: N }, (_, i) => choices(set, i));
    const tot = ch.reduce((a, c) => a * c.reduce((x, y) => x + y.w, 0n), 1n);
    return { set, ch, tot };
  });
  const tops = top ? top.reel.map((_, q) => ({ w: big(top.weights ? top.weights[q] : 1), extra: top.covers.map((_, m) => top.reel[(q + m) % top.reel.length]) })) : [{ w: 1n, extra: null }];
  const topTot = tops.reduce((a, t) => a + t.w, 0n);
  // Common denominator: P(set) x P(board | set) = (setW / sum) x (w / tot_set), written
  // over sum x (product of every set's tot) x (top total).
  const allTot = perSet.reduce((a, s) => a * s.tot, 1n);
  for (const { set, ch, tot } of perSet) {
    const scaleW = big(set.weight) * (allTot / tot); // P(set) * P(board | set) = setW/sum * w/tot
    const idx = new Array(N).fill(0);
    for (;;) {
      for (const t of tops) {
        let w = scaleW * t.w;
        const cells = ch.map((c, i) => { w *= c[idx[i]].w; return c[idx[i]].cells.slice(); });
        if (t.extra) top.covers.forEach((c, m) => cells[c - 1].push(t.extra[m]));
        out.push({ w, cells });
      }
      let k = 0;
      while (k < N && ++idx[k] === ch[k].length) { idx[k] = 0; k++; }
      if (k === N) break;
    }
  }
  return { list: out, total: sumSets * allTot * topTot };
}

// The win of one board in total bets, from the rules (README / slot-model.js comments).
function payBoard(raw, cells) {
  const wild = raw.wild ? (typeof raw.wild === 'string' ? raw.wild : raw.wild.symbol) : null;
  const scatter = raw.scatter ? raw.scatter.symbol : null;
  const ms = raw.multiplierSymbols || {};
  const baseOf = (x) => (ms[x] ? ms[x].symbol : x);
  const multOf = (x) => (ms[x] ? ms[x].multiplier : 1);
  const strategy = raw.multiplierStrategy || 'symbol';
  const betCost = raw.betCost || 1;
  const G = raw.globalMultiplier || 1;
  let win = new Fraction(0n);
  for (const [s, pays] of Object.entries(raw.paytable)) {
    if (s === wild || s === scatter) continue;
    let ways = 1n, msum = 0, k = 0;
    for (let i = 0; i < cells.length; i++) {
      const match = cells[i].filter((x) => baseOf(x) === s || baseOf(x) === wild);
      if (!match.length) break;
      if (i === 0 && raw.wildStartsWin === false && !cells[0].some((x) => baseOf(x) === s)) break;
      if (strategy === 'symbol') ways *= big(match.reduce((a, x) => a + multOf(x), 0));
      else ways *= big(match.length);
      if (strategy === 'board') msum += match.reduce((a, x) => a + (multOf(x) > 1 ? multOf(x) : 0), 0);
      k++;
    }
    if (!k) continue;
    const pay = Fraction.of(pays[k - 1] || 0);
    const mult = strategy === 'board' ? Math.max(1, msum) : strategy === 'global' ? G : 1;
    win = win.add(pay.mul(ways).mul(mult));
  }
  win = win.div(betCost); // coins -> total bets
  const sc = cells.flat().filter((x) => x === scatter).length;
  if (scatter && sc > 0 && raw.scatter.pays) {
    const p = raw.scatter.pays;
    win = win.add(Fraction.of(p[Math.min(sc, p.length) - 1] || 0));
  }
  return { win, sc };
}

// Exact moments and distribution of one source by enumeration.
function brute(raw, { fsMode = false, triggerCounts = true } = {}) {
  const { list, total } = boards(raw, fsMode);
  const fsr = raw.scatter && raw.scatter.freeSpins;
  const T = fsr ? fsr.trigger : Infinity;
  const dist = new Map(); // "win|trigger" -> weight
  let s1 = new Fraction(0n), s2 = new Fraction(0n), hit = 0n, pJ = 0n, sXJ = new Fraction(0n), max = new Fraction(0n);
  for (const b of list) {
    const { win, sc } = payBoard(raw, b.cells);
    const J = triggerCounts && sc >= T;
    const wf = new Fraction(b.w);
    s1 = s1.add(win.mul(wf)); s2 = s2.add(win.mul(win).mul(wf));
    if (win.cmp(0) > 0 || J) hit += b.w;
    if (J) { pJ += b.w; sXJ = sXJ.add(win.mul(wf)); }
    if (win.cmp(max) > 0) max = win;
    const key = win.toString() + '|' + (J ? 1 : 0);
    dist.set(key, (dist.get(key) || 0n) + b.w);
  }
  const tf = new Fraction(total);
  return {
    E: s1.div(tf), E2: s2.div(tf), hit: new Fraction(hit, total), pJ: new Fraction(pJ, total), EXJ: sXJ.div(tf), max,
    dist: [...dist].map(([k, w]) => [k, new Fraction(w, total).toString()]).sort(),
    boards: list.length,
  };
}

// The whole round without retrigger: base spin plus, on a trigger, F free spins x m.
function bruteRound(raw) {
  const f = raw.scatter && raw.scatter.freeSpins;
  const b = brute(raw, { triggerCounts: Boolean(f) });
  if (!f) return { rtp: b.E, variance: b.E2.sub(b.E.mul(b.E)), hit: b.hit, base: b };
  assert.ok(!f.retrigger, 'brute force covers free spins without retrigger');
  const x = brute(raw, { fsMode: true, triggerCounts: false });
  const m = Fraction.of(f.multiplier || 1), Fs = BigInt(f.spins);
  const EX = x.E.mul(m), EX2 = x.E2.mul(m).mul(m);
  const EFv = EX.mul(Fs), EFv2 = EX2.mul(Fs).add(EX.mul(EX).mul(Fs * (Fs - 1n)));
  const EW = b.E.add(b.pJ.mul(EFv));
  const EW2 = b.E2.add(b.EXJ.mul(EFv).mul(2n)).add(b.pJ.mul(EFv2));
  return { rtp: EW, variance: EW2.sub(EW.mul(EW)), hit: b.hit, base: b, fs: x };
}

// The engine's per-spin distribution in the brute force's form.
const enginePmf = (r) => r.distribution.pmf.entries
  .map((e) => [new Fraction(BigInt(e.units), BigInt(r.distribution.pmf.unitsPerBet)).toString() + '|' + (e.trigger ? 1 : 0), new Fraction(BigInt(e.count), BigInt(r.distribution.pmf.total)).toString()])
  .reduce((m, [k, p]) => m.set(k, (m.get(k) || new Fraction(0n)).add(F(p))), new Map());
const pmfList = (m) => [...m].map(([k, p]) => [k, p.toString()]).sort();

function assertMatches(r, b, what) {
  assert.strictEqual(r.rtp.fraction, b.rtp.toString(), what + ': RTP');
  assert.strictEqual(r.distribution.variance.fraction, b.variance.toString(), what + ': variance');
  assert.strictEqual(r.distribution.hitFrequency.fraction, b.hit.toString(), what + ': hit frequency');
}

// ---------------- models ----------------
// 4 reels, heights 1-3 drawn independently with weights, weighted stops on reel 2, a
// wild on reels 1 and 3, a scatter, a blank (Z) and a symbol that never pays (N).
const BASE = {
  name: 'ways brute force', evaluation: 'ways', betCost: 4,
  reels: [['A', 'W', 'B', 'S', 'C'], ['B', 'A', 'Z', 'C', 'A', 'S'], ['C', 'W', 'A', 'B', 'N'], ['A', 'C', 'B', 'S', 'Z']],
  weights: [null, [2, 1, 3, 1, 2, 1], null, null],
  heights: [
    [{ rows: 1, weight: 1 }, { rows: 2, weight: 2 }, { rows: 3, weight: 1 }],
    [{ rows: 2, weight: 3 }, { rows: 3, weight: 1 }],
    [{ rows: 1, weight: 1 }, { rows: 3, weight: 1 }],
    [{ rows: 1, weight: 2 }, { rows: 2, weight: 1 }, { rows: 3, weight: 1 }],
  ],
  paytable: { A: [0, 0.5, 2, 6], B: [0, 0, 1.5, 4], C: [0, 0.25, 1, 2.5], N: [0, 0, 0, 0] },
  wild: { symbol: 'W' },
  scatter: { symbol: 'S', pays: [0, 1, 5] },
};

test('brute force: 4 reels, weighted heights 1-3 and stops, wild: RTP, E[W^2], hit frequency and the whole distribution', () => {
  const r = analyzeExact(normalizeModel(BASE));
  const b = bruteRound(BASE);
  assertMatches(r, b, 'base');
  assert.deepStrictEqual(pmfList(enginePmf(r)), b.base.dist);
  assert.strictEqual(r.distribution.maxWin.base, b.base.max.toNumber());
  // The symbol RTPs add up to the ways part; the scatter table is the count distribution.
  let sum = new Fraction(0n);
  for (const s of r.symbols) sum = sum.add(F(s.rtp.fraction));
  assert.strictEqual(sum.toString(), r.contributions.lines.fraction);
  assert.strictEqual(F(r.contributions.lines.fraction).add(F(r.contributions.scatter.fraction)).toString(), r.rtp.fraction);
  assert.ok(b.base.boards > 5000, 'enumerated ' + b.base.boards);
  assert.strictEqual(r.model.evaluation, 'ways');
  assert.strictEqual(r.model.ways.base.maxWays, String(3 * 3 * 3 * 3));
});

test('brute force: per symbol and run length, probability and average ways', () => {
  const r = analyzeExact(normalizeModel(BASE));
  const { list, total } = boards(BASE);
  // Brute force of "A runs exactly k reels" and its ways.
  const runOf = (cells, s) => {
    let k = 0, ways = 1;
    for (const col of cells) { const c = col.filter((x) => x === s || x === 'W').length; if (!c) break; ways *= c; k++; }
    return { k, ways };
  };
  for (const s of ['A', 'C']) {
    const row = r.symbols.find((x) => x.symbol === s);
    for (const bc of row.byCount) {
      let p = 0n, w = 0n;
      for (const b of list) { const o = runOf(b.cells, s); if (o.k === bc.count) { p += b.w; w += b.w * BigInt(o.ways); } }
      assert.strictEqual(bc.probabilityPerLine.fraction, new Fraction(p, total).toString(), `${s} x${bc.count} probability`);
      assert.strictEqual(bc.averageWays.fraction, new Fraction(w, p).toString(), `${s} x${bc.count} ways`);
    }
  }
});

test('wild on reel 1: "wildStartsWin": false (Stake math-sdk ways.py) starts only symbols shown on reel 1', () => {
  const g = clone(BASE);
  g.wildStartsWin = false;
  const r = analyzeExact(normalizeModel(g));
  const b = bruteRound(g);
  assertMatches(r, b, 'wildStartsWin false');
  assert.deepStrictEqual(pmfList(enginePmf(r)), b.base.dist);
  // The convention matters here: reel 1 has a wild.
  assert.notStrictEqual(r.rtp.fraction, analyzeExact(normalizeModel(BASE)).rtp.fraction);
  // A board by hand: reel 1 = [W], reel 2 = [A, A], reel 3 = [A], reel 4 = [Z].
  // wildStartsWin true: A pays 2 coins x (1 x 2 x 1) ways = 4 coins; C: 1 x 0 -> no run;
  // B: 1 x 0 -> no. With 4 coins per spin: 1 total bet. false: nothing starts.
  for (const [startsWin, expected] of [[true, 4], [false, 0]]) {
    const m = normalizeModel({ ...clone(BASE), wildStartsWin: startsWin, scatter: undefined });
    const ev = waysBoardEvaluator(m);
    const id = (x) => m.symbols.indexOf(x);
    const cells = Int32Array.from([id('W'), 0, 0, id('A'), id('A'), 0, id('A'), 0, 0, id('Z'), 0, 0]);
    assert.strictEqual(ev(cells, Int32Array.from([1, 2, 1, 1]), 3).win, expected * m.scale);
  }
});

test('fixed rows (one height for all reels, and one per reel) equal brute force', () => {
  for (const rows of [2, [1, 3, 2, 2]]) {
    const g = clone(BASE);
    delete g.heights;
    g.rows = rows;
    const r = analyzeExact(normalizeModel(g));
    assertMatches(r, bruteRound(g), 'rows ' + JSON.stringify(rows));
  }
});

test('joint (stop, height) table: heights tied to the stop equal brute force', () => {
  const g = clone(BASE);
  g.weights = null;
  // Reel 2: the height depends on the stop; some (stop, height) pairs never show (0).
  g.heights[1] = { rows: [1, 2, 3], joint: [[1, 0, 2], [0, 3, 1], [2, 2, 0], [1, 1, 1], [0, 0, 4], [3, 0, 0]] };
  const r = analyzeExact(normalizeModel(g));
  const b = bruteRound(g);
  assertMatches(r, b, 'joint');
  assert.deepStrictEqual(pmfList(enginePmf(r)), b.base.dist);
  assert.strictEqual(r.model.ways.base.heights[1].joint, true);
});

test('top reel over reels 2-3 (weighted top stops): conditional enumeration equals brute force', () => {
  const g = clone(BASE);
  g.topReel = { reel: ['A', 'W', 'C', 'S', 'B', 'Z', 'A'], weights: [2, 1, 1, 1, 3, 1, 1], covers: [2, 3] };
  const r = analyzeExact(normalizeModel(g));
  const b = bruteRound(g);
  assertMatches(r, b, 'top reel');
  assert.deepStrictEqual(pmfList(enginePmf(r)), b.base.dist);
  // The top reel changes the game (its cells count for reels 2 and 3).
  assert.notStrictEqual(r.rtp.fraction, analyzeExact(normalizeModel(BASE)).rtp.fraction);
  assert.deepStrictEqual(r.model.ways.base.topReel, { stops: 7, covers: [2, 3], weighted: true });
  // Max ways: (3) x (3 + 1) x (3 + 1) x (3) = 144.
  assert.strictEqual(r.model.ways.base.maxWays, '144');
});

test('top reel over reels 2-4 of a 4-reel game with fixed heights equals brute force', () => {
  const g = clone(BASE);
  delete g.heights;
  g.rows = [2, 1, 2, 1];
  g.topReel = { reel: ['W', 'A', 'B', 'C', 'A'], covers: [2, 3, 4] };
  const r = analyzeExact(normalizeModel(g));
  const b = bruteRound(g);
  assertMatches(r, b, 'top reel 2-4');
  assert.deepStrictEqual(pmfList(enginePmf(r)), b.base.dist);
});

// Multiplier wilds (W2, W3) and a multiplied symbol (A5).
const MULT = (() => {
  const g = clone(BASE);
  g.reels = [['A', 'W2', 'B', 'S', 'C', 'A5'], ['B', 'A', 'W3', 'C', 'A', 'S'], ['C', 'W', 'A', 'B', 'W2'], ['A', 'C', 'B', 'S', 'W3']];
  g.weights = null;
  g.multiplierSymbols = { W2: { symbol: 'W', multiplier: 2 }, W3: { symbol: 'W', multiplier: 3 }, A5: { symbol: 'A', multiplier: 5 } };
  return g;
})();

for (const strategy of ['symbol', 'board', 'global']) {
  test(`multiplier strategy "${strategy}" equals brute force`, () => {
    const g = clone(MULT);
    g.multiplierStrategy = strategy;
    if (strategy === 'global') g.globalMultiplier = 3;
    const r = analyzeExact(normalizeModel(g));
    const b = bruteRound(g);
    assertMatches(r, b, strategy);
    assert.deepStrictEqual(pmfList(enginePmf(r)), b.base.dist);
    assert.strictEqual(r.model.ways.multiplierStrategy, strategy);
    // And with a top reel and the reel-1 rule of ways.py.
    g.topReel = { reel: ['W3', 'A', 'B', 'A5', 'C'], covers: [1, 2] };
    g.wildStartsWin = false;
    const r2 = analyzeExact(normalizeModel(g));
    assertMatches(r2, bruteRound(g), strategy + ' + top reel');
  });
}

test('multiplier strategies by hand on one board: symbol multiplies, board adds, global scales', () => {
  // Reel 1 = [A, W2], reel 2 = [A, W3], reel 3 = [B, C] (B and C pay nothing), betCost 1,
  // A pays 0.5 per way for 2 of a kind. A runs 2 reels. Every stop of these 2-stop
  // strips shows the same two cells, so the RTP is this board's win:
  //   symbol: ways = (1 + 2) x (1 + 3) = 12 -> 0.5 x 12 = 6;
  //   board:  ways = 2 x 2 = 4, multipliers added 2 + 3 = 5 -> 0.5 x 4 x 5 = 10;
  //   global (G = 3): ways = 4 -> 0.5 x 4 x 3 = 6.
  const raw = (strategy, extra = {}) => ({
    evaluation: 'ways', rows: 2, reels: [['A', 'W2'], ['A', 'W3'], ['B', 'C']], paytable: { A: [0, 0.5, 1] },
    wild: 'W', multiplierSymbols: { W2: { symbol: 'W', multiplier: 2 }, W3: { symbol: 'W', multiplier: 3 } }, multiplierStrategy: strategy, ...extra,
  });
  for (const [strategy, extra, expected] of [['symbol', {}, '6'], ['board', {}, '10'], ['global', { globalMultiplier: 3 }, '6']]) {
    assert.strictEqual(analyzeExact(normalizeModel(raw(strategy, extra))).rtp.fraction, expected, strategy);
  }
});

test('Stake Engine documentation example: H1 with a 3x multiplier on reel 3 gives (1)(2)(3) = 6 ways', () => {
  // https://github.com/StakeEngine/math-sdk/blob/main/docs/math_docs/source_section/ways_info.md
  // (commit 141b4e8, 2 Nov 2026): on the board
  //   L5 H1 L4 L4 L4
  //   L1 H4 L3 H2 L4
  //   H1 H1 H1 L3 H3
  // "If there is a multiplier value of, say 3x on the H1 symbol on reel 3, the total ways
  // for symbol H1 is (3,H1) pays: (1) * (2) * (3) = 6 ways". Each reel strip below is one
  // column (3 stops, 3 rows), so every stop shows the same cells and the RTP is the win of
  // this board: H1 3 of a kind pays 1 per way here, so 6.
  const raw = {
    name: 'math-sdk ways_info.md example', evaluation: 'ways', rows: 3,
    reels: [['L5', 'L1', 'H1'], ['H1', 'H4', 'H1'], ['L4', 'L3', 'H1x3'], ['L4', 'H2', 'L3'], ['L4', 'L4', 'H3']],
    paytable: { H1: [0, 0, 1, 2, 5] }, multiplierSymbols: { H1x3: { symbol: 'H1', multiplier: 3 } }, multiplierStrategy: 'symbol',
  };
  const r = analyzeExact(normalizeModel(raw));
  assert.strictEqual(r.rtp.fraction, '6');
  const h1 = r.symbols.find((s) => s.symbol === 'H1').byCount;
  assert.deepStrictEqual(h1.map((b) => [b.count, b.averageWays.fraction, b.probabilityPerLine.fraction]), [[3, '6', '1']]);
});

test('reel sets mix with their weights (base game) and equal brute force', () => {
  const g = clone(BASE);
  delete g.reels; delete g.weights;
  g.reelSets = [
    { weight: 3, reels: BASE.reels, weights: BASE.weights },
    { weight: 1, reels: [['A', 'A', 'W', 'S'], ['C', 'B', 'S'], ['A', 'B', 'C', 'W'], ['S', 'Z', 'A']] },
  ];
  const r = analyzeExact(normalizeModel(g));
  const b = bruteRound(g);
  assertMatches(r, b, 'reel sets');
  assert.deepStrictEqual(pmfList(enginePmf(r)), b.base.dist);
  assert.strictEqual(r.model.weighted, true);
});

test('free spins with ways: own reels, heights and no top reel (no retrigger) equal brute force', () => {
  const g = clone(BASE);
  g.topReel = { reel: ['A', 'W', 'C', 'B'], covers: [2, 3] };
  g.scatter.freeSpins = {
    trigger: 2, spins: 4, multiplier: 2.5, retrigger: false,
    reels: [['A', 'W', 'C', 'S'], ['B', 'A', 'W', 'S', 'C'], ['C', 'A', 'B'], ['A', 'W', 'B', 'S']],
    heights: [2, [{ rows: 1, weight: 1 }, { rows: 3, weight: 2 }], 2, 1],
    topReel: null,
  };
  const r = analyzeExact(normalizeModel(g));
  const b = bruteRound(g);
  assertMatches(r, b, 'free spins');
  assert.strictEqual(r.freeSpins.triggerProbability.fraction, b.base.pJ.toString());
  assert.strictEqual(r.model.ways.freeSpins.topReel, null);
  assert.ok(F(r.contributions.freeSpins.fraction).cmp(0) > 0);
  // The paid spin's own distribution (scope baseSpin: trigger spins marked).
  assert.strictEqual(r.distribution.pmf.scope, 'baseSpin');
  assert.deepStrictEqual(pmfList(enginePmf(r)), b.base.dist);
});

test('free spins with taller windows: scatter counts only free spins can reach keep their own pay', () => {
  // Base windows of 1 row (at most 4 scatters); free spins of 3 rows (up to 12). A pay for
  // 6 or more scatters exists only in free spins.
  const g = clone(BASE);
  delete g.heights;
  g.rows = 1;
  g.scatter = { symbol: 'S', pays: [0, 1, 2, 3, 4, 50], freeSpins: { trigger: 2, spins: 2, multiplier: 1, retrigger: false, heights: [3, 3, 3, 3], reels: [['S', 'A', 'S', 'W'], ['S', 'B', 'S'], ['S', 'S', 'C', 'A'], ['S', 'A', 'S', 'B']] } };
  const r = analyzeExact(normalizeModel(g));
  assertMatches(r, bruteRound(g), 'tall free-spin windows');
});

test('free spins on the base reels with the same top reel (no retrigger) equal brute force', () => {
  const g = clone(BASE);
  g.topReel = { reel: ['A', 'W', 'S', 'B'], covers: [3, 4] };
  g.scatter.freeSpins = { trigger: 2, spins: 3, multiplier: 2, retrigger: false };
  const r = analyzeExact(normalizeModel(g));
  assertMatches(r, bruteRound(g), 'free spins, same reels');
});

test('retrigger: expected spins F / (1 - pF) from the brute-force retrigger probability; closed form = distribution path', () => {
  const g = clone(BASE);
  g.scatter.freeSpins = { trigger: 2, spins: 3, multiplier: 2, retrigger: true, heights: [1, 2, 1, 1] };
  const r = analyzeExact(normalizeModel(g));
  const x = brute(g, { fsMode: true, triggerCounts: true });
  assert.strictEqual(r.freeSpins.retriggerProbability.fraction, x.pJ.toString());
  const expected = new Fraction(3n).div(new Fraction(1n).sub(x.pJ.mul(3n)));
  assert.strictEqual(r.freeSpins.expectedSpinsPerTrigger.fraction, expected.toString());
  // RTP by hand from the brute-force moments: E[base] + P(trigger) x expected spins x m x E[free spin].
  const b = brute(g);
  assert.strictEqual(r.rtp.fraction, b.E.add(b.pJ.mul(expected).mul(2n).mul(x.E)).toString());
  // A state limit of 1 forces the closed-form path: same hit frequency and variance.
  const c = analyzeExact(normalizeModel(g), { maxStates: 1 });
  assert.strictEqual(c.distribution.closedForm, true);
  assert.strictEqual(c.distribution.variance.fraction, r.distribution.variance.fraction);
  assert.strictEqual(c.distribution.hitFrequency.fraction, r.distribution.hitFrequency.fraction);
  assert.ok(c.distributionError && /Monte Carlo/.test(c.distributionError.en) && /مونت كارلو/.test(c.distributionError.ar));
  assert.strictEqual(c.distribution.pmf, null);
  assert.strictEqual(c.distribution.maxWin, null);
});

test('too large for the distribution: RTP, variance and hit frequency stay exact (closed form vs brute force)', () => {
  for (const g of [clone(MULT), { ...clone(MULT), multiplierStrategy: 'board', topReel: { reel: ['W3', 'A', 'B'], covers: [2, 3] } }]) {
    const r = analyzeExact(normalizeModel(g), { maxStates: 2 });
    assert.strictEqual(r.distribution.closedForm, true);
    assertMatches(r, bruteRound(g), 'closed form ' + (g.multiplierStrategy || 'symbol'));
  }
});

test('more than 16 paying symbols: hit frequency from the distribution, or unavailable (never guessed)', () => {
  // 17 paying symbols on 3 reels of one row: the bit-mask DP is not used.
  const names = Array.from({ length: 17 }, (_, i) => 'S' + i);
  const raw = { evaluation: 'ways', rows: 1, reels: [names, names.slice().reverse(), names.slice(3).concat(names.slice(0, 3))], paytable: Object.fromEntries(names.map((n, i) => [n, [0, 0, 1 + i]])) };
  const r = analyzeExact(normalizeModel(raw));
  assert.strictEqual(r.model.ways.hitDp, false);
  const b = bruteRound(raw);
  assertMatches(r, b, '17 symbols');
  const c = analyzeExact(normalizeModel(raw), { maxStates: 1 });
  assert.strictEqual(c.distribution.hitFrequency, null);
  assert.strictEqual(c.distribution.variance.fraction, b.variance.toString());
});

test('cascades: the result is labelled first drop only, and its pmf is withheld from round-level tests', () => {
  const g = clone(BASE);
  g.cascades = true;
  const r = analyzeExact(normalizeModel(g));
  assert.strictEqual(r.scope, 'firstDrop');
  assert.strictEqual(r.model.ways.cascades, true);
  // The numbers are those of the first drop (the same game without cascades).
  assert.strictEqual(r.rtp.fraction, bruteRound(BASE).rtp.toString());
  assert.strictEqual(r.distribution.pmf, null);
  assert.strictEqual(analyzeExact(normalizeModel(BASE)).scope, undefined);
  // A line game may declare cascades too: same label.
  const lines = JSON.parse(fs.readFileSync(new URL('../../lab/samples/desert-gold.json', import.meta.url), 'utf8'));
  const rl = analyzeExact(normalizeModel({ ...lines, cascades: true }));
  assert.strictEqual(rl.scope, 'firstDrop');
  assert.strictEqual(rl.rtp.fraction, analyzeExact(normalizeModel(lines)).rtp.fraction);
  assert.throws(() => normalizeModel({ ...lines, cascades: 'yes' }), (e) => e instanceof ModelError && /cascades/.test(e.en));
});

test('bet units: betCost coins per spin; pays per way in coins, scatter pays x total bet', () => {
  // One reel set, 2 reels of one stop each and 1 row: A A always shows. Pay 3 coins per
  // way for 2 A; betCost 20 -> 3 / 20 = 0.15 total bets. Scatter-free.
  const r = analyzeExact(normalizeModel({ evaluation: 'ways', rows: 1, betCost: 20, reels: [['A'], ['A']], paytable: { A: [0, 3] } }));
  assert.strictEqual(r.rtp.fraction, '3/20');
  // A scatter on a third reel pays 2 x total bet whatever betCost is.
  const r2 = analyzeExact(normalizeModel({ evaluation: 'ways', rows: 1, betCost: 20, reels: [['A'], ['A'], ['S']], paytable: { A: [0, 3] }, scatter: { symbol: 'S', pays: [2] } }));
  assert.strictEqual(r2.rtp.fraction, F('3/20').add(2).toString());
  assert.strictEqual(normalizeModel({ evaluation: 'ways', rows: 1, betCost: 20, reels: [['A'], ['A']], paytable: { A: [0, 0.25] } }).totalBetUnits, 20 * 100);
});

test('invalid ways models are rejected with a message in both languages', () => {
  const bad = [
    { ...clone(BASE), evaluation: 'cluster' },
    { ...clone(BASE), heights: undefined, rows: undefined },
    { ...clone(BASE), heights: [[{ rows: 0, weight: 1 }], null, null, null], rows: 2 },
    { ...clone(BASE), heights: [[{ rows: 2, weight: 1 }, { rows: 2, weight: 3 }], 1, 1, 1] },
    { ...clone(BASE), wild: { symbol: 'W', pays: [0, 0, 5, 10] } },
    { ...clone(BASE), multiplierStrategy: 'sum' },
    { ...clone(BASE), globalMultiplier: 2 },
    { ...clone(BASE), wildStartsWin: 'no' },
    { ...clone(BASE), topReel: { reel: ['A'], covers: [3, 2] } },
    { ...clone(BASE), topReel: { reel: ['A'], covers: [5] } },
    { ...clone(BASE), multiplierSymbols: { W2: { symbol: 'S', multiplier: 2 } } },
    { ...clone(BASE), multiplierSymbols: { A: { symbol: 'W', multiplier: 2 } } },
    { ...clone(BASE), heights: [{ rows: [1, 2], joint: [[1, 1]] }, 1, 1, 1] },
    { ...clone(BASE), heights: [1, { rows: [1, 2], joint: BASE.reels[1].map(() => [1, 1]) }, 1, 1] }, // reel 2 has stop weights
    { ...clone(BASE), betCost: 0 },
    // A joint table belongs to the base strips: free spins with other reels need their own heights.
    { ...clone(BASE), weights: null, heights: [1, { rows: [1, 2], joint: BASE.reels[1].map(() => [1, 1]) }, 1, 1], scatter: { symbol: 'S', freeSpins: { trigger: 2, spins: 3, reels: BASE.reels } } },
    { evaluation: 'ways', rows: 10, reels: Array.from({ length: 8 }, () => ['A', 'W3']), paytable: { A: [0, 0, 0, 0, 0, 0, 0, 1e9] }, wild: 'W', multiplierSymbols: { W3: { symbol: 'W', multiplier: 1000 } } },
  ];
  for (const raw of bad) {
    assert.throws(() => normalizeModel(raw), (e) => e instanceof ModelError && e.ar && e.en && e.ar !== e.en, JSON.stringify(raw).slice(0, 120));
  }
  assert.ok(isWaysModel(BASE) && !isWaysModel({ rows: 3 }));
});

// ---------------- line models are unchanged ----------------
test('bundled line samples: analyses identical to the base commit (before ways existed)', () => {
  // SHA-256 of canonicalJson(analyzeExact(normalizeModel(sample))), obtained by running
  // lab/core/*.js at commit 2659225 on the same files.
  const pins = {
    'desert-gold.json': '78952f3f8b309fe78cfef24243713831a2a1c22fda666c2353442e8236ff14dd',
    'desert-gold-weighted.json': '8418c559ff8d8503ab838bff863053d6ffcf1b3ffa1d8a8614a04b710425d825',
    'roulette-european.json': '1dc0bb9d416f8255952eb3c93a49a207f4b77f805d95291283a1905f1855536a',
    'roulette-american.json': '9ef1022691abad7c128040e49540055bf051824c76461b67e5a4cc3468e62403',
  };
  for (const [file, sha] of Object.entries(pins)) {
    const raw = JSON.parse(fs.readFileSync(new URL('../../lab/samples/' + file, import.meta.url), 'utf8'));
    const r = analyzeExact(normalizeModel(raw));
    assert.strictEqual(crypto.createHash('sha256').update(canonicalJson(r)).digest('hex'), sha, file);
  }
});

test('bundled line samples: Monte Carlo fingerprints identical to the base commit', async () => {
  // resultSha256 as the worker computes it (seed "pin", 20,000 rounds), obtained by
  // running lab/core/*.js at commit 2659225 on the same files.
  const pins = {
    'desert-gold.json': '554fce83c044ff344544c218c4bb39617e2f1142daf5251e0642ff6111aa43f1',
    'desert-gold-weighted.json': '6c776fdf7db2eaeb0b50ed2e0ca0418da9b22aab732992f69280577c673b2170',
    'roulette-european.json': 'f6f86e98858d63299097c1884eb13a3975463fb22aeffbfbb017e06ff43f6d17',
    'roulette-american.json': 'df246726f4b208f2bfff5526d3a81798f04290b66bcc49673c0ba8e9378e9206',
  };
  for (const [file, pin] of Object.entries(pins)) {
    const raw = JSON.parse(fs.readFileSync(new URL('../../lab/samples/' + file, import.meta.url), 'utf8'));
    const model = normalizeModel(raw);
    const run = { modelSha256: sha256(canonicalJson(raw)), seed: 'pin', spins: 20000, generator: generatorDescription(model), result: simulate(model, await prngFromSeed('pin'), 20000) };
    assert.strictEqual(sha256(canonicalJson(run)), pin, file);
  }
});

// ---------------- Monte Carlo ----------------
test('the simulator pays every board as the brute-force rules do (each strategy, both reel-1 rules)', () => {
  for (const strategy of ['symbol', 'board', 'global']) {
    for (const wildStartsWin of [true, false]) {
      const g = { ...clone(MULT), multiplierStrategy: strategy, wildStartsWin, ...(strategy === 'global' ? { globalMultiplier: 2 } : {}) };
      const m = normalizeModel(g);
      const ev = waysBoardEvaluator(m);
      const cells = new Int32Array(4 * 12), lens = new Int32Array(4);
      let n = 0;
      for (const b of boards(g).list) {
        if (n++ % 7) continue; // a seventh of the boards keeps this quick
        b.cells.forEach((col, i) => { col.forEach((x, r) => { cells[i * 12 + r] = m.symbols.indexOf(x); }); lens[i] = col.length; });
        const got = ev(cells, lens, 12);
        const want = payBoard(g, b.cells);
        assert.strictEqual(new Fraction(BigInt(got.win), BigInt(m.totalBetUnits)).toString(), want.win.toString(), strategy + ' ' + JSON.stringify(b.cells));
        assert.strictEqual(got.scatters, want.sc);
      }
    }
  }
});

test('Monte Carlo of small ways models (joint heights, top reel, reel sets, multipliers) agrees with the exact engine', async () => {
  const joint = clone(BASE);
  joint.weights = null;
  joint.heights[1] = { rows: [1, 2, 3], joint: [[1, 0, 2], [0, 3, 1], [2, 2, 0], [1, 1, 1], [0, 0, 4], [3, 0, 0]] };
  joint.topReel = { reel: ['A', 'W', 'C', 'S', 'B', 'Z', 'A'], weights: [2, 1, 1, 1, 3, 1, 1], covers: [2, 3] };
  const sets = clone(BASE);
  delete sets.reels; delete sets.weights;
  sets.reelSets = [{ weight: 3, reels: BASE.reels, weights: BASE.weights }, { weight: 1, reels: [['A', 'A', 'W', 'S'], ['C', 'B', 'S'], ['A', 'B', 'C', 'W'], ['S', 'Z', 'A']] }];
  const board = { ...clone(MULT), multiplierStrategy: 'board', topReel: { reel: ['W3', 'A', 'B', 'A5', 'C'], covers: [1, 2] } };
  const fsModel = clone(BASE);
  fsModel.scatter.freeSpins = { trigger: 2, spins: 3, multiplier: 2, retrigger: true, heights: [1, 2, 1, 1] };
  for (const [name, raw] of Object.entries({ joint, sets, board, fsModel })) {
    const m = normalizeModel(raw);
    const exact = analyzeExact(m);
    const n = 200000;
    const sim = simulate(m, await prngFromSeed('ways-small-' + name), n);
    near(sim.rtp, exact.rtp.value, 4 * exact.distribution.sd / Math.sqrt(n), name + ' RTP');
    const h = exact.distribution.hitFrequency.value;
    near(sim.hitFrequency, h, 4 * Math.sqrt(h * (1 - h) / n), name + ' hit frequency');
  }
});

test('Monte Carlo of the ways sample (6 reels, heights 2-7, top reel over reels 2-5) agrees with the exact RTP within 4 standard errors', async () => {
  const m = normalizeModel(oasisCaravanWays);
  const exact = analyzeExact(m);
  // The exact figures do not need the full distribution (too large here): closed form.
  assert.strictEqual(exact.distribution.closedForm, true);
  assert.ok(exact.distributionError);
  const n = 1000000;
  const sim = simulate(m, await prngFromSeed('ways-sample'), n);
  near(sim.rtp, exact.rtp.value, 4 * exact.distribution.sd / Math.sqrt(n), 'RTP');
  const h = exact.distribution.hitFrequency.value;
  near(sim.hitFrequency, h, 4 * Math.sqrt(h * (1 - h) / n), 'hit frequency');
  near(sim.sd, exact.distribution.sd, 0.1 * exact.distribution.sd, 'sd');
  // The paid spin's own win, with its exact mean, as a control variate: also within 4
  // of its standard error, which is smaller than the plain one.
  const mu = exact.controlVariate.mean;
  assert.strictEqual(mu.fraction, F(exact.contributions.lines.fraction).add(F(exact.contributions.scatter.fraction)).toString());
  const cv = controlVariate(sim, mu.value, m.totalBetUnits);
  near(cv.rtp, exact.rtp.value, 4 * cv.standardError, 'control-variate RTP');
  assert.ok(cv.standardError < sim.standardError, 'variance reduced');
  near(cv.paidSpinMean, mu.value, 4 * 3 / Math.sqrt(n), 'paid spin mean');
  assert.strictEqual(sim.scope, 'round');
  // The casino page's sampler draws the same game.
  const draw = slotSampler(m);
  const rng = await prngFromSeed('ways-sampler');
  let sum = 0;
  for (let i = 0; i < 300000; i++) sum += draw(rng);
  near(sum / 300000, exact.rtp.value, 4 * exact.distribution.sd / Math.sqrt(300000), 'casino sampler');
});

test('Monte Carlo of a ways model: same seed, same run; the generator text states the ways draw', async () => {
  const m = normalizeModel(oasisCaravanWays);
  assert.strictEqual(generatorDescription(m), PRNG_DESCRIPTION_WAYS);
  assert.ok(/window height/.test(PRNG_DESCRIPTION_WAYS) && /top reel/.test(PRNG_DESCRIPTION_WAYS));
  const a = simulate(m, await prngFromSeed('again'), 20000);
  const b = simulate(m, await prngFromSeed('again'), 20000);
  assert.deepStrictEqual(a, b);
  const c = simulate(normalizeModel({ ...clone(oasisCaravanWays), cascades: true }), await prngFromSeed('again'), 20000);
  assert.strictEqual(c.scope, 'firstDrop');
  assert.strictEqual(c.rtp, a.rtp, 'first drop only: the same spins');
  // A line game that declares cascades is labelled too; without the flag nothing changes.
  const dg = JSON.parse(fs.readFileSync(new URL('../../lab/samples/desert-gold.json', import.meta.url), 'utf8'));
  const lc = simulate(normalizeModel({ ...dg, cascades: true }), await prngFromSeed('again'), 2000);
  const lp = simulate(normalizeModel(dg), await prngFromSeed('again'), 2000);
  assert.strictEqual(lc.scope, 'firstDrop');
  assert.strictEqual(lp.scope, undefined);
  assert.strictEqual(lc.rtp, lp.rtp);
});

test('control variate estimate checked by hand', () => {
  // Four rounds, units per bet 10: X = 0, 10, 20, 10 and Y = 0, 10, 50, 10, muX = 1.25.
  // mean X = 1, mean Y = 1.75, Var X = 1.5 - 1 = 0.5, Cov = 3 - 1.75 = 1.25, beta = 2.5,
  // Y_cv = 1.75 - 2.5 (1 - 1.25) = 2.375; Var Y = 6.75 - 1.75^2 = 3.6875,
  // Var Y - Cov^2 / Var X = 0.5625, SE = sqrt(0.5625 / 3) = 0.4330127.
  const sim = { spins: 4, totalWinUnits: 70, sd: Math.sqrt(3.6875 * 4 / 3) * 1, paidSpin: { total: 40, sumSq: 600, crossSum: 1200 } };
  const cv = controlVariate(sim, 1.25, 10);
  near(cv.rtp, 2.375, 1e-12, 'estimate');
  near(cv.beta, 2.5, 1e-12, 'beta');
  near(cv.standardError, Math.sqrt(0.1875), 1e-12, 'standard error');
  assert.strictEqual(controlVariate({ spins: 4, totalWinUnits: 0, sd: 0 }, 1, 10), null, 'no paid-spin sums (line game)');
});

// The sample's RTP computed directly from the research formula, independently of the
// engine: for each top-reel stop, per symbol and reel the expected matching cells and the
// chance of none (every height x stop window, with the top cell on reels 2-5), then
// sum_k pay(k) prod_{i<k} E[c_i] P(c_k = 0); the scatter count by convolution (the top
// reel has no scatter); free spins on the same reels with retrigger: F / (1 - pF) spins.
function sampleRtpByHand(raw) {
  const N = raw.reels.length, wild = raw.wild.symbol, S = raw.scatter.symbol;
  const top = raw.topReel.reel, covers = raw.topReel.covers.map((c) => c - 1);
  const windowsOf = (i) => raw.heights[i].flatMap((h) => raw.reels[i].map((_, p) => ({ w: BigInt(h.weight), cells: Array.from({ length: h.rows }, (_, r) => raw.reels[i][(p + r) % raw.reels[i].length]) })));
  const wins = Array.from({ length: N }, (_, i) => windowsOf(i));
  let waysSum = new Fraction(0n);
  for (let q = 0; q < top.length; q++) {
    for (const [s, pays] of Object.entries(raw.paytable)) {
      const Ec = [], P0 = [];
      for (let i = 0; i < N; i++) {
        const m = covers.indexOf(i);
        const extra = m >= 0 ? top[(q + m) % top.length] : null;
        let tot = 0n, c = 0n, z = 0n;
        for (const w of wins[i]) {
          const n = BigInt(w.cells.filter((x) => x === s || x === wild).length + (extra === s || extra === wild ? 1 : 0));
          tot += w.w; c += w.w * n; if (n === 0n) z += w.w;
        }
        Ec.push(new Fraction(c, tot)); P0.push(new Fraction(z, tot));
      }
      let prod = new Fraction(1n);
      for (let k = 1; k <= N; k++) {
        prod = prod.mul(Ec[k - 1]);
        const tail = k < N ? P0[k] : new Fraction(1n);
        waysSum = waysSum.add(Fraction.of(pays[k - 1] || 0).mul(prod).mul(tail));
      }
    }
  }
  const ways = waysSum.div(BigInt(top.length)).div(BigInt(raw.betCost));
  let dist = [new Fraction(1n)];
  for (let i = 0; i < N; i++) {
    const local = [];
    let tot = 0n;
    for (const w of wins[i]) { const c = w.cells.filter((x) => x === S).length; local[c] = (local[c] || 0n) + w.w; tot += w.w; }
    const next = [];
    dist.forEach((a, x) => local.forEach((b, y) => { if (b !== undefined) next[x + y] = (next[x + y] || new Fraction(0n)).add(a.mul(new Fraction(b, tot))); }));
    dist = next;
  }
  const sp = raw.scatter.pays, f = raw.scatter.freeSpins;
  let scat = new Fraction(0n), pT = new Fraction(0n);
  dist.forEach((p, c) => {
    if (!p || c === 0) return;
    scat = scat.add(p.mul(Fraction.of(sp[Math.min(c, sp.length) - 1] || 0)));
    if (c >= f.trigger) pT = pT.add(p);
  });
  const spin = ways.add(scat);
  const spins = new Fraction(BigInt(f.spins)).div(new Fraction(1n).sub(pT.mul(BigInt(f.spins))));
  return spin.add(pT.mul(spins).mul(Fraction.of(f.multiplier)).mul(spin));
}

test('the ways sample: exact RTP equals the direct per-symbol computation; max ways 200,704', () => {
  const r = analyzeExact(normalizeModel(oasisCaravanWays));
  assert.strictEqual(r.rtp.fraction, sampleRtpByHand(oasisCaravanWays).toString());
  assert.strictEqual(r.rtp.percent, '95.901366'); // the same fraction, as the page shows it
  assert.strictEqual(r.model.ways.base.maxWays, String(7 * 8 ** 4 * 7));
  assert.strictEqual(r.model.ways.base.minWays, String(2 * 3 ** 4 * 2));
  assert.deepStrictEqual(r.model.ways.base.topReel, { stops: oasisCaravanWays.topReel.reel.length, covers: [2, 3, 4, 5], weighted: false });
  assert.deepStrictEqual(r.model.ways.base.heights[0].probabilities, ['6.666667', '20.000000', '26.666667', '26.666667', '13.333333', '6.666667']);
  assert.strictEqual(r.distribution.closedForm, true);
  assert.ok(r.distribution.hitFrequency.value > 0.5);
  const json = JSON.parse(fs.readFileSync(new URL('../../lab/samples/oasis-caravan-ways.json', import.meta.url), 'utf8'));
  assert.deepStrictEqual(json, oasisCaravanWays, 'lab/samples.js matches the JSON (scripts/make-lab-samples.mjs)');
});

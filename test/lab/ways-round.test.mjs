// Ways models (P0-6) with the whole-round distribution, max-win cap and session funnel
// (P0-8). Every expected number comes from an independent derivation in this file:
//  * the spin distributions by brute-force enumeration of every board (each reel's
//    (height, stop) window, evaluated by the README's ways rule written out here:
//    a symbol pays pay[k] x ways when it or the wild shows on reels 1..k, ways = product
//    of the matching cells, longest run only; the scatter pays x total bet by count);
//  * the round pmf with uncapped retriggers from feature trees cut at depth n, by direct
//    sparse convolution on the coin lattice (phi_n = A + B * phi_{n-1}^F, phi_0 = A);
//    every cut only drops non-negative terms, so brute[x] <= true[x] <= brute[x] + cut,
//    with cut <= P(trigger) * F0 * b (F b)^n (b = P(retrigger), since the depth-n
//    missing mass u_n = b (1 - (1 - u_{n-1})^F) <= F b u_{n-1}, u_0 = b) plus the
//    mass every convolution drops past the lattice bound D (a drop of mass d at any
//    step lowers the final round's mass by at most d: later steps scale a loss by
//    F b < 1 per level and F0 P(trigger) < 1 at the end, every mass being <= 1);
//  * with free-spin caps, by an exact walk over (spins left, spins awarded,
//    retriggers) in floating point for the pmf, and in exact fractions (a memoised
//    recursion, not the engine's state sweep) for the RTP and the variance.
import test from 'node:test';
import assert from 'node:assert';
import { normalizeModel, canonicalJson } from '../../lab/core/slot-model.js';
import { analyzeExact } from '../../lab/core/slot-exact.js';
import { attachRoundDistribution, capStats } from '../../lab/core/round-dist.js';
import { sessionFunnel } from '../../lab/core/session.js';
import { pmfFromExact, auditDistribution } from '../../lab/core/audit-stats.js';
import { parsePlayLog } from '../../lab/core/actual.js';
import { simulate } from '../../lab/core/montecarlo.js';
import { prngFromSeed } from '../../lab/core/prng.js';
import { Fraction } from '../../lab/core/fraction.js';
import { oasisCaravanWays } from '../../lab/samples.js';
import nodeCrypto from 'node:crypto';
import { buildReport, reportPayload } from '../../lab/report.js';
import { generateKeyPair, ED25519 } from '../../lab/core/sign.js';
import { verifyReportPdf } from '../../lab/core/report-sign.js';
import { readPdfAttachments } from '../../lab/core/pdf-read.js';
import { pair } from '../../lab/i18n.js';
import { MINI, spinTable, conv, bruteRoundUncapped } from '../helpers/ways-brute.mjs';

const clone = (v) => JSON.parse(JSON.stringify(v));
const fracOf = (s) => { const [n, d] = String(s).split('/'); return new Fraction(BigInt(n), BigInt(d || '1')); };

// Capped feature: (spins left, awarded, retriggers) walked exactly. Returns the round
// pmf (float, coins) and the exact RTP and variance (Fractions, in bets).
function bruteRoundCapped(raw) {
  const fs = raw.scatter.freeSpins, m = BigInt(fs.multiplier);
  const S = fs.maxSpins ?? Infinity, R = fs.maxRetriggers ?? Infinity, F = fs.spins;
  const base = spinTable(raw, raw.heights), free = spinTable(raw, fs.heights || raw.heights);
  const step = (st, retrig) => {
    const [r, t, k] = st;
    if (retrig && k < R && t < S) { const add = Math.min(F, S - t); return [r - 1 + add, t + add, k + 1]; }
    return [r - 1, t, k];
  };
  // Exact first and second moments of the rest of the feature from a state.
  const memo = new Map();
  const D = free.total;
  const moments = (st) => {
    if (st[0] === 0) return [new Fraction(0n), new Fraction(0n)];
    const key = st.join(',');
    if (memo.has(key)) return memo.get(key);
    let v1 = new Fraction(0n), v2 = new Fraction(0n);
    for (const c of free.cells) {
      const p = new Fraction(c.w, D), w = BigInt(c.coins) * m;
      const [n1, n2] = moments(step(st, c.scat >= fs.trigger));
      v1 = v1.add(p.mul(n1.add(w)));
      v2 = v2.add(p.mul(n2.add(n1.mul(2n * w)).add(w * w)));
    }
    const out = [v1, v2];
    memo.set(key, out);
    return out;
  };
  const start = [F, F, 0];
  const [f1, f2] = moments(start);
  let e1 = new Fraction(0n), e2 = new Fraction(0n);
  for (const c of base.cells) {
    const p = new Fraction(c.w, base.total), b = BigInt(c.coins);
    if (c.scat >= fs.trigger) {
      e1 = e1.add(p.mul(f1.add(b)));
      e2 = e2.add(p.mul(f2.add(f1.mul(2n * b)).add(b * b)));
    } else {
      e1 = e1.add(p.mul(b));
      e2 = e2.add(p.mul(b * b));
    }
  }
  const bet = BigInt(raw.betCost);
  const rtp = e1.div(bet), variance = e2.sub(e1.mul(e1)).div(bet * bet);
  // Float pmf of the feature total by the same walk.
  let states = new Map([[start.join(','), new Map([[0, 1]])]]);
  const feature = new Map();
  while (states.size) {
    const next = new Map();
    for (const [key, dist] of states) {
      const st = key.split(',').map(Number);
      for (const c of free.cells) {
        const p = Number(c.w) / Number(D), w = c.coins * fs.multiplier;
        const ns = step(st, c.scat >= fs.trigger);
        const target = ns[0] === 0 ? feature : (next.get(ns.join(',')) || next.set(ns.join(','), new Map()).get(ns.join(',')));
        for (const [x, q] of dist) target.set(x + w, (target.get(x + w) || 0) + q * p);
      }
    }
    states = next;
  }
  const round = new Map();
  for (const c of base.cells) {
    const p = Number(c.w) / Number(base.total);
    if (c.scat >= fs.trigger) for (const [x, q] of feature) round.set(x + c.coins, (round.get(x + c.coins) || 0) + p * q);
    else round.set(c.coins, (round.get(c.coins) || 0) + p);
  }
  return { round, rtp, variance };
}

function analyze(raw, opts = {}) {
  const model = normalizeModel(raw);
  let spins = null;
  const result = analyzeExact(model, { ...opts, onEntries: (e) => { spins = e; } });
  attachRoundDistribution(result, model, spins);
  return { model, spins, result };
}
// The engine's round pmf as coins -> probability (the exact and transform cells of
// one win added up).
function pmfCoins(round, betCost) {
  const got = new Map();
  for (const e of round.pmf.entries) {
    const k = Math.round(e.x * betCost);
    assert.ok(Math.abs(k - e.x * betCost) < 1e-9, 'every cell is a whole number of coins');
    got.set(k, (got.get(k) || 0) + e.p);
  }
  return got;
}

test('ways + uncapped retrigger: the whole-round pmf matches truncated feature trees to 1e-9', () => {
  const { model, result } = analyze(MINI);
  assert.strictEqual(model.evaluation, 'ways');
  assert.strictEqual(result.distribution.closedForm, undefined, 'the full distribution path');
  assert.strictEqual(result.roundError, null);
  const round = result.round;
  assert.strictEqual(round.method, 'fft');
  assert.strictEqual(round.pmf.scope, 'round');
  assert.strictEqual(round.scope, undefined, 'not a first-drop result');
  const brute = bruteRoundUncapped(MINI);
  // The enumerated totals: (3*10)(2*11)(3*12) base windows, 10*11*12 free windows.
  assert.strictEqual(brute.base.total, 23760n);
  assert.strictEqual(brute.free.total, 1320n);
  assert.ok(5 * brute.pR < 1 && 5 * brute.pT < 1, 'the conditions of the bound (header)');
  assert.ok(brute.bound < 1e-15, 'truncated mass ' + brute.bound);
  // RTP by hand from the enumeration: E[feature] = F0 E[free win] / (1 - F P(retrigger))
  // (total spins of a branching process with mean F P(retrigger) offspring per spin).
  let eBase = new Fraction(0n), pTrig = new Fraction(0n), eFree = new Fraction(0n), pR = new Fraction(0n);
  for (const c of brute.base.cells) {
    eBase = eBase.add(new Fraction(BigInt(c.coins) * c.w, brute.base.total));
    if (c.scat >= 3) pTrig = pTrig.add(new Fraction(c.w, brute.base.total));
  }
  for (const c of brute.free.cells) {
    eFree = eFree.add(new Fraction(BigInt(c.coins * 2) * c.w, brute.free.total));
    if (c.scat >= 3) pR = pR.add(new Fraction(c.w, brute.free.total));
  }
  const eFeature = eFree.mul(5n).div(new Fraction(1n).sub(pR.mul(5n)));
  assert.strictEqual(result.rtp.fraction, eBase.add(pTrig.mul(eFeature)).div(10n).toString());
  // Cell by cell: relative 1e-9 where the probability is at least 1e-6; below that the
  // cell is either in the pmf to 1e-12 or left out under the noise floor.
  const got = pmfCoins(round, 10);
  let compared = 0;
  for (let x = 0; x < brute.round.length; x++) {
    const b = brute.round[x], g = got.get(x) || 0;
    if (b >= 1e-6) {
      compared++;
      assert.ok(Math.abs(g - b) <= 1e-9 * b, `x = ${x} coins: ${g} vs ${b}`);
    } else {
      assert.ok(Math.abs(g - b) <= 1e-12 + brute.bound, `x = ${x} coins: ${g} vs ${b}`);
      if (!got.has(x)) assert.ok(b < 1000 * round.floor, `a left-out cell is under the floor: ${b}`);
    }
  }
  assert.ok(compared > 400, 'cells compared at 1e-9: ' + compared);
  for (const [x, p] of got) assert.ok(brute.round[x] > 0 || p < 1e-12, `cell ${x} coins is a real outcome`);
  // Big wins ("1 in N"): P(W >= 100x) from the brute tail.
  let tail = 0;
  for (let x = 1000; x < brute.round.length; x++) tail += brute.round[x];
  const t100 = round.thresholds.find((t) => t.x === 100);
  assert.strictEqual(t100.method, 'fft');
  assert.ok(Math.abs(t100.value - tail) <= 1e-9 * tail, `P(W >= 100x) ${t100.value} vs ${tail}`);
  // Max-win cap M = 5x: RTP_capped = E[min(W, 5)] and P(W >= 5) from the enumeration.
  // The engine's E[(W - M)+] misses the cells under its noise floor, so it states an
  // interval [lower, value] for RTP_capped: the brute value must lie in it.
  let capped = 0, reach = 0;
  for (let x = 0; x < brute.round.length; x++) { capped += Math.min(x, 50) * brute.round[x]; if (x >= 50) reach += brute.round[x]; }
  capped /= 10;
  const cs = capStats(round, '5', result.rtp.fraction);
  assert.ok(cs.rtpCapped.lower <= capped * (1 + 1e-12) && capped <= cs.rtpCapped.value * (1 + 1e-12), `${capped} in [${cs.rtpCapped.lower}, ${cs.rtpCapped.value}]`);
  assert.ok(cs.rtpCapped.value - cs.rtpCapped.lower < 1e-7, 'a narrow interval');
  assert.ok(Math.abs(cs.reach.value - reach) <= 1e-9 * reach, `${cs.reach.value} vs ${reach}`);
});

test('ways + retrigger: session funnel and distribution tests use the whole-round pmf', async () => {
  const { model, result } = analyze(MINI);
  const brute = bruteRoundUncapped(MINI);
  const r = brute.round;
  // One round: P(finish ahead) = P(W > 1 bet) = P(coins > 10). Two rounds: the brute
  // pmf convolved with itself, P(W1 + W2 > 20 coins).
  let ahead1 = 0;
  for (let x = 11; x < r.length; x++) ahead1 += r[x];
  const cut = { mass: 0 };
  const two = conv(r, r, r.length - 1, cut);
  let ahead2 = cut.mass;
  for (let x = 21; x < two.length; x++) ahead2 += two[x];
  for (const [n, want] of [[1, ahead1], [2, ahead2]]) {
    const f = sessionFunnel(result.round.pmf, { rounds: n, rtp: result.rtp.fraction, sd: result.distribution.sd });
    assert.strictEqual(f.method, 'fft');
    assert.ok(Math.abs(f.pAhead - want) <= 1e-9 * want, `${n} rounds: P(ahead) ${f.pAhead} vs ${want}`);
    // Expected loss n x (1 - RTP), exactly.
    assert.strictEqual(f.expectedLoss.fraction, new Fraction(1n).sub(fracOf(result.rtp.fraction)).mul(BigInt(n)).toString());
  }
  // The distribution tests read the whole round: its mean is the RTP up to the cells
  // left out under the noise floor (kept as the "rest" cell), and a log simulated from
  // the model (seeded) fits it with no impossible round.
  const pmf = pmfFromExact(result.round.pmf, 'mini');
  assert.strictEqual(pmf.scope, 'round');
  assert.ok(pmf.rest && pmf.rest.p >= result.round.pmf.droppedMass && pmf.rest.unit === 0.1, 'the lattice step is 1 coin = 0.1 bet');
  assert.ok(Math.abs(pmf.mean - result.rtp.value) <= 1e-8 * result.rtp.value, `${pmf.mean} vs ${result.rtp.value}`);
  const rng = await prngFromSeed('mini ways log');
  const lines = ['bet,win,trigger'];
  for (let i = 0; i < 4000; i++) {
    const s = simulate(model, rng, 1, { progressEvery: 1e9 });
    lines.push('1,' + +(s.totalWinUnits / model.totalBetUnits).toFixed(6) + ',' + s.triggers);
  }
  const out = auditDistribution(parsePlayLog(lines.join('\n') + '\n'), [pmf], { alpha: 0.01, replicates: 199, totalReplicates: 199 }, await prngFromSeed('audit'));
  assert.strictEqual(out.scope, 'round');
  assert.strictEqual(out.fit.offSupport.count, 0);
  assert.notStrictEqual(out.fit.verdict, 'impossible');
});

test('ways + free-spin caps: exact RTP and variance, pmf, closed form and Monte Carlo agree', async () => {
  const raw = clone(MINI);
  // Start 5, a first retrigger adds 5 (10), a second adds min(5, 12 - 10) = 2 (12),
  // a third adds nothing (maxRetriggers 2).
  Object.assign(raw.scatter.freeSpins, { maxSpins: 12, maxRetriggers: 2 });
  const { model, result } = analyze(raw);
  assert.deepStrictEqual([model.freeSpins.maxSpins, model.freeSpins.maxRetriggers], [12, 2], 'ways models keep the caps');
  const brute = bruteRoundCapped(raw);
  assert.strictEqual(result.rtp.fraction, brute.rtp.toString());
  assert.strictEqual(result.distribution.variance.fraction, brute.variance.toString());
  // The closed form (the full distribution refused) gives the same exact variance.
  const closed = analyzeExact(normalizeModel(raw), { maxStates: 1 });
  assert.strictEqual(closed.distribution.closedForm, true);
  assert.strictEqual(closed.rtp.fraction, brute.rtp.toString());
  assert.strictEqual(closed.distribution.variance.fraction, brute.variance.toString());
  // The round pmf (cap-state sweep) against the exact walk, relative 1e-9.
  const round = result.round;
  assert.strictEqual(round.method, 'capsDp');
  assert.deepStrictEqual(round.caps, { maxSpins: 12, maxRetriggers: 2 });
  const got = pmfCoins(round, 10);
  let compared = 0;
  for (const [x, b] of brute.round) {
    const g = got.get(x) || 0;
    if (b >= 1e-6) { compared++; assert.ok(Math.abs(g - b) <= 1e-9 * b, `x = ${x}: ${g} vs ${b}`); } else assert.ok(Math.abs(g - b) <= 1e-12, `x = ${x}: ${g} vs ${b}`);
  }
  assert.ok(compared > 300, 'cells compared: ' + compared);
  // A bounded feature has a top win: the largest trigger spin, then j = 0, 1 or 2
  // retriggers (5, 10 or 12 spins). The j retriggering spins (scatter >= 3) come first
  // at their best; with j = 2 the cap is reached, so every later spin may be any spin;
  // with j < 2 the others must not retrigger. All from the enumeration, x2 in the feature.
  const fsCells = spinTable(raw, raw.scatter.freeSpins.heights).cells;
  const maxTrig = Math.max(...spinTable(raw, raw.heights).cells.filter((c) => c.scat >= 3).map((c) => c.coins));
  const mR = 2 * Math.max(...fsCells.filter((c) => c.scat >= 3).map((c) => c.coins));
  const mN = 2 * Math.max(...fsCells.filter((c) => c.scat < 3).map((c) => c.coins));
  const mAny = Math.max(mR, mN);
  const top = maxTrig + Math.max(5 * mN, mR + 9 * mN, 2 * mR + 10 * mAny);
  assert.strictEqual(round.maxWin.bounded, true);
  assert.strictEqual(round.maxWin.x, top / 10);
  // Monte Carlo applies the same caps to ways rounds: within 4 standard errors.
  const mc = simulate(model, await prngFromSeed('mini ways caps'), 200000, { progressEvery: 1e9 });
  assert.ok(Math.abs(mc.rtp - brute.rtp.toNumber()) < 4 * mc.standardError, `${mc.rtp} vs ${brute.rtp.toNumber()} (SE ${mc.standardError})`);
});

test('ways cascades: the whole-round distribution is labelled first drop and kept out of the distribution tests', () => {
  const raw = { ...clone(MINI), cascades: true };
  const { result } = analyze(raw);
  const plain = analyze(MINI).result;
  assert.strictEqual(result.scope, 'firstDrop');
  assert.strictEqual(result.rtp.fraction, plain.rtp.fraction, 'the first drop is the game without cascades');
  assert.strictEqual(result.round.scope, 'firstDrop');
  assert.strictEqual(result.round.pmf.scope, 'firstDrop');
  assert.strictEqual(result.distribution.pmf, null, 'the paid-spin pmf stays out too (P0-6)');
  assert.deepStrictEqual(result.round.thresholds, plain.round.thresholds, 'same figures, other label');
  assert.throws(() => pmfFromExact(result.round.pmf, 'cascading'), (e) => /first drop/.test(e.en) && Boolean(e.ar));
});

test('a ways game too large for the per-spin distribution says why it has no whole-round distribution', () => {
  const { result } = analyze(oasisCaravanWays);
  assert.strictEqual(result.distribution.closedForm, true);
  assert.strictEqual(result.round, null);
  assert.strictEqual(result.roundError.tooLarge, true);
  assert.strictEqual(result.roundError.internal, false);
  assert.match(result.roundError.en, /per-spin distribution/);
  assert.ok(result.roundError.ar.length > 20);
});

// ---- the signed report of a cascading ways game with its round and session ----
// Labels are literal; the figures are the analysis results carried through.

const enc = new TextEncoder();
const sha = (b) => nodeCrypto.createHash('sha256').update(b).digest('hex');
function recordingCanvas(drawn) {
  let pageNo = 0;
  return (w, h) => {
    const ctx = { fillRect() {}, fillText: (t) => drawn.push(String(t)), drawImage() {}, measureText: (s) => ({ width: String(s).length * 12 }) };
    return {
      width: w, height: h, getContext: () => ctx,
      convertToBlob: async () => {
        const b = new Uint8Array(3000);
        for (let i = 0; i < b.length; i++) b[i] = (i * 31 + ++pageNo) & 255;
        b.set([0xff, 0xd8]); b.set([0xff, 0xd9], b.length - 2);
        return new Blob([b]);
      },
    };
  };
}
function roundSession(raw, { cap = null, sessionRounds = null } = {}) {
  const bytes = enc.encode(canonicalJson(raw));
  const { result } = analyze(raw);
  const th = { inputId: 'model', modelSha256: sha(bytes), result, raw };
  if (cap) th.cap = { M: cap, odds: true, result: { cap: capStats(result.round, cap, result.rtp.fraction), top: null } };
  const results = { theoretical: th };
  if (sessionRounds) {
    const s = sessionFunnel(result.round.pmf, { rounds: sessionRounds, rtp: result.rtp.fraction, sd: result.distribution.sd });
    results.session = { inputId: 'model', modelSha256: th.modelSha256, options: { rounds: sessionRounds, bet: '1', budget: null, budgetInBets: null, seed: 's' }, result: s, ...(result.scope === 'firstDrop' ? { scope: 'firstDrop' } : {}) };
  }
  return { meta: { title: 'ways round', auditor: '', notes: '' }, inputs: [{ id: 'model', name: 'ways.json', kind: 'model', size: bytes.length, sha256: sha(bytes), bytes, mime: 'application/json' }], results };
}

test('signed report: a cascading ways game\'s round, cap and session say first drop only', async () => {
  const session = roundSession({ ...clone(MINI), cascades: true }, { cap: '5', sessionRounds: 10 });
  const key = { ...(await generateKeyPair({ algorithms: [ED25519] })), storage: 'persistent' };
  const drawn = [];
  const r = await buildReport(session, { createCanvas: recordingCanvas(drawn), signer: key, now: new Date('2026-11-04T09:00:00Z') });
  const v = await verifyReportPdf(r.bytes);
  assert.strictEqual(v.status, 'valid', JSON.stringify(v.checks.filter((c) => !c.ok)));
  const report = JSON.parse(new TextDecoder().decode(readPdfAttachments(r.bytes).attachments.find((a) => a.name === 'report.json').data));
  assert.strictEqual(report.results.theoretical.scope, 'firstDrop');
  assert.strictEqual(report.results.theoretical.roundDistribution.scope, 'firstDrop');
  assert.strictEqual(report.results.theoretical.roundDistribution.pmf.scope, 'firstDrop');
  assert.strictEqual(report.results.session.scope, 'firstDrop');
  assert.strictEqual(report.manifest.parameters.roundDistribution.scope, 'firstDrop');
  const fig = Object.fromEntries(v.report.figures.map((f) => [f.section, f]));
  assert.strictEqual(fig.round.scope, 'firstDrop');
  assert.strictEqual(fig.session.scope, 'firstDrop');
  // The PDF pages: the first-drop badge and notes in both languages.
  for (const k of ['roundFirstDropNote', 'sessFirstDropNote']) {
    assert.ok(drawn.join(' ').includes(pair(k)[1].split(' ').slice(0, 6).join(' ')), k + ' English');
    assert.ok(drawn.join(' ').includes(pair(k)[0].split(' ').slice(0, 4).join(' ')), k + ' Arabic');
  }
  assert.ok(drawn.filter((s) => s.includes(pair('firstDropBadge')[1])).length >= 2, 'badges in the theoretical, round and session sections');
  // The text page.
  const page = [...Buffer.from(r.bytes).toString('latin1').matchAll(/\(((?:\\.|[^\\)])*)\) Tj/g)].map((m) => m[1].replace(/\\(.)/g, '$1')).join(' ').replace(/\s+/g, ' ');
  assert.match(page, /Whole-round distribution \(FIRST DROP ONLY/);
  assert.match(page, /Max-win cap 5x per round: RTP [0-9.]+% \(first drop only\)/);
  assert.match(page, /Session funnel \(FIRST DROP ONLY\)/);
});

test('report.json: a ways game with free spins carries its whole-round distribution; a closed-form one says why not', () => {
  const plain = reportPayload({ ...roundSession(MINI, { cap: '5' }), signer: null }, '2026-11-04T00:00:00Z');
  const rd = plain.results.theoretical.roundDistribution;
  assert.strictEqual(rd.method, 'fft');
  assert.strictEqual(rd.scope, undefined);
  assert.strictEqual(rd.pmf.scope, 'round');
  assert.strictEqual(plain.results.theoretical.maxWinCap.M, '5');
  assert.strictEqual(plain.manifest.parameters.roundDistribution.scope, undefined);
  const closed = reportPayload({ ...roundSession(oasisCaravanWays), signer: null }, '2026-11-04T00:00:00Z');
  assert.strictEqual(closed.results.theoretical.roundDistribution, null);
  assert.strictEqual(closed.results.theoretical.roundError.tooLarge, true);
  assert.match(closed.manifest.parameters.roundDistribution.error, /per-spin distribution/);
});

test('labels of the ways + whole-round integration exist in both languages', () => {
  for (const k of ['roundFirstDropNote', 'sessFirstDropNote', 'roundUseMcClosed']) {
    const [ar, en] = pair(k);
    assert.ok(ar !== k && en !== k && ar !== en, k);
    assert.ok(/[؀-ۿ]/.test(ar), k + ' Arabic');
  }
});

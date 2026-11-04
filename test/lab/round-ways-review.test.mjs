// Review fixes of the ways + whole-round integration (P0-6 x P0-8). Each expected value
// is derived independently of the engine, as stated next to it:
//  * Fraction#toExponential: hand values, and Number#toExponential (V8's own rounding)
//    for fractions whose doubles are far from a rounding tie;
//  * Desert Gold without retrigger and 50 free spins: the top win's probability by hand
//    from the published spin pmf (the same reading as round-dist.test.mjs, with 50 spins
//    in place of 10), and its decimal form from logarithms in doubles;
//  * a ways game whose free spins pay nothing: its RTP is the base game's, enumerated
//    here board by board;
//  * the bound on wrapped mass is 0 when the grid holds the largest win (nothing can wrap);
//  * Monte Carlo sessions that are all ahead: the 95% lower bound 0.05^(1/m) by hand.
import test from 'node:test';
import assert from 'node:assert';
import nodeCrypto from 'node:crypto';
import fs from 'fs';
import { normalizeModel, canonicalJson } from '../../lab/core/slot-model.js';
import { analyzeExact } from '../../lab/core/slot-exact.js';
import { Fraction } from '../../lab/core/fraction.js';
import { attachRoundDistribution, capStats, topAward, MIN_BOUND } from '../../lab/core/round-dist.js';
import { sessionFunnel } from '../../lab/core/session.js';
import { buildManifest } from '../../lab/core/manifest.js';
import { verifyReportPdf } from '../../lab/core/report-sign.js';
import { prngFromSeed } from '../../lab/core/prng.js';
import { buildReport } from '../../lab/report.js';
import { pair } from '../../lab/i18n.js';
import { MINI } from '../helpers/ways-brute.mjs';

const SAMPLES = new URL('../../lab/samples/', import.meta.url);
const sample = (name) => JSON.parse(fs.readFileSync(new URL(name, SAMPLES), 'utf8'));
const clone = (v) => JSON.parse(JSON.stringify(v));
const enc = new TextEncoder();
const sha = (b) => nodeCrypto.createHash('sha256').update(b).digest('hex');

function analyzeRound(raw) {
  const model = normalizeModel(raw);
  let spins = null;
  const result = attachRoundDistribution(analyzeExact(model, { onEntries: (e) => { spins = e; } }), model, spins);
  return { model, result };
}

// A canvas that records each page's text with its box: the width is the character count
// times 0.55 of the font size (a stand-in for real glyphs, the same for every string),
// so two strings drawn on one line overlap when their boxes do. A page starts where the
// layout clears the whole canvas.
function layoutCanvas(pages) {
  let rec = null;
  return (w, h) => {
    const st = { font: '10px x', textAlign: 'left' };
    const size = () => Number(/(\d+(?:\.\d+)?)px/.exec(st.font)[1]);
    const width = (s) => String(s).length * size() * 0.55;
    const ctx = {
      fillRect: (x, y, fw, fh) => { if (x === 0 && y === 0 && fw === w && fh === h) { rec = []; pages.push(rec); } },
      drawImage() {},
      measureText: (s) => ({ width: width(s) }),
      fillText: (s, x, y) => {
        if (!rec) return;
        const wd = width(s), a = st.textAlign;
        rec.push({ s: String(s), y, x0: a === 'left' ? x : a === 'right' ? x - wd : x - wd / 2, x1: a === 'left' ? x + wd : a === 'right' ? x : x + wd / 2 });
      },
    };
    for (const k of ['font', 'textAlign']) Object.defineProperty(ctx, k, { get: () => st[k], set: (v) => { st[k] = v; } });
    return {
      width: w, height: h, getContext: () => ctx,
      convertToBlob: async () => { const b = new Uint8Array(3000); b.set([0xff, 0xd8]); b.set([0xff, 0xd9], b.length - 2); return new Blob([b]); },
    };
  };
}
const textPage = (bytes) => [...Buffer.from(bytes).toString('latin1').matchAll(/\(((?:\\.|[^\\)])*)\) Tj/g)]
  .map((m) => m[1].replace(/\\(.)/g, '$1')).join(' ').replace(/\s+/g, ' ');
function sessionOf(raw, result, { cap = null, odds = false } = {}) {
  const bytes = enc.encode(canonicalJson(raw));
  const th = { inputId: 'model', modelSha256: sha(bytes), result, raw };
  if (cap) {
    const c = capStats(result.round, cap, result.rtp.fraction);
    th.cap = { M: cap, odds, result: { cap: c, top: topAward(result.round, c) } };
  }
  return {
    meta: { title: 'review', auditor: '', notes: '' },
    inputs: [{ id: 'model', name: 'model.json', kind: 'model', size: bytes.length, sha256: sha(bytes), bytes, mime: 'application/json' }],
    results: { theoretical: th },
  };
}

// ---------- 1. an exact probability below a double's range is never shown as 0 ----------

test('Fraction#toExponential: hand values, a carry, both signs and any size', () => {
  const F = (n, d = 1n) => new Fraction(n, d);
  assert.strictEqual(F(1n, 3n).toExponential(3), '3.333e-1'); // 0.33333...
  assert.strictEqual(F(2n, 3n).toExponential(3), '6.667e-1'); // 0.66666... rounds up
  assert.strictEqual(F(1n, 10n ** 366n).toExponential(3), '1.000e-366');
  assert.strictEqual(F(99995n, 100000n).toExponential(3), '1.000e+0'); // 9.9995e-1: the half rounds up, 10.000 -> 1.000e+0
  assert.strictEqual(F(10n ** 400n, 7n).toExponential(3), '1.429e+399'); // 10/7 = 1.42857...
  assert.strictEqual(F(-1n, 8n).toExponential(2), '-1.25e-1');
  assert.strictEqual(F(0n).toExponential(3), '0.000e+0');
  assert.strictEqual(F(12345n).toExponential(0), '1e+4');
  // A second algorithm: V8's Number#toExponential on p / q, away from rounding ties
  // (where the double's own rounding could tip the last digit either way).
  let compared = 0;
  for (let i = 1; i < 4000; i++) {
    const p = (i * 7919) % 1000003 + 1, q = (i * 104729) % 999983 + 1;
    const v = p / q;
    const m = v / 10 ** Math.floor(Math.log10(v)) * 1000;
    if (Math.abs((m % 1) - 0.5) < 1e-6) continue;
    assert.strictEqual(F(BigInt(p), BigInt(q)).toExponential(3), v.toExponential(3), `${p}/${q}`);
    compared++;
  }
  assert.ok(compared > 3900);
});

test('Desert Gold, no retrigger, 50 free spins: the top win\'s exact probability (about 1e-367) is written from its fraction, not as 0', async () => {
  const raw = sample('desert-gold.json');
  Object.assign(raw.scatter.freeSpins, { retrigger: false, spins: 50 });
  const { result } = analyzeRound(raw);
  const round = result.round;
  // By hand from the published spin pmf: the largest free spin is the largest spin win
  // (count 4 of 61,709,340 combinations, x3), so the top round win is the largest
  // trigger-spin win followed by 50 such spins: P = c_trig / T x (c_top / T)^50.
  const pmf = result.distribution.pmf;
  const T = BigInt(pmf.total);
  const top = pmf.entries.reduce((a, e) => (e.units > a.units ? e : a));
  const trig = pmf.entries.filter((e) => e.trigger);
  const tmax = Math.max(...trig.map((e) => e.units));
  const cTrig = trig.filter((e) => e.units === tmax).reduce((a, e) => a + BigInt(e.count), 0n);
  const expected = new Fraction(cTrig, T).mul(new Fraction(BigInt(top.count) ** 50n, T ** 50n));
  assert.strictEqual(round.maxWin.x, (tmax + 50 * 3 * top.units) / 20);
  assert.strictEqual(round.maxWin.method, 'exact');
  assert.strictEqual(round.maxWin.fraction, expected.toString());
  // Its decimal form from logarithms in doubles (independent of the BigInt rounding):
  // log10 P = log10 c_trig - log10 T + 50 (log10 c_top - log10 T).
  const L = Math.log10(Number(cTrig)) - Math.log10(Number(T)) + 50 * (Math.log10(Number(top.count)) - Math.log10(Number(T)));
  assert.ok(L < Math.log10(MIN_BOUND), 'below the double range shown (the premise)');
  const sci = (lg, d) => { const e = Math.floor(lg); return (10 ** (lg - e)).toFixed(d) + 'e' + (e < 0 ? '-' : '+') + Math.abs(e); };
  assert.strictEqual(round.maxWin.sci, sci(L, 3));
  assert.strictEqual(round.maxWin.oneInSci, sci(-L, 2));
  assert.strictEqual(round.maxWin.value, null, 'no double stands for it (it would read 0)');
  // The top award (no cap) carries it, and fails both odds rules (it is far below 1e-8).
  const t = topAward(round, null);
  assert.deepStrictEqual([t.prob.sci, t.checks.oneInSci, t.checks.gli19.pass, t.checks.pa.pass], [sci(L, 3), sci(-L, 2), false, false]);
  // A cap at the top win reads the same probability for "a round reaches the cap".
  const atTop = capStats(round, String(round.maxWin.x), result.rtp.fraction);
  assert.strictEqual(atTop.reach.sci, sci(L, 3));

  // The report: the PDF table, the text page and the Verify figure say 1.248e-367 and
  // "1 in 8.01e+366", never 0.
  const session = sessionOf(raw, result, { cap: String(round.maxWin.x), odds: true });
  const pages = [];
  const r = await buildReport(session, { createCanvas: layoutCanvas(pages), signer: null, now: new Date('2026-11-04T09:00:00Z') });
  const drawn = pages.flat().map((d) => d.s);
  assert.ok(drawn.includes(sci(L, 3)) && drawn.includes(sci(-L, 2)), 'the PDF round table');
  assert.ok(drawn.some((s) => s.includes('P = ' + sci(L, 3))), 'the top win and top award lines');
  const page = textPage(r.bytes);
  assert.ok(page.includes(`top win ${round.maxWin.x}x, P ${sci(L, 3)}`), 'text page: top win');
  assert.ok(page.includes(`Top award ${round.maxWin.x}x, P ${sci(L, 3)}`), 'text page: top award');
  assert.ok(!/top win [0-9.]+x, P 0[;. ]/.test(page));
  const v = await verifyReportPdf(r.bytes);
  const fig = v.report.figures.find((f) => f.section === 'round');
  assert.deepStrictEqual([fig.value, fig.oneIn], [round.maxWin.x + '×', sci(-L, 2)]);
});

// ---------- 2. the ways closed form keeps the RTP when the caps are too large ----------

test('ways closed form: caps too large for the variance sweep keep the exact RTP and say why', () => {
  // 5 reels, 1 row, A B S each. Free spins on their own reels: S (weight 1) or X (weight
  // 2^64 - 1, pays nothing), so the free-spin cycle is 2^320 and a free spin pays 0. The
  // cap 290 (5 spins per award) passes the RTP's sweep and is over the memory budget of
  // the sweep with the sums, which the closed form needs for the variance.
  const big = String((1n << 64n) - 1n);
  const raw = {
    evaluation: 'ways', rows: 1, betCost: 1,
    reels: Array.from({ length: 5 }, () => ['A', 'B', 'S']),
    paytable: { A: [0, 0, 1, 2, 5], B: [0, 0, 1, 1, 2] },
    scatter: {
      symbol: 'S',
      freeSpins: { trigger: 3, spins: 5, multiplier: 1, retrigger: true, maxSpins: 290, reels: Array.from({ length: 5 }, () => ['S', 'X']), weights: Array.from({ length: 5 }, () => ['1', big]) },
    },
  };
  // RTP by enumeration of the 3^5 base boards: a run of A or B from reel 1 of length k
  // pays its paytable entry (one way per reel, 1 row); free spins add nothing.
  let coins = 0n;
  const syms = ['A', 'B', 'S'];
  for (let i = 0; i < 243; i++) {
    const board = [0, 1, 2, 3, 4].map((r) => syms[Math.floor(i / 3 ** r) % 3]);
    const s = board[0];
    if (s === 'S') continue;
    let k = 1;
    while (k < 5 && board[k] === s) k++;
    coins += BigInt(raw.paytable[s][k - 1]);
  }
  const rtp = new Fraction(coins, 243n);
  assert.strictEqual(rtp.toString(), '25/243');
  // maxStates 1: the full distribution is refused, so the closed form is the only path.
  const r = analyzeExact(normalizeModel(raw), { maxStates: 1 });
  assert.strictEqual(r.rtp.fraction, rtp.toString());
  assert.strictEqual(r.distribution, null);
  assert.match(r.distributionError.en, /free-spin caps are too large/);
  assert.match(r.distributionError.en, /RTP and its contributions are still exact/);
  assert.ok(r.distributionError.ar.includes('حدود اللفات المجانية') && r.distributionError.ar.includes('ما زال RTP'));
  // The whole-round step then has nothing to build on, and says nothing wrong.
  const out = attachRoundDistribution(r, normalizeModel(raw), null);
  assert.deepStrictEqual([out.round, out.roundError], [null, null]);
});

// ---------- 4 to 6: the PDF and the text page ----------

test('cascading ways game: the top-award odds carry the first-drop label (PDF note and text page)', async () => {
  const raw = { ...clone(MINI), cascades: true };
  const { result } = analyzeRound(raw);
  const pages = [];
  const r = await buildReport(sessionOf(raw, result, { cap: '5', odds: true }), { createCanvas: layoutCanvas(pages), signer: null, now: new Date('2026-11-04T09:00:00Z') });
  const drawn = pages.flat().map((d) => d.s).join(' ');
  const [ar, en] = pair('roundOddsFirstDrop');
  assert.ok(drawn.includes(en.split(' ').slice(0, 8).join(' ')) && drawn.includes(ar.split(' ').slice(0, 5).join(' ')), 'PDF note in both languages');
  assert.match(textPage(r.bytes), /Top award 5x \(FIRST DROP ONLY: from the first-drop distribution, so the verdicts do not hold for the game\), P /);
  // A game without cascades has no such label.
  const plain = analyzeRound(clone(MINI)).result;
  const r2 = await buildReport(sessionOf(MINI, plain, { cap: '5', odds: true }), { createCanvas: layoutCanvas([]), signer: null, now: new Date('2026-11-04T09:00:00Z') });
  assert.match(textPage(r2.bytes), /Top award 5x, P /);
});

test('signed-report references: the ways row\'s labels do not run into its value', async () => {
  const { result } = analyzeRound(clone(MINI));
  const pages = [];
  await buildReport(sessionOf(MINI, result, { cap: '5', odds: true }), { createCanvas: layoutCanvas(pages), signer: null, now: new Date('2026-11-04T09:00:00Z') });
  // Every row of the references list (the ways row and the two odds rules included):
  // the boxes drawn on that line do not overlap.
  const ids = ['Stake Engine math-sdk (ways)', 'GLI-19 v3.0', '58 Pa. Code 461a.7', 'FIPS 180-4', 'PDF 1.4'];
  let rows = 0;
  for (const rec of pages) {
    for (const d of rec.filter((x) => ids.includes(x.s))) {
      const line = rec.filter((x) => x.y === d.y && x.s);
      rows++;
      for (let i = 0; i < line.length; i++) for (let j = i + 1; j < line.length; j++) {
        const a = line[i], b = line[j];
        assert.ok(!(a.x0 < b.x1 && b.x0 < a.x1), `"${a.s}" overlaps "${b.s}"`);
      }
    }
  }
  assert.ok(rows >= 2 * ids.length, 'each row drawn on both passes: ' + rows);
});

test('text page: a wrapped-mass bound of 0 reads "0", not "< 0"', async () => {
  const raw = clone(MINI);
  Object.assign(raw.scatter.freeSpins, { maxSpins: 25, maxRetriggers: 3 });
  const { result } = analyzeRound(raw);
  const round = result.round;
  // The capped feature is bounded and the grid holds its largest win, so no mass can
  // wrap around the grid: the bound is 0 (the premise of this test).
  assert.ok(round.maxWin.bounded && round.maxWin.units < round.grid.size, `${round.maxWin.units} < ${round.grid.size}`);
  assert.strictEqual(round.aliasBound, 0);
  const r = await buildReport(sessionOf(raw, result), { createCanvas: layoutCanvas([]), signer: null, now: new Date('2026-11-04T09:00:00Z') });
  const page = textPage(r.bytes);
  assert.match(page, /grid \d+, wrapped mass 0, noise floor/);
  assert.ok(!page.includes('wrapped mass < 0'));
});

// ---------- 7. no "wild on reel 1" departure for a ways game without a wild ----------

test('ways game without a wild: no wild-on-reel-1 deviation, and the rule says there is no wild', async () => {
  const raw = clone(MINI);
  delete raw.wild;
  raw.reels = raw.reels.map((r) => r.map((s) => (s === 'W' ? 'T' : s)));
  const model = normalizeModel(raw);
  assert.strictEqual(model.wild, -1, 'no wild (the premise)');
  const result = analyzeExact(model);
  assert.strictEqual(result.model.ways.hasWild, false);
  const session = sessionOf(raw, result);
  assert.deepStrictEqual(buildManifest({ ...session, signer: null }).deviations.map((d) => d.id), []);
  const pages = [];
  const r = await buildReport(session, { createCanvas: layoutCanvas(pages), signer: null, now: new Date('2026-11-04T09:00:00Z') });
  const drawn = pages.flat().map((d) => d.s).join(' ');
  assert.ok(drawn.includes(pair('wildReel1_none')[1]) && !drawn.includes(pair('wildReel1_true')[1]));
  assert.match(textPage(r.bytes), /no wild in the model \(wildStartsWin changes nothing\)/);
  // With its wild back, the departure from ways.py is listed (as before).
  const withWild = analyzeExact(normalizeModel(clone(MINI)));
  assert.strictEqual(withWild.model.ways.hasWild, true);
  assert.deepStrictEqual(buildManifest({ ...sessionOf(MINI, withWild), signer: null }).deviations.map((d) => d.id), ['ways-wild-reel1']);
});

// ---------- 8. the Verify figure of a Monte Carlo session ----------

test('Verify figure of a Monte Carlo session: the estimate with its standard error, or the 95% bound', async () => {
  const report = async (raw, rounds) => {
    const { result } = analyzeRound(raw);
    const session = sessionOf(raw, result);
    const s = sessionFunnel(result.round.pmf, { rounds, budget: null, rtp: result.rtp.fraction, sd: result.distribution.sd, seed: 'review', rng: await prngFromSeed('review'), forceMonteCarlo: true });
    session.results.session = { inputId: 'model', modelSha256: session.results.theoretical.modelSha256, options: { rounds, bet: '1', budget: null, budgetInBets: null, seed: 'review' }, result: s };
    const r = await buildReport(session, { createCanvas: layoutCanvas([]), signer: null, now: new Date('2026-11-04T09:00:00Z') });
    const v = await verifyReportPdf(r.bytes);
    return { s, fig: v.report.figures.find((f) => f.section === 'session') };
  };
  // European roulette on red: an estimate between 0 and 1; the figure is the stored
  // estimate and standard error (carried through), marked as Monte Carlo.
  const { s, fig } = await report(sample('roulette-european.json'), 100);
  assert.ok(s.pAhead > 0 && s.pAhead < 1 && s.pAheadSe > 0);
  assert.deepStrictEqual(fig, { section: 'session', value: `${(s.pAhead * 100).toFixed(4)}% ± ${(s.pAheadSe * 100).toFixed(4)}%`, rounds: 100, method: 'mc' });
  // A game that pays 2x every round: every simulated session is ahead, so the figure
  // is the 95% lower bound 0.05^(1/m) (P(all m ahead) = p^m >= 0.05), rounded down.
  const always = { name: 'always 2x', rows: 1, reels: [['A'], ['A'], ['A']], lines: [[1, 1, 1]], paytable: { A: [0, 0, 2] } };
  const all = await report(always, 5);
  const m = all.s.sessions;
  const lower = 0.05 ** (1 / m);
  assert.strictEqual(all.fig.value, `> ${(Math.floor(lower * 1e6) / 1e4).toFixed(4)}% (95%)`);
  assert.strictEqual(all.fig.method, 'mc');
  assert.ok(!all.fig.value.includes('100.0000%'));
});

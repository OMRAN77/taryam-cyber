// Ways models (P0-6) in the signed report: report.json says what the theoretical figure
// covers (scope "round" or "firstDrop"), the manifest records the ways conventions and
// their source, the Verify tab's headline figures carry the scope, and the text page
// says "first drop only" in words. Expected values are the analysis results themselves
// carried through (the numbers are checked in ways-exact.test.mjs) and literal labels.
import test from 'node:test';
import assert from 'node:assert';
import nodeCrypto from 'node:crypto';
import { buildReport, reportPayload } from '../../lab/report.js';
import { generateKeyPair, ED25519 } from '../../lab/core/sign.js';
import { verifyReportPdf } from '../../lab/core/report-sign.js';
import { readPdfAttachments } from '../../lab/core/pdf-read.js';
import { buildManifest } from '../../lab/core/manifest.js';
import { normalizeModel, canonicalJson } from '../../lab/core/slot-model.js';
import { analyzeExact } from '../../lab/core/slot-exact.js';
import { simulate, generatorDescription, controlVariate } from '../../lab/core/montecarlo.js';
import { prngFromSeed } from '../../lab/core/prng.js';
import { pair } from '../../lab/i18n.js';
import { oasisCaravanWays, desertGold } from '../../lab/samples.js';

const enc = new TextEncoder();
const sha = (b) => nodeCrypto.createHash('sha256').update(b).digest('hex');

let pageNo = 0;
function stubCanvas(w, h) {
  const ctx = { fillRect() {}, fillText() {}, drawImage() {}, measureText: (s) => ({ width: String(s).length * 12 }) };
  return {
    width: w, height: h, getContext: () => ctx,
    convertToBlob: async () => {
      const b = new Uint8Array(3000);
      for (let i = 0; i < b.length; i++) b[i] = (i * 31 + ++pageNo) & 255;
      b.set([0xff, 0xd8]); b.set([0xff, 0xd9], b.length - 2);
      return new Blob([b]);
    },
  };
}

async function waysSession(raw, { mc = false } = {}) {
  const bytes = enc.encode(canonicalJson(raw));
  const model = normalizeModel(raw);
  const result = analyzeExact(model);
  const results = { theoretical: { inputId: 'model', modelSha256: sha(bytes), result, raw } };
  if (mc) {
    const sim = simulate(model, await prngFromSeed('report'), 20000);
    const run = { modelSha256: sha(bytes), seed: 'report', spins: 20000, generator: generatorDescription(model), result: sim };
    results.montecarlo = { ...run, resultSha256: sha(canonicalJson(run)), exactRtp: result.rtp.value, controlVariate: controlVariate(sim, result.controlVariate.mean.value, model.totalBetUnits) };
  }
  return { meta: { title: 'ways', auditor: '', notes: '' }, inputs: [{ id: 'model', name: 'ways.json', kind: 'model', size: bytes.length, sha256: sha(bytes), bytes, mime: 'application/json' }], results };
}

test('report.json: a ways model states its evaluation, scope "round", conventions and control variate', async () => {
  const session = await waysSession(oasisCaravanWays, { mc: true });
  const payload = JSON.parse(canonicalJson(reportPayload({ ...session, signer: null }, '2026-11-04T00:00:00Z')));
  const th = payload.results.theoretical;
  assert.strictEqual(th.scope, 'round');
  assert.strictEqual(th.model.evaluation, 'ways');
  assert.strictEqual(th.model.ways.base.maxWays, '200704');
  assert.strictEqual(th.model.ways.multiplierStrategy, 'symbol');
  assert.strictEqual(th.distribution.closedForm, true);
  assert.strictEqual(th.distribution.maxWin, null);
  assert.strictEqual(th.controlVariate.mean.fraction, session.results.theoretical.result.controlVariate.mean.fraction);
  assert.strictEqual(payload.results.montecarlo.result.scope, 'round');
  assert.ok(payload.results.montecarlo.controlVariate.standardError > 0);
  const m = buildManifest({ ...session, signer: null });
  assert.deepStrictEqual(m.parameters.theoretical, { input: 'model', evaluation: 'ways', scope: 'round', betCost: 20, multiplierStrategy: 'symbol', globalMultiplier: 1, wildStartsWin: true, closedForm: true });
  assert.ok(m.references.some((r) => r.id === 'Stake Engine math-sdk (ways)' && /141b4e8/.test(r.title) && /2 Nov 2026/.test(r.title)));
  // The sample's wilds never land on reel 1, but its rule (wildStartsWin true) still differs from ways.py.
  assert.deepStrictEqual(m.deviations.map((d) => d.id), ['ways-wild-reel1']);
});

test('report.json and the manifest of a line game: the theoretical parameters say lines, round', async () => {
  const session = await waysSession(desertGold);
  const payload = JSON.parse(canonicalJson(reportPayload({ ...session, signer: null }, '2026-11-04T00:00:00Z')));
  assert.strictEqual(payload.results.theoretical.scope, undefined, 'line payloads keep their keys');
  assert.strictEqual(payload.results.theoretical.controlVariate, undefined);
  const m = buildManifest({ ...session, signer: null });
  assert.deepStrictEqual(m.parameters.theoretical, { input: 'model', evaluation: 'lines', scope: 'round' });
  assert.ok(!m.references.some((r) => r.id === 'Stake Engine math-sdk (ways)'));
  assert.deepStrictEqual(m.deviations, []);
});

test('signed report of a cascading ways game: first drop only in report.json, the Verify figures and the text page', async () => {
  const raw = { ...JSON.parse(JSON.stringify(oasisCaravanWays)), name: 'Oasis Caravan, cascading', cascades: true, multiplierStrategy: 'board', wildStartsWin: false };
  const session = await waysSession(raw, { mc: true });
  const key = { ...(await generateKeyPair({ algorithms: [ED25519] })), storage: 'persistent' };
  const r = await buildReport(session, { createCanvas: stubCanvas, signer: key, now: new Date('2026-11-04T09:00:00Z') });
  const v = await verifyReportPdf(r.bytes);
  assert.strictEqual(v.status, 'valid', JSON.stringify(v.checks.filter((c) => !c.ok)));
  const report = JSON.parse(new TextDecoder().decode(readPdfAttachments(r.bytes).attachments.find((a) => a.name === 'report.json').data));
  assert.strictEqual(report.results.theoretical.scope, 'firstDrop');
  assert.strictEqual(report.manifest.parameters.theoretical.scope, 'firstDrop');
  assert.deepStrictEqual(report.manifest.deviations.map((d) => d.id), ['ways-board-sum']);
  const fig = Object.fromEntries(v.report.figures.map((f) => [f.section, f]));
  assert.strictEqual(fig.theoretical.scope, 'firstDrop');
  assert.strictEqual(fig.theoretical.value, session.results.theoretical.result.rtp.percent + '%');
  assert.strictEqual(fig.montecarlo.scope, 'firstDrop');
  const text = Buffer.from(r.bytes).toString('latin1');
  assert.ok(text.includes('FIRST DROP ONLY'), 'text page');
  assert.ok(text.includes('Ways evaluation: 324-200704 ways, bet 20 coins, top reel over reels 2, 3, 4, 5'), 'ways line');
  assert.ok(text.includes('multiplier strategy \\(board\\)') || text.includes('multiplier strategy "board"'), 'strategy');
});

test('every label the ways UI and report use exists in both languages', () => {
  const keys = ['sampleWays', 'waysJsonNote', 'waysEval', 'waysWord', 'maxWays', 'waysRange', 'waysCombinations', 'waysTitle', 'waysHeights', 'waysHeight', 'waysTopCell', 'waysJoint',
    'fsWindows', 'topReelWord', 'topReelValue', 'topReelNone', 'topReelKv', 'betCostLabel', 'waysPayUnit', 'multStrategy', 'multStrategy_symbol', 'multStrategy_board', 'multStrategy_global',
    'globalMultLabel', 'multiplierSymbolsLabel', 'wildReel1', 'wildReel1_true', 'wildReel1_false', 'waysSource', 'waysBoardNote', 'waysNotCert', 'rtpFirstDrop', 'firstDropNote', 'firstDropBadge',
    'firstDropShort', 'hitUnavailable', 'payPerWay', 'probabilityRun', 'averageWays', 'controlVariateLabel', 'cvRtp', 'cvSe', 'cvNote', 'simRtpFirstDrop', 'distFirstDrop', 'sigmaFirstDrop',
    'refUseWays', 'devWaysBoard', 'devWaysWild', 'contribWays', 'symbolTableWays',
    'cascadesJsonNote', 'waysWildNote', 'globalPayNote', 'topReelTotal', 'waysWeightsNote', 'cvRtpFirstDrop'];
  for (const k of keys) {
    const [ar, en] = pair(k);
    assert.ok(ar !== k && en !== k && ar !== en, k);
    assert.ok(/[؀-ۿ]/.test(ar), k + ' Arabic');
  }
  // The source and date of the conventions are named in both languages.
  assert.ok(pair('waysSource')[1].includes('141b4e8') && pair('waysSource')[1].includes('2 Nov 2026'));
  assert.ok(pair('waysSource')[0].includes('141b4e8') && pair('waysSource')[0].includes('2 نوفمبر 2026'));
});

// A canvas that records every text the PDF layout draws.
function recordingCanvas(drawn) {
  return (w, h) => {
    const c = stubCanvas(w, h);
    const ctx = c.getContext('2d');
    ctx.fillText = (t) => drawn.push(String(t));
    return c;
  };
}

test('PDF: a cascading game\'s control-variate RTP is labelled first drop only', async () => {
  const raw = { ...JSON.parse(JSON.stringify(oasisCaravanWays)), name: 'Oasis Caravan, cascading', cascades: true };
  const session = await waysSession(raw, { mc: true });
  const drawn = [];
  await buildReport(session, { createCanvas: recordingCanvas(drawn), now: new Date('2026-11-04T09:00:00Z') });
  assert.ok(drawn.includes(pair('cvRtpFirstDrop')[1]) && drawn.includes(pair('cvRtpFirstDrop')[0]), 'first-drop control-variate label');
  assert.ok(!drawn.includes(pair('cvRtp')[1]), 'no plain control-variate label');
  assert.ok(drawn.includes(pair('simRtpFirstDrop')[1]));
  // The text page says it too: its lines (PDF strings, parentheses escaped) joined again.
  const r = await buildReport(session, { createCanvas: stubCanvas, now: new Date('2026-11-04T09:00:00Z') });
  const page = [...Buffer.from(r.bytes).toString('latin1').matchAll(/\(((?:\\.|[^\\)])*)\) Tj/g)].map((m) => m[1].replace(/\\(.)/g, '$1')).join(' ').replace(/\s+/g, ' ');
  assert.match(page, /as a control variate [0-9.]+% \+\/- [0-9.]+% \(first drop only\)/);
});

test('PDF: a weighted ways model shows window totals and the top reel total; global pays and wild-assisted are explained', async () => {
  // The totals are checked by hand in ways-exact.test.mjs: 24 / 16 / 3, top reel 7.
  const raw = { evaluation: 'ways', reels: [['A', 'B', 'W'], ['A', 'B', 'C'], ['C', 'A', 'B']], weights: [[1, 2, 3], null, null],
    heights: [[{ rows: 1, weight: 1 }, { rows: 2, weight: 3 }], { rows: [1, 2], joint: [[1, 5], [2, 0], [7, 1]] }, 2],
    topReel: { reel: ['A', 'W', 'C'], weights: [1, 2, 4], covers: [2, 3] },
    paytable: { A: [0, 1, 3], B: [0, 2, 5], C: [0, 0, 4] }, wild: 'W', multiplierStrategy: 'global', globalMultiplier: 3 };
  const session = await waysSession(raw);
  const drawn = [];
  await buildReport(session, { createCanvas: recordingCanvas(drawn), now: new Date('2026-11-04T09:00:00Z') });
  for (const v of ['24', '16', '3', '8,064']) assert.ok(drawn.includes(v), v);
  const top = drawn.indexOf(pair('topReelTotal')[1]);
  assert.ok(top >= 0, 'top reel total label');
  assert.ok(drawn.slice(top, top + 3).includes('7'), 'top reel total value');
  const text = drawn.join(' ');
  for (const k of ['waysWeightsNote', 'globalPayNote', 'waysWildNote']) assert.ok(text.includes(pair(k)[1].split(' ').slice(0, 6).join(' ')), k);
});

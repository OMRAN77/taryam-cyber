// The whole-round distribution, the max-win cap and the session funnel in the signed
// report: report.json (summary, not the pmf), the manifest's settings and references,
// the Verify tab's headline figures and the text page. The game is European roulette
// on red, so every number has a hand or binomial value: the round pays 2 bets with
// probability 18/37, a cap of 1x keeps 18/37 of RTP 36/37, and after 1000 rounds the
// chance to be ahead is P(K > 500) for K ~ Binomial(1000, 18/37).
import test from 'node:test';
import assert from 'node:assert';
import nodeCrypto from 'node:crypto';
import fs from 'fs';
import { buildReport, reportPayload } from '../../lab/report.js';
import { generateKeyPair, ED25519 } from '../../lab/core/sign.js';
import { verifyReportPdf } from '../../lab/core/report-sign.js';
import { readPdfAttachments } from '../../lab/core/pdf-read.js';
import { buildManifest, LAB_VERSION } from '../../lab/core/manifest.js';
import { normalizeModel, canonicalJson } from '../../lab/core/slot-model.js';
import { analyzeExact } from '../../lab/core/slot-exact.js';
import { Fraction } from '../../lab/core/fraction.js';
import { attachRoundDistribution, capStats, topAwardChecks } from '../../lab/core/round-dist.js';
import { sessionFunnel } from '../../lab/core/session.js';
import { prngFromSeed } from '../../lab/core/prng.js';

const enc = new TextEncoder();
const sha = (b) => nodeCrypto.createHash('sha256').update(b).digest('hex');
const raw = JSON.parse(fs.readFileSync(new URL('../../lab/samples/roulette-european.json', import.meta.url), 'utf8'));

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

async function rouletteSession({ forceMonteCarlo = false } = {}) {
  const model = normalizeModel(raw);
  let spins = null;
  const result = attachRoundDistribution(analyzeExact(model, { onEntries: (e) => { spins = e; } }), model, spins);
  const bytes = enc.encode(canonicalJson(raw));
  const cap = capStats(result.round, '1', result.rtp.fraction);
  const th = { inputId: 'model', modelSha256: sha(bytes), result, raw, cap: { M: '1', odds: true, result: { cap, top: { x: cap.M, prob: cap.reach, checks: topAwardChecks(cap.reach) } } } };
  const s = sessionFunnel(result.round.pmf, { rounds: 1000, budget: '50', rtp: result.rtp.fraction, sd: result.distribution.sd, seed: 'report-round', rng: await prngFromSeed('report-round'), forceMonteCarlo });
  return {
    meta: { title: 'Round distribution', auditor: 'test', notes: '' },
    inputs: [{ id: 'model', name: 'roulette.json', kind: 'model', size: bytes.length, sha256: sha(bytes), bytes, mime: 'application/json' }],
    results: { theoretical: th, session: { inputId: 'model', modelSha256: th.modelSha256, options: { rounds: 1000, bet: '2', budget: '100', budgetInBets: '50', seed: 'report-round' }, result: s } },
  };
}

// P(K > 500), K ~ Binomial(1000, 18/37), exactly.
function aheadAfter1000() {
  let c = 1n, num = 0n;
  for (let k = 0; k <= 1000; k++) {
    if (k > 500) num += c * 18n ** BigInt(k) * 19n ** BigInt(1000 - k);
    c = (c * BigInt(1000 - k)) / BigInt(k + 1);
  }
  return new Fraction(num, 37n ** 1000n).toNumber();
}

test('report.json carries the round summary, the cap and the session; the manifest names their settings', async () => {
  const session = await rouletteSession();
  const text = canonicalJson(reportPayload({ ...session, signer: null }, '2026-11-04T00:00:00Z'));
  assert.ok(!text.includes('undefined'));
  const p = JSON.parse(text);
  const rd = p.results.theoretical.roundDistribution;
  assert.strictEqual(rd.method, 'exact');
  assert.strictEqual(rd.pmf.cells, 2); // 0 and 2 bets: the pmf itself is not copied
  assert.ok(!('entries' in rd.pmf) && !('mgf' in rd));
  assert.strictEqual(rd.maxWin.fraction, '18/37');
  const cap = p.results.theoretical.maxWinCap;
  assert.deepStrictEqual([cap.M, cap.oddsChecks, cap.cap.rtpCapped.fraction, cap.cap.lost.fraction], ['1', true, '18/37', '18/37']);
  assert.deepStrictEqual([cap.top.checks.gli19.pass, cap.top.checks.pa.pass, cap.top.checks.gli19.unverified], [true, true, true]);
  assert.ok(Math.abs(p.results.session.pAhead - aheadAfter1000()) < 1e-12);
  assert.strictEqual(p.results.session.expectedLossBets.fraction, '1000/37');
  const m = buildManifest({ ...session, signer: null });
  assert.strictEqual(m.lab.version, LAB_VERSION);
  assert.deepStrictEqual(m.parameters.roundDistribution, { input: 'model', method: 'exact', grid: null, gridLimit: null, aliasBound: 0, noiseFloor: 0, checkTolerance: 1e-9, error: null, maxWinCap: '1', oddsChecks: true });
  assert.deepStrictEqual(m.parameters.session.method, 'fft');
  assert.strictEqual(m.parameters.session.ruinMethod, 'dp');
  const ids = m.references.map((r) => r.id);
  assert.ok(ids.includes('GLI-19 v3.0') && ids.includes('58 Pa. Code 461a.7'), 'odds rules cited');
  assert.ok(m.references.filter((r) => /GLI-19|Pa\. Code/.test(r.id)).every((r) => /unverified/.test(r.usedFor)));
  assert.ok(!ids.includes('Vose 1991') && !ids.includes('xoshiro128** 1.1'), 'no Monte Carlo was used');
  // With Monte Carlo, the generator and the alias method are cited.
  const mc = await rouletteSession({ forceMonteCarlo: true });
  const ids2 = buildManifest({ ...mc, signer: null }).references.map((r) => r.id);
  assert.ok(ids2.includes('Vose 1991') && ids2.includes('xoshiro128** 1.1'));
});

test('signed report with the round distribution and the session verifies; the Verify tab reads both', async () => {
  const session = await rouletteSession();
  const key = { ...(await generateKeyPair({ algorithms: [ED25519] })), storage: 'persistent' };
  const r = await buildReport(session, { createCanvas: stubCanvas, signer: key, now: new Date('2026-11-04T09:00:00Z') });
  const v = await verifyReportPdf(r.bytes);
  assert.strictEqual(v.status, 'valid');
  const fig = Object.fromEntries(v.report.figures.map((f) => [f.section, f]));
  assert.deepStrictEqual(v.report.figures.map((f) => f.section), ['theoretical', 'round', 'session']);
  // Top win 2x with probability 18/37: once every 37/18 = 2.06 rounds, shown rounded.
  assert.deepStrictEqual(fig.round, { section: 'round', value: '2×', oneIn: '2' });
  assert.strictEqual(fig.session.value, (aheadAfter1000() * 100).toFixed(4) + '%');
  assert.strictEqual(fig.session.rounds, 1000);
  const report = JSON.parse(new TextDecoder().decode(readPdfAttachments(r.bytes).attachments.find((a) => a.name === 'report.json').data));
  assert.strictEqual(report.results.session.options.bet, '2');
  // The text page (PDF text operators, uncompressed; lines wrap at 100 characters)
  // states the figures.
  const pdfText = [...Buffer.from(r.bytes).toString('latin1').matchAll(/\(((?:\\.|[^\\)])*)\) Tj/g)]
    .map((m) => m[1].replace(/\\(.)/g, '$1')).join(' ').replace(/\s+/g, ' ');
  assert.match(pdfText, /Whole-round distribution \(exact fractions\)/);
  assert.match(pdfText, /Max-win cap 1x per round: RTP 48\.6486%/); // 18/37
  assert.match(pdfText, /Session funnel: 1000 rounds at 2, budget 100 \(exact, FFT\): expected loss 54\.05/); // 2 * 1000/37
  assert.match(pdfText, /Rules unverified; not a regulatory finding/);
});

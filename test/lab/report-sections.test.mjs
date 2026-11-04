// A signed report that holds the sections of every merged lab branch: provably fair
// v2 (an operator adapter), the distribution tests, the outcome tables (LUT) and a
// weighted model. report.json must stay valid JSON, the manifest must name what each
// analysis ran with, and the Verify tab's headline figures must read each section.
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
import { prngFromSeed, PRNG_DESCRIPTION } from '../../lab/core/prng.js';
import { selfTest, listAdapters } from '../../lab/core/pf/registry.js';
import { auditCsv } from '../../lab/core/pf/audit.js';
import { makeSample } from '../../lab/core/pf/sample.js';
import { analyzeLutFiles, makeSampleLut } from '../../lab/core/lut.js';
import { auditDistribution, examplePmf, pmfCsv, parsePmfCsv, samplePmfLog } from '../../lab/core/audit-stats.js';
import { parsePlayLog } from '../../lab/core/actual.js';
import { desertGoldWeighted } from '../../lab/samples.js';

const enc = new TextEncoder();
const sha = (b) => nodeCrypto.createHash('sha256').update(b).digest('hex');
const input = (id, name, kind, bytes, mime = 'text/csv') => ({ id, name, kind, size: bytes.length, sha256: sha(bytes), bytes, mime });

// Same stand-in canvas as report-sign.test.mjs.
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

// Deterministic bytes for the provably-fair sample.
function seededBytes(seed) {
  let counter = 0;
  return (n) => {
    const out = new Uint8Array(n);
    for (let i = 0; i < n; i += 32) out.set(nodeCrypto.createHash('sha256').update(seed + ':' + counter++).digest().subarray(0, Math.min(32, n - i)), i);
    return out;
  };
}

async function mergedSession() {
  const inputs = [], results = {};
  // Weighted model (P0-5).
  const modelBytes = enc.encode(canonicalJson(desertGoldWeighted));
  inputs.push(input('model', 'desert-gold-weighted.json', 'model', modelBytes, 'application/json'));
  results.theoretical = { inputId: 'model', modelSha256: sha(modelBytes), result: analyzeExact(normalizeModel(desertGoldWeighted)), raw: desertGoldWeighted };
  // Distribution tests (P0-9): a log from the 94% version against the 96% and 94% ones.
  const log = enc.encode(samplePmfLog(examplePmf(0.94), 3000, await prngFromSeed('report-sections-log')));
  inputs.push(input('playlog', 'versions-log.csv', 'csv', log));
  const pmfs = [0.96, 0.94].map((rtp, i) => {
    const bytes = enc.encode(pmfCsv(examplePmf(rtp)));
    inputs.push(input('pmf-' + i, `version-${rtp * 100}.csv`, 'csv', bytes));
    return parsePmfCsv(new TextDecoder().decode(bytes), `RTP ${rtp * 100}%`);
  });
  const options = { refIndex: 0, alpha: 0.01, seed: 'report-sections', declaredRtp: 0.96, referenceRtp: null, sigma: null, sigmaSource: 'input', maxWin: 5000, maxWinSource: 'input', gap: 0.02, mode: '' };
  const dist = auditDistribution(parsePlayLog(new TextDecoder().decode(log)), pmfs, options, await prngFromSeed(options.seed));
  results.distTests = {
    inputId: 'playlog', inputIds: ['pmf-0', 'pmf-1'], options,
    candidates: pmfs.map((p, i) => ({ label: p.label, kind: 'csv', inputId: 'pmf-' + i })),
    result: { ...dist, seed: options.seed, generator: PRNG_DESCRIPTION },
  };
  // Provably fair v2 (P0-10): the Stake adapter's own sample.
  const s = makeSample('stake', { rounds: 300, rand: seededBytes('report-sections-pf'), start: Date.UTC(2026, 10, 1) });
  inputs.push(input('fair', s.name, 'csv', enc.encode(s.text)));
  const adapter = listAdapters(selfTest()).find((a) => a.key === s.key);
  results.fair = { mode: 'adapter', inputId: 'fair', adapter, options: s.options, result: auditCsv(s.text, s.key, s.options), ms: 1 };
  // Outcome tables (P0-7).
  const lutFiles = makeSampleLut();
  for (const f of lutFiles) inputs.push(input('lut:' + f.name, f.name, f.name.endsWith('.json') ? 'json' : 'csv', enc.encode(f.text)));
  results.lut = { inputIds: lutFiles.map((f) => 'lut:' + f.name), result: analyzeLutFiles(lutFiles) };
  return { meta: { title: 'Merged sections', auditor: 'test', notes: '' }, inputs, results };
}

test('canonicalJson writes valid JSON when a value is undefined (left out, or null in an array)', () => {
  const text = canonicalJson({ b: [1, undefined], a: undefined, c: { d: undefined, e: 2n } });
  assert.strictEqual(text, '{"b":[1,null],"c":{"e":"2"}}');
  assert.deepStrictEqual(JSON.parse(text), { b: [1, null], c: { e: '2' } });
  // Values without undefined are written as before (the model fingerprints do not move).
  assert.strictEqual(canonicalJson({ z: [1, 'x', null, true], a: { c: 1, b: 2 } }), '{"a":{"b":2,"c":1},"z":[1,"x",null,true]}');
});

test('manifest: a provably-fair v2 run is named by its adapter, and every section lists its settings', async () => {
  const session = await mergedSession();
  const m = buildManifest({ ...session, signer: null });
  assert.deepStrictEqual(m.parameters.fair, { input: 'fair', mode: 'adapter', adapter: { key: 'stake@v1', id: 'stake', version: 'v1' }, options: session.results.fair.options });
  assert.deepStrictEqual(m.parameters.distTests, { input: 'playlog', inputs: ['pmf-0', 'pmf-1'], options: session.results.distTests.options, generator: PRNG_DESCRIPTION });
  assert.deepStrictEqual(m.parameters.lut.inputs, session.results.lut.inputIds);
  assert.match(m.parameters.lut.rgsProfile.commit, /^[0-9a-f]{40}$/);
  const ids = m.references.map((r) => r.id);
  assert.ok(ids.includes('xoshiro128** 1.1'), 'the distribution tests use the seeded generator');
  assert.ok(ids.includes('Stake Engine math-sdk'));
  // A custom-mode run keeps its scheme.
  const custom = buildManifest({ inputs: [], results: { fair: { inputId: 'fair', scheme: 'hmac', options: {} } }, signer: null });
  assert.deepStrictEqual(custom.parameters.fair, { input: 'fair', scheme: 'hmac', options: {} });
  // report.json text is valid JSON with no undefined left in it.
  const text = canonicalJson(reportPayload({ ...session, signer: null }, '2026-11-04T00:00:00Z'));
  assert.ok(!text.includes('undefined'));
  const payload = JSON.parse(text);
  assert.deepStrictEqual(Object.keys(payload.results).sort(), ['actual', 'distTests', 'fair', 'lut', 'rng', 'theoretical', 'montecarlo'].filter((k) => session.results[k]).sort());
  assert.strictEqual(payload.results.theoretical.model.weighted, true);
});

test('signed report with every merged section verifies, and the Verify tab reads each section', async () => {
  const session = await mergedSession();
  const key = { ...(await generateKeyPair({ algorithms: [ED25519] })), storage: 'persistent' };
  const r = await buildReport(session, { createCanvas: stubCanvas, signer: key, now: new Date('2026-11-04T09:00:00Z') });
  const v = await verifyReportPdf(r.bytes);
  assert.strictEqual(v.status, 'valid', JSON.stringify(v.checks.filter((c) => !c.ok)));
  const report = JSON.parse(new TextDecoder().decode(readPdfAttachments(r.bytes).attachments.find((a) => a.name === 'report.json').data));
  assert.strictEqual(report.manifest.parameters.fair.mode, 'adapter');
  const fig = Object.fromEntries(v.report.figures.map((f) => [f.section, f]));
  assert.deepStrictEqual(v.report.figures.map((f) => f.section), ['theoretical', 'distTests', 'fair', 'lut']);
  assert.strictEqual(fig.theoretical.value, '95.743252%');
  assert.deepStrictEqual(fig.fair, { section: 'fair', value: 'stake@v1', verdict: 'PASS', pass: true });
  assert.strictEqual(fig.distTests.value, session.results.distTests.result.fit.verdict);
  assert.strictEqual(fig.distTests.rounds, 3000);
  assert.strictEqual(fig.lut.value, session.results.lut.result.modes.map((m) => `${m.name}: ${m.rtp.percent}%`).join(' · '));
  // Every input is attached and matches the manifest.
  assert.ok(v.files.every((f) => f.status === 'match'), JSON.stringify(v.files.filter((f) => f.status !== 'match')));
});

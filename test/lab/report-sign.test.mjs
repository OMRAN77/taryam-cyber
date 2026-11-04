// Signed report PDFs end to end, in Node: lab/report.js builds the PDF (with a stub
// canvas), core/report-sign.js seals and checks it. Every expected hash and
// signature verdict is recomputed independently with node:crypto (SHA-256,
// Ed25519 / ECDSA verify) from bytes cut out of the PDF by hand-located offsets.
import test from 'node:test';
import assert from 'node:assert';
import nodeCrypto from 'node:crypto';
import { buildReport, reportPayload } from '../../lab/report.js';
import { generateKeyPair, ED25519, ECDSA_P256, fromBase64 } from '../../lab/core/sign.js';
import { verifyReportPdf, sealReportPdf, signaturePlaceholder, SIGNATURE_RESERVED_BYTES } from '../../lab/core/report-sign.js';
import { PdfBuilder } from '../../lab/core/pdf.js';
import { readPdfAttachments, PdfReadError } from '../../lab/core/pdf-read.js';
import { buildManifest, planAttachments, LAB_VERSION, ATTACH_LIMIT_BYTES } from '../../lab/core/manifest.js';
import { normalizeModel, canonicalJson } from '../../lab/core/slot-model.js';
import { analyzeExact } from '../../lab/core/slot-exact.js';
import { simulate } from '../../lab/core/montecarlo.js';
import { prngFromSeed, PRNG_DESCRIPTION } from '../../lab/core/prng.js';
import { rouletteEuropean } from '../../lab/samples.js';

const enc = new TextEncoder();
const sha = (b) => nodeCrypto.createHash('sha256').update(b).digest('hex');

// Canvas stand-in: text is measured as 12 px per character; each page encodes to a
// different fake JPEG so page bytes are distinct.
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

function input(id, name, kind, bytes, mime = 'application/octet-stream') {
  return { id, name, kind, size: bytes.length, sha256: sha(bytes), bytes, mime };
}

// A session like the page builds: exact roulette analysis, a short Monte Carlo run,
// and a binary data file covering every byte value.
async function sampleSession() {
  const modelBytes = enc.encode(canonicalJson(rouletteEuropean));
  const modelSha256 = sha(modelBytes);
  const result = analyzeExact(normalizeModel(rouletteEuropean));
  const sim = simulate(normalizeModel(rouletteEuropean), await prngFromSeed('signed-report-test'), 2000);
  const bin = new Uint8Array(4096);
  for (let i = 0; i < bin.length; i++) bin[i] = (i * 7) & 255;
  return {
    meta: { title: 'Signed report test / تقرير موقّع', auditor: 'Test Lab', notes: '' },
    inputs: [
      input('model', 'european-roulette.json', 'model', modelBytes, 'application/json'),
      input('rng', 'numbers.bin', 'binary', bin),
      input('fair', 'rounds.csv', 'csv', enc.encode('server_seed,client_seed,nonce,result\n'), 'text/csv'),
    ],
    results: {
      theoretical: { inputId: 'model', modelSha256, result, raw: rouletteEuropean },
      montecarlo: { modelSha256, seed: 'signed-report-test', spins: 2000, generator: PRNG_DESCRIPTION, result: sim, resultSha256: 'f'.repeat(64), exactRtp: result.rtp.value },
    },
  };
}

async function signedReport(alg = ED25519, opts = {}) {
  const key = { ...(await generateKeyPair({ algorithms: [alg] })), storage: opts.storage || 'persistent' };
  const session = opts.session || await sampleSession();
  const r = await buildReport(session, { createCanvas: stubCanvas, signer: key, now: new Date('2026-11-04T08:30:00.123Z'), ...opts.build });
  return { key, session, ...r };
}

const attachment = (bytes, name) => readPdfAttachments(bytes).attachments.find((a) => a.name === name);
const flip = (bytes, at, mask = 0x01) => { const b = bytes.slice(); b[at] ^= mask; return b; };
const checkOf = (v, id) => (v.checks.find((c) => c.id === id) || {}).ok;

for (const alg of [ED25519, ECDSA_P256]) {
  test(`${alg}: a fresh report verifies, and node:crypto agrees with every part of report.sig`, async () => {
    const r = await signedReport(alg);
    const v = await verifyReportPdf(r.bytes);
    assert.strictEqual(v.status, 'valid', JSON.stringify(v.checks));
    assert.ok(v.checks.every((c) => c.ok === true), JSON.stringify(v.checks));
    assert.deepStrictEqual(v.files.map((f) => [f.name, f.status]), [['european-roulette.json', 'match'], ['numbers.bin', 'match'], ['rounds.csv', 'match']]);
    assert.strictEqual(v.signer.alg, alg);
    assert.strictEqual(v.signer.fingerprint, sha(r.key.spki));
    assert.strictEqual(v.signer.storage, 'persistent');

    // Independent checks on the raw bytes.
    const json = attachment(r.bytes, 'report.json').data;
    const sigFile = attachment(r.bytes, 'report.sig');
    const text = new TextDecoder().decode(sigFile.data);
    assert.strictEqual(sigFile.length, SIGNATURE_RESERVED_BYTES);
    assert.match(text, /^\{.*\} *$/s);
    const sig = JSON.parse(text);
    assert.strictEqual(sig.signedFileSha256, sha(json));
    assert.strictEqual(sha(json), r.digest);
    assert.strictEqual(v.report.id, 'TRL-20261104-' + sha(json).slice(0, 8).toUpperCase());
    assert.strictEqual(v.report.id, r.reportId);
    const pub = nodeCrypto.createPublicKey({ key: Buffer.from(fromBase64(sig.publicKey)), format: 'der', type: 'spki' });
    const nodeVerify = (msg, s) => (alg === ED25519 ? nodeCrypto.verify(null, msg, pub, s) : nodeCrypto.verify('sha256', msg, { key: pub, dsaEncoding: 'ieee-p1363' }, s));
    assert.ok(nodeVerify(json, fromBase64(sig.signature)), 'report.json signature');
    const st = sig.pdf.statement;
    assert.strictEqual(st.sigOffset, sigFile.offset);
    assert.strictEqual(st.pdfSize, r.bytes.length);
    const blanked = Buffer.from(r.bytes);
    blanked.fill(0x20, sigFile.offset, sigFile.offset + sigFile.length);
    assert.strictEqual(st.pdfSha256, sha(blanked), 'PDF hash with report.sig blanked');
    // The signed statement is the canonical JSON: keys in sorted order, no spaces.
    const statementText = '{' + Object.keys(st).sort().map((k) => JSON.stringify(k) + ':' + JSON.stringify(st[k])).join(',') + '}';
    assert.ok(nodeVerify(Buffer.from(statementText), fromBase64(sig.pdf.signature)), 'PDF statement signature');

    // report.json carries the signer and the manifest.
    const report = JSON.parse(new TextDecoder().decode(json));
    assert.deepStrictEqual(report.signer, { alg, keyFingerprint: sha(r.key.spki), keyStorage: 'persistent', file: 'report.sig' });
    assert.strictEqual(report.manifest.lab.version, LAB_VERSION);
    assert.deepStrictEqual(report.manifest.inputs.map((i) => [i.name, i.sha256, i.attachment]), r.session.inputs.map((i) => [i.name, sha(i.bytes), i.name]));
    assert.strictEqual(report.manifest.model.sha256, sha(enc.encode(canonicalJson(rouletteEuropean))));
    assert.deepStrictEqual(report.manifest.montecarlo, { generator: PRNG_DESCRIPTION, seed: 'signed-report-test', spins: 2000, modelSha256: report.manifest.model.sha256, resultSha256: 'f'.repeat(64) });
    assert.deepStrictEqual(report.manifest.references.map((x) => x.id), ['FIPS 180-4', 'PDF 1.4', alg === ED25519 ? 'RFC 8032' : 'FIPS 186-5', 'RFC 5280', 'xoshiro128** 1.1']);
    assert.deepStrictEqual(report.manifest.deviations, []);

    // The text page states the signature and the fingerprint (PDF strings escape parentheses).
    const latin = Buffer.from(r.bytes).toString('latin1');
    assert.ok(latin.includes(alg === ED25519 ? '(Signature:      Ed25519 \\(RFC 8032\\)' : '(Signature:      ECDSA P-256 / SHA-256 \\(FIPS 186-5\\)'));
    assert.ok(latin.includes(sha(r.key.spki).toUpperCase().match(/.{4}/g).join(' ')));
  });
}

test('one changed byte anywhere in the PDF makes the report invalid (or unreadable), never valid', async () => {
  const r = await signedReport(ED25519);
  const atts = readPdfAttachments(r.bytes).attachments;
  const json = atts.find((a) => a.name === 'report.json');
  const bin = atts.find((a) => a.name === 'numbers.bin');
  const sigFile = atts.find((a) => a.name === 'report.sig');
  const latin = Buffer.from(r.bytes).toString('latin1');
  const firstImage = latin.indexOf('/DCTDecode');
  const imageData = latin.indexOf('stream\n', firstImage) + 7;

  // In report.json: its signature and the PDF signature both fail.
  let v = await verifyReportPdf(flip(r.bytes, json.offset + 20));
  assert.strictEqual(v.status, 'invalid');
  assert.strictEqual(checkOf(v, 'reportSignature'), false);
  assert.strictEqual(checkOf(v, 'reportHash'), false);
  assert.strictEqual(checkOf(v, 'pdfUnchanged'), false);

  // In an attached input: report.json is intact, the file and the PDF are not.
  v = await verifyReportPdf(flip(r.bytes, bin.offset + 1000));
  assert.strictEqual(v.status, 'invalid');
  assert.strictEqual(checkOf(v, 'reportSignature'), true);
  assert.strictEqual(checkOf(v, 'pdfUnchanged'), false);
  assert.strictEqual(checkOf(v, 'inputsMatch'), false);
  assert.strictEqual(v.files.find((f) => f.name === 'numbers.bin').status, 'mismatch');
  assert.strictEqual(v.dataIntactPdfChanged, true);

  // In a page image, which report.json does not cover: the PDF signature catches it.
  v = await verifyReportPdf(flip(r.bytes, imageData + 500));
  assert.strictEqual(v.status, 'invalid');
  assert.strictEqual(checkOf(v, 'reportSignature'), true);
  assert.strictEqual(checkOf(v, 'pdfUnchanged'), false);
  assert.strictEqual(checkOf(v, 'inputsMatch'), true);

  // In report.sig: a signature character, and a padding space turned into a newline.
  const sigText = new TextDecoder().decode(sigFile.data);
  v = await verifyReportPdf(flip(r.bytes, sigFile.offset + sigText.indexOf('"signature":"') + 20));
  assert.strictEqual(v.status, 'invalid');
  v = await verifyReportPdf(flip(r.bytes, sigFile.offset + sigText.length - 1, 0x20 ^ 0x0a));
  assert.strictEqual(v.status, 'invalid');
  assert.strictEqual(checkOf(v, 'signatureFormat'), false);

  // 160 positions spread over the whole file, the trailer included.
  const positions = Array.from({ length: 160 }, (_, i) => Math.floor((i * (r.bytes.length - 1)) / 159));
  for (const at of positions) {
    for (const mask of [0x01, 0x80]) {
      try {
        const res = await verifyReportPdf(flip(r.bytes, at, mask));
        assert.notStrictEqual(res.status, 'valid', `byte ${at} ^ ${mask} went unnoticed`);
      } catch (e) {
        assert.ok(e instanceof PdfReadError, `byte ${at}: ${e.stack}`);
      }
    }
  }
});

test('a trusted fingerprint must match; a key swapped by someone else is caught', async () => {
  const r = await signedReport(ED25519);
  const fp = sha(r.key.spki);
  let v = await verifyReportPdf(r.bytes, { trustedFingerprint: fp.toUpperCase().match(/.{4}/g).join(' ') });
  assert.strictEqual(v.status, 'valid');
  assert.deepStrictEqual(v.trusted, { fingerprint: fp, match: true });
  const other = await generateKeyPair({ algorithms: [ED25519] });
  v = await verifyReportPdf(r.bytes, { trustedFingerprint: sha(other.spki) });
  assert.strictEqual(v.status, 'wrong-key');
  assert.strictEqual(checkOf(v, 'trustedKey'), false);
  await assert.rejects(verifyReportPdf(r.bytes, { trustedFingerprint: 'abc' }), (e) => e.code === 'bad-fingerprint');

  // Someone re-signs the same PDF with their own key: report.json still names the
  // original signer, so the swap shows.
  const forged = r.bytes.slice();
  const sigFile = attachment(forged, 'report.sig');
  forged.fill(0x20, sigFile.offset, sigFile.offset + sigFile.length);
  await sealReportPdf(forged, sigFile.offset, { ...other, storage: 'persistent' }, attachment(forged, 'report.json').data);
  v = await verifyReportPdf(forged);
  assert.strictEqual(v.status, 'invalid');
  assert.strictEqual(checkOf(v, 'reportSignature'), true);
  assert.strictEqual(checkOf(v, 'pdfUnchanged'), true);
  assert.strictEqual(checkOf(v, 'signerInReport'), false);

  // A whole new report signed by another key is valid on its own: only a trusted
  // fingerprint from elsewhere tells the two signers apart.
  const theirs = await signedReport(ED25519);
  assert.strictEqual((await verifyReportPdf(theirs.bytes)).status, 'valid');
  assert.strictEqual((await verifyReportPdf(theirs.bytes, { trustedFingerprint: fp })).status, 'wrong-key');
});

test('unsigned reports, session keys and browsers without the algorithm are reported as such', async () => {
  const session = await sampleSession();
  const plain = await buildReport(session, { createCanvas: stubCanvas });
  assert.strictEqual(attachment(plain.bytes, 'report.sig'), undefined);
  let v = await verifyReportPdf(plain.bytes);
  assert.strictEqual(v.status, 'unsigned');
  assert.ok(v.files.every((f) => f.status === 'match'));
  assert.strictEqual(v.signer, null);
  v = await verifyReportPdf(flip(plain.bytes, attachment(plain.bytes, 'rounds.csv').offset + 3));
  assert.strictEqual(v.status, 'invalid', 'fingerprints still catch a changed input');

  // A report from before signatures (no manifest): inputs are found by their names.
  const old = new PdfBuilder();
  old.addPage({ lines: [{ text: 'old', x: 40, y: 800 }] });
  const csv = enc.encode('bet,win\n1,2\n');
  old.attach('report.json', enc.encode(JSON.stringify({ format: 'taryam-rtp-lab-report/1', createdAt: '2026-10-01T00:00:00Z', inputs: [{ id: 'playlog', name: 'log.csv', kind: 'csv', size: csv.length, sha256: sha(csv) }], results: {} })));
  old.attach('log.csv', csv);
  v = await verifyReportPdf(old.build());
  assert.strictEqual(v.status, 'unsigned');
  assert.deepStrictEqual(v.files.map((f) => [f.name, f.status]), [['log.csv', 'match']]);
  assert.strictEqual(v.report.id, 'TRL-20261001-' + sha(enc.encode(JSON.stringify({ format: 'taryam-rtp-lab-report/1', createdAt: '2026-10-01T00:00:00Z', inputs: [{ id: 'playlog', name: 'log.csv', kind: 'csv', size: csv.length, sha256: sha(csv) }], results: {} }))).slice(0, 8).toUpperCase());

  const s = await signedReport(ECDSA_P256, { storage: 'session' });
  v = await verifyReportPdf(s.bytes);
  assert.strictEqual(v.status, 'valid');
  assert.strictEqual(v.signer.storage, 'session');
  assert.ok(Buffer.from(s.bytes).toString('latin1').includes('this session only'));

  // Node without Ed25519 (patched for this test): the signature cannot be judged.
  const e = await signedReport(ED25519);
  const subtle = globalThis.crypto.subtle;
  const realImport = subtle.importKey;
  subtle.importKey = function (format, key, alg, ...rest) {
    if ((alg && alg.name) === 'Ed25519') return Promise.reject(Object.assign(new Error('Unrecognized algorithm name'), { name: 'NotSupportedError' }));
    return realImport.call(this, format, key, alg, ...rest);
  };
  try {
    v = await verifyReportPdf(e.bytes);
  } finally {
    subtle.importKey = realImport;
  }
  assert.strictEqual(v.status, 'unverifiable');
  assert.strictEqual(checkOf(v, 'reportSignature'), null);
});

test('inputs over the size limit are listed by SHA-256 only, and can be checked with the original file', async () => {
  const session = await sampleSession();
  // Limit of 2,000 bytes: numbers.bin (4,096) is not attached; the others are.
  const r = await signedReport(ED25519, { session, build: { attachLimit: 2000 } });
  const names = readPdfAttachments(r.bytes).attachments.map((a) => a.name).sort();
  assert.deepStrictEqual(names, ['european-roulette.json', 'report.json', 'report.sig', 'rounds.csv']);
  const report = JSON.parse(new TextDecoder().decode(attachment(r.bytes, 'report.json').data));
  const entry = report.manifest.inputs.find((i) => i.name === 'numbers.bin');
  assert.strictEqual(entry.attachment, null);
  assert.strictEqual(entry.sha256, sha(session.inputs[1].bytes));
  assert.ok(Buffer.from(r.bytes).toString('latin1').includes('numbers.bin \\(binary, 4096 bytes\\) - HASH ONLY'));

  let v = await verifyReportPdf(r.bytes);
  assert.strictEqual(v.status, 'valid');
  assert.strictEqual(v.files.find((f) => f.name === 'numbers.bin').status, 'hash-only');
  v = await verifyReportPdf(r.bytes, { originals: [{ name: 'renamed.bin', bytes: session.inputs[1].bytes }] });
  assert.strictEqual(v.files.find((f) => f.name === 'numbers.bin').status, 'original-match');
  const wrong = session.inputs[1].bytes.slice(); wrong[0] ^= 1;
  v = await verifyReportPdf(r.bytes, { originals: [{ name: 'numbers.bin', bytes: wrong }] });
  assert.strictEqual(v.files.find((f) => f.name === 'numbers.bin').status, 'original-mismatch');
  assert.strictEqual(v.status, 'invalid');
  assert.strictEqual(ATTACH_LIMIT_BYTES, 25 * 1024 * 1024);
});

test('attachment names stay unique; an extra file slipped into the list is flagged', async () => {
  const a = enc.encode('a,b\n1,2\n'), b = enc.encode('x\n');
  const planned = planAttachments([
    input('playlog', 'data.csv', 'csv', a), input('fair', 'data.csv', 'csv', b), input('rng', 'DATA.CSV', 'csv', b), input('model', 'report.json', 'model', a),
  ], { limit: 100 });
  assert.deepStrictEqual(planned.map((p) => p.attachment), ['data.csv', 'fair-data.csv', 'rng-DATA.CSV', 'model-report.json']);

  const session = { meta: { title: '', auditor: '', notes: '' }, inputs: [input('playlog', 'data.csv', 'csv', a), input('fair', 'data.csv', 'csv', b)], results: {} };
  const r = await signedReport(ED25519, { session });
  let v = await verifyReportPdf(r.bytes);
  assert.strictEqual(v.status, 'valid');
  assert.deepStrictEqual(v.files.map((f) => [f.attachment, f.status]), [['data.csv', 'match'], ['fair-data.csv', 'match']]);

  // A PDF sealed by a valid key but carrying a file report.json does not list.
  const key = { ...(await generateKeyPair()), storage: 'persistent' };
  const json = enc.encode(canonicalJson(reportPayload({ ...session, inputs: planAttachments(session.inputs), signer: key }, '2026-11-04T00:00:00Z')));
  const pdf = new PdfBuilder();
  pdf.addPage({ lines: [{ text: 'x', x: 40, y: 800 }] });
  pdf.attach('report.json', json);
  const sigId = pdf.attach('report.sig', signaturePlaceholder());
  pdf.attach('data.csv', a);
  pdf.attach('fair-data.csv', b);
  pdf.attach('extra.exe', Uint8Array.of(0x4d, 0x5a));
  const bytes = pdf.build();
  await sealReportPdf(bytes, pdf.dataOffset(sigId), key, json);
  v = await verifyReportPdf(bytes);
  assert.strictEqual(v.status, 'invalid');
  assert.strictEqual(checkOf(v, 'reportSignature'), true);
  assert.strictEqual(checkOf(v, 'pdfUnchanged'), true);
  assert.strictEqual(checkOf(v, 'noExtraFiles'), false);
  assert.deepStrictEqual(v.files.filter((f) => f.status === 'extra').map((f) => [f.name, f.sha256]), [['extra.exe', sha(Uint8Array.of(0x4d, 0x5a))]]);
});

test('manifest: references and deviations follow the sections present', () => {
  const nist = (ids) => ({ inputId: 'rng', options: { mode: 'binary' }, nist: { twoLevel: false, results: ids.map((id) => ({ id, applicable: true })) } });
  const m = buildManifest({ inputs: [], results: { rng: nist(['overlappingTemplate', 'linearComplexity', 'cumulativeSums']), fair: { inputId: 'fair', scheme: 'hmac', options: {} } }, signer: null });
  assert.deepStrictEqual(m.references.map((x) => x.id), ['FIPS 180-4', 'PDF 1.4', 'NIST SP 800-22 Rev. 1a', 'NIST STS 2.1.2', 'RFC 2104']);
  assert.deepStrictEqual(m.deviations.map((d) => d.id), ['nist-overlapping-exact', 'nist-linear-pi0', 'nist-cusum-bounds', 'nist-family-holm']);
  assert.deepStrictEqual(m.parameters.rng, { input: 'rng', options: { mode: 'binary' } });
  // A short sample where the 1,000,000-bit tests did not run: only the family rule applies.
  const short = buildManifest({ inputs: [], results: { rng: nist([]) }, signer: null });
  assert.deepStrictEqual(short.deviations.map((d) => d.id), ['nist-family-holm']);
  const two = buildManifest({ inputs: [], results: { rng: { ...nist([]), nist: { twoLevel: true, results: [] } } }, signer: null });
  assert.ok(two.deviations.some((d) => d.id === 'nist-proportion-bound'));
  // The payload of a session without a signer has signer: null and still a manifest.
  const p = reportPayload({ meta: {}, inputs: [], results: {}, signer: null }, '2026-11-04T00:00:00Z');
  assert.strictEqual(p.signer, null);
  assert.strictEqual(p.manifest.lab.version, LAB_VERSION);
});

// report.sig: how a lab report PDF is signed, and how one is checked.
//
// report.sig is canonical JSON (keys sorted, no whitespace) padded with spaces to a
// fixed size, embedded in the PDF next to report.json:
//   format            'taryam-rtp-lab-signature/1'
//   alg               'Ed25519' or 'ECDSA-P256-SHA256'
//   publicKey         the signer's public key, SPKI DER, base64
//   keyFingerprint    SHA-256 of the SPKI bytes, hex
//   signedFile        'report.json'
//   signedFileSha256  SHA-256 of report.json, hex
//   signature         signature of the exact bytes of report.json, base64
//   pdf.statement     { format: 'taryam-rtp-lab-pdf/1', pdfSha256, pdfSize,
//                       reportSha256, sigOffset, sigLength }
//   pdf.signature     signature of the canonical JSON of pdf.statement, base64
// pdfSha256 is the SHA-256 of the whole PDF with report.sig's own bytes (sigLength
// bytes at sigOffset) replaced by spaces, so the second signature covers every
// other byte of the file: pages, attachments, structure. report.sig's own bytes are
// pinned by the strict reading below: exactly these keys, canonical JSON, the
// fingerprint of the key it carries, and signatures in their one accepted form
// (core/sign.js), so without the private key no byte of it can change either.
import { canonicalJson } from './slot-model.js';
import { signBytes, verifyBytes, toBase64, fromBase64, keyFingerprint, toHex, sha256, parseTrustedFingerprint, ALGORITHM_INFO } from './sign.js';
import { readPdfAttachments, PdfReadError } from './pdf-read.js';
import { REPORT_FILE, SIGNATURE_FILE, reportIdFor } from './manifest.js';

export const SIGNATURE_FORMAT = 'taryam-rtp-lab-signature/1';
export const PDF_STATEMENT_FORMAT = 'taryam-rtp-lab-pdf/1';
export const SIGNATURE_RESERVED_BYTES = 2048;
const SPACE = 0x20;
const enc = new TextEncoder();
const hashHex = async (bytes) => toHex(await sha256(bytes));

export function signaturePlaceholder() {
  return new Uint8Array(SIGNATURE_RESERVED_BYTES).fill(SPACE);
}

// pdfBytes was built with signaturePlaceholder() as the data of report.sig, starting
// at sigOffset. Signs report.json and the PDF, then writes report.sig into the
// placeholder (in place). Returns the report.sig object.
export async function sealReportPdf(pdfBytes, sigOffset, key, jsonBytes) {
  const region = pdfBytes.subarray(sigOffset, sigOffset + SIGNATURE_RESERVED_BYTES);
  if (region.length !== SIGNATURE_RESERVED_BYTES || region.some((b) => b !== SPACE)) throw new Error('report.sig placeholder not found at ' + sigOffset);
  const reportSha256 = await hashHex(jsonBytes);
  const statement = {
    format: PDF_STATEMENT_FORMAT, pdfSha256: await hashHex(pdfBytes), pdfSize: pdfBytes.length,
    reportSha256, sigOffset, sigLength: SIGNATURE_RESERVED_BYTES,
  };
  const sig = {
    format: SIGNATURE_FORMAT,
    alg: key.alg,
    publicKey: toBase64(key.spki),
    keyFingerprint: key.fingerprint,
    signedFile: REPORT_FILE,
    signedFileSha256: reportSha256,
    signature: toBase64(await signBytes(key, jsonBytes)),
    pdf: { statement, signature: toBase64(await signBytes(key, enc.encode(canonicalJson(statement)))) },
  };
  const text = enc.encode(canonicalJson(sig));
  if (text.length > SIGNATURE_RESERVED_BYTES) throw new Error('report.sig is larger than its reserved space');
  region.set(text);
  return sig;
}

// The exact key sets of report.sig, of its pdf part and of the signed statement.
const SIG_KEYS = 'alg,format,keyFingerprint,pdf,publicKey,signature,signedFile,signedFileSha256';
const PDF_KEYS = 'signature,statement';
const STATEMENT_KEYS = 'format,pdfSha256,pdfSize,reportSha256,sigLength,sigOffset';
const hasKeys = (o, keys) => !!o && typeof o === 'object' && !Array.isArray(o) && Object.keys(o).sort().join(',') === keys;
const HEX64 = /^[0-9a-f]{64}$/;
const count = (n) => Number.isSafeInteger(n) && n >= 0;

// Strict reading: the bytes must be exactly the canonical JSON of an object with
// exactly the keys above, followed by spaces; anything else is refused (an extra
// key would be text no signature covers).
function parseSignatureFile(file) {
  if (file.encoded) return null;
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(file.data); } catch (e) { return null; }
  const body = text.replace(/ +$/, '');
  let obj;
  try { obj = JSON.parse(body); } catch (e) { return null; }
  if (!hasKeys(obj, SIG_KEYS) || canonicalJson(obj) !== body) return null;
  if (obj.format !== SIGNATURE_FORMAT || !ALGORITHM_INFO[obj.alg] || obj.signedFile !== REPORT_FILE) return null;
  if (!HEX64.test(obj.keyFingerprint) || !HEX64.test(obj.signedFileSha256)) return null;
  const pdf = obj.pdf, st = hasKeys(pdf, PDF_KEYS) ? pdf.statement : null;
  if (!hasKeys(st, STATEMENT_KEYS) || typeof st.format !== 'string' || !HEX64.test(st.pdfSha256) || !HEX64.test(st.reportSha256)
    || !count(st.pdfSize) || !count(st.sigOffset) || !count(st.sigLength)) return null;
  const spki = fromBase64(obj.publicKey), signature = fromBase64(obj.signature), pdfSignature = fromBase64(pdf.signature);
  if (!spki || !signature || !pdfSignature) return null;
  return { obj, spki, signature, pdfSignature, statement: st };
}

async function pdfUnchanged(bytes, sigFile, s, reportSha256) {
  const st = s.statement;
  const ok = await verifyBytes({ alg: s.obj.alg, spki: s.spki, signature: s.pdfSignature, bytes: enc.encode(canonicalJson(st)) });
  if (!ok) return false;
  if (st.format !== PDF_STATEMENT_FORMAT || st.sigOffset !== sigFile.offset || st.sigLength !== sigFile.length || st.pdfSize !== bytes.length || st.reportSha256 !== reportSha256) return false;
  const copy = bytes.slice();
  copy.fill(SPACE, sigFile.offset, sigFile.offset + sigFile.length);
  return (await hashHex(copy)) === st.pdfSha256;
}

const pct = (v) => (typeof v === 'number' ? (v * 100).toFixed(4) + '%' : '—');

// The headline figures, as report.json states them, to compare with the pages.
function figures(report) {
  const r = (report && report.results) || {};
  const out = [];
  if (r.theoretical && r.theoretical.rtp) out.push({ section: 'theoretical', value: r.theoretical.rtp.percent + '%', ...(r.theoretical.scope ? { scope: r.theoretical.scope } : {}) });
  if (r.actual) out.push({ section: 'actual', value: pct(r.actual.rtp), rounds: r.actual.rounds ?? null, verdict: (r.actual.declared && r.actual.declared.verdict) || null });
  if (r.distTests) out.push({ section: 'distTests', value: (r.distTests.fit && r.distTests.fit.verdict) || null, rounds: r.distTests.rounds ?? null });
  if (r.rng) out.push({ section: 'rng', value: r.rng.bits ?? null, pass: r.rng.family ? !!r.rng.family.pass : null });
  // Provably fair v2 runs (an operator adapter) carry a verdict code, not ok/scheme.
  if (r.fair && r.fair.mode === 'adapter') {
    const code = (r.fair.verdict && r.fair.verdict.code) || null;
    const a = r.fair.adapter || {};
    out.push({ section: 'fair', value: a.key || null, verdict: code, pass: code === null ? null : code === 'PASS' });
  } else if (r.fair) out.push({ section: 'fair', value: r.fair.scheme || null, pass: !!r.fair.ok });
  if (r.montecarlo && r.montecarlo.result) out.push({ section: 'montecarlo', value: pct(r.montecarlo.result.rtp), spins: r.montecarlo.spins ?? null, ...(r.montecarlo.result.scope ? { scope: r.montecarlo.result.scope } : {}) });
  if (r.lut && Array.isArray(r.lut.modes)) out.push({ section: 'lut', value: r.lut.modes.map((m) => `${m.name}: ${m.rtp && m.rtp.percent}%`).join(' · ') || null });
  return out;
}

// Checks a report PDF. Throws PdfReadError when the file cannot be read or holds no
// report.json, and SignError for a malformed trusted fingerprint. Otherwise returns
// { status, checks, files, signer, trusted, report, pdf }, where status is
//   valid         every check passed;
//   invalid       something changed after signing, a signature is wrong, or
//                 report.json names a signature that is no longer there;
//   wrong-key     a trusted fingerprint was given and the report is not signed
//                 with that key (signed with another key, or not signed at all);
//   unsigned      no report.sig, and report.json names none (fingerprints only,
//                 which do not show who issued it);
//   unverifiable  this browser cannot check the signature algorithm.
// The key's fingerprint is always computed from the public key in report.sig, never
// taken from what report.sig states.
// originals: [{ name, bytes }], files the user adds to check inputs that are not
// attached (hash only). One that does not match is shown on its own (check
// originalsMatch, file status original-mismatch): it says the file is not the input
// the report covers, not that the report changed, so the status does not depend on it.
export async function verifyReportPdf(input, { trustedFingerprint = null, originals = [] } = {}) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const trusted = parseTrustedFingerprint(trustedFingerprint);
  const pdf = readPdfAttachments(bytes);
  const byName = new Map(), duplicates = [];
  for (const a of pdf.attachments) { if (byName.has(a.name)) duplicates.push(a); else byName.set(a.name, a); }
  const reportFile = byName.get(REPORT_FILE);
  if (!reportFile) {
    throw new PdfReadError('not-lab-report', 'هذا الـPDF لا يحوي report.json: ليس تقريرًا من المختبر، أو أُزيلت مرفقاته', 'This PDF has no report.json: it is not a lab report, or its attachments were removed');
  }

  const checks = [];
  const check = (id, ok) => { checks.push({ id, ok }); return ok; };
  const reportSha256 = await hashHex(reportFile.data);
  let report = null;
  if (!reportFile.encoded) {
    try { report = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(reportFile.data)); } catch (e) { report = null; }
  }
  if (!report || typeof report !== 'object' || !/^taryam-rtp-lab-report\//.test(report.format)) report = null;
  check('reportJson', !!report);

  const sigFile = byName.get(SIGNATURE_FILE);
  // report.json says the report was signed: report.sig must be there.
  if (report && report.signer) check('signaturePresent', !!sigFile);
  let s = null, fingerprint = null, unsupported = false, reportSigned = null, pdfIntact = null;
  if (sigFile) {
    s = parseSignatureFile(sigFile);
    if (check('signatureFormat', !!s)) {
      fingerprint = await keyFingerprint(s.spki);
      check('keyFingerprint', fingerprint === s.obj.keyFingerprint);
      check('reportHash', s.obj.signedFileSha256 === reportSha256);
      try {
        reportSigned = check('reportSignature', await verifyBytes({ alg: s.obj.alg, spki: s.spki, signature: s.signature, bytes: reportFile.data }));
        pdfIntact = check('pdfUnchanged', await pdfUnchanged(bytes, sigFile, s, reportSha256));
      } catch (e) {
        if (e.code !== 'unsupported') throw e;
        unsupported = true;
        check('reportSignature', null);
        check('pdfUnchanged', null);
      }
      check('signerInReport', !!(report && report.signer && report.signer.alg === s.obj.alg && report.signer.keyFingerprint === fingerprint));
    }
  }

  // Inputs: listed in the manifest (older reports: the inputs list, attached by name).
  const listed = report && report.manifest && Array.isArray(report.manifest.inputs) ? report.manifest.inputs
    : report && Array.isArray(report.inputs) ? report.inputs.map((i) => ({ ...i, attachment: i.name })) : [];
  const given = [];
  for (const o of originals || []) {
    const b = o.bytes instanceof Uint8Array ? o.bytes : new Uint8Array(o.bytes);
    given.push({ name: o.name, size: b.length, sha256: await hashHex(b) });
  }
  const files = [];
  const covered = new Set([REPORT_FILE, SIGNATURE_FILE]);
  for (const e of listed) {
    const row = { name: e.name, attachment: e.attachment || null, size: e.size, expected: e.sha256, sha256: null, status: null };
    if (!e.attachment) {
      const same = given.find((g) => g.sha256 === e.sha256);
      const named = given.find((g) => g.name === e.name);
      if (same) Object.assign(row, { sha256: same.sha256, status: 'original-match' });
      else if (named) Object.assign(row, { sha256: named.sha256, status: 'original-mismatch' });
      else row.status = 'hash-only';
    } else {
      covered.add(e.attachment);
      const a = byName.get(e.attachment);
      if (!a) row.status = 'missing';
      else if (a.encoded) row.status = 'encoded';
      else {
        row.sha256 = await hashHex(a.data);
        row.status = row.sha256 === e.sha256 && a.length === e.size ? 'match' : 'mismatch';
      }
    }
    files.push(row);
  }
  for (const a of [...pdf.attachments.filter((x) => !covered.has(x.name)), ...duplicates]) {
    if (files.some((f) => f.status === 'extra' && f.attachment === a.name && f.offset === a.offset)) continue;
    files.push({ name: a.name, attachment: a.name, size: a.length, expected: null, sha256: a.encoded ? null : await hashHex(a.data), status: 'extra', offset: a.offset });
  }
  // Attached inputs must match; the user's own originals are judged separately.
  if (report) check('inputsMatch', files.every((f) => ['match', 'hash-only', 'original-match', 'original-mismatch', 'extra'].includes(f.status)));
  check('noExtraFiles', !files.some((f) => f.status === 'extra'));
  if (files.some((f) => f.status === 'original-match' || f.status === 'original-mismatch')) {
    check('originalsMatch', !files.some((f) => f.status === 'original-mismatch'));
  }
  const trustedMatch = trusted ? fingerprint === trusted : null;
  if (trusted) check('trustedKey', trustedMatch);

  // trustedKey and originalsMatch are not about whether the report changed; they
  // decide wrong-key and the originals' own result.
  const failed = checks.some((c) => c.ok === false && c.id !== 'trustedKey' && c.id !== 'originalsMatch');
  let status;
  if (failed) status = 'invalid';
  else if (trusted && !trustedMatch) status = 'wrong-key';
  else if (!sigFile) status = 'unsigned';
  else if (unsupported) status = 'unverifiable';
  else status = 'valid';

  return {
    status,
    checks,
    files: files.map(({ offset, ...f }) => f),
    // The signed data is intact although the PDF around it changed.
    dataIntactPdfChanged: reportSigned === true && pdfIntact === false,
    signer: s ? {
      alg: s.obj.alg, label: ALGORITHM_INFO[s.obj.alg].label, reference: ALGORITHM_INFO[s.obj.alg].reference,
      fingerprint, storage: (report && report.signer && report.signer.keyStorage) || null,
    } : null,
    trusted: trusted ? { fingerprint: trusted, match: trustedMatch } : null,
    report: report ? {
      id: reportIdFor(report.createdAt, reportSha256), sha256: reportSha256, createdAt: report.createdAt || null,
      title: (report.meta && report.meta.title) || '', auditor: (report.meta && report.meta.auditor) || '',
      labVersion: (report.manifest && report.manifest.lab && report.manifest.lab.version) || null,
      signed: reportSigned === true, figures: figures(report),
    } : null,
    pdf: { size: bytes.length, version: pdf.version, attachments: pdf.attachments.length, problems: pdf.problems },
  };
}

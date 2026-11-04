// Browser tests for signed reports: a report built in the lab verifies in the
// "Verify a report" tab, one changed byte makes it invalid, the key survives a
// reload, and the two fallbacks work (no Ed25519: ECDSA P-256; no IndexedDB: a
// session-only key that the page and the report both mention). The PDFs are also
// taken apart in Node with lab/core/pdf-read.js to look at what was signed.
const test = require('node:test');
const assert = require('node:assert');
const { startServer } = require('../helpers/dev-server');

let chromium;
try {
  ({ chromium } = require('playwright'));
} catch (e) {
  throw new Error('These tests need Playwright: npm install --no-save playwright && npx playwright install chromium');
}

const attachmentsOf = async (buf) => (await import('../../lab/core/pdf-read.js')).readPdfAttachments(new Uint8Array(buf)).attachments;
const jsonOf = (att, name) => JSON.parse(Buffer.from(att.find((a) => a.name === name).data).toString('utf8'));

async function openLab(browser, server, initScript = null) {
  const ctx = await browser.newContext({ acceptDownloads: true, viewport: { width: 1280, height: 900 } });
  if (initScript) await ctx.addInitScript(initScript);
  const page = await ctx.newPage();
  page.setDefaultTimeout(120000);
  const errors = [], requests = [];
  page.on('pageerror', (e) => errors.push(e.message));
  ctx.on('request', (r) => requests.push({ method: r.method(), url: r.url() }));
  await page.goto(server.url + '/lab/index.html');
  return { ctx, page, errors, requests };
}

// Theoretical RTP of the example slot, then a PDF report; returns its bytes.
async function makeReport(page) {
  await page.click('#tab-theory');
  await page.click('[data-sample="desertGold"]');
  await page.click('#run-theory');
  await page.waitForFunction(() => !document.querySelector('#run-theory').disabled && document.querySelector('#res-theory .card'));
  await page.click('#tab-report');
  await page.waitForSelector('#sign-fingerprint');
  await page.click('#run-report');
  await page.waitForSelector('#report-download');
  const [download] = await Promise.all([page.waitForEvent('download'), page.click('#report-download')]);
  return require('fs').readFileSync(await download.path());
}

// Loads a file into the Verify tab and waits for its verdict or error.
async function verify(page, buffer, name = 'report.pdf') {
  await page.click('#tab-verify');
  await page.evaluate(() => { document.querySelector('#res-verify').replaceChildren(); document.querySelector('#err-verify').hidden = true; });
  await page.setInputFiles('#verifyFile', { name, mimeType: 'application/pdf', buffer });
  return readVerdict(page);
}
async function rerun(page, trusted) {
  await page.fill('#v-trusted', trusted);
  await page.evaluate(() => { document.querySelector('#res-verify').replaceChildren(); document.querySelector('#err-verify').hidden = true; });
  await page.click('#run-verify');
  return readVerdict(page);
}
async function readVerdict(page) {
  await page.waitForFunction(() => document.querySelector('#verify-verdict') || !document.querySelector('#err-verify').hidden);
  await page.waitForFunction(() => !document.querySelector('#run-verify').disabled);
  return page.evaluate(() => {
    const v = document.querySelector('#verify-verdict');
    const fp = document.querySelector('#verify-fingerprint');
    const err = document.querySelector('#err-verify');
    return { status: v ? v.dataset.status : null, text: document.querySelector('#res-verify').innerText, fingerprint: fp ? fp.textContent : null, error: err.hidden ? null : err.textContent };
  });
}

const flip = (buf, at) => { const b = Buffer.from(buf); b[at] ^= 0x01; return b; };
const fingerprintHex = (shown) => shown.replace(/\s+/g, '').toLowerCase();

test('signed report: verifies in the Verify tab, a flipped byte does not, the key survives a reload', async (t) => {
  const server = await startServer();
  const browser = await chromium.launch();
  t.after(async () => { await browser.close(); await server.close(); });
  const { page, errors, requests } = await openLab(browser, server);

  // Which algorithm this Chromium gives Web Crypto decides what the lab must use.
  const hasEd25519 = await page.evaluate(() => crypto.subtle.generateKey({ name: 'Ed25519' }, false, ['sign', 'verify']).then(() => true, () => false));
  const expectedAlg = hasEd25519 ? 'Ed25519' : 'ECDSA-P256-SHA256';
  t.diagnostic('Chromium ' + browser.version() + ' Ed25519 in Web Crypto: ' + hasEd25519);

  const pdf = await makeReport(page);
  assert.strictEqual(await page.getAttribute('#sign-fingerprint', 'data-alg'), expectedAlg);
  assert.strictEqual(await page.getAttribute('#sign-storage', 'data-storage'), 'persistent');
  const shown = await page.textContent('#sign-fingerprint');
  assert.match(shown, /^([0-9A-F]{4} ){15}[0-9A-F]{4}$/);
  assert.strictEqual(await page.textContent('#report-fingerprint'), shown);

  // What was signed, read in Node.
  const att = await attachmentsOf(pdf);
  assert.deepStrictEqual(att.map((a) => a.name).sort(), ['desert-gold-example.json', 'report.json', 'report.sig']);
  const sig = JSON.parse(Buffer.from(att.find((a) => a.name === 'report.sig').data).toString('utf8'));
  const report = jsonOf(att, 'report.json');
  assert.strictEqual(sig.alg, expectedAlg);
  assert.strictEqual(sig.keyFingerprint, fingerprintHex(shown));
  assert.deepStrictEqual(report.signer, { alg: expectedAlg, keyFingerprint: fingerprintHex(shown), keyStorage: 'persistent', file: 'report.sig' });
  assert.strictEqual(report.manifest.inputs[0].sha256, require('crypto').createHash('sha256').update(att.find((a) => a.name === 'desert-gold-example.json').data).digest('hex'));

  // The untouched PDF is valid and names the same key.
  let v = await verify(page, pdf);
  assert.strictEqual(v.status, 'valid', v.text);
  assert.strictEqual(v.fingerprint, shown);
  assert.match(v.text, /95\.517500%/, 'the signed RTP figure is shown');

  // Against a trusted fingerprint: the right one, another one, and a malformed one.
  assert.strictEqual((await rerun(page, shown.toLowerCase())).status, 'valid');
  assert.strictEqual((await rerun(page, 'ab'.repeat(32))).status, 'wrong-key');
  v = await rerun(page, '1234');
  assert.strictEqual(v.status, null);
  assert.match(v.error, /64/);
  await page.fill('#v-trusted', '');

  // One byte of report.json, then one byte of the first page image.
  const json = att.find((a) => a.name === 'report.json');
  v = await verify(page, flip(pdf, json.offset + Math.floor(json.length / 2)));
  assert.strictEqual(v.status, 'invalid', v.text);
  const latin = pdf.toString('latin1');
  const image = latin.indexOf('stream\n', latin.indexOf('/DCTDecode')) + 7;
  v = await verify(page, flip(pdf, image + 1000));
  assert.strictEqual(v.status, 'invalid', v.text);
  // Back to the original, this time dropped on the panel's text: valid again.
  await page.evaluate(() => { document.querySelector('#res-verify').replaceChildren(); });
  const dropped = await page.evaluateHandle((b64) => {
    const dt = new DataTransfer();
    dt.items.add(new File([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], 'dropped.pdf', { type: 'application/pdf' }));
    return dt;
  }, pdf.toString('base64'));
  await page.dispatchEvent('#panel-verify > p', 'drop', { dataTransfer: dropped });
  v = await readVerdict(page);
  assert.strictEqual(v.status, 'valid', v.text);
  assert.match(await page.textContent('#name-verify'), /^dropped\.pdf/);

  // Not a PDF, and a PDF that is not a lab report: refused with a message.
  v = await verify(page, Buffer.from('bet,win\n1,0\n'), 'log.csv');
  assert.strictEqual(v.status, null);
  assert.match(v.error, /PDF/);
  const plain = Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [] /Count 0 >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n', 'latin1');
  v = await verify(page, plain, 'other.pdf');
  assert.match(v.error, /report\.json/);

  // English labels.
  await page.click('#langToggle');
  assert.strictEqual(await page.textContent('#tab-verify'), 'Verify a report');
  await page.click('#langToggle');

  // The key is kept: after a reload the report tab shows the same fingerprint.
  await page.reload();
  await page.click('#tab-report');
  await page.waitForSelector('#sign-fingerprint');
  assert.strictEqual(await page.textContent('#sign-fingerprint'), shown);

  assert.deepStrictEqual(errors, []);
  const outside = requests.filter((r) => !r.url.startsWith('blob:') && !(r.method === 'GET' && /\/(lab|icons)\//.test(new URL(r.url).pathname)));
  assert.deepStrictEqual(outside, [], 'requests other than the lab\'s own static files');
});

test('without Ed25519 the lab signs with ECDSA P-256, and the report verifies', async (t) => {
  const server = await startServer();
  const browser = await chromium.launch();
  t.after(async () => { await browser.close(); await server.close(); });
  // The page's Web Crypto behaves like a browser from before Ed25519 shipped.
  const { page, errors } = await openLab(browser, server, () => {
    const subtle = crypto.subtle;
    const isEd = (a) => (typeof a === 'string' ? a : a && a.name) === 'Ed25519';
    const no = () => Promise.reject(new DOMException('Unrecognized algorithm name', 'NotSupportedError'));
    const gen = subtle.generateKey.bind(subtle), imp = subtle.importKey.bind(subtle);
    subtle.generateKey = (a, ...r) => (isEd(a) ? no() : gen(a, ...r));
    subtle.importKey = (f, k, a, ...r) => (isEd(a) ? no() : imp(f, k, a, ...r));
  });
  assert.strictEqual(await page.evaluate(() => crypto.subtle.generateKey({ name: 'Ed25519' }, false, ['sign']).then(() => 'yes', (e) => e.name)), 'NotSupportedError');
  const pdf = await makeReport(page);
  assert.strictEqual(await page.getAttribute('#sign-fingerprint', 'data-alg'), 'ECDSA-P256-SHA256');
  const att = await attachmentsOf(pdf);
  assert.strictEqual(jsonOf(att, 'report.sig').alg, 'ECDSA-P256-SHA256');
  const v = await verify(page, pdf);
  assert.strictEqual(v.status, 'valid', v.text);
  assert.match(v.text, /ECDSA P-256/);
  const report = att.find((a) => a.name === 'report.json');
  assert.strictEqual((await verify(page, flip(pdf, report.offset + 5))).status, 'invalid');
  assert.deepStrictEqual(errors, []);
});

test('without IndexedDB a session-only key is used, and the page and the report say so', async (t) => {
  const server = await startServer();
  const browser = await chromium.launch();
  t.after(async () => { await browser.close(); await server.close(); });
  const { page, errors } = await openLab(browser, server, () => {
    Object.defineProperty(window, 'indexedDB', { configurable: true, get() { throw new DOMException('The operation is insecure.', 'SecurityError'); } });
  });
  const pdf = await makeReport(page);
  assert.strictEqual(await page.getAttribute('#sign-storage', 'data-storage'), 'session');
  assert.ok(await page.isVisible('#sign-key .verdict.warn'), 'session-only warning shown');
  const att = await attachmentsOf(pdf);
  assert.strictEqual(jsonOf(att, 'report.json').signer.keyStorage, 'session');
  assert.ok(pdf.toString('latin1').includes('this session only'), 'text page says the key was for this session only');
  const v = await verify(page, pdf);
  assert.strictEqual(v.status, 'valid', v.text);
  assert.match(v.text, /لجلسة واحدة فقط عند الموقّع/);
  assert.deepStrictEqual(errors, []);
});

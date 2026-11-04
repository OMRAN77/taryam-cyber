// Browser test for weighted stops and reel sets in lab/index.html: the weighted
// example opens in the JSON editor (the form has no weights), its exact RTP and reel
// sets are shown, the model fingerprint covers the weights, the simulator runs it
// reproducibly, CSV weight columns are read, and the PDF report carries it all.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { startServer } = require('../helpers/dev-server');

let chromium;
try {
  ({ chromium } = require('playwright'));
} catch (e) {
  throw new Error('These tests need Playwright: npm install --no-save playwright && npx playwright install chromium');
}

const SAMPLES = path.join(__dirname, '..', '..', 'lab', 'samples');
const sample = JSON.parse(fs.readFileSync(path.join(SAMPLES, 'desert-gold-weighted.json'), 'utf8'));

// Sorted-key JSON, written here independently of lab/core/slot-model.js.
const canon = (v) => (Array.isArray(v) ? '[' + v.map(canon).join(',') + ']'
  : v && typeof v === 'object' ? '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}' : JSON.stringify(v));
const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');

test('RTP lab: weighted stops and reel sets end to end', async (t) => {
  const server = await startServer();
  const browser = await chromium.launch();
  t.after(async () => { await browser.close(); await server.close(); });
  const ctx = await browser.newContext({ acceptDownloads: true, viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  page.setDefaultTimeout(120000);
  const errors = [], requests = [];
  page.on('pageerror', (e) => errors.push(e.message));
  ctx.on('request', (r) => requests.push({ method: r.method(), url: r.url() }));
  await page.goto(server.url + '/lab/index.html');

  const runTheory = async () => {
    await page.evaluate(() => document.querySelector('#res-theory').replaceChildren());
    await page.click('#run-theory');
    await page.waitForFunction(() => !document.querySelector('#run-theory').disabled && (document.querySelector('#res-theory .card') || !document.querySelector('#err-theory').hidden));
    assert.ok(await page.isHidden('#err-theory'), 'theory error: ' + await page.textContent('#err-theory'));
    return page.textContent('#res-theory .card.accent .v');
  };
  const runMc = async () => {
    await page.click('#tab-mc');
    await page.selectOption('#m-spins', '100000');
    await page.evaluate(() => document.querySelector('#res-mc').replaceChildren());
    await page.click('#run-mc');
    await page.waitForSelector('#mc-digest');
    return page.textContent('#mc-digest');
  };

  // Unweighted models use the form; the weighted example opens the JSON editor instead.
  assert.ok(await page.isVisible('#f-reels'));
  assert.ok(await page.isHidden('#modelJsonBox'));
  await page.click('[data-sample="desertGoldWeighted"]');
  assert.ok(await page.isVisible('#f-json'));
  for (const id of ['#f-reels', '#f-paytable', '#f-name', '#f-fsEnabled']) assert.ok(await page.isHidden(id), id + ' hidden');
  assert.deepStrictEqual(JSON.parse(await page.inputValue('#f-json')), sample);

  // Exact RTP: 95.743252%, from the symbol-tuple enumeration in test/lab/weighted-reels.test.mjs.
  assert.strictEqual(await runTheory(), '95.743252%');
  const res = await page.textContent('#res-theory');
  assert.ok(res.includes('موزونة'), 'weighted card');
  const heads = await page.$$eval('#res-theory h3.sub', (h) => h.map((x) => x.textContent));
  assert.ok(heads.includes('مجموعات بكرات الجولة الأساسية') && heads.includes('مجموعات بكرات اللفات المجانية'), heads.join(' | '));
  // Free-spin sets: weights 3 and 1, so 75% and 25%.
  const fsRows = await page.$$eval('#res-theory h3.sub', (h) => {
    const head = h.find((x) => x.textContent === 'مجموعات بكرات اللفات المجانية');
    return [...head.nextElementSibling.querySelectorAll('tbody tr')].map((r) => [...r.cells].map((c) => c.textContent));
  });
  assert.deepStrictEqual(fsRows.map((r) => r.slice(0, 3)), [['1', '3', '75.000000%'], ['2', '1', '25.000000%']]);
  // The fingerprint is SHA-256 of the sorted-key JSON of the model as loaded, weights included.
  const hash = await page.textContent('#res-theory .hash');
  assert.strictEqual(hash, sha256(canon(sample)));

  // Changing one stop weight changes the fingerprint and the RTP.
  const edited = JSON.parse(JSON.stringify(sample));
  edited.weights[0][7] = 1; // the LION stop of reel 1: 2 -> 1
  await page.fill('#f-json', JSON.stringify(edited));
  const rtpEdited = await runTheory();
  assert.notStrictEqual(rtpEdited, '95.743252%');
  assert.strictEqual(await page.textContent('#res-theory .hash'), sha256(canon(edited)));
  // Invalid weights are refused with the bilingual message.
  edited.weights[0][7] = 0;
  await page.fill('#f-json', JSON.stringify(edited));
  await page.click('#run-theory');
  await page.waitForSelector('#err-theory:not([hidden])');
  assert.match(await page.textContent('#err-theory'), /الوزن/);

  // Export JSON keeps the weights.
  await page.click('[data-sample="desertGoldWeighted"]');
  const [exported] = await Promise.all([page.waitForEvent('download'), page.click('#exportModel')]);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(await exported.path(), 'utf8')), sample);

  // Monte Carlo of the weighted model: reproducible, close to the exact value, and the
  // generator text describes the weighted draw.
  assert.strictEqual(await runTheory(), '95.743252%');
  const digest = await runMc();
  assert.ok((await page.textContent('#res-mc')).includes('weighted models:'), 'weighted generator description');
  assert.ok(await page.$('#res-mc .card.good'), 'within 4 standard errors of the exact RTP');
  await page.click('#rerun-mc');
  await page.waitForSelector('#res-mc .verdict.pass');
  assert.strictEqual(await page.textContent('#mc-digest'), digest);

  // Report: the weighted section, report.json and the text page.
  await page.click('#tab-report');
  await page.click('#run-report');
  await page.waitForSelector('#report-download');
  const [pdfDl] = await Promise.all([page.waitForEvent('download'), page.click('#report-download')]);
  const pdf = fs.readFileSync(await pdfDl.path()).toString('latin1');
  assert.ok(pdf.includes('"weighted":true') && pdf.includes('"freeSpinReelSets":['), 'report.json carries the reel sets');
  assert.ok(pdf.includes('Weighted reels: base reel sets 1, free-spin reel sets 2'), 'text summary line');

  // Back to an unweighted example: the form returns, and Desert Gold keeps the model
  // and run fingerprints it had before weights existed (recorded with commit 5863f5b).
  await page.click('#tab-theory');
  await page.click('[data-sample="desertGold"]');
  assert.ok(await page.isVisible('#f-reels'));
  assert.ok(await page.isHidden('#modelJsonBox'));
  assert.strictEqual(await runTheory(), '95.517500%');
  assert.strictEqual(await page.textContent('#res-theory .hash'), '6d8951a0f1388a005c340ee0e8295db4eedcd73110188e300e10d370150a387a');
  assert.ok(!(await page.textContent('#res-theory')).includes('موزونة'));
  assert.strictEqual(await runMc(), '65ff4b4d0438fd9a735f5308a6d14bf4da4b33a94565d3f75a2a7bc47811443d');
  assert.ok(!(await page.textContent('#res-mc')).includes('weighted models:'));

  // A reels CSV with weight columns makes the form's model weighted (JSON editor).
  await page.click('#tab-theory');
  await page.setInputFiles('#modelFile', path.join(SAMPLES, 'desert-gold-weighted-reels.csv'));
  await page.waitForSelector('#modelJsonBox:not([hidden])');
  const fromCsv = JSON.parse(await page.inputValue('#f-json'));
  assert.deepStrictEqual(fromCsv.weights, sample.weights);
  assert.deepStrictEqual(fromCsv.reels, sample.reels);
  await runTheory();
  assert.ok((await page.textContent('#res-theory')).includes('موزونة'));

  // English labels.
  await page.click('#langToggle');
  const en = await page.textContent('#res-theory');
  assert.ok(en.includes('Weighted') && en.includes('Total weight per reel') && en.includes('Weight per line'), 'English labels');
  assert.ok((await page.textContent('#modelJsonBox')).includes('edit it here as JSON'));

  assert.deepStrictEqual(errors, []);
  const outside = requests.filter((r) => !r.url.startsWith('blob:') && !(r.method === 'GET' && /\/(lab|icons)\//.test(new URL(r.url).pathname)));
  assert.deepStrictEqual(outside, [], 'requests other than the lab\'s own static files');
});

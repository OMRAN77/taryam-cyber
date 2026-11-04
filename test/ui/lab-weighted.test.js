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

test('RTP lab: weights near 2^64 on a phone, exact large numbers, the PDF reel table, notes and errors', async (t) => {
  const server = await startServer();
  const browser = await chromium.launch();
  t.after(async () => { await browser.close(); await server.close(); });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();
  page.setDefaultTimeout(120000);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(server.url + '/lab/index.html');
  const runTheory = async () => {
    await page.evaluate(() => document.querySelector('#res-theory').replaceChildren());
    await page.click('#run-theory');
    await page.waitForFunction(() => !document.querySelector('#run-theory').disabled && (document.querySelector('#res-theory .card') || !document.querySelector('#err-theory').hidden));
  };
  const noSideScroll = () => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);

  // The weighted example with every base stop weight times 2^62 - 1 (each still below
  // 2^64 - 1) and the first free-spin set weighted 2^64 - 1, all written as strings.
  const K = (1n << 62n) - 1n;
  const big = JSON.parse(JSON.stringify(sample));
  big.weights = sample.weights.map((r) => r.map((w) => String(BigInt(w) * K)));
  big.scatter.freeSpins.reelSets[0].weight = '18446744073709551615';
  // Expected totals by direct BigInt sums and products here: one base set, so the cycle
  // is the product of the reel totals.
  const reelTotals = big.weights.map((r) => r.reduce((a, w) => a + BigInt(w), 0n));
  const cycle = reelTotals.reduce((a, b) => a * b, 1n);
  await page.click('[data-sample="desertGoldWeighted"]');
  await page.fill('#f-json', JSON.stringify(big));
  await runTheory();
  assert.ok(await page.isHidden('#err-theory'), await page.textContent('#err-theory'));
  // The cycle total (105 digits) wraps instead of pushing the page sideways at 390px.
  assert.strictEqual(await page.textContent('#res-theory .weight-total'), 'مجموع أوزان الدورة الكاملة: ' + cycle.toLocaleString('en-US'));
  assert.ok(await noSideScroll(), 'no horizontal page scroll at 390px');
  // The note says which row a stop weight belongs to, here and in the JSON editor.
  assert.ok((await page.textContent('#res-theory')).includes('الصف الأول (العلوي)'));
  assert.ok((await page.textContent('#modelJsonBox')).includes('الصف الأول (العلوي)'));

  // PDF: every reel total and the 2^64 - 1 set weight are drawn whole (L.table cuts a
  // cell that does not fit with '…'); recorded from the canvas text calls.
  await page.evaluate(() => {
    window.drawn = [];
    const fill = CanvasRenderingContext2D.prototype.fillText;
    CanvasRenderingContext2D.prototype.fillText = function (text, ...rest) { window.drawn.push(String(text)); return fill.call(this, text, ...rest); };
  });
  await page.click('#tab-report');
  await page.click('#run-report');
  await page.waitForSelector('#report-download');
  const drawn = await page.evaluate(() => window.drawn);
  for (const v of [...reelTotals, (1n << 64n) - 1n]) assert.ok(drawn.includes(v.toLocaleString('en-US')), 'drawn whole: ' + v.toLocaleString('en-US'));
  assert.deepStrictEqual(drawn.filter((s) => /^[\d,]+…$/.test(s)), [], 'no number cut short');
  assert.ok(await noSideScroll(), 'no horizontal page scroll on the report tab');

  // A weight per line that is a fraction above 2^53 keeps every digit. One reel A, B, C
  // with weights 2^60 + 1, 1, 2 and lines on rows 1 and 2: A shows in row 1 from the
  // first stop (2^60 + 1) and in row 2 from the third (2); the per-line average is
  // (2^60 + 3) / 2 = 576460752303423489.5 (2^60 = 1152921504606846976).
  await page.click('#tab-theory');
  await page.fill('#f-json', JSON.stringify({ rows: 3, reels: [['A', 'B', 'C']], weights: [[String((1n << 60n) + 1n), 1, 2]], lines: [[1], [2]], paytable: { A: [1] } }));
  await runTheory();
  assert.ok((await page.textContent('#res-theory')).includes('576,460,752,303,423,489.50'), 'exact weight per line');

  // A model with one reel set has the reelSets key, so it opens in the JSON editor, but it
  // is not weighted: the note names the keys and no weights card is shown.
  const oneSet = { name: 'one set', rows: 1, reelSets: [{ weight: 5, reels: [['A', 'B'], ['A', 'B']] }], paytable: { A: [0, 5] } };
  await page.setInputFiles('#modelFile', { name: 'one-set.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(oneSet)) });
  await page.waitForSelector('#modelJsonBox:not([hidden])');
  const note = await page.textContent('#modelJsonBox');
  assert.ok(note.includes('weights') && note.includes('reelSets') && !note.includes('أكثر من مجموعة'), note);
  await runTheory();
  // By hand: one middle-row line, A A pays 5 and lands with probability 1/2 x 1/2: 125%.
  assert.strictEqual(await page.textContent('#res-theory .card.accent .v'), '125.000000%');
  assert.ok(!(await page.textContent('#res-theory')).includes('موزونة'));

  // Reel-set errors name the set without brackets, so right-to-left text keeps its order.
  await page.fill('#f-json', '{"rows":1,"reelSets":[{"reels":[["A"]]}],"paytable":{}}');
  await page.click('#run-theory');
  await page.waitForSelector('#err-theory:not([hidden])');
  assert.strictEqual(await page.textContent('#err-theory'), 'reelSets، المجموعة 1: لا يوجد وزن للمجموعة');
  assert.ok(await noSideScroll());
  assert.deepStrictEqual(errors, []);
});

// Browser test for ways / Megaways models (P0-6) in lab/index.html: the ways example
// opens in the JSON editor (the form edits line games only) and is not changed by it,
// the theoretical tab shows the evaluation, max ways, heights, top reel and conventions
// with their source, a cascading game is labelled "first drop only" everywhere, the
// simulator agrees with the exact RTP and offers a control variate, the report carries
// it all, and nothing leaves the page.
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
const sample = JSON.parse(fs.readFileSync(path.join(SAMPLES, 'oasis-caravan-ways.json'), 'utf8'));
// Sorted-key JSON, written here independently of lab/core/slot-model.js.
const canon = (v) => (Array.isArray(v) ? '[' + v.map(canon).join(',') + ']'
  : v && typeof v === 'object' ? '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}' : JSON.stringify(v));
const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');

test('RTP lab: ways / Megaways models end to end', async (t) => {
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
  const cardValue = (label) => page.$$eval('#res-theory .card', (cs, l) => { const c = cs.find((x) => x.querySelector('.k').textContent === l); return c ? c.querySelector('.v').textContent : null; }, label);

  // The ways example opens in the JSON editor with its own note, unchanged.
  await page.click('[data-sample="oasisCaravanWays"]');
  assert.ok(await page.isVisible('#f-json'));
  assert.ok(await page.isVisible('#waysJsonNote'));
  assert.ok(await page.isHidden('#jsonModeNote'), 'no weights note for an unweighted ways model');
  for (const id of ['#f-reels', '#f-paytable', '#f-linePreset']) assert.ok(await page.isHidden(id), id + ' hidden');
  assert.deepStrictEqual(JSON.parse(await page.inputValue('#f-json')), sample);

  // Exact RTP 95.901366%: the fraction equals the direct per-symbol computation in
  // test/lab/ways-exact.test.mjs ("the ways sample: exact RTP equals ...").
  assert.strictEqual(await runTheory(), '95.901366%');
  assert.strictEqual(await page.textContent('#res-theory .hash'), sha256(canon(sample)));
  const heads = await page.$$eval('#res-theory h3.sub', (h) => h.map((x) => x.textContent));
  assert.ok(heads.includes('النوافذ وقواعد ways'), heads.join(' | '));
  // Max ways (7) x (7 + 1)^4 x (7) = 200,704; fewest (2) x (2 + 1)^4 x (2) = 324.
  assert.strictEqual(await cardValue('أقصى عدد ways'), '200,704');
  assert.strictEqual(await cardValue('البكرة العلوية'), 'تغطي البكرات: 2، 3، 4، 5 · المواقع: ' + sample.topReel.reel.length);
  assert.strictEqual(await cardValue('الرهان الكلي بالعملات (betCost)'), '20');
  // The heights table: one row per reel; weights 1, 3, 4, 4, 2, 1 of 15 -> 6.67% ... (2 places on the page).
  const heights = await page.$$eval('#res-theory h3.sub', (h) => {
    const head = h.find((x) => x.textContent === 'النوافذ وقواعد ways');
    let n = head.nextElementSibling;
    while (n && !n.classList.contains('table-wrap')) n = n.nextElementSibling;
    return [...n.querySelectorAll('tbody tr')].map((r) => [...r.cells].map((c) => c.textContent));
  });
  assert.strictEqual(heights.length, 6);
  assert.deepStrictEqual(heights[0], ['1', ['2: 6.67%', '3: 20.00%', '4: 26.67%', '5: 26.67%', '6: 13.33%', '7: 6.67%'].join(' · ').replace(/: /g, ':\u00a0'), '', '']);
  assert.deepStrictEqual(heights.map((r) => r[2]), ['', '✓', '✓', '✓', '✓', '']);
  const rules = await page.textContent('#ways-rules');
  assert.ok(rules.includes('تتضاعف المضاعفات عبر البكرات') && rules.includes('wildStartsWin: true'), rules);
  assert.ok((await page.textContent('#res-theory')).includes('141b4e8، 2 نوفمبر 2026'), 'source and date of the conventions');
  // Too large for the full distribution: the message says what stays exact.
  assert.ok((await page.textContent('#res-theory .verdict.warn')).includes('مونت كارلو'));
  const symHeads = await page.$$eval('#res-theory th', (h) => h.map((x) => x.textContent));
  assert.ok(symHeads.includes('متوسط ways عندها') && symHeads.includes('الدفع لكل way (عملات)'), symHeads.join(' | '));

  // Monte Carlo: within 4 standard errors, reproducible, with a control variate.
  await page.click('#tab-mc');
  await page.selectOption('#m-spins', '100000');
  await page.click('#run-mc');
  await page.waitForSelector('#mc-digest');
  assert.ok(await page.$('#res-mc .card.good'), 'within 4 standard errors of the exact RTP');
  const mcText = await page.textContent('#res-mc');
  assert.ok(mcText.includes('RTP بمتغيّر ضابط') && mcText.includes('ways models:'), 'control variate card and ways generator text');
  const digest = await page.textContent('#mc-digest');
  await page.click('#rerun-mc');
  await page.waitForSelector('#res-mc .verdict.pass');
  assert.strictEqual(await page.textContent('#mc-digest'), digest);

  // Report: report.json and the text page describe the ways model.
  await page.click('#tab-report');
  await page.click('#run-report');
  await page.waitForSelector('#report-download');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#report-download')]);
  const pdfBytes = fs.readFileSync(await dl.path());
  const pdf = pdfBytes.toString('latin1');
  assert.ok(pdf.includes('"evaluation":"ways"') && pdf.includes('"scope":"round"'), 'report.json');
  assert.ok(pdf.includes('Ways evaluation: 324-200704 ways, bet 20 coins'), 'text page');

  // A cascading version: first drop only, in the card, a note, and the Verify figures.
  await page.click('#tab-theory');
  const cascading = { ...sample, name: 'Oasis Caravan, cascading', cascades: true };
  await page.fill('#f-json', JSON.stringify(cascading));
  assert.strictEqual(await runTheory(), '95.901366%', 'the first drop is the game without cascades');
  assert.strictEqual(await page.textContent('#res-theory .card.accent .k'), 'RTP أول سقوط فقط');
  assert.ok(await page.isVisible('#first-drop-note'));
  await page.click('#tab-report');
  await page.click('#run-report');
  await page.waitForFunction(() => document.querySelector('#res-report .card .v') && !document.querySelector('#run-report').disabled);
  const [dl2] = await Promise.all([page.waitForEvent('download'), page.click('#report-download')]);
  const pdf2 = fs.readFileSync(await dl2.path());
  assert.ok(pdf2.toString('latin1').includes('"scope":"firstDrop"') && pdf2.toString('latin1').includes('FIRST DROP ONLY'));
  await page.click('#tab-verify');
  await page.setInputFiles('#verifyFile', { name: 'cascading.pdf', mimeType: 'application/pdf', buffer: pdf2 });
  await page.waitForSelector('#verify-verdict');
  assert.ok((await page.textContent('#res-verify')).includes('95.9014% · أول سقوط فقط') || (await page.textContent('#res-verify')).includes('95.901366% · أول سقوط فقط'), await page.textContent('#res-verify'));

  // The distribution tests refuse a first-drop model as the game's distribution.
  await page.click('#tab-actual');
  await page.click('#sample-actual');
  await page.waitForFunction(() => document.querySelector('#name-actual').textContent.includes('sample-playlog'));
  await page.click('#run-dist');
  await page.waitForSelector('#err-dist:not([hidden])');
  assert.match(await page.textContent('#err-dist'), /أول سقوط فقط/);

  // English labels.
  await page.click('#langToggle');
  await page.click('#tab-theory');
  assert.strictEqual(await page.textContent('#res-theory .card.accent .k'), 'First-drop RTP only');
  assert.ok((await page.textContent('#modelJsonBox')).includes('the form edits payline games only'));
  assert.ok((await page.textContent('#res-theory')).includes('commit 141b4e8, 2 Nov 2026'));
  await page.click('#langToggle');

  // Back to a line example: the form returns and its RTP is unchanged.
  await page.click('[data-sample="desertGold"]');
  assert.ok(await page.isVisible('#f-reels'));
  assert.ok(await page.isHidden('#modelJsonBox'));
  assert.strictEqual(await runTheory(), '95.517500%');

  assert.deepStrictEqual(errors, []);
  const outside = requests.filter((r) => !r.url.startsWith('blob:') && !(r.method === 'GET' && /\/(lab|icons)\//.test(new URL(r.url).pathname)));
  assert.deepStrictEqual(outside, [], 'requests other than the lab\'s own static files');
});

test('RTP lab: the ways example on a phone has no sideways scroll', async (t) => {
  const server = await startServer();
  const browser = await chromium.launch();
  t.after(async () => { await browser.close(); await server.close(); });
  const page = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();
  page.setDefaultTimeout(120000);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(server.url + '/lab/index.html');
  await page.click('[data-sample="oasisCaravanWays"]');
  await page.click('#run-theory');
  await page.waitForSelector('#ways-rules');
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), 'no horizontal page scroll');
  if (process.env.WAYS_SHOT) await page.screenshot({ path: process.env.WAYS_SHOT, fullPage: true });
  assert.deepStrictEqual(errors, []);
});

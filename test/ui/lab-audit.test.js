// Browser test for the distribution tests in the lab's observed-RTP tab
// (lab/core/audit-stats.js): the three-version example, a distribution that cannot
// produce the log, the theoretical model of Desert Gold (paid-spin pmf + trigger
// column), and the report. The numbers themselves are checked in
// test/lab/audit-stats.test.mjs; here the page must wire them up and say the right thing.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { startServer } = require('../helpers/dev-server');

let chromium;
try {
  ({ chromium } = require('playwright'));
} catch (e) {
  throw new Error('These tests need Playwright: npm install --no-save playwright && npx playwright install chromium');
}

test('RTP lab: distribution tests, version identification, e-process and report', async (t) => {
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
  await page.click('#tab-actual');
  assert.match(await page.textContent('#dist-candidates'), /لا يوجد توزيع/);

  // Example: one synthetic game in three RTP versions, 200,000 rounds drawn from the 94% one.
  await page.click('#sample-dist');
  await page.waitForFunction(() => document.querySelector('#name-actual').textContent.includes('sample-playlog-3-versions'));
  assert.match(await page.textContent('#dist-candidates'), /1\. RTP 96% · 2\. RTP 94% · 3\. RTP 92%/);
  assert.strictEqual(await page.inputValue('#d-maxWin'), '5000');
  assert.strictEqual(await page.inputValue('#a-declared'), '96');
  assert.strictEqual(await page.$eval('#d-ref', (s) => s.selectedOptions[0].textContent), '1. RTP 96%');
  const runDist = async () => {
    await page.click('#run-dist');
    await page.waitForFunction(() => !document.querySelector('#run-dist').disabled);
    assert.ok(await page.isHidden('#err-dist'), 'no error: ' + await page.textContent('#err-dist'));
  };
  await runDist();
  // A 2-point RTP gap made by the bonus trigger rate is far below what 200,000 rounds can show
  // (the planner says ~1.5M rounds for SPRT): nothing is rejected, and the page says it is no
  // certification and shows the minimum detectable effect.
  assert.ok(await page.$('#dist-verdict.pass'));
  const res = await page.textContent('#res-dist');
  assert.match(res, /لا يعني "مطابق" ولا يعني شهادة/);
  assert.match(res, /أصغر أثر قابل للكشف/);
  assert.match(res, /200,000/);
  assert.ok(await page.$('#dist-sprt.warn'), 'SPRT undecided');
  const posteriors = await page.$$eval('#dist-versions tbody tr', (rows) => rows.map((r) => Number(r.cells[3].textContent.replace('%', ''))));
  assert.strictEqual(posteriors.length, 3);
  assert.ok(Math.abs(posteriors.reduce((a, b) => a + b, 0) - 100) < 0.05, 'posteriors add up to 100%: ' + posteriors);
  assert.ok(await page.$('#dist-bet.pass'), 'e-process: not shown to be below');
  assert.ok(await page.$('#res-dist svg.echart polyline'), 'capital chart');
  assert.match(res, /M = 5,000×/);
  // The chance of a total this low: a Monte Carlo estimate with its standard error, labelled.
  assert.match(await page.textContent('#dist-total'), /≈ [0-9.]+ ± [0-9.]+ .*مونت كارلو.*السحوبات: 9,999/);
  // Minimum detectable effects are stated at Holm's strictest level, and the G-test can reach it.
  assert.match(res, /عند أشد مستوى في طريقة Holm/);
  assert.ok(!(await page.$('#dist-gof-floor')));
  // English.
  await page.click('#langToggle');
  assert.match(await page.textContent('#res-dist'), /Not rejected at this power/);
  assert.match(await page.textContent('#res-dist'), /Sample-size planner/);
  await page.click('#langToggle');

  // Report with the distribution section and the three distribution files attached.
  await page.click('#tab-report');
  assert.match(await page.textContent('#rep-sections'), /اختبارات التوزيع/);
  await page.click('#run-report');
  await page.waitForSelector('#report-download');
  const [download] = await Promise.all([page.waitForEvent('download'), page.click('#report-download')]);
  const pdf = fs.readFileSync(await download.path()).toString('latin1');
  for (const name of ['report.json', 'example-version-96.csv', 'example-version-94.csv', 'example-version-92.csv', 'sample-playlog-3-versions.csv']) {
    assert.ok(pdf.includes('(' + name + ')'), 'attachment ' + name);
  }
  assert.ok(pdf.includes('"distTests":{'), 'report.json carries the distribution tests');
  assert.ok(pdf.includes('"verdict":"consistent"'));

  // A distribution that cannot produce the log's wins (no 5,000x prize, nothing but 0 and 1x).
  await page.click('#tab-actual');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lab-dist-'));
  const bad = path.join(dir, 'two-outcomes.csv');
  fs.writeFileSync(bad, 'multiplier,probability\n0,0.9\n1,0.1\n');
  await page.setInputFiles('#pmfFile', bad);
  await page.waitForFunction(() => document.querySelector('#dist-candidates').textContent.includes('two-outcomes'));
  assert.doesNotMatch(await page.textContent('#dist-candidates'), /RTP 94%/);
  await runDist();
  assert.ok(await page.$('#dist-verdict.fail'));
  assert.match(await page.textContent('#dist-verdict'), /أرباح لا يستطيع التوزيع المعلن إنتاجها/);

  // Theoretical model of Desert Gold: its pmf covers the whole round (free spins
  // included, P0-8), and the example log has a trigger column, so the whole family runs.
  await page.click('#tab-theory');
  await page.click('[data-sample="desertGold"]');
  await page.click('#run-theory');
  await page.waitForFunction(() => !document.querySelector('#run-theory').disabled && document.querySelector('#res-theory .card'));
  await page.click('#tab-actual');
  await page.click('#sample-actual');
  await page.waitForFunction(() => document.querySelector('#name-actual').textContent.includes('sample-playlog-desert'));
  await page.click('#clear-pmf');
  await page.check('#d-useTheory');
  await page.fill('#d-maxWin', '');
  await page.fill('#a-declared', '95.5175');
  assert.match(await page.textContent('#dist-candidates'), /^\D*1\. Desert Gold \(example\)$/);
  await runDist();
  assert.ok(await page.$('#dist-verdict.pass'), await page.textContent('#dist-verdict'));
  const dg = await page.textContent('#res-dist');
  assert.match(dg, /الجولة كاملة/);
  assert.match(dg, /نسبة تفعيل الميزة/);
  // Retriggers: no max-win cap, so no "below declared" test is possible (Bahadur-Savage).
  assert.ok(await page.$('#dist-bet.warn'));
  assert.match(await page.textContent('#dist-bet'), /يلزم سقف ربح M/);
  // With a cap entered, the e-process runs.
  await page.fill('#d-maxWin', '10000');
  await runDist();
  assert.ok(await page.$('#dist-bet.pass'));

  assert.deepStrictEqual(errors, []);
  const outside = requests.filter((r) => !r.url.startsWith('blob:') && !(r.method === 'GET' && /\/(lab|icons)\//.test(new URL(r.url).pathname)));
  assert.deepStrictEqual(outside, [], 'requests other than the lab\'s own static files');
});

// Review findings: the reference choice, where sigma / M / the tested RTP come from,
// stale results in the report, probabilities that do not add up to 1, a mode typed for a
// log without a mode column.
test('RTP lab: distribution tests keep the chosen reference and take sigma, M and RTP from it', async (t) => {
  const server = await startServer();
  const browser = await chromium.launch();
  t.after(async () => { await browser.close(); await server.close(); });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.setDefaultTimeout(120000);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(server.url + '/lab/index.html');
  const selected = () => page.$eval('#d-ref', (s) => s.selectedOptions[0].textContent);
  const runDist = async () => {
    await page.click('#run-dist');
    await page.waitForFunction(() => !document.querySelector('#run-dist').disabled);
  };
  const noError = async () => assert.ok(await page.isHidden('#err-dist'), 'no error: ' + await page.textContent('#err-dist'));

  // Another game in the Theoretical tab: European roulette (sigma ~ 1, M = 2).
  await page.click('[data-sample="rouletteEuropean"]');
  await page.click('#run-theory');
  await page.waitForFunction(() => !document.querySelector('#run-theory').disabled && document.querySelector('#res-theory .card'));
  await page.click('#tab-actual');
  await page.click('#sample-dist');
  await page.waitForFunction(() => document.querySelector('#name-actual').textContent.includes('sample-playlog-3-versions'));

  // Ticking the model adds a candidate in front: the chosen version stays chosen.
  await page.selectOption('#d-ref', { label: '3. RTP 92%' });
  await page.check('#d-useTheory');
  assert.match(await page.textContent('#dist-candidates'), /1\. European roulette.* · 2\. RTP 96% · 3\. RTP 94% · 4\. RTP 92%/);
  assert.strictEqual(await selected(), '4. RTP 92%');
  await page.uncheck('#d-useTheory');
  assert.strictEqual(await selected(), '3. RTP 92%');
  await page.check('#d-useTheory');

  // A CSV reference with the roulette model loaded: sigma and M are the reference's own
  // (sigma of the example 96% pmf is 22.685; M its 5,000x top prize), not roulette's 1 and 2x.
  await page.selectOption('#d-ref', { label: '2. RTP 96%' });
  await page.fill('#d-maxWin', '');
  await page.fill('#a-sigma', '');
  await runDist();
  await noError();
  assert.ok(await page.$('#dist-bet.pass'), await page.textContent('#res-dist'));
  let res = await page.textContent('#res-dist');
  assert.match(res, /M = 5,000× \(من التوزيع المرجعي\)/);
  assert.match(await page.textContent('#dist-plan-grid'), /σ: 22\.685 من التوزيع المرجعي/);
  assert.doesNotMatch(res, /M = 2×/);
  assert.ok(!(await page.$('#dist-declared-differs')), 'declared 96% = the reference');

  // The 94% version as the declared one: the e-process tests 94%, and says the field differs.
  await page.selectOption('#d-ref', { label: '3. RTP 94%' });
  await runDist();
  await noError();
  res = await page.textContent('#res-dist');
  assert.match(res, /RTP الإصدار المرجعي94\.000%/);
  assert.match(await page.textContent('#dist-declared-differs'), /96\.000% ≠ 94\.000%/);

  // New files replace pmf-0...: the result that used the old ones is dropped, so the report
  // cannot pair it with other files.
  await page.click('#tab-report');
  assert.match(await page.textContent('#rep-sections'), /اختبارات التوزيع/);
  await page.click('#tab-actual');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lab-dist-'));
  const short = path.join(dir, 'short.csv'), weights = path.join(dir, 'weights.csv');
  fs.writeFileSync(short, 'multiplier,probability\n0,0.5\n1,0.3\n2,0.1\n');
  fs.writeFileSync(weights, 'multiplier,weight\n0,3\n1,1\n');
  await page.setInputFiles('#pmfFile', [weights, short]);
  await page.waitForFunction(() => document.querySelector('#dist-candidates').textContent.includes('short'));
  assert.strictEqual(await page.textContent('#res-dist'), '');
  await page.click('#tab-report');
  assert.doesNotMatch(await page.textContent('#rep-sections'), /اختبارات التوزيع/);
  await page.click('#tab-actual');

  // Probabilities adding up to 0.9: an error naming the file, not a silent renormalization.
  await page.uncheck('#d-useTheory');
  await runDist();
  const err = await page.textContent('#err-dist');
  assert.match(err, /"short"/);
  assert.match(err, /0\.9/);
  // A weight column is divided by its total, and the page says so.
  await page.setInputFiles('#pmfFile', weights);
  await page.waitForFunction(() => !document.querySelector('#dist-candidates').textContent.includes('short'));
  await runDist();
  await noError();
  assert.match(await page.textContent('#dist-normalized'), /weights \(المجموع: 4\)/);

  // A mode typed for a log without a mode column is an error, not a label.
  await page.fill('#d-mode', 'bonus');
  await runDist();
  assert.match(await page.textContent('#err-dist'), /لا يحتوي السجل على عمود للنمط.*"bonus"/);

  assert.deepStrictEqual(errors, []);
});

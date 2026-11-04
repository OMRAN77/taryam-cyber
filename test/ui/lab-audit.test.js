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
  assert.strictEqual(await page.inputValue('#d-ref'), '0');
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

  // Theoretical model of Desert Gold: its pmf covers the paid spin (free spins retrigger),
  // and the example log now has a trigger column, so the whole family runs.
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
  assert.match(dg, /اللفة المدفوعة وحدها/);
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

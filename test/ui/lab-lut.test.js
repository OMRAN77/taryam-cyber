// Browser test for the outcome-table (LUT) tab of lab/index.html: hand-made files give
// their hand-calculated RTP, bad uploads are refused in both languages, the generated
// example matches an offline exact computation, and the PDF report carries the tables.
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

// p/q as a percentage with 6 decimals, rounded half up (how the page prints exact RTPs).
function percent6(p, q) {
  const r = (p * 100n * 1000000n * 2n + q) / (2n * q);
  const s = r.toString().padStart(7, '0');
  return s.slice(0, -6) + '.' + s.slice(-6) + '%';
}

test('LUT tab: exact RTP per mode, bilingual errors, generated example and report', async (t) => {
  const server = await startServer();
  const browser = await chromium.launch();
  t.after(async () => { await browser.close(); await server.close(); });
  const ctx = await browser.newContext({ acceptDownloads: true, viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  page.setDefaultTimeout(60000);
  const errors = [], requests = [];
  page.on('pageerror', (e) => errors.push(e.message));
  ctx.on('request', (r) => requests.push({ method: r.method(), url: r.url() }));
  await page.goto(server.url + '/lab/index.html');
  await page.click('#tab-lut');
  assert.ok(await page.isVisible('#panel-lut'));
  // The page says plainly that a server-drawn LUT is not provably fair.
  assert.match(await page.textContent('#lut-pf'), /provably fair/);
  assert.match(await page.textContent('#lut-pf'), /commit-reveal/);

  // Nothing selected yet.
  await page.click('#run-lut');
  await page.waitForSelector('#err-lut:not([hidden])');
  assert.match(await page.textContent('#err-lut'), /لم يتم اختيار ملف/);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lab-lut-'));
  const write = (name, text) => { const p = path.join(dir, name); fs.writeFileSync(p, text); return p; };
  const index = (modes) => JSON.stringify({ modes: modes.map(([name, cost, weights]) => ({ name, cost, events: `books_${name}.jsonl.zst`, weights })) }, null, 4);

  // Hand-made table: weights 6, 2, 1, 1 on 0x, 0.5x, 1.5x, 4x. sum(w*p) = 650, W = 10:
  // RTP 650 / (100 * 1 * 10) = 65% at cost 1, 650 / (100 * 1.25 * 10) = 52% at cost 1.25.
  // Both are outside Stake's 96.0-96.7% band, so the profile reports submission issues.
  const good = write('index.json', index([['base', 1.0, 'a.csv'], ['ante', 1.25, 'a.csv']]));
  const table = write('a.csv', '1,6,0\n2,2,50\n3,1,150\n4,1,400\n');
  const books = write('books_base.jsonl.zst', 'not read');
  await page.setInputFiles('#lutFiles', [good, table, books]);
  await page.waitForFunction(() => document.querySelector('#name-lut').textContent.includes('a.csv'));
  await page.click('#run-lut');
  await page.waitForSelector('#lut-submission');
  const rows = await page.$$eval('#res-lut .table-wrap:first-of-type tbody tr', (r) => r.map((x) => x.innerText));
  assert.ok(rows[0].includes('base') && rows[0].includes('65.000000%'), rows[0]);
  assert.ok(rows[1].includes('ante') && rows[1].includes('52.000000%'), rows[1]);
  assert.ok(await page.$('#lut-submission.fail'), 'RTP outside the band is a submission issue');
  assert.match(await page.textContent('#res-lut'), /books_base\.jsonl\.zst/); // listed as not read

  // A table named in index.json but not uploaded is refused, in Arabic and in English.
  const missing = write('index.json', index([['base', 1.0, 'a.csv'], ['bonus', 100.0, 'b.csv']]));
  await page.setInputFiles('#lutFiles', [missing, table]);
  await page.waitForFunction(() => !document.querySelector('#res-lut').children.length); // old results cleared
  await page.click('#run-lut');
  await page.waitForSelector('#err-lut:not([hidden])');
  assert.match(await page.textContent('#err-lut'), /لم تُرفع: b\.csv/);
  await page.click('#langToggle');
  await page.click('#run-lut');
  await page.waitForFunction(() => /not uploaded: b\.csv/.test(document.querySelector('#err-lut').textContent));
  await page.click('#langToggle');

  // A malformed row is refused with its line number.
  const bad = write('bad.csv', '1,6,0\n2,x,50\n');
  await page.setInputFiles('#lutFiles', [write('index.json', index([['base', 1.0, 'bad.csv']])), bad]);
  await page.click('#run-lut');
  await page.waitForFunction(() => /bad\.csv، السطر 2/.test(document.querySelector('#err-lut').textContent));

  // Generated example. Its exact RTPs were computed offline from the same files with
  // Python's fractions module: base 11119927911933037157/11523241359516100680,
  // bonus 52132551352438561841/54023369277138406050.
  await page.click('#sample-lut');
  await page.waitForFunction(() => document.querySelector('#name-lut').textContent.includes('lookUpTable_bonus_0.csv'));
  await page.click('#run-lut');
  await page.waitForSelector('#lut-submission');
  assert.ok(await page.isHidden('#err-lut'));
  const sampleRows = await page.$$eval('#res-lut .table-wrap:first-of-type tbody tr', (r) => r.map((x) => x.innerText));
  assert.ok(sampleRows[0].includes(percent6(11119927911933037157n, 11523241359516100680n)), sampleRows[0]);
  assert.ok(sampleRows[1].includes(percent6(52132551352438561841n, 54023369277138406050n)), sampleRows[1]);
  assert.ok(await page.$('#lut-submission.pass'), 'no submission issue');
  assert.match(await page.textContent('#res-lut'), /6 \/ 6/);
  assert.match(await page.textContent('#res-lut'), /rgs_verification\.py/);

  // PDF report with the LUT section and its input files attached.
  await page.click('#tab-report');
  assert.match(await page.textContent('#rep-sections'), /LUT/);
  await page.click('#run-report');
  await page.waitForSelector('#report-download');
  const [download] = await Promise.all([page.waitForEvent('download'), page.click('#report-download')]);
  const pdf = fs.readFileSync(await download.path()).toString('latin1');
  for (const name of ['report.json', 'index.json', 'lookUpTable_base_0.csv', 'lookUpTable_bonus_0.csv']) assert.ok(pdf.includes('(' + name + ')'), 'attachment ' + name);
  assert.ok(pdf.includes('"provablyFair":false'), 'report.json records that the LUT is not provably fair');
  assert.ok(pdf.includes('"lut":{'), 'report.json carries the LUT results');
  assert.ok(pdf.includes('Stake Engine RGS limits'), 'summary page names the profile');

  assert.deepStrictEqual(errors, []);
  const outside = requests.filter((r) => !r.url.startsWith('blob:') && !(r.method === 'GET' && /\/(lab|icons)\//.test(new URL(r.url).pathname)));
  assert.deepStrictEqual(outside, [], 'requests other than the lab\'s own static files');
});

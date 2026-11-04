// Browser tests for "Provably fair v2" in lab/index.html: the adapter selector with
// evidence levels and the Worker's self-test, locally generated samples, the batch
// audit catching planted problems, bustabit's real chain reaching its published
// terminating hash, and the report section.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const { startServer } = require('../helpers/dev-server');

let chromium;
try {
  ({ chromium } = require('playwright'));
} catch (e) {
  throw new Error('These tests need Playwright: npm install --no-save playwright && npx playwright install chromium');
}

async function openFair(t) {
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
  await page.click('#tab-fair');
  // the adapter list arrives from the Worker after its self-test
  await page.waitForFunction(() => document.querySelectorAll('#p-adapter option').length > 5);
  return { page, errors, requests };
}

async function sampleAndRun(page, adapter, { plant = false, version = null } = {}) {
  await page.selectOption('#p-adapter', adapter);
  if (version) await page.selectOption('#p-version', version);
  if (plant) await page.check('#p-plant'); else await page.uncheck('#p-plant');
  const before = await page.textContent('#name-fair');
  await page.click('#sample-fair');
  await page.waitForFunction((b) => document.querySelector('#name-fair').textContent !== b && !document.querySelector('#sample-fair').disabled, before);
  await page.click('#run-fair');
  await page.waitForFunction(() => !document.querySelector('#run-fair').disabled && document.querySelector('#pf-verdict'));
  return page.getAttribute('#pf-verdict', 'data-code');
}

test('provably fair v2: adapters, self-test, samples and the batch audit', async (t) => {
  const { page, errors, requests } = await openFair(t);

  // Every adapter is listed with its evidence level; none is disabled by the self-test.
  const options = await page.$$eval('#p-adapter option', (o) => o.map((x) => ({ value: x.value, text: x.textContent })));
  const ids = options.map((o) => o.value);
  for (const id of ['custom', 'stake', 'stake-crash', 'stake-slide', 'bustabit', 'primedice', 'duelbits', 'duel', 'bcgame-dice', 'bcgame-crash', 'aviator', 'roobet']) assert.ok(ids.includes(id), 'adapter ' + id);
  assert.ok(options.find((o) => o.value === 'aviator').text.includes('غير مؤكد'), 'Aviator is labelled unconfirmed');
  assert.ok(options.find((o) => o.value === 'duel').text.includes('موثّق'), 'Duel is labelled verified');
  assert.ok(!options.some((o) => o.text.includes('معطّل')), 'no adapter disabled');

  // Custom mode (the generic HMAC template) stays the default.
  assert.strictEqual(await page.inputValue('#p-adapter'), 'custom');
  assert.strictEqual(await page.isVisible('#hmacFields'), true);

  // Stake: info card with evidence badge and self-test; a clean sample passes.
  await page.selectOption('#p-adapter', 'stake');
  await page.waitForSelector('#pfInfo .ev-reference');
  assert.match(await page.textContent('#pfInfo .pf-selftest'), /14 \/ 14/);
  assert.strictEqual(await page.isVisible('#hmacFields'), false);
  assert.strictEqual(await sampleAndRun(page, 'stake'), 'PASS');
  assert.match(await page.textContent('#res-fair'), /600 \/ 600/);

  // Planted problems: a tampered result, a missing nonce, a wrong payout, a replayed seed.
  assert.strictEqual(await sampleAndRun(page, 'stake', { plant: true }), 'FAIL');
  const issues = await page.textContent('#pf-issues');
  for (const label of ['نتيجة منشورة تختلف عن المحسوبة', 'فجوة في تسلسل الـnonce', 'دفعة لا تطابق', 'عادت للاستعمال']) assert.ok(issues.includes(label), 'issue: ' + label);

  // BC.Game Dice has two versions; the legacy one is selectable.
  await page.selectOption('#p-adapter', 'bcgame-dice');
  assert.strictEqual(await page.isVisible('#p-version'), true);
  assert.strictEqual(await sampleAndRun(page, 'bcgame-dice', { version: 'legacy-2022' }), 'PASS');

  // bustabit: 300 real games ending at game 12,306,896; the chain reaches bustabit's
  // published terminating hash (about 2.3 million SHA-256 links in the Worker).
  assert.strictEqual(await sampleAndRun(page, 'bustabit'), 'PASS');
  assert.ok(await page.$('#pf-terminating.pass'), 'terminating hash reached');
  assert.ok(await page.$('#pfInfo .ev-verified'));

  // An unconfirmed formula is never a plain pass.
  assert.strictEqual(await sampleAndRun(page, 'roobet'), 'CONDITIONAL');

  // Report: the PF section and the data in report.json.
  await sampleAndRun(page, 'duel', { plant: true });
  await page.click('#tab-report');
  await page.click('#run-report');
  await page.waitForSelector('#report-download');
  const [download] = await Promise.all([page.waitForEvent('download'), page.click('#report-download')]);
  const pdf = fs.readFileSync(await download.path()).toString('latin1');
  assert.ok(pdf.includes('(report.json)'), 'report.json attached');
  // The ASCII summary page (PDF text strings escape parentheses).
  assert.ok(pdf.includes('Provably fair: adapter duel@v1 \\(evidence: verified'), 'ASCII summary line');
  assert.ok(pdf.includes('verdict FAIL \\(code 1\\)'), 'verdict in the summary');

  // English labels.
  await page.click('#langToggle');
  await page.click('#tab-fair');
  assert.match(await page.textContent('#pf-verdict'), /Fail/);
  assert.match(await page.textContent('#pfInfo'), /Verified/);

  assert.deepStrictEqual(errors, []);
  const outside = requests.filter((r) => !r.url.startsWith('blob:') && !(r.method === 'GET' && /\/(lab|icons)\//.test(new URL(r.url).pathname)));
  assert.deepStrictEqual(outside, [], 'requests other than the lab\'s own static files');
});

test('provably fair v2: an uploaded CSV with a malformed hash is "not checked", never a mismatch', async (t) => {
  const { page, errors } = await openFair(t);
  await page.selectOption('#p-adapter', 'primedice');
  // Primedice's published example (provably-fair-app README): roll 79.69 at nonce 0.
  const seed = '293d5d2ddd365f54759283a8097ab2640cbe6f8864adc2b1b31e65c14c999f04';
  const csv = ['server_seed,server_seed_hash,client_seed,nonce,result',
    `${seed},0x5AC59780D512265230D5EFB3CC238886DC1B457A80B54FBF1F920B99C6505801,ClientSeedForDiceSites.com,0,79.69`,
    `,5ac59780d512265230d5efb3cc238886dc1b457a80b54fbf1f92,other-client,0,12.34`].join('\n');
  const os = require('os'), path = require('path');
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lab-pf-')), 'primedice.csv');
  fs.writeFileSync(file, csv);
  await page.setInputFiles('#fairFile', file);
  await page.waitForFunction(() => document.querySelector('#name-fair').textContent.includes('primedice.csv'));
  await page.click('#run-fair');
  await page.waitForFunction(() => !document.querySelector('#run-fair').disabled && document.querySelector('#pf-verdict'));
  assert.strictEqual(await page.getAttribute('#pf-verdict', 'data-code'), 'CONDITIONAL');
  const text = await page.textContent('#res-fair');
  assert.match(text, /1 \/ 1/); // the 0x-prefixed upper-case hash was normalized and matched
  assert.ok(text.includes('hash مشوّه'), 'malformed hash reported as not checked');
  assert.deepStrictEqual(errors, []);
});

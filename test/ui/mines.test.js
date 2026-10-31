// Browser tests for lab/mines.html: the commitment check on a real round's hash and
// seed, the click-by-click ladder on typed multipliers, the history analysis, the
// language switch, the phone layout, and that nothing leaves the page.
const test = require('node:test');
const assert = require('node:assert');
const { startServer } = require('../helpers/dev-server');

let chromium;
try {
  ({ chromium } = require('playwright'));
} catch (e) {
  throw new Error('These tests need Playwright: npm install --no-save playwright && npx playwright install chromium');
}

test('mines page: commitment, ladder, walk, session, history and language work offline', async (t) => {
  const server = await startServer();
  const browser = await chromium.launch();
  t.after(async () => { await browser.close(); await server.close(); });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  page.setDefaultTimeout(60000);
  const errors = [], requests = [];
  page.on('pageerror', (e) => errors.push(e.message));
  ctx.on('request', (r) => requests.push({ method: r.method(), url: r.url() }));
  await page.goto(server.url + '/lab/mines.html');
  assert.match(await page.getAttribute('meta[http-equiv="Content-Security-Policy"]', 'content'), /connect-src 'none'/);
  assert.strictEqual(await page.evaluate(() => fetch('/api/auth', { method: 'POST' }).then(() => 'sent', () => 'blocked')), 'blocked');

  // The ladder renders on load with the defaults (3 mines, 10, 96%).
  await page.waitForSelector('#ladder-headline');
  assert.match(await page.textContent('#ladder-headline'), /9\.59 من 10/);
  assert.strictEqual(await page.$$eval('table.ladder tbody tr', (r) => r.length), 12);
  assert.match(await page.textContent('table.ladder tbody tr:first-child'), /12\.0%.*88\.0%.*×1\.14.*×1\.09.*4\.1%/s);

  // 1. Commitment: the provider's own worked example matches; a changed seed does not.
  await page.click('#example-commit');
  await page.waitForSelector('#commit-verdict');
  assert.match(await page.getAttribute('#commit-verdict', 'class'), /pass/);
  await page.fill('#c-seed', 'turbo-demo-round-7f3a92');
  await page.click('#run-commit');
  await page.waitForFunction(() => /fail/.test(document.querySelector('#commit-verdict').className));
  await page.fill('#c-seed', '');
  await page.click('#run-commit');
  assert.match(await page.textContent('#err-commit'), /أدخل البصمة والبذرة/);

  // 2. Typed multipliers from the real game: implied RTP consistent; a clone's are flagged.
  await page.fill('#l-mults', '1.09 1.24 1.43 1.66');
  await page.click('#run-ladder');
  await page.waitForSelector('#ladder-implied');
  assert.match(await page.textContent('#ladder-implied'), /95\.8%.*الجدول الأصلي/);
  assert.strictEqual(await page.$$eval('table.ladder .tag', (n) => n.length), 4);
  await page.fill('#l-mults', '1.00 1.10 1.20');
  await page.click('#run-ladder');
  await page.waitForFunction(() => /fail/.test(document.querySelector('#ladder-implied').className));
  assert.match(await page.textContent('#ladder-implied'), /ليست الجدول الأصلي/);
  await page.fill('#l-mults', '');
  await page.fill('#l-mines', '30');
  await page.click('#run-ladder');
  assert.match(await page.textContent('#err-ladder'), /من 1 إلى 24/);
  await page.fill('#l-mines', '5');
  await page.click('#run-ladder');
  await page.waitForFunction(() => document.querySelector('#err-ladder').hidden);
  assert.match(await page.textContent('table.ladder tbody tr:first-child'), /20\.0%/); // 5 of 25

  // Walk: each safe click shows the screen's multiplier against its worth.
  assert.match(await page.textContent('#walk-state'), /نقرة آمنة/);
  await page.click('#walk-safe');
  await page.click('#walk-safe');
  assert.strictEqual(await page.$$eval('#walk-grid .mtile.gem', (n) => n.length), 2);
  assert.match(await page.textContent('#walk-state'), /^بعد 2 نقرة/);
  await page.click('#walk-reset');
  assert.strictEqual(await page.$$eval('#walk-grid .mtile.gem', (n) => n.length), 0);

  // Session: more rounds, smaller chance of ending ahead.
  const ahead = async () => parseFloat(await page.$eval('#res-session .card:nth-child(3) .v', (n) => n.textContent));
  await page.fill('#s-rounds', '50');
  const a50 = await ahead();
  await page.fill('#s-rounds', '2000');
  const a2000 = await ahead();
  assert.ok(a50 > a2000, `${a50} > ${a2000}`);
  assert.match(await page.$eval('#res-session .card:nth-child(1) .v', (n) => n.textContent), /20,000/);

  // 3. History example and a bad paste.
  await page.click('#example-hist');
  await page.waitForSelector('#hist-verdict');
  const hist = await page.textContent('#res-hist');
  for (const v of ['20', '325', '175.1', '−149.9']) assert.ok(hist.includes(v), v + ' in ' + hist);
  await page.fill('#h-text', 'nothing');
  await page.click('#run-hist');
  assert.match(await page.textContent('#err-hist'), /سطرين على الأقل/);

  // Language switch re-renders everything.
  await page.click('#langToggle');
  assert.strictEqual(await page.getAttribute('html', 'dir'), 'ltr');
  assert.strictEqual(await page.textContent('h1'), 'Mines from A to Z');
  assert.match(await page.textContent('#ladder-headline'), /^Wherever you stop/);
  assert.match(await page.textContent('#commit-verdict'), /No match/);
  assert.strictEqual(await page.getAttribute('#site-link', 'href'), 'casino-check.html');

  assert.deepStrictEqual(errors, []);
  const outside = requests.filter((r) => !(r.method === 'GET' && /\/(lab|icons)\//.test(new URL(r.url).pathname)));
  assert.deepStrictEqual(outside, [], 'requests other than the page\'s own static files');
});

test('mines page fits a phone screen and the app pages link to it', async (t) => {
  const server = await startServer();
  const browser = await chromium.launch();
  t.after(async () => { await browser.close(); await server.close(); });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  page.setDefaultTimeout(60000);
  await page.goto(server.url + '/lab/mines.html');
  await page.waitForSelector('#ladder-headline');
  await page.click('#example-hist');
  await page.waitForSelector('#hist-verdict');
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'no horizontal scroll');
  for (const p of ['/lab/casino.html', '/lab/casino-check.html']) {
    await page.goto(server.url + p);
    await page.waitForFunction(() => document.querySelector('a[href="mines.html"]').textContent.length > 0);
    assert.strictEqual(await page.textContent('a[href="mines.html"]'), 'Mines من أ إلى ي');
  }
  await page.goto(server.url + '/');
  await page.waitForTimeout(500);
  assert.strictEqual(await page.getAttribute('#linkMines', 'href'), 'lab/mines.html');
});

// Browser smoke test for index.html. The whole app lives in one inline script, so a
// single binding to a missing element (e.g. $('#btnToggleHistory').onclick after the
// button was removed from the markup) throws and silently skips everything after it:
// settings, all security tools, the command palette and the boot code.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { startServer, ROOT } = require('../helpers/dev-server');

let chromium;
try {
  ({ chromium } = require('playwright'));
} catch (e) {
  throw new Error('These tests need Playwright: npm install --no-save playwright && npx playwright install chromium');
}

// Ids the inline script dereferences directly, e.g. $('#x').onclick or $('#x').value.
// Optional-chained uses ($('#x')?.foo) are skipped because they tolerate a missing element.
function directlyBoundIds() {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n');
  return [...new Set([...script.matchAll(/\$\('#([\w-]+)'\)\.(?!\.)/g)].map((m) => m[1]))];
}

test('index.html boots without JavaScript errors and every bound element exists', async (t) => {
  const server = await startServer();
  const browser = await chromium.launch();
  t.after(async () => { await browser.close(); await server.close(); });

  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(server.url + '/', { waitUntil: 'load' });
  await page.waitForTimeout(1000);

  assert.deepStrictEqual(errors, [], 'uncaught errors while loading the page');

  const toolCount = await page.evaluate(() => document.querySelectorAll('#secToolsNav button').length);
  assert.strictEqual(toolCount, 18, 'boot code did not run: security tools list is empty');
  const projects = await page.evaluate(() => document.querySelectorAll('#history > *').length);
  assert.ok(projects >= 1, 'boot code did not run: no project in the sidebar');

  const ids = directlyBoundIds();
  assert.ok(ids.length > 50, 'expected to find the script\'s element bindings, found ' + ids.length);
  const missing = await page.evaluate((list) => list.filter((id) => !document.getElementById(id)), ids);
  assert.deepStrictEqual(missing, [], 'script binds elements that are not in the page');
});

test('header buttons wired at the end of the script respond', async (t) => {
  const server = await startServer();
  const browser = await chromium.launch();
  t.after(async () => { await browser.close(); await server.close(); });

  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  page.setDefaultTimeout(5000);
  await page.goto(server.url + '/', { waitUntil: 'load' });
  await page.click('#btnGuestMode');

  // Phones: the account button opens the sidebar drawer with the account menu.
  await page.click('#btnAcctMobile');
  await page.click('#miSettings');
  assert.ok(await page.evaluate(() => document.querySelector('#settingsDialog').open), 'settings did not open');
  await page.click('#btnCancelSettings');
  await page.evaluate(() => closeDrawers());

  await page.click('#btnHeaderMenu');
  await page.click('#btnSecTools');
  assert.ok(await page.evaluate(() => document.querySelector('#secToolsDialog').open), 'security tools did not open');
  await page.click('#btnCloseSecTools');

  await page.click('#btnHeaderMenu');
  await page.click('#btnToggleHistory');
  assert.ok(await page.evaluate(() => document.querySelector('#workarea').classList.contains('open')), 'code/preview panel did not open');
});

test('security operations home: shown on an empty chat, its tiles open the matching tool', async (t) => {
  const server = await startServer();
  const browser = await chromium.launch();
  t.after(async () => { await browser.close(); await server.close(); });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  page.setDefaultTimeout(5000);
  await page.goto(server.url + '/');
  await page.click('#btnGuestMode');
  assert.ok(await page.isVisible('#socHome'), 'SOC home hidden on an empty chat');
  assert.strictEqual(await page.$$eval('#socHome [data-soc-tool]', (b) => b.length), 8);
  assert.strictEqual(await page.textContent('#sysChipText'), 'ONLINE');
  await page.click('#socHome [data-soc-tool="jwt"]');
  assert.ok(await page.evaluate(() => document.querySelector('#secToolsDialog').open), 'tools dialog did not open');
  assert.strictEqual(await page.getAttribute('.secToolNavBtn.active', 'data-tool'), 'jwt');
});

test('account bar: settings, language and log in sit at the bottom of the sidebar', async (t) => {
  const server = await startServer();
  const browser = await chromium.launch();
  t.after(async () => { await browser.close(); await server.close(); });
  const page = await browser.newPage({ viewport: { width: 1366, height: 820 } });
  page.setDefaultTimeout(5000);
  await page.goto(server.url + '/');
  await page.click('#btnGuestMode');
  assert.strictEqual(await page.$('header #btnSettings'), null, 'settings still in the header');
  const bar = await page.$eval('#acctBar', (b) => { const r = b.getBoundingClientRect(); const s = document.querySelector('#sidebar').getBoundingClientRect(); return { gap: s.bottom - r.bottom }; });
  assert.ok(bar.gap < 2, 'account bar is not at the bottom of the sidebar');
  assert.strictEqual(await page.textContent('#acctName'), 'ضيف');
  await page.click('#btnSettings');
  assert.ok(await page.evaluate(() => document.querySelector('#settingsDialog').open), 'gear did not open settings');
  await page.click('#btnCancelSettings');
  await page.keyboard.press('Control+,');
  assert.ok(await page.evaluate(() => document.querySelector('#settingsDialog').open), 'Ctrl+, did not open settings');
  await page.click('#btnCancelSettings');
  await page.click('#btnAcct');
  assert.ok(await page.isVisible('#acctMenu'), 'menu did not open');
  assert.ok(await page.isVisible('#btnAcctLogin') && !(await page.isVisible('#btnLogout')), 'guest sees log in, not log out');
  await page.click('#miLang');
  assert.strictEqual(await page.getAttribute('html', 'dir'), 'ltr');
  assert.strictEqual(await page.textContent('#acctName'), 'Guest');
  await page.click('#btnAcct');
  await page.click('#btnAcctLogin');
  assert.ok(await page.isVisible('#authOverlay'), 'log in did not open the login screen');
});

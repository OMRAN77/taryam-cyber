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

  // The code / preview labels and their menu entry are gone.
  assert.strictEqual(await page.$('#btnToggleHistory'), null);
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
  assert.strictEqual(await page.$eval('#socHome', (e) => getComputedStyle(e).flexDirection), 'column', 'SOC home stacks its sections');
  assert.ok(!(await page.isVisible('#chatHint')), 'the desktop hint does not overlap the phone SOC home');
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

test('a formal console: no emoji anywhere on the page, icon-only send, phone account menu under the header', async (t) => {
  const server = await startServer();
  const browser = await chromium.launch();
  t.after(async () => { await browser.close(); await server.close(); });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  page.setDefaultTimeout(5000);
  await page.goto(server.url + '/');
  const emojiIn = () => page.evaluate(() => (document.body.innerText.match(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{26FF}\u{2B50}\u{2B55}]/gu) || []));
  assert.deepStrictEqual(await emojiIn(), [], 'login screen');
  await page.click('#btnGuestMode');
  assert.deepStrictEqual(await emojiIn(), [], 'console');
  assert.strictEqual(await page.$('#btnEmoji'), null);
  assert.strictEqual(await page.getAttribute('#btnSend', 'aria-label'), 'إرسال');
  assert.ok(!(await page.isVisible('#btnSend span')), 'send shows an icon, not a label');
  await page.click('#btnAcctMobile');
  const pos = await page.evaluate(() => ({ menu: parseFloat(document.querySelector('#acctMenu').style.top), header: document.querySelector('header').getBoundingClientRect().bottom, drawer: document.querySelector('#sidebar').classList.contains('open') }));
  assert.ok(pos.menu >= pos.header && !pos.drawer, `menu drops below the header without the drawer (${JSON.stringify(pos)})`);
  await page.click('#miSettings');
  assert.ok(await page.evaluate(() => document.querySelector('#settingsDialog').open), 'settings did not open');
  assert.deepStrictEqual(await emojiIn(), [], 'settings');
});

test('desktop: the side panel stays, without Preview / Code / Download, and holds the operations center', async (t) => {
  const server = await startServer();
  const browser = await chromium.launch();
  t.after(async () => { await browser.close(); await server.close(); });
  const page = await browser.newPage({ viewport: { width: 1366, height: 820 } });
  page.setDefaultTimeout(5000);
  await page.goto(server.url + '/');
  await page.click('#btnGuestMode');
  assert.ok(await page.isVisible('#workarea'), 'the panel is still there');
  for (const sel of ['#tabs', '#btnDownload', '#previewFrame', '#code']) assert.ok(!(await page.isVisible(sel)), sel + ' is hidden');
  assert.strictEqual(await page.$$eval('#socPanel [data-soc-tool]', (b) => b.length), 8);
  assert.ok(!(await page.isVisible('#socHome')), 'the chat copy is for phones only');
  assert.ok(await page.isVisible('#chatHint'), 'the empty chat shows a hint');
  assert.strictEqual(await page.textContent('#projCount'), '01');
  await page.click('#socPanel [data-soc-tool="hashid"]');
  assert.strictEqual(await page.getAttribute('.secToolNavBtn.active', 'data-tool'), 'hashid');
});

test('desktop drag bars push either side panel all the way in, and a double-click brings it back', async (t) => {
  const server = await startServer();
  const browser = await chromium.launch();
  t.after(async () => { await browser.close(); await server.close(); });
  const page = await browser.newPage({ viewport: { width: 1366, height: 820 } });
  page.setDefaultTimeout(5000);
  await page.goto(server.url + '/');
  await page.click('#btnGuestMode');
  const width = (sel) => page.$eval(sel, (e) => Math.round(e.getBoundingClientRect().width));
  const drag = async (sel, dx) => {
    const b = await (await page.$(sel)).boundingBox();
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
    await page.mouse.down();
    await page.mouse.move(b.x + b.width / 2 + dx, b.y + b.height / 2, { steps: 8 });
    await page.mouse.up();
  };
  // Arabic layout: projects on the right, operations panel on the left.
  assert.ok(await width('#sidebar') > 150);
  await drag('#resizer1', 400);
  assert.strictEqual(await width('#sidebar'), 0, 'projects sidebar pushed all the way in');
  await page.dblclick('#resizer1');
  assert.ok(await width('#sidebar') >= 200, 'double-click brings it back');

  const before = await width('#workarea');
  assert.ok(before > 300);
  await drag('#resizer2', -1200);
  assert.strictEqual(await width('#workarea'), 0, 'operations panel pushed all the way in');
  assert.ok(await width('#chatcol') > 900, 'the chat takes the room');
  await page.dblclick('#resizer2');
  assert.ok(await width('#workarea') >= 300, 'double-click brings the panel back');
  await drag('#resizer2', 1200);
  assert.ok(await width('#chatcol') >= 320, 'the chat keeps at least 320px');

  // Widths survive a reload.
  await drag('#resizer1', 400);
  await page.reload();
  await page.click('#btnGuestMode');
  assert.strictEqual(await width('#sidebar'), 0);
});

test('header panel buttons: collapse / restore on desktop, open the drawer on a phone', async (t) => {
  const server = await startServer();
  const browser = await chromium.launch();
  t.after(async () => { await browser.close(); await server.close(); });
  const width = (page, sel) => page.$eval(sel, (e) => Math.round(e.getBoundingClientRect().width));
  const desk = await browser.newPage({ viewport: { width: 1366, height: 820 } });
  desk.setDefaultTimeout(5000);
  await desk.goto(server.url + '/');
  await desk.click('#btnGuestMode');
  assert.strictEqual(await desk.getAttribute('#btnToggleSide', 'aria-expanded'), 'true');
  await desk.click('#btnToggleSide');
  assert.strictEqual(await width(desk, '#sidebar'), 0, 'projects hidden');
  assert.strictEqual(await desk.getAttribute('#btnToggleSide', 'aria-expanded'), 'false');
  await desk.click('#btnToggleSide');
  assert.ok(await width(desk, '#sidebar') >= 200, 'projects back');
  await desk.click('#btnTogglePanel');
  assert.strictEqual(await width(desk, '#workarea'), 0, 'operations panel hidden');
  await desk.click('#btnTogglePanel');
  assert.ok(await width(desk, '#workarea') >= 300, 'operations panel back');

  const phone = await browser.newPage({ viewport: { width: 553, height: 760 } });
  phone.setDefaultTimeout(5000);
  await phone.goto(server.url + '/');
  await phone.click('#btnGuestMode');
  await phone.click('#btnToggleSide');
  await phone.waitForFunction(() => document.querySelector('#sidebar').classList.contains('open'));
  await phone.evaluate(() => closeDrawers());
  await phone.click('#btnTogglePanel');
  await phone.waitForFunction(() => document.querySelector('#workarea').classList.contains('open'));
  assert.strictEqual(await phone.$$eval('#socPanel [data-soc-tool]', (b) => b.length), 8, 'the operations panel opens as a drawer');
});

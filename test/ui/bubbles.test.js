// Browser test for files shown inside a sent message. Sending only attachments used
// to render a lone "📎" line and grey file names on the purple→cyan user bubble,
// wrapped into ragged rows. Now: no placeholder line, readable white pills, and more
// than six files collapse behind a "+N" pill that expands on click.
const test = require('node:test');
const assert = require('node:assert');
const { startServer } = require('../helpers/dev-server');

let chromium;
try {
  ({ chromium } = require('playwright'));
} catch (e) {
  throw new Error('These tests need Playwright: npm install --no-save playwright && npx playwright install chromium');
}

const NAMES = ['core.js', 'content.js', 'consensus.js', 'ai.js', 'inpage.js', 'demo-config.js',
  'demo-background.js', 'predict.js', 'manifest.json', 'local-trial.js'];

test('files sent alone render as readable pills, six then "+4"', async (t) => {
  const server = await startServer();
  const browser = await chromium.launch();
  t.after(async () => { await browser.close(); await server.close(); });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.setDefaultTimeout(20000);
  await page.route('**/api/deepseek', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ choices: [{ message: { content: 'تمام' } }] }) }));
  await page.goto(server.url + '/', { waitUntil: 'load' });
  await page.click('#btnGuestMode');
  await page.setInputFiles('#attachInput', NAMES.map((name) => ({ name, mimeType: 'text/plain', buffer: Buffer.from('// ' + name) })));
  await page.waitForSelector('.attach-chip');
  await page.click('#btnSend');
  await page.waitForFunction(() => !document.querySelector('#btnSend').disabled);

  const r = await page.evaluate(() => {
    const bubble = document.querySelector('#messages .msg.user');
    const b = bubble.getBoundingClientRect();
    const pills = [...bubble.querySelectorAll('.msg-file:not(.more)')];
    const shown = pills.filter((p) => getComputedStyle(p).display !== 'none');
    const more = bubble.querySelector('.msg-file.more');
    const inside = shown.every((p) => { const q = p.getBoundingClientRect(); return q.left >= b.left - 1 && q.right <= b.right + 1 && q.top >= b.top - 1 && q.bottom <= b.bottom + 1; });
    return {
      hasPlaceholder: [...bubble.children].some((c) => c.textContent.trim() === '📎'),
      total: pills.length,
      shown: shown.length,
      firstName: shown[0] && shown[0].querySelector('.nm').textContent,
      color: shown[0] && getComputedStyle(shown[0]).color,
      more: more && more.textContent,
      inside,
    };
  });
  assert.strictEqual(r.hasPlaceholder, false, 'no lone 📎 line');
  assert.strictEqual(r.total, 10);
  assert.strictEqual(r.shown, 6);
  assert.strictEqual(r.firstName, 'core.js');
  assert.strictEqual(r.color, 'rgb(255, 255, 255)', 'white text on the user bubble');
  assert.strictEqual(r.more, '+4');
  assert.ok(r.inside, 'pills stay inside the bubble');

  await page.click('#messages .msg.user .msg-file.more');
  const after = await page.evaluate(() => {
    const bubble = document.querySelector('#messages .msg.user');
    return {
      shown: [...bubble.querySelectorAll('.msg-file:not(.more)')].filter((p) => getComputedStyle(p).display !== 'none').length,
      more: !!bubble.querySelector('.msg-file.more'),
    };
  });
  assert.deepStrictEqual(after, { shown: 10, more: false });
});

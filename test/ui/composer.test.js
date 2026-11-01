// Browser test for the floating chat dock (#inputbar). The provider toggles and the
// attachment chips used to sit in normal flow at the bottom of the chat column, i.e.
// underneath the absolutely positioned dock: the toggles were hidden behind it and
// attached files showed up below it, cut off by the window edge.
const test = require('node:test');
const assert = require('node:assert');
const { startServer } = require('../helpers/dev-server');

let chromium;
try {
  ({ chromium } = require('playwright'));
} catch (e) {
  throw new Error('These tests need Playwright: npm install --no-save playwright && npx playwright install chromium');
}

const FILES = ['demo-config.js', 'inpage.js', 'local-trial.js', 'manifest.json', 'predict.js']
  .map((name) => ({ name, mimeType: 'text/plain', buffer: Buffer.from('// ' + name) }));

for (const [label, viewport] of [['desktop', { width: 1280, height: 760 }], ['mobile', { width: 390, height: 760 }]]) {
  test(`${label}: toggles and attached files sit inside the dock, uncovered`, async (t) => {
    const server = await startServer();
    const browser = await chromium.launch();
    t.after(async () => { await browser.close(); await server.close(); });
    const page = await browser.newPage({ viewport });
    await page.goto(server.url + '/', { waitUntil: 'load' });
    await page.click('#btnGuestMode');
    await page.setInputFiles('#attachInput', FILES);
    await page.waitForSelector('.attach-chip');
    // --dock-h follows the dock through a ResizeObserver, which runs after layout: wait for it.
    await page.waitForFunction(() => parseFloat(getComputedStyle(document.querySelector('#messages')).paddingBottom)
      >= document.querySelector('#inputbar').getBoundingClientRect().height);

    const r = await page.evaluate(() => {
      const box = (el) => el.getBoundingClientRect();
      const dock = box(document.querySelector('#inputbar'));
      const inside = (b) => b.top >= dock.top - 0.5 && b.bottom <= dock.bottom + 0.5;
      // The element actually on top at a point (nothing may cover our controls).
      const reachable = (el) => {
        const b = box(el);
        const hit = document.elementFromPoint(b.left + Math.min(b.width / 2, 20), b.top + b.height / 2);
        return !!hit && (hit === el || el.contains(hit));
      };
      const chips = [...document.querySelectorAll('.attach-chip')];
      const strip = document.querySelector('#attachStrip');
      const messages = document.querySelector('#messages');
      return {
        chipCount: chips.length,
        chipsInDock: chips.every((c) => c.closest('#inputbar')),
        stripInside: inside(box(strip)),
        stripInViewport: box(strip).bottom <= window.innerHeight,
        firstChipReachable: reachable(chips[0]),
        togglesInside: inside(box(document.querySelector('#chat-toggles'))),
        askAllReachable: reachable(document.querySelector('#chip-askall')),
        mergeReachable: reachable(document.querySelector('#chip-merge')),
        attachReachable: reachable(document.querySelector('#btnAttach')),
        dockHeight: Math.round(dock.height),
        messagesPadBottom: parseFloat(getComputedStyle(messages).paddingBottom),
      };
    });

    assert.strictEqual(r.chipCount, 5);
    assert.ok(r.chipsInDock, 'chips are rendered inside the dock');
    assert.ok(r.stripInside && r.stripInViewport, 'attachment row is within the dock and the window');
    assert.ok(r.firstChipReachable, 'first attachment chip is not covered');
    assert.ok(r.togglesInside, 'provider toggles are within the dock');
    assert.ok(r.askAllReachable && r.mergeReachable, 'provider toggles can be clicked');
    // In Arabic (the default, RTL) a closed drawer used to sit over this button on phones.
    assert.ok(r.attachReachable, 'attach button is not covered');
    assert.ok(r.messagesPadBottom >= r.dockHeight, `messages keep clear of the dock (${r.messagesPadBottom} < ${r.dockHeight})`);

    // The toggles really work from their new place.
    await page.click('#chip-askall');
    assert.strictEqual(await page.isChecked('#chkAskAll'), true);
  });
}

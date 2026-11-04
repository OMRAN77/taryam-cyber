// Browser test for the off-canvas projects drawer (#sidebar) used at widths of 860px
// or less and whenever html.mobile-ui is set. (The #workarea code / preview drawer is
// retired: it must stay hidden.)
// In Arabic (RTL, the default) the closed drawers used to be pinned to the left
// edge and slid right by only their own width, so they stayed on screen over the
// chat and swallowed taps on the dock: the attach button, the Ask-all / Merge
// toggles. Closed drawers must be fully off-screen and must not intercept clicks;
// open drawers must sit fully on screen against the reading-start edge.
const test = require('node:test');
const assert = require('node:assert');
const { startServer } = require('../helpers/dev-server');

let chromium;
try {
  ({ chromium } = require('playwright'));
} catch (e) {
  throw new Error('These tests need Playwright: npm install --no-save playwright && npx playwright install chromium');
}

const DOCK = ['#btnAttach', '#chip-askall', '#chip-merge', '#prompt', '#btnSend'];

const CASES = [
  { lang: 'ar', width: 390, height: 760 },
  { lang: 'ar', width: 860, height: 1000 },
  { lang: 'en', width: 390, height: 760 },
  { lang: 'en', width: 860, height: 1000 },
  // The html.mobile-ui fallback forces the drawer layout at any width.
  { lang: 'ar', width: 1280, height: 800, mobileUi: true },
  { lang: 'en', width: 1280, height: 800, mobileUi: true },
];

// Geometry of both drawers, plus whether each is where it should be.
function geometry(page) {
  return page.evaluate(() => {
    const iw = window.innerWidth;
    const rtl = document.documentElement.dir === 'rtl';
    const rect = (sel) => {
      const b = document.querySelector(sel).getBoundingClientRect();
      return {
        left: Math.round(b.left), right: Math.round(b.right),
        // Closed: entirely past the reading-start edge (right in RTL, left in LTR).
        closed: rtl ? b.left >= iw - 0.5 : b.right <= 0.5,
        // Open: entirely on screen and flush with the reading-start edge.
        open: b.left >= -0.5 && b.right <= iw + 0.5 && (rtl ? Math.abs(b.right - iw) <= 0.5 : Math.abs(b.left) <= 0.5),
      };
    };
    return { iw, rtl, scrollWidth: document.documentElement.scrollWidth, sidebar: rect('#sidebar'), workareaHidden: getComputedStyle(document.querySelector('#workarea')).display === 'none' };
  });
}

// Waits (through the slide transition) until `want` holds, then returns the geometry.
async function settle(page, want) {
  await page.waitForFunction((w) => {
    const iw = window.innerWidth, rtl = document.documentElement.dir === 'rtl';
    return Object.entries(w).every(([sel, state]) => {
      const b = document.querySelector(sel).getBoundingClientRect();
      if (state === 'closed') return rtl ? b.left >= iw - 0.5 : b.right <= 0.5;
      return b.left >= -0.5 && b.right <= iw + 0.5 && (rtl ? Math.abs(b.right - iw) <= 0.5 : Math.abs(b.left) <= 0.5);
    });
  }, want, { timeout: 3000 }).catch(() => {});
  return geometry(page);
}

for (const { lang, width, height, mobileUi } of CASES) {
  const label = `${lang} ${width}px${mobileUi ? ' html.mobile-ui' : ''}`;
  test(`${label}: closed drawers are off-screen and leave the dock clickable; open drawers sit on the start edge`, async (t) => {
    const server = await startServer();
    const browser = await chromium.launch();
    t.after(async () => { await browser.close(); await server.close(); });
    const ctx = await browser.newContext({ viewport: { width, height } });
    await ctx.addInitScript((l) => { try { localStorage.setItem('aiapp_lang', l); } catch (e) {} }, lang);
    const page = await ctx.newPage();
    page.setDefaultTimeout(10000);
    await page.goto(server.url + '/', { waitUntil: 'load' });
    await page.click('#btnGuestMode');
    if (mobileUi) await page.evaluate(() => document.documentElement.classList.add('mobile-ui'));

    let g = await settle(page, { '#sidebar': 'closed' });
    assert.strictEqual(g.rtl, lang === 'ar', 'page direction follows the language');
    assert.ok(g.sidebar.closed, `closed sidebar is off-screen (${JSON.stringify(g.sidebar)}, viewport ${g.iw})`);
    assert.ok(g.workareaHidden, 'the retired code / preview pane stays hidden');
    assert.ok(g.scrollWidth <= g.iw, `no horizontal scroll (${g.scrollWidth} > ${g.iw})`);

    // Nothing sits on top of the dock controls (hit-test at each control's centre).
    const covered = await page.evaluate((sels) => sels.flatMap((sel) => {
      const el = document.querySelector(sel);
      const b = el.getBoundingClientRect();
      const hit = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
      return hit && (hit === el || el.contains(hit)) ? [] : [`${sel} is covered by ${hit ? (hit.closest('[id]') || hit).id || hit.tagName : 'nothing'}`];
    }), DOCK);
    assert.deepStrictEqual(covered, [], 'dock controls are not covered');

    // A real click on the paperclip reaches it and opens the file chooser.
    const [chooser] = await Promise.all([
      page.waitForEvent('filechooser', { timeout: 5000 }),
      page.click('#btnAttach', { timeout: 5000 }),
    ]);
    assert.ok(chooser.isMultiple(), 'the attach button opened the file chooser');

    // The drawer opens from the header menu onto the start edge, and closes again
    // fully off-screen when the backdrop is tapped.
    await page.click('#btnHeaderMenu');
    await page.click('#btnToggleProjects');
    g = await settle(page, { '#sidebar': 'open' });
    assert.ok(g.sidebar.open, `open sidebar is on screen against the ${g.rtl ? 'right' : 'left'} edge (${JSON.stringify(g.sidebar)}, viewport ${g.iw})`);
    // Tap the backdrop on the side away from the drawer.
    await page.mouse.click(g.rtl ? 5 : g.iw - 5, Math.round(height / 2));
    g = await settle(page, { '#sidebar': 'closed' });
    assert.ok(g.sidebar.closed, `drawer closed again (${JSON.stringify(g.sidebar)})`);
  });
}

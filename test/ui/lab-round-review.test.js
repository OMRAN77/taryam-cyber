// Browser test for the review fixes of the ways + whole-round integration:
//  * a model without a whole-round distribution (the Oasis Caravan closed form) turns the
//    max-win cap controls off instead of asking for a theoretical run it already has;
//  * a cascading game's odds verdict carries the first-drop label;
//  * an exact top-win probability below 1e-300 is written in full, never as 0 (the value
//    itself is checked in test/lab/round-ways-review.test.mjs; here: no "0", and the
//    exponent from the published spin pmf: P = c_trig/T x (4/61,709,340)^50 is about
//    10^-367, since 50 x log10(4/61,709,340) = -359.4 and c_trig/T is about 1e-8);
//  * on a 390px phone the big-wins table fits the screen and the funnel's axis numbers
//    are drawn at a readable size;
//  * the signed report's references rows (real fonts): labels and value do not overlap.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
const { startServer } = require('../helpers/dev-server');

let chromium;
try {
  ({ chromium } = require('playwright'));
} catch (e) {
  throw new Error('These tests need Playwright: npm install --no-save playwright && npx playwright install chromium');
}
const ROOT = path.join(__dirname, '..', '..');
const esm = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href);

// Records every text the report draws on a canvas, with its box from the browser's own
// fonts; a page starts where the layout clears the whole canvas.
function recordCanvasText() {
  const pages = [];
  let rec = null;
  window.__pages = pages;
  const P = CanvasRenderingContext2D.prototype;
  const fillRect = P.fillRect, fillText = P.fillText;
  P.fillRect = function (x, y, w, h) {
    if (x === 0 && y === 0 && w === this.canvas.width && h === this.canvas.height && w > 1000) { rec = []; pages.push(rec); }
    return fillRect.call(this, x, y, w, h);
  };
  P.fillText = function (s, x, y, ...rest) {
    if (rec && this.canvas.width > 1000) {
      const w = this.measureText(String(s)).width;
      // Canvas text with direction rtl and align right ends at x, as with ltr.
      const a = this.textAlign === 'start' ? (this.direction === 'rtl' ? 'right' : 'left') : this.textAlign === 'end' ? (this.direction === 'rtl' ? 'left' : 'right') : this.textAlign;
      rec.push({ s: String(s), y, x0: a === 'left' ? x : a === 'right' ? x - w : x - w / 2, x1: a === 'left' ? x + w : a === 'right' ? x : x + w / 2 });
    }
    return fillText.call(this, s, x, y, ...rest);
  };
}

test('RTP lab review fixes: cap controls without a round, first-drop odds, tiny exact probabilities, phone layout, report references', async (t) => {
  const { MINI } = await esm('test/helpers/ways-brute.mjs');
  const server = await startServer();
  const browser = await chromium.launch();
  t.after(async () => { await browser.close(); await server.close(); });
  const ctx = await browser.newContext({ acceptDownloads: true, viewport: { width: 1280, height: 900 } });
  await ctx.addInitScript(recordCanvasText);
  const page = await ctx.newPage();
  page.setDefaultTimeout(180000);
  const errors = [], requests = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  ctx.on('request', (r) => requests.push({ method: r.method(), url: r.url() }));
  await page.goto(server.url + '/lab/index.html');

  const runTheory = async () => {
    await page.evaluate(() => document.querySelector('#res-theory').replaceChildren());
    await page.click('#run-theory');
    await page.waitForFunction(() => !document.querySelector('#run-theory').disabled && (document.querySelector('#res-theory .card') || !document.querySelector('#err-theory').hidden));
    assert.ok(await page.isHidden('#err-theory'), 'theory error: ' + await page.textContent('#err-theory'));
  };
  const rowsOf = (sel) => page.$$eval(sel + ' tbody tr', (rs) => rs.map((r) => [...r.cells].map((c) => c.textContent.replace(/[⁦-⁩]/g, '').trim())));
  const capControls = () => page.evaluate(() => ['#r-cap', '#r-odds', '#run-round'].map((s) => document.querySelector(s).disabled));

  // ---- No whole-round distribution: the cap controls are off ----
  await page.click('[data-sample="oasisCaravanWays"]');
  await runTheory();
  assert.ok(await page.isVisible('#round-error'));
  assert.deepStrictEqual(await capControls(), [true, true, true]);
  // ---- A cascading ways game: controls on; the odds verdict says first drop only ----
  await page.fill('#f-json', JSON.stringify({ ...MINI, cascades: true }));
  await runTheory();
  assert.deepStrictEqual(await capControls(), [false, false, false]);
  await page.fill('#r-cap', '5');
  await page.check('#r-odds');
  await page.click('#run-round');
  await page.waitForSelector('#round-odds');
  assert.ok(await page.isHidden('#err-round'));
  assert.match(await page.textContent('#round-odds-first-drop'), /أول سقوط فقط: احتمال الجائزة العليا هنا من توزيع أول سقوط/);
  // The same game without cascades: no such label.
  await page.fill('#f-json', JSON.stringify(MINI));
  await runTheory();
  await page.click('#run-round');
  await page.waitForSelector('#round-odds');
  assert.strictEqual(await page.$('#round-odds-first-drop'), null);

  // ---- Desert Gold without retrigger, 50 free spins: the top win is about 1e-367 ----
  await page.click('[data-sample="desertGold"]');
  await page.uncheck('#f-fsRetrigger');
  await page.fill('#f-fsSpins', '50');
  await runTheory();
  const dg = await rowsOf('#round-big');
  const topRow = dg[dg.length - 1];
  assert.match(topRow[1], /^\d\.\d{3}e-36\d$/, 'probability of the top win: ' + topRow[1]);
  assert.match(topRow[2], /^\d\.\d\de\+36\d$/, 'once every ... rounds: ' + topRow[2]);
  assert.strictEqual(topRow[3], 'دقيق');
  assert.ok((await page.textContent('#res-round')).includes(topRow[1]), 'the top-win card shows it too');

  // ---- Phone, 390px, Arabic and English: the big-wins table and the funnel ----
  const raw = JSON.parse(JSON.stringify(MINI));
  Object.assign(raw.scatter.freeSpins, { maxSpins: 25, maxRetriggers: 3 });
  await page.click('[data-sample="oasisCaravanWays"]');
  await page.fill('#f-json', JSON.stringify(raw));
  await runTheory();
  await page.fill('#s-rounds', '200');
  await page.fill('#s-bet', '2');
  await page.click('#run-session');
  await page.waitForSelector('#sess-funnel');
  for (const lang of ['ar', 'en']) {
    if (lang === 'en') await page.click('#langToggle');
    await page.setViewportSize({ width: 390, height: 900 });
    if (lang === 'ar') {
      // The funnel is drawn for the screen it is computed on.
      await page.evaluate(() => document.querySelector('#res-session').replaceChildren());
      await page.click('#run-session');
      await page.waitForSelector('#sess-funnel');
    }
    const fit = await page.$eval('#round-big', (w) => ({ sw: w.scrollWidth, cw: w.clientWidth, right: w.getBoundingClientRect().right }));
    assert.ok(fit.sw <= fit.cw + 1 && fit.right <= 390, `${lang}: the big-wins table fits the screen: ${JSON.stringify(fit)}`);
    const funnel = await page.$eval('#sess-funnel', (s) => {
      const scale = s.getBoundingClientRect().width / s.viewBox.baseVal.width;
      return { px: parseFloat(getComputedStyle(s.querySelector('text')).fontSize) * scale, width: s.getBoundingClientRect().width };
    });
    assert.ok(funnel.px >= 9, `${lang}: funnel axis numbers at ${funnel.px.toFixed(1)}px`);
    assert.ok(funnel.width <= 390);
    const doc = await page.evaluate(() => ({ sw: document.scrollingElement.scrollWidth, cw: document.scrollingElement.clientWidth }));
    assert.ok(doc.sw <= doc.cw + 1, `${lang}: no sideways page scroll`);
    if (lang === 'en') await page.click('#langToggle');
  }
  await page.setViewportSize({ width: 1280, height: 900 });

  // ---- The signed report of a ways model: its references rows do not overlap ----
  await page.fill('#r-cap', '5');
  await page.click('#run-round');
  await page.waitForSelector('#round-cap-cards');
  await page.click('#tab-report');
  await page.click('#run-report');
  await page.waitForSelector('#report-download');
  const overlaps = await page.evaluate(() => {
    const ids = ['Stake Engine math-sdk (ways)', 'FIPS 180-4', 'PDF 1.4'];
    const out = [];
    let rows = 0;
    for (const rec of window.__pages) {
      for (const d of rec.filter((x) => ids.includes(x.s))) {
        rows++;
        const line = rec.filter((x) => x.y === d.y && x.s);
        for (let i = 0; i < line.length; i++) for (let j = i + 1; j < line.length; j++) {
          const a = line[i], b = line[j];
          if (a.x0 < b.x1 && b.x0 < a.x1) out.push(`"${a.s}" / "${b.s}"`);
        }
      }
    }
    return { rows, out };
  });
  assert.ok(overlaps.rows >= 3, 'references drawn: ' + overlaps.rows);
  assert.deepStrictEqual(overlaps.out, []);
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#report-download')]);
  assert.ok(fs.readFileSync(await dl.path()).length > 1000);

  assert.deepStrictEqual(errors, []);
  const outside = requests.filter((r) => !r.url.startsWith('blob:') && !(r.method === 'GET' && /\/(lab|icons)\//.test(new URL(r.url).pathname)));
  assert.deepStrictEqual(outside, [], 'no request leaves the lab');
});

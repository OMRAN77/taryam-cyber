// Browser test for ways models (P0-6) with the whole-round distribution, max-win cap,
// session funnel and distribution tests (P0-8). Expected numbers come from the brute
// force in test/helpers/ways-brute.mjs (every board enumerated, feature trees cut at a
// depth by direct convolution; the bound on what the cuts leave out is checked in
// test/lab/ways-round.test.mjs):
//  * the mini model's RTP 208453/234630 = 88.843285% (the brute-force fraction of
//    test/lab/ways-round.test.mjs), so 10 rounds at 1 cost 10 x 26177/234630 = 1.12;
//  * P(W >= 100x), E[min(W, 5x)] and P(1 round finishes ahead) = P(W > 1x) from the
//    brute-force round pmf.
// The play log for the distribution tests is drawn by the lab's own seeded simulator
// (an input, not an expected value).
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
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

test('RTP lab: a ways game gets the whole-round distribution, cap, session funnel and distribution tests', async (t) => {
  const { MINI, bruteRoundUncapped } = await esm('test/helpers/ways-brute.mjs');
  const brute = bruteRoundUncapped(MINI).round;
  let tail100 = 0, capped = 0, ahead1 = 0;
  for (let x = 0; x < brute.length; x++) {
    if (x >= 1000) tail100 += brute[x];
    capped += Math.min(x, 50) * brute[x];
    if (x > 10) ahead1 += brute[x];
  }
  capped /= 10;

  const server = await startServer();
  const browser = await chromium.launch();
  t.after(async () => { await browser.close(); await server.close(); });
  const ctx = await browser.newContext({ acceptDownloads: true, viewport: { width: 1280, height: 900 } });
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
    return page.textContent('#res-theory .card.accent .v');
  };
  const rowsOf = (sel) => page.$$eval(sel + ' tbody tr', (rs) => rs.map((r) => [...r.cells].map((c) => c.textContent.replace(/[⁦-⁩]/g, '').trim())));

  // ---- The ways example: its per-spin distribution is too large (closed form), so the
  // whole-round section shows and says why it has no figures.
  await page.click('[data-sample="oasisCaravanWays"]');
  assert.strictEqual(await runTheory(), '95.901366%');
  assert.strictEqual(await page.$eval('#round', (n) => n.hidden), false, 'the whole-round section shows');
  assert.match(await page.textContent('#round-error'), /تعذّر حساب توزيع الجولة الكاملة/);
  assert.match(await page.textContent('#round-error'), /توزيع اللفة الواحدة لهذه اللعبة أكبر من الحساب الدقيق/);
  assert.match(await page.textContent('#round-use-mc'), /ارفع ملف توزيع/);
  assert.match(await page.textContent('#res-session'), /لا يتوفر توزيع الجولة الكاملة/);

  // ---- A small ways game with free spins and retrigger: the full chain.
  await page.fill('#f-json', JSON.stringify(MINI));
  assert.strictEqual(await runTheory(), '88.843285%');
  assert.strictEqual(await page.$eval('#round', (n) => n.hidden), false);
  assert.ok(!(await page.$('#round-error')), 'no round error');
  assert.ok(!(await page.$('#round-first-drop')), 'not a first-drop game');
  assert.match(await page.textContent('#res-round'), /تحويل فورييه ونقطة ثابتة للفات المجانية/);
  assert.match(await page.textContent('#res-round'), /بلا حدّ: إعادة التفعيل غير محدودة/);
  const big = await rowsOf('#round-big');
  assert.strictEqual(big.length, 4, 'four thresholds, no top win (uncapped retriggers)');
  assert.strictEqual(big[0][1], tail100.toExponential(3), 'P(W >= 100x) by brute force');
  // Max-win cap 5x: RTP with the cap = E[min(W, 5)] (brute force, 4 decimals).
  await page.fill('#r-cap', '5');
  await page.click('#run-round');
  await page.waitForSelector('#round-cap-cards');
  assert.ok((await page.textContent('#round-cap-cards')).includes((capped * 100).toFixed(4) + '%'), await page.textContent('#round-cap-cards'));
  // Session funnel: 10 rounds at 1, and 1 round (P(finish ahead) = P(W > 1x)).
  await page.fill('#s-rounds', '10');
  await page.fill('#s-bet', '1');
  await page.fill('#s-budget', '');
  await page.click('#run-session');
  await page.waitForSelector('#sess-cards');
  assert.match(await page.textContent('#sess-cards'), /1\.12/);
  await page.fill('#s-rounds', '1');
  await page.evaluate(() => document.querySelector('#res-session').replaceChildren());
  await page.click('#run-session');
  await page.waitForSelector('#sess-cards');
  assert.ok((await page.textContent('#sess-cards')).includes((ahead1 * 100).toFixed(2) + '%'), `P(ahead) ${(ahead1 * 100).toFixed(2)}% in ${await page.textContent('#sess-cards')}`);

  // Distribution tests: the reference is the whole round of the ways game, and a log
  // drawn from that game fits it.
  const { normalizeModel } = await esm('lab/core/slot-model.js');
  const { simulate } = await esm('lab/core/montecarlo.js');
  const { prngFromSeed } = await esm('lab/core/prng.js');
  const model = normalizeModel(MINI);
  const rng = await prngFromSeed('mini ways browser log');
  const lines = ['bet,win,trigger'];
  for (let i = 0; i < 3000; i++) {
    const s = simulate(model, rng, 1, { progressEvery: 1e9 });
    lines.push('1,' + +(s.totalWinUnits / model.totalBetUnits).toFixed(6) + ',' + s.triggers);
  }
  await page.click('#tab-actual');
  await page.setInputFiles('#actualFile', { name: 'mini-ways-log.csv', mimeType: 'text/csv', buffer: Buffer.from(lines.join('\n') + '\n') });
  await page.waitForFunction(() => document.querySelector('#name-actual').textContent.includes('mini-ways-log'));
  await page.click('#run-dist');
  await page.waitForSelector('#dist-verdict');
  const distText = await page.textContent('#res-dist');
  assert.match(distText, /الجولة كاملة/);
  assert.strictEqual(await page.$eval('#dist-verdict', (n) => n.className), 'verdict pass', distText.slice(0, 300));

  // ---- The cascading version: same figures, labelled first drop only, kept out of the
  // distribution tests; the report and the Verify tab carry the label.
  await page.click('#tab-theory');
  await page.fill('#f-json', JSON.stringify({ ...MINI, cascades: true }));
  assert.strictEqual(await runTheory(), '88.843285%');
  assert.ok(await page.isVisible('#round-first-drop'));
  assert.match(await page.textContent('#round-first-drop'), /أول سقوط فقط/);
  assert.strictEqual((await rowsOf('#round-big'))[0][1], tail100.toExponential(3));
  await page.click('#run-round');
  await page.waitForSelector('#round-cap-cards');
  assert.match(await page.textContent('#round-cap-cards'), /أول سقوط فقط/);
  await page.fill('#s-rounds', '10');
  await page.click('#run-session');
  await page.waitForSelector('#sess-first-drop');
  await page.click('#tab-actual');
  await page.click('#run-dist');
  await page.waitForSelector('#err-dist:not([hidden])');
  assert.match(await page.textContent('#err-dist'), /أول سقوط فقط/);
  await page.click('#tab-report');
  await page.click('#run-report');
  await page.waitForSelector('#report-download');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#report-download')]);
  const pdf = require('fs').readFileSync(await dl.path());
  assert.match(pdf.toString('latin1'), /Whole-round distribution \\?\(FIRST DROP ONLY/, 'text page (PDF strings escape parentheses)');
  await page.click('#tab-verify');
  await page.setInputFiles('#verifyFile', { name: 'cascading-ways.pdf', mimeType: 'application/pdf', buffer: pdf });
  await page.waitForSelector('#verify-verdict');
  // The headline figures: the round and session lines carry the label.
  assert.match(await page.textContent('#verify-verdict'), /.+/);
  const figureRows = await page.$$eval('#res-verify tr', (rs) => rs.map((r) => r.textContent));
  const roundRow = figureRows.find((r) => r.startsWith('توزيع الجولة الكاملة'));
  assert.ok(roundRow && roundRow.includes('أول سقوط فقط'), figureRows.join(' | '));
  const sessRow = figureRows.find((r) => r.startsWith('قمع الجلسة'));
  assert.ok(sessRow && sessRow.includes('أول سقوط فقط'), figureRows.join(' | '));

  // English labels.
  await page.click('#langToggle');
  await page.click('#tab-theory');
  assert.match(await page.textContent('#round-first-drop'), /First drop only/);
  assert.match(await page.textContent('#sess-first-drop'), /First drop only/);
  await page.fill('#f-json', JSON.stringify(MINI));
  await page.click('[data-sample="oasisCaravanWays"]');
  await runTheory();
  assert.match(await page.textContent('#round-error'), /per-spin distribution of this game is too large/);
  assert.match(await page.textContent('#round-use-mc'), /upload a distribution file/);
  await page.click('#langToggle');

  assert.deepStrictEqual(errors, []);
  const outside = requests.filter((r) => !r.url.startsWith('blob:') && !(r.method === 'GET' && /\/(lab|icons)\//.test(new URL(r.url).pathname)));
  assert.deepStrictEqual(outside, [], 'no request leaves the lab');
});

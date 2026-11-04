// Browser test for the whole-round distribution, the max-win cap, the session funnel
// and the free-spin caps (lab/index.html, theoretical tab). Expected numbers come from
// hand arithmetic or the binomial distribution:
//  * European roulette on red: the round pays 2 bets with probability 18/37
//    (48.649%, once every 37/18 = 2.06 rounds); RTP 36/37; a 1x cap keeps half of it;
//  * 1000 rounds of it: K ~ Binomial(1000, 18/37) reds, net 2K - 1000, so P(ahead) =
//    P(K > 500) = 18.76% and the median is -28 (also the research's own figures),
//    and the expected loss 1000 x (1 - 36/37) = 27.03 per unit bet;
//  * Desert Gold: the expected loss of 1000 rounds at 1 is 1000 x (1 - 0.955175) = 44.83.
const test = require('node:test');
const assert = require('node:assert');
const { startServer } = require('../helpers/dev-server');

let chromium;
try {
  ({ chromium } = require('playwright'));
} catch (e) {
  throw new Error('These tests need Playwright: npm install --no-save playwright && npx playwright install chromium');
}

// P(K > 500) and the median of 2K - 1000 for K ~ Binomial(1000, 18/37), in BigInt.
function binomial1000() {
  const den = 37n ** 1000n;
  let c = 1n, acc = 0n, ahead = 0n, median = null;
  for (let k = 0; k <= 1000; k++) {
    const w = c * 18n ** BigInt(k) * 19n ** BigInt(1000 - k);
    acc += w;
    if (k > 500) ahead += w;
    if (median === null && acc * 2n >= den) median = 2 * k - 1000;
    c = (c * BigInt(1000 - k)) / BigInt(k + 1);
  }
  return { ahead: Number((ahead * 10n ** 8n) / den) / 1e8, median };
}

test('RTP lab: whole-round distribution, max-win cap, session funnel and free-spin caps', async (t) => {
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
  };
  const rowsOf = (sel) => page.$$eval(sel + ' tbody tr', (rs) => rs.map((r) => [...r.cells].map((c) => c.textContent.replace(/[⁦-⁩]/g, '').trim())));

  // Before any calculation the two sections are hidden.
  assert.strictEqual(await page.$eval('#round', (n) => n.hidden), true);
  assert.strictEqual(await page.$eval('#session', (n) => n.hidden), true);

  // ---- European roulette: exact, every number by hand ----
  await page.click('[data-sample="rouletteEuropean"]');
  await runTheory();
  assert.strictEqual(await page.$eval('#round', (n) => n.hidden), false);
  const big = await rowsOf('#round-big');
  assert.strictEqual(big.length, 5, 'four thresholds and the top win');
  assert.deepStrictEqual(big[0].slice(1), ['0', '—', 'دقيق']); // nothing reaches 100x
  assert.match(big[4][0], /2×/);
  assert.deepStrictEqual(big[4].slice(1), ['48.649%', '2.06', 'دقيق']);
  assert.ok(!(await page.$('#round-precision')), 'no grid for an exact pmf');
  // A 1x cap: E[min(W, 1)] = 18/37 = 48.6486% of RTP 97.2973%, so 48.6486% is removed.
  await page.fill('#r-cap', '1');
  await page.check('#r-odds');
  await page.click('#run-round');
  await page.waitForSelector('#round-odds');
  const capText = await page.textContent('#round-cap-cards');
  assert.match(capText, /48\.6486%/);
  assert.deepStrictEqual((await rowsOf('#round-odds')).map((r) => r[1]), ['يستوفي', 'يستوفي']); // 18/37 is far above both thresholds
  assert.match(await page.textContent('#res-roundcap'), /غير مُتحقَّق/);

  // Session: 1000 rounds at 2, budget 100.
  await page.fill('#s-rounds', '1000');
  await page.fill('#s-bet', '2');
  await page.fill('#s-budget', '100');
  await page.click('#run-session');
  await page.waitForSelector('#sess-cards');
  const b = binomial1000();
  const cardsText = await page.textContent('#sess-cards');
  assert.match(cardsText, /54\.05/, 'expected loss 2 x 1000/37');
  assert.ok(cardsText.includes((b.ahead * 100).toFixed(2) + '%'), `P(ahead) ${(b.ahead * 100).toFixed(2)}% in ${cardsText}`);
  assert.strictEqual(b.median, -28);
  const pcts = await rowsOf('#sess-percentiles');
  assert.deepStrictEqual(pcts.map((r) => r[1]), ['-160', '-96', '-56', '-12', '+48']); // 2 x (-80, -48, -28, -6, +24)
  assert.match(await page.textContent('#sess-method'), /بتحويل فورييه، دون محاكاة/);
  assert.ok(await page.$('#sess-funnel polygon.f90'), 'funnel chart');

  // ---- review fixes (roulette, numbers by hand) ----
  // The exact 1x cap card has no "up to" (an exact value has no upper bound) and names M.
  assert.ok(!capText.includes('حتى'), capText);
  assert.match(capText, /السقف M/);
  // A cap of 5x is above the top win (2x): it removes nothing, and the top award for
  // the odds rules stays 2x with P = 18/37, which meets both.
  await page.fill('#r-cap', '5');
  await page.click('#run-round');
  await page.waitForSelector('#round-cap-above');
  assert.deepStrictEqual((await rowsOf('#round-odds')).map((r) => r[1]), ['يستوفي', 'يستوفي']);
  assert.match(await page.textContent('#res-roundcap'), /2×/);
  // An invalid cap: the error, and no figures of the previous cap beside it.
  await page.fill('#r-cap', '1/2');
  await page.click('#run-round');
  await page.waitForFunction(() => !document.querySelector('#err-round').hidden);
  assert.strictEqual(await page.$('#round-cap-cards'), null, 'the previous cap is gone');
  await page.fill('#r-cap', '1');
  await page.click('#run-round');
  await page.waitForSelector('#round-cap-cards');
  // A decimal-comma bet: 0,5 x 1000 x (1 - 36/37) = 13.51; no "—" and no NaN in the chart.
  await page.fill('#s-bet', '0,5');
  await page.click('#run-session');
  await page.waitForFunction(() => /13\.51/.test(document.querySelector('#sess-cards')?.textContent || ''));
  assert.ok(!(await page.textContent('#res-session')).includes('—'), 'every money figure is a number');
  assert.deepStrictEqual((await rowsOf('#sess-percentiles')).map((r) => r[1]), ['-40', '-24', '-14', '-3', '+12']); // 0.5 x (-80, -48, -28, -6, +24)
  assert.ok(!(await page.$eval('#sess-funnel', (s) => s.innerHTML.includes('NaN'))));
  // Phone width: the odds verdict column is on screen without scrolling the table.
  await page.check('#r-odds');
  await page.click('#run-round');
  await page.waitForSelector('#round-odds');
  await page.setViewportSize({ width: 390, height: 900 });
  const verdictRight = await page.$eval('#round-odds tbody tr td:last-child', (td) => { const r = td.getBoundingClientRect(); return [r.left, r.right]; });
  assert.ok(verdictRight[0] >= 0 && verdictRight[1] <= 390, 'verdict cell inside the screen: ' + verdictRight);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.fill('#s-bet', '2');

  // ---- Desert Gold: free spins with retrigger (FFT) ----
  await page.click('[data-sample="desertGold"]');
  await runTheory();
  assert.strictEqual(await page.textContent('#res-session'), '', 'the session of the previous model is gone');
  const dg = await rowsOf('#round-big');
  assert.strictEqual(dg.length, 4, 'no top win with uncapped retriggers');
  assert.strictEqual(dg[0][3], 'تحويل فورييه');
  for (const r of dg.slice(1)) {
    assert.match(r[1], /^< \d\.\de-\d+$/, 'a bound, never a number under the floor: ' + r[1]);
    assert.strictEqual(r[3], 'حدّ أعلى');
  }
  assert.match(await page.textContent('#res-round'), /بلا حدّ/);
  assert.match(await page.textContent('#round-precision'), /32,768/);
  // A 100x cap reaches exactly the rounds of the ">= 100x" row (same probability).
  await page.fill('#r-cap', '100');
  await page.click('#run-round');
  await page.waitForFunction(() => /5\.\d{3}e-5/.test(document.querySelector('#round-cap-cards')?.textContent || ''));
  const reach = /(\d\.\d{3}e-\d)/.exec(await page.textContent('#round-cap-cards'))[1];
  assert.strictEqual(reach, dg[0][1]);
  await page.fill('#s-budget', '');
  await page.fill('#s-bet', '1');
  await page.click('#run-session');
  await page.waitForSelector('#sess-cards');
  assert.match(await page.textContent('#sess-cards'), /44\.83/);
  assert.ok(!(await page.textContent('#sess-cards')).includes('نفاد'), 'no budget, no ruin figure');

  // The distribution tests now compare whole rounds.
  await page.click('#tab-actual');
  await page.click('#sample-actual');
  await page.waitForFunction(() => document.querySelector('#name-actual').textContent.includes('sample-playlog'));
  await page.click('#run-dist');
  await page.waitForSelector('#dist-verdict');
  const distText = await page.textContent('#res-dist');
  assert.match(distText, /الجولة كاملة/);
  assert.strictEqual(await page.$eval('#dist-verdict', (n) => n.className), 'verdict pass', distText.slice(0, 300));

  // ---- Free-spin caps from the form ----
  await page.click('#tab-theory');
  await page.fill('#f-fsMaxRetriggers', '2');
  await runTheory();
  assert.match(await page.textContent('#res-theory'), /حدود اللفات المجانية/);
  assert.match(await page.textContent('#res-round'), /مسح حالات حدود اللفات/);
  const capped = await rowsOf('#round-big');
  assert.strictEqual(capped.length, 5, 'a capped feature has a top win');
  assert.strictEqual(capped[4][3], 'دقيق', 'its probability by exact enumeration');
  // Unticking retrigger hides the cap fields and drops the caps from the model.
  await page.uncheck('#f-fsRetrigger');
  assert.strictEqual(await page.$eval('#fsCapFields', (n) => n.hidden), true);
  await page.check('#f-fsRetrigger');
  await page.fill('#f-fsMaxRetriggers', '');

  // English labels.
  await page.click('#langToggle');
  assert.match(await page.textContent('#round-title'), /Whole-round distribution/);
  assert.match(await page.textContent('#session-title'), /Session funnel/);
  await page.click('#langToggle');

  // Report and Verify tab: both sections and their headline figures.
  await page.click('[data-sample="rouletteEuropean"]');
  await runTheory();
  await page.fill('#s-budget', '100');
  await page.fill('#s-bet', '2');
  await page.click('#run-session');
  await page.waitForSelector('#sess-cards');
  await page.click('#tab-report');
  assert.match(await page.textContent('#rep-sections'), /قمع الجلسة/);
  await page.click('#run-report');
  await page.waitForSelector('#report-download');
  const [download] = await Promise.all([page.waitForEvent('download'), page.click('#report-download')]);
  const pdf = require('fs').readFileSync(await download.path());
  await page.click('#tab-verify');
  await page.setInputFiles('#verifyFile', { name: 'report.pdf', mimeType: 'application/pdf', buffer: pdf });
  await page.waitForSelector('#verify-verdict');
  const verifyText = await page.textContent('#res-verify');
  assert.match(verifyText, /توزيع الجولة الكاملة/);
  assert.match(verifyText, /أعلى ربح: 2×/);
  assert.ok(verifyText.includes('الخروج رابحًا: ' + (b.ahead * 100).toFixed(4).slice(0, 5)), verifyText);

  assert.deepStrictEqual(errors, []);
  const outside = requests.filter((r) => !r.url.startsWith('blob:') && !(r.method === 'GET' && /\/(lab|icons)\//.test(new URL(r.url).pathname)));
  assert.deepStrictEqual(outside, [], 'no request leaves the lab');
});

// The lab promises that nothing leaves the browser. Its <meta> CSP covers the page
// but not the Worker that does the work: a dedicated worker takes its policy from
// its own HTTP response. vercel.json therefore sends the CSP as a header for every
// file under /lab/. These tests load a probe worker under /lab/ and check that its
// request is blocked with the header, and (control) that it gets out without it.
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

const PROBE = '/lab/__csp-probe.js';
const PROBE_SRC = "fetch('/api/auth', { method: 'POST', body: 'probe' }).then(() => postMessage('sent'), () => postMessage('blocked'));";

async function probe(serverOptions) {
  const seen = [];
  const server = await startServer({ ...serverOptions, extra: { [PROBE]: PROBE_SRC }, onRequest: (method, p) => seen.push(method + ' ' + p) });
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(server.url + '/lab/index.html', { waitUntil: 'load' });
    const result = await page.evaluate((url) => new Promise((resolve) => {
      const w = new Worker(url);
      w.onmessage = (e) => resolve(e.data);
      w.onerror = (e) => resolve('error: ' + e.message);
      setTimeout(() => resolve('timeout'), 5000);
    }), PROBE);
    // The page itself is blocked by both the meta tag and the header.
    const fromPage = await page.evaluate(() => fetch('/api/auth', { method: 'POST' }).then(() => 'sent', () => 'blocked'));
    return { result, fromPage, reachedServer: seen.filter((s) => s.endsWith('/api/auth')) };
  } finally {
    await browser.close();
    await server.close();
  }
}

test('vercel.json sends the lab CSP (connect-src none) for every file under /lab/', () => {
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'));
  const rule = cfg.headers.find((r) => r.source === '/lab/(.*)');
  assert.ok(rule, 'a header rule for /lab/(.*)');
  const csp = rule.headers.find((h) => h.key === 'Content-Security-Policy').value;
  for (const d of ["connect-src 'none'", "worker-src 'self'", "script-src 'self'", "frame-ancestors 'none'"]) assert.ok(csp.includes(d), d);
});

test('a worker under /lab/ cannot send anything: the request never reaches the server', async () => {
  const r = await probe({});
  assert.strictEqual(r.result, 'blocked');
  assert.strictEqual(r.fromPage, 'blocked');
  assert.deepStrictEqual(r.reachedServer, []);
});

test('control: without the header, the meta tag alone does not stop the worker', async () => {
  const r = await probe({ headers: false });
  assert.strictEqual(r.fromPage, 'blocked');
  assert.strictEqual(r.result, 'sent');
  assert.deepStrictEqual(r.reachedServer, ['POST /api/auth']);
});

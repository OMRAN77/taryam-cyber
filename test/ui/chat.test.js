// Browser tests for the chat reply path in index.html.
// 1. End to end: browser -> dev server -> api/deepseek.js -> _relay -> a fake DeepSeek
//    that streams Server-Sent Events. The streamed tokens must reach the page.
// 2. Regression: when the server answers with plain JSON instead of a stream (as the
//    proxies did before streaming existed), the reply used to be parsed as SSE and
//    lost, leaving an empty message.
const test = require('node:test');
const assert = require('node:assert');
const { startServer } = require('../helpers/dev-server');
const { loadApi, createBlobFake, installFetch, STRONG_SECRET } = require('../helpers/harness');

let chromium;
try {
  ({ chromium } = require('playwright'));
} catch (e) {
  throw new Error('These tests need Playwright: npm install --no-save playwright && npx playwright install chromium');
}

function sseResponse(parts) {
  const enc = new TextEncoder();
  const body = new ReadableStream({
    start(c) {
      for (const p of parts) c.enqueue(enc.encode('data: ' + JSON.stringify({ choices: [{ delta: { content: p } }] }) + '\n\n'));
      c.enqueue(enc.encode('data: [DONE]\n\n'));
      c.close();
    },
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

async function sendAndReadReply(page, server, text) {
  await page.goto(server.url + '/', { waitUntil: 'load' });
  await page.click('#btnGuestMode');
  await page.fill('#prompt', text);
  await page.click('#btnSend');
  await page.waitForFunction(() => !document.querySelector('#btnSend').disabled);
  return page.evaluate(() => {
    const all = [...document.querySelectorAll('#messages .msg.assistant')];
    const last = all[all.length - 1];
    if (!last) return null;
    const tag = last.querySelector('.provider-tag');
    const body = [...last.children].find((el) => el !== tag && el.tagName === 'DIV');
    return body ? body.textContent : null;
  });
}

test('a streamed DeepSeek answer travels through the real proxy into the chat', async (t) => {
  const blob = createBlobFake();
  const upstream = [];
  const restore = installFetch(blob.fetchImpl(async (url, opts) => {
    upstream.push({ url, body: JSON.parse(opts.body) });
    return sseResponse(['مرح', 'بًا ', 'من البث']);
  }));
  loadApi('_usage', { AUTH_SECRET: STRONG_SECRET, BLOB_READ_WRITE_TOKEN: blob.token, DEEPSEEK_API_KEY: 'test-key' });
  require('../../api/_store').config.retryDelayMs = 0;

  const server = await startServer();
  const browser = await chromium.launch();
  t.after(async () => { await browser.close(); await server.close(); restore(); });
  const page = await browser.newPage();
  page.setDefaultTimeout(20000);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));

  const reply = await sendAndReadReply(page, server, 'سلام');
  assert.strictEqual(reply, 'مرحبًا من البث');
  assert.strictEqual(upstream.length, 1);
  assert.match(upstream[0].url, /api\.deepseek\.com/);
  assert.strictEqual(upstream[0].body.stream, true, 'the proxy asked DeepSeek for a stream');
  assert.deepStrictEqual(errors, []);
});

test('a plain JSON answer is shown, not lost (regression)', async (t) => {
  const server = await startServer();
  const browser = await chromium.launch();
  t.after(async () => { await browser.close(); await server.close(); });
  const page = await browser.newPage();
  page.setDefaultTimeout(20000);
  await page.route('**/api/deepseek', (r) => r.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ choices: [{ message: { content: 'مرحبا من DeepSeek' } }] }),
  }));

  const reply = await sendAndReadReply(page, server, 'اختبار');
  assert.strictEqual(reply, 'مرحبا من DeepSeek');
});

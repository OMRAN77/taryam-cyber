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

// ---- Single-provider replies that break, come back empty, or are refused ----

const sseText = (parts) => parts.map((p) => 'data: ' + JSON.stringify({ choices: [{ delta: { content: p } }] }) + '\n\n').join('');
// What api/_relay.js writes when the upstream breaks after the stream started.
const STREAM_ERROR = 'data: ' + JSON.stringify({ error: { message: 'stream interrupted: terminated' } }) + '\n\n';

// A guest-mode page with every /api/<key> call recorded. reply(key, n) answers the n-th
// call (0-based) to that provider: a string (a JSON chat answer), {sse}, or {status, body}.
async function openChat(browser, server, { storage = {}, reply }) {
  const page = await browser.newPage();
  page.setDefaultTimeout(20000);
  await page.addInitScript((s) => { for (const [k, v] of Object.entries(s)) localStorage.setItem(k, v); }, storage);
  const calls = {};
  await page.route('**/api/*', async (route) => {
    const key = new URL(route.request().url()).pathname.split('/').pop();
    if (key === 'auth') return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    (calls[key] = calls[key] || []).push(JSON.parse(route.request().postData() || '{}'));
    const r = await reply(key, calls[key].length - 1);
    if (typeof r === 'string') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ choices: [{ message: { content: r } }] }) });
    if (r.sse !== undefined) return route.fulfill({ status: 200, contentType: 'text/event-stream', body: r.sse });
    return route.fulfill({ status: r.status || 200, contentType: 'application/json', body: JSON.stringify(r.body) });
  });
  await page.goto(server.url + '/', { waitUntil: 'load' });
  await page.click('#btnGuestMode');
  return { page, calls };
}

async function say(page, text) {
  await page.fill('#prompt', text);
  await page.press('#prompt', 'Enter');
  await page.waitForFunction(() => !document.querySelector('#btnSend').disabled);
}

const lastAssistant = (page) => page.evaluate(() => {
  const all = [...document.querySelectorAll('#messages .msg.assistant')];
  return all.length ? all[all.length - 1].textContent : null;
});

// The turns after the system message, as role + text.
const turns = (body) => body.messages.filter((m) => m.role !== 'system').map((m) => ({
  role: m.role,
  text: typeof m.content === 'string' ? m.content : m.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n'),
}));

test('a stream that ends with the error event keeps the text so far and says it was cut off', async (t) => {
  const server = await startServer();
  const browser = await chromium.launch();
  t.after(async () => { await browser.close(); await server.close(); });
  const { page, calls } = await openChat(browser, server, {
    reply: (key, n) => (n === 0 ? { sse: sseText(['PART-ONE ', 'PART-TWO']) + STREAM_ERROR } : 'تمام'),
  });

  await say(page, 'سؤال طويل');
  const shown = await lastAssistant(page);
  assert.match(shown, /PART-ONE PART-TWO/, 'the partial answer stays');
  assert.match(shown, /انقطع الرد/, 'a note says it was cut off');
  assert.match(shown, /stream interrupted/, 'with the reason');

  await say(page, 'أكمل');
  const sent = turns(calls.deepseek[1]);
  assert.deepStrictEqual(sent.map((m) => m.role), ['user', 'assistant', 'user']);
  assert.strictEqual(sent[1].text, 'PART-ONE PART-TWO', 'the partial answer is history, the note is not');
});

test('a stream whose connection drops keeps the text so far (not just "network error")', async (t) => {
  const server = await startServer();
  const browser = await chromium.launch();
  t.after(async () => { await browser.close(); await server.close(); });
  const page = await browser.newPage();
  page.setDefaultTimeout(20000);
  // The body reader rejects mid-stream, as the browser's does when the connection resets.
  await page.addInitScript((chunks) => {
    const realFetch = window.fetch;
    window.fetch = (url, opts) => {
      if (!String(url).endsWith('/api/deepseek')) return realFetch(url, opts);
      const enc = new TextEncoder();
      let i = 0;
      const body = new ReadableStream({
        pull(c) { if (i < chunks.length) c.enqueue(enc.encode(chunks[i++])); else c.error(new TypeError('network error')); },
      });
      return Promise.resolve(new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } }));
    };
  }, [sseText(['PARTIAL-ONE ']), sseText(['PARTIAL-TWO'])]);
  await page.goto(server.url + '/', { waitUntil: 'load' });
  await page.click('#btnGuestMode');

  await say(page, 'سؤال');
  const shown = await lastAssistant(page);
  assert.match(shown, /PARTIAL-ONE PARTIAL-TWO/, 'the partial answer stays: ' + shown);
  assert.match(shown, /انقطع الرد[\s\S]*network error/);
});

test('an empty reply or an error event with no text is explained, not a blank bubble', async (t) => {
  const server = await startServer();
  const browser = await chromium.launch();
  t.after(async () => { await browser.close(); await server.close(); });
  const reasoningOnly = 'data: ' + JSON.stringify({ choices: [{ delta: { reasoning_content: 'hmm' }, finish_reason: 'length' }] }) + '\n\ndata: [DONE]\n\n';
  const openrouterError = 'data: ' + JSON.stringify({ error: { message: 'Provider returned error', code: 502 }, choices: [{ delta: { content: '' }, finish_reason: 'error' }] }) + '\n\n';
  const { page, calls } = await openChat(browser, server, {
    reply: (key, n) => [{ sse: reasoningOnly }, { sse: openrouterError }, 'جواب'][n],
  });

  await say(page, 'سؤال 1');
  assert.match(await lastAssistant(page), /DeepSeek[\s\S]*ردّ فارغ/, 'empty reply notice');
  await say(page, 'سؤال 2');
  assert.match(await lastAssistant(page), /Provider returned error/, 'the stream error is shown');

  await say(page, 'سؤال 3');
  assert.deepStrictEqual(turns(calls.deepseek[2]), [{ role: 'user', text: 'سؤال 1\n\nسؤال 2\n\nسؤال 3' }],
    'notices are not history, and the user turns left next to each other are joined');
});

test('an error reply is shown but never sent back to the provider as its answer', async (t) => {
  const server = await startServer();
  const browser = await chromium.launch();
  t.after(async () => { await browser.close(); await server.close(); });
  const { page, calls } = await openChat(browser, server, {
    reply: (key, n) => (n === 0 ? { status: 500, body: { error: 'Server is missing DEEPSEEK_API_KEY' } } : 'جواب'),
  });

  await say(page, 'q1');
  assert.match(await lastAssistant(page), /DEEPSEEK_API_KEY غير مضبوط/);
  await say(page, 'q2');
  assert.deepStrictEqual(turns(calls.deepseek[1]), [{ role: 'user', text: 'q1\n\nq2' }]);
  assert.doesNotMatch(JSON.stringify(calls.deepseek[1].messages), /⚠️|DEEPSEEK_API_KEY/);
});

test('Enter while a reply is pending does not start a second send', async (t) => {
  const server = await startServer();
  const browser = await chromium.launch();
  t.after(async () => { await browser.close(); await server.close(); });
  const { page, calls } = await openChat(browser, server, {
    reply: async () => { await new Promise((r) => setTimeout(r, 1500)); return 'جواب'; },
  });

  await page.fill('#prompt', 'الأول');
  await page.press('#prompt', 'Enter');
  await page.waitForFunction(() => document.querySelector('#btnSend').disabled);
  await page.fill('#prompt', 'الثاني');
  await page.press('#prompt', 'Enter');
  await page.waitForFunction(() => !document.querySelector('#btnSend').disabled);
  await page.waitForTimeout(300);

  assert.strictEqual(calls.deepseek.length, 1, 'one request');
  assert.strictEqual(await page.inputValue('#prompt'), 'الثاني', 'the second text stays in the box');
  assert.strictEqual(await page.locator('#messages .msg.user').count(), 1);
});

test("Claude's refusal message follows the UI language", async (t) => {
  const server = await startServer();
  const browser = await chromium.launch();
  t.after(async () => { await browser.close(); await server.close(); });
  const refusal = { body: { content: [], stop_reason: 'refusal', stop_details: { category: 'cyber' } } };

  const en = await openChat(browser, server, { storage: { aiapp_lang: 'en', aiapp_provider: 'claude' }, reply: () => refusal });
  await say(en.page, 'question');
  const shownEn = await lastAssistant(en.page);
  assert.match(shownEn, /Claude declined this request \(cyber\)\. Rephrase it or try another provider\./);
  assert.doesNotMatch(shownEn, /[؀-ۿ]/, 'no Arabic in the English UI');

  const ar = await openChat(browser, server, { storage: { aiapp_provider: 'claude' }, reply: () => refusal });
  await say(ar.page, 'سؤال');
  assert.match(await lastAssistant(ar.page), /رفض Claude هذا الطلب \(cyber\)/);
});

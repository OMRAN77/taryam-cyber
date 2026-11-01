// Tests for api/_relay.js through the real provider proxies: SSE is piped through
// when the browser asks for a stream, JSON stays unchanged otherwise, retired model
// ids fall back to the next candidate (or a discovered one), and other errors are
// passed through without retrying. A stream that breaks ends with an error event, and
// a browser that disconnects aborts the upstream call. Nothing here talks to the
// network (the disconnect tests use a local server on 127.0.0.1).
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { loadApi, createBlobFake, installFetch, STRONG_SECRET } = require('../helpers/harness');
const { startServer } = require('../helpers/dev-server');

const KEYS = {
  COHERE_API_KEY: 'k', DEEPSEEK_API_KEY: 'k', GROQ_API_KEY: 'k', MISTRAL_API_KEY: 'k',
  OPENAI_API_KEY: 'k', OPENROUTER_API_KEY: 'k',
};

const SSE = 'data: {"choices":[{"delta":{"content":"مرح"}}]}\n\n'
  + 'data: {"choices":[{"delta":{"content":"با"}}]}\n\n'
  + 'data: [DONE]\n\n';

function sseResponse(text) {
  const bytes = new TextEncoder().encode(text);
  const body = new ReadableStream({
    start(c) { c.enqueue(bytes.slice(0, 20)); c.enqueue(bytes.slice(20)); c.close(); },
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

// upstream(url, body, opts) -> Response. Records every provider call.
function setup(upstream) {
  const blob = createBlobFake();
  const calls = [];
  const restore = installFetch(blob.fetchImpl(async (url, opts) => {
    const body = opts.body ? JSON.parse(opts.body) : null;
    calls.push({ url, body });
    return upstream(url, body, opts);
  }));
  loadApi('_usage', { AUTH_SECRET: STRONG_SECRET, BLOB_READ_WRITE_TOKEN: blob.token, ...KEYS });
  require('../../api/_store').config.retryDelayMs = 0;
  return { calls, restore };
}

// Minimal Vercel-style res that also records streamed writes.
function call(name, body) {
  const handler = require('../../api/' + name);
  return new Promise((resolve) => {
    const chunks = [];
    const res = {
      statusCode: 200, headers: {}, headersSent: false,
      setHeader(k, v) { this.headers[k.toLowerCase()] = v; return this; },
      getHeader(k) { return this.headers[k.toLowerCase()]; },
      status(c) { this.statusCode = c; return this; },
      write(c) { this.headersSent = true; chunks.push(Buffer.from(c)); return true; },
      json(o) { resolve({ status: this.statusCode, body: o, headers: this.headers }); },
      send(d) { let b = d; try { b = JSON.parse(d); } catch (e) { /* text */ } resolve({ status: this.statusCode, body: b, headers: this.headers }); },
      end() { resolve({ status: this.statusCode, text: Buffer.concat(chunks).toString('utf8'), headers: this.headers }); },
    };
    const req = { method: 'POST', body: { messages: [{ role: 'user', content: 'hi' }], ...body }, headers: { 'x-forwarded-for': '198.51.100.80' } };
    Promise.resolve(handler(req, res)).catch((e) => resolve({ status: 'threw', body: e.message }));
  });
}

const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
const notFound = (id) => json({ error: { code: 'model_not_found', message: 'The model `' + id + '` does not exist' } }, 404);
const ok = () => json({ choices: [{ message: { content: 'ok' } }] });
const tick = (ms) => new Promise((r) => setTimeout(r, ms));

test('a streamed answer is piped through as Server-Sent Events', async () => {
  const { calls, restore } = setup(() => sseResponse(SSE));
  try {
    const r = await call('deepseek', { stream: true, model: 'deepseek-chat' });
    assert.strictEqual(r.status, 200);
    assert.match(r.headers['content-type'], /text\/event-stream/);
    assert.strictEqual(r.text, SSE, 'every byte of the upstream stream reaches the browser');
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].body.stream, true);
  } finally { restore(); }
});

test('without stream the upstream JSON is returned unchanged', async () => {
  const { calls, restore } = setup(() => json({ choices: [{ message: { content: 'hi' } }] }));
  try {
    const r = await call('mistral', { model: 'mistral-large-latest' });
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(r.body, { choices: [{ message: { content: 'hi' } }] });
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].body.stream, undefined);
  } finally { restore(); }
});

test('a retired model id falls back to the next candidate', async () => {
  const { calls, restore } = setup((url, body) => (body.model === 'gpt-4-retired' ? notFound(body.model) : json({ choices: [{ message: { content: 'ok' } }] })));
  try {
    const r = await call('openai', { model: 'gpt-4-retired' });
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(calls.map((c) => c.body.model), ['gpt-4-retired', 'gpt-5.6']);
    assert.strictEqual(r.headers['x-taryam-model'], 'gpt-5.6');
  } finally { restore(); }
});

test('when every candidate is gone, a model discovered from /models is tried', async () => {
  const { calls, restore } = setup((url, body) => {
    if (url.endsWith('/models')) return json({ data: [{ id: 'whisper-large-v3' }, { id: 'llama-9-70b-versatile' }] });
    return body.model === 'llama-9-70b-versatile' ? json({ choices: [{ message: { content: 'ok' } }] }) : notFound(body.model);
  });
  try {
    const r = await call('groq', { model: 'gone-model' });
    assert.strictEqual(r.status, 200);
    const tried = calls.filter((c) => c.body).map((c) => c.body.model);
    assert.deepStrictEqual(tried, ['gone-model', 'openai/gpt-oss-120b', 'llama-3.3-70b-versatile', 'llama-9-70b-versatile']);
  } finally { restore(); }
});

test('errors other than "model not found" are passed through without retrying', async () => {
  const { calls, restore } = setup(() => json({ error: { message: 'Incorrect API key provided' } }, 401));
  try {
    const r = await call('openai', { model: 'gpt-5.6' });
    assert.strictEqual(r.status, 401);
    assert.match(JSON.stringify(r.body), /Incorrect API key/);
    assert.strictEqual(calls.length, 1);
  } finally { restore(); }
});

test('reasoning models get no temperature; older chat models keep it', async () => {
  const { calls, restore } = setup(() => json({ choices: [{ message: { content: 'ok' } }] }));
  try {
    await call('openai', { model: 'gpt-5.6' });
    await call('openai', { model: 'gpt-4o-mini' });
    await call('openrouter', { model: 'openai/gpt-5.6' });
    assert.strictEqual(calls[0].body.temperature, undefined);
    assert.strictEqual(calls[1].body.temperature, 0.7);
    assert.strictEqual(calls[2].body.temperature, undefined);
  } finally { restore(); }
});

test('Cohere upgrades retired model names and never asks for a stream', async () => {
  const { calls, restore } = setup(() => json({ choices: [{ message: { content: 'ok' } }] }));
  try {
    const r = await call('cohere', { model: 'command-r-plus', stream: true });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(calls[0].body.model, 'command-a-plus-05-2026');
    assert.strictEqual(calls[0].body.stream, undefined);
  } finally { restore(); }
});

test('an unsafe model id is not echoed into a response header', async () => {
  const { restore } = setup(() => json({ choices: [{ message: { content: 'ok' } }] }));
  try {
    const r = await call('mistral', { model: 'bad\r\nX-Injected: 1' });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.headers['x-taryam-model'], undefined);
  } finally { restore(); }
});

// How DeepSeek and OpenRouter word "this model id is unknown" (not OpenAI's wording).
const PROVIDER_NOT_FOUND = [
  ['DeepSeek 400 "Model Not Exist"', 'deepseek', 'deepseek-coder', 'deepseek-chat',
    () => json({ error: { message: 'Model Not Exist', type: 'invalid_request_error', param: null, code: 'invalid_request_error' } }, 400)],
  ['OpenRouter 400 "is not a valid model ID"', 'openrouter', 'gpt-4o', 'openai/gpt-5.6',
    () => json({ error: { message: 'gpt-4o is not a valid model ID', code: 400 } }, 400)],
  ['OpenRouter 404 "No endpoints found for"', 'openrouter', 'anthropic/claude-2', 'openai/gpt-5.6',
    () => json({ error: { message: 'No endpoints found for anthropic/claude-2.', code: 404 } }, 404)],
];

for (const [label, provider, bad, next, reply] of PROVIDER_NOT_FOUND) {
  test('fallback also fires on ' + label, async () => {
    const { calls, restore } = setup((url, body) => (body.model === bad ? reply() : ok()));
    try {
      const r = await call(provider, { model: bad });
      assert.strictEqual(r.status, 200);
      assert.deepStrictEqual(calls.map((c) => c.body.model), [bad, next]);
      assert.strictEqual(r.headers['x-taryam-model'], next);
    } finally { restore(); }
  });
}

test('other 400s (context length, max_tokens, temperature) are not mistaken for a missing model', async () => {
  const cases = [
    ['deepseek', 'deepseek-chat', "This model's maximum context length is 65536 tokens. However, you requested 70000 tokens (61808 in the messages, 8192 in the completion). Please reduce the length of the messages or completion."],
    ['deepseek', 'deepseek-reasoner', 'Invalid max_tokens value, the valid range of max_tokens is [1, 8192]'],
    ['openai', 'gpt-4o-mini', "Unsupported value: 'temperature' does not support 0.7 with this model. Only the default (1) value is supported."],
  ];
  for (const [provider, model, message] of cases) {
    const { calls, restore } = setup(() => json({ error: { message, type: 'invalid_request_error', code: 'invalid_request_error' } }, 400));
    try {
      const r = await call(provider, { model });
      assert.strictEqual(r.status, 400, message);
      assert.strictEqual(r.body.error.message, message);
      assert.strictEqual(calls.length, 1, 'no fallback for: ' + message);
    } finally { restore(); }
  }
});

test('an upstream stream that breaks mid-way ends with an error event, not as a complete answer', async () => {
  // The break lands inside an event, as a connection reset would.
  const head = 'data: {"choices":[{"delta":{"content":"Part one."}}]}\n\n'
    + 'data: {"choices":[{"delta":{"content":" Part tw';
  const { restore } = setup(() => {
    let n = 0;
    const body = new ReadableStream({
      pull(c) { if (n++ === 0) c.enqueue(new TextEncoder().encode(head)); else c.error(new Error('upstream reset')); },
    });
    return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  });
  try {
    const r = await call('deepseek', { stream: true, model: 'deepseek-chat' });
    assert.strictEqual(r.status, 200);
    assert.ok(r.text.startsWith(head), 'what arrived before the break still reaches the browser');
    assert.ok(r.text.endsWith('\n\n'), 'the error event is terminated by a blank line');
    const data = r.text.split('\n').filter((l) => l.startsWith('data:'));
    const last = JSON.parse(data[data.length - 1].slice(5));
    assert.match(last.error.message, /upstream reset/);
    assert.strictEqual(data.filter((l) => l.includes('"error"')).length, 1, 'exactly one error event');
  } finally { restore(); }
});

// POSTs a streamed chat to the local dev server. onResponse(res, req) drives the read.
function streamRequest(server, onResponse) {
  return new Promise((resolve, reject) => {
    const req = http.request(server.url + '/api/deepseek', { method: 'POST', headers: { 'Content-Type': 'application/json' } },
      (res) => onResponse(res, req, resolve));
    req.on('error', (e) => { if (!req.destroyed) reject(e); });
    req.end(JSON.stringify({ messages: [{ role: 'user', content: 'hi' }], model: 'deepseek-chat', stream: true }));
  });
}

test('a browser that disconnects mid-stream aborts the upstream request', async () => {
  const TOTAL = 60;
  let signal = null;
  let sent = 0;
  const { restore } = setup((url, body, opts) => {
    signal = opts.signal || null;
    const enc = new TextEncoder();
    // Behaves like a real fetch body: aborting the request errors the stream.
    const stream = new ReadableStream({
      start(c) { if (signal) signal.addEventListener('abort', () => { try { c.error(signal.reason); } catch (e) { /* closed */ } }); },
      async pull(c) {
        if (sent >= TOTAL) { c.close(); return; }
        await tick(10);
        if (signal && signal.aborted) return;
        sent++;
        c.enqueue(enc.encode('data: {"choices":[{"delta":{"content":"t' + sent + ' "}}]}\n\n'));
      },
    });
    return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  });
  const server = await startServer();
  try {
    await streamRequest(server, (res, req, done) => {
      assert.strictEqual(res.statusCode, 200);
      res.once('data', () => { req.destroy(); done(); }); // first tokens arrived, then the tab closes
    });
    assert.ok(signal, 'the upstream fetch is given an abort signal');
    for (let i = 0; i < 100 && !signal.aborted; i++) await tick(10);
    assert.strictEqual(signal.aborted, true, 'the upstream request is aborted after the disconnect');
    const atAbort = sent;
    await tick(100);
    assert.strictEqual(sent, atAbort, 'no more upstream chunks are read after the abort');
    assert.ok(sent < TOTAL, 'the upstream answer was not read to the end (' + sent + '/' + TOTAL + ')');
  } finally {
    await server.close();
    restore();
  }
});

test('a stream that completes normally is not aborted and gets no error event', async () => {
  let signal = null;
  const { restore } = setup((url, body, opts) => { signal = opts.signal; return sseResponse(SSE); });
  const server = await startServer();
  try {
    const text = await streamRequest(server, (res, req, done) => {
      let t = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { t += c; });
      res.on('end', () => done(t));
    });
    assert.strictEqual(text, SSE);
    await tick(20);
    assert.strictEqual(signal.aborted, false);
  } finally {
    await server.close();
    restore();
  }
});

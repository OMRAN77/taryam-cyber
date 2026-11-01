// Tests for api/_relay.js through the real provider proxies: SSE is piped through
// when the browser asks for a stream, JSON stays unchanged otherwise, retired model
// ids fall back to the next candidate (or a discovered one), and other errors are
// passed through without retrying. Nothing here talks to the network.
const test = require('node:test');
const assert = require('node:assert');
const { loadApi, createBlobFake, installFetch, STRONG_SECRET } = require('../helpers/harness');

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

// upstream(url, body) -> Response. Records every provider call.
function setup(upstream) {
  const blob = createBlobFake();
  const calls = [];
  const restore = installFetch(blob.fetchImpl(async (url, opts) => {
    const body = opts.body ? JSON.parse(opts.body) : null;
    calls.push({ url, body });
    return upstream(url, body);
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

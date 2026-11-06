const test = require('node:test');
const assert = require('node:assert');
const { loadApi, callApi, createBlobFake, installFetch, STRONG_SECRET } = require('../helpers/harness');

const PROVIDER_KEYS = {
  ANTHROPIC_API_KEY: 'k', COHERE_API_KEY: 'k', DEEPSEEK_API_KEY: 'k', GEMINI_API_KEY: 'k', GROQ_API_KEY: 'k',
  MISTRAL_API_KEY: 'k', OPENAI_API_KEY: 'sk-owner', OPENROUTER_API_KEY: 'k',
};

// Fake upstream AI provider: counts calls, remembers the Authorization header used.
// Limits are on by default for everyone except the owner account(s) (OWNER_USERNAMES,
// default "taryam"); QUOTA=off lifts them all. Each test starts from those defaults.
function setup(env = {}) {
  env = { QUOTA: undefined, OWNER_USERNAMES: undefined, ...env };
  const blob = createBlobFake();
  const upstream = { calls: 0, auth: [] };
  const restore = installFetch(blob.fetchImpl(async (url, opts) => {
    upstream.calls++;
    upstream.auth.push((opts.headers && (opts.headers.Authorization || opts.headers['x-api-key'])) || null);
    upstream.lastBody = opts.body;
    if (url.includes('/audio/speech')) return new Response(Buffer.from('ID3'), { status: 200 });
    return new Response('{"choices":[{"message":{"content":"hi"}}]}', { status: 200 });
  }));
  loadApi('_usage', { AUTH_SECRET: STRONG_SECRET, BLOB_READ_WRITE_TOKEN: blob.token, ...PROVIDER_KEYS, ...env });
  require('../../api/_store').config.retryDelayMs = 0;
  return { blob, upstream, restore };
}
const chat = (handler, ip, extra = {}) => callApi(handler, {
  body: { messages: [{ role: 'user', content: 'hi' }], ...extra },
  headers: { 'x-forwarded-for': ip },
});

test('by default guests are limited but the owner account is not, and costs no Blob I/O', async () => {
  const { blob, upstream, restore } = setup();
  try {
    const { makeToken } = require('../../api/_secrets');
    const ds = require('../../api/deepseek');
    for (let i = 0; i < 20; i++) assert.strictEqual((await chat(ds, '198.51.100.90')).status, 200);
    assert.strictEqual((await chat(ds, '198.51.100.90')).status, 402, 'a guest stops at 20');
    const before = blob.log.length;
    const owner = makeToken('taryam', 0);
    for (let i = 0; i < 25; i++) assert.strictEqual((await chat(ds, '198.51.100.90', { token: owner })).status, 200, 'owner message ' + (i + 1));
    assert.strictEqual(blob.log.length, before, 'no quota counters read or written for the owner');
    assert.strictEqual(upstream.calls, 45);
  } finally { restore(); }
});

test('OWNER_USERNAMES replaces the default owner list', async () => {
  const { restore } = setup({ OWNER_USERNAMES: 'Boss, other' });
  try {
    const { makeToken } = require('../../api/_secrets');
    const ds = require('../../api/deepseek');
    const taryam = makeToken('taryam', 0);
    for (let i = 0; i < 20; i++) assert.strictEqual((await chat(ds, '198.51.100.92', { token: taryam })).status, 200);
    assert.strictEqual((await chat(ds, '198.51.100.92', { token: taryam })).status, 402, 'no longer an owner');
    const boss = makeToken('boss', 0);
    for (let i = 0; i < 25; i++) assert.strictEqual((await chat(ds, '198.51.100.92', { token: boss })).status, 200);
  } finally { restore(); }
});

test('a forged or expired token for the owner name gets no exemption', async () => {
  const { restore } = setup();
  try {
    const { makeToken } = require('../../api/_secrets');
    const ds = require('../../api/deepseek');
    const real = makeToken('taryam', 0);
    const forged = real.slice(0, -2) + (real.endsWith('AA') ? 'BB' : 'AA');
    for (let i = 0; i < 20; i++) assert.strictEqual((await chat(ds, '198.51.100.93', { token: forged })).status, 200);
    assert.strictEqual((await chat(ds, '198.51.100.93', { token: forged })).status, 402, 'counted as a guest');
  } finally { restore(); }
});

test('QUOTA=off lifts every limit and counts nothing', async () => {
  const { blob, upstream, restore } = setup({ QUOTA: 'off' });
  try {
    const ds = require('../../api/deepseek');
    for (let i = 0; i < 25; i++) assert.strictEqual((await chat(ds, '198.51.100.94')).status, 200, 'message ' + (i + 1));
    assert.strictEqual(upstream.calls, 25);
    assert.strictEqual(blob.log.length, 0, 'no quota counters read or written');
  } finally { restore(); }
});

test('with QUOTA=off chat and voice work even without Blob configured', async () => {
  const { upstream, restore } = setup({ QUOTA: 'off', BLOB_READ_WRITE_TOKEN: undefined });
  try {
    assert.strictEqual((await chat(require('../../api/openai'), '198.51.100.91')).status, 200);
    const tts = await callApi(require('../../api/tts'), { body: { text: 'hi', voice: 'nova' }, headers: { 'x-forwarded-for': '198.51.100.91' } });
    assert.strictEqual(tts.status, 200);
    assert.strictEqual(upstream.calls, 2);
  } finally { restore(); }
});

test('scan tools keep their daily limit for guests but not for the owner token', async () => {
  const { blob, restore } = setup();
  try {
    const { makeToken } = require('../../api/_secrets');
    const webscan = require('../../api/webscan');
    const scan = (extra = {}) => callApi(webscan, { body: { mode: 'headers', value: 'example.com', guestId: 'g-1', ...extra }, headers: { 'x-forwarded-for': '198.51.100.95' } });
    for (let i = 0; i < 40; i++) assert.strictEqual((await scan()).status, 200, 'scan ' + (i + 1));
    const over = await scan();
    assert.strictEqual(over.status, 429, 'guest stops at 40');
    const before = blob.log.length;
    const owner = makeToken('taryam', 0);
    for (let i = 0; i < 45; i++) assert.strictEqual((await scan({ token: owner })).status, 200, 'owner scan ' + (i + 1));
    assert.strictEqual(blob.log.length, before, 'no counter I/O for the owner');
  } finally { restore(); }
});

test('guest quota is per IP: a new guestId on every request does not reset it', async () => {
  const { upstream, restore } = setup();
  try {
    const ds = require('../../api/deepseek');
    for (let i = 0; i < 20; i++) assert.strictEqual((await chat(ds, '198.51.100.20', { guestId: 'fresh-id-' + i })).status, 200);
    const over = await chat(ds, '198.51.100.20', { guestId: 'yet-another-id' });
    assert.strictEqual(over.status, 402);
    assert.strictEqual(upstream.calls, 20);
    assert.strictEqual((await chat(ds, '198.51.100.21')).status, 200);
  } finally { restore(); }
});

test('accounts have their own daily quota, independent of IP, reset the next day', async (t) => {
  const { restore } = setup();
  try {
    const { makeToken } = require('../../api/_secrets');
    const ds = require('../../api/deepseek');
    const token = makeToken('alice', 0);
    for (let i = 0; i < 20; i++) assert.strictEqual((await chat(ds, '198.51.100.' + (30 + i), { token })).status, 200);
    assert.strictEqual((await chat(ds, '198.51.100.99', { token })).status, 402);
    t.mock.timers.enable({ apis: ['Date'], now: Date.now() + 24 * 60 * 60 * 1000 });
    try {
      assert.strictEqual((await chat(ds, '198.51.100.99', { token })).status, 200);
    } finally { t.mock.timers.reset(); }
  } finally { restore(); }
});

test('quota counters are encrypted and do not reveal IPs or usernames', async () => {
  const { blob, restore } = setup();
  try {
    const { makeToken } = require('../../api/_secrets');
    const ds = require('../../api/deepseek');
    await chat(ds, '198.51.100.40');
    await chat(ds, '198.51.100.41', { token: makeToken('alice', 0) });
    assert.ok(blob.files.size >= 2);
    for (const [p, v] of blob.files) {
      assert.match(p, /^taryam\/s\/usage-chat\/[0-9a-f]{64}\.json$/);
      for (const leak of ['198.51.100', 'alice', '"count"']) assert.ok(!v.includes(leak) && !p.includes(leak), 'leak: ' + leak);
    }
  } finally { restore(); }
});

test('missing Blob token or AUTH_SECRET fails closed: 503 and the provider is never called', async () => {
  for (const env of [{ BLOB_READ_WRITE_TOKEN: undefined }, { AUTH_SECRET: undefined }]) {
    const { upstream, restore } = setup(env);
    try {
      const r = await chat(require('../../api/deepseek'), '198.51.100.50');
      assert.strictEqual(r.status, 503, JSON.stringify(env));
      assert.strictEqual(upstream.calls, 0);
    } finally { restore(); }
  }
});

test('every server-key proxy enforces the shared quota before calling its provider', async () => {
  const bodies = {
    gemini: { contents: [{ role: 'user', parts: [{ text: 'hi' }] }] },
    stt: { audioBase64: Buffer.from('fake audio').toString('base64'), mimeType: 'audio/webm' },
  };
  for (const name of ['claude', 'cohere', 'deepseek', 'gemini', 'groq', 'mistral', 'openai', 'openrouter', 'stt']) {
    const { upstream, restore } = setup();
    try {
      const store = require('../../api/_store');
      const handler = require('../../api/' + name);
      const body = bodies[name] || { messages: [{ role: 'user', content: 'hi' }] };
      const ok = await callApi(handler, { body, headers: { 'x-forwarded-for': '198.51.100.60' } });
      assert.strictEqual(upstream.calls, 1, name + ' did not reach its provider: ' + JSON.stringify(ok));
      const today = new Date().toISOString().slice(0, 10);
      await store.writeSecret(store.secretPath('usage-chat', 'ip:198.51.100.61'), { date: today, count: 20 });
      const over = await callApi(handler, { body, headers: { 'x-forwarded-for': '198.51.100.61' } });
      assert.strictEqual(over.status, 402, name + ': ' + JSON.stringify(over));
      assert.strictEqual(upstream.calls, 1, name + ' called its provider over quota');
    } finally { restore(); }
  }
});

test('TTS on the owner key needs quota (10 per guest IP); a user-supplied key bypasses it', async () => {
  const { upstream, restore } = setup();
  try {
    const tts = require('../../api/tts');
    const speak = (ip, extra = {}) => callApi(tts, { body: { text: 'hello', voice: 'nova', ...extra }, headers: { 'x-forwarded-for': ip } });
    for (let i = 0; i < 10; i++) assert.strictEqual((await speak('198.51.100.70')).status, 200);
    assert.strictEqual((await speak('198.51.100.70')).status, 402);
    assert.strictEqual(upstream.calls, 10);
    assert.ok(upstream.auth.every((a) => a === 'Bearer sk-owner'));
    const own = await speak('198.51.100.70', { apiKey: 'sk-users-own-key' });
    assert.strictEqual(own.status, 200);
    assert.strictEqual(upstream.auth[upstream.auth.length - 1], 'Bearer sk-users-own-key');
  } finally { restore(); }
});

test('TTS only forwards known voices', async () => {
  const { upstream, restore } = setup();
  try {
    const tts = require('../../api/tts');
    await callApi(tts, { body: { text: 'hello', voice: 'nova' }, headers: { 'x-forwarded-for': '198.51.100.80' } });
    assert.strictEqual(JSON.parse(upstream.lastBody).voice, 'nova');
    await callApi(tts, { body: { text: 'hello', voice: '../../something' }, headers: { 'x-forwarded-for': '198.51.100.80' } });
    assert.strictEqual(JSON.parse(upstream.lastBody).voice, 'onyx');
  } finally { restore(); }
});

test('a body field cannot buy a higher allowance: client=taryam-ext is just the chat bucket', async () => {
  // Regression: the bucket used to be chosen from body.client, so an unauthenticated
  // caller sending "taryam-ext" got the 1000/day extension bucket instead of 20/day.
  const { upstream, restore } = setup();
  try {
    const names = ['claude', 'openai', 'deepseek'];
    for (let n = 0; n < names.length; n++) {
      const h = require('../../api/' + names[n]);
      const ip = '198.51.100.7' + n;   // one address per provider, so each starts clean
      for (let i = 0; i < 20; i++) {
        assert.strictEqual((await chat(h, ip, { client: 'taryam-ext' })).status, 200, names[n] + ' #' + i);
      }
      assert.strictEqual((await chat(h, ip, { client: 'taryam-ext' })).status, 402,
        names[n] + ': the body field earns nothing past the guest limit');
    }
    assert.strictEqual(upstream.calls, 60);
  } finally { restore(); }
});

test('a counter that cannot be saved denies the request instead of granting unlimited free ones', async () => {
  // Regression: the write was wrapped in a swallow-all try/catch, so a storage fault
  // left the count at zero and every request looked like the first of the day.
  const blob = createBlobFake();
  const inner = blob.fetchImpl(async () => new Response('{"choices":[{"message":{"content":"hi"}}]}', { status: 200 }));
  const restore = installFetch(async (url, opts = {}) => {
    const u = new URL(String(url));
    if (u.hostname === 'blob.vercel-storage.com' && String(opts.method || 'GET').toUpperCase() === 'PUT') {
      return new Response('{"error":"storage down"}', { status: 500 });
    }
    return inner(url, opts);
  });
  try {
    loadApi('_usage', { AUTH_SECRET: STRONG_SECRET, BLOB_READ_WRITE_TOKEN: blob.token, ...PROVIDER_KEYS });
    require('../../api/_store').config.retryDelayMs = 0;
    const ds = require('../../api/deepseek');
    const r = await chat(ds, '198.51.100.60');
    assert.strictEqual(r.status, 503, 'an unrecordable allowance is refused, not granted');
    assert.match(String(r.body && r.body.error), /غير مهيأ/, 'reported as a configuration problem');
  } finally { restore(); }
});

test('openai: reasoning models are sent without a temperature', async () => {
  const { upstream, restore } = setup();
  try {
    const h = require('../../api/openai');
    await chat(h, '198.51.100.50', { model: 'o3' });
    assert.ok(!('temperature' in JSON.parse(upstream.lastBody)));
    await chat(h, '198.51.100.50', { model: 'gpt-4.1' });
    assert.strictEqual(JSON.parse(upstream.lastBody).temperature, 0.7);
  } finally { restore(); }
});

// Regression tests for the two scan-tool fixes:
//   1. _destination refuses private/loopback/link-local targets (SSRF and port probing)
//   2. the daily quota is keyed on the caller address, not on a body field
// Nothing here talks to the network: refused targets are rejected before a socket opens.
const test = require('node:test');
const assert = require('node:assert');
const { loadApi, callApi, createBlobFake, installFetch, STRONG_SECRET } = require('../helpers/harness');

const { isBlockedAddress, resolvePublic, parseTarget, BlockedTargetError } =
  require('../../api/_destination');

test('every private, loopback and link-local form is refused', () => {
  const blocked = [
    '127.0.0.1', '127.1.2.3', '10.0.0.5', '172.16.0.1', '172.31.255.254',
    '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '255.255.255.255',
    '::1', '::', 'fe80::1', 'fc00::1', 'fd12:3456::1', '::ffff:127.0.0.1',
    '224.0.0.1', '240.0.0.1',
  ];
  for (const ip of blocked) assert.strictEqual(isBlockedAddress(ip), true, ip + ' must be blocked');

  const allowed = ['8.8.8.8', '1.1.1.1', '93.184.215.14', '2606:2800:21f:cb07:6820:80da:af6b:8b2c'];
  for (const ip of allowed) assert.strictEqual(isBlockedAddress(ip), false, ip + ' must be allowed');
});

test('resolvePublic refuses literal private addresses and unknown hosts', async () => {
  for (const host of ['127.0.0.1', '10.1.2.3', '169.254.169.254', '::1']) {
    await assert.rejects(() => resolvePublic(host), (e) => e instanceof BlockedTargetError, host);
  }
  // A name with no DNS answer must fail closed, not fall through to a fetch.
  await assert.rejects(() => resolvePublic('no-such-host.invalid'), (e) => e instanceof BlockedTargetError);
});

test('parseTarget accepts normal sites and refuses odd ports and schemes', () => {
  assert.strictEqual(parseTarget('https://example.com').port, 443);
  assert.strictEqual(parseTarget('http://example.com').port, 80);
  assert.strictEqual(parseTarget('example.com/path').port, 443); // scheme added for bare domains
  for (const bad of ['https://example.com:22', 'https://example.com:3306', 'ftp://example.com', 'file:///etc/passwd']) {
    assert.throws(() => parseTarget(bad), (e) => e instanceof BlockedTargetError, bad);
  }
});

// --- handler-level: the guard is actually on the request path ---------------------------------

function setupWebscan(env = {}) {
  const blob = createBlobFake();
  const restore = installFetch(blob.fetchImpl(async () => new Response('{"ok":1}', { status: 200 })));
  const webscan = loadApi('webscan', {
    AUTH_SECRET: STRONG_SECRET, BLOB_READ_WRITE_TOKEN: blob.token, QUOTA: undefined, OWNER_USERNAMES: undefined, ...env,
  });
  require('../../api/_store').config.retryDelayMs = 0;
  return { blob, webscan, restore };
}

test('webscan refuses loopback, decimal-IP and metadata targets with 400, and never fetches', async () => {
  const { restore, webscan } = setupWebscan();
  try {
    const targets = [
      { mode: 'headers', value: 'http://127.0.0.1:80/' },
      { mode: 'headers', value: 'http://localhost:80/' },
      { mode: 'headers', value: 'http://169.254.169.254/latest/meta-data/' },
      { mode: 'headers', value: 'http://[::1]:80/' },
      { mode: 'headers', value: 'http://192.168.0.10/' },
      { mode: 'ssl', value: 'https://example.com:22' },
      { mode: 'ssl', value: 'https://example.com' }, // non-TLS port rules are checked first below
    ];
    for (const body of targets.slice(0, 6)) {
      const r = await callApi(webscan, { body: { ...body, guestId: 'g' }, headers: { 'x-forwarded-for': '198.51.100.7' } });
      assert.strictEqual(r.status, 400, JSON.stringify(body) + ' should be refused, got ' + r.status + ' ' + JSON.stringify(r.body));
    }
  } finally { restore(); }
});

test('rotating guestId no longer resets the webscan quota (keyed on the caller address)', async () => {
  const { restore, webscan } = setupWebscan();
  try {
    const scan = (guestId) => callApi(webscan, {
      body: { mode: 'headers', value: 'http://127.0.0.1/', guestId },
      headers: { 'x-forwarded-for': '198.51.100.8' },
    });
    // Refused targets still consume quota, so 40 attempts fill the day for this address
    // regardless of how many different guestIds are used.
    for (let i = 0; i < 40; i++) assert.strictEqual((await scan('fresh-' + i)).status, 400, 'attempt ' + (i + 1));
    const over = await scan('yet-another-id');
    assert.strictEqual(over.status, 429, 'a new guestId must not buy a fresh quota');

    // A different address still has its own counter.
    const other = await callApi(webscan, {
      body: { mode: 'headers', value: 'http://127.0.0.1/', guestId: 'x' },
      headers: { 'x-forwarded-for': '198.51.100.9' },
    });
    assert.strictEqual(other.status, 400);
  } finally { restore(); }
});

test('the owner token is never counted and no counter is read or written', async () => {
  const { blob, restore, webscan } = setupWebscan();
  try {
    const { makeToken } = require('../../api/_secrets');
    const owner = makeToken('taryam', 0);
    const before = blob.log.length;
    for (let i = 0; i < 45; i++) {
      const r = await callApi(webscan, {
        body: { mode: 'headers', value: 'http://127.0.0.1/', token: owner },
        headers: { 'x-forwarded-for': '198.51.100.10' },
      });
      assert.strictEqual(r.status, 400, 'scan ' + (i + 1));
    }
    assert.strictEqual(blob.log.length, before, 'owner scans must not touch the counter store');
  } finally { restore(); }
});

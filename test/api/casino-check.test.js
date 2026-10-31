// api/casino-check.js offline: the page, RDAP, geo and certificate are faked, so the
// test checks what the analysis says about a typical illegal site and a regulated
// one, that private and local addresses are refused before anything is fetched
// (including behind a redirect), and the per-IP daily throttle in the encrypted store.
const test = require('node:test');
const assert = require('node:assert');
const dns = require('dns');
const tls = require('tls');
const { EventEmitter } = require('events');
const { loadApi, callApi, installFetch, createBlobFake, STRONG_SECRET } = require('../helpers/harness');
const C = require('../../api/_casino');

const SCAM_HTML = `<!doctype html><html lang="ar"><head><title>كازينو الإمارات — بونص 200%</title></head><body>
<h1>أفضل كازينو في دبي للاعبين من الإمارات</h1>
<p>سلوتس وروليت وبلاك جاك من Pragmatic Play وEvolution وSpribe (Aviator). موقع مرخّص وآمن 100%.</p>
<p>مكافأة ترحيبية 200% حتى 5000 درهم مع شرط الرهان x40. العب النسخة التجريبية مجانًا.</p>
<p>الإيداع: USDT (TRC20)، بيتكوين، أو عبر وكيل الدفع المحلي بالتحويل البنكي.</p>
<p>الدعم 24/7: <a href="https://t.me/casino_support">تلغرام</a> · في حال الحجب استخدم VPN أو الرابط البديل.</p>
<img src="https://cdn.example-ads.net/banner.png"><script src="https://cdn.example-ads.net/track.js"></script>
</body></html>`;

const REGULATED_HTML = `<!doctype html><html lang="en"><head><title>Example Casino | Official Website</title></head><body>
<p>Slots, roulette and live casino. Deposit with Visa or Mastercard.</p>
<p>Example Ltd is licensed and regulated by the Malta Gaming Authority under licence MGA/B2C/123/2010.</p>
<p>Responsible gaming: deposit limits and self-exclusion. 18+. BeGambleAware.</p>
<script src="https://static.pragmaticplay.net/loader.js"></script>
${'<p>Terms and conditions apply to every promotion listed on this page. </p>'.repeat(8)}
</body></html>`;

function fakeCert({ authorized = true, from = '2024-01-01' } = {}) {
  return () => {
    const s = new EventEmitter();
    s.authorized = authorized;
    s.authorizationError = authorized ? null : 'SELF_SIGNED_CERT_IN_CHAIN';
    s.getPeerCertificate = () => ({ issuer: { O: 'Test CA' }, subject: { CN: 'site' }, valid_from: from, valid_to: '2030-01-01' });
    s.end = () => {};
    s.destroy = () => {};
    return s;
  };
}

function connectFake(certFactory) {
  return (opts, cb) => { const s = certFactory(); setImmediate(cb); return s; };
}

function upstream({ html, registered, country = 'Curacao', code = 'CW', org = 'Some Hosting B.V.' }) {
  return async (url) => {
    const u = new URL(url);
    if (u.hostname === 'rdap.org') return new Response(JSON.stringify({ events: registered ? [{ eventAction: 'registration', eventDate: registered }] : [], entities: [{ roles: ['registrar'], vcardArray: ['vcard', [['fn', {}, 'text', 'Test Registrar']]] }], status: ['active'] }), { headers: { 'content-type': 'application/rdap+json' } });
    if (u.hostname === 'ipwho.is') return new Response(JSON.stringify({ success: true, country, country_code: code, city: 'City', connection: { isp: org, org, asn: 64500 } }));
    if (u.hostname === 'data.iana.org') return new Response(JSON.stringify({ services: [] }));
    if (u.hostname === 'redirector.test') return new Response('', { status: 302, headers: { location: u.pathname === '/inside' ? 'http://local.test/admin' : u.pathname === '/loop' ? 'https://redirector.test/loop' : 'https://landing.test/home' } });
    return new Response(html, { status: 200, headers: { 'content-type': 'text/html', 'strict-transport-security': 'max-age=1' } });
  };
}

function withNetwork(t, { html, registered, cert, ...geo }) {
  const blob = createBlobFake();
  const restoreFetch = installFetch(blob.fetchImpl(upstream({ html, registered, ...geo })));
  const r4 = dns.promises.resolve4, r6 = dns.promises.resolve6, conn = tls.connect;
  dns.promises.resolve4 = async (host) => (host === 'local.test' ? ['10.0.0.5'] : host === 'nowhere.test' ? [] : ['203.0.113.10']);
  dns.promises.resolve6 = async () => [];
  tls.connect = connectFake(fakeCert(cert));
  t.after(() => { restoreFetch(); dns.promises.resolve4 = r4; dns.promises.resolve6 = r6; tls.connect = conn; });
  return blob;
}

const ENV = (blob) => ({ AUTH_SECRET: STRONG_SECRET, BLOB_READ_WRITE_TOKEN: blob.token });
const from = (ip, url) => ({ body: { url }, headers: { 'x-real-ip': ip } });

test('a typical illegal site aimed at the UAE: evidence-backed findings and a high risk', async (t) => {
  const recent = new Date(Date.now() - 40 * 86400000).toISOString();
  const blob = withNetwork(t, { html: SCAM_HTML, registered: recent });
  const api = loadApi('casino-check', ENV(blob));
  const r = await callApi(api, from('198.51.100.1', 'casino-uae-win.test/ar'));
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  const ids = r.body.findings.map((f) => f.id);
  for (const id of ['no-uae-licence', 'licence-vague', 'crypto-only', 'agents', 'messenger', 'mirror', 'bonus', 'demo', 'no-responsible', 'providers-unverified', 'targets-uae', 'domain-new', 'host-abroad']) {
    assert.ok(ids.includes(id), 'missing finding ' + id + ' in ' + ids.join(','));
  }
  assert.ok(!ids.includes('licence-offshore'));
  assert.strictEqual(r.body.level, 'danger');
  assert.strictEqual(r.body.risk, 100);
  assert.strictEqual(r.body.page.isGambling, true);
  assert.strictEqual(r.body.page.targetsUae, true);
  assert.deepStrictEqual(r.body.page.payments, { crypto: true, cards: false, agents: true });
  assert.deepStrictEqual(r.body.page.providers.sort(), ['Evolution', 'Pragmatic Play', 'Spribe']);
  assert.deepStrictEqual(r.body.page.externalHosts, [{ host: 'cdn.example-ads.net', count: 2 }, { host: 't.me', count: 1 }]);
  assert.strictEqual(r.body.registration.registrar, 'Test Registrar');
  assert.strictEqual(r.body.geo.countryCode, 'CW');
  assert.strictEqual(r.body.cert.authorized, true);
  assert.ok(r.body.headers.present.includes('strict-transport-security'));
  assert.strictEqual(r.body.remaining, 19);
  // Every finding carries both languages; evidence quotes the page where it can.
  for (const f of r.body.findings) { assert.ok(f.ar && f.en, f.id); assert.ok(['high', 'medium', 'low', 'info', 'ok'].includes(f.severity)); }
  assert.match(r.body.findings.find((f) => f.id === 'bonus').evidence, /x40/);
  assert.match(r.body.findings.find((f) => f.id === 'mirror').evidence, /VPN/);
});

test('a regulated, long-established site still fails the UAE test but scores lower', async (t) => {
  const blob = withNetwork(t, { html: REGULATED_HTML, registered: '2002-05-13T19:38:40Z', country: 'Malta', code: 'MT', org: 'Example Hosting' });
  const api = loadApi('casino-check', ENV(blob));
  const r = await callApi(api, from('198.51.100.2', 'https://www.example-casino.test/'));
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  const ids = r.body.findings.map((f) => f.id);
  assert.ok(ids.includes('no-uae-licence'));
  assert.ok(ids.includes('licence-offshore'));
  assert.ok(ids.includes('responsible'));
  assert.ok(ids.includes('providers-hosts'));
  assert.ok(ids.includes('domain-age'));
  for (const id of ['licence-vague', 'licence-none', 'crypto-only', 'messenger', 'mirror', 'targets-uae', 'no-responsible']) assert.ok(!ids.includes(id), id);
  assert.deepStrictEqual(r.body.page.licences.map((l) => l.id), ['mga']);
  assert.strictEqual(r.body.domain, 'example-casino.test');
  assert.ok(r.body.risk < 60 && r.body.risk >= 30, 'risk ' + r.body.risk);
  assert.strictEqual(r.body.level, 'warning');
});

test('a bot-challenge page is reported as such, not as "not a casino"', () => {
  const a = C.analyzeHtml('<html><head><title>Just a moment...</title></head><body>Checking your browser before accessing the site.</body></html>', 'https://x.test/');
  assert.strictEqual(a.challenge, true);
  assert.deepStrictEqual(a.findings.map((f) => f.id), ['bot-challenge']);
  const b = C.analyzeHtml('<html><head><title>Blog</title></head><body>Recipes and travel notes.</body></html>', 'https://blog.test/');
  assert.ok(b.findings.some((f) => f.id === 'not-gambling'));
  assert.ok(!b.findings.some((f) => f.id === 'no-uae-licence'));
});

test('private, local and unresolvable targets are refused before any page is fetched', async (t) => {
  const blob = withNetwork(t, { html: SCAM_HTML, registered: null });
  const fetched = [];
  const inner = global.fetch;
  global.fetch = async (url, opts) => { fetched.push(String(url)); return inner(url, opts); };
  t.after(() => { global.fetch = inner; });
  const api = loadApi('casino-check', ENV(blob));
  const { normalizeUrl, isPrivateIp } = api._internal;

  for (const bad of ['', 'localhost', 'ftp://x.test', 'not a url', 'javascript:alert(1)']) assert.strictEqual(normalizeUrl(bad), null, bad);
  assert.strictEqual(normalizeUrl('Casino.Test/path#frag').toString(), 'https://casino.test/path');
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:10.0.0.1']) assert.strictEqual(isPrivateIp(ip), true, ip);
  for (const ip of ['8.8.8.8', '172.32.0.1', '203.0.113.10', '2606:4700::1111']) assert.strictEqual(isPrivateIp(ip), false, ip);

  let r = await callApi(api, from('198.51.100.3', 'local.test'));
  assert.strictEqual(r.status, 400); assert.strictEqual(r.body.error, 'private');
  r = await callApi(api, from('198.51.100.3', 'http://127.0.0.1:8080/admin'));
  assert.strictEqual(r.status, 400); assert.strictEqual(r.body.error, 'private');
  r = await callApi(api, from('198.51.100.3', 'http://[::1]/'));
  assert.strictEqual(r.status, 400); assert.ok(['private', 'invalid'].includes(r.body.error));
  r = await callApi(api, from('198.51.100.3', 'nowhere.test'));
  assert.strictEqual(r.status, 400); assert.strictEqual(r.body.error, 'unresolvable');
  r = await callApi(api, from('198.51.100.3', 'localhost'));
  assert.strictEqual(r.status, 400); assert.strictEqual(r.body.error, 'invalid');
  // A public site that redirects to a private address: the hop is refused and never fetched.
  r = await callApi(api, from('198.51.100.3', 'https://redirector.test/inside'));
  assert.strictEqual(r.status, 400); assert.strictEqual(r.body.error, 'private');
  assert.ok(!fetched.some((u) => /local\.test/.test(u)), 'private redirect target was fetched: ' + fetched.join(' '));
  // Redirect loops end instead of hanging.
  r = await callApi(api, from('198.51.100.3', 'https://redirector.test/loop'));
  assert.strictEqual(r.status, 200);
  assert.ok(r.body.findings.some((f) => f.id === 'unreachable' && /too many redirects/.test(f.en)));
  // A redirect to another public domain is followed and reported as a mirror.
  r = await callApi(api, from('198.51.100.3', 'https://redirector.test/go'));
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.finalUrl, 'https://landing.test/home');
  assert.ok(r.body.findings.some((f) => f.id === 'redirected'));
  const nonUsage = fetched.filter((u) => !/blob\.vercel-storage\.com/.test(u));
  assert.ok(nonUsage.every((u) => /redirector\.test|landing\.test|rdap\.org|ipwho\.is/.test(u)), 'unexpected fetch: ' + nonUsage.join(' '));
  assert.strictEqual((await callApi(api, { method: 'GET' })).status, 405);
});

test('daily throttle is per platform-seen IP, in the encrypted store, and the browser\'s guestId is ignored', async (t) => {
  const blob = withNetwork(t, { html: REGULATED_HTML, registered: '2010-01-01T00:00:00Z' });
  const api = loadApi('casino-check', ENV(blob));
  const store = require('../../api/_store');
  const path = store.secretPath('usage-casino-check', 'ip:198.51.100.4');
  await store.writeSecret(path, { date: new Date().toISOString().slice(0, 10), count: 19 });
  let r = await callApi(api, { body: { url: 'example-casino.test', guestId: 'fresh-id-1' }, headers: { 'x-real-ip': '198.51.100.4' } });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.remaining, 0);
  r = await callApi(api, { body: { url: 'example-casino.test', guestId: 'fresh-id-2' }, headers: { 'x-real-ip': '198.51.100.4' } });
  assert.strictEqual(r.status, 429);
  assert.strictEqual(r.body.error, 'limit');
  // Another IP is unaffected.
  r = await callApi(api, from('198.51.100.5', 'example-casino.test'));
  assert.strictEqual(r.status, 200);
  // Nothing stored names an IP or is readable without the key.
  for (const [p, v] of blob.files) {
    assert.match(p, /^taryam\/s\/usage-casino-check\/[0-9a-f]{64}\.json$/);
    assert.ok(!p.includes('198.51') && !v.includes('198.51') && !v.includes('count'), p);
  }
});

test('without AUTH_SECRET or the Blob token the tool fails closed and visits nothing', async (t) => {
  const blob = withNetwork(t, { html: REGULATED_HTML, registered: '2010-01-01T00:00:00Z' });
  const fetched = [];
  const inner = global.fetch;
  global.fetch = async (url, opts) => { fetched.push(String(url)); return inner(url, opts); };
  t.after(() => { global.fetch = inner; });
  for (const env of [{ AUTH_SECRET: undefined, BLOB_READ_WRITE_TOKEN: blob.token }, { AUTH_SECRET: STRONG_SECRET, BLOB_READ_WRITE_TOKEN: undefined }]) {
    const api = loadApi('casino-check', env);
    const r = await callApi(api, from('198.51.100.6', 'example-casino.test'));
    assert.strictEqual(r.status, 503);
    assert.strictEqual(r.body.error, 'config');
  }
  assert.deepStrictEqual(fetched, []);
});

// Vercel Serverless Function: web security scanner.
// Two modes in one endpoint (kept together since both just inspect a URL):
//   - headers: fetch the URL and grade its HTTP security headers
//     (CSP, HSTS, X-Frame-Options, X-Content-Type-Options, Referrer-Policy,
//     Permissions-Policy) similar to securityheaders.com.
//   - ssl: connect via TLS to the host and report certificate validity,
//     issuer, expiry, and negotiated protocol/cipher.
// No external API key needed; lightweight per-IP daily throttling.
const tls = require('tls');
const http = require('http');
const https = require('https');
const { resolvePublic, parseTarget, BlockedTargetError, TLS_PORTS } = require('./_destination');

// Up to 3 hops; every hop is re-checked against _destination before it is fetched.
const MAX_REDIRECTS = 3;

const DAILY_LIMIT = 40;
const scanQuota = require('./_scancounter');

function normalizeUrl(input) {
  let u = String(input || '').trim();
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
  return u;
}

// Fetches one hop with the connection pinned to an address that resolvePublic()
// already accepted, so a second DNS answer cannot redirect the socket. Redirects
// are returned to the caller instead of being followed by the HTTP client.
async function fetchPinned(url, address, family) {
  const transport = url.protocol === 'https:' ? https : http;
  const opts = {
    protocol: url.protocol,
    host: address,
    family,
    port: url.port ? Number(url.port) : (url.protocol === 'https:' ? 443 : 80),
    path: (url.pathname || '/') + (url.search || ''),
    method: 'GET',
    headers: { Host: url.host, 'User-Agent': 'TaryamCyber-WebScan/1.0' },
    timeout: 8000,
  };
  if (url.protocol === 'https:') opts.servername = url.hostname; // SNI/cert still the real host
  return new Promise((resolve, reject) => {
    const req = transport.request(opts, (res) => {
      res.resume(); // drain the body; only headers are needed
      resolve({ status: res.statusCode, headers: res.headers });
    });
    req.on('timeout', () => req.destroy(new Error('Request timed out')));
    req.on('error', reject);
    req.end();
  });
}

async function scanHeaders(urlStr) {
  let url = parseTarget(urlStr).url;
  let res = null;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const { address, family } = await resolvePublic(url.hostname);
    res = await fetchPinned(url, address, family);
    const location = res.headers.location;
    if (res.status >= 300 && res.status < 400 && location) {
      const next = new URL(location, url);
      parseTarget(next.toString()); // validates scheme and port of the hop
      url = next;
      continue;
    }
    break;
  }
  if (res && res.status >= 300 && res.status < 400) throw new BlockedTargetError('Too many redirects');
  const h = {};
  Object.keys(res.headers).forEach((k) => { h[k.toLowerCase()] = String(res.headers[k]); });

  const checks = [
    { key: 'strict-transport-security', label: 'HSTS', points: 20 },
    { key: 'content-security-policy', label: 'Content-Security-Policy', points: 25 },
    { key: 'x-content-type-options', label: 'X-Content-Type-Options', points: 15 },
    { key: 'x-frame-options', label: 'X-Frame-Options', points: 15 },
    { key: 'referrer-policy', label: 'Referrer-Policy', points: 10 },
    { key: 'permissions-policy', label: 'Permissions-Policy', points: 15 },
  ];
  let score = 0;
  const details = checks.map((c) => {
    const present = !!h[c.key];
    if (present) score += c.points;
    return { label: c.label, present, value: present ? h[c.key] : null };
  });
  let grade = 'F';
  if (score >= 90) grade = 'A+';
  else if (score >= 80) grade = 'A';
  else if (score >= 65) grade = 'B';
  else if (score >= 50) grade = 'C';
  else if (score >= 30) grade = 'D';
  return { url: url.toString(), status: res.status, score, grade, details, server: h['server'] || null };
}

async function scanSsl(urlStr) {
  const { url, hostname, port } = parseTarget(urlStr);
  if (!TLS_PORTS.has(port)) throw new BlockedTargetError('Certificate checks run on ports 443 and 8443 only');
  const host = hostname;
  const { address, family } = await resolvePublic(host);
  return new Promise((resolve, reject) => {
    const socket = tls.connect({ host: address, family, port, servername: host, timeout: 8000, rejectUnauthorized: false }, () => {
      const cert = socket.getPeerCertificate();
      const proto = socket.getProtocol();
      const cipher = socket.getCipher();
      const now = Date.now();
      const validTo = cert.valid_to ? new Date(cert.valid_to) : null;
      const validFrom = cert.valid_from ? new Date(cert.valid_from) : null;
      const daysLeft = validTo ? Math.round((validTo.getTime() - now) / 86400000) : null;
      resolve({
        host,
        protocol: proto,
        cipher: cipher ? cipher.name : null,
        authorized: socket.authorized,
        authorizationError: socket.authorizationError ? String(socket.authorizationError) : null,
        issuer: cert.issuer ? (cert.issuer.O || cert.issuer.CN) : null,
        subject: cert.subject ? cert.subject.CN : null,
        validFrom: validFrom ? validFrom.toISOString() : null,
        validTo: validTo ? validTo.toISOString() : null,
        daysLeft,
        expired: daysLeft !== null ? daysLeft < 0 : null,
        expiringSoon: daysLeft !== null ? (daysLeft >= 0 && daysLeft <= 21) : null,
      });
      socket.end();
    });
    socket.on('timeout', () => { socket.destroy(); reject(new Error('TLS connection timed out')); });
    socket.on('error', (e) => reject(e));
  });
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  try {
    const body = req.body || {};
    const mode = body.mode;
    if (!['headers', 'ssl'].includes(mode)) {
      res.status(400).json({ error: 'mode must be "headers" or "ssl"' });
      return;
    }
    const urlStr = normalizeUrl(body.value);
    try {
      parseTarget(urlStr);
    } catch (e) {
      res.status(400).json({ error: e instanceof BlockedTargetError ? e.message : 'Invalid URL/domain' });
      return;
    }

    // Daily per-tool limit keyed on the caller address; never for the owner's account
    // or a QUOTA=off deployment (see _scancounter.js).
    let quota;
    try {
      quota = await scanQuota.consume(req, { namespace: 'webscan', limit: DAILY_LIMIT, token: body.token });
    } catch (e) {
      res.status(503).json({ error: 'الخدمة غير مهيأة للمحاسبة (AUTH_SECRET)' });
      return;
    }
    if (quota.noAddress) { res.status(403).json({ error: 'Cannot determine caller address' }); return; }
    if (!quota.allowed) { scanQuota.limitResponse(res, DAILY_LIMIT); return; }

    if (mode === 'headers') {
      const result = await scanHeaders(urlStr);
      res.status(200).json({ mode, ...result, remaining: quota.remaining });
    } else {
      const result = await scanSsl(urlStr);
      res.status(200).json({ mode, ...result, remaining: quota.remaining });
    }
  } catch (e) {
    // A refused target is the caller's problem, not a server fault.
    if (e instanceof BlockedTargetError) {
      res.status(400).json({ error: e.message });
      return;
    }
    res.status(500).json({ error: 'Scan failed: ' + (e && e.message ? e.message : String(e)) });
  }
};

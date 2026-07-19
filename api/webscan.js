// Vercel Serverless Function: web security scanner.
// Two modes in one endpoint (kept together since both just inspect a URL):
//   - headers: fetch the URL and grade its HTTP security headers
//     (CSP, HSTS, X-Frame-Options, X-Content-Type-Options, Referrer-Policy,
//     Permissions-Policy) similar to securityheaders.com.
//   - ssl: connect via TLS to the host and report certificate validity,
//     issuer, expiry, and negotiated protocol/cipher.
// No external API key needed; lightweight per-IP daily throttling.
const tls = require('tls');

const BLOB_TOKEN = process.env.BLOB_READ_WRITE_TOKEN;
const BLOB_BASE = 'https://blob.vercel-storage.com';
const STORE_ID = process.env.BLOB_STORE_ID || '6tfgxvttzyoiavtu';
const PUBLIC_BASE = 'https://' + STORE_ID + '.public.blob.vercel-storage.com/';

const DAILY_LIMIT = 40;

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}
function usagePath(id) {
  return 'taryam/db/webscan_usage/' + encodeURIComponent(id) + '.json';
}
async function readBlobJson(path, fallback) {
  try {
    const res = await fetch(PUBLIC_BASE + path + '?_=' + Date.now(), { cache: 'no-store' });
    if (!res.ok) return fallback;
    return await res.json();
  } catch (e) {
    return fallback;
  }
}
async function writeBlobJson(path, data) {
  try {
    await fetch(BLOB_BASE + '/' + path, {
      method: 'PUT',
      headers: {
        Authorization: 'Bearer ' + BLOB_TOKEN,
        'x-content-type': 'application/json',
        'x-add-random-suffix': '0',
        'x-cache-control-max-age': '0',
      },
      body: JSON.stringify(data),
    });
  } catch (e) {}
}

function normalizeUrl(input) {
  let u = String(input || '').trim();
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
  return u;
}

async function scanHeaders(urlStr) {
  const url = new URL(urlStr);
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 8000);
  const res = await fetch(url.toString(), { redirect: 'follow', signal: controller.signal, headers: { 'User-Agent': 'TaryamCyber-WebScan/1.0' } });
  clearTimeout(t);
  const h = {};
  res.headers.forEach((v, k) => { h[k.toLowerCase()] = v; });

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

function scanSsl(urlStr) {
  const url = new URL(urlStr);
  const host = url.hostname;
  const port = url.port ? Number(url.port) : 443;
  return new Promise((resolve, reject) => {
    const socket = tls.connect({ host, port, servername: host, timeout: 8000, rejectUnauthorized: false }, () => {
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
    let parsed;
    try { parsed = new URL(urlStr); } catch (e) {
      res.status(400).json({ error: 'Invalid URL/domain' });
      return;
    }
    if (!/^https?:$/.test(parsed.protocol)) {
      res.status(400).json({ error: 'Only http/https supported' });
      return;
    }

    const id = String(body.guestId || req.headers['x-forwarded-for'] || 'anon').slice(0, 100);
    const today = todayStr();
    let usage = await readBlobJson(usagePath(id), null);
    if (!usage || usage.date !== today) usage = { date: today, count: 0 };
    if (usage.count >= DAILY_LIMIT) {
      res.status(429).json({ error: 'limit', message: 'وصلت للحد اليومي المسموح لهذه الأداة (' + DAILY_LIMIT + ' فحوصات/يوم). حاول غدًا.' });
      return;
    }
    usage.count += 1;
    await writeBlobJson(usagePath(id), usage);

    if (mode === 'headers') {
      const result = await scanHeaders(urlStr);
      res.status(200).json({ mode, ...result, remaining: DAILY_LIMIT - usage.count });
    } else {
      const result = await scanSsl(urlStr);
      res.status(200).json({ mode, ...result, remaining: DAILY_LIMIT - usage.count });
    }
  } catch (e) {
    res.status(500).json({ error: 'Scan failed: ' + (e && e.message ? e.message : String(e)) });
  }
};

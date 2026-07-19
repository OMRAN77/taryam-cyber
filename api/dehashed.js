// Vercel Serverless Function: proxies breach/leak lookups to the DeHashed v2
// Search API using a server-side DEHASHED_API_KEY. This returns REAL leaked
// records (emails, usernames, passwords, IPs, names, phones, etc.) pulled from
// known data breaches — much more sensitive than the HIBP "was I breached"
// check, so this endpoint is locked down harder:
//   - Requires a logged-in account (no guest/anonymous access).
//   - Small daily quota per account (keeps API credit spend + abuse in check).
//   - Every query is written to an audit log per user (who searched what, when)
//     so usage can be reviewed if a report/complaint ever comes in.
// The user explicitly acknowledged responsibility for how this tool's results
// are used before this endpoint was enabled.
const crypto = require('crypto');

const AUTH_SECRET = process.env.AUTH_SECRET || 'fallback-dev-secret-change-me';
const BLOB_TOKEN = process.env.BLOB_READ_WRITE_TOKEN;
const BLOB_BASE = 'https://blob.vercel-storage.com';
const STORE_ID = process.env.BLOB_STORE_ID || '6tfgxvttzyoiavtu';
const PUBLIC_BASE = 'https://' + STORE_ID + '.public.blob.vercel-storage.com/';

const SEARCH_URL = 'https://api.dehashed.com/v2/search';
const DAILY_LIMIT = 5; // per logged-in account
const MAX_SIZE = 20;   // max records returned per search (cost control)

const ALLOWED_FIELDS = ['email', 'username', 'password', 'hashed_password', 'ip_address', 'name', 'phone', 'domain', 'address', 'vin'];

function verifyToken(token) {
  try {
    const [payload, sig] = String(token).split('.');
    const expected = crypto.createHmac('sha256', AUTH_SECRET).update(payload).digest('base64url');
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
    if (data.exp < Date.now()) return null;
    return data.u;
  } catch (e) {
    return null;
  }
}

function todayStr() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
}

function usagePath(username) {
  return 'taryam/db/dehashed_usage/' + encodeURIComponent(username) + '.json';
}

function auditPath(username) {
  return 'taryam/db/dehashed_audit/' + encodeURIComponent(username) + '.json';
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
  } catch (e) {
    // Best-effort; never block the real request over a bookkeeping write.
  }
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
    const apiKey = process.env.DEHASHED_API_KEY;
    if (!apiKey) {
      res.status(200).json({ notConfigured: true });
      return;
    }

    const body = req.body || {};
    const { token, field, value } = body;

    // Sensitive leak-data lookups require a real, logged-in account — no
    // anonymous guest access, unlike the AI chat and the basic HIBP check.
    const username = verifyToken(token);
    if (!username) {
      res.status(401).json({ error: 'auth', message: 'يجب تسجيل الدخول لاستخدام أداة البحث المتقدم عن التسريبات.' });
      return;
    }

    if (!ALLOWED_FIELDS.includes(field)) {
      res.status(400).json({ error: 'Invalid field. Allowed: ' + ALLOWED_FIELDS.join(', ') });
      return;
    }
    const q = String(value || '').trim();
    if (!q || q.length > 200) {
      res.status(400).json({ error: 'Invalid query value' });
      return;
    }

    // Daily quota per account.
    const today = todayStr();
    let usage = await readBlobJson(usagePath(username), null);
    if (!usage || usage.date !== today) usage = { date: today, count: 0 };
    if (usage.count >= DAILY_LIMIT) {
      res.status(429).json({ error: 'limit', message: 'وصلت للحد اليومي المسموح لهذه الأداة (' + DAILY_LIMIT + ' عمليات بحث/يوم). حاول غدًا.' });
      return;
    }
    usage.count += 1;
    await writeBlobJson(usagePath(username), usage);

    // Audit log (append-only, per user).
    const audit = await readBlobJson(auditPath(username), []);
    audit.push({ ts: new Date().toISOString(), field, value: q });
    if (audit.length > 500) audit.splice(0, audit.length - 500); // cap log size
    await writeBlobJson(auditPath(username), audit);

    const query = field === 'domain' ? `domain:${q}` : `${field}:"${q}"`;

    const upstream = await fetch(SEARCH_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'DeHashed-Api-Key': apiKey,
      },
      body: JSON.stringify({
        query,
        page: 1,
        size: MAX_SIZE,
        wildcard: false,
        regex: false,
        de_dupe: true,
      }),
    });

    if (!upstream.ok) {
      const txt = await upstream.text().catch(() => '');
      res.status(upstream.status).json({ error: 'DeHashed lookup failed (' + upstream.status + ')', detail: txt.slice(0, 300) });
      return;
    }
    const data = await upstream.json();
    res.status(200).json({
      total: data.total || (data.entries ? data.entries.length : 0),
      entries: data.entries || [],
      remaining: DAILY_LIMIT - usage.count,
    });
  } catch (e) {
    res.status(500).json({ error: 'Proxy error: ' + (e && e.message ? e.message : String(e)) });
  }
};

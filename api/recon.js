// Vercel Serverless Function: domain reconnaissance.
// - Subdomain discovery via crt.sh certificate-transparency logs (free, no key).
// - DNS record lookup (A, AAAA, MX, TXT, NS, CNAME) via Node's built-in dns module.
// No API key needed; lightweight per-IP daily throttling to avoid abuse.
const dns = require('dns').promises;

const BLOB_TOKEN = process.env.BLOB_READ_WRITE_TOKEN;
const BLOB_BASE = 'https://blob.vercel-storage.com';
const STORE_ID = process.env.BLOB_STORE_ID || '6tfgxvttzyoiavtu';
const PUBLIC_BASE = 'https://' + STORE_ID + '.public.blob.vercel-storage.com/';

const DAILY_LIMIT = 30;

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}
function usagePath(id) {
  return 'taryam/db/recon_usage/' + encodeURIComponent(id) + '.json';
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

function isValidDomain(d) {
  return /^(?!-)[A-Za-z0-9-]{1,63}(?<!-)(\.[A-Za-z0-9-]{1,63})+$/.test(d);
}

async function getSubdomains(domain) {
  const url = `https://crt.sh/?q=${encodeURIComponent('%.' + domain)}&output=json`;
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { 'User-Agent': 'TaryamCyber-Recon/1.0' } });
    clearTimeout(t);
    if (!res.ok) return [];
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch (e) { return []; }
    const names = new Set();
    for (const row of data) {
      const nameValue = row.name_value || '';
      nameValue.split('\n').forEach((n) => {
        n = n.trim().toLowerCase().replace(/^\*\./, '');
        if (n && n.endsWith(domain)) names.add(n);
      });
    }
    return Array.from(names).sort().slice(0, 200);
  } catch (e) {
    clearTimeout(t);
    return [];
  }
}

async function getDnsRecords(domain) {
  const out = {};
  const lookups = [
    ['A', () => dns.resolve4(domain)],
    ['AAAA', () => dns.resolve6(domain)],
    ['MX', () => dns.resolveMx(domain)],
    ['TXT', () => dns.resolveTxt(domain)],
    ['NS', () => dns.resolveNs(domain)],
    ['CNAME', () => dns.resolveCname(domain)],
  ];
  await Promise.all(lookups.map(async ([type, fn]) => {
    try {
      out[type] = await fn();
    } catch (e) {
      out[type] = [];
    }
  }));
  return out;
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
    const raw = String(body.domain || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    if (!isValidDomain(raw)) {
      res.status(400).json({ error: 'Invalid domain format' });
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

    const [subdomains, dnsRecords] = await Promise.all([getSubdomains(raw), getDnsRecords(raw)]);

    res.status(200).json({
      domain: raw,
      subdomains,
      subdomainCount: subdomains.length,
      dns: dnsRecords,
      remaining: DAILY_LIMIT - usage.count,
    });
  } catch (e) {
    res.status(500).json({ error: 'Recon error: ' + (e && e.message ? e.message : String(e)) });
  }
};

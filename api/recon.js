// Vercel Serverless Function: domain reconnaissance.
// - Subdomain discovery via crt.sh certificate-transparency logs (free, no key).
// - DNS record lookup (A, AAAA, MX, TXT, NS, CNAME) via Node's built-in dns module.
// No API key needed; lightweight per-IP daily throttling to avoid abuse.
const dns = require('dns').promises;

const DAILY_LIMIT = 30;
const scanQuota = require('./_scancounter');

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

    // Daily per-tool limit keyed on the caller address; never for the owner's account
    // or a QUOTA=off deployment (see _scancounter.js).
    let quota;
    try {
      quota = await scanQuota.consume(req, { namespace: 'recon', limit: DAILY_LIMIT, token: body.token });
    } catch (e) {
      res.status(503).json({ error: 'الخدمة غير مهيأة للمحاسبة (AUTH_SECRET)' });
      return;
    }
    if (quota.noAddress) { res.status(403).json({ error: 'Cannot determine caller address' }); return; }
    if (!quota.allowed) { scanQuota.limitResponse(res, DAILY_LIMIT); return; }

    const [subdomains, dnsRecords] = await Promise.all([getSubdomains(raw), getDnsRecords(raw)]);

    res.status(200).json({
      domain: raw,
      subdomains,
      subdomainCount: subdomains.length,
      dns: dnsRecords,
      remaining: quota.remaining,
    });
  } catch (e) {
    res.status(500).json({ error: 'Recon error: ' + (e && e.message ? e.message : String(e)) });
  }
};

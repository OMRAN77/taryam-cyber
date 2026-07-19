// Vercel Serverless Function: proxies IP reputation lookups to the AbuseIPDB
// public API using a server-side ABUSEIPDB_API_KEY. If no key is configured
// yet, responds with notConfigured so the UI can show a friendly
// "coming soon" message instead of erroring.
// Free AbuseIPDB tier allows ~1000 checks/day, so this endpoint also applies
// its own lightweight per-IP daily throttling to keep the owner's quota safe.
const BLOB_TOKEN = process.env.BLOB_READ_WRITE_TOKEN;
const BLOB_BASE = 'https://blob.vercel-storage.com';
const STORE_ID = process.env.BLOB_STORE_ID || '6tfgxvttzyoiavtu';
const PUBLIC_BASE = 'https://' + STORE_ID + '.public.blob.vercel-storage.com/';

const DAILY_LIMIT = 40;

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}
function usagePath(id) {
  return 'taryam/db/iprep_usage/' + encodeURIComponent(id) + '.json';
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

const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const IPV6_RE = /^[0-9a-fA-F:]+$/;

function isValidIp(ip) {
  if (IPV4_RE.test(ip)) {
    return ip.split('.').every((p) => Number(p) >= 0 && Number(p) <= 255);
  }
  return ip.includes(':') && IPV6_RE.test(ip);
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
    const apiKey = process.env.ABUSEIPDB_API_KEY;
    if (!apiKey) {
      res.status(200).json({ notConfigured: true });
      return;
    }

    const body = req.body || {};
    const ip = String(body.ip || '').trim();
    if (!ip || !isValidIp(ip)) {
      res.status(400).json({ error: 'Invalid IP address' });
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

    const upstream = await fetch(
      'https://api.abuseipdb.com/api/v2/check?ipAddress=' + encodeURIComponent(ip) + '&maxAgeInDays=90&verbose',
      { headers: { Key: apiKey, Accept: 'application/json' } }
    );

    if (!upstream.ok) {
      res.status(upstream.status).json({ error: 'AbuseIPDB lookup failed (' + upstream.status + ')' });
      return;
    }
    const json = await upstream.json();
    const d = json.data || {};
    res.status(200).json({
      ip: d.ipAddress,
      abuseScore: d.abuseConfidenceScore,
      totalReports: d.totalReports,
      lastReportedAt: d.lastReportedAt || null,
      isWhitelisted: !!d.isWhitelisted,
      isTor: !!d.isTor,
      isp: d.isp || null,
      usageType: d.usageType || null,
      domain: d.domain || null,
      countryCode: d.countryCode || null,
      countryName: d.countryName || null,
      reports: (d.reports || []).slice(0, 8).map((r) => ({
        reportedAt: r.reportedAt,
        comment: (r.comment || '').slice(0, 200),
        categories: r.categories || [],
      })),
      remaining: DAILY_LIMIT - usage.count,
    });
  } catch (e) {
    res.status(500).json({ error: 'Proxy error: ' + (e && e.message ? e.message : String(e)) });
  }
};

// Vercel Serverless Function: proxies IP reputation lookups to the AbuseIPDB
// public API using a server-side ABUSEIPDB_API_KEY. If no key is configured
// yet, responds with notConfigured so the UI can show a friendly
// "coming soon" message instead of erroring.
// Free AbuseIPDB tier allows ~1000 checks/day, so this endpoint also applies
// its own lightweight per-IP daily throttling to keep the owner's quota safe.
const DAILY_LIMIT = 40;
const { quotaEnabled, isOwnerToken } = require('./_quota');
const { clientIp } = require('./_client');
const store = require('./_store');

function todayStr() {
  return new Date().toISOString().slice(0, 10);
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

    // Keyed on the platform-verified caller address, never on a body field, and kept
    // at an HMAC-derived encrypted path (see _store.js) like the other counters.
    const today = todayStr();
    // Daily per-tool limit; never for the owner's account or a QUOTA=off deployment (api/_quota.js).
    const limited = quotaEnabled() && !isOwnerToken(body.token);
    let usage = { date: today, count: 0 };
    if (limited) {
      const id = clientIp(req);
      if (!id) { res.status(403).json({ error: 'Cannot determine caller address' }); return; }
      let counterPath;
      try {
        counterPath = store.secretPath('iprep-usage', 'ip:' + id);
        usage = await store.readSecret(counterPath);
      } catch (e) {
        res.status(503).json({ error: 'الخدمة غير مهيأة للمحاسبة (AUTH_SECRET)' });
        return;
      }
      if (!usage || usage.date !== today) usage = { date: today, count: 0 };
      if (usage.count >= DAILY_LIMIT) {
        res.status(429).json({ error: 'limit', message: 'وصلت للحد اليومي المسموح لهذه الأداة (' + DAILY_LIMIT + ' فحوصات/يوم). حاول غدًا.' });
        return;
      }
      usage.count += 1;
      try { await store.writeSecret(counterPath, usage); } catch (e) {}
    }

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
      remaining: limited ? DAILY_LIMIT - usage.count : null,
    });
  } catch (e) {
    res.status(500).json({ error: 'Proxy error: ' + (e && e.message ? e.message : String(e)) });
  }
};

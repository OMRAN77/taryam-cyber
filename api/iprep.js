// Vercel Serverless Function: proxies IP reputation lookups to the AbuseIPDB
// public API using a server-side ABUSEIPDB_API_KEY. If no key is configured
// yet, responds with notConfigured so the UI can show a friendly
// "coming soon" message instead of erroring.
// Free AbuseIPDB tier allows ~1000 checks/day, so this endpoint also applies
// its own lightweight per-IP daily throttling to keep the owner's quota safe.
const DAILY_LIMIT = 40;
const scanQuota = require('./_scancounter');

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

    // Daily per-tool limit keyed on the caller address; never for the owner's account
    // or a QUOTA=off deployment (see _scancounter.js).
    let quota;
    try {
      quota = await scanQuota.consume(req, { namespace: 'iprep', limit: DAILY_LIMIT, token: body.token });
    } catch (e) {
      res.status(503).json({ error: 'الخدمة غير مهيأة للمحاسبة (AUTH_SECRET)' });
      return;
    }
    if (quota.noAddress) { res.status(403).json({ error: 'Cannot determine caller address' }); return; }
    if (!quota.allowed) { scanQuota.limitResponse(res, DAILY_LIMIT); return; }

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
      remaining: quota.remaining,
    });
  } catch (e) {
    res.status(500).json({ error: 'Proxy error: ' + (e && e.message ? e.message : String(e)) });
  }
};

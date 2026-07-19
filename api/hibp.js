// Vercel Serverless Function: proxies breach lookups to the "Have I Been Pwned"
// public breach-check API using a server-side HIBP_API_KEY (paid, ~$3.95/mo).
// If no key is configured yet, responds with notConfigured so the UI can show
// a friendly "coming soon" message instead of erroring.
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  try {
    const apiKey = process.env.HIBP_API_KEY;
    if (!apiKey) {
      res.status(200).json({ notConfigured: true });
      return;
    }

    const email = (req.query && req.query.email) || '';
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      res.status(400).json({ error: 'Invalid email' });
      return;
    }

    const upstream = await fetch(
      `https://haveibeenpwned.com/api/v3/breachedaccount/${encodeURIComponent(email)}?truncateResponse=false`,
      { headers: { 'hibp-api-key': apiKey, 'user-agent': 'TARYAM-Cyber' } }
    );

    if (upstream.status === 404) {
      res.status(200).json({ breaches: [] });
      return;
    }
    if (!upstream.ok) {
      res.status(upstream.status).json({ error: 'HIBP lookup failed (' + upstream.status + ')' });
      return;
    }
    const data = await upstream.json();
    res.status(200).json({ breaches: data });
  } catch (e) {
    res.status(500).json({ error: 'Proxy error: ' + (e && e.message ? e.message : String(e)) });
  }
};

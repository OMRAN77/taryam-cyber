// Vercel Serverless Function: proxies chat requests to Cohere using the site
// owner's own server-side API key (COHERE_API_KEY env var), so visitors can try
// the app without entering their own key. This key is NEVER exposed to the client.
const { checkAndConsume, DAILY_LIMIT } = require('./_usage');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  try {
    const apiKey = process.env.COHERE_API_KEY;
    if (!apiKey) {
      res.status(500).json({ error: 'Server is missing COHERE_API_KEY' });
      return;
    }

    let body = req.body;
    if (!body || typeof body === 'string') {
      body = JSON.parse(body || '{}');
    }
    let { messages, model, token, guestId } = body;
    // Deprecated/retired Cohere model names get silently upgraded server-side,
    // so stale client caches (old JS, old localStorage) never hit a hard error.
    const DEPRECATED_MODELS = new Set(['command-r-plus', 'command-r', 'command-r-plus-08-2024', 'command-r-08-2024', 'command']);
    if (!model || DEPRECATED_MODELS.has(String(model).trim().toLowerCase())) {
      model = 'command-a-03-2025';
    }
    if (!messages) {
      res.status(400).json({ error: 'Missing messages' });
      return;
    }

    const usage = await checkAndConsume(token, guestId);
    if (!usage.allowed) {
      if (usage.reason === 'auth') {
        res.status(401).json({ error: 'الجلسة منتهية، الرجاء تسجيل الدخول من جديد' });
      } else {
        res.status(402).json({ error: 'وصلت للحد اليومي المجاني (' + DAILY_LIMIT + ' رسالة) لهذا المزوّد. جرّب مزودًا آخر بمفتاحك الخاص أو انتظر الغد.' });
      }
      return;
    }

    const upstream = await fetch('https://api.cohere.com/compatibility/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + apiKey,
      },
      body: JSON.stringify({
        model: model || 'command-a-03-2025',
        messages,
        temperature: 0.7,
      }),
    });

    const data = await upstream.text();
    res.status(upstream.status).setHeader('Content-Type', 'application/json').send(data);
  } catch (e) {
    res.status(500).json({ error: 'Proxy error: ' + (e && e.message ? e.message : String(e)) });
  }
};

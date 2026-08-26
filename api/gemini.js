// Vercel Serverless Function: proxies chat requests to Google Gemini using the site
// owner's own server-side API key (GEMINI_API_KEY env var), so visitors can try the
// app without entering their own key. This key is NEVER exposed to the client.
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
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      res.status(500).json({ error: 'Server is missing GEMINI_API_KEY' });
      return;
    }

    let body = req.body;
    if (!body || typeof body === 'string') {
      body = JSON.parse(body || '{}');
    }
    const { contents, systemInstruction, model, token, guestId } = body;
    if (!contents) {
      res.status(400).json({ error: 'Missing contents' });
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

    const DEPRECATED_GEMINI = new Set(['gemini-2.0-flash', 'gemini-1.5-flash', 'gemini-1.5-pro', 'gemini-pro']);
    const useModel = (!model || DEPRECATED_GEMINI.has(String(model).trim().toLowerCase())) ? 'gemini-flash-latest' : model;
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${useModel}:generateContent?key=${apiKey}`;
    const reqBody = { contents };
    if (systemInstruction) reqBody.systemInstruction = systemInstruction;

    const callGemini = () => fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(reqBody),
    });

    let upstream = await callGemini();
    // Gemini's free tier throws transient 503 "high demand" errors; one short
    // retry resolves most of them instead of surfacing an error to the user.
    if (upstream.status === 503 || upstream.status === 529) {
      await new Promise((r) => setTimeout(r, 1200));
      upstream = await callGemini();
    }

    const data = await upstream.text();
    res.status(upstream.status).setHeader('Content-Type', 'application/json').send(data);
  } catch (e) {
    res.status(500).json({ error: 'Proxy error: ' + (e && e.message ? e.message : String(e)) });
  }
};

// Vercel Serverless Function: proxies chat requests to Groq using the site owner's
// own server-side API key (GROQ_API_KEY env var), so visitors can try the app
// without entering their own key. This key is NEVER exposed to the client.
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
    const apiKey = process.env.GROQ_API_KEY;
    if (!apiKey) {
      res.status(500).json({ error: 'Server is missing GROQ_API_KEY' });
      return;
    }

    let body = req.body;
    if (!body || typeof body === 'string') {
      body = JSON.parse(body || '{}');
    }
    const { messages, model, token, guestId } = body;
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

    const callGroq = (useModel) => fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + apiKey,
      },
      body: JSON.stringify({
        model: useModel,
        messages,
        temperature: 0.7,
      }),
    });

    let upstream = await callGroq(model || 'llama-3.3-70b-versatile');
    let data = await upstream.text();

    // Groq decommissions models over time (model_not_found 404). Instead of
    // failing, auto-discover a currently-available chat model and retry once.
    if (upstream.status === 404 && /model_not_found|does not exist/i.test(data)) {
      try {
        const listRes = await fetch('https://api.groq.com/openai/v1/models', {
          headers: { Authorization: 'Bearer ' + apiKey },
        });
        if (listRes.ok) {
          const list = await listRes.json();
          const ids = ((list && list.data) || []).map((m) => m.id)
            .filter((id) => !/whisper|tts|guard|embed/i.test(id));
          const fallback =
            ids.find((id) => /llama.*versatile/i.test(id)) ||
            ids.find((id) => /llama.*instant/i.test(id)) ||
            ids.find((id) => /llama/i.test(id)) ||
            ids.find((id) => /qwen|mixtral|gemma|deepseek|gpt/i.test(id)) ||
            ids[0];
          if (fallback) {
            upstream = await callGroq(fallback);
            data = await upstream.text();
          }
        }
      } catch (e) {
        // keep the original 404 response
      }
    }

    res.status(upstream.status).setHeader('Content-Type', 'application/json').send(data);
  } catch (e) {
    res.status(500).json({ error: 'Proxy error: ' + (e && e.message ? e.message : String(e)) });
  }
};

// Vercel Serverless Function: proxies chat requests to OpenAI using the site owner's
// own server-side API key (OPENAI_API_KEY env var), so visitors can try the app
// without entering their own key. This key is NEVER exposed to the client.
const { checkAndConsume, rejectUsage } = require('./_usage');

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
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      res.status(500).json({ error: 'Server is missing OPENAI_API_KEY' });
      return;
    }

    let body = req.body;
    if (!body || typeof body === 'string') {
      body = JSON.parse(body || '{}');
    }
    const { messages, model, token } = body;
    if (!messages) {
      res.status(400).json({ error: 'Missing messages' });
      return;
    }

    const usage = await checkAndConsume(token, req, body.client === 'taryam-ext' ? 'ext' : 'chat');
    if (!usage.allowed) {
      rejectUsage(res, usage);
      return;
    }

    const upstream = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + apiKey,
      },
      body: JSON.stringify({
        model: model || 'gpt-4o-mini',
        messages,
        // Reasoning models (o1/o3/o4, gpt-5) reject any temperature but the default.
        ...(/^(o\d|gpt-5)/i.test(String(model || '')) ? {} : { temperature: 0.7 }),
      }),
    });

    const data = await upstream.text();
    res.status(upstream.status).setHeader('Content-Type', 'application/json').send(data);
  } catch (e) {
    res.status(500).json({ error: 'Proxy error: ' + (e && e.message ? e.message : String(e)) });
  }
};

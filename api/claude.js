// Vercel Serverless Function: proxies chat requests to Anthropic Claude using the site
// owner's own server-side API key (ANTHROPIC_API_KEY env var), so visitors can try the
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
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      res.status(500).json({ error: 'Server is missing ANTHROPIC_API_KEY' });
      return;
    }

    let body = req.body;
    if (!body || typeof body === 'string') {
      body = JSON.parse(body || '{}');
    }
    const { messages, model, system, token, guestId } = body;
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

    let useModel = model || 'claude-3-5-sonnet-latest';

    const doRequest = (m) => fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: m,
        max_tokens: 4096,
        system: system || undefined,
        messages,
      }),
    });

    let upstream = await doRequest(useModel);
    if (!upstream.ok && upstream.status === 404) {
      const errTextFirst = await upstream.text();
      if (/model/i.test(errTextFirst) && /not_found/i.test(errTextFirst)) {
        const listRes = await fetch('https://api.anthropic.com/v1/models?limit=1000', {
          headers: {
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
          },
        });
        if (listRes.ok) {
          const listData = await listRes.json();
          const ids = (listData.data || []).map((mm) => mm.id);
          const preferred = ids.find((id) => /sonnet/i.test(id)) || ids.find((id) => /haiku/i.test(id)) || ids[0];
          if (preferred) {
            upstream = await doRequest(preferred);
          } else {
            res.status(404).setHeader('Content-Type', 'application/json').send(errTextFirst);
            return;
          }
        } else {
          res.status(404).setHeader('Content-Type', 'application/json').send(errTextFirst);
          return;
        }
      } else {
        res.status(404).setHeader('Content-Type', 'application/json').send(errTextFirst);
        return;
      }
    }

    const data = await upstream.text();
    res.status(upstream.status).setHeader('Content-Type', 'application/json').send(data);
  } catch (e) {
    res.status(500).json({ error: 'Proxy error: ' + (e && e.message ? e.message : String(e)) });
  }
};

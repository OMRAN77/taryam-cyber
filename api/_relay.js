// Shared upstream relay for the OpenAI-compatible chat proxies (DeepSeek, OpenAI,
// Groq, Mistral, OpenRouter, Cohere).
//
// - Model fallback: providers retire model ids over time. When the upstream answers
//   "model not found", try the next candidate instead of failing the user's message,
//   and as a last resort ask the provider which models exist (optional `discover`).
// - Streaming: when the browser asks for `stream` and the provider answers with
//   Server-Sent Events, pipe them through as they arrive so tokens show up live.
//   Otherwise the upstream JSON is returned unchanged, exactly as before.
//
// Quota is checked by each proxy before calling this, so a fallback retry never
// costs the user an extra message.

const MODEL_NOT_FOUND = /model_not_found|model.{0,60}(not.?found|does not exist|decommissioned|deprecated|is invalid|unknown)|(invalid|unknown|no such|unsupported) model/i;

function isModelNotFound(status, text) {
  return (status === 404 || status === 400) && MODEL_NOT_FOUND.test(String(text || ''));
}

// The model id comes from the browser; only echo it back when it is header-safe.
function setModelHeader(res, model) {
  if (/^[\w.\-/:@]{1,120}$/.test(String(model || ''))) res.setHeader('X-Taryam-Model', model);
}

function uniq(list) {
  const seen = new Set();
  return list.filter((m) => m && !seen.has(m) && seen.add(m));
}

// opts:
//   url        upstream chat-completions URL
//   headers    upstream request headers (auth etc.)
//   models     candidate model ids, tried in order (falsy/duplicates dropped)
//   body(m)    builds the upstream JSON body for model m
//   stream     the browser asked for a streamed answer
//   discover() optional: resolves to one more model id to try after all candidates fail
async function relayChat(res, opts) {
  const candidates = uniq(opts.models || []);
  let discovered = false;
  let last = null;

  for (let i = 0; i < candidates.length; i++) {
    const model = candidates[i];
    const payload = opts.body(model);
    if (opts.stream) payload.stream = true;
    const upstream = await fetch(opts.url, {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {}),
      body: JSON.stringify(payload),
    });

    if (upstream.ok) {
      const type = upstream.headers.get('content-type') || '';
      if (opts.stream && upstream.body && /text\/event-stream/i.test(type)) {
        res.statusCode = 200;
        res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache, no-transform');
        res.setHeader('X-Accel-Buffering', 'no');
        setModelHeader(res, model);
        for await (const chunk of upstream.body) res.write(chunk);
        res.end();
        return { model, streamed: true };
      }
      const text = await upstream.text();
      res.status(200).setHeader('Content-Type', 'application/json');
      setModelHeader(res, model);
      res.send(text);
      return { model, streamed: false };
    }

    const text = await upstream.text();
    last = { status: upstream.status, text };
    if (!isModelNotFound(upstream.status, text)) break;

    // All fixed candidates are gone: ask the provider once for a live model.
    if (i === candidates.length - 1 && !discovered && typeof opts.discover === 'function') {
      discovered = true;
      try {
        const extra = await opts.discover();
        if (extra && !candidates.includes(extra)) candidates.push(extra);
      } catch (e) {
        // keep the last upstream error
      }
    }
  }

  if (!last) {
    res.status(500).json({ error: 'No model configured for this provider' });
    return { model: null, streamed: false };
  }
  res.status(last.status).setHeader('Content-Type', 'application/json');
  res.send(last.text);
  return { model: null, streamed: false };
}

// Fetches GET {base}/models and returns the first id matching the preference
// regexes (in order), skipping non-chat models. Used as a `discover` callback.
async function discoverModel(modelsUrl, headers, prefer) {
  const r = await fetch(modelsUrl, { headers });
  if (!r.ok) return null;
  const data = await r.json();
  const ids = ((data && data.data) || []).map((m) => m && m.id).filter(Boolean)
    .filter((id) => !/whisper|tts|transcribe|audio|realtime|image|embed|guard|moderation|search|rerank/i.test(id));
  for (const re of prefer || []) {
    const hit = ids.find((id) => re.test(id));
    if (hit) return hit;
  }
  return ids[0] || null;
}

// Reasoning-style OpenAI models (o-series, gpt-5 and later) reject a non-default
// temperature. Accepts bare ids and OpenRouter-style "openai/gpt-5.6".
function rejectsTemperature(model) {
  return /(^|\/)(o\d|gpt-([5-9]|\d{2}))/i.test(String(model || ''));
}

function parseBody(req) {
  let body = req.body;
  if (!body || typeof body === 'string') body = JSON.parse(body || '{}');
  return body;
}

// Builds a complete Vercel handler for one OpenAI-compatible provider.
// cfg:
//   envKey          env var holding the owner's API key
//   url             chat-completions endpoint
//   models(model)   candidate ids for the requested model (first = requested)
//   body(m, msgs)   upstream JSON body for model m
//   stream          whether this provider may stream SSE back (default true)
//   extBucket       count requests from the TARYAM extension in their own quota bucket
//   prepare(model)  optional: map a requested id to another (e.g. retired -> current)
//   discover(key)   optional: resolves a live model id when every candidate is gone
function chatProxy(cfg) {
  const { checkAndConsume, rejectUsage } = require('./_usage');
  return async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') { res.status(204).end(); return; }
    if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

    try {
      const apiKey = process.env[cfg.envKey];
      if (!apiKey) { res.status(500).json({ error: 'Server is missing ' + cfg.envKey }); return; }

      const body = parseBody(req);
      const { messages, token } = body;
      let model = body.model;
      if (cfg.prepare) model = cfg.prepare(model);
      if (!messages) { res.status(400).json({ error: 'Missing messages' }); return; }

      const bucket = cfg.extBucket && body.client === 'taryam-ext' ? 'ext' : 'chat';
      const usage = await checkAndConsume(token, req, bucket);
      if (!usage.allowed) { rejectUsage(res, usage); return; }

      await relayChat(res, {
        url: cfg.url,
        headers: { Authorization: 'Bearer ' + apiKey },
        models: cfg.models(model),
        body: (m) => cfg.body(m, messages),
        stream: cfg.stream !== false && body.stream === true,
        discover: cfg.discover ? () => cfg.discover(apiKey) : undefined,
      });
    } catch (e) {
      if (res.headersSent) { try { res.end(); } catch (e2) { /* already closed */ } return; }
      res.status(500).json({ error: 'Proxy error: ' + (e && e.message ? e.message : String(e)) });
    }
  };
}

module.exports = { relayChat, discoverModel, isModelNotFound, rejectsTemperature, parseBody, chatProxy };

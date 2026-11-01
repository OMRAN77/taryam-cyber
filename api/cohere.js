// Vercel Serverless Function: proxies chat requests to Cohere using the site
// owner's own server-side API key (COHERE_API_KEY env var), so visitors can try
// the app without entering their own key. This key is NEVER exposed to the client.
// Quota and model fallback are handled by ./_relay.
const { chatProxy } = require('./_relay');

// Deprecated/retired Cohere model names get silently upgraded server-side,
// so stale client caches (old JS, old localStorage) never hit a hard error.
const DEPRECATED_MODELS = new Set(['command-r-plus', 'command-r', 'command-r-plus-08-2024', 'command-r-08-2024', 'command']);
const CURRENT = 'command-a-plus-05-2026';

module.exports = chatProxy({
  envKey: 'COHERE_API_KEY',
  url: 'https://api.cohere.com/compatibility/v1/chat/completions',
  prepare: (model) => (!model || DEPRECATED_MODELS.has(String(model).trim().toLowerCase()) ? CURRENT : model),
  models: (model) => [model, CURRENT, 'command-a-03-2025'],
  body: (m, messages) => ({ model: m, messages, temperature: 0.7 }),
  // The compatibility endpoint's stream format isn't verified here; answer in one piece.
  stream: false,
});

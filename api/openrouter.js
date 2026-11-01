// Vercel Serverless Function: proxies chat requests to OpenRouter using the site
// owner's own server-side API key (OPENROUTER_API_KEY env var), so visitors can try
// the app without entering their own key. This key is NEVER exposed to the client.
// Quota, streaming and model fallback are handled by ./_relay.
const { chatProxy, rejectsTemperature } = require('./_relay');

module.exports = chatProxy({
  envKey: 'OPENROUTER_API_KEY',
  url: 'https://openrouter.ai/api/v1/chat/completions',
  // openrouter/auto lets OpenRouter route to any live model as the last resort.
  models: (model) => [model, 'openai/gpt-5.6', 'openrouter/auto'],
  body: (m, messages) => ({ model: m, messages, ...(rejectsTemperature(m) ? {} : { temperature: 0.7 }) }),
});

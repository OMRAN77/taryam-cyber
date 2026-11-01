// Vercel Serverless Function: proxies chat requests to Mistral AI using the site
// owner's own server-side API key (MISTRAL_API_KEY env var), so visitors can try
// the app without entering their own key. This key is NEVER exposed to the client.
// Quota, streaming and model fallback are handled by ./_relay.
const { chatProxy } = require('./_relay');

module.exports = chatProxy({
  envKey: 'MISTRAL_API_KEY',
  url: 'https://api.mistral.ai/v1/chat/completions',
  models: (model) => [model, 'mistral-large-latest', 'mistral-medium-latest', 'mistral-small-latest'],
  body: (m, messages) => ({ model: m, messages, temperature: 0.7 }),
});

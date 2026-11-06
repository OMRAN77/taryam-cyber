// Vercel Serverless Function: proxies chat requests to OpenAI using the site owner's
// own server-side API key (OPENAI_API_KEY env var), so visitors can try the app
// without entering their own key. This key is NEVER exposed to the client.
// Quota, streaming and model fallback are handled by ./_relay.
const { chatProxy, discoverModel, rejectsTemperature } = require('./_relay');

module.exports = chatProxy({
  envKey: 'OPENAI_API_KEY',
  url: 'https://api.openai.com/v1/chat/completions',
  models: (model) => [model, 'gpt-5.6', 'gpt-5.6-luna', 'gpt-4.1-mini', 'gpt-4o-mini'],
  // Reasoning models (o-series, gpt-5 and later) reject any temperature but the default.
  body: (m, messages) => ({ model: m, messages, ...(rejectsTemperature(m) ? {} : { temperature: 0.7 }) }),
  discover: (key) => discoverModel('https://api.openai.com/v1/models', { Authorization: 'Bearer ' + key },
    [/^gpt-5\.6$/, /^gpt-5\.6-(sol|terra|luna)$/, /^gpt-6/, /^gpt-5/, /^gpt-4\.1/, /^gpt-4o/]),
});

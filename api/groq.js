// Vercel Serverless Function: proxies chat requests to Groq using the site owner's
// own server-side API key (GROQ_API_KEY env var), so visitors can try the app
// without entering their own key. This key is NEVER exposed to the client.
// Quota, streaming and model fallback are handled by ./_relay.
const { chatProxy, discoverModel } = require('./_relay');

module.exports = chatProxy({
  envKey: 'GROQ_API_KEY',
  url: 'https://api.groq.com/openai/v1/chat/completions',
  models: (model) => [model || 'llama-3.3-70b-versatile', 'openai/gpt-oss-120b', 'llama-3.3-70b-versatile'],
  body: (m, messages) => ({ model: m, messages, temperature: 0.7 }),
  // Groq decommissions models over time: ask which chat models exist right now.
  discover: (key) => discoverModel('https://api.groq.com/openai/v1/models', { Authorization: 'Bearer ' + key },
    [/llama.*versatile/i, /llama.*instant/i, /llama/i, /qwen|mixtral|gemma|deepseek|gpt/i]),
});

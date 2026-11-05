// Vercel Serverless Function: proxies chat requests to DeepSeek using the site
// owner's own server-side API key (DEEPSEEK_API_KEY env var), so visitors can try
// the app without entering their own key. This key is NEVER exposed to the client.
// Quota, streaming and model fallback are handled by ./_relay.
const { chatProxy } = require('./_relay');

module.exports = chatProxy({
  envKey: 'DEEPSEEK_API_KEY',
  url: 'https://api.deepseek.com/chat/completions',
  models: (model) => [model, 'deepseek-chat'],
  // 8192 is deepseek-chat's output cap; the 4096 default cut long explanations short.
  body: (m, messages) => ({ model: m, messages, temperature: 0.7, max_tokens: 8192 }),
});

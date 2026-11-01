// Browser tests for what each provider is sent when a conversation has images.
// - An image sent without text used to go out with an empty text block, which Claude
//   rejects ("text content blocks must be non-empty"); the turn stayed in history, so
//   Claude kept failing for the rest of that conversation. Gemini and OpenAI-vision got
//   the same empty text part.
// - When localStorage fills up, older images are purged (their data emptied) but were
//   still sent: Claude got an image with no data, OpenAI/OpenRouter an empty image_url.
const test = require('node:test');
const assert = require('node:assert');
const { startServer } = require('../helpers/dev-server');

let chromium;
try {
  ({ chromium } = require('playwright'));
} catch (e) {
  throw new Error('These tests need Playwright: npm install --no-save playwright && npx playwright install chromium');
}

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const ALL = ['claude', 'cohere', 'deepseek', 'gemini', 'groq', 'mistral', 'openai', 'openrouter'];
const VISION = ['claude', 'gemini', 'openai', 'openrouter'];

const json = (route, body) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
const answer = (route, key) => {
  if (key === 'claude') return json(route, { content: [{ type: 'text', text: 'جواب ' + key }] });
  if (key === 'gemini') return json(route, { candidates: [{ content: { parts: [{ text: 'جواب ' + key }] } }] });
  return json(route, { choices: [{ message: { content: 'جواب ' + key } }] });
};

// Ask all providers (no merge), every request recorded with the round it belongs to.
async function open(browser, server, storage = {}) {
  const page = await browser.newPage();
  page.setDefaultTimeout(30000);
  await page.addInitScript((s) => {
    localStorage.setItem('aiapp_askall', 'true');
    localStorage.setItem('aiapp_merge', 'false');
    localStorage.setItem('aiapp_askall_timeout_ms', '5000');
    for (const [k, v] of Object.entries(s)) localStorage.setItem(k, v);
  }, storage);
  const round = { n: 1, reqs: [] };
  await page.route('**/api/*', (route) => {
    const key = new URL(route.request().url()).pathname.split('/').pop();
    if (key === 'auth') return json(route, {});
    round.reqs.push({ round: round.n, key, body: JSON.parse(route.request().postData() || '{}') });
    return answer(route, key);
  });
  await page.goto(server.url + '/', { waitUntil: 'load' });
  await page.click('#btnGuestMode');
  return { page, round };
}

async function send(page) {
  await page.click('#btnSend');
  await page.waitForFunction(() => !document.querySelector('#btnSend').disabled);
}

// The conversation turns of one request, in that provider's own format.
const turnsOf = (key, body) => (key === 'gemini' ? body.contents : body.messages.filter((m) => m.role !== 'system'));

// Every empty piece a provider would reject: blank text, an image without data.
function emptyBits(key, body) {
  const bad = [];
  const blank = (s) => typeof s !== 'string' || !s.trim();
  turnsOf(key, body).forEach((m, i) => {
    if (key === 'gemini') {
      if (!m.parts.length) bad.push(i + ': no parts');
      m.parts.forEach((p, j) => {
        if ('text' in p && blank(p.text)) bad.push(i + '.' + j + ': empty text part');
        if (p.inline_data && blank(p.inline_data.data)) bad.push(i + '.' + j + ': image without data');
      });
      return;
    }
    if (typeof m.content === 'string') { if (blank(m.content)) bad.push(i + ': empty content'); return; }
    if (!m.content.length) bad.push(i + ': no blocks');
    m.content.forEach((c, j) => {
      if (c.type === 'text' && blank(c.text)) bad.push(i + '.' + j + ': empty text block');
      if (c.type === 'image' && blank(c.source && c.source.data)) bad.push(i + '.' + j + ': image without data');
      if (c.type === 'image_url' && !/^data:image\/[\w+.-]+;base64,./.test((c.image_url && c.image_url.url) || '')) bad.push(i + '.' + j + ': empty image_url');
    });
  });
  return bad;
}

function imageCount(key, body) {
  return turnsOf(key, body).reduce((n, m) => {
    if (key === 'gemini') return n + m.parts.filter((p) => p.inline_data).length;
    return n + (Array.isArray(m.content) ? m.content.filter((c) => c.type === 'image' || c.type === 'image_url').length : 0);
  }, 0);
}

function roles(key, body) {
  return turnsOf(key, body).map((m) => (m.role === 'model' ? 'assistant' : m.role));
}

test('an image sent alone reaches every provider without empty text, also in the next turn', async (t) => {
  const server = await startServer();
  const browser = await chromium.launch();
  t.after(async () => { await browser.close(); await server.close(); });
  const { page, round } = await open(browser, server);

  await page.setInputFiles('#attachInput', { name: 'shot.png', mimeType: 'image/png', buffer: PNG });
  await page.waitForSelector('.attach-chip');
  await send(page);
  round.n = 2;
  await page.fill('#prompt', 'ما في الصورة؟');
  await send(page);

  for (const n of [1, 2]) {
    const reqs = round.reqs.filter((r) => r.round === n);
    assert.deepStrictEqual(reqs.map((r) => r.key).sort(), ALL, 'round ' + n);
    for (const r of reqs) {
      assert.deepStrictEqual(emptyBits(r.key, r.body), [], 'round ' + n + ' ' + r.key + ': ' + JSON.stringify(turnsOf(r.key, r.body)).slice(0, 300));
      assert.deepStrictEqual(roles(r.key, r.body), ['user'], 'round ' + n + ' ' + r.key + ': one user turn');
      assert.strictEqual(imageCount(r.key, r.body), VISION.includes(r.key) ? 1 : 0, 'round ' + n + ' ' + r.key + ' images');
    }
  }
  const claude2 = round.reqs.find((r) => r.round === 2 && r.key === 'claude').body.messages[0].content;
  assert.deepStrictEqual(claude2.map((c) => c.type), ['text', 'image']);
  assert.strictEqual(claude2[0].text, 'ما في الصورة؟');
  const deepseek1 = round.reqs.find((r) => r.round === 1 && r.key === 'deepseek').body.messages;
  assert.strictEqual(deepseek1[deepseek1.length - 1].content, '[صورة]', 'text-only providers get a placeholder, not an empty message');
});

test('purged images are left out instead of being sent with empty data', async (t) => {
  const server = await startServer();
  const browser = await chromium.launch();
  t.after(async () => { await browser.close(); await server.close(); });
  // As saved after purgeOldImages() ran: the entries stay, their data is gone.
  const purged = (name) => ({ attachments: [{ name, isImage: true, dataUrl: '', purged: true }], apiImages: [{ name, mime: 'image/png', dataUrl: '' }] });
  const project = {
    id: 'p_1', title: 'old', code: '',
    messages: [
      { role: 'user', content: 'انظر', apiText: 'انظر', ...purged('a.png') },
      { role: 'assistant', content: 'أرى صورة', providerKey: 'deepseek', providerLabel: 'DeepSeek' },
      { role: 'user', content: '📎', apiText: '', ...purged('b.png') },
      { role: 'assistant', content: 'وصلت', providerKey: 'deepseek', providerLabel: 'DeepSeek' },
    ],
  };
  const { page, round } = await open(browser, server, { aiapp_projects: JSON.stringify([project]), aiapp_askall: 'false', aiapp_provider: 'claude' });

  // Single provider (Claude), then Ask all for the vision ones.
  await page.fill('#prompt', 'والآن؟');
  await send(page);
  await page.evaluate(() => { const c = document.querySelector('#chkAskAll'); c.checked = true; c.dispatchEvent(new Event('change')); });
  round.n = 2;
  await page.fill('#prompt', 'وماذا بعد؟');
  await send(page);

  const claude = round.reqs.find((r) => r.round === 1 && r.key === 'claude');
  assert.ok(claude, 'Claude was asked');
  const reqs = [claude, ...round.reqs.filter((r) => r.round === 2 && r.key !== 'claude')];
  for (const k of ['openai', 'openrouter', 'gemini']) assert.ok(reqs.some((r) => r.key === k), k + ' was asked');
  for (const r of reqs) {
    assert.deepStrictEqual(emptyBits(r.key, r.body), [], r.key + ': ' + JSON.stringify(turnsOf(r.key, r.body)).slice(0, 300));
    assert.strictEqual(imageCount(r.key, r.body), 0, r.key + ' sent no purged image');
    const rs = roles(r.key, r.body);
    for (let i = 1; i < rs.length; i++) assert.notStrictEqual(rs[i], rs[i - 1], r.key + ' roles alternate: ' + rs);
  }
  assert.deepStrictEqual(claude.body.messages.map((m) => [m.role, m.content]), [
    ['user', 'انظر'], ['assistant', 'أرى صورة\n\nوصلت'], ['user', 'والآن؟'],
  ]);
});

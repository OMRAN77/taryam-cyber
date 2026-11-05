// Browser tests for "Ask all providers". Each provider endpoint is mocked:
// - every failure shows its real reason (quota, missing server key, timeout) instead of
//   a bare "did not respond";
// - a provider that never answers is cut off by the per-provider timeout, so the round ends;
// - Perplexity (no site proxy, no user key) is not called and not counted;
// - when all providers fail for the same reason, one message is shown instead of eight.
const test = require('node:test');
const assert = require('node:assert');
const { startServer } = require('../helpers/dev-server');

let chromium;
try {
  ({ chromium } = require('playwright'));
} catch (e) {
  throw new Error('These tests need Playwright: npm install --no-save playwright && npx playwright install chromium');
}

const OPENAI_STYLE = ['deepseek', 'openai', 'groq', 'openrouter', 'mistral', 'cohere'];
const json = (route, status, body) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
const answer = (route, key) => {
  if (key === 'claude') return json(route, 200, { content: [{ type: 'text', text: 'جواب ' + key }] });
  if (key === 'gemini') return json(route, 200, { candidates: [{ content: { parts: [{ text: 'جواب ' + key } ] } }] });
  return json(route, 200, { choices: [{ message: { content: 'جواب ' + key } }] });
};

async function open(browser, server, { merge = false } = {}) {
  const page = await browser.newPage();
  page.setDefaultTimeout(30000);
  await page.addInitScript(([m]) => {
    localStorage.setItem('aiapp_askall', 'true');
    localStorage.setItem('aiapp_merge', m ? 'true' : 'false');
    localStorage.setItem('aiapp_askall_timeout_ms', '1500');
  }, [merge]);
  const called = new Set();
  const external = [];
  page.on('request', (r) => { if (/perplexity\.ai/.test(r.url())) external.push(r.url()); });
  return { page, called, external };
}

async function send(page, server, text) {
  await page.goto(server.url + '/', { waitUntil: 'load' });
  await page.click('#btnGuestMode');
  await page.fill('#prompt', text);
  await page.click('#btnSend');
  await page.waitForFunction(() => !document.querySelector('#btnSend').disabled);
  return page.evaluate(() => [...document.querySelectorAll('#messages .msg.assistant')].map((m) => m.textContent));
}

test('each failing provider shows why, a stuck one times out, and the round finishes', async (t) => {
  const server = await startServer();
  const browser = await chromium.launch();
  t.after(async () => { await browser.close(); await server.close(); });
  const { page, called, external } = await open(browser, server);

  await page.route('**/api/*', (route) => {
    const key = new URL(route.request().url()).pathname.split('/').pop();
    called.add(key);
    if (key === 'deepseek') return json(route, 402, { error: 'وصلت للحد اليومي المجاني (20 رسالة) لهذا المزوّد.' });
    if (key === 'openai') return json(route, 500, { error: 'Server is missing OPENAI_API_KEY' });
    if (key === 'claude') return; // never answers
    if (key === 'auth') return json(route, 200, {});
    return answer(route, key);
  });

  const started = Date.now();
  const msgs = await send(page, server, 'سؤال');
  const all = msgs.join('\n---\n');
  assert.ok(Date.now() - started < 20000, 'the round did not wait for the stuck provider');

  assert.match(all, /DeepSeek[\s\S]*وصلت للحد اليومي/, 'quota reason shown');
  assert.match(all, /OpenAI[\s\S]*OPENAI_API_KEY غير مضبوط/, 'missing server key explained');
  assert.match(all, /Claude[\s\S]*انتهت المهلة/, 'stuck provider timed out');
  for (const k of ['gemini', 'groq', 'mistral', 'cohere', 'openrouter']) assert.match(all, new RegExp('جواب ' + k), k + ' answered');
  assert.doesNotMatch(all, /لم يستجب/, 'no bare "did not respond"');

  assert.deepStrictEqual([...called].filter((k) => k !== 'auth').sort(), ['claude', 'cohere', 'deepseek', 'gemini', 'groq', 'mistral', 'openai', 'openrouter']);
  assert.deepStrictEqual(external, [], 'Perplexity is not called without a user key');
});

test('the same failure everywhere is shown once, with the provider names', async (t) => {
  const server = await startServer();
  const browser = await chromium.launch();
  t.after(async () => { await browser.close(); await server.close(); });
  const { page } = await open(browser, server);
  await page.route('**/api/*', (route) => json(route, 402, { error: 'وصلت للحد اليومي المجاني (20 رسالة) لهذا المزوّد.' }));

  const msgs = await send(page, server, 'سؤال');
  const failures = msgs.filter((m) => /وصلت للحد اليومي/.test(m));
  assert.strictEqual(failures.length, 1, 'one message, not eight: ' + JSON.stringify(msgs));
  for (const name of ['DeepSeek', 'OpenAI', 'Claude', 'Gemini', 'Groq', 'Mistral', 'Cohere', 'OpenRouter']) {
    assert.match(failures[0], new RegExp(name), name + ' listed');
  }
});

test('smart merge lists each failed provider with its reason', async (t) => {
  const server = await startServer();
  const browser = await chromium.launch();
  t.after(async () => { await browser.close(); await server.close(); });
  const { page } = await open(browser, server, { merge: true });
  await page.route('**/api/*', (route) => {
    const key = new URL(route.request().url()).pathname.split('/').pop();
    if (key === 'deepseek') return answer(route, key);
    if (key === 'openai') return json(route, 500, { error: 'Server is missing OPENAI_API_KEY' });
    return json(route, 402, { error: 'وصلت للحد اليومي المجاني (20 رسالة) لهذا المزوّد.' });
  });

  const msgs = await send(page, server, 'سؤال');
  const merged = msgs[msgs.length - 1];
  assert.match(merged, /جواب deepseek/);
  assert.match(merged, /OpenAI: .*OPENAI_API_KEY غير مضبوط/);
  assert.match(merged, /Claude: .*وصلت للحد اليومي/);
});

// ---- What the next round sends back as history ----

// A follow-up in the same conversation (no reload).
async function sendMore(page, text) {
  await page.fill('#prompt', text);
  await page.click('#btnSend');
  await page.waitForFunction(() => !document.querySelector('#btnSend').disabled);
}

// Each provider's turns after the system prompt, as [role, text] in that provider's format.
function history(key, body) {
  const text = (c) => (typeof c === 'string' ? c : c.filter((p) => p.type === 'text').map((p) => p.text).join('\n'));
  if (key === 'gemini') return body.contents.map((c) => [c.role === 'model' ? 'assistant' : 'user', c.parts.map((p) => p.text || '').join('\n')]);
  return body.messages.filter((m) => m.role !== 'system').map((m) => [m.role, text(m.content)]);
}

// Records every provider request of the current round (round.n is bumped by the test).
async function recordRounds(page, respond) {
  const round = { n: 1, reqs: [] };
  await page.route('**/api/*', (route) => {
    const key = new URL(route.request().url()).pathname.split('/').pop();
    if (key === 'auth') return json(route, 200, {});
    round.reqs.push({ round: round.n, key, body: JSON.parse(route.request().postData() || '{}') });
    return respond(route, key);
  });
  return round;
}

test('merge notes and failure reasons are shown but never sent back as the answer', async (t) => {
  const server = await startServer();
  const browser = await chromium.launch();
  t.after(async () => { await browser.close(); await server.close(); });
  const { page } = await open(browser, server, { merge: true });
  const round = await recordRounds(page, (route, key) => {
    if (key === 'deepseek' || key === 'groq') return answer(route, key);
    if (key === 'openai') return json(route, 500, { error: 'Server is missing OPENAI_API_KEY' });
    return json(route, 402, { error: 'وصلت للحد اليومي المجاني (20 رسالة) لهذا المزوّد.' });
  });

  const msgs = await send(page, server, 'سؤال 1');
  assert.match(msgs[msgs.length - 1], /دُمِجت إجابات[\s\S]*OPENAI_API_KEY غير مضبوط/, 'the notes are still shown');
  round.n = 2;
  await sendMore(page, 'سؤال 2');

  const second = round.reqs.filter((r) => r.round === 2);
  assert.ok(second.length >= 8, 'round 2 asked every provider again (and merged)');
  for (const r of second) {
    const h = history(r.key, r.body);
    const prior = h.find(([role]) => role === 'assistant');
    assert.ok(prior, r.key + ' got the merged answer as history');
    assert.strictEqual(prior[1], 'جواب deepseek', r.key + ': only the answer, not the notes');
    assert.doesNotMatch(JSON.stringify(r.body.messages || r.body.contents), /⚠️|دُمِجت إجابات|OPENAI_API_KEY/, r.key);
  }
});

test('history alternates roles: user turns left next to each other are joined for every provider', async (t) => {
  const server = await startServer();
  const browser = await chromium.launch();
  t.after(async () => { await browser.close(); await server.close(); });
  const { page } = await open(browser, server);
  const round = await recordRounds(page, (route, key) => answer(route, key));

  await send(page, server, 'سؤال 1');
  round.n = 2;
  await sendMore(page, 'سؤال 2');

  const second = round.reqs.filter((r) => r.round === 2);
  assert.deepStrictEqual(second.map((r) => r.key).sort(), ['claude', 'cohere', 'deepseek', 'gemini', 'groq', 'mistral', 'openai', 'openrouter']);
  for (const r of second) {
    const h = history(r.key, r.body);
    for (let i = 1; i < h.length; i++) assert.notStrictEqual(h[i][0], h[i - 1][0], r.key + ' sent two ' + h[i][0] + ' turns in a row: ' + JSON.stringify(h));
    assert.deepStrictEqual(h, [['user', 'سؤال 1\n\nسؤال 2']], r.key);
  }
});

test('failure bubbles offer no "continue with this provider"; tapping the chosen one again asks everyone', async (t) => {
  const server = await startServer();
  const browser = await chromium.launch();
  t.after(async () => { await browser.close(); await server.close(); });
  const { page } = await open(browser, server);
  const round = await recordRounds(page, (route, key) => {
    if (key === 'deepseek') return json(route, 402, { error: 'وصلت للحد اليومي المجاني (20 رسالة) لهذا المزوّد.' });
    if (key === 'openai') return json(route, 500, { error: 'Server is missing OPENAI_API_KEY' });
    return answer(route, key);
  });
  const bubbles = () => page.evaluate(() => [...document.querySelectorAll('#messages .msg.assistant')].map((m) => {
    const wrap = m.parentElement;
    const choose = wrap.id === 'messages' ? null : [...wrap.children].find((c) => c.tagName === 'BUTTON');
    return { label: m.querySelector('.provider-tag')?.textContent, failed: m.classList.contains('failed'), choose: choose ? choose.textContent : null };
  }));

  await send(page, server, 'سؤال 1');
  const shown = await bubbles();
  const failures = shown.filter((b) => b.failed);
  assert.deepStrictEqual(failures.map((b) => b.label).sort(), ['DeepSeek', 'OpenAI']);
  for (const b of failures) assert.strictEqual(b.choose, null, b.label + ' failure has no choose button');
  for (const b of shown.filter((x) => !x.failed)) assert.strictEqual(b.choose, '○', b.label + ' answer can be chosen');

  const groq = async () => page.evaluate(() => {
    const m = [...document.querySelectorAll('#messages .msg.assistant')].find((x) => x.querySelector('.provider-tag')?.textContent === 'Groq');
    const b = [...m.parentElement.children].find((c) => c.tagName === 'BUTTON');
    b.click();
    return [...document.querySelectorAll('#messages .msg.assistant')].find((x) => x.querySelector('.provider-tag')?.textContent === 'Groq').parentElement.lastElementChild.textContent;
  });
  assert.strictEqual(await groq(), '✓', 'Groq chosen');
  assert.strictEqual(await groq(), '○', 'tapping it again unpins it');

  round.n = 2;
  await sendMore(page, 'سؤال 2');
  assert.ok(round.reqs.filter((r) => r.round === 2).length > 1, 'back to asking every provider');
});

// The cyber brain: every provider receives the defensive-security system prompt, and
// Smart merge sends the synthesizer a security-structured fuse prompt.
test('cyber brain: providers get the security system prompt; merge fuses with a security structure', async (t) => {
  const server = await startServer();
  const browser = await chromium.launch();
  t.after(async () => { await browser.close(); await server.close(); });
  const { page } = await open(browser, server, { merge: true });

  const bodies = [];
  await page.route('**/api/*', (route) => {
    const key = new URL(route.request().url()).pathname.split('/').pop();
    if (key === 'auth') return json(route, 200, {});
    bodies.push({ key, body: JSON.parse(route.request().postData() || '{}') });
    return answer(route, key);
  });

  await send(page, server, 'كيف أأمّن خادم SSH؟');

  // Every provider call carries a system message, and it names the defensive-security role.
  const sysOf = (b) => {
    if (b.key === 'gemini') return b.body.systemInstruction ? JSON.stringify(b.body.systemInstruction) : '';
    if (b.key === 'claude') return b.body.system || '';
    return (b.body.messages || []).filter((m) => m.role === 'system').map((m) => m.content).join('\n');
  };
  const providerCalls = bodies.filter((b) => ['deepseek', 'openai', 'claude', 'gemini', 'groq'].includes(b.key));
  assert.ok(providerCalls.length >= 2, 'several providers were called');
  for (const b of providerCalls) {
    const sys = sysOf(b);
    assert.match(sys, /أمن سيبراني|cybersecurity/i, `${b.key} got the security role`);
    assert.match(sys, /إذن|authoriz/i, `${b.key} kept the ethics guard`);
    assert.match(sys, /ATT&CK/, `${b.key} got the deep role (MITRE)`);
    assert.match(sys, /Sigma/i, `${b.key} got detection depth`);
  }

  // The synthesizer request (the one carrying the fuse prompt) asks for the security shape.
  const fuse = bodies.map((b) => (b.body.messages || []).map((m) => m.content).join('\n')).find((t2) => /Fusion Core|قواعد الدمج|Merging Rules/.test(t2));
  assert.ok(fuse, 'a fuse prompt was sent');
  assert.match(fuse, /الكشف|detection/i, 'the fuse prompt keeps the detection section');

  // Turning the brain off drops the role but keeps the ethics guard.
  await page.evaluate(() => localStorage.setItem('aiapp_cyberbrain', '0'));
  bodies.length = 0;
  await sendMore(page, 'سؤال عادي');
  const plain = bodies.filter((b) => b.key !== 'auth');
  assert.ok(plain.length >= 1);
  for (const b of plain) {
    const sys = sysOf(b);
    assert.doesNotMatch(sys, /مهندس أمن سيبراني دفاعي|defensive cybersecurity engineer/i, `${b.key} dropped the role when off`);
    assert.match(sys, /إذن|authoriz/i, `${b.key} kept the ethics guard when off`);
  }
});

test('cyber brain switch in Settings shows its state and saves it', async (t) => {
  const server = await startServer();
  const browser = await chromium.launch();
  t.after(async () => { await browser.close(); await server.close(); });
  const page = await browser.newPage();
  page.setDefaultTimeout(10000);
  await page.goto(server.url + '/');
  await page.click('#btnGuestMode');
  await page.click('#btnSettings');
  await page.click('#brainSection .head');
  assert.ok(await page.isChecked('#chkCyberBrain'), 'on by default');
  assert.match(await page.getAttribute('#chip-cyberbrain', 'class'), /\bon\b/, 'the switch shows on');
  await page.click('#chip-cyberbrain');
  assert.doesNotMatch(await page.getAttribute('#chip-cyberbrain', 'class'), /\bon\b/, 'the switch shows off');
  await page.click('#btnSaveSettings');
  assert.strictEqual(await page.evaluate(() => localStorage.getItem('aiapp_cyberbrain')), '0');
});

import test from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import { generate } from '../../scripts/make-site-core.mjs';
import { analyzeHtml, score } from '../../lab/core/site.js';

test('lab/core/site.js is the generated copy of api/_casino.js', () => {
  assert.strictEqual(fs.readFileSync(new URL('../../lab/core/site.js', import.meta.url), 'utf8'), generate(), 'run: node scripts/make-site-core.mjs');
});

test('a pasted page source is analysed in the browser the same way, and a blocked site is still judged by its name', () => {
  const html = `<html lang="ar"><head><title>كازينو دبي</title></head><body><h1>كازينو ومراهنات للاعبي الإمارات</h1>
  <p>موقع مرخّص. الإيداع USDT فقط. الدعم <a href="https://t.me/x">تلغرام</a>. بونص 100% welcome bonus بشرط رهان x40.</p>${'<p>شروط وأحكام العرض تنطبق على جميع اللاعبين. </p>'.repeat(10)}</body></html>`;
  const a = analyzeHtml(html, 'https://casino-dubai.test/');
  const ids = a.findings.map((f) => f.id);
  for (const id of ['no-uae-licence', 'licence-vague', 'crypto-only', 'messenger', 'bonus', 'targets-uae', 'no-responsible']) assert.ok(ids.includes(id), id);
  assert.strictEqual(score(a.findings).level, 'danger');

  const blocked = analyzeHtml('<html><head><title>Attention Required! | Cloudflare</title></head><body>Sorry, you have been blocked</body></html>', 'https://www.playdubibet.test/ar/casino');
  assert.strictEqual(blocked.challenge, true);
  assert.deepStrictEqual(blocked.findings.map((f) => f.id), ['bot-challenge', 'no-uae-licence', 'targets-uae']);
  assert.strictEqual(blocked.isGambling, true);
  const plain = analyzeHtml('<html><head><title>Just a moment...</title></head><body>Checking your browser</body></html>', 'https://example.test/');
  assert.deepStrictEqual(plain.findings.map((f) => f.id), ['bot-challenge']);
});

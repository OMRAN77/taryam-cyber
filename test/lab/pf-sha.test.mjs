// Synchronous SHA-256 / SHA-512 / HMAC used by the provably-fair adapters, checked
// against node:crypto (a second implementation) and published known answers, plus
// the speed of chain walking that 10,000,000-link chains need.
import test from 'node:test';
import assert from 'node:assert';
import crypto from 'node:crypto';
import { sha256, sha256Hex, hmacSha256, hmacSha256Key, linkRaw, linkHex, walkChain, linksUntil, bytesToHex, hexToBytes } from '../../lab/core/sha256-sync.js';
import { sha512, hmacSha512 } from '../../lab/core/sha512-sync.js';

const nodeHex = (alg, data) => crypto.createHash(alg).update(data).digest('hex');
const nodeHmac = (alg, key, data) => crypto.createHmac(alg, key).update(data).digest('hex');

test('known answers: FIPS 180-2 "abc" and RFC 4231 test case 2', () => {
  // FIPS 180-2 appendix B.1 / C.1.
  assert.strictEqual(sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.strictEqual(bytesToHex(sha512('abc')), 'ddaf35a193617abacc417349ae20413112e6fa4e89a97ea20a9eeee64b55d39a2192992a274fc1a836ba3c23a3feebbd454d4423643ce80e2a9ac94fa54ca49f');
  // RFC 4231 test case 2 (key "Jefe").
  assert.strictEqual(bytesToHex(hmacSha256('Jefe', 'what do ya want for nothing?')), '5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843');
  assert.strictEqual(bytesToHex(hmacSha512('Jefe', 'what do ya want for nothing?')), '164b7a7bfcf819e2e395fbe73b56e0a387bd64222e831fd610270cd7ea2505549758bf75c05a994a6d034f65f8f0e6fdcaeab1a34d4a6b4b636e070a38bce737');
});

test('SHA-256, SHA-512 and HMAC agree with node:crypto on every length 0..300 and long keys', () => {
  for (let len = 0; len <= 300; len++) {
    const b = crypto.randomBytes(len);
    assert.strictEqual(bytesToHex(sha256(b)), nodeHex('sha256', b), 'sha256 len ' + len);
    assert.strictEqual(bytesToHex(sha512(b)), nodeHex('sha512', b), 'sha512 len ' + len);
    const k = crypto.randomBytes((len * 7) % 200); // includes keys longer than both block sizes
    assert.strictEqual(bytesToHex(hmacSha256(k, b)), nodeHmac('sha256', k, b), 'hmac256 len ' + len);
    assert.strictEqual(bytesToHex(hmacSha512(k, b)), nodeHmac('sha512', k, b), 'hmac512 len ' + len);
  }
  // UTF-8 text keys and messages (Arabic, emoji) are hashed as UTF-8 like node:crypto does.
  const key = 'بذرة الخادم 🎲', msg = 'عميل:7:0';
  assert.strictEqual(bytesToHex(hmacSha256(key, msg)), nodeHmac('sha256', key, msg));
  // A keyed HMAC reused for many messages gives the same as a fresh one each time.
  const f = hmacSha256Key('server');
  for (let i = 0; i < 50; i++) assert.strictEqual(bytesToHex(f(`c:${i}:0`)), nodeHmac('sha256', 'server', `c:${i}:0`));
});

test('chain links: raw 32 bytes and 64-character hex text, against node:crypto', () => {
  for (let i = 0; i < 2000; i++) {
    const h = crypto.randomBytes(32);
    assert.strictEqual(bytesToHex(linkRaw(h)), nodeHex('sha256', h));
    assert.strictEqual(bytesToHex(linkHex(h)), nodeHex('sha256', h.toString('hex')));
  }
  // walkChain / linksUntil against a node:crypto walk of 1,000 links each way.
  const start = crypto.randomBytes(32);
  let raw = start, hex = start;
  for (let i = 0; i < 1000; i++) { raw = crypto.createHash('sha256').update(raw).digest(); hex = crypto.createHash('sha256').update(hex.toString('hex')).digest(); }
  assert.strictEqual(bytesToHex(walkChain(start, 1000, 'raw').hash), raw.toString('hex'));
  assert.strictEqual(bytesToHex(walkChain(start, 1000, 'hex').hash), hex.toString('hex'));
  assert.strictEqual(linksUntil(start, raw, 5000, 'raw'), 1000);
  assert.strictEqual(linksUntil(start, hex, 999, 'hex'), -1);
});

test('speed: millions of chain links per second (order of magnitude), and a real 2.3M-link bustabit walk', () => {
  // bustabit game 12,306,896 (hash reported by a player, deduzzo/bustabit-scripts) walked
  // 12,306,896 - 10,000,000 = 2,306,896 raw-byte links reaches the terminating hash in
  // bustabit's own verifier (src/constants.ts). Checked once with node:crypto (6 s).
  const t0 = performance.now();
  const w = walkChain(hexToBytes('94aa062026624e59a0ace092568d5f46e21b9bf1d5173609db8645dd62bdfc44'), 2306896, 'raw');
  const ms = performance.now() - t0;
  assert.strictEqual(bytesToHex(w.hash), '567a98370fb7545137ddb53687723cf0b8a1f5e93b1f76f4a1da29416930fa59');
  const rate = 2306896 / (ms / 1000);
  // ~2.6M/s measured on Node 22; the bound leaves room for slow CI machines.
  assert.ok(rate > 400000, `raw links per second: ${rate.toFixed(0)}`);
  const t1 = performance.now();
  walkChain(crypto.randomBytes(32), 500000, 'hex');
  const hexRate = 500000 / ((performance.now() - t1) / 1000);
  assert.ok(hexRate > 250000, `hex links per second: ${hexRate.toFixed(0)}`);
});

// Shared pieces of the provably-fair adapters: input hygiene, byte streams,
// float extraction, the game maps that several operators share, result
// comparison and exact outcome probabilities (for the uniformity tests).
import { sha256, bytesToHex, hexToBytes, hmacSha256Key } from '../sha256-sync.js';

export { bytesToHex, hexToBytes };

const pfError = (ar, en) => Object.assign(new Error(en), { ar, en });
export { pfError };

// ---------- input hygiene ----------

// Zero-width and direction-control characters that survive copy and paste.
const INVISIBLE = /[­᠎​-‏‪-‮⁠-⁤⁦-⁩﻿]/g;

// Seeds: invisible characters and surrounding whitespace are removed unless
// `exact` is set (Stake's calculator does not trim: a leading space changes the
// result). `changed` reports whether anything was removed.
export function normalizeSeed(raw, { exact = false } = {}) {
  const s = raw === null || raw === undefined ? '' : String(raw);
  if (exact) return { value: s, changed: false, empty: s === '', inner: /\s/.test(s.trim()) };
  const v = s.replace(INVISIBLE, '').trim();
  return { value: v, changed: v !== s, empty: v === '', inner: /\s/.test(v) };
}

// Hex hashes: invisible characters, all whitespace and a 0x prefix are removed and
// the case is lowered. Anything that is not then 64 hex digits is 'malformed',
// which the audit reports as "not checked", never as a mismatch.
export function normalizeHash(raw, length = 64) {
  const s = raw === null || raw === undefined ? '' : String(raw);
  let v = s.replace(INVISIBLE, '').replace(/\s+/g, '');
  if (/^0x/i.test(v)) v = v.slice(2);
  v = v.toLowerCase();
  if (v === '') return { value: null, status: 'empty', changed: false };
  if (v.length !== length || !/^[0-9a-f]+$/.test(v)) return { value: null, status: 'malformed', changed: true, raw: s };
  return { value: v, status: 'ok', changed: v !== s };
}

// Nonces: Arabic-Indic and Persian digits are read; the value is a non-negative
// integer kept as BigInt (no precision loss above 2^53); `text` is its canonical
// decimal form, which is what the HMAC message contains.
export function parseNonce(raw) {
  const s = String(raw ?? '').replace(INVISIBLE, '').trim()
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x6f0));
  if (!/^\d+$/.test(s)) return { error: s === '' ? 'empty' : 'invalid' };
  const value = BigInt(s);
  return { value, text: value.toString(), changed: value.toString() !== String(raw ?? '').trim() };
}

// ---------- byte streams and floats ----------

// f = b0/256 + b1/256^2 + b2/256^3 + b3/256^4 = u32 / 2^32, exact in a double.
export const floatAt = (b, i) => ((((b[i] * 256 + b[i + 1]) * 256 + b[i + 2]) * 256 + b[i + 3]) / 4294967296);
export const u32At = (b, i) => (((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0);

// Stake-style cursor: HMAC-SHA256(key, "client:nonce:round"), 32 bytes per round,
// 8 floats per round, the cursor continuing into round 1, 2, ... as needed.
export function cursorFloats(hmac, client, nonceText, count) {
  const floats = [];
  for (let round = 0; floats.length < count; round++) {
    const b = hmac(`${client}:${nonceText}:${round}`);
    for (let i = 0; i < 32 && floats.length < count; i += 4) floats.push(floatAt(b, i));
  }
  return floats;
}

// Keyed HMAC-SHA256 functions are cached per key (one cache per audit).
export function keyCache(make = hmacSha256Key) {
  const m = new Map();
  return (key) => {
    const id = typeof key === 'string' ? 's:' + key : 'b:' + bytesToHex(key);
    let f = m.get(id);
    if (!f) { f = make(key); m.set(id, f); if (m.size > 4096) m.delete(m.keys().next().value); }
    return f;
  };
}

// ---------- exact probabilities of floor(u * N / 2^k) ----------

// Number of k-bit integers u with floor(u * N / 2^k) in [a, b): ceil(b 2^k / N) - ceil(a 2^k / N).
export function floorMapCount(a, b, N, bits = 32) {
  const T = 1n << BigInt(bits), n = BigInt(N);
  const ceil = (x) => (x * T + n - 1n) / n;
  return ceil(BigInt(b)) - ceil(BigInt(a));
}
export const floorMapProb = (a, b, N, bits = 32) => Number(floorMapCount(a, b, N, bits)) / 2 ** bits;

// ---------- result parsing and comparison ----------

const num = (s) => {
  const t = String(s ?? '').replace(INVISIBLE, '').trim().replace(/x$/i, '').replace(/,/g, '.');
  if (t === '' || !/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(t)) return null;
  return Number(t);
};
export { num as parseNumber };

export function splitList(s) {
  return String(s ?? '').replace(INVISIBLE, '').replace(/[[\]{}()"']/g, ' ').split(/[\s,;|/]+/).filter(Boolean);
}

// Dice-like values with two decimals: the claim must equal ticks / 100.
export function compareTicks(ticks, claimed) {
  const v = num(claimed);
  if (v === null) return 'unparsable';
  return Math.abs(v * 100 - ticks) < 1e-6 ? 'match' : 'mismatch';
}

// Multipliers: a claim matches the value floored to cents, or the raw value.
// `alt` lists other accepted cent values (exact-arithmetic boundary cases).
export function compareMultiplier({ raw, cents, alt = [] }, claimed) {
  const v = num(claimed);
  if (v === null) return 'unparsable';
  if (!Number.isFinite(raw)) return 'edge';
  const c = Math.round(v * 100);
  if (Math.abs(v * 100 - c) < 1e-6 && (c === cents || alt.includes(c))) return 'match';
  if (Math.abs(v - raw) <= 1e-12 * Math.max(1, raw)) return 'match';
  return 'mismatch';
}

export function compareInt(value, claimed) {
  const v = num(claimed);
  if (v === null || !Number.isInteger(v)) return 'unparsable';
  return v === value ? 'match' : 'mismatch';
}

// Unordered list of integers (a Keno draw or a Mines board).
export function compareSet(values, claimed, base = 0, shift = 0) {
  const toks = splitList(claimed).map(Number);
  if (!toks.length || toks.some((x) => !Number.isInteger(x))) return 'unparsable';
  const want = values.map((v) => v + shift).sort((a, b) => a - b);
  const got = toks.slice().sort((a, b) => a - b);
  return want.length === got.length && want.every((v, i) => v === got[i]) ? 'match' : 'mismatch';
}

// ---------- Stake-style game maps from floats in [0, 1) ----------

export const diceTicks = (f) => Math.floor(f * 10001);

// Limbo, documented formula: 1e8 / (f * 1e8) * 0.99, floored to cents.
// Exact cents for the same float (f = u / 2^32): floor(99 * 2^32 / u).
export function limboDocs(f) {
  const raw = 1e8 / (f * 1e8) * 0.99;
  const cents = Math.floor(raw * 100);
  const u = Math.round(f * 4294967296), A = 99 * 4294967296; // A < 2^53: exact integer division
  const exact = u === 0 ? null : (A - (A % u)) / u;
  return { raw, cents, alt: exact !== null && exact !== cents ? [exact] : [] };
}

// Limbo, live-calculator formula: 2^24 equiprobable buckets,
// raw = 2^24 / (floor(f * 2^24) + 1) * 0.99. Exact cents: floor(99 * 2^24 / (k + 1)).
export function limboCalc24(f) {
  const k = Math.floor(f * 16777216);
  const raw = 16777216 / (k + 1) * 0.99;
  const cents = Math.floor(raw * 100);
  const A = 99 * 16777216; // exact integer division in doubles
  const exact = (A - (A % (k + 1))) / (k + 1);
  return { raw, cents, k, alt: exact !== cents ? [exact] : [], centBoundary: exact !== cents };
}

// Draws without replacement: idx = floor(f * remaining) into the remaining list.
export function drawWithout(floats, items) {
  const left = items.slice();
  return floats.map((f) => left.splice(Math.floor(f * left.length), 1)[0]);
}
export const range = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => from + i);

// Cards from an infinite deck: index floor(f * 52) into ♦2 ♥2 ♠2 ♣2 ♦3 ... ♣A.
export const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
export const SUITS = ['♦', '♥', '♠', '♣'];
const SUIT_LETTER = { D: '♦', H: '♥', S: '♠', C: '♣' };
export const cardName = (i) => RANKS[Math.floor(i / 4)] + SUITS[i % 4];
export function parseCard(tok) {
  const m = /^(10|[2-9TJQKA])\s*([♦♥♠♣♢♡♤♧DHSC])$/i.exec(String(tok).trim());
  if (!m) return null;
  const rank = m[1].toUpperCase() === 'T' ? '10' : m[1].toUpperCase();
  let suit = m[2].toUpperCase();
  suit = SUIT_LETTER[suit] || { '♢': '♦', '♡': '♥', '♤': '♠', '♧': '♣' }[suit] || suit;
  return RANKS.indexOf(rank) * 4 + SUITS.indexOf(suit);
}

// ---------- commitments ----------

export const commitText = (seed) => bytesToHex(sha256(seed));
export const commitHexBytes = (seed) => bytesToHex(sha256(hexToBytes(seed)));

// ---------- crash formulas on 52-bit values (bustabit / BC.Game family) ----------

// r = first 13 hex digits as an integer; X = r / 2^52 (exact);
// bust = max(1, floor(99 / (1 - X)) / 100), in doubles as the operators compute it.
export function bust52(hex13, { precision9 = false } = {}) {
  const r = parseInt(hex13, 16);
  let X = r / 4503599627370496;
  if (precision9) X = parseFloat(X.toPrecision(9));
  const q = 99 / (1 - X);
  if (!Number.isFinite(q)) return { raw: Infinity, cents: Infinity, r };
  const cents = Math.max(100, Math.floor(q));
  return { raw: cents / 100, cents, r };
}

// P(bust >= m) for the 52-bit formula, m in cents (m >= 101): the share of r with
// 99 * 2^52 / (2^52 - r) >= m, i.e. r >= 2^52 (m - 99) / m. Exact in BigInt.
export function bust52Survival(mCents) {
  if (mCents <= 100) return 1;
  const T = 1n << 52n, m = BigInt(mCents);
  const rMin = (T * (m - 99n) + m - 1n) / m;
  return Number(T - rMin) / 2 ** 52;
}

export { sha256 };

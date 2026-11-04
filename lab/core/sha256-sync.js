// Synchronous SHA-256 and HMAC-SHA256 (FIPS 180-4, RFC 2104) in plain JavaScript.
//
// WebCrypto's digest is asynchronous: walking a 10,000,000-link hash chain with
// one await per link takes minutes. This compressor runs in the Worker without
// awaits; the chain-link helpers hash a 32-byte value either as raw bytes (one
// block) or as its 64-character lowercase hex text (two blocks, the second being
// constant padding whose message schedule is computed once).
// Checked against node:crypto in test/lab/pf-sha.test.mjs.

const K = new Int32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);
const IV = new Int32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);

const W = new Int32Array(64);

// One compression: state (Int32Array(8)) is updated in place from W[0..15]
// (already filled with the block's big-endian words).
function compress(state) {
  for (let i = 16; i < 64; i++) {
    const x = W[i - 15], y = W[i - 2];
    const s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3);
    const s1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10);
    W[i] = (W[i - 16] + s0 + W[i - 7] + s1) | 0;
  }
  rounds(state, W);
}

// The 64 rounds with a ready message schedule w (or K[i] + w[i] when kw is set).
function rounds(state, w, kw = false) {
  let a = state[0], b = state[1], c = state[2], d = state[3], e = state[4], f = state[5], g = state[6], h = state[7];
  for (let i = 0; i < 64; i++) {
    const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
    const ch = (e & f) ^ (~e & g);
    const t1 = (h + S1 + ch + (kw ? w[i] : (K[i] + w[i]) | 0)) | 0;
    const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
    const maj = (a & b) ^ (a & c) ^ (b & c);
    const t2 = (S0 + maj) | 0;
    h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
  }
  state[0] = (state[0] + a) | 0; state[1] = (state[1] + b) | 0; state[2] = (state[2] + c) | 0; state[3] = (state[3] + d) | 0;
  state[4] = (state[4] + e) | 0; state[5] = (state[5] + f) | 0; state[6] = (state[6] + g) | 0; state[7] = (state[7] + h) | 0;
}

const enc = new TextEncoder();
export const utf8 = (s) => enc.encode(s);
const asBytes = (data) => (typeof data === 'string' ? enc.encode(data) : data instanceof Uint8Array ? data : new Uint8Array(data));

function loadBlock(bytes, off) {
  for (let i = 0; i < 16; i++) {
    const j = off + 4 * i;
    W[i] = (bytes[j] << 24) | (bytes[j + 1] << 16) | (bytes[j + 2] << 8) | bytes[j + 3];
  }
}

function stateToBytes(state, out = new Uint8Array(32)) {
  for (let i = 0; i < 8; i++) {
    const v = state[i];
    out[4 * i] = v >>> 24; out[4 * i + 1] = (v >>> 16) & 255; out[4 * i + 2] = (v >>> 8) & 255; out[4 * i + 3] = v & 255;
  }
  return out;
}

// Hashes `bytes` starting from `state` (after `prefixBytes` already absorbed).
function finish(state, bytes, prefixBytes) {
  const n = bytes.length;
  let off = 0;
  for (; off + 64 <= n; off += 64) { loadBlock(bytes, off); compress(state); }
  const tail = new Uint8Array(n - off < 56 ? 64 : 128);
  tail.set(bytes.subarray(off));
  tail[n - off] = 0x80;
  // Bit length as a 64-bit big-endian integer (exact up to 2^53 bytes).
  const bits = (prefixBytes + n) * 8;
  const hi = Math.floor(bits / 2 ** 32), lo = bits >>> 0;
  const L = tail.length;
  tail[L - 8] = hi >>> 24; tail[L - 7] = (hi >>> 16) & 255; tail[L - 6] = (hi >>> 8) & 255; tail[L - 5] = hi & 255;
  tail[L - 4] = lo >>> 24; tail[L - 3] = (lo >>> 16) & 255; tail[L - 2] = (lo >>> 8) & 255; tail[L - 1] = lo & 255;
  for (let t = 0; t < L; t += 64) { loadBlock(tail, t); compress(state); }
  return state;
}

export function sha256(data) {
  return stateToBytes(finish(Int32Array.from(IV), asBytes(data), 0));
}

const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'));
export function bytesToHex(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += HEX[bytes[i]];
  return s;
}
export function hexToBytes(hex) {
  if (typeof hex !== 'string' || hex.length % 2 || !/^[0-9a-fA-F]*$/.test(hex)) throw new RangeError('not hex');
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(2 * i, 2), 16);
  return out;
}

export const sha256Hex = (data) => bytesToHex(sha256(data));

// HMAC-SHA256 keyed once: the inner and outer pad blocks are absorbed when the
// key is set, so each message costs two compressions for short messages.
export function hmacSha256Key(key) {
  let k = asBytes(key);
  if (k.length > 64) k = sha256(k);
  const pad = new Uint8Array(64);
  const inner = Int32Array.from(IV), outer = Int32Array.from(IV);
  pad.set(k); for (let i = 0; i < 64; i++) pad[i] ^= 0x36;
  loadBlock(pad, 0); compress(inner);
  pad.fill(0); pad.set(k); for (let i = 0; i < 64; i++) pad[i] ^= 0x5c;
  loadBlock(pad, 0); compress(outer);
  const ih = new Uint8Array(32);
  return (message) => {
    stateToBytes(finish(Int32Array.from(inner), asBytes(message), 64), ih);
    return stateToBytes(finish(Int32Array.from(outer), ih, 64));
  };
}

export const hmacSha256 = (key, message) => hmacSha256Key(key)(message);

// ---- hash-chain links ----

const LINK_STATE = new Int32Array(8);
// Schedule (with K added) of the constant second block of a 64-byte message.
const PAD64_KW = (() => {
  const w = new Int32Array(64);
  W.fill(0); W[0] = 0x80000000 | 0; W[15] = 512;
  compress(new Int32Array(IV)); // fills W[16..63]
  for (let i = 0; i < 64; i++) w[i] = (K[i] + W[i]) | 0;
  return w;
})();
const HEXCODE = new Int32Array(256); // byte -> two ASCII hex characters as a 16-bit value
for (let i = 0; i < 256; i++) HEXCODE[i] = (HEX[i].charCodeAt(0) << 8) | HEX[i].charCodeAt(1);

// out = SHA-256(the 32 raw bytes of h). h and out may be the same array.
export function linkRaw(h, out = new Uint8Array(32)) {
  for (let i = 0; i < 8; i++) W[i] = (h[4 * i] << 24) | (h[4 * i + 1] << 16) | (h[4 * i + 2] << 8) | h[4 * i + 3];
  W[8] = 0x80000000 | 0; W[9] = 0; W[10] = 0; W[11] = 0; W[12] = 0; W[13] = 0; W[14] = 0; W[15] = 256;
  LINK_STATE.set(IV);
  compress(LINK_STATE);
  return stateToBytes(LINK_STATE, out);
}

// out = SHA-256(the 64-character lowercase hex text of h).
export function linkHex(h, out = new Uint8Array(32)) {
  for (let i = 0; i < 16; i++) W[i] = (HEXCODE[h[2 * i]] << 16) | HEXCODE[h[2 * i + 1]];
  LINK_STATE.set(IV);
  compress(LINK_STATE);
  rounds(LINK_STATE, PAD64_KW, true);
  return stateToBytes(LINK_STATE, out);
}

// Applies `links` chain steps to the 32-byte hash `start` ('raw' or 'hex' links).
// onStep(done) is called every `every` links; it may return true to stop early.
export function walkChain(start, links, mode = 'raw', { every = 1 << 18, onStep = null } = {}) {
  const step = mode === 'hex' ? linkHex : linkRaw;
  const h = Uint8Array.from(start);
  for (let i = 1; i <= links; i++) {
    step(h, h);
    if (onStep && i % every === 0 && onStep(i)) return { hash: h, links: i, stopped: true };
  }
  return { hash: h, links, stopped: false };
}

// Walks from `start` until the hash equals `target` (both 32-byte arrays), at most
// maxLinks steps. Returns the number of links, or -1 when the target was not reached.
export function linksUntil(start, target, maxLinks, mode = 'raw', { every = 1 << 18, onStep = null } = {}) {
  const step = mode === 'hex' ? linkHex : linkRaw;
  const h = Uint8Array.from(start);
  const t0 = target[0], t1 = target[1], t2 = target[2], t3 = target[3];
  const same = () => { for (let j = 0; j < 32; j++) if (h[j] !== target[j]) return false; return true; };
  if (same()) return 0;
  for (let i = 1; i <= maxLinks; i++) {
    step(h, h);
    if (h[0] === t0 && h[1] === t1 && h[2] === t2 && h[3] === t3 && same()) return i;
    if (onStep && i % every === 0 && onStep(i)) return -1;
  }
  return -1;
}

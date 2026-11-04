// Synchronous SHA-512 and HMAC-SHA512 (FIPS 180-4, RFC 2104) in plain JavaScript,
// for the operators that use HMAC-SHA512 (Primedice) or plain SHA-512 (Aviator's
// third-party reconstruction). 64-bit words are kept as (high, low) 32-bit pairs.
// The round constants and initial value are derived here from their definition
// (fractional parts of cube and square roots of the first primes) with BigInt.
// Checked against node:crypto in test/lab/pf-sha.test.mjs.

const PRIMES = [];
for (let n = 2; PRIMES.length < 80; n++) if (PRIMES.every((p) => n % p)) PRIMES.push(n);

function iroot(n, k) {
  // floor(n^(1/k)) by Newton's method from an overestimate.
  let x = 1n << BigInt(Math.ceil(n.toString(2).length / k) + 1);
  const K = BigInt(k);
  for (;;) {
    const y = ((K - 1n) * x + n / x ** (K - 1n)) / K;
    if (y >= x) return x;
    x = y;
  }
}
const frac64 = (v) => v & ((1n << 64n) - 1n);
const KH = new Int32Array(80), KL = new Int32Array(80);
PRIMES.forEach((p, i) => {
  const v = frac64(iroot(BigInt(p) << 192n, 3));
  KH[i] = Number(v >> 32n) | 0; KL[i] = Number(v & 0xffffffffn) | 0;
});
const IVH = new Int32Array(8), IVL = new Int32Array(8);
PRIMES.slice(0, 8).forEach((p, i) => {
  const v = frac64(iroot(BigInt(p) << 128n, 2));
  IVH[i] = Number(v >> 32n) | 0; IVL[i] = Number(v & 0xffffffffn) | 0;
});

const WH = new Int32Array(80), WL = new Int32Array(80);
const T32 = 4294967296;

function compress(H, L) {
  for (let i = 16; i < 80; i++) {
    // s0 = rotr1 ^ rotr8 ^ shr7 of W[i-15]; s1 = rotr19 ^ rotr61 ^ shr6 of W[i-2]
    let xh = WH[i - 15], xl = WL[i - 15];
    const s0h = ((xh >>> 1) | (xl << 31)) ^ ((xh >>> 8) | (xl << 24)) ^ (xh >>> 7);
    const s0l = ((xl >>> 1) | (xh << 31)) ^ ((xl >>> 8) | (xh << 24)) ^ ((xl >>> 7) | (xh << 25));
    xh = WH[i - 2]; xl = WL[i - 2];
    const s1h = ((xh >>> 19) | (xl << 13)) ^ ((xl >>> 29) | (xh << 3)) ^ (xh >>> 6);
    const s1l = ((xl >>> 19) | (xh << 13)) ^ ((xh >>> 29) | (xl << 3)) ^ ((xl >>> 6) | (xh << 26));
    const lo = (WL[i - 16] >>> 0) + (s0l >>> 0) + (WL[i - 7] >>> 0) + (s1l >>> 0);
    WL[i] = lo | 0;
    WH[i] = (WH[i - 16] + s0h + WH[i - 7] + s1h + Math.floor(lo / T32)) | 0;
  }
  let ah = H[0], al = L[0], bh = H[1], bl = L[1], ch = H[2], cl = L[2], dh = H[3], dl = L[3];
  let eh = H[4], el = L[4], fh = H[5], fl = L[5], gh = H[6], gl = L[6], hh = H[7], hl = L[7];
  for (let i = 0; i < 80; i++) {
    // S1 = rotr14 ^ rotr18 ^ rotr41 of e
    const S1h = ((eh >>> 14) | (el << 18)) ^ ((eh >>> 18) | (el << 14)) ^ ((el >>> 9) | (eh << 23));
    const S1l = ((el >>> 14) | (eh << 18)) ^ ((el >>> 18) | (eh << 14)) ^ ((eh >>> 9) | (el << 23));
    const chh = (eh & fh) ^ (~eh & gh), chl = (el & fl) ^ (~el & gl);
    const t1lo = (hl >>> 0) + (S1l >>> 0) + (chl >>> 0) + (KL[i] >>> 0) + (WL[i] >>> 0);
    const t1h = (hh + S1h + chh + KH[i] + WH[i] + Math.floor(t1lo / T32)) | 0;
    const t1l = t1lo | 0;
    // S0 = rotr28 ^ rotr34 ^ rotr39 of a
    const S0h = ((ah >>> 28) | (al << 4)) ^ ((al >>> 2) | (ah << 30)) ^ ((al >>> 7) | (ah << 25));
    const S0l = ((al >>> 28) | (ah << 4)) ^ ((ah >>> 2) | (al << 30)) ^ ((ah >>> 7) | (al << 25));
    const mjh = (ah & bh) ^ (ah & ch) ^ (bh & ch), mjl = (al & bl) ^ (al & cl) ^ (bl & cl);
    const t2lo = (S0l >>> 0) + (mjl >>> 0);
    const t2h = (S0h + mjh + Math.floor(t2lo / T32)) | 0;
    const t2l = t2lo | 0;
    hh = gh; hl = gl; gh = fh; gl = fl; fh = eh; fl = el;
    const elo = (dl >>> 0) + (t1l >>> 0);
    eh = (dh + t1h + Math.floor(elo / T32)) | 0; el = elo | 0;
    dh = ch; dl = cl; ch = bh; cl = bl; bh = ah; bl = al;
    const alo = (t1l >>> 0) + (t2l >>> 0);
    ah = (t1h + t2h + Math.floor(alo / T32)) | 0; al = alo | 0;
  }
  const add = (k, xh, xl) => {
    const lo = (L[k] >>> 0) + (xl >>> 0);
    H[k] = (H[k] + xh + Math.floor(lo / T32)) | 0; L[k] = lo | 0;
  };
  add(0, ah, al); add(1, bh, bl); add(2, ch, cl); add(3, dh, dl); add(4, eh, el); add(5, fh, fl); add(6, gh, gl); add(7, hh, hl);
}

function loadBlock(bytes, off) {
  for (let i = 0; i < 16; i++) {
    const j = off + 8 * i;
    WH[i] = (bytes[j] << 24) | (bytes[j + 1] << 16) | (bytes[j + 2] << 8) | bytes[j + 3];
    WL[i] = (bytes[j + 4] << 24) | (bytes[j + 5] << 16) | (bytes[j + 6] << 8) | bytes[j + 7];
  }
}

const enc = new TextEncoder();
const asBytes = (data) => (typeof data === 'string' ? enc.encode(data) : data instanceof Uint8Array ? data : new Uint8Array(data));

function finish(H, L, bytes, prefixBytes) {
  const n = bytes.length;
  let off = 0;
  for (; off + 128 <= n; off += 128) { loadBlock(bytes, off); compress(H, L); }
  const tail = new Uint8Array(n - off < 112 ? 128 : 256);
  tail.set(bytes.subarray(off));
  tail[n - off] = 0x80;
  const bits = (prefixBytes + n) * 8; // < 2^53: the upper 64 bits of the 128-bit length stay 0
  const hi = Math.floor(bits / T32), lo = bits >>> 0;
  const E = tail.length;
  tail[E - 8] = hi >>> 24; tail[E - 7] = (hi >>> 16) & 255; tail[E - 6] = (hi >>> 8) & 255; tail[E - 5] = hi & 255;
  tail[E - 4] = lo >>> 24; tail[E - 3] = (lo >>> 16) & 255; tail[E - 2] = (lo >>> 8) & 255; tail[E - 1] = lo & 255;
  for (let t = 0; t < E; t += 128) { loadBlock(tail, t); compress(H, L); }
}

function out(H, L) {
  const o = new Uint8Array(64);
  for (let i = 0; i < 8; i++) {
    const h = H[i], l = L[i], j = 8 * i;
    o[j] = h >>> 24; o[j + 1] = (h >>> 16) & 255; o[j + 2] = (h >>> 8) & 255; o[j + 3] = h & 255;
    o[j + 4] = l >>> 24; o[j + 5] = (l >>> 16) & 255; o[j + 6] = (l >>> 8) & 255; o[j + 7] = l & 255;
  }
  return o;
}

export function sha512(data) {
  const H = Int32Array.from(IVH), L = Int32Array.from(IVL);
  finish(H, L, asBytes(data), 0);
  return out(H, L);
}

export function hmacSha512Key(key) {
  let k = asBytes(key);
  if (k.length > 128) k = sha512(k);
  const pad = new Uint8Array(128);
  const iH = Int32Array.from(IVH), iL = Int32Array.from(IVL), oH = Int32Array.from(IVH), oL = Int32Array.from(IVL);
  pad.set(k); for (let i = 0; i < 128; i++) pad[i] ^= 0x36;
  loadBlock(pad, 0); compress(iH, iL);
  pad.fill(0); pad.set(k); for (let i = 0; i < 128; i++) pad[i] ^= 0x5c;
  loadBlock(pad, 0); compress(oH, oL);
  return (message) => {
    const H = Int32Array.from(iH), L = Int32Array.from(iL);
    finish(H, L, asBytes(message), 128);
    const inner = out(H, L);
    const H2 = Int32Array.from(oH), L2 = Int32Array.from(oL);
    finish(H2, L2, inner, 128);
    return out(H2, L2);
  };
}

export const hmacSha512 = (key, message) => hmacSha512Key(key)(message);

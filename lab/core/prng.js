// Reproducible pseudo-random numbers for the simulator: xoshiro128** 1.1
// (Blackman & Vigna), with its 128-bit state taken from SHA-256 of the seed text
// (first 16 bytes, four little-endian 32-bit words). Integer-only arithmetic, so
// every browser produces the same sequence for the same seed.
const rotl = (x, k) => (x << k) | (x >>> (32 - k));

export class Xoshiro128ss {
  constructor(s0, s1, s2, s3) {
    this.s = new Uint32Array([s0, s1, s2, s3]);
    if (!(s0 | s1 | s2 | s3)) this.s[0] = 1; // the all-zero state is invalid
  }

  nextU32() {
    const s = this.s;
    const result = Math.imul(rotl(Math.imul(s[1], 5), 7), 9) >>> 0;
    const t = s[1] << 9;
    s[2] ^= s[0];
    s[3] ^= s[1];
    s[1] ^= s[2];
    s[0] ^= s[3];
    s[2] ^= t;
    s[3] = rotl(s[3], 11);
    return result;
  }

  // Uniform integer in [0, n) without modulo bias (rejection sampling).
  nextBelow(n) {
    const limit = 4294967296 - (4294967296 % n);
    let r;
    do r = this.nextU32(); while (r >= limit);
    return r % n;
  }
}

export async function prngFromSeed(seedText) {
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(seedText))));
  const v = new DataView(digest.buffer);
  return new Xoshiro128ss(v.getUint32(0, true), v.getUint32(4, true), v.getUint32(8, true), v.getUint32(12, true));
}

export const PRNG_DESCRIPTION = 'xoshiro128** 1.1, state = first 16 bytes of SHA-256(seed) as 4 little-endian uint32; reel stops by rejection sampling';

// Models with stop weights or several reel sets draw differently, so their runs record
// this longer text; unweighted runs keep the text above and their fingerprints.
export const PRNG_DESCRIPTION_WEIGHTED = PRNG_DESCRIPTION + '; weighted models: per spin the reel set (if several), then reels 1..N in order;'
  + ' each pick is the entry whose cumulative weight range holds u, a uniform integer below the total weight:'
  + ' u = one 32-bit draw by rejection when the total is at most 2^32, otherwise ceil(bits(total-1)/32) draws (most significant first) rejected above the last whole multiple of the total';

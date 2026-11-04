// Fast Fourier transforms, written in-house (no dependencies).
//
//  * fftInPlace / dftMagnitudes: the radix-2 transform and Bluestein's algorithm the
//    NIST spectral test (nist.js, SP 800-22 2.6) has always used, moved here
//    unchanged so its P-values stay bit-identical. Its twiddle factors come from a
//    running product, which is fine for the test's magnitudes but loses about
//    len * 2^-53 of accuracy on long transforms.
//  * Fft: a radix-2 transform of a fixed power-of-two size whose twiddle factors are
//    each computed directly (cos / sin of 2 pi k / n), so the rounding error of a
//    transform stays near log2(n) * 2^-53 of the input's size. Probability work
//    (round-dist.js, session.js) uses this one.

// In-place radix-2 FFT of (re, im); n = re.length must be a power of two.
// Forward: X_j = sum_k x_k e^{-2 pi i jk/n}; inverse: the same with +i, divided by n.
export function fftInPlace(re, im, inverse) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (inverse ? 2 : -2) * Math.PI / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = a + len / 2;
        const xr = re[b] * cr - im[b] * ci, xi = re[b] * ci + im[b] * cr;
        re[b] = re[a] - xr; im[b] = im[a] - xi;
        re[a] += xr; im[a] += xi;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr; cr = ncr;
      }
    }
  }
  if (inverse) for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
}

// |X_j| for j < count of the DFT of a real sequence of any length (Bluestein's algorithm).
export function dftMagnitudes(x, count) {
  const n = x.length;
  const out = new Float64Array(count);
  if ((n & (n - 1)) === 0) {
    const re = Float64Array.from(x), im = new Float64Array(n);
    fftInPlace(re, im, false);
    for (let j = 0; j < count; j++) out[j] = Math.hypot(re[j], im[j]);
    return out;
  }
  let m = 1;
  while (m < 2 * n - 1) m <<= 1;
  const wr = new Float64Array(n), wi = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    const ang = Math.PI * ((k * k) % (2 * n)) / n;
    wr[k] = Math.cos(ang); wi[k] = -Math.sin(ang);
  }
  const ar = new Float64Array(m), ai = new Float64Array(m), br = new Float64Array(m), bi = new Float64Array(m);
  for (let k = 0; k < n; k++) { ar[k] = x[k] * wr[k]; ai[k] = x[k] * wi[k]; }
  br[0] = wr[0]; bi[0] = -wi[0];
  for (let k = 1; k < n; k++) { br[k] = br[m - k] = wr[k]; bi[k] = bi[m - k] = -wi[k]; }
  fftInPlace(ar, ai, false);
  fftInPlace(br, bi, false);
  for (let i = 0; i < m; i++) {
    const r = ar[i] * br[i] - ai[i] * bi[i];
    ai[i] = ar[i] * bi[i] + ai[i] * br[i];
    ar[i] = r;
  }
  fftInPlace(ar, ai, true);
  for (let j = 0; j < count; j++) {
    const r = ar[j] * wr[j] - ai[j] * wi[j];
    const i = ar[j] * wi[j] + ai[j] * wr[j];
    out[j] = Math.hypot(r, i);
  }
  return out;
}

export const isPowerOfTwo = (n) => Number.isInteger(n) && n > 0 && (n & (n - 1)) === 0;
export function nextPowerOfTwo(n) {
  let m = 1;
  while (m < n) m *= 2;
  return m;
}

// Radix-2 transform of size n (a power of two) with exact-as-possible twiddles.
// Tables are shared between instances of the same size.
const TABLES = new Map();
function tables(n) {
  let t = TABLES.get(n);
  if (t) return t;
  const half = n >> 1;
  const cos = new Float64Array(half), sin = new Float64Array(half);
  // k / n is exact (n is a power of two), so each angle is within an ulp or two.
  for (let k = 0; k < half; k++) {
    const a = (k / n) * 2 * Math.PI;
    cos[k] = Math.cos(a); sin[k] = Math.sin(a);
  }
  const rev = new Uint32Array(n);
  const bits = Math.round(Math.log2(n));
  for (let i = 0; i < n; i++) {
    let r = 0;
    for (let b = 0, x = i; b < bits; b++, x >>= 1) r = (r << 1) | (x & 1);
    rev[i] = r >>> 0;
  }
  t = { cos, sin, rev };
  TABLES.set(n, t);
  return t;
}

export class Fft {
  constructor(n) {
    if (!isPowerOfTwo(n)) throw new RangeError('FFT size must be a power of two');
    this.n = n;
    Object.assign(this, tables(n));
  }

  // In place. sign -1: forward (e^{-2 pi i jk/n}); +1: inverse without the 1/n.
  run(re, im, sign) {
    const n = this.n, rev = this.rev, cos = this.cos, sin = this.sin;
    for (let i = 0; i < n; i++) {
      const j = rev[i];
      if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const halfLen = len >> 1, step = n / len;
      for (let i = 0; i < n; i += len) {
        for (let k = 0, w = 0; k < halfLen; k++, w += step) {
          const cr = cos[w], ci = sign * sin[w];
          const a = i + k, b = a + halfLen;
          const xr = re[b] * cr - im[b] * ci, xi = re[b] * ci + im[b] * cr;
          re[b] = re[a] - xr; im[b] = im[a] - xi;
          re[a] += xr; im[a] += xi;
        }
      }
    }
  }

  forward(re, im) { this.run(re, im, -1); }

  inverse(re, im) {
    this.run(re, im, 1);
    const n = this.n;
    for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
  }
}

// lab/core/fft.js: the transform NIST's spectral test uses (moved out of nist.js,
// which must keep its P-values bit for bit), and the accurate-twiddle transform the
// whole-round distribution and the session funnel use.
import test from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import * as N from '../../lab/core/nist.js';
import { Fft, fftInPlace, dftMagnitudes } from '../../lab/core/fft.js';
import { Xoshiro128ss } from '../../lab/core/prng.js';

const FIX = new URL('./fixtures/', import.meta.url);
const e = (n) => N.bitsFromBytes(fs.readFileSync(new URL('e.bin', FIX)), n);
const bitsOf = (x) => { const v = new DataView(new ArrayBuffer(8)); v.setFloat64(0, x); return v.getBigUint64(0).toString(16).padStart(16, '0'); };

// Expected bit patterns: printed by running lab/core/nist.js as it was at commit
// 2659225 (before the FFT moved to fft.js) on the same inputs, i.e. a second copy of
// the code, not the code under test. The 100-bit value is also the publication's
// worked example 2.6 (P = 0.168669), which nist.test.mjs checks to 6 digits.
test('NIST spectral P-values are bit-identical after the FFT moved to fft.js', () => {
  const want = {
    100: { p: '3fc596eeecfe0910', n1: 46, d: 'bff6061efecf8ae8' },
    1000: { p: '3fe1f91999b0de0b', n1: 473, d: 'bfe2927b2cd320f5' },
    65536: { p: '3fc9d83afc5004c0', n1: 31094, d: 'bff46b02119067dd' },
    1000000: { p: '3feb1c274afc0b3e', n1: 475021, d: '3fc8aab21325e343' },
  };
  for (const [n, w] of Object.entries(want)) {
    const r = N.spectral(e(Number(n)));
    assert.strictEqual(bitsOf(r.pValues[0]), w.p, `P-value, ${n} bits`);
    assert.strictEqual(r.stats.n1, w.n1, `N1, ${n} bits`);
    assert.strictEqual(bitsOf(r.stats.d), w.d, `d, ${n} bits`);
  }
  // runNist's spectral entry (the same code path the tab uses).
  const all = N.runNist(e(1000000));
  assert.strictEqual(bitsOf(all.results.find((t) => t.id === 'spectral').pValues[0]), '3feb1c274afc0b3e');
  // Bluestein (1000, not a power of two) and radix-2 (1024) magnitudes.
  const x1 = Float64Array.from(e(1000), (b) => (b ? 1 : -1));
  const m1 = dftMagnitudes(x1, 500);
  assert.deepStrictEqual([0, 1, 37, 250, 499].map((j) => bitsOf(m1[j])), ['404a000000000000', '403866f5c8518128', '4032c7fe0242933e', '403752e50db3a310', '4053d1c2f5608873']);
  const x2 = Float64Array.from(e(1024), (b) => (b ? 1 : -1));
  const m2 = N.dftMagnitudes(x2, 512); // still exported by nist.js
  assert.deepStrictEqual([0, 1, 37, 250, 511].map((j) => bitsOf(m2[j])), ['404a000000000000', '40392fa3d089e33a', '40370b702f4086fa', '403626a6954f6b1d', '4053bc0405fc03bc']);
});

function randomVector(n, seed) {
  const rng = new Xoshiro128ss(seed, 2, 3, 4);
  return Float64Array.from({ length: n }, () => rng.nextU32() / 2 ** 32 - 0.5);
}

// Expected: a direct O(n^2) DFT, X_j = sum_k x_k e^{-2 pi i jk/n}.
test('Fft agrees with a direct DFT and inverts', () => {
  for (const n of [1, 2, 8, 64, 256]) {
    const xr = randomVector(n, n), xi = randomVector(n, n + 7);
    const re = Float64Array.from(xr), im = Float64Array.from(xi);
    new Fft(n).forward(re, im);
    for (let j = 0; j < n; j++) {
      let sr = 0, si = 0;
      for (let k = 0; k < n; k++) {
        const a = -2 * Math.PI * ((j * k) % n) / n;
        sr += xr[k] * Math.cos(a) - xi[k] * Math.sin(a);
        si += xr[k] * Math.sin(a) + xi[k] * Math.cos(a);
      }
      assert.ok(Math.abs(re[j] - sr) < 1e-12 && Math.abs(im[j] - si) < 1e-12, `n=${n} j=${j}`);
    }
    new Fft(n).inverse(re, im);
    for (let k = 0; k < n; k++) assert.ok(Math.abs(re[k] - xr[k]) < 1e-14 && Math.abs(im[k] - xi[k]) < 1e-14);
  }
  assert.throws(() => new Fft(12), /power of two/);
});

// Expected: direct convolution c_s = sum_k a_k b_{s-k} of two probability vectors.
test('FFT convolution of pmfs equals direct convolution', () => {
  const a = randomVector(300, 11).map(Math.abs), b = randomVector(500, 12).map(Math.abs);
  const sa = a.reduce((x, y) => x + y), sb = b.reduce((x, y) => x + y);
  for (let i = 0; i < a.length; i++) a[i] /= sa;
  for (let i = 0; i < b.length; i++) b[i] /= sb;
  const n = 1024;
  const ar = new Float64Array(n), ai = new Float64Array(n), br = new Float64Array(n), bi = new Float64Array(n);
  ar.set(a); br.set(b);
  const f = new Fft(n);
  f.forward(ar, ai); f.forward(br, bi);
  for (let k = 0; k < n; k++) { const t = ar[k] * br[k] - ai[k] * bi[k]; ai[k] = ar[k] * bi[k] + ai[k] * br[k]; ar[k] = t; }
  f.inverse(ar, ai);
  let worst = 0;
  for (let s = 0; s < a.length + b.length - 1; s++) {
    let c = 0;
    for (let k = Math.max(0, s - b.length + 1); k <= Math.min(s, a.length - 1); k++) c += a[k] * b[s - k];
    worst = Math.max(worst, Math.abs(ar[s] - c));
  }
  assert.ok(worst < 1e-17, 'worst absolute error ' + worst);
  // The accurate twiddles beat the running-product ones of the NIST transform on a long input.
  const m = 1 << 16;
  const x = randomVector(m, 5);
  const r1 = Float64Array.from(x), i1 = new Float64Array(m), r2 = Float64Array.from(x), i2 = new Float64Array(m);
  new Fft(m).forward(r1, i1); new Fft(m).inverse(r1, i1);
  fftInPlace(r2, i2, false); fftInPlace(r2, i2, true);
  let e1 = 0, e2 = 0;
  for (let k = 0; k < m; k++) { e1 = Math.max(e1, Math.abs(r1[k] - x[k])); e2 = Math.max(e2, Math.abs(r2[k] - x[k])); }
  assert.ok(e1 < 1e-15 && e1 <= e2, `round trip ${e1} (accurate) vs ${e2} (running product)`);
});

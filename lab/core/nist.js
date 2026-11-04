// NIST SP 800-22 Rev. 1a statistical tests for random number generators.
// Every function takes a Uint8Array of 0/1 values (one bit per element) and
// returns { pValues, stats }. Formulas, parameter tables and category bounds
// follow the publication; tests/lab/nist.test.js checks them against its worked
// examples. runNist() applies NIST's recommended parameters and input-size limits.
import { erfc, igamc, normalCdf, lgamma } from './specfun.js';
import { dftMagnitudes } from './fft.js';

// The FFT lives in fft.js (moved unchanged); re-exported for existing callers.
export { dftMagnitudes };

export const ALPHA = 0.01;

// 2.1 Frequency (monobit)
export function frequency(bits) {
  const n = bits.length;
  let sum = 0;
  for (let i = 0; i < n; i++) sum += bits[i] ? 1 : -1;
  const sObs = Math.abs(sum) / Math.sqrt(n);
  return { pValues: [erfc(sObs / Math.SQRT2)], stats: { n, sum, sObs } };
}

// 2.2 Frequency within a block
export function blockFrequency(bits, M) {
  const N = Math.floor(bits.length / M);
  let chi2 = 0;
  for (let i = 0; i < N; i++) {
    let ones = 0;
    for (let j = 0; j < M; j++) ones += bits[i * M + j];
    chi2 += (ones / M - 0.5) ** 2;
  }
  chi2 *= 4 * M;
  return { pValues: [igamc(N / 2, chi2 / 2)], stats: { M, N, chi2 } };
}

// 2.3 Runs
export function runs(bits) {
  const n = bits.length;
  let ones = 0;
  for (let i = 0; i < n; i++) ones += bits[i];
  const pi = ones / n;
  const tau = 2 / Math.sqrt(n);
  if (Math.abs(pi - 0.5) >= tau) return { pValues: [0], stats: { pi, tau, frequencyPrerequisiteFailed: true } };
  let v = 1;
  for (let k = 0; k < n - 1; k++) if (bits[k] !== bits[k + 1]) v++;
  const p = erfc(Math.abs(v - 2 * n * pi * (1 - pi)) / (2 * Math.sqrt(2 * n) * pi * (1 - pi)));
  return { pValues: [p], stats: { pi, vObs: v } };
}

// 2.4 Longest run of ones in a block (category probabilities as tabulated in 3.4)
const LONGEST_RUN = {
  8: { K: 3, low: 1, pi: [0.2148, 0.3672, 0.2305, 0.1875] },
  128: { K: 5, low: 4, pi: [0.1174, 0.2430, 0.2493, 0.1752, 0.1027, 0.1124] },
  10000: { K: 6, low: 10, pi: [0.0882, 0.2092, 0.2483, 0.1933, 0.1208, 0.0675, 0.0727] },
};

export function longestRunBlockSize(n) {
  if (n < 128) return 0;
  if (n < 6272) return 8;
  if (n < 750000) return 128;
  return 10000;
}

export function longestRun(bits, M = longestRunBlockSize(bits.length)) {
  const cfg = LONGEST_RUN[M];
  const N = Math.floor(bits.length / M);
  const nu = new Array(cfg.K + 1).fill(0);
  for (let i = 0; i < N; i++) {
    let run = 0, best = 0;
    for (let j = 0; j < M; j++) {
      if (bits[i * M + j]) { run++; if (run > best) best = run; } else run = 0;
    }
    nu[Math.min(Math.max(best - cfg.low, 0), cfg.K)]++;
  }
  let chi2 = 0;
  for (let i = 0; i <= cfg.K; i++) chi2 += (nu[i] - N * cfg.pi[i]) ** 2 / (N * cfg.pi[i]);
  return { pValues: [igamc(cfg.K / 2, chi2 / 2)], stats: { M, N, nu, chi2 } };
}

// 2.5 Binary matrix rank (32 x 32 matrices over GF(2))
function rankGF2(rows) {
  const m = rows.length;
  let rank = 0;
  for (let col = 31; col >= 0 && rank < m; col--) {
    const bit = 1 << col;
    let pivot = -1;
    for (let r = rank; r < m; r++) if (rows[r] & bit) { pivot = r; break; }
    if (pivot < 0) continue;
    const t = rows[pivot]; rows[pivot] = rows[rank]; rows[rank] = t;
    for (let r = 0; r < m; r++) if (r !== rank && (rows[r] & bit)) rows[r] ^= rows[rank];
    rank++;
  }
  return rank;
}

function rankProbability(r, M, Q) {
  let product = 1;
  for (let i = 0; i < r; i++) product *= ((1 - 2 ** (i - Q)) * (1 - 2 ** (i - M))) / (1 - 2 ** (i - r));
  return 2 ** (r * (Q + M - r) - M * Q) * product;
}

export function matrixRank(bits) {
  const M = 32, Q = 32;
  const N = Math.floor(bits.length / (M * Q));
  const p32 = rankProbability(32, M, Q), p31 = rankProbability(31, M, Q), p30 = 1 - p32 - p31;
  let f32 = 0, f31 = 0;
  const rows = new Uint32Array(M);
  for (let k = 0; k < N; k++) {
    for (let i = 0; i < M; i++) {
      let row = 0;
      const base = k * M * Q + i * Q;
      for (let j = 0; j < Q; j++) row = (row << 1) | bits[base + j];
      rows[i] = row >>> 0;
    }
    const r = rankGF2(rows);
    if (r === 32) f32++; else if (r === 31) f31++;
  }
  const rest = N - f32 - f31;
  const chi2 = (f32 - p32 * N) ** 2 / (p32 * N) + (f31 - p31 * N) ** 2 / (p31 * N) + (rest - p30 * N) ** 2 / (p30 * N);
  return { pValues: [Math.exp(-chi2 / 2)], stats: { N, f32, f31, rest, chi2 } };
}

// 2.6 Discrete Fourier transform (spectral), with the Rev. 1a threshold and variance.
export function spectral(bits) {
  const n = bits.length;
  const x = new Float64Array(n);
  for (let i = 0; i < n; i++) x[i] = bits[i] ? 1 : -1;
  const half = Math.floor(n / 2);
  const mags = dftMagnitudes(x, half);
  const T = Math.sqrt(Math.log(1 / 0.05) * n);
  let n1 = 0;
  for (let j = 0; j < half; j++) if (mags[j] < T) n1++;
  const n0 = 0.95 * n / 2;
  const d = (n1 - n0) / Math.sqrt(n * 0.95 * 0.05 / 4);
  return { pValues: [erfc(Math.abs(d) / Math.SQRT2)], stats: { n1, n0, d } };
}

// m-bit window value starting at every position (no wraparound), MSB first.
function windowValues(bits, m) {
  const n = bits.length;
  const out = new Uint32Array(Math.max(n - m + 1, 0));
  const mask = m >= 32 ? 0xffffffff : (1 << m) - 1;
  let v = 0;
  for (let i = 0; i < n; i++) {
    v = ((v << 1) | bits[i]) & mask;
    if (i >= m - 1) out[i - m + 1] = v >>> 0;
  }
  return out;
}

// Templates of length m with no proper prefix equal to a suffix (NIST's aperiodic templates).
export function aperiodicTemplates(m) {
  const out = [];
  for (let v = 0; v < 2 ** m; v++) {
    const b = [];
    for (let i = m - 1; i >= 0; i--) b.push((v >> i) & 1);
    let bordered = false;
    for (let k = 1; k < m && !bordered; k++) {
      let same = true;
      for (let i = 0; i < k; i++) if (b[i] !== b[m - k + i]) { same = false; break; }
      bordered = same;
    }
    if (!bordered) out.push(b);
  }
  return out;
}

// 2.7 Non-overlapping template matching, one P-value per template.
export function nonOverlappingTemplate(bits, templates, N = 8) {
  const m = templates[0].length;
  const M = Math.floor(bits.length / N);
  const mu = (M - m + 1) / 2 ** m;
  const sigma2 = M * (1 / 2 ** m - (2 * m - 1) / 2 ** (2 * m));
  const win = windowValues(bits.subarray(0, N * M), m);
  const pValues = [];
  const counts = [];
  for (const t of templates) {
    const target = t.reduce((v, b) => (v << 1) | b, 0);
    let chi2 = 0;
    const w = [];
    for (let j = 0; j < N; j++) {
      let count = 0;
      const start = j * M, end = start + M - m;
      for (let i = start; i <= end;) {
        if (win[i] === target) { count++; i += m; } else i++;
      }
      w.push(count);
      chi2 += (count - mu) ** 2 / sigma2;
    }
    counts.push(w);
    pValues.push(igamc(N / 2, chi2 / 2));
  }
  return { pValues, stats: { m, N, M, mu, sigma2, counts } };
}

// 2.8 Overlapping template matching (template of m ones by default).
//
// The class probabilities pi_0..pi_K are the exact ones of the publication
// (section 3.8: 0.364091, 0.185659, 0.139381, 0.100571, 0.070432, 0.139865 for
// m = 9, M = 1032, K = 5, the values of Hamano & Kaneko). The reference code
// (sts-2.1.2) and the publication's worked example in 2.8.8 replace them with an
// older approximation; on long inputs that approximation alone makes random data
// fail (chi-square bias grows with the number of blocks: about 35% false failures
// at 10^8 bits). probabilities: 'reference' reproduces the reference code.

// Approximation used by sts-2.1.2 (Poisson-compound with eta = lambda / 2).
function overlapProbability(u, eta) {
  if (u === 0) return Math.exp(-eta);
  let sum = 0;
  for (let l = 1; l <= u; l++) {
    sum += Math.exp(-eta - u * Math.LN2 + l * Math.log(eta) - lgamma(l + 1) + lgamma(u) - lgamma(l) - lgamma(u - l + 1));
  }
  return sum;
}

// Exact P(number of overlapping occurrences of template B in M random bits = u),
// u = 0..K-1, and P(>= K): a dynamic program over the template's KMP automaton.
const overlapCache = new Map();
export function overlappingProbabilities(B, M, K) {
  const key = B.join('') + ':' + M + ':' + K;
  if (overlapCache.has(key)) return overlapCache.get(key).slice();
  const m = B.length;
  const fail = new Array(m + 1).fill(0);
  for (let i = 1, k = 0; i < m; i++) {
    while (k && B[i] !== B[k]) k = fail[k];
    if (B[i] === B[k]) k++;
    fail[i + 1] = k;
  }
  const next = [];
  for (let st = 0; st <= m; st++) {
    next.push([0, 1].map((b) => {
      let x = st;
      while (x && (x === m || B[x] !== b)) x = fail[x];
      return x < m && B[x] === b ? x + 1 : x;
    }));
  }
  let P = new Float64Array((m + 1) * (K + 1));
  P[0] = 1;
  for (let t = 0; t < M; t++) {
    const Q = new Float64Array(P.length);
    for (let st = 0; st <= m; st++) {
      for (let c = 0; c <= K; c++) {
        const v = P[st * (K + 1) + c];
        if (v === 0) continue;
        for (let b = 0; b < 2; b++) {
          const s2 = next[st][b];
          const c2 = s2 === m ? Math.min(K, c + 1) : c;
          Q[s2 * (K + 1) + c2] += v / 2;
        }
      }
    }
    P = Q;
  }
  const out = new Array(K + 1).fill(0);
  for (let st = 0; st <= m; st++) for (let c = 0; c <= K; c++) out[c] += P[st * (K + 1) + c];
  overlapCache.set(key, out);
  return out.slice();
}

export function overlappingTemplate(bits, m = 9, M = 1032, K = 5, template = null, { probabilities = 'exact' } = {}) {
  const B = template || new Array(m).fill(1);
  const target = B.reduce((v, b) => (v << 1) | b, 0);
  const N = Math.floor(bits.length / M);
  let pi;
  if (probabilities === 'reference') {
    const eta = (M - m + 1) / 2 ** m / 2;
    pi = [];
    let acc = 0;
    for (let u = 0; u < K; u++) { pi.push(overlapProbability(u, eta)); acc += pi[u]; }
    pi.push(1 - acc);
  } else {
    pi = overlappingProbabilities(B, M, K);
  }
  const nu = new Array(K + 1).fill(0);
  const win = windowValues(bits.subarray(0, N * M), m);
  for (let i = 0; i < N; i++) {
    let count = 0;
    for (let j = i * M; j <= i * M + M - m; j++) if (win[j] === target) count++;
    nu[Math.min(count, K)]++;
  }
  let chi2 = 0;
  for (let i = 0; i <= K; i++) chi2 += (nu[i] - N * pi[i]) ** 2 / (N * pi[i]);
  return { pValues: [igamc(K / 2, chi2 / 2)], stats: { N, nu, pi, chi2, probabilities } };
}

// 2.9 Maurer's universal statistical test
const UNIVERSAL_EXPECTED = [0, 0.7326495, 1.5374383, 2.4016068, 3.3112247, 4.2534266, 5.2177052, 6.1962507,
  7.1836656, 8.1764248, 9.1723243, 10.170032, 11.168765, 12.168070, 13.167693, 14.167488, 15.167379];
const UNIVERSAL_VARIANCE = [0, 0.690, 1.338, 1.901, 2.358, 2.705, 2.954, 3.125, 3.238, 3.311, 3.356, 3.384,
  3.401, 3.410, 3.416, 3.419, 3.421];
const UNIVERSAL_MIN_N = [[16, 1059061760], [15, 496435200], [14, 231669760], [13, 107560960], [12, 49643520],
  [11, 22753280], [10, 10342400], [9, 4654080], [8, 2068480], [7, 904960], [6, 387840]];

export function universalBlockLength(n) {
  for (const [L, min] of UNIVERSAL_MIN_N) if (n >= min) return L;
  return 0;
}

export function universal(bits, L = universalBlockLength(bits.length), Q = 10 * 2 ** L) {
  const K = Math.floor(bits.length / L) - Q;
  const table = new Float64Array(2 ** L);
  const block = (i) => { // 1-based block index
    let v = 0;
    const base = (i - 1) * L;
    for (let j = 0; j < L; j++) v = v * 2 + bits[base + j];
    return v;
  };
  for (let i = 1; i <= Q; i++) table[block(i)] = i;
  let sum = 0;
  for (let i = Q + 1; i <= Q + K; i++) {
    const v = block(i);
    sum += Math.log2(i - table[v]);
    table[v] = i;
  }
  const fn = sum / K;
  const c = 0.7 - 0.8 / L + (4 + 32 / L) * Math.pow(K, -3 / L) / 15;
  const sigma = c * Math.sqrt(UNIVERSAL_VARIANCE[L] / K);
  const p = erfc(Math.abs(fn - UNIVERSAL_EXPECTED[L]) / (Math.SQRT2 * sigma));
  return { pValues: [p], stats: { L, Q, K, fn, expected: UNIVERSAL_EXPECTED[L], sigma } };
}

// 2.10 Linear complexity
export function berlekampMassey(s) {
  const n = s.length;
  let b = new Uint8Array(n), c = new Uint8Array(n);
  b[0] = c[0] = 1;
  let L = 0, m = -1;
  for (let N = 0; N < n; N++) {
    let d = s[N];
    for (let i = 1; i <= L; i++) d ^= c[i] & s[N - i];
    if (d) {
      const t = c.slice();
      for (let i = 0; i + N - m < n; i++) c[i + N - m] ^= b[i];
      if (L <= N / 2) { L = N + 1 - L; m = N; b = t; }
    }
  }
  return L;
}

// pi_0 is 1/96 = 0.010417 in the publication's table, but NIST's reference code (which
// produced the published example values) uses 0.01047; we follow the code.
const LINEAR_PI = [0.01047, 0.03125, 0.125, 0.5, 0.25, 0.0625, 0.020833];

export function linearComplexity(bits, M = 500) {
  const N = Math.floor(bits.length / M);
  const sign = M % 2 === 0 ? 1 : -1; // (-1)^M
  const mu = M / 2 + (9 - sign) / 36 - (M / 3 + 2 / 9) / 2 ** M; // (9 + (-1)^(M+1))/36
  const nu = new Array(7).fill(0);
  for (let i = 0; i < N; i++) {
    const L = berlekampMassey(bits.subarray(i * M, (i + 1) * M));
    const T = sign * (L - mu) + 2 / 9;
    let k;
    if (T <= -2.5) k = 0; else if (T <= -1.5) k = 1; else if (T <= -0.5) k = 2; else if (T <= 0.5) k = 3;
    else if (T <= 1.5) k = 4; else if (T <= 2.5) k = 5; else k = 6;
    nu[k]++;
  }
  let chi2 = 0;
  for (let i = 0; i < 7; i++) chi2 += (nu[i] - N * LINEAR_PI[i]) ** 2 / (N * LINEAR_PI[i]);
  return { pValues: [igamc(3, chi2 / 2)], stats: { M, N, nu, chi2 } };
}

// Counts of every overlapping m-bit pattern, wrapping around the end (sections 2.11, 2.12).
function cyclicPatternCounts(bits, m) {
  const n = bits.length;
  const counts = new Float64Array(2 ** m);
  if (m === 0) return counts;
  const mask = 2 ** m - 1;
  let v = 0;
  for (let i = 0; i < m - 1; i++) v = (v * 2 + bits[i]) % (mask + 1);
  for (let i = 0; i < n; i++) {
    v = (v * 2 + bits[(i + m - 1) % n]) % (mask + 1);
    counts[v]++;
  }
  return counts;
}

function psi2(bits, m) {
  if (m <= 0) return 0;
  const n = bits.length;
  const counts = cyclicPatternCounts(bits, m);
  let sum = 0;
  for (let i = 0; i < counts.length; i++) sum += counts[i] * counts[i];
  return sum * 2 ** m / n - n;
}

// 2.11 Serial
export function serial(bits, m) {
  const p0 = psi2(bits, m), p1 = psi2(bits, m - 1), p2 = psi2(bits, m - 2);
  const del1 = p0 - p1, del2 = p0 - 2 * p1 + p2;
  return { pValues: [igamc(2 ** (m - 2), del1 / 2), igamc(2 ** (m - 3), del2 / 2)], stats: { m, psi2: [p0, p1, p2], del1, del2 } };
}

// 2.12 Approximate entropy
export function approximateEntropy(bits, m) {
  const n = bits.length;
  const phi = (k) => {
    if (k === 0) return 0;
    const counts = cyclicPatternCounts(bits, k);
    let s = 0;
    for (let i = 0; i < counts.length; i++) if (counts[i] > 0) { const p = counts[i] / n; s += p * Math.log(p); }
    return s;
  };
  const apEn = phi(m) - phi(m + 1);
  const chi2 = 2 * n * (Math.LN2 - apEn);
  return { pValues: [igamc(2 ** (m - 1), chi2 / 2)], stats: { m, apEn, chi2 } };
}

// 2.13 Cumulative sums. Summation bounds use C integer division, as NIST's reference code does.
function cusumP(n, z) {
  const sq = Math.sqrt(n);
  const idiv = (a, b) => Math.trunc(a / b);
  let sum1 = 0;
  for (let k = idiv(idiv(-n, z) + 1, 4); k <= idiv(idiv(n, z) - 1, 4); k++) {
    sum1 += normalCdf((4 * k + 1) * z / sq) - normalCdf((4 * k - 1) * z / sq);
  }
  let sum2 = 0;
  for (let k = idiv(idiv(-n, z) - 3, 4); k <= idiv(idiv(n, z) - 1, 4); k++) {
    sum2 += normalCdf((4 * k + 3) * z / sq) - normalCdf((4 * k + 1) * z / sq);
  }
  return 1 - sum1 + sum2;
}

export function cumulativeSums(bits) {
  const n = bits.length;
  let s = 0, zf = 0;
  for (let i = 0; i < n; i++) { s += bits[i] ? 1 : -1; zf = Math.max(zf, Math.abs(s)); }
  s = 0;
  let zr = 0;
  for (let i = n - 1; i >= 0; i--) { s += bits[i] ? 1 : -1; zr = Math.max(zr, Math.abs(s)); }
  return { pValues: [cusumP(n, zf), cusumP(n, zr)], stats: { zForward: zf, zReverse: zr } };
}

// Cycles of the random walk S' = 0, S_1, ..., S_n, 0 (sections 2.14, 2.15).
function walkCycles(bits) {
  const n = bits.length;
  let s = 0, J = 0;
  for (let i = 0; i < n; i++) { s += bits[i] ? 1 : -1; if (s === 0) J++; }
  if (s !== 0) J++;
  return J;
}

export function excursionConstraint(n) {
  return Math.max(0.005 * Math.sqrt(n), 500);
}

// 2.14 Random excursions
export const EXCURSION_STATES = [-4, -3, -2, -1, 1, 2, 3, 4];

function excursionPi(x) {
  const a = Math.abs(x), q = 1 - 1 / (2 * a);
  const pi = [q];
  for (let k = 1; k <= 4; k++) pi.push((1 / (4 * a * a)) * q ** (k - 1));
  pi.push((1 / (2 * a)) * q ** 4);
  return pi;
}

export function randomExcursions(bits) {
  const n = bits.length;
  const J = walkCycles(bits);
  const visits = new Map(EXCURSION_STATES.map((x) => [x, new Array(6).fill(0)]));
  const inCycle = new Map(EXCURSION_STATES.map((x) => [x, 0]));
  let s = 0;
  const closeCycle = () => {
    for (const x of EXCURSION_STATES) { visits.get(x)[Math.min(inCycle.get(x), 5)]++; inCycle.set(x, 0); }
  };
  for (let i = 0; i < n; i++) {
    s += bits[i] ? 1 : -1;
    if (s === 0) closeCycle();
    else if (s >= -4 && s <= 4) inCycle.set(s, inCycle.get(s) + 1);
  }
  if (s !== 0) closeCycle();
  const pValues = [], chi2 = [];
  for (const x of EXCURSION_STATES) {
    const pi = excursionPi(x), nu = visits.get(x);
    let c = 0;
    for (let k = 0; k < 6; k++) c += (nu[k] - J * pi[k]) ** 2 / (J * pi[k]);
    chi2.push(c);
    pValues.push(igamc(2.5, c / 2));
  }
  return { pValues, stats: { J, states: EXCURSION_STATES, chi2, visits: EXCURSION_STATES.map((x) => visits.get(x)) } };
}

// 2.15 Random excursions variant
export const VARIANT_STATES = [-9, -8, -7, -6, -5, -4, -3, -2, -1, 1, 2, 3, 4, 5, 6, 7, 8, 9];

export function randomExcursionsVariant(bits) {
  const n = bits.length;
  const J = walkCycles(bits);
  const xi = new Map(VARIANT_STATES.map((x) => [x, 0]));
  let s = 0;
  for (let i = 0; i < n; i++) {
    s += bits[i] ? 1 : -1;
    if (s >= -9 && s <= 9 && s !== 0) xi.set(s, xi.get(s) + 1);
  }
  const pValues = VARIANT_STATES.map((x) => erfc(Math.abs(xi.get(x) - J) / Math.sqrt(2 * J * (4 * Math.abs(x) - 2))));
  return { pValues, stats: { J, states: VARIANT_STATES, xi: VARIANT_STATES.map((x) => xi.get(x)) } };
}

// Pass rule for a test with several P-values from one sequence: the number below
// alpha must stay within the 3-sigma binomial bound NIST uses for proportions.
export function passesProportion(pValues, alpha = ALPHA) {
  const k = pValues.length;
  const failures = pValues.filter((p) => p < alpha).length;
  if (k <= 2) return failures === 0;
  const allowed = Math.floor(k * alpha + 3 * Math.sqrt(k * alpha * (1 - alpha)));
  return failures <= allowed;
}

// P(X >= k) for X ~ Binomial(n, p).
export function binomialUpperTail(k, n, p) {
  if (k <= 0) return 1;
  if (k > n) return 0;
  let sum = 0;
  for (let j = k; j <= n; j++) {
    const t = Math.exp(lgamma(n + 1) - lgamma(j + 1) - lgamma(n - j + 1) + j * Math.log(p) + (n - j) * Math.log1p(-p));
    sum += t;
    if (t < sum * 1e-17) break;
  }
  return Math.min(1, sum);
}

// Holm's step-down procedure: which P-values are rejected while keeping the chance
// of any false rejection at or below alpha, whatever the dependence between them.
export function holm(pValues, alpha = ALPHA) {
  const m = pValues.length;
  const order = pValues.map((p, i) => [p, i]).sort((a, b) => a[0] - b[0]);
  const rejected = new Array(m).fill(false);
  for (let r = 0; r < m; r++) {
    if (order[r][0] > alpha / (m - r)) break;
    rejected[order[r][1]] = true;
  }
  return rejected;
}

// One verdict for all the P-values of a run. A single sequence gives ~150-190
// P-values; at alpha = 0.01 some fall below alpha by chance in most runs of a
// perfect generator (1 - 0.99^188 = 85% if they were independent). Per-test
// results therefore get three states:
//   fail - rejected by Holm at the family level: a real defect at level alpha;
//   flag - fails NIST's per-test rule but not the family test: expected by chance
//          this often, worth a second sample, not evidence on its own;
//   pass.
// tests: [{ id, applicable, pValues, pass }]
export function assessFamily(tests, alpha = ALPHA) {
  const all = [];
  tests.forEach((t, ti) => { if (t.applicable) t.pValues.forEach((p) => all.push([p, ti])); });
  const rejected = holm(all.map((x) => x[0]), alpha);
  const rejectedTests = new Set();
  rejected.forEach((r, i) => { if (r) rejectedTests.add(all[i][1]); });
  const m = all.length;
  const below = all.filter((x) => x[0] < alpha).length;
  const statuses = tests.map((t, ti) => (!t.applicable ? 'na' : rejectedTests.has(ti) ? 'fail' : t.pass ? 'pass' : 'flag'));
  return {
    alpha, method: 'holm', pValueCount: m,
    rejected: rejected.filter(Boolean).length,
    pass: !rejected.some(Boolean),
    minP: m ? Math.min(...all.map((x) => x[0])) : null,
    belowAlpha: below, expectedBelowAlpha: m * alpha,
    // Chance of this many or more P-values below alpha if they were independent.
    belowAlphaTailP: binomialUpperTail(below, m, alpha),
    statuses,
  };
}

function testPlan(bits) {
  const n = bits.length;
  const log2n = Math.floor(Math.log2(n));
  const serialM = Math.min(16, log2n - 3);
  const apEnM = Math.min(10, log2n - 6);
  return [
    ['frequency', n >= 100, () => frequency(bits), 'n ≥ 100'],
    ['blockFrequency', n >= 100 * 128, () => blockFrequency(bits, 128), 'n ≥ 12,800 (M = 128)'],
    ['runs', n >= 100, () => runs(bits), 'n ≥ 100'],
    ['longestRun', n >= 128, () => longestRun(bits), 'n ≥ 128'],
    ['matrixRank', n >= 38 * 1024, () => matrixRank(bits), 'n ≥ 38,912'],
    ['spectral', n >= 1000, () => spectral(bits), 'n ≥ 1,000'],
    ['nonOverlappingTemplate', n >= 8 * 1032, () => nonOverlappingTemplate(bits, aperiodicTemplates(9), 8), 'n ≥ 8,256 (m = 9)'],
    ['overlappingTemplate', n >= 1000000, () => overlappingTemplate(bits), 'n ≥ 1,000,000'],
    ['universal', universalBlockLength(n) >= 6, () => universal(bits), 'n ≥ 387,840'],
    ['linearComplexity', n >= 1000000, () => linearComplexity(bits, 500), 'n ≥ 1,000,000'],
    ['serial', serialM >= 2, () => serial(bits, serialM), 'n ≥ 32'],
    ['approximateEntropy', apEnM >= 2, () => approximateEntropy(bits, apEnM), 'n ≥ 256'],
    ['cumulativeSums', n >= 100, () => cumulativeSums(bits), 'n ≥ 100'],
    ['randomExcursions', n >= 1000000, () => randomExcursions(bits), 'n ≥ 1,000,000 and J ≥ 500 cycles'],
    ['randomExcursionsVariant', n >= 1000000, () => randomExcursionsVariant(bits), 'n ≥ 1,000,000 and J ≥ 500 cycles'],
  ];
}

function runPlan(bits, alpha, onProgress) {
  const n = bits.length;
  const plan = testPlan(bits);
  const results = [];
  plan.forEach(([id, ok, run, requirement], i) => {
    onProgress(i / plan.length, id);
    if (!ok) { results.push({ id, applicable: false, requirement }); return; }
    if ((id === 'randomExcursions' || id === 'randomExcursionsVariant') && walkCycles(bits) < excursionConstraint(n)) {
      results.push({ id, applicable: false, requirement, reason: 'J < ' + excursionConstraint(n) });
      return;
    }
    const r = run();
    results.push({ id, applicable: true, pValues: r.pValues, stats: r.stats, pass: passesProportion(r.pValues, alpha) });
  });
  return results;
}

// Runs every test with NIST's recommended parameters on one sequence. Tests whose
// input-size requirements are not met are reported as not applicable instead of run.
export function runNist(bits, { alpha = ALPHA, onProgress = () => {} } = {}) {
  const results = runPlan(bits, alpha, onProgress);
  const family = assessFamily(results, alpha);
  results.forEach((r, i) => { r.status = family.statuses[i]; });
  onProgress(1, 'done');
  return { n: bits.length, alpha, results, family };
}

// Section 4.2: the input is cut into `count` sequences of `sequenceLength` bits,
// every test runs on each, and each P-value position (a "sub-test": one template,
// one excursion state...) is judged on two things across the sequences:
//   proportion - the share with P >= alpha must lie within
//                (1 - alpha) +- 3 sqrt(alpha (1 - alpha) / m)   (real bound: 97/100, not 96);
//   uniformity - chi-square of the P-values over 10 equal bins, P_T >= 0.0001,
//                assessed when m >= 55 (NIST's minimum).
// Each sub-test also gets exact P-values for both checks (binomial tail for the
// failures, P_T for uniformity) so the family verdict can use Holm like runNist.
export const TWO_LEVEL_MIN_SEQUENCES = 10;
export const UNIFORMITY_MIN_SEQUENCES = 55;

// Second-level checks for one sub-test: its P-values across m sequences.
export function secondLevel(ps, alpha = ALPHA) {
  const m = ps.length;
  const failures = ps.filter((p) => p < alpha).length;
  const proportion = (m - failures) / m;
  const lower = (1 - alpha) - 3 * Math.sqrt(alpha * (1 - alpha) / m);
  let uniformityP = null;
  if (m >= UNIFORMITY_MIN_SEQUENCES) {
    const F = new Array(10).fill(0);
    for (const p of ps) F[Math.min(9, Math.floor(p * 10))]++;
    const e = m / 10;
    uniformityP = igamc(4.5, F.reduce((a, f) => a + (f - e) ** 2 / e, 0) / 2);
  }
  return {
    m, failures, proportion, lower,
    proportionOk: proportion >= lower,
    proportionP: binomialUpperTail(failures, m, alpha),
    // Chance that a perfect generator fails the proportion rule for this m.
    proportionChance: binomialUpperTail(Math.floor((1 - lower) * m + 1e-9) + 1, m, alpha),
    uniformityP, uniformityOk: uniformityP === null ? null : uniformityP >= 0.0001,
  };
}

export function runNistMulti(bits, { sequenceLength = 1000000, alpha = ALPHA, onProgress = () => {} } = {}) {
  const count = Math.floor(bits.length / sequenceLength);
  if (count < TWO_LEVEL_MIN_SEQUENCES) {
    throw Object.assign(new Error(`two-level mode needs at least ${TWO_LEVEL_MIN_SEQUENCES} sequences of ${sequenceLength} bits`), {
      ar: `التقييم من مستويين يحتاج ${TWO_LEVEL_MIN_SEQUENCES} تسلسلات على الأقل، كل منها ${sequenceLength.toLocaleString('en-US')} بت`,
      en: `Two-level mode needs at least ${TWO_LEVEL_MIN_SEQUENCES} sequences of ${sequenceLength.toLocaleString('en-US')} bits`,
    });
  }
  const collected = new Map(); // id -> { requirement, reason, pv: [[p of sub-test k per sequence]] }
  for (let s = 0; s < count; s++) {
    const seq = bits.subarray(s * sequenceLength, (s + 1) * sequenceLength);
    const results = runPlan(seq, alpha, (f) => onProgress((s + f) / count));
    for (const r of results) {
      let c = collected.get(r.id);
      if (!c) collected.set(r.id, c = { id: r.id, requirement: r.requirement, reason: null, sequences: 0, pv: [] });
      if (!r.applicable) { c.reason = r.reason || c.reason; continue; }
      c.sequences++;
      r.pValues.forEach((p, k) => (c.pv[k] || (c.pv[k] = [])).push(p));
    }
  }
  const tests = [...collected.values()].map((c) => {
    if (!c.sequences) return { id: c.id, applicable: false, requirement: c.requirement, reason: c.reason };
    const subtests = c.pv.map((ps) => secondLevel(ps, alpha));
    const pValues = subtests.flatMap((t) => [t.proportionP, ...(t.uniformityP === null ? [] : [t.uniformityP])]);
    const pass = subtests.every((t) => t.proportionOk && t.uniformityOk !== false);
    return {
      id: c.id, applicable: true, sequences: c.sequences, subtests, pValues, pass,
      // Sub-tests that fail NIST's rule, and how many a perfect generator would fail.
      subtestsFailing: subtests.filter((t) => !t.proportionOk || t.uniformityOk === false).length,
      subtestsExpectedFailing: subtests.reduce((a, t) => a + t.proportionChance, 0),
      minProportion: Math.min(...subtests.map((t) => t.proportion)),
      minUniformityP: subtests.some((t) => t.uniformityP !== null) ? Math.min(...subtests.filter((t) => t.uniformityP !== null).map((t) => t.uniformityP)) : null,
    };
  });
  const family = assessFamily(tests, alpha);
  tests.forEach((t, i) => { t.status = family.statuses[i]; });
  onProgress(1, 'done');
  return { n: count * sequenceLength, alpha, sequenceLength, sequences: count, results: tests, family, twoLevel: true };
}

export function bitsFromString(s) {
  const out = [];
  for (const ch of s) if (ch === '0' || ch === '1') out.push(ch === '1' ? 1 : 0);
  return Uint8Array.from(out);
}

export function bitsFromBytes(bytes, nBits = bytes.length * 8) {
  const out = new Uint8Array(nBits);
  for (let i = 0; i < nBits; i++) out[i] = (bytes[i >> 3] >> (7 - (i & 7))) & 1;
  return out;
}

// The session funnel (player protection): what n paid rounds at a flat bet cost,
// computed from the exact whole-round win distribution (round-dist.js). It describes
// a session; it does not suggest bet sizes or when to stop, and no stopping rule
// changes the expected loss.
//
//  * Net result after n rounds: the n-fold sum of the round's win by FFT, the
//    spectrum raised to the power n by repeated squaring, on a grid long enough that
//    the wrapped mass is below 1e-13 (Chernoff bound); negative rounding noise is
//    clipped and the result renormalized. From it: percentiles 5/25/50/75/95, the
//    median, P(finish ahead). Too large a grid: seeded Monte Carlo (alias table,
//    labeled), with standard errors.
//  * P(the budget runs out within the n rounds): path dependent. "Runs out" = what is
//    left is less than one bet (another round cannot be paid). Dynamic programming
//    over the bankroll with absorbing ruin (a bankroll that can no longer reach it in
//    the rounds left is dropped as safe) for moderate sizes, else the same seeded
//    Monte Carlo.
//  * Expected loss n * bet * (1 - RTP), exact; N* = (z sigma / edge)^2 with
//    z = 1.645: by the normal approximation (labeled), after about N* rounds the
//    chance of being ahead is below 5%.
// Wins are on the round pmf's lattice: x steps = x * a / b bets (pmf.unitBets = a/b);
// the bankroll uses steps of 1/b bet, so a win is x * a and a bet is b.
import { Fraction } from './fraction.js';
import { Fft, nextPowerOfTwo } from './fft.js';
import { normalCdf } from './specfun.js';
import { uniform01 } from './audit-stats.js';

export const SESSION_GRID_LIMIT = 2 ** 21;
export const SESSION_PERCENTILES = [0.05, 0.25, 0.5, 0.75, 0.95];
export const N_STAR_Z = 1.645;
export const MAX_SESSION_ROUNDS = 1000000;
const WRAP_TARGET = 1e-13;
const RUIN_WORK_LIMIT = 4e8;
const MC_DRAWS = 4e7;

const fail = (en, ar) => Object.assign(new Error(en), { ar, en });
const SAFE = 9007199254740991n;

function lse(values) {
  let m = -Infinity;
  for (const v of values) if (v > m) m = v;
  if (!Number.isFinite(m)) return m;
  let s = 0;
  for (const v of values) s += Math.exp(v - m);
  return m + Math.log(s);
}

// The round pmf as arrays: steps xs (sorted, merged), probabilities ps (sum 1), and
// a/b = bets per step.
export function sessionInputs(pmf) {
  const merged = new Map();
  for (const e of pmf.entries) {
    if (!(e.p > 0)) continue;
    merged.set(e.units, (merged.get(e.units) || 0) + e.p);
  }
  const xs = [...merged.keys()].sort((a, b) => a - b);
  let total = 0;
  for (const x of xs) total += merged.get(x);
  if (!(total > 0)) throw fail('the round distribution is empty', 'توزيع الجولة فارغ');
  const [a, b] = String(pmf.unitBets).split('/').map((s) => BigInt(s));
  return {
    xs: Float64Array.from(xs), ps: Float64Array.from(xs, (x) => merged.get(x) / total),
    a: a, b: b === undefined ? 1n : b, mass: total, droppedMass: pmf.droppedMass || 0,
  };
}

// Vose's alias method: O(1) draws from a discrete distribution.
export function aliasTable(ps) {
  const K = ps.length;
  const prob = new Float64Array(K), alias = new Int32Array(K);
  let total = 0;
  for (const p of ps) total += p;
  const scaled = Float64Array.from(ps, (p) => (p * K) / total);
  const small = [], large = [];
  scaled.forEach((v, i) => (v < 1 ? small : large).push(i));
  while (small.length && large.length) {
    const s = small.pop(), l = large.pop();
    prob[s] = scaled[s]; alias[s] = l;
    scaled[l] = scaled[l] + scaled[s] - 1;
    (scaled[l] < 1 ? small : large).push(l);
  }
  for (const i of [...small, ...large]) { prob[i] = 1; alias[i] = i; }
  return { K, prob, alias, draw: (rng) => { const c = rng.nextBelow(K); return uniform01(rng) < prob[c] ? c : alias[c]; } };
}

let PR = 0, PI = 0;
function powC(zr, zi, n) {
  let rr = 1, ri = 0, br = zr, bi = zi;
  while (n > 0) {
    if (n & 1) { const t = rr * br - ri * bi; ri = rr * bi + ri * br; rr = t; }
    n = Math.floor(n / 2);
    if (n) { const t = br * br - bi * bi; bi = 2 * br * bi; br = t; }
  }
  PR = rr; PI = ri;
}

// Grid length L with P(sum of n rounds >= L) <= target (Chernoff), at most n * max + 1.
function sumGrid(xs, ps, n, target = WRAP_TARGET) {
  const K = xs[xs.length - 1];
  const exact = n * K + 1;
  if (K === 0) return { L: 1, bound: 0 };
  const lp = Array.from(ps, Math.log);
  const table = [];
  for (let j = 0; j <= 200; j++) {
    const th = (40 / K) * 2 ** (-j / 4);
    table.push({ th, logM: lse(Array.from(xs, (x, i) => lp[i] + th * x)) });
  }
  // P(S >= L) <= M(theta)^n e^{-theta L}: the smallest L that reaches the target.
  let need = Infinity;
  for (const { th, logM } of table) need = Math.min(need, (n * logM - Math.log(target)) / th);
  const L = Math.min(exact, Math.ceil(need) + 1);
  let bound = 0; // the bound actually reached at L (0: nothing can wrap)
  if (L < exact) {
    bound = Infinity;
    for (const { th, logM } of table) bound = Math.min(bound, Math.exp(n * logM - th * L));
  }
  return { L, bound };
}

// Distribution of the sum of n rounds (in steps) by FFT powering, or null when the
// grid would pass `limit`.
export function sumDistribution(xs, ps, n, { limit = SESSION_GRID_LIMIT } = {}) {
  const g = sumGrid(xs, ps, n);
  const N = nextPowerOfTwo(Math.max(2, g.L));
  if (N > limit) return null;
  const fft = new Fft(N);
  const re = new Float64Array(N), im = new Float64Array(N);
  for (let i = 0; i < xs.length; i++) re[xs[i] % N] += ps[i];
  fft.forward(re, im);
  const H = N / 2;
  for (let k = 0; k <= H; k++) { powC(re[k], im[k], n); re[k] = PR; im[k] = PI; }
  for (let k = H + 1; k < N; k++) { re[k] = re[N - k]; im[k] = -im[N - k]; }
  fft.inverse(re, im);
  let clipped = 0, total = 0;
  for (let s = 0; s < N; s++) {
    if (re[s] < 0) { clipped -= re[s]; re[s] = 0; }
    total += re[s];
  }
  for (let s = 0; s < N; s++) re[s] /= total;
  return { q: re, N, wrapBound: g.bound, clipped, renormalizedFrom: total };
}

// P(the bankroll falls below one bet within n rounds), by DP over the bankroll in
// steps of 1/b bet (win x * a, bet b), starting from `start` steps. null when the
// work would pass `maxWork`.
export function ruinProbability(xs, ps, a, b, n, start, { maxWork = RUIN_WORK_LIMIT } = {}) {
  const A = Number(a), B = Number(b);
  if (start < B) return { p: 1, method: 'dp' };
  if (start >= (n + 1) * B) return { p: 0, method: 'dp' };
  const top = (n + 1) * B; // at or above: can never run out in the rounds left
  // Win sizes in bankroll steps; wins at or above `top` always end safe.
  const wins = [];
  let big = 0;
  for (let i = 0; i < xs.length; i++) {
    const w = xs[i] * A;
    if (w >= top) big += ps[i]; else wins.push([w, ps[i]]);
  }
  const P = wins.length ? wins[wins.length - 1][0] + 1 : 1;
  const size = nextPowerOfTwo(top + P);
  const fftWork = n * 2 * size * Math.log2(size) * 3;
  const directWork = n * top * wins.length;
  if (Math.min(fftWork, directWork) > maxWork) return null;
  let dist = new Float64Array(top); // dist[y] for bankroll y in [B, H)
  dist[start] = 1;
  let ruin = 0, H = top;
  let fft = null, wr = null, wi = null;
  if (fftWork < directWork) {
    fft = new Fft(size);
    wr = new Float64Array(size); wi = new Float64Array(size);
    for (const [w, p] of wins) wr[w] += p;
    fft.forward(wr, wi);
  }
  for (let r = n; r >= 1; r--) {
    // before this round r rounds are left and the bankroll is in [B, (r + 1) B);
    // after it r - 1 are left: below B is ruin, at or above r B is safe.
    const Hafter = r * B;
    const next = new Float64Array(Hafter);
    let c;
    if (fft) {
      const re = new Float64Array(size), im = new Float64Array(size);
      for (let y = B; y < H; y++) re[y] = dist[y];
      fft.forward(re, im);
      for (let k = 0; k < size; k++) { const t = re[k] * wr[k] - im[k] * wi[k]; im[k] = re[k] * wi[k] + im[k] * wr[k]; re[k] = t; }
      fft.inverse(re, im);
      c = re; // c[j] = mass at bankroll j - B after paying the bet
      for (let z = 0; z < B; z++) ruin += Math.max(0, c[z + B]);
      for (let z = B; z < Hafter; z++) next[z] = Math.max(0, c[z + B]);
    } else {
      for (let y = B; y < H; y++) {
        const m = dist[y];
        if (!m) continue;
        for (const [w, p] of wins) {
          const z = y - B + w;
          if (z >= Hafter) break;
          if (z < B) ruin += m * p; else next[z] += m * p;
        }
      }
    }
    dist = next; H = Hafter;
  }
  return { p: Math.min(1, Math.max(0, ruin)), method: 'dp', bigWinShare: big };
}

// Seeded Monte Carlo of `sessions` sessions of n rounds; S in bankroll steps.
function monteCarlo(inp, n, start, rng, { sessions } = {}) {
  const A = Number(inp.a), B = Number(inp.b);
  const m = sessions ?? Math.max(2000, Math.min(20000, Math.floor(MC_DRAWS / n)));
  const table = aliasTable(inp.ps);
  const finals = new Float64Array(m);
  let ruined = 0;
  for (let s = 0; s < m; s++) {
    let S = 0, dead = false;
    for (let j = 1; j <= n; j++) {
      S += inp.xs[table.draw(rng)] * A;
      if (!dead && start !== null && start + S - j * B < B) dead = true;
    }
    finals[s] = S;
    if (dead) ruined++;
  }
  return { finals, ruined, sessions: m };
}

const se = (p, m) => Math.sqrt(Math.max(p * (1 - p), 0) / m);

// opts: { rounds, budget (bets, number or decimal string; null = no ruin figure),
//         rtp (fraction string), sd (bets), rng (seeded; needed for Monte Carlo),
//         seed (recorded), limit, forceMonteCarlo }
export function sessionFunnel(pmf, opts) {
  const n = Number(opts.rounds);
  if (!Number.isInteger(n) || n < 1 || n > MAX_SESSION_ROUNDS) {
    throw fail(`the number of rounds must be a whole number from 1 to ${MAX_SESSION_ROUNDS.toLocaleString('en-US')}`, `عدد الجولات يجب أن يكون عددًا صحيحًا من 1 إلى ${MAX_SESSION_ROUNDS.toLocaleString('en-US')}`);
  }
  const inp = sessionInputs(pmf);
  const rtp = Fraction.of(opts.rtp && String(opts.rtp).includes('/') ? new Fraction(...String(opts.rtp).split('/').map(BigInt)) : opts.rtp);
  const edge = new Fraction(1n).sub(rtp);
  const sd = Number(opts.sd);
  const A = inp.a, B = inp.b;
  if (A > SAFE || B > SAFE) throw fail('the lattice is too fine for a session', 'الشبكة أدق من أن تُحسب بها جلسة');
  let start = null;
  if (opts.budget !== null && opts.budget !== undefined && String(opts.budget).trim() !== '') {
    const bud = Fraction.of(String(opts.budget).trim());
    if (!(bud.cmp(0) > 0)) throw fail('the budget must be a positive number', 'يجب أن تكون الميزانية عددًا موجبًا');
    const f = bud.mul(B); // budget in steps of 1/b bet, rounded down (exact for "runs out")
    const steps = f.num / f.den;
    start = steps > BigInt((n + 2) * Number(B)) ? (n + 2) * Number(B) : Number(steps);
  }
  const out = {
    rounds: n, budget: opts.budget ?? null, seed: opts.seed ?? null,
    expectedLoss: { value: edge.mul(n).toNumber(), fraction: edge.mul(n).toString() }, // in bets
    mean: rtp.sub(1).mul(n).toNumber(),
    droppedMass: inp.droppedMass, mass: inp.mass,
  };
  // N* and the normal approximation (labeled as such).
  const e = edge.toNumber();
  out.nStar = e > 0 && sd > 0 ? { z: N_STAR_Z, rounds: Math.ceil((N_STAR_Z * sd / e) ** 2) } : null;
  out.normal = sd > 0 ? { pAhead: normalCdf(-Math.sqrt(n) * e / sd) } : null;

  const toNet = (S) => S / Number(B) - n; // S in bankroll steps
  const sums = opts.forceMonteCarlo ? null : sumDistribution(inp.xs, inp.ps, n, { limit: opts.limit ?? SESSION_GRID_LIMIT });
  let mc = null;
  if (sums) {
    const q = sums.q;
    let ahead = 0, even = 0, acc = 0, pi = 0;
    const pct = [];
    const nb = BigInt(n) * B;
    for (let s = 0; s < sums.N; s++) {
      const v = BigInt(s) * A; // bankroll steps won
      if (v > nb) ahead += q[s]; else if (v === nb) even += q[s];
      acc += q[s];
      while (pi < SESSION_PERCENTILES.length && acc >= SESSION_PERCENTILES[pi] * (1 - 1e-12)) pct.push({ q: SESSION_PERCENTILES[pi++], net: toNet(s * Number(A)) });
    }
    Object.assign(out, {
      method: 'fft', pAhead: ahead, pEven: even, percentiles: pct, median: pct.find((x) => x.q === 0.5).net,
      grid: { size: sums.N, wrapBound: sums.wrapBound, clipped: sums.clipped, renormalizedFrom: sums.renormalizedFrom },
    });
  } else {
    if (!opts.rng) throw fail('a seeded generator is needed for Monte Carlo', 'يلزم مولّد ببذرة لمونت كارلو');
    mc = monteCarlo(inp, n, start, opts.rng);
    const f = mc.finals.slice().sort();
    const nb = n * Number(B);
    let ahead = 0, even = 0;
    for (const S of f) { if (S > nb) ahead++; else if (S === nb) even++; }
    const m = mc.sessions;
    const at = (q) => f[Math.min(m - 1, Math.max(0, Math.ceil(q * m) - 1))];
    const pct = SESSION_PERCENTILES.map((q) => ({ q, net: toNet(at(q)) }));
    Object.assign(out, {
      method: 'mc', sessions: m, generator: 'xoshiro128** (seeded), Vose alias table',
      pAhead: ahead / m, pAheadSe: se(ahead / m, m), pEven: even / m, percentiles: pct, median: pct.find((x) => x.q === 0.5).net,
    });
  }
  // Ruin.
  if (start !== null) {
    const dp = opts.forceMonteCarlo ? null : ruinProbability(inp.xs, inp.ps, A, B, n, start);
    if (dp) out.ruin = { p: dp.p, method: 'dp', startSteps: start };
    else {
      if (!mc) {
        if (!opts.rng) throw fail('a seeded generator is needed for Monte Carlo', 'يلزم مولّد ببذرة لمونت كارلو');
        mc = monteCarlo(inp, n, start, opts.rng);
        out.sessions = mc.sessions;
        out.generator = 'xoshiro128** (seeded), Vose alias table';
      }
      out.ruin = { p: mc.ruined / mc.sessions, se: se(mc.ruined / mc.sessions, mc.sessions), method: 'mc', startSteps: start, sessions: mc.sessions };
    }
  } else out.ruin = null;
  return out;
}

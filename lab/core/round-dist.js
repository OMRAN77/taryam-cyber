// The whole-round win distribution of a slot: the paid spin plus every free spin it
// leads to, with retriggers, optional caps on the free spins, and what it says about
// big wins and max-win caps.
//
// Input is only the per-spin outcome lists that the exact engine builds (entries
// { lineWin, scat, count }, one list for the base reels and one for the free-spin
// reels) together with model.scatterPays and model.freeSpins, so any evaluation that
// produces such entries (lines, ways, ...) gets the same distribution.
//
// Lattice. Every win is a whole number of model units (line bet / scale); a free
// spin pays its units times the multiplier p/q (a Fraction). Counting in steps of
// G/q units, G the gcd of every base win * q and every free-spin win * p, puts every
// round's win on the integers 0, 1, 2, ... exactly.
//
// Free spins (Fourier). On a grid of N points, with A(t) and B_j(t) the transforms of
// one free spin's win split by whether it retriggers (B_j: awards F_j more spins),
// the transform phi of "one free spin plus all the spins it leads to" solves
//     phi = A + sum_j B_j phi^{F_j}.
// The map is a contraction of the unit disk with constant c = sum_j F_j P(J = j) < 1,
// so its fixed point there is unique: it is the limit of the trees cut at depth n,
// i.e. the right root (the one continuous with the no-retrigger case phi = A). It is
// found per frequency by Newton steps started from the neighbouring frequency (plain
// iteration as a fall-back) and verified: residual |phi - T(phi)| small, |phi| <= 1,
// error <= residual / (1 - c). The feature total for F0 spins is phi^F0; the round
// mixes the base spins: a spin that does not trigger contributes its own win (exact
// BigInt counts), a trigger spin its win plus the feature total, and an inverse FFT
// gives the trigger rounds' pmf. Without retrigger phi = A (an F0-fold convolution).
//
// Caps on total free spins or on retriggers break the independent branching, so the
// feature is a walk over states (spins left, spins awarded, retriggers used). Every
// step lowers "spins that can still be played", so the states form a DAG that is
// swept once: forward with spectra for the pmf, backward in exact integers for the
// mean and second moment (slot-exact.js uses these for the RTP).
//
// Precision. The grid wraps: mass at or beyond N lands on (W mod N). The grid is
// doubled until a Chernoff bound on that mass (from the moment generating function,
// a real fixed point checked to be an upper bound) is below 1e-15 and its effect on
// the mean and variance below 1e-12 of them; the bound is reported. Floating-point
// noise of the transform is estimated from the output (negative cells, imaginary
// parts) plus the solver's error bound; probabilities below the noise floor
// (at least 1e-13) are never shown as computed values: they come from an exact sparse
// BigInt enumeration when the feature is bounded and the enumeration small, or are
// shown as "< bound". Mass, mean and variance must match the closed forms of
// slot-exact.js to 1e-9 (relative), or the computation fails loudly.
//
// Size guard: at most GRID_LIMIT = 2^21 lattice points (about 32 MB per complex
// transform in a browser worker); a bigger lattice is left to Monte Carlo.
import { Fraction } from './fraction.js';
import { Fft, nextPowerOfTwo } from './fft.js';

export const GRID_LIMIT = 2 ** 21;
export const FLOOR_MIN = 1e-13;
export const ALIAS_TARGET = 1e-15;
const MOMENT_TARGET = 1e-12;
export const CHECK_TOLERANCE = 1e-9;
export const BIG_WINS = [100, 1000, 5000, 10000];
export const QUANTILES = [0.5, 0.75, 0.9, 0.95, 0.99, 0.999, 0.9999];
// Top-award odds rules (unverified against the primary texts; see README):
// GLI-19 v3.0 4.7.3 "at least once in 100,000,000 games" and 58 Pa. Code 461a.7
// "odds of any winning combination may not exceed 50 million to 1".
export const GLI19_ONE_IN = 100000000;
export const PA_ODDS_TO_ONE = 50000000;
export const CAP_STATE_LIMIT = 50000;
const CAP_BIGINT_BYTES = 128 * 2 ** 20;
const CAP_WORK_LIMIT = 6e8; // complex multiply-adds in the capped transform sweep
const CAP_MEMORY_LIMIT = 384 * 2 ** 20; // bytes of spectra alive at once in that sweep
const EXACT_TAIL_LIMIT = 200000; // (state, partial sum) pairs an exact tail may keep
const SAFE = 9007199254740991n;

const fail = (en, ar, extra = {}) => Object.assign(new Error(en), { ar, en, ...extra });
const tooLarge = (en, ar) => fail(en, ar, { tooLarge: true });

function bgcd(a, b) {
  a = a < 0n ? -a : a; b = b < 0n ? -b : b;
  while (b) [a, b] = [b, a % b];
  return a;
}
const big = (c) => (typeof c === 'bigint' ? c : BigInt(c));
// count / total as the nearest double, also when they pass 2^53.
export function ratio(c, t) {
  c = big(c); t = big(t);
  if (c <= SAFE && t <= SAFE) return Number(c) / Number(t);
  return new Fraction(c, t).toNumber();
}
export function parseFraction(s) {
  if (s instanceof Fraction) return s;
  const [n, d] = String(s).split('/');
  return new Fraction(BigInt(n), BigInt(d || '1'));
}
const ceilFrac = (f) => (f.num >= 0n ? (f.num + f.den - 1n) / f.den : -((-f.num) / f.den));
function lse(values) {
  let m = -Infinity;
  for (const v of values) if (v > m) m = v;
  if (m === -Infinity || m === Infinity) return m;
  let s = 0;
  for (const v of values) s += Math.exp(v - m);
  return m + Math.log(s);
}

// Spins a trigger or a retrigger awards for a spin with `scat` scatters. The model
// awards fs.spins for both; one that awarded different counts by scatter count would
// return them here (the engine below takes any list of awards: phi = A + sum B_j phi^F_j).
const awardOf = (fs, scat) => (scat >= fs.trigger ? fs.spins : 0);
export const hasCaps = (fs) => Boolean(fs && fs.retrigger && ((fs.maxSpins ?? null) !== null || (fs.maxRetriggers ?? null) !== null));

// ---------- capped features: the state graph and its exact sweeps ----------

// States (r spins left, t spins awarded so far including the start, k retriggers).
// A retrigger awarding F adds min(F, maxSpins - t) spins while k < maxRetriggers and
// t < maxSpins; otherwise the spin still pays but adds nothing. level = spins that can
// still be played at most; every step lowers it, so sorting by level orders the DAG.
export function capGraph(fs, f0, awards, limit = CAP_STATE_LIMIT) {
  const S = fs.maxSpins ?? Infinity, R = fs.maxRetriggers ?? Infinity;
  const fmax = awards.length ? Math.max(...awards) : 0;
  const level = (r, t, k) => r + Math.min(S - t, (R - k) * fmax);
  const states = new Map(), queue = [];
  const add = (r, t, k) => {
    const id = r + ',' + t + ',' + k;
    let s = states.get(id);
    if (!s) {
      if (states.size >= limit) {
        throw tooLarge(`the free-spin caps give more than ${limit.toLocaleString('en-US')} feature states`,
          `حدود اللفات المجانية تعطي أكثر من ${limit.toLocaleString('en-US')} حالة للميزة`);
      }
      s = { id, r, t, k, level: level(r, t, k), n0: null, n1: null };
      states.set(id, s);
      queue.push(s);
    }
    return s;
  };
  const start = add(f0, f0, 0);
  while (queue.length) {
    const s = queue.pop();
    if (s.r === 0) continue;
    s.n0 = add(s.r - 1, s.t, s.k);
    s.n1 = awards.map((F) => {
      const a = s.k < R && s.t < S ? Math.min(F, S - s.t) : 0;
      return a > 0 ? add(s.r - 1 + a, s.t + a, s.k + 1) : s.n0;
    });
  }
  const ascending = [...states.values()].sort((a, b) => a.level - b.level);
  return { start, states, ascending, maxLevel: start.level, maxSpins: Math.max(...ascending.map((s) => s.t)) };
}

// Exact expected number of spins and, with sums, the first two moments of the
// feature total in raw units (before the multiplier) for a capped feature started
// with fs.spins spins. D: total weight of the free-spin combinations; c1: weight of
// those that retrigger; sums: { sx, sx2, sxj } = sum of count * win, count * win^2,
// and count * win over the retriggering ones (BigInt). Values are kept as integers
// over D^level (no gcd), since every step goes at least one level down.
export function cappedFeature(fs, { D, c1, sums = null }) {
  D = big(D); c1 = big(c1);
  const g = capGraph(fs, fs.spins, [fs.spins]);
  const bits = D.toString(2).length;
  let bytes = 0;
  for (const s of g.ascending) bytes += (s.level * bits * (sums ? 3 : 1)) / 8;
  if (bytes > CAP_BIGINT_BYTES) {
    throw tooLarge('the free-spin caps are too large for the exact computation', 'حدود اللفات المجانية أكبر من أن تُحسب بدقة');
  }
  const pow = [1n];
  for (let i = 1; i <= g.maxLevel; i++) pow.push(pow[i - 1] * D);
  const c0 = D - c1;
  const sc = (v, from, to) => v * pow[from.level - 1 - to.level];
  for (const s of g.ascending) {
    if (s.r === 0) { s.N = 0n; s.Z1 = 0n; s.Z2 = 0n; continue; }
    const L = s.level, a = s.n0, b = s.n1[0];
    s.N = pow[L] + c0 * sc(a.N, s, a) + c1 * sc(b.N, s, b);
    if (sums) {
      s.Z1 = sums.sx * pow[L - 1] + c0 * sc(a.Z1, s, a) + c1 * sc(b.Z1, s, b);
      s.Z2 = sums.sx2 * pow[L - 1] + 2n * ((sums.sx - sums.sxj) * sc(a.Z1, s, a) + sums.sxj * sc(b.Z1, s, b))
        + c0 * sc(a.Z2, s, a) + c1 * sc(b.Z2, s, b);
    }
  }
  const st = g.start, den = pow[st.level];
  return {
    states: g.states.size, maxSpins: g.maxSpins,
    expectedSpins: new Fraction(st.N, den),
    ez: sums ? new Fraction(st.Z1, den) : null,
    ez2: sums ? new Fraction(st.Z2, den) : null,
  };
}

// Largest feature total (raw units) of a capped feature: max-plus over the graph.
// x0max / x1max: the largest win of a spin that does not / does retrigger
// (-Infinity when no spin of that kind exists).
export function cappedMaxFeature(fs, x0max, x1max) {
  const g = capGraph(fs, fs.spins, [fs.spins]);
  for (const s of g.ascending) {
    if (s.r === 0) { s.best = 0; continue; }
    const b = s.n1[0];
    s.best = Math.max(x0max + s.n0.best, x1max + b.best);
  }
  return g.start.best;
}

// ---------- lattice and spin classes ----------

function prepare(model, spins) {
  const fs = model.freeSpins;
  const m = fs ? fs.multiplier : new Fraction(1n);
  const p = m.num, q = m.den;
  const baseMap = new Map(), freeMap = new Map();
  for (const e of spins.base.entries) {
    const win = e.lineWin + model.scatterPays[e.scat];
    const f0 = fs ? awardOf(fs, e.scat) : 0;
    const key = win + ',' + f0;
    const c = baseMap.get(key);
    if (c) c.count += big(e.count); else baseMap.set(key, { win, f0, count: big(e.count) });
  }
  if (fs && spins.free) {
    for (const e of spins.free.entries) {
      const win = e.lineWin + model.scatterPays[e.scat];
      const award = fs.retrigger ? awardOf(fs, e.scat) : 0;
      const key = win + ',' + award;
      const c = freeMap.get(key);
      if (c) c.count += big(e.count); else freeMap.set(key, { win, award, count: big(e.count) });
    }
  }
  const base = [...baseMap.values()].filter((c) => c.count > 0n), free = [...freeMap.values()].filter((c) => c.count > 0n);
  let G = 0n;
  for (const c of base) if (c.win) G = bgcd(G, BigInt(c.win) * q);
  for (const c of free) if (c.win) G = bgcd(G, BigInt(c.win) * p);
  if (!G) G = q;
  const index = (v) => {
    if (v % G !== 0n) throw new Error('internal: lattice');
    const x = v / G;
    if (x > SAFE) throw tooLarge('the wins are too far apart for one lattice', 'الأرباح متباعدة جدًا على شبكة واحدة');
    return Number(x);
  };
  const baseTotal = big(spins.base.total);
  const freeTotal = spins.free ? big(spins.free.total) : 1n;
  base.forEach((c) => { c.x = index(BigInt(c.win) * q); c.p = ratio(c.count, baseTotal); });
  free.forEach((c) => { c.x = index(BigInt(c.win) * p); c.p = ratio(c.count, freeTotal); });
  const bet = BigInt(model.totalBetUnits);
  return {
    model, fs, base, free, baseTotal, freeTotal, multiplier: m,
    unit: new Fraction(G, q), // model units per lattice step
    perBet: new Fraction(bet * q, G), // lattice steps per bet
    nonTrig: base.filter((c) => !c.f0), trig: base.filter((c) => c.f0),
  };
}

// ---------- moment generating function (Chernoff bounds) ----------

// log E[e^{theta X}; class] for classes [{x, lp}].
function logMgf(list, theta) {
  return lse(list.map((c) => c.lp + theta * c.x));
}

// log of the feature's MGF per spin tree: the least fixed point of
// psi = a + sum_j b_j psi^F_j, as an upper bound: after the increasing iteration from
// psi = 1 (trees cut at depth n) settles, psi_u = psi (1 + margin) with T(psi_u) <=
// psi_u is checked, which bounds the least fixed point by psi_u (T is increasing).
function featureLogPsi(la, lbs) {
  let L = 0, converged = false;
  const T = (v) => lse([la, ...lbs.map((b) => b.lb + b.F * v)]);
  for (let it = 0; it < 20000; it++) {
    const n = T(L);
    if (!(n < 1e6)) return Infinity;
    if (Math.abs(n - L) <= 1e-15 * Math.max(1, Math.abs(n))) { L = n; converged = true; break; }
    L = n;
  }
  if (!converged) return Infinity;
  for (const margin of [1e-12, 1e-9, 1e-6, 1e-3]) {
    const u = L + margin * Math.max(1, Math.abs(L));
    if (T(u) <= u) return u;
  }
  return Infinity;
}

// Capped feature MGF: an exact sweep over the state graph (no fixed point).
function cappedLogPsi(graph, la, lbs) {
  const lb = lbs.length ? lbs[0].lb : -Infinity;
  for (const s of graph.ascending) {
    if (s.r === 0) { s.lpsi = 0; continue; }
    s.lpsi = lse([la + s.n0.lpsi, lb + s.n1[0].lpsi]);
  }
  return graph.start.lpsi;
}

// Table of log M(theta) for the trigger rounds and for every round, on a geometric
// grid of theta (per lattice step). Infinite values are dropped.
function mgfTable(ctx, graph) {
  const lp = (c) => { c.lp = Math.log(c.p); return c; };
  const free0 = ctx.free.filter((c) => !c.award).map(lp);
  const awards = [...new Set(ctx.free.filter((c) => c.award).map((c) => c.award))];
  const freeB = awards.map((F) => ({ F, list: ctx.free.filter((c) => c.award === F).map(lp) }));
  const trigByF0 = new Map();
  for (const c of ctx.trig) { lp(c); if (!trigByF0.has(c.f0)) trigByF0.set(c.f0, []); trigByF0.get(c.f0).push(c); }
  const non = ctx.nonTrig.map(lp);
  let xs = 1;
  for (const c of [...ctx.free, ...ctx.base]) xs = Math.max(xs, c.x);
  const out = [];
  for (let j = 0; j <= 160; j++) {
    const theta = (40 / xs) * 2 ** (-j / 4);
    const la = logMgf(free0, theta);
    const lbs = freeB.map((b) => ({ F: b.F, lb: logMgf(b.list, theta) }));
    const lpsi = graph ? cappedLogPsi(graph, la, lbs) : featureLogPsi(la, lbs);
    if (!Number.isFinite(lpsi)) continue;
    const parts = [...trigByF0].map(([f0, list]) => logMgf(list, theta) + f0 * lpsi);
    const logT = lse(parts);
    const logAll = lse([logT, logMgf(non, theta)]);
    if (Number.isFinite(logAll)) out.push({ theta, logT, logM: logAll });
  }
  return out;
}

// Bounds at lattice point x from a table (key: 'logT' trigger rounds, 'logM' all):
// p0 >= P(W >= x), e1 >= E[W; W >= x], e2 >= E[W^2; W >= x], ex >= E[(W - x)+].
export function tailBounds(table, x, key = 'logM') {
  let p0 = Infinity, e1 = Infinity, e2 = Infinity, ex = Infinity;
  const supLog = (k, th) => (th * x >= k ? k * Math.log(x) - th * x : k * (Math.log(k) - Math.log(th)) - k);
  for (const row of table) {
    const l = row[key], th = row.theta;
    if (!Number.isFinite(l)) continue;
    p0 = Math.min(p0, Math.exp(l - th * x));
    e1 = Math.min(e1, Math.exp(l + supLog(1, th)));
    e2 = Math.min(e2, Math.exp(l + supLog(2, th)));
    ex = Math.min(ex, Math.exp(l - th * x - 1) / th);
  }
  return { p0: Math.min(1, p0), e1, e2, ex };
}

// ---------- the feature transform on the grid ----------

let PR = 0, PI = 0; // result of powC (no allocation in the hot loops)
function powC(zr, zi, n) {
  let rr = 1, ri = 0, br = zr, bi = zi;
  while (n > 0) {
    if (n & 1) { const t = rr * br - ri * bi; ri = rr * bi + ri * br; rr = t; }
    n >>= 1;
    if (n) { const t = br * br - bi * bi; bi = 2 * br * bi; br = t; }
  }
  PR = rr; PI = ri;
}

// Half spectrum (k = 0..N/2) of a lattice pmf given as classes {x, p}.
function halfSpectrum(fft, N, list) {
  const re = new Float64Array(N), im = new Float64Array(N);
  // A value at or past N wraps, like the sums it takes part in (the aliasing bound covers it).
  for (const c of list) re[c.x % N] += c.p;
  fft.forward(re, im);
  const H = N / 2 + 1;
  return { re: re.slice(0, H), im: im.slice(0, H) };
}

// phi_k for every frequency: the fixed point in the unit disk of A + sum B_j phi^F_j.
// Newton steps from the previous frequency's root; a Newton step that leaves the disk
// or raises the residual is replaced by the contraction step T(z) from the last
// accepted point, which always gains (error times c), so the loop cannot cycle.
const TOL = 1e-14;
function solvePhi(A, Bs, c, H, onProgress) {
  const re = new Float64Array(H), im = new Float64Array(H);
  let zr = 1, zi = 0, maxRes = 0, maxIt = 0;
  for (let k = 0; k < H; k++) {
    const ar = A.re[k], ai = A.im[k];
    let res = Infinity, prev = Infinity, it = 0, last = 'start', keepTr = 0, keepTi = 0;
    for (; it < 5000; it++) {
      let tr = ar, ti = ai, dr = 0, di = 0;
      for (const b of Bs) {
        powC(zr, zi, b.F - 1);
        const pr = PR, pi = PI;
        const fr = pr * zr - pi * zi, fi = pr * zi + pi * zr;
        const br = b.re[k], bi = b.im[k];
        tr += br * fr - bi * fi; ti += br * fi + bi * fr;
        dr += b.F * (br * pr - bi * pi); di += b.F * (br * pi + bi * pr);
      }
      const gr = zr - tr, gi = zi - ti;
      res = Math.hypot(gr, gi);
      if (last === 'newton' && res > prev) { zr = keepTr; zi = keepTi; last = 'fixed'; continue; }
      if (res <= TOL && (res === 0 || res > 0.25 * prev)) break; // converged, at rounding level
      prev = res; keepTr = tr; keepTi = ti;
      const hr = 1 - dr, hi = -di, h2 = hr * hr + hi * hi;
      const nr = zr - (gr * hr + gi * hi) / h2, ni = zi - (gi * hr - gr * hi) / h2;
      if (Math.hypot(nr, ni) <= 1 + 1e-9) { zr = nr; zi = ni; last = 'newton'; } else { zr = tr; zi = ti; last = 'fixed'; }
    }
    if (!(res <= 10 * TOL) || !(Math.hypot(zr, zi) <= 1 + 1e-12)) {
      throw new Error(`internal check failed: the free-spin fixed point did not converge at frequency ${k} (residual ${res})`);
    }
    re[k] = zr; im[k] = zi;
    if (res > maxRes) maxRes = res;
    if (it > maxIt) maxIt = it;
    if ((k & 65535) === 0) onProgress(k / H);
  }
  return { re, im, maxResidual: maxRes, errorBound: maxRes / (1 - c), maxIterations: maxIt, contraction: c };
}

// The pmf of an uncapped feature's total on a grid of N points (wrapped mod N), for
// f0 starting spins and one free spin's outcomes [{ x (lattice), p, award }] (award:
// spins a retrigger adds, 0 for none; several sizes give phi = A + sum B_j phi^F_j).
// roundDistribution does the same inside; this one is for checks and tests.
export function featureDistribution(spin, f0, N) {
  const fft = new Fft(N);
  const H = N / 2 + 1;
  const awards = [...new Set(spin.filter((c) => c.award).map((c) => c.award))];
  const c = spin.reduce((a, s) => a + (s.award || 0) * s.p, 0);
  if (!(c < 1)) throw fail('the expected number of free spins is infinite', 'العدد المتوقع للفات المجانية لا نهائي');
  const A = halfSpectrum(fft, N, spin.filter((s) => !s.award));
  const Bs = awards.map((F) => ({ F, ...halfSpectrum(fft, N, spin.filter((s) => s.award === F)) }));
  const sol = solvePhi(A, Bs, c, H, () => {});
  const re = new Float64Array(N), im = new Float64Array(N);
  for (let k = 0; k < H; k++) { powC(sol.re[k], sol.im[k], f0); re[k] = PR; im[k] = PI; }
  for (let k = H; k < N; k++) { re[k] = re[N - k]; im[k] = -im[N - k]; }
  fft.inverse(re, im);
  return { pmf: re, solver: { maxResidual: sol.maxResidual, errorBound: sol.errorBound, maxIterations: sol.maxIterations, contraction: c } };
}

// Capped feature: forward sweep of spectra over the state graph.
function cappedSpectrum(graph, A, Bs, H, onProgress) {
  const B = Bs.length ? Bs[0] : null;
  const live = new Map();
  const vec = () => ({ re: new Float64Array(H), im: new Float64Array(H) });
  const first = vec();
  first.re.fill(1);
  live.set(graph.start.id, first);
  const out = vec();
  const desc = [...graph.ascending].reverse();
  let done = 0;
  for (const s of desc) {
    const v = live.get(s.id);
    if (!v) continue;
    live.delete(s.id);
    if (s.r === 0) {
      for (let k = 0; k < H; k++) { out.re[k] += v.re[k]; out.im[k] += v.im[k]; }
      continue;
    }
    const a = s.n0, b = s.n1[0];
    const va = live.get(a.id) || (live.set(a.id, vec()), live.get(a.id));
    if (!B || b === a) {
      const sr = B ? B.re : null, si = B ? B.im : null;
      for (let k = 0; k < H; k++) {
        const cr = A.re[k] + (sr ? sr[k] : 0), ci = A.im[k] + (si ? si[k] : 0);
        va.re[k] += v.re[k] * cr - v.im[k] * ci; va.im[k] += v.re[k] * ci + v.im[k] * cr;
      }
    } else {
      const vb = live.get(b.id) || (live.set(b.id, vec()), live.get(b.id));
      for (let k = 0; k < H; k++) {
        const xr = v.re[k], xi = v.im[k];
        va.re[k] += xr * A.re[k] - xi * A.im[k]; va.im[k] += xr * A.im[k] + xi * A.re[k];
        vb.re[k] += xr * B.re[k] - xi * B.im[k]; vb.im[k] += xr * B.im[k] + xi * B.re[k];
      }
    }
    if ((++done & 63) === 0) onProgress(done / desc.length);
  }
  return out;
}

// Spectra alive at once in cappedSpectrum, and its multiply-adds per frequency.
function cappedCost(graph) {
  const desc = [...graph.ascending].reverse();
  const live = new Set([graph.start.id]);
  let peak = 1, work = 0;
  for (const s of desc) {
    if (!live.has(s.id)) continue;
    live.delete(s.id);
    if (s.r === 0) continue;
    live.add(s.n0.id); live.add(s.n1[0].id);
    work += s.n1[0] === s.n0 ? 1 : 2;
    peak = Math.max(peak, live.size + 1);
  }
  return { peak, work };
}

// ---------- exact sparse tails (bounded features) ----------

// The exact upper tail of the feature total, for a feature started with f0 spins that
// cannot run forever (no retrigger, or capped): partial sums are enumerated with
// BigInt weights, and those that cannot reach `need` any more (sum + most spins left
// * largest spin win < need) are dropped, so only the tail is enumerated. Returns
// (v) => P(total >= v) as a Fraction for any v >= need, or null when more than
// `limit` partial sums would be kept or the work passes `maxWork` (the caller then
// shows a bound).
function exactFeatureTail(ctx, f0, need, graph, { limit = EXACT_TAIL_LIMIT, maxWork = 3e6 } = {}) {
  if (need <= 0) return Object.assign(() => 1n, { den: 1n });
  const xmax = ctx.free.reduce((a, c) => Math.max(a, c.x), 0);
  // Spin outcomes by award (0: no retrigger), largest win first.
  const groups = new Map();
  for (const c of ctx.free) {
    const a = ctx.fs.retrigger ? c.award : 0;
    if (!groups.has(a)) groups.set(a, []);
    groups.get(a).push(c);
  }
  for (const list of groups.values()) list.sort((a, b) => b.x - a.x);
  const spinsLeft = graph ? (s) => s.level : (s) => s.r;
  const nextOf = graph ? (s, award) => (award ? s.n1[0] : s.n0) : (s) => ({ r: s.r - 1, id: String(s.r - 1) });
  const start = graph ? graph.start : { r: f0, id: String(f0) };
  const D = ctx.freeTotal;
  const depth = graph ? graph.maxSpins : f0;
  const pow = [1n];
  for (let i = 1; i <= depth; i++) pow.push(pow[i - 1] * D);
  let layer = new Map([[start.id + '|0', { s: start, sum: 0, count: 1n }]]);
  const done = new Map();
  let work = 0;
  for (let step = 0; layer.size; step++) {
    const next = new Map();
    for (const { s, sum, count } of layer.values()) {
      if (s.r === 0) {
        // finished after `step` spins: weight count / D^step, kept over D^depth
        if (sum >= need) done.set(sum, (done.get(sum) || 0n) + count * pow[depth - step]);
        continue;
      }
      for (const [award, list] of groups) {
        const n = nextOf(s, award);
        const least = need - sum - spinsLeft(n) * xmax; // smallest spin win that can still reach need
        for (const c of list) {
          if (c.x < least) break;
          const ns = sum + c.x;
          const key = n.id + '|' + ns;
          const e = next.get(key);
          if (e) e.count += count * c.count; else next.set(key, { s: n, sum: ns, count: count * c.count });
          if (++work > maxWork) return null;
        }
      }
      if (next.size > limit) return null;
    }
    layer = next;
  }
  const sums = [...done.keys()].sort((a, b) => b - a);
  // numerator over den = D^depth (unreduced, so callers can add them up)
  const tail = (v) => {
    if (v < need) throw new Error('internal: tail below its enumeration');
    let num = 0n;
    for (const s of sums) { if (s < v) break; num += done.get(s); }
    return num;
  };
  tail.den = pow[depth];
  return tail;
}

// ---------- the whole-round distribution ----------

// Lattice steps to bets: x * den / num, one correctly rounded division when it fits.
const toBets = (ctx, x) => {
  const { num, den } = ctx.perBet;
  const t = BigInt(x) * den;
  return t <= SAFE && num <= SAFE ? Number(t) / Number(num) : new Fraction(t, num).toNumber();
};

// Exact whole-round pmf when nothing triggers free spins (or the model has none).
function exactRound(ctx, exact) {
  const T = ctx.baseTotal;
  const cells = new Map();
  for (const c of ctx.base) cells.set(c.x, (cells.get(c.x) || 0n) + c.count);
  const xs = [...cells.keys()].sort((a, b) => a - b);
  const entries = xs.map((x) => ({ units: x, x: toBets(ctx, x), trigger: false, p: ratio(cells.get(x), T), count: cells.get(x).toString() }));
  // checks (exact, so they cannot drift; kept for symmetry with the FFT path)
  let s0 = 0n, s1 = 0n, s2 = 0n;
  for (const x of xs) { const c = cells.get(x), b = BigInt(x); s0 += c; s1 += c * b; s2 += c * b * b; }
  const pb = ctx.perBet;
  const mean = new Fraction(s1, T).div(pb), m2 = new Fraction(s2, T).div(pb).div(pb);
  const variance = m2.sub(mean.mul(mean));
  const checks = {
    mass: { computed: ratio(s0, T), expected: 1, relativeError: 0 },
    mean: { computed: mean.toNumber(), expected: exact.rtp.toNumber(), relativeError: relErr(mean.toNumber(), exact.rtp.toNumber()) },
    variance: { computed: variance.toNumber(), expected: exact.variance.toNumber(), relativeError: relErr(variance.toNumber(), exact.variance.toNumber()) },
  };
  if (!s0 || s0 !== T || !mean.equals(exact.rtp) || !variance.equals(exact.variance)) {
    throw new Error('internal check failed: the exact whole-round pmf does not match the closed forms');
  }
  const tailFrac = (xmin) => { let n = 0n; for (const x of xs) if (BigInt(x) >= xmin) n += cells.get(x); return new Fraction(n, T); };
  const maxX = xs.length ? xs[xs.length - 1] : 0;
  const prob = (f) => ({ value: f.toNumber(), fraction: f.toString(), method: 'exact', below: null });
  const thresholds = BIG_WINS.map((t) => {
    const xmin = ceilFrac(pb.mul(t));
    return { x: t, ...prob(tailFrac(xmin)) };
  });
  const quantiles = QUANTILES.map((q) => {
    let acc = 0n;
    const need = new Fraction(BigInt(Math.round(q * 1e6)), 1000000n);
    for (const x of xs) { acc += cells.get(x); if (new Fraction(acc, T).cmp(need) >= 0) return { q, x: toBets(ctx, x) }; }
    return { q, x: toBets(ctx, maxX) };
  });
  return {
    method: 'exact', exact: true,
    unit: { modelUnits: ctx.unit.toString(), perBet: pb.toString() },
    grid: null, floor: 0, noise: 0, aliasBound: 0,
    checks, triggerProbability: 0,
    maxWin: { bounded: true, x: toBets(ctx, maxX), ...prob(tailFrac(BigInt(maxX))) },
    thresholds, quantiles, mgf: [],
    pmf: { scope: 'round', exact: true, unitsPerBet: pb.toNumber(), unitBets: new Fraction(1n).div(pb).toString(), total: T.toString(), droppedMass: 0, noiseFloor: 0, maxX: toBets(ctx, maxX), truncated: false, entries },
  };
}

function relErr(a, b) { return b === 0 ? Math.abs(a) : Math.abs(a - b) / Math.abs(b); }

// exact: { rtp, variance } as Fractions in bets (the closed forms of slot-exact.js).
export function roundDistribution(model, spins, exact, { onProgress = () => {}, gridLimit = GRID_LIMIT } = {}) {
  const ctx = prepare(model, spins);
  const fs = ctx.fs;
  if (!fs || !ctx.trig.length) return exactRound(ctx, exact);
  const capped = hasCaps(fs);
  const awards = [...new Set(ctx.free.filter((c) => c.award).map((c) => c.award))].sort((a, b) => a - b);
  const f0s = [...new Set(ctx.trig.map((c) => c.f0))];
  if (capped && (awards.length > 1 || f0s.length > 1)) throw new Error('internal: caps with several award sizes');
  const graph = capped ? capGraph(fs, f0s[0], awards.length ? awards : [fs.spins]) : null;
  const pb = ctx.perBet;
  const EW = exact.rtp.mul(pb).toNumber(); // lattice steps
  const VarW = exact.variance.mul(pb).mul(pb).toNumber();
  const EW2 = VarW + EW * EW;
  const pTrig = ctx.trig.reduce((a, c) => a + c.p, 0);
  const contraction = awards.reduce((a, F) => a + F * ctx.free.filter((c) => c.award === F).reduce((s, c) => s + c.p, 0), 0);

  // Bounded feature: its largest total; and the largest round win.
  const xmaxFree = (award) => ctx.free.filter((c) => (award === null ? !c.award : c.award === award)).reduce((a, c) => Math.max(a, c.x), -Infinity);
  let featureMax = Infinity;
  if (!fs.retrigger || !awards.length) featureMax = f0s[0] * ctx.free.reduce((a, c) => Math.max(a, c.x), 0);
  else if (capped) {
    const g2 = capGraph(fs, f0s[0], awards);
    for (const s of g2.ascending) s.best = s.r === 0 ? 0 : Math.max(xmaxFree(null) + s.n0.best, xmaxFree(awards[0]) + s.n1[0].best);
    featureMax = g2.start.best;
  }
  const bounded = Number.isFinite(featureMax);
  const nonTrigMax = ctx.nonTrig.reduce((a, c) => Math.max(a, c.x), 0);
  const roundMax = bounded ? Math.max(nonTrigMax, ...ctx.trig.map((c) => c.x + featureMax)) : Infinity;

  // Grid: smallest power of two whose wrap-around bounds are negligible.
  onProgress(0.02);
  const table = mgfTable(ctx, graph);
  const trigMax = ctx.trig.reduce((a, c) => Math.max(a, c.x), 0);
  let N = nextPowerOfTwo(Math.max(1024, 2 * (trigMax + 1)));
  if (bounded) N = Math.min(N, nextPowerOfTwo(roundMax + 1)) || N;
  N = Math.max(N, nextPowerOfTwo(trigMax + 1));
  const ok = (n) => {
    if (bounded && n > roundMax) return true; // nothing can wrap
    const b = tailBounds(table, n, 'logT');
    if (!(EW > 0)) return b.p0 <= ALIAS_TARGET; // nothing ever pays: no moment to protect
    return b.p0 <= ALIAS_TARGET && b.e1 + n * b.p0 <= MOMENT_TARGET * EW && b.e2 + n * n * b.p0 <= MOMENT_TARGET * EW2;
  };
  while (!ok(N) && N <= gridLimit) N *= 2;
  if (N > gridLimit) {
    throw tooLarge(`the whole-round distribution needs more than ${gridLimit.toLocaleString('en-US')} lattice points; use Monte Carlo`,
      `توزيع الجولة الكاملة يحتاج أكثر من ${gridLimit.toLocaleString('en-US')} نقطة على الشبكة؛ استخدم مونت كارلو`);
  }
  const aliasBound = bounded && N > roundMax ? 0 : tailBounds(table, N, 'logT').p0;
  const H = N / 2 + 1;
  if (graph) {
    const cost = cappedCost(graph);
    if (cost.work * H > CAP_WORK_LIMIT || cost.peak * H * 16 > CAP_MEMORY_LIMIT) {
      throw tooLarge('the free-spin caps make the whole-round distribution too large for the browser; use Monte Carlo',
        'حدود اللفات المجانية تجعل توزيع الجولة الكاملة أكبر من طاقة المتصفح؛ استخدم مونت كارلو');
    }
  }

  // Spectra of one free spin (A: no retrigger, B_F: retriggers F) and of the trigger spins.
  const fft = new Fft(N);
  const A = halfSpectrum(fft, N, ctx.free.filter((c) => !c.award));
  const Bs = awards.map((F) => ({ F, ...halfSpectrum(fft, N, ctx.free.filter((c) => c.award === F)) }));
  onProgress(0.1);
  let solver = null, Phi;
  const sub = (from, to) => (v) => onProgress(from + (to - from) * v);
  if (graph) {
    Phi = cappedSpectrum(graph, A, Bs, H, sub(0.1, 0.7));
  } else {
    solver = solvePhi(A, Bs, contraction, H, sub(0.1, 0.6));
    Phi = solver;
  }
  // Trigger rounds: sum over F0 of BT_F0 * phi^F0 (capped: the swept spectrum).
  const re = new Float64Array(N), im = new Float64Array(N);
  for (const f0 of f0s) {
    const bt = halfSpectrum(fft, N, ctx.trig.filter((c) => c.f0 === f0));
    for (let k = 0; k < H; k++) {
      let fr, fi;
      if (graph) { fr = Phi.re[k]; fi = Phi.im[k]; } else { powC(Phi.re[k], Phi.im[k], f0); fr = PR; fi = PI; }
      re[k] += bt.re[k] * fr - bt.im[k] * fi; im[k] += bt.re[k] * fi + bt.im[k] * fr;
    }
  }
  for (let k = H; k < N; k++) { re[k] = re[N - k]; im[k] = -im[N - k]; }
  onProgress(0.75);
  fft.inverse(re, im);
  const pT = re;
  let noise = 0;
  for (let x = 0; x < N; x++) {
    const a = Math.abs(im[x]);
    if (a > noise) noise = a;
    if (-pT[x] > noise) noise = -pT[x];
  }
  // The solver's error bound, carried through phi^F0 and the mix of trigger spins.
  if (solver) noise = Math.max(noise, pTrig * Math.max(...f0s) * solver.errorBound);
  const floor = Math.max(FLOOR_MIN, 1000 * (noise + aliasBound));
  onProgress(0.8);

  // Exact part: rounds that do not trigger.
  const non = new Map();
  for (const c of ctx.nonTrig) non.set(c.x, (non.get(c.x) || 0n) + c.count);
  const T = ctx.baseTotal;

  // Internal checks against the closed forms.
  let mass = 0, s1 = 0, s2 = 0;
  for (const [x, c] of non) { const p = ratio(c, T); mass += p; s1 += x * p; s2 += (x - EW) * (x - EW) * p; }
  for (let x = 0; x < N; x++) { const p = pT[x]; if (p === 0) continue; mass += p; s1 += x * p; s2 += (x - EW) * (x - EW) * p; }
  const checks = {
    mass: { computed: mass, expected: 1, relativeError: Math.abs(mass - 1) },
    mean: { computed: s1 / pb.toNumber(), expected: exact.rtp.toNumber(), relativeError: relErr(s1, EW) },
    variance: { computed: s2 / pb.toNumber() ** 2, expected: exact.variance.toNumber(), relativeError: relErr(s2, VarW) },
  };
  for (const [k, v] of Object.entries(checks)) {
    if (!(v.relativeError <= CHECK_TOLERANCE)) {
      throw new Error(`internal check failed: whole-round ${k} ${v.computed} differs from the closed form ${v.expected} (relative ${v.relativeError})`);
    }
  }

  // Probabilities, honest about the floor.
  const exactTail = (xmin) => { let n = 0n; for (const [x, c] of non) if (BigInt(x) >= xmin) n += c; return new Fraction(n, T); };
  const fftTail = (xmin) => { let s = 0; for (let x = Math.max(0, xmin); x < N; x++) s += pT[x]; return s; };
  // P(trigger round >= xm) exactly (bounded features only), or null when too big.
  // Highest thresholds first: once one is too big, every lower one is too.
  const exactTrigTails = (xmins) => {
    const out = new Map();
    if (!bounded) return out;
    for (const xm of [...new Set(xmins)].sort((a, b) => b - a)) {
      // One enumeration down to the smallest need of this threshold (every trigger
      // spin c needs a feature total of xm - c.x); f0 is the same for every trigger.
      const least = Math.min(Infinity, ...ctx.trig.map((c) => xm - c.x).filter((v) => v > 0));
      const tail = exactFeatureTail(ctx, f0s[0], Number.isFinite(least) ? least : 0, graph);
      if (!tail) break;
      let num = 0n;
      for (const c of ctx.trig) num += c.count * (xm - c.x <= 0 ? tail.den : tail(xm - c.x));
      out.set(xm, new Fraction(num, tail.den * T));
    }
    return out;
  };
  const probAt = (xmin, exactTrig = null) => {
    const ex = exactTail(BigInt(xmin));
    if (bounded && xmin > roundMax) return { value: 0, fraction: '0', method: 'exact', below: null };
    if (exactTrig) { const f = ex.add(exactTrig); return { value: f.toNumber(), fraction: f.toString(), method: 'exact', below: null }; }
    const exV = ex.toNumber();
    if (xmin < N) {
      const t = fftTail(xmin);
      if (t >= floor) return { value: exV + t, fraction: null, method: 'fft', below: null };
    }
    // Below the floor: the Chernoff bound (rigorous) when it is smaller.
    const bound = Math.min(floor, tailBounds(table, xmin, 'logT').p0);
    if (exV >= 1e6 * bound) return { value: exV, fraction: null, method: 'fft', below: null };
    return { value: null, fraction: null, method: 'bound', below: exV + bound };
  };
  const xmins = BIG_WINS.map((t) => Number(ceilFrac(pb.mul(t))));
  // Exact tails where the transform is below its floor (or would be), and for the top.
  const wantExact = xmins.filter((xm) => xm <= roundMax && (xm >= N || fftTail(xm) < floor));
  if (bounded) wantExact.push(roundMax);
  const exTails = wantExact.length ? exactTrigTails(wantExact) : null;
  const thresholds = BIG_WINS.map((t, i) => ({ x: t, ...probAt(xmins[i], exTails && exTails.get(xmins[i])) }));
  let maxWin;
  if (bounded) {
    maxWin = { bounded: true, x: toBets(ctx, roundMax), ...probAt(roundMax, exTails && exTails.get(roundMax)) };
  } else {
    let top = 0;
    for (let x = N - 1; x >= 0; x--) if (pT[x] >= floor) { top = x; break; }
    for (const x of non.keys()) top = Math.max(top, x);
    maxWin = { bounded: false, x: null, largestAboveFloor: toBets(ctx, top), value: null, fraction: null, method: null, below: null };
  }
  // Quantiles over the lattice (exact part + transform).
  const nonAt = new Map([...non].map(([x, c]) => [x, ratio(c, T)]));
  const quantiles = [];
  {
    let acc = 0, qi = 0;
    const last = Math.max(N - 1, nonTrigMax);
    for (let x = 0; x <= last && qi < QUANTILES.length; x++) {
      acc += (x < N ? pT[x] : 0) + (nonAt.get(x) || 0);
      while (qi < QUANTILES.length && acc >= QUANTILES[qi] * (1 - 1e-12)) quantiles.push({ q: QUANTILES[qi++], x: toBets(ctx, x) });
    }
  }
  // The pmf for the distribution tests and the session funnel: exact cells for rounds
  // without the feature, transform cells at or above the floor for the others.
  const entries = [];
  let dropped = 0;
  const xsAll = new Set(non.keys());
  for (let x = 0; x < N; x++) {
    if (pT[x] >= floor) xsAll.add(x);
    else if (pT[x] > 0) dropped += pT[x];
  }
  for (const x of [...xsAll].sort((a, b) => a - b)) {
    if (non.has(x)) entries.push({ units: x, x: toBets(ctx, x), trigger: false, p: nonAt.get(x), count: non.get(x).toString() });
    if (x < N && pT[x] >= floor) entries.push({ units: x, x: toBets(ctx, x), trigger: true, p: pT[x] });
  }
  onProgress(1);
  return {
    method: graph ? 'capsDp' : 'fft', exact: false, bounded,
    unit: { modelUnits: ctx.unit.toString(), perBet: pb.toString() },
    grid: {
      size: N, limit: gridLimit, aliasBound,
      solver: solver ? { maxResidual: solver.maxResidual, errorBound: solver.errorBound, maxIterations: solver.maxIterations, contraction } : null,
      capStates: graph ? graph.states.size : null,
    },
    noise, floor, aliasBound, checks, triggerProbability: pTrig,
    maxWin, thresholds, quantiles,
    // Chernoff table (theta per lattice step) for bounds beyond the grid.
    mgf: table.map((r) => ({ theta: r.theta, logT: r.logT, logM: r.logM })),
    caps: capped ? { maxSpins: fs.maxSpins ?? null, maxRetriggers: fs.maxRetriggers ?? null } : null,
    // maxX: the round's true largest win (null: none, retriggers are uncapped); truncated:
    // cells under the noise floor are left out, so the last entry is not the top prize.
    pmf: {
      scope: 'round', exact: false, unitsPerBet: pb.toNumber(), unitBets: new Fraction(1n).div(pb).toString(), total: T.toString(),
      droppedMass: dropped, noiseFloor: floor, maxX: bounded ? toBets(ctx, roundMax) : null, truncated: dropped > 0 || (bounded && roundMax >= N), entries,
    },
  };
}

// slot-exact.js's closed forms, read back from its result (fraction strings, bets).
export function exactMomentsOf(result) {
  return { rtp: parseFraction(result.rtp.fraction), variance: parseFraction(result.distribution.variance.fraction) };
}

// Runs the whole-round distribution for an analyzeExact result (spins: what
// analyzeExact passed to opts.onEntries) and stores it as result.round, or the reason
// it could not be computed as result.roundError ({ ar, en, tooLarge, internal }).
export function attachRoundDistribution(result, model, spins, opts = {}) {
  result.round = null;
  result.roundError = null;
  if (!spins || !result.distribution) return result;
  try {
    result.round = roundDistribution(model, spins, exactMomentsOf(result), opts);
  } catch (e) {
    const internal = !e.ar;
    result.roundError = { ar: e.ar || 'فشل فحص داخلي في توزيع الجولة الكاملة: ' + e.message, en: e.en || e.message, tooLarge: Boolean(e.tooLarge), internal };
  }
  return result;
}

// ---------- a max-win cap M (x bet) applied to every round ----------

// RTP_capped = E[min(W, M)] / bet and the RTP the cap removes, E[(W - M)+] / bet.
// Exact (fractions) for an exact pmf; otherwise from the transform with the
// precision it allows. P(W >= M) (the chance a round reaches the cap) follows the
// same floor rule as the thresholds.
export function capStats(round, M, rtp) {
  rtp = parseFraction(rtp);
  const pb = parseFraction(round.unit.perBet);
  let cap = null;
  try { cap = Fraction.of(typeof M === 'string' ? M.trim().replace(',', '.') : M); } catch (e) { /* reported below */ }
  if (!cap || !(cap.cmp(0) > 0)) throw fail('the max-win cap must be a positive number', 'يجب أن يكون سقف الربح عددًا موجبًا');
  const Mx = cap.mul(pb); // lattice steps, maybe fractional
  const pmf = round.pmf;
  if (round.exact) {
    const T = BigInt(pmf.total);
    let num = new Fraction(0n), reach = 0n;
    for (const e of pmf.entries) {
      const c = BigInt(e.count), x = new Fraction(BigInt(e.units));
      if (x.cmp(Mx) >= 0) { reach += c; num = num.add(Mx.mul(c)); } else num = num.add(x.mul(c));
    }
    const capped = num.div(T).div(pb);
    const pReach = new Fraction(reach, T);
    return {
      M: cap.toNumber(), exact: true,
      rtpCapped: { value: capped.toNumber(), fraction: capped.toString() },
      lost: { value: rtp.sub(capped).toNumber(), fraction: rtp.sub(capped).toString() },
      reach: { value: pReach.toNumber(), fraction: pReach.toString(), method: 'exact', below: null },
    };
  }
  // From the tail only: E[(W - M)+] over the cells at or above M, and RTP_capped =
  // RTP (exact) - that. Cells under the noise floor are not in the pmf; what they
  // can add is at most min(Chernoff bound of E[(W - M)+], their mass * (grid - M)).
  const m = Mx.toNumber(), steps = pb.toNumber();
  let excess = 0, above = 0;
  for (const e of pmf.entries) if (e.units >= m) { excess += (e.units - m) * e.p; above += e.p; }
  const bounds = tailBounds(round.mgf, m, 'logM');
  const span = Math.max(0, (round.grid ? round.grid.size : 0) - m);
  const missing = Math.min(bounds.ex, pmf.droppedMass * span + round.aliasBound * (span + m));
  const lost = Math.max(0, excess) / steps;
  let reach;
  if (above >= round.floor) reach = { value: above, fraction: null, method: 'fft', below: null };
  else reach = { value: null, fraction: null, method: 'bound', below: Math.min(round.floor, bounds.p0) };
  return {
    M: m / steps, exact: false,
    rtpCapped: { value: rtp.toNumber() - lost, fraction: null, lower: rtp.toNumber() - lost - missing / steps },
    lost: { value: lost, fraction: null, upper: lost + missing / steps },
    reach,
  };
}

// Top award odds against two published rules (both unverified here): the top award
// is the cap M when one is set, else the largest win when the game has one.
// prob: { value, fraction, method, below }. pass: true / false, or null when only a
// bound is known and it does not decide.
export function topAwardChecks(prob) {
  if (!prob) return null;
  const decide = (oneIn) => {
    const least = new Fraction(1n, BigInt(oneIn)); // the smallest allowed probability
    if (prob.method === 'exact') return parseFraction(prob.fraction).cmp(least) >= 0;
    if (prob.method === 'bound') return prob.below < least.toNumber() ? false : null;
    return prob.value >= least.toNumber();
  };
  return {
    oneIn: prob.value ? 1 / prob.value : null,
    gli19: { rule: '1 in 100,000,000', oneIn: GLI19_ONE_IN, pass: decide(GLI19_ONE_IN), unverified: true },
    // odds of 50,000,000 to 1 = probability 1 / 50,000,001
    pa: { rule: '50,000,000 to 1', oneIn: PA_ODDS_TO_ONE + 1, pass: decide(PA_ODDS_TO_ONE + 1), unverified: true },
  };
}

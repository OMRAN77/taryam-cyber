// Exact ways / Megaways engine (P0-6). For a model with "evaluation": "ways" (see the
// ways block of slot-model.js) it gives, as exact fractions on BigInt: the RTP per
// symbol and run length, the scatter distribution, the second moment of a spin, the
// moments the free-spin closed forms need, the hit frequency and, when it is small
// enough, the full per-spin distribution in the entry format of slot-exact.js
// ({ lineWin, scat, count }), so analyzeExact treats ways and line games alike.
//
// Independence. Reels stop independently, except the reels a top reel covers: the
// cells it adds are consecutive stops of one strip. Conditioning on the top reel's
// stop (each distinct tuple of cells it adds) makes them independent again, so every
// sum below is taken per (reel set, top tuple) and added up with their weights (the
// cost is multiplied by the number of distinct top tuples, at most the top strip's
// length). A window is `h` consecutive stops of a strip from the drawn stop; its
// weight is (height weight) x (stop weight), or the joint (stop, height) weight.
//
// Closed forms. Reels are 0-based here. For a paying symbol s and a window w of reel
// i let c_i(s) be its count element (below) and d_i(s) = 1 when no cell shows s or a
// wild. The win of s is pay_s(K) * L(c_0 ... c_{K-1}) for its run length K, so
//   E[W_s] = sum_k pay_s(k) * L(E[c_0] ... E[c_{k-1}]) * E[d_k] * (product of the
//            remaining reels' total weights),
// the research formula sum_k pay_s(k) prod_{i<=k} E[c_i(s)] P(c_{k+1}(s) = 0) in
// 1-based form. E[W_s W_t] follows the same reels left to right with the state
// (s still running?, t still running?) and per-reel moments E[c_s c_t], E[c_s d_t],
// E[d_s c_t], E[d_s d_t]: an exact sum over every (k, l) pair of run lengths without
// enumerating them. The scatter count rides along as powers of y, which gives the
// scatter distribution and E[W ; C = c] (for scatter pays and free-spin triggers) from
// the same products.
//
// Count elements by multiplier strategy (StakeEngine/math-sdk ways.py, 141b4e8):
//   symbol  c = sum of the matching cells' multipliers (a plain cell counts 1), so
//           multipliers multiply across reels;
//   global  c = number of matching cells; the global multiplier is in the pays;
//   board   win = pay * prod(n_i) * max(1, sum M_i), n = matching cells, M = the sum of
//           their multipliers above 1. With max(1, x) = x + [x = 0] and
//           prod(n_i) * sum(M_i) = the e-part of prod(n_i (1 + e M_i)) (e^2 = 0), the
//           element c = (n, n M, n [M = 0]) multiplies as (dual number) x (number), and
//           L(a + b e, r) = b + r turns a product back into the win.
// Reel 1 (wildStartsWin false): c_0(s) = 0 unless s itself shows on reel 1.
import { Fraction } from './fraction.js';
import { ModelError } from './slot-model.js';

// ---- the count algebra: elements are arrays of BigInt over a basis ----
// idx[a * d + b] = index of basis_a * basis_b (-1 = 0); Lv = L on the basis.
const SCALAR = { d: 1, unit: [1n], Lv: [1n], idx: [0] };
const BOARD = { d: 3, unit: [1n, 0n, 1n], Lv: [0n, 1n, 1n], idx: [0, 1, -1, 1, -1, -1, -1, -1, 2] };

function amul(alg, x, y) {
  if (alg.d === 1) return [x[0] * y[0]];
  const d = alg.d, out = new Array(d).fill(0n);
  for (let a = 0; a < d; a++) {
    if (!x[a]) continue;
    for (let b = 0; b < d; b++) { const c = alg.idx[a * d + b]; if (c >= 0 && y[b]) out[c] += x[a] * y[b]; }
  }
  return out;
}
function aL(alg, x) {
  let s = 0n;
  for (let a = 0; a < alg.d; a++) if (alg.Lv[a]) s += x[a];
  return s;
}
const azero = (alg) => new Array(alg.d).fill(0n);

// Tensors (elements of A (x) A) are flat arrays X[a * d + b].
function tmul(alg, X, Y) {
  const d = alg.d, D = d * d;
  if (d === 1) return [X[0] * Y[0]];
  const out = new Array(D).fill(0n);
  for (let p = 0; p < D; p++) {
    if (!X[p]) continue;
    const a = (p / d) | 0, b = p % d;
    for (let q = 0; q < D; q++) {
      if (!Y[q]) continue;
      const ca = alg.idx[a * d + ((q / d) | 0)], cb = alg.idx[b * d + (q % d)];
      if (ca >= 0 && cb >= 0) out[ca * d + cb] += X[p] * Y[q];
    }
  }
  return out;
}
function projRight(alg, X) { // (id (x) L)
  const d = alg.d, out = new Array(d).fill(0n);
  for (let a = 0; a < d; a++) for (let b = 0; b < d; b++) if (alg.Lv[b]) out[a] += X[a * d + b];
  return out;
}
function projLeft(alg, X) { // (L (x) id)
  const d = alg.d, out = new Array(d).fill(0n);
  for (let a = 0; a < d; a++) if (alg.Lv[a]) for (let b = 0; b < d; b++) out[b] += X[a * d + b];
  return out;
}
function tL(alg, X) {
  const d = alg.d;
  let s = 0n;
  for (let a = 0; a < d; a++) if (alg.Lv[a]) for (let b = 0; b < d; b++) if (alg.Lv[b]) s += X[a * d + b];
  return s;
}

// ---- polynomials in y (the scatter count): arrays of BigInt, or of algebra elements ----
function pmul(p, q) {
  const out = new Array(p.length + q.length - 1).fill(0n);
  for (let i = 0; i < p.length; i++) {
    if (!p[i]) continue;
    for (let j = 0; j < q.length; j++) if (q[j]) out[i + j] += p[i] * q[j];
  }
  return out;
}
function apmul(alg, p, q) {
  const out = Array.from({ length: p.length + q.length - 1 }, () => azero(alg));
  for (let i = 0; i < p.length; i++) {
    if (p[i].every((v) => !v)) continue;
    for (let j = 0; j < q.length; j++) {
      if (q[j].every((v) => !v)) continue;
      const m = amul(alg, p[i], q[j]);
      const o = out[i + j];
      for (let a = 0; a < alg.d; a++) o[a] += m[a];
    }
  }
  return out;
}
const psum = (p) => p.reduce((a, b) => a + b, 0n);
function padd(into, p, f = 1n) {
  while (into.length < p.length) into.push(0n);
  for (let i = 0; i < p.length; i++) if (p[i]) into[i] += p[i] * f;
}

const bgcd = (a, b) => { while (b) [a, b] = [b, a % b]; return a; };

// ---- windows ----
// The distinct windows of reel i of a reel set, as sorted cell lists with their
// weights: a window of height h from stop p weighs (height weight) x (stop weight), or
// the joint (stop, height) weight.
export function reelWindows(set, heights, i) {
  const strip = set.reels[i], len = strip.length;
  const sw = set.weights && set.weights[i];
  const h = heights[i];
  const map = new Map();
  const add = (p, rows, w) => {
    if (w === 0n) return;
    const cells = [];
    for (let r = 0; r < rows; r++) cells.push(strip[(p + r) % len]);
    cells.sort((a, b) => a - b);
    const key = cells.join(',');
    const e = map.get(key);
    if (e) e.weight += w; else map.set(key, { cells, weight: w });
  };
  if (h.joint) h.joint.forEach((row, p) => row.forEach((w, j) => add(p, h.rows[j], w)));
  else h.rows.forEach((rows, j) => { const hw = h.weights ? h.weights[j] : 1n; for (let p = 0; p < len; p++) add(p, rows, hw * (sw ? sw[p] : 1n)); });
  return [...map.values()];
}

// Distinct tuples of cells the top reel adds (one per covered reel), with weights.
export function topTuples(top) {
  if (!top) return [{ extra: null, weight: 1n }];
  const map = new Map();
  const L = top.strip.length;
  for (let q = 0; q < L; q++) {
    const extra = top.covers.map((_, m) => top.strip[(q + m) % L]);
    const key = extra.join(',');
    const w = top.weights ? top.weights[q] : 1n;
    const e = map.get(key);
    if (e) e.weight += w; else map.set(key, { extra, weight: w });
  }
  return [...map.values()];
}

function makeContext(model) {
  const w = model.ways;
  const P = w.paying.length;
  const payIndex = new Int32Array(model.symbols.length).fill(-1);
  w.paying.forEach((id, j) => { payIndex[id] = j; });
  return {
    model, P, payIndex, N: model.nReels,
    alg: w.strategy === 'board' ? BOARD : SCALAR,
    pays: Array.from(w.paying, (id) => model.waysPays[id].map(BigInt)),
    paysN: Array.from(w.paying, (id) => model.waysPays[id]),
  };
}

// What the engines use of one window: the scatter count and, per paying symbol j
// that runs through it (shows j or a wild; on reel 1 per wildStartsWin), its count
// element e, e again if the window has no wild cell and 0 otherwise (pure: a win of j
// "uses a wild", as a line win does, when any reel of its run shows a wild), the plain
// count and the board sum.
function windowInfo(ctx, cells, weight, first) {
  const { model, P, payIndex, alg } = ctx;
  const { cellBase, cellMult, strategy, wildStartsWin } = model.ways;
  const n = new Int32Array(P), m = new Int32Array(P), x = new Int32Array(P);
  let wn = 0, wm = 0, wx = 0, sc = 0;
  for (const id of cells) {
    const b = cellBase[id], mu = cellMult[id];
    if (b === model.wild) { wn++; wm += mu; if (mu > 1) wx += mu; } else if (b === model.scatter) sc++;
    else {
      const j = payIndex[b];
      if (j >= 0) { n[j]++; m[j] += mu; if (mu > 1) x[j] += mu; }
    }
  }
  const alive = [], e = new Array(P).fill(null), pure = new Array(P).fill(null);
  const noWild = wn === 0;
  const cnt = new Int32Array(P), mx = new Int32Array(P);
  let mask = 0;
  for (let j = 0; j < P; j++) {
    const on = first && !wildStartsWin ? n[j] > 0 : n[j] + wn > 0;
    if (!on) continue;
    alive.push(j);
    if (j < 31) mask |= 1 << j;
    if (strategy === 'board') {
      const a = n[j] + wn, M = x[j] + wx;
      cnt[j] = a; mx[j] = M;
      e[j] = [BigInt(a), BigInt(a * M), M === 0 ? BigInt(a) : 0n];
    } else {
      const c = strategy === 'symbol' ? m[j] + wm : n[j] + wn;
      cnt[j] = c;
      e[j] = [BigInt(c)];
    }
    pure[j] = noWild ? e[j] : new Array(alg.d).fill(0n);
  }
  return { w: weight, sc, alive, mask, e, pure, cnt, mx, alg };
}

// Per-reel sums over the windows (weights times values), for one reel variant.
function reelMoments(ctx, infos) {
  const { P, alg } = ctx;
  const d = alg.d, D = d * d;
  let maxSc = 0;
  for (const f of infos) if (f.sc > maxSc) maxSc = f.sc;
  const T = new Array(maxSc + 1).fill(0n);
  const A = Array.from({ length: P }, () => Array.from({ length: maxSc + 1 }, () => azero(alg)));
  const Ap = Array.from({ length: P }, () => azero(alg));
  const aliveP = Array.from({ length: P }, () => new Array(maxSc + 1).fill(0n));
  const CC = new Array(P * P * D).fill(0n); // j <= l
  const EA = new Array(P * P * d).fill(0n); // sum over windows where j and l both run of W e_j
  const BB = new Array(P * P).fill(0n);
  for (const f of infos) {
    const W = f.w;
    T[f.sc] += W;
    const We = new Array(P);
    for (const j of f.alive) {
      const ej = f.e[j], pj = f.pure[j], Aj = A[j][f.sc], wj = We[j] = new Array(d);
      for (let a = 0; a < d; a++) { wj[a] = W * ej[a]; Aj[a] += wj[a]; Ap[j][a] += W * pj[a]; }
      aliveP[j][f.sc] += W;
    }
    for (const j of f.alive) {
      const wj = We[j];
      for (const l of f.alive) {
        const base = (j * P + l);
        for (let a = 0; a < d; a++) EA[base * d + a] += wj[a];
        if (j > l) continue;
        BB[base] += W;
        const el = f.e[l];
        for (let a = 0; a < d; a++) { if (!wj[a]) continue; for (let b = 0; b < d; b++) if (el[b]) CC[base * D + a * d + b] += wj[a] * el[b]; }
      }
    }
  }
  const Tsum = psum(T);
  const Z = aliveP.map((ap) => T.map((t, c) => t - ap[c]));
  const Al = aliveP.map(psum);
  const C = A.map((poly) => poly.reduce((acc, x) => acc.map((v, a) => v + x[a]), azero(alg)));
  return { T, Tsum, A, Ap, Z, Zsum: Z.map(psum), Al, C, CC, EA, BB };
}

// Reel sets of one source mixed as in slot-exact.js: set r is scaled by f_r so that
// f_r * T_r is proportional to its weight, T_r being its own total weight.
function mixSets(weights, totals) {
  const lcm = totals.reduce((a, t) => (a / bgcd(a, t)) * t);
  let factors = weights.map((w, r) => w * (lcm / totals[r]));
  const g = factors.reduce(bgcd);
  factors = factors.map((f) => f / g);
  return { factors, totals, total: factors.reduce((a, f, r) => a + f * totals[r], 0n) };
}

// Windows, reel variants (a covered reel with each extra cell) and their moments,
// built once per source and reused by every (reel set, top tuple).
function prepareSource(ctx, src) {
  const tuples = topTuples(src.top);
  const U = tuples.reduce((a, t) => a + t.weight, 0n);
  const covered = new Map((src.top ? src.top.covers : []).map((c, m) => [c, m]));
  const sets = src.sets.map((set) => {
    const windows = Array.from({ length: ctx.N }, (_, i) => reelWindows(set, src.heights, i));
    const reelTotals = windows.map((ws) => ws.reduce((a, w) => a + w.weight, 0n));
    return { set, windows, reelTotals, total: reelTotals.reduce((a, b) => a * b, 1n) * U, variants: new Map() };
  });
  const mix = mixSets(src.sets.map((s) => s.weight), sets.map((s) => s.total));
  // The windows of reel i of a set with the extra top cell x (-1 = none), as infos.
  const infos = (s, i, x) => {
    const key = i + ':' + x;
    let v = s.variants.get(key);
    if (!v) {
      v = { infos: s.windows[i].map((w) => windowInfo(ctx, x >= 0 ? w.cells.concat([x]) : w.cells, w.weight, i === 0)) };
      s.variants.set(key, v);
    }
    return v;
  };
  const extraOf = (tuple, i) => (tuple.extra && covered.has(i) ? tuple.extra[covered.get(i)] : -1);
  return { tuples, U, sets, mix, total: mix.total, infos, extraOf };
}

function momentsOf(ctx, variant) {
  if (!variant.moments) variant.moments = reelMoments(ctx, variant.infos);
  return variant.moments;
}

// E[W_j W_l] (times the weight of the reels) for one (set, tuple): left to right with
// the state (j running?, l running?); a symbol whose run ends is paid and projected
// by L at once, since later reels multiply it by plain numbers only.
function pairMoment(ctx, M, j, l) {
  const { alg, N, pays, P } = ctx;
  const d = alg.d, D = d * d;
  const at = (arr, i, size) => arr.slice(i * size, i * size + size);
  let AA = at(M[0].CC, j * P + l, D);
  let AO = azero(alg), OA = azero(alg), OO = 0n;
  for (let i = 1; i < N; i++) {
    const m = M[i];
    const CC = at(m.CC, j * P + l, D);
    // E[c_j d_l] = E[c_j] - E[c_j ; l runs] and the same the other way round.
    const CD = m.C[j].map((v, a) => v - m.EA[(j * P + l) * d + a]);
    const DC = m.C[l].map((v, a) => v - m.EA[(l * P + j) * d + a]);
    const DD = m.Tsum - m.Al[j] - m.Al[l] + m.BB[j * P + l];
    const pj = pays[j][i], pl = pays[l][i];
    const nAA = tmul(alg, AA, CC);
    const nAO = amul(alg, AO, m.C[j]);
    if (pl) { const t = amul(alg, projRight(alg, AA), CD); for (let a = 0; a < d; a++) nAO[a] += pl * t[a]; }
    const nOA = amul(alg, OA, m.C[l]);
    if (pj) { const t = amul(alg, projLeft(alg, AA), DC); for (let a = 0; a < d; a++) nOA[a] += pj * t[a]; }
    let nOO = OO * m.Tsum;
    if (pj) nOO += pj * aL(alg, AO) * m.Zsum[j];
    if (pl) nOO += pl * aL(alg, OA) * m.Zsum[l];
    if (pj && pl) nOO += pj * pl * tL(alg, AA) * DD;
    AA = nAA; AO = nAO; OA = nOA; OO = nOO;
  }
  const pj = pays[j][N], pl = pays[l][N];
  return OO + pj * aL(alg, AO) + pl * aL(alg, OA) + pj * pl * tL(alg, AA);
}

// Weight of the windows with no ways win, by scatter count capped at `cap`, for one
// (set, tuple): a DP over the set of symbols still running (bit masks, P <= 16).
function noWinMass(ctx, variants, cap) {
  const { P, N, paysN } = ctx;
  const winsAt = (k) => { let mask = 0; for (let j = 0; j < P; j++) if (paysN[j][k] > 0) mask |= 1 << j; return mask; };
  const can = new Array(N + 1).fill(0); // can[i]: symbols with a paying run of i + 1 reels or more
  for (let i = N - 1; i >= 0; i--) can[i] = can[i + 1] | winsAt(i + 1);
  let states = new Map([[((1 << P) - 1) * (cap + 1), 1n]]);
  for (let i = 0; i < N; i++) {
    const groups = new Map();
    for (const f of variants[i].infos) {
      const key = f.mask * (cap + 1) + Math.min(f.sc, cap);
      groups.set(key, (groups.get(key) || 0n) + f.w);
    }
    const payNow = i > 0 ? winsAt(i) : 0;
    const next = new Map();
    for (const [key, w] of states) {
      const mask = Math.floor(key / (cap + 1)), c = key % (cap + 1);
      for (const [g, gw] of groups) {
        const gm = Math.floor(g / (cap + 1)), gs = g % (cap + 1);
        if (mask & ~gm & payNow) continue; // a symbol ended its run on a paying length
        const nm = mask & gm & can[i]; // still running and able to win with a longer run
        const nk = nm * (cap + 1) + Math.min(c + gs, cap);
        next.set(nk, (next.get(nk) || 0n) + w * gw);
      }
    }
    states = next;
  }
  const out = new Array(cap + 1).fill(0n);
  const last = winsAt(N);
  for (const [key, w] of states) if (!(Math.floor(key / (cap + 1)) & last)) out[key % (cap + 1)] += w;
  return out;
}

// The smallest c0 such that "the spin is a hit apart from ways wins" (a scatter pay, or
// a counted trigger) is the same for every scatter count from c0 up.
function hitCap(model, triggerAt) {
  const g = (c) => (model.scatterPays[c] || 0) > 0 || (triggerAt !== null && c >= triggerAt);
  const max = model.ways.maxScatter;
  let c0 = max;
  while (c0 > 0 && g(c0 - 1) === g(max)) c0--;
  return c0;
}

export const MAX_HIT_SYMBOLS = 16;

// Exact analysis of one reel source (base game or free spins). triggerAt: the scatter
// count that counts as a trigger in the moments (null = none). Returns the mixture,
// the per-symbol outcomes in the format analyzeExact reads, the scatter distribution
// and the spin moments { s1, s2, sJ, sXJ, hits } as weights over `total`.
export function waysSource(model, src, { triggerAt = null, hits = true, onProgress = () => {} } = {}) {
  const ctx = makeContext(model);
  const { P, N, alg, pays } = ctx;
  const prep = prepareSource(ctx, src);
  const combos = Array.from({ length: P }, () => new Array(N + 1).fill(0n));
  const pureC = Array.from({ length: P }, () => new Array(N + 1).fill(0n));
  const hitsK = Array.from({ length: P }, () => new Array(N + 1).fill(0n));
  const WY = [0n], SD = [0n];
  let S2 = 0n;
  const doHits = hits && P <= MAX_HIT_SYMBOLS;
  const cap = doHits ? hitCap(model, triggerAt) : 0;
  const noWin = new Array(cap + 1).fill(0n);
  const steps = prep.sets.length * prep.tuples.length;
  let step = 0;
  prep.sets.forEach((s, r) => {
    for (const tuple of prep.tuples) {
      const F = prep.mix.factors[r] * tuple.weight;
      const variants = Array.from({ length: N }, (_, i) => prep.infos(s, i, prep.extraOf(tuple, i)));
      const M = variants.map((v) => momentsOf(ctx, v));
      // Suffix products of the reels' total weights (with y for the scatters).
      const suf = new Array(N).fill(null), sufSum = new Array(N).fill(1n);
      suf[N - 1] = [1n];
      for (let i = N - 2; i >= 0; i--) { suf[i] = pmul(suf[i + 1], M[i + 1].T); sufSum[i] = sufSum[i + 1] * M[i + 1].Tsum; }
      padd(SD, pmul(M[0].T, suf[0]), F);
      for (let j = 0; j < P; j++) {
        let Pk = [alg.unit], Pp = alg.unit, Hk = 1n;
        for (let k = 1; k <= N; k++) {
          const m = M[k - 1];
          Pk = apmul(alg, Pk, m.A[j]);
          Pp = amul(alg, Pp, m.Ap[j]);
          Hk *= m.Al[j];
          if (Hk === 0n) break;
          const pay = pays[j][k];
          if (!pay) continue;
          const LP = Pk.map((x) => aL(alg, x));
          const wy = k < N ? pmul(pmul(LP, M[k].Z[j]), suf[k]) : LP;
          const zs = k < N ? M[k].Zsum[j] * sufSum[k] : 1n;
          combos[j][k] += F * psum(wy);
          pureC[j][k] += F * aL(alg, Pp) * zs;
          hitsK[j][k] += F * Hk * zs;
          padd(WY, wy, F * pay);
        }
      }
      for (let j = 0; j < P; j++) for (let l = j; l < P; l++) S2 += F * (j === l ? 1n : 2n) * pairMoment(ctx, M, j, l);
      if (doHits) noWinMass(ctx, variants, cap).forEach((w, c) => { noWin[c] += F * w; });
      onProgress(++step / steps);
    }
  });

  // Spin moments from the ways part and the scatter distribution.
  const total = prep.total;
  const SP = (c) => BigInt(model.scatterPays[c] || 0);
  const trig = (c) => triggerAt !== null && c >= triggerAt;
  let s1 = 0n, s2 = S2, sJ = 0n, sXJ = 0n;
  for (let c = 0; c < Math.max(WY.length, SD.length); c++) {
    const wy = WY[c] || 0n, sd = SD[c] || 0n, sp = SP(c);
    s1 += wy + sp * sd;
    s2 += 2n * sp * wy + sp * sp * sd;
    if (trig(c)) { sJ += sd; sXJ += wy + sp * sd; }
  }
  let hitsW = null;
  if (doHits) {
    hitsW = total;
    noWin.forEach((w, c) => { if (!((model.scatterPays[c] || 0) > 0 || trig(c))) hitsW -= w; });
  }
  const par = [];
  for (let j = 0; j < P; j++) {
    for (let k = 1; k <= N; k++) {
      if (!pays[j][k] || !hitsK[j][k]) continue;
      const sym = model.ways.paying[j], pay = model.waysPays[sym][k];
      // payShown: the paytable's pay (units), before the global multiplier that pay holds.
      const payShown = pay / model.ways.globalMultiplier;
      par.push({ sym, count: k, wildAssisted: false, pay, payShown, combos: pureC[j][k], hits: hitsK[j][k] });
      par.push({ sym, count: k, wildAssisted: true, pay, payShown, combos: combos[j][k] - pureC[j][k], hits: 0n });
    }
  }
  return {
    mix: prep.mix, total, par, sd: SD,
    moments: { s1, s2, sJ, sXJ, hits: hitsW },
    tuples: prep.tuples.length,
    // Per reel set, each reel's total window weight (heights x stops, or the joint table),
    // and the top reel's total weight: a set's cycle is their product.
    reelTotals: prep.sets.map((st) => st.reelTotals), topTotal: src.top ? prep.U : null,
  };
}

// ---- full per-spin distribution ----
// A left-to-right pass per (set, tuple), then mixed. A state is the scatter count so far
// (capped at `cap`, as jointDistribution does) and each running symbol's product (and
// board sum); it carries the distribution of the win already settled by symbols whose
// run has ended. Identical states merge, so this equals enumerating every board.
// Entries: { lineWin (the ways win, units), scat, count (BigInt) }.
export function waysEntries(model, src, { cap, maxStates = 300000, maxWork = 6000000, onProgress = () => {} } = {}) {
  const ctx = makeContext(model);
  const { P, N, paysN } = ctx;
  const board = model.ways.strategy === 'board';
  const prep = prepareSource(ctx, src);
  const can = new Array(N + 1).fill(false).map(() => new Uint8Array(P));
  for (let j = 0; j < P; j++) for (let i = N - 1; i >= 0; i--) can[i][j] = can[i + 1][j] || paysN[j][i + 1] > 0 ? 1 : 0;
  // The closed form gives the hit frequency only through the bit-mask DP (P <= 16).
  const tooLarge = () => (P <= MAX_HIT_SYMBOLS ? new ModelError(
    'التوزيع الكامل لهذه اللعبة كبير جدًا للحساب الدقيق (عدد الحالات تجاوز الحد). RTP والتباين ونسبة الفوز ما زالت دقيقة بالصيغة المغلقة؛ التوزيع متروك لمحاكاة مونت كارلو.',
    'The full distribution of this game is too large to compute exactly (state limit exceeded). RTP, variance and hit frequency are still exact (closed form); the distribution is left to Monte Carlo.')
    : new ModelError(
      'التوزيع الكامل لهذه اللعبة كبير جدًا للحساب الدقيق (عدد الحالات تجاوز الحد). RTP والتباين ما زالا دقيقين بالصيغة المغلقة؛ أما نسبة الفوز فغير متاحة هنا (أكثر من 16 رمزًا دافعًا)، فهي والتوزيع متروكان لمحاكاة مونت كارلو.',
      'The full distribution of this game is too large to compute exactly (state limit exceeded). RTP and variance are still exact (closed form); the hit frequency is not available here (more than 16 paying symbols), so it and the distribution are left to Monte Carlo.'));
  // Windows of a reel variant grouped by what the pass reads from them.
  const groupsOf = (v) => {
    if (v.groups) return v.groups;
    const map = new Map();
    for (const f of v.infos) {
      const parts = [f.sc];
      for (const j of f.alive) parts.push(j, f.cnt[j], f.mx[j]);
      const key = parts.join(',');
      const g = map.get(key);
      if (g) g.w += f.w; else map.set(key, { w: f.w, sc: f.sc, alive: f.alive, cnt: f.cnt, mx: f.mx });
    }
    return (v.groups = [...map.values()]);
  };
  const paid = (j, k, prod, ms) => { const pay = paysN[j][k]; return pay ? pay * prod * (board ? Math.max(1, ms) : 1) : 0; };
  // Final (win, scatter count) pairs: one map of win -> weight per capped scatter count,
  // so no key mixes the two (a win * 128 + count key passed 2^53 for wins near 2^50).
  const merged = Array.from({ length: cap + 1 }, () => new Map());
  const steps = prep.sets.length * prep.tuples.length;
  // Each (set, tuple) gets its share of the work budget, so a game far too large stops
  // within its first pass instead of after all of them.
  const budget = maxWork / steps;
  let step = 0;
  prep.sets.forEach((s, r) => {
    for (const tuple of prep.tuples) {
      const F = prep.mix.factors[r] * tuple.weight;
      // run: [j, product, boardSum, ...] of the running symbols, in symbol order.
      let states = new Map([['', { sc: 0, run: [], settled: new Map([[0, 1n]]) }]]);
      let work = 0;
      for (let i = 0; i < N; i++) {
        const groups = groupsOf(prep.infos(s, i, prep.extraOf(tuple, i)));
        const next = new Map();
        let size = 0;
        for (const st of states.values()) {
          for (const g of groups) {
            let delta = 0;
            const run = [];
            if (i === 0) {
              for (const j of g.alive) run.push(j, g.cnt[j], g.mx[j]);
            } else {
              const prev = st.run;
              let gi = 0;
              for (let q = 0; q < prev.length; q += 3) {
                const j = prev[q];
                while (gi < g.alive.length && g.alive[gi] < j) gi++;
                if (gi < g.alive.length && g.alive[gi] === j) {
                  if (can[i][j]) run.push(j, prev[q + 1] * g.cnt[j], prev[q + 2] + g.mx[j]);
                } else delta += paid(j, i, prev[q + 1], prev[q + 2]);
              }
            }
            const sc = Math.min(st.sc + g.sc, cap);
            const key = sc + '|' + run.join(',');
            let e = next.get(key);
            if (!e) next.set(key, (e = { sc, run, settled: new Map() }));
            work += st.settled.size + 1;
            if (work > budget) throw tooLarge();
            for (const [acc, w] of st.settled) {
              const a = acc + delta, old = e.settled.get(a);
              if (old === undefined) { e.settled.set(a, w * g.w); size++; } else e.settled.set(a, old + w * g.w);
            }
            if (size > maxStates) throw tooLarge();
          }
        }
        states = next;
      }
      for (const st of states.values()) {
        let delta = 0;
        for (let q = 0; q < st.run.length; q += 3) delta += paid(st.run[q], N, st.run[q + 1], st.run[q + 2]);
        const bySc = merged[st.sc];
        for (const [acc, w] of st.settled) {
          const win = acc + delta;
          bySc.set(win, (bySc.get(win) || 0n) + w * F);
        }
      }
      onProgress(++step / steps);
    }
  });
  const out = [];
  merged.forEach((bySc, scat) => { for (const [lineWin, count] of bySc) out.push({ lineWin, scat, count }); });
  return out;
}

// Hit frequency and variance from the closed-form moments, when the full distribution
// is too large. The free-spin part is the same branching-process closed form as in
// analyzeExact (slot-exact.js), from the moments instead of the entries.
// feature: { EFv, EFv2 }, the feature's own first two moments (units, multiplier
// included) when free-spin caps make them come from slot-exact.js's state sweep.
export function waysMomentSummary(model, b, x, total, fsTotal, ev, feature = null) {
  const fs = model.freeSpins, tb = model.totalBetUnits;
  let ew2 = new Fraction(b.s2, total);
  if (fs && feature) {
    ew2 = ew2.add(new Fraction(b.sXJ, total).mul(feature.EFv).mul(2n)).add(new Fraction(b.sJ, total).mul(feature.EFv2));
  } else if (fs) {
    const m = fs.multiplier, F = BigInt(fs.spins);
    const EX = new Fraction(x.s1, fsTotal).mul(m);
    const EX2 = new Fraction(x.s2, fsTotal).mul(m).mul(m);
    const EXI = new Fraction(x.sXJ, fsTotal).mul(m);
    const p = new Fraction(x.sJ, fsTotal);
    const oneMinus = new Fraction(1n).sub(p.mul(F));
    const EZ = EX.div(oneMinus);
    const EZ2 = EX2.add(EXI.mul(EZ).mul(2n * F)).add(p.mul(F * (F - 1n)).mul(EZ).mul(EZ)).div(oneMinus);
    const EFv = EZ.mul(F);
    const EFv2 = EZ2.mul(F).add(EZ.mul(EZ).mul(F * (F - 1n)));
    ew2 = ew2.add(new Fraction(b.sXJ, total).mul(EFv).mul(2n)).add(new Fraction(b.sJ, total).mul(EFv2));
  }
  const variance = ew2.sub(ev.mul(ev)).div(tb * tb);
  return { hits: b.hits === null ? null : new Fraction(b.hits, total), variance };
}

// ---- what the theoretical tab and the report show about a ways model ----
function heightsInfo(heights, top) {
  return heights.map((h, i) => {
    const covered = Boolean(top && top.covers.includes(i));
    let weights;
    if (h.joint) weights = h.rows.map((_, j) => h.joint.reduce((a, row) => a + row[j], 0n));
    else weights = h.weights || h.rows.map(() => 1n);
    const sum = weights.reduce((a, w) => a + w, 0n);
    return {
      rows: h.rows.slice(), joint: Boolean(h.joint), topCell: covered,
      probabilities: weights.map((w) => new Fraction(w, sum).toPercent(6)),
    };
  });
}
function sourceInfo(src) {
  const maxWays = src.heights.reduce((a, h, i) => a * BigInt(Math.max(...h.rows) + (src.top && src.top.covers.includes(i) ? 1 : 0)), 1n);
  const minWays = src.heights.reduce((a, h, i) => a * BigInt(Math.min(...h.rows) + (src.top && src.top.covers.includes(i) ? 1 : 0)), 1n);
  // (set, per reel (height, stop) with positive weight, top stop) combinations.
  const combos = src.sets.reduce((a, set) => a + src.heights.reduce((c, h, i) => {
    const len = set.reels[i].length;
    return c * BigInt(h.joint ? h.joint.reduce((n, row) => n + row.filter((w) => w > 0n).length, 0) : h.rows.length * len);
  }, 1n), 0n) * BigInt(src.top ? src.top.strip.length : 1);
  return {
    maxWays: maxWays.toString(), minWays: minWays.toString(), combinations: combos.toString(),
    variableHeights: src.heights.some((h) => h.rows.length > 1),
    heights: heightsInfo(src.heights, src.top),
    topReel: src.top ? { stops: src.top.strip.length, covers: src.top.covers.map((c) => c + 1), weighted: src.top.weights !== null } : null,
  };
}
export function waysModelInfo(model) {
  const w = model.ways;
  return {
    evaluation: 'ways', betCost: w.betCost, multiplierStrategy: w.strategy, globalMultiplier: w.globalMultiplier,
    // hasWild false: the model has no wild, so wildStartsWin changes nothing.
    wildStartsWin: w.wildStartsWin, hasWild: model.wild >= 0, cascades: Boolean(model.cascades),
    multiplierSymbols: model.symbols.map((name, id) => ({ name, id })).filter(({ id }) => w.cellMult[id] > 1 || w.cellBase[id] !== id)
      .map(({ name, id }) => ({ symbol: name, countsAs: model.symbols[w.cellBase[id]], multiplier: w.cellMult[id] })),
    base: sourceInfo(w.base),
    freeSpins: model.freeSpins && !model.freeSpins.sameReels ? sourceInfo(w.fs) : null,
    payingSymbols: w.paying.length,
    hitDp: w.paying.length <= MAX_HIT_SYMBOLS,
  };
}

// ---- one board, for the simulator: the win in model units and the scatter count ----
// cells: Int32Array with reel i's cells at i * stride .. i * stride + lens[i] - 1.
export function waysBoardEvaluator(model) {
  const N = model.nReels;
  const { cellBase, cellMult, paying, strategy, wildStartsWin } = model.ways;
  const P = paying.length;
  const payIndex = new Int32Array(model.symbols.length).fill(-1);
  paying.forEach((id, j) => { payIndex[id] = j; });
  const pays = Array.from(paying, (id) => model.waysPays[id]);
  const n = new Int32Array(N * P), m = new Int32Array(N * P), x = new Int32Array(N * P);
  const wn = new Int32Array(N), wm = new Int32Array(N), wx = new Int32Array(N);
  const board = strategy === 'board', sym = strategy === 'symbol';
  const wild = model.wild, scatter = model.scatter;
  return (cells, lens, stride) => {
    n.fill(0); m.fill(0); x.fill(0); wn.fill(0); wm.fill(0); wx.fill(0);
    let sc = 0;
    for (let i = 0; i < N; i++) {
      for (let r = 0; r < lens[i]; r++) {
        const id = cells[i * stride + r], b = cellBase[id], mu = cellMult[id];
        if (b === wild) { wn[i]++; wm[i] += mu; if (mu > 1) wx[i] += mu; } else if (b === scatter) sc++;
        else {
          const j = payIndex[b];
          if (j >= 0) { const q = i * P + j; n[q]++; m[q] += mu; if (mu > 1) x[q] += mu; }
        }
      }
    }
    let win = 0;
    for (let j = 0; j < P; j++) {
      let prod = 1, ms = 0, k = 0;
      for (let i = 0; i < N; i++) {
        const q = i * P + j, nn = n[q];
        if (i === 0 && !wildStartsWin ? nn === 0 : nn + wn[i] === 0) break;
        prod *= sym ? m[q] + wm[i] : nn + wn[i];
        if (board) ms += x[q] + wx[i];
        k++;
      }
      if (k > 0 && pays[j][k]) win += pays[j][k] * prod * (board ? Math.max(1, ms) : 1);
    }
    return { win: win + model.scatterPays[sc], scatters: sc };
  };
}

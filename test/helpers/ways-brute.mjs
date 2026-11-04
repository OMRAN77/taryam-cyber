// Brute force for small ways models with free spins (test/lab/ways-round.test.mjs and
// test/ui/lab-ways-round.test.js), written from the README's rules and independent of
// lab/core: every board is enumerated, and the feature is built from trees cut at a
// depth by direct sparse convolution on the coin lattice (see the unit test's header
// for the bound on the mass the cuts leave out).

// 3 reels, heights 2 or 3 drawn with their own weights, uniform stops; 1 scatter per
// strip (so at most one per window); free spins on 3-row windows, x2, with retrigger.
export const MINI = {
  name: 'Mini ways with free spins', evaluation: 'ways', betCost: 10,
  heights: [
    [{ rows: 2, weight: 1 }, { rows: 3, weight: 2 }],
    [{ rows: 2, weight: 1 }, { rows: 3, weight: 1 }],
    [{ rows: 2, weight: 2 }, { rows: 3, weight: 1 }],
  ],
  reels: [
    ['A', 'K', 'S', 'Q', 'J', 'K', 'A', 'Q', 'J', 'T'],
    ['K', 'W', 'A', 'J', 'S', 'Q', 'K', 'T', 'Q', 'J', 'A'],
    ['Q', 'A', 'K', 'J', 'S', 'T', 'Q', 'W', 'K', 'J', 'A', 'T'],
  ],
  paytable: { A: [0, 0, 16], K: [0, 0, 8], Q: [0, 0, 5], J: [0, 0, 3], T: [0, 0, 3] },
  wild: { symbol: 'W' },
  scatter: {
    symbol: 'S', pays: [0, 0, 2],
    freeSpins: { trigger: 3, spins: 5, multiplier: 2, retrigger: true, heights: [[{ rows: 3, weight: 1 }], [{ rows: 3, weight: 1 }], [{ rows: 3, weight: 1 }]] },
  },
};

// ---- brute force: every board ----
function windowsOf(strip, heights) {
  const out = [];
  for (const h of heights) {
    for (let s = 0; s < strip.length; s++) {
      const cells = [];
      for (let i = 0; i < h.rows; i++) cells.push(strip[(s + i) % strip.length]);
      out.push({ cells, weight: BigInt(h.weight) });
    }
  }
  return out;
}
// { total, cells: [{ coins, scat, w }] }: the spin's win in coins and scatter count.
export function spinTable(raw, heights) {
  const lists = raw.reels.map((strip, r) => windowsOf(strip, heights[r]));
  const map = new Map();
  let total = 0n;
  const rec = (r, board, w) => {
    if (r === lists.length) {
      let coins = 0;
      for (const [sym, pays] of Object.entries(raw.paytable)) {
        let ways = 1, k = 0;
        for (const win of board) {
          const c = win.cells.filter((x) => x === sym || x === raw.wild.symbol).length;
          if (!c) break;
          ways *= c; k++;
        }
        if (k && pays[k - 1]) coins += pays[k - 1] * ways;
      }
      const scat = board.reduce((a, win) => a + win.cells.filter((x) => x === raw.scatter.symbol).length, 0);
      coins += (scat ? raw.scatter.pays[scat - 1] : 0) * raw.betCost;
      const key = coins + ',' + scat;
      map.set(key, (map.get(key) || 0n) + w);
      total += w;
      return;
    }
    for (const win of lists[r]) rec(r + 1, [...board, win], w * win.weight);
  };
  rec(0, [], 1n);
  return { total, cells: [...map].map(([k, w]) => { const [coins, scat] = k.split(',').map(Number); return { coins, scat, w }; }) };
}

// Sparse convolution on 0..D; `cut.mass` collects what falls past D.
export function conv(a, b, D, cut) {
  const out = new Float64Array(D + 1);
  const nb = [];
  for (let j = 0; j <= D; j++) if (b[j]) nb.push(j);
  for (let i = 0; i <= D; i++) {
    const ai = a[i];
    if (!ai) continue;
    for (const j of nb) {
      if (i + j > D) cut.mass += ai * b[j];
      else out[i + j] += ai * b[j];
    }
  }
  return out;
}
export function power(a, n, D, cut) {
  let r = null, b = a;
  while (n) {
    if (n & 1) r = r ? conv(r, b, D, cut) : b;
    n >>= 1;
    if (n) b = conv(b, b, D, cut);
  }
  return r;
}
// Round pmf (coins) of a ways game with uncapped retriggers, from trees cut at `depth`.
export function bruteRoundUncapped(raw, D = 6000, depth = 20) {
  const fs = raw.scatter.freeSpins, m = fs.multiplier;
  const base = spinTable(raw, raw.heights), free = spinTable(raw, fs.heights || raw.heights);
  const cut = { mass: 0 };
  const A = new Float64Array(D + 1), B = new Float64Array(D + 1);
  let pR = 0;
  for (const c of free.cells) {
    const p = Number(c.w) / Number(free.total);
    (c.scat >= fs.trigger ? B : A)[c.coins * m] += p;
    if (c.scat >= fs.trigger) pR += p;
  }
  let phi = A.slice();
  for (let n = 1; n <= depth; n++) {
    const next = conv(B, power(phi, fs.spins, D, cut), D, cut);
    for (let x = 0; x <= D; x++) next[x] += A[x];
    phi = next;
  }
  const feature = power(phi, fs.spins, D, cut);
  const round = new Float64Array(D + 1);
  let pT = 0;
  for (const c of base.cells) {
    const p = Number(c.w) / Number(base.total);
    if (c.scat >= fs.trigger) {
      pT += p;
      for (let x = 0; x + c.coins <= D; x++) round[x + c.coins] += p * feature[x];
    } else round[c.coins] += p;
  }
  const depthCut = pT * fs.spins * pR * (fs.spins * pR) ** depth;
  return { round, bound: depthCut + cut.mass, base, free, pR, pT };
}

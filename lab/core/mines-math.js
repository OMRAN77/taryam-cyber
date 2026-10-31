// The arithmetic behind a Mines round (5×5 grid by default): what each click
// risks, what a fair payout would be, and what the game actually pays — so the gap,
// which is the house's take, can be shown on the real game's own numbers.
//
//   P(survive k picks) = C(T−M, k) / C(T, k)        T tiles, M mines
//   P(this click is safe | k−1 survived) = (T−M−(k−1)) / (T−(k−1))
//   fair multiplier after k = 1 / P(survive k)         (pays back exactly what is risked)
//   offered multiplier      = what the game shows; implied RTP_k = offered_k × P(survive k)
//   expected return at k    = bet × offered_k × P(survive k) = bet × RTP_k
//   expected loss at k      = bet × (1 − RTP_k), the same at every k when RTP is flat.

export function choose(n, k) {
  if (k < 0 || k > n) return 0;
  k = Math.min(k, n - k);
  let r = 1;
  for (let i = 1; i <= k; i++) r = (r * (n - k + i)) / i;
  return Math.round(r);
}

export function pSurvive(k, mines, tiles = 25) {
  return choose(tiles - mines, k) / choose(tiles, k);
}

export function pSafeNext(k, mines, tiles = 25) {
  // probability that the k-th click (1-based) is safe given k−1 safe so far
  return (tiles - mines - (k - 1)) / (tiles - (k - 1));
}

export function fairMultiplier(k, mines, tiles = 25) {
  return 1 / pSurvive(k, mines, tiles);
}

// Parses the multipliers the game displays: "1.12 1.29 ×1.48, 1.71x" → [1.12, 1.29, 1.48, 1.71].
export function parseMultipliers(text) {
  const t = String(text || '').replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x660)).replace(/٫/g, '.').replace(/[×xX]/g, ' ');
  return (t.match(/\d+(?:\.\d+)?/g) || []).map(Number).filter((v) => v > 0);
}

// One row per possible safe click, with the offered multiplier taken from the game
// when given (else from a flat RTP), the fair one, and the implied RTP of that step.
export function ladder({ mines, tiles = 25, offered = [], rtp = 0.96, bet = 1 }) {
  if (!(Number.isInteger(mines) && mines >= 1 && mines <= tiles - 1)) throw new RangeError('mines');
  const rows = [];
  const maxK = tiles - mines;
  for (let k = 1; k <= maxK; k++) {
    const ps = pSurvive(k, mines, tiles);
    const fair = 1 / ps;
    const fromGame = offered[k - 1];
    const mult = fromGame !== undefined ? fromGame : Math.floor(fair * rtp * 100) / 100;
    rows.push({
      k, pSafeNext: pSafeNext(k, mines, tiles), pBombNext: 1 - pSafeNext(k, mines, tiles), pSurvive: ps,
      fair, offered: mult, fromGame: fromGame !== undefined,
      impliedRtp: mult * ps, takePct: 1 - mult * ps,
      expectedReturn: bet * mult * ps, expectedLoss: bet * (1 - mult * ps), payoutIfSurvive: bet * mult,
    });
  }
  return rows;
}

// Session summary for a flat RTP: what n rounds of `bet` cost in expectation, and
// the chance of ending ahead when cashing out after k picks each time.
export function sessionExpectation({ rounds, bet, rtp = 0.96 }) {
  return { wagered: rounds * bet, expectedLoss: rounds * bet * (1 - rtp), expectedBack: rounds * bet * rtp };
}

// Probability of being ahead after n rounds of the same strategy (cash out after k picks
// at multiplier m, else lose the bet): binomial exact for small n, normal otherwise.
export function pAheadAfter({ rounds, pWin, mult }) {
  // ahead when wins × mult × bet > rounds × bet  ⇔ wins > rounds / mult
  const need = Math.floor(rounds / mult) + 1;
  if (rounds <= 2000) {
    let p = 0;
    let logC = 0; // log C(rounds, w) iteratively
    for (let w = 0; w <= rounds; w++) {
      if (w > 0) logC += Math.log(rounds - w + 1) - Math.log(w);
      if (w >= need) p += Math.exp(logC + w * Math.log(pWin) + (rounds - w) * Math.log(1 - pWin));
    }
    return Math.min(1, Math.max(0, p));
  }
  const mu = rounds * pWin, sd = Math.sqrt(rounds * pWin * (1 - pWin));
  const z = (need - 0.5 - mu) / sd;
  return 0.5 * erfc(z / Math.SQRT2);
}

function erfc(x) {
  const t = 1 / (1 + 0.5 * Math.abs(x));
  const y = t * Math.exp(-x * x - 1.26551223 + t * (1.00002368 + t * (0.37409196 + t * (0.09678418 + t * (-0.18628806 + t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))))));
  return x >= 0 ? y : 2 - y;
}

// Win and loss in common casino games. A game is an outcome distribution: a list of
// [payout, probability] pairs, where payout is what comes back per 1 unit bet,
// stake included (0 = the bet is lost). simulatePlayers() runs many seeded players
// through the same session so the spread of outcomes can be shown, not only the mean.
import { makeRoundPlayer } from './montecarlo.js';

export class GameError extends Error {
  constructor(ar, en) { super(en); this.ar = ar; this.en = en; }
}

function choose(n, k) {
  let r = 1;
  for (let i = 0; i < k; i++) r = (r * (n - i)) / (i + 1);
  return r;
}

const isInt = (x) => Number.isInteger(x);

// Roulette, exact: a bet on red pays 1:1, a single number 35:1.
export const rouletteEuRed = () => [[2, 18 / 37], [0, 19 / 37]];
export const rouletteEuNumber = () => [[36, 1 / 37], [0, 36 / 37]];
export const rouletteUsRed = () => [[2, 18 / 38], [0, 20 / 38]];

// Crash: the round's multiplier reaches m with probability rtp / m, and cashing out
// at m pays m. Most crash games publish rtp = 97%.
export function crash({ cashout = 2, rtp = 0.97 } = {}) {
  if (!(cashout >= 1.01 && cashout <= 1e6)) throw new GameError('مضاعف السحب لازم يكون بين 1.01 و 1,000,000', 'The cash-out multiplier must be between 1.01 and 1,000,000');
  const p = rtp / cashout;
  return [[cashout, p], [0, 1 - p]];
}

// Mines: `mines` hidden among `tiles`, the player reveals `picks` tiles and wins only
// if none is a mine. P(win) = C(tiles - mines, picks) / C(tiles, picks); the payout
// is rtp / P(win). Most mines games publish rtp = 97%.
export function mines({ mines = 3, picks = 5, tiles = 25, rtp = 0.97 } = {}) {
  if (!isInt(mines) || mines < 1 || mines >= tiles) throw new GameError(`عدد الألغام لازم يكون من 1 إلى ${tiles - 1}`, `Mines must be from 1 to ${tiles - 1}`);
  if (!isInt(picks) || picks < 1 || picks > tiles - mines) throw new GameError(`عدد المربعات لازم يكون من 1 إلى ${tiles - mines}`, `Tiles to reveal must be from 1 to ${tiles - mines}`);
  const p = choose(tiles - mines, picks) / choose(tiles, picks);
  return [[rtp / p, p], [0, 1 - p]];
}

// Blackjack, approximate: perfect basic strategy with doubles and splits folded into
// plain wins. Blackjack 4.5% (pays 3:2), push 8.5%, and the win share set so the
// return is 99.5%, the usual figure for perfect play.
export function blackjack() {
  const bj = 0.045, push = 0.085, rtp = 0.995;
  const win = (rtp - 2.5 * bj - push) / 2;
  return [[2.5, bj], [2, win], [1, push], [0, 1 - bj - win - push]];
}

// Any game reduced to win or lose: with probability winChance the bet returns
// rtp / winChance, otherwise nothing.
export function simpleGame({ rtp, winChance }) {
  if (!(rtp > 0 && rtp <= 1.5)) throw new GameError('نسبة العائد لازم تكون بين 0 و 150٪', 'The return must be between 0 and 150%');
  if (!(winChance > 0 && winChance < 1)) throw new GameError('فرصة الفوز لازم تكون بين 0 و 100٪', 'The win chance must be between 0 and 100%');
  return [[rtp / winChance, winChance], [0, 1 - winChance]];
}

export function describe(dist) {
  let rtp = 0, m2 = 0, winChance = 0, maxPayout = 0;
  for (const [x, p] of dist) {
    rtp += x * p;
    m2 += x * x * p;
    if (x > 1) winChance += p;
    if (x > maxPayout) maxPayout = x;
  }
  return { rtp, houseEdge: 1 - rtp, winChance, sd: Math.sqrt(Math.max(0, m2 - rtp * rtp)), maxPayout };
}

export function sampler(dist) {
  const xs = dist.map((d) => d[0]);
  const cum = [];
  let c = 0;
  for (const [, p] of dist) cum.push((c += p));
  const last = xs.length - 1;
  return (rng) => {
    const u = rng.nextU32() / 4294967296;
    for (let i = 0; i < last; i++) if (u < cum[i]) return xs[i];
    return xs[last];
  };
}

// A slot model (slot-model.js) played round by round, free spins included. Stop
// weights and reel sets are drawn exactly and without bias by montecarlo.js.
export function slotSampler(model) {
  const { play } = makeRoundPlayer(model);
  const tb = model.totalBetUnits;
  return (rng) => play(rng) / tb;
}

function quantile(sorted, q) {
  const i = Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))));
  return sorted[i];
}

// Every player starts with `balance` and bets `bet` each round for up to `rounds`
// rounds. A player stops early when the balance drops below one bet (broke) or, if
// `target` is set, once it reaches the target. Balances are recorded at
// `checkpoints` evenly spaced rounds for the percentile bands and sample paths.
export function simulatePlayers(draw, rng, { players = 1000, rounds, bet, balance, target = null, checkpoints = 60, samplePaths = 12, onProgress = () => {} }) {
  if (!(bet > 0)) throw new GameError('الرهان لازم يكون أكبر من صفر', 'The bet must be above zero');
  if (!(balance >= bet)) throw new GameError('الرصيد لازم يكون أكبر من الرهان أو يساويه', 'The balance must be at least one bet');
  if (!isInt(rounds) || rounds < 1) throw new GameError('عدد الجولات لازم يكون عدد صحيح أكبر من صفر', 'Rounds must be a whole number above zero');
  if (!isInt(players) || players < 1) throw new GameError('عدد اللاعبين لازم يكون عدد صحيح أكبر من صفر', 'Players must be a whole number above zero');
  if (target !== null && !(target > balance)) throw new GameError('هدف التوقف لازم يكون أكبر من رصيد البداية', 'The stop target must be above the starting balance');
  const eps = 1e-9 * Math.max(1, bet);
  const steps = Math.min(checkpoints, rounds);
  const at = Array.from({ length: steps + 1 }, (_, i) => Math.round((i * rounds) / steps));
  const grid = Array.from({ length: steps + 1 }, () => new Float64Array(players));
  const finals = new Float64Array(players);
  const bustRounds = [];
  let ahead = 0, reached = 0, wageredSum = 0, wonSum = 0;
  for (let p = 0; p < players; p++) {
    let bal = balance, k = 1, played = 0, wagered = 0, won = 0;
    grid[0][p] = bal;
    while (played < rounds) {
      const x = draw(rng);
      bal += bet * (x - 1);
      wagered += bet;
      won += bet * x;
      played++;
      while (k <= steps && at[k] <= played) grid[k++][p] = bal;
      if (bal < bet - eps) { bustRounds.push(played); break; }
      if (target !== null && bal >= target - eps) { reached++; break; }
    }
    while (k <= steps) grid[k++][p] = bal;
    finals[p] = bal;
    if (bal > balance + eps) ahead++;
    wageredSum += wagered;
    wonSum += won;
    if ((p + 1) % 25 === 0) onProgress((p + 1) / players);
  }
  onProgress(1);
  const sortedFinals = Float64Array.from(finals).sort();
  let total = 0;
  for (const f of finals) total += f;
  bustRounds.sort((a, b) => a - b);
  const half = Math.ceil(players / 2);
  const band = { p10: [], p50: [], p90: [] };
  for (const col of grid) {
    const s = Float64Array.from(col).sort();
    band.p10.push(quantile(s, 0.1));
    band.p50.push(quantile(s, 0.5));
    band.p90.push(quantile(s, 0.9));
  }
  const paths = [];
  for (let p = 0; p < Math.min(samplePaths, players); p++) paths.push(grid.map((col) => col[p]));
  return {
    players, rounds, bet, balance, target,
    ahead, broke: bustRounds.length, reached,
    meanFinal: total / players, medianFinal: quantile(sortedFinals, 0.5),
    bestFinal: sortedFinals[players - 1], worstFinal: sortedFinals[0],
    meanWagered: wageredSum / players, observedRtp: wageredSum > 0 ? wonSum / wageredSum : null,
    // Rounds after which half of all players had gone broke (null if fewer than half did).
    medianBustRound: bustRounds.length >= half ? bustRounds[half - 1] : null,
    at, band, paths,
  };
}

// A real session from a casino's transaction history.
export function sessionSummary({ start = null, bets, wins }) {
  if (!(bets > 0)) throw new GameError('مجموع الرهانات لازم يكون أكبر من صفر', 'Total bets must be above zero');
  if (!(wins >= 0)) throw new GameError('مجموع الأرباح لازم يكون صفر أو أكثر', 'Total wins must be zero or more');
  if (start !== null && !(start > 0)) throw new GameError('رصيد البداية لازم يكون أكبر من صفر', 'The starting balance must be above zero');
  const net = wins - bets;
  return {
    net, returnRate: wins / bets, houseTake: 1 - wins / bets,
    turnover: start === null ? null : bets / start,
    end: start === null ? null : start + net,
  };
}

// Observed RTP from a play log (bet and win per round), its confidence interval,
// a test against the declared RTP, and how many rounds a reliable verdict needs.
import { forEachCsvRow, findColumn, detectDelimiter } from './csv.js';
import { normalQuantile, erfc } from './specfun.js';

const BET_NAMES = ['bet', 'stake', 'wager', 'betamount', 'الرهان', 'رهان', 'المبلغ'];
const WIN_NAMES = ['win', 'payout', 'return', 'won', 'prize', 'winamount', 'الربح', 'ربح', 'الفوز', 'فوز'];
// Rows that share a round id are one round (a paid spin and the free spins it
// triggered, a cascade, a bonus pick...).
const ROUND_NAMES = ['roundid', 'round', 'gameround', 'gameid', 'spinid', 'betid', 'رقمالجولة', 'الجولة', 'جولة'];
// Base game, bonus buy, ante... Each mode has its own RTP.
const MODE_NAMES = ['mode', 'gamemode', 'bettype', 'feature', 'النمط', 'نوعاللعب'];
// Did the round trigger a feature (free spins, bonus)? Read by the distribution
// tests (audit-stats.js). A column named "feature" stays the game mode, as it was
// before trigger columns existed (feature = 1 often marks bonus-buy rounds); only
// next to a separate mode column is it read as this flag.
const TRIGGER_NAMES = ['trigger', 'triggered', 'featuretriggered', 'freespinstriggered', 'bonustriggered', 'التفعيل', 'تفعيل'];
const FLAG_FALSE = new Set(['', '0', 'false', 'no', 'n', 'f', 'none', '-', '—', 'لا', 'خطأ']);
const FLAG_TRUE = new Set(['1', 'true', 'yes', 'y', 't', 'نعم', 'صح']);

// A trigger cell: 1/0, true/false, yes/no, a number (non-zero = triggered) or a
// feature name (triggered). The distribution CSVs read their flags with it too.
export function flagSet(cell, readNumber) {
  const s = String(cell ?? '').trim().toLowerCase();
  if (FLAG_FALSE.has(s)) return false;
  if (FLAG_TRUE.has(s)) return true;
  const v = readNumber(s);
  return !Number.isFinite(v) || v !== 0;
}

export const CONFIDENCE_LEVELS = [0.9, 0.95, 0.99, 0.999];

// A shortfall is only called "review" or "suspicious" below these one-sided P-values.
export const REVIEW_P = 0.05;
export const SUSPICIOUS_P = 0.001;

const ARABIC_DIGITS = /[٠-٩۰-۹]/g;

// Reads "1.5", "1,5" and "1.234,5" (a decimal comma is only possible when the
// file is not comma-separated), Arabic-Indic digits and the Arabic decimal sign.
export function makeNumberReader(delimiter) {
  const commaDecimal = delimiter !== ',';
  return (cell) => {
    let s = String(cell ?? '').trim()
      .replace(ARABIC_DIGITS, (d) => String((d.charCodeAt(0) & 0xf) % 10))
      .replace(/٫/g, '.').replace(/[٬  ]/g, '');
    if (s === '') return NaN;
    if (commaDecimal && s.includes(',')) {
      if (/^[+-]?\d{1,3}(\.\d{3})+,\d+$/.test(s)) s = s.replace(/\./g, '').replace(',', '.');
      else if (/^[+-]?\d*,\d+$/.test(s)) s = s.replace(',', '.');
    }
    return Number(s);
  };
}

// Returns one entry per paid round. Rows with bet 0 (free spins, respins, bonus
// rounds) add their win to the paid round before them; dropping them would hide
// part of what the game paid and bias the RTP down. Consecutive rows with the
// same round id are one round.
export function parsePlayLog(text) {
  const delimiter = detectDelimiter(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  const readNumber = makeNumberReader(delimiter);
  const bets = [], wins = [], modes = [], triggers = [];
  const skipped = [];
  const merged = { freeRows: 0, sameRoundRows: 0 };
  let betCol = 0, winCol = 1, roundCol = -1, modeCol = -1, trigCol = -1, first = true, header = null;
  let lastId = null;
  forEachCsvRow(text, (row, line) => {
    if (first) {
      first = false;
      if (row.some((c) => c.trim() !== '' && !Number.isFinite(readNumber(c)))) {
        header = row;
        betCol = findColumn(row, BET_NAMES);
        winCol = findColumn(row, WIN_NAMES);
        roundCol = findColumn(row, ROUND_NAMES);
        trigCol = findColumn(row, TRIGGER_NAMES);
        const featureCol = findColumn(row, ['feature']);
        modeCol = findColumn(row.map((h, i) => (i === featureCol ? '' : h)), MODE_NAMES);
        // "feature" alone is the mode; next to a separate mode column, the trigger flag.
        if (featureCol >= 0 && modeCol < 0) modeCol = featureCol;
        else if (featureCol >= 0 && trigCol < 0) trigCol = featureCol;
        if (betCol < 0 || winCol < 0) throw Object.assign(new Error('header must contain a bet column and a win column (e.g. "bet,win")'), {
          ar: 'يجب أن يحتوي العنوان على عمود للرهان وعمود للربح (مثل "bet,win")',
          en: 'The header must contain a bet column and a win column (e.g. "bet,win")',
        });
        return;
      }
    }
    const b = readNumber(row[betCol]);
    const w = readNumber(row[winCol]);
    if (!Number.isFinite(b) || !Number.isFinite(w)) { skipped.push({ line, reason: 'not a number' }); return; }
    if (b < 0) { skipped.push({ line, reason: 'bet must be ≥ 0' }); return; }
    if (w < 0) { skipped.push({ line, reason: 'win must be ≥ 0' }); return; }
    const id = roundCol >= 0 ? String(row[roundCol] ?? '').trim() || null : null;
    const n = bets.length;
    const flag = trigCol >= 0 && flagSet(row[trigCol], readNumber) ? 1 : 0;
    if (id !== null && n > 0 && id === lastId) {
      bets[n - 1] += b; wins[n - 1] += w; merged.sameRoundRows++;
      if (flag) triggers[n - 1] = 1;
      return;
    }
    if (b === 0) {
      if (n === 0) { skipped.push({ line, reason: 'free round before any paid round' }); return; }
      wins[n - 1] += w; merged.freeRows++;
      if (flag) triggers[n - 1] = 1;
      if (id !== null) lastId = id;
      return;
    }
    bets.push(b); wins.push(w); triggers.push(flag);
    if (modeCol >= 0) modes.push(String(row[modeCol] ?? '').trim() || '—');
    lastId = id;
  });
  return {
    bets: Float64Array.from(bets), wins: Float64Array.from(wins), modes: modeCol >= 0 ? modes : null,
    triggers: trigCol >= 0 ? Uint8Array.from(triggers) : null,
    skipped, merged, header, delimiter,
    columns: { bet: betCol, win: winCol, round: roundCol, mode: modeCol, trigger: trigCol },
  };
}

function summarizeModes(bets, wins, modes) {
  if (!modes) return null;
  const by = new Map();
  for (let i = 0; i < bets.length; i++) {
    let m = by.get(modes[i]);
    if (!m) by.set(modes[i], m = { mode: modes[i], rounds: 0, totalBet: 0, totalWin: 0 });
    m.rounds++; m.totalBet += bets[i]; m.totalWin += wins[i];
  }
  if (by.size < 2) return null;
  return [...by.values()].map((m) => ({ ...m, rtp: m.totalWin / m.totalBet }));
}

// declaredRtp and sigma are fractions of the bet (0.96 for 96%); sigma is the
// declared per-round standard deviation per unit bet, if the game sheet gives one.
//
// Why a shortfall verdict needs the declared sigma: the deviation computed from
// the data is too small whenever the rare big wins have not shown up yet, which is
// most of the time in a high-volatility game. With it, a fair game's log is
// regularly called "suspicious". No test can bound the mean of unbounded data
// without outside information (Bahadur & Savage, 1956), so without the game's
// sigma the verdict is "insufficient evidence", never an accusation.
export function analyzePlayLog(log, { declaredRtp = null, confidence = 0.95, sigma = null } = {}) {
  const { bets, wins } = log;
  const n = bets.length;
  if (n < 2) throw Object.assign(new Error('need at least 2 rounds'), { ar: 'يلزم جولتان على الأقل', en: 'At least 2 rounds are needed' });
  let sumBet = 0, sumWin = 0, sumBet2 = 0, hits = 0, maxMult = 0;
  for (let i = 0; i < n; i++) {
    sumBet += bets[i]; sumWin += wins[i]; sumBet2 += bets[i] * bets[i];
    if (wins[i] > 0) hits++;
    maxMult = Math.max(maxMult, wins[i] / bets[i]);
  }
  const rtp = sumWin / sumBet;
  const meanBet = sumBet / n;
  let ss = 0;
  for (let i = 0; i < n; i++) { const d = wins[i] - rtp * bets[i]; ss += d * d; }
  const sdResidual = Math.sqrt(ss / (n - 1));
  const sigmaObserved = sdResidual / meanBet; // per unit bet
  const seObserved = sdResidual / Math.sqrt(n) / meanBet; // ratio-estimator (delta method)
  const hasSigma = Number.isFinite(sigma) && sigma > 0;
  const seDeclared = hasSigma ? sigma * Math.sqrt(sumBet2) / sumBet : null;
  const se = seDeclared ?? seObserved;
  const sigmaUsed = hasSigma ? sigma : sigmaObserved;
  const z = normalQuantile(1 - (1 - confidence) / 2);
  const out = {
    rounds: n, totalBet: sumBet, totalWin: sumWin, meanBet, rtp,
    hitRate: hits / n, maxWinMultiple: maxMult,
    sigmaObserved, sigmaUsed, sigmaSource: hasSigma ? 'declared' : 'observed',
    standardError: se, confidence,
    ci: [rtp - z * se, rtp + z * se],
    roundsNeeded: [0.001, 0.005, 0.01, 0.02].map((margin) => ({ margin, rounds: Math.ceil((z * sigmaUsed / margin) ** 2) })),
    merged: log.merged || null,
    modes: summarizeModes(bets, wins, log.modes),
  };
  // With sigma from the data, "enough rounds" can't be known: that sigma is too small
  // exactly when it matters.
  out.reliable = hasSigma ? n >= out.roundsNeeded.find((r) => r.margin === 0.01).rounds : null;
  if (declaredRtp !== null && declaredRtp !== undefined) {
    const diff = rtp - declaredRtp;
    const zStat = diff / se;
    // The question is "does the game pay less than it says?": a one-sided test.
    const pBelow = 0.5 * erfc(-zStat / Math.SQRT2);
    const pAbove = 0.5 * erfc(zStat / Math.SQRT2);
    let verdict = 'normal';
    if (diff < 0 && pBelow < REVIEW_P) verdict = !hasSigma ? 'insufficient' : pBelow < SUSPICIOUS_P ? 'suspicious' : 'review';
    out.declared = {
      rtp: declaredRtp, difference: diff, z: zStat,
      pValue: pBelow, pBelow, pAbove, pTwoSided: Math.min(1, 2 * Math.min(pBelow, pAbove)),
      verdict,
      direction: diff < 0 ? 'below' : 'above',
      aboveDeclared: diff > 0 && pAbove < REVIEW_P,
      insideCi: declaredRtp >= out.ci[0] && declaredRtp <= out.ci[1],
      // Rounds to detect a gap this large at 5% (one-sided) with 80% power.
      roundsToDetect: diff === 0 ? null : Math.ceil(((normalQuantile(1 - REVIEW_P) + normalQuantile(0.8)) * sigmaUsed / Math.abs(diff)) ** 2),
    };
  }
  return out;
}

// Reads a bet history pasted straight from a casino's "My bets" table: one round
// per line, in whatever order the site prints dates, ids, bets, multipliers and
// payouts. Rules, per line, after dates, times, ids and currency marks are removed:
//   - a multiplier written ×2.5, x2.5 or 2.5x is remembered and taken out;
//   - the first remaining number is the bet, the last is the payout;
//   - with one number and a multiplier, payout = bet × multiplier;
//   - anything else is skipped and reported.
// A CSV with a header naming bet and win columns goes through parsePlayLog.
import { parsePlayLog } from './actual.js';

const DIGITS = { '٠': '0', '١': '1', '٢': '2', '٣': '3', '٤': '4', '٥': '5', '٦': '6', '٧': '7', '٨': '8', '٩': '9', '۰': '0', '۱': '1', '۲': '2', '۳': '3', '۴': '4', '۵': '5', '۶': '6', '۷': '7', '۸': '8', '۹': '9' };
const MONTHS = '(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*|(?:يناير|فبراير|مارس|أبريل|ابريل|مايو|يونيو|يوليو|أغسطس|اغسطس|سبتمبر|أكتوبر|اكتوبر|نوفمبر|ديسمبر)';

export function normalizeDigits(s) {
  return String(s).replace(/[٠-٩۰-۹]/g, (d) => DIGITS[d]).replace(/٫/g, '.').replace(/٬/g, ',');
}

function clean(line) {
  let s = normalizeDigits(line);
  s = s.replace(/(?<!\d)\d{1,4}[-/.]\d{1,2}[-/.]\d{1,4}(?:[T ]\d{1,2}:\d{2}(?::\d{2})?(?:\.\d+)?Z?)?/g, ' '); // 30/10/2026, 2026-10-30T14:05:07
  s = s.replace(/(?<!\d)\d{1,2}:\d{2}(?::\d{2})?(?:\s*[ap]\.?m\.?)?(?!\d)/gi, ' ');   // 14:05, 2:05:07 pm
  s = s.replace(new RegExp(`(?<!\\d)\\d{1,2}\\s+(?:${MONTHS})\\.?,?\\s*(?:\\d{2,4})?`, 'gi'), ' ');  // 30 Oct 2026
  s = s.replace(new RegExp(`(?:${MONTHS})\\.?\\s+\\d{1,2},?\\s*(?:\\d{2,4})?`, 'gi'), ' ');     // Oct 30, 2026
  s = s.replace(/[#№]\s*\d+|(?<![\d.])\d{7,}(?![\d.])|\b(?=[a-z0-9]*\d)(?=[a-z0-9]*[a-z])[a-z0-9]{10,}\b/gi, ' '); // bet ids
  s = s.replace(/[$€£¥₹₽]|AED|USD|EUR|GBP|USDT|BTC|ETH|TRX|درهم|دولار|ريال|د\.إ/gi, ' ');
  return s;
}

const MULT = /(?:[×x]\s*(\d+(?:[.,]\d+)?)|(\d+(?:[.,]\d+)?)\s*[×x])(?![\d.])/i;
const NUM = /(?<![\d.])[-+]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?(?![\d])/g;

function toNumber(tok) {
  return Number(String(tok).replace(/,/g, ''));
}

export function parseLine(line) {
  let s = clean(line);
  let mult = null;
  const m = MULT.exec(s);
  if (m) { mult = toNumber((m[1] || m[2]).replace(',', '.')); s = s.slice(0, m.index) + ' ' + s.slice(m.index + m[0].length); }
  const nums = (s.match(NUM) || []).map(toNumber).filter((v) => Number.isFinite(v) && v >= 0);
  if (nums.length >= 2) {
    const bet = nums[0], win = nums[nums.length - 1];
    if (bet > 0) return { bet, win, mult };
  }
  if (nums.length === 1 && mult !== null && nums[0] > 0) return { bet: nums[0], win: nums[0] * mult, mult };
  return null;
}

export function parseHistory(text) {
  const raw = String(text || '');
  const firstLine = raw.split(/\r?\n/).find((l) => l.trim());
  if (firstLine && /\b(bet|stake|wager|الرهان)\b/i.test(firstLine) && /\b(win|payout|won|الربح|الفوز|المكسب)\b/i.test(firstLine) && /[,;\t]/.test(firstLine)) {
    const log = parsePlayLog(raw);
    return { bets: log.bets, wins: log.wins, rows: Array.from(log.bets, (b, i) => ({ line: i + 2, bet: b, win: log.wins[i], mult: null })), skipped: log.skipped.map((s) => ({ line: s.line, text: s.reason })), source: 'csv' };
  }
  const rows = [], skipped = [];
  raw.split(/\r?\n/).forEach((line, i) => {
    if (!line.trim()) return;
    const r = parseLine(line);
    if (r) rows.push({ line: i + 1, ...r });
    else skipped.push({ line: i + 1, text: line.trim().slice(0, 80) });
  });
  return { bets: Float64Array.from(rows, (r) => r.bet), wins: Float64Array.from(rows, (r) => r.win), rows, skipped, source: 'text' };
}

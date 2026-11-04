// Game maps shared by the operators that turn a list of floats in [0, 1) into a
// result the Stake way (Stake and the many sites that copy its scheme). Each game:
//   floats(params)            how many floats one round consumes
//   compute(floats, params)   the outcome: { display, ... }
//   compare(outcome, claimed) 'match' | 'mismatch' | 'unparsable' | 'edge'
//   win(outcome, params)      true / false / null (unknown) for binary bets
//   multiplier(...)           payout multiplier from a rule or a paytable, or null
//   stats                     how the published outcomes are distributed under fair play
import {
  limboDocs, limboCalc24, drawWithout, range, cardName, parseCard, splitList,
  compareTicks, compareMultiplier, compareInt, compareSet, floorMapProb, parseNumber, pfError,
} from './common.js';

const intParam = (v, lo, hi, name) => {
  const n = parseNumber(v);
  if (n === null || !Number.isInteger(n) || n < lo || n > hi) throw pfError(`قيمة غير صالحة لـ ${name}`, `Invalid ${name}`);
  return n;
};

// Dice target and comparison: "over" wins when roll > target, "under" when roll < target.
export function diceBet(params) {
  const target = parseNumber(params.target);
  if (target === null) return null;
  const c = String(params.condition || '').trim().toLowerCase();
  const over = ['over', '>', 'above', 'rollover', 'roll over', 'فوق', 'أكبر'].includes(c) ? true
    : ['under', '<', 'below', 'rollunder', 'roll under', 'تحت', 'أصغر'].includes(c) ? false : null;
  if (over === null) return null;
  return { target, targetTicks: Math.round(target * 100), over };
}

const keyOf = (o, ...ks) => ks.reduce((x, k) => (x && x[k] !== undefined ? x[k] : (x && x[String(k).toLowerCase()] !== undefined ? x[String(k).toLowerCase()] : undefined)), o);

// Dice on N ticks (value = ticks / 100): Stake 10001 ticks, 0.00-100.00.
export function diceGame(N = 10001, label = 'floor(f × 10001) / 100') {
  return {
    formula: label,
    params: ['target', 'condition'],
    floats: () => 1,
    compute: ([f]) => { const ticks = Math.floor(f * N); return { ticks, display: (ticks / 100).toFixed(2) }; },
    compare: (o, c) => compareTicks(o.ticks, c),
    win(o, p) { const b = diceBet(p); return b ? (b.over ? o.ticks > b.targetTicks : o.ticks < b.targetTicks) : null; },
    // Win chance in % as the operator states it (100 - target over, target under) and
    // multiplier = RTP x 100 / chance. Only with a paytable { "rtp": 0.99 }.
    multiplier(o, p, table) {
      const b = diceBet(p);
      if (!b || !table || typeof table.rtp !== 'number') return null;
      const chance = b.over ? 100 - b.target : b.target;
      return chance > 0 ? (table.rtp * 100) / chance : null;
    },
    stats: { type: 'ticks', N, prob: (a, b) => floorMapProb(a, b, N) },
  };
}

export const LIMBO_FORMULAS = {
  calc24: { label: '2^24 / (floor(f × 2^24) + 1) × 0.99', fn: limboCalc24 },
  docs: { label: '1e8 / (f × 1e8) × 0.99', fn: limboDocs },
};

export const limboGame = {
  params: ['target'],
  floats: () => 1,
  compute([f], p, opts = {}) {
    const which = opts.limboFormula === 'docs' ? 'docs' : 'calc24';
    const r = LIMBO_FORMULAS[which].fn(f);
    const other = LIMBO_FORMULAS[which === 'docs' ? 'calc24' : 'docs'].fn(f);
    return { ...r, formula: which, otherCents: other.cents, display: Number.isFinite(r.raw) ? (r.cents / 100).toFixed(2) : '∞' };
  },
  compare: (o, c) => compareMultiplier(o, c),
  win(o, p) { const t = parseNumber(p.target); return t === null ? null : o.cents >= Math.round(t * 100); },
  multiplier(o, p) { const t = parseNumber(p.target); return t === null ? null : t; },
  // P(shown >= m), m in cents: calculator floor(99 2^24 / m) / 2^24; docs (floor(99 2^32 / m) + 1) / 2^32.
  stats: {
    type: 'multiplier',
    survival: (m, opts = {}) => (opts.limboFormula === 'docs'
      ? Math.min(1, (Number((99n << 32n) / BigInt(m)) + 1) / 2 ** 32)
      : Math.min(1, Number((99n << 24n) / BigInt(m)) / 2 ** 24)),
  },
};

export const rouletteGame = {
  formula: 'floor(f × 37)',
  params: [],
  floats: () => 1,
  compute: ([f]) => { const v = Math.floor(f * 37); return { value: v, display: String(v) }; },
  compare: (o, c) => compareInt(o.value, c),
  stats: { type: 'categorical', N: 37, prob: (j) => floorMapProb(j, j + 1, 37) },
};

export const wheelGame = {
  formula: 'floor(f × segments)',
  params: ['segments'],
  floats: () => 1,
  compute([f], p) { const n = intParam(p.segments, 2, 1000, 'segments'); const v = Math.floor(f * n); return { value: v, segments: n, display: String(v) }; },
  compare: (o, c) => compareInt(o.value, c),
  stats: { type: 'categorical', key: 'segments', prob: (j, o) => floorMapProb(j, j + 1, o.segments) },
};

// Keno: 10 numbers from 1..40 without replacement.
export const kenoGame = {
  formula: '10 × floor(f × remaining) from 1..40',
  params: ['picks', 'risk'],
  floats: () => 10,
  compute: (fs) => { const drawn = drawWithout(fs, range(1, 40)); return { values: drawn, display: drawn.join(' ') }; },
  compare: (o, c) => compareSet(o.values, c),
  hits(o, p) { const picks = splitList(p.picks).map(Number).filter(Number.isInteger); return picks.length ? picks.filter((x) => o.values.includes(x)).length : null; },
  multiplier(o, p, table) {
    const picks = splitList(p.picks).map(Number).filter(Number.isInteger);
    const row = keyOf(table, p.risk || 'classic', picks.length);
    const hits = this.hits(o, p);
    return Array.isArray(row) && hits !== null && hits < row.length ? row[hits] : null;
  },
  stats: { type: 'draws', N: 40, k: 10, base: 1 },
};

// Mines: positions drawn from 25 tiles without replacement; the first `mines` are mines.
// Numbering 0-24 (stake.us calculator) or 1-25 (option tileBase).
export const minesGame = {
  formula: 'floor(f × remaining) from 25 tiles',
  params: ['mines', 'revealed'],
  floats: (p) => intParam(p.mines, 1, 24, 'mines'),
  compute(fs, p, opts = {}) {
    const base = Number(opts.tileBase) === 1 ? 1 : 0;
    const values = drawWithout(fs, range(0, 24));
    return { values, base, display: values.map((v) => v + base).join(' ') };
  },
  compare: (o, c) => compareSet(o.values, c, 0, o.base),
  win(o, p) {
    const rev = splitList(p.revealed).map(Number).filter(Number.isInteger);
    return rev.length ? !rev.some((x) => o.values.includes(x - o.base)) : null;
  },
  // RTP x C(25, k) / C(25 - mines, k) for k safe tiles revealed; paytable { "rtp": 0.99 }.
  multiplier(o, p, table) {
    const k = splitList(p.revealed).length;
    if (!table || typeof table.rtp !== 'number' || !k) return null;
    const m = o.values.length;
    let x = table.rtp;
    for (let i = 0; i < k; i++) x *= (25 - i) / (25 - m - i);
    return x;
  },
  stats: { type: 'draws', N: 25, kFrom: 'values', base: 0 },
};

// Plinko: per row f < 0.5 is left, otherwise right; slot = number of rights (0-based).
export const plinkoGame = {
  formula: 'f < 0.5 → L, slot = number of R',
  params: ['rows', 'risk'],
  floats: (p) => intParam(p.rows, 8, 16, 'rows'),
  compute(fs) {
    const path = fs.map((f) => (f < 0.5 ? 'L' : 'R')).join('');
    const slot = path.split('').filter((x) => x === 'R').length;
    return { path, slot, rows: fs.length, display: `${path} (${slot})` };
  },
  compare(o, c) {
    const s = String(c ?? '').trim().toUpperCase().replace(/[\s,]+/g, '');
    if (/^\d+$/.test(s) && s.length <= 2) return Number(s) === o.slot ? 'match' : 'mismatch';
    if (/^[LR]+$/.test(s)) return s === o.path ? 'match' : 'mismatch';
    if (/^[01]+$/.test(s) && s.length === o.rows) return s.replace(/0/g, 'L').replace(/1/g, 'R') === o.path ? 'match' : 'mismatch';
    return 'unparsable';
  },
  multiplier(o, p, table) {
    const row = keyOf(table, o.rows, p.risk || 'low');
    return Array.isArray(row) && o.slot < row.length ? row[o.slot] : null;
  },
  stats: { type: 'binomial', key: 'rows' },
};

// Cards from an infinite deck (blackjack, hilo, baccarat): with replacement.
export const cardsGame = {
  formula: 'CARDS[floor(f × 52)], ♦2 ♥2 ♠2 ♣2 ♦3 … (with replacement)',
  params: ['count'],
  floats: (p, claimed) => {
    if (p.count !== undefined && String(p.count).trim() !== '') return intParam(p.count, 1, 416, 'count');
    const n = splitList(claimed).length;
    if (!n) throw pfError('عدد البطاقات غير معروف', 'Number of cards unknown');
    return n;
  },
  compute: (fs) => { const idx = fs.map((f) => Math.floor(f * 52)); return { values: idx, display: idx.map(cardName).join(' ') }; },
  compare(o, c) {
    const toks = splitList(c).map(parseCard);
    if (!toks.length || toks.includes(null)) return 'unparsable';
    return toks.length === o.values.length && toks.every((x, i) => x === o.values[i]) ? 'match' : 'mismatch';
  },
  stats: { type: 'categorical-multi', N: 52, prob: (j) => floorMapProb(j, j + 1, 52) },
};

// Lookup-table (LUT) games, audited exactly. A LUT game does not spin reels when a
// bet is placed: the server draws one pre-simulated round from a table, row i with
// probability w_i / sum(w). This reads the publish files of the Stake Engine math SDK
// (github.com/StakeEngine/math-sdk, MIT; docs/rgs_docs/data_format.md, read at commit
// 141b4e8 of 2026-11-02):
//   index.json   {"modes": [{"name", "cost", "events", "weights"}, ...]}
//   <weights>    CSV without a header, rows "id,weight,payout", each a uint64; the
//                payout is in hundredths of the base bet ("2,25668581149,20" = 0.20x)
// Every sum is BigInt, so weights above 2^53 keep their exact value (Stake's own
// verifier reads them with float()). For a mode costing c base bets:
//   RTP = sum(w*p) / (100 * c * sum(w))
// and every other figure here is an exact fraction until it is shown.
import { Fraction } from './fraction.js';

export class LutError extends Error {
  constructor(ar, en) {
    super(en);
    this.ar = ar;
    this.en = en;
  }
}
const fail = (ar, en) => new LutError(ar, en);

export const UINT64_MAX = (1n << 64n) - 1n;
const MAX_ROWS = 5_000_000;
const MAX_MODES = 64;
// Absolute big-win thresholds (x base bet), as in rgs_verification.py.
export const BIG_WIN_THRESHOLDS = [5000, 10000, 25000, 50000, 100000];
// Distribution buckets in multiples of the mode's cost: 0, (0,1), [1,2), ... , >= 5000.
export const BUCKETS = [0, 1, 2, 5, 10, 20, 50, 100, 500, 1000, 5000];

const frac = (f) => ({ fraction: f.toString(), value: f.toNumber(), percent: f.toPercent(6) });
const baseName = (p) => String(p).split(/[\\/]/).pop();
const clip = (s) => (s.length > 32 ? s.slice(0, 29) + '…' : s);

// What a selected file is, by its name.
export function lutFileKind(name) {
  const n = baseName(name).toLowerCase();
  if (/\.jsonl(\.zstd?)?$/.test(n) || /\.zstd?$/.test(n)) return 'books';
  if (n.endsWith('.json')) return 'index';
  if (n.endsWith('.csv')) return 'csv';
  return 'other';
}

// ---------- index.json ----------
export function parseLutIndex(text, fileName = 'index.json') {
  let data;
  try {
    data = JSON.parse(String(text).replace(/^﻿/, ''));
  } catch (e) {
    throw fail(`${fileName} ليس JSON صالحًا: ${e.message}`, `${fileName} is not valid JSON: ${e.message}`);
  }
  if (!data || typeof data !== 'object' || !Array.isArray(data.modes) || data.modes.length === 0) {
    throw fail(`${fileName}: يلزم مفتاح modes يحوي قائمة أنماط غير فارغة`, `${fileName}: a "modes" key holding a non-empty list of modes is required`);
  }
  if (data.modes.length > MAX_MODES) throw fail(`${fileName}: الحد الأقصى للأنماط ${MAX_MODES}`, `${fileName}: at most ${MAX_MODES} modes`);
  const names = new Set();
  const modes = data.modes.map((m, i) => {
    const at = [`${fileName}، النمط رقم ${i + 1}`, `${fileName}, mode #${i + 1}`];
    if (!m || typeof m !== 'object' || Array.isArray(m)) throw fail(`${at[0]}: ليس كائن JSON`, `${at[1]}: not a JSON object`);
    if (typeof m.name !== 'string' || !m.name.trim()) throw fail(`${at[0]}: الاسم name مفقود`, `${at[1]}: "name" is missing`);
    if (names.has(m.name)) throw fail(`${fileName}: اسم النمط «${m.name}» مكرر`, `${fileName}: mode name "${m.name}" appears twice`);
    names.add(m.name);
    if (typeof m.cost !== 'number' || !Number.isFinite(m.cost) || m.cost <= 0) {
      throw fail(`${at[0]} (${m.name}): التكلفة cost يجب أن تكون عددًا موجبًا`, `${at[1]} (${m.name}): "cost" must be a positive number`);
    }
    for (const k of ['events', 'weights']) {
      if (typeof m[k] !== 'string' || !m[k].trim()) throw fail(`${at[0]} (${m.name}): الحقل ${k} مفقود`, `${at[1]} (${m.name}): "${k}" is missing`);
    }
    // The cost as the decimal written in the file (Python writes the shortest form).
    return { name: m.name, cost: Fraction.fromDecimal(String(m.cost)), costText: String(m.cost), events: m.events, weights: m.weights };
  });
  return { modes };
}

// ---------- lookUpTable_<mode>.csv ----------
const COLUMN = [['المعرّف id', 'id'], ['الوزن weight', 'weight'], ['الدفع payout', 'payout']];
function uint(raw, col, file, line) {
  const s = raw.trim();
  if (!/^\d+$/.test(s)) {
    throw fail(`${file}، السطر ${line}: ${COLUMN[col][0]} «${clip(s)}» ليس عددًا صحيحًا غير سالب`,
      `${file}, line ${line}: ${COLUMN[col][1]} "${clip(s)}" is not a non-negative integer`);
  }
  const v = BigInt(s);
  if (v > UINT64_MAX) {
    throw fail(`${file}، السطر ${line}: ${COLUMN[col][0]} أكبر من أقصى قيمة uint64 (18446744073709551615)`,
      `${file}, line ${line}: ${COLUMN[col][1]} is above the uint64 maximum (18446744073709551615)`);
  }
  return v;
}
const isHeader = (fields) => fields.length === 3 && fields.every((f) => /^\s*[A-Za-z_][A-Za-z0-9_ ]*\s*$/.test(f));

// Reads one table. Rows with weight 0 are counted but carry no probability.
export function parseLutCsv(text, fileName = 'lookUpTable.csv', { onProgress = () => {} } = {}) {
  text = String(text);
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const n = text.length;
  const byPayout = new Map(); // payout -> total weight (rows with weight > 0)
  let ids = new BigUint64Array(1024);
  let rows = 0, zeroWeightRows = 0, blankLines = 0, header = false, badIncrementRows = 0;
  let totalWeight = 0n, sumW2 = 0n, maxRowWeight = 0n, maxRowId = null;
  let klSum = 0, klComp = 0; // Kahan sum of w*ln(w) for KL(w || uniform)
  let pos = 0, line = 0;
  while (pos < n) {
    let end = text.indexOf('\n', pos);
    if (end < 0) end = n;
    const raw = text.slice(pos, end);
    pos = end + 1;
    line++;
    if ((line & 0xffff) === 0) onProgress(pos / n);
    if (!raw.trim()) { blankLines++; continue; }
    const f = raw.split(',');
    if (rows === 0 && !header && isHeader(f)) { header = true; continue; }
    if (f.length !== 3) {
      throw fail(`${fileName}، السطر ${line}: يلزم 3 قيم مفصولة بفواصل (id, weight, payout)؛ عدد القيم في السطر: ${f.length}`,
        `${fileName}, line ${line}: expected 3 comma-separated values (id, weight, payout), found ${f.length}`);
    }
    const id = uint(f[0], 0, fileName, line), w = uint(f[1], 1, fileName, line), p = uint(f[2], 2, fileName, line);
    if (rows >= MAX_ROWS) throw fail(`${fileName}: الجدول أكبر من الحد (${MAX_ROWS.toLocaleString('en-US')} صف)`, `${fileName}: the table is larger than the limit (${MAX_ROWS.toLocaleString('en-US')} rows)`);
    if (rows === ids.length) { const g = new BigUint64Array(ids.length * 2); g.set(ids); ids = g; }
    ids[rows++] = id;
    if (p % 10n !== 0n) badIncrementRows++;
    if (w === 0n) { zeroWeightRows++; continue; }
    totalWeight += w;
    sumW2 += w * w;
    if (w > maxRowWeight) { maxRowWeight = w; maxRowId = id; }
    byPayout.set(p, (byPayout.get(p) || 0n) + w);
    const x = Number(w), y = x * Math.log(x) - klComp, s = klSum + y;
    klComp = (s - klSum) - y;
    klSum = s;
  }
  if (rows === 0) throw fail(`${fileName}: لا توجد صفوف بيانات`, `${fileName}: no data rows`);
  if (totalWeight === 0n) throw fail(`${fileName}: مجموع الأوزان صفر، فلا يمكن سحب أي جولة`, `${fileName}: the weights sum to 0, so no round can be drawn`);
  const sorted = ids.slice(0, rows).sort();
  for (let i = 1; i < rows; i++) {
    if (sorted[i] === sorted[i - 1]) {
      throw fail(`${fileName}: المعرّف ${sorted[i]} مكرر، ولكل جولة معرّف واحد`, `${fileName}: id ${sorted[i]} appears more than once; each round has one id`);
    }
  }
  // KL(w || uniform over all n rows) = sum q ln(q n) = (1/W) sum w ln w - ln W + ln n.
  const W = Number(totalWeight);
  const klNats = Math.max(0, klSum / W - Math.log(W) + Math.log(rows));
  onProgress(1);
  return { fileName, rows, zeroWeightRows, blankLines, header, badIncrementRows, totalWeight, sumW2, maxRowWeight, maxRowId, byPayout, klNats };
}

// ---------- per-mode statistics (exact) ----------
const cmpBig = (x, y) => (x < y ? -1 : x > y ? 1 : 0);

// Internal: everything as Fractions, for the summary and for the profile checks.
export function modeStats(mode, t) {
  const W = t.totalWeight, a = mode.cost.num, b = mode.cost.den;
  const C = 100n * a; // payout p (hundredths) is below the cost  <=>  p*b < 100*a
  const pays = [...t.byPayout.entries()].sort((x, y) => cmpBig(x[0], y[0]));
  let s1 = 0n, s2 = 0n, hitW = 0n, ldwW = 0n, belowW = 0n, etl40 = 0n, etl10k = 0n;
  const big = BIG_WIN_THRESHOLDS.map(() => 0n);
  const bucketW = new Array(BUCKETS.length + 1).fill(0n), bucketS = new Array(BUCKETS.length + 1).fill(0n);
  for (const [p, w] of pays) {
    const wp = w * p, pb = p * b;
    s1 += wp;
    s2 += wp * p;
    if (p > 0n) hitW += w;
    if (pb < C) { belowW += w; if (p > 0n) ldwW += w; }
    if (pb >= 40n * C) etl40 += wp; // win >= 40 x cost
    if (p >= 1_000_000n) etl10k += wp; // win >= 10,000 x base bet
    BIG_WIN_THRESHOLDS.forEach((T, i) => { if (p >= BigInt(T) * 100n) big[i] += w; });
    let k = 0;
    if (p > 0n) {
      k = BUCKETS.length;
      for (let i = 1; i < BUCKETS.length; i++) if (pb < BigInt(BUCKETS[i]) * C) { k = i; break; }
    }
    bucketW[k] += w;
    bucketS[k] += wp;
  }
  // CVaR(99.9%) as rgs_verification.py computes it: the tail starts at the first
  // payout (ascending) where the cumulative probability reaches 0.999, and the whole
  // atom at that payout is in the tail: E[X | X >= q].
  let cum = 0n, q = 0;
  for (; q < pays.length - 1; q++) { cum += pays[q][1]; if (1000n * cum >= 999n * W) break; }
  let tailW = 0n, tailS = 0n;
  for (let i = q; i < pays.length; i++) { tailW += pays[i][1]; tailS += pays[i][0] * pays[i][1]; }
  const [pMax, wMax] = pays[pays.length - 1];
  return {
    mode, table: t, W,
    rtp: new Fraction(s1 * b, C * W),
    hit: new Fraction(hitW, W),
    zero: new Fraction(W - hitW, W),
    ldw: new Fraction(ldwW, W),
    ldwShare: hitW ? new Fraction(ldwW, hitW) : null,
    below: new Fraction(belowW, W),
    // Variance of the return per unit staked, X / cost (Stake's "std" is its root).
    variance: new Fraction((s2 * W - s1 * s1) * b * b, C * C * W * W),
    maxPayout: pMax,
    maxX: new Fraction(pMax, 100n),
    maxXCost: new Fraction(pMax * b, C),
    maxProb: new Fraction(wMax, W),
    cvarQuantile: new Fraction(pays[q][0], 100n),
    cvarAbs: new Fraction(tailS, 100n * tailW),
    cvarRel: new Fraction(tailS * b, C * tailW),
    rtp40: new Fraction(etl40 * b, C * W),
    rtp10k: new Fraction(etl10k * b, C * W),
    etlAbs: new Fraction(etl40 + etl10k, 100n * W),
    share40: s1 ? new Fraction(etl40, s1) : null,
    share10k: s1 ? new Fraction(etl10k, s1) : null,
    big: big.map((w) => new Fraction(w, W)),
    buckets: bucketW.map((w, i) => ({
      from: i === 0 ? 0 : BUCKETS[i - 1], to: i === 0 ? 0 : i < BUCKETS.length ? BUCKETS[i] : null,
      probability: new Fraction(w, W), rtp: new Fraction(bucketS[i] * b, C * W),
    })),
    distinctPayouts: pays.length,
    ess: new Fraction(W * W, t.sumW2),
    maxRow: new Fraction(t.maxRowWeight, W),
  };
}

const oneIn = (p) => (p.isZero() ? null : new Fraction(p.den, p.num).toNumber());

// JSON-safe summary of one mode (strings and numbers only).
export function summarizeMode(s) {
  const m = s.mode, t = s.table;
  const sd = Math.sqrt(s.variance.toNumber());
  return {
    name: m.name, cost: { text: m.costText, ...frac(m.cost) }, weightsFile: m.weights, eventsFile: m.events,
    totalWeight: s.W.toString(),
    rtp: frac(s.rtp),
    hitRate: { ...frac(s.hit), oneIn: oneIn(s.hit) },
    zeroWin: frac(s.zero),
    ldw: frac(s.ldw),
    ldwShareOfWins: s.ldwShare && frac(s.ldwShare),
    belowCost: frac(s.below),
    variance: frac(s.variance),
    sd,
    maxWin: { payout: s.maxPayout.toString(), multiplier: frac(s.maxX), costMultiple: frac(s.maxXCost), probability: frac(s.maxProb), oneIn: oneIn(s.maxProb) },
    cvar999: { quantile: frac(s.cvarQuantile), absolute: frac(s.cvarAbs), relative: frac(s.cvarRel) },
    tail: {
      rtpFrom40xCost: frac(s.rtp40), rtpFrom10kx: frac(s.rtp10k),
      shareFrom40xCost: s.share40 && frac(s.share40), shareFrom10kx: s.share10k && frac(s.share10k),
    },
    bigWins: BIG_WIN_THRESHOLDS.map((T, i) => ({ threshold: T, probability: frac(s.big[i]), oneIn: oneIn(s.big[i]) })),
    buckets: s.buckets.map((x) => ({ from: x.from, to: x.to, probability: frac(x.probability), rtp: frac(x.rtp) })),
    transparency: {
      rows: t.rows, zeroWeightRows: t.zeroWeightRows, distinctPayouts: s.distinctPayouts,
      effectiveSize: frac(s.ess), effectiveShare: s.ess.toNumber() / t.rows,
      maxRowProbability: { ...frac(s.maxRow), oneIn: oneIn(s.maxRow), id: String(t.maxRowId) },
      klBits: t.klNats / Math.LN2, klNats: t.klNats, klMaxBits: Math.log2(t.rows),
    },
    format: { header: t.header, blankLines: t.blankLines, badIncrementRows: t.badIncrementRows },
  };
}

// ---------- "Stake Engine RGS limits" profile ----------
// Reproduces SUBMISSION_LIMITS, RISK_CHECKS and TEMPLATE_LIMITS of
// utils/rgs_verification.py (StakeEngine/math-sdk, commit 141b4e8 of 2026-11-02, as
// cited by the lab's research of that date). The checks there compare float values
// (float32 for the risk checks); here every comparison is exact.
const F = (s) => Fraction.fromDecimal(s);
const RISK = [
  { id: 'topWin', measures: [{ id: 'topWin', limit: '100000', unit: 'x', get: (s) => s.maxX }] },
  { id: 'costMultiplier', measures: [{ id: 'cost', limit: '5000', unit: 'x', get: (s) => s.mode.cost }] },
  { id: 'volatility', measures: [{ id: 'std', limit: '60', unit: 'n', get: (s) => s.variance, squared: true }] },
  {
    id: 'worst', measures: [
      { id: 'cvarRelative', limit: '700', unit: 'xc', get: (s) => s.cvarRel },
      { id: 'cvarAbsolute', limit: '50000', unit: 'x', get: (s) => s.cvarAbs },
    ],
  },
  {
    id: 'tail', measures: [
      { id: 'rtp40', limit: '0.9', unit: 'rtp', get: (s) => s.rtp40 },
      { id: 'rtp10k', limit: '0.8', unit: 'rtp', get: (s) => s.rtp10k },
      { id: 'combined', limit: '1.5', unit: 'rtp', get: (s) => s.rtp40.add(s.rtp10k) },
      { id: 'combinedAbs', limit: '10000', unit: 'x', get: (s) => s.etlAbs },
    ],
  },
  {
    id: 'bigWin', measures: [['5000', '0.05'], ['10000', '0.01'], ['25000', '0.005'], ['50000', '0.001'], ['100000', '0.0005']].map(([T, limit], i) => (
      { id: 'p' + T, threshold: Number(T), limit, unit: 'p', get: (s) => s.big[i] })),
  },
];
const TEMPLATE_LIMITS = [[50e6, 500e3], [25e6, 500e3], [15e6, 250e3], [10e6, 100e3], [5e6, 50e3], [1e6, 10e3], [500e3, 10e3], [100e3, 10e3], [50e3, 1e3]];
const MAX_TEMPLATE_BET = 1000;

export const STAKE_RGS_PROFILE = {
  id: 'stake-engine-rgs-limits',
  repository: 'https://github.com/StakeEngine/math-sdk',
  source: 'utils/rgs_verification.py',
  commit: '141b4e89065ac4400769709a919259a923430c4d',
  commitDate: '2026-11-02',
  researchDate: '2026-11-02',
  submission: { minRtp: 0.96, maxRtp: 0.967, rtpRounding: '4 decimal places, half up', baseCost: 1, maxCost: 50000, maxWin: 1000000, minBaseStd: 0.6 },
  risk: RISK.map((c) => ({ id: c.id, measures: c.measures.map((m) => ({ id: m.id, limit: Number(m.limit), unit: m.unit })) })),
  templateLimits: TEMPLATE_LIMITS,
  maxTemplateBet: MAX_TEMPLATE_BET,
};

// floor(f * 10^4 + 1/2) for f >= 0: Stake rounds the RTP to 4 places before the band check.
const round4 = (f) => (f.num * 20000n + f.den) / (2n * f.den);

export function stakeRgsChecks(stats) {
  const L = STAKE_RGS_PROFILE.submission;
  const submission = [];
  for (const s of stats) {
    const mode = s.mode.name, t = s.table;
    const r4 = round4(s.rtp);
    submission.push({ id: 'rtp', mode, unit: 'rtp', value: s.rtp.toNumber(), rounded: Number(r4) / 1e4, limit: [L.minRtp, L.maxRtp], ok: r4 >= 9600n && r4 <= 9670n });
    submission.push({ id: 'maxCost', mode, unit: 'x', value: s.mode.cost.toNumber(), limit: L.maxCost, ok: s.mode.cost.cmp(L.maxCost) <= 0 });
    submission.push({ id: 'maxWin', mode, unit: 'x', value: s.maxX.toNumber(), limit: L.maxWin, ok: s.maxX.cmp(L.maxWin) <= 0 });
    // verify_lookup_format(): the RGS refuses a table that breaks these.
    submission.push({ id: 'increment', mode, unit: 'n', value: t.badIncrementRows, limit: 0, ok: t.badIncrementRows === 0 });
    submission.push({ id: 'weightSum', mode, unit: 'n', value: s.W.toString(), limit: UINT64_MAX.toString(), ok: s.W <= UINT64_MAX });
    submission.push({ id: 'noHeader', mode, unit: 'n', value: t.header ? 1 : 0, limit: 0, ok: !t.header });
    submission.push({ id: 'noBlank', mode, unit: 'n', value: t.blankLines, limit: 0, ok: t.blankLines === 0 });
  }
  const minCost = stats.reduce((m, s) => (m === null || s.mode.cost.cmp(m) < 0 ? s.mode.cost : m), null);
  submission.push({ id: 'baseCost', mode: null, unit: 'x', value: minCost.toNumber(), limit: L.baseCost, ok: minCost.equals(L.baseCost) });
  const base = stats.filter((s) => s.mode.cost.equals(L.baseCost));
  if (base.length) {
    const minVar = base.reduce((m, s) => (m === null || s.variance.cmp(m) < 0 ? s.variance : m), null);
    submission.push({ id: 'baseStd', mode: null, unit: 'n', value: Math.sqrt(minVar.toNumber()), limit: L.minBaseStd, ok: minVar.cmp(F('0.36')) >= 0 });
  }

  const risk = [];
  for (const s of stats) {
    for (const c of RISK) {
      for (const m of c.measures) {
        const v = m.get(s), limit = F(m.limit);
        const over = m.squared ? v.cmp(limit.mul(limit)) > 0 : v.cmp(limit) > 0;
        risk.push({ category: c.id, measure: m.id, mode: s.mode.name, unit: m.unit, value: m.squared ? Math.sqrt(v.toNumber()) : v.toNumber(), limit: limit.toNumber(), ok: !over });
      }
    }
  }
  const failedCategories = RISK.filter((c) => risk.some((r) => r.category === c.id && !r.ok)).map((c) => c.id);

  // get_max_base_bet(): each failing risk category moves the game to a lower bet template.
  let maxBet;
  const nFailed = failedCategories.length;
  if (nFailed >= TEMPLATE_LIMITS.length) maxBet = new Fraction(0n);
  else {
    const [exposure, roundCost] = TEMPLATE_LIMITS[nFailed];
    const topWin = stats.reduce((m, s) => (s.maxX.cmp(m) > 0 ? s.maxX : m), new Fraction(0n));
    const topCost = stats.reduce((m, s) => (s.mode.cost.cmp(m) > 0 ? s.mode.cost : m), new Fraction(0n));
    maxBet = new Fraction(BigInt(MAX_TEMPLATE_BET));
    if (!topWin.isZero()) { const x = new Fraction(BigInt(exposure)).div(topWin); if (x.cmp(maxBet) < 0) maxBet = x; }
    if (!topCost.isZero()) { const x = new Fraction(BigInt(roundCost)).div(topCost); if (x.cmp(maxBet) < 0) maxBet = x; }
  }
  return {
    profile: { id: STAKE_RGS_PROFILE.id, repository: STAKE_RGS_PROFILE.repository, source: STAKE_RGS_PROFILE.source, commit: STAKE_RGS_PROFILE.commit, commitDate: STAKE_RGS_PROFILE.commitDate, researchDate: STAKE_RGS_PROFILE.researchDate },
    submission,
    submissionIssues: submission.filter((c) => !c.ok).length,
    risk,
    riskCategories: RISK.length,
    failedCategories,
    riskPassing: RISK.length - failedCategories.length,
    maxBaseBet: { fraction: maxBet.toString(), value: maxBet.toNumber(), template: Math.min(nFailed, TEMPLATE_LIMITS.length) },
  };
}

// ---------- whole upload ----------
// files: [{ name, text }] (text may be null for book files, which are not read).
export function analyzeLutFiles(files, { onProgress = () => {} } = {}) {
  if (!Array.isArray(files) || files.length === 0) throw fail('لم يتم اختيار ملفات', 'No files selected');
  const indexFiles = [], csv = new Map(), ignored = [], other = [];
  for (const f of files) {
    const name = baseName(f.name);
    const kind = lutFileKind(name);
    if (kind === 'index') indexFiles.push({ name, text: f.text });
    else if (kind === 'books') ignored.push(name);
    else if (kind === 'csv') {
      if (csv.has(name)) throw fail(`الملف ${name} مختار مرتين`, `The file ${name} was selected twice`);
      csv.set(name, f.text);
    } else other.push(name);
  }
  if (other.length) {
    throw fail(`ملفات من نوع غير متوقع: ${other.join('، ')}. المطلوب index.json وجداول CSV`, `Unexpected file types: ${other.join(', ')}. Expected index.json and CSV tables`);
  }
  if (indexFiles.length === 0) {
    throw fail('index.json مطلوب: يحدد الأنماط وتكلفة كل نمط واسم جدوله', 'index.json is required: it names the modes, the cost of each and its table');
  }
  if (indexFiles.length > 1) {
    throw fail(`يلزم ملف JSON واحد فقط (index.json)؛ الملفات المختارة: ${indexFiles.map((f) => f.name).join('، ')}`, `Exactly one JSON file (index.json) is needed; selected: ${indexFiles.map((f) => f.name).join(', ')}`);
  }
  const index = parseLutIndex(indexFiles[0].text, indexFiles[0].name);
  const wanted = [...new Set(index.modes.map((m) => baseName(m.weights)))];
  const missing = wanted.filter((n) => !csv.has(n));
  if (missing.length) {
    throw fail(`${indexFiles[0].name} يذكر جداول لم تُرفع: ${missing.join('، ')}`, `${indexFiles[0].name} lists tables that were not uploaded: ${missing.join(', ')}`);
  }
  const extra = [...csv.keys()].filter((n) => !wanted.includes(n));
  if (extra.length) {
    throw fail(`ملفات CSV غير مذكورة في ${indexFiles[0].name}: ${extra.join('، ')}`, `CSV files not listed in ${indexFiles[0].name}: ${extra.join(', ')}`);
  }
  const tables = new Map();
  wanted.forEach((n, i) => tables.set(n, parseLutCsv(csv.get(n), n, { onProgress: (p) => onProgress((i + p) / wanted.length) })));
  const stats = index.modes.map((m) => modeStats(m, tables.get(baseName(m.weights))));
  onProgress(1);
  return { format: 'stake-engine-lut', indexFile: indexFiles[0].name, modes: stats.map(summarizeMode), profile: stakeRgsChecks(stats), ignored };
}

// ---------- generated example ----------
// A synthetic two-mode table in the same format (not a real game): a base mode at
// 1x and a bonus buy at 100x, both tuned to an RTP of about 96.5%. Row weights reach
// 2^54, so the totals cannot be held exactly in a float. Deterministic.
export function makeSampleLut() {
  let seed = 0x2545f491;
  const rnd = () => { seed ^= seed << 13; seed >>>= 0; seed ^= seed >>> 17; seed ^= seed << 5; seed >>>= 0; return seed / 4294967296; };
  const SCALE = 2 ** 62;
  // Splits a level's weight over `count` rows with some spread.
  const spread = (total, count) => {
    const r = Array.from({ length: count }, () => 0.5 + rnd());
    const sum = r.reduce((x, y) => x + y, 0);
    const out = r.map((x) => BigInt(Math.floor((Number(total) * x) / sum)));
    out[count - 1] += total - out.reduce((x, y) => x + y, 0n);
    return out;
  };
  // levels: [x base bet, probability-ish share, rows]. The `fill` level absorbs the
  // weight that sets the RTP to the target, which must be below every other level's
  // mean for base (fill = 0) and above it for the bonus.
  const build = (levels, fill, costHundredths, zeroWeightRows) => {
    const rows = [];
    let s = 0n, w = 0n;
    for (const [x, share, count] of levels) {
      const p = BigInt(Math.round(x * 100));
      for (const wt of spread(BigInt(Math.round(share * SCALE)), count)) { rows.push([wt, p]); s += wt * p; w += wt; }
    }
    // Target sum(w*p) / (100 * cost * W) = 0.965, i.e. sum(w*p) = 0.965 * cost(hundredths) * W.
    const T = 965n * costHundredths; // per 1000 * W
    const pf = BigInt(Math.round(fill[0] * 100));
    // (s + pf*F) * 1000 = T * (w + F)  =>  F = (1000 s - T w) / (T - 1000 pf)
    const Fw = (1000n * s - T * w) / (T - 1000n * pf);
    if (Fw <= 0n) throw new Error('sample LUT: fill weight must be positive');
    for (const wt of spread(Fw, fill[1])) rows.push([wt, pf]);
    for (let i = 0; i < zeroWeightRows; i++) rows.push([0n, BigInt(Math.round(levels[Math.floor(rnd() * levels.length)][0] * 100))]);
    for (let i = rows.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [rows[i], rows[j]] = [rows[j], rows[i]]; }
    return rows.map(([wt, p], i) => `${i + 1},${wt},${p}`).join('\n') + '\n';
  };
  const base = build([
    [0.2, 0.06, 120], [0.5, 0.05, 100], [1, 0.1, 120], [1.5, 0.025, 50], [2, 0.07, 80], [3, 0.03, 60], [5, 0.03, 50],
    [10, 0.015, 40], [20, 0.005, 30], [50, 0.0012, 20], [100, 0.0004, 12], [500, 0.00005, 6], [1000, 0.00002, 4], [5000, 0.000003, 2],
  ], [0, 300], 100n, 24);
  const bonus = build([
    [5, 0.05, 20], [20, 0.12, 40], [30, 0.12, 40], [50, 0.15, 50], [75, 0.12, 40], [100, 0.1, 40], [150, 0.08, 30],
    [200, 0.06, 30], [300, 0.045, 20], [500, 0.03, 16], [1000, 0.012, 10], [2000, 0.004, 6], [5000, 0.001, 3],
  ], [10, 40], 10000n, 12);
  const index = '{\n    "modes": [\n'
    + '        {\n            "name": "base",\n            "cost": 1.0,\n            "events": "books_base.jsonl.zst",\n            "weights": "lookUpTable_base_0.csv"\n        },\n'
    + '        {\n            "name": "bonus",\n            "cost": 100.0,\n            "events": "books_bonus.jsonl.zst",\n            "weights": "lookUpTable_bonus_0.csv"\n        }\n'
    + '    ]\n}\n';
  return [
    { name: 'index.json', text: index },
    { name: 'lookUpTable_base_0.csv', text: base },
    { name: 'lookUpTable_bonus_0.csv', text: bonus },
  ];
}

// Reel-strip slot model: reading it from JSON, CSV or the form, validating it, and
// normalizing it for the exact engine and the simulator.
//
// Raw model (what users write; rows and line positions are 1-based, row 1 = top):
// {
//   "name": "...", "rows": 3,
//   "reels": [["A","K",...], ...],            one reel strip per reel, cyclic
//   "lines": [[2,2,2,2,2], ...],              row per reel for each payline
//   "paytable": { "A": [0,0,5,20,100], ... }, pay for 1..N of a kind, x line bet
//   "wild": { "symbol": "W", "pays": [...] }, substitutes for paying symbols
//   "scatter": { "symbol": "S", "pays": [...] (x total bet, by count anywhere),
//                "freeSpins": { "trigger": 3, "spins": 10, "multiplier": 2,
//                               "retrigger": true, "reels": [[...], ...],
//                               "maxSpins": 50, "maxRetriggers": 3 } }
// }
// Free-spin caps (optional, with retrigger only): "maxSpins" caps the spins one
// feature awards in all (start included; a retrigger past it adds only what is left)
// and "maxRetriggers" the retriggers that add spins (later ones still pay).
//
// Weighted stops and reel sets (optional):
//   "weights": [[3, 1, ...], ...]             one positive integer per stop, parallel to
//                                             "reels" (null for a reel = every stop weighs 1).
//                                             The window whose top row (row 1) is a stop
//                                             shows with probability weight / reel total;
//                                             the stops after it fill rows 2, 3, ... Weights
//                                             above 2^53 - 1 are written as strings ("123...").
//                                             A sheet that weights the stop on another row j
//                                             (e.g. the middle row 2 of 3) converts by
//                                             weights[p] = sheet[(p + j - 1) mod length].
//   "reelSets": [{ "weight": 3, "reels": [...], "weights": [...] }, ...]
//                                             instead of "reels": each spin first picks a
//                                             set with probability weight / sum of weights,
//                                             then its stops. Also allowed in freeSpins
//                                             (each free spin picks its own set).
import { Fraction } from './fraction.js';
import { parseCsv } from './csv.js';

export class ModelError extends Error {
  constructor(ar, en) {
    super(en);
    this.ar = ar;
    this.en = en;
  }
}

const err = (ar, en) => new ModelError(ar, en);
const MAX_REELS = 8, MAX_ROWS = 8, MAX_STOPS = 10000, MAX_LINES = 200;

export const STANDARD_LINES_5x3 = [
  [2, 2, 2, 2, 2], [1, 1, 1, 1, 1], [3, 3, 3, 3, 3], [1, 2, 3, 2, 1], [3, 2, 1, 2, 3],
  [2, 1, 1, 1, 2], [2, 3, 3, 3, 2], [1, 1, 2, 3, 3], [3, 3, 2, 1, 1], [2, 3, 2, 1, 2],
  [2, 1, 2, 3, 2], [1, 2, 2, 2, 1], [3, 2, 2, 2, 3], [1, 2, 1, 2, 1], [3, 2, 3, 2, 3],
  [2, 2, 1, 2, 2], [2, 2, 3, 2, 2], [1, 1, 3, 1, 1], [3, 3, 1, 3, 3], [1, 3, 1, 3, 1],
];

export function linePreset(preset, reels, rows) {
  const mid = Math.ceil(rows / 2);
  if (preset === 'middle') return [new Array(reels).fill(mid)];
  if (preset === 'rows') return Array.from({ length: rows }, (_, r) => new Array(reels).fill(r + 1));
  if (preset === 'standard20') {
    if (reels !== 5 || rows !== 3) throw err('خطوط 20 القياسية تحتاج 5 بكرات و3 صفوف', 'The standard 20 lines need 5 reels and 3 rows');
    return STANDARD_LINES_5x3.map((l) => l.slice());
  }
  throw err('قالب خطوط غير معروف', 'Unknown line preset');
}

function decimals(x) {
  const s = String(x);
  if (/e/i.test(s)) {
    const [m, e] = s.split(/e/i);
    return Math.max(0, (m.split('.')[1] || '').length - parseInt(e, 10));
  }
  return (s.split('.')[1] || '').length;
}

function payArray(value, maxCount, what) {
  let arr;
  if (Array.isArray(value)) arr = value;
  else if (value && typeof value === 'object') {
    arr = new Array(maxCount).fill(0);
    for (const [k, v] of Object.entries(value)) {
      const c = parseInt(k, 10);
      if (!(c >= 1 && c <= maxCount)) throw err(`عدد غير صالح "${k}" في دفع ${what}`, `Invalid count "${k}" in pays for ${what}`);
      arr[c - 1] = v;
    }
  } else throw err(`جدول دفع غير صالح للرمز ${what}`, `Invalid pays for ${what}`);
  if (arr.length > maxCount) throw err(`دفع ${what} أطول من ${maxCount}`, `Pays for ${what} are longer than ${maxCount}`);
  return arr.map((v) => {
    const x = typeof v === 'string' ? Number(v.trim() || 0) : Number(v);
    if (!Number.isFinite(x) || x < 0 || x > 1e9) throw err(`قيمة دفع غير صالحة للرمز ${what}: ${v}`, `Invalid pay for ${what}: ${v}`);
    if (decimals(x) > 6) throw err(`قيمة الدفع ${v} فيها أكثر من 6 خانات عشرية`, `Pay ${v} has more than 6 decimal places`);
    return x;
  });
}

// `what` names the reels in error messages: one text, or [arabic, english].
const names = (what) => (Array.isArray(what) ? what : [what, what]);

function strips(raw, what) {
  const [wa, we] = names(what);
  if (!Array.isArray(raw) || raw.length === 0) throw err(`${wa}: لا توجد بكرات`, `${we}: no reels`);
  if (raw.length > MAX_REELS) throw err(`${wa}: الحد الأقصى ${MAX_REELS} بكرات`, `${we}: at most ${MAX_REELS} reels`);
  return raw.map((reel, i) => {
    if (!Array.isArray(reel)) throw err(`${wa}: البكرة ${i + 1} ليست قائمة`, `${we}: reel ${i + 1} is not a list`);
    const s = reel.map((x) => String(x).trim()).filter((x) => x !== '');
    if (s.length === 0) throw err(`${wa}: البكرة ${i + 1} فارغة`, `${we}: reel ${i + 1} is empty`);
    if (s.length > MAX_STOPS) throw err(`${wa}: البكرة ${i + 1} أطول من ${MAX_STOPS}`, `${we}: reel ${i + 1} has more than ${MAX_STOPS} stops`);
    return s;
  });
}

// ---- Weighted stops and reel sets ----
const MAX_REEL_SETS = 32;
const MAX_WEIGHT = (1n << 64n) - 1n; // uint64, the widest weight real engines use

// A stop or reel-set weight: a whole number from 1 to 2^64 - 1, as a JS number (up to
// 2^53 - 1, beyond which JSON numbers lose digits), a string of digits or a BigInt.
// A JSON number of 2^53 or more has already been rounded when it gets here (both
// 9007199254740992 and 9007199254740993 read as 2^53), so the message does not
// quote it back as if the user had typed it.
export function parseWeight(v, ar, en) {
  let w = null;
  if (typeof v === 'bigint') w = v;
  else if (typeof v === 'number' && Number.isInteger(v)) {
    if (v >= 2 ** 53) throw err(`${ar}: الوزن رقم JSON يساوي 2^53 أو أكبر، وأرقام JSON بهذا الحجم تفقد بعض خاناتها؛ اكتبه نصًا بين علامتي تنصيص ليحتفظ بكل أرقامه`, `${en}: the weight is a JSON number of 2^53 or more, and JSON numbers this large lose digits; write it as a string in quotes so every digit is kept`);
    w = v < 0 ? -1n : BigInt(v); // any negative number fails the check below
  } else if (typeof v === 'string' && /^\s*\d+\s*$/.test(v)) w = BigInt(v.trim());
  if (w === null) throw err(`${ar}: الوزن "${v}" ليس عددًا صحيحًا`, `${en}: weight "${v}" is not a whole number`);
  if (w < 1n) throw err(`${ar}: الوزن يجب أن يكون 1 على الأقل (ما لا يظهر أبدًا يُحذف بدل إعطائه الوزن 0)`, `${en}: a weight must be at least 1 (remove what should never show instead of giving it weight 0)`);
  if (w > MAX_WEIGHT) throw err(`${ar}: الوزن أكبر من الحد الأقصى ${MAX_WEIGHT}`, `${en}: weight is above the maximum ${MAX_WEIGHT}`);
  return w;
}

// Reel strips with optional per-stop weights. Weights are parallel to the stops as
// written; a stop left empty is dropped together with its weight.
function weightedStrips(rawReels, rawWeights, what) {
  if (rawWeights === undefined || rawWeights === null) return { strips: strips(rawReels, what), weights: null };
  const s = strips(rawReels, what);
  const [wa, we] = names(what);
  if (!Array.isArray(rawWeights) || rawWeights.length !== rawReels.length) {
    throw err(`${wa}: الأوزان يجب أن تكون قائمة لكل بكرة (${rawReels.length})`, `${we}: weights must hold one list per reel (${rawReels.length})`);
  }
  const weights = rawWeights.map((wr, i) => {
    if (wr === null || wr === undefined) return null;
    const reel = rawReels[i];
    if (!Array.isArray(wr) || wr.length !== reel.length) {
      throw err(`${wa}: البكرة ${i + 1}: عدد المواقع ${reel.length} وعدد الأوزان ${Array.isArray(wr) ? wr.length : 0}، ويجب أن يتساويا`, `${we}: reel ${i + 1} has ${reel.length} stops but ${Array.isArray(wr) ? wr.length : 0} weights`);
    }
    const out = [];
    reel.forEach((x, p) => {
      if (String(x).trim() === '') return;
      out.push(parseWeight(wr[p], `${wa}: البكرة ${i + 1}، الموقع ${p + 1}`, `${we}: reel ${i + 1}, stop ${p + 1}`));
    });
    return out;
  });
  return { strips: s, weights: weights.some(Boolean) ? weights : null };
}

// The reels of the base game or of the free spins: "reels" (+ "weights") or "reelSets".
// Returns [{ weight, strips, weights }] or null when neither is given. `what` and
// `setsWhat` name the two keys in error messages.
function reelSource(raw, what, setsWhat) {
  if (raw.reelSets === undefined || raw.reelSets === null) {
    if (raw.reels === undefined || raw.reels === null) {
      if (raw.weights !== undefined && raw.weights !== null) throw err(`${what}: توجد أوزان بلا بكرات`, `${what}: weights are given without reels`);
      return null;
    }
    const { strips: s, weights } = weightedStrips(raw.reels, raw.weights, what);
    return [{ weight: 1n, strips: s, weights }];
  }
  if (raw.reels !== undefined && raw.reels !== null) throw err(`${what}: استخدم reels أو reelSets وليس الاثنين`, `${what}: use either reels or reelSets, not both`);
  if (raw.weights !== undefined && raw.weights !== null) throw err(`${what}: ضع الأوزان داخل كل مجموعة في reelSets`, `${what}: put the weights inside each entry of reelSets`);
  const sets = raw.reelSets;
  if (!Array.isArray(sets) || sets.length === 0) throw err(`${setsWhat}: القائمة فارغة`, `${setsWhat} is empty`);
  if (sets.length > MAX_REEL_SETS) throw err(`${setsWhat}: الحد الأقصى لعدد مجموعات البكرات ${MAX_REEL_SETS}`, `${setsWhat}: at most ${MAX_REEL_SETS} reel sets`);
  const out = sets.map((set, j) => {
    // "reelSets, set 1" rather than "reelSets[1]": no zero- vs one-based doubt, and no
    // brackets for the bidi algorithm to move around in right-to-left Arabic text.
    const [na, ne] = [`${setsWhat}، المجموعة ${j + 1}`, `${setsWhat}, set ${j + 1}`];
    if (!set || typeof set !== 'object' || Array.isArray(set)) throw err(`${na}: يجب أن تكون كائنًا { weight, reels }`, `${ne}: must be an object { weight, reels }`);
    if (set.weight === undefined || set.weight === null) throw err(`${na}: لا يوجد وزن للمجموعة`, `${ne}: the set has no weight`);
    const weight = parseWeight(set.weight, `${na}: وزن المجموعة`, `${ne}: set weight`);
    if (set.reels === undefined || set.reels === null) throw err(`${na}: لا توجد بكرات`, `${ne}: no reels`);
    return { weight, ...weightedStrips(set.reels, set.weights, [na, ne]) };
  });
  if (out.some((s) => s.strips.length !== out[0].strips.length)) throw err(`${setsWhat}: كل مجموعات البكرات يجب أن تكون بنفس عدد البكرات`, `${setsWhat}: every reel set must have the same number of reels`);
  return out;
}

// ---- Free-spin caps (whole-round distribution, P0-8) ----
export const MAX_FREE_SPINS_CAP = 10000;
export const MAX_RETRIGGERS_CAP = 1000;
const capValue = (v) => (v === undefined || v === null || v === '' ? null : Number(v));
// { maxSpins?, maxRetriggers? }: only the caps that are set, so a model without them
// normalizes exactly as before.
function freeSpinCaps(f, spins) {
  const maxSpins = capValue(f.maxSpins), maxRetriggers = capValue(f.maxRetriggers);
  if (maxSpins === null && maxRetriggers === null) return {};
  if (!f.retrigger) throw err('حدود اللفات المجانية (maxSpins وmaxRetriggers) لا تعمل إلا مع إعادة التفعيل', 'Free-spin caps (maxSpins, maxRetriggers) apply only with retrigger');
  const out = {};
  if (maxSpins !== null) {
    if (!Number.isInteger(maxSpins) || maxSpins < spins || maxSpins > MAX_FREE_SPINS_CAP) {
      throw err(`الحد الأقصى للفات المجانية (maxSpins) يجب أن يكون عددًا صحيحًا من ${spins} إلى ${MAX_FREE_SPINS_CAP}`, `freeSpins.maxSpins must be a whole number from ${spins} to ${MAX_FREE_SPINS_CAP}`);
    }
    out.maxSpins = maxSpins;
  }
  if (maxRetriggers !== null) {
    if (!Number.isInteger(maxRetriggers) || maxRetriggers < 0 || maxRetriggers > MAX_RETRIGGERS_CAP) {
      throw err(`الحد الأقصى لإعادات التفعيل (maxRetriggers) يجب أن يكون عددًا صحيحًا من 0 إلى ${MAX_RETRIGGERS_CAP}`, `freeSpins.maxRetriggers must be a whole number from 0 to ${MAX_RETRIGGERS_CAP}`);
    }
    out.maxRetriggers = maxRetriggers;
  }
  return out;
}

// True when a raw model has a "weights" or "reelSets" key anywhere, which the form
// cannot show, so the page edits it as JSON. This is about the keys, not the odds:
// normalizeModel(raw).weighted is false when they change nothing (one reel set, or
// only null weight lists), and such a model is analysed and simulated as unweighted.
export function isWeightedModel(raw) {
  if (!raw || typeof raw !== 'object') return false;
  const has = (o) => Boolean(o && typeof o === 'object' && ((o.weights !== undefined && o.weights !== null) || (o.reelSets !== undefined && o.reelSets !== null)));
  const sc = raw.scatter && typeof raw.scatter === 'object' ? raw.scatter : null;
  return has(raw) || has(sc && sc.freeSpins);
}

// Validates a raw model and returns the normalized form used by the engines.
export function normalizeModel(raw) {
  if (!raw || typeof raw !== 'object') throw err('النموذج ليس كائن JSON', 'The model is not a JSON object');
  if (raw.evaluation !== undefined && raw.evaluation !== null && raw.evaluation !== 'lines') return normalizeWaysModel(raw);
  const rows = Number(raw.rows ?? 1);
  if (!Number.isInteger(rows) || rows < 1 || rows > MAX_ROWS) throw err(`عدد الصفوف يجب أن يكون بين 1 و${MAX_ROWS}`, `rows must be between 1 and ${MAX_ROWS}`);
  const baseSets = reelSource(raw, 'reels', 'reelSets') || [{ weight: 1n, strips: strips(raw.reels, 'reels'), weights: null }];
  const baseStrips = baseSets.flatMap((set) => set.strips);
  const nReels = baseSets[0].strips.length;

  const symbols = [];
  const index = new Map();
  const idOf = (name) => {
    if (!index.has(name)) { index.set(name, symbols.length); symbols.push(name); }
    return index.get(name);
  };
  baseStrips.forEach((s) => s.forEach(idOf));

  const wildName = raw.wild ? String(typeof raw.wild === 'string' ? raw.wild : raw.wild.symbol || '').trim() : '';
  const scatterRaw = raw.scatter && typeof raw.scatter === 'object' ? raw.scatter : raw.scatter ? { symbol: raw.scatter } : null;
  const scatterName = scatterRaw ? String(scatterRaw.symbol || '').trim() : '';
  if (wildName && wildName === scatterName) throw err('لا يمكن أن يكون الرمز نفسه wild وscatter', 'The same symbol cannot be both wild and scatter');

  const paytable = raw.paytable || {};
  if (typeof paytable !== 'object' || Array.isArray(paytable)) throw err('جدول الدفع يجب أن يكون كائنًا: رمز ← قائمة دفع', 'paytable must be an object: symbol -> list of pays');
  const linePaysRaw = new Map();
  for (const [sym, pays] of Object.entries(paytable)) {
    const name = sym.trim();
    if (name === scatterName) continue; // scatter pays live under scatter.pays
    linePaysRaw.set(name, payArray(pays, nReels, name));
    idOf(name);
  }

  let fsSets = null;
  let freeSpins = null;
  if (scatterRaw && scatterRaw.freeSpins) {
    const f = scatterRaw.freeSpins;
    const trigger = Number(f.trigger), spins = Number(f.spins);
    if (!Number.isInteger(trigger) || trigger < 1) throw err('عدد رموز التفعيل للفري سبين يجب أن يكون عددًا صحيحًا ≥ 1', 'freeSpins.trigger must be an integer ≥ 1');
    if (!Number.isInteger(spins) || spins < 1 || spins > 1000) throw err('عدد الفري سبين يجب أن يكون بين 1 و1000', 'freeSpins.spins must be between 1 and 1000');
    const mult = Fraction.of(f.multiplier ?? 1);
    if (mult.cmp(0) <= 0 || mult.cmp(10000) > 0) throw err('مضاعف الفري سبين يجب أن يكون بين 0 و10000', 'freeSpins.multiplier must be in (0, 10000]');
    // No free-spin reels (key missing, null, or another falsy value such as "") means
    // "the base reels", as before reel sets existed; an empty list [] is an error.
    fsSets = reelSource({ ...f, reels: f.reels || undefined }, 'freeSpins.reels', 'freeSpins.reelSets');
    if (fsSets) {
      if (fsSets[0].strips.length !== nReels) throw err('بكرات الفري سبين يجب أن تكون بنفس عدد البكرات', 'freeSpins.reels must have the same number of reels');
      fsSets.forEach((set) => set.strips.forEach((s) => s.forEach(idOf)));
    }
    freeSpins = { trigger, spins, multiplier: mult, retrigger: Boolean(f.retrigger), sameReels: !fsSets, ...freeSpinCaps(f, spins) };
  }

  const wild = wildName ? idOf(wildName) : -1;
  const scatter = scatterName ? idOf(scatterName) : -1;
  if (wildName && !baseStrips.some((s) => s.includes(wildName))) throw err(`رمز الـwild "${wildName}" غير موجود في البكرات`, `Wild symbol "${wildName}" does not appear on the reels`);
  if (scatterName && !baseStrips.some((s) => s.includes(scatterName))) throw err(`رمز الـscatter "${scatterName}" غير موجود في البكرات`, `Scatter symbol "${scatterName}" does not appear on the reels`);

  const maxScatter = nReels * rows;
  const scatterPays = scatterRaw && scatterRaw.pays ? payArray(scatterRaw.pays, maxScatter, scatterName) : [];
  if (paytable[scatterName] && !(scatterRaw && scatterRaw.pays)) scatterPays.push(...payArray(paytable[scatterName], maxScatter, scatterName));
  const wildPays = raw.wild && typeof raw.wild === 'object' && raw.wild.pays ? payArray(raw.wild.pays, nReels, wildName) : (linePaysRaw.get(wildName) || []);
  if (freeSpins && freeSpins.trigger > maxScatter) throw err(`عدد التفعيل أكبر من أقصى عدد scatter ممكن (${maxScatter})`, `freeSpins.trigger exceeds the most scatters that can land (${maxScatter})`);

  let lines = raw.lines;
  if (lines === undefined || lines === null) lines = linePreset('middle', nReels, rows);
  if (typeof lines === 'string') lines = linePreset(lines, nReels, rows);
  if (!Array.isArray(lines) || lines.length === 0) throw err('لا توجد خطوط دفع', 'No paylines');
  if (lines.length > MAX_LINES) throw err(`الحد الأقصى ${MAX_LINES} خط`, `At most ${MAX_LINES} lines`);
  const lines0 = lines.map((line, i) => {
    if (!Array.isArray(line) || line.length !== nReels) throw err(`الخط ${i + 1} يجب أن يحدد صفًا لكل بكرة (${nReels})`, `Line ${i + 1} must give a row for each of the ${nReels} reels`);
    return line.map((r) => {
      const v = Number(r);
      if (!Number.isInteger(v) || v < 1 || v > rows) throw err(`الخط ${i + 1}: الصف ${r} خارج 1..${rows}`, `Line ${i + 1}: row ${r} is outside 1..${rows}`);
      return v - 1;
    });
  });

  // Exact integer units: one unit = line bet / scale, so every pay is an integer.
  let d = 0;
  const allPays = [...linePaysRaw.values(), wildPays, scatterPays];
  for (const arr of allPays) for (const p of arr) d = Math.max(d, decimals(p));
  const scale = 10 ** d;
  const L = lines0.length;
  const toUnits = (p, factor = 1) => Math.round(p * scale * factor);

  const linePays = symbols.map((name, id) => {
    const out = new Array(nReels + 1).fill(0);
    if (id === wild || id === scatter) return out;
    (linePaysRaw.get(name) || []).forEach((p, i) => { out[i + 1] = toUnits(p); });
    return out;
  });
  const wildUnits = new Array(nReels + 1).fill(0);
  wildPays.forEach((p, i) => { wildUnits[i + 1] = toUnits(p); });
  const scatterUnits = new Array(maxScatter + 1).fill(0);
  scatterPays.forEach((p, i) => { scatterUnits[i + 1] = toUnits(p, L); });
  // The last listed scatter pay applies to that count or more.
  for (let c = scatterPays.length + 1; c <= maxScatter && scatterPays.length; c++) scatterUnits[c] = scatterUnits[scatterPays.length];

  // Normalized reel sets: { weight: BigInt, reels: [Int32Array], weights: null | [null | BigInt[]] }.
  const toSet = (set) => ({ weight: set.weight, reels: set.strips.map((s) => Int32Array.from(s, (x) => index.get(x))), weights: set.weights });
  const reelSets = baseSets.map(toSet);
  const fsReelSets = fsSets ? fsSets.map(toSet) : reelSets;
  const tooMany = (sets) => sets.some((set) => set.reels.reduce((c, s) => c * BigInt(s.length), 1n) > BigInt(Number.MAX_SAFE_INTEGER));
  if (tooMany(reelSets)) throw err('عدد التوليفات أكبر من 2^53؛ قلّل طول البكرات', 'More than 2^53 reel combinations; use shorter reels');
  if (fsSets && tooMany(fsReelSets)) throw err('توليفات بكرات الفري سبين أكبر من 2^53', 'More than 2^53 free-spin reel combinations');
  const isWeighted = (sets) => sets.length > 1 || sets.some((set) => set.weights !== null);

  return {
    name: String(raw.name || ''),
    rows, nReels, symbols, wild, scatter, scale,
    lines: lines0,
    linePays, wildPays: wildUnits, scatterPays: scatterUnits,
    // reels / freeSpins.reels: the first (for unweighted models the only) reel set.
    reels: reelSets[0].reels, reelSets,
    freeSpins: freeSpins && { ...freeSpins, reels: fsReelSets[0].reels, reelSets: fsReelSets },
    weighted: isWeighted(reelSets) || Boolean(freeSpins && isWeighted(fsReelSets)),
    totalBetUnits: L * scale,
    cascades: waysCascades(raw),
  };
}

export function parseModelJson(text) {
  let raw;
  try { raw = JSON.parse(text); } catch (e) { throw err('ملف JSON غير صالح: ' + e.message, 'Invalid JSON: ' + e.message); }
  return raw;
}

// Builds or updates a raw model from CSV files, recognized by their header:
//   reels:    reel1,reel2,...            (one stop per row; shorter reels leave cells empty;
//             reel1,weight1,reel2,...     weightN right after reelN holds its stop weights, each
//                                         the weight of the window with that stop in row 1)
//   paytable: symbol,type,1,2,3,...      (type: normal | wild | scatter; type is optional)
//   lines:    line,reel1,reel2,...       (1-based rows)
export function applyCsv(raw, text, fileName = '') {
  const rows = parseCsv(text);
  if (rows.length < 2) throw err(`الملف ${fileName} فارغ أو بلا بيانات`, `${fileName} has no data rows`);
  const header = rows[0].map((h) => h.trim().toLowerCase());
  const out = { ...raw };
  if (header[0] === 'symbol' || header[0] === 'رمز' || header[0] === 'الرمز') {
    const typeCol = header[1] === 'type' || header[1] === 'نوع' ? 1 : -1;
    const counts = header.slice(typeCol === 1 ? 2 : 1).map((h) => parseInt(h, 10));
    if (counts.some((c) => !(c >= 1))) throw err('أعمدة جدول الدفع يجب أن تكون أعدادًا: 1,2,3...', 'Paytable columns must be counts: 1,2,3...');
    out.paytable = {};
    delete out.wild;
    const prevScatter = raw.scatter && typeof raw.scatter === 'object' ? raw.scatter : {};
    delete out.scatter;
    for (const r of rows.slice(1)) {
      const sym = (r[0] || '').trim();
      if (!sym) continue;
      const type = typeCol === 1 ? (r[1] || '').trim().toLowerCase() : 'normal';
      const pays = {};
      counts.forEach((c, i) => { const v = r[i + (typeCol === 1 ? 2 : 1)]; if (v !== undefined && v.trim() !== '') pays[c] = Number(v); });
      if (type === 'wild') out.wild = { symbol: sym, pays };
      else if (type === 'scatter') out.scatter = { ...prevScatter, symbol: sym, pays };
      else if (type === 'normal' || type === '') out.paytable[sym] = pays;
      else throw err(`نوع غير معروف "${type}" للرمز ${sym}`, `Unknown type "${type}" for ${sym}`);
    }
    return out;
  }
  if (header[0] === 'line' || header[0] === 'خط' || header[0] === 'الخط') {
    out.lines = rows.slice(1).filter((r) => r.some((c) => c.trim() !== '')).map((r) => r.slice(1).map((c) => parseInt(c, 10)));
    return out;
  }
  const isReel = (h) => /^(reel|بكرة)\s*\d*$/.test(h);
  const isWeight = (h) => /^(weight|وزن)\s*\d*$/.test(h);
  if (isReel(header[0]) && header.every((h) => isReel(h) || isWeight(h))) {
    // A weight column holds the weights of the reel column just before it. A numbered
    // weight column must match that reel: weightN follows reelN (or, for a reel column
    // without a number, the Nth reel column), so a misplaced column is an error rather
    // than weights silently given to another reel.
    const numberOf = (h) => { const m = /\d+$/.exec(h); return m ? parseInt(m[0], 10) : null; };
    const cols = [];
    header.forEach((h, i) => {
      if (isReel(h)) { cols.push({ col: i, weightCol: -1 }); return; }
      if (!(cols[cols.length - 1].weightCol === -1 && isReel(header[i - 1]))) {
        throw err(`${fileName}: عمود الوزن "${rows[0][i]}" يجب أن يأتي مباشرة بعد عمود بكرته`, `${fileName}: weight column "${rows[0][i]}" must come right after its reel column`);
      }
      const n = numberOf(h), reelNo = numberOf(header[i - 1]) ?? cols.length;
      if (n !== null && n !== reelNo) {
        throw err(`${fileName}: عمود الوزن "${rows[0][i]}" يأتي بعد عمود البكرة "${rows[0][i - 1]}"؛ ضع عمود وزن كل بكرة مباشرة بعدها وبرقمها نفسه`, `${fileName}: weight column "${rows[0][i]}" comes after reel column "${rows[0][i - 1]}"; put each reel's weight column right after it, with the same number`);
      }
      cols[cols.length - 1].weightCol = i;
    });
    const reels = cols.map(() => []);
    const weights = cols.map((c) => (c.weightCol >= 0 ? [] : null));
    rows.slice(1).forEach((r, n) => cols.forEach((c, k) => {
      const v = (r[c.col] || '').trim();
      const w = c.weightCol >= 0 ? (r[c.weightCol] || '').trim() : '';
      if (v) reels[k].push(v);
      if (c.weightCol < 0) return;
      if (v && !w) throw err(`${fileName}: السطر ${n + 2}: للبكرة ${k + 1} رمز بلا وزن`, `${fileName}: row ${n + 2}: reel ${k + 1} has a symbol but no weight`);
      if (!v && w) throw err(`${fileName}: السطر ${n + 2}: للبكرة ${k + 1} وزن بلا رمز`, `${fileName}: row ${n + 2}: reel ${k + 1} has a weight but no symbol`);
      // Weights stay text above 2^53 - 1 so no digit is lost; normalizeModel checks them.
      if (v) weights[k].push(/^\d+$/.test(w) && Number.isSafeInteger(Number(w)) ? Number(w) : w);
    }));
    out.reels = reels;
    delete out.reelSets;
    if (weights.some(Boolean)) out.weights = weights; else delete out.weights;
    return out;
  }
  throw err(`لم أتعرف على نوع الملف ${fileName}: يجب أن يبدأ بـ reel1,... أو symbol,... أو line,...`, `Unrecognized CSV ${fileName}: the header must start with reel1,..., symbol,... or line,...`);
}

const splitList = (s) => s.split(/[\s,;|]+/).map((x) => x.trim()).filter(Boolean);

// The form edits the model as plain text blocks.
export function modelFromForm(f) {
  const reels = String(f.reels || '').split(/\r?\n/).map(splitList).filter((r) => r.length);
  const paytable = {};
  for (const line of String(f.paytable || '').split(/\r?\n/)) {
    const m = /^\s*([^:=,\s]+)\s*[:=,]?\s*(.*)$/.exec(line);
    if (!m || !m[1]) continue;
    paytable[m[1]] = splitList(m[2]).map(Number);
  }
  const raw = { name: f.name || '', rows: Number(f.rows), reels, paytable };
  const lineRows = String(f.lines || '').split(/\r?\n/).map(splitList).filter((r) => r.length);
  if (f.linePreset && f.linePreset !== 'custom') raw.lines = f.linePreset;
  else if (lineRows.length) raw.lines = lineRows.map((r) => r.map(Number));
  if (f.wild) { raw.wild = { symbol: f.wild.trim(), pays: paytable[f.wild.trim()] || [] }; delete paytable[f.wild.trim()]; }
  if (f.scatter) {
    const s = f.scatter.trim();
    raw.scatter = { symbol: s, pays: paytable[s] || [] };
    delete paytable[s];
    if (f.fsEnabled) {
      raw.scatter.freeSpins = { trigger: Number(f.fsTrigger), spins: Number(f.fsSpins), multiplier: String(f.fsMultiplier || 1), retrigger: Boolean(f.fsRetrigger) };
      // Caps: written only when filled in (and only with retrigger), so other models stay as they were.
      if (f.fsRetrigger && String(f.fsMaxSpins ?? '').trim()) raw.scatter.freeSpins.maxSpins = Number(f.fsMaxSpins);
      if (f.fsRetrigger && String(f.fsMaxRetriggers ?? '').trim()) raw.scatter.freeSpins.maxRetriggers = Number(f.fsMaxRetriggers);
      const fsReels = String(f.fsReels || '').split(/\r?\n/).map(splitList).filter((r) => r.length);
      if (fsReels.length) raw.scatter.freeSpins.reels = fsReels;
    }
  }
  return raw;
}

export function formFromModel(raw) {
  const payRow = (sym, pays) => {
    const arr = Array.isArray(pays) ? pays : Object.entries(pays || {}).reduce((a, [k, v]) => { a[parseInt(k, 10) - 1] = v; return a; }, []);
    return sym + ': ' + Array.from(arr, (v) => v ?? 0).join(' ');
  };
  const pt = Object.entries(raw.paytable || {}).map(([s, p]) => payRow(s, p));
  const wild = raw.wild ? (typeof raw.wild === 'string' ? raw.wild : raw.wild.symbol) : '';
  if (raw.wild && raw.wild.pays) pt.push(payRow(wild, raw.wild.pays));
  const sc = raw.scatter && typeof raw.scatter === 'object' ? raw.scatter : raw.scatter ? { symbol: raw.scatter } : null;
  if (sc && sc.pays) pt.push(payRow(sc.symbol, sc.pays));
  const fs = sc && sc.freeSpins;
  return {
    name: raw.name || '',
    rows: raw.rows || 1,
    reels: (raw.reels || []).map((r) => r.join(' ')).join('\n'),
    paytable: pt.join('\n'),
    linePreset: typeof raw.lines === 'string' ? raw.lines : raw.lines ? 'custom' : 'middle',
    lines: Array.isArray(raw.lines) ? raw.lines.map((l) => l.join(' ')).join('\n') : '',
    wild: wild || '',
    scatter: sc ? sc.symbol : '',
    fsEnabled: Boolean(fs),
    fsTrigger: fs ? fs.trigger : 3,
    fsSpins: fs ? fs.spins : 10,
    fsMultiplier: fs ? String(fs.multiplier ?? 1) : '1',
    fsRetrigger: fs ? Boolean(fs.retrigger) : false,
    fsReels: fs && fs.reels ? fs.reels.map((r) => r.join(' ')).join('\n') : '',
    fsMaxSpins: fs && fs.maxSpins !== undefined && fs.maxSpins !== null ? String(fs.maxSpins) : '',
    fsMaxRetriggers: fs && fs.maxRetriggers !== undefined && fs.maxRetriggers !== null ? String(fs.maxRetriggers) : '',
  };
}

// Stable JSON (sorted keys) so the same model always hashes the same way. A BigInt
// (e.g. a weight above 2^53) is written as a string of its digits.
// Like JSON.stringify, a member whose value is undefined is left out and an
// undefined array element is written as null, so the text is always valid JSON.
export function canonicalJson(value) {
  if (typeof value === 'bigint') return JSON.stringify(value.toString());
  if (Array.isArray(value)) return '[' + value.map((v) => (v === undefined ? 'null' : canonicalJson(v))).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().filter((k) => value[k] !== undefined).map((k) => JSON.stringify(k) + ':' + canonicalJson(value[k])).join(',') + '}';
  }
  return JSON.stringify(value);
}

// ---- Ways evaluation (P0-6) ----
// "evaluation": "ways" ("lines", the default, is everything above). A symbol s pays
// paytable[s][k - 1] x ways when each of reels 1..k shows s or a wild in its window, for
// the longest such k only; ways = the product over reels 1..k of the matching cells.
//   "betCost": 20              coins per spin (whole number, default 1). Pays are per way
//                              in coins, so with betCost 1 they are multiples of the total
//                              bet; scatter pays stay multiples of the total bet.
//   "rows": 7 | [3, 4, 5, ...] fixed window height, for every reel or reel by reel.
//   "heights": [h1, ..., hN]   per reel: null (use rows), a whole number, a list
//                              [{ "rows": 2, "weight": 1 }, ...] (height drawn independently
//                              of the stop), or { "rows": [2, ..., 7], "joint": [[w, ...], ...] }
//                              with one row of weights per stop (height tied to the stop).
//                              The window is `rows` consecutive stops from the drawn stop.
//   "topReel": { "reel": [...], "weights": [...], "covers": [2, 3, 4, 5] }
//                              a horizontal reel: its stop p and the stops after it add one
//                              cell to each covered reel in order (p to the first, p + 1 to
//                              the next, ...), so the covered reels are not independent.
//   "multiplierSymbols": { "W2": { "symbol": "W", "multiplier": 2 }, ... }
//                              a strip symbol that counts as the wild (or a paying symbol)
//                              and carries a multiplier.
//   "multiplierStrategy": "symbol" (a cell counts as its multiplier, so multipliers
//                              multiply across reels) | "board" (each cell counts 1 and the
//                              multipliers of a win's cells are added, at least 1) |
//                              "global" (cell multipliers ignored; every ways win x
//                              "globalMultiplier"). Named after StakeEngine/math-sdk
//                              src/calculations/ways.py (commit 141b4e8, 2 Nov 2026).
//   "wildStartsWin": true (a wild on reel 1 starts a win for every symbol) | false (only a
//                              symbol shown on reel 1 starts its own win, as ways.py does).
//   "cascades": true           the game removes winning symbols and refills: the lab then
//                              computes the first drop only (see slot-exact.js).
//   scatter.freeSpins may carry its own "reels"/"reelSets", "heights" and "topReel" (null
//   for none); a key left out uses the base game's.
const MAX_WAYS_ROWS = 10, MAX_CELL_MULTIPLIER = 1000, MAX_BET_COST = 1000000;
// Every single-spin win (in model units) stays below this, so the engines' integer
// sums and the pmf keys (win * 2 + trigger, slot-exact.js spinPmf) stay exact as JS
// numbers; ways-exact.js keeps the win and the scatter count apart (no packed key).
export const WAYS_MAX_UNITS = 2 ** 50;
export const MULTIPLIER_STRATEGIES = ['symbol', 'board', 'global'];

export function isWaysModel(raw) {
  return Boolean(raw && typeof raw === 'object' && raw.evaluation === 'ways');
}

// The cascades flag (any evaluation): the exact engine then covers the first drop only.
function waysCascades(raw) {
  if (raw.cascades === undefined || raw.cascades === null || raw.cascades === false) return false;
  if (raw.cascades === true) return true;
  throw err('cascades يجب أن تكون true أو false', 'cascades must be true or false');
}

function wholeNumber(v, min, max, ar, en) {
  const x = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  if (!Number.isInteger(x) || x < min || x > max) throw err(`${ar}: يجب أن يكون عددًا صحيحًا من ${min} إلى ${max}`, `${en} must be a whole number from ${min} to ${max}`);
  return x;
}

// A weight in a joint (stop, height) table: 0 is allowed there (that height never shows
// at that stop); otherwise as parseWeight.
function jointWeight(v, ar, en) {
  if (v === 0 || v === 0n || (typeof v === 'string' && /^\s*0+\s*$/.test(v))) return 0n;
  return parseWeight(v, ar, en);
}

// Window heights of one reel source, per reel: { rows: [h, ...], weights: null | [BigInt],
// joint: null | [[BigInt per height] per stop] }. One height and no joint = a fixed window.
function waysHeights(rowsRaw, heightsRaw, sets, [wa, we]) {
  const nReels = sets[0].strips.length;
  const height = (h, i) => wholeNumber(h, 1, MAX_WAYS_ROWS, `${wa}: ارتفاع البكرة ${i + 1}`, `${we}: the height of reel ${i + 1}`);
  let fixed = null;
  if (rowsRaw !== undefined && rowsRaw !== null) {
    const list = Array.isArray(rowsRaw) ? rowsRaw : new Array(nReels).fill(rowsRaw);
    if (list.length !== nReels) throw err(`${wa}: rows يجب أن يحدد ارتفاعًا لكل بكرة (${nReels})`, `${we}: rows must give one height per reel (${nReels})`);
    fixed = list.map(height);
  }
  if (heightsRaw === undefined || heightsRaw === null) {
    if (!fixed) throw err(`${wa}: نموذج ways يحتاج rows أو heights`, `${we}: a ways model needs rows or heights`);
    return fixed.map((h) => ({ rows: [h], weights: null, joint: null }));
  }
  if (!Array.isArray(heightsRaw) || heightsRaw.length !== nReels) throw err(`${wa}: heights يجب أن تكون قائمة لكل بكرة (${nReels})`, `${we}: heights must hold one entry per reel (${nReels})`);
  return heightsRaw.map((hr, i) => {
    const [ra, re] = [`${wa}: البكرة ${i + 1}`, `${we}: reel ${i + 1}`];
    if (hr === null || hr === undefined) {
      if (!fixed) throw err(`${ra}: لا ارتفاع لها (أضف rows أو ارتفاعًا في heights)`, `${re}: no height (add rows, or a height in heights)`);
      return { rows: [fixed[i]], weights: null, joint: null };
    }
    if (typeof hr === 'number' || typeof hr === 'string') return { rows: [height(hr, i)], weights: null, joint: null };
    const distinct = (rows) => {
      if (new Set(rows).size !== rows.length) throw err(`${ra}: ارتفاع مكرر`, `${re}: a height is listed twice`);
      return rows;
    };
    if (Array.isArray(hr)) {
      if (!hr.length) throw err(`${ra}: قائمة الارتفاعات فارغة`, `${re}: the list of heights is empty`);
      const items = hr.map((o) => {
        if (!o || typeof o !== 'object' || Array.isArray(o)) throw err(`${ra}: كل ارتفاع كائن { rows, weight }`, `${re}: each height is an object { rows, weight }`);
        return { rows: height(o.rows, i), weight: parseWeight(o.weight ?? 1, `${ra}: وزن الارتفاع ${o.rows}`, `${re}: weight of height ${o.rows}`) };
      });
      return { rows: distinct(items.map((o) => o.rows)), weights: items.map((o) => o.weight), joint: null };
    }
    if (typeof hr !== 'object') throw err(`${ra}: ارتفاع غير صالح`, `${re}: invalid height`);
    // Joint (stop, height) weights: they replace the stop weights of this reel.
    if (sets.length > 1) throw err(`${ra}: جدول (الموقع، الارتفاع) يحتاج مجموعة بكرات واحدة`, `${re}: a joint (stop, height) table needs a single reel set`);
    if (sets[0].weights && sets[0].weights[i]) throw err(`${ra}: جدول (الموقع، الارتفاع) يحل محل أوزان المواقع؛ احذف أوزان هذه البكرة`, `${re}: a joint (stop, height) table replaces the stop weights; remove this reel's weights`);
    if (!Array.isArray(hr.rows) || !hr.rows.length) throw err(`${ra}: rows في الجدول قائمة ارتفاعات`, `${re}: rows in the table is a list of heights`);
    const rows = distinct(hr.rows.map((h) => height(h, i)));
    const len = sets[0].strips[i].length;
    if (!Array.isArray(hr.joint) || hr.joint.length !== len) throw err(`${ra}: joint يحتاج سطرًا لكل موقع (${len})`, `${re}: joint needs one row per stop (${len})`);
    let total = 0n;
    const joint = hr.joint.map((row, p) => {
      if (!Array.isArray(row) || row.length !== rows.length) throw err(`${ra}: الموقع ${p + 1}: يلزم وزن لكل ارتفاع (${rows.length})`, `${re}: stop ${p + 1}: one weight per height is needed (${rows.length})`);
      return row.map((v) => { const w = jointWeight(v, `${ra}، الموقع ${p + 1}`, `${re}, stop ${p + 1}`); total += w; return w; });
    });
    if (total === 0n) throw err(`${ra}: كل أوزان الجدول أصفار`, `${re}: every weight in the table is 0`);
    // A height listed with weight 0 at every stop never shows: it would count in the max
    // ways and the scatter bounds, so it is removed instead (as for a weight of 0).
    const dead = rows.find((h, j) => joint.every((row) => row[j] === 0n));
    if (dead !== undefined) throw err(`${ra}: الارتفاع ${dead} وزنه 0 في كل المواقع فلا يظهر أبدًا؛ احذفه من rows ومن الجدول`, `${re}: height ${dead} has weight 0 at every stop, so it never shows; remove it from rows and from the table`);
    return { rows, weights: null, joint };
  });
}

// The horizontal top reel of one source: { strip: [names], weights, covers: [0-based] }.
function waysTopReel(raw, nReels, [wa, we]) {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) throw err(`${wa}: يجب أن تكون كائنًا { reel, covers }`, `${we}: must be an object { reel, covers }`);
  if (!Array.isArray(raw.reel)) throw err(`${wa}: reel قائمة رموز البكرة العلوية`, `${we}: reel is the list of the top reel's symbols`);
  const strip = raw.reel.map((x) => String(x).trim());
  if (!strip.length || strip.some((x) => x === '')) throw err(`${wa}: البكرة العلوية فارغة أو فيها رمز فارغ`, `${we}: the top reel is empty or has an empty symbol`);
  if (strip.length > MAX_STOPS) throw err(`${wa}: البكرة العلوية أطول من ${MAX_STOPS}`, `${we}: the top reel has more than ${MAX_STOPS} stops`);
  let weights = null;
  if (raw.weights !== undefined && raw.weights !== null) {
    if (!Array.isArray(raw.weights) || raw.weights.length !== strip.length) throw err(`${wa}: عدد الأوزان يجب أن يساوي عدد المواقع (${strip.length})`, `${we}: weights must match the stops (${strip.length})`);
    weights = raw.weights.map((w, p) => parseWeight(w, `${wa}: الموقع ${p + 1}`, `${we}: stop ${p + 1}`));
  }
  if (!Array.isArray(raw.covers) || !raw.covers.length) throw err(`${wa}: covers قائمة البكرات التي تغطيها (مثل [2, 3, 4, 5])`, `${we}: covers lists the reels it covers (e.g. [2, 3, 4, 5])`);
  const covers = raw.covers.map((c) => wholeNumber(c, 1, nReels, `${wa}: رقم البكرة في covers`, `${we}: a reel number in covers`) - 1);
  if (covers.some((c, j) => j > 0 && c <= covers[j - 1])) throw err(`${wa}: أرقام covers يجب أن تكون تصاعدية بلا تكرار`, `${we}: covers must be increasing, without repeats`);
  return { strip, weights, covers };
}

const WILD_PAYS = ['في تقييم ways يعوّض الـwild عن الرموز فقط ولا يدفع وحده؛ احذف دفع الـwild', 'In ways evaluation the wild only substitutes and pays nothing on its own; remove the wild pays'];

// Validates a ways model and returns the normalized form (see the top of this block).
function normalizeWaysModel(raw) {
  if (raw.evaluation !== 'ways') throw err(`نوع التقييم "${raw.evaluation}" غير معروف (lines أو ways)`, `Unknown evaluation "${raw.evaluation}" (lines or ways)`);
  const baseSets = reelSource(raw, 'reels', 'reelSets') || [{ weight: 1n, strips: strips(raw.reels, 'reels'), weights: null }];
  const nReels = baseSets[0].strips.length;
  const symbols = [];
  const index = new Map();
  const idOf = (name) => {
    if (!index.has(name)) { index.set(name, symbols.length); symbols.push(name); }
    return index.get(name);
  };
  baseSets.forEach((set) => set.strips.forEach((s) => s.forEach(idOf)));

  const wildRaw = raw.wild && typeof raw.wild === 'object' ? raw.wild : raw.wild ? { symbol: raw.wild } : null;
  const wildName = wildRaw ? String(wildRaw.symbol || '').trim() : '';
  const scatterRaw = raw.scatter && typeof raw.scatter === 'object' ? raw.scatter : raw.scatter ? { symbol: raw.scatter } : null;
  const scatterName = scatterRaw ? String(scatterRaw.symbol || '').trim() : '';
  if (wildName && wildName === scatterName) throw err('لا يمكن أن يكون الرمز نفسه wild وscatter', 'The same symbol cannot be both wild and scatter');
  if (wildRaw && wildRaw.pays && payArray(wildRaw.pays, nReels, wildName).some((p) => p > 0)) throw err(...WILD_PAYS);

  const paytable = raw.paytable || {};
  if (typeof paytable !== 'object' || Array.isArray(paytable)) throw err('جدول الدفع يجب أن يكون كائنًا: رمز ← قائمة دفع', 'paytable must be an object: symbol -> list of pays');
  const paysRaw = new Map();
  for (const [sym, pays] of Object.entries(paytable)) {
    const name = sym.trim();
    if (name === scatterName) continue; // scatter pays live under scatter.pays
    const arr = payArray(pays, nReels, name);
    if (name === wildName) {
      if (arr.some((p) => p > 0)) throw err(...WILD_PAYS);
      continue;
    }
    paysRaw.set(name, arr);
    idOf(name);
  }

  const betCost = raw.betCost === undefined || raw.betCost === null ? 1 : wholeNumber(raw.betCost, 1, MAX_BET_COST, 'betCost (عدد العملات في الرهان)', 'betCost (coins per spin)');
  const strategy = raw.multiplierStrategy === undefined || raw.multiplierStrategy === null ? 'symbol' : String(raw.multiplierStrategy);
  if (!MULTIPLIER_STRATEGIES.includes(strategy)) throw err('multiplierStrategy يجب أن تكون symbol أو board أو global', 'multiplierStrategy must be symbol, board or global');
  const globalMultiplier = raw.globalMultiplier === undefined || raw.globalMultiplier === null ? 1 : wholeNumber(raw.globalMultiplier, 1, MAX_CELL_MULTIPLIER, 'globalMultiplier', 'globalMultiplier');
  if (globalMultiplier !== 1 && strategy !== 'global') throw err('globalMultiplier يعمل مع multiplierStrategy "global" فقط', 'globalMultiplier only applies with multiplierStrategy "global"');
  if (raw.wildStartsWin !== undefined && raw.wildStartsWin !== null && typeof raw.wildStartsWin !== 'boolean') throw err('wildStartsWin يجب أن تكون true أو false', 'wildStartsWin must be true or false');
  const wildStartsWin = raw.wildStartsWin !== false;

  // Free spins: as for lines, plus their own heights and top reel.
  let fsSets = null, freeSpins = null, fsRaw = null;
  if (scatterRaw && scatterRaw.freeSpins) {
    const f = fsRaw = scatterRaw.freeSpins;
    const trigger = Number(f.trigger), spins = Number(f.spins);
    if (!Number.isInteger(trigger) || trigger < 1) throw err('عدد رموز التفعيل للفري سبين يجب أن يكون عددًا صحيحًا ≥ 1', 'freeSpins.trigger must be an integer ≥ 1');
    if (!Number.isInteger(spins) || spins < 1 || spins > 1000) throw err('عدد الفري سبين يجب أن يكون بين 1 و1000', 'freeSpins.spins must be between 1 and 1000');
    const mult = Fraction.of(f.multiplier ?? 1);
    if (mult.cmp(0) <= 0 || mult.cmp(10000) > 0) throw err('مضاعف الفري سبين يجب أن يكون بين 0 و10000', 'freeSpins.multiplier must be in (0, 10000]');
    fsSets = reelSource({ ...f, reels: f.reels || undefined }, 'freeSpins.reels', 'freeSpins.reelSets');
    if (fsSets) {
      if (fsSets[0].strips.length !== nReels) throw err('بكرات الفري سبين يجب أن تكون بنفس عدد البكرات', 'freeSpins.reels must have the same number of reels');
      fsSets.forEach((set) => set.strips.forEach((s) => s.forEach(idOf)));
    }
    const sameReels = !fsSets && f.heights === undefined && f.topReel === undefined;
    // Caps on the feature (maxSpins, maxRetriggers) as for lines (P0-8).
    freeSpins = { trigger, spins, multiplier: mult, retrigger: Boolean(f.retrigger), sameReels, ...freeSpinCaps(f, spins) };
  }

  // Window shapes and top reels.
  const baseHeights = waysHeights(raw.rows, raw.heights, baseSets, ['reels', 'reels']);
  const baseTop = waysTopReel(raw.topReel, nReels, ['topReel', 'topReel']);
  let fsHeights = null, fsTop = null;
  if (freeSpins) {
    if (fsRaw.heights !== undefined && fsRaw.heights !== null) fsHeights = waysHeights(raw.rows, fsRaw.heights, fsSets || baseSets, ['freeSpins.heights', 'freeSpins.heights']);
    else if (fsSets && baseHeights.some((h) => h.joint)) throw err('freeSpins: جدول (الموقع، الارتفاع) مرتبط ببكرات اللعبة الأساسية؛ أعطِ اللفات المجانية heights خاصة بها', 'freeSpins: a joint (stop, height) table belongs to the base reels; give the free spins their own heights');
    else fsHeights = baseHeights;
    fsTop = fsRaw.topReel === undefined ? baseTop : waysTopReel(fsRaw.topReel, nReels, ['freeSpins.topReel', 'freeSpins.topReel']);
  }
  [baseTop, fsTop].forEach((t) => t && t.strip.forEach(idOf));

  // Multiplier symbols: a strip symbol counting as the wild or a paying symbol.
  const cellOf = new Map(); // name -> { as, multiplier }
  const msRaw = raw.multiplierSymbols;
  if (msRaw !== undefined && msRaw !== null) {
    if (typeof msRaw !== 'object' || Array.isArray(msRaw)) throw err('multiplierSymbols يجب أن تكون كائنًا: رمز ← { symbol, multiplier }', 'multiplierSymbols must be an object: symbol -> { symbol, multiplier }');
    for (const [k, v] of Object.entries(msRaw)) {
      const name = k.trim();
      if (!v || typeof v !== 'object') throw err(`multiplierSymbols: ${name}: يجب أن تكون { symbol, multiplier }`, `multiplierSymbols: ${name}: must be { symbol, multiplier }`);
      const as = String(v.symbol || '').trim();
      if (name === wildName || name === scatterName || paysRaw.has(name)) throw err(`multiplierSymbols: ${name} رمز معرّف أصلًا؛ اختر اسمًا آخر لنسخته ذات المضاعف`, `multiplierSymbols: ${name} is already defined; give its multiplier version another name`);
      if (!(wildName && as === wildName) && !paysRaw.has(as)) throw err(`multiplierSymbols: ${name}: الرمز "${as}" ليس الـwild ولا رمزًا في جدول الدفع`, `multiplierSymbols: ${name}: "${as}" is neither the wild nor a symbol in the paytable`);
      cellOf.set(name, { as, multiplier: wholeNumber(v.multiplier, 1, MAX_CELL_MULTIPLIER, `multiplierSymbols: ${name}: المضاعف`, `multiplierSymbols: ${name}: the multiplier`) });
      idOf(name);
    }
  }

  const allStrips = [...baseSets, ...(fsSets || [])].flatMap((set) => set.strips).concat([baseTop, fsTop].filter(Boolean).map((t) => t.strip));
  const shows = (name) => allStrips.some((s) => s.includes(name)) || [...cellOf].some(([n, c]) => c.as === name && allStrips.some((s) => s.includes(n)));
  if (wildName && !shows(wildName)) throw err(`رمز الـwild "${wildName}" غير موجود في البكرات`, `Wild symbol "${wildName}" does not appear on the reels`);
  if (scatterName && !allStrips.some((s) => s.includes(scatterName))) throw err(`رمز الـscatter "${scatterName}" غير موجود في البكرات`, `Scatter symbol "${scatterName}" does not appear on the reels`);
  const wild = wildName ? idOf(wildName) : -1;
  const scatter = scatterName ? idOf(scatterName) : -1;

  // Largest number of cells per reel: the tallest window plus the top reel's cell.
  const cellsOf = (heights, top) => heights.map((h, i) => Math.max(...h.rows) + (top && top.covers.includes(i) ? 1 : 0));
  const baseCells = cellsOf(baseHeights, baseTop);
  const fsCells = freeSpins ? cellsOf(fsHeights, fsTop) : baseCells;
  const sum = (a) => a.reduce((x, y) => x + y, 0);
  const maxScatter = Math.max(sum(baseCells), sum(fsCells));
  const scatterPays = scatterRaw && scatterRaw.pays ? payArray(scatterRaw.pays, maxScatter, scatterName) : [];
  if (paytable[scatterName] && !(scatterRaw && scatterRaw.pays)) scatterPays.push(...payArray(paytable[scatterName], maxScatter, scatterName));
  if (freeSpins && freeSpins.trigger > sum(baseCells)) throw err(`عدد التفعيل أكبر من أقصى عدد scatter ممكن (${sum(baseCells)})`, `freeSpins.trigger exceeds the most scatters that can land (${sum(baseCells)})`);

  // Integer units: one unit = one coin / scale; the total bet is betCost coins.
  let d = 0;
  for (const arr of [...paysRaw.values(), scatterPays]) for (const p of arr) d = Math.max(d, decimals(p));
  const scale = 10 ** d;
  const waysPays = symbols.map((name) => {
    const out = new Array(nReels + 1).fill(0);
    (paysRaw.get(name) || []).forEach((p, i) => { out[i + 1] = Math.round(p * scale) * globalMultiplier; });
    return out;
  });
  const scatterUnits = new Array(maxScatter + 1).fill(0);
  scatterPays.forEach((p, i) => { scatterUnits[i + 1] = Math.round(p * scale) * betCost; });
  // The last listed scatter pay applies to that count or more.
  for (let c = scatterPays.length + 1; c <= maxScatter && scatterPays.length; c++) scatterUnits[c] = scatterUnits[scatterPays.length];

  const cellBase = Int32Array.from(symbols, (name, id) => (cellOf.has(name) ? index.get(cellOf.get(name).as) : id));
  const cellMult = Int32Array.from(symbols, (name) => (cellOf.has(name) ? cellOf.get(name).multiplier : 1));
  const paying = Int32Array.from(symbols.map((_, id) => id).filter((id) => cellBase[id] === id && id !== wild && id !== scatter && waysPays[id].some((p) => p > 0)));

  // The largest single-spin win must stay below WAYS_MAX_UNITS (exact integer sums).
  const maxMult = (base) => symbols.reduce((m, _, id) => (cellBase[id] === base ? Math.max(m, cellMult[id]) : m), 1);
  const wildMult = wild >= 0 ? maxMult(wild) : 1;
  let bound = 0n;
  for (const cells of [baseCells, fsCells]) {
    let total = BigInt(Math.max(0, ...scatterUnits));
    for (const s of paying) {
      const m = Math.max(maxMult(s), wildMult);
      const cellCount = BigInt(strategy === 'symbol' ? m : 1);
      const boardMult = BigInt(strategy === 'board' ? Math.max(1, sum(cells) * m) : 1);
      let best = 0n, ways = 1n;
      for (let k = 1; k <= nReels; k++) {
        ways *= BigInt(cells[k - 1]) * cellCount;
        const v = BigInt(waysPays[s][k]) * ways * boardMult;
        if (v > best) best = v;
      }
      total += best;
    }
    if (total > bound) bound = total;
  }
  if (bound >= BigInt(WAYS_MAX_UNITS)) throw err('أعلى ربح ممكن في لفة واحدة كبير جدًا للحساب الدقيق بالأعداد الصحيحة (أكثر من 2^50 وحدة)؛ قلّل الدفع أو الخانات العشرية أو المضاعفات', 'The largest possible single-spin win is too large for exact integer arithmetic (over 2^50 units); use smaller pays, fewer decimals or smaller multipliers');

  const toSet = (set) => ({ weight: set.weight, reels: set.strips.map((s) => Int32Array.from(s, (x) => index.get(x))), weights: set.weights });
  const reelSets = baseSets.map(toSet);
  const fsReelSets = fsSets ? fsSets.map(toSet) : reelSets;
  const toTop = (t) => t && { strip: Int32Array.from(t.strip, (x) => index.get(x)), weights: t.weights, covers: t.covers };
  const isWeighted = (sets) => sets.length > 1 || sets.some((set) => set.weights !== null);
  const base = { sets: reelSets, heights: baseHeights, top: toTop(baseTop) };
  const fsSource = freeSpins ? (freeSpins.sameReels ? base : { sets: fsReelSets, heights: fsHeights, top: toTop(fsTop) }) : null;

  return {
    name: String(raw.name || ''),
    evaluation: 'ways',
    // rows: the most cells any reel shows (base or free spins), so nReels x rows bounds
    // the scatter count wherever slot-exact.js caps it.
    rows: Math.max(...baseCells, ...fsCells), nReels, symbols, wild, scatter, scale,
    lines: null, waysPays,
    wildPays: new Array(nReels + 1).fill(0), scatterPays: scatterUnits,
    reels: reelSets[0].reels, reelSets,
    freeSpins: freeSpins && { ...freeSpins, reels: fsReelSets[0].reels, reelSets: fsReelSets },
    weighted: isWeighted(reelSets) || Boolean(freeSpins && isWeighted(fsReelSets)),
    totalBetUnits: betCost * scale,
    cascades: waysCascades(raw),
    ways: { strategy, wildStartsWin, betCost, globalMultiplier, cellBase, cellMult, paying, maxScatter, base, fs: fsSource },
  };
}

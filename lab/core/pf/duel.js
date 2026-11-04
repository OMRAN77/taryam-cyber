// Duel.com: the disclosed server seed is 64 hex digits whose 32 decoded BYTES are
// both the HMAC key and what the commitment hashes: commitment = SHA-256(bytes).
// Dice: HMAC_SHA256(key, "client:nonce"); scan the eight 32-bit big-endian words and
// take the first below LIMIT = 0xffffffff - (0xffffffff mod 10001); ticks = word mod 10001.
// Keno: backward Fisher-Yates over 1..40 with one HMAC per step s = 0..38
// (message "client:nonce:s"), index i = 39 - s, range r = i + 1, rejection with
// LIMIT = floor(2^32 / r) r over the 4-byte chunks, j = v mod r; the first 10 entries.
import { hmacSha256Key } from '../sha256-sync.js';
import { u32At, commitHexBytes, hexToBytes, compareTicks, compareSet, splitList, pfError } from './common.js';
import { diceGame } from './games.js';

export const DUEL_DICE_LIMIT = 0xffffffff - (0xffffffff % 10001);

export function duelDiceFromBytes(b) {
  for (let i = 0; i < 8; i++) {
    const w = u32At(b, 4 * i);
    if (w < DUEL_DICE_LIMIT) return { ticks: w % 10001, wordIndex: i };
  }
  return null; // all eight words rejected: what Duel does then is not documented
}

export function duelKeno(hmac, client, nonceText) {
  const a = Array.from({ length: 40 }, (_, i) => i + 1);
  for (let s = 0; s <= 38; s++) {
    const i = 39 - s, r = i + 1;
    const limit = Math.floor(4294967296 / r) * r;
    const b = hmac(`${client}:${nonceText}:${s}`);
    let v = null;
    for (let off = 0; off < 32; off += 4) { const w = u32At(b, off); if (w < limit) { v = w; break; } }
    if (v === null) return null; // open point O2 in the audit's specification
    const j = v % r;
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a.slice(0, 10);
}

const dice = diceGame(10001);
export const duel = {
  id: 'duel',
  version: 'v1',
  kind: 'seeded',
  name: ['Duel.com', 'Duel.com'],
  sourceUrl: 'https://github.com/ProvablyFair-org/duel-keno/blob/bea30f6ed7dc0f15c436940a7d6920bcca6eae91/docs/ALGORITHM.md',
  sources: [
    'https://github.com/ProvablyHero/engine/blob/f3366d5fe7b1fcd069ddbea8fcaf59eac45b2896/test-vectors/duel-dice-v1.json',
    'https://github.com/ProvablyFair-org/duel-keno/blob/bea30f6ed7dc0f15c436940a7d6920bcca6eae91/data/keno-master-5100bets.json',
  ],
  captureDate: '2026-10-27',
  evidence: 'verified',
  notes: [
    'Dice: ثلاث عشرة جولة مكشوفة بالتزام مسجّل قبل اللعب. Keno: ‏5,100 رهان من تدقيق ProvablyFair.org. البيانات لا تميّز قاعدة الرفض في Keno من باقي القسمة البسيط (النقطة المفتوحة O2). جدول الأرباح يرفع حافة الكازينو مع حجم الرهان؛ هذا لا يكشفه التحقق من النتائج.',
    'Dice: thirteen disclosed rounds with a commitment recorded before play. Keno: 5,100 bets from the ProvablyFair.org audit. The data cannot tell Keno\'s rejection rule from a plain modulo (open point O2). The paytable raises the house edge with stake size; result verification does not reveal that.',
  ],
  keyEncoding: 'hex',
  commitment: 'hex-bytes',
  nonceBase: 0,
  hmacKey: (seed) => hmacSha256Key(hexToBytes(seed)),
  commit: commitHexBytes,
  defaultGame: 'dice',
  games: {
    dice: {
      formula: 'word mod 10001, first word < 0xffffffff − (0xffffffff mod 10001)',
      params: ['target', 'condition'],
      raw: true,
      compute(ctx) {
        const r = duelDiceFromBytes(ctx.hmac(`${ctx.client}:${ctx.nonceText}`));
        if (!r) return { edge: 'exhausted', display: '—' };
        return { ...r, display: (r.ticks / 100).toFixed(2) };
      },
      compare: (o, c) => (o.edge ? 'edge' : compareTicks(o.ticks, c)),
      win: dice.win,
      multiplier: dice.multiplier,
      stats: { type: 'ticks', N: 10001, prob: (a, b) => (b - a) / 10001 },
    },
    keno: {
      formula: 'backward Fisher-Yates, one HMAC per step',
      params: ['picks', 'risk'],
      raw: true,
      compute(ctx) {
        const v = duelKeno(ctx.hmac, ctx.client, ctx.nonceText);
        return v ? { values: v, display: v.join(' ') } : { edge: 'exhausted', display: '—' };
      },
      compare: (o, c) => (o.edge ? 'edge' : compareSet(o.values, c)),
      multiplier(o, p, table) {
        const picks = splitList(p.picks).map(Number).filter(Number.isInteger);
        const row = table && table[p.risk || 'classic'] && table[p.risk || 'classic'][picks.length];
        if (!Array.isArray(row) || !o.values) return null;
        const hits = picks.filter((x) => o.values.includes(x)).length;
        return hits < row.length ? row[hits] : null;
      },
      stats: { type: 'draws', N: 40, k: 10, base: 1 },
    },
  },
  checkSeed(seed) {
    if (!/^[0-9a-f]{64}$/.test(seed)) throw pfError('بذرة Duel يجب أن تكون 64 رقمًا ست عشريًا', 'A Duel server seed must be 64 hex digits');
  },
};

const DS = '4acfd9fe9d29ebf77b65fe1f7f956c8eef37f5e09f30f35252d3a7f9e7d62a3c', DC = 'iCzc2OiTfyQkloS6';
const KS = '94eee14e882d43325f7948ef9569552f4506feeeb70a2ca35023916b4f9f0fe9', KC = 'dAn1wtkuDAXxQOKP';
const KS2 = '2f121894ee7df021cac8f51b16329e7798bdb2577667ebe9d8dee647a3ba02b1', KC2 = 'gxIsYguLtWrLkzXF';
const ctx = (s, c, n) => ({ hmac: duel.hmacKey(s), client: c, nonceText: String(n) });
duel.vectors = [
  { name: 'dice commitment SHA-256(hex-decoded seed)', source: 'ProvablyHero test-vectors/duel-dice-v1.json', got: () => commitHexBytes(DS), expect: '93e233d8841c7f7ba714d5fb96fc071b6489398c84076b7361c77d82905d556e' },
  { name: 'dice nonces 0..12 (disclosed rounds)', source: 'ProvablyHero test-vectors/duel-dice-v1.json', got: () => Array.from({ length: 13 }, (_, n) => duel.games.dice.compute(ctx(DS, DC, n)).ticks), expect: [3950, 7443, 7861, 638, 6255, 5251, 9107, 2307, 606, 1487, 3997, 1490, 6529] },
  { name: 'keno commitment 111880213ddf…', source: 'ProvablyFair-org/duel-keno data/keno-master-5100bets.json', got: () => commitHexBytes(KS), expect: '111880213ddf0a3a7b93cf725aeec359113c3986a902fffa0e5a33987600b77a' },
  // The bet records list the 10 numbers in an order nobody has reproduced (open point
  // O1 of the audit); the SET matches on all 5,100 bets. Served lists, sorted here:
  // [25 8 7 27 32 29 11 9 22 1], [3 23 30 24 31 35 6 38 17 15], [33 14 20 23 15 13 40 24 21 8], [30 26 37 25 6 35 15 21 33 14].
  { name: 'keno draws as sets (two seeds, nonces 0, 1, 49)', source: 'ProvablyFair-org/duel-keno data/keno-master-5100bets.json', got: () => [[KS, KC, 0], [KS, KC, 1], [KS, KC, 49], [KS2, KC2, 0]].map(([s, c, n]) => duel.games.keno.compute(ctx(s, c, n)).values.slice().sort((a, b) => a - b)), expect: [[1, 7, 8, 9, 11, 22, 25, 27, 29, 32], [3, 6, 15, 17, 23, 24, 30, 31, 35, 38], [8, 13, 14, 15, 20, 21, 23, 24, 33, 40], [6, 14, 15, 21, 25, 26, 30, 33, 35, 37]] },
  { name: 'keno a[0..9] in shuffle order, first bet', source: 'ProvablyFair-org/duel-keno docs/ALGORITHM.md worked example (line 345)', got: () => duel.games.keno.compute(ctx(KS, KC, 0)).values, expect: [8, 25, 1, 27, 29, 22, 9, 7, 11, 32] },
];

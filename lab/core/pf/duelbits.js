// Duelbits (reference implementation only; no disclosed operator rounds):
// hash = SHA-256("server:client:nonce") (plain SHA-256, not HMAC);
// ticket = first 32 bits mod 10000 for dice (value = ticket / 100), mod 65535 for the
// Plinko ticket. 2^32 mod 10000 = 7296, so tickets 0..7295 have one extra preimage.
import { sha256 } from '../sha256-sync.js';
import { u32At, commitText, compareTicks, compareInt } from './common.js';
import { diceGame } from './games.js';

const dice = diceGame(10000);
const word = (ctx) => u32At(sha256(`${ctx.server}:${ctx.client}:${ctx.nonceText}`), 0);

export const duelbits = {
  id: 'duelbits',
  version: 'v1',
  kind: 'seeded',
  name: ['Duelbits', 'Duelbits'],
  sourceUrl: 'https://github.com/ProvablyHero/engine/blob/f3366d5fe7b1fcd069ddbea8fcaf59eac45b2896/src/adapters/duelbits/v1.ts',
  sources: [],
  captureDate: '2026-10-28',
  evidence: 'reference',
  notes: [
    'من التوثيق فقط؛ لا جولات مكشوفة من المشغّل. ولا يوجد متجه منشور بنتيجة: المتجهات هنا محسوبة بـ SHA-256 مستقل. Plinko v2 الحالي غير منشور؛ يُحسب رقم التذكرة فقط.',
    'From documentation only; no disclosed operator rounds, and no published vector with a result: the vectors here come from an independent SHA-256. The current Plinko v2 path is not public; only the ticket is computed.',
  ],
  keyEncoding: 'text',
  commitment: 'text',
  nonceBase: null,
  hmacKey: () => null,
  commit: commitText,
  defaultGame: 'dice',
  games: {
    dice: {
      formula: 'u32(SHA-256("server:client:nonce")) mod 10000',
      params: ['target', 'condition'],
      raw: true,
      compute(ctx) { const ticks = word(ctx) % 10000; return { ticks, display: (ticks / 100).toFixed(2) }; },
      compare: (o, c) => compareTicks(o.ticks, c),
      win: dice.win,
      multiplier: dice.multiplier,
      // 429,497 preimages for tickets below 7296, 429,496 above.
      stats: { type: 'ticks', N: 10000, prob: (a, b) => ((b - a) * 429496 + Math.max(0, Math.min(b, 7296) - a)) / 4294967296 },
    },
    'plinko-ticket': {
      formula: 'u32(SHA-256("server:client:nonce")) mod 65535',
      params: [],
      raw: true,
      compute(ctx) { const v = word(ctx) % 65535; return { value: v, display: String(v) }; },
      compare: (o, c) => compareInt(o.value, c),
    },
  },
};

duelbits.vectors = [
  // SHA-256("04093dcb…36e3:my client seed:0") starts with 98c930dd (node:crypto):
  // 2563322077 mod 10000 = 2077 → 20.77, mod 65535 = 51622; nonce 1: f05c94f8 → 92.88.
  { name: 'published example seed, client "my client seed", nonces 0 and 1', source: 'ProvablyHero duelbits/v1.test.ts inputs; expected from node:crypto SHA-256', got: () => [0, 1].map((n) => duelbits.games.dice.compute({ server: '04093dcb0d2790612ecd6d9837e2e3c6144f30f16bf560357ecc14ac0f0236e3', client: 'my client seed', nonceText: String(n) }).display), expect: ['20.77', '92.88'] },
  { name: 'plinko ticket, nonce 0 → 51622', source: 'node:crypto SHA-256', got: () => duelbits.games['plinko-ticket'].compute({ server: '04093dcb0d2790612ecd6d9837e2e3c6144f30f16bf560357ecc14ac0f0236e3', client: 'my client seed', nonceText: '0' }).value, expect: 51622 },
];

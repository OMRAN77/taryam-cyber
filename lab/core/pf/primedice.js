// Primedice (legacy dice): h = HMAC_SHA512(key = server seed text, message =
// "client-nonce") as hex; read 5 hex digits at a time and take the first value
// below 10^6; roll = (value mod 10^4) / 100. If all 25 windows fail the roll is
// 99.99 (probability about 4e-34). Unbiased: 10^6 is a multiple of 10^4.
import { hmacSha512Key } from '../sha512-sync.js';
import { bytesToHex, commitText, compareTicks } from './common.js';
import { diceGame } from './games.js';

export function primediceRoll(hex) {
  for (let i = 0; i + 5 <= hex.length; i += 5) {
    const v = parseInt(hex.slice(i, i + 5), 16);
    if (v < 1000000) return { ticks: v % 10000, window: i / 5 };
  }
  return { ticks: 9999, window: null };
}

const dice = diceGame(10000);
export const primedice = {
  id: 'primedice',
  version: 'legacy',
  kind: 'seeded',
  name: ['Primedice', 'Primedice'],
  sourceUrl: 'https://github.com/provably-fair/provably-fair-app/blob/4cad9a520ab85d26c5ce4c6bda0a266d3a7781af/README.md',
  sources: [
    'https://github.com/provably-fair/provably-fair-app/blob/4cad9a520ab85d26c5ce4c6bda0a266d3a7781af/src/services/Primedice/generic.js',
    'https://github.com/sh4dowb/primedice-verify-py/blob/9fd76e852ca196d42c7b9ef62dc605ee524f5f0f/prime-verify.py',
  ],
  captureDate: '2026-11-02',
  evidence: 'reference',
  notes: [
    'من وثائق وأدوات طرف ثالث؛ لم يُتحقق منه مقابل صفحة Primedice الحالية. انتبه: مفتاح HMAC هو بذرة الخادم المكشوفة، لا الـhash (أحد التطبيقات يسمّي المعامل serverSeedHash).',
    'From third-party documentation and tools; not checked against Primedice\'s current page. Note: the HMAC key is the revealed server seed, not its hash (one app names the parameter serverSeedHash).',
  ],
  keyEncoding: 'text',
  commitment: 'text',
  nonceBase: 0,
  hmacKey: (seed) => hmacSha512Key(seed),
  commit: commitText,
  defaultGame: 'dice',
  games: {
    dice: {
      formula: 'first 5-hex window < 10^6 of HMAC-SHA512("client-nonce"), mod 10^4 / 100',
      params: ['target', 'condition'],
      raw: true,
      compute(ctx) {
        const r = primediceRoll(bytesToHex(ctx.hmac(`${ctx.client}-${ctx.nonceText}`)));
        return { ...r, display: (r.ticks / 100).toFixed(2) };
      },
      compare: (o, c) => compareTicks(o.ticks, c),
      win: dice.win,
      multiplier: dice.multiplier,
      stats: { type: 'ticks', N: 10000, prob: (a, b) => (b - a) / 10000 },
    },
  },
};

const SEED = '293d5d2ddd365f54759283a8097ab2640cbe6f8864adc2b1b31e65c14c999f04';
primedice.vectors = [
  { name: 'commitment 5ac59780…', source: 'provably-fair-app README', got: () => commitText(SEED), expect: '5ac59780d512265230d5efb3cc238886dc1b457a80b54fbf1f920b99c6505801' },
  { name: 'HMAC-SHA512 starts aa671aad5e45', source: 'provably-fair-app README', got: () => bytesToHex(hmacSha512Key(SEED)('ClientSeedForDiceSites.com-0')).slice(0, 12), expect: 'aa671aad5e45' },
  { name: 'roll 79.69 (window aa671 = 697969)', source: 'provably-fair-app README', got: () => primedice.games.dice.compute({ hmac: hmacSha512Key(SEED), client: 'ClientSeedForDiceSites.com', nonceText: '0' }).display, expect: '79.69' },
];

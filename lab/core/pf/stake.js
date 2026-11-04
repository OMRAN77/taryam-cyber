// Stake: per-bet games (HMAC-SHA256 byte stream with a 32-byte cursor) and the
// multiplayer Crash / Slide hash chain. Clean-room implementation of the scheme as
// described in the research notes; vectors are quoted from the cited sources.
import { hmacSha256Key, linkHex } from '../sha256-sync.js';
import { cursorFloats, commitText, bytesToHex } from './common.js';
import { diceGame, limboGame, rouletteGame, wheelGame, kenoGame, minesGame, plinkoGame, cardsGame } from './games.js';

// Per bet: bytes = HMAC_SHA256(key = server seed as UTF-8 text,
// message = "client:nonce:round"); each float uses 4 bytes; 8 floats per round.
export const stake = {
  id: 'stake',
  version: 'v1',
  kind: 'seeded',
  name: ['Stake (لكل رهان)', 'Stake (per bet)'],
  sourceUrl: 'https://github.com/GuidoHam/fairplay-verifier/blob/dd655abd6fe1eb9f69e70284497b3968dcdc3578/tests/run-tests.js',
  sources: [
    'https://github.com/GuidoHam/fairplay-verifier/blob/dd655abd6fe1eb9f69e70284497b3968dcdc3578/AUDIT.md',
    'https://github.com/KyranRana/stake-provably-fair-api/tree/2bdc7ee02fc21421639bd33fbe31f59c757315ba/src/test',
    'https://github.com/ProvablyHero/engine/blob/f3366d5fe7b1fcd069ddbea8fcaf59eac45b2896/test-vectors/stake-plinko-v1-historical.json',
    'https://stake.com/provably-fair/implementation (not reachable from the research sandbox)',
  ],
  captureDate: '2026-08-05',
  evidence: 'reference',
  notes: [
    'الخوارزمية والمتجهات أُعيد حسابها بشكل مستقل. فحص "stake.us" المباشر تقرير صاحب المستودع لا مشاهدتنا. ترقيم خانات Mines و Plinko وكون الالتزام SHA-256 لنص البذرة لم يُتحقق منها مقابل Stake. صيغة Limbo المستعملة في التسوية (التوثيق أم الحاسبة) غير مؤكدة.',
    'Algorithm and vectors recomputed independently. The "stake.us" first-hand check is the repository author\'s report, not ours. Mines/Plinko numbering and the commitment being SHA-256 of the seed TEXT are not verified against Stake. Which Limbo formula settles bets (docs or calculator) is unconfirmed.',
  ],
  keyEncoding: 'text',
  commitment: 'text',
  nonceBase: null,
  defaultGame: 'dice',
  games: {
    dice: diceGame(10001),
    limbo: limboGame,
    roulette: rouletteGame,
    wheel: wheelGame,
    keno: kenoGame,
    plinko: plinkoGame,
    mines: minesGame,
    cards: cardsGame,
  },
  options: { limboFormula: ['calc24', 'docs'], tileBase: [0, 1] },
  floats(ctx, count) {
    return cursorFloats(ctx.hmac, ctx.client, ctx.nonceText, count);
  },
  hmacKey: (seed) => hmacSha256Key(seed),
  commit: commitText,
};

const S = 'e8df2cc3b9ccb583ce5ea92336842387', C = '83e27f682128eb1852b048203dfd6931';
const ctxOf = (server, client, nonce) => ({ hmac: hmacSha256Key(server), client, nonceText: String(nonce) });
const run = (game, server, client, nonce, params = {}, opts = {}) => {
  const g = stake.games[game];
  const n = g.floats(params);
  return g.compute(stake.floats(ctxOf(server, client, nonce), n), params, opts);
};
const KR = [
  ['18e93f4a7b5b58d2569765766d1b6c3296bbd8430d6f20249044d72f14720159', 'bb62964774', 1],
  ['a9a09f7f84c9dc6d4f46f9b702d8e7e211e1fc219ac10e1145c4ca032eb000c6', '3c83fc7e07', 3],
  ['a5022ccf5dd5a76d2014278e3d91d1dfc47c3f12e683ea0c8151fdc2f944beb1', '8b3ca8298c', 54],
];
const GUIDO = 'GuidoHam/fairplay-verifier tests/run-tests.js (stake.us calculator, 2026-08-05, author\'s report)';
const KYRAN = 'KyranRana/stake-provably-fair-api src/test (stake.com calculation links)';

stake.vectors = [
  { name: 'bytes 0..3 = b7 08 ca 58', source: GUIDO, got: () => bytesToHex(hmacSha256Key(S)(`${C}:1:0`).subarray(0, 4)), expect: 'b708ca58' },
  { name: 'dice 71.50', source: GUIDO, got: () => run('dice', S, C, 1).display, expect: '71.50' },
  { name: 'limbo raw (calculator) 1.384658144300882', source: GUIDO, got: () => run('limbo', S, C, 1).raw, expect: 1.384658144300882 },
  { name: 'limbo shown 1.38', source: GUIDO, got: () => run('limbo', S, C, 1).display, expect: '1.38' },
  { name: 'mines, first 17 tiles (0-24)', source: GUIDO, got: () => run('mines', S, C, 1, { mines: 17 }).values, expect: [17, 21, 7, 24, 13, 23, 11, 14, 6, 9, 15, 2, 20, 1, 10, 4, 8] },
  { name: 'keno', source: GUIDO, got: () => run('keno', S, C, 1).values, expect: [29, 36, 12, 40, 23, 38, 21, 24, 14, 17] },
  { name: 'plinko 8 rows RRLRRRRR, slot 7', source: GUIDO, got: () => { const o = run('plinko', S, C, 1, { rows: 8 }); return [o.path, o.slot]; }, expect: ['RRLRRRRR', 7] },
  { name: 'limbo, leading space on both seeds, nonce 1942124', source: GUIDO, got: () => run('limbo', ' ' + S, ' ' + C, 1942124).raw, expect: 1.5831247773805166 },
  { name: 'dice 77.18 / 19.59 / 56.37', source: KYRAN, got: () => KR.map(([s, c, n]) => run('dice', s, c, n).display), expect: ['77.18', '19.59', '56.37'] },
  { name: 'limbo (docs formula) 1.28 / 5.05 / 1.75', source: KYRAN, got: () => KR.map(([s, c, n]) => run('limbo', s, c, n, {}, { limboFormula: 'docs' }).display), expect: ['1.28', '5.05', '1.75'] },
  { name: 'roulette 28 / 7 / 20', source: KYRAN, got: () => KR.map(([s, c, n]) => run('roulette', s, c, n).value), expect: [28, 7, 20] },
  { name: 'keno (crosses into round 1)', source: KYRAN, got: () => run('keno', ...KR[0]).values, expect: [31, 36, 12, 32, 2, 8, 20, 10, 25, 17] },
  { name: 'cards, infinite deck (10 cards)', source: KYRAN, got: () => run('cards', ...KR[0], { count: 10 }).display, expect: 'Q♦ K♠ 6♦ Q♥ 2♥ 4♠ 8♥ 5♦ 9♣ 7♥' },
  {
    name: 'plinko 8/11/16 rows (community-reported paths, 2018)',
    source: 'ProvablyHero/engine test-vectors/stake-plinko-v1-historical.json (stakecommunity.com topic 14119)',
    got: () => [[1, 8], [2, 11], [3, 16]].map(([n, rows]) => run('plinko', '910af731f943e44fa03584d7e760fd1a8cc8d075befd69249e2801a27187ddd9', 'Boobs', n, { rows }).path),
    expect: ['LLRLLRRR', 'LRLLRRLLRLL', 'RRRLRRLLLLLLLRLR'],
  },
];

// ---------- Crash and Slide (multiplayer hash chain) ----------
// Each link is SHA-256 of the previous hash's hex TEXT. Result:
// hmac = HMAC_SHA256(key = game hash as text, message = salt as text);
// int = first 8 hex digits; crash = max(1, 2^32 / (int + 1) x 0.99) (Slide x 0.98).
const STAKE_SALT = '0000000000000000001b34dc6a1e86083f95500b096231436e9b25cbdd0075c4';
function stakeChain(id, factor, name, vectorsExpect) {
  const a = {
    id,
    version: 'v1',
    kind: 'chain',
    name,
    sourceUrl: 'https://github.com/lucasholder/fair/blob/ffbccd49cd423cd2eab7784fc1a2422b50882860/src/games/crash.rs',
    sources: [
      'https://github.com/KyranRana/stake-provably-fair-api/blob/2bdc7ee02fc21421639bd33fbe31f59c757315ba/src/test/Crash.test.ts',
      'https://bitcointalk.org/index.php?topic=5162888 (seeding event, quoted in crash.rs)',
    ],
    captureDate: '2026-11-02',
    evidence: 'reference',
    notes: [
      'الـsalt هو hash كتلة بيتكوين 584,500 وفق مصدرين ثانويين؛ لم نتحقق من هوية الكتلة. سلسلة من 10 ملايين hash آخرها 78a9757d….',
      'The salt is the hash of Bitcoin block 584,500 according to two secondary sources; the block identity was not checked. A 10,000,000-hash chain ending at 78a9757d….',
    ],
    link: 'hex',
    salt: STAKE_SALT,
    terminating: '78a9757d3be42b74a3f70239078ad9317125fe9ee630d5bdada46de963e56752',
    chainLength: 10000000,
    eraFor: () => ({ id: 'v1', chain: 'main', link: 'hex', computable: true, chainStart: null, terminating: a.terminating }),
    result(hashHex, era, opts = {}) {
      const salt = opts.salt || STAKE_SALT;
      const h = hmacSha256Key(hashHex)(salt);
      const int = ((h[0] << 24) | (h[1] << 16) | (h[2] << 8) | h[3]) >>> 0;
      const raw = Math.max(1, (2 ** 32 / (int + 1)) * factor);
      return { raw, cents: Math.floor(raw * 100), hmac: bytesToHex(h) };
    },
    // P(result >= m), m in cents: floor(factor x 100 x 2^32 / m) / 2^32.
    survival: (m) => Math.min(1, Number((BigInt(Math.round(factor * 100)) << 32n) / BigInt(m)) / 2 ** 32),
    linkFor: () => linkHex,
  };
  const hashes = ['b4e7b335045da0a2666145980d03ed440a2e150e5369c72c7e6e24aeeb95f791', '3e473405bd819ed4171854194bae75a2b117739fc1ab2e1c4cd263e1904dae6f', 'ca9b74c095c615cdf961892e54b35d42b6b8d3612266ff158547020fab514cf7'];
  a.vectors = [
    { name: 'results of three game hashes', source: `KyranRana/stake-provably-fair-api src/test/${id === 'stake-crash' ? 'Crash' : 'Slide'}.test.ts`, got: () => hashes.map((h) => a.result(h).raw), expect: vectorsExpect },
    { name: 'HMAC of the first hash starts 62ae955a1b219e9d', source: 'KyranRana Crash.test.ts', got: () => a.result(hashes[0]).hmac.slice(0, 16), expect: '62ae955a1b219e9d' },
  ];
  return a;
}

export const stakeCrash = stakeChain('stake-crash', 0.99, ['Stake Crash', 'Stake Crash'], [2.5682504010713783, 1.3193661251992947, 3.018368989236868]);
export const stakeSlide = stakeChain('stake-slide', 0.98, ['Stake Slide', 'Stake Slide'], [2.542308477828233, 1.3060391946417262, 2.9878804135880106]);

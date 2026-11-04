// BC.Game: crash hash chain (salted after bet #2,561,902) and single-player dice
// (current 53-bit sliding window, and the 2022 legacy mapping).
import { hmacSha256Key, linkHex } from '../sha256-sync.js';
import { bust52, bust52Survival, hexToBytes, bytesToHex, commitText, floatAt, floorMapProb, compareTicks } from './common.js';
import { diceGame } from './games.js';

// ---------- Crash ----------
// Link = SHA-256 of the previous hash's hex TEXT. Salted era:
// h = HMAC_SHA256(key = UTF-8 salt, message = the game hash's raw bytes);
// X = first 52 bits / 2^52, then X = parseFloat(X.toPrecision(9)) (BC's extra
// rounding), bust = max(1, floor(99 / (1 - X)) / 100). When X rounds to 1 the
// published formula gives Infinity (about 5e-10 per game): such a game is reported
// "not checked (edge case)", since what the game actually showed is unknown.
const BC_SALT = '0000000000000000000e3a66df611d6935b30632f352e4934c21059696117f28';
const SALT_FROM = 2561902; // "after Bet # 2561902"; that this number is a game id is not confirmed

const keys = new Map();
const keyed = (salt) => { if (!keys.has(salt)) keys.set(salt, hmacSha256Key(salt)); return keys.get(salt); };

export function bcCrashFromHex(hex13) { return bust52(hex13, { precision9: true }); }

export const bcgameCrash = {
  id: 'bcgame-crash',
  version: 'salted-2020',
  kind: 'chain',
  name: ['BC.Game Crash', 'BC.Game Crash'],
  sourceUrl: 'https://github.com/bc-game-project/bcgame-crash/blob/a82f49105f45d5f405e352a983cccaae4312f1a3/docs/index.html',
  sources: [
    'https://github.com/bc-game-project/verify/blob/bb5a09ac756f0ace10cd15d0792124682e994737/crash.html',
    'https://github.com/GuyPaddock/BcGameCrashAnalyzer/blob/c9f843b3c43cab30809629f0f18f504c070ad7cb/bc_game_data_4905002_4923003_with_gaps.csv (11,412 published results, Apache-2.0)',
    'https://bitcointalk.org/index.php?topic=5256606 (salt announcement)',
  ],
  captureDate: '2026-11-02',
  evidence: 'reference',
  notes: [
    'إعادة الحساب تطابق 11,412 نتيجة منشورة (الألعاب 4,905,002 إلى 4,923,003) من سلسلة hash لعبة 5,098,240، لكن hash الإنهاء والتزام ما قبل اللعب لم يُفحصا، فالدليل "مرجعي". إن قرّبت toPrecision(9) قيمة X إلى 1 تعطي الصيغة المنشورة Infinity؛ تُعلَّم هذه اللعبة "لم تُفحص".',
    'The recomputation matches 11,412 published results (games 4,905,002 to 4,923,003) from the chain of game 5,098,240\'s hash, but no terminating hash or pre-play commitment was checked, so the evidence is "reference". When toPrecision(9) rounds X to 1 the published formula gives Infinity; such a game is marked "not checked".',
  ],
  link: 'hex',
  chainLength: null,
  eraOption: ['salted', 'unsalted'],
  eraFor(gameId, opts = {}) {
    const salted = gameId === null || gameId === undefined ? opts.era !== 'unsalted' : gameId > SALT_FROM;
    return { id: salted ? 'salted' : 'unsalted', chain: 'main', link: 'hex', computable: true, chainStart: null, terminating: null, salted };
  },
  result(hashHex, era, opts = {}) {
    const hex = era.salted ? bytesToHex(keyed(opts.salt || BC_SALT)(hexToBytes(hashHex))) : hashHex;
    const r = bcCrashFromHex(hex.slice(0, 13));
    return Number.isFinite(r.raw) ? r : { ...r, edge: 'infinity' };
  },
  survival: (m) => bust52Survival(m),
  linkFor: () => linkHex,
  salt: BC_SALT,
};

const GP = 'GuyPaddock/BcGameCrashAnalyzer dataset (game id, result); hashes from walking game 5,098,240\'s hash (algopert/BC-Game-Crash-bot) with node:crypto';
bcgameCrash.vectors = [
  { name: 'games 4,905,002 / 4,905,003 / 4,923,003 → 1.05 / 1.81 / 6.27', source: GP, got: () => ['3373da5bf3c68f66dd6d81919e6a7890475582103d74c46f4677cc48606ca225', '4546d022dbbd8026e03d82d3e4a5e39987e214ec1196416b6289eee38f3c4218', 'cbc026f8c7e4315553643e10386ef11fa1b05d7f64d85fb5abe139722e756504'].map((h) => bcgameCrash.result(h, bcgameCrash.eraFor(4905002)).raw), expect: [1.05, 1.81, 6.27] },
  { name: 'link 4,905,003 → 4,905,002 hashes hex text', source: GP, got: () => bytesToHex(linkHex(hexToBytes('4546d022dbbd8026e03d82d3e4a5e39987e214ec1196416b6289eee38f3c4218'))), expect: '3373da5bf3c68f66dd6d81919e6a7890475582103d74c46f4677cc48606ca225' },
  // X = r / 2^52 >= 0.9999999995 rounds to 1 at 9 significant digits. The smallest such
  // r is ceil(9999999995 x 2^52 / 10^10) = 4503599625118697 = 0xfffffffdda3e9 (BigInt).
  { name: 'Infinity edge: 52-bit value 0xfffffffdda3e9 → Infinity, one less → finite', source: 'bc-game-project/verify crash.html formula; threshold derived with BigInt', got: () => [bcCrashFromHex('fffffffdda3e9').raw, Number.isFinite(bcCrashFromHex('fffffffdda3e8').raw)], expect: [Infinity, true] },
];

// ---------- Dice ----------
// Current (captured 2026-10, ProvablyHero): h = HMAC_SHA256(key = server seed text,
// message = "client:nonce") as hex; offset = int(h[0..15]) mod 47;
// w = int(h[offset .. offset+14]) >> 3 (53 bits). ClassicDice98: ticks = floor(w 2^-53 10001);
// Dice98: ticks = parseInt(String(w 2^-53 10000)) (the published quirk: below 1e-6 the
// string is in scientific notation and parseInt returns its first digit).
export function bcWindow(hex) {
  const offset = Number(BigInt('0x' + hex.slice(0, 15)) % 47n);
  const w = BigInt('0x' + hex.slice(offset, offset + 14)) >> 3n;
  return { offset, w };
}

function bcDice(N, quirk) {
  return {
    formula: quirk ? 'parseInt(String(w × 2^-53 × 10000))' : 'floor(w × 2^-53 × 10001)',
    params: ['target', 'condition'],
    raw: true,
    compute(hex) {
      const { w, offset } = bcWindow(hex);
      const x = Number(w) * 2 ** -53 * N;
      const ticks = quirk ? Number.parseInt(String(x), 10) : Math.floor(x);
      return { ticks, offset, display: (ticks / 100).toFixed(2) };
    },
    compare: (o, c) => compareTicks(o.ticks, c),
    win: diceGame(N).win,
    multiplier: diceGame(N).multiplier,
    stats: { type: 'ticks', N, prob: (a, b) => floorMapProb(a, b, N, 53) },
  };
}

const BC_DICE_COMMON = {
  kind: 'seeded',
  keyEncoding: 'text',
  commitment: 'text',
  nonceBase: null,
  hmacKey: (seed) => hmacSha256Key(seed),
  commit: commitText,
  message: (ctx) => `${ctx.client}:${ctx.nonceText}`,
};

export const bcgameDice = {
  ...BC_DICE_COMMON,
  id: 'bcgame-dice',
  version: '2026-10',
  name: ['BC.Game Dice', 'BC.Game Dice'],
  sourceUrl: 'https://github.com/ProvablyHero/engine/blob/f3366d5fe7b1fcd069ddbea8fcaf59eac45b2896/src/adapters/bc-game/dice-v1.test.ts',
  sources: ['https://github.com/ProvablyHero/engine/blob/f3366d5fe7b1fcd069ddbea8fcaf59eac45b2896/README.md'],
  captureDate: '2026-10-25',
  evidence: 'verified',
  notes: [
    '"موثّق" لدى ProvablyHero استنادًا إلى جولتين مكشوفتين لـ ClassicDice98 وست جولات لـ Dice98 فقط، فالثقة متوسطة.',
    'Labelled "verified" by ProvablyHero on only two disclosed ClassicDice98 rounds and six Dice98 rounds, so confidence is medium.',
  ],
  defaultGame: 'classic-dice',
  games: { 'classic-dice': bcDice(10001, false), dice: bcDice(10000, true) },
  bytes: (ctx) => bytesToHex(ctx.hmac(BC_DICE_COMMON.message(ctx))),
};

export const bcgameDiceLegacy = {
  ...BC_DICE_COMMON,
  id: 'bcgame-dice',
  version: 'legacy-2022',
  name: ['BC.Game Dice (قديم)', 'BC.Game Dice (legacy)'],
  sourceUrl: 'https://github.com/bc-game-project/verify/blob/bb5a09ac756f0ace10cd15d0792124682e994737/classicdice.html',
  sources: [],
  captureDate: '2026-11-02',
  evidence: 'reference',
  notes: [
    'المدقق القديم (2022): أول 4 بايت من HMAC-SHA256("client:nonce") ثم floor(f × 10001) / 100. لم يعد مستعملًا في Dice الحالي.',
    'Legacy verifier (2022): first 4 bytes of HMAC-SHA256("client:nonce"), then floor(f × 10001) / 100. Not what current Dice uses.',
  ],
  defaultGame: 'classic-dice',
  games: { 'classic-dice': diceGame(10001) },
  floats: (ctx) => [floatAt(ctx.hmac(BC_DICE_COMMON.message(ctx)), 0)],
};

const PH = 'ProvablyHero/engine src/adapters/bc-game/dice-v1.test.ts (disclosed rounds)';
const roll = (a, game, seed, client, nonce) => {
  const ctx = { hmac: hmacSha256Key(seed), client, nonceText: String(nonce) };
  const g = a.games[game];
  return g.raw ? g.compute(a.bytes(ctx)).display : g.compute(a.floats(ctx)).display;
};
bcgameDice.vectors = [
  { name: 'ClassicDice98 nonce 15 → 76.28', source: PH, got: () => roll(bcgameDice, 'classic-dice', '2dbc38e175dcf0fed504db05da12adffc1df6684e6394b1d18070c1f25728fe8', '8a83fd8e6b586a23e84aa99b4a88bedf', 15), expect: '76.28' },
  { name: 'ClassicDice98 nonce 2 → 35.84', source: PH, got: () => roll(bcgameDice, 'classic-dice', '5307cf62acca4cc9141c450c7ac72ecd926f5ee92301bf3033c4a45e49cb30b5', 'e18e0JxwASAwiwCdx', 2), expect: '35.84' },
  { name: 'Dice98 nonces 2,3,4,6,7,9', source: PH, got: () => [2, 3, 4, 6, 7, 9].map((n) => roll(bcgameDice, 'dice', '58cc768fe782afd394911862a3579dc7f2eb3a13802f16ce0f762948f0115ff7', 'e58d4457f15c1851581b349de5b60821', n)), expect: ['93.62', '11.97', '99.07', '9.25', '37.54', '13.49'] },
  { name: 'commitment of the disclosed seed', source: PH, got: () => commitText('2dbc38e175dcf0fed504db05da12adffc1df6684e6394b1d18070c1f25728fe8'), expect: 'd566fbe201f5aac6a4d45ff9d7fa44fe5bb7108efb5d00212d7962daf012983a' },
];
bcgameDiceLegacy.vectors = [
  { name: 'legacy mapping of the same seed, nonce 15 → 42.21', source: PH + ' (legacy first-four-byte mapping)', got: () => roll(bcgameDiceLegacy, 'classic-dice', '2dbc38e175dcf0fed504db05da12adffc1df6684e6394b1d18070c1f25728fe8', '8a83fd8e6b586a23e84aa99b4a88bedf', 15), expect: '42.21' },
];

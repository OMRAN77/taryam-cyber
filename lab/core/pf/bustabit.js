// bustabit crash: one hash chain per era, salted with a Bitcoin block hash.
// Result: X = first 52 bits of HMAC_SHA256(key, message = the game hash's RAW
// bytes) / 2^52; bust = max(1, floor(99 / (1 - X)) / 100).
// Eras (constants from bustabit's own verifier, src/constants.ts):
//   games 1 .. 10,000,000            previous chain: a link hashes the HEX TEXT of the
//                                    next game's hash; key = UTF-8 of the 2018 salt.
//   games 10,000,001 .. 12,279,450   current chain (links hash RAW bytes), "Vx" era:
//                                    key = a BLS12-381 signature; not computed here.
//   games 12,279,451 ..              current chain; key = UTF-8 of the 2025 salt.
// bustabit's verifier routes game 10,000,000 to the current chain (isPreviousChain =
// gameNumber < 10,000,000), so it shows no result for it; here it belongs to the
// previous chain, whose 10,000,000 games end at the previous terminating hash.
import { hmacSha256Key, linkHex, linkRaw } from '../sha256-sync.js';
import { bust52, bust52Survival, hexToBytes as fromHex, bytesToHex as hex } from './common.js';

const PREV_SALT = '0000000000000000004d6ec16dafe9d8370958664c1dc422f452892264c59526';
const VX_SALT = '000000000000000000011f6e135efe67d7463dfe7bb955663ef88b1243b2deea';
const SALT = '00000000000000000001e08b7fd44f95e3e950ac65650a8031a6d5e1750e34be';
export const BUSTABIT = {
  PREV_CHAIN_LENGTH: 10000000,
  VX_LAST_GAME: 12279450,
  PREV_TERMINATING: '86728f5fc3bd99db94d3cdaf105d67788194e9701bf95d049ad0e1ee3d004277',
  TERMINATING: '567a98370fb7545137ddb53687723cf0b8a1f5e93b1f76f4a1da29416930fa59',
  PREV_SALT, VX_SALT, SALT,
};

const ERAS = {
  prev: { id: 'prev', chain: 'prev', link: 'hex', computable: true, chainStart: 1, terminating: BUSTABIT.PREV_TERMINATING, key: PREV_SALT },
  vx: { id: 'vx', chain: 'current', link: 'raw', computable: false, chainStart: 10000001, terminating: BUSTABIT.TERMINATING, reason: 'era-unsupported' },
  current: { id: 'current', chain: 'current', link: 'raw', computable: true, chainStart: 10000001, terminating: BUSTABIT.TERMINATING, key: SALT },
};

export function bustabitEra(gameId, fallback = 'current') {
  if (gameId === null || gameId === undefined) return ERAS[fallback] || ERAS.current;
  if (gameId <= BUSTABIT.PREV_CHAIN_LENGTH) return ERAS.prev;
  if (gameId <= BUSTABIT.VX_LAST_GAME) return ERAS.vx;
  return ERAS.current;
}

const keys = new Map();
const keyed = (salt) => { if (!keys.has(salt)) keys.set(salt, hmacSha256Key(salt)); return keys.get(salt); };

export const bustabit = {
  id: 'bustabit',
  version: 'v2-2025',
  kind: 'chain',
  name: ['bustabit', 'bustabit'],
  sourceUrl: 'https://github.com/bustabit/verifier/blob/f45fc0cd95f626ac435c8121d413056b57eb2acf/src/verifier.worker.ts',
  sources: [
    'https://github.com/bustabit/verifier/blob/f45fc0cd95f626ac435c8121d413056b57eb2acf/src/constants.ts',
    'https://bitcointalk.org/index.php?topic=5560454 (current seeding event)',
    'https://bitcointalk.org/index.php?topic=2807542 (previous seeding event)',
  ],
  captureDate: '2026-11-02',
  evidence: 'verified',
  notes: [
    'متجهات حقيقية: نتائج ألعاب أبلغ عنها لاعبون تطابق إعادة الحساب، والسلسلة من اللعبة 12,306,896 تصل إلى hash الإنهاء الرسمي بعد 2,306,896 رابطًا. ألعاب حقبة Vx ‏(10,000,001 إلى 12,279,450) تحتاج توقيع BLS12-381 فلا تُحسب نتائجها هنا (تُفحص روابط السلسلة فقط). اللعبة 10,000,000 من السلسلة السابقة؛ مدقق bustabit الرسمي لا يحسبها.',
    'Real vectors: player-reported game results match the recomputation, and the chain from game 12,306,896 reaches the official terminating hash after 2,306,896 links. Vx-era games (10,000,001 to 12,279,450) need a BLS12-381 signature, so their results are not computed here (chain links are still checked). Game 10,000,000 belongs to the previous chain; bustabit\'s own verifier skips it.',
  ],
  link: 'era',
  chainLength: null,
  eraOption: ['current', 'prev'],
  eraFor: (gameId, opts = {}) => bustabitEra(gameId, opts.era),
  result(hashHex, era) {
    if (!era.computable) return { raw: null, cents: null, edge: era.reason };
    const h = keyed(era.key)(fromHex(hashHex));
    return { ...bust52(bytesHex13(h)) };
  },
  survival: (m) => bust52Survival(m),
  linkFor: (era) => (era.link === 'hex' ? linkHex : linkRaw),
};

function bytesHex13(h) {
  let s = '';
  for (let i = 0; i < 7; i++) s += h[i].toString(16).padStart(2, '0');
  return s.slice(0, 13);
}

const CUR = 'deduzzo/bustabit-scripts tests/verification/test-forward-chain.js (results reported by a player)';
const PREV = 'Jay-ArBrouillard/jay-bit-hash source/tests/test_functions.py (game numbers: links walked to the terminating hash with node:crypto)';
bustabit.vectors = [
  { name: 'games 12,306,896 / 895 / 894 → 10.91 / 4.26 / 1.83', source: CUR, got: () => ['94aa062026624e59a0ace092568d5f46e21b9bf1d5173609db8645dd62bdfc44', '94e66d98029c61ecd27c4fb6b381d401c823cf3dfbdac9246756d5b655e125aa', '8d3b9726ca7bc5e3637bf2079e09eaf2a9d67df4e6f50ff23a7b593bd802cca6'].map((h, i) => bustabit.result(h, bustabitEra(12306896 - i)).raw), expect: [10.91, 4.26, 1.83] },
  { name: 'game 12,306,896 links (raw bytes) to game 12,306,895', source: CUR, got: () => hex(linkRaw(fromHex('94aa062026624e59a0ace092568d5f46e21b9bf1d5173609db8645dd62bdfc44'))), expect: '94e66d98029c61ecd27c4fb6b381d401c823cf3dfbdac9246756d5b655e125aa' },
  { name: 'previous chain: games 8,138,709 / 711 / 712 / 716 → 1.00 / 1.69 / 36.18 / 48.93', source: PREV, got: () => [['332901b7b469b69d544597767849b36767fe86925b5d01de04e70c468b60b903', 8138709], ['3add5306be1ad9679f8aa572cc08a79987de14249f3f582c59d0b4eaff4a390c', 8138711], ['533473d9e1e0ddc9cabe769c4eff4bf05959a346a770ee7fc580c8eff0300d09', 8138712], ['dd6f372d0a177b83284e3d094676deea6062008ba142aee433e6342ee21de8f4', 8138716]].map(([h, g]) => bustabit.result(h, bustabitEra(g)).raw), expect: [1, 1.69, 36.18, 48.93] },
  { name: 'previous chain links hash hex text (game 8,138,712 → 8,138,711)', source: PREV, got: () => hex(linkHex(fromHex('533473d9e1e0ddc9cabe769c4eff4bf05959a346a770ee7fc580c8eff0300d09'))), expect: '3add5306be1ad9679f8aa572cc08a79987de14249f3f582c59d0b4eaff4a390c' },
  { name: 'era boundaries: 10,000,000 previous; 10,000,001 and 12,279,450 Vx; 12,279,451 current', source: 'bustabit/verifier src/constants.ts', got: () => [10000000, 10000001, 12279450, 12279451].map((g) => bustabitEra(g).id), expect: ['prev', 'vx', 'vx', 'current'] },
];

// Roobet crash, UNCONFIRMED third-party package (drewnicolette/roobet, 2021):
// link = SHA-256 of the previous hash's hex TEXT; hmac = HMAC_SHA256(key = game
// hash as text, message = UTF-8 salt); if the whole 256-bit hmac is divisible by 20
// the crash is 1.00; otherwise h = first 52 bits, crash = floor((100 e - h) / (e - h)) / 100
// with e = 2^52 (computed exactly with BigInt). If accurate, RTP is about 94-95%.
import { hmacSha256Key, linkHex } from '../sha256-sync.js';
import { bytesToHex } from './common.js';

const ROOBET_SALT = '0000000000000000000fa3b65e43e4240d71762a5bf397d5304b2596d116859c';

export function roobetCrash(hashHex, salt = ROOBET_SALT) {
  const hx = bytesToHex(hmacSha256Key(hashHex)(salt));
  if (BigInt('0x' + hx) % 20n === 0n) return { raw: 1, cents: 100, instant: true };
  const h = BigInt('0x' + hx.slice(0, 13)), e = 1n << 52n;
  const cents = Number((100n * e - h) / (e - h));
  return { raw: cents / 100, cents };
}

export const roobet = {
  id: 'roobet',
  version: 'unofficial-2021',
  kind: 'chain',
  name: ['Roobet Crash', 'Roobet Crash'], // the evidence level is shown next to the name
  sourceUrl: 'https://github.com/drewnicolette/roobet/blob/218ac001e6cd8ead023a5aa03600b5afc7a0c642/roobet/roobet.py',
  sources: [],
  captureDate: '2026-11-02',
  evidence: 'unconfirmed',
  notes: [
    'حزمة طرف ثالث من 2021؛ لا شيء يؤكد أن Roobet تستعملها اليوم (roobet.com غير متاح). عدم التطابق قد يعني أن الصيغة قديمة لا أن المشغّل غشّ.',
    'A third-party package from 2021; nothing confirms Roobet uses it today (roobet.com unreachable). A mismatch may mean the formula is outdated, not that the operator cheated.',
  ],
  link: 'hex',
  chainLength: null,
  eraFor: () => ({ id: 'v1', chain: 'main', link: 'hex', computable: true, chainStart: null, terminating: null }),
  result: (hashHex, era, opts = {}) => roobetCrash(hashHex, opts.salt || ROOBET_SALT),
  // P(crash >= m) = (1 - 1/20) x 99 / (100 m - 1) for m > 1 (m in cents: 99 / (m - 1)).
  survival: (m) => (m <= 100 ? 1 : Math.min(1, 0.95 * 99 / (m - 1))),
  linkFor: () => linkHex,
  salt: ROOBET_SALT,
};

const PY = 'independent Python derivation of the published third-party formula (synthetic hashes)';
roobet.vectors = [
  { name: 'three synthetic game hashes → 1.33 / 2.83 / 1.81', source: PY, got: () => ['b8bf3d2116750fd2160a435d887355eace01dc90baee29201823b7d56b8e91b5', '5b783d7c0b80ea1f7e629943180ad11dded91fe99683aacec564fe5b6614a1f7', 'c74bb168398895e69f12deeea71f4a154876de0adfe22b1d2d2a7a1939c194fa'].map((h) => roobetCrash(h).raw), expect: [1.33, 2.83, 1.81] },
  { name: 'instant crash (hmac divisible by 20) → 1.00', source: PY, got: () => roobetCrash('080aacad2572d0692742dd561c10e23f3314e14c9c6d5402bdfcb6a5ea2ac027').instant, expect: true },
  { name: 'link: previous hash = SHA-256(hex text)', source: PY, got: () => bytesToHex(linkHex(Uint8Array.from('b8bf3d2116750fd2160a435d887355eace01dc90baee29201823b7d56b8e91b5'.match(/../g), (x) => parseInt(x, 16)))), expect: '53a1ada0c6f5b9aab4a007543837b21ce4df3b3eb79cf53a8c95a6783bf087e5' },
];

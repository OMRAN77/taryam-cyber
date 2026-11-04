// Spribe Aviator, UNCONFIRMED third-party reconstruction (side-quest-dev/aviator-verifier):
// hash = SHA-512(server seed + client seed 1 + client seed 2 + client seed 3) as hex;
// n = first 13 hex digits / 2^52; crash = floor((97 / (1 - n)) / 100 x 100) / 100.
// The formula has no max(1, ...): about 3% of rounds give a value below 1.00. How
// the game shows those is unknown, so such rows are "not checked (edge case)".
import { sha512 } from '../sha512-sync.js';
import { bytesToHex, compareMultiplier } from './common.js';

export function aviatorCrash(server, clients) {
  const h = bytesToHex(sha512(server + clients.join('')));
  const n = parseInt(h.slice(0, 13), 16) / 4503599627370496;
  const raw = (97 / (1 - n)) / 100;
  const cents = Math.floor(raw * 100);
  return { raw, cents, display: (cents / 100).toFixed(2), ...(cents < 100 ? { edge: 'below-one' } : {}) };
}

export const aviator = {
  id: 'aviator',
  version: 'unofficial-2025',
  kind: 'combined',
  name: ['Aviator (غير مؤكد)', 'Aviator (unconfirmed)'],
  sourceUrl: 'https://github.com/side-quest-dev/aviator-verifier/blob/d024be598e82bca5f3051a0997c867c3fab4a50d/README.md',
  sources: [],
  captureDate: '2026-11-02',
  evidence: 'unconfirmed',
  notes: [
    'إعادة بناء من طرف ثالث لم تُطابق بوثائق Spribe (الموقع غير متاح). اللاعب لا يتحكم بالنتيجة إلا إن كان أحد أصحاب بذور العميل الثلاث، وجمع البذور يمر عبر الخادم. عدم التطابق قد يعني أن الصيغة خاطئة لا أن المشغّل غشّ.',
    'A third-party reconstruction not matched against Spribe\'s documents (site unreachable). A player controls nothing unless they are one of the three client-seed contributors, and seed collection goes through the server. A mismatch may mean the formula is wrong, not that the operator cheated.',
  ],
  defaultGame: 'crash',
  games: {
    crash: {
      formula: 'floor(97 / (1 − n)) / 100, n = SHA-512(server + c1 + c2 + c3)[0..13] / 2^52',
      compute: (server, clients) => aviatorCrash(server, clients),
      compare: (o, c) => (o.edge ? 'edge' : compareMultiplier(o, c)),
      // P(crash >= m) = P(97 / (1 - n) >= m) = 0.97 / m, up to the 2^-52 grid.
      stats: { type: 'multiplier', survival: (m) => Math.min(1, 97 / m) },
    },
  },
};

// Inputs are synthetic; expected values computed independently in Python
// (hashlib.sha512, same formula) — not from operator data.
const PY = 'independent Python derivation of the published third-party formula (synthetic inputs)';
aviator.vectors = [
  { name: 'three synthetic rounds → 3.15 / 1.85 / 1.71', source: PY, got: () => [['cd3fabdfb42d4cd05ebbad6d62dc2e99031ab51004855a555e25ad503b7d76c2', '0'], ['26c7558c500bdffb29b6ef3fb68c04494641f97fb78405598a30e2a26d7bf66c', '1'], ['b10b2a47d0b103aec9e29ead16227403af67966c1f2034572dc9074d32901508', '2']].map(([s, i]) => aviatorCrash(s, [`c1-${i}`, `c2-${i}`, `c3-${i}`]).raw), expect: [3.1566090281557964, 1.8550748944977034, 1.7127505945694947] },
  { name: 'a round below 1.00 (0.97) is an edge case', source: PY, got: () => { const r = aviatorCrash('4a2167ce082a19ec45a4e3f7cb0e4bf9480f6ec3c47d2935f3894c48bc6654bc', ['a', 'b', 'c']); return [r.display, r.edge]; }, expect: ['0.97', 'below-one'] },
];

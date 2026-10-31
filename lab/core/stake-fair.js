// Recomputes the outcome of a provably-fair round the way the Stake family of
// casinos (and the many sites that copied its scheme) derives it, so a player can
// check a round they actually played:
//   bytes  = HMAC-SHA256(key = server seed, message = "client seed:nonce:cursor"),
//            cursor = 0, 1, 2, … for every 32 bytes consumed;
//   floats = one per 4 bytes: b0/256 + b1/256² + b2/256³ + b3/256⁴, in [0, 1);
//   dice   = floor(f × 10001) / 100                      (0.00 – 100.00)
//   limbo  = max(1, floor(1e8 / (f × 1e8 + 1) × 0.99 × 100) / 100)
//   mines  = 24 floats; tile i = floor(f_i × (25 − i)) taken from the remaining
//            tiles, the first `mines` of them are the mines (tiles 0..24, row-major)
//   plinko = one float per row; right when floor(f × 2) = 1; bucket = number of rights
// The server seed hash the site showed before the round must equal
// SHA-256(server seed) once the seed is revealed; that is the commitment check.
import { sha256Hex, hmacSha256, floatFromBytes } from './fair.js';

export class FairError extends Error {
  constructor(ar, en) { super(en); this.ar = ar; this.en = en; }
}

export async function* byteStream(serverSeed, clientSeed, nonce) {
  for (let cursor = 0; ; cursor++) {
    const block = await hmacSha256(serverSeed, `${clientSeed}:${nonce}:${cursor}`);
    for (const b of block) yield b;
  }
}

export async function floats(serverSeed, clientSeed, nonce, count) {
  const out = [];
  const it = byteStream(serverSeed, clientSeed, nonce);
  while (out.length < count) {
    const bytes = [];
    for (let i = 0; i < 4; i++) bytes.push((await it.next()).value);
    out.push(floatFromBytes(bytes));
  }
  return out;
}

export function diceFrom(f) { return Math.floor(f * 10001) / 100; }
export function limboFrom(f, houseEdge = 0.01) { return Math.max(1, Math.floor((1e8 / (f * 1e8 + 1)) * (1 - houseEdge) * 100) / 100); }

export function minesFrom(fs, mines, tiles = 25) {
  const pool = Array.from({ length: tiles }, (_, i) => i);
  const order = [];
  for (let i = 0; i < fs.length && pool.length; i++) order.push(pool.splice(Math.floor(fs[i] * pool.length), 1)[0]);
  return { mines: order.slice(0, mines).sort((a, b) => a - b), order };
}

export function plinkoFrom(fs) {
  const path = fs.map((f) => Math.floor(f * 2));
  return { path, bucket: path.reduce((s, d) => s + d, 0) };
}

function checkInputs({ serverSeed, clientSeed, nonce }) {
  if (!serverSeed || !String(serverSeed).trim()) throw new FairError('بذرة الخادم مطلوبة (تظهر بعد تدوير البذور)', 'The server seed is required (shown after rotating seeds)');
  if (!clientSeed || !String(clientSeed).trim()) throw new FairError('بذرة اللاعب مطلوبة', 'The client seed is required');
  if (!(Number.isInteger(Number(nonce)) && Number(nonce) >= 0)) throw new FairError('الـnonce رقم صحيح من 0 فصاعدًا', 'The nonce is a whole number from 0 up');
}

// game: 'dice' | 'limbo' | 'mines' | 'plinko'; options: { mines, rows, houseEdge }.
// Returns the recomputed outcome plus the commitment check when a hash is given.
export async function recompute({ game, serverSeed, serverSeedHash = '', clientSeed, nonce, mines = 3, rows = 16, houseEdge = 0.01 }) {
  checkInputs({ serverSeed, clientSeed, nonce });
  serverSeed = String(serverSeed).trim(); clientSeed = String(clientSeed).trim(); nonce = Number(nonce);
  const hash = await sha256Hex(serverSeed);
  const commitment = serverSeedHash && serverSeedHash.trim() ? (serverSeedHash.trim().toLowerCase() === hash ? 'match' : 'mismatch') : 'none';
  const base = { game, serverSeed, clientSeed, nonce, hash, commitment };
  if (game === 'dice') { const [f] = await floats(serverSeed, clientSeed, nonce, 1); return { ...base, floats: [f], result: diceFrom(f) }; }
  if (game === 'limbo') { const [f] = await floats(serverSeed, clientSeed, nonce, 1); return { ...base, floats: [f], result: limboFrom(f, houseEdge) }; }
  if (game === 'mines') {
    if (!(Number.isInteger(mines) && mines >= 1 && mines <= 24)) throw new FairError('عدد الألغام من 1 إلى 24', 'Mines must be from 1 to 24');
    const fs = await floats(serverSeed, clientSeed, nonce, 24);
    return { ...base, floats: fs, ...minesFrom(fs, mines), minesCount: mines };
  }
  if (game === 'plinko') {
    if (!(Number.isInteger(rows) && rows >= 8 && rows <= 16)) throw new FairError('عدد الصفوف من 8 إلى 16', 'Rows must be from 8 to 16');
    const fs = await floats(serverSeed, clientSeed, nonce, rows);
    return { ...base, floats: fs, rows, ...plinkoFrom(fs) };
  }
  throw new FairError('لعبة غير معروفة', 'Unknown game');
}

// What a player could predict before the server seed is revealed: nothing. With
// only the hash, every outcome is equally likely; this is why "predictor" tools
// cannot work. Returned for the page to show next to the recomputation.
export const PREDICTION_NOTE = {
  ar: 'قبل كشف بذرة الخادم لا يملك اللاعب إلا بصمتها (SHA-256)، ولا يمكن حساب النتيجة منها. أي أداة تدّعي التنبؤ بالجولة القادمة من البصمة أو من «آخر بذرة» تكذب.',
  en: 'Before the server seed is revealed the player has only its SHA-256 hash, and the outcome cannot be computed from it. Any tool claiming to predict the next round from the hash or the "last seed" is lying.',
};

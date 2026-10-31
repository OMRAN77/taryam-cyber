import test from 'node:test';
import assert from 'node:assert';
import { createHmac, createHash } from 'node:crypto';
import { floats, diceFrom, limboFrom, minesFrom, plinkoFrom, recompute, FairError } from '../../lab/core/stake-fair.js';

const SERVER = '7f3b1c9e2d4a5f60817293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8';
const CLIENT = 'taryam-check';

// The scheme written out independently with node:crypto, as a site's own
// verifier page would compute it.
function referenceFloats(serverSeed, clientSeed, nonce, count) {
  const out = [];
  for (let cursor = 0; out.length < count; cursor++) {
    const block = createHmac('sha256', serverSeed).update(`${clientSeed}:${nonce}:${cursor}`).digest();
    for (let i = 0; i + 4 <= block.length && out.length < count; i += 4) {
      out.push(block[i] / 256 + block[i + 1] / 256 ** 2 + block[i + 2] / 256 ** 3 + block[i + 3] / 256 ** 4);
    }
  }
  return out;
}

test('floats follow HMAC-SHA256(server, "client:nonce:cursor") four bytes at a time, across blocks', async () => {
  const ours = await floats(SERVER, CLIENT, 12, 24);
  const ref = referenceFloats(SERVER, CLIENT, 12, 24);
  assert.deepStrictEqual(ours, ref);
  for (const f of ours) assert.ok(f >= 0 && f < 1);
  // A different nonce or client seed gives different numbers; the same inputs give the same.
  assert.notDeepStrictEqual(await floats(SERVER, CLIENT, 13, 1), ours.slice(0, 1));
  assert.notDeepStrictEqual(await floats(SERVER, 'other', 12, 1), ours.slice(0, 1));
  assert.deepStrictEqual(await floats(SERVER, CLIENT, 12, 1), ours.slice(0, 1));
});

test('game mappings: dice 0–100 in cents, limbo ≥ 1 with the 1% edge, mines unique, plinko bucket = rights', () => {
  assert.strictEqual(diceFrom(0), 0);
  assert.strictEqual(diceFrom(0.5), 50);
  assert.strictEqual(diceFrom(0.99999999), 100);
  assert.strictEqual(limboFrom(0.99999999), 1);
  assert.strictEqual(limboFrom(0.5), 1.97); // 1e8 / (5e7 + 1) × 0.99 = 1.9799…, floored to cents
  assert.ok(limboFrom(0.0000001) > 1000);
  const fs = referenceFloats(SERVER, CLIENT, 12, 24);
  const { mines, order } = minesFrom(fs, 3);
  assert.strictEqual(mines.length, 3);
  assert.strictEqual(new Set(order).size, 24);
  assert.ok(order.every((t) => t >= 0 && t < 25));
  assert.deepStrictEqual(mines, [...order.slice(0, 3)].sort((a, b) => a - b));
  const p = plinkoFrom([0.1, 0.9, 0.5, 0.49]);
  assert.deepStrictEqual(p.path, [0, 1, 1, 0]);
  assert.strictEqual(p.bucket, 2);
});

test('recompute: commitment check against SHA-256(server seed), per-game results, input errors', async () => {
  const hash = createHash('sha256').update(SERVER).digest('hex');
  const r = await recompute({ game: 'mines', serverSeed: SERVER, serverSeedHash: hash.toUpperCase(), clientSeed: CLIENT, nonce: 12, mines: 3 });
  assert.strictEqual(r.hash, hash);
  assert.strictEqual(r.commitment, 'match');
  assert.deepStrictEqual(r.mines, [0, 22, 24]); // the example on the page: tiles 1, 23, 25
  assert.strictEqual((await recompute({ game: 'mines', serverSeed: SERVER, serverSeedHash: 'deadbeef', clientSeed: CLIENT, nonce: 12 })).commitment, 'mismatch');
  assert.strictEqual((await recompute({ game: 'mines', serverSeed: SERVER, clientSeed: CLIENT, nonce: 12 })).commitment, 'none');

  const dice = await recompute({ game: 'dice', serverSeed: SERVER, clientSeed: CLIENT, nonce: '7' });
  assert.strictEqual(dice.result, diceFrom(referenceFloats(SERVER, CLIENT, 7, 1)[0]));
  const limbo = await recompute({ game: 'limbo', serverSeed: SERVER, clientSeed: CLIENT, nonce: 0 });
  assert.strictEqual(limbo.result, limboFrom(referenceFloats(SERVER, CLIENT, 0, 1)[0]));
  const plinko = await recompute({ game: 'plinko', serverSeed: SERVER, clientSeed: CLIENT, nonce: 3, rows: 8 });
  assert.strictEqual(plinko.path.length, 8);
  assert.ok(plinko.bucket >= 0 && plinko.bucket <= 8);

  await assert.rejects(recompute({ game: 'dice', serverSeed: '', clientSeed: CLIENT, nonce: 1 }), FairError);
  await assert.rejects(recompute({ game: 'dice', serverSeed: SERVER, clientSeed: CLIENT, nonce: -1 }), FairError);
  await assert.rejects(recompute({ game: 'mines', serverSeed: SERVER, clientSeed: CLIENT, nonce: 1, mines: 25 }), FairError);
  await assert.rejects(recompute({ game: 'plinko', serverSeed: SERVER, clientSeed: CLIENT, nonce: 1, rows: 4 }), FairError);
  await assert.rejects(recompute({ game: 'keno', serverSeed: SERVER, clientSeed: CLIENT, nonce: 1 }), FairError);
});

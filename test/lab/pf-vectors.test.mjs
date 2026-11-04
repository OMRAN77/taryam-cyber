// Golden vectors of the provably-fair adapters, restated here from their sources
// (not read back from the adapters), the self-test that disables a failing adapter,
// and differential tests of the float / integer mappings against BigInt references.
import test from 'node:test';
import assert from 'node:assert';
import crypto from 'node:crypto';
import { ADAPTERS, adapterKey, getAdapter, selfTest, disabledAdapters, runVectors, listAdapters, EVIDENCE_LEVELS } from '../../lab/core/pf/registry.js';
import { stake, stakeCrash, stakeSlide } from '../../lab/core/pf/stake.js';
import { bustabit, bustabitEra, BUSTABIT } from '../../lab/core/pf/bustabit.js';
import { bcgameCrash, bcgameDice, bcgameDiceLegacy, bcCrashFromHex, bcWindow } from '../../lab/core/pf/bcgame.js';
import { primedice } from '../../lab/core/pf/primedice.js';
import { duel, DUEL_DICE_LIMIT } from '../../lab/core/pf/duel.js';
import { duelbits } from '../../lab/core/pf/duelbits.js';
import { aviatorCrash } from '../../lab/core/pf/aviator-unofficial.js';
import { roobetCrash } from '../../lab/core/pf/roobet-unofficial.js';
import { computeOutcome, auditRounds } from '../../lab/core/pf/audit.js';
import { floatAt, limboCalc24, limboDocs, floorMapCount, bust52, bust52Survival, normalizeHash, normalizeSeed, parseNonce, cursorFloats } from '../../lab/core/pf/common.js';
import { hmacSha256Key, bytesToHex } from '../../lab/core/sha256-sync.js';

const seeded = (a, game, server, client, nonce, params = {}, opts = {}) =>
  computeOutcome(a, a.games[game], { hmac: a.hmacKey(server), server, client, nonceText: String(nonce) }, params, '', opts);

// ---------- metadata and self-test ----------

test('every adapter declares id, version, source, capture date and an evidence level, and has vectors', () => {
  const keys = new Set();
  for (const a of ADAPTERS) {
    assert.ok(a.id && a.version && a.sourceUrl.startsWith('https://') && /^\d{4}-\d{2}-\d{2}$/.test(a.captureDate), adapterKey(a));
    assert.ok(EVIDENCE_LEVELS.includes(a.evidence), adapterKey(a));
    assert.ok(Array.isArray(a.notes) && a.notes.length === 2, adapterKey(a) + ' notes [ar, en]');
    assert.ok(a.vectors.length > 0, adapterKey(a) + ' has golden vectors');
    assert.ok(!keys.has(adapterKey(a)));
    keys.add(adapterKey(a));
  }
  // What the research could and could not confirm (research/provably-fair.md, fact-check).
  assert.strictEqual(getAdapter('aviator').evidence, 'unconfirmed');
  assert.strictEqual(getAdapter('roobet').evidence, 'unconfirmed');
  assert.strictEqual(getAdapter('duel').evidence, 'verified');
  assert.strictEqual(getAdapter('stake').evidence, 'reference');
  assert.strictEqual(getAdapter('bcgame-dice@legacy-2022').version, 'legacy-2022');
  // metadata for the page is plain data (structured-clone safe)
  assert.doesNotThrow(() => structuredClone(listAdapters(selfTest())));
});

test('self-test: all golden vectors pass; a failing vector disables its adapter with a clear message', () => {
  const st = selfTest();
  for (const [k, v] of Object.entries(st)) assert.ok(v.ok, `${k}: ${JSON.stringify(v.failures)}`);
  assert.deepStrictEqual(disabledAdapters(st), {});
  // A copy of the Primedice adapter whose vector expects 79.70 instead of 79.69.
  const broken = { ...primedice, vectors: primedice.vectors.map((v) => (v.expect === '79.69' ? { ...v, expect: '79.70' } : v)) };
  const st2 = selfTest([broken]);
  const k = adapterKey(broken);
  assert.strictEqual(st2[k].ok, false);
  assert.deepStrictEqual(disabledAdapters(st2), { [k]: ['roll 79.69 (window aa671 = 697969)'] });
  assert.throws(() => auditRounds([{ line: 2, f: { nonce: '0' } }], broken, { disabled: disabledAdapters(st2) }),
    (e) => e.ar.includes('معطّل') && e.en.includes('disabled') && e.en.includes('79.69'));
  assert.strictEqual(runVectors(broken).filter((r) => !r.ok).length, 1);
});

// ---------- Stake ----------

test('Stake per-bet vectors (stake.us calculator 2026-08-05 via GuidoHam/fairplay-verifier tests/run-tests.js)', () => {
  const S = 'e8df2cc3b9ccb583ce5ea92336842387', C = '83e27f682128eb1852b048203dfd6931';
  // bytes b7 08 ca 58 of HMAC-SHA256(S, "C:1:0"); node:crypto gives the same.
  assert.strictEqual(crypto.createHmac('sha256', S).update(`${C}:1:0`).digest('hex').slice(0, 8), 'b708ca58');
  assert.strictEqual(bytesToHex(hmacSha256Key(S)(`${C}:1:0`)).slice(0, 8), 'b708ca58');
  assert.strictEqual(seeded(stake, 'dice', S, C, 1).display, '71.50');
  const limbo = seeded(stake, 'limbo', S, C, 1);
  assert.strictEqual(limbo.raw, 1.384658144300882);
  assert.strictEqual(limbo.display, '1.38');
  // The documented formula gives 1.3846582200538022 for the same float (fact-check of the research).
  assert.strictEqual(seeded(stake, 'limbo', S, C, 1, {}, { limboFormula: 'docs' }).raw, 1.3846582200538022);
  assert.deepStrictEqual(seeded(stake, 'mines', S, C, 1, { mines: 17 }).values, [17, 21, 7, 24, 13, 23, 11, 14, 6, 9, 15, 2, 20, 1, 10, 4, 8]);
  assert.deepStrictEqual(seeded(stake, 'keno', S, C, 1).values, [29, 36, 12, 40, 23, 38, 21, 24, 14, 17]);
  const p = seeded(stake, 'plinko', S, C, 1, { rows: 8 });
  assert.deepStrictEqual([p.path, p.slot], ['RRLRRRRR', 7]);
  // Leading space on BOTH seeds, nonce 1942124 (the fact-check's correction).
  assert.strictEqual(seeded(stake, 'limbo', ' ' + S, ' ' + C, 1942124).raw, 1.5831247773805166);
});

test('Stake vectors from KyranRana/stake-provably-fair-api src/test (stake.com calculation links)', () => {
  const G = [['18e93f4a7b5b58d2569765766d1b6c3296bbd8430d6f20249044d72f14720159', 'bb62964774', 1], ['a9a09f7f84c9dc6d4f46f9b702d8e7e211e1fc219ac10e1145c4ca032eb000c6', '3c83fc7e07', 3], ['a5022ccf5dd5a76d2014278e3d91d1dfc47c3f12e683ea0c8151fdc2f944beb1', '8b3ca8298c', 54]];
  assert.deepStrictEqual(G.map((g) => seeded(stake, 'dice', ...g).display), ['77.18', '19.59', '56.37']); // Dice.test.ts
  assert.deepStrictEqual(G.map((g) => seeded(stake, 'roulette', ...g).value), [28, 7, 20]); // Roulette.test.ts
  assert.deepStrictEqual(G.map((g) => seeded(stake, 'limbo', ...g, {}, { limboFormula: 'docs' }).display), ['1.28', '5.05', '1.75']); // Limbo.test.ts
  assert.deepStrictEqual(G.map((g) => seeded(stake, 'keno', ...g).values), [[31, 36, 12, 32, 2, 8, 20, 10, 25, 17], [8, 19, 28, 29, 18, 30, 11, 13, 3, 2], [23, 33, 1, 36, 9, 20, 19, 28, 8, 38]]); // Keno.test.ts
  // Cards.test.ts case 1: Q♦ K♠ 6♦ Q♥ 2♥ 4♠ 8♥ 5♦ 9♣ 7♥ (infinite deck, crosses into round 1).
  assert.strictEqual(seeded(stake, 'cards', ...G[0], { count: 10 }).display, 'Q♦ K♠ 6♦ Q♥ 2♥ 4♠ 8♥ 5♦ 9♣ 7♥');
});

test('Stake crash and slide (KyranRana Crash.test.ts / Slide.test.ts) and the exact survival P(>= 2)', () => {
  const salt = '0000000000000000001b34dc6a1e86083f95500b096231436e9b25cbdd0075c4';
  const hashes = ['b4e7b335045da0a2666145980d03ed440a2e150e5369c72c7e6e24aeeb95f791', '3e473405bd819ed4171854194bae75a2b117739fc1ab2e1c4cd263e1904dae6f', 'ca9b74c095c615cdf961892e54b35d42b6b8d3612266ff158547020fab514cf7'];
  const era = stakeCrash.eraFor(null);
  assert.deepStrictEqual(hashes.map((h) => stakeCrash.result(h, era, { salt }).raw), [2.5682504010713783, 1.3193661251992947, 3.018368989236868]);
  assert.strictEqual(stakeCrash.result(hashes[0], era).hmac, '62ae955a1b219e9d4b990fe3d4231ac83c950083e72083e6a52b96a0301cef11');
  assert.deepStrictEqual(hashes.map((h) => stakeSlide.result(h, era).raw), [2.542308477828233, 1.3060391946417262, 2.9878804135880106]);
  // P(crash >= 2) = floor(0.99 x 2^32 / 2) / 2^32 = 2126008811 / 2^32 = 0.49499999988... (research, fact-checked).
  assert.strictEqual(stakeCrash.survival(200), 2126008811 / 2 ** 32);
  assert.ok(Math.abs(stakeCrash.survival(200) - 0.49499999988) < 1e-11);
});

// ---------- bustabit ----------

test('bustabit: real games of the current and previous chains, and the era boundaries', () => {
  // Busts reported by a player (deduzzo/bustabit-scripts tests/verification/test-forward-chain.js).
  const cur = [[12306896, '94aa062026624e59a0ace092568d5f46e21b9bf1d5173609db8645dd62bdfc44', 10.91], [12306895, '94e66d98029c61ecd27c4fb6b381d401c823cf3dfbdac9246756d5b655e125aa', 4.26], [12306894, '8d3b9726ca7bc5e3637bf2079e09eaf2a9d67df4e6f50ff23a7b593bd802cca6', 1.83]];
  for (const [g, h, bust] of cur) assert.strictEqual(bustabit.result(h, bustabitEra(g)).raw, bust, 'game ' + g);
  // Previous chain (Jay-ArBrouillard/jay-bit-hash test_functions.py); game numbers from
  // walking each hash to the previous terminating hash with node:crypto (8,138,7xx links).
  const prev = [[8138709, '332901b7b469b69d544597767849b36767fe86925b5d01de04e70c468b60b903', 1], [8138711, '3add5306be1ad9679f8aa572cc08a79987de14249f3f582c59d0b4eaff4a390c', 1.69], [8138712, '533473d9e1e0ddc9cabe769c4eff4bf05959a346a770ee7fc580c8eff0300d09', 36.18], [8138716, 'dd6f372d0a177b83284e3d094676deea6062008ba142aee433e6342ee21de8f4', 48.93]];
  for (const [g, h, bust] of prev) assert.strictEqual(bustabit.result(h, bustabitEra(g)).raw, bust, 'game ' + g);
  // Boundaries (bustabit/verifier src/constants.ts): PREV_CHAIN_LENGTH 10,000,000, VX_LAST_GAME 12,279,450.
  // Game 10,000,000 is the last game of the previous chain (the official verifier skips it).
  assert.deepStrictEqual([1, 10000000, 10000001, 12279450, 12279451].map((g) => bustabitEra(g).id), ['prev', 'prev', 'vx', 'vx', 'current']);
  assert.strictEqual(bustabitEra(10000000).link, 'hex');
  assert.strictEqual(bustabitEra(10000001).link, 'raw');
  assert.strictEqual(bustabit.result('d80862011cc416cf985c365c5dd996bbcacd3d89a67be1ddf371af1084bb52cd', bustabitEra(12279450)).edge, 'era-unsupported');
  // Game 12,279,451 (first after Vx): hash published by sabari245/bustabit-monitor; its
  // SHA-256 of the raw bytes is game 12,279,450's hash, which node:crypto confirms.
  assert.strictEqual(crypto.createHash('sha256').update(Buffer.from('86c808ac480d261de1d6481520cdd0064327a25c0da4f8109dd8ea7cce0662e6', 'hex')).digest('hex'), 'd80862011cc416cf985c365c5dd996bbcacd3d89a67be1ddf371af1084bb52cd');
  // Game 10,000,001's hash (from a node:crypto walk) hashes to the current terminating hash.
  assert.strictEqual(crypto.createHash('sha256').update(Buffer.from('0983b27539508f34d90bf11d084e118d65bbc32798e059e53d2a95464b8bb7d6', 'hex')).digest('hex'), BUSTABIT.TERMINATING);
  // P(1.00x) = 2/101 within 2^-52 and P(bust >= m) = 0.99 / m (research).
  assert.ok(Math.abs(1 - bust52Survival(101) - 2 / 101) < 1e-12);
  assert.ok(Math.abs(bust52Survival(200) - 0.495) < 1e-12);
});

// ---------- BC.Game ----------

test('BC.Game crash: published results (GuyPaddock dataset) and the Infinity edge', () => {
  // Hashes: game 5,098,240's hash (algopert/BC-Game-Crash-bot) walked down with node:crypto;
  // results: GuyPaddock/BcGameCrashAnalyzer CSV (Apache-2.0), games 4,905,002 and 4,905,003.
  const era = bcgameCrash.eraFor(4905002);
  assert.strictEqual(bcgameCrash.result('3373da5bf3c68f66dd6d81919e6a7890475582103d74c46f4677cc48606ca225', era).raw, 1.05);
  assert.strictEqual(bcgameCrash.result('4546d022dbbd8026e03d82d3e4a5e39987e214ec1196416b6289eee38f3c4218', era).raw, 1.81);
  // toPrecision(9) rounds X up to 1 from r = ceil(9999999995 * 2^52 / 10^10): BigInt below.
  const rMin = ((9999999995n << 52n) + 10n ** 10n - 1n) / 10n ** 10n;
  assert.strictEqual(rMin.toString(16), 'fffffffdda3e9');
  assert.strictEqual(bcCrashFromHex(rMin.toString(16)).raw, Infinity);
  assert.ok(Number.isFinite(bcCrashFromHex((rMin - 1n).toString(16)).raw));
  // Without the extra rounding (bustabit) the same value is finite: 99 / (1 - X) with X < 1.
  assert.ok(Number.isFinite(bust52(rMin.toString(16)).raw));
  // In an audit the Infinity game is "not checked (edge case)", never a mismatch.
  const r = auditRounds([{ line: 2, f: { gameId: '100', gameHash: 'fffffffdda3e9' + '0'.repeat(51), result: '1000000.00' } }], bcgameCrash, {});
  assert.deepStrictEqual([r.counts.mismatch, r.counts.notCheckedBy['edge-case']], [0, 1]);
  assert.notStrictEqual(r.verdict.code, 'FAIL');
});

test('BC.Game dice: current 53-bit window (ProvablyHero disclosed rounds) and the legacy mapping', () => {
  const s1 = '2dbc38e175dcf0fed504db05da12adffc1df6684e6394b1d18070c1f25728fe8', c1 = '8a83fd8e6b586a23e84aa99b4a88bedf';
  assert.strictEqual(seeded(bcgameDice, 'classic-dice', s1, c1, 15).display, '76.28');
  assert.strictEqual(seeded(bcgameDiceLegacy, 'classic-dice', s1, c1, 15).display, '42.21');
  const s3 = '58cc768fe782afd394911862a3579dc7f2eb3a13802f16ce0f762948f0115ff7', c3 = 'e58d4457f15c1851581b349de5b60821';
  assert.deepStrictEqual([2, 3, 4, 6, 7, 9].map((n) => seeded(bcgameDice, 'dice', s3, c3, n).ticks), [9362, 1197, 9907, 925, 3754, 1349]);
  // Window against an independent BigInt oracle (offset = h[0..15] mod 47, w = h[i..i+14] >> 3).
  for (let n = 0; n < 300; n++) {
    const h = crypto.createHmac('sha256', 'synthetic-' + n).update(`client:${n}`).digest('hex');
    const i = Number(BigInt('0x' + h.slice(0, 15)) % 47n);
    const w = BigInt('0x' + h.slice(i, i + 14)) >> 3n;
    assert.deepStrictEqual(bcWindow(h), { offset: i, w });
    assert.strictEqual(seeded(bcgameDice, 'classic-dice', 'synthetic-' + n, 'client', n).ticks, Number((w * 10001n) >> 53n));
  }
});

// ---------- Primedice, Duel, Duelbits ----------

test('Primedice: README vector 79.69 (window aa671 = 697969), rejection windows', () => {
  const seed = '293d5d2ddd365f54759283a8097ab2640cbe6f8864adc2b1b31e65c14c999f04';
  assert.strictEqual(primedice.commit(seed), '5ac59780d512265230d5efb3cc238886dc1b457a80b54fbf1f920b99c6505801');
  assert.strictEqual(seeded(primedice, 'dice', seed, 'ClientSeedForDiceSites.com', 0).display, '79.69');
  // Independent: node:crypto HMAC-SHA512 + the rule in Python-like steps.
  for (let n = 0; n < 200; n++) {
    const h = crypto.createHmac('sha512', 's' + n).update(`c-${n}`).digest('hex');
    let i = 0, v = parseInt(h.slice(0, 5), 16);
    while (v >= 1e6) { i += 5; v = parseInt(h.slice(i, i + 5), 16); }
    assert.strictEqual(seeded(primedice, 'dice', 's' + n, 'c', n).ticks, v % 10000);
  }
});

test('Duel: dice (13 disclosed rounds) and keno (ProvablyFair.org data), hex-decoded key and commitment', () => {
  const DS = '4acfd9fe9d29ebf77b65fe1f7f956c8eef37f5e09f30f35252d3a7f9e7d62a3c';
  // commitment = SHA-256 of the 32 decoded bytes, not of the text (102/102 vs 0/102 in the audit)
  assert.strictEqual(crypto.createHash('sha256').update(Buffer.from(DS, 'hex')).digest('hex'), '93e233d8841c7f7ba714d5fb96fc071b6489398c84076b7361c77d82905d556e');
  assert.strictEqual(duel.commit(DS), '93e233d8841c7f7ba714d5fb96fc071b6489398c84076b7361c77d82905d556e');
  assert.notStrictEqual(crypto.createHash('sha256').update(DS).digest('hex'), duel.commit(DS));
  // ProvablyHero test-vectors/duel-dice-v1.json, nonces 0..12.
  assert.deepStrictEqual(Array.from({ length: 13 }, (_, n) => seeded(duel, 'dice', DS, 'iCzc2OiTfyQkloS6', n).ticks), [3950, 7443, 7861, 638, 6255, 5251, 9107, 2307, 606, 1487, 3997, 1490, 6529]);
  // 0xffffffff - (0xffffffff mod 10001) = 4294967295 - 7842 = 4294959453 = 10001 x 429453.
  assert.strictEqual(DUEL_DICE_LIMIT, 4294959453);
  assert.strictEqual(DUEL_DICE_LIMIT % 10001, 0);
  // Keno: sets served in the bet records (data/keno-master-5100bets.json).
  const k = seeded(duel, 'keno', '94eee14e882d43325f7948ef9569552f4506feeeb70a2ca35023916b4f9f0fe9', 'dAn1wtkuDAXxQOKP', 0).values;
  assert.deepStrictEqual(k.slice().sort((a, b) => a - b), [25, 8, 7, 27, 32, 29, 11, 9, 22, 1].sort((a, b) => a - b));
});

test('Duelbits: SHA-256("server:client:nonce") mod 10000, against node:crypto', () => {
  const seed = '04093dcb0d2790612ecd6d9837e2e3c6144f30f16bf560357ecc14ac0f0236e3';
  for (const nonce of [0, 1, 7, 123456]) {
    const w = crypto.createHash('sha256').update(`${seed}:my client seed:${nonce}`).digest().readUInt32BE(0);
    assert.strictEqual(seeded(duelbits, 'dice', seed, 'my client seed', nonce).ticks, w % 10000);
    assert.strictEqual(seeded(duelbits, 'plinko-ticket', seed, 'my client seed', nonce).value, w % 65535);
  }
});

// ---------- unconfirmed reconstructions ----------

test('Aviator and Roobet (unconfirmed): independent Python derivations of the published formulas', () => {
  // Python: hashlib.sha512((s + "c1-0" + "c2-0" + "c3-0").encode()), n = int(h[:13], 16) / 2**52, (97 / (1 - n)) / 100.
  assert.strictEqual(aviatorCrash('cd3fabdfb42d4cd05ebbad6d62dc2e99031ab51004855a555e25ad503b7d76c2', ['c1-0', 'c2-0', 'c3-0']).raw, 3.1566090281557964);
  const low = aviatorCrash('4a2167ce082a19ec45a4e3f7cb0e4bf9480f6ec3c47d2935f3894c48bc6654bc', ['a', 'b', 'c']);
  assert.deepStrictEqual([low.raw, low.display, low.edge], [0.9753445769757105, '0.97', 'below-one']);
  // Python: hmac.new(hash.encode(), salt.encode(), sha256); instant when int(hmac, 16) % 20 == 0.
  assert.strictEqual(roobetCrash('5b783d7c0b80ea1f7e629943180ad11dded91fe99683aacec564fe5b6614a1f7').raw, 2.83);
  assert.strictEqual(roobetCrash('080aacad2572d0692742dd561c10e23f3314e14c9c6d5402bdfcb6a5ea2ac027').instant, true);
});

// ---------- differential tests against BigInt references ----------

test('4-byte float = u32 / 2^32 exactly, and floor(f N) = floor(u N / 2^32) for every mapping (BigInt)', () => {
  const Ns = [2, 25, 37, 40, 52, 10000, 10001, 16777216];
  const edges = [0, 1, 2 ** 31 - 1, 2 ** 31, 2 ** 32 - 2, 2 ** 32 - 1];
  for (const N of Ns) for (let j = 1; j < Math.min(N, 50); j++) {
    const b = Number(((BigInt(j) << 32n) + BigInt(N) - 1n) / BigInt(N)); // first u mapping to j
    edges.push(b, b - 1);
  }
  const buf = new Uint8Array(4);
  const check = (u) => {
    buf[0] = u >>> 24; buf[1] = (u >>> 16) & 255; buf[2] = (u >>> 8) & 255; buf[3] = u & 255;
    const f = floatAt(buf, 0);
    assert.strictEqual(BigInt(f * 4294967296), BigInt(u)); // exact: f * 2^32 recovers u
    for (const N of Ns) assert.strictEqual(Math.floor(f * N), Number((BigInt(u) * BigInt(N)) >> 32n), `u=${u} N=${N}`);
  };
  edges.forEach(check);
  const rnd = crypto.randomBytes(4 * 50000);
  for (let i = 0; i < 50000; i++) check(rnd.readUInt32BE(4 * i));
  // Stake's float from the stream equals u32 / 2^32 of the HMAC bytes (node:crypto).
  const fl = cursorFloats(hmacSha256Key('s'), 'c', '5', 9);
  const b0 = crypto.createHmac('sha256', 's').update('c:5:0').digest(), b1 = crypto.createHmac('sha256', 's').update('c:5:1').digest();
  assert.deepStrictEqual(fl, [...Array.from({ length: 8 }, (_, i) => b0.readUInt32BE(4 * i) / 2 ** 32), b1.readUInt32BE(0) / 2 ** 32]);
});

test('preimage counts of floor(u N / 2^k): closed form vs brute force, and they sum to 2^k', () => {
  for (const N of [3, 7, 37, 52, 100, 1000]) {
    const bits = 12, T = 1 << bits;
    const counts = new Array(N).fill(0);
    for (let u = 0; u < T; u++) counts[Math.floor((u * N) / T)]++;
    for (let j = 0; j < N; j++) assert.strictEqual(Number(floorMapCount(j, j + 1, N, bits)), counts[j], `N=${N} j=${j}`);
  }
  // Stake Dice: 429,453 or 429,454 preimages per outcome (research: ideal 429,453.78).
  let total = 0n;
  for (let j = 0; j < 10001; j++) { const c = floorMapCount(j, j + 1, 10001); assert.ok(c === 429453n || c === 429454n); total += c; }
  assert.strictEqual(total, 1n << 32n);
});

test('Limbo, all 2^24 calculator buckets: 44 land one cent low in doubles, 16 reach 1,000,000x (RTP 95.367%)', () => {
  // Exact cents floor(99 x 2^24 / (k + 1)) with BigInt vs the double formula; the counts 44
  // and 16 are the research's own exhaustive enumeration (and GuidoHam's limbo-exhaustive.js).
  const A = 99n << 24n;
  let low = 0, top = 0, k0 = -1;
  for (let k = 0; k < 16777216; k++) {
    const L = limboCalc24(k / 16777216);
    if (k < 4096 || (k & 1023) === 0 || L.centBoundary) {
      const exact = Number(A / BigInt(k + 1));
      assert.ok(L.cents === exact || L.cents === exact - 1, 'k=' + k);
      assert.strictEqual(L.centBoundary, L.cents !== exact);
    }
    if (L.centBoundary) { low++; if (k0 < 0) k0 = k; }
    if (L.cents >= 100000000) top++;
  }
  assert.strictEqual(low, 44);
  assert.strictEqual(top, 16);
  assert.strictEqual((top / 2 ** 24) * 1e6, 0.95367431640625);
  // The first such bucket: raw 5536481.279999999 shown as 5536481.27 instead of .28.
  assert.strictEqual(k0, 2);
  // An audit accepts either the double result or the exact cent at those buckets.
  const L = limboCalc24(2 / 16777216);
  assert.deepStrictEqual([L.cents, L.alt], [553648127, [553648128]]);
  // The documented formula's exact cents are floor(99 x 2^32 / u) (BigInt).
  for (const u of [1, 3, 12345, 2 ** 31 + 7, 2 ** 32 - 1]) {
    const D = limboDocs(u / 2 ** 32);
    assert.ok([D.cents, ...D.alt].includes(Number((99n << 32n) / BigInt(u))), 'u=' + u);
  }
});

test('52-bit crash formula in doubles vs the exact rational floor(99 x 2^52 / (2^52 - r))', () => {
  const T = 1n << 52n;
  const rnd = crypto.randomBytes(7 * 20000);
  let diff = 0;
  for (let i = 0; i < 20000; i++) {
    const r = BigInt('0x' + rnd.subarray(7 * i, 7 * i + 7).toString('hex').slice(0, 13));
    const exact = (99n * T) / (T - r);
    const got = bust52(r.toString(16).padStart(13, '0')).cents;
    const want = exact < 100n ? 100 : Number(exact);
    if (got !== want) diff++;
  }
  // The operators compute in doubles too; a difference needs the exact quotient within
  // ~1e-13 of an integer, which random draws essentially never hit.
  assert.strictEqual(diff, 0);
});

test('input hygiene: hashes with 0x, case, spaces and zero-width characters; malformed is not a mismatch', () => {
  const H = crypto.createHash('sha256').update('x').digest('hex');
  for (const h of ['0x' + H, ' 0X' + H.toUpperCase() + '\n', H.replace(/(.{8})/g, '$1 '), '​' + H]) assert.deepStrictEqual([normalizeHash(h).status, normalizeHash(h).value], ['ok', H]);
  for (const h of [H.slice(0, 63), H + 'a', 'g'.repeat(64), 'not a hash']) assert.strictEqual(normalizeHash(h).status, 'malformed');
  assert.deepStrictEqual(normalizeSeed(' ​abc﻿ '), { value: 'abc', changed: true, empty: false, inner: false });
  assert.strictEqual(normalizeSeed(' abc', { exact: true }).value, ' abc');
  // Nonces: Arabic-Indic digits are read; values above 2^53 keep every digit (BigInt).
  assert.deepStrictEqual([parseNonce('١٢').text, parseNonce('9007199254740993').text, parseNonce('007').text], ['12', '9007199254740993', '7']);
  assert.ok(parseNonce('1.0').error && parseNonce('-1').error && parseNonce('').error);
  const n = '9007199254740993';
  const f = cursorFloats(hmacSha256Key('s'), 'c', parseNonce(n).text, 1)[0];
  assert.strictEqual(f, crypto.createHmac('sha256', 's').update(`c:${n}:0`).digest().readUInt32BE(0) / 2 ** 32);
});

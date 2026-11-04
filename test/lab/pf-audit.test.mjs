// Batch audit of provably-fair rounds: fixtures are built with node:crypto and BigInt
// (an implementation independent of the lab's adapters) or taken from published data,
// and the negative fixtures (gap in nonces, reused seed, tampered result, bad
// commitment, wrong payout, broken chain) must be flagged.
import test from 'node:test';
import assert from 'node:assert';
import crypto from 'node:crypto';
import { auditCsv, auditRounds, parsePfCsv } from '../../lab/core/pf/audit.js';
import { makeSample } from '../../lab/core/pf/sample.js';
import { adapterKey, ADAPTERS } from '../../lab/core/pf/registry.js';

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const csv = (cols, rows) => [cols.join(','), ...rows.map((r) => cols.map((c) => r[c] ?? '').join(','))].join('\n') + '\n';
// Deterministic random bytes: SHA-256(label:counter). (A chain state -> SHA-256(state)
// would make each sample seed the SHA-256 of the previous one, which the audit
// rightly reports as SEED_DERIVABLE.)
function byteSource(label) {
  let i = 0;
  return (n) => {
    const out = Buffer.alloc(n);
    for (let o = 0; o < n; o += 32) crypto.createHash('sha256').update(`${label}:${i++}`).digest().copy(out, o, 0, Math.min(32, n - o));
    return new Uint8Array(out);
  };
}

// Stake-style dice computed independently: u = first 4 bytes of HMAC-SHA256(seed text,
// "client:nonce:0"), ticks = floor(u x 10001 / 2^32) in BigInt, roll = ticks / 100.
function stakeDice(seed, client, nonce) {
  const u = BigInt(crypto.createHmac('sha256', seed).update(`${client}:${nonce}:0`).digest().readUInt32BE(0));
  return Number((u * 10001n) >> 32n);
}
const COLS = ['time', 'bet_id', 'game', 'server_seed', 'server_seed_hash', 'next_server_seed_hash', 'client_seed', 'nonce', 'target', 'condition', 'bet', 'payout', 'result'];
// Three epochs of 40 dice bets, over 50.50 with RTP 0.99 (multiplier 0.99 x 100 / 49.5 = 2).
function stakeFixture() {
  const seeds = ['alpha', 'bravo', 'charlie', 'delta'].map((w) => sha('server-seed-' + w));
  const rows = [];
  let t = Date.UTC(2026, 0, 1), id = 1;
  for (let e = 0; e < 3; e++) {
    for (let n = 0; n < 40; n++) {
      const ticks = stakeDice(seeds[e], 'player-' + e, n);
      rows.push({ time: new Date(t += 5000).toISOString(), bet_id: id++, game: 'dice', server_seed: seeds[e], server_seed_hash: sha(seeds[e]), next_server_seed_hash: sha(seeds[e + 1]), client_seed: 'player-' + e, nonce: n, target: '50.50', condition: 'over', bet: 1, payout: ticks > 5050 ? 2 : 0, result: (ticks / 100).toFixed(2) });
    }
  }
  return { seeds, rows, t, id };
}
const run = (rows, opts = {}) => auditCsv(csv(COLS, rows), 'stake', { paytable: { dice: { rtp: 0.99 } }, ...opts });

test('a clean Stake history passes: 120 results, 3 commitments, forward chain, payouts', () => {
  const { rows } = stakeFixture();
  const r = run(rows);
  assert.strictEqual(r.verdict.code, 'PASS', JSON.stringify(r.issueCounts));
  assert.strictEqual(r.verdict.exit, 0);
  assert.deepStrictEqual([r.rows, r.counts.ok, r.counts.mismatch, r.counts.notChecked], [120, 120, 0, 0]);
  assert.deepStrictEqual(r.epochs.map((e) => [e.commitment, e.rows, e.nonceMin, e.nonceMax, e.gaps, e.forward]), [['ok', 40, '0', '39', 0, 'ok'], ['ok', 40, '0', '39', 0, 'ok'], ['ok', 40, '0', '39', 0, 'open']]);
  assert.deepStrictEqual([r.payout.checked, r.payout.ok], [120, 120]);
});

test('negative fixtures: tampered result, gap in nonces, reused seed, wrong payout are all flagged', () => {
  const f = stakeFixture();
  const rows = f.rows.map((x) => ({ ...x }));
  // tampered result on line 12 (row index 10): +0.01
  rows[10].result = (Number(rows[10].result) + 0.01).toFixed(2);
  // a gap: nonce 17 of the second epoch is missing
  const gapRow = rows.findIndex((x) => x.client_seed === 'player-1' && x.nonce === 17);
  rows.splice(gapRow, 1);
  // a wrong payout on the first winning bet of the third epoch (2 -> 2.5)
  const w = rows.findIndex((x) => x.client_seed === 'player-2' && x.payout === 2);
  rows[w].payout = 2.5;
  // the first seed comes back after the third was used (continuing nonces 40..42)
  for (let n = 40; n < 43; n++) {
    const ticks = stakeDice(f.seeds[0], 'player-0', n);
    rows.push({ ...rows[0], time: new Date(f.t += 5000).toISOString(), bet_id: f.id++, nonce: n, payout: ticks > 5050 ? 2 : 0, result: (ticks / 100).toFixed(2) });
  }
  const r = run(rows);
  assert.strictEqual(r.verdict.code, 'FAIL');
  assert.strictEqual(r.verdict.exit, 1);
  for (const c of ['RESULT_MISMATCH', 'NONCE_GAP', 'PAYOUT_MISMATCH', 'SEED_REUSED']) assert.ok(r.issueCounts[c] >= 1, c);
  const mm = r.issues.find((i) => i.code === 'RESULT_MISMATCH');
  assert.deepStrictEqual([mm.line, mm.claimed, mm.expected], [12, rows[10].result, f.rows[10].result]);
  assert.deepStrictEqual(r.issues.find((i) => i.code === 'NONCE_GAP').detail, { from: '17', to: '17' });
  assert.strictEqual(r.issues.find((i) => i.code === 'PAYOUT_MISMATCH').claimed, 2.5);
  assert.strictEqual(r.counts.mismatch, 1);
});

test('replayed nonces (same seed pair, same nonce, another bet) are flagged; an exact duplicate row is only a warning', () => {
  const f = stakeFixture();
  const replay = f.rows.concat([{ ...f.rows[3], bet_id: 9999, time: new Date(f.t + 1000).toISOString() }]);
  const r = run(replay);
  assert.strictEqual(r.issueCounts.NONCE_REUSED, 1);
  assert.deepStrictEqual(r.issues.find((i) => i.code === 'NONCE_REUSED').lines, [5, 122]);
  const dup = run(f.rows.concat([{ ...f.rows[3] }]));
  assert.deepStrictEqual([dup.issueCounts.DUPLICATE_ROW, dup.issueCounts.NONCE_REUSED, dup.verdict.code], [1, undefined, 'CONDITIONAL']);
});

test('commitments: a wrong hash fails; a malformed hash or an unrevealed seed is "not checked", never a mismatch', () => {
  const f = stakeFixture();
  const bad = f.rows.map((x) => (x.client_seed === 'player-1' ? { ...x, server_seed_hash: sha('something else') } : x));
  const r1 = run(bad);
  assert.strictEqual(r1.issueCounts.COMMITMENT_MISMATCH, 1);
  assert.strictEqual(r1.verdict.code, 'FAIL');
  // 63 hex digits: malformed. The outcomes are still recomputed from the seed.
  const mal = f.rows.map((x) => (x.client_seed === 'player-1' ? { ...x, server_seed_hash: x.server_seed_hash.slice(1) } : x));
  const r2 = run(mal);
  assert.ok(r2.issueCounts.HASH_MALFORMED >= 1);
  assert.strictEqual(r2.issueCounts.COMMITMENT_MISMATCH, undefined);
  assert.strictEqual(r2.counts.mismatch, 0);
  assert.strictEqual(r2.verdict.code, 'CONDITIONAL');
  // The active (third) seed is not revealed yet: its 40 rounds are not checked.
  const active = f.rows.map((x) => (x.client_seed === 'player-2' ? { ...x, server_seed: '' } : x));
  const r3 = run(active);
  assert.deepStrictEqual([r3.counts.ok, r3.counts.notChecked, r3.counts.notCheckedBy['seed-unrevealed'], r3.verdict.code], [80, 40, 40, 'CONDITIONAL']);
  // A forward commitment that was never used while a later epoch exists.
  const fw = f.rows.map((x) => (x.client_seed === 'player-0' ? { ...x, next_server_seed_hash: sha('an uncommitted seed') } : x));
  const r4 = run(fw);
  assert.ok(r4.issueCounts.FORWARD_BREAK >= 1 && r4.issueCounts.FORWARD_UNANNOUNCED >= 1);
  assert.strictEqual(r4.verdict.code, 'FAIL');
  // An export repeating one next hash on every row (today's) is not evidence of a break.
  const same = f.rows.map((x) => ({ ...x, next_server_seed_hash: sha('next at export time') }));
  const r5 = run(same);
  assert.deepStrictEqual([r5.issueCounts.FORWARD_BREAK, r5.issueCounts.FORWARD_COLUMN_CONSTANT, r5.verdict.code], [undefined, 1, 'PASS']);
});

test('seed hygiene: copied spaces are cleaned (and reported); the exact option keeps them', () => {
  const f = stakeFixture();
  const spaced = f.rows.map((x) => ({ ...x, server_seed: ' ' + x.server_seed + '​' }));
  const r = run(spaced);
  assert.strictEqual(r.counts.ok, 120);
  assert.ok(r.issueCounts.SEED_CLEANED >= 1);
  // GuidoHam's spaced vector: the seeds really begin with a space (both of them).
  const S = 'e8df2cc3b9ccb583ce5ea92336842387', C = '83e27f682128eb1852b048203dfd6931';
  const rows = [{ server_seed: '" ' + S + '"', client_seed: '" ' + C + '"', nonce: 1942124, game: 'limbo', result: '1.58' }];
  const text = csv(['game', 'server_seed', 'client_seed', 'nonce', 'result'], rows);
  assert.strictEqual(auditCsv(text, 'stake', { exactSeeds: true }).counts.ok, 1);
  assert.strictEqual(auditCsv(text, 'stake', {}).counts.mismatch, 1);
});

// ---------- Duel: pair seeds by hash, not by row position (real data) ----------

test('Duel keno: rotation records carry the OLD seed next to the NEW hash; pairing by hash verifies all 10 bets', () => {
  // ProvablyFair-org/duel-keno data/keno-master-5100bets.json: bets of the first two seed
  // epochs (nonces 0..4, served draws) and the two rotation records that reveal their seeds.
  const H1 = '111880213ddf0a3a7b93cf725aeec359113c3986a902fffa0e5a33987600b77a', H2 = '59342a844e0bea049d9229443540cb78ab74b2e6ec39e4b6b14ec026488c6d2a', H3 = '35e5eb9d016121eebc8f51e363902e2353209aca74c82ee22cde87e7ecb6cb80';
  const S1 = '94eee14e882d43325f7948ef9569552f4506feeeb70a2ca35023916b4f9f0fe9', S2 = '2f121894ee7df021cac8f51b16329e7798bdb2577667ebe9d8dee647a3ba02b1';
  const bets1 = ['25 8 7 27 32 29 11 9 22 1', '3 23 30 24 31 35 6 38 17 15', '32 22 35 11 33 27 1 18 10 4', '18 13 5 35 29 8 19 32 22 2', '29 16 35 5 37 26 1 20 8 36'];
  const bets2 = ['30 26 37 25 6 35 15 21 33 14', '22 33 12 31 23 18 1 24 40 13', '10 13 28 14 29 33 32 3 6 37', '6 1 22 14 12 8 3 30 39 17', '24 11 8 21 16 15 23 29 3 2'];
  const rows = [
    ...bets1.map((d, n) => ({ game: 'keno', server_seed_hash: H1, next_server_seed_hash: H2, client_seed: 'dAn1wtkuDAXxQOKP', nonce: n, result: `"${d}"` })),
    { server_seed: S1, server_seed_hash: H2, next_server_seed_hash: H3, client_seed: 'gxIsYguLtWrLkzXF' }, // rotation record
    ...bets2.map((d, n) => ({ game: 'keno', server_seed_hash: H2, next_server_seed_hash: H3, client_seed: 'gxIsYguLtWrLkzXF', nonce: n, result: `"${d}"` })),
    { server_seed: S2, server_seed_hash: H3, next_server_seed_hash: '5088aa2c4c46eed4080194d4439bc9810ae1a63cbd2a5390b15ac0e1e0f01f76', client_seed: 'oUbsEky2U6J87G2M' },
  ];
  const cols = ['game', 'server_seed', 'server_seed_hash', 'next_server_seed_hash', 'client_seed', 'nonce', 'result'];
  const r = auditCsv(csv(cols, rows), 'duel', {});
  assert.deepStrictEqual([r.rows, r.records, r.counts.ok, r.counts.mismatch], [10, 2, 10, 0]);
  assert.deepStrictEqual(r.epochs.map((e) => [e.hash.slice(0, 6), e.commitment, e.forward]), [['111880', 'ok', 'ok'], ['59342a', 'ok', 'ok'], ['35e5eb', 'unrevealed', 'open']]);
  assert.strictEqual(r.issueCounts.SEED_PAIRED_BY_HASH, 2);
  assert.strictEqual(r.verdict.code, 'PASS', JSON.stringify(r.issueCounts));
  // Hashing the seed text instead of its bytes would match nothing: the Stake adapter
  // (text commitment) reports the other encoding, not a mismatch.
  const asText = auditCsv(csv(cols, rows), 'bcgame-dice@legacy-2022', { game: 'classic-dice' });
  assert.ok(asText.issueCounts.COMMITMENT_ENCODING >= 1);
  assert.strictEqual(asText.issueCounts.COMMITMENT_MISMATCH, undefined);
  // Without the rotation record of the first epoch, its five bets are not checked.
  const r2 = auditCsv(csv(cols, rows.filter((x, i) => i !== 5)), 'duel', {});
  assert.deepStrictEqual([r2.counts.ok, r2.counts.notChecked, r2.verdict.code], [5, 5, 'CONDITIONAL']);
  // A tampered draw (one number changed) is a mismatch on that line.
  const t = rows.map((x) => ({ ...x }));
  t[7].result = '"22 33 12 31 23 18 1 24 40 14"';
  const r3 = auditCsv(csv(cols, t), 'duel', {});
  assert.deepStrictEqual([r3.counts.mismatch, r3.issues.find((i) => i.code === 'RESULT_MISMATCH').line, r3.verdict.code], [1, 9, 'FAIL']);
  // A revealed seed that hashes to no commitment in the file fails.
  const u = rows.map((x) => ({ ...x }));
  u[11].server_seed = sha('not the seed');
  const r4 = auditCsv(csv(cols, u), 'duel', {});
  assert.ok(r4.issueCounts.COMMITMENT_MISMATCH >= 1);
  assert.strictEqual(r4.verdict.code, 'FAIL');
});

// ---------- hash chains ----------

const sha256Raw = (hex) => crypto.createHash('sha256').update(Buffer.from(hex, 'hex')).digest('hex');
const sha256Text = (hex) => crypto.createHash('sha256').update(hex).digest('hex');

test('bustabit chain: real games, links across the Vx era, the walk to the published terminating hash', () => {
  // Busts reported by a player (deduzzo/bustabit-scripts); 12,279,451 from bustabit-monitor;
  // 12,279,450 = SHA-256(raw 12,279,451); 10,000,001 from a node:crypto walk (see pf-vectors).
  const rows = [
    { gameId: '12306896', gameHash: '94aa062026624e59a0ace092568d5f46e21b9bf1d5173609db8645dd62bdfc44', result: '10.91' },
    { gameId: '12306895', gameHash: '94e66d98029c61ecd27c4fb6b381d401c823cf3dfbdac9246756d5b655e125aa', result: '4.26' },
    { gameId: '12306894', gameHash: '8d3b9726ca7bc5e3637bf2079e09eaf2a9d67df4e6f50ff23a7b593bd802cca6', result: '1.83x' },
    { gameId: '12279451', gameHash: '86c808ac480d261de1d6481520cdd0064327a25c0da4f8109dd8ea7cce0662e6', result: '' },
    { gameId: '12279450', gameHash: sha256Raw('86c808ac480d261de1d6481520cdd0064327a25c0da4f8109dd8ea7cce0662e6'), result: '3.00' },
    { gameId: '10000001', gameHash: '0983b27539508f34d90bf11d084e118d65bbc32798e059e53d2a95464b8bb7d6', result: '' },
  ].map((f, i) => ({ line: i + 2, f }));
  const r = auditRounds(rows, 'bustabit', { walkTerminating: true });
  assert.deepStrictEqual([r.counts.ok, r.counts.computed, r.counts.notCheckedBy['era-unsupported']], [3, 1, 2]);
  assert.strictEqual(r.chain.breaks, 0);
  assert.strictEqual(r.chain.linksChecked, 5);
  // the oldest listed game is 10,000,001: one link to the terminating hash
  assert.deepStrictEqual([r.chain.terminating.status, r.chain.terminating.links], ['ok', 1]);
  assert.strictEqual(r.verdict.code, 'CONDITIONAL');
  // From game 12,306,894 alone: 2,306,894 links (game id - 10,000,000).
  const r2 = auditRounds(rows.slice(0, 3), 'bustabit', { walkTerminating: true });
  assert.deepStrictEqual([r2.chain.terminating.status, r2.chain.terminating.links, r2.verdict.code], ['ok', 2306894, 'PASS']);
  // A forged hash for game 12,306,895 breaks both of its links; its own bust is recomputed.
  const forged = rows.slice(0, 3).map((x) => ({ ...x, f: { ...x.f } }));
  forged[1].f.gameHash = sha256Text('forged');
  const r3 = auditRounds(forged, 'bustabit', {});
  assert.deepStrictEqual([r3.chain.breaks, r3.verdict.code], [2, 'FAIL']);
});

test('bustabit previous chain: hex-text links, game 1,000 walks to the 2018 terminating hash', () => {
  // jay-bit-hash test_functions.py: this hash reaches the previous terminating hash within
  // 1,000 iterations; node:crypto counts exactly 1,000 hex-text links (game 1,000).
  const rows = [{ line: 2, f: { gameId: '1000', gameHash: '216f014579a1cff543b210d0b03967a107a81f6a6240bb39927b453cb9791fa6', result: '' } }];
  let h = rows[0].f.gameHash;
  for (let i = 0; i < 1000; i++) h = sha256Text(h);
  assert.strictEqual(h, '86728f5fc3bd99db94d3cdaf105d67788194e9701bf95d049ad0e1ee3d004277');
  const r = auditRounds(rows, 'bustabit', { walkTerminating: true });
  assert.deepStrictEqual([r.chain.terminating.status, r.chain.terminating.links], ['ok', 1000]);
  // games 8,138,716 .. 8,138,709 listed with gaps: links are bridged in hex text
  const prev = [['8138716', 'dd6f372d0a177b83284e3d094676deea6062008ba142aee433e6342ee21de8f4', '48.93'], ['8138712', '533473d9e1e0ddc9cabe769c4eff4bf05959a346a770ee7fc580c8eff0300d09', '36.18'], ['8138711', '3add5306be1ad9679f8aa572cc08a79987de14249f3f582c59d0b4eaff4a390c', '1.69'], ['8138709', '332901b7b469b69d544597767849b36767fe86925b5d01de04e70c468b60b903', '1.00']];
  const r2 = auditRounds(prev.map(([gameId, gameHash, result], i) => ({ line: i + 2, f: { gameId, gameHash, result } })), 'bustabit', {});
  assert.deepStrictEqual([r2.counts.ok, r2.chain.breaks, r2.chain.gapsBridged, r2.verdict.code], [4, 0, 2, 'PASS']);
});

test('BC.Game crash: 24 consecutive games from the published dataset; hashes walked with node:crypto', () => {
  // GuyPaddock/BcGameCrashAnalyzer CSV, games 4,905,002 .. 4,905,025 (Apache-2.0).
  const published = ['1.05', '1.81', '3.12', '102.69', '3.38', '1.9', '1.28', '2.26', '1.57', '1.02', '8.3', '32.92', '29.28', '1.84', '1.36', '2.58', '1.22', '1.25', '1.75', '1.62', '8.93', '1.63', '3.26', '3.58'];
  // game 5,098,240 (algopert/BC-Game-Crash-bot) walked down 193,215 hex-text links to 4,905,025
  let h = 'bdbdf909aadd399c54b9c4abff1f9ec52a1e0d27be4121294b593ebe8bc7e376';
  for (let g = 5098240; g > 4905025; g--) h = sha256Text(h);
  const rows = [];
  for (let g = 4905025; g >= 4905002; g--) { rows.push({ gameId: String(g), gameHash: h, result: published[g - 4905002] + 'x' }); h = sha256Text(h); }
  const text = csv(['gameId', 'gameHash', 'result'], rows).replace(/^gameId,gameHash/, 'game_id,hash');
  const r = auditCsv(text, 'bcgame-crash', {});
  assert.deepStrictEqual([r.counts.ok, r.counts.mismatch, r.chain.linksChecked, r.chain.breaks], [24, 0, 23, 0]);
  assert.strictEqual(r.verdict.code, 'PASS');
  // listed newest first without game ids: the order is found from the links
  const noIds = csv(['hash', 'result'], rows.map((x) => ({ hash: x.gameHash, result: x.result })));
  const r2 = auditCsv(noIds, 'bcgame-crash', {});
  assert.deepStrictEqual([r2.chain.order, r2.chain.breaks, r2.counts.ok], ['newest-first', 0, 24]);
});

// ---------- uniformity of the published outcomes ----------

test('uniformity is tested on the PUBLISHED outcomes: a skewed feed is flagged, clean samples rarely are', () => {
  // 600 published dice results all below 50 (seeds unknown): rejected at Holm level.
  const rows = Array.from({ length: 600 }, (_, i) => ({ line: i + 2, f: { nonce: String(i), commitment: sha('active'), client: 'p', result: ((i * 37) % 5000 / 100).toFixed(2) } }));
  const r = auditRounds(rows, 'stake', { game: 'dice' });
  assert.strictEqual(r.counts.notCheckedBy['seed-unrevealed'], 600);
  assert.strictEqual(r.uniformity[0].status, 'fail');
  // Nothing could be recomputed (no revealed seed), but the warning is reported.
  assert.ok(r.issueCounts.UNIFORMITY_REJECTED === 1 && r.verdict.code === 'NOTHING_CHECKED');
  // 40 clean samples of each Stake game (dice, limbo, keno, plinko, mines) from a fixed
  // byte stream: at alpha = 0.01 with Holm, expect about 0.4 false rejections in 40 runs.
  const rand = byteSource('calibration');
  let rejected = 0;
  for (let i = 0; i < 40; i++) {
    const s = makeSample('stake', { rounds: 900, rand });
    if (auditCsv(s.text, 'stake', s.options).issueCounts.UNIFORMITY_REJECTED) rejected++;
  }
  assert.ok(rejected <= 3, 'false rejections: ' + rejected);
});

test('every adapter: its clean local sample passes (or is conditional for unconfirmed formulas), its planted sample is caught', () => {
  const rand = byteSource('samples');
  for (const a of ADAPTERS) {
    const key = adapterKey(a);
    const clean = makeSample(key, { rounds: 240, rand });
    const r = auditCsv(clean.text, key, { ...clean.options, walkTerminating: false });
    assert.strictEqual(r.counts.mismatch, 0, key);
    assert.ok(a.evidence === 'unconfirmed' ? ['CONDITIONAL'].includes(r.verdict.code) : ['PASS', 'CONDITIONAL'].includes(r.verdict.code), `${key}: ${r.verdict.code} ${JSON.stringify(r.issueCounts)}`);
    if (a.evidence !== 'unconfirmed' && a.kind !== 'combined') assert.strictEqual(r.verdict.code, 'PASS', `${key}: ${JSON.stringify(r.issueCounts)}`);
    const planted = makeSample(key, { rounds: 240, plant: true, rand });
    const p = auditCsv(planted.text, key, { ...planted.options, walkTerminating: false });
    assert.ok(p.issueCounts.RESULT_MISMATCH >= 1, key);
    assert.ok(a.evidence === 'unconfirmed' ? ['FAIL', 'INCONCLUSIVE'].includes(p.verdict.code) : p.verdict.code === 'FAIL', `${key}: ${p.verdict.code}`);
  }
});

test('CSV columns are found by common export names', () => {
  const { columns } = parsePfCsv('Server Seed,Server Seed Hashed,Client Seed,Nonce,Roll,Next Server Seed Hash,Created At\n', 'seeded');
  assert.deepStrictEqual(columns.sort(), ['client', 'commitment', 'next', 'nonce', 'result', 'server', 'time']);
  assert.throws(() => auditCsv('a,b\n1,2\n', 'stake', {}), (e) => e.en.includes('nonce'));
});

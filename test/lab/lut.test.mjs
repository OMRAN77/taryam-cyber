// Outcome-table (LUT) auditor, Stake Engine format. Expected values come from hand
// calculation, from a second algorithm in this file (rows expanded into one outcome
// per unit of weight), or from an offline exact computation with Python's fractions
// module; never from lut.js itself.
import test from 'node:test';
import assert from 'node:assert';
import { analyzeLutFiles, parseLutCsv, parseLutIndex, lutFileKind, makeSampleLut, LutError, UINT64_MAX, BIG_WIN_THRESHOLDS, BUCKETS } from '../../lab/core/lut.js';
import { Fraction } from '../../lab/core/fraction.js';

const indexFile = (modes, name = 'index.json') => ({
  name, text: JSON.stringify({ modes: modes.map(([mode, cost, weights]) => ({ name: mode, cost, events: `books_${mode}.jsonl.zst`, weights })) }, null, 4),
});
const csvFile = (name, rows) => ({ name, text: rows.map((r) => r.join(',')).join('\n') + '\n' });
const run = (modes, tables) => analyzeLutFiles([indexFile(modes), ...Object.entries(tables).map(([n, rows]) => csvFile(n, rows))]);
const fr = (s) => { const [n, d] = String(s).split('/'); return new Fraction(BigInt(n), BigInt(d || '1')); };
const sameFraction = (got, want, label) => assert.ok(fr(got).equals(fr(want)), `${label}: ${got} != ${want}`);

// ---------------------------------------------------------------------------------
test('hand-made table: RTP 13/20 at cost 1 and 13/25 at cost 1.25, every figure by hand', () => {
  // weights 6, 2, 1, 1 on payouts 0x, 0.5x, 1.5x, 4x; W = 10.
  const rows = [[1, 6, 0], [2, 2, 50], [3, 1, 150], [4, 1, 400]];
  const r = run([['base', 1.0, 'lut.csv'], ['ante', 1.25, 'lut.csv']], { 'lut.csv': rows });
  const [base, ante] = r.modes;

  // sum(w*p) = 2*50 + 150 + 400 = 650; RTP = 650 / (100 * 1 * 10) = 13/20.
  assert.strictEqual(base.rtp.fraction, '13/20');
  assert.strictEqual(base.rtp.percent, '65.000000');
  // Wins > 0: 2 + 1 + 1 of 10 = 2/5; nothing won: 6/10.
  assert.strictEqual(base.hitRate.fraction, '2/5');
  assert.strictEqual(base.hitRate.oneIn, 2.5);
  assert.strictEqual(base.zeroWin.fraction, '3/5');
  // 0 < win < 1: the 0.5x rows = 2/10; that is half of the winning rounds.
  assert.strictEqual(base.ldw.fraction, '1/5');
  assert.strictEqual(base.ldwShareOfWins.fraction, '1/2');
  // Below the cost (win < 1): 0x and 0.5x = 8/10.
  assert.strictEqual(base.belowCost.fraction, '4/5');
  // E[X] = 0.65, E[X^2] = (2*0.25 + 2.25 + 16) / 10 = 1.875, Var = 1.875 - 0.4225 = 1.4525 = 581/400.
  assert.strictEqual(base.variance.fraction, '581/400');
  assert.strictEqual(base.sd, Math.sqrt(1.4525));
  // Top win 4x, weight 1 of 10: 1 in 10.
  assert.strictEqual(base.maxWin.multiplier.fraction, '4');
  assert.strictEqual(base.maxWin.probability.fraction, '1/10');
  assert.strictEqual(base.maxWin.oneIn, 10);
  // CVaR: cumulative 0.6, 0.8, 0.9, 1.0 -> the 0.999 point is the 4x atom, mean 4.
  assert.strictEqual(base.cvar999.quantile.fraction, '4');
  assert.strictEqual(base.cvar999.absolute.fraction, '4');
  assert.strictEqual(base.cvar999.relative.fraction, '4');
  // Buckets (x cost): 0 -> 6/10, (0,1) -> 2/10 with RTP 0.1, [1,2) -> 1/10 with 0.15, [2,5) -> 1/10 with 0.4.
  const b = Object.fromEntries(base.buckets.map((x) => [`${x.from}-${x.to}`, [x.probability.fraction, x.rtp.fraction]]));
  assert.deepStrictEqual(b['0-0'], ['3/5', '0']);
  assert.deepStrictEqual(b['0-1'], ['1/5', '1/10']);
  assert.deepStrictEqual(b['1-2'], ['1/10', '3/20']);
  assert.deepStrictEqual(b['2-5'], ['1/10', '2/5']);
  // Transparency: (sum w)^2 / sum w^2 = 100 / (36 + 4 + 1 + 1) = 50/21; largest row 6/10 (id 1).
  assert.strictEqual(base.transparency.rows, 4);
  assert.strictEqual(base.transparency.zeroWeightRows, 0);
  assert.strictEqual(base.transparency.distinctPayouts, 4);
  assert.strictEqual(base.transparency.effectiveSize.fraction, '50/21');
  assert.strictEqual(base.transparency.maxRowProbability.fraction, '3/5');
  assert.strictEqual(base.transparency.maxRowProbability.id, '1');
  // KL(q || uniform) = log2(4) - H(0.6, 0.2, 0.1, 0.1) bits.
  const H = -[0.6, 0.2, 0.1, 0.1].reduce((s, q) => s + q * Math.log2(q), 0);
  assert.ok(Math.abs(base.transparency.klBits - (2 - H)) < 1e-12, `KL ${base.transparency.klBits} vs ${2 - H}`);
  assert.strictEqual(base.transparency.klMaxBits, 2);

  // Same table at cost 5/4: RTP = 650 / (100 * 5/4 * 10) = 13/25.
  assert.strictEqual(ante.cost.fraction, '5/4');
  assert.strictEqual(ante.rtp.fraction, '13/25');
  // Var(X / 1.25) = (581/400) / (25/16) = 581/625; top win 4x = 16/5 of the cost.
  assert.strictEqual(ante.variance.fraction, '581/625');
  assert.strictEqual(ante.maxWin.costMultiple.fraction, '16/5');
  assert.strictEqual(ante.cvar999.relative.fraction, '16/5');
  // In cost multiples the wins are 0.4, 1.2 and 3.2: buckets (0,1), [1,2), [2,5) with RTP 0.08, 0.12, 0.32.
  const a = Object.fromEntries(ante.buckets.map((x) => [`${x.from}-${x.to}`, x.rtp.fraction]));
  assert.deepStrictEqual([a['0-1'], a['1-2'], a['2-5']], ['2/25', '3/25', '8/25']);
  assert.strictEqual(ante.ldw.fraction, '1/5');
});

test('weights above 2^53 keep their exact value (a float reader would see RTP = 1)', () => {
  const a = 2n ** 60n + 1n, b = 2n ** 60n + 3n;
  // Why BigInt: both weights round to the same double, 2^60.
  assert.strictEqual(Number(a), Number(b));
  const r = run([['base', 1, 't.csv']], { 't.csv': [[1, a, 0], [2, b, 200]] });
  const m = r.modes[0];
  // RTP = 200 b / (100 (a + b)) = (2^61 + 6) / (2^61 + 4) = (2^60 + 3) / (2^60 + 2) (consecutive, so coprime).
  assert.strictEqual(m.rtp.fraction, `${2n ** 60n + 3n}/${2n ** 60n + 2n}`);
  assert.notStrictEqual(m.rtp.fraction, '1');
  // Hit rate b / (a + b) = (2^60 + 3) / (2^61 + 4).
  assert.strictEqual(m.hitRate.fraction, `${2n ** 60n + 3n}/${2n ** 61n + 4n}`);
  assert.strictEqual(m.totalWeight, String(a + b));
});

test('uint64 bounds: the largest weight is accepted; a total above it is a Stake format issue', () => {
  const one = run([['base', 1, 't.csv']], { 't.csv': [[1, UINT64_MAX, 100]] });
  assert.strictEqual(one.modes[0].rtp.fraction, '1'); // one row paying exactly the cost
  assert.ok(one.profile.submission.find((c) => c.id === 'weightSum').ok);
  // Two maximal rows: W = 2^65 - 2 > 2^64 - 1.
  const two = run([['base', 1, 't.csv']], { 't.csv': [[1, UINT64_MAX, 100], [2, UINT64_MAX, 0]] });
  assert.strictEqual(two.modes[0].rtp.fraction, '1/2');
  const ws = two.profile.submission.find((c) => c.id === 'weightSum');
  assert.strictEqual(ws.ok, false);
  assert.strictEqual(ws.value, String(2n ** 65n - 2n));
});

// ---------------------------------------------------------------------------------
const bilingual = (pattern, arPattern) => (e) => {
  assert.ok(e instanceof LutError, 'LutError: ' + e);
  assert.ok(e.ar && e.en, 'both languages');
  assert.match(e.en, pattern);
  if (arPattern) assert.match(e.ar, arPattern);
  assert.ok(/[؀-ۿ]/.test(e.ar), 'Arabic text');
  return true;
};

test('malformed rows are rejected with the line number in both languages', () => {
  const bad = (row, re) => assert.throws(() => parseLutCsv(`1,5,0\n${row}\n3,1,10\n`, 't.csv'), bilingual(re, /السطر 2/));
  bad('2,5', /line 2: expected 3 comma-separated values .* found 2/);
  bad('2,5,10,7', /line 2: expected 3 .* found 4/);
  bad('2,-5,10', /line 2: weight "-5" is not a non-negative integer/);
  bad('2,5.5,10', /line 2: weight "5.5"/);
  bad('2,1e3,10', /line 2: weight "1e3"/);
  bad('2,abc,10', /line 2: weight "abc"/);
  bad('2,,10', /line 2: weight ""/);
  bad('x,5,10', /line 2: id "x"/);
  bad('2,5,0.5', /line 2: payout "0.5"/);
  bad('2,18446744073709551616,10', /line 2: weight is above the uint64 maximum/);
  bad('2,5,18446744073709551616', /line 2: payout is above the uint64 maximum/);
  assert.throws(() => parseLutCsv('1,5,0\n2,3,10\n1,1,20\n', 't.csv'), bilingual(/id 1 appears more than once/, /المعرّف 1 مكرر/));
  assert.throws(() => parseLutCsv('', 't.csv'), bilingual(/no data rows/));
  assert.throws(() => parseLutCsv('id,weight,payout\n', 't.csv'), bilingual(/no data rows/));
  assert.throws(() => parseLutCsv('1,0,0\n2,0,100\n', 't.csv'), bilingual(/weights sum to 0/));
});

test('a header line and blank lines are read and noted as the lab\'s inference, not as Stake refusals', () => {
  const t = parseLutCsv('﻿id,weight,payout\r\n1,3,0\r\n\r\n2,1,200\r\n', 't.csv');
  assert.strictEqual(t.rows, 2);
  assert.strictEqual(t.header, true);
  assert.strictEqual(t.blankLines, 1);
  assert.strictEqual(t.totalWeight, 4n);
  // Regression: these two checks are not in rgs_verification.py, so they must not count
  // as submission issues. The table otherwise passes every published submission check
  // (by hand): weights 9 and 1 on 0x and 9.6x, so RTP = 960 / (100 * 10) = 0.96, inside
  // [0.960, 0.967]; cost 1; top win 9.6x; payouts 0 and 960 are multiples of 10; total
  // weight 10; SD = sqrt(0.1 * 9.6^2 - 0.96^2) = sqrt(8.2944) = 2.88 >= 0.6.
  // The text has a header and one blank line between rows plus one after the last row.
  const r = analyzeLutFiles([indexFile([['base', 1, 't.csv']]), { name: 't.csv', text: 'id,weight,payout\n1,9,0\n\n2,1,960\n\n' }]);
  assert.strictEqual(r.modes[0].rtp.fraction, '24/25');
  assert.deepStrictEqual(r.profile.submission.filter((c) => !c.ok).map((c) => c.id), []);
  assert.strictEqual(r.profile.submissionIssues, 0);
  assert.ok(!r.profile.submission.some((c) => c.id === 'noHeader' || c.id === 'noBlank'), 'not listed as published checks');
  const inferred = Object.fromEntries(r.profile.inferred.map((c) => [c.id, c]));
  assert.deepStrictEqual([inferred.noHeader.ok, inferred.noHeader.value], [false, 1]);
  assert.deepStrictEqual([inferred.noBlank.ok, inferred.noBlank.value], [false, 2]);
  assert.strictEqual(r.profile.inferredIssues, 2);
  // A clean file has no inferred notes either.
  const clean = analyzeLutFiles([indexFile([['base', 1, 't.csv']]), { name: 't.csv', text: '1,9,0\n2,1,960\n' }]);
  assert.strictEqual(clean.profile.inferredIssues, 0);
  assert.strictEqual(clean.profile.submissionIssues, 0);
});

test('index.json errors and file mismatches are rejected in both languages', () => {
  const tbl = csvFile('a.csv', [[1, 1, 100]]);
  const go = (files) => () => analyzeLutFiles(files);
  assert.throws(go([]), bilingual(/No files selected/));
  assert.throws(go([tbl]), bilingual(/index\.json is required/));
  assert.throws(go([indexFile([['base', 1, 'a.csv']]), indexFile([['base', 1, 'a.csv']], 'other.json'), tbl]), bilingual(/Exactly one JSON file/));
  assert.throws(go([indexFile([['base', 1, 'a.csv'], ['bonus', 100, 'b.csv']]), tbl]), bilingual(/lists tables that were not uploaded: b\.csv/, /b\.csv/));
  assert.throws(go([indexFile([['base', 1, 'a.csv']]), tbl, csvFile('extra.csv', [[1, 1, 0]])]), bilingual(/CSV files not listed in index\.json: extra\.csv/));
  assert.throws(go([indexFile([['base', 1, 'a.csv']]), tbl, tbl]), bilingual(/selected twice/));
  assert.throws(go([indexFile([['base', 1, 'a.csv']]), tbl, { name: 'notes.txt', text: 'x' }]), bilingual(/Unexpected file types: notes\.txt/));
  const idx = (text) => () => parseLutIndex(text);
  assert.throws(idx('{"modes": ['), bilingual(/not valid JSON/));
  assert.throws(idx('{}'), bilingual(/non-empty list of modes/));
  assert.throws(idx('{"modes": []}'), bilingual(/non-empty list of modes/));
  assert.throws(idx('{"modes": [1]}'), bilingual(/mode #1: not a JSON object/));
  assert.throws(idx('{"modes": [{"cost": 1, "events": "e", "weights": "w"}]}'), bilingual(/"name" is missing/));
  for (const cost of ['0', '-1', '"1.0"', 'null']) {
    assert.throws(idx(`{"modes": [{"name": "base", "cost": ${cost}, "events": "e", "weights": "w"}]}`), bilingual(/"cost" must be a positive number/));
  }
  assert.throws(idx('{"modes": [{"name": "base", "cost": 1, "events": "e"}]}'), bilingual(/"weights" is missing/));
  assert.throws(idx('{"modes": [{"name": "base", "cost": 1, "weights": "w"}]}'), bilingual(/"events" is missing/));
  assert.throws(idx('{"modes": [{"name": "a", "cost": 1, "events": "e", "weights": "w"}, {"name": "a", "cost": 2, "events": "e", "weights": "w"}]}'), bilingual(/"a" appears twice/));
  // A malformed row inside a matched table names the file.
  assert.throws(go([indexFile([['base', 1, 'a.csv']]), { name: 'a.csv', text: '1,1,100\n2,x,0\n' }]), bilingual(/a\.csv, line 2/, /a\.csv، السطر 2/));
});

test('book files are listed as not read; file kinds are recognised by name', () => {
  const r = analyzeLutFiles([indexFile([['base', 1, 'a.csv']]), csvFile('a.csv', [[1, 1, 100]]), { name: 'books_base.jsonl.zst', text: null }]);
  assert.deepStrictEqual(r.ignored, ['books_base.jsonl.zst']);
  assert.deepStrictEqual(['index.json', 'lookUpTable_base_0.csv', 'books_base.jsonl.zst', 'books.jsonl', 'x.zstd', 'notes.txt'].map(lutFileKind),
    ['index', 'csv', 'books', 'books', 'books', 'other']);
  // A weights path with folders matches the uploaded file name.
  const p = analyzeLutFiles([indexFile([['base', 1, 'publish_files/a.csv']]), csvFile('a.csv', [[1, 1, 100]])]);
  assert.strictEqual(p.modes[0].rtp.fraction, '1');
});

// ---------------------------------------------------------------------------------
// Second algorithm: every row repeated w times, one outcome per unit of weight, then
// each figure computed directly from that list.
function expanded(rows, cost) {
  const c = Fraction.fromDecimal(String(cost));
  const xs = [];
  for (const [, w, p] of rows) for (let i = 0; i < w; i++) xs.push(new Fraction(BigInt(p), 100n));
  const n = xs.length;
  const sum = (list) => list.reduce((s, x) => s.add(x), new Fraction(0n));
  const share = (pred) => new Fraction(BigInt(xs.filter(pred).length), BigInt(n));
  const mean = sum(xs).div(n);
  const variance = sum(xs.map((x) => x.sub(mean).mul(x.sub(mean)))).div(n).div(c.mul(c)); // two-pass
  const sorted = xs.slice().sort((x, y) => x.cmp(y));
  const max = sorted[n - 1];
  // 0.999 quantile as the k-th smallest outcome, k = ceil(0.999 n).
  const k = Math.ceil((999 * n) / 1000);
  const q = sorted[k - 1];
  const tail = xs.filter((x) => x.cmp(q) >= 0);
  const cvar = sum(tail).div(tail.length);
  const r = xs.map((x) => x.div(c));
  const bucket = (x) => (x.isZero() ? 0 : BUCKETS.findIndex((e, i) => i > 0 && x.cmp(e) < 0) === -1 ? BUCKETS.length : BUCKETS.findIndex((e, i) => i > 0 && x.cmp(e) < 0));
  const buckets = new Array(BUCKETS.length + 1).fill(0).map((_, i) => ({ p: share((x) => bucket(x.div(c)) === i), rtp: sum(r.filter((x) => bucket(x) === i)).div(n) }));
  const ws = rows.map((row) => BigInt(row[1]));
  const W = ws.reduce((s, w) => s + w, 0n);
  const qs = ws.map((w) => new Fraction(w, W));
  return {
    rtp: mean.div(c), hit: share((x) => !x.isZero()), zero: share((x) => x.isZero()),
    ldw: share((x) => !x.isZero() && x.cmp(c) < 0), below: share((x) => x.cmp(c) < 0),
    variance, max, pMax: share((x) => x.equals(max)), q, cvar, cvarRel: cvar.div(c),
    rtp40: sum(xs.filter((x) => x.cmp(c.mul(40)) >= 0)).div(n).div(c),
    rtp10k: sum(xs.filter((x) => x.cmp(10000) >= 0)).div(n).div(c),
    // Stake's expected tail liabilities in base bets (etl40, etl10k of rgs_verification.py):
    // the mean of X * [X >= 40 * cost] and of X * [X >= 10,000].
    etl40: sum(xs.filter((x) => x.cmp(c.mul(40)) >= 0)).div(n),
    etl10k: sum(xs.filter((x) => x.cmp(10000) >= 0)).div(n),
    ldwShare: new Fraction(BigInt(xs.filter((x) => !x.isZero() && x.cmp(c) < 0).length), BigInt(xs.filter((x) => !x.isZero()).length)),
    maxCost: max.div(c),
    big: BIG_WIN_THRESHOLDS.map((T) => share((x) => x.cmp(T) >= 0)),
    buckets,
    ess: new Fraction(1n).div(sum(qs.map((x) => x.mul(x)))), // 1 / sum q^2
    maxRow: qs.reduce((m, x) => (x.cmp(m) > 0 ? x : m), new Fraction(0n)),
    klBits: Math.log2(rows.length) + qs.filter((x) => !x.isZero()).reduce((s, x) => s + x.toNumber() * Math.log2(x.toNumber()), 0),
    zeroRows: rows.filter((row) => row[1] === 0).length,
    distinct: new Set(rows.filter((row) => row[1] > 0).map((row) => row[2])).size,
  };
}

function lcg(seed) {
  let s = seed >>> 0;
  return (n) => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s % n; };
}

test('every metric equals a direct computation over the expanded outcomes (random tables)', () => {
  for (const [seed, cost] of [[1, 1], [2, 2.5], [3, 100], [4, 0.2], [5, 1], [6, 40]]) {
    const rnd = lcg(seed);
    const c = Fraction.fromDecimal(String(cost));
    // Payouts that sit on and next to every threshold: the cost, 40 x cost, 5,000x ... 100,000x.
    const special = [0, 10, Number(c.mul(100).toDecimal(0)), Number(c.mul(4000).toDecimal(0)), 499990, 500000, 1000000, 2500000, 5000000, 10000000, 10000010];
    const rows = [];
    for (let i = 0; i < 700; i++) {
      const p = rnd(3) === 0 ? special[rnd(special.length)] : rnd(4) === 0 ? 0 : 10 * rnd(5000);
      rows.push([i + 1, rnd(6), p]);
    }
    rows.push([701, 1, 10000010]); // so some weight sits on the top row
    const full = run([['m', cost, 't.csv']], { 't.csv': rows });
    const m = full.modes[0];
    const x = expanded(rows, cost);
    const tag = `seed ${seed}, cost ${cost}`;
    sameFraction(m.rtp.fraction, x.rtp.toString(), tag + ' RTP');
    sameFraction(m.hitRate.fraction, x.hit.toString(), tag + ' hit');
    sameFraction(m.zeroWin.fraction, x.zero.toString(), tag + ' zero');
    sameFraction(m.ldw.fraction, x.ldw.toString(), tag + ' LDW');
    sameFraction(m.belowCost.fraction, x.below.toString(), tag + ' below cost');
    sameFraction(m.variance.fraction, x.variance.toString(), tag + ' variance');
    sameFraction(m.maxWin.multiplier.fraction, x.max.toString(), tag + ' max');
    sameFraction(m.maxWin.probability.fraction, x.pMax.toString(), tag + ' P(max)');
    sameFraction(m.cvar999.quantile.fraction, x.q.toString(), tag + ' 0.999 quantile');
    sameFraction(m.cvar999.absolute.fraction, x.cvar.toString(), tag + ' CVaR');
    sameFraction(m.cvar999.relative.fraction, x.cvarRel.toString(), tag + ' CVaR / cost');
    sameFraction(m.tail.rtpFrom40xCost.fraction, x.rtp40.toString(), tag + ' RTP from >= 40x cost');
    sameFraction(m.tail.rtpFrom10kx.fraction, x.rtp10k.toString(), tag + ' RTP from >= 10,000x');
    m.bigWins.forEach((bw, i) => sameFraction(bw.probability.fraction, x.big[i].toString(), `${tag} P(>= ${bw.threshold}x)`));
    m.buckets.forEach((bk, i) => {
      sameFraction(bk.probability.fraction, x.buckets[i].p.toString(), `${tag} bucket ${i}`);
      sameFraction(bk.rtp.fraction, x.buckets[i].rtp.toString(), `${tag} bucket ${i} RTP`);
    });
    sameFraction(m.transparency.effectiveSize.fraction, x.ess.toString(), tag + ' ESS');
    sameFraction(m.transparency.maxRowProbability.fraction, x.maxRow.toString(), tag + ' largest row');
    assert.ok(Math.abs(m.transparency.klBits - x.klBits) < 1e-9, `${tag} KL ${m.transparency.klBits} vs ${x.klBits}`);
    assert.strictEqual(m.transparency.zeroWeightRows, x.zeroRows, tag + ' zero-weight rows');
    assert.strictEqual(m.transparency.distinctPayouts, x.distinct, tag + ' distinct payouts');
    assert.strictEqual(m.transparency.rows, rows.length);
    // The share of RTP from the tail is the contribution over the RTP.
    sameFraction(m.tail.shareFrom40xCost.fraction, x.rtp40.div(x.rtp).toString(), tag + ' share >= 40x');
    sameFraction(m.tail.shareFrom10kx.fraction, x.rtp10k.div(x.rtp).toString(), tag + ' share >= 10,000x');
    sameFraction(m.ldwShareOfWins.fraction, x.ldwShare.toString(), tag + ' LDW share of wins');
    sameFraction(m.maxWin.costMultiple.fraction, x.maxCost.toString(), tag + ' top win / cost');
    // Tail-liability risk inputs: "Both combined" = (etl40 + etl10k) / cost, "Combined, in
    // base bets" = etl40 + etl10k. Shown as floats; the pass flag is value <= limit, exactly.
    const risk = (id) => full.profile.risk.find((e) => e.measure === id);
    for (const [id, want, limit] of [['combined', x.etl40.add(x.etl10k).div(c), 1.5], ['combinedAbs', x.etl40.add(x.etl10k), 10000]]) {
      const got = risk(id);
      assert.ok(Math.abs(got.value - want.toNumber()) <= 1e-12 * Math.max(1, want.toNumber()), `${tag} ${id}: ${got.value} vs ${want.toNumber()}`);
      assert.strictEqual(got.limit, limit, `${tag} ${id} limit`);
      assert.strictEqual(got.ok, want.cmp(Fraction.fromDecimal(String(limit))) <= 0, `${tag} ${id} verdict`);
    }
  }
});

test('CVaR follows rgs_verification.py: the whole atom at the 0.999 point is in the tail', () => {
  // Weights 998, 1, 1 on 0x, 1x, 10x: the cumulative reaches 0.999 at the 1x atom, so
  // the tail is {1x, 10x} with mean (1 + 10) / 2 = 11/2 (not 10, the top 0.1% alone).
  const m = run([['base', 1, 't.csv']], { 't.csv': [[1, 998, 0], [2, 1, 100], [3, 1, 1000]] }).modes[0];
  assert.strictEqual(m.cvar999.quantile.fraction, '1');
  assert.strictEqual(m.cvar999.absolute.fraction, '11/2');
});

test('effective size: equal weights give the row count, one dominant row gives about 1', () => {
  // (n w)^2 / (n w^2) = n.
  const eq = run([['base', 1, 't.csv']], { 't.csv': [1, 2, 3, 4, 5].map((i) => [i, 7, 10 * i]) }).modes[0];
  assert.strictEqual(eq.transparency.effectiveSize.fraction, '5');
  assert.ok(Math.abs(eq.transparency.klBits) < 1e-12, 'uniform weights: KL 0');
  // Weights 1000, 1, 1: 1002^2 / (10^6 + 2) = 1004004 / 1000002; both are divisible by 6
  // (1004004 = 2^2 * 3^2 * 167^2, 1000002 = 2 * 3 * 166667), so 167334 / 166667.
  const dom = run([['base', 1, 't.csv']], { 't.csv': [[1, 1000, 0], [2, 1, 10], [3, 1, 20]] }).modes[0];
  assert.strictEqual(dom.transparency.effectiveSize.fraction, '167334/166667');
});

// ---------------------------------------------------------------------------------
// Stake Engine RGS limits. Expected outcomes follow the rules in utils/rgs_verification.py
// (math-sdk commit 141b4e8): RTP rounded with floor(rtp * 1e4 + 0.5) / 1e4 and checked
// against [0.960, 0.967]; a risk measure fails when value > limit.
const twoRows = (w1, p1, w0) => [[1, w0, 0], [2, w1, p1]];
const check = (r, id, mode = undefined) => r.profile.submission.find((c) => c.id === id && (mode === undefined || c.mode === mode));

test('Stake profile: RTP band with its 4-place rounding (half up)', () => {
  // RTP = w1 / 100000 with a 1x payout: 0.96705 -> 0.9671 (out), 0.96704 -> 0.9670 (in),
  // 0.95995 -> 0.9600 (in), 0.95994 -> 0.9599 (out), 0.96 and 0.967 exactly (in).
  for (const [w1, ok] of [[96705, false], [96704, true], [95995, true], [95994, false], [96000, true], [96700, true]]) {
    const r = run([['base', 1, 't.csv']], { 't.csv': twoRows(w1, 100, 100000 - w1) });
    const c = check(r, 'rtp');
    assert.strictEqual(c.ok, ok, `RTP ${w1 / 1e5}`);
    assert.strictEqual(r.modes[0].rtp.fraction, new Fraction(BigInt(w1), 100000n).toString());
  }
});

test('Stake profile: cost, top win, base mode, base deviation and payout steps', () => {
  // Cost 50,000 is allowed, 50,000.5 is not; a top win of exactly 1,000,000x is allowed, 1,000,000.1x is not.
  const r1 = run([['base', 1, 'a.csv'], ['big', 50000, 'b.csv'], ['bigger', 50000.5, 'c.csv']], {
    'a.csv': [[1, 1, 100000000]], 'b.csv': [[1, 1, 100000010]], 'c.csv': [[1, 1, 0]],
  });
  assert.deepStrictEqual([check(r1, 'maxCost', 'big').ok, check(r1, 'maxCost', 'bigger').ok], [true, false]);
  assert.deepStrictEqual([check(r1, 'maxWin', 'base').ok, check(r1, 'maxWin', 'big').ok], [true, false]);
  assert.strictEqual(check(r1, 'baseCost').ok, true);
  // No 1x mode: the cheapest costs 2, and there is no base deviation to check.
  const r2 = run([['a', 2, 'a.csv'], ['b', 100, 'a.csv']], { 'a.csv': [[1, 1, 200]] });
  assert.strictEqual(check(r2, 'baseCost').ok, false);
  assert.strictEqual(check(r2, 'baseCost').value, 2);
  assert.strictEqual(check(r2, 'baseStd'), undefined);
  // Base deviation: wins 0.5x / 1.5x with equal weight have sigma 0.5 (< 0.6, issue);
  // 0.4x / 1.6x have sigma exactly 0.6 (allowed).
  const low = run([['base', 1, 'a.csv']], { 'a.csv': [[1, 1, 50], [2, 1, 150]] });
  assert.strictEqual(check(low, 'baseStd').ok, false);
  assert.strictEqual(check(low, 'baseStd').value, 0.5);
  const edge = run([['base', 1, 'a.csv']], { 'a.csv': [[1, 1, 40], [2, 1, 160]] });
  assert.strictEqual(check(edge, 'baseStd').ok, true);
  // Payouts must be multiples of 10 (0.1x steps): 15 and 7 break it, even on a zero-weight row.
  const inc = run([['base', 1, 'a.csv']], { 'a.csv': [[1, 1, 100], [2, 1, 15], [3, 0, 7]] });
  assert.strictEqual(check(inc, 'increment').value, 2);
  assert.strictEqual(check(inc, 'increment').ok, false);
  assert.strictEqual(inc.profile.submissionIssues, inc.profile.submission.filter((c) => !c.ok).length);
});

test('Stake profile: risk checks lower the bet template instead of rejecting', () => {
  // All risk checks pass: template 0 = (50e6, 500e3); top win 4x, top cost 1:
  // min(1000, 50e6 / 4, 500e3 / 1) = 1000.
  const ok = run([['base', 1, 'a.csv']], { 'a.csv': [[1, 6, 0], [2, 2, 50], [3, 1, 150], [4, 1, 400]] });
  assert.deepStrictEqual(ok.profile.failedCategories, []);
  assert.strictEqual(ok.profile.riskPassing, 6);
  assert.strictEqual(ok.profile.maxBaseBet.fraction, '1000');

  // Only "Top win" fails: 200,000x at weight 1 in 10^9 + 1. Its deviation is about 6.3,
  // its CVaR point is 0x, and P(>= 5,000x) = 1e-9. Template 1 = (25e6, 500e3):
  // min(1000, 25e6 / 200000 = 125, 500e3) = 125.
  const top = run([['base', 1, 'a.csv']], { 'a.csv': [[1, 1e9, 0], [2, 1, 20000000]] });
  assert.deepStrictEqual(top.profile.failedCategories, ['topWin']);
  assert.strictEqual(top.profile.maxBaseBet.fraction, '125');

  // 10,000x on 10% of rounds: sigma = 10000 * sqrt(0.09) = 3000 > 60; the 0.999 point is
  // the 10,000x atom, CVaR 10000 > 700 x cost (absolute 10000 <= 50000); RTP from >= 40x is
  // 1000 > 0.9; P(>= 5,000x) = 0.1 > 0.05. Four categories fail: template 4 = (5e6, 50e3):
  // min(1000, 5e6 / 10000 = 500, 50e3 / 1) = 500.
  const heavy = run([['base', 1, 'a.csv']], { 'a.csv': [[1, 90, 0], [2, 10, 1000000]] });
  assert.deepStrictEqual(heavy.profile.failedCategories, ['volatility', 'worst', 'tail', 'bigWin']);
  const measure = (r, id) => r.profile.risk.find((x) => x.measure === id);
  assert.strictEqual(measure(heavy, 'std').value, 3000);
  assert.strictEqual(measure(heavy, 'cvarRelative').ok, false);
  assert.strictEqual(measure(heavy, 'cvarAbsolute').ok, true);
  assert.strictEqual(heavy.profile.maxBaseBet.fraction, '500');
  // Risk failures are not submission issues: the band, cost and top win here are fine
  // except the RTP (1000x on average), which is a separate check.
  assert.strictEqual(check(heavy, 'maxWin').ok, true);

  // All six: add a 6,000x-cost mode (cost > 5,000) and a 200,000x top win. Template 6 =
  // (500e3, 10e3): min(1000, 500e3 / 200000 = 5/2, 10e3 / 6000 = 5/3) = 5/3.
  const all = run([['base', 1, 'a.csv'], ['vip', 6000, 'b.csv']], { 'a.csv': [[1, 90, 0], [2, 10, 20000000]], 'b.csv': [[1, 1, 0]] });
  assert.strictEqual(all.profile.failedCategories.length, 6);
  assert.strictEqual(all.profile.riskPassing, 0);
  assert.strictEqual(all.profile.maxBaseBet.fraction, '5/3');
});

test('Stake profile: tail liability "Both combined" and "Combined, in base bets" at and over their limits', () => {
  const measure = (r, id) => r.profile.risk.find((x) => x.measure === id);
  // Cost 1; weight 1 on 40x and 1 on 10,000x out of W. A 40x win counts in etl40 only; a
  // 10,000x win counts in both (it is also >= 40 x cost). By hand:
  // etl40 = (40 + 10000) / W, etl10k = 10000 / W, combined = 20040 / W.
  // W = 13360: 20040 / 13360 = 3/2 exactly -> passes (limit 1.5, rule value > limit).
  const at = run([['base', 1, 'a.csv']], { 'a.csv': [[1, 13358, 0], [2, 1, 4000], [3, 1, 1000000]] });
  assert.strictEqual(measure(at, 'combined').value, 1.5);
  assert.strictEqual(measure(at, 'combined').ok, true);
  // The same rows give the share of RTP from >= 10,000x: 10000 / (40 + 10000) = 250/251,
  // and from >= 40x cost all of it.
  assert.strictEqual(at.modes[0].tail.shareFrom10kx.fraction, '250/251');
  assert.strictEqual(at.modes[0].tail.shareFrom40xCost.fraction, '1');
  // W = 13359: 20040 / 13359 > 3/2 -> fails.
  const over = run([['base', 1, 'a.csv']], { 'a.csv': [[1, 13357, 0], [2, 1, 4000], [3, 1, 1000000]] });
  assert.strictEqual(measure(over, 'combined').ok, false);

  // Cost 2 separates the two: one 10,000x win in W = 2 gives etl40 = etl10k = 5000 base
  // bets, so "in base bets" = 10000 (equal to its limit: passes) while "combined" =
  // 10000 / 2 = 5000 (over 1.5: fails).
  const c2 = run([['base', 1, 'b.csv'], ['buy', 2, 'a.csv']], { 'a.csv': [[1, 1, 0], [2, 1, 1000000]], 'b.csv': [[1, 1, 0]] });
  const buy = (id) => c2.profile.risk.find((x) => x.measure === id && x.mode === 'buy');
  assert.deepStrictEqual([buy('combinedAbs').value, buy('combinedAbs').ok], [10000, true]);
  assert.deepStrictEqual([buy('combined').value, buy('combined').ok], [5000, false]);
  // 10,000.1x instead: "in base bets" = 2 * 10000.1 / 2 = 10000.1 > 10000 -> fails.
  const c3 = run([['base', 1, 'b.csv'], ['buy', 2, 'a.csv']], { 'a.csv': [[1, 1, 0], [2, 1, 1000010]], 'b.csv': [[1, 1, 0]] });
  assert.strictEqual(c3.profile.risk.find((x) => x.measure === 'combinedAbs' && x.mode === 'buy').ok, false);
});

test('Stake profile: a risk value equal to its limit passes (the rule is value > limit)', () => {
  // P(>= 5,000x) = 1/20 = 0.05 exactly passes; 1/19 fails.
  const at = run([['base', 1, 'a.csv']], { 'a.csv': [[1, 19, 0], [2, 1, 500000]] });
  assert.strictEqual(at.profile.risk.find((x) => x.measure === 'p5000').ok, true);
  const over = run([['base', 1, 'a.csv']], { 'a.csv': [[1, 18, 0], [2, 1, 500000]] });
  assert.strictEqual(over.profile.risk.find((x) => x.measure === 'p5000').ok, false);
  // Deviation exactly 60: wins 0 / 120x with equal weight have sigma 60.
  const sd = run([['base', 1, 'a.csv']], { 'a.csv': [[1, 1, 0], [2, 1, 12000]] });
  const m = sd.profile.risk.find((x) => x.measure === 'std');
  assert.strictEqual(m.value, 60);
  assert.strictEqual(m.ok, true);
});

// ---------------------------------------------------------------------------------
test('generated example: two modes in the Stake band, totals above 2^53, results JSON-safe', () => {
  const files = makeSampleLut();
  assert.deepStrictEqual(files.map((f) => f.name), ['index.json', 'lookUpTable_base_0.csv', 'lookUpTable_bonus_0.csv']);
  const r = analyzeLutFiles(files);
  assert.doesNotThrow(() => JSON.stringify(r));
  const [base, bonus] = r.modes;
  // Exact RTPs computed offline from the same files with Python's fractions module:
  // sum(w * p / 100) / sum(w) / cost over every row.
  assert.strictEqual(base.rtp.fraction, '11119927911933037157/11523241359516100680');
  assert.strictEqual(bonus.rtp.fraction, '52132551352438561841/54023369277138406050');
  assert.strictEqual(base.cost.fraction, '1');
  assert.strictEqual(bonus.cost.fraction, '100');
  for (const m of r.modes) assert.ok(BigInt(m.totalWeight) > 2n ** 53n && BigInt(m.totalWeight) <= UINT64_MAX, m.name);
  assert.strictEqual(r.profile.submissionIssues, 0);
  assert.strictEqual(r.profile.riskPassing, 6);
  // Same generator, same bytes.
  assert.deepStrictEqual(makeSampleLut(), files);
});

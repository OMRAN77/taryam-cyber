import test from 'node:test';
import assert from 'node:assert';
import { parseLine, parseHistory } from '../../lab/core/history.js';
import { analyzePlayLog } from '../../lab/core/actual.js';

test('parseLine: bets pasted from real "my bets" tables, in several layouts', () => {
  // date, game, bet, multiplier, payout
  assert.deepStrictEqual(parseLine('30/10/2026 21:01  Mines  5.00 AED  ×1.12  5.60 AED'), { bet: 5, win: 5.6, mult: 1.12 });
  // ISO timestamp and a long bet id must not be read as amounts
  assert.deepStrictEqual(parseLine('2026-10-30T14:05:07 #1234567890 Dice 10 USD 0.00'), { bet: 10, win: 0, mult: null });
  assert.deepStrictEqual(parseLine('Oct 30, 2026 2:05 pm  Limbo  Bet 2.50  Win 0.00'), { bet: 2.5, win: 0, mult: null });
  // Arabic digits, dirham word, Arabic month
  assert.deepStrictEqual(parseLine('٣٠ أكتوبر ٢٠٢٦  الرهان ٢٠ درهم  الربح ٤٥٫٥ درهم'), { bet: 20, win: 45.5, mult: null });
  // one amount and a multiplier: payout = bet × multiplier
  assert.deepStrictEqual(parseLine('Crash  1,000.00  2.5x'), { bet: 1000, win: 2500, mult: 2.5 });
  // crypto amounts with many decimals are not bet ids
  assert.deepStrictEqual(parseLine('bet 0.00000100 BTC  ×0.00  payout 0.00000000'), { bet: 0.000001, win: 0, mult: 0 });
  // an alphanumeric id is dropped
  assert.deepStrictEqual(parseLine('a7f3k9d2m1x4 Mines 5 0'), { bet: 5, win: 0, mult: null });
  // nothing usable
  assert.strictEqual(parseLine('Mines  —  pending'), null);
  assert.strictEqual(parseLine('30/10/2026 21:01'), null);
});

test('parseHistory: free text rows and skipped lines, or a CSV header through parsePlayLog', () => {
  const text = [
    'Date  Game  Bet  Mult  Payout',
    '30/10/2026 21:01  Mines  5.00  ×0.00  0.00',
    '',
    '30/10/2026 21:02  Mines  5.00  ×1.12  5.60',
    'some note without numbers',
    '30/10/2026 21:03  Mines  10.00  ×1.48  14.80',
  ].join('\n');
  const h = parseHistory(text);
  assert.strictEqual(h.source, 'text');
  assert.deepStrictEqual(Array.from(h.bets), [5, 5, 10]);
  assert.deepStrictEqual(Array.from(h.wins), [0, 5.6, 14.8]);
  assert.deepStrictEqual(h.rows.map((r) => r.line), [2, 4, 6]);
  assert.deepStrictEqual(h.skipped.map((s) => s.line), [1, 5]);

  const csv = parseHistory('bet,win\n5,0\n5,5.6\n10,14.8\n');
  assert.strictEqual(csv.source, 'csv');
  assert.deepStrictEqual(Array.from(csv.bets), [5, 5, 10]);
  assert.deepStrictEqual(Array.from(csv.wins), [0, 5.6, 14.8]);

  // The parsed history feeds the existing session analysis unchanged.
  const a = analyzePlayLog(h, { declaredRtp: 0.97, confidence: 0.95 });
  assert.strictEqual(a.rounds, 3);
  assert.strictEqual(a.totalBet, 20);
  assert.ok(Math.abs(a.rtp - 20.4 / 20) < 1e-12);
  assert.ok(['normal', 'review', 'suspicious'].includes(a.declared.verdict));
});

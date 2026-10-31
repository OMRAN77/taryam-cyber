import test from 'node:test';
import assert from 'node:assert';
import { choose, pSurvive, pSafeNext, fairMultiplier, parseMultipliers, ladder, sessionExpectation, pAheadAfter } from '../../lab/core/mines-math.js';

const near = (a, b, tol, label = '') => assert.ok(Math.abs(a - b) <= tol, `${label} ${a} vs ${b}`);

test('mines odds on a 5×5 grid: exact survival and next-click probabilities, fair multipliers', () => {
  assert.strictEqual(choose(25, 3), 2300);
  near(pSafeNext(1, 3), 22 / 25, 1e-15);
  near(pSafeNext(2, 3), 21 / 24, 1e-15);
  near(pSurvive(1, 3), 22 / 25, 1e-15);
  near(pSurvive(2, 3), (22 * 21) / (25 * 24), 1e-15);
  near(pSurvive(22, 3), 1 / 2300, 1e-18); // clearing every safe tile
  near(fairMultiplier(1, 3), 25 / 22, 1e-15);
  near(fairMultiplier(22, 3), 2300, 1e-9);
  near(pSurvive(1, 24), 1 / 25, 1e-15);
});

test('ladder: the game\'s cut is flat at 1 − RTP whatever the cash-out point; typed multipliers expose the implied RTP', () => {
  const rows = ladder({ mines: 3, rtp: 0.96, bet: 10 });
  assert.strictEqual(rows.length, 22);
  for (const r of rows) {
    near(r.impliedRtp, 0.96, 0.011, 'k=' + r.k); // floored to cents, so slightly under
    near(r.expectedReturn, 10 * r.impliedRtp, 1e-12);
    assert.ok(r.offered < r.fair);
    assert.strictEqual(r.fromGame, false);
  }
  assert.strictEqual(rows[0].offered, 1.09);
  near(rows[0].pBombNext, 3 / 25, 1e-15);
  near(rows[1].pBombNext, 3 / 24, 1e-15);
  // The real game's own ladder, typed in: consistent with 96%.
  const typed = ladder({ mines: 3, bet: 10, offered: parseMultipliers('×1.09 1.24x 1.43 1.66') });
  assert.deepStrictEqual(typed.slice(0, 4).map((r) => r.fromGame), [true, true, true, true]);
  assert.strictEqual(typed[4].fromGame, false);
  near(typed[0].impliedRtp, 1.09 * 22 / 25, 1e-12);
  // A clone paying less shows it.
  const clone = ladder({ mines: 3, bet: 10, offered: [1.0, 1.1] });
  assert.ok(clone[0].impliedRtp < 0.9 && clone[1].impliedRtp < 0.85);
  assert.throws(() => ladder({ mines: 25 }), RangeError);
  assert.throws(() => ladder({ mines: 0 }), RangeError);
});

test('session: expected loss and the chance of finishing ahead shrink with rounds', () => {
  const s = sessionExpectation({ rounds: 200, bet: 10, rtp: 0.96 });
  assert.strictEqual(s.wagered, 2000);
  near(s.expectedLoss, 80, 1e-9);
  const p1 = pAheadAfter({ rounds: 1, pWin: 0.88, mult: 1.09 });
  near(p1, 0.88, 1e-12); // one round: ahead iff the single click is safe
  const p100 = pAheadAfter({ rounds: 100, pWin: 0.88, mult: 1.09 });
  const p1000 = pAheadAfter({ rounds: 1000, pWin: 0.88, mult: 1.09 });
  const p5000 = pAheadAfter({ rounds: 5000, pWin: 0.88, mult: 1.09 });
  assert.ok(p100 > p1000 && p1000 > p5000, `${p100} ${p1000} ${p5000}`);
  assert.ok(p100 > 0.1 && p100 < 0.2, String(p100));
  assert.ok(p5000 < 1e-6);
  // exact and normal branches agree around the switch
  near(pAheadAfter({ rounds: 2000, pWin: 0.88, mult: 1.09 }), pAheadAfter({ rounds: 2001, pWin: 0.88, mult: 1.09 }), 0.002);
});

test('parseMultipliers reads what the screen shows, in either digit set', () => {
  assert.deepStrictEqual(parseMultipliers('×1.09, 1.24x; ١٫٤٣ 1.66'), [1.09, 1.24, 1.43, 1.66]);
  assert.deepStrictEqual(parseMultipliers(''), []);
});

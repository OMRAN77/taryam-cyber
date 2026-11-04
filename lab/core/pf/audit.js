// Batch audit of provably-fair rounds with a versioned operator adapter.
//
// Seeded schemes (one server seed per epoch, committed by its SHA-256):
//  1. normalize inputs (seeds, hashes, nonces); a malformed hash is "not checked",
//     never a mismatch;
//  2. group rounds into epochs by the COMMITTED HASH, and pair each epoch with the
//     revealed seed that hashes to it, wherever that seed appears in the file (not
//     by row position: a rotation record may carry the old seed next to the new hash);
//  3. the forward commitment chain (each epoch's announced next hash is the hash of
//     the epoch that follows), nonce uniqueness and continuity per seed pair, and a
//     revealed seed coming back after another seed was used;
//  4. recompute every outcome, and the payout when a paytable (or a payout rule) is
//     known;
//  5. goodness of fit of the PUBLISHED outcomes to their exact distribution under
//     fair play (a data-integrity check with low power, not a proof of fairness).
// Hash-chain schemes: the same, with chain links (and an optional walk to the
// published terminating hash) in place of commitments and nonces.
import { forEachCsvRow, findColumn } from '../csv.js';
import { chiSquareP } from '../specfun.js';
import { holm } from '../nist.js';
import { hexToBytes, bytesToHex, linksUntil, walkChain } from '../sha256-sync.js';
import {
  normalizeSeed, normalizeHash, parseNonce, parseNumber, splitList, keyCache, commitText, commitHexBytes, parseCard, pfError,
} from './common.js';
import { getAdapter, adapterKey } from './registry.js';

export const ALPHA = 0.01;

const COLS = {
  server: ['serverseed', 'server_seed', 'server', 'revealedserverseed', 'unhashedserverseed', 'serverseedrevealed', 'serverseedunhashed'],
  commitment: ['serverseedhash', 'server_seed_hash', 'hashedserverseed', 'serverseedhashed', 'commitment', 'serverhash', 'hash'],
  next: ['nextserverseedhash', 'next_server_seed_hash', 'nexthash', 'nextseedhash', 'nextserverhash'],
  client: ['clientseed', 'client_seed', 'client', 'clientseed1', 'client_seed_1', 'client1'],
  client2: ['clientseed2', 'client_seed_2', 'client2'],
  client3: ['clientseed3', 'client_seed_3', 'client3'],
  nonce: ['nonce'],
  game: ['game', 'gametype', 'game_type', 'gamename'],
  result: ['result', 'outcome', 'roll', 'value', 'crash', 'crashpoint', 'bust', 'drawn', 'draw'],
  gameId: ['gameid', 'game_id', 'gamenumber', 'game_number', 'roundid', 'round_id', 'id'],
  gameHash: ['gamehash', 'game_hash', 'hash'],
  time: ['time', 'timestamp', 'date', 'createdat', 'created_at', 'datetime'],
  betId: ['betid', 'bet_id', 'transactionid', 'transaction_id', 'iid'],
  bet: ['bet', 'amount', 'stake', 'wager', 'betamount'],
  payout: ['payout', 'win', 'return', 'amountwon', 'amount_won', 'payoutamount'],
  profit: ['profit'],
  multiplier: ['multiplier', 'payoutmultiplier', 'payout_multiplier'],
  target: ['target', 'targetmultiplier', 'target_multiplier'],
  condition: ['condition', 'direction', 'mode', 'rollover'],
  rows: ['rows'],
  risk: ['risk', 'difficulty'],
  mines: ['mines', 'minescount', 'mines_count'],
  picks: ['picks', 'selected', 'selectednumbers', 'selected_numbers', 'selectedpositions'],
  revealed: ['revealed', 'opened', 'revealedtiles'],
  segments: ['segments'],
  count: ['count', 'cards'],
  cashout: ['cashout', 'autocashout', 'auto_cashout', 'cashedout', 'cashed_out'],
};

// rows: [{ line, f: { column: text } }], plus which columns were found.
export function parsePfCsv(text, kind = 'seeded') {
  const rows = [];
  let idx = null;
  forEachCsvRow(text, (r, line) => {
    if (!idx) {
      idx = {};
      for (const [k, names] of Object.entries(COLS)) {
        if (kind === 'chain' && k === 'commitment') continue;
        if (kind !== 'chain' && k === 'gameHash') continue;
        const i = findColumn(r, names);
        if (i >= 0 && !Object.values(idx).includes(i)) idx[k] = i;
      }
      return;
    }
    const f = {};
    for (const [k, i] of Object.entries(idx)) f[k] = r[i] ?? '';
    rows.push({ line, f });
  });
  if (!idx) throw pfError('الملف فارغ', 'The file is empty');
  return { columns: Object.keys(idx), rows };
}

// ---------- issues ----------

const SEVERITY = {
  RESULT_MISMATCH: 'fail', COMMITMENT_MISMATCH: 'fail', PAYOUT_MISMATCH: 'fail', NONCE_REUSED: 'fail', SEED_REUSED: 'fail',
  FORWARD_BREAK: 'fail', CHAIN_BREAK: 'fail', TERMINATING_MISMATCH: 'fail', GAME_ID_CONFLICT: 'fail',
  COMMITMENT_ENCODING: 'warn', SEED_ROW_MISMATCH: 'warn', NONCE_GAP: 'warn', NONCE_ORDER: 'warn', DUPLICATE_ROW: 'warn',
  FORWARD_UNANNOUNCED: 'warn', SERVER_SEED_SHARED: 'warn', SEED_DERIVABLE: 'warn', SEED_WEAK: 'warn', UNIFORMITY_REJECTED: 'warn',
  TERMINATING_NOT_REACHED: 'warn', CHAIN_ORDER_UNKNOWN: 'warn', UNCONFIRMED_FORMULA: 'warn', COMMITMENT_ABSENT: 'warn', HASH_MALFORMED: 'warn',
  LIMBO_FORMULAS_DISAGREE: 'info', SEED_UNREVEALED: 'info', FORWARD_COLUMN_CONSTANT: 'info', SEED_MALFORMED: 'info', NONCE_INVALID: 'info', SEED_CLEANED: 'info',
  NONCE_START: 'info', SEED_PAIRED_BY_HASH: 'info', EDGE_CASE: 'info', ERA_UNSUPPORTED: 'info', TERMINATING_OK: 'info',
  RESULT_UNPARSABLE: 'info', GAME_UNKNOWN: 'info', PARAMS_INVALID: 'info', CHAIN_GAP_SKIPPED: 'info', GAME_GAP: 'info',
};
export const ISSUE_SEVERITY = SEVERITY;
const MAX_ISSUES = 500;

class Issues {
  constructor() { this.list = []; this.counts = {}; }
  add(code, detail = {}) {
    this.counts[code] = (this.counts[code] || 0) + 1;
    if (this.list.length < MAX_ISSUES) this.list.push({ code, severity: SEVERITY[code] || 'info', ...detail });
  }
}

// ---------- verdict ----------

// Codes modelled on the ProvablyFair.org audit exit codes.
export const VERDICTS = { PASS: 0, FAIL: 1, CONDITIONAL: 2, INCONCLUSIVE: 3, NOTHING_CHECKED: 4 };

function verdictOf(issues, counts, evidence) {
  const sev = (s) => Object.entries(issues.counts).filter(([c]) => SEVERITY[c] === s).map(([c]) => c);
  const fails = sev('fail'), warns = sev('warn');
  const checked = counts.ok + counts.mismatch;
  let code;
  if (fails.length && evidence === 'unconfirmed' && fails.every((c) => c === 'RESULT_MISMATCH' || c === 'PAYOUT_MISMATCH')) code = 'INCONCLUSIVE';
  else if (fails.length) code = 'FAIL';
  else if (checked === 0 && !issues.counts.TERMINATING_OK) code = 'NOTHING_CHECKED';
  else if (warns.length || counts.notChecked || counts.computed) code = 'CONDITIONAL';
  else code = 'PASS';
  return { code, exit: VERDICTS[code], fails, warns };
}

// ---------- goodness of fit on published outcomes ----------

// Pearson chi-square, merging neighbouring bins until each expects >= 5.
// `factor` corrects for draws without replacement (see drawsTest).
function chiSquare(observed, probs, n, factor = 1) {
  const O = [], E = [];
  let o = 0, e = 0;
  for (let i = 0; i < probs.length; i++) {
    o += observed[i]; e += probs[i] * n;
    if (e >= 5) { O.push(o); E.push(e); o = 0; e = 0; }
  }
  if (e > 0 || o > 0) { if (E.length) { O[O.length - 1] += o; E[E.length - 1] += e; } else { O.push(o); E.push(e); } }
  if (E.length < 2) return null;
  let chi2 = 0;
  for (let i = 0; i < E.length; i++) chi2 += (O[i] - E[i]) ** 2 / E[i];
  chi2 *= factor;
  const df = E.length - 1;
  return { chi2, df, bins: E.length, pValue: chiSquareP(chi2, df) };
}

const MULT_THRESHOLDS = [101, 110, 120, 150, 200, 300, 500, 1000, 2000, 5000, 10000, 100000];
const MIN_N = 30;

function binomialProbs(n) {
  const p = [];
  let c = 1;
  for (let k = 0; k <= n; k++) { p.push(c / 2 ** n); c = (c * (n - k)) / (k + 1); }
  return p;
}

// One collector per (game, stats key): add(claimedText, row) then test().
function makeCollector(stats, opts, group) {
  const values = [];
  return {
    group, type: stats.type,
    add(claimed, row, outcome) {
      if (stats.type === 'ticks') {
        const v = parseNumber(claimed); if (v === null) return;
        const t = Math.round(v * 100); if (Math.abs(v * 100 - t) > 1e-6 || t < 0 || t >= stats.N) return;
        values.push(t);
      } else if (stats.type === 'categorical') {
        const v = parseNumber(claimed); if (v === null || !Number.isInteger(v)) return;
        values.push(v);
      } else if (stats.type === 'categorical-multi') {
        values.push(...(row.cards || []));
      } else if (stats.type === 'multiplier') {
        // values below 1.00 (Aviator's formula has no floor) fall in the first bin
        const v = parseNumber(claimed); if (v === null || v < 0) return;
        values.push(Math.floor(v * 100 + 1e-7));
      } else if (stats.type === 'draws') {
        const list = splitList(claimed).map(Number);
        if (!list.length || list.some((x) => !Number.isInteger(x))) return;
        values.push(list);
      } else if (stats.type === 'binomial') {
        if (outcome && outcome.slotClaimed !== undefined) values.push(outcome.slotClaimed);
      }
    },
    test() {
      const n = values.length;
      if (n < MIN_N) return { group, type: stats.type, n, insufficient: true };
      let res = null;
      if (stats.type === 'ticks') {
        const B = 20, obs = new Array(B).fill(0), probs = [];
        const edge = (b) => Math.round((b * stats.N) / B);
        for (let b = 0; b < B; b++) probs.push(stats.prob(edge(b), edge(b + 1)));
        for (const t of values) { let b = Math.min(B - 1, Math.floor((t * B) / stats.N)); while (b > 0 && t < edge(b)) b--; while (b < B - 1 && t >= edge(b + 1)) b++; obs[b]++; }
        res = chiSquare(obs, probs, n);
      } else if (stats.type === 'categorical' || stats.type === 'categorical-multi') {
        const N = stats.N || group.N;
        const obs = new Array(N).fill(0);
        let m = 0;
        for (const v of values) if (v >= 0 && v < N) { obs[v]++; m++; }
        res = chiSquare(obs, Array.from({ length: N }, (_, j) => stats.prob(j, group)), m);
      } else if (stats.type === 'multiplier') {
        const S = (m) => stats.survival(m, opts);
        const edges = [100, ...MULT_THRESHOLDS];
        const probs = edges.map((m, i) => (i + 1 < edges.length ? S(m) - S(edges[i + 1]) : S(m)));
        probs[0] = 1 - S(edges[1]);
        const obs = new Array(edges.length).fill(0);
        for (const c of values) { let b = edges.length - 1; while (b > 0 && c < edges[b]) b--; obs[b]++; }
        res = chiSquare(obs, probs, n);
      } else if (stats.type === 'draws') {
        // k numbers from N without replacement per round: each number's count is
        // Binomial(n, k/N) and the counts sum to n k, so the Pearson statistic times
        // (N - 1) / ((N - 1) (1 - k/N) N / (N - 1)) = 1 / ((1 - p) N / (N - 1)) is chi-square(N - 1).
        const N = stats.N, k = group.k, base = group.base;
        const obs = new Array(N).fill(0);
        let rounds = 0;
        for (const list of values) {
          if (list.length !== k || new Set(list).size !== k || list.some((x) => x - base < 0 || x - base >= N)) continue;
          for (const x of list) obs[x - base]++;
          rounds++;
        }
        if (rounds < MIN_N) return { group, type: stats.type, n: rounds, insufficient: true };
        const p = k / N;
        res = chiSquare(obs, new Array(N).fill(1 / N), rounds * k, 1 / ((1 - p) * N / (N - 1)));
        if (res) res.n = rounds;
      } else if (stats.type === 'binomial') {
        const rows = group.rows;
        const obs = new Array(rows + 1).fill(0);
        for (const s of values) if (s >= 0 && s <= rows) obs[s]++;
        res = chiSquare(obs, binomialProbs(rows), n);
      }
      if (!res) return { group, type: stats.type, n, insufficient: true };
      return { group, type: stats.type, n: res.n || n, chi2: res.chi2, df: res.df, bins: res.bins, pValue: res.pValue };
    },
  };
}

function runUniformity(collectors, issues, alpha) {
  const tests = [...collectors.values()].map((c) => c.test());
  const usable = tests.filter((t) => !t.insufficient);
  const rejected = holm(usable.map((t) => t.pValue), alpha);
  usable.forEach((t, i) => {
    t.status = rejected[i] ? 'fail' : t.pValue < alpha ? 'flag' : 'pass';
    if (rejected[i]) issues.add('UNIFORMITY_REJECTED', { game: t.group.game, detail: { pValue: t.pValue } });
  });
  for (const t of tests) if (t.insufficient) t.status = 'na';
  return tests;
}

// Adds one published outcome to the right goodness-of-fit collector.
function collectPublished(collectors, game, gname, params, claimed, r, opts) {
  let key = gname, group = { game: gname };
  const st = game.stats;
  if (st.type === 'binomial') {
    const rowsN = parseNumber(params.rows);
    if (rowsN === null) return;
    key += ':' + rowsN; group = { game: gname, rows: rowsN };
    const cs = String(claimed).trim().toUpperCase().replace(/[\s,]+/g, '');
    r.slotClaimed = /^\d{1,2}$/.test(cs) ? Number(cs) : /^[LR]+$/.test(cs) ? cs.split('').filter((x) => x === 'R').length : /^[01]+$/.test(cs) ? cs.split('').filter((x) => x === '1').length : undefined;
  } else if (st.type === 'draws') {
    const k = st.k || splitList(claimed).length;
    const base = st.base + (gname === 'mines' && Number(opts.tileBase) === 1 ? 1 : 0);
    key += ':' + k; group = { game: gname, k, base };
  } else if (st.type === 'categorical' && st.key) {
    const N = parseNumber(params[st.key]);
    if (N === null) return;
    key += ':' + N; group = { game: gname, N, segments: N };
  } else if (st.type === 'categorical-multi') {
    r.cards = splitList(claimed).map(parseCard).filter((x) => x !== null);
  }
  if (!collectors.has(key)) collectors.set(key, makeCollector(st, opts, group));
  collectors.get(key).add(claimed, r, { slotClaimed: r.slotClaimed });
}

// ---------- payouts ----------

function checkPayout(game, gameName, outcome, params, row, opts, summary, issues) {
  const bet = parseNumber(row.f.bet);
  const payoutText = row.f.payout, profitText = row.f.profit, multText = row.f.multiplier;
  let claimedPayout = parseNumber(payoutText);
  if (claimedPayout === null && bet !== null && parseNumber(profitText) !== null) claimedPayout = bet + parseNumber(profitText);
  const claimedMult = parseNumber(multText);
  if (claimedPayout === null && claimedMult === null) return;
  const table = opts.paytable ? opts.paytable[gameName] ?? null : null;
  const win = game.win ? game.win(outcome, params) : null;
  let expectedMult = null;
  if (win === false) expectedMult = 0;
  else if (game.multiplier) expectedMult = game.multiplier(outcome, params, table);
  if (expectedMult === null) { summary.notChecked++; return; }
  // Relative tolerance (operators round multipliers and amounts): default 1e-4.
  const tol = opts.payoutTolerance ?? 1e-4;
  const near = (a, b, scale) => Math.abs(a - b) <= tol * Math.max(Math.abs(b), scale) + 1e-12;
  let ok = true;
  if (claimedMult !== null && win !== false && !near(claimedMult, expectedMult, 1)) ok = false;
  if (claimedPayout !== null && bet !== null && !near(claimedPayout, bet * expectedMult, Math.abs(bet))) ok = false;
  if (claimedPayout !== null && bet === null && win === false && claimedPayout > 0) ok = false;
  summary.checked++;
  if (ok) summary.ok++;
  else {
    summary.mismatch++;
    issues.add('PAYOUT_MISMATCH', { line: row.line, expected: bet !== null ? +(bet * expectedMult).toFixed(8) : +expectedMult.toFixed(6), claimed: claimedPayout ?? claimedMult });
  }
}

// ---------- seeded audits ----------

// One round of a seeded scheme. ctx: { hmac (keyed with the server seed), server, client, nonceText }.
export function computeOutcome(adapter, game, ctx, params = {}, claimed = '', opts = {}) {
  if (adapter.bytes) return game.compute(adapter.bytes(ctx), params, opts);
  if (game.raw) return game.compute(ctx, params, opts);
  return game.compute(adapter.floats(ctx, game.floats(params, claimed)), params, opts);
}

function paramsOf(f) {
  return { target: f.target, condition: f.condition, rows: f.rows, risk: f.risk, mines: f.mines, picks: f.picks, revealed: f.revealed, segments: f.segments, count: f.count };
}

function auditSeeded(rows, adapter, opts, issues, progress) {
  const exact = !!opts.exactSeeds;
  const hexKey = adapter.keyEncoding === 'hex';
  const commit = adapter.commit;
  const other = adapter.commitment === 'hex-bytes' ? commitText : (s) => (/^[0-9a-f]{64}$/.test(s) ? commitHexBytes(s) : null);
  const keyFor = keyCache(adapter.hmacKey);
  const commitCache = new Map();
  const commitOf = (s) => { if (!commitCache.has(s)) commitCache.set(s, commit(s)); return commitCache.get(s); };

  // 1. normalize
  const R = rows.map((r) => {
    const out = { line: r.line, f: r.f };
    const s = normalizeSeed(r.f.server, { exact });
    let seed = s.empty ? null : s.value;
    if (seed !== null && hexKey) {
      const h = normalizeHash(seed);
      if (h.status !== 'ok') { issues.add('SEED_MALFORMED', { line: r.line }); seed = null; out.seedMalformed = true; } else seed = h.value;
    }
    if (s.changed && seed !== null) issues.add('SEED_CLEANED', { line: r.line });
    out.seed = seed;
    const c = normalizeSeed(r.f.client, { exact });
    out.client = c.value;
    if (c.changed && !c.empty) issues.add('SEED_CLEANED', { line: r.line, which: 'client' });
    const h = normalizeHash(r.f.commitment);
    out.hash = h.status === 'ok' ? h.value : null;
    out.hashStatus = h.status;
    if (h.status === 'malformed') issues.add('HASH_MALFORMED', { line: r.line, claimed: String(r.f.commitment).slice(0, 80) });
    const nx = normalizeHash(r.f.next);
    out.next = nx.status === 'ok' ? nx.value : null;
    const n = parseNonce(r.f.nonce);
    out.nonce = n.error ? null : n.value;
    out.nonceText = n.error ? null : n.text;
    // A row with neither nonce nor result is a seed record (e.g. a rotation that reveals
    // the old seed next to the new hash): it supplies seeds and hashes, not a round.
    out.record = n.error === 'empty' && String(r.f.result ?? '').trim() === '';
    if (n.error && !out.record) issues.add('NONCE_INVALID', { line: r.line, claimed: r.f.nonce });
    out.time = r.f.time !== undefined && r.f.time !== '' ? Date.parse(r.f.time) : NaN;
    return out;
  });

  // 2. pair revealed seeds with commitments by hashing
  const seedByCommit = new Map(), seedByOther = new Map();
  for (const r of R) {
    if (r.seed === null) continue;
    const c = commitOf(r.seed);
    if (!seedByCommit.has(c)) seedByCommit.set(c, { seed: r.seed, line: r.line });
    const o = other(r.seed);
    if (o && !seedByOther.has(o)) seedByOther.set(o, r.line);
  }
  const epochs = new Map();
  for (const r of R) {
    const key = r.hash || (r.seed !== null ? commitOf(r.seed) : null);
    r.epoch = key;
    if (!key) continue;
    if (!epochs.has(key)) epochs.set(key, { hash: key, given: !!r.hash, rows: [], clients: new Set(), nexts: new Set() });
    const e = epochs.get(key);
    e.rows.push(r);
    if (r.client && !r.record) e.clients.add(r.client);
    if (r.next) e.nexts.add(r.next);
    if (r.hash) e.given = true;
  }
  for (const e of epochs.values()) {
    const found = seedByCommit.get(e.hash);
    if (!e.given) e.commitment = 'none';
    else if (found) e.commitment = 'ok';
    else {
      // No seed in the file hashes to this commitment under the adapter's encoding.
      // Seeds that do under the OTHER encoding (text vs bytes) point to a wrong adapter,
      // not to a cheat; seeds carried here that belong to other epochs are pairing noise.
      const carried = e.rows.filter((r) => r.seed !== null);
      if (seedByOther.has(e.hash) || carried.some((r) => epochs.has(other(r.seed)))) e.commitment = 'encoding';
      else if (!carried.length || carried.every((r) => epochs.has(commitOf(r.seed)))) e.commitment = 'unrevealed';
      else e.commitment = 'mismatch';
    }
    e.seed = found ? found.seed : e.commitment === 'none' ? (e.rows.find((r) => r.seed !== null) || {}).seed ?? null : null;
    e.seedLine = found ? found.line : null;
    if (e.commitment === 'none' && e.rows.some((r) => !r.record)) issues.add('COMMITMENT_ABSENT', { epoch: e.hash, line: e.rows[0].line });
    if (e.commitment === 'mismatch') issues.add('COMMITMENT_MISMATCH', { epoch: e.hash, line: e.rows.find((r) => r.seed !== null).line });
    if (e.commitment === 'encoding') issues.add('COMMITMENT_ENCODING', { epoch: e.hash, line: (e.rows.find((r) => r.seed !== null) || e.rows[0]).line });
    if (e.commitment === 'unrevealed' && e.rows.some((r) => !r.record)) issues.add('SEED_UNREVEALED', { epoch: e.hash, detail: { rows: e.rows.filter((r) => !r.record).length } });
    for (const r of e.rows) {
      if (r.seed === null || !r.hash) continue;
      const c = commitOf(r.seed);
      if (c === r.hash) continue;
      if (epochs.has(c)) issues.add('SEED_PAIRED_BY_HASH', { line: r.line, epoch: e.hash });
      else if (e.commitment === 'ok') issues.add('SEED_ROW_MISMATCH', { line: r.line, epoch: e.hash });
    }
    if (e.seed && /^[0-9a-fA-F]+$/.test(e.seed) && e.seed.length < 32) issues.add('SEED_WEAK', { epoch: e.hash, detail: { length: e.seed.length } });
  }

  // 3. order of epochs (by time when every row has one, otherwise as listed)
  const timed = R.every((r) => Number.isFinite(r.time));
  const seq = (timed ? R.slice().sort((a, b) => a.time - b.time || a.line - b.line) : R).filter((r) => r.epoch);
  const runs = [];
  for (const r of seq) if (!runs.length || runs[runs.length - 1].epoch !== r.epoch) runs.push({ epoch: r.epoch, line: r.line });
  if (timed) {
    const seen = new Set();
    for (const run of runs) {
      if (seen.has(run.epoch)) issues.add('SEED_REUSED', { epoch: run.epoch, line: run.line });
      seen.add(run.epoch);
    }
  }
  const order = [];
  for (const run of runs) if (!order.includes(run.epoch)) order.push(run.epoch);

  // forward commitment chain. An export that repeats today's next hash on every row
  // (the same value for every epoch) says nothing about the past: it is not checked.
  const announced = new Set();
  for (const e of epochs.values()) for (const n of e.nexts) announced.add(n);
  const announcing = [...epochs.values()].filter((e) => e.nexts.size).length;
  if (announced.size === 1 && announcing > 1) { issues.add('FORWARD_COLUMN_CONSTANT', {}); announced.clear(); for (const e of epochs.values()) e.nexts.clear(); }
  order.forEach((key, i) => {
    const e = epochs.get(key);
    e.order = i;
    if (e.nexts.size > 1) { e.forward = 'break'; issues.add('FORWARD_BREAK', { epoch: key, detail: { announced: [...e.nexts] } }); return; }
    const n = [...e.nexts][0];
    if (!n) { e.forward = null; return; }
    e.next = n;
    if (epochs.has(n)) e.forward = 'ok';
    else if (i === order.length - 1) e.forward = 'open';
    else { e.forward = 'break'; issues.add('FORWARD_BREAK', { epoch: key, line: e.rows[0].line }); }
  });
  if (announced.size) {
    order.forEach((key, i) => {
      if (i > 0 && !announced.has(key)) { epochs.get(key).announced = false; issues.add('FORWARD_UNANNOUNCED', { epoch: key, line: epochs.get(key).rows[0].line }); }
    });
  }
  // a seed derivable from the previous one (next = SHA-256(previous)) is a weakness
  for (let i = 1; i < order.length; i++) {
    const a = epochs.get(order[i - 1]).seed, b = epochs.get(order[i]).seed;
    if (a && b && (commitText(a) === b.toLowerCase() || (/^[0-9a-f]{64}$/.test(a) && commitHexBytes(a) === b.toLowerCase()))) issues.add('SEED_DERIVABLE', { epoch: order[i] });
  }

  // nonces per seed pair
  for (const e of epochs.values()) {
    e.clientList = [...e.clients];
    if (e.clients.size > 1) issues.add('SERVER_SEED_SHARED', { epoch: e.hash, detail: { clients: e.clients.size } });
    const byPair = new Map();
    for (const r of e.rows) if (r.nonce !== null) { const k = r.client; if (!byPair.has(k)) byPair.set(k, []); byPair.get(k).push(r); }
    e.nonceMin = null; e.nonceMax = null; e.gaps = 0; e.duplicates = 0;
    for (const list of byPair.values()) {
      const byNonce = new Map();
      for (const r of list) { const k = r.nonce.toString(); if (!byNonce.has(k)) byNonce.set(k, []); byNonce.get(k).push(r); }
      for (const [k, same] of byNonce) {
        if (same.length < 2) continue;
        const sig = (r) => Object.values(r.f).join('\u0001');
        const identical = same.every((r) => sig(r) === sig(same[0]));
        e.duplicates += same.length - 1;
        issues.add(identical ? 'DUPLICATE_ROW' : 'NONCE_REUSED', { epoch: e.hash, lines: same.map((r) => r.line), detail: { nonce: k } });
      }
      const ns = [...byNonce.keys()].map(BigInt).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
      if (e.nonceMin === null || ns[0] < e.nonceMin) e.nonceMin = ns[0];
      if (e.nonceMax === null || ns[ns.length - 1] > e.nonceMax) e.nonceMax = ns[ns.length - 1];
      for (let i = 1; i < ns.length; i++) {
        const gap = ns[i] - ns[i - 1] - 1n;
        if (gap > 0n) { e.gaps += Number(gap); issues.add('NONCE_GAP', { epoch: e.hash, detail: { from: (ns[i - 1] + 1n).toString(), to: (ns[i] - 1n).toString() } }); }
      }
      if (adapter.nonceBase !== null && adapter.nonceBase !== undefined && ns[0] > BigInt(adapter.nonceBase)) issues.add('NONCE_START', { epoch: e.hash, detail: { first: ns[0].toString() } });
      if (timed) {
        const byTime = list.slice().sort((a, b) => a.time - b.time);
        for (let i = 1; i < byTime.length; i++) if (byTime[i].time > byTime[i - 1].time && byTime[i].nonce < byTime[i - 1].nonce) { issues.add('NONCE_ORDER', { epoch: e.hash, line: byTime[i].line }); break; }
      }
    }
  }

  // 4. recompute
  const counts = { ok: 0, mismatch: 0, computed: 0, notChecked: 0, notCheckedBy: {} };
  const notChecked = (r, reason) => { counts.notChecked++; counts.notCheckedBy[reason] = (counts.notCheckedBy[reason] || 0) + 1; r.status = 'not-checked'; r.reason = reason; };
  const payout = { checked: 0, ok: 0, mismatch: 0, notChecked: 0 };
  const collectors = new Map();
  let limboDisagree = 0;
  const defaultGame = opts.game && adapter.games[opts.game] ? opts.game : adapter.defaultGame;
  R.forEach((r, i) => {
    if (i % 512 === 0) progress(0.1 + 0.85 * (i / R.length));
    if (r.record) return;
    const named = String(r.f.game ?? '').trim().toLowerCase().replace(/[\s_]+/g, '-');
    const gname = named === '' ? defaultGame : adapter.games[named] ? named : null;
    if (!gname) { notChecked(r, 'game-unknown'); issues.add('GAME_UNKNOWN', { line: r.line, claimed: r.f.game }); return; }
    const game = adapter.games[gname];
    const params = paramsOf(r.f);
    const claimed = r.f.result;
    r.game = gname;
    // published outcomes for the goodness-of-fit test (whether or not the seed is known)
    if (game.stats && claimed !== undefined && String(claimed).trim() !== '') collectPublished(collectors, game, gname, params, claimed, r, opts);
    if (!r.epoch && r.seed === null) { notChecked(r, r.seedMalformed ? 'seed-malformed' : r.hashStatus === 'malformed' ? 'hash-malformed' : 'seed-unrevealed'); return; }
    const e = r.epoch ? epochs.get(r.epoch) : null;
    const seed = e ? e.seed : r.seed;
    if (r.hashStatus === 'malformed' && !seed) { notChecked(r, 'hash-malformed'); return; }
    if (!seed) { notChecked(r, e && e.commitment === 'mismatch' ? 'commitment-mismatch' : e && e.commitment === 'encoding' ? 'commitment-encoding' : 'seed-unrevealed'); return; }
    if (r.nonce === null) { notChecked(r, 'nonce-invalid'); return; }
    let outcome;
    try {
      outcome = computeOutcome(adapter, game, { hmac: keyFor(seed), server: seed, client: r.client, nonceText: r.nonceText }, params, claimed, opts);
    } catch (err) {
      notChecked(r, 'params-invalid'); issues.add('PARAMS_INVALID', { line: r.line, detail: { message: err.en || err.message } }); return;
    }
    r.computed = outcome.display;
    if (gname === 'limbo' && outcome.otherCents !== outcome.cents) limboDisagree++;
    if (claimed === undefined || String(claimed).trim() === '') { counts.computed++; r.status = 'computed'; return; }
    const cmp = game.compare(outcome, claimed);
    if (cmp === 'match') { counts.ok++; r.status = 'ok'; }
    else if (cmp === 'mismatch') {
      counts.mismatch++; r.status = 'mismatch';
      issues.add('RESULT_MISMATCH', { line: r.line, expected: outcome.display, claimed: String(claimed).slice(0, 120), game: gname });
    } else if (cmp === 'edge') { notChecked(r, 'edge-case'); issues.add('EDGE_CASE', { line: r.line, detail: { edge: outcome.edge } }); return; }
    else { notChecked(r, 'result-unparsable'); issues.add('RESULT_UNPARSABLE', { line: r.line, claimed: String(claimed).slice(0, 80) }); return; }
    checkPayout(game, gname, outcome, params, r, opts, payout, issues);
  });
  if (limboDisagree) issues.add('LIMBO_FORMULAS_DISAGREE', { detail: { rows: limboDisagree } });

  const epochList = order.concat([...epochs.keys()].filter((k) => !order.includes(k))).map((k) => {
    const e = epochs.get(k);
    const st = { ok: 0, mismatch: 0, notChecked: 0 };
    for (const r of e.rows) { if (r.status === 'ok') st.ok++; else if (r.status === 'mismatch') st.mismatch++; else if (r.status === 'not-checked') st.notChecked++; }
    const rounds = e.rows.filter((r) => !r.record);
    return {
      hash: e.hash, commitment: e.commitment, seedLine: e.seedLine, seed: e.seed ? (e.seed.length > 80 ? e.seed.slice(0, 77) + '…' : e.seed) : null,
      clients: e.clientList, rows: rounds.length, records: e.rows.length - rounds.length, firstLine: e.rows[0].line,
      nonceMin: e.nonceMin === null ? null : e.nonceMin.toString(), nonceMax: e.nonceMax === null ? null : e.nonceMax.toString(),
      gaps: e.gaps, duplicates: e.duplicates, next: e.next || null, forward: e.forward ?? null, announced: e.announced !== false, ...st,
    };
  });
  return { R, counts, payout, collectors, epochs: epochList, timed, records: R.filter((r) => r.record).length };
}

// ---------- combined-seed audits (Aviator) ----------

function auditCombined(rows, adapter, opts, issues) {
  const game = adapter.games[adapter.defaultGame];
  const counts = { ok: 0, mismatch: 0, computed: 0, notChecked: 0, notCheckedBy: {} };
  const collectors = new Map();
  const nc = (r, reason) => { counts.notChecked++; counts.notCheckedBy[reason] = (counts.notCheckedBy[reason] || 0) + 1; r.status = 'not-checked'; r.reason = reason; };
  const R = rows.map((r) => {
    const out = { line: r.line, f: r.f };
    const server = normalizeSeed(r.f.server, { exact: !!opts.exactSeeds });
    let clients = [r.f.client, r.f.client2, r.f.client3].filter((x) => x !== undefined && String(x).trim() !== '');
    if (clients.length === 1 && /[|;]/.test(clients[0])) clients = clients[0].split(/[|;]/);
    clients = clients.map((c) => normalizeSeed(c, { exact: !!opts.exactSeeds }).value);
    if (game.stats && String(r.f.result ?? '').trim() !== '') {
      if (!collectors.has('crash')) collectors.set('crash', makeCollector(game.stats, opts, { game: 'crash' }));
      collectors.get('crash').add(r.f.result, out);
    }
    if (server.empty) { nc(out, 'seed-unrevealed'); return out; }
    if (clients.length !== 3) { nc(out, 'params-invalid'); issues.add('PARAMS_INVALID', { line: r.line, detail: { message: 'three client seeds are needed' } }); return out; }
    const o = game.compute(server.value, clients);
    out.computed = o.display;
    const claimed = r.f.result;
    if (claimed === undefined || String(claimed).trim() === '') { counts.computed++; out.status = 'computed'; return out; }
    const cmp = game.compare(o, claimed);
    if (cmp === 'match') { counts.ok++; out.status = 'ok'; }
    else if (cmp === 'mismatch') { counts.mismatch++; out.status = 'mismatch'; issues.add('RESULT_MISMATCH', { line: r.line, expected: o.display, claimed: String(claimed).slice(0, 60) }); }
    else if (cmp === 'edge') { nc(out, 'edge-case'); issues.add('EDGE_CASE', { line: r.line, detail: { edge: o.edge, computed: o.display } }); }
    else { nc(out, 'result-unparsable'); issues.add('RESULT_UNPARSABLE', { line: r.line }); }
    return out;
  });
  return { R, counts, payout: { checked: 0, ok: 0, mismatch: 0, notChecked: 0 }, collectors, epochs: [] };
}

// ---------- hash-chain audits ----------

function auditChain(rows, adapter, opts, issues, progress) {
  const counts = { ok: 0, mismatch: 0, computed: 0, notChecked: 0, notCheckedBy: {} };
  const nc = (r, reason) => { counts.notChecked++; counts.notCheckedBy[reason] = (counts.notCheckedBy[reason] || 0) + 1; r.status = 'not-checked'; r.reason = reason; };
  const payout = { checked: 0, ok: 0, mismatch: 0, notChecked: 0 };
  const collectors = new Map();
  const eras = {};
  const R = rows.map((r) => {
    const out = { line: r.line, f: r.f };
    const h = normalizeHash(r.f.gameHash);
    out.hash = h.status === 'ok' ? h.value : null;
    if (h.status === 'malformed') issues.add('HASH_MALFORMED', { line: r.line, claimed: String(r.f.gameHash).slice(0, 80) });
    const id = parseNonce(r.f.gameId);
    out.gameId = id.error || id.value > BigInt(Number.MAX_SAFE_INTEGER) ? null : Number(id.value);
    out.era = adapter.eraFor(out.gameId, opts);
    eras[out.era.id] = (eras[out.era.id] || 0) + 1;
    return out;
  });
  const surv = { type: 'multiplier', survival: (m) => adapter.survival(m) };
  R.forEach((r, i) => {
    const claimed = r.f.result;
    if (String(claimed ?? '').trim() !== '') {
      const k = r.era.computable ? 'crash' : null;
      if (k) { if (!collectors.has(k)) collectors.set(k, makeCollector(surv, opts, { game: 'crash' })); collectors.get(k).add(claimed, r); }
    }
    if (!r.hash) { nc(r, r.f.gameHash ? 'hash-malformed' : 'hash-missing'); return; }
    if (!r.era.computable) { nc(r, 'era-unsupported'); issues.add('ERA_UNSUPPORTED', { line: r.line, detail: { era: r.era.id } }); return; }
    const o = adapter.result(r.hash, r.era, opts);
    r.computed = Number.isFinite(o.raw) ? (o.cents / 100).toFixed(2) : '∞';
    if (o.edge) { nc(r, 'edge-case'); issues.add('EDGE_CASE', { line: r.line, detail: { edge: o.edge } }); return; }
    if (String(claimed ?? '').trim() === '') { counts.computed++; r.status = 'computed'; }
    else {
      const v = parseNumber(claimed);
      const cmp = v === null ? 'unparsable' : (Math.abs(v * 100 - o.cents) < 1e-6 || Math.abs(v - o.raw) <= 1e-12 * Math.max(1, o.raw)) ? 'match' : 'mismatch';
      if (cmp === 'match') { counts.ok++; r.status = 'ok'; }
      else if (cmp === 'mismatch') { counts.mismatch++; r.status = 'mismatch'; issues.add('RESULT_MISMATCH', { line: r.line, expected: r.computed, claimed: String(claimed).slice(0, 40) }); }
      else { nc(r, 'result-unparsable'); issues.add('RESULT_UNPARSABLE', { line: r.line }); }
    }
    const cash = parseNumber(r.f.cashout);
    if (cash !== null && r.status !== 'not-checked') {
      const game = { win: () => o.cents >= Math.round(cash * 100), multiplier: () => cash };
      checkPayout(game, 'crash', o, {}, r, opts, payout, issues);
    }
    if (i % 512 === 0) progress(0.05 + 0.25 * (i / R.length));
  });

  // chain links between listed games
  const chain = { linksChecked: 0, linksWalked: 0, breaks: 0, gapsBridged: 0, order: null, terminating: null, eras };
  const valid = R.filter((r) => r.hash);
  const budget = { left: opts.maxLinks ?? 20000000 };
  const linkOf = (era) => (adapter.linkFor ? adapter.linkFor(era) : null);
  const walk = (from, n, era) => {
    const fn = linkOf(era);
    const h = hexToBytes(from);
    for (let k = 0; k < n; k++) fn(h, h);
    chain.linksWalked += n;
    return bytesToHex(h);
  };
  if (valid.length && valid.every((r) => r.gameId !== null)) {
    chain.order = 'game-id';
    const byId = valid.slice().sort((a, b) => b.gameId - a.gameId);
    for (let i = 1; i < byId.length; i++) {
      const a = byId[i - 1], b = byId[i];
      if (a.gameId === b.gameId) {
        if (a.hash !== b.hash) issues.add('GAME_ID_CONFLICT', { lines: [a.line, b.line], detail: { gameId: a.gameId } });
        else issues.add('DUPLICATE_ROW', { lines: [a.line, b.line] });
        continue;
      }
      if (a.era.chain !== b.era.chain) continue; // different chains (bustabit eras)
      const gap = a.gameId - b.gameId;
      if (gap > budget.left) { issues.add('CHAIN_GAP_SKIPPED', { lines: [a.line, b.line], detail: { gap } }); continue; }
      budget.left -= gap;
      chain.linksChecked++;
      if (gap > 1) chain.gapsBridged++;
      if (walk(a.hash, gap, a.era) !== b.hash) { chain.breaks++; issues.add('CHAIN_BREAK', { lines: [a.line, b.line], detail: { fromGame: a.gameId, toGame: b.gameId } }); }
      if (i % 256 === 0) progress(0.3 + 0.3 * (i / byId.length));
    }
    const seenHash = new Map();
    for (const r of valid) { if (seenHash.has(r.hash) && seenHash.get(r.hash) !== r.gameId) issues.add('GAME_ID_CONFLICT', { line: r.line, detail: { hash: r.hash } }); seenHash.set(r.hash, r.gameId); }
  } else if (valid.length > 1) {
    // No game ids: find the listing direction, then check each neighbour pair, bridging
    // up to 1,000 missing games before calling a pair a break.
    const linked = (x, y, era) => walk(x.hash, 1, era) === y.hash;
    let newest = 0, oldest = 0;
    for (let i = 1; i < Math.min(valid.length, 20); i++) {
      if (linked(valid[i - 1], valid[i], valid[i - 1].era)) newest++;
      else if (linked(valid[i], valid[i - 1], valid[i].era)) oldest++;
    }
    if (!newest && !oldest) issues.add('CHAIN_ORDER_UNKNOWN', {});
    else {
      chain.order = newest >= oldest ? 'newest-first' : 'oldest-first';
      for (let i = 1; i < valid.length; i++) {
        const [a, b] = chain.order === 'newest-first' ? [valid[i - 1], valid[i]] : [valid[i], valid[i - 1]];
        chain.linksChecked++;
        if (a.hash === b.hash) { issues.add('DUPLICATE_ROW', { lines: [a.line, b.line] }); continue; }
        const fn = linkOf(a.era), h = hexToBytes(a.hash);
        let k = 0, ok = false;
        while (k < 1000) { fn(h, h); k++; if (bytesToHex(h) === b.hash) { ok = true; break; } }
        chain.linksWalked += k;
        if (ok && k > 1) { chain.gapsBridged++; issues.add('GAME_GAP', { lines: [a.line, b.line], detail: { missing: k - 1 } }); }
        if (!ok) { chain.breaks++; issues.add('CHAIN_BREAK', { lines: [a.line, b.line] }); }
      }
    }
  }

  // optional walk from the oldest listed game to the published terminating hash
  if (opts.walkTerminating && valid.length) {
    const ids = valid.every((r) => r.gameId !== null);
    const oldest = ids ? valid.reduce((m, r) => (r.gameId < m.gameId ? r : m)) : chain.order === 'oldest-first' ? valid[0] : valid[valid.length - 1];
    const era = oldest.era;
    const target = normalizeHash(opts.terminating || era.terminating || adapter.terminating || '').value;
    if (!target) chain.terminating = { status: 'no-target' };
    else if (ids && era.chainStart) {
      const need = oldest.gameId - era.chainStart + 1;
      const w = walkChain(hexToBytes(oldest.hash), need, era.link === 'hex' ? 'hex' : 'raw', { onStep: (k) => { progress(0.6 + 0.4 * (k / need)); return false; } });
      chain.linksWalked += need;
      const got = bytesToHex(w.hash);
      chain.terminating = { status: got === target ? 'ok' : 'mismatch', links: need, fromGame: oldest.gameId, target, got };
      issues.add(got === target ? 'TERMINATING_OK' : 'TERMINATING_MISMATCH', { line: oldest.line, detail: { links: need } });
    } else {
      const max = opts.maxTerminatingLinks ?? adapter.chainLength ?? 10000000;
      const k = linksUntil(hexToBytes(oldest.hash), hexToBytes(target), max, era.link === 'hex' ? 'hex' : 'raw', { onStep: (n) => { progress(0.6 + 0.4 * (n / max)); return false; } });
      chain.linksWalked += k >= 0 ? k : max;
      chain.terminating = { status: k >= 0 ? 'ok' : 'not-reached', links: k >= 0 ? k : null, max, target };
      issues.add(k >= 0 ? 'TERMINATING_OK' : 'TERMINATING_NOT_REACHED', { line: oldest.line, detail: { links: k >= 0 ? k : null } });
    }
  }
  return { R, counts, payout, collectors, epochs: [], chain };
}

// ---------- entry point ----------

// adapterOrKey: an adapter object or its key ("stake@v1"). opts: { game, exactSeeds,
// limboFormula, tileBase, paytable, payoutTolerance, era, walkTerminating,
// terminating, salt, maxLinks, alpha, disabled: { key: reason } }.
export function auditRounds(rows, adapterOrKey, opts = {}, onProgress = () => {}) {
  const adapter = typeof adapterOrKey === 'string' ? getAdapter(adapterOrKey) : adapterOrKey;
  if (!adapter) throw pfError('محوّل غير معروف', 'Unknown adapter');
  const key = adapterKey(adapter);
  if (opts.disabled && opts.disabled[key]) {
    const names = [].concat(opts.disabled[key]).join('; ');
    throw pfError(`هذا المحوّل معطّل لأن متجهًا ذهبيًا فشل في الفحص الذاتي: ${names}`, `This adapter is disabled because a golden vector failed the self-test: ${names}`);
  }
  const issues = new Issues();
  const progress = (v) => onProgress(Math.min(1, Math.max(0, v)));
  const t = adapter.kind === 'chain' ? auditChain(rows, adapter, opts, issues, progress)
    : adapter.kind === 'combined' ? auditCombined(rows, adapter, opts, issues)
      : auditSeeded(rows, adapter, opts, issues, progress);
  const uniformity = runUniformity(t.collectors, issues, opts.alpha ?? ALPHA);
  if (adapter.evidence === 'unconfirmed') issues.add('UNCONFIRMED_FORMULA', {});
  const verdict = verdictOf(issues, t.counts, adapter.evidence);
  progress(1);
  const rowsOut = t.R.filter((r) => r.status === 'mismatch' || r.status === 'not-checked').slice(0, 200)
    .map((r) => ({ line: r.line, status: r.status, reason: r.reason || null, game: r.game || null, computed: r.computed ?? null, claimed: r.f.result !== undefined ? String(r.f.result).slice(0, 120) : null }));
  return {
    adapter: { key, id: adapter.id, version: adapter.version, evidence: adapter.evidence, kind: adapter.kind },
    options: { game: opts.game || adapter.defaultGame || null, exactSeeds: !!opts.exactSeeds, limboFormula: opts.limboFormula || 'calc24', tileBase: Number(opts.tileBase) === 1 ? 1 : 0, paytable: !!opts.paytable, walkTerminating: !!opts.walkTerminating, era: opts.era || null },
    rows: rows.length - (t.records || 0),
    records: t.records || 0,
    counts: t.counts,
    payout: t.payout,
    epochs: t.epochs,
    chain: t.chain || null,
    uniformity: uniformity.map((u) => ({ game: u.group.game, group: u.group, type: u.type, n: u.n, chi2: u.chi2 ?? null, df: u.df ?? null, pValue: u.pValue ?? null, status: u.status })),
    issues: issues.list,
    issueCounts: issues.counts,
    problemRows: rowsOut,
    verdict,
  };
}

export function auditCsv(text, adapterOrKey, opts = {}, onProgress = () => {}) {
  const adapter = typeof adapterOrKey === 'string' ? getAdapter(adapterOrKey) : adapterOrKey;
  if (!adapter) throw pfError('محوّل غير معروف', 'Unknown adapter');
  const { rows, columns } = parsePfCsv(text, adapter.kind);
  if (!rows.length) throw pfError('لا توجد صفوف في الملف', 'The file has no rows');
  const need = adapter.kind === 'chain' ? ['gameHash'] : adapter.kind === 'combined' ? ['server'] : ['nonce'];
  const missing = need.filter((c) => !columns.includes(c));
  if (missing.length) throw pfError(`أعمدة ناقصة: ${missing.join(', ')}`, `Missing columns: ${missing.join(', ')}`);
  return { ...auditRounds(rows, adapter, opts, onProgress), columns };
}

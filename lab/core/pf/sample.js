// Example rounds for each adapter, generated locally (nothing is downloaded).
// Seeded schemes get three revealed seed epochs with a forward commitment chain;
// bustabit and BC.Game samples start from a real published game hash (so the chain
// walk reaches bustabit's real terminating hash); the others use random seeds.
// With `plant`, a few known problems are added so the audit can be seen catching them.
import { hexToBytes, bytesToHex, linkHex } from '../sha256-sync.js';
import { getAdapter, adapterKey } from './registry.js';
import { computeOutcome } from './audit.js';

const csvCell = (v) => (/[",\n]/.test(String(v)) ? '"' + String(v).replace(/"/g, '""') + '"' : String(v));
const toCsv = (cols, rows) => [cols.join(','), ...rows.map((r) => cols.map((c) => csvCell(r[c] ?? '')).join(','))].join('\n') + '\n';

const REAL_START = {
  bustabit: { gameId: 12306896, hash: '94aa062026624e59a0ace092568d5f46e21b9bf1d5173609db8645dd62bdfc44' },
  'bcgame-crash': { gameId: 5098240, hash: 'bdbdf909aadd399c54b9c4abff1f9ec52a1e0d27be4121294b593ebe8bc7e376' },
};

// rand(n) -> Uint8Array of n random bytes.
export function makeSample(key, { rounds = 600, plant = false, rand, start = Date.UTC(2026, 9, 1, 12) } = {}) {
  const adapter = getAdapter(key);
  if (!adapter) throw new Error('unknown adapter ' + key);
  const hex = (n) => bytesToHex(rand(n));
  const u = () => { const b = rand(4); return ((b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3]) >>> 0; };
  const pick = (list) => list[u() % list.length];
  const time = (i) => new Date(start + i * 7000).toISOString();
  const k = adapterKey(adapter);
  const name = `sample-${adapter.id}-${adapter.version}${plant ? '-planted' : ''}.csv`;

  if (adapter.kind === 'chain') {
    const real = REAL_START[adapter.id];
    let h = hexToBytes(real ? real.hash : hex(32));
    let gameId = real ? real.gameId : 4000000 + (u() % 1000000);
    const rows = [];
    for (let i = 0; i < rounds; i++) {
      const hashHex = bytesToHex(h);
      const era = adapter.eraFor(gameId, {});
      const r = adapter.result(hashHex, era, {});
      const cash = pick([1.5, 2, 2, 3, 10]);
      const won = r.cents >= cash * 100;
      rows.push({ game_id: gameId, hash: hashHex, result: Number.isFinite(r.raw) ? (r.cents / 100).toFixed(2) : '', cashout: cash, bet: 1, payout: won ? cash : 0 });
      const link = adapter.linkFor ? adapter.linkFor(era) : linkHex;
      h = link(h);
      gameId--;
    }
    if (plant) {
      rows[5].result = (Number(rows[5].result) + 1).toFixed(2); // tampered result
      rows[40].hash = hex(32); rows[40].result = (adapter.result(rows[40].hash, adapter.eraFor(rows[40].game_id, {}), {}).cents / 100).toFixed(2); // foreign hash
      rows[70].payout = rows[70].payout ? 0 : rows[70].cashout; // wrong payout
    }
    return { name, text: toCsv(['game_id', 'hash', 'result', 'cashout', 'bet', 'payout'], rows), options: { walkTerminating: adapter.id === 'bustabit' }, rows: rows.length, key: k };
  }

  if (adapter.kind === 'combined') {
    const rows = [];
    for (let i = 0; i < rounds; i++) {
      const server = hex(32), c = [hex(8), hex(8), hex(8)];
      const o = adapter.games.crash.compute(server, c);
      rows.push({ round_id: 100000 + i, server_seed: server, client_seed_1: c[0], client_seed_2: c[1], client_seed_3: c[2], result: o.display });
    }
    if (plant) rows[3].result = (Number(rows[3].result) + 0.5).toFixed(2);
    return { name, text: toCsv(['round_id', 'server_seed', 'client_seed_1', 'client_seed_2', 'client_seed_3', 'result'], rows), options: {}, rows: rows.length, key: k };
  }

  // Seeded schemes: three epochs, each announcing the next one's hash.
  const epochs = 3;
  const per = Math.max(10, Math.floor(rounds / epochs));
  const seeds = Array.from({ length: epochs + 1 }, () => hex(32));
  const hashes = seeds.map((s) => adapter.commit(s));
  const games = adapter.id === 'stake' ? ['dice', 'dice', 'dice', 'limbo', 'keno', 'plinko', 'mines'] : [adapter.defaultGame];
  const base = adapter.nonceBase ?? 0;
  const rows = [];
  let t = 0, betId = 900000;
  for (let e = 0; e < epochs; e++) {
    const client = 'player-' + hex(4);
    const hmac = adapter.hmacKey(seeds[e]);
    for (let i = 0; i < per; i++) {
      const g = pick(games);
      const game = adapter.games[g];
      const nonceText = String(base + i);
      const params = {};
      const row = { time: time(t++), bet_id: betId++, game: g, server_seed: seeds[e], server_seed_hash: hashes[e], next_server_seed_hash: hashes[e + 1], client_seed: client, nonce: nonceText, bet: 1 };
      if (g === 'dice' || g === 'classic-dice') { const over = u() % 2 === 0; Object.assign(params, { target: over ? '50.50' : '49.50', condition: over ? 'over' : 'under' }); }
      if (g === 'limbo') params.target = '2';
      if (g === 'plinko') Object.assign(params, { rows: 8, risk: 'low' });
      if (g === 'mines') params.mines = 3;
      const o = computeOutcome(adapter, game, { hmac, server: seeds[e], client, nonceText }, params, '', {});
      Object.assign(row, params, { result: o.display.replace(/ \(\d+\)$/, '') });
      if (g === 'plinko') row.result = o.path;
      const win = game.win ? game.win(o, params) : null;
      const mult = win === false ? 0 : game.multiplier ? game.multiplier(o, params, { rtp: 0.99 }) : null;
      if (mult !== null && win !== null) { row.multiplier = win ? mult.toFixed(4) : ''; row.payout = +(mult).toFixed(8); }
      rows.push(row);
    }
  }
  if (plant) {
    const dice = rows.findIndex((r, i) => i > 3 && /dice/.test(r.game));
    rows[dice].result = (Number(rows[dice].result) + (Number(rows[dice].result) >= 99 ? -0.01 : 0.01)).toFixed(2); // tampered result
    rows.splice(per + 7, 1); // a missing nonce in epoch 2
    const won = rows.findIndex((r) => Number(r.payout) > 0);
    if (won >= 0) rows[won].payout = +(Number(rows[won].payout) * 1.5).toFixed(8); // wrong payout
    // the first seed comes back after the others were used (a replay of nonces 0..2)
    for (let i = 0; i < 3; i++) rows.push({ ...rows[i], time: time(t++), bet_id: betId++ });
  }
  const cols = ['time', 'bet_id', 'game', 'server_seed', 'server_seed_hash', 'next_server_seed_hash', 'client_seed', 'nonce', 'target', 'condition', 'rows', 'risk', 'mines', 'bet', 'multiplier', 'payout', 'result'];
  return { name, text: toCsv(cols, rows), options: { paytable: { dice: { rtp: 0.99 }, 'classic-dice': { rtp: 0.99 } } }, rows: rows.length, key: k };
}


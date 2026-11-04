// Runs every heavy calculation off the page's main thread. Nothing here uses the
// network: inputs arrive as bytes from the page and results go back by postMessage.
import { normalizeModel, canonicalJson } from './core/slot-model.js';
import { analyzeExact } from './core/slot-exact.js';
import { parsePlayLog, analyzePlayLog } from './core/actual.js';
import { parseRngInput, chiSquareUniform, serialCorrelation } from './core/rng-basic.js';
import { runNist, runNistMulti, assessFamily } from './core/nist.js';
import { parseFairCsv, verifyHmacRounds, verifyHashChain, sha256Hex, hmacSha256, floatFromBytes, mapOutcome, toHex } from './core/fair.js';
import { prngFromSeed, PRNG_DESCRIPTION } from './core/prng.js';
import { simulate } from './core/montecarlo.js';
import { sampler, slotSampler, simulatePlayers } from './core/casino.js';
import { verifyReportPdf } from './core/report-sign.js';

const decode = (bytes) => new TextDecoder().decode(bytes);
const encode = (text) => new TextEncoder().encode(text);

// Keeps P-values and scalar statistics; drops large per-block arrays.
function slimNist(n) {
  return {
    n: n.n, alpha: n.alpha, twoLevel: !!n.twoLevel, sequenceLength: n.sequenceLength || null, sequences: n.sequences || null,
    results: n.results.map((r) => {
      const stats = {};
      for (const [k, v] of Object.entries(r.stats || {})) if (!Array.isArray(v) || v.length <= 20) stats[k] = v;
      const out = { id: r.id, applicable: r.applicable, requirement: r.requirement, reason: r.reason, pass: r.pass, status: r.status, pValues: r.pValues, stats };
      if (n.twoLevel && r.applicable) {
        Object.assign(out, { sequences: r.sequences, subtestsFailing: r.subtestsFailing, subtestsExpectedFailing: r.subtestsExpectedFailing, minProportion: r.minProportion, minUniformityP: r.minUniformityP, subtestCount: r.subtests.length });
        if (r.subtests.length <= 20) out.subtests = r.subtests;
      }
      return out;
    }),
  };
}

const TASKS = {
  exact: ({ raw }, progress) => analyzeExact(normalizeModel(raw), { onProgress: progress }),

  actual: ({ bytes, options }) => {
    const log = parsePlayLog(decode(bytes));
    return { ...analyzePlayLog(log, options), skipped: log.skipped.length, skippedSample: log.skipped.slice(0, 20) };
  },

  rng: ({ bytes, options }, progress) => {
    const parsed = parseRngInput(new Uint8Array(bytes), options);
    if (parsed.bits.length < 100) throw Object.assign(new Error('need at least 100 bits'), { ar: 'يلزم 100 بت على الأقل', en: 'At least 100 bits are needed' });
    const nist = slimNist(options.twoLevel ? runNistMulti(parsed.bits, { onProgress: progress }) : runNist(parsed.bits, { onProgress: progress }));
    const chi = chiSquareUniform(parsed.values, parsed.min, parsed.max);
    const serial = serialCorrelation(parsed.values);
    // One family verdict over every P-value shown, including the two value-level tests.
    const family = assessFamily([
      ...nist.results,
      { id: 'chiSquare', applicable: chi.enoughData, pValues: [chi.pValue], pass: chi.pass },
      { id: 'serialCorr', applicable: true, pValues: [serial.pValue], pass: serial.pass },
    ], nist.alpha);
    nist.results.forEach((r, i) => { r.status = family.statuses[i]; });
    const k = nist.results.length;
    chi.status = chi.enoughData ? family.statuses[k] : chi.pass ? 'pass' : 'flag';
    serial.status = family.statuses[k + 1];
    delete family.statuses;
    return {
      parsed: { kind: parsed.kind, nBits: parsed.bits.length, nValues: parsed.values.length, min: parsed.min, max: parsed.max, notes: parsed.notes },
      nist, chi, serial, family,
    };
  },

  fair: async ({ bytes, scheme, options }, progress) => {
    if (scheme === 'chain') return verifyHashChain(decode(bytes).split(/[\s,;]+/), options, progress);
    const { rows } = parseFairCsv(decode(bytes));
    return verifyHmacRounds(rows, options, progress);
  },

  montecarlo: async ({ raw, seed, spins, modelSha256 }, progress) => {
    const sim = simulate(normalizeModel(raw), await prngFromSeed(seed), spins, { onProgress: progress });
    const run = { modelSha256, seed, spins, generator: PRNG_DESCRIPTION, result: sim };
    return { ...run, resultSha256: await sha256Hex(canonicalJson(run)) };
  },

  // Many players through one session of a casino game (casino.html).
  players: async ({ kind, dist, raw, seed, options }, progress) => {
    const draw = kind === 'slot' ? slotSampler(normalizeModel(raw)) : sampler(dist);
    return simulatePlayers(draw, await prngFromSeed(seed), { ...options, onProgress: progress });
  },

  // Example inputs, generated locally.
  samplePlayLog: async ({ raw, rounds, seed }, progress) => {
    const model = normalizeModel(raw);
    const rng = await prngFromSeed(seed);
    const lines = ['bet,win'];
    const step = Math.max(1, Math.floor(rounds / 50));
    for (let i = 0; i < rounds; i++) {
      const s = simulate(model, rng, 1, { progressEvery: 2 });
      lines.push('1,' + +(s.totalWinUnits / model.totalBetUnits).toFixed(6));
      if (i % step === 0) progress(i / rounds);
    }
    return encode(lines.join('\n') + '\n');
  },

  sampleFair: async ({ rounds, options }) => {
    const lines = ['server_seed,server_seed_hash,client_seed,nonce,result'];
    const client = 'player-' + toHex(crypto.getRandomValues(new Uint8Array(4)));
    let server = '', hash = '';
    for (let i = 0; i < rounds; i++) {
      if (i % 1000 === 0) { server = toHex(crypto.getRandomValues(new Uint8Array(32))); hash = await sha256Hex(server); }
      const f = floatFromBytes(await hmacSha256(server, `${client}:${i}`));
      const v = mapOutcome(f, { type: options.outcomeType, range: options.range, offset: options.offset });
      lines.push([server, hash, client, i, options.outcomeType === 'float' ? v.toFixed(12) : v].join(','));
    }
    return encode(lines.join('\n') + '\n');
  },

  sampleChain: async ({ length }) => {
    const chain = [toHex(crypto.getRandomValues(new Uint8Array(32)))];
    for (let i = 1; i < length; i++) chain.unshift(await sha256Hex(chain[0]));
    return encode(chain.join('\n') + '\n');
  },

  // ---- signed reports: check a report PDF (signatures, attached files) ----
  verifyReport: ({ bytes, trusted, originals }) => verifyReportPdf(bytes, { trustedFingerprint: trusted, originals: originals || [] }),
};

self.onmessage = async (e) => {
  const { id, task, payload } = e.data;
  const progress = (value) => self.postMessage({ id, type: 'progress', value });
  try {
    const result = await TASKS[task](payload, progress);
    self.postMessage({ id, type: 'result', result });
  } catch (err) {
    self.postMessage({ id, type: 'error', error: { message: err.message, ar: err.ar || null, en: err.en || null } });
  }
};

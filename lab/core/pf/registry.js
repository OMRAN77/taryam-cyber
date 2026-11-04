// Versioned operator adapters for provably-fair verification. Each adapter states
// where its algorithm comes from and how strong that evidence is:
//   verified     replay agrees with captured rounds (disclosed seeds, or a published
//                results feed) from the cited source
//   reference    implements published documentation or third-party code only
//   unconfirmed  a third-party reconstruction nobody has matched to the operator
// Every adapter carries golden vectors quoted from its sources; selfTest() runs them
// (the Worker does so at startup) and an adapter whose vectors fail is disabled.
import { stake, stakeCrash, stakeSlide } from './stake.js';
import { bustabit } from './bustabit.js';
import { bcgameCrash, bcgameDice, bcgameDiceLegacy } from './bcgame.js';
import { primedice } from './primedice.js';
import { duel } from './duel.js';
import { duelbits } from './duelbits.js';
import { aviator } from './aviator-unofficial.js';
import { roobet } from './roobet-unofficial.js';

export const ADAPTERS = [stake, stakeCrash, stakeSlide, bustabit, primedice, duelbits, duel, bcgameDice, bcgameDiceLegacy, bcgameCrash, aviator, roobet];
export const EVIDENCE_LEVELS = ['verified', 'reference', 'unconfirmed'];

export const adapterKey = (a) => `${a.id}@${a.version}`;
const BY_KEY = new Map(ADAPTERS.map((a) => [adapterKey(a), a]));

// "stake" or "stake@v1"; without a version, the first listed (current) one.
export function getAdapter(key) {
  if (BY_KEY.has(key)) return BY_KEY.get(key);
  return ADAPTERS.find((a) => a.id === key) || null;
}

// Deep equality for vector results (numbers compare exactly, Infinity included).
export function same(a, b) {
  if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => same(x, b[i]));
  return Object.is(a, b) || a === b;
}

export function runVectors(adapter) {
  return (adapter.vectors || []).map((v) => {
    let got, error = null;
    try { got = v.got(); } catch (e) { error = e.message; }
    return { name: v.name, source: v.source, ok: error === null && same(got, v.expect), got: error ? null : got, expect: v.expect, error };
  });
}

// { key: { ok, passed, total, failures: [...] } } for every adapter.
export function selfTest(adapters = ADAPTERS) {
  const out = {};
  for (const a of adapters) {
    const results = runVectors(a);
    const failures = results.filter((r) => !r.ok);
    out[adapterKey(a)] = { ok: failures.length === 0 && results.length > 0, passed: results.length - failures.length, total: results.length, failures };
  }
  return out;
}

// { key: [names of failed vectors] } for the adapters to disable.
export function disabledAdapters(tests) {
  const out = {};
  for (const [k, t] of Object.entries(tests)) if (!t.ok) out[k] = t.failures.map((f) => f.name);
  return out;
}

// Plain metadata for the page (functions stripped).
export function describeAdapter(a, test = null) {
  return {
    key: adapterKey(a), id: a.id, version: a.version, kind: a.kind, name: a.name,
    sourceUrl: a.sourceUrl, sources: a.sources || [], captureDate: a.captureDate, evidence: a.evidence, notes: a.notes,
    keyEncoding: a.keyEncoding || null, commitment: a.commitment || null, nonceBase: a.nonceBase ?? null, link: a.link || null,
    games: Object.fromEntries(Object.entries(a.games || {}).map(([g, d]) => [g, { formula: d.formula || null, params: d.params || [] }])),
    defaultGame: a.defaultGame || null, options: a.options || {}, eraOption: a.eraOption || null,
    terminating: a.terminating || null, salt: a.salt || null,
    selfTest: test ? { ok: test.ok, passed: test.passed, total: test.total, failures: test.failures.map((f) => ({ name: f.name, error: f.error })) } : null,
  };
}

export const listAdapters = (tests = null) => ADAPTERS.map((a) => describeAdapter(a, tests ? tests[adapterKey(a)] : null));

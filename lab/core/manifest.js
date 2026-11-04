// The reproducibility manifest that goes inside report.json: what another auditor
// needs to rerun every figure (the SHA-256 of each input, the model hash, the Monte
// Carlo generator and seed), the references the methods follow, and where the lab
// knowingly departs from them. Everything here is static or comes from the session:
// nothing has to be regenerated when the code changes.

// Bump by hand when a change alters a result or the report format.
export const LAB_VERSION = '2026.11.2';

// Inputs larger than this are not attached inside the PDF; the report keeps their
// SHA-256 only, and the original file is needed to check them.
export const ATTACH_LIMIT_BYTES = 25 * 1024 * 1024; // 25 MiB = 26,214,400 bytes

export const REPORT_FILE = 'report.json';
export const SIGNATURE_FILE = 'report.sig';

export function reportIdFor(createdAt, digest) {
  return 'TRL-' + String(createdAt).slice(0, 10).replace(/-/g, '') + '-' + String(digest).slice(0, 8).toUpperCase();
}

// Attachment names: the input's own name unless it is reserved or would collide
// with another one (PDF name-tree keys keep ASCII only; extraction folders may
// ignore case), in which case the input id is put in front.
export function planAttachments(inputs, { limit = ATTACH_LIMIT_BYTES } = {}) {
  const used = new Set([REPORT_FILE, SIGNATURE_FILE]);
  const keyOf = (name) => name.replace(/[^\x20-\x7e]/g, '?').toLowerCase();
  return inputs.map((i) => {
    if (i.size > limit) return { ...i, attachment: null };
    let name = i.name || i.id;
    for (let n = 1; used.has(keyOf(name)); n++) name = `${i.id}${n > 1 ? n : ''}-${i.name || i.id}`;
    used.add(keyOf(name));
    return { ...i, attachment: name };
  });
}

const REFERENCES = [
  { id: 'FIPS 180-4', title: 'Secure Hash Standard', usedFor: 'SHA-256 of every input, of report.json and of the PDF' },
  { id: 'PDF 1.4', title: 'Portable Document Format, embedded files', usedFor: 'inputs, report.json and report.sig carried inside the PDF' },
  { id: 'RFC 8032', title: 'Edwards-Curve Digital Signature Algorithm', usedFor: 'Ed25519 report signature', when: (s) => s.signer && s.signer.alg === 'Ed25519' },
  { id: 'FIPS 186-5', title: 'Digital Signature Standard', usedFor: 'ECDSA P-256 / SHA-256 report signature (used where Ed25519 is not available)', when: (s) => s.signer && s.signer.alg === 'ECDSA-P256-SHA256' },
  { id: 'RFC 5280', title: 'X.509 SubjectPublicKeyInfo', usedFor: 'form of the public key in report.sig (SPKI)', when: (s) => !!s.signer },
  { id: 'NIST SP 800-22 Rev. 1a', title: 'A Statistical Test Suite for Random and Pseudorandom Number Generators (April 2010)', usedFor: 'RNG tests', when: (s) => !!s.results.rng },
  { id: 'NIST STS 2.1.2', title: 'reference implementation of SP 800-22', usedFor: 'compared against; see deviations', when: (s) => !!s.results.rng },
  { id: 'RFC 2104', title: 'HMAC', usedFor: 'HMAC-SHA256 outcomes of provably-fair rounds', when: (s) => s.results.fair && s.results.fair.scheme !== 'chain' },
  { id: 'xoshiro128** 1.1', title: 'Blackman & Vigna, scrambled linear generator', usedFor: 'Monte Carlo generator (simulation, and the P-values of the distribution tests)', when: (s) => !!(s.results.montecarlo || s.results.distTests || sessionUsedMc(s)) },
  { id: 'Stake Engine math-sdk', title: 'StakeEngine/math-sdk (MIT): docs/rgs_docs/data_format.md and utils/rgs_verification.py', usedFor: 'outcome-table (LUT) format and RGS limits; the commit is in parameters.lut.rgsProfile', when: (s) => !!s.results.lut },
  { id: 'Stake Engine math-sdk (ways)', title: 'StakeEngine/math-sdk (MIT): src/calculations/ways.py and docs/math_docs/source_section/ways_info.md, commit 141b4e8 (2 Nov 2026)', usedFor: 'names of the ways multiplier strategies (symbol, board, global) and the reel-1 wild convention; read as documentation, none of its code is run', when: (s) => !!waysOf(s) },
  // Whole-round distribution and session funnel (P0-8). The two odds rules were not
  // checked against their official text (unverified); the report says so.
  { id: 'GLI-19 v3.0', title: 'GLI-19 Standards for Interactive Gaming Systems v3.0, 4.7.3 (text not verified here)', usedFor: 'top-award odds check: at least once in 100,000,000 games (unverified)', when: (s) => oddsChecked(s) },
  { id: '58 Pa. Code 461a.7', title: 'Pennsylvania Code, slot machine payout and odds (text not verified here)', usedFor: 'top-award odds check: odds no worse than 50,000,000 to 1 (unverified)', when: (s) => oddsChecked(s) },
  { id: 'Vose 1991', title: 'M. D. Vose, A linear algorithm for generating random numbers with a given distribution, IEEE TSE 17(9)', usedFor: 'alias-table draws of the session Monte Carlo', when: (s) => sessionUsedMc(s) },
];

// The ways part of the theoretical result (P0-6), or null.
const waysOf = (s) => (s.results.theoretical && s.results.theoretical.result && s.results.theoretical.result.model.ways) || null;
const sessionUsedMc = (s) => !!(s.results.session && s.results.session.result && s.results.session.result.generator);
const oddsChecked = (s) => !!(s.results.theoretical && s.results.theoretical.cap && s.results.theoretical.cap.odds && s.results.theoretical.cap.result && s.results.theoretical.cap.result.top);

const nistApplicable = (s, id) => !!(s.results.rng && s.results.rng.nist.results.some((t) => t.id === id && t.applicable));

// Deliberate departures from the references above. The PDF shows each one in both
// languages (i18n key: 'dev_' + id with dashes removed).
export const DEVIATIONS = [
  {
    id: 'nist-overlapping-exact', reference: 'NIST SP 800-22 Rev. 1a 2.8 and 3.8; NIST STS 2.1.2',
    text: 'Overlapping template matching uses the exact class probabilities of section 3.8, computed by dynamic programming over the template automaton (m = 9, M = 1032, K = 5: 0.364091, 0.185659, 0.139381, 0.100571, 0.070432, 0.139865). STS 2.1.2 and the worked example of 2.8.8 use an older approximation, so this P-value differs from theirs.',
    when: (s) => nistApplicable(s, 'overlappingTemplate'),
  },
  {
    id: 'nist-linear-pi0', reference: 'NIST SP 800-22 Rev. 1a 2.10; NIST STS 2.1.2',
    text: 'Linear complexity uses pi_0 = 0.01047 as the reference code does; the publication\'s table gives 1/96 = 0.010417.',
    when: (s) => nistApplicable(s, 'linearComplexity'),
  },
  {
    id: 'nist-cusum-bounds', reference: 'NIST SP 800-22 Rev. 1a 2.13; NIST STS 2.1.2',
    text: 'Cumulative sums: the summation bounds are rounded by truncating integer division, as in the reference code.',
    when: (s) => nistApplicable(s, 'cumulativeSums'),
  },
  {
    id: 'nist-family-holm', reference: 'NIST SP 800-22 Rev. 1a (an addition)',
    text: 'The overall verdict is not part of SP 800-22: Holm\'s step-down procedure at alpha = 0.01 over every P-value shown (NIST tests, chi-square, serial correlation). A test that fails its own rule without being rejected at family level is shown as "flag".',
    when: (s) => !!s.results.rng,
  },
  {
    // The lab follows the publication here; the departure is from the reference code.
    id: 'nist-proportion-bound', reference: 'NIST STS 2.1.2 (assess.c); NIST SP 800-22 Rev. 1a 4.2.1 is followed',
    text: 'Second level: the proportion bound (1 - alpha) - 3 sqrt(alpha (1 - alpha) / m) is applied as SP 800-22 4.2.1 states it, without rounding: with m = 100 sequences the bound is 0.96015, so at least 97 must pass. STS 2.1.2 (assess.c) truncates the bound times m to an integer and so accepts 96 of 100.',
    when: (s) => !!(s.results.rng && s.results.rng.nist.twoLevel),
  },
  {
    id: 'ways-board-sum', reference: 'StakeEngine/math-sdk src/calculations/ways.py (commit 141b4e8)',
    text: 'Ways "board" multiplier strategy: the lab adds the multipliers (above 1) of each win\'s own cells, at least 1, and multiplies that win by the sum. ways.py keeps one running sum (board_mult_count) across the symbols it evaluates in a spin, so its value depends on their order; the lab does not reproduce that.',
    when: (s) => !!(waysOf(s) && waysOf(s).multiplierStrategy === 'board'),
  },
  {
    id: 'ways-wild-reel1', reference: 'StakeEngine/math-sdk src/calculations/ways.py (commit 141b4e8)',
    text: 'Ways wild on reel 1: this model lets a wild on reel 1 start a win for every symbol (wildStartsWin true, the lab default); ways.py starts wins only for symbols shown on reel 1 (wildStartsWin false).',
    when: (s) => !!(waysOf(s) && waysOf(s).wildStartsWin),
  },
];

// A provably-fair run is either the custom mode (a scheme) or an operator adapter
// (provably fair v2), which has no scheme: it is named by its key and version.
function fairParameters(f) {
  if (f.mode === 'adapter') {
    const a = f.adapter || {};
    return { input: f.inputId, mode: 'adapter', adapter: { key: a.key ?? null, id: a.id ?? null, version: a.version ?? null }, options: f.options || null };
  }
  return { input: f.inputId, scheme: f.scheme ?? null, options: f.options || null };
}

function theoreticalParameters(th) {
  const x = th.result, w = x.model.ways;
  return {
    input: th.inputId ?? null, evaluation: w ? 'ways' : 'lines', scope: x.scope || 'round',
    ...(w ? { betCost: w.betCost, multiplierStrategy: w.multiplierStrategy, globalMultiplier: w.globalMultiplier, wildStartsWin: w.wildStartsWin, closedForm: Boolean(x.distribution && x.distribution.closedForm) } : {}),
  };
}

// The whole-round distribution's settings (P0-8): method, grid and its limit, the
// bound on wrapped mass, the noise floor, and the max-win cap / odds checks asked for.
function roundParameters(th) {
  const x = th && th.result;
  if (!x || !(x.round || x.roundError)) return null;
  const rd = x.round;
  return {
    input: th.inputId,
    method: rd ? rd.method : null, grid: rd && rd.grid ? rd.grid.size : null, gridLimit: rd && rd.grid ? rd.grid.limit : null,
    aliasBound: rd ? rd.aliasBound : null, noiseFloor: rd ? rd.floor : null, checkTolerance: 1e-9,
    error: x.roundError ? x.roundError.en : null,
    maxWinCap: th.cap ? th.cap.M : null, oddsChecks: th.cap ? !!th.cap.odds : false,
  };
}

// session: { inputs (from planAttachments), results, signer, attachLimit (the limit
// planAttachments was given; the default when absent) }.
export function buildManifest(session) {
  const r = session.results;
  const th = r.theoretical, mc = r.montecarlo;
  const modelSha256 = (th && th.modelSha256) || (mc && mc.modelSha256) || null;
  return {
    lab: { name: 'TARYAM RTP Lab', version: LAB_VERSION },
    hash: 'SHA-256',
    attachmentLimitBytes: session.attachLimit ?? ATTACH_LIMIT_BYTES,
    inputs: session.inputs.map((i) => ({ id: i.id, name: i.name, kind: i.kind, size: i.size, sha256: i.sha256, attachment: i.attachment === undefined ? i.name : i.attachment })),
    model: modelSha256 ? { sha256: modelSha256, input: th ? th.inputId : null, canonicalForm: 'JSON, object keys sorted, no whitespace (canonicalJson)' } : null,
    montecarlo: mc ? { generator: mc.generator, seed: mc.seed, spins: mc.spins, modelSha256: mc.modelSha256, resultSha256: mc.resultSha256 } : null,
    // The settings each analysis ran with, next to the inputs they apply to.
    parameters: {
      // Theoretical RTP: the evaluation and what the figure covers (ways conventions, P0-6).
      theoretical: th && th.result ? theoreticalParameters(th) : null,
      actual: r.actual ? { input: r.actual.inputId, options: r.actual.options || null } : null,
      rng: r.rng ? { input: r.rng.inputId, options: r.rng.options || null } : null,
      fair: r.fair ? fairParameters(r.fair) : null,
      distTests: r.distTests ? {
        input: r.distTests.inputId, inputs: r.distTests.inputIds || [], options: r.distTests.options || null,
        generator: (r.distTests.result && r.distTests.result.generator) || null,
      } : null,
      lut: r.lut ? { inputs: r.lut.inputIds || [], rgsProfile: (r.lut.result && r.lut.result.profile && r.lut.result.profile.profile) || null } : null,
      roundDistribution: roundParameters(th),
      session: r.session ? {
        input: r.session.inputId, modelSha256: r.session.modelSha256, options: r.session.options,
        method: r.session.result.method, ruinMethod: r.session.result.ruin ? r.session.result.ruin.method : null,
        generator: r.session.result.generator || null, grid: r.session.result.grid ? r.session.result.grid.size : null,
      } : null,
    },
    references: REFERENCES.filter((x) => !x.when || x.when(session)).map(({ id, title, usedFor }) => ({ id, title, usedFor })),
    deviations: DEVIATIONS.filter((x) => x.when(session)).map(({ id, reference, text }) => ({ id, reference, text })),
  };
}

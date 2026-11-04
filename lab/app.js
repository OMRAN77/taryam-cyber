// RTP lab page controller. Reads inputs, sends the work to worker.js, renders the
// results and builds the PDF report. Nothing leaves the browser: the page's CSP
// (connect-src 'none') blocks every network request a script could make.
import { t, pair, getLang, setLang, NIST_NAMES, VOLATILITY, VERDICT } from './i18n.js';
import { modelFromForm, formFromModel, applyCsv, parseModelJson, normalizeModel, canonicalJson, isWeightedModel, isWaysModel } from './core/slot-model.js';
import { controlVariate } from './core/montecarlo.js';
import { sha256Hex } from './core/fair.js';
import { Fraction } from './core/fraction.js';
import { buildReport, compactJson, pfIssueDetail } from './report.js';
import { loadSigningKey, formatFingerprint, ALGORITHM_INFO } from './core/sign.js';
import * as samples from './samples.js';
import { lutFileKind } from './core/lut.js';

const $ = (s) => document.querySelector(s);
let lang = getLang();
const tr = (key) => t(key, lang);
const pick = (p) => (lang === 'en' ? p[1] : p[0]);
const pct = (v, d = 4) => (v === null || v === undefined ? '—' : (v * 100).toFixed(d) + '%');
const fmt = (v, d = 4) => (v === null || v === undefined || Number.isNaN(v) ? '—' : Number(v).toLocaleString('en-US', { maximumFractionDigits: d }));
const fmtP = (p) => (p === null || p === undefined ? '—' : p < 1e-6 ? p.toExponential(2) : p.toFixed(6));
const enc = new TextEncoder();

// ---------- worker ----------
let worker = null, nextId = 1;
const pending = new Map();
function getWorker() {
  if (!worker) {
    worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = (e) => {
      const { id, type } = e.data;
      const p = pending.get(id);
      if (!p) return;
      if (type === 'progress') { p.onProgress(e.data.value); return; }
      pending.delete(id);
      if (type === 'result') p.resolve(e.data.result); else p.reject(e.data.error);
    };
    worker.onerror = (e) => {
      for (const p of pending.values()) p.reject({ message: e.message || 'worker error' });
      pending.clear();
      worker = null;
    };
  }
  return worker;
}
function runTask(task, payload, onProgress = () => {}) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject, onProgress });
    getWorker().postMessage({ id, task, payload });
  });
}
function stopWorker() {
  if (worker) { worker.terminate(); worker = null; }
  for (const p of pending.values()) p.reject({ stopped: true });
  pending.clear();
}

// ---------- session (inputs with fingerprints, results) ----------
const session = { inputs: new Map(), results: {}, extra: {} };
async function registerInput(id, name, kind, bytes, mime) {
  const sha256 = await sha256Hex(bytes);
  const old = session.inputs.get(id);
  session.inputs.set(id, { id, name, kind, size: bytes.length, sha256, bytes, mime });
  if (old && old.sha256 !== sha256) dropDistTestsUsing([id]);
  return sha256;
}

// ---------- DOM helpers ----------
function el(tag, attrs = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') n.className = v; else if (k === 'text') n.textContent = v; else n.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c !== null && c !== undefined) n.append(c instanceof Node ? c : String(c));
  return n;
}
const label = (k) => (Array.isArray(k) ? pick(k) : tr(k));
function cards(list) {
  return el('div', { class: 'cards' }, list.filter(Boolean).map((c) => el('div', { class: 'card ' + (c.cls || '') }, el('div', { class: 'k' }, label(c.k)), el('div', { class: 'v', title: c.title || null }, c.v), c.s ? el('div', { class: 's' }, c.s) : null)));
}
function table(headers, rows) {
  return el('div', { class: 'table-wrap' }, el('table', {},
    el('thead', {}, el('tr', {}, headers.map((h) => el('th', {}, label(h))))),
    el('tbody', {}, rows.map((r) => el('tr', {}, r.map((c) => {
      const cell = c !== null && typeof c === 'object' && !(c instanceof Node) ? c : { v: c };
      return el('td', { class: cell.cls || null }, cell.v instanceof Node ? cell.v : String(cell.v));
    })))),
  ));
}
const bar = (frac) => el('div', { class: 'bar', style: `width:${Math.max(0.5, Math.min(100, frac * 100)).toFixed(2)}%` });
const sub = (k) => el('h3', { class: 'sub' }, label(k));
function setBusy(id, busy, value = 0) {
  const btn = $('#run-' + id), prog = $('#prog-' + id);
  if (btn) btn.disabled = busy;
  if (prog) { prog.hidden = !busy; prog.value = value; }
}
function showError(id, err) {
  const box = $('#err-' + id);
  if (!err) { box.hidden = true; box.textContent = ''; return; }
  box.hidden = false;
  box.textContent = err.stopped ? tr('stopped') : (lang === 'en' ? err.en : err.ar) || err.message || String(err);
}
function download(bytes, name, mime) {
  const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
  const a = el('a', { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
async function withTask(id, fn) {
  showError(id, null);
  setBusy(id, true);
  const t0 = performance.now();
  try { await fn((v) => { $('#prog-' + id).value = v; }); } catch (e) { showError(id, e); } finally { setBusy(id, false); session.extra[id + 'Ms'] = performance.now() - t0; }
}

// ---------- tabs and language ----------
function selectTab(name) {
  document.querySelectorAll('[role="tab"]').forEach((b) => b.setAttribute('aria-selected', String(b.id === 'tab-' + name)));
  document.querySelectorAll('[role="tabpanel"]').forEach((p) => { p.hidden = p.id !== 'panel-' + name; });
  if (name === 'report') { renderReportSections(); showSigningKey(); }
  if (name === 'mc') renderMcModel();
  if (name === 'fair') loadPfAdapters();
}
const fileNames = {};
function applyLang() {
  document.documentElement.lang = lang;
  document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr';
  document.title = tr('pageTitle') + ' — TARYAM';
  document.querySelectorAll('[data-t]').forEach((n) => { n.textContent = tr(n.dataset.t); });
  for (const [id, name] of Object.entries(fileNames)) $('#name-' + id).textContent = name;
  renderAll();
}

// ---------- theoretical RTP ----------
const FORM = ['name', 'rows', 'reels', 'paytable', 'linePreset', 'lines', 'wild', 'scatter', 'fsEnabled', 'fsTrigger', 'fsSpins', 'fsMultiplier', 'fsRetrigger', 'fsReels', 'fsMaxSpins', 'fsMaxRetriggers'];
function readForm() {
  const f = {};
  for (const k of FORM) { const n = $('#f-' + k); f[k] = n.type === 'checkbox' ? n.checked : n.value; }
  return f;
}
function fillForm(raw) {
  const f = formFromModel(raw);
  for (const k of FORM) { const n = $('#f-' + k); if (n.type === 'checkbox') n.checked = Boolean(f[k]); else n.value = f[k] ?? ''; }
  syncFormVisibility();
}
function syncFormVisibility() {
  $('#f-lines').hidden = $('#f-linePreset').value !== 'custom';
  const fs = $('#f-fsEnabled').checked;
  $('#fsFields').hidden = !fs;
  $('#f-fsReels').closest('label').hidden = !fs;
  $('#fsCapFields').hidden = !fs || !$('#f-fsRetrigger').checked; // caps apply with retrigger only (P0-8)
}

// ---------- weighted stops and reel sets (P0-5) ----------
// The form has no weights or reel sets, so a model that uses them is edited as JSON.
let jsonMode = false;
function setJsonMode(on) {
  jsonMode = on;
  $('#panel-theory').classList.toggle('json-mode', on);
  $('#modelJsonBox').hidden = !on;
}
// A model declaring "cascades" (any value but false): the form has no such key and
// would drop it, so the first-drop label would be lost (P0-6).
const declaresCascades = (raw) => Boolean(raw && typeof raw === 'object' && raw.cascades !== undefined && raw.cascades !== null && raw.cascades !== false);
function setModel(raw) {
  // A ways model (P0-6) also stays in JSON: the form edits line games only.
  if (isWeightedModel(raw) || isWaysModel(raw) || declaresCascades(raw)) {
    $('#f-json').value = compactJson(raw) + '\n';
    $('#jsonModeNote').hidden = !isWeightedModel(raw);
    $('#waysJsonNote').hidden = !isWaysModel(raw);
    $('#cascadesJsonNote').hidden = !declaresCascades(raw);
    setJsonMode(true);
  } else {
    setJsonMode(false);
    fillForm(raw);
  }
}
const currentRaw = () => (jsonMode ? parseModelJson($('#f-json').value) : modelFromForm(readForm()));
// A weight count can pass 2^53 or be a fraction (an average over lines). Both are
// written exactly in BigInt: every integer digit kept, a fraction rounded to 2 places.
const fmtWeight = (s) => {
  if (!s.includes('/')) return BigInt(s).toLocaleString('en-US');
  const [int, dec] = new Fraction(...s.split('/').map(BigInt)).toDecimal(2).split('.');
  return BigInt(int).toLocaleString('en-US') + '.' + dec;
};
function reelSetsTable(sets) {
  return table([['#', '#'], 'setWeight', 'probability', 'stops', 'reelTotals'], sets.map((st, i) => [
    { v: i + 1, cls: 'num' }, { v: fmtWeight(st.weight), cls: 'num' }, { v: st.probability.percent + '%', cls: 'num' },
    { v: st.stops.join(' / '), cls: 'num' }, { v: st.reelTotals.map(fmtWeight).join(' / '), cls: 'num' },
  ]));
}
function renderWeights(box, m) {
  if (!m.weighted) return;
  // Ways (P0-6): the top reel's total weight, which multiplies a set's cycle.
  const topTotal = (sets) => (sets[0].topReelTotal ? [el('p', { class: 'muted small top-total' }, tr('topReelTotal') + ': ' + fmtWeight(sets[0].topReelTotal))] : []);
  box.append(sub('reelSetsTable'), reelSetsTable(m.reelSets), ...topTotal(m.reelSets));
  if (m.freeSpinReelSets) box.append(sub('fsReelSetsCount'), reelSetsTable(m.freeSpinReelSets), ...topTotal(m.freeSpinReelSets));
  box.append(el('p', { class: 'muted small weight-total' }, tr('totalWeight') + ': ' + fmtWeight(m.totalWeight)), el('p', { class: 'muted small' }, tr('weightsNote')));
  if (m.ways) box.append(el('p', { class: 'muted small', id: 'ways-weights-note' }, tr('waysWeightsNote')));
}

// ---------- ways / Megaways (P0-6) ----------
const fill = (key, ...args) => args.reduce((text, a, i) => text.replace('{' + i + '}', a), tr(key));
const bigText = (s) => BigInt(s).toLocaleString('en-US');
// Probabilities to 2 places here (the report and report.json carry 6); the cell wraps on phones.
function waysHeightsTable(src) {
  return table(['reelNo', 'waysHeights', 'waysTopCell', 'waysJoint'], src.heights.map((h, i) => [
    { v: i + 1, cls: 'num' }, { v: h.rows.map((r, j) => `${r}:\u00a0${Number(h.probabilities[j]).toFixed(2)}%`).join(' · '), cls: 'num ways-h' }, h.topCell ? '✓' : '', h.joint ? '✓' : '',
  ]));
}
function waysSourceCards(src) {
  const top = src.topReel;
  return cards([
    { k: 'maxWays', v: bigText(src.maxWays), s: `${tr('waysRange')}: ${bigText(src.minWays)} – ${bigText(src.maxWays)}`, cls: 'ways-text' },
    { k: 'topReelWord', v: top ? fill('topReelValue', top.covers.join(lang === 'en' ? ', ' : '، '), top.stops) : tr('topReelNone'), cls: 'ways-text' },
  ]);
}
function renderWays(box, x) {
  const w = x.model.ways;
  box.append(sub('waysTitle'), cards([{ k: 'waysEval', v: tr('waysWord'), cls: 'ways-text' }, { k: 'betCostLabel', v: String(w.betCost) }]), waysSourceCards(w.base), waysHeightsTable(w.base));
  if (w.freeSpins) box.append(sub('fsWindows'), waysSourceCards(w.freeSpins), waysHeightsTable(w.freeSpins));
  const rules = [
    tr('multStrategy') + ': ' + tr('multStrategy_' + w.multiplierStrategy) + (w.multiplierStrategy === 'global' ? ` (${tr('globalMultLabel')}: ${w.globalMultiplier}). ${tr('globalPayNote')}` : ''),
    tr('wildReel1') + ': ' + tr('wildReel1_' + w.wildStartsWin),
  ];
  if (w.multiplierSymbols.length) rules.push(tr('multiplierSymbolsLabel') + ': ' + w.multiplierSymbols.map((m) => `${m.symbol} = ${m.countsAs} × ${m.multiplier}`).join(' · '));
  box.append(el('ul', { class: 'ways-rules', id: 'ways-rules' }, rules.map((r) => el('li', {}, r))));
  box.append(el('p', { class: 'muted small' }, tr('waysPayUnit')), el('p', { class: 'muted small ways-source' }, tr('waysSource')));
  if (w.multiplierStrategy === 'board') box.append(el('p', { class: 'muted small' }, tr('waysBoardNote')));
  box.append(el('p', { class: 'muted small' }, tr('waysNotCert')));
}

async function runTheory() {
  await withTask('theory', async (progress) => {
    const raw = currentRaw();
    normalizeModel(raw); // fails fast with a readable message
    const bytes = enc.encode(canonicalJson(raw));
    const name = (raw.name || 'model').replace(/[^\w؀-ۿ-]+/g, '-').replace(/^-|-$/g, '').toLowerCase() + '.json';
    const modelSha256 = await registerInput('model', name, 'model', bytes, 'application/json');
    const result = await runTask('exact', { raw }, progress);
    session.results.theoretical = { inputId: 'model', modelSha256, result, raw };
    delete session.results.montecarlo;
    delete session.results.session; // the session funnel belongs to the previous model
    renderTheory();
    renderSession();
    renderDistCandidates();
  });
}

function renderTheory() {
  const box = $('#res-theory');
  box.replaceChildren();
  renderRound();
  const th = session.results.theoretical;
  if (!th) return;
  const x = th.result, d = x.distribution;
  const ways = x.model.ways, firstDrop = x.scope === 'firstDrop';
  // A ways game too large for the full distribution has no max win or buckets (closed form).
  const mw = d && d.maxWin;
  const fraction = x.rtp.fraction.length > 40 ? x.rtp.fraction.slice(0, 37) + '…' : x.rtp.fraction;
  box.append(cards([
    { k: firstDrop ? 'rtpFirstDrop' : 'rtp', v: x.rtp.percent + '%', s: tr('exactFraction') + ': ' + fraction, title: x.rtp.fraction, cls: 'accent' },
    d && { k: 'hitFrequency', v: d.hitFrequency ? pct(d.hitFrequency.value, 3) : '—', s: d.hitFrequency ? null : tr('hitUnavailable'), cls: d.hitFrequency ? '' : 'ways-text' },
    d && { k: 'sd', v: fmt(d.sd, 3), s: tr('volatility') + ': ' + pick(VOLATILITY[d.volatilityClass]) + ' · VI90 ' + fmt(d.volatilityIndex90, 2) },
    mw && { k: 'maxWinBase', v: fmt(mw.base, 2) + '×' },
    mw && mw.perFreeSpin !== undefined && { k: 'maxWinFs', v: fmt(mw.perFreeSpin, 2) + '×' },
    mw && mw.perFreeSpin !== undefined && { k: 'maxWinTotal', v: mw.unbounded ? '∞' : fmt(mw.withFeature, 2) + '×', s: mw.unbounded ? tr('unbounded') : null },
    mw && mw.perFreeSpin !== undefined && fsCaps(th.raw) && { k: 'roundCapsCard', v: capsText(fsCaps(th.raw)) },
    ways ? { k: 'waysCombinations', v: BigInt(x.model.combinations).toLocaleString('en-US'), s: `${tr('waysRange')}: ${BigInt(ways.base.minWays).toLocaleString('en-US')} – ${BigInt(ways.base.maxWays).toLocaleString('en-US')}`, cls: 'ways-text' }
      : { k: 'combinations', v: BigInt(x.model.combinations).toLocaleString('en-US'), s: x.model.reels + '×' + x.model.rows + ' · ' + x.model.lines + ' ' + tr('lines') },
    x.model.weighted && { k: 'weightedModel', v: tr('weightedYes'), s: tr('reelSetsCount') + ': ' + x.model.reelSets.length + (x.model.freeSpinReelSets ? ' · ' + tr('fsReelSetsCount') + ': ' + x.model.freeSpinReelSets.length : '') },
  ]));
  if (firstDrop) box.append(el('div', { class: 'verdict warn', id: 'first-drop-note' }, tr('firstDropNote')));
  if (x.distributionError) box.append(el('div', { class: 'verdict warn' }, pick([x.distributionError.ar, x.distributionError.en])));
  box.append(el('div', {}, el('span', { class: 'muted small' }, tr('modelHash')), el('div', { class: 'hash' }, th.modelSha256)));
  renderWeights(box, x.model);
  if (ways) renderWays(box, x);
  const c = x.contributions;
  box.append(sub('contributions'), table(['contributions', 'contribution', ['حصة من RTP', 'Share of RTP'], ''], [
    [ways ? 'contribWays' : 'contribLines', c.lines], ['contribWild', c.wildAssistedLines], ['contribScatter', c.scatter], ['contribFs', c.freeSpins],
  ].map(([k, v]) => [tr(k), { v: v.percent + '%', cls: 'num' }, { v: pct(v.value / x.rtp.value, 2), cls: 'num' }, { v: bar(v.value / x.rtp.value) }])));
  if (ways) box.append(el('p', { class: 'muted small', id: 'ways-wild-note' }, tr('waysWildNote')));
  if (x.freeSpins) {
    const f = x.freeSpins;
    box.append(sub('freeSpins'), cards([
      { k: 'triggerProb', v: pct(f.triggerProbability.value, 4), s: tr('oneIn') + ' ' + fmt(1 / f.triggerProbability.value, 1) + ' ' + tr('rounds') },
      { k: 'expectedSpins', v: fmt(f.expectedSpinsPerTrigger.value, 3) },
      { k: 'evPerTrigger', v: fmt(f.evPerTrigger.value, 3) + '×' },
    ]));
  }
  const rows = [];
  for (const s of x.symbols) for (const b of s.byCount) {
    rows.push([s.symbol + (s.isWild ? ' (wild)' : ''), { v: b.count, cls: 'num' }, { v: fmt(b.pay, 4), cls: 'num' }, { v: b.probabilityPerLine.value.toExponential(4), cls: 'mono' },
      ways ? { v: fmt(b.averageWays.value, 2), cls: 'num' } : { v: x.model.weighted ? fmtWeight(b.combosPerLine) : Number(b.combosPerLine).toLocaleString('en-US'), cls: 'num' }, { v: b.rtp.percent + '%', cls: 'num' }]);
  }
  box.append(sub(ways ? 'symbolTableWays' : 'symbolTable'), table(ways ? ['symbol', 'count', 'payPerWay', 'probabilityRun', 'averageWays', 'contribution']
    : ['symbol', 'count', 'pay', 'probability', x.model.weighted ? 'weightPerLine' : ['التوليفات لكل خط', 'Combinations per line'], 'contribution'], rows));
  if (x.scatter.length) {
    box.append(table([['عدد الـScatter', 'Scatters'], 'probability', ['الدفع × الرهان', 'Pay × bet'], ['تفعيل', 'Trigger']],
      x.scatter.map((s) => [{ v: s.count, cls: 'num' }, { v: s.probability.value.toExponential(4), cls: 'mono' }, { v: fmt(s.pay, 4), cls: 'num' }, s.triggers ? '✓' : ''])));
  }
  if (d && d.buckets) {
    const maxP = Math.max(...d.buckets.map((b) => b.probability.value));
    box.append(sub('distribution'), table(['range', 'probability', ''], d.buckets.map((b) => [
      { v: b.to === 0 ? '0' : b.to === null ? '≥ ' + b.from : b.from + ' – ' + b.to, cls: 'num' }, { v: pct(b.probability.value, 4), cls: 'num' }, { v: bar(b.probability.value / maxP) },
    ])));
  }
}

// ---------- whole-round distribution, max-win cap, session funnel (P0-8) ----------
// A bound rounded up to two significant digits, so "< x" stays an upper bound.
function upper2(v) {
  if (!(v > 0)) return '0';
  let e = Math.floor(Math.log10(v));
  let m = Math.ceil(v / 10 ** (e - 1) - 1e-9);
  if (m >= 100) { m = 10; e += 1; }
  return (m / 10).toFixed(1) + 'e' + e;
}
// A probability { value, method: exact | fft | bound, below }: never a number under the floor.
const probText = (p) => {
  if (!p) return '—';
  if (p.method === 'bound') return '< ' + upper2(p.below);
  if (p.value === 0) return '0';
  return p.value >= 1e-3 ? pct(p.value, 3) : p.value.toExponential(3);
};
const bigCount = (n) => (n >= 1e9 ? n.toExponential(2) : fmt(n, n < 100 ? 2 : 0));
const oneInText = (p) => {
  if (!p) return '—';
  if (p.method === 'bound') return '> ' + bigCount(1 / p.below);
  return p.value > 0 ? bigCount(1 / p.value) : '—';
};
const pctSmall = (v, d = 2) => (v === 0 ? '0%' : v < 1e-4 ? (v * 100).toExponential(2) + '%' : pct(v, d));
const quantileLabel = (q) => (q * 100).toFixed(q >= 0.9999 ? 2 : q >= 0.999 ? 1 : 0) + '%';
// The free-spin caps of a raw model (P0-8), or null.
const fsCaps = (raw) => {
  const f = raw && raw.scatter && typeof raw.scatter === 'object' ? raw.scatter.freeSpins : null;
  const has = (v) => v !== undefined && v !== null && v !== '';
  return f && (has(f.maxSpins) || has(f.maxRetriggers)) ? { maxSpins: has(f.maxSpins) ? f.maxSpins : null, maxRetriggers: has(f.maxRetriggers) ? f.maxRetriggers : null } : null;
};
const capsText = (c) => [c.maxSpins !== null ? `${tr('fsMaxSpinsShort')}: ${c.maxSpins}` : null, c.maxRetriggers !== null ? `${tr('fsMaxRetriggersShort')}: ${c.maxRetriggers}` : null].filter(Boolean).join(' · ');

function renderRound() {
  const sec = $('#round'), box = $('#res-round');
  box.replaceChildren();
  const th = session.results.theoretical;
  const x = th && th.result;
  sec.hidden = !x || (!x.round && !x.roundError);
  renderRoundCap();
  if (sec.hidden) return;
  if (x.roundError) {
    const e = x.roundError;
    box.append(el('div', { class: 'verdict ' + (e.internal ? 'fail' : 'warn'), id: 'round-error' }, tr('roundUnavailable') + ': ' + pick([e.ar, e.en])));
    if (e.tooLarge) box.append(el('p', { class: 'muted small' }, tr('roundUseMc')));
    return;
  }
  const r = x.round;
  const worst = Math.max(...Object.values(r.checks).map((c) => c.relativeError));
  box.append(cards([
    { k: 'roundMethod', v: tr('roundMethod_' + r.method), s: r.caps ? capsText(r.caps) : null },
    r.maxWin.bounded
      ? { k: 'roundTop', v: fmt(r.maxWin.x, 2) + '×', s: `${tr('probability')}: ${probText(r.maxWin)}` }
      : { k: 'roundTop', v: tr('roundUnboundedTop'), s: `${tr('roundLargestShown')}: ${fmt(r.maxWin.largestAboveFloor, 2)}×` },
  ]));
  if (!r.exact) {
    box.append(el('p', { class: 'muted small', id: 'round-precision' }, [
      `${tr('roundGrid')}: ${r.grid.size.toLocaleString('en-US')}`, `${tr('roundAlias')}: ${r.aliasBound ? upper2(r.aliasBound) : '0'}`,
      `${tr('roundFloor')}: ${upper2(r.floor)}`, `${tr('roundChecks')}: ${worst.toExponential(1)}`,
    ].join(' · ')));
  }
  const rows = r.thresholds.map((t) => [{ v: iso('≥ ' + fmt(t.x, 0) + '×'), cls: 'num' }, { v: probText(t), cls: 'mono' }, { v: oneInText(t), cls: 'num' }, tr('roundSrc_' + t.method)]);
  if (r.maxWin.bounded) rows.push([{ v: tr('roundTop') + ' ' + iso(fmt(r.maxWin.x, 2) + '×'), cls: 'num' }, { v: probText(r.maxWin), cls: 'mono' }, { v: oneInText(r.maxWin), cls: 'num' }, tr('roundSrc_' + r.maxWin.method)]);
  const big = table(['roundWinCol', 'probability', 'roundOneInCol', 'roundSource'], rows);
  big.id = 'round-big';
  box.append(sub('roundBig'), big);
  const qt = table(['roundQuantile', 'roundWinCol'], r.quantiles.map((q) => [{ v: quantileLabel(q.q), cls: 'num' }, { v: fmt(q.x, 2) + '×', cls: 'num' }]));
  qt.id = 'round-quantiles';
  box.append(sub('roundQuantiles'), qt, el('p', { class: 'muted small' }, tr('roundNote')));
}

function renderRoundCap() {
  const box = $('#res-roundcap');
  box.replaceChildren();
  const th = session.results.theoretical;
  const c = th && th.cap;
  if (!c) return;
  const res = c.result;
  if (res.cap) {
    const k = res.cap;
    // An exact result has no upper bound on what the cap removes.
    const upTo = typeof k.lost.upper === 'number' && pctSmall(k.lost.upper, 4) !== pctSmall(k.lost.value, 4) ? `${tr('roundUpTo')} ${pctSmall(k.lost.upper, 4)}` : null;
    box.append(cards([
      { k: 'roundCapM', v: iso(fmt(k.M, 4) + '×') },
      { k: 'roundCapped', v: (k.rtpCapped.value * 100).toFixed(4) + '%', title: k.rtpCapped.fraction, cls: 'accent' },
      { k: 'roundLost', v: pctSmall(k.lost.value, 4), s: upTo },
      { k: 'roundReach', v: probText(k.reach), s: `${tr('roundOneInCol')}: ${oneInText(k.reach)}` },
    ]));
    box.firstChild.id = 'round-cap-cards';
    if (k.aboveMax) box.append(el('p', { class: 'muted small', id: 'round-cap-above' }, tr('roundCapAboveMax')));
    box.append(el('p', { class: 'muted small' }, tr('roundCapNote')));
  }
  if (!c.odds) return;
  if (!res.top) { box.append(el('div', { class: 'verdict warn', id: 'round-needcap' }, tr('roundNeedCap'))); return; }
  const ch = res.top.checks;
  const cell = (pass) => (pass === true ? { v: tr('roundPass'), cls: 'pass' } : pass === false ? { v: tr('roundFail'), cls: 'fail' } : { v: tr('roundUndecided'), cls: 'na' });
  const tb = table(['roundRule', 'result'], [[tr('roundRuleGli'), cell(ch.gli19.pass)], [tr('roundRulePa'), cell(ch.pa.pass)]]);
  tb.id = 'round-odds';
  box.append(sub('roundOddsTitle'), cards([{ k: 'roundTopAward', v: fmt(res.top.x, 2) + '×', s: `${tr('probability')}: ${probText(res.top.prob)} · ${tr('roundOneInCol')}: ${oneInText(res.top.prob)}` }]), tb, el('p', { class: 'muted small' }, tr('roundOddsNote')));
}

async function runRoundCap() {
  await withTask('round', async () => {
    const th = session.results.theoretical;
    if (!th || !th.result.round) throw { ar: t('roundNeedRun', 'ar'), en: t('roundNeedRun', 'en') };
    const cap = $('#r-cap').value.trim();
    // The previous cap's figures go now: next to an error they would belong to another M
    // (and would stay in the report).
    th.cap = null;
    renderRoundCap();
    const result = await runTask('roundCap', { round: th.result.round, cap: cap || null, rtp: th.result.rtp.fraction });
    th.cap = { M: cap || null, odds: $('#r-odds').checked, result };
    renderRoundCap();
  });
}

// A session probability: the value (± its standard error), "< bound" when it is under
// the precision floor, or a 95% bound when Monte Carlo saw it in no session (or in all),
// with a note saying which. Bounds are rounded outwards.
const pctUp = (v) => (v * 100 >= 0.01 ? (Math.ceil(v * 1e4 - 1e-9) / 100).toFixed(2) + '%' : upper2(v * 100) + '%');
const pctDown = (v) => (Math.floor(v * 1e4 + 1e-9) / 100).toFixed(2) + '%';
function sessProb(p, { below = null, se = null, upper95, lower95 } = {}) {
  if (p === null || p === undefined) return { v: '< ' + pctUp(below), note: tr('sessBelowFloor') };
  if (typeof upper95 === 'number') return { v: '< ' + pctUp(upper95), note: tr('sessNone95') };
  if (typeof lower95 === 'number') return { v: '> ' + pctDown(lower95), note: tr('sessAll95') };
  return { v: pctSmall(p) + (se !== undefined && se !== null ? ' ± ' + pctSmall(se) : ''), note: null };
}

const readPositive = (text) => {
  let f = null;
  try { f = Fraction.of(String(text).trim().replace(',', '.')); } catch (e) { /* not a number */ }
  return f && f.cmp(0) > 0 ? f : null;
};
async function runSession() {
  await withTask('session', async (progress) => {
    const th = session.results.theoretical;
    if (!th) throw { ar: t('roundNeedRun', 'ar'), en: t('roundNeedRun', 'en') };
    if (!th.result.round) throw { ar: t('sessNoRound', 'ar'), en: t('sessNoRound', 'en') };
    const rounds = Number($('#s-rounds').value);
    const betText = $('#s-bet').value.trim(), budgetText = $('#s-budget').value.trim();
    const bet = readPositive(betText);
    if (!bet) throw { ar: t('sessBetInvalid', 'ar'), en: t('sessBetInvalid', 'en') };
    let budget = null;
    if (budgetText) {
      const b = readPositive(budgetText);
      if (!b) throw { ar: t('sessBudgetInvalid', 'ar'), en: t('sessBudgetInvalid', 'en') };
      budget = b.div(bet).toString(); // in bets, exact
    }
    const seed = $('#s-seed').value;
    const result = await runTask('session', { pmf: th.result.round.pmf, rtp: th.result.rtp.fraction, sd: th.result.distribution.sd, rounds, budget, seed }, progress);
    // The bet and budget as read (a decimal comma becomes a point), so every figure,
    // the report and report.json use the same numbers.
    const asRead = (s) => s.replace(',', '.');
    session.results.session = { inputId: 'model', modelSha256: th.modelSha256, options: { rounds, bet: asRead(betText), budget: budgetText ? asRead(budgetText) : null, budgetInBets: budget, seed }, result };
    renderSession();
    renderReportSections();
  });
}

// The funnel: bands of 90% and 50% of sessions, the median and the expected result.
function funnelChart(r, bet) {
  const W = 640, H = 240, L = 58, R = 10, T = 12, B = 28;
  const zero = { rounds: 0, mean: 0, percentiles: r.percentiles.map((p) => ({ q: p.q, net: 0 })) };
  const pts = [zero, ...r.funnel];
  const at = (p, q) => p.percentiles.find((x) => x.q === q).net * bet;
  const all = pts.flatMap((p) => [at(p, 0.05), at(p, 0.95), p.mean * bet]);
  const lo = Math.min(0, ...all), hi = Math.max(0, ...all), span = hi - lo || 1;
  const X = (n) => (L + ((W - L - R) * n) / r.rounds).toFixed(1), Y = (v) => (T + ((H - T - B) * (hi - v)) / span).toFixed(1);
  const s = svg('svg', { viewBox: `0 0 ${W} ${H}`, class: 'chart funnel', role: 'img', 'aria-label': tr('sessFunnel'), id: 'sess-funnel' });
  const band = (qa, qb, cls) => s.append(svg('polygon', { class: cls, points: [...pts.map((p) => `${X(p.rounds)},${Y(at(p, qb))}`), ...pts.slice().reverse().map((p) => `${X(p.rounds)},${Y(at(p, qa))}`)].join(' ') }));
  band(0.05, 0.95, 'f90');
  band(0.25, 0.75, 'f50');
  s.append(svg('line', { x1: L, x2: W - R, y1: Y(0), y2: Y(0), class: 'fzero' }));
  s.append(svg('polyline', { class: 'fmean', points: pts.map((p) => `${X(p.rounds)},${Y(p.mean * bet)}`).join(' ') }));
  s.append(svg('polyline', { class: 'fmedian', points: pts.map((p) => `${X(p.rounds)},${Y(at(p, 0.5))}`).join(' ') }));
  for (const v of [hi, 0, lo]) s.append(svg('text', { x: L - 6, y: Number(Y(v)) + 4, 'text-anchor': 'end' }, fmt(v, 0)));
  s.append(svg('text', { x: L, y: H - 8 }, '0'));
  s.append(svg('text', { x: W - R, y: H - 8, 'text-anchor': 'end' }, r.rounds.toLocaleString('en-US')));
  const key = (cls, k) => el('span', { class: 'fkey' }, el('i', { class: cls }), tr(k));
  return el('figure', { class: 'funnel-wrap' }, s, el('figcaption', { class: 'muted small' }, tr('sessFunnel'), ' ', key('f90', 'sessBand90'), key('f50', 'sessBand50'), key('fmedian', 'sessMedianLine'), key('fmean', 'sessMeanLine')));
}

function renderSession() {
  const sec = $('#session'), box = $('#res-session');
  box.replaceChildren();
  const th = session.results.theoretical;
  sec.hidden = !th;
  if (!th) return;
  if (!th.result.round) { box.append(el('div', { class: 'verdict warn' }, tr('sessNoRound'))); return; }
  const s = session.results.session;
  if (!s) return;
  const r = s.result, bet = Number(String(s.options.bet).replace(',', '.'));
  const money = (v) => iso((v > 0 ? '+' : '') + fmt(v * bet, 2)); // a sign stays in front in Arabic text
  const ahead = sessProb(r.pAhead, { below: r.pAheadBelow, se: r.pAheadSe, upper95: r.pAheadUpper95, lower95: r.pAheadLower95 });
  const ruin = r.ruin && sessProb(r.ruin.p, r.ruin);
  box.append(cards([
    { k: 'sessExpectedLoss', v: fmt(r.expectedLoss.value * bet, 2), s: iso(`${r.rounds.toLocaleString('en-US')} × ${s.options.bet} × (1 − ${th.result.rtp.percent}%)`), cls: 'bad' },
    { k: 'sessMedian', v: money(r.median), cls: r.median < 0 ? 'bad' : '' },
    { k: 'sessAhead', v: ahead.v, s: [ahead.note, r.normal ? `${tr('sessNormal')}: ${pctSmall(r.normal.pAhead)}` : null].filter(Boolean).join(' · ') || null },
    r.ruin && { k: 'sessRuin', v: ruin.v, s: [ruin.note, tr('sessRuinMethod_' + r.ruin.method)].filter(Boolean).join(' · ') },
    r.nStar && { k: 'sessNStar', v: r.nStar.rounds.toLocaleString('en-US'), s: tr('sessNStarNote') },
  ]));
  box.firstChild.id = 'sess-cards';
  // One statement per method: the range (and the chance to finish ahead), then the budget.
  const mc = r.sessions ? ` (${tr('sessSessions')}: ${r.sessions.toLocaleString('en-US')} · ${tr('seed')}: ${s.options.seed})` : '';
  box.append(el('p', { class: 'muted small', id: 'sess-method' }, `${tr('sessMethodRange')}: ${tr('sessMethod_' + r.method)}` + (r.method === 'mc' ? mc : '')
    + (r.ruin ? ` · ${tr('sessMethodRuin')}: ${tr('sessRuinMethod_' + r.ruin.method)}` + (r.ruin.method === 'mc' && r.method !== 'mc' ? mc : '') : '')
    + (r.droppedMass > 0 ? ` · ${tr('sessDropped')}: ${upper2(r.droppedMass)}` : '')));
  const tb = table(['sessPct', 'sessNet'], r.percentiles.map((p) => [{ v: pct(p.q, 0), cls: 'num' }, { v: money(p.net), cls: 'num' }]));
  tb.id = 'sess-percentiles';
  box.append(sub('sessPercentiles'), tb, funnelChart(r, bet), el('p', { class: 'muted small' }, tr('sessNote')));
}

// ---------- observed RTP ----------
// inputId keys the session input; panel names the "#name-<panel>" label.
async function loadFileInput(inputId, panel, file, kind) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  await registerInput(inputId, file.name, kind, bytes, file.type || 'application/octet-stream');
  fileNames[panel] = file.name + ' · ' + bytes.length.toLocaleString('en-US') + ' ' + tr('bytes');
  $('#name-' + panel).textContent = fileNames[panel];
}

async function runActual() {
  await withTask('actual', async (progress) => {
    const input = session.inputs.get('playlog');
    if (!input) throw { ar: tr('noFile'), en: t('noFile', 'en') };
    const num = (s) => (String(s).trim() === '' ? null : Number(String(s).replace(',', '.')));
    let sigma = num($('#a-sigma').value);
    if (sigma === null && $('#a-useTheory').checked && session.results.theoretical && session.results.theoretical.result.distribution) {
      if (session.results.theoretical.result.scope === 'firstDrop') throw { ar: t('sigmaFirstDrop', 'ar'), en: t('sigmaFirstDrop', 'en') };
      sigma = session.results.theoretical.result.distribution.sd;
    }
    const declared = num($('#a-declared').value);
    const options = { declaredRtp: declared === null ? null : declared / 100, confidence: Number($('#a-confidence').value), sigma };
    const result = await runTask('actual', { bytes: input.bytes, options }, progress);
    session.results.actual = { inputId: 'playlog', options, result, skipped: result.skipped };
    renderActual();
  });
}

function renderActual() {
  const box = $('#res-actual');
  box.replaceChildren();
  const ac = session.results.actual;
  if (!ac) return;
  const a = ac.result;
  box.append(cards([
    { k: 'observedRtp', v: pct(a.rtp, 4), cls: 'accent' },
    { k: 'ci', v: pct(a.ci[0], 3) + ' – ' + pct(a.ci[1], 3), s: (a.confidence * 100).toFixed(1) + '%' },
    { k: 'roundsChecked', v: a.rounds.toLocaleString('en-US') },
    { k: 'totalBet', v: fmt(a.totalBet, 2) },
    { k: 'totalWin', v: fmt(a.totalWin, 2) },
    { k: 'hitFrequency', v: pct(a.hitRate, 3) },
    { k: 'sigmaSource', v: fmt(a.sigmaUsed, 4), s: a.sigmaSource === 'declared' ? tr('declaredWord') : tr('observed') },
  ]));
  if (a.sigmaSource !== 'declared') box.append(el('p', { class: 'muted' }, tr('ciObservedNote')));
  if (a.declared) {
    const dd = a.declared;
    box.append(cards([
      { k: 'declaredRtp', v: pct(dd.rtp, 4) },
      { k: 'difference', v: (dd.difference >= 0 ? '+' : '') + pct(dd.difference, 4) },
      { k: 'zScore', v: fmt(dd.z, 3) },
      { k: 'pBelow', v: fmtP(dd.pBelow) },
    ]));
    box.append(el('div', { class: 'verdict ' + dd.verdict }, tr('verdict') + ': ' + pick(VERDICT[dd.verdict])));
    if (dd.verdict === 'insufficient') box.append(el('p', { class: 'muted' }, tr('insufficientNote')));
    if (dd.aboveDeclared) box.append(el('p', { class: 'muted' }, tr('aboveDeclared') + ' · P = ' + fmtP(dd.pAbove)));
    if (dd.roundsToDetect) box.append(el('p', { class: 'muted' }, tr('roundsToDetect') + ': ' + dd.roundsToDetect.toLocaleString('en-US')));
  }
  if (a.reliable === null) box.append(el('div', { class: 'verdict warn' }, tr('reliableUnknown')));
  else box.append(el('div', { class: 'verdict ' + (a.reliable ? 'pass' : 'warn') }, tr(a.reliable ? 'reliableYes' : 'reliableNo')));
  box.append(sub('roundsNeeded'), table(['margin', 'roundsChecked'], a.roundsNeeded.map((r) => [{ v: '± ' + pct(r.margin, 1), cls: 'num' }, { v: r.rounds.toLocaleString('en-US'), cls: 'num' }])));
  if (a.modes) {
    box.append(sub('byMode'), table(['modeName', 'roundsChecked', 'totalBet', 'totalWin', 'observedRtp'], a.modes.map((m) => [
      m.mode, { v: m.rounds.toLocaleString('en-US'), cls: 'num' }, { v: fmt(m.totalBet, 2), cls: 'num' }, { v: fmt(m.totalWin, 2), cls: 'num' }, { v: pct(m.rtp, 3), cls: 'num' },
    ])), el('p', { class: 'muted' }, tr('modesNote')));
  }
  const mg = a.merged;
  if (mg && (mg.freeRows || mg.sameRoundRows)) {
    const parts = [];
    if (mg.freeRows) parts.push(mg.freeRows.toLocaleString('en-US') + ' ' + tr('mergedFree'));
    if (mg.sameRoundRows) parts.push(mg.sameRoundRows.toLocaleString('en-US') + ' ' + tr('mergedSame'));
    box.append(el('p', { class: 'muted' }, tr('mergedRows') + ': ' + parts.join(' · ')));
  }
  if (ac.skipped) box.append(el('p', { class: 'muted' }, tr('skippedRows') + ': ' + ac.skipped + ' (' + tr('line') + ' ' + a.skippedSample.map((s) => s.line).join(', ') + ')'));
}

// ---------- distribution tests (core/audit-stats.js) ----------
// Uploaded distribution CSVs: { inputId, label, key }. The theoretical tab's model
// joins them as the first candidate when its box is ticked. A key names one upload
// for good (input ids pmf-0... are reused by the next upload), so the chosen
// reference never slides to another file when the list changes.
let distFiles = [], distUploads = 0;
const optNum = (s) => (String(s).trim() === '' ? null : Number(String(s).trim().replace(',', '.')));
function distCandidates() {
  const th = session.results.theoretical;
  const list = [];
  if ($('#d-useTheory').checked && th) list.push({ kind: 'exact', label: th.raw.name || 'model', inputId: 'model', key: 'model', th });
  for (const f of distFiles) list.push({ kind: 'csv', label: f.label, inputId: f.inputId, key: f.key });
  return list;
}
function renderDistCandidates() {
  const list = distCandidates();
  const box = $('#dist-candidates');
  box.textContent = list.length ? tr('distLoaded') + ': ' + list.map((c, i) => `${i + 1}. ${c.label}`).join(' · ') : tr('distNone');
  $('#clear-pmf').hidden = !distFiles.length;
  const sel = $('#d-ref'), keep = sel.value;
  sel.replaceChildren(...list.map((c, i) => el('option', { value: c.key }, `${i + 1}. ${c.label}`)));
  if (list.some((c) => c.key === keep)) sel.value = keep;
}
// A distribution-test result names its inputs by id. When one of them is replaced or
// removed, the report would attach other files than the ones tested: drop the result.
function dropDistTestsUsing(ids) {
  const d = session.results.distTests;
  if (!d || ![d.inputId, ...d.inputIds].some((id) => ids.includes(id))) return;
  delete session.results.distTests;
  renderDist();
  renderReportSections();
}
function replacePmfFiles() {
  const ids = [...session.inputs.keys()].filter((id) => id.startsWith('pmf-'));
  for (const id of ids) session.inputs.delete(id);
  dropDistTestsUsing(ids);
  distFiles = [];
  distUploads++;
}
async function addPmfFile(i, name, label, bytes, mime) {
  await registerInput('pmf-' + i, name, 'csv', bytes, mime);
  distFiles.push({ inputId: 'pmf-' + i, label, key: `pmf-${i}@${distUploads}` });
}

async function runDist() {
  await withTask('dist', async (progress) => {
    const input = session.inputs.get('playlog');
    if (!input) throw { ar: tr('noFile'), en: t('noFile', 'en') };
    const list = distCandidates();
    if (!list.length) throw { ar: t('distNoPmf', 'ar'), en: t('distNoPmf', 'en') };
    if (list.length > 5) throw { ar: t('distTooMany', 'ar'), en: t('distTooMany', 'en') };
    const candidates = list.map((c) => {
      if (c.kind === 'csv') return { kind: 'csv', label: c.label, bytes: session.inputs.get(c.inputId).bytes };
      const d = c.th.result.distribution;
      if (c.th.result.scope === 'firstDrop') throw { ar: t('distFirstDrop', 'ar'), en: t('distFirstDrop', 'en') };
      if (!d || !d.pmf) throw { ar: t('distNoModelPmf', 'ar'), en: t('distNoModelPmf', 'en') };
      // The whole round (free spins included) when available (P0-8); else the paid spin.
      const round = c.th.result.round;
      return { kind: 'exact', label: c.label, pmf: round && round.pmf ? round.pmf : d.pmf };
    });
    const refIndex = Math.max(0, list.findIndex((c) => c.key === $('#d-ref').value));
    // The theoretical model gives sigma, M and the RTP only when it is the reference:
    // another game's values would size the planner and bound the e-process wrongly.
    const ref = list[refIndex];
    const thd = ref.kind === 'exact' ? ref.th.result.distribution : null;
    let sigma = optNum($('#a-sigma').value), sigmaSource = 'input';
    if (sigma === null && thd) { sigma = thd.sd; sigmaSource = 'model'; }
    let maxWin = optNum($('#d-maxWin').value), maxWinSource = 'input';
    if (maxWin === null && thd && thd.maxWin && !thd.maxWin.unbounded) { maxWin = thd.maxWin.withFeature ?? thd.maxWin.base; maxWinSource = 'model'; }
    const declared = optNum($('#a-declared').value);
    const gap = optNum($('#d-gap').value);
    const options = {
      refIndex, alpha: Number($('#d-alpha').value), seed: $('#d-seed').value,
      declaredRtp: declared === null ? null : declared / 100, referenceRtp: ref.kind === 'exact' ? ref.th.result.rtp.value : null,
      sigma, sigmaSource, maxWin, maxWinSource, gap: gap > 0 ? gap / 100 : 0.02, mode: $('#d-mode').value.trim(),
    };
    const result = await runTask('distTests', { bytes: input.bytes, candidates, options }, progress);
    session.results.distTests = { inputId: 'playlog', inputIds: list.map((c) => c.inputId), candidates: list.map((c) => ({ label: c.label, kind: c.kind, inputId: c.inputId })), options, result };
    renderDist();
  });
}

const rounds = (v) => (v === null || v === undefined ? '—' : !Number.isFinite(v) ? '∞' : Math.ceil(v).toLocaleString('en-US'));
const times = (x) => fmt(x, 4) + '×';
function binLabel(b) {
  const range = b.lo === null ? null : b.lo === b.hi ? times(b.lo) : `${fmt(b.lo, 4)} – ${times(b.hi)}`;
  return [range, b.triggered ? tr('distTriggered') : null, b.rest ? tr('distRestCell') : null].filter(Boolean).join(' + ');
}
// Minimum detectable effect as a card: "±0.60%", "w = 0.0089 · relative change in
// the share of rounds with no win · at Holm's strictest level (α ÷ m): 0.001667".
const mdeLevel = (m) => `${tr('distMdeLevel')}: ${fmtP(m.alpha)}`;
function mdeCard(g) {
  const m = g.mde;
  const b = g.bins[m.bin];
  const zeroBin = b && b.lo === 0 && b.hi === 0 && !b.triggered;
  if (m.relativeChange === null) return { k: 'distMde', v: `w = ${fmt(m.w, 4)}`, s: mdeLevel(m) };
  return { k: 'distMde', v: '±' + pct(m.relativeChange, 2), s: `w = ${fmt(m.w, 4)} · ${tr('distMdeBin')} ${tr(zeroBin ? 'distNoWinShare' : 'distLargestBin')} · ${mdeLevel(m)}` };
}

const svgNs = 'http://www.w3.org/2000/svg';
function svg(tag, attrs = {}, text = null) {
  const n = document.createElementNS(svgNs, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  if (text !== null) n.textContent = text;
  return n;
}
// log10 of the bettor's capital over the rounds, with the 1/alpha line.
function eChart(b) {
  const W = 640, H = 210, L = 46, R = 10, T = 10, B = 28;
  const pts = b.trajectory;
  const n = Math.max(1, pts[pts.length - 1][0]);
  const thr = b.threshold / Math.LN10;
  const ys = pts.map((p) => p[1] / Math.LN10);
  const lo = Math.min(-1, ...ys), hi = Math.max(thr + 0.5, ...ys);
  const X = (r) => L + ((W - L - R) * r) / n, Y = (v) => T + ((H - T - B) * (hi - v)) / (hi - lo);
  const s = svg('svg', { viewBox: `0 0 ${W} ${H}`, class: 'chart echart', role: 'img', 'aria-label': tr('distChartTitle') });
  for (const [v, cls] of [[0, 'ezero'], [thr, 'ethr']]) {
    s.append(svg('line', { x1: L, x2: W - R, y1: Y(v), y2: Y(v), class: cls }));
    s.append(svg('text', { x: L - 6, y: Y(v) + 4, 'text-anchor': 'end' }, fmt(v, 2)));
  }
  s.append(svg('polyline', { points: pts.map((p, i) => `${X(p[0]).toFixed(1)},${Y(ys[i]).toFixed(1)}`).join(' '), class: 'eline' }));
  s.append(svg('text', { x: L, y: H - 8 }, '0'));
  s.append(svg('text', { x: W - R, y: H - 8, 'text-anchor': 'end' }, n.toLocaleString('en-US')));
  return el('figure', { class: 'echart-wrap' }, s, el('figcaption', { class: 'muted small' }, tr('distChartTitle')));
}

function renderDist() {
  const box = $('#res-dist');
  box.replaceChildren();
  const dt = session.results.distTests;
  if (!dt) return;
  const r = dt.result, f = r.fit;
  const ref = r.candidates[r.refIndex];
  const vcls = { consistent: 'pass', mismatch: 'fail', impossible: 'fail', insufficient: 'warn' };
  box.append(el('div', { class: 'verdict ' + vcls[f.verdict], id: 'dist-verdict' }, tr('verdict') + ': ' + tr('distV_' + f.verdict)));
  if (f.verdict === 'consistent') box.append(el('p', { class: 'muted' }, tr('distPassNote')));
  if (f.verdict === 'mismatch') box.append(el('p', { class: 'muted' }, tr('distMismatchNote')));
  if (f.verdict === 'impossible') box.append(el('p', { class: 'muted' }, tr('distImpossibleNote')));
  if (f.unavailable) box.append(el('div', { class: 'verdict warn' }, tr('distNeedTrigger')));
  if (r.mixedModes) box.append(el('div', { class: 'verdict warn' }, tr('distMixedModes') + ' (' + r.modes.join(', ') + ')'));
  const g = f.gof;
  const inFamily = (id, index) => f.tests.find((x) => x.id === id && (index === undefined || x.index === index));
  const gt = inFamily('gof');
  box.append(cards([
    { k: 'roundsChecked', v: r.rounds.toLocaleString('en-US'), s: r.mode ? tr('modeName') + ': ' + r.mode : null },
    { k: 'distReference', v: ref.label, s: tr(ref.scope === 'round' ? 'distScopeRound' : 'distScopeBase') },
    g && g.applicable && { k: 'distMcP', v: fmtP(g.pValue), s: `G ${fmt(g.G, 2)} · df ${g.df} · ${g.replicates.toLocaleString('en-US')} MC`, cls: !gt ? '' : gt.rejected ? 'bad' : 'good' },
    g && g.applicable && g.mde && mdeCard(g),
    f.offSupport && f.offSupport.count > 0 && { k: 'distOff', v: f.offSupport.count.toLocaleString('en-US'), cls: 'bad', s: f.offSupport.examples.map((e) => `#${e.round}: ${times(e.x)}`).join(' · ') },
  ]));
  if (g && g.applicable && !g.inFamily) box.append(el('p', { class: 'muted small', id: 'dist-gof-floor' }, tr('distGofFloorNote')));
  const normalized = r.candidates.filter((c) => c.normalizedFrom !== null);
  if (normalized.length) box.append(el('p', { class: 'muted small', id: 'dist-normalized' }, tr('distNormalized') + ': ' + normalized.map((c) => `${c.label} (${tr('distSum')}: ${fmt(c.normalizedFrom, 8)})`).join(' · ')));

  // The family of tests.
  const status = (t, out = 'distTooRare') => (!t ? { v: tr(out), cls: 'na' } : t.rejected ? { v: tr('distReject'), cls: 'fail' } : { v: tr('distKeep'), cls: 'pass' });
  // Columns: test | observed | expected | P | status (no words inside the number cells).
  const mono = (v) => ({ v, cls: 'mono' });
  const rate = (x, d) => [mono(`${pct(x.rate, d)} [${pct(x.ci[0], d)} – ${pct(x.ci[1], d)}]`), mono(pct(x.expected, d)), mono(fmtP(x.pValue))];
  const rows = [];
  if (g && g.applicable) rows.push([tr('distGof'), mono(`G ${fmt(g.G, 2)} · χ² ${fmt(g.X2, 2)}`), mono(`df ${g.df}`), mono(`${fmtP(g.pValue)} · χ² ${fmtP(g.pValueX2)}`), status(gt, 'distGofOut')]);
  if (f.hit) rows.push([tr('distHit'), ...rate(f.hit, 3), status(inFamily('hit'))]);
  if (f.trigger) rows.push([tr('distTrigger'), ...rate(f.trigger, 4), status(inFamily('trigger'))]);
  (f.tails || []).forEach((t, i) => rows.push([`${tr('distTailRow')} ${times(t.threshold)}`, mono(t.observed.toLocaleString('en-US')), mono(fmt(t.expected, 2)), mono(fmtP(t.pValue)), status(inFamily('tail', i))]));
  if (rows.length) box.append(sub('distTests'), table(['test', 'distObserved', 'distExpected', 'pValue', 'result'], rows));
  if (f.tails && f.tails.length) box.append(el('p', { class: 'muted small' }, tr('distTailNote')));
  if (f.total) {
    const tt = f.total;
    // No draw at or below the total (or every draw): only a bound is known.
    const est = tt.count === 0 ? `< ${fmtP(1 / tt.replicates)}` : tt.count === tt.replicates ? `> ${fmtP(1 - 1 / tt.replicates)}` : `≈ ${fmtP(tt.estimate)} ± ${fmtP(tt.se)}`;
    box.append(el('p', { class: 'muted', id: 'dist-total' }, `${tr('distTotal')}: ${est} (${tr('distObserved')} ${fmt(tt.sum, 2)} · ${tr('distExpected')} ${fmt(tt.expected, 2)}). ${tr('distTotalNote')} (${tr('distDraws')}: ${tt.replicates.toLocaleString('en-US')}).`));
  }
  if (f.hit) box.append(el('p', { class: 'muted small' }, `${tr('distMdeRate')} (${tr('distHit')}): ${pct(f.hit.mde.absolute, 3)}` + (f.trigger ? ` · (${tr('distTrigger')}): ${pct(f.trigger.mde.absolute, 4)}` : '') + ` · ${mdeLevel(f.hit.mde)}`));

  if (f.topPrize) {
    const tp = f.topPrize;
    box.append(sub('distTop'), cards([
      { k: 'distTop', v: times(tp.x), s: tp.paidSpinOnly ? tr('distTopBase') : null },
      { k: 'distTopProb', v: tp.probability.toExponential(3), s: tr('oneIn') + ' ' + fmt(tp.oneIn, 0) + ' ' + tr('rounds') },
      { k: 'distTopExpected', v: fmt(tp.expected, 3), s: tr('distTopSeen') + ': ' + tp.observed.toLocaleString('en-US') },
      { k: 'distTopNever', v: pct(tp.pNeverSeen, 2) },
      tp.ruleOfThree !== null && { k: 'distRuleOfThree', v: tp.ruleOfThree.toExponential(3), s: '≈ 3 / ' + r.rounds.toLocaleString('en-US') },
      tp.rtpShare !== null && { k: 'distTopShare', v: pct(tp.rtpShare, 2) },
      { k: 'distTopFor95', v: rounds(tp.roundsFor95) },
    ]));
  }
  if (f.unseen) box.append(el('p', { class: 'muted' }, `${tr('distUnseen')}: ${pct(f.unseen.rtpAbove, 3)} (${tr('distMaxObserved')}: ${times(f.unseen.maxObserved)})`));
  if (g && g.applicable) {
    const d = el('details', { class: 'table-view' }, el('summary', {}, tr('distBins') + ` (${g.bins.length})`),
      table(['range', 'distObserved', 'distExpected', 'probability'], g.bins.map((b) => [{ v: binLabel(b), cls: 'num' }, { v: b.observed.toLocaleString('en-US'), cls: 'num' }, { v: fmt(b.expected, 2), cls: 'num' }, { v: b.p.toExponential(4), cls: 'mono' }])));
    box.append(d);
  }

  // Versions.
  const v = r.versions;
  if (v && v.error) box.append(sub('distVersions'), el('div', { class: 'verdict warn' }, pick([v.error.ar, v.error.en])));
  else if (v) {
    box.append(sub('distVersions'));
    const s = v.sequential;
    box.append(el('div', { class: 'verdict ' + (s.decision === null ? 'warn' : s.decision === v.refIndex ? 'pass' : 'fail'), id: 'dist-sprt' },
      s.decision === null ? tr('distSprtContinue') : `${tr('distSprtDecided')} ${v.models[s.decision].label} ${tr('distAtRound')} ${s.at.toLocaleString('en-US')}`));
    const vt = table(['distVersion', 'distPmfRtp', 'distLogLik', 'distPosterior', 'distAsn'], v.models.map((m, i) => [
      (i === v.refIndex ? '★ ' : '') + m.label, { v: r.candidates[i].scope === 'round' ? pct(r.candidates[i].mean, 3) : '—', cls: 'num' },
      { v: Number.isFinite(m.logLik) ? fmt(m.logLik, 2) : '−∞', cls: 'num' }, { v: pct(m.posterior, 2), cls: 'num' }, { v: rounds(m.asn), cls: 'num' },
    ]));
    vt.id = 'dist-versions';
    box.append(vt);
    box.append(table(['distVersion', 'distKl', 'distPairAsn'], v.pairs.map((p) => [p.label, { v: `${p.klRefAlt.toExponential(3)} / ${p.klAltRef.toExponential(3)}`, cls: 'mono' }, { v: `${rounds(p.asnRef)} / ${rounds(p.asnAlt)}`, cls: 'num' }])));
    const wald = v.pairs.length === 1 && v.pairs[0].sprt;
    if (wald) box.append(el('p', { class: 'muted' }, `${tr('distWald')}: ` + (wald.decision === 'continue' ? tr('distSprtContinue') : `${tr(wald.decision === 'reference' ? 'distWaldRef' : 'distWaldAlt')} ${tr('distAtRound')} ${wald.at.toLocaleString('en-US')}`)));
    if (v.unmatched) box.append(el('p', { class: 'muted' }, tr('distUnmatched') + ': ' + v.unmatched.toLocaleString('en-US')));
    box.append(el('p', { class: 'muted small' }, tr('distSprtNote')));
  }

  // Betting e-process.
  const b = r.betting;
  box.append(sub('distBetting'));
  if (b.needs) box.append(el('div', { class: 'verdict warn', id: 'dist-bet' }, tr(b.needs === 'maxWin' ? 'distNeedsMax' : 'distNeedsDeclared')));
  else if (b.error) box.append(el('div', { class: 'verdict warn', id: 'dist-bet' }, pick([b.error.ar, b.error.en]) + (b.maxWinSource ? ` (M: ${tr('distSrc_' + b.maxWinSource)})` : '')));
  else {
    box.append(el('div', { class: 'verdict ' + (b.rejected ? 'fail' : 'pass'), id: 'dist-bet' }, tr(b.rejected ? 'distBetReject' : 'distBetKeep')));
    box.append(cards([
      { k: b.mu0Source === 'reference' ? 'distRefRtp' : 'declaredRtp', v: pct(b.mu0, 3), s: `M = ${times(b.M)} (${tr('distSrc_' + b.maxWinSource)})` },
      { k: 'distEValue', v: fmt(b.eValue, 4), s: '1/α = ' + fmt(1 / b.alpha, 0) },
      { k: 'distMaxE', v: fmt(b.maxEValue, 4), cls: b.rejected ? 'bad' : '' },
      { k: 'distAnytimeP', v: fmtP(b.pValue) },
      { k: 'distUpper', v: b.upperBound === null ? `> ${pct(b.gridTop, 0)}` : (b.belowGrid ? '≤ ' : '') + pct(b.upperBound, 1), s: `${((1 - b.alpha) * 100).toFixed(1)}%` },
      b.crossedAt && { k: 'distCrossed', v: b.crossedAt.toLocaleString('en-US') },
    ]));
    box.append(eChart(b));
  }
  if (b.declaredDiffers) box.append(el('p', { class: 'verdict warn', id: 'dist-declared-differs' }, `${tr('distDeclaredDiffers')}: ${pct(b.declaredDiffers, 3)} ≠ ${pct(b.mu0, 3)}`));
  box.append(el('p', { class: 'muted small' }, tr('distBetNote')));

  // Planner.
  const pl = r.planner;
  box.append(sub('distPlanner'));
  box.append(table(['distPlanMethod', 'distPlanNeeds', 'distPlanRounds'], pl.rows.map((x) => [
    tr('plan_' + x.id) + (x.version ? ' ' + x.version : ''), tr('planNeeds_' + x.needs), { v: (x.approx && x.rounds !== null ? '≈ ' : '') + rounds(x.rounds), cls: 'num' },
  ])));
  box.append(el('p', { class: 'muted small', id: 'dist-plan-grid' }, tr('distPlanGrid') + ` (${tr('distGap')}: ${fmt(pl.gap * 100, 2)}` + (pl.sigma ? ` · σ: ${fmt(pl.sigma, 3)} ${tr('distSrc_' + pl.sigmaSource)}` : '') + ')'));
  box.append(table(['σ', 'distPlanMean', ...pl.maxWins.map((m) => ['M = ' + m.toLocaleString('en-US') + '×', 'M = ' + m.toLocaleString('en-US') + '×'])], pl.grid.map((gr) => [
    { v: fmt(gr.sigma, 3), cls: 'num' }, { v: rounds(gr.meanTest), cls: 'num' }, ...gr.eProcess.map((e) => ({ v: rounds(e.rounds), cls: 'num' })),
  ])));
  box.append(el('p', { class: 'muted small' }, tr('distPlanNote') + ' ' + tr('distSeedNote') + ` (${r.seed})`));
}

// ---------- RNG tests ----------
async function runRng() {
  await withTask('rng', async (progress) => {
    const input = session.inputs.get('rng');
    if (!input) throw { ar: tr('noFile'), en: t('noFile', 'en') };
    const num = (s) => (String(s).trim() === '' ? null : Number(s));
    const options = { mode: $('#r-mode').value, min: num($('#r-min').value), max: num($('#r-max').value), twoLevel: $('#r-twoLevel').checked };
    const result = await runTask('rng', { bytes: input.bytes, options }, progress);
    input.kind = result.parsed.kind === 'binary' ? 'binary' : 'text';
    session.results.rng = { inputId: 'rng', options, ...result };
    renderRng();
  });
}

// "12 sequences" / "عدد التسلسلات: 12" (Arabic counted nouns change form with the number).
const seqText = (n) => (lang === 'en' ? `${n} ${tr('sequences')}` : `${tr('sequences')}: ${n}`);
const STATUS_CLASS = { pass: 'pass', flag: 'warn', fail: 'fail' };
function statusCell(status) {
  if (status === 'na') return { v: tr('notApplicable'), cls: 'na' };
  return { v: tr(status), cls: STATUS_CLASS[status] || 'fail' };
}
// Older saved results have only pass/fail.
const statusOf = (r) => r.status || (r.pass ? 'pass' : 'fail');

function renderRng() {
  const box = $('#res-rng');
  box.replaceChildren();
  const rg = session.results.rng;
  if (!rg) return;
  const applicable = rg.nist.results.filter((r) => r.applicable);
  const passed = applicable.filter((r) => statusOf(r) === 'pass').length;
  const fam = rg.family;
  box.append(cards([
    fam && { k: 'familyVerdict', v: tr(fam.pass ? 'pass' : 'fail'), s: `Holm · ${fam.pValueCount} P · α = ${fam.alpha}`, cls: fam.pass ? 'good' : 'bad' },
    { k: 'test', v: `${passed} / ${applicable.length}`, s: 'NIST SP 800-22' + (rg.nist.twoLevel ? ' · ' + seqText(rg.nist.sequences) : ''), cls: passed === applicable.length ? 'good' : fam && fam.pass ? '' : 'bad' },
    fam && { k: 'familyDetail', v: `${fam.belowAlpha} / ${fam.pValueCount}`, s: tr('familyExpected') + ' ≈ ' + fmt(fam.expectedBelowAlpha, 1) },
    { k: 'bitsCount', v: rg.parsed.nBits.toLocaleString('en-US') },
    { k: 'valuesCount', v: rg.parsed.nValues.toLocaleString('en-US'), s: rg.parsed.kind + ' · ' + rg.parsed.min + '..' + rg.parsed.max },
  ]));
  if (fam) box.append(el('div', { class: 'verdict ' + (fam.pass ? 'pass' : 'fail') }, tr(fam.pass ? 'familyPass' : 'familyFail')));
  for (const n of rg.parsed.notes) box.append(el('p', { class: 'muted small' }, n));
  const pText = (r) => {
    if (rg.nist.twoLevel) {
      return `${seqText(r.sequences)} · ${tr('minProportion')} ${(r.minProportion * 100).toFixed(1)}%`
        + (r.minUniformityP === null ? '' : ` · min P_T ${fmtP(r.minUniformityP)}`)
        + (r.subtestCount > 1 ? ` · ${tr('subtestsFailing')}: ${r.subtestsFailing} ${tr('ofWord')} ${r.subtestCount} (${tr('familyExpected')} ≈ ${fmt(r.subtestsExpectedFailing, 1)})` : '');
    }
    const ps = r.pValues;
    return ps.length === 1 ? fmtP(ps[0]) : `min ${fmtP(Math.min(...ps))} · ${ps.filter((p) => p < 0.01).length}/${ps.length} < 0.01`;
  };
  const rows = rg.nist.results.map((r) => {
    const name = pick(NIST_NAMES[r.id]);
    if (!r.applicable) return [name, { v: r.requirement + (r.reason ? ' · ' + r.reason : ''), cls: 'na' }, { v: tr('notApplicable'), cls: 'na' }];
    return [name, { v: pText(r), cls: 'mono' }, statusCell(statusOf(r))];
  });
  rows.push([tr('chiSquare'), { v: `χ² ${fmt(rg.chi.chi2, 2)} · df ${rg.chi.df} · P ${fmtP(rg.chi.pValue)}`, cls: 'mono' }, statusCell(rg.chi.status || (rg.chi.pass ? 'pass' : 'fail'))]);
  rows.push([tr('serialCorr'), { v: rg.serial.r === null ? '—' : `r ${fmt(rg.serial.r, 6)} · P ${fmtP(rg.serial.pValue)}`, cls: 'mono' }, statusCell(rg.serial.status || (rg.serial.pass ? 'pass' : 'fail'))]);
  box.append(table(['test', 'pValue', 'result'], rows), el('p', { class: 'muted small' }, tr('nistPassRule')));
  if (rg.nist.twoLevel) box.append(el('p', { class: 'muted small' }, tr('twoLevelRule')));
}

// ---------- provably fair ----------
function fairOptions() {
  if ($('#p-scheme').value === 'chain') return { order: $('#p-order').value, input: $('#p-input').value };
  return { template: $('#p-template').value, keyFrom: $('#p-key').value, outcomeType: $('#p-outcome').value, range: Number($('#p-range').value), offset: Number($('#p-offset').value), tolerance: Number($('#p-tolerance').value) };
}
function syncFairFields() {
  const chain = $('#p-scheme').value === 'chain';
  $('#hmacFields').hidden = chain;
  $('#chainFields').hidden = !chain;
  $('#sample-fair').textContent = tr(chain ? 'sampleChain' : 'sampleFair');
  syncPfFields();
}

async function runFair() {
  await withTask('fair', async (progress) => {
    const input = session.inputs.get('fair');
    if (!input) throw { ar: tr('noFile'), en: t('noFile', 'en') };
    if (pfMode()) { await runPf(input, progress); return; }
    const scheme = $('#p-scheme').value, options = fairOptions();
    const t0 = performance.now();
    const result = await runTask('fair', { bytes: input.bytes, scheme, options }, progress);
    session.results.fair = { inputId: 'fair', scheme, options, result, ms: performance.now() - t0 };
    renderFair();
  });
}

function renderFair() {
  const box = $('#res-fair');
  box.replaceChildren();
  const fr = session.results.fair;
  if (!fr) return;
  if (fr.mode === 'adapter') { renderPfResult(box, fr); return; }
  const f = fr.result;
  const secs = (fr.ms / 1000).toFixed(2) + ' ' + tr('seconds');
  if (fr.scheme === 'chain') {
    box.append(cards([{ k: 'chainLinks', v: f.links.toLocaleString('en-US'), s: tr('verifyEnd') + ' ' + secs }, { k: 'chainBreaks', v: f.breaks.length, cls: f.breaks.length ? 'bad' : 'good' }]));
    box.append(el('div', { class: 'verdict ' + (f.ok ? 'pass' : 'fail') }, tr(f.ok ? 'allVerified' : 'someFailed')));
    if (f.breaks.length) box.append(table(['line', 'expected', 'claimed'], f.breaks.slice(0, 50).map((b) => [{ v: b.index, cls: 'num' }, { v: b.expected, cls: 'mono' }, { v: b.found, cls: 'mono' }])));
    return;
  }
  box.append(cards([
    { k: 'roundsChecked', v: f.rows.toLocaleString('en-US'), s: tr('verifyEnd') + ' ' + secs },
    { k: 'commitments', v: `${(f.commitmentsChecked - f.commitmentFailures.length).toLocaleString('en-US')} / ${f.commitmentsChecked.toLocaleString('en-US')}`, cls: f.commitmentFailures.length ? 'bad' : 'good' },
    { k: 'results', v: `${(f.resultsChecked - f.mismatches.length).toLocaleString('en-US')} / ${f.resultsChecked.toLocaleString('en-US')}`, cls: f.mismatches.length ? 'bad' : 'good' },
    f.uniformity && { k: 'uniformity', v: 'P ' + fmtP(f.uniformity.pValue), s: 'χ² ' + fmt(f.uniformity.chi2, 2) + ' · 20 bins', cls: f.uniformity.pass ? 'good' : 'bad' },
  ]));
  box.append(el('div', { class: 'verdict ' + (f.ok ? 'pass' : 'fail') }, tr(f.ok ? 'allVerified' : 'someFailed')));
  const bad = [...f.commitmentFailures.map((m) => [{ v: m.line, cls: 'num' }, 'SHA-256 ≠', { v: m.claimed, cls: 'mono' }]), ...f.mismatches.map((m) => [{ v: m.line, cls: 'num' }, { v: String(m.expected), cls: 'mono' }, { v: m.claimed, cls: 'mono' }]), ...f.invalid.map((m) => [{ v: m.line, cls: 'num' }, m.reason, ''])];
  if (bad.length) box.append(sub('mismatches'), table(['line', 'expected', 'claimed'], bad.slice(0, 100)));
}

// ---------- provably fair v2: operator adapters and batch audit ----------
// Adapter metadata (with the Worker's self-test results) is loaded the first time
// the tab opens; "custom" keeps the generic HMAC-template / hash-chain mode above.
let pfAdapters = null, pfLoading = null;
const pfMode = () => $('#p-adapter').value !== 'custom';
const pfIds = () => [...new Set((pfAdapters || []).map((a) => a.id))];
function loadPfAdapters() {
  if (pfAdapters || pfLoading) return pfLoading;
  pfLoading = runTask('pfInfo', {}).then((info) => { pfAdapters = info.adapters; syncPfFields(); }, (e) => { pfLoading = null; showError('fair', e); });
  return pfLoading;
}
function currentPf() {
  if (!pfAdapters || !pfMode()) return null;
  const id = $('#p-adapter').value, version = $('#p-version').value;
  return pfAdapters.find((a) => a.id === id && a.version === version) || pfAdapters.find((a) => a.id === id) || null;
}
function fillSelect(sel, items) {
  const prev = sel.value;
  sel.replaceChildren(...items.map(([value, text]) => el('option', { value }, text)));
  if (items.some(([v]) => v === prev)) sel.value = prev;
}
function syncPfFields() {
  const sel = $('#p-adapter');
  if (pfAdapters) {
    const prev = sel.value;
    sel.replaceChildren(el('option', { value: 'custom' }, tr('pfCustom')), ...pfIds().map((id) => {
      const versions = pfAdapters.filter((a) => a.id === id);
      const off = versions.every((x) => x.selfTest && !x.selfTest.ok);
      return el('option', { value: id }, `${pick(versions[0].name)} · ${tr('pfEv_' + versions[0].evidence)}${off ? ' · ' + tr('pfDisabled') : ''}`);
    }));
    sel.value = [...sel.options].some((o) => o.value === prev) ? prev : 'custom';
  }
  const on = pfMode();
  $('#customFields').hidden = on;
  $('#pfFields').hidden = !on;
  $('#pfInfo').hidden = !on;
  $('#pfVersionLabel').hidden = true;
  if (!on) { $('#sample-fair').textContent = tr($('#p-scheme').value === 'chain' ? 'sampleChain' : 'sampleFair'); return; }
  $('#sample-fair').textContent = tr('pfSample');
  if (!pfAdapters) return;
  const versions = pfAdapters.filter((a) => a.id === sel.value);
  fillSelect($('#p-version'), versions.map((a) => [a.version, `${a.version} · ${tr('pfEv_' + a.evidence)}`]));
  $('#pfVersionLabel').hidden = versions.length < 2;
  const a = currentPf();
  const games = Object.keys(a.games || {});
  fillSelect($('#p-game'), games.map((g) => [g, g]));
  if (!games.includes($('#p-game').value) && a.defaultGame) $('#p-game').value = a.defaultGame;
  $('#pfGameLabel').hidden = games.length < 2;
  $('#pfLimboLabel').hidden = !games.includes('limbo');
  $('#pfTilesLabel').hidden = !games.includes('mines');
  $('#pfEraLabel').hidden = !a.eraOption;
  if (a.eraOption) fillSelect($('#p-era'), a.eraOption.map((e) => [e, tr('pfEra_' + e)]));
  $('#pfExactLabel').hidden = a.kind === 'chain';
  $('#pfChainFields').hidden = a.kind !== 'chain';
  renderPfInfo(a);
}
const evBadge = (ev) => el('span', { class: 'ev ev-' + ev }, tr('pfEv_' + ev));
function renderPfInfo(a) {
  const box = $('#pfInfo');
  box.replaceChildren();
  if (!a) return;
  const game = a.games && a.games[$('#p-game').value];
  const enc = a.kind === 'chain' ? (a.link === 'era' ? 'pfLinkEra' : a.link === 'raw' ? 'pfLinkRaw' : 'pfLinkHex') : a.keyEncoding === 'hex' ? 'pfKeyHex' : a.keyEncoding === 'text' ? 'pfKeyText' : null;
  box.append(
    el('div', { class: 'pf-head' }, el('strong', {}, `${pick(a.name)} · ${a.version}`), evBadge(a.evidence)),
    el('p', { class: 'muted small' }, tr('pfEvNote_' + a.evidence)),
    game && game.formula ? el('div', { class: 'small' }, tr('pfFormula') + ': ', el('span', { class: 'formula' }, game.formula)) : null,
    enc ? el('div', { class: 'small muted' }, tr(enc)) : null,
    el('div', { class: 'small muted pf-src' }, tr('pfSource') + ': ', el('a', { href: a.sourceUrl, target: '_blank', rel: 'noopener noreferrer' }, a.sourceUrl), ' · ' + tr('pfCaptureDate') + ': ' + a.captureDate),
    el('p', { class: 'small' }, pick(a.notes)),
  );
  const st = a.selfTest;
  if (st && st.ok) box.append(el('div', { class: 'small pf-selftest' }, `${tr('pfSelfTest')}: ${tr('pfSelfTestPassed')} ${st.passed} / ${st.total}`));
  else if (st) box.append(el('div', { class: 'verdict fail pf-selftest' }, `${tr('pfDisabled')} (${st.passed} / ${st.total}): ${st.failures.map((f) => f.name).join('; ')}`), el('p', { class: 'muted small' }, tr('pfDisabledNote')));
}

function pfOptions() {
  let paytable = null;
  const pt = $('#p-paytable').value.trim();
  if (pt) { try { paytable = JSON.parse(pt); } catch (e) { throw { ar: t('pfPaytableInvalid', 'ar'), en: t('pfPaytableInvalid', 'en') }; } }
  return {
    game: $('#p-game').value || null, limboFormula: $('#p-limbo').value, tileBase: Number($('#p-tiles').value),
    era: $('#pfEraLabel').hidden ? null : $('#p-era').value, exactSeeds: $('#p-exact').checked,
    walkTerminating: $('#p-walk').checked, terminating: $('#p-terminating').value.trim() || null, paytable,
  };
}

async function runPf(input, progress) {
  await loadPfAdapters();
  const a = currentPf();
  if (!a) throw { ar: t('pfLoadFailed', 'ar'), en: t('pfLoadFailed', 'en') };
  if (a.selfTest && !a.selfTest.ok) throw { ar: t('pfDisabledNote', 'ar'), en: t('pfDisabledNote', 'en') };
  const options = pfOptions();
  const t0 = performance.now();
  const result = await runTask('pfAudit', { bytes: input.bytes, key: a.key, options }, progress);
  session.results.fair = { mode: 'adapter', inputId: 'fair', adapter: a, options, result, ms: performance.now() - t0 };
  renderFair();
}

async function samplePf() {
  await loadPfAdapters();
  const a = currentPf();
  if (!a) throw { ar: t('pfLoadFailed', 'ar'), en: t('pfLoadFailed', 'en') };
  const s = await runTask('pfSample', { key: a.key, rounds: a.kind === 'chain' ? 300 : 600, plant: $('#p-plant').checked });
  await registerInput('fair', s.name, 'csv', s.bytes, 'text/csv');
  fileNames.fair = s.name + ' · ' + s.bytes.length.toLocaleString('en-US') + ' ' + tr('bytes');
  $('#name-fair').textContent = fileNames.fair;
  $('#p-paytable').value = s.options.paytable ? JSON.stringify(s.options.paytable) : '';
  $('#p-walk').checked = !!s.options.walkTerminating;
}

const PF_VERDICT_CLASS = { PASS: 'pass', CONDITIONAL: 'warn', FAIL: 'fail', INCONCLUSIVE: 'warn', NOTHING_CHECKED: 'warn' };
const SEV_ORDER = { fail: 0, warn: 1, info: 2 };
const SEV_CLASS = { fail: 'fail', warn: 'warn', info: 'na' };
const sumCounts = (counts, codes) => Object.entries(counts).filter(([c]) => codes.includes(c)).reduce((s, [, n]) => s + n, 0);
function renderPfResult(box, fr) {
  const r = fr.result, a = fr.adapter, v = r.verdict;
  const secs = (fr.ms / 1000).toFixed(2) + ' ' + tr('seconds');
  const checked = r.counts.ok + r.counts.mismatch;
  const okEpochs = r.epochs.filter((e) => e.commitment === 'ok').length;
  const fails = sumCounts(r.issueCounts, v.fails), warns = sumCounts(r.issueCounts, v.warns);
  const n = (x) => x.toLocaleString('en-US');
  box.append(el('div', { class: 'verdict ' + PF_VERDICT_CLASS[v.code], id: 'pf-verdict', 'data-code': v.code }, `${tr('pfVerdict')}: ${tr('pfV_' + v.code)} · ${tr('pfVerdictCode')} ${v.exit}`));
  const term = r.chain && r.chain.terminating;
  box.append(cards([
    { k: 'roundsChecked', v: n(r.rows), s: tr('verifyEnd') + ' ' + secs },
    { k: 'pfMatched', v: `${n(r.counts.ok)} / ${n(checked)}`, cls: r.counts.mismatch ? 'bad' : checked ? 'good' : '' },
    r.counts.notChecked ? { k: 'pfNotChecked', v: n(r.counts.notChecked) } : null,
    r.counts.computed ? { k: 'pfComputedOnly', v: n(r.counts.computed) } : null,
    r.epochs.length ? { k: 'pfEpochs', v: `${okEpochs} / ${r.epochs.length}`, cls: r.epochs.some((e) => e.commitment === 'mismatch') ? 'bad' : '' } : null,
    r.payout.checked ? { k: 'pfPayouts', v: `${n(r.payout.ok)} / ${n(r.payout.checked)}`, cls: r.payout.mismatch ? 'bad' : 'good' } : null,
    r.chain ? { k: 'pfChainLinks', v: n(r.chain.linksChecked), s: `${tr('pfChainBreaks')}: ${r.chain.breaks} · ${tr('pfLinksWalked')}: ${n(r.chain.linksWalked)}`, cls: r.chain.breaks ? 'bad' : '' } : null,
    term ? { k: 'pfTerminatingRes', v: term.status === 'ok' ? '✓' : '✗', s: term.links !== null && term.links !== undefined ? `${tr('pfLinksWalked')}: ${n(term.links)}` : null, cls: term.status === 'ok' ? 'good' : 'bad' } : null,
    { k: 'pfEvidence', v: tr('pfEv_' + r.adapter.evidence), s: `${a.id}@${a.version}` },
    { k: 'pfProblems', v: String(fails), cls: fails ? 'bad' : 'good' },
    { k: 'pfToReview', v: String(warns) },
  ]));
  if (term) box.append(el('div', { class: 'verdict ' + (term.status === 'ok' ? 'pass' : term.status === 'mismatch' ? 'fail' : 'warn'), id: 'pf-terminating' }, tr(term.status === 'ok' ? 'pfTerm_ok' : term.status === 'mismatch' ? 'pfTerm_mismatch' : term.status === 'no-target' ? 'pfTerm_noTarget' : 'pfTerm_notReached')));
  box.append(el('p', { class: 'muted small' }, tr('pfVerdictNote')));
  const issues = r.issues.slice().sort((x, y) => SEV_ORDER[x.severity] - SEV_ORDER[y.severity]);
  if (issues.length) {
    box.append(sub('pfIssuesTable'), table(['pfSeverity', 'pfDescription', 'line', 'expected', 'claimed', ''], issues.slice(0, 100).map((i) => [
      { v: tr('pfSev_' + i.severity), cls: SEV_CLASS[i.severity] }, tr('pfI_' + i.code),
      { v: i.line ?? (i.lines ? i.lines.slice(0, 4).join(' · ') : ''), cls: 'num' },
      { v: i.expected ?? '', cls: 'mono' }, { v: i.claimed ?? '', cls: 'mono' }, { v: pfIssueDetail(i, lang), cls: 'mono' },
    ])));
    box.lastChild.id = 'pf-issues';
  }
  // per-row verdicts: rounds that do not match (first), then rounds not checked, by line
  const rows = r.problemRows || [];
  if (rows.length) {
    box.append(sub('pfRowsTable'), table(['line', 'pfGame', 'pfRowStatus', 'expected', 'claimed'], rows.slice(0, 100).map((p) => [
      { v: p.line, cls: 'num' }, p.game || '—',
      p.status === 'mismatch' ? { v: tr('pfRow_mismatch'), cls: 'fail' } : { v: tr('pfR_' + p.reason), cls: 'na' },
      { v: p.computed ?? '—', cls: 'mono' }, { v: p.claimed ?? '', cls: 'mono' },
    ])));
    box.lastChild.id = 'pf-rows';
    const total = r.counts.mismatch + r.counts.notChecked;
    if (total > 100) box.append(el('p', { class: 'muted small' }, `${tr('pfRowsShown')}: 100 / ${n(total)}`));
  }
  if (r.epochs.length) {
    box.append(sub('pfEpochTable'), table(['pfCommitment', ['SHA-256', 'SHA-256'], 'roundsChecked', 'pfNonces', 'pfGaps', 'pfForward', 'pfMatched'], r.epochs.slice(0, 50).map((e) => [
      { v: tr('pfCm_' + e.commitment), cls: e.commitment === 'ok' ? 'pass' : e.commitment === 'mismatch' ? 'fail' : 'na' },
      { v: e.hash.slice(0, 16) + '…', cls: 'mono' }, { v: e.rows, cls: 'num' },
      { v: e.nonceMin === null ? '—' : `${e.nonceMin} – ${e.nonceMax}`, cls: 'num' }, { v: e.gaps, cls: 'num' },
      e.forward ? { v: tr('pfFw_' + e.forward), cls: e.forward === 'break' ? 'fail' : e.forward === 'gap' ? 'warn' : e.forward === 'ok' ? 'pass' : 'na' } : '—',
      { v: `${e.ok} / ${e.ok + e.mismatch}`, cls: 'num' },
    ])), el('p', { class: 'muted small' }, tr('pfCommitmentNote')));
    if (r.listed === 'newest-first') box.append(el('p', { class: 'muted small' }, tr('pfListedNewest')));
  }
  if (r.uniformity.length) {
    box.append(sub('pfUniformity'), table(['pfGame', 'roundsChecked', ['χ² / df', 'χ² / df'], 'pValue', 'result'], r.uniformity.map((u) => [
      u.game + (u.group.rows ? ` (${u.group.rows})` : ''), { v: n(u.n), cls: 'num' },
      { v: u.chi2 === null ? '—' : `${fmt(u.chi2, 2)} / ${u.df}`, cls: 'mono' }, { v: fmtP(u.pValue), cls: 'mono' },
      u.status === 'na' ? { v: tr('pfInsufficient'), cls: 'na' } : u.status === 'pass' ? { v: tr('pfNotRejected'), cls: 'pass' } : statusCell(u.status),
    ])), el('p', { class: 'muted small' }, tr('pfUniformityNote')));
  }
  const reasons = Object.entries(r.counts.notCheckedBy);
  if (reasons.length) box.append(sub('pfNotCheckedReasons'), table(['pfDescription', 'roundsChecked'], reasons.map(([k, c]) => [tr('pfR_' + k), { v: n(c), cls: 'num' }])));
  box.append(el('p', { class: 'muted small' }, tr('pfEvNote_' + r.adapter.evidence)));
}

// ---------- Monte Carlo ----------
function renderMcModel() {
  const th = session.results.theoretical;
  $('#mc-model').textContent = th ? `${tr('game')}: ${th.raw.name || '—'} · ${tr('modelHash')}: ${th.modelSha256.slice(0, 16)}…` : tr('needModel');
  $('#run-mc').disabled = !th;
}

async function runMc(compareTo = null) {
  const th = session.results.theoretical;
  if (!th) return;
  $('#stop-mc').hidden = false;
  await withTask('mc', async (progress) => {
    const spins = Number($('#m-spins').value), seed = $('#m-seed').value;
    const t0 = performance.now();
    const run = await runTask('montecarlo', { raw: th.raw, seed, spins, modelSha256: th.modelSha256 }, progress);
    // Ways games with free spins: the paid spin's exact mean as a control variate.
    const cvMean = th.result.controlVariate;
    const cv = cvMean && th.result.freeSpins && run.result.paidSpin ? controlVariate(run.result, cvMean.mean.value, normalizeModel(th.raw).totalBetUnits) : null;
    session.results.montecarlo = { ...run, exactRtp: th.result.rtp.value, ms: performance.now() - t0, confirmed: compareTo ? compareTo === run.resultSha256 : null, controlVariate: cv };
    renderMc();
  });
  $('#stop-mc').hidden = true;
}

function renderMc() {
  const box = $('#res-mc');
  box.replaceChildren();
  const mc = session.results.montecarlo;
  if (!mc) return;
  const s = mc.result;
  const z = (s.rtp - mc.exactRtp) / s.standardError;
  const cv = mc.controlVariate;
  box.append(cards([
    { k: s.scope === 'firstDrop' ? 'simRtpFirstDrop' : 'simRtp', v: pct(s.rtp, 4), s: '95%: ' + pct(s.ci95[0], 3) + ' – ' + pct(s.ci95[1], 3), cls: 'accent' },
    cv && { k: s.scope === 'firstDrop' ? 'cvRtpFirstDrop' : 'cvRtp', v: pct(cv.rtp, 4), s: '95%: ' + pct(cv.ci95[0], 3) + ' – ' + pct(cv.ci95[1], 3) },
    { k: 'vsExact', v: pct(mc.exactRtp, 4), s: 'z = ' + fmt(z, 2), cls: Math.abs(z) < 4 ? 'good' : 'bad' },
    { k: 'hitFrequency', v: pct(s.hitFrequency, 3) },
    { k: 'sd', v: fmt(s.sd, 3) },
    { k: 'maxWinBase', v: fmt(s.maxWin, 2) + '×' },
    { k: 'triggers', v: s.triggers.toLocaleString('en-US') },
    { k: 'spins', v: mc.spins.toLocaleString('en-US'), s: (mc.ms / 1000).toFixed(1) + ' ' + tr('seconds') },
  ]));
  box.append(el('div', { class: 'box' },
    el('div', { class: 'muted small' }, tr('prng')), el('div', { class: 'hash' }, mc.generator),
    el('div', { class: 'muted small' }, tr('seed') + ' · ' + tr('spins')), el('div', { class: 'hash' }, `"${mc.seed}" · ${mc.spins}`),
    el('div', { class: 'muted small' }, tr('modelHash')), el('div', { class: 'hash' }, mc.modelSha256),
    el('div', { class: 'muted small' }, tr('resultDigest')), el('div', { class: 'hash', id: 'mc-digest' }, mc.resultSha256),
    el('p', { class: 'muted small' }, tr('reproduce')),
  ));
  if (s.scope === 'firstDrop') box.append(el('p', { class: 'muted small' }, tr('firstDropNote')));
  if (cv) box.append(el('p', { class: 'muted small', id: 'mc-cv-note' }, `${tr('cvNote')} ${fill('cvSe', pct(cv.standardError, 4), pct(s.standardError, 4))} · μ = ${pct(cv.muX, 4)} · β = ${fmt(cv.beta, 4)}`));
  if (mc.confirmed !== null) box.append(el('div', { class: 'verdict ' + (mc.confirmed ? 'pass' : 'fail') }, tr(mc.confirmed ? 'sameAgain' : 'differentAgain')));
  const again = el('button', { type: 'button', id: 'rerun-mc' }, tr('rerun'));
  again.addEventListener('click', () => runMc(mc.resultSha256));
  box.append(again);
}

// ---------- outcome tables (LUT, P0-7) ----------
// The selected files: [{ name, bytes, mime }]; book files (.jsonl.zst) keep bytes null,
// are not read and are not attached to the report. A new selection replaces the array
// (never mutates it), so a run can tell whether the files it read are still the ones listed.
let lutSelection = [];
let lutInputIds = [];
let lutTagKey = null; // i18n key of the tag in front of the file names, e.g. the sample's
let lutGen = 0;
async function setLutFiles(files, tagKey = null) {
  const gen = ++lutGen;
  const read = files.filter((f) => f.bytes);
  const hashes = await Promise.all(read.map((f) => sha256Hex(f.bytes)));
  if (gen !== lutGen) return; // newer files were chosen while these were hashed
  // From here on everything is synchronous: the inputs, the selection and the cleared
  // result change together, so the report never pairs a result with other files.
  for (const id of lutInputIds) session.inputs.delete(id);
  lutInputIds = read.map((f, i) => {
    const id = 'lut:' + f.name;
    session.inputs.set(id, { id, name: f.name, kind: lutFileKind(f.name) === 'index' ? 'json' : 'csv', size: f.bytes.length, sha256: hashes[i], bytes: f.bytes, mime: f.mime });
    return id;
  });
  lutSelection = files;
  lutTagKey = tagKey;
  delete session.results.lut; // results always match the files listed
  renderLut();
}
// Built in the current language each time (applyLang re-renders it).
function showLutName() {
  if (!lutSelection.length) { $('#name-lut').textContent = tr('noFile'); return; }
  const total = lutSelection.reduce((s, f) => s + (f.bytes ? f.bytes.length : 0), 0);
  $('#name-lut').textContent = (lutTagKey ? tr(lutTagKey) + ': ' : '') + lutSelection.map((f) => f.name + (f.bytes ? '' : ' (' + tr('lutIgnored') + ')')).join(' · ')
    + ' · ' + total.toLocaleString('en-US') + ' ' + tr('bytes');
}

async function runLut() {
  await withTask('lut', async (progress) => {
    if (!lutSelection.length) throw { ar: t('noFile', 'ar'), en: t('noFile', 'en') };
    // The files and their input ids as they are now: other files may be chosen while this runs.
    const selection = lutSelection, inputIds = lutInputIds.slice();
    let result;
    try {
      result = await runTask('lut', { files: selection.map((f) => ({ name: f.name, bytes: f.bytes })) }, progress);
    } catch (e) {
      if (selection !== lutSelection) return; // an error about files no longer listed
      throw e;
    }
    if (selection !== lutSelection) return; // the files changed: this result is not theirs
    session.results.lut = { inputIds, result };
    renderLut();
  });
}

const lutProb = (v) => (v === null || v === undefined ? '—' : v === 0 ? '0%' : v < 1e-5 ? (v * 100).toExponential(2) + '%' : pct(v, 4));
const lutOneIn = (n) => (n === null || n === undefined ? '—' : tr('lutOneIn') + ' ' + fmt(n, n < 100 ? 2 : 0));
const lutBig = (s) => (/^\d+$/.test(String(s)) ? BigInt(s).toLocaleString('en-US') : String(s));
const iso = (s) => '\u2066' + s + '\u2069'; // keeps "50×" in that order inside Arabic text
function lutValue(unit, v) {
  if (typeof v === 'string') return lutBig(v);
  if (unit === 'rtp') return pct(v, 4);
  if (unit === 'p') return lutProb(v);
  if (unit === 'x' || unit === 'xc') return fmt(v, 4) + '×';
  return fmt(v, 4);
}

function renderLut() {
  showLutName();
  const box = $('#res-lut');
  box.replaceChildren();
  const lu = session.results.lut;
  if (!lu) return;
  const x = lu.result;
  box.append(sub('lutModes'), table(['lutMode', 'lutCostShort', 'rtp', 'lutHitShort', 'lutSdShort', 'lutMaxShort', 'probability'], x.modes.map((m) => [
    m.name, { v: m.cost.text + '×', cls: 'num' }, { v: m.rtp.percent + '%', cls: 'num' }, { v: pct(m.hitRate.value, 4), cls: 'num' },
    { v: fmt(m.sd, 4), cls: 'num' }, { v: fmt(m.maxWin.multiplier.value, 2) + '×', cls: 'num' }, lutOneIn(m.maxWin.oneIn),
  ])), el('p', { class: 'muted small' }, tr('lutCostNote')));

  for (const m of x.modes) {
    const fraction = m.rtp.fraction.length > 60 ? m.rtp.fraction.slice(0, 57) + '…' : m.rtp.fraction;
    box.append(el('h3', { class: 'lut-mode' }, `${tr('lutMode')}: ${m.name} · ${tr('lutCostShort')}: ${iso(m.cost.text + '×')}`));
    box.append(cards([
      { k: 'rtp', v: m.rtp.percent + '%', s: tr('exactFraction') + ': ' + fraction, title: m.rtp.fraction, cls: 'accent' },
      { k: 'lutHit', v: pct(m.hitRate.value, 4), s: lutOneIn(m.hitRate.oneIn) },
      { k: 'lutLdw', v: pct(m.ldw.value, 4), s: m.ldwShareOfWins ? tr('lutLdwShare') + ': ' + pct(m.ldwShareOfWins.value, 2) : null },
      { k: 'lutBelowCost', v: pct(m.belowCost.value, 4) },
      { k: 'lutSd', v: fmt(m.sd, 4), s: tr('lutVariance') + ': ' + fmt(m.variance.value, 4) },
      { k: 'lutMaxWin', v: fmt(m.maxWin.multiplier.value, 2) + '×', s: lutOneIn(m.maxWin.oneIn) + ' · ' + tr('lutInCost') + ': ' + iso(fmt(m.maxWin.costMultiple.value, 2) + '×') },
      { k: 'lutCvar', v: fmt(m.cvar999.absolute.value, 2) + '×', s: tr('lutInCost') + ': ' + iso(fmt(m.cvar999.relative.value, 2) + '×') + ' · ' + tr('lutQuantile') + ': ' + iso(fmt(m.cvar999.quantile.value, 2) + '×') },
    ]));
    box.append(sub('lutTail'), table(['lutCheck', 'lutContribution', 'lutShare'], [
      [tr('lutRtpFrom40'), { v: pct(m.tail.rtpFrom40xCost.value, 4), cls: 'num' }, { v: m.tail.shareFrom40xCost ? pct(m.tail.shareFrom40xCost.value, 2) : '—', cls: 'num' }],
      [tr('lutRtpFrom10k'), { v: pct(m.tail.rtpFrom10kx.value, 4), cls: 'num' }, { v: m.tail.shareFrom10kx ? pct(m.tail.shareFrom10kx.value, 2) : '—', cls: 'num' }],
    ]));
    box.append(sub('lutBigWins'), table(['lutWinAtLeast', 'probability', ''], m.bigWins.map((b) => [
      { v: b.threshold.toLocaleString('en-US') + '×', cls: 'num' }, { v: lutProb(b.probability.value), cls: 'num' }, lutOneIn(b.oneIn),
    ])));
    const maxP = Math.max(...m.buckets.map((b) => b.probability.value)) || 1;
    box.append(sub('lutBuckets'), table(['range', 'probability', 'lutContribution', ''], m.buckets.map((b) => [
      { v: b.to === 0 ? '0' : b.to === null ? '≥ ' + b.from : b.from + ' – ' + b.to, cls: 'num' }, { v: lutProb(b.probability.value), cls: 'num' },
      { v: pct(b.rtp.value, 4), cls: 'num' }, { v: bar(b.probability.value / maxP) },
    ])), el('p', { class: 'muted small' }, tr('lutCvarNote')));
    const tp = m.transparency;
    box.append(sub('lutTransparency'), cards([
      { k: 'lutRows', v: tp.rows.toLocaleString('en-US') },
      { k: 'lutZeroRows', v: tp.zeroWeightRows.toLocaleString('en-US') },
      { k: 'lutDistinct', v: tp.distinctPayouts.toLocaleString('en-US') },
      { k: 'lutEss', v: fmt(tp.effectiveSize.value, 1), s: tr('lutOfRows') + ': ' + pct(tp.effectiveShare, 1) },
      { k: 'lutMaxRow', v: lutProb(tp.maxRowProbability.value), s: 'id ' + tp.maxRowProbability.id + ' · ' + lutOneIn(tp.maxRowProbability.oneIn) },
      { k: 'lutKl', v: fmt(tp.klBits, 4), s: tr('lutKlMax') + ': ' + fmt(tp.klMaxBits, 2) },
    ]), el('div', {}, el('span', { class: 'muted small' }, tr('lutTotalWeight')), el('div', { class: 'hash' }, lutBig(m.totalWeight))));
  }
  box.append(el('p', { class: 'muted small' }, tr('lutTransparencyNote')));

  const pr = x.profile;
  box.append(el('h3', { class: 'lut-mode' }, tr('lutStake')), el('p', { class: 'muted small' }, tr('lutStakeSource')));
  box.append(el('div', { class: 'verdict ' + (pr.submissionIssues ? 'fail' : pr.inferredIssues ? 'warn' : 'pass'), id: 'lut-submission' },
    pr.submissionIssues ? tr('lutSubmissionBad') + ': ' + pr.submissionIssues : pr.inferredIssues ? tr('lutInferredBad') + ': ' + pr.inferredIssues : tr('lutSubmissionOk')));
  box.append(cards([
    { k: 'lutRiskPassing', v: `${pr.riskPassing} / ${pr.riskCategories}`, cls: pr.riskPassing === pr.riskCategories ? 'good' : 'bad' },
    { k: 'lutMaxBet', v: '$' + fmt(pr.maxBaseBet.value, 2), s: tr('lutTemplate') + ': ' + pr.maxBaseBet.template },
  ]));
  box.append(el('p', { class: 'muted small' }, tr('lutStakeRiskNote')));
  const modeName = (mo) => (mo === null ? tr('lutAllModes') : mo);
  box.append(sub('lutSubmission'), table(['lutCheck', 'lutMode', 'lutValue', 'lutLimit', 'result'], pr.submission.map((c) => [
    tr('lutChk_' + c.id), modeName(c.mode),
    { v: c.id === 'rtp' ? pct(c.value, 4) + ' → ' + pct(c.rounded, 2) : lutValue(c.unit, c.value), cls: 'num' },
    { v: Array.isArray(c.limit) ? c.limit.map((v) => pct(v, 1)).join(' – ') : lutValue(c.unit, c.limit), cls: 'num' },
    statusCell(c.ok ? 'pass' : 'fail'),
  ])));
  box.append(sub('lutInferred'), table(['lutCheck', 'lutMode', 'lutValue', 'result'], pr.inferred.map((c) => [
    tr('lutChk_' + c.id), c.mode, { v: lutValue(c.unit, c.value), cls: 'num' }, statusCell(c.ok ? 'pass' : 'flag'),
  ])), el('p', { class: 'muted small' }, tr('lutInferredNote')));
  box.append(sub('lutRisk'), table(['lutCheck', 'lutMode', 'lutValue', 'lutLimit', 'result'], pr.risk.map((c) => [
    tr('lutCat_' + c.category) + ': ' + tr('lutMea_' + c.measure), c.mode,
    { v: lutValue(c.unit, c.value), cls: 'num' }, { v: lutValue(c.unit, c.limit), cls: 'num' }, statusCell(c.ok ? 'pass' : 'fail'),
  ])));
  box.append(el('p', { class: 'muted small' }, tr('lutStakeNotCert')), el('p', { class: 'muted small' }, tr('lutStakeExactNote')));
  if (x.ignored.length) box.append(el('p', { class: 'muted small' }, tr('lutIgnored') + ': ' + x.ignored.join(' · ') + '. ' + tr('lutBooksNote')));
}

// ---------- report ----------
// 'round' only names a headline figure of the theoretical section (no result of its own).
const SECTION_KEYS = { theoretical: 'tabTheory', actual: 'tabActual', distTests: 'distTitle', rng: 'tabRng', fair: 'tabFair', montecarlo: 'tabMc', lut: 'tabLut', session: 'sessTitle', round: 'roundTitle' };
function renderReportSections() {
  const names = Object.keys(SECTION_KEYS).filter((k) => session.results[k]).map((k) => tr(SECTION_KEYS[k]));
  $('#rep-sections').textContent = names.length ? names.join(' · ') : tr('sectionsNone');
  $('#run-report').disabled = !names.length;
}

async function runReport() {
  await withTask('report', async (progress) => {
    const used = new Set(Object.values(session.results).flatMap((r) => [r.inputId, ...(r.inputIds || [])]).filter(Boolean));
    if (session.results.montecarlo) used.add('model');
    const signer = await getSigner();
    signerState.key = signer;
    renderSigningKey();
    const report = await buildReport({
      meta: { title: $('#rep-title').value.trim(), auditor: $('#rep-auditor').value.trim(), notes: $('#rep-notes').value.trim() },
      inputs: [...session.inputs.values()].filter((i) => used.has(i.id)),
      results: session.results,
    }, { createCanvas: (w, h) => Object.assign(document.createElement('canvas'), { width: w, height: h }), onProgress: progress, signer });
    session.extra.report = report;
    renderReport();
  });
}

function renderReport() {
  const box = $('#res-report');
  box.replaceChildren();
  const r = session.extra.report;
  if (!r) return;
  const url = URL.createObjectURL(new Blob([r.bytes], { type: 'application/pdf' }));
  box.append(el('div', { class: 'verdict pass' }, tr('reportReady') + ' · ' + r.pages + ' ' + tr('pages')));
  box.append(cards([
    { k: 'reportId', v: r.reportId },
    { k: 'size', v: (r.bytes.length / 1024).toFixed(0) + ' KB' },
    r.signature && { k: 'sigAlg', v: ALGORITHM_INFO[r.signature.alg].label, s: tr(r.signature.storage === 'persistent' ? 'keyPersistent' : 'keySession'), cls: r.signature.storage === 'persistent' ? '' : 'bad' },
  ]));
  box.append(el('div', {}, el('span', { class: 'muted small' }, tr('digest')), el('div', { class: 'hash' }, r.digest)));
  if (r.signature) box.append(el('div', {}, el('span', { class: 'muted small' }, tr('keyFingerprint')), el('div', { class: 'hash', id: 'report-fingerprint' }, formatFingerprint(r.signature.fingerprint))));
  box.append(el('a', { class: 'download', href: url, download: r.reportId + '.pdf', id: 'report-download' }, tr('download') + ' PDF'));
  const thumbs = el('div', { class: 'thumbs' });
  for (const th of r.thumbnails) thumbs.append(th);
  box.append(thumbs);
}

// ---------- signed reports: the signing key, and "Verify a report" ----------
// The key is loaded (or created and stored) when first needed, then reused.
const signerState = { promise: null, key: null, error: null };
function getSigner() {
  if (!signerState.promise) signerState.promise = loadSigningKey().catch((e) => { signerState.promise = null; throw e; });
  return signerState.promise;
}
async function showSigningKey() {
  if (!signerState.key && !signerState.error) renderSigningKey();
  try { signerState.key = await getSigner(); signerState.error = null; } catch (e) { signerState.error = e; }
  renderSigningKey();
}
function renderSigningKey() {
  const box = $('#sign-key');
  box.replaceChildren();
  const k = signerState.key;
  if (signerState.error && !k) { box.append(el('div', { class: 'error' }, pick([signerState.error.ar, signerState.error.en]) || signerState.error.message)); return; }
  if (!k) { box.append(el('span', { class: 'muted small' }, tr('keyLoading'))); return; }
  box.append(
    el('div', { class: 'muted small' }, `${tr('signingKey')} · ${ALGORITHM_INFO[k.alg].label} · `, el('span', { id: 'sign-storage', 'data-storage': k.storage }, tr(k.storage === 'persistent' ? 'keyPersistent' : 'keySession'))),
    el('div', { class: 'hash', id: 'sign-fingerprint', 'data-alg': k.alg }, formatFingerprint(k.fingerprint)),
  );
  if (k.storage !== 'persistent') box.append(el('div', { class: 'verdict warn' }, tr('sessionKeyNote')));
  if (k.replaced) {
    box.append(el('div', { class: 'verdict warn', id: 'sign-replaced' }, tr('keyReplaced')));
    if (k.previousFingerprint) box.append(el('div', {}, el('span', { class: 'muted small' }, tr('previousFingerprint')), el('div', { class: 'hash', id: 'sign-previous' }, formatFingerprint(k.previousFingerprint))));
  }
  box.append(el('p', { class: 'muted small' }, tr('keyNote')));
}

const verifyState = { file: null, originals: [], result: null };
async function loadVerifyFile(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  verifyState.file = { name: file.name, bytes };
  fileNames.verify = file.name + ' · ' + bytes.length.toLocaleString('en-US') + ' ' + tr('bytes');
  $('#name-verify').textContent = fileNames.verify;
  await runVerify();
}
async function runVerify() {
  await withTask('verify', async () => {
    verifyState.result = null;
    renderVerify();
    if (!verifyState.file) throw { ar: tr('noFile'), en: t('noFile', 'en') };
    verifyState.result = await runTask('verifyReport', { bytes: verifyState.file.bytes, trusted: $('#v-trusted').value, originals: verifyState.originals });
    renderVerify();
  });
}

const VERIFY_VIEW = { valid: ['pass', 'vValid'], invalid: ['fail', 'vInvalid'], 'wrong-key': ['fail', 'vWrongKey'], unsigned: ['warn', 'vUnsigned'], unverifiable: ['warn', 'vUnverifiable'] };
const FILE_CLASS = { match: 'pass', 'original-match': 'pass', 'hash-only': 'na' };
function figureText(f) {
  const n = (x) => Number(x).toLocaleString('en-US');
  if (f.section === 'actual') return [f.value, f.rounds !== null ? `${tr('roundsChecked')}: ${n(f.rounds)}` : null, f.verdict && VERDICT[f.verdict] ? pick(VERDICT[f.verdict]) : null].filter(Boolean).join(' · ');
  if (f.section === 'rng') return [f.pass === null ? null : tr(f.pass ? 'familyPassShort' : 'familyFailShort'), f.value !== null ? `${tr('bitsCount')}: ${n(f.value)}` : null].filter(Boolean).join(' · ');
  if (f.section === 'fair' && f.verdict) return [f.value, tr('pfV_' + f.verdict)].filter(Boolean).join(' · ');
  if (f.section === 'fair') return tr(f.pass ? 'allVerified' : 'someFailed');
  if (f.section === 'distTests') return [f.value ? tr('distB_' + f.value) : null, f.rounds !== null ? `${tr('roundsChecked')}: ${n(f.rounds)}` : null].filter(Boolean).join(' · ') || '—';
  if (f.section === 'montecarlo') return [f.value, f.scope === 'firstDrop' ? tr('firstDropShort') : null, f.spins !== null ? `${tr('spins')}: ${n(f.spins)}` : null].filter(Boolean).join(' · ');
  if (f.section === 'theoretical') return [f.value, f.scope === 'firstDrop' ? tr('firstDropShort') : null].filter(Boolean).join(' · ');
  if (f.section === 'round') return [f.value ? `${tr('figRoundTop')}: ${f.value}` : null, f.oneIn ? `${tr('lutOneIn')} ${f.oneIn}` : null].filter(Boolean).join(' · ') || '—';
  if (f.section === 'session') return [`${tr('figSessAhead')}: ${f.value}`, `${tr('sessRounds')}: ${n(f.rounds)}`].join(' · ');
  return f.value ?? '—';
}
function renderVerify() {
  const box = $('#res-verify');
  box.replaceChildren();
  const v = verifyState.result;
  if (!v) return;
  const [cls, key] = VERIFY_VIEW[v.status];
  box.append(el('div', { class: 'verdict ' + cls, id: 'verify-verdict', 'data-status': v.status }, tr(key)));
  const failedCheck = (id) => v.checks.some((c) => c.id === id && c.ok === false);
  // Lines that explain the verdict; none of them softens a failing one.
  if (failedCheck('signaturePresent')) box.append(el('p', { class: 'muted', id: 'verify-sig-removed' }, tr('vSignatureRemoved')));
  if (v.status === 'wrong-key') box.append(el('p', { class: 'muted' }, tr(v.signer ? 'vOtherKey' : 'vNoSignatureTrusted')));
  if (v.dataIntactPdfChanged) box.append(el('p', { class: 'muted' }, tr('vDataIntact')));
  if (v.status === 'valid' && v.trusted && v.trusted.match) box.append(el('p', { class: 'muted' }, tr('vTrustedMatch')));
  else if ((v.status === 'valid' || v.status === 'unverifiable') && v.signer && !v.trusted) box.append(el('p', { class: 'muted' }, tr('vCompareFingerprint')));
  if (v.files.some((f) => f.status === 'original-mismatch')) box.append(el('div', { class: 'verdict warn', id: 'verify-original-mismatch' }, tr('vOriginalMismatch')));
  const rp = v.report;
  box.append(cards([
    rp && { k: 'reportIdComputed', v: rp.id },
    rp && rp.createdAt && { k: 'signedAt', v: rp.createdAt.replace('T', ' ').replace('Z', ' UTC') },
    v.signer && { k: 'sigAlg', v: v.signer.label, s: v.signer.reference },
    v.signer && v.signer.storage && { k: 'keyStorage', v: tr(v.signer.storage === 'persistent' ? 'signerKeyPersistent' : 'signerKeySession'), cls: v.signer.storage === 'persistent' ? '' : 'bad' },
    rp && rp.labVersion && { k: 'labVersion', v: rp.labVersion },
  ]));
  if (v.signer) box.append(el('div', {}, el('span', { class: 'muted small' }, tr('keyFingerprint')), el('div', { class: 'hash', id: 'verify-fingerprint' }, formatFingerprint(v.signer.fingerprint))));
  const mark = (ok) => (ok === true ? { v: '✓', cls: 'pass' } : ok === false ? { v: '✗', cls: 'fail' } : { v: tr('notChecked'), cls: 'na' });
  box.append(sub('checksTitle'), table(['check', 'result'], v.checks.map((c) => [tr('chk_' + c.id), mark(c.ok)])));
  if (v.files.length) {
    box.append(sub('filesTitle'), table(['file', 'size', 'SHA-256', 'fileStatus'], v.files.map((f) => [
      f.name, { v: f.size === null || f.size === undefined ? '—' : Number(f.size).toLocaleString('en-US'), cls: 'num' },
      { v: f.sha256 || f.expected ? (f.sha256 || f.expected).slice(0, 16) + '…' : '—', cls: 'mono' }, { v: tr('fs_' + f.status), cls: FILE_CLASS[f.status] || 'fail' },
    ])));
  }
  if (rp && rp.figures.length) {
    box.append(sub(rp.signed ? 'figuresTitle' : 'figuresUnsigned'), table(['sectionWord', 'result'], rp.figures.map((f) => [tr(SECTION_KEYS[f.section]), figureText(f)])), el('p', { class: 'muted small' }, tr('figuresNote')));
  }
  box.append(el('p', { class: 'muted small' }, tr('signatureMeaning')));
}

function renderAll() {
  renderTheory(); renderActual(); renderRng(); renderFair(); renderMc(); renderMcModel(); renderLut(); renderReportSections(); renderReport();
  renderSession();
  renderDistCandidates(); renderDist();
  syncFairFields();
  if (signerState.key || signerState.error) renderSigningKey();
  renderVerify();
}

// ---------- wiring ----------
function init() {
  document.querySelectorAll('[role="tab"]').forEach((b) => b.addEventListener('click', () => selectTab(b.id.slice(4))));
  $('#langToggle').addEventListener('click', () => { lang = lang === 'ar' ? 'en' : 'ar'; setLang(lang); applyLang(); });

  document.querySelectorAll('[data-sample]').forEach((b) => b.addEventListener('click', () => { setModel(samples[b.dataset.sample]); showError('theory', null); }));
  $('#f-linePreset').addEventListener('change', syncFormVisibility);
  $('#f-fsEnabled').addEventListener('change', syncFormVisibility);
  $('#f-fsRetrigger').addEventListener('change', syncFormVisibility);
  $('#run-round').addEventListener('click', runRoundCap);
  $('#run-session').addEventListener('click', runSession);
  $('#modelFile').addEventListener('change', async (e) => {
    showError('theory', null);
    try {
      const files = [...e.target.files].sort((a, b) => (a.name.endsWith('.json') ? -1 : 0) - (b.name.endsWith('.json') ? -1 : 0));
      let raw = null; // the current model is read only if a CSV needs it
      for (const f of files) {
        const text = await f.text();
        raw = /\.json$/i.test(f.name) || text.trim().startsWith('{') ? parseModelJson(text) : applyCsv(raw || currentRaw(), text, f.name);
      }
      if (raw) setModel(raw);
    } catch (err) { showError('theory', err); }
    e.target.value = '';
  });
  $('#exportModel').addEventListener('click', () => {
    try {
      const raw = currentRaw();
      download(enc.encode(JSON.stringify(raw, null, 2) + '\n'), (raw.name || 'model').replace(/[^\w-]+/g, '-') + '.json', 'application/json');
    } catch (err) { showError('theory', err); }
  });
  $('#run-theory').addEventListener('click', runTheory);

  $('#actualFile').addEventListener('change', async (e) => { if (e.target.files[0]) await loadFileInput('playlog', 'actual', e.target.files[0], 'csv'); });
  $('#sample-actual').addEventListener('click', () => withTask('actual', async (progress) => {
    const bytes = await runTask('samplePlayLog', { raw: samples.desertGold, rounds: 100000, seed: 'sample-play-log' }, progress);
    await registerInput('playlog', 'sample-playlog-desert-gold.csv', 'csv', bytes, 'text/csv');
    fileNames.actual = 'sample-playlog-desert-gold.csv · ' + bytes.length.toLocaleString('en-US') + ' ' + tr('bytes');
    $('#name-actual').textContent = fileNames.actual;
    $('#a-declared').value = '95.5175';
  }));
  $('#run-actual').addEventListener('click', runActual);

  $('#d-useTheory').addEventListener('change', renderDistCandidates);
  $('#pmfFile').addEventListener('change', async (e) => {
    const files = [...e.target.files];
    if (!files.length) return;
    replacePmfFiles();
    for (const [i, file] of files.entries()) {
      await addPmfFile(i, file.name, file.name.replace(/\.csv$/i, ''), new Uint8Array(await file.arrayBuffer()), file.type || 'text/csv');
    }
    e.target.value = '';
    renderDistCandidates();
  });
  $('#clear-pmf').addEventListener('click', () => {
    replacePmfFiles();
    renderDistCandidates();
  });
  $('#sample-dist').addEventListener('click', () => withTask('dist', async () => {
    const ex = await runTask('sampleVersions', { rounds: 200000, seed: 'sample-versions' });
    replacePmfFiles();
    for (const [i, v] of ex.versions.entries()) {
      await addPmfFile(i, `example-version-${Math.round(v.rtp * 100)}.csv`, `RTP ${Math.round(v.rtp * 100)}%`, v.csv, 'text/csv');
    }
    await registerInput('playlog', 'sample-playlog-3-versions.csv', 'csv', ex.log, 'text/csv');
    fileNames.actual = 'sample-playlog-3-versions.csv · ' + ex.log.length.toLocaleString('en-US') + ' ' + tr('bytes');
    $('#name-actual').textContent = fileNames.actual;
    $('#a-declared').value = '96';
    $('#d-maxWin').value = String(ex.maxWin);
    $('#d-useTheory').checked = false;
    renderDistCandidates();
    $('#d-ref').selectedIndex = 0;
  }));
  $('#run-dist').addEventListener('click', runDist);

  $('#rngFile').addEventListener('change', async (e) => { if (e.target.files[0]) await loadFileInput('rng', 'rng', e.target.files[0], 'data'); });
  $('#sample-rng').addEventListener('click', () => withTask('rng', async () => {
    const bytes = new Uint8Array(125000);
    for (let i = 0; i < bytes.length; i += 65536) crypto.getRandomValues(bytes.subarray(i, i + 65536)); // 64 KiB per call max
    await registerInput('rng', 'random-sample-1000000-bits.bin', 'binary', bytes, 'application/octet-stream');
    fileNames.rng = 'random-sample-1000000-bits.bin · crypto.getRandomValues';
    $('#name-rng').textContent = fileNames.rng;
    $('#r-mode').value = 'binary';
  }));
  $('#run-rng').addEventListener('click', runRng);

  $('#p-scheme').addEventListener('change', syncFairFields);
  $('#p-adapter').addEventListener('change', () => { $('#p-version').replaceChildren(); $('#p-game').replaceChildren(); syncPfFields(); });
  $('#p-version').addEventListener('change', () => { $('#p-game').replaceChildren(); syncPfFields(); });
  $('#p-game').addEventListener('change', () => renderPfInfo(currentPf()));
  $('#fairFile').addEventListener('change', async (e) => { if (e.target.files[0]) await loadFileInput('fair', 'fair', e.target.files[0], 'csv'); });
  $('#sample-fair').addEventListener('click', () => withTask('fair', async () => {
    if (pfMode()) { await samplePf(); return; }
    const chain = $('#p-scheme').value === 'chain';
    const bytes = chain ? await runTask('sampleChain', { length: 2000 }) : await runTask('sampleFair', { rounds: 5000, options: fairOptions() });
    const name = chain ? 'sample-hash-chain.txt' : 'sample-provably-fair-5000.csv';
    await registerInput('fair', name, 'csv', bytes, chain ? 'text/plain' : 'text/csv');
    fileNames.fair = name + ' · ' + bytes.length.toLocaleString('en-US') + ' ' + tr('bytes');
    $('#name-fair').textContent = fileNames.fair;
  }));
  $('#run-fair').addEventListener('click', runFair);

  $('#run-mc').addEventListener('click', () => runMc());
  $('#stop-mc').addEventListener('click', () => { stopWorker(); $('#stop-mc').hidden = true; });

  $('#lutFiles').addEventListener('change', async (e) => {
    showError('lut', null);
    try {
      const files = [];
      for (const f of e.target.files) {
        const books = lutFileKind(f.name) === 'books';
        files.push({ name: f.name, bytes: books ? null : new Uint8Array(await f.arrayBuffer()), mime: f.type || (f.name.endsWith('.json') ? 'application/json' : 'text/csv') });
      }
      await setLutFiles(files);
    } catch (err) { showError('lut', err); }
    e.target.value = '';
  });
  $('#sample-lut').addEventListener('click', () => withTask('lut', async () => {
    const files = await runTask('sampleLut', {});
    await setLutFiles(files.map((f) => ({ ...f, mime: f.name.endsWith('.json') ? 'application/json' : 'text/csv' })), 'lutSampleTag');
  }));
  $('#run-lut').addEventListener('click', runLut);

  $('#run-report').addEventListener('click', runReport);

  $('#verifyFile').addEventListener('change', async (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) await loadVerifyFile(f); });
  // A PDF dropped anywhere on the Verify panel is checked (the browser would
  // otherwise open it in place of the lab); the originals picker keeps its own drop.
  const panel = $('#panel-verify'), drop = $('#verify-drop');
  const ownDrop = (e) => e.target && e.target.id === 'verifyOriginals';
  panel.addEventListener('dragover', (e) => { if (ownDrop(e)) return; e.preventDefault(); drop.classList.add('drag'); });
  panel.addEventListener('dragleave', (e) => { if (!panel.contains(e.relatedTarget)) drop.classList.remove('drag'); });
  panel.addEventListener('drop', async (e) => {
    if (ownDrop(e)) return;
    e.preventDefault();
    drop.classList.remove('drag');
    const f = e.dataTransfer && e.dataTransfer.files[0];
    if (f) await loadVerifyFile(f);
  });
  $('#verifyOriginals').addEventListener('change', async (e) => {
    const files = [...e.target.files];
    verifyState.originals = await Promise.all(files.map(async (f) => ({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) })));
    fileNames.verifyOriginals = files.map((f) => f.name).join(', ');
    $('#name-verifyOriginals').textContent = fileNames.verifyOriginals;
    if (verifyState.file) await runVerify();
  });
  $('#v-trusted').addEventListener('change', () => { if (verifyState.file) runVerify(); });
  $('#run-verify').addEventListener('click', runVerify);

  fillForm(samples.desertGold);
  applyLang();
}

init();

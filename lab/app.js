// RTP lab page controller. Reads inputs, sends the work to worker.js, renders the
// results and builds the PDF report. Nothing leaves the browser: the page's CSP
// (connect-src 'none') blocks every network request a script could make.
import { t, pair, getLang, setLang, NIST_NAMES, VOLATILITY, VERDICT } from './i18n.js';
import { modelFromForm, formFromModel, applyCsv, parseModelJson, normalizeModel, canonicalJson } from './core/slot-model.js';
import { sha256Hex } from './core/fair.js';
import { buildReport } from './report.js';
import * as samples from './samples.js';

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
  if (name === 'report') renderReportSections();
  if (name === 'mc') renderMcModel();
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
const FORM = ['name', 'rows', 'reels', 'paytable', 'linePreset', 'lines', 'wild', 'scatter', 'fsEnabled', 'fsTrigger', 'fsSpins', 'fsMultiplier', 'fsRetrigger', 'fsReels'];
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
}

async function runTheory() {
  await withTask('theory', async (progress) => {
    const raw = modelFromForm(readForm());
    normalizeModel(raw); // fails fast with a readable message
    const bytes = enc.encode(canonicalJson(raw));
    const name = (raw.name || 'model').replace(/[^\w؀-ۿ-]+/g, '-').replace(/^-|-$/g, '').toLowerCase() + '.json';
    const modelSha256 = await registerInput('model', name, 'model', bytes, 'application/json');
    const result = await runTask('exact', { raw }, progress);
    session.results.theoretical = { inputId: 'model', modelSha256, result, raw };
    delete session.results.montecarlo;
    renderTheory();
    renderDistCandidates();
  });
}

function renderTheory() {
  const box = $('#res-theory');
  box.replaceChildren();
  const th = session.results.theoretical;
  if (!th) return;
  const x = th.result, d = x.distribution;
  const fraction = x.rtp.fraction.length > 40 ? x.rtp.fraction.slice(0, 37) + '…' : x.rtp.fraction;
  box.append(cards([
    { k: 'rtp', v: x.rtp.percent + '%', s: tr('exactFraction') + ': ' + fraction, title: x.rtp.fraction, cls: 'accent' },
    d && { k: 'hitFrequency', v: pct(d.hitFrequency.value, 3) },
    d && { k: 'sd', v: fmt(d.sd, 3), s: tr('volatility') + ': ' + pick(VOLATILITY[d.volatilityClass]) + ' · VI90 ' + fmt(d.volatilityIndex90, 2) },
    d && { k: 'maxWinBase', v: fmt(d.maxWin.base, 2) + '×' },
    d && d.maxWin.perFreeSpin !== undefined && { k: 'maxWinFs', v: fmt(d.maxWin.perFreeSpin, 2) + '×' },
    d && d.maxWin.perFreeSpin !== undefined && { k: 'maxWinTotal', v: d.maxWin.unbounded ? '∞' : fmt(d.maxWin.withFeature, 2) + '×', s: d.maxWin.unbounded ? tr('unbounded') : null },
    { k: 'combinations', v: Number(x.model.combinations).toLocaleString('en-US'), s: x.model.reels + '×' + x.model.rows + ' · ' + x.model.lines + ' ' + tr('lines') },
  ]));
  if (x.distributionError) box.append(el('div', { class: 'verdict warn' }, pick([x.distributionError.ar, x.distributionError.en])));
  box.append(el('div', {}, el('span', { class: 'muted small' }, tr('modelHash')), el('div', { class: 'hash' }, th.modelSha256)));
  const c = x.contributions;
  box.append(sub('contributions'), table(['contributions', 'contribution', ['حصة من RTP', 'Share of RTP'], ''], [
    ['contribLines', c.lines], ['contribWild', c.wildAssistedLines], ['contribScatter', c.scatter], ['contribFs', c.freeSpins],
  ].map(([k, v]) => [tr(k), { v: v.percent + '%', cls: 'num' }, { v: pct(v.value / x.rtp.value, 2), cls: 'num' }, { v: bar(v.value / x.rtp.value) }])));
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
    rows.push([s.symbol + (s.isWild ? ' (wild)' : ''), { v: b.count, cls: 'num' }, { v: fmt(b.pay, 4), cls: 'num' }, { v: b.probabilityPerLine.value.toExponential(4), cls: 'mono' }, { v: Number(b.combosPerLine).toLocaleString('en-US'), cls: 'num' }, { v: b.rtp.percent + '%', cls: 'num' }]);
  }
  box.append(sub('symbolTable'), table(['symbol', 'count', 'pay', 'probability', ['التوليفات لكل خط', 'Combinations per line'], 'contribution'], rows));
  if (x.scatter.length) {
    box.append(table([['عدد الـScatter', 'Scatters'], 'probability', ['الدفع × الرهان', 'Pay × bet'], ['تفعيل', 'Trigger']],
      x.scatter.map((s) => [{ v: s.count, cls: 'num' }, { v: s.probability.value.toExponential(4), cls: 'mono' }, { v: fmt(s.pay, 4), cls: 'num' }, s.triggers ? '✓' : ''])));
  }
  if (d) {
    const maxP = Math.max(...d.buckets.map((b) => b.probability.value));
    box.append(sub('distribution'), table(['range', 'probability', ''], d.buckets.map((b) => [
      { v: b.to === 0 ? '0' : b.to === null ? '≥ ' + b.from : b.from + ' – ' + b.to, cls: 'num' }, { v: pct(b.probability.value, 4), cls: 'num' }, { v: bar(b.probability.value / maxP) },
    ])));
  }
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
    if (sigma === null && $('#a-useTheory').checked && session.results.theoretical && session.results.theoretical.result.distribution) sigma = session.results.theoretical.result.distribution.sd;
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
      if (!d || !d.pmf) throw { ar: t('distNoModelPmf', 'ar'), en: t('distNoModelPmf', 'en') };
      return { kind: 'exact', label: c.label, pmf: d.pmf };
    });
    const refIndex = Math.max(0, list.findIndex((c) => c.key === $('#d-ref').value));
    // The theoretical model gives sigma, M and the RTP only when it is the reference:
    // another game's values would size the planner and bound the e-process wrongly.
    const ref = list[refIndex];
    const thd = ref.kind === 'exact' ? ref.th.result.distribution : null;
    let sigma = optNum($('#a-sigma').value), sigmaSource = 'input';
    if (sigma === null && thd) { sigma = thd.sd; sigmaSource = 'model'; }
    let maxWin = optNum($('#d-maxWin').value), maxWinSource = 'input';
    if (maxWin === null && thd && !thd.maxWin.unbounded) { maxWin = thd.maxWin.withFeature ?? thd.maxWin.base; maxWinSource = 'model'; }
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
  return [range, b.triggered ? tr('distTriggered') : null].filter(Boolean).join(' + ');
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
}

async function runFair() {
  await withTask('fair', async (progress) => {
    const input = session.inputs.get('fair');
    if (!input) throw { ar: tr('noFile'), en: t('noFile', 'en') };
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
    session.results.montecarlo = { ...run, exactRtp: th.result.rtp.value, ms: performance.now() - t0, confirmed: compareTo ? compareTo === run.resultSha256 : null };
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
  box.append(cards([
    { k: 'simRtp', v: pct(s.rtp, 4), s: '95%: ' + pct(s.ci95[0], 3) + ' – ' + pct(s.ci95[1], 3), cls: 'accent' },
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
  if (mc.confirmed !== null) box.append(el('div', { class: 'verdict ' + (mc.confirmed ? 'pass' : 'fail') }, tr(mc.confirmed ? 'sameAgain' : 'differentAgain')));
  const again = el('button', { type: 'button', id: 'rerun-mc' }, tr('rerun'));
  again.addEventListener('click', () => runMc(mc.resultSha256));
  box.append(again);
}

// ---------- report ----------
const SECTION_KEYS = { theoretical: 'tabTheory', actual: 'tabActual', distTests: 'distTitle', rng: 'tabRng', fair: 'tabFair', montecarlo: 'tabMc' };
function renderReportSections() {
  const names = Object.keys(SECTION_KEYS).filter((k) => session.results[k]).map((k) => tr(SECTION_KEYS[k]));
  $('#rep-sections').textContent = names.length ? names.join(' · ') : tr('sectionsNone');
  $('#run-report').disabled = !names.length;
}

async function runReport() {
  await withTask('report', async (progress) => {
    const used = new Set(Object.values(session.results).flatMap((r) => [r.inputId, ...(r.inputIds || [])]).filter(Boolean));
    if (session.results.montecarlo) used.add('model');
    const report = await buildReport({
      meta: { title: $('#rep-title').value.trim(), auditor: $('#rep-auditor').value.trim(), notes: $('#rep-notes').value.trim() },
      inputs: [...session.inputs.values()].filter((i) => used.has(i.id)),
      results: session.results,
    }, { createCanvas: (w, h) => Object.assign(document.createElement('canvas'), { width: w, height: h }), onProgress: progress });
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
  box.append(cards([{ k: 'reportId', v: r.reportId }, { k: 'size', v: (r.bytes.length / 1024).toFixed(0) + ' KB' }]));
  box.append(el('div', {}, el('span', { class: 'muted small' }, tr('digest')), el('div', { class: 'hash' }, r.digest)));
  box.append(el('a', { class: 'download', href: url, download: r.reportId + '.pdf', id: 'report-download' }, tr('download') + ' PDF'));
  const thumbs = el('div', { class: 'thumbs' });
  for (const th of r.thumbnails) thumbs.append(th);
  box.append(thumbs);
}

function renderAll() {
  renderTheory(); renderActual(); renderRng(); renderFair(); renderMc(); renderMcModel(); renderReportSections(); renderReport();
  renderDistCandidates(); renderDist();
  syncFairFields();
}

// ---------- wiring ----------
function init() {
  document.querySelectorAll('[role="tab"]').forEach((b) => b.addEventListener('click', () => selectTab(b.id.slice(4))));
  $('#langToggle').addEventListener('click', () => { lang = lang === 'ar' ? 'en' : 'ar'; setLang(lang); applyLang(); });

  document.querySelectorAll('[data-sample]').forEach((b) => b.addEventListener('click', () => { fillForm(samples[b.dataset.sample]); showError('theory', null); }));
  $('#f-linePreset').addEventListener('change', syncFormVisibility);
  $('#f-fsEnabled').addEventListener('change', syncFormVisibility);
  $('#modelFile').addEventListener('change', async (e) => {
    showError('theory', null);
    try {
      const files = [...e.target.files].sort((a, b) => (a.name.endsWith('.json') ? -1 : 0) - (b.name.endsWith('.json') ? -1 : 0));
      let raw = modelFromForm(readForm());
      for (const f of files) {
        const text = await f.text();
        raw = /\.json$/i.test(f.name) || text.trim().startsWith('{') ? parseModelJson(text) : applyCsv(raw, text, f.name);
      }
      fillForm(raw);
    } catch (err) { showError('theory', err); }
    e.target.value = '';
  });
  $('#exportModel').addEventListener('click', () => {
    try {
      const raw = modelFromForm(readForm());
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
  $('#fairFile').addEventListener('change', async (e) => { if (e.target.files[0]) await loadFileInput('fair', 'fair', e.target.files[0], 'csv'); });
  $('#sample-fair').addEventListener('click', () => withTask('fair', async () => {
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

  $('#run-report').addEventListener('click', runReport);

  fillForm(samples.desertGold);
  applyLang();
}

init();

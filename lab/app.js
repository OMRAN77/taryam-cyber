// RTP lab page controller. Reads inputs, sends the work to worker.js, renders the
// results and builds the PDF report. Nothing leaves the browser: the page's CSP
// (connect-src 'none') blocks every network request a script could make.
import { t, pair, getLang, setLang, NIST_NAMES, VOLATILITY, VERDICT } from './i18n.js';
import { modelFromForm, formFromModel, applyCsv, parseModelJson, normalizeModel, canonicalJson } from './core/slot-model.js';
import { sha256Hex } from './core/fair.js';
import { buildReport } from './report.js';
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
  session.inputs.set(id, { id, name, kind, size: bytes.length, sha256, bytes, mime });
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
const SECTION_KEYS = { theoretical: 'tabTheory', actual: 'tabActual', rng: 'tabRng', fair: 'tabFair', montecarlo: 'tabMc', lut: 'tabLut' };
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
  renderTheory(); renderActual(); renderRng(); renderFair(); renderMc(); renderMcModel(); renderLut(); renderReportSections(); renderReport();
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

  fillForm(samples.desertGold);
  applyLang();
}

init();

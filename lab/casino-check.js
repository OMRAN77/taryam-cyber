// "Casino check" page controller. Three tools on real material:
//   1. the site: our /api/casino-check visits it and returns findings with evidence;
//   2. a round the user played: recomputed from its seeds (core/stake-fair.js);
//   3. the user's bet history pasted from the site (core/history.js + core/actual.js).
// Only (1) touches the network, and only our own API.
import { getLang, setLang } from './i18n.js';
import { text } from './casino-check-text.js';
import { recompute, FairError, PREDICTION_NOTE } from './core/stake-fair.js';
import { parseHistory } from './core/history.js';
import { analyzePlayLog } from './core/actual.js';
import { analyzeHtml, score } from './core/site.js';

const $ = (s) => document.querySelector(s);
let lang = getLang();
const tr = (key) => text(key, lang);
const money = (v, d = 2) => Number(v).toLocaleString('en-US', { maximumFractionDigits: d });
const pct = (v, d = 2) => (v * 100).toFixed(d) + '%';

function el(tag, attrs = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') n.className = v; else if (k === 'text') n.textContent = v; else n.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) if (c !== null && c !== undefined && c !== false) n.append(c instanceof Node ? c : String(c));
  return n;
}
const ltr = (s) => el('bdi', { dir: 'ltr' }, s);
function cards(list) {
  return el('div', { class: 'cards' }, list.filter(Boolean).map((c) => el('div', { class: 'card ' + (c.cls || '') }, el('div', { class: 'k' }, c.k), el('div', { class: 'v' }, c.v), c.s ? el('div', { class: 's' }, c.s) : null)));
}
function showError(id, err) {
  const box = $('#err-' + id);
  box.hidden = !err;
  box.textContent = err ? (lang === 'en' ? err.en : err.ar) || err.message || String(err) : '';
}
function num(id) {
  const s = $(id).value.trim().replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x660)).replace(/٫/g, '.').replace(/[٬,\s]/g, '');
  return s === '' ? null : Number(s);
}

// ---------- 1. site ----------
let site = null;
const SEV_ORDER = { high: 0, medium: 1, low: 2, info: 3, ok: 4 };

async function runSite() {
  showError('site', null);
  const url = $('#s-url').value.trim();
  if (!url) return;
  const btn = $('#run-site');
  btn.disabled = true; btn.textContent = tr('checking');
  $('#res-site').replaceChildren();
  try {
    const res = await fetch('/api/casino-check', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url }) });
    const data = await res.json();
    if (!res.ok || data.error) throw { ar: data.message || data.error || 'فشل الفحص', en: data.message || data.error || 'The check failed' };
    site = data;
    renderSite();
    // Blocked or empty: invite the user's own browser to supply the page.
    if (data.findings.some((f) => ['bot-challenge', 'thin-page', 'unreachable', 'http-error'].includes(f.id))) $('#paste-box').open = true;
  } catch (e) {
    showError('site', e.ar ? e : { ar: 'تعذّر الاتصال بالخادم: ' + (e.message || e), en: 'Could not reach the server: ' + (e.message || e) });
  } finally {
    btn.disabled = false; btn.textContent = tr('check');
  }
}

// Analyses a page source the user pasted from their own browser (the site may block
// our server) and merges it with the link check's domain, certificate and server
// findings when one has run for the same host.
function runPaste() {
  showError('site', null);
  const html = $('#s-html').value;
  if (html.trim().length < 50) { showError('site', { ar: tr('pasteShort'), en: tr('pasteShort') }); return; }
  let host = '';
  try { const u = $('#s-url').value.trim(); host = u ? new URL(/^https?:\/\//i.test(u) ? u : 'https://' + u).hostname.toLowerCase() : ''; } catch (e) { host = ''; }
  const base = site && (!host || site.host === host) ? site : null;
  const a = analyzeHtml(html, 'https://' + (host || (base && base.host) || 'unknown.invalid') + '/');
  const fromServer = base ? base.findings.filter((f) => /^(domain-|cert-|host-|redirected)/.test(f.id)) : [];
  const findings = [...a.findings.filter((f) => f.id !== 'bot-challenge' && f.id !== 'thin-page'), ...fromServer];
  const { risk, level } = score(findings);
  site = {
    ...(base || { url: host ? 'https://' + host + '/' : '', host, domain: host, ips: [], registration: null, cert: null, geo: null, headers: null }),
    page: { title: a.title, lang: a.lang, isGambling: a.isGambling, targetsUae: a.targetsUae, licences: a.licences, providers: a.providers, providerHosts: a.providerHosts, externalHosts: a.externalHosts, payments: a.payments },
    findings, risk, level, pasted: true, pastedWithServer: !!base, checkedAt: new Date().toISOString(),
  };
  renderSite();
  $('#res-site').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function renderSite() {
  const box = $('#res-site');
  box.replaceChildren();
  if (!site) return;
  const d = site;
  if (d.pasted) box.append(el('p', { class: 'muted small', id: 'pasted-note' }, tr(d.pastedWithServer ? 'pastedNote' : 'pastedOnly')));
  const level = d.level === 'danger' ? 'suspicious' : d.level === 'warning' ? 'review' : 'normal';
  box.append(el('div', { class: 'risk' },
    el('div', { class: 'risk-head' }, el('span', {}, tr('riskLabel')), el('strong', { id: 'risk-value' }, ltr(String(d.risk) + ' / 100'))),
    el('div', { class: 'risk-bar' }, el('i', { class: 'risk-fill ' + d.level, style: `width:${d.risk}%` })),
    el('div', { class: 'verdict ' + level, id: 'site-verdict' }, tr(d.level === 'danger' ? 'lvlDanger' : d.level === 'warning' ? 'lvlWarning' : 'lvlCaution'))));

  const findings = [...d.findings].sort((a, b) => SEV_ORDER[a.severity] - SEV_ORDER[b.severity]);
  box.append(el('h3', { class: 'sub' }, tr('findings')));
  box.append(el('ul', { class: 'findings', id: 'site-findings' }, findings.map((f) => el('li', { class: 'finding ' + f.severity, 'data-id': f.id },
    el('span', { class: 'sev' }, tr('sev' + f.severity[0].toUpperCase() + f.severity.slice(1))),
    el('div', {}, el('div', {}, lang === 'en' ? f.en : f.ar), f.evidence ? el('div', { class: 'ev' }, tr('evidence') + ': ', ltr(String(f.evidence).slice(0, 200))) : null)))));

  const facts = [];
  if (d.domain) facts.push([tr('fDomain'), ltr(d.domain + (d.ips && d.ips.length ? ' · ' + d.ips[0] : ''))]);
  if (d.finalUrl && d.host && new URL(d.finalUrl).hostname !== d.host) facts.push([tr('fFinal'), ltr(new URL(d.finalUrl).hostname)]);
  if (d.page && d.page.title) facts.push([tr('fTitle'), ltr(d.page.title)]);
  if (d.registration && d.registration.registered) facts.push([tr('fRegistered'), ltr(d.registration.registered.slice(0, 10))]);
  if (d.registration && d.registration.registrar) facts.push([tr('fRegistrar'), ltr(d.registration.registrar)]);
  if (d.geo) facts.push([tr('fServer'), ltr([d.geo.country, d.geo.city, d.geo.isp || d.geo.org].filter(Boolean).join(' · '))]);
  if (d.cert) facts.push([tr('fCert'), ltr([d.cert.issuer, d.cert.authorized === false ? d.cert.error : null].filter(Boolean).join(' · '))], [tr('fCertTo'), ltr(d.cert.validTo ? d.cert.validTo.slice(0, 10) : '—')]);
  if (d.page) {
    facts.push([tr('fLicences'), d.page.licences.length ? ltr(d.page.licences.map((l) => l.name).join(', ')) : tr('none')]);
    facts.push([tr('fProviders'), d.page.providers.length ? ltr(d.page.providers.join(', ')) : tr('none')]);
    if (d.page.externalHosts.length) facts.push([tr('fHosts'), ltr(d.page.externalHosts.slice(0, 8).map((h) => h.host).join(', '))]);
  }
  if (d.headers) facts.push([tr('fHeaders'), d.headers.missing.length ? ltr(d.headers.missing.join(', ')) : tr('none')]);
  box.append(el('h3', { class: 'sub' }, tr('factsTitle')));
  box.append(el('dl', { class: 'kv' }, facts.map(([k, v]) => [el('dt', {}, k), el('dd', {}, v)])));
  const copy = el('button', { type: 'button' }, tr('copyReport'));
  copy.addEventListener('click', async () => {
    const lines = [`${tr('pageTitle')} — ${d.url}`, `${tr('riskLabel')}: ${d.risk}/100`, '', ...findings.map((f) => `[${f.severity}] ${lang === 'en' ? f.en : f.ar}${f.evidence ? ` (${f.evidence})` : ''}`), '', ...facts.map(([k, v]) => `${k}: ${v.textContent || v}`), '', d.checkedAt];
    try { await navigator.clipboard.writeText(lines.join('\n')); copy.textContent = tr('copied'); setTimeout(() => { copy.textContent = tr('copyReport'); }, 1500); } catch (e) { /* clipboard unavailable */ }
  });
  box.append(el('div', { class: 'actions' }, copy, d.remaining !== undefined ? el('span', { class: 'muted small' }, `${tr('remaining')}: ${d.remaining}`) : null));
}

// ---------- 2. provably fair ----------
let fair = null;

function fairFields() {
  const g = $('#f-game').value;
  document.querySelectorAll('#fair [data-for]').forEach((n) => { n.hidden = n.dataset.for !== g; });
}

function parseShown(game, s) {
  const t = s.trim().replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x660)).replace(/٫/g, '.');
  if (!t) return null;
  if (game === 'mines') return t.split(/[\s,;،]+/).filter(Boolean).map(Number).filter((n) => Number.isInteger(n) && n >= 1 && n <= 25).sort((a, b) => a - b);
  return Number(t.replace(/[^\d.]/g, ''));
}

async function runFair() {
  showError('fair', null);
  $('#res-fair').replaceChildren();
  try {
    const game = $('#f-game').value;
    const r = await recompute({ game, serverSeed: $('#f-server').value, serverSeedHash: $('#f-hash').value, clientSeed: $('#f-client').value, nonce: num('#f-nonce'), mines: num('#f-mines'), rows: num('#f-rows') });
    fair = { ...r, shown: parseShown(game, $('#f-shown').value) };
    renderFair();
  } catch (e) {
    showError('fair', e instanceof FairError ? e : { ar: String(e.message || e), en: String(e.message || e) });
  }
}

function renderFair() {
  const box = $('#res-fair');
  box.replaceChildren();
  if (!fair) return;
  const r = fair;
  const c = r.commitment;
  box.append(el('div', { class: 'verdict ' + (c === 'match' ? 'pass' : c === 'mismatch' ? 'fail' : 'review'), id: 'fair-commitment' }, tr(c === 'match' ? 'cMatch' : c === 'mismatch' ? 'cMismatch' : 'cNone')));
  box.append(el('div', { class: 'hash' }, 'SHA-256(server seed) = ' + r.hash));
  let matched = null;
  if (r.game === 'mines') {
    const grid = el('div', { class: 'mines-grid', id: 'mines-grid' });
    const shownSet = new Set(r.shown || []);
    for (let i = 0; i < 25; i++) {
      const isMine = r.mines.includes(i);
      grid.append(el('div', { class: 'mtile' + (isMine ? ' mine' : '') + (shownSet.size && shownSet.has(i + 1) !== isMine ? ' diff' : ''), title: String(i + 1) }, el('span', { class: 'n' }, String(i + 1)), isMine ? el('span', { class: 'b' }, '💣') : null));
    }
    box.append(el('h3', { class: 'sub' }, tr('rMines')), grid);
    box.append(el('p', { class: 'mono-line', id: 'mines-list' }, r.mines.map((m) => m + 1).join(', ')));
    box.append(el('details', {}, el('summary', {}, tr('rOrder')), el('p', { class: 'mono-line' }, r.order.map((m) => m + 1).join(' → '))));
    if (r.shown && r.shown.length) matched = r.shown.length === r.mines.length && r.shown.every((v, i) => v === r.mines[i] + 1);
  } else if (r.game === 'plinko') {
    box.append(cards([{ k: tr('rBucket'), v: ltr(String(r.bucket) + ' / ' + r.rows) }, { k: tr('rPath'), v: ltr(r.path.map((d) => (d ? 'R' : 'L')).join('')) }]));
    if (r.shown !== null && Number.isFinite(r.shown)) matched = r.shown === r.bucket;
  } else {
    box.append(cards([{ k: tr('rResult'), v: ltr(r.game === 'limbo' ? r.result.toFixed(2) + '×' : r.result.toFixed(2)), cls: 'accent' }, { k: tr('rFloat'), v: ltr(r.floats[0].toFixed(10)) }]));
    if (r.shown !== null && Number.isFinite(r.shown)) matched = Math.abs(r.shown - r.result) < 0.005;
  }
  box.append(el('div', { class: 'verdict ' + (matched === null ? 'review' : matched ? 'pass' : 'fail'), id: 'fair-outcome' }, tr(matched === null ? 'oNone' : matched ? 'oMatch' : 'oMismatch')));
}

// ---------- 3. history ----------
let hist = null;

function runHist() {
  showError('hist', null);
  $('#res-hist').replaceChildren();
  try {
    const parsed = parseHistory($('#h-text').value);
    if (parsed.rows.length < 2) throw { ar: 'نحتاج سطرين على الأقل فيهما رهان ومكسب', en: 'At least two lines with a bet and a payout are needed' };
    const declared = num('#h-declared');
    const a = analyzePlayLog(parsed, { declaredRtp: declared ? declared / 100 : null, confidence: 0.95 });
    hist = { parsed, a };
    renderHist();
  } catch (e) {
    showError('hist', e.ar ? e : { ar: String(e.message || e), en: String(e.message || e) });
  }
}

function renderHist() {
  const box = $('#res-hist');
  box.replaceChildren();
  if (!hist) return;
  const { parsed, a } = hist;
  const net = a.totalWin - a.totalBet;
  box.append(cards([
    { k: tr('hRounds'), v: money(a.rounds, 0), s: `${tr('parsedRows')}: ${parsed.rows.length} · ${tr('skippedRows')}: ${parsed.skipped.length}` },
    { k: tr('hBets'), v: money(a.totalBet) },
    { k: tr('hWins'), v: money(a.totalWin) },
    { k: tr('hNet'), v: (net >= 0 ? '+' : '−') + money(Math.abs(net)), cls: net >= 0 ? 'good' : 'bad' },
    { k: tr('hReturn'), v: money(a.rtp * 100), cls: 'accent' },
    { k: tr('hTake'), v: money((1 - a.rtp) * 100), cls: a.rtp < 1 ? 'bad' : 'good' },
    { k: tr('hCi'), v: ltr(`${money(a.ci[0] * 100, 1)}% – ${money(a.ci[1] * 100, 1)}%`) },
    a.declared && { k: tr('hZ'), v: ltr((a.declared.difference >= 0 ? '+' : '−') + money(Math.abs(a.declared.difference) * 100) + ' pts'), s: `z = ${a.declared.z.toFixed(2)} · p = ${a.declared.pValue < 0.0001 ? '< 0.0001' : a.declared.pValue.toFixed(4)}` },
    { k: tr('hNeed'), v: money(a.roundsNeeded.find((r) => r.margin === 0.01).rounds, 0) },
  ]));
  const v = a.declared ? a.declared.verdict : null;
  const cls = v === 'suspicious' ? 'suspicious' : v === 'review' ? 'review' : v === 'normal' ? 'normal' : 'review';
  box.append(el('div', { class: 'verdict ' + cls, id: 'hist-verdict' }, tr(v === 'suspicious' ? 'vSuspicious' : v === 'review' ? 'vReview' : v === 'normal' ? 'vNormal' : 'vNoDeclared')));
  const rows = parsed.rows.slice(0, 8);
  box.append(el('details', { class: 'table-view', open: true }, el('summary', {}, tr('previewTitle')),
    el('div', { class: 'table-wrap' }, el('table', {},
      el('thead', {}, el('tr', {}, [tr('colLine'), tr('colBet'), tr('colWin')].map((h) => el('th', {}, h)))),
      el('tbody', {}, rows.map((r) => el('tr', {}, [String(r.line), money(r.bet, 8), money(r.win, 8)].map((x) => el('td', { class: 'num' }, x)))))))));
}

// ---------- examples ----------
function exampleFair() {
  $('#f-game').value = 'mines'; fairFields();
  $('#f-server').value = '7f3b1c9e2d4a5f60817293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8';
  $('#f-hash').value = '';
  $('#f-client').value = 'taryam-check';
  $('#f-nonce').value = '12';
  $('#f-mines').value = '3';
  $('#f-shown').value = '';
  runFair();
}

const EXAMPLE_HISTORY = [
  ['30/10/2026 21:01', '5.00', '×0.00', '0.00'], ['30/10/2026 21:01', '5.00', '×1.12', '5.60'], ['30/10/2026 21:02', '5.00', '×1.12', '5.60'],
  ['30/10/2026 21:02', '5.00', '×1.29', '6.45'], ['30/10/2026 21:03', '5.00', '×0.00', '0.00'], ['30/10/2026 21:03', '10.00', '×1.12', '11.20'],
  ['30/10/2026 21:04', '10.00', '×0.00', '0.00'], ['30/10/2026 21:04', '10.00', '×0.00', '0.00'], ['30/10/2026 21:05', '10.00', '×1.48', '14.80'],
  ['30/10/2026 21:05', '20.00', '×0.00', '0.00'], ['30/10/2026 21:06', '20.00', '×1.12', '22.40'], ['30/10/2026 21:06', '20.00', '×0.00', '0.00'],
  ['30/10/2026 21:07', '20.00', '×1.29', '25.80'], ['30/10/2026 21:07', '20.00', '×0.00', '0.00'], ['30/10/2026 21:08', '40.00', '×0.00', '0.00'],
  ['30/10/2026 21:08', '40.00', '×1.12', '44.80'], ['30/10/2026 21:09', '40.00', '×0.00', '0.00'], ['30/10/2026 21:09', '40.00', '×0.00', '0.00'],
  ['30/10/2026 21:10', '80.00', '×1.12', '89.60'], ['30/10/2026 21:10', '80.00', '×0.00', '0.00'],
];
function exampleHist() {
  $('#h-text').value = EXAMPLE_HISTORY.map((r) => `${r[0]}  Mines  ${r[1]} AED  ${r[2]}  ${r[3]} AED`).join('\n');
  $('#h-declared').value = '97';
  runHist();
}

// ---------- language and wiring ----------
function applyLang() {
  document.documentElement.lang = lang;
  document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr';
  document.title = tr('pageTitle') + ' — TARYAM';
  document.querySelectorAll('[data-t]').forEach((n) => { n.textContent = tr(n.dataset.t); });
  $('#predict-note').textContent = lang === 'en' ? PREDICTION_NOTE.en : PREDICTION_NOTE.ar;
  fairFields();
  renderSite(); renderFair(); renderHist();
}

function init() {
  $('#langToggle').addEventListener('click', () => { lang = lang === 'ar' ? 'en' : 'ar'; setLang(lang); applyLang(); });
  $('#run-site').addEventListener('click', runSite);
  $('#run-paste').addEventListener('click', runPaste);
  $('#s-url').addEventListener('keydown', (e) => { if (e.key === 'Enter') runSite(); });
  $('#f-game').addEventListener('change', fairFields);
  $('#run-fair').addEventListener('click', runFair);
  $('#example-fair').addEventListener('click', exampleFair);
  $('#run-hist').addEventListener('click', runHist);
  $('#example-hist').addEventListener('click', exampleHist);
  applyLang();
}

init();

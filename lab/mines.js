// "Mines from A to Z" page controller: the commitment check on a real round's hash
// and seed, the click-by-click ladder on the real game's multipliers, the user's
// pasted bet history, and the pointer to the site check. Nothing leaves the page.
import { getLang, setLang } from './i18n.js';
import { text, fmt } from './mines-text.js';
import { sha256Hex } from './core/fair.js';
import { ladder, parseMultipliers, sessionExpectation, pAheadAfter } from './core/mines-math.js';
import { parseHistory } from './core/history.js';
import { analyzePlayLog } from './core/actual.js';

const $ = (s) => document.querySelector(s);
let lang = getLang();
const tr = (key) => text(key, lang);
const money = (v, d = 2) => Number(v).toLocaleString('en-US', { maximumFractionDigits: d });
const pct = (v, d = 1) => (v * 100).toFixed(d) + '%';
const DECLARED = 0.96;

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
function showError(id, msg) {
  const box = $('#err-' + id);
  box.hidden = !msg;
  box.textContent = msg || '';
}
function num(id) {
  const s = $(id).value.trim().replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x660)).replace(/٫/g, '.').replace(/[٬,\s]/g, '');
  return s === '' ? null : Number(s);
}

// ---------- 1. commitment ----------
let commit = null;
async function runCommit() {
  showError('commit', null);
  const hash = $('#c-hash').value.trim().toLowerCase();
  const seed = $('#c-seed').value.trim();
  if (!hash || !seed) { showError('commit', tr('cNeed')); return; }
  const computed = await sha256Hex(seed);
  commit = { hash, seed, computed, match: computed === hash.replace(/^0x/, '') };
  renderCommit();
}
function renderCommit() {
  const box = $('#res-commit');
  box.replaceChildren();
  if (!commit) return;
  box.append(el('div', { class: 'verdict ' + (commit.match ? 'pass' : 'fail'), id: 'commit-verdict' }, tr(commit.match ? 'cMatch' : 'cMismatch')));
  box.append(el('div', { class: 'hash' }, `SHA-256("${commit.seed}") = ${commit.computed}`));
  box.append(el('div', { class: 'hash' }, `${lang === 'en' ? 'shown' : 'المعروض'} = ${commit.hash}`));
}
function exampleCommit() {
  $('#c-hash').value = 'dde93053e586c455f19696d7299d3be462e363321c24b031074737f9009fcf22';
  $('#c-seed').value = 'turbo-demo-round-7f3a91';
  runCommit();
}

// ---------- 2. ladder ----------
let rows = null, params = null, walkK = 0;
function runLadder() {
  showError('ladder', null);
  try {
    const mines = num('#l-mines'), bet = num('#l-bet'), rtp = (num('#l-rtp') || 96) / 100;
    if (!(Number.isInteger(mines) && mines >= 1 && mines <= 24)) throw new Error(lang === 'en' ? 'Mines must be from 1 to 24' : 'عدد الألغام من 1 إلى 24');
    if (!(bet > 0)) throw new Error(lang === 'en' ? 'Enter a bet above 0' : 'أدخل رهانًا أكبر من 0');
    const offered = parseMultipliers($('#l-mults').value);
    params = { mines, bet, rtp, offered };
    rows = ladder({ mines, bet, rtp, offered });
    walkK = 0;
    renderLadder(); renderWalk(); renderSession();
  } catch (e) { showError('ladder', e.message); }
}
function renderLadder() {
  const box = $('#res-ladder');
  box.replaceChildren();
  if (!rows) return;
  const { bet } = params;
  const typed = rows.filter((r) => r.fromGame);
  const flatTake = rows[0].takePct;
  box.append(el('p', { class: 'headline', id: 'ladder-headline' }, fmt(tr('ladderHeadline'), { ev: money(rows[0].expectedReturn), bet: money(bet), take: pct(flatTake) })));
  if (typed.length) {
    const implied = typed.reduce((s, r) => s + r.impliedRtp, 0) / typed.length;
    box.append(el('p', { class: typed.length && implied < 0.93 ? 'verdict fail' : 'verdict pass', id: 'ladder-implied' }, fmt(tr('ladderImplied'), { rtp: pct(implied) }) + ' ' + tr(implied < 0.93 ? 'ladderImpliedLow' : 'ladderImpliedOk')));
  }
  const show = rows.slice(0, Math.min(rows.length, 12));
  box.append(el('div', { class: 'table-wrap' }, el('table', { class: 'ladder' },
    el('thead', {}, el('tr', {}, [tr('colK'), tr('colBomb'), tr('colSurvive'), tr('colFair'), tr('colOffered'), tr('colTake'), tr('colEv')].map((h) => el('th', {}, h)))),
    el('tbody', {}, show.map((r) => el('tr', {},
      el('td', { class: 'num' }, String(r.k)),
      el('td', { class: 'num' }, pct(r.pBombNext)),
      el('td', { class: 'num' }, pct(r.pSurvive)),
      el('td', { class: 'num' }, '×' + r.fair.toFixed(2)),
      el('td', { class: 'num offered' }, '×' + r.offered.toFixed(2), r.fromGame ? el('span', { class: 'tag' }, tr('fromGame')) : null),
      el('td', { class: 'num fail' }, pct(r.takePct)),
      el('td', { class: 'num' }, money(r.expectedReturn) + ' / ' + money(bet))))))));
}
function renderWalk() {
  const grid = $('#walk-grid');
  grid.replaceChildren();
  if (!rows) { $('#walk-state').textContent = ''; return; }
  for (let i = 0; i < 25; i++) grid.append(el('div', { class: 'mtile' + (i < walkK ? ' gem' : '') }, i < walkK ? '💎' : ''));
  const r = walkK ? rows[walkK - 1] : null;
  $('#walk-state').textContent = r
    ? fmt(tr('walkState'), { k: walkK, mult: r.offered.toFixed(2), payout: money(r.payoutIfSurvive), bomb: pct(walkK < rows.length ? rows[walkK].pBombNext : 1, 1), ev: money(r.expectedReturn) })
    : tr('walkStart');
  $('#walk-safe').disabled = walkK >= rows.length;
}
function renderSession() {
  const box = $('#res-session');
  box.replaceChildren();
  if (!rows) return;
  const n = Math.max(1, Math.min(100000, Math.round(num('#s-rounds') || 200)));
  $('#session-title').textContent = fmt(tr('sessionTitle'), { n: money(n, 0) });
  const rtpUsed = rows[0].impliedRtp;
  const s = sessionExpectation({ rounds: n, bet: params.bet, rtp: rtpUsed });
  const ahead = pAheadAfter({ rounds: n, pWin: rows[0].pSurvive, mult: rows[0].offered });
  box.append(cards([
    { k: tr('sWagered'), v: money(s.wagered) },
    { k: tr('sLoss'), v: '−' + money(s.expectedLoss), cls: 'bad', s: pct(1 - rtpUsed) + ' × ' + money(s.wagered) },
    { k: tr('sAhead'), v: pct(ahead, ahead < 0.001 ? 3 : 1), cls: ahead < 0.1 ? 'bad' : 'accent' },
  ]));
}

// ---------- 3. history ----------
let hist = null;
function runHist() {
  showError('hist', null);
  $('#res-hist').replaceChildren();
  try {
    const parsed = parseHistory($('#h-text').value);
    if (parsed.rows.length < 2) throw new Error(tr('histNeed'));
    hist = { parsed, a: analyzePlayLog(parsed, { declaredRtp: DECLARED, confidence: 0.95 }) };
    renderHist();
  } catch (e) { showError('hist', e.message); }
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
    { k: tr('hZ'), v: ltr((a.declared.difference >= 0 ? '+' : '−') + money(Math.abs(a.declared.difference) * 100) + ' pts'), s: `z = ${a.declared.z.toFixed(2)} · p = ${a.declared.pValue < 0.0001 ? '< 0.0001' : a.declared.pValue.toFixed(4)}` },
  ]));
  const v = a.declared.verdict;
  box.append(el('div', { class: 'verdict ' + (v === 'suspicious' ? 'suspicious' : v === 'review' ? 'review' : 'normal'), id: 'hist-verdict' }, tr(v === 'suspicious' ? 'vSuspicious' : v === 'review' ? 'vReview' : 'vNormal')));
}
const EXAMPLE = [['5.00', '×0.00', '0.00'], ['5.00', '×1.09', '5.45'], ['5.00', '×1.24', '6.20'], ['5.00', '×0.00', '0.00'], ['5.00', '×1.09', '5.45'], ['10.00', '×0.00', '0.00'], ['10.00', '×1.43', '14.30'], ['10.00', '×0.00', '0.00'], ['10.00', '×1.09', '10.90'], ['10.00', '×0.00', '0.00'], ['10.00', '×1.24', '12.40'], ['20.00', '×0.00', '0.00'], ['20.00', '×1.09', '21.80'], ['20.00', '×0.00', '0.00'], ['20.00', '×1.09', '21.80'], ['20.00', '×1.66', '33.20'], ['20.00', '×0.00', '0.00'], ['40.00', '×0.00', '0.00'], ['40.00', '×1.09', '43.60'], ['40.00', '×0.00', '0.00']];
function exampleHist() {
  $('#h-text').value = EXAMPLE.map((r, i) => `30/10/2026 17:${String(i + 1).padStart(2, '0')}  Mines  ${r[0]} AED  ${r[1]}  ${r[2]} AED`).join('\n');
  runHist();
}

// ---------- language and wiring ----------
function applyLang() {
  document.documentElement.lang = lang;
  document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr';
  document.title = tr('pageTitle') + ' — TARYAM';
  document.querySelectorAll('[data-t]').forEach((n) => { n.textContent = tr(n.dataset.t); });
  renderCommit(); renderLadder(); renderWalk(); renderSession(); renderHist();
}

function init() {
  $('#langToggle').addEventListener('click', () => { lang = lang === 'ar' ? 'en' : 'ar'; setLang(lang); applyLang(); });
  $('#run-commit').addEventListener('click', runCommit);
  $('#example-commit').addEventListener('click', exampleCommit);
  $('#run-ladder').addEventListener('click', runLadder);
  for (const id of ['#l-mines', '#l-bet', '#l-rtp', '#l-mults']) $(id).addEventListener('keydown', (e) => { if (e.key === 'Enter') runLadder(); });
  $('#walk-safe').addEventListener('click', () => { if (rows && walkK < rows.length) { walkK++; renderWalk(); } });
  $('#walk-reset').addEventListener('click', () => { walkK = 0; renderWalk(); });
  $('#s-rounds').addEventListener('input', renderSession);
  $('#run-hist').addEventListener('click', runHist);
  $('#example-hist').addEventListener('click', exampleHist);
  applyLang();
  runLadder();
}

init();

// Bilingual (Arabic / English) PDF report. Pages are laid out on canvases so the
// browser shapes Arabic text, then embedded as JPEG pages; a final page carries the
// identifiers and fingerprints as real, copyable text, and the input files plus a
// machine-readable report.json are attached inside the PDF. With a signing key,
// report.sig (core/report-sign.js) signs report.json and every other byte of the PDF.
import { PdfBuilder } from './core/pdf.js';
import { canonicalJson } from './core/slot-model.js';
import { sha256Hex } from './core/fair.js';
import { pair, NIST_NAMES, VOLATILITY, VERDICT } from './i18n.js';
import { planAttachments, buildManifest, reportIdFor, ATTACH_LIMIT_BYTES, REPORT_FILE, SIGNATURE_FILE } from './core/manifest.js';
import { signaturePlaceholder, sealReportPdf } from './core/report-sign.js';
import { formatFingerprint, ALGORITHM_INFO } from './core/sign.js';

const W = 1488, H = 2105; // A4 at about 180 dpi
const M = 92;
const FONT = '"Segoe UI", Tahoma, "Noto Sans Arabic", "Noto Sans", "DejaVu Sans", Arial, sans-serif';
const MONO = 'ui-monospace, Menlo, Consolas, "DejaVu Sans Mono", monospace';
const C = { text: '#111827', muted: '#6b7280', accent: '#5b21b6', line: '#e5e7eb', zebra: '#f8f7fc', pass: '#047857', fail: '#b91c1c', warn: '#b45309', band: '#f5f3ff' };

const pct = (v, d = 4) => (v * 100).toFixed(d) + '%';
const num = (v, d = 4) => (v === null || v === undefined || Number.isNaN(v) ? '—' : Number(v).toLocaleString('en-US', { maximumFractionDigits: d }));
const fmtP = (p) => (p === null || p === undefined ? '—' : p < 1e-6 ? p.toExponential(2) : p.toFixed(6));

// Lays pages out on one reused canvas. When a page is complete it is decorated
// (header, footer, page x / total) and handed to onPage, which must copy it
// synchronously (canvas.toBlob snapshots the bitmap when called).
class Layout {
  constructor(canvas, { reportId = '', created = '', totalPages = 0, onPage = () => {} } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    Object.assign(this, { reportId, created, totalPages, onPage });
    this.page = 0;
    this.begin();
  }

  begin() {
    this.ctx.fillStyle = '#ffffff';
    this.ctx.fillRect(0, 0, W, H);
    this.page++;
    this.y = 190;
  }

  newPage() {
    this.decorate();
    this.onPage(this.canvas, this.page);
    this.begin();
  }

  end() {
    this.decorate();
    this.onPage(this.canvas, this.page);
  }

  get bottom() { return H - 140; }

  ensure(h) { if (this.y + h > this.bottom) this.newPage(); }

  setFont(size, weight = '400', family = FONT) { this.ctx.font = `${weight} ${size}px ${family}`; }

  draw(str, x, y, { size = 24, weight = '400', color = C.text, align = 'left', dir = 'ltr', family = FONT } = {}) {
    const ctx = this.ctx;
    this.setFont(size, weight, family);
    ctx.fillStyle = color;
    ctx.direction = dir;
    ctx.textAlign = align;
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(String(str), x, y);
  }

  measure(str, size, weight = '400', family = FONT) { this.setFont(size, weight, family); return this.ctx.measureText(String(str)).width; }

  // Word wrap; a word wider than the line (e.g. a hash) is broken by characters.
  wrap(str, maxWidth, size, weight = '400', family = FONT) {
    const fits = (s) => this.measure(s, size, weight, family) <= maxWidth;
    const out = [];
    for (const para of String(str).split('\n')) {
      let line = '';
      for (const word of para.split(/\s+/).filter(Boolean)) {
        const test = line ? line + ' ' + word : word;
        if (fits(test)) { line = test; continue; }
        if (line) out.push(line);
        if (fits(word)) { line = word; continue; }
        let chunk = '';
        for (const ch of word) {
          if (chunk && !fits(chunk + ch)) { out.push(chunk); chunk = ''; }
          chunk += ch;
        }
        line = chunk;
      }
      out.push(line);
    }
    return out;
  }

  section(key) {
    const [ar, en] = pair(key);
    this.ensure(120);
    this.y += 24;
    this.draw(ar, W - M, this.y, { size: 36, weight: '700', color: C.accent, align: 'right', dir: 'rtl' });
    this.draw(en, M, this.y, { size: 26, weight: '600', color: C.muted });
    this.y += 18;
    this.ctx.fillStyle = C.accent;
    this.ctx.fillRect(M, this.y, W - 2 * M, 3);
    this.y += 44;
  }

  // Arabic label on the right, English label on the left, value in the middle
  // (or on its own full-width line when it is long).
  kv(key, value, { mono = false, color = C.text, labels = null } = {}) {
    const [ar, en] = labels || pair(key);
    const v = String(value);
    const family = mono ? MONO : FONT;
    const size = mono ? 22 : 25;
    const midWidth = W - 2 * M - 2 * 420;
    const long = this.measure(v, size, '600', family) > midWidth;
    const lines = long ? this.wrap(v, W - 2 * M - 40, size, '600', family) : [v];
    const h = 46 + (long ? lines.length * 34 : 0);
    this.ensure(h);
    this.draw(ar, W - M, this.y, { size: 23, color: C.text, align: 'right', dir: 'rtl' });
    this.draw(en, M, this.y, { size: 21, color: C.muted });
    if (!long) this.draw(v, W / 2, this.y, { size, weight: '600', color, align: 'center', family });
    else lines.forEach((l, i) => this.draw(l, M + 20, this.y + 36 + i * 34, { size, weight: '600', color, family }));
    this.ctx.fillStyle = C.line;
    this.ctx.fillRect(M, this.y + h - 30, W - 2 * M, 1);
    this.y += h;
  }

  note(key, extra = null) {
    const [ar, en] = extra || pair(key);
    const width = W - 2 * M;
    const arLines = this.wrap(ar, width, 22);
    const enLines = this.wrap(en, width, 20);
    this.ensure((arLines.length + enLines.length) * 32 + 20);
    arLines.forEach((l) => { this.draw(l, W - M, this.y, { size: 22, color: C.muted, align: 'right', dir: 'rtl' }); this.y += 32; });
    enLines.forEach((l) => { this.draw(l, M, this.y, { size: 20, color: C.muted }); this.y += 30; });
    this.y += 14;
  }

  badge(key, color, labels = null) {
    const [ar, en] = labels || pair(key);
    this.ensure(80);
    const ctx = this.ctx;
    ctx.fillStyle = color;
    ctx.globalAlpha = 0.1;
    ctx.fillRect(M, this.y - 40, W - 2 * M, 64);
    ctx.globalAlpha = 1;
    ctx.fillRect(W - M - 8, this.y - 40, 8, 64);
    this.draw(ar, W - M - 28, this.y + 2, { size: 28, weight: '700', color, align: 'right', dir: 'rtl' });
    this.draw(en, M + 20, this.y + 2, { size: 24, weight: '600', color });
    this.y += 64;
  }

  // Right-to-left table; columns: [{ key | labels, w (fraction of width), mono, align }].
  table(columns, rows) {
    const width = W - 2 * M;
    const xs = [];
    let x = W - M;
    for (const c of columns) { xs.push([x - c.w * width, x]); x -= c.w * width; }
    const header = () => {
      this.ensure(110);
      const ctx = this.ctx;
      ctx.fillStyle = C.band;
      ctx.fillRect(M, this.y - 36, width, 78);
      columns.forEach((c, i) => {
        const [ar, en] = c.labels || pair(c.key);
        const cx = (xs[i][0] + xs[i][1]) / 2;
        this.draw(ar, cx, this.y, { size: 21, weight: '700', align: 'center', dir: 'rtl' });
        this.draw(en, cx, this.y + 28, { size: 17, color: C.muted, align: 'center' });
      });
      this.y += 76;
    };
    header();
    rows.forEach((row, r) => {
      if (this.y + 44 > this.bottom) { this.newPage(); header(); }
      if (r % 2 === 1) { this.ctx.fillStyle = C.zebra; this.ctx.fillRect(M, this.y - 30, width, 44); }
      row.forEach((cell, i) => {
        const c = columns[i];
        const v = typeof cell === 'object' && cell !== null ? cell : { text: cell };
        const family = c.mono ? MONO : FONT;
        const size = c.mono ? 19 : 21;
        let text = String(v.text);
        const maxW = xs[i][1] - xs[i][0] - 16;
        while (text.length > 1 && this.measure(text, size, '400', family) > maxW) text = text.slice(0, -2) + '…';
        const rtl = /[\u0600-\u06ff]/.test(text);
        this.draw(text, (xs[i][0] + xs[i][1]) / 2, this.y, { size, color: v.color || C.text, align: 'center', dir: rtl ? 'rtl' : 'ltr', family, weight: v.bold ? '700' : '400' });
      });
      this.y += 44;
    });
    this.y += 18;
  }

  // Monospace block: wraps by character count so indentation is kept.
  mono(lines) {
    const size = 18, lh = 25, width = W - 2 * M - 30;
    const perLine = Math.max(10, Math.floor(width / this.measure('0', size, '400', MONO)));
    for (const raw of lines) {
      const parts = [];
      for (let i = 0; i < Math.max(1, raw.length); i += perLine) parts.push(raw.slice(i, i + perLine));
      for (const l of parts) {
        if (this.y + lh > this.bottom) this.newPage();
        this.draw(l, M + 15, this.y, { size, family: MONO, color: '#1f2937' });
        this.y += lh;
      }
    }
    this.y += 10;
  }

  decorate() {
    const ctx = this.ctx;
    ctx.fillStyle = C.accent;
    ctx.fillRect(0, 0, W, 12);
    this.draw('تقرير مختبر RTP', W - M, 82, { size: 40, weight: '700', color: C.accent, align: 'right', dir: 'rtl' });
    this.draw('RTP Lab Report', M, 82, { size: 32, weight: '700', color: C.accent });
    this.draw(`${this.reportId}   ·   ${this.created}`, W / 2, 128, { size: 21, family: MONO, color: C.muted, align: 'center' });
    ctx.fillStyle = C.line;
    ctx.fillRect(M, 148, W - 2 * M, 2);
    ctx.fillRect(M, H - 108, W - 2 * M, 2);
    const [far, fen] = pair('footer');
    this.draw(far, W - M, H - 70, { size: 18, color: C.muted, align: 'right', dir: 'rtl' });
    this.draw(fen, M, H - 70, { size: 17, color: C.muted });
    this.draw(`${this.page} / ${this.totalPages || '?'}`, W / 2, H - 40, { size: 20, color: C.muted, align: 'center' });
  }
}

async function canvasToJpeg(canvas, quality = 0.9) {
  const blob = canvas.convertToBlob ? await canvas.convertToBlob({ type: 'image/jpeg', quality }) : await new Promise((r) => canvas.toBlob(r, 'image/jpeg', quality));
  return new Uint8Array(await blob.arrayBuffer());
}

// Machine-readable summary that the report fingerprint (and signature) covers.
// session.signer: the signing key or null; session.inputs may carry `attachment`
// (planAttachments: the name inside the PDF, null for hash only).
export function reportPayload(session, createdAt) {
  const r = session.results;
  const out = {
    format: 'taryam-rtp-lab-report/1',
    createdAt,
    meta: { title: session.meta.title || '', auditor: session.meta.auditor || '', notes: session.meta.notes || '' },
    inputs: session.inputs.map((i) => ({ id: i.id, name: i.name, kind: i.kind, size: i.size, sha256: i.sha256 })),
    results: {},
    signer: session.signer ? { alg: session.signer.alg, keyFingerprint: session.signer.fingerprint, keyStorage: session.signer.storage, file: SIGNATURE_FILE } : null,
    manifest: buildManifest(session),
  };
  if (r.theoretical) {
    const x = r.theoretical.result;
    out.results.theoretical = {
      input: r.theoretical.inputId, model: x.model, rtp: x.rtp, contributions: x.contributions, freeSpins: x.freeSpins,
      distribution: x.distribution && { hitFrequency: x.distribution.hitFrequency, variance: x.distribution.variance, sd: x.distribution.sd, maxWin: x.distribution.maxWin, ...(x.distribution.closedForm ? { closedForm: true } : {}) },
      symbols: x.symbols.map((s) => ({ symbol: s.symbol, rtp: s.rtp.fraction })),
      // Ways and cascading games (P0-6): "firstDrop" = the first drop only, not the game's RTP.
      ...(x.model.ways || x.scope ? { scope: x.scope || 'round' } : {}),
      ...(x.controlVariate ? { controlVariate: x.controlVariate } : {}),
    };
  }
  if (r.actual) {
    const a = r.actual.result;
    out.results.actual = { input: r.actual.inputId, options: r.actual.options, rounds: a.rounds, totalBet: a.totalBet, totalWin: a.totalWin, rtp: a.rtp, ci: a.ci, confidence: a.confidence, standardError: a.standardError, declared: a.declared || null, roundsNeeded: a.roundsNeeded, skipped: r.actual.skipped };
  }
  if (r.distTests) {
    const d = r.distTests, x = d.result;
    out.results.distTests = {
      input: d.inputId, inputs: d.inputIds, candidates: d.candidates.map((c) => ({ label: c.label, kind: c.kind, input: c.inputId })),
      options: d.options, seed: x.seed, generator: x.generator, rounds: x.rounds, mode: x.mode, scope: x.scope, refIndex: x.refIndex, alpha: x.alpha,
      distributions: x.candidates, fit: x.fit, versions: x.versions || null, betting: x.betting, planner: x.planner,
    };
  }
  if (r.rng) {
    out.results.rng = {
      input: r.rng.inputId, kind: r.rng.parsed.kind, bits: r.rng.parsed.nBits, values: r.rng.parsed.nValues,
      nist: r.rng.nist.results.map((t) => ({ id: t.id, applicable: t.applicable, pass: t.pass ?? null, status: t.status ?? null, pValues: t.pValues || null })),
      twoLevel: r.rng.nist.twoLevel ? { sequences: r.rng.nist.sequences, sequenceLength: r.rng.nist.sequenceLength } : null,
      family: r.rng.family || null,
      chiSquare: r.rng.chi, serialCorrelation: r.rng.serial,
    };
  }
  if (r.fair && r.fair.mode === 'adapter') out.results.fair = pfPayload(r.fair);
  else if (r.fair) {
    const f = r.fair.result;
    out.results.fair = { input: r.fair.inputId, scheme: r.fair.scheme, options: r.fair.options, ok: f.ok, summary: { ...f, mismatches: (f.mismatches || []).slice(0, 100), commitmentFailures: (f.commitmentFailures || []).slice(0, 100), breaks: (f.breaks || []).slice(0, 100) } };
  }
  if (r.montecarlo) {
    const m = r.montecarlo;
    out.results.montecarlo = { modelSha256: m.modelSha256, seed: m.seed, spins: m.spins, generator: m.generator, result: m.result, resultSha256: m.resultSha256, exactRtp: m.exactRtp ?? null, ...(m.controlVariate ? { controlVariate: m.controlVariate } : {}) };
  }
  if (r.lut) {
    const x = r.lut.result;
    out.results.lut = { inputs: r.lut.inputIds, format: x.format, indexFile: x.indexFile, ignored: x.ignored, provablyFair: false, modes: x.modes, profile: x.profile };
  }
  return out;
}

function theorySection(L, th) {
  const x = th.result;
  const ways = x.model.ways, firstDrop = x.scope === 'firstDrop';
  L.section('tabTheory');
  L.kv('game', x.model.name || '—');
  if (ways) L.kv('waysEval', pair('waysWord').join(' / '));
  else L.kv('layout', `${x.model.reels} × ${x.model.rows}, ${x.model.lines}`);
  L.kv('stops', x.model.stops.join(' / '));
  L.kv(ways ? 'waysCombinations' : 'combinations', BigInt(x.model.combinations).toLocaleString('en-US'));
  L.kv('modelHash', th.modelSha256, { mono: true });
  L.kv(firstDrop ? 'rtpFirstDrop' : 'rtp', x.rtp.percent + '%', { color: C.accent });
  L.kv('exactFraction', x.rtp.fraction, { mono: true });
  if (firstDrop) { L.badge('firstDropBadge', C.warn); L.note('firstDropNote'); }
  const d = x.distribution;
  if (d) {
    L.kv('hitFrequency', d.hitFrequency ? pct(d.hitFrequency.value, 4) : '—');
    if (!d.hitFrequency) L.note('hitUnavailable');
    L.kv('sd', num(d.sd, 4));
    L.kv('vi90', num(d.volatilityIndex90, 4));
    const v = VOLATILITY[d.volatilityClass];
    L.kv('volatility', v[0] + ' / ' + v[1]);
    if (d.maxWin) L.kv('maxWinBase', num(d.maxWin.base, 2) + '×');
    if (d.maxWin && d.maxWin.perFreeSpin !== undefined) {
      L.kv('maxWinFs', num(d.maxWin.perFreeSpin, 2) + '×');
      L.kv('maxWinTotal', d.maxWin.unbounded ? pair('unbounded').join(' / ') : num(d.maxWin.withFeature, 2) + '×');
    }
  }
  if (x.distributionError && !d) L.badge('distributionError', C.warn, [x.distributionError.ar, x.distributionError.en]);
  // A ways game whose full distribution is too large: the message says what stays exact.
  else if (x.distributionError) L.note(null, [x.distributionError.ar, x.distributionError.en]);
  L.section('contributions');
  const c = x.contributions;
  L.table([{ key: 'contributions', w: 0.5 }, { key: 'contribution', w: 0.5, mono: true }], [
    [pair(ways ? 'contribWays' : 'contribLines').join(' / '), c.lines.percent + '%'],
    [pair('contribWild').join(' / '), c.wildAssistedLines.percent + '%'],
    [pair('contribScatter').join(' / '), c.scatter.percent + '%'],
    [pair('contribFs').join(' / '), c.freeSpins.percent + '%'],
    [{ text: 'RTP', bold: true }, { text: x.rtp.percent + '%', bold: true }],
  ]);
  if (ways) L.note('waysWildNote');
  if (x.freeSpins) {
    const f = x.freeSpins;
    L.kv('triggerProb', `${pct(f.triggerProbability.value, 4)}  (1 / ${num(1 / f.triggerProbability.value, 1)})`);
    L.kv('expectedSpins', num(f.expectedSpinsPerTrigger.value, 4));
    L.kv('evPerTrigger', num(f.evPerTrigger.value, 4) + '×');
  }
  if (x.model.weighted) weightsSection(L, x.model);
  if (ways) waysSection(L, x);
  L.section(ways ? 'symbolTableWays' : 'symbolTable');
  const rows = [];
  for (const s of x.symbols) for (const b of s.byCount) rows.push([s.symbol + (s.isWild ? ' (wild)' : ''), b.count, num(b.pay, 4), b.probabilityPerLine.value.toExponential(4), b.rtp.percent + '%']);
  L.table([{ key: 'symbol', w: 0.22 }, { key: 'count', w: 0.12 }, { key: ways ? 'payPerWay' : 'pay', w: 0.16 }, { key: ways ? 'probabilityRun' : 'probability', w: 0.24, mono: true }, { key: 'contribution', w: 0.26, mono: true }], rows);
  if (x.scatter && x.scatter.length) {
    L.table([{ labels: ['عدد الـScatter', 'Scatters'], w: 0.25 }, { key: 'probability', w: 0.35, mono: true }, { labels: ['الدفع × الرهان', 'Pay × bet'], w: 0.2 }, { labels: ['تفعيل', 'Trigger'], w: 0.2 }],
      x.scatter.map((s) => [s.count, s.probability.value.toExponential(4), num(s.pay, 4), s.triggers ? '✓' : '']));
  }
  if (d && d.buckets) {
    L.section('distribution');
    L.table([{ key: 'range', w: 0.5 }, { key: 'probability', w: 0.5, mono: true }],
      d.buckets.map((b) => [b.to === 0 ? '0' : b.to === null ? `≥ ${b.from}` : `${b.from} – ${b.to}`, pct(b.probability.value, 4)]));
  }
}

// ---- Ways / Megaways (P0-6) ----
// Heights one row per (reel, height), so no cell holds a list that L.table would cut.
function waysHeightsRows(src) {
  const rows = [];
  src.heights.forEach((h, i) => h.rows.forEach((r, j) => rows.push([j === 0 ? i + 1 : '', r, h.probabilities[j] + '%', j === 0 && h.topCell ? '✓' : '', j === 0 && h.joint ? '✓' : ''])));
  return rows;
}
const WAYS_HEIGHT_COLUMNS = [{ key: 'reelNo', w: 0.14 }, { key: 'waysHeight', w: 0.18 }, { key: 'probability', w: 0.28, mono: true }, { key: 'waysTopCell', w: 0.22 }, { key: 'waysJoint', w: 0.18 }];
function waysSourceKv(L, src) {
  L.kv('maxWays', BigInt(src.maxWays).toLocaleString('en-US'));
  L.kv('waysRange', `${BigInt(src.minWays).toLocaleString('en-US')} – ${BigInt(src.maxWays).toLocaleString('en-US')}`);
  L.kv('topReelKv', src.topReel ? `${src.topReel.covers.join(', ')} · ${src.topReel.stops}` : '—');
  L.table(WAYS_HEIGHT_COLUMNS, waysHeightsRows(src));
}
function waysSection(L, x) {
  const w = x.model.ways;
  L.section('waysTitle');
  L.kv('betCostLabel', String(w.betCost));
  waysSourceKv(L, w.base);
  if (w.freeSpins) { L.section('fsWindows'); waysSourceKv(L, w.freeSpins); }
  L.kv('multStrategy', w.multiplierStrategy + (w.multiplierStrategy === 'global' ? ` × ${w.globalMultiplier}` : ''));
  L.note('multStrategy_' + w.multiplierStrategy);
  if (w.multiplierStrategy === 'global') L.note('globalPayNote');
  L.kv('wildReel1', 'wildStartsWin: ' + w.wildStartsWin);
  L.note('wildReel1_' + w.wildStartsWin);
  if (w.multiplierSymbols.length) L.kv('multiplierSymbolsLabel', w.multiplierSymbols.map((m) => `${m.symbol} = ${m.countsAs} × ${m.multiplier}`).join(', '));
  if (x.controlVariate) L.kv('controlVariateLabel', x.controlVariate.mean.percent + '%');
  L.note('waysPayUnit');
  L.note('waysSource');
  if (w.multiplierStrategy === 'board') L.note('waysBoardNote');
  L.note('waysNotCert');
}

// ---- Weighted stops and reel sets (P0-5) ----
const bigNum = (s) => BigInt(s).toLocaleString('en-US');
// One row per reel of each set, so no cell holds more than one number: L.table cuts a
// cell that does not fit with '…'. The widest values still fit their columns at 19px
// mono: a set weight up to 2^64 - 1 (26 characters with commas) and a reel total up to
// 10,000 stops x (2^64 - 1) (31 characters).
function reelSetsTable(L, sets) {
  const rows = [];
  sets.forEach((st, i) => st.reelTotals.forEach((total, k) => rows.push(k === 0
    ? [i + 1, bigNum(st.weight), st.probability.percent + '%', k + 1, st.stops[k], bigNum(total)]
    : ['', '', '', k + 1, st.stops[k], bigNum(total)])));
  L.table([{ key: 'reelSet', w: 0.1 }, { key: 'setWeight', w: 0.25, mono: true }, { key: 'probability', w: 0.15, mono: true },
    { key: 'reelNo', w: 0.08 }, { key: 'reelStops', w: 0.12, mono: true }, { key: 'reelTotal', w: 0.3, mono: true }], rows);
}
function weightsSection(L, m) {
  L.section('weightedModel');
  L.kv('totalWeight', bigNum(m.totalWeight), { mono: true });
  L.kv('reelSetsCount', m.reelSets.length);
  reelSetsTable(L, m.reelSets);
  // Ways (P0-6): the top reel's total weight multiplies a set's cycle.
  if (m.reelSets[0].topReelTotal) L.kv('topReelTotal', bigNum(m.reelSets[0].topReelTotal), { mono: true });
  if (m.freeSpinReelSets) {
    L.kv('fsReelSetsCount', m.freeSpinReelSets.length);
    reelSetsTable(L, m.freeSpinReelSets);
    if (m.freeSpinReelSets[0].topReelTotal) L.kv('topReelTotal', bigNum(m.freeSpinReelSets[0].topReelTotal), { mono: true });
  }
  L.note('weightsNote');
  if (m.ways) L.note('waysWeightsNote');
}

function actualSection(L, ac) {
  const a = ac.result;
  L.section('tabActual');
  L.kv('roundsChecked', a.rounds.toLocaleString('en-US'));
  L.kv('totalBet', num(a.totalBet, 2));
  L.kv('totalWin', num(a.totalWin, 2));
  L.kv('observedRtp', pct(a.rtp, 4), { color: C.accent });
  L.kv('ci', `${(a.confidence * 100).toFixed(1)}%:  ${pct(a.ci[0], 3)} – ${pct(a.ci[1], 3)}`);
  L.kv('sigmaSource', `${num(a.sigmaUsed, 4)} (${a.sigmaSource === 'declared' ? pair('declaredWord').join(' / ') : pair('observed').join(' / ')})`);
  if (a.declared) {
    const dd = a.declared;
    L.kv('declaredRtp', pct(dd.rtp, 4));
    L.kv('difference', (dd.difference >= 0 ? '+' : '') + pct(dd.difference, 4));
    L.kv('zScore', num(dd.z, 3));
    L.kv('pBelow', fmtP(dd.pBelow ?? dd.pValue));
    const color = dd.verdict === 'normal' ? C.pass : dd.verdict === 'suspicious' ? C.fail : C.warn;
    L.badge(null, color, VERDICT[dd.verdict]);
    if (dd.verdict === 'insufficient') L.note('insufficientNote');
    if (dd.aboveDeclared) L.note('aboveDeclared');
    if (dd.roundsToDetect) L.kv('roundsToDetect', dd.roundsToDetect.toLocaleString('en-US'));
  }
  if (a.reliable === null) { L.badge('reliableUnknownShort', C.warn); L.note('reliableUnknown'); }
  else L.badge(null, a.reliable ? C.pass : C.warn, pair(a.reliable ? 'reliableYes' : 'reliableNo'));
  L.table([{ key: 'margin', w: 0.5 }, { key: 'roundsChecked', w: 0.5, mono: true }], a.roundsNeeded.map((r) => ['± ' + pct(r.margin, 1), r.rounds.toLocaleString('en-US')]));
  if (a.modes) {
    L.section('byMode');
    L.table([{ key: 'modeName', w: 0.4 }, { key: 'roundsChecked', w: 0.3, mono: true }, { key: 'observedRtp', w: 0.3, mono: true }],
      a.modes.map((m) => [m.mode, m.rounds.toLocaleString('en-US'), pct(m.rtp, 3)]));
    L.note('modesNote');
  }
  const mg = a.merged;
  if (mg && (mg.freeRows || mg.sameRoundRows)) L.kv('mergedRows', (mg.freeRows + mg.sameRoundRows).toLocaleString('en-US'));
  if (ac.skipped) L.kv('skippedRows', ac.skipped.toLocaleString('en-US'));
  if (a.sigmaSource !== 'declared') L.note('ciObservedNote');
  L.note('confidenceNote');
}

// Distribution tests of the play log (core/audit-stats.js).
function distSection(L, dt) {
  const r = dt.result, f = r.fit;
  const ref = r.candidates[r.refIndex];
  const both = (key) => pair(key).join(' / ');
  const x = (v) => num(v, 4) + '×';
  const rounds = (v) => (v === null || v === undefined ? '—' : !Number.isFinite(v) ? '∞' : Math.ceil(v).toLocaleString('en-US'));
  L.section('distTitle');
  L.kv('roundsChecked', r.rounds.toLocaleString('en-US') + (r.mode ? `  (${r.mode})` : ''));
  const [la, le] = pair('distLoaded');
  r.candidates.forEach((c, i) => L.kv(null, `${i === r.refIndex ? '★ ' : ''}${c.label}` + (c.scope === 'round' ? `  (RTP ${pct(c.mean, 3)})` : ''), { labels: [`${la}: ${i + 1}`, `${le}: ${i + 1}`] }));
  // Probabilities or weights that were divided by their total.
  const normalized = r.candidates.filter((c) => c.normalizedFrom !== null && c.normalizedFrom !== undefined);
  if (normalized.length) {
    const list = normalized.map((c) => `${c.label} (${num(c.normalizedFrom, 8)})`).join(', ');
    L.note(null, pair('distNormalized').map((s) => `${s}: ${list}`));
  }
  L.kv('distScope', both(ref.scope === 'round' ? 'distScopeRound' : 'distScopeBase'));
  L.kv('seed', `"${r.seed}"`, { mono: true });
  const color = { consistent: C.pass, mismatch: C.fail, impossible: C.fail, insufficient: C.warn }[f.verdict];
  L.badge('distB_' + f.verdict, color);
  L.note('distV_' + f.verdict);
  L.note({ consistent: 'distPassNote', mismatch: 'distMismatchNote', impossible: 'distImpossibleNote', insufficient: 'distNeedTrigger' }[f.verdict]);
  if (f.unavailable && f.verdict !== 'insufficient') L.note('distNeedTrigger');
  if (r.mixedModes) L.note('distMixedModes');
  if (f.offSupport && f.offSupport.count) L.kv('distOff', `${f.offSupport.count.toLocaleString('en-US')}: ` + f.offSupport.examples.map((e) => `#${e.round} ${x(e.x)}`).join(', '));
  const inFamily = (id, index) => f.tests.find((t) => t.id === id && (index === undefined || t.index === index));
  const status = (t, out = 'distTooRareShort') => (!t ? { text: both(out), color: C.muted } : t.rejected ? { text: both('distReject'), color: C.fail, bold: true } : { text: both('distKeep'), color: C.pass, bold: true });
  const rows = [];
  const g = f.gof;
  if (g && g.applicable) rows.push([both('distGof'), `G ${num(g.G, 2)}, df ${g.df}, P ${fmtP(g.pValue)}`, status(inFamily('gof'), 'distGofOut')]);
  if (f.hit) rows.push([both('distHit'), `${pct(f.hit.rate, 3)} / ${pct(f.hit.expected, 3)}, P ${fmtP(f.hit.pValue)}`, status(inFamily('hit'))]);
  if (f.trigger) rows.push([both('distTrigger'), `${pct(f.trigger.rate, 4)} / ${pct(f.trigger.expected, 4)}, P ${fmtP(f.trigger.pValue)}`, status(inFamily('trigger'))]);
  (f.tails || []).forEach((t, i) => rows.push([`P(X ≥ ${x(t.threshold)})`, `${t.observed} / ${num(t.expected, 2)}, P ${fmtP(t.pValue)}`, status(inFamily('tail', i))]));
  if (rows.length) {
    L.table([{ key: 'test', w: 0.36 }, { labels: ['المرصود / المتوقع، قيمة P', 'Observed / expected, P'], w: 0.4, mono: true }, { key: 'result', w: 0.24 }], rows);
    if (f.tails && f.tails.length) L.note('distTailNote');
  }
  if (g && g.applicable) {
    L.kv('distMcP', `G ${fmtP(g.pValue)}  ·  χ² ${fmtP(g.pValueX2)}  (${g.replicates.toLocaleString('en-US')} MC)`);
    L.kv('distBinsDf', `${g.bins.length} / ${g.df}`);
    if (!g.inFamily) L.note('distGofFloorNote');
    // Every minimum detectable effect is at Holm's strictest level, alpha / m.
    const [lva, lve] = pair('distMdeLevel');
    const m = g.mde;
    if (m) {
      const b = g.bins[m.bin];
      const zero = b && b.lo === 0 && b.hi === 0 && !b.triggered;
      const share = m.relativeChange === null ? '' : `±${pct(m.relativeChange, 2)}`;
      L.kv('distMde', `w = ${num(m.w, 4)}` + (share ? `  (${share})` : '') + `   α/m = ${fmtP(m.alpha)}`);
      const [sa, se] = share ? pair(zero ? 'distNoWinShare' : 'distLargestBin') : ['', ''];
      L.note(null, [
        `${pair('distMde')[0]}` + (share ? `: ${share} ${pair('distMdeBin')[0]} ${sa}` : '') + `، ${lva}.`,
        `${pair('distMde')[1]}` + (share ? `: ${share} ${pair('distMdeBin')[1]} ${se}` : '') + `, ${lve}.`,
      ]);
    }
  }
  if (f.hit) L.kv('distHit', `${pct(f.hit.rate, 3)}  [${pct(f.hit.ci[0], 3)} – ${pct(f.hit.ci[1], 3)}]  ${(f.hit.confidence * 100).toFixed(1)}%`);
  if (f.trigger) L.kv('distTrigger', `${pct(f.trigger.rate, 4)}  [${pct(f.trigger.ci[0], 4)} – ${pct(f.trigger.ci[1], 4)}]`);
  if (f.hit) {
    const [ra, re] = pair('distMdeRate'), [ha, he] = pair('distHit'), [ta, te] = pair('distTrigger'), [va, ve] = pair('distMdeLevel');
    const hit = pct(f.hit.mde.absolute, 3), trig = f.trigger ? pct(f.trigger.mde.absolute, 4) : null, level = fmtP(f.hit.mde.alpha);
    L.note(null, [
      `${ra}: ${ha} ${hit}` + (trig ? `، ${ta} ${trig}` : '') + ` (${va}: ${level}).`,
      `${re}: ${he.toLowerCase()} ${hit}` + (trig ? `, ${te.toLowerCase()} ${trig}` : '') + ` (${ve}: ${level}).`,
    ]);
  }
  if (f.topPrize) {
    const tp = f.topPrize;
    L.kv('distTop', `${x(tp.x)}  (1 / ${num(tp.oneIn, 0)})`);
    if (tp.paidSpinOnly) L.note('distTopBase');
    L.kv('distTopExpected', num(tp.expected, 3));
    L.kv('distTopSeen', tp.observed.toLocaleString('en-US'));
    L.kv('distTopNever', pct(tp.pNeverSeen, 2));
    if (tp.ruleOfThree !== null) L.kv('distRuleOfThree', tp.ruleOfThree.toExponential(3));
    if (tp.rtpShare !== null) L.kv('distTopShare', pct(tp.rtpShare, 2));
    L.kv('distTopFor95', rounds(tp.roundsFor95));
  }
  if (f.total) {
    const tt = f.total;
    const est = tt.count === 0 ? `< ${fmtP(1 / tt.replicates)}` : tt.count === tt.replicates ? `> ${fmtP(1 - 1 / tt.replicates)}` : `≈ ${fmtP(tt.estimate)} ± ${fmtP(tt.se)}`;
    L.kv('distTotalShort', `${est}   (${num(tt.sum, 2)} / ${num(tt.expected, 2)})`);
    const draws = pair('distDraws');
    L.note(null, pair('distTotalNote').map((s, i) => `${s} (${draws[i]}: ${tt.replicates.toLocaleString('en-US')}).`));
  }
  if (f.unseen) L.kv('distUnseenShort', `${pct(f.unseen.rtpAbove, 3)}  (max ${x(f.unseen.maxObserved)})`);

  const v = r.versions;
  if (v) {
    L.section('distVersions');
    if (v.error) L.note(null, [v.error.ar, v.error.en]);
    else {
      L.table([{ key: 'distVersion', w: 0.26 }, { key: 'distPmfRtp', w: 0.16, mono: true }, { key: 'distLogLik', w: 0.2, mono: true }, { key: 'distPosterior', w: 0.16, mono: true }, { key: 'distAsn', w: 0.22, mono: true }],
        v.models.map((m, i) => [(i === v.refIndex ? '★ ' : '') + m.label, r.candidates[i].scope === 'round' ? pct(r.candidates[i].mean, 3) : '—', Number.isFinite(m.logLik) ? num(m.logLik, 2) : '−∞', pct(m.posterior, 2), rounds(m.asn)]));
      const s = v.sequential;
      if (s.decision === null) L.badge('distSprtPending', C.warn);
      else {
        L.kv('distSprtDecided', v.models[s.decision].label, { color: s.decision === v.refIndex ? C.pass : C.fail });
        L.kv('distAtRound', s.at.toLocaleString('en-US'));
      }
      L.table([{ key: 'distVersion', w: 0.22 }, { labels: ['تباعد KL', 'KL divergence'], w: 0.4, mono: true }, { labels: ['جولات SPRT المتوقعة', 'Expected SPRT rounds'], w: 0.38, mono: true }],
        v.pairs.map((p) => [p.label, `${p.klRefAlt.toExponential(3)} / ${p.klAltRef.toExponential(3)}`, `${rounds(p.asnRef)} / ${rounds(p.asnAlt)}`]));
      L.note('distKl');
      L.note('distPairAsn');
      const wald = v.pairs.length === 1 && v.pairs[0].sprt;
      if (wald) L.kv('distWald', wald.decision === 'continue' ? '—' : `${both(wald.decision === 'reference' ? 'distWaldRef' : 'distWaldAlt')} (${wald.at.toLocaleString('en-US')})`);
      if (v.unmatched) L.kv('distUnmatched', v.unmatched.toLocaleString('en-US'));
      L.note('distSprtNote');
    }
  }

  const b = r.betting;
  L.section('distSecBetting');
  if (b.needs) L.note(b.needs === 'maxWin' ? 'distNeedsMax' : 'distNeedsDeclared');
  else if (b.error) L.note(null, [b.error.ar, b.error.en]);
  else {
    L.kv(b.mu0Source === 'reference' ? 'distRefRtp' : 'declaredRtp', pct(b.mu0, 3));
    L.kv(null, `${x(b.M)}   (${both('distSrc_' + b.maxWinSource)})`, { labels: ['M', 'M'] });
    L.kv('distEValue', num(b.eValue, 4));
    L.kv('distMaxE', `${num(b.maxEValue, 4)}   (1/α = ${num(1 / b.alpha, 0)})`);
    L.kv('distAnytimeP', fmtP(b.pValue));
    L.kv('distUpper', (b.upperBound === null ? `> ${pct(b.gridTop, 0)}` : (b.belowGrid ? '≤ ' : '') + pct(b.upperBound, 1)) + `   (${((1 - b.alpha) * 100).toFixed(1)}%)`);
    if (b.crossedAt) L.kv('distCrossed', b.crossedAt.toLocaleString('en-US'));
    L.badge(b.rejected ? 'distBetBadgeReject' : 'distBetBadgeKeep', b.rejected ? C.fail : C.pass);
    L.note(b.rejected ? 'distBetReject' : 'distBetKeep');
  }
  if (b.declaredDiffers) L.note(null, pair('distDeclaredDiffers').map((s) => `${s}: ${pct(b.declaredDiffers, 3)} ≠ ${pct(b.mu0, 3)}`));
  L.note('distBetNote');

  const pl = r.planner;
  L.section('distPlanner');
  L.kv('distGap', num(pl.gap * 100, 2));
  if (pl.sigma) L.kv(null, `${num(pl.sigma, 3)}   (${both('distSrc_' + pl.sigmaSource)})`, { labels: ['σ', 'σ'] });
  const short = (id) => { const [a, e] = pair('planShort_' + id); return a === e ? a : `${a} / ${e}`; };
  L.table([{ key: 'distPlanMethod', w: 0.5 }, { key: 'distVersion', w: 0.2 }, { key: 'distPlanRounds', w: 0.3, mono: true }],
    pl.rows.map((p) => [short(p.id), p.version || '—', (p.approx && p.rounds !== null ? '≈ ' : '') + rounds(p.rounds)]));
  const w = 1 / (2 + pl.maxWins.length);
  L.table([{ labels: ['σ', 'σ'], w }, { key: 'distPlanMean', w, mono: true }, ...pl.maxWins.map((m) => ({ labels: [`M = ${m}×\u200e`, `M = ${m}×`], w, mono: true }))],
    pl.grid.map((gr) => [num(gr.sigma, 3), rounds(gr.meanTest), ...gr.eProcess.map((e) => rounds(e.rounds))]));
  L.note('distPlanNote');
}

const STATUS_COLOR = { pass: C.pass, flag: C.warn, fail: C.fail };
const statusOf = (r) => r.status || (r.pass ? 'pass' : 'fail');
const statusCell = (status) => ({ text: pair(status).join(' / '), color: STATUS_COLOR[status] || C.fail, bold: true });

function rngSection(L, rg) {
  L.section('tabRng');
  L.kv('rngMode', rg.parsed.kind);
  L.kv('bitsCount', rg.parsed.nBits.toLocaleString('en-US'));
  L.kv('valuesCount', rg.parsed.nValues.toLocaleString('en-US'));
  if (rg.nist.twoLevel) L.kv('twoLevel', `${rg.nist.sequences} × ${rg.nist.sequenceLength.toLocaleString('en-US')}`);
  for (const n of rg.parsed.notes || []) L.note(null, [n, n]);
  const fam = rg.family;
  if (fam) {
    L.kv('familyDetail', `${fam.belowAlpha} / ${fam.pValueCount}  (${pair('familyExpected').join(' / ')} ≈ ${num(fam.expectedBelowAlpha, 1)})`);
    L.badge(fam.pass ? 'familyPassShort' : 'familyFailShort', fam.pass ? C.pass : C.fail);
    L.note(fam.pass ? 'familyPass' : 'familyFail');
  }
  const rows = rg.nist.results.map((r) => {
    const [ar, en] = NIST_NAMES[r.id];
    if (!r.applicable) return [`${ar} / ${en}`, r.reason || r.requirement, { text: pair('na').join(' / '), color: C.muted }];
    let shown;
    if (rg.nist.twoLevel) {
      shown = `${r.sequences} seq, min ${(r.minProportion * 100).toFixed(1)}%` + (r.minUniformityP === null ? '' : `, P_T ${fmtP(r.minUniformityP)}`)
        + (r.subtestCount > 1 ? `, ${r.subtestsFailing}/${r.subtestCount} out (~${num(r.subtestsExpectedFailing, 1)})` : '');
    } else {
      const ps = r.pValues;
      shown = ps.length === 1 ? fmtP(ps[0]) : `min ${fmtP(Math.min(...ps))} (${ps.filter((p) => p < 0.01).length}/${ps.length} < 0.01)`;
    }
    return [`${ar} / ${en}`, shown, statusCell(statusOf(r))];
  });
  rows.push([pair('chiSquare').join(' / '), `χ² = ${num(rg.chi.chi2, 2)}, df ${rg.chi.df}, P ${fmtP(rg.chi.pValue)}`, statusCell(rg.chi.status || (rg.chi.pass ? 'pass' : 'fail'))]);
  rows.push([pair('serialCorr').join(' / '), rg.serial.r === null ? '—' : `r = ${num(rg.serial.r, 6)}, P ${fmtP(rg.serial.pValue)}`, statusCell(rg.serial.status || (rg.serial.pass ? 'pass' : 'fail'))]);
  L.table([{ key: 'test', w: 0.46 }, { key: 'pValue', w: 0.34, mono: true }, { key: 'result', w: 0.2 }], rows);
  L.note('nistPassRule');
  if (rg.nist.twoLevel) L.note('twoLevelRule');
}

function fairSection(L, fr) {
  if (fr.mode === 'adapter') { pfSection(L, fr); return; }
  const f = fr.result;
  L.section('tabFair');
  L.kv('fairScheme', fr.scheme === 'chain' ? pair('schemeChain').join(' / ') : pair('schemeHmac').join(' / '));
  if (fr.scheme === 'chain') {
    L.kv('chainLinks', f.links.toLocaleString('en-US'));
    L.kv('chainBreaks', f.breaks.length.toLocaleString('en-US'), { color: f.breaks.length ? C.fail : C.pass });
    L.badge(f.ok ? 'allVerified' : 'someFailed', f.ok ? C.pass : C.fail);
    if (f.breaks.length) L.table([{ key: 'line', w: 0.2 }, { key: 'expected', w: 0.8, mono: true }], f.breaks.slice(0, 20).map((b) => [b.index, b.expected]));
    return;
  }
  L.kv('template', fr.options.template, { mono: true });
  L.kv('keyFrom', fr.options.keyFrom === 'client' ? pair('keyClient').join(' / ') : pair('keyServer').join(' / '));
  L.kv('outcomeType', fr.options.outcomeType + (fr.options.outcomeType === 'int' ? ` (N=${fr.options.range}, +${fr.options.offset})` : ''));
  L.note('fairFormula');
  L.kv('roundsChecked', f.rows.toLocaleString('en-US'));
  L.kv('commitments', `${(f.commitmentsChecked - f.commitmentFailures.length).toLocaleString('en-US')} / ${f.commitmentsChecked.toLocaleString('en-US')}`, { color: f.commitmentFailures.length ? C.fail : C.pass });
  L.kv('results', `${(f.resultsChecked - f.mismatches.length).toLocaleString('en-US')} / ${f.resultsChecked.toLocaleString('en-US')}`, { color: f.mismatches.length ? C.fail : C.pass });
  if (f.uniformity) L.kv('uniformity', `χ² ${num(f.uniformity.chi2, 2)}, P ${fmtP(f.uniformity.pValue)}`);
  L.badge(f.ok ? 'allVerified' : 'someFailed', f.ok ? C.pass : C.fail);
  const bad = [...f.commitmentFailures.map((m) => [m.line, 'SHA-256', m.claimed]), ...f.mismatches.map((m) => [m.line, String(m.expected), m.claimed])].slice(0, 25);
  if (bad.length) L.table([{ key: 'line', w: 0.15 }, { key: 'expected', w: 0.45, mono: true }, { key: 'claimed', w: 0.4, mono: true }], bad);
}

// ---- Provably fair v2 (adapter audit) ----
function pfPayload(fr) {
  const r = fr.result, a = fr.adapter;
  return {
    input: fr.inputId, mode: 'adapter',
    adapter: { key: a.key, id: a.id, version: a.version, evidence: a.evidence, sourceUrl: a.sourceUrl, captureDate: a.captureDate, selfTest: a.selfTest ? { ok: a.selfTest.ok, passed: a.selfTest.passed, total: a.selfTest.total } : null },
    options: { ...fr.options, paytable: fr.options.paytable || null },
    verdict: r.verdict, rows: r.rows, counts: r.counts, payout: r.payout,
    epochs: r.epochs.slice(0, 100), listed: r.listed || null, chain: r.chain, uniformity: r.uniformity, games: r.games || {},
    issueCounts: r.issueCounts, issues: r.issues.slice(0, 100),
    // per-row verdicts: mismatches first, then rounds not checked (with the reason)
    problemRows: (r.problemRows || []).slice(0, 200),
  };
}

// Short text for an issue's detail (nonce range, P-value, link count...) in `lang`.
export function pfIssueDetail(i, lang = 'en') {
  const d = i.detail || {};
  const tx = (k, v) => pair(k)[lang === 'en' ? 1 : 0].replace('{0}', v);
  if (d.from !== undefined) return tx('pfD_nonce', `${d.from}${d.to !== d.from ? '–' + d.to : ''}`);
  if (d.nonce !== undefined) return tx('pfD_nonce', d.nonce);
  if (d.pValue !== undefined) return 'P = ' + fmtP(d.pValue);
  if (d.links !== undefined && d.links !== null) return tx('pfD_links', num(d.links, 0));
  if (d.missing !== undefined) return tx('pfD_missing', d.missing);
  if (d.rows !== undefined) return tx('pfD_rows', d.rows);
  if (d.first !== undefined) return tx('pfD_first', d.first);
  if (d.edge) return tx('pfEdge_' + d.edge);
  if (d.era) return tx('pfEra_' + d.era);
  if (d.formula) return tx('pfLimboShort_' + d.formula);
  if (d.message) return typeof d.message === 'object' ? d.message[lang === 'en' ? 'en' : 'ar'] : String(d.message);
  if (d.gap !== undefined) return tx('pfD_gap', d.gap);
  if (d.clients !== undefined) return tx('pfD_clients', d.clients);
  if (d.length !== undefined) return tx('pfD_length', d.length);
  if (d.fromGame !== undefined) return tx('pfD_game', `${d.fromGame} → ${d.toGame}`);
  if (d.gameId !== undefined) return tx('pfD_game', d.gameId);
  if (d.hash) return d.hash.slice(0, 12) + '…';
  return i.epoch ? i.epoch.slice(0, 12) + '…' : '';
}

const PF_COLOR = { PASS: C.pass, CONDITIONAL: C.warn, FAIL: C.fail, INCONCLUSIVE: C.warn, NOTHING_CHECKED: C.warn };
const SEV_COLOR = { fail: C.fail, warn: C.warn, info: C.muted };
function pfSection(L, fr) {
  const r = fr.result, a = fr.adapter, v = r.verdict;
  const both = (k) => pair(k).join(' / ');
  const n = (x) => x.toLocaleString('en-US');
  L.section('tabFair');
  L.kv('pfAdapter', `${a.name[1]} · ${a.id}@${a.version}`);
  L.kv('pfEvidence', both('pfEv_' + a.evidence), { color: a.evidence === 'verified' ? C.pass : a.evidence === 'unconfirmed' ? C.warn : C.accent });
  L.kv('pfSource', a.sourceUrl, { mono: true });
  L.kv('pfCaptureDate', a.captureDate);
  if (a.selfTest) L.kv('pfSelfTest', `${a.selfTest.passed} / ${a.selfTest.total}`, { color: a.selfTest.ok ? C.pass : C.fail });
  // the games the audit actually covered (rows per game), not only the default one
  const played = Object.entries(r.games || {});
  const formulaOf = (g) => (a.games && a.games[g] && a.games[g].formula ? a.games[g].formula : null);
  if (played.length > 1) {
    L.kv('pfGame', played.map(([g, c]) => `${g}: ${n(c)}`).join(' · '));
    const lines = played.filter(([g]) => formulaOf(g)).map(([g]) => `${g} — ${formulaOf(g)}`);
    if (lines.length) L.note(null, [lines.join(' ؛ '), lines.join('; ')]);
  } else {
    const g = played.length ? played[0][0] : r.options.game;
    if (g) L.kv('pfGame', g + (formulaOf(g) ? ' — ' + formulaOf(g) : ''));
  }
  if (a.games && a.games.limbo && (!played.length || r.games.limbo)) L.kv('pfLimbo', r.options.limboFormula === 'docs' ? 'docs: 1e8 / (f × 1e8) × 0.99' : 'calculator: 2^24 / (floor(f × 2^24) + 1) × 0.99');
  L.note('pfEvNote_' + a.evidence);
  L.note(null, a.notes);
  L.kv('roundsChecked', n(r.rows));
  L.kv('pfMatched', `${n(r.counts.ok)} / ${n(r.counts.ok + r.counts.mismatch)}`, { color: r.counts.mismatch ? C.fail : C.pass });
  if (r.counts.notChecked) L.kv('pfNotChecked', n(r.counts.notChecked));
  if (r.counts.computed) L.kv('pfComputedOnly', n(r.counts.computed));
  if (r.epochs.length) L.kv('pfEpochs', `${r.epochs.filter((e) => e.commitment === 'ok').length} / ${r.epochs.length}`);
  if (r.payout.checked) L.kv('pfPayouts', `${n(r.payout.ok)} / ${n(r.payout.checked)}`, { color: r.payout.mismatch ? C.fail : C.pass });
  if (r.chain) {
    L.kv('pfChainLinks', n(r.chain.linksChecked));
    L.kv('pfChainBreaks', String(r.chain.breaks), { color: r.chain.breaks ? C.fail : C.pass });
    L.kv('pfLinksWalked', n(r.chain.linksWalked));
    const term = r.chain.terminating;
    if (term) {
      L.kv('pfTerminatingRes', (term.status === 'ok' ? '✓' : '✗') + (term.links !== null && term.links !== undefined ? ` · ${n(term.links)}` : ''), { color: term.status === 'ok' ? C.pass : C.fail });
      L.note(term.status === 'ok' ? 'pfTerm_ok' : term.status === 'mismatch' ? 'pfTerm_mismatch' : term.status === 'no-target' ? 'pfTerm_noTarget' : 'pfTerm_notReached');
    }
  }
  L.kv('pfVerdictCode', String(v.exit));
  L.badge('pfVS_' + v.code, PF_COLOR[v.code]);
  L.note('pfV_' + v.code);
  L.note('pfVerdictNote');
  const issues = r.issues.slice().sort((x, y) => ({ fail: 0, warn: 1, info: 2 }[x.severity] - { fail: 0, warn: 1, info: 2 }[y.severity])).slice(0, 25);
  if (issues.length) {
    L.section('pfIssuesTable');
    L.table([{ key: 'pfSeverity', w: 0.15 }, { key: 'pfDescription', w: 0.3, mono: true }, { key: 'line', w: 0.12, mono: true }, { key: 'expected', w: 0.13, mono: true }, { key: 'claimed', w: 0.13, mono: true }, { labels: ['التفاصيل', 'Detail'], w: 0.17, mono: true }],
      issues.map((i) => [{ text: both('pfSev_' + i.severity), color: SEV_COLOR[i.severity], bold: i.severity === 'fail' }, i.code, i.line ?? (i.lines ? i.lines.slice(0, 3).join(' · ') : ''), i.expected ?? '', i.claimed ?? '', pfIssueDetail(i)]));
    for (const code of [...new Set(issues.map((i) => i.code))]) {
      const [ar, en] = pair('pfI_' + code);
      L.note(null, [`${ar} (${code})`, `${code}: ${en}`]);
    }
  }
  const rows = r.problemRows || [];
  if (rows.length) {
    L.section('pfRowsTable');
    L.table([{ key: 'line', w: 0.1, mono: true }, { key: 'pfGame', w: 0.14, mono: true }, { key: 'pfRowStatus', w: 0.36 }, { key: 'expected', w: 0.2, mono: true }, { key: 'claimed', w: 0.2, mono: true }],
      rows.slice(0, 25).map((p) => [p.line, p.game || '—', p.status === 'mismatch' ? { text: both('pfRow_mismatch'), color: C.fail, bold: true } : { text: both('pfR_' + p.reason), color: C.muted }, p.computed ?? '—', p.claimed ?? '']));
    if (rows.length > 25) L.note(null, [`${pair('pfRowsShown')[0]}: 25 / ${n(r.counts.mismatch + r.counts.notChecked)}`, `${pair('pfRowsShown')[1]}: 25 / ${n(r.counts.mismatch + r.counts.notChecked)}`]);
  }
  if (r.epochs.length) {
    L.section('pfEpochTable');
    L.table([{ key: 'pfCommitment', w: 0.22 }, { labels: ['SHA-256', 'SHA-256'], w: 0.24, mono: true }, { key: 'roundsChecked', w: 0.1, mono: true }, { key: 'pfNonces', w: 0.16, mono: true }, { key: 'pfForward', w: 0.28 }],
      r.epochs.slice(0, 20).map((e) => [both('pfCm_' + e.commitment), e.hash.slice(0, 20) + '…', e.rows, e.nonceMin === null ? '—' : `${e.nonceMin}–${e.nonceMax}`, e.forward ? both('pfFw_' + e.forward) : '—']));
    L.note('pfCommitmentNote');
    if (r.listed === 'newest-first') L.note('pfListedNewest');
  }
  if (r.uniformity.length) {
    L.section('pfUniformity');
    L.table([{ key: 'pfGame', w: 0.25 }, { key: 'roundsChecked', w: 0.2, mono: true }, { labels: ['χ² / df', 'χ² / df'], w: 0.2, mono: true }, { key: 'pValue', w: 0.15, mono: true }, { key: 'result', w: 0.2 }],
      r.uniformity.map((u) => [u.game + (u.group.rows ? ` (${u.group.rows})` : ''), n(u.n), u.chi2 === null ? '—' : `${num(u.chi2, 2)} / ${u.df}`, fmtP(u.pValue),
        u.status === 'na' ? { text: both('pfInsufficient'), color: C.muted } : u.status === 'pass' ? { text: both('pfNotRejected'), color: C.pass } : statusCell(u.status)]));
    L.note('pfUniformityNote');
  }
}

function mcSection(L, mc) {
  const s = mc.result;
  L.section('tabMc');
  L.kv('modelHash', mc.modelSha256, { mono: true });
  L.kv('seed', mc.seed, { mono: true });
  L.kv('prng', mc.generator, { mono: true });
  L.kv('spins', mc.spins.toLocaleString('en-US'));
  L.kv(s.scope === 'firstDrop' ? 'simRtpFirstDrop' : 'simRtp', pct(s.rtp, 4), { color: C.accent });
  if (mc.controlVariate) {
    const cv = mc.controlVariate;
    L.kv(s.scope === 'firstDrop' ? 'cvRtpFirstDrop' : 'cvRtp', `${pct(cv.rtp, 4)}  (95%: ${pct(cv.ci95[0], 3)} – ${pct(cv.ci95[1], 3)})`);
    L.note('cvNote');
  }
  L.kv('ci', `95%:  ${pct(s.ci95[0], 3)} – ${pct(s.ci95[1], 3)}`);
  L.kv('hitFrequency', pct(s.hitFrequency, 4));
  L.kv('sd', num(s.sd, 4));
  L.kv('maxWinBase', num(s.maxWin, 2) + '×');
  L.kv('triggers', s.triggers.toLocaleString('en-US'));
  if (mc.exactRtp !== null && mc.exactRtp !== undefined) {
    const z = (s.rtp - mc.exactRtp) / s.standardError;
    L.kv('vsExact', `${pct(mc.exactRtp, 4)}  (z = ${num(z, 2)})`);
  }
  L.kv('resultDigest', mc.resultSha256, { mono: true });
  L.note('reproduce');
}

// ---- Outcome tables (LUT, P0-7) ----
const lutPct = (v) => (v === 0 ? '0%' : v < 1e-5 ? (v * 100).toExponential(2) + '%' : pct(v, 4));
const lutOneIn = (n) => (n === null || n === undefined ? '—' : '1 / ' + num(n, n < 100 ? 2 : 0));
const lutBig = (s) => (/^\d+$/.test(String(s)) ? BigInt(s).toLocaleString('en-US') : String(s));
function lutValue(unit, v) {
  if (typeof v === 'string') return lutBig(v);
  if (unit === 'rtp') return pct(v, 4);
  if (unit === 'p') return lutPct(v);
  if (unit === 'x' || unit === 'xc') return num(v, 4) + '×';
  return num(v, 4);
}

// A small heading above a table (Arabic right, English left), kept with the table.
function lutSub(L, key) {
  const [ar, en] = pair(key);
  L.ensure(160);
  L.y += 10;
  L.draw(ar, W - M, L.y, { size: 24, weight: '700', align: 'right', dir: 'rtl' });
  L.draw(en, M, L.y, { size: 21, weight: '600', color: C.muted });
  L.y += 46;
}

function lutSection(L, lu) {
  const x = lu.result;
  L.section('tabLut');
  L.badge('lutNotPfShort', C.warn);
  L.note('lutNotPf');
  L.table([{ key: 'lutMode', w: 0.16 }, { key: 'lutCostShort', w: 0.12 }, { key: 'rtp', w: 0.18, mono: true }, { key: 'lutHitShort', w: 0.16, mono: true }, { key: 'lutSdShort', w: 0.14, mono: true }, { key: 'lutMaxShort', w: 0.24, mono: true }],
    x.modes.map((m) => [m.name, m.cost.text + '×', m.rtp.percent + '%', pct(m.hitRate.value, 4), num(m.sd, 4), `${num(m.maxWin.multiplier.value, 2)}× (${lutOneIn(m.maxWin.oneIn)})`]));
  L.note('lutCostNote');
  for (const m of x.modes) {
    L.y += 16;
    L.kv('lutMode', `${m.name}  ·  ${m.cost.text}×  ·  ${m.weightsFile}`, { color: C.accent });
    L.kv('rtp', m.rtp.percent + '%', { color: C.accent });
    L.kv('exactFraction', m.rtp.fraction, { mono: true });
    L.kv('lutTotalWeight', lutBig(m.totalWeight), { mono: true });
    L.kv('lutHit', `${pct(m.hitRate.value, 4)}  (${lutOneIn(m.hitRate.oneIn)})`);
    L.kv('lutLdw', pct(m.ldw.value, 4) + (m.ldwShareOfWins ? `  (${pair('lutLdwShare')[1]}: ${pct(m.ldwShareOfWins.value, 2)})` : ''));
    L.kv('lutBelowCost', pct(m.belowCost.value, 4));
    L.kv('lutSd', num(m.sd, 4));
    L.kv('lutMaxWin', `${num(m.maxWin.multiplier.value, 2)}×  (${lutOneIn(m.maxWin.oneIn)})`);
    L.kv('lutCvar', `${num(m.cvar999.absolute.value, 2)}×  (÷ cost: ${num(m.cvar999.relative.value, 2)})`);
    L.kv('lutMea_rtp40', pct(m.tail.rtpFrom40xCost.value, 4) + (m.tail.shareFrom40xCost ? `  (${pair('lutShare')[1]}: ${pct(m.tail.shareFrom40xCost.value, 2)})` : ''));
    L.kv('lutMea_rtp10k', pct(m.tail.rtpFrom10kx.value, 4) + (m.tail.shareFrom10kx ? `  (${pair('lutShare')[1]}: ${pct(m.tail.shareFrom10kx.value, 2)})` : ''));
    lutSub(L, 'lutBigWins');
    L.table([{ key: 'lutWinAtLeast', w: 0.34 }, { key: 'probability', w: 0.33, mono: true }, { labels: ['1 من N', '1 in N'], w: 0.33, mono: true }],
      m.bigWins.map((b) => [b.threshold.toLocaleString('en-US') + '×', lutPct(b.probability.value), lutOneIn(b.oneIn)]));
    // Buckets are in multiples of the mode's cost, unlike the base-bet tables above.
    lutSub(L, 'lutBuckets');
    L.table([{ key: 'lutRangeCost', w: 0.34 }, { key: 'probability', w: 0.33, mono: true }, { key: 'lutContribution', w: 0.33, mono: true }],
      m.buckets.map((b) => [b.to === 0 ? '0' : b.to === null ? `≥ ${b.from}` : `${b.from} – ${b.to}`, lutPct(b.probability.value), pct(b.rtp.value, 4)]));
  }
  L.note('lutCvarNote');
  L.section('lutTransparency');
  L.table([{ key: 'lutMode', w: 0.16 }, { key: 'lutRows', w: 0.14, mono: true }, { key: 'lutZeroRows', w: 0.18, mono: true }, { key: 'lutEssShort', w: 0.18, mono: true }, { key: 'lutMaxRowShort', w: 0.18, mono: true }, { key: 'lutKlShort', w: 0.16, mono: true }],
    x.modes.map((m) => {
      const tp = m.transparency;
      return [m.name, tp.rows.toLocaleString('en-US'), tp.zeroWeightRows.toLocaleString('en-US'), num(tp.effectiveSize.value, 1), lutPct(tp.maxRowProbability.value), num(tp.klBits, 4)];
    }));
  L.note('lutTransparencyNote');
  if (x.ignored.length) L.kv('lutIgnored', x.ignored.join(', '));
  L.note('lutBooksNote'); // books are never read, whether or not any were selected

  const pr = x.profile;
  L.section('lutStake');
  L.note('lutStakeSource');
  if (pr.submissionIssues) L.badge('lutSubmissionBadShort', C.fail);
  else if (pr.inferredIssues) L.badge('lutInferredBadShort', C.warn);
  else L.badge('lutSubmissionOk', C.pass);
  L.kv('lutRiskPassing', `${pr.riskPassing} / ${pr.riskCategories}`, { color: pr.riskPassing === pr.riskCategories ? C.pass : C.warn });
  L.kv('lutMaxBet', `$${num(pr.maxBaseBet.value, 2)}  (${pair('lutTemplate')[1]} ${pr.maxBaseBet.template})`);
  L.note('lutStakeRiskNote');
  const mode = (m) => (m === null ? pair('lutAllShort').join(' / ') : m);
  const cell = (ok) => statusCell(ok ? 'pass' : 'fail');
  // Arabic and English labels in their own columns: a mixed cell with numbers reorders badly.
  // Submission labels state their own limit ("Cost ≤ 50,000×").
  lutSub(L, 'lutSubmission');
  L.table([{ key: 'lutCheckAr', w: 0.28 }, { key: 'lutCheckEn', w: 0.24 }, { key: 'lutMode', w: 0.1 }, { key: 'lutValue', w: 0.26, mono: true }, { key: 'result', w: 0.12 }],
    pr.submission.map((c) => [pair('lutChk_' + c.id)[0], pair('lutChk_' + c.id)[1], mode(c.mode), c.id === 'rtp' ? `${pct(c.value, 4)} → ${pct(c.rounded, 2)}` : lutValue(c.unit, c.value), cell(c.ok)]));
  lutSub(L, 'lutInferred');
  L.table([{ key: 'lutCheckAr', w: 0.28 }, { key: 'lutCheckEn', w: 0.24 }, { key: 'lutMode', w: 0.1 }, { key: 'lutValue', w: 0.26, mono: true }, { key: 'result', w: 0.12 }],
    pr.inferred.map((c) => [pair('lutChk_' + c.id)[0], pair('lutChk_' + c.id)[1], c.mode, lutValue(c.unit, c.value), statusCell(c.ok ? 'pass' : 'flag')]));
  L.note('lutInferredNote');
  // Risk measures grouped under their category (a category fails if any measure in any mode does).
  const riskRows = [];
  for (const cat of [...new Set(pr.risk.map((c) => c.category))]) {
    const [ar, en] = pair('lutCat_' + cat);
    riskRows.push([{ text: ar, bold: true }, { text: en, bold: true }, '', '', '', pr.failedCategories.includes(cat) ? cell(false) : cell(true)]);
    for (const c of pr.risk.filter((r) => r.category === cat)) {
      riskRows.push([pair('lutMea_' + c.measure)[0], pair('lutMea_' + c.measure)[1], c.mode, lutValue(c.unit, c.value), lutValue(c.unit, c.limit), cell(c.ok)]);
    }
  }
  lutSub(L, 'lutRisk');
  L.table([{ key: 'lutCheckAr', w: 0.26 }, { key: 'lutCheckEn', w: 0.22 }, { key: 'lutMode', w: 0.1 }, { key: 'lutValue', w: 0.16, mono: true }, { key: 'lutLimit', w: 0.14, mono: true }, { key: 'result', w: 0.12 }], riskRows);
  L.note('lutStakeNotCert');
  L.note('lutStakeExactNote');
}

function lutAscii(lines, x) {
  lines.push(`  Outcome tables (Stake Engine LUT format), modes: ${x.modes.length}. A LUT drawn on the server is not provably fair without commit-reveal.`);
  for (const m of x.modes) {
    const f = m.rtp.fraction.length > 60 ? m.rtp.fraction.slice(0, 57) + '...' : m.rtp.fraction;
    lines.push(`    ${m.name} (cost ${m.cost.text}x): RTP ${m.rtp.percent}% = ${f}, hit ${(m.hitRate.value * 100).toFixed(4)}%, SD ${m.sd.toFixed(4)} x cost, top win ${m.maxWin.multiplier.value}x (1 in ${Math.round(m.maxWin.oneIn).toLocaleString('en-US')}), effective size ${m.transparency.effectiveSize.value.toFixed(1)} of ${m.transparency.rows} rows`);
  }
  const pr = x.profile;
  lines.push(`  Stake Engine RGS limits (${pr.profile.source} @${pr.profile.commit.slice(0, 7)}, ${pr.profile.commitDate}): submission issues ${pr.submissionIssues}`
    + (pr.inferredIssues ? ` (plus format notes ${pr.inferredIssues}: the lab's inference, not published checks)` : '')
    + `; risk categories passing ${pr.riskPassing} of ${pr.riskCategories}`
    + (pr.failedCategories.length ? ` (failing: ${pr.failedCategories.join(', ')}; this lowers bet limits, it does not reject the game)` : '')
    + `; max base bet $${pr.maxBaseBet.value}. A recomputation, not a certification. Book files are not read, so their match with the tables is not checked.`);
}

// ---- signed reports: reproducibility manifest page ----
const REFERENCE_USE = {
  'FIPS 180-4': 'refUseHash', 'PDF 1.4': 'refUsePdf', 'RFC 8032': 'refUseSignature', 'FIPS 186-5': 'refUseSignature',
  'RFC 5280': 'refUseSpki', 'NIST SP 800-22 Rev. 1a': 'refUseNist', 'NIST STS 2.1.2': 'refUseSts', 'RFC 2104': 'refUseHmac', 'xoshiro128** 1.1': 'refUseMc',
  'Stake Engine math-sdk': 'refUseLut', 'Stake Engine math-sdk (ways)': 'refUseWays',
};
const DEVIATION_TEXT = {
  'nist-overlapping-exact': 'devOverlapping', 'nist-linear-pi0': 'devLinearPi0', 'nist-cusum-bounds': 'devCusum',
  'nist-family-holm': 'devFamily', 'nist-proportion-bound': 'devProportion',
  'ways-board-sum': 'devWaysBoard', 'ways-wild-reel1': 'devWaysWild',
};

// "25 MiB (26,214,400 bytes)", in Arabic (lang 0) or English (lang 1).
function limitText(bytes, lang) {
  const mib = (bytes / 1048576).toLocaleString('en-US', { maximumFractionDigits: 3 });
  return `${mib} ${pair('mib')[lang]} (${bytes.toLocaleString('en-US')} ${pair('bytes')[lang]})`;
}

function manifestSection(L, m) {
  L.section('manifestTitle');
  L.kv('labVersion', m.lab.version, { mono: true });
  L.kv('attachLimit', limitText(m.attachmentLimitBytes, 1));
  if (m.model) L.kv('modelHash', m.model.sha256, { mono: true });
  if (m.montecarlo) L.kv('seed', m.montecarlo.seed, { mono: true });
  L.section('referencesTitle');
  for (const ref of m.references) L.kv(null, ref.id, { labels: pair(REFERENCE_USE[ref.id] || 'refUseHash') });
  if (m.deviations.length) {
    L.section('deviationsTitle');
    for (const d of m.deviations) L.note(null, DEVIATION_TEXT[d.id] ? pair(DEVIATION_TEXT[d.id]) : [d.text, d.text]);
  }
  L.note('manifestNote');
}

// Pretty JSON, but arrays of plain values stay on one line (reel strips, pay rows).
export function compactJson(v, indent = '') {
  if (Array.isArray(v)) {
    if (v.every((x) => x === null || typeof x !== 'object')) return JSON.stringify(v);
    return '[\n' + v.map((x) => indent + '  ' + compactJson(x, indent + '  ')).join(',\n') + '\n' + indent + ']';
  }
  if (v && typeof v === 'object') {
    return '{\n' + Object.entries(v).map(([k, x]) => indent + '  ' + JSON.stringify(k) + ': ' + compactJson(x, indent + '  ')).join(',\n') + '\n' + indent + '}';
  }
  return JSON.stringify(v);
}

function previewLines(input) {
  const bytes = input.bytes;
  if (input.kind === 'binary') {
    const out = [];
    for (let i = 0; i < Math.min(bytes.length, 256); i += 16) out.push(Array.from(bytes.slice(i, i + 16), (b) => b.toString(16).padStart(2, '0')).join(' '));
    return { lines: out, truncated: bytes.length > 256 };
  }
  let text = new TextDecoder().decode(bytes.length > 200000 ? bytes.slice(0, 200000) : bytes);
  if (input.kind === 'model') { try { text = compactJson(JSON.parse(text)); } catch (e) { /* keep as is */ } }
  const lines = text.split(/\r?\n/);
  const max = input.kind === 'model' ? 140 : 20;
  return { lines: lines.slice(0, max), truncated: lines.length > max || bytes.length > 200000 };
}

function asciiSummary(payload, reportId, digest) {
  const sg = payload.signer;
  const lines = [
    'TARYAM RTP Lab - verification page',
    '',
    'Report ID:      ' + reportId,
    'Created (UTC):  ' + payload.createdAt + (sg ? "  (the signer's own device clock)" : ''),
    'Report SHA-256: ' + digest,
    '                (SHA-256 of the attached file report.json)',
    'Lab version:    ' + payload.manifest.lab.version,
  ];
  if (sg) {
    lines.push(
      'Signature:      ' + ALGORITHM_INFO[sg.alg].label + ' (' + ALGORITHM_INFO[sg.alg].reference + '), attached file report.sig',
      '                (signs report.json, and every other byte of this PDF)',
      'Signer key:     SHA-256 of the public key (SPKI):',
      '                ' + formatFingerprint(sg.keyFingerprint),
      'Key storage:    ' + (sg.keyStorage === 'persistent' ? "kept in the signer's browser (private key not extractable)" : 'this session only (browser storage was unavailable); later reports use another key'),
    );
  }
  lines.push('', 'Inputs:');
  const attachedAs = new Map(payload.manifest.inputs.map((i) => [i.id, i.attachment]));
  payload.inputs.forEach((i, n) => {
    const hashOnly = attachedAs.get(i.id) === null;
    lines.push(`  ${n + 1}. ${i.name} (${i.kind}, ${i.size} bytes)` + (hashOnly ? ` - HASH ONLY: over ${payload.manifest.attachmentLimitBytes} bytes, not attached` : ', attached'));
    lines.push(`     SHA-256 ${i.sha256}`);
  });
  lines.push('', 'Results:');
  const r = payload.results;
  if (r.theoretical) lines.push(`  Theoretical RTP: ${r.theoretical.rtp.percent}% = ${r.theoretical.rtp.fraction.length > 80 ? r.theoretical.rtp.fraction.slice(0, 77) + '...' : r.theoretical.rtp.fraction}`);
  if (r.theoretical && r.theoretical.model.weighted) {
    const m = r.theoretical.model;
    lines.push(`  Weighted reels: base reel sets ${m.reelSets.length}` + (m.freeSpinReelSets ? `, free-spin reel sets ${m.freeSpinReelSets.length}` : '') + `; exact for the weights as entered, not a certification`);
  }
  if (r.theoretical && r.theoretical.model.ways) {
    const w = r.theoretical.model.ways, top = w.base.topReel;
    lines.push(`  Ways evaluation: ${w.base.minWays}-${w.base.maxWays} ways, bet ${w.betCost} coins, top reel ${top ? `over reels ${top.covers.join(', ')} (${top.stops} stops)` : 'none'};`
      + ` multiplier strategy "${w.multiplierStrategy}", wild on reel 1 ${w.wildStartsWin ? 'starts every symbol' : 'starts only symbols shown on reel 1'}`
      + ' (conventions named after StakeEngine/math-sdk ways.py, commit 141b4e8, 2 Nov 2026); exact for the model as entered, not a certification');
  }
  if (r.theoretical && r.theoretical.scope === 'firstDrop') {
    lines.push('  FIRST DROP ONLY: the game cascades and the lab does not compute the drops that follow; this is not the game\'s RTP'
      + (r.theoretical.controlVariate ? `. Exact paid-spin first-drop mean (a control variate): ${r.theoretical.controlVariate.mean.fraction}` : ''));
  }
  if (r.theoretical && r.theoretical.distribution) {
    const d = r.theoretical.distribution;
    lines.push(`  Hit frequency ${d.hitFrequency ? (d.hitFrequency.value * 100).toFixed(4) + '%' : 'not available'}, SD ${d.sd.toFixed(4)} x bet` + (d.closedForm ? ' (closed form; the full distribution and max win were too large to compute)' : ''));
  }
  if (r.actual) lines.push(`  Observed RTP: ${(r.actual.rtp * 100).toFixed(4)}% over ${r.actual.rounds} rounds, ${(r.actual.confidence * 100).toFixed(1)}% CI ${(r.actual.ci[0] * 100).toFixed(3)}% - ${(r.actual.ci[1] * 100).toFixed(3)}%` + (r.actual.declared ? `, declared ${(r.actual.declared.rtp * 100).toFixed(2)}%, p = ${r.actual.declared.pValue.toPrecision(4)} (${r.actual.declared.verdict})` : ''));
  if (r.distTests) {
    const d = r.distTests, f = d.fit, g = f.gof;
    lines.push(`  Distribution tests (reference "${d.distributions[d.refIndex].label}", ${d.rounds} rounds, alpha ${d.alpha}, seed "${d.seed}"): ${f.verdict}`
      + (g && g.applicable ? `; G-test P = ${g.pValue.toPrecision(4)} (Monte Carlo, ${g.replicates} replicates`
        + (g.inFamily ? `), minimum detectable w = ${g.mde.w.toPrecision(3)} at alpha/m = ${g.mde.alpha.toPrecision(3)}` : '; cannot reach alpha/m, kept out of the verdict)') : '')
      + (f.hit ? `; hit ${(f.hit.rate * 100).toFixed(3)}% vs ${(f.hit.expected * 100).toFixed(3)}%` : '')
      + (f.trigger ? `; trigger ${(f.trigger.rate * 100).toFixed(4)}% vs ${(f.trigger.expected * 100).toFixed(4)}%` : '')
      + (f.total ? `; P(total <= observed) ~ ${f.total.estimate.toPrecision(3)} +/- ${f.total.se.toPrecision(2)} (Monte Carlo, ${f.total.replicates} draws)` : ''));
    const v = d.versions;
    if (v && v.models) lines.push(`  Versions: posterior ${v.models.map((m) => `${m.label} ${(m.posterior * 100).toFixed(1)}%`).join(', ')}; SPRT ${v.sequential.decision === null ? 'undecided' : `chose ${v.models[v.sequential.decision].label} at round ${v.sequential.at}`}`);
    const b = d.betting;
    if (b && b.eValue !== undefined) lines.push(`  RTP below ${(b.mu0 * 100).toFixed(2)}% (${b.mu0Source === 'reference' ? 'the reference version' : 'the declared field'})? Betting e-process (M = ${b.M}x, from ${b.maxWinSource}): ${b.rejected ? 'REJECTED' : 'not rejected'}, max e-value ${b.maxEValue.toPrecision(4)}, anytime P = ${b.pValue.toPrecision(4)}`);
    if (b && b.declaredDiffers) lines.push(`  Note: the declared RTP field (${(b.declaredDiffers * 100).toFixed(3)}%) differs from the reference version's RTP (${(b.mu0 * 100).toFixed(3)}%); the e-process tests the latter`);
  }
  if (r.rng) {
    const app = r.rng.nist.filter((t) => t.applicable);
    const fam = r.rng.family;
    lines.push(`  RNG: NIST SP 800-22 passed ${app.filter((t) => (t.status || (t.pass ? 'pass' : 'fail')) === 'pass').length} of ${app.length} applicable tests` + (r.rng.twoLevel ? ` (two-level, ${r.rng.twoLevel.sequences} sequences)` : '') + `; chi-square ${r.rng.chiSquare.status || (r.rng.chiSquare.pass ? 'pass' : 'fail')}; serial correlation ${r.rng.serialCorrelation.status || (r.rng.serialCorrelation.pass ? 'pass' : 'fail')}`);
    if (fam) lines.push(`  Family verdict (Holm over ${fam.pValueCount} P-values, alpha ${fam.alpha}): ${fam.pass ? 'no gross statistical defect detected' : 'statistical defect detected'}; ${fam.belowAlpha} below alpha, ~${fam.expectedBelowAlpha.toFixed(1)} expected by chance`);
  }
  if (r.fair && r.fair.mode === 'adapter') {
    const f = r.fair;
    lines.push(`  Provably fair: adapter ${f.adapter.key} (evidence: ${f.adapter.evidence}; self-test ${f.adapter.selfTest ? f.adapter.selfTest.passed + '/' + f.adapter.selfTest.total : 'n/a'}), verdict ${f.verdict.code} (code ${f.verdict.exit}); ${f.counts.ok} of ${f.counts.ok + f.counts.mismatch} recomputed results match, ${f.counts.notChecked} not checked` + (f.payout.checked ? `; payouts ${f.payout.ok}/${f.payout.checked}` : '') + (f.chain && f.chain.terminating ? `; terminating hash ${f.chain.terminating.status}` : ''));
    const issues = Object.entries(f.issueCounts).filter(([c]) => f.verdict.fails.includes(c) || f.verdict.warns.includes(c));
    if (issues.length) lines.push('  Issues: ' + issues.map(([c, n]) => `${c} x${n}`).join(', '));
    lines.push('  Not a certification: provably fair covers outcome derivation only, not RTP, settlement or paytables.');
  } else if (r.fair) lines.push(`  Provably fair (${r.fair.scheme}): ${r.fair.ok ? 'all rounds verified' : 'FAILURES FOUND'}`);
  if (r.montecarlo) lines.push(`  Monte Carlo: ${r.montecarlo.spins} rounds, seed "${r.montecarlo.seed}", RTP ${(r.montecarlo.result.rtp * 100).toFixed(4)}%` + (r.montecarlo.result.scope === 'firstDrop' ? ' (first drop only)' : '') + `, result SHA-256 ${r.montecarlo.resultSha256}`
    + (r.montecarlo.controlVariate ? `; with the paid spin as a control variate ${(r.montecarlo.controlVariate.rtp * 100).toFixed(4)}% +/- ${(1.959964 * r.montecarlo.controlVariate.standardError * 100).toFixed(4)}%` + (r.montecarlo.result.scope === 'firstDrop' ? ' (first drop only)' : '') : ''));
  if (r.lut) lutAscii(lines, r.lut);
  if (sg) {
    lines.push('', 'How to verify: open the RTP Lab\'s "Verify a report" tab and drop this PDF. It checks report.sig',
      'and recomputes the SHA-256 of every attached file against the list in report.json. Compare the',
      'signer key fingerprint with one the auditor publishes somewhere independent of this file.',
      'A valid signature shows who holds the key, not that the content is correct, and the date is the',
      "signer's own clock. This report is supporting evidence, not a certification.");
  } else {
    lines.push('', 'How to verify: extract the attached files, compute their SHA-256 and compare with the', 'values above. Any change to an input or to report.json changes its fingerprint.', 'The fingerprint detects changes; it is not a digital signature of the issuer.');
  }
  const out = [];
  for (const l of lines) {
    let rest = l;
    const pad = ' '.repeat(Math.min(8, (/^\s*/.exec(l)[0].length || 0) + 4));
    while (rest.length > 100) {
      let cut = rest.lastIndexOf(' ', 100);
      if (cut <= pad.length) cut = 100;
      out.push(rest.slice(0, cut));
      rest = pad + rest.slice(cut).trimStart();
    }
    out.push(rest);
  }
  return out;
}

const SECTION_ORDER = ['theoretical', 'actual', 'distTests', 'rng', 'fair', 'montecarlo', 'lut'];
const RENDER = { theoretical: theorySection, actual: actualSection, distTests: distSection, rng: rngSection, fair: fairSection, montecarlo: mcSection, lut: lutSection };

// session: { meta, inputs: [{ id, name, kind, size, sha256, bytes, mime }], results: {...} }
// signer: a key from core/sign.js (loadSigningKey), or null for an unsigned report.
// Inputs larger than attachLimit are listed by SHA-256 only, not attached.
export async function buildReport(session, { createCanvas, now = new Date(), onProgress = () => {}, signer = null, attachLimit = ATTACH_LIMIT_BYTES } = {}) {
  const createdAt = now.toISOString().replace(/\.\d{3}Z$/, 'Z');
  session = { ...session, inputs: planAttachments(session.inputs, { limit: attachLimit }), signer, attachLimit };
  const payload = reportPayload(session, createdAt);
  const json = canonicalJson(payload);
  const jsonBytes = new TextEncoder().encode(json);
  const digest = await sha256Hex(jsonBytes);
  const reportId = reportIdFor(createdAt, digest);
  const hashOnly = session.inputs.some((i) => i.attachment === null);

  const draw = (L) => {
    L.y += 10;
    if (session.meta.title) { L.draw(session.meta.title, W / 2, L.y + 20, { size: 38, weight: '700', align: 'center', dir: /[\u0600-\u06ff]/.test(session.meta.title) ? 'rtl' : 'ltr' }); L.y += 80; }
    L.kv('reportId', reportId, { mono: true, color: C.accent });
    L.kv('created', createdAt.replace('T', '  ').replace('Z', '  UTC'));
    if (session.meta.auditor) L.kv('auditor', session.meta.auditor);
    if (session.meta.notes) L.note(null, [session.meta.notes, session.meta.notes]);
    L.kv('digest', digest, { mono: true });
    if (signer) {
      L.kv('sigAlg', `${ALGORITHM_INFO[signer.alg].label}  (${ALGORITHM_INFO[signer.alg].reference})`);
      L.kv('keyFingerprint', formatFingerprint(signer.fingerprint), { mono: true });
      L.kv('keyStorage', pair(signer.storage === 'persistent' ? 'signerKeyPersistent' : 'signerKeySession').join(' / '), { color: signer.storage === 'persistent' ? C.text : C.warn });
      if (signer.storage !== 'persistent') L.note('sessionKeyNote');
      L.note('signedReportNote');
      L.note('signatureMeaning');
    }
    L.section('inputsTitle');
    for (const i of session.inputs) {
      L.kv('file', `${i.name}  (${i.size.toLocaleString('en-US')} ${pair('bytes')[1]})`);
      L.kv('modelHash', i.sha256, { mono: true, labels: ['SHA-256', 'SHA-256'] });
      if (i.attachment === null) L.kv('attachedState', pair('hashOnlyShort').join(' / '), { color: C.warn });
    }
    if (hashOnly) L.note(null, pair('hashOnlyNote').map((t, k) => t.replace('{limit}', limitText(attachLimit, k))));
    L.note(hashOnly ? 'verifyHowHashOnly' : 'verifyHow');
    if (!signer) L.note('signatureNote');
    for (const key of SECTION_ORDER) if (session.results[key]) { L.newPage(); RENDER[key](L, session.results[key]); }
    L.newPage();
    manifestSection(L, payload.manifest);
    if (session.inputs.length) {
      L.newPage();
      L.section('appendix');
      for (const i of session.inputs) {
        L.kv('file', i.name);
        L.kv('modelHash', i.sha256, { mono: true, labels: ['SHA-256', 'SHA-256'] });
        const p = previewLines(i);
        L.mono(p.lines);
        if (p.truncated) L.note(i.attachment === null ? 'truncatedHashOnly' : 'truncated');
      }
    }
    L.end();
  };

  // Pass 1 counts pages; pass 2 draws them again with "page x / total" and encodes
  // each one as soon as it is complete, so only one full-size canvas exists.
  const canvas = createCanvas(W, H);
  const counter = new Layout(canvas);
  draw(counter);
  const totalPages = counter.page;
  const jpegs = [], thumbnails = [];
  let done = 0;
  draw(new Layout(canvas, {
    reportId, created: createdAt, totalPages,
    onPage: (c) => {
      const th = createCanvas(248, 351);
      th.getContext('2d').drawImage(c, 0, 0, 248, 351);
      thumbnails.push(th);
      jpegs.push(canvasToJpeg(c).then((bytes) => { onProgress(++done / (totalPages + 1)); return bytes; }));
    },
  }));
  const pageImages = await Promise.all(jpegs);

  const pdf = new PdfBuilder({
    title: (session.meta.title ? session.meta.title + ' — ' : '') + 'تقرير مختبر RTP / RTP Lab Report',
    subject: reportId, keywords: `${reportId} report-sha256:${digest} ` + session.inputs.map((i) => `${i.name}:${i.sha256}`).join(' '),
    author: session.meta.auditor || '', creator: 'TARYAM RTP Lab', creationDate: now, id: digest.slice(0, 32),
  });
  for (const jpeg of pageImages) pdf.addPage({ jpeg, pixelWidth: W, pixelHeight: H });
  const lines = asciiSummary(payload, reportId, digest);
  let y = 800;
  const textPage = [];
  for (const l of lines) {
    if (y < 50) { pdf.addPage({ lines: textPage.splice(0) }); y = 800; }
    textPage.push({ text: l, x: 40, y, size: l.startsWith('TARYAM') ? 13 : 8.5, font: l.startsWith('TARYAM') ? 'F2' : 'F3' });
    y -= l.startsWith('TARYAM') ? 22 : 12.5;
  }
  pdf.addPage({ lines: textPage });
  pdf.attach(REPORT_FILE, jsonBytes, { mime: 'application/json', description: 'Report data covered by the report SHA-256' + (signer ? ' and signed in report.sig' : '') });
  const sigId = signer ? pdf.attach(SIGNATURE_FILE, signaturePlaceholder(), { mime: 'application/json', description: 'Signature of report.json and of this PDF (TARYAM RTP Lab)' }) : null;
  for (const i of session.inputs) if (i.attachment !== null) pdf.attach(i.attachment, i.bytes, { mime: i.mime || 'application/octet-stream', description: 'SHA-256 ' + i.sha256 });
  const bytes = pdf.build();
  if (signer) await sealReportPdf(bytes, pdf.dataOffset(sigId), signer, jsonBytes);
  onProgress(1);
  return {
    bytes, reportId, digest, json, pages: totalPages + 1, thumbnails,
    signature: signer ? { alg: signer.alg, fingerprint: signer.fingerprint, storage: signer.storage } : null,
  };
}

// Bilingual (Arabic / English) PDF report. Pages are laid out on canvases so the
// browser shapes Arabic text, then embedded as JPEG pages; a final page carries the
// identifiers and fingerprints as real, copyable text, and the input files plus a
// machine-readable report.json are attached inside the PDF.
import { PdfBuilder } from './core/pdf.js';
import { canonicalJson } from './core/slot-model.js';
import { sha256Hex } from './core/fair.js';
import { pair, NIST_NAMES, VOLATILITY, VERDICT } from './i18n.js';

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

// Machine-readable summary that the report fingerprint covers.
export function reportPayload(session, createdAt) {
  const r = session.results;
  const out = {
    format: 'taryam-rtp-lab-report/1',
    createdAt,
    meta: { title: session.meta.title || '', auditor: session.meta.auditor || '', notes: session.meta.notes || '' },
    inputs: session.inputs.map((i) => ({ id: i.id, name: i.name, kind: i.kind, size: i.size, sha256: i.sha256 })),
    results: {},
  };
  if (r.theoretical) {
    const x = r.theoretical.result;
    out.results.theoretical = {
      input: r.theoretical.inputId, model: x.model, rtp: x.rtp, contributions: x.contributions, freeSpins: x.freeSpins,
      distribution: x.distribution && { hitFrequency: x.distribution.hitFrequency, variance: x.distribution.variance, sd: x.distribution.sd, maxWin: x.distribution.maxWin },
      symbols: x.symbols.map((s) => ({ symbol: s.symbol, rtp: s.rtp.fraction })),
    };
  }
  if (r.actual) {
    const a = r.actual.result;
    out.results.actual = { input: r.actual.inputId, options: r.actual.options, rounds: a.rounds, totalBet: a.totalBet, totalWin: a.totalWin, rtp: a.rtp, ci: a.ci, confidence: a.confidence, standardError: a.standardError, declared: a.declared || null, roundsNeeded: a.roundsNeeded, skipped: r.actual.skipped };
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
  if (r.fair) {
    const f = r.fair.result;
    out.results.fair = { input: r.fair.inputId, scheme: r.fair.scheme, options: r.fair.options, ok: f.ok, summary: { ...f, mismatches: (f.mismatches || []).slice(0, 100), commitmentFailures: (f.commitmentFailures || []).slice(0, 100), breaks: (f.breaks || []).slice(0, 100) } };
  }
  if (r.montecarlo) {
    const m = r.montecarlo;
    out.results.montecarlo = { modelSha256: m.modelSha256, seed: m.seed, spins: m.spins, generator: m.generator, result: m.result, resultSha256: m.resultSha256, exactRtp: m.exactRtp ?? null };
  }
  if (r.lut) {
    const x = r.lut.result;
    out.results.lut = { inputs: r.lut.inputIds, format: x.format, indexFile: x.indexFile, ignored: x.ignored, provablyFair: false, modes: x.modes, profile: x.profile };
  }
  return out;
}

function theorySection(L, th) {
  const x = th.result;
  L.section('tabTheory');
  L.kv('game', x.model.name || '—');
  L.kv('layout', `${x.model.reels} × ${x.model.rows}, ${x.model.lines}`);
  L.kv('stops', x.model.stops.join(' / '));
  L.kv('combinations', Number(x.model.combinations).toLocaleString('en-US'));
  L.kv('modelHash', th.modelSha256, { mono: true });
  L.kv('rtp', x.rtp.percent + '%', { color: C.accent });
  L.kv('exactFraction', x.rtp.fraction, { mono: true });
  const d = x.distribution;
  if (d) {
    L.kv('hitFrequency', pct(d.hitFrequency.value, 4));
    L.kv('sd', num(d.sd, 4));
    L.kv('vi90', num(d.volatilityIndex90, 4));
    const v = VOLATILITY[d.volatilityClass];
    L.kv('volatility', v[0] + ' / ' + v[1]);
    L.kv('maxWinBase', num(d.maxWin.base, 2) + '×');
    if (d.maxWin.perFreeSpin !== undefined) {
      L.kv('maxWinFs', num(d.maxWin.perFreeSpin, 2) + '×');
      L.kv('maxWinTotal', d.maxWin.unbounded ? pair('unbounded').join(' / ') : num(d.maxWin.withFeature, 2) + '×');
    }
  } else if (x.distributionError) {
    L.badge('distributionError', C.warn, [x.distributionError.ar, x.distributionError.en]);
  }
  L.section('contributions');
  const c = x.contributions;
  L.table([{ key: 'contributions', w: 0.5 }, { key: 'contribution', w: 0.5, mono: true }], [
    [pair('contribLines').join(' / '), c.lines.percent + '%'],
    [pair('contribWild').join(' / '), c.wildAssistedLines.percent + '%'],
    [pair('contribScatter').join(' / '), c.scatter.percent + '%'],
    [pair('contribFs').join(' / '), c.freeSpins.percent + '%'],
    [{ text: 'RTP', bold: true }, { text: x.rtp.percent + '%', bold: true }],
  ]);
  if (x.freeSpins) {
    const f = x.freeSpins;
    L.kv('triggerProb', `${pct(f.triggerProbability.value, 4)}  (1 / ${num(1 / f.triggerProbability.value, 1)})`);
    L.kv('expectedSpins', num(f.expectedSpinsPerTrigger.value, 4));
    L.kv('evPerTrigger', num(f.evPerTrigger.value, 4) + '×');
  }
  L.section('symbolTable');
  const rows = [];
  for (const s of x.symbols) for (const b of s.byCount) rows.push([s.symbol + (s.isWild ? ' (wild)' : ''), b.count, num(b.pay, 4), b.probabilityPerLine.value.toExponential(4), b.rtp.percent + '%']);
  L.table([{ key: 'symbol', w: 0.22 }, { key: 'count', w: 0.12 }, { key: 'pay', w: 0.16 }, { key: 'probability', w: 0.24, mono: true }, { key: 'contribution', w: 0.26, mono: true }], rows);
  if (x.scatter && x.scatter.length) {
    L.table([{ labels: ['عدد الـScatter', 'Scatters'], w: 0.25 }, { key: 'probability', w: 0.35, mono: true }, { labels: ['الدفع × الرهان', 'Pay × bet'], w: 0.2 }, { labels: ['تفعيل', 'Trigger'], w: 0.2 }],
      x.scatter.map((s) => [s.count, s.probability.value.toExponential(4), num(s.pay, 4), s.triggers ? '✓' : '']));
  }
  if (d) {
    L.section('distribution');
    L.table([{ key: 'range', w: 0.5 }, { key: 'probability', w: 0.5, mono: true }],
      d.buckets.map((b) => [b.to === 0 ? '0' : b.to === null ? `≥ ${b.from}` : `${b.from} – ${b.to}`, pct(b.probability.value, 4)]));
  }
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

function mcSection(L, mc) {
  const s = mc.result;
  L.section('tabMc');
  L.kv('modelHash', mc.modelSha256, { mono: true });
  L.kv('seed', mc.seed, { mono: true });
  L.kv('prng', mc.generator, { mono: true });
  L.kv('spins', mc.spins.toLocaleString('en-US'));
  L.kv('simRtp', pct(s.rtp, 4), { color: C.accent });
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
    L.table([{ key: 'lutWinAtLeast', w: 0.34 }, { key: 'probability', w: 0.33, mono: true }, { labels: ['1 من N', '1 in N'], w: 0.33, mono: true }],
      m.bigWins.map((b) => [b.threshold.toLocaleString('en-US') + '×', lutPct(b.probability.value), lutOneIn(b.oneIn)]));
    L.table([{ key: 'range', w: 0.34 }, { key: 'probability', w: 0.33, mono: true }, { key: 'lutContribution', w: 0.33, mono: true }],
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
  if (x.ignored.length) { L.kv('lutIgnored', x.ignored.join(', ')); L.note('lutBooksNote'); }

  const pr = x.profile;
  L.section('lutStake');
  L.note('lutStakeSource');
  L.badge(pr.submissionIssues ? 'lutSubmissionBadShort' : 'lutSubmissionOk', pr.submissionIssues ? C.fail : C.pass);
  L.kv('lutRiskPassing', `${pr.riskPassing} / ${pr.riskCategories}`, { color: pr.riskPassing === pr.riskCategories ? C.pass : C.warn });
  L.kv('lutMaxBet', `$${num(pr.maxBaseBet.value, 2)}  (${pair('lutTemplate')[1]} ${pr.maxBaseBet.template})`);
  L.note('lutStakeRiskNote');
  const mode = (m) => (m === null ? pair('lutAllShort').join(' / ') : m);
  const cell = (ok) => statusCell(ok ? 'pass' : 'fail');
  // Arabic and English labels in their own columns: a mixed cell with numbers reorders badly.
  // Submission labels state their own limit ("Cost ≤ 50,000×").
  L.table([{ key: 'lutCheckAr', w: 0.28 }, { key: 'lutCheckEn', w: 0.24 }, { key: 'lutMode', w: 0.1 }, { key: 'lutValue', w: 0.26, mono: true }, { key: 'result', w: 0.12 }],
    pr.submission.map((c) => [pair('lutChk_' + c.id)[0], pair('lutChk_' + c.id)[1], mode(c.mode), c.id === 'rtp' ? `${pct(c.value, 4)} → ${pct(c.rounded, 2)}` : lutValue(c.unit, c.value), cell(c.ok)]));
  // Risk measures grouped under their category (a category fails if any measure in any mode does).
  const riskRows = [];
  for (const cat of [...new Set(pr.risk.map((c) => c.category))]) {
    const [ar, en] = pair('lutCat_' + cat);
    riskRows.push([{ text: ar, bold: true }, { text: en, bold: true }, '', '', '', pr.failedCategories.includes(cat) ? cell(false) : cell(true)]);
    for (const c of pr.risk.filter((r) => r.category === cat)) {
      riskRows.push([pair('lutMea_' + c.measure)[0], pair('lutMea_' + c.measure)[1], c.mode, lutValue(c.unit, c.value), lutValue(c.unit, c.limit), cell(c.ok)]);
    }
  }
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
  lines.push(`  Stake Engine RGS limits (${pr.profile.source} @${pr.profile.commit.slice(0, 7)}, ${pr.profile.commitDate}): submission issues ${pr.submissionIssues}; risk categories passing ${pr.riskPassing} of ${pr.riskCategories}`
    + (pr.failedCategories.length ? ` (failing: ${pr.failedCategories.join(', ')}; this lowers bet limits, it does not reject the game)` : '')
    + `; max base bet $${pr.maxBaseBet.value}. A recomputation, not a certification.`);
}

// Pretty JSON, but arrays of plain values stay on one line (reel strips, pay rows).
function compactJson(v, indent = '') {
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
  const lines = [
    'TARYAM RTP Lab - verification page',
    '',
    'Report ID:      ' + reportId,
    'Created (UTC):  ' + payload.createdAt,
    'Report SHA-256: ' + digest,
    '                (SHA-256 of the attached file report.json)',
    '',
    'Inputs (attached inside this PDF):',
  ];
  payload.inputs.forEach((i, n) => {
    lines.push(`  ${n + 1}. ${i.name} (${i.kind}, ${i.size} bytes)`);
    lines.push(`     SHA-256 ${i.sha256}`);
  });
  lines.push('', 'Results:');
  const r = payload.results;
  if (r.theoretical) lines.push(`  Theoretical RTP: ${r.theoretical.rtp.percent}% = ${r.theoretical.rtp.fraction.length > 80 ? r.theoretical.rtp.fraction.slice(0, 77) + '...' : r.theoretical.rtp.fraction}`);
  if (r.theoretical && r.theoretical.distribution) lines.push(`  Hit frequency ${(r.theoretical.distribution.hitFrequency.value * 100).toFixed(4)}%, SD ${r.theoretical.distribution.sd.toFixed(4)} x bet`);
  if (r.actual) lines.push(`  Observed RTP: ${(r.actual.rtp * 100).toFixed(4)}% over ${r.actual.rounds} rounds, ${(r.actual.confidence * 100).toFixed(1)}% CI ${(r.actual.ci[0] * 100).toFixed(3)}% - ${(r.actual.ci[1] * 100).toFixed(3)}%` + (r.actual.declared ? `, declared ${(r.actual.declared.rtp * 100).toFixed(2)}%, p = ${r.actual.declared.pValue.toPrecision(4)} (${r.actual.declared.verdict})` : ''));
  if (r.rng) {
    const app = r.rng.nist.filter((t) => t.applicable);
    const fam = r.rng.family;
    lines.push(`  RNG: NIST SP 800-22 passed ${app.filter((t) => (t.status || (t.pass ? 'pass' : 'fail')) === 'pass').length} of ${app.length} applicable tests` + (r.rng.twoLevel ? ` (two-level, ${r.rng.twoLevel.sequences} sequences)` : '') + `; chi-square ${r.rng.chiSquare.status || (r.rng.chiSquare.pass ? 'pass' : 'fail')}; serial correlation ${r.rng.serialCorrelation.status || (r.rng.serialCorrelation.pass ? 'pass' : 'fail')}`);
    if (fam) lines.push(`  Family verdict (Holm over ${fam.pValueCount} P-values, alpha ${fam.alpha}): ${fam.pass ? 'no gross statistical defect detected' : 'statistical defect detected'}; ${fam.belowAlpha} below alpha, ~${fam.expectedBelowAlpha.toFixed(1)} expected by chance`);
  }
  if (r.fair) lines.push(`  Provably fair (${r.fair.scheme}): ${r.fair.ok ? 'all rounds verified' : 'FAILURES FOUND'}`);
  if (r.montecarlo) lines.push(`  Monte Carlo: ${r.montecarlo.spins} rounds, seed "${r.montecarlo.seed}", RTP ${(r.montecarlo.result.rtp * 100).toFixed(4)}%, result SHA-256 ${r.montecarlo.resultSha256}`);
  if (r.lut) lutAscii(lines, r.lut);
  lines.push('', 'How to verify: extract the attached files, compute their SHA-256 and compare with the', 'values above. Any change to an input or to report.json changes its fingerprint.', 'The fingerprint detects changes; it is not a digital signature of the issuer.');
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

const SECTION_ORDER = ['theoretical', 'actual', 'rng', 'fair', 'montecarlo', 'lut'];
const RENDER = { theoretical: theorySection, actual: actualSection, rng: rngSection, fair: fairSection, montecarlo: mcSection, lut: lutSection };

// session: { meta, inputs: [{ id, name, kind, size, sha256, bytes, mime }], results: {...} }
export async function buildReport(session, { createCanvas, now = new Date(), onProgress = () => {} } = {}) {
  const createdAt = now.toISOString().replace(/\.\d{3}Z$/, 'Z');
  const payload = reportPayload(session, createdAt);
  const json = canonicalJson(payload);
  const jsonBytes = new TextEncoder().encode(json);
  const digest = await sha256Hex(jsonBytes);
  const reportId = 'TRL-' + createdAt.slice(0, 10).replace(/-/g, '') + '-' + digest.slice(0, 8).toUpperCase();

  const draw = (L) => {
    L.y += 10;
    if (session.meta.title) { L.draw(session.meta.title, W / 2, L.y + 20, { size: 38, weight: '700', align: 'center', dir: /[\u0600-\u06ff]/.test(session.meta.title) ? 'rtl' : 'ltr' }); L.y += 80; }
    L.kv('reportId', reportId, { mono: true, color: C.accent });
    L.kv('created', createdAt.replace('T', '  ').replace('Z', '  UTC'));
    if (session.meta.auditor) L.kv('auditor', session.meta.auditor);
    if (session.meta.notes) L.note(null, [session.meta.notes, session.meta.notes]);
    L.kv('digest', digest, { mono: true });
    L.section('inputsTitle');
    for (const i of session.inputs) {
      L.kv('file', `${i.name}  (${i.size.toLocaleString('en-US')} ${pair('bytes')[1]})`);
      L.kv('modelHash', i.sha256, { mono: true, labels: ['SHA-256', 'SHA-256'] });
    }
    L.note('verifyHow');
    L.note('signatureNote');
    for (const key of SECTION_ORDER) if (session.results[key]) { L.newPage(); RENDER[key](L, session.results[key]); }
    if (session.inputs.length) {
      L.newPage();
      L.section('appendix');
      for (const i of session.inputs) {
        L.kv('file', i.name);
        L.kv('modelHash', i.sha256, { mono: true, labels: ['SHA-256', 'SHA-256'] });
        const p = previewLines(i);
        L.mono(p.lines);
        if (p.truncated) L.note('truncated');
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
  pdf.attach('report.json', jsonBytes, { mime: 'application/json', description: 'Report data covered by the report SHA-256' });
  for (const i of session.inputs) pdf.attach(i.name, i.bytes, { mime: i.mime || 'application/octet-stream', description: 'SHA-256 ' + i.sha256 });
  onProgress(1);
  return { bytes: pdf.build(), reportId, digest, json, pages: totalPages + 1, thumbnails };
}

// Exact theoretical RTP of a reel-strip line game, from every reel combination.
//
// Reels stop independently and uniformly, so:
//  * Each payline's outcome depends only on the symbol frequencies of each reel,
//    which gives an exact per-symbol pay table (PAR sheet) by direct counting.
//  * The scatter count is a convolution of per-reel window counts.
//  * The full joint distribution of a spin's win (needed for hit frequency,
//    variance and max win) comes from a left-to-right pass over the reels that
//    keeps, per partial combination, the state of every line and merges
//    identical states. This is the same as enumerating every combination, minus
//    the duplicate work.
//  * Free spins (multiplier, optional retrigger) are a branching process whose
//    first two moments have closed forms in terms of single-spin moments.
// All sums are BigInt and results are exact fractions.
import { Fraction } from './fraction.js';
import { ModelError } from './slot-model.js';

const BUCKETS = [0, 1, 2, 5, 10, 20, 50, 100, 500];

function product(nums) { return nums.reduce((a, b) => a * BigInt(b), 1n); }

function linePayout(model, t, w, len) {
  const wildPay = model.wildPays[w] || 0;
  if (t === model.symbols.length) return { pay: wildPay, sym: model.wild, count: w };
  const symPay = model.linePays[t][len];
  if (wildPay > symPay) return { pay: wildPay, sym: model.wild, count: w };
  return { pay: symPay, sym: t, count: len };
}

function zeroPaySymbols(model) {
  return model.symbols.map((_, id) => id !== model.wild && model.linePays[id].every((p) => p === 0));
}

// Exact outcomes of one payline (identical for every line, since each reel's
// symbol at any row is distributed like the strip's symbol frequencies).
export function linePar(model, strips) {
  const S = model.symbols.length, N = model.nReels, WO = S;
  const zero = zeroPaySymbols(model);
  const freq = strips.map((s) => { const f = new Array(S).fill(0); for (const x of s) f[x]++; return f; });
  const suffix = new Array(N + 1).fill(1);
  for (let k = N - 1; k >= 0; k--) suffix[k] = suffix[k + 1] * strips[k].length;
  const outcomes = new Map();
  const record = (res, count, usedWild) => {
    if (res.pay <= 0) return;
    const key = res.sym + ',' + res.count + ',' + (res.sym !== model.wild && usedWild ? 1 : 0);
    const o = outcomes.get(key);
    if (o) o.combos += BigInt(count); else outcomes.set(key, { sym: res.sym, count: res.count, wildAssisted: res.sym !== model.wild && usedWild === 1, pay: res.pay, combos: BigInt(count) });
  };
  let states = new Map([[WO + ',0,0', 1]]);
  for (let k = 0; k < N; k++) {
    const next = new Map();
    for (const [key, cnt] of states) {
      const [t, w, uw] = key.split(',').map(Number);
      for (let x = 0; x < S; x++) {
        const fx = freq[k][x];
        if (!fx) continue;
        const c = cnt * fx;
        let nt = t, nw = w, nuw = uw, dead = false;
        if (x === model.wild) { if (t === WO) nw = w + 1; nuw = 1; }
        else if (x === model.scatter || zero[x]) dead = true;
        else if (t === WO) nt = x;
        else if (x !== t) dead = true;
        if (dead) record(linePayout(model, t, w, k), c * suffix[k + 1], uw);
        else { const nk = nt + ',' + nw + ',' + nuw; next.set(nk, (next.get(nk) || 0) + c); }
      }
    }
    states = next;
  }
  for (const [key, cnt] of states) {
    const [t, w, uw] = key.split(',').map(Number);
    record(linePayout(model, t, w, N), cnt, uw);
  }
  return [...outcomes.values()];
}

// Distribution of the number of scatters in the visible window.
export function scatterDistribution(model, strips) {
  let dist = [1];
  for (const s of strips) {
    const local = new Array(model.rows + 1).fill(0);
    for (let p = 0; p < s.length; p++) {
      let c = 0;
      for (let r = 0; r < model.rows; r++) if (s[(p + r) % s.length] === model.scatter) c++;
      local[c]++;
    }
    const next = new Array(dist.length + model.rows).fill(0);
    dist.forEach((a, i) => local.forEach((b, j) => { next[i + j] += a * b; }));
    dist = next;
  }
  return dist; // dist[c] = number of combinations with exactly c scatters
}

function scatterCap(model) {
  let cap = 1;
  for (let c = model.scatterPays.length - 1; c >= 1; c--) if (model.scatterPays[c] !== model.scatterPays[c - 1]) { cap = Math.max(cap, c); break; }
  if (model.freeSpins) cap = Math.max(cap, model.freeSpins.trigger);
  return Math.min(cap, model.nReels * model.rows);
}

// Joint distribution of (total line win, capped scatter count) over every combination.
export function jointDistribution(model, strips, { maxStates = 4000000, onProgress = () => {} } = {}) {
  const S = model.symbols.length, N = model.nReels, R = model.rows, L = model.lines.length, WO = S;
  const B = N + 1;
  const zero = zeroPaySymbols(model);
  const enc = (t, w) => 1 + t * B + w;
  const C = (S + 1) * B + 1;
  const next = [], pay = [];
  for (let k = 0; k < N; k++) {
    const nx = new Uint16Array(C * S), py = new Float64Array(C * S);
    for (let code = 1; code < C; code++) {
      const t = Math.floor((code - 1) / B), w = (code - 1) % B;
      if (w > k) continue; // unreachable before reel k
      for (let x = 0; x < S; x++) {
        let nt = t, nw = w, dead = false;
        if (x === model.wild) { if (t === WO) nw = w + 1; }
        else if (x === model.scatter || zero[x]) dead = true;
        else if (t === WO) nt = x;
        else if (x !== t) dead = true;
        const i = code * S + x;
        if (dead) { nx[i] = 0; py[i] = linePayout(model, t, w, k).pay; } else nx[i] = enc(nt, nw);
      }
    }
    next.push(nx); pay.push(py);
  }
  const finalPay = new Float64Array(C);
  for (let code = 1; code < C; code++) finalPay[code] = linePayout(model, Math.floor((code - 1) / B), (code - 1) % B, N).pay;

  const cap = model.scatter >= 0 ? scatterCap(model) : 0;
  const windows = strips.map((s) => {
    const m = new Map();
    for (let p = 0; p < s.length; p++) {
      const syms = [];
      let sc = 0;
      for (let r = 0; r < R; r++) { const x = s[(p + r) % s.length]; syms.push(x); if (x === model.scatter) sc++; }
      const key = syms.join(',');
      const e = m.get(key);
      if (e) e.mult++; else m.set(key, { syms, scat: sc, mult: 1 });
    }
    return [...m.values()];
  });
  const rowOf = model.lines.map((line) => line);

  let codes = new Uint16Array(L).fill(enc(WO, 0));
  let acc = [0], scat = [0], count = [1];
  let nStates = 1;
  const tmp = new Uint16Array(L);
  const dist = new Map();
  let work = 0;
  for (let k = 0; k < N; k++) {
    const last = k === N - 1;
    const index = new Map();
    const nCodes = [], nAcc = [], nScat = [], nCount = [];
    const nx = next[k], py = pay[k];
    for (let s = 0; s < nStates; s++) {
      const base = s * L;
      for (const wd of windows[k]) {
        let a = acc[s];
        const sc = Math.min(scat[s] + wd.scat, cap);
        const cnt = count[s] * wd.mult;
        for (let i = 0; i < L; i++) {
          const idx = codes[base + i] * S + wd.syms[rowOf[i][k]];
          tmp[i] = nx[idx];
          a += py[idx];
        }
        if (last) {
          for (let i = 0; i < L; i++) a += finalPay[tmp[i]];
          const key = a * 128 + sc;
          dist.set(key, (dist.get(key) || 0) + cnt);
        } else {
          const key = String.fromCharCode.apply(null, tmp) + '|' + a + '|' + sc;
          const j = index.get(key);
          if (j === undefined) {
            index.set(key, nAcc.length);
            for (let i = 0; i < L; i++) nCodes.push(tmp[i]);
            nAcc.push(a); nScat.push(sc); nCount.push(cnt);
            if (nAcc.length > maxStates) {
              throw new ModelError('اللعبة كبيرة جدًا لحساب التوزيع الكامل بدقة (عدد الحالات تجاوز الحد). RTP والمساهمات ما زالت دقيقة.',
                'The game is too large for the exact full distribution (state limit exceeded). RTP and contributions are still exact.');
            }
          } else nCount[j] += cnt;
        }
      }
      if ((++work & 4095) === 0) onProgress((k + s / nStates) / N);
    }
    if (!last) {
      codes = Uint16Array.from(nCodes);
      acc = nAcc; scat = nScat; count = nCount; nStates = nAcc.length;
    }
  }
  onProgress(1);
  const out = [];
  for (const [key, cnt] of dist) out.push({ lineWin: Math.floor(key / 128), scat: key % 128, count: cnt });
  return out;
}

const frac = (f) => ({ fraction: f.toString(), value: f.toNumber(), percent: f.toPercent(6) });

function spinMoments(model, entries, triggerCounts) {
  const fs = model.freeSpins;
  let s1 = 0n, s2 = 0n, sJ = 0n, sXJ = 0n, hits = 0n, maxAll = 0, maxNoJ = 0, maxJ = 0, sLine = 0n, sScat = 0n;
  const buckets = new Array(BUCKETS.length + 1).fill(0n);
  for (const e of entries) {
    const win = e.lineWin + model.scatterPays[e.scat];
    const c = BigInt(e.count), w = BigInt(win);
    const J = Boolean(fs && triggerCounts && e.scat >= fs.trigger);
    s1 += c * w; s2 += c * w * w; sLine += c * BigInt(e.lineWin); sScat += c * BigInt(model.scatterPays[e.scat]);
    if (J) { sJ += c; sXJ += c * w; maxJ = Math.max(maxJ, win); } else maxNoJ = Math.max(maxNoJ, win);
    if (win > 0 || J) hits += c;
    maxAll = Math.max(maxAll, win);
    const x = win / model.totalBetUnits;
    let b = 0;
    if (x > 0) { b = BUCKETS.length; for (let i = 1; i < BUCKETS.length; i++) if (x < BUCKETS[i]) { b = i; break; } }
    buckets[b] += c;
  }
  return { s1, s2, sJ, sXJ, hits, maxAll, maxNoJ, maxJ, sLine, sScat, buckets };
}

// Exact distribution of the paid spin's own win (lines + scatter) for the
// distribution tests (audit-stats.js): sorted by win, in model units
// (x = units / unitsPerBet), probability = count / total. With free spins, the
// spins that trigger them are separate entries (trigger: true) whose win does not
// include the feature, so scope is 'baseSpin'; without, it is the whole round.
export function spinPmf(model, entries, total) {
  const fs = model.freeSpins;
  const counts = new Map();
  for (const e of entries) {
    const key = (e.lineWin + model.scatterPays[e.scat]) * 2 + (fs && e.scat >= fs.trigger ? 1 : 0);
    counts.set(key, (counts.get(key) || 0n) + BigInt(e.count));
  }
  return {
    scope: fs ? 'baseSpin' : 'round', unitsPerBet: model.totalBetUnits, total: total.toString(),
    entries: [...counts].sort((a, b) => a[0] - b[0]).map(([key, c]) => ({
      units: Math.floor(key / 2), x: Math.floor(key / 2) / model.totalBetUnits, trigger: key % 2 === 1, count: c.toString(),
    })),
  };
}

// Full exact analysis. Throws ModelError only for invalid input; if the joint
// distribution is too large, the RTP part is still returned with distribution: null.
export function analyzeExact(model, opts = {}) {
  const fs = model.freeSpins;
  const scale = model.scale, L = model.lines.length, totalBet = model.totalBetUnits;
  const total = product(model.reels.map((s) => s.length));
  const fsTotal = fs ? product(fs.reels.map((s) => s.length)) : 1n;

  // Exact RTP from the per-line table and the scatter convolution.
  const par = linePar(model, model.reels);
  const lineSum = par.reduce((a, o) => a + o.combos * BigInt(o.pay), 0n); // one line, units
  const sd = model.scatter >= 0 ? scatterDistribution(model, model.reels) : [Number(total)];
  const scatterSum = sd.reduce((a, c, k) => a + BigInt(c) * BigInt(model.scatterPays[k] || 0), 0n);
  const pTrigger = fs ? new Fraction(sd.reduce((a, c, k) => a + (k >= fs.trigger ? BigInt(c) : 0n), 0n), total) : new Fraction(0n);

  let fsInfo = null;
  let fsEV = new Fraction(0n); // expected free-spin win per trigger, units
  let fsSpinEV = null, pRetrig = new Fraction(0n);
  if (fs) {
    const fpar = fs.sameReels ? par : linePar(model, fs.reels);
    const fsd = fs.sameReels ? sd : scatterDistribution(model, fs.reels);
    const fLine = fpar.reduce((a, o) => a + o.combos * BigInt(o.pay), 0n) * BigInt(L);
    const fScat = fsd.reduce((a, c, k) => a + BigInt(c) * BigInt(model.scatterPays[k] || 0), 0n);
    fsSpinEV = new Fraction(fLine + fScat, fsTotal).mul(fs.multiplier);
    if (fs.retrigger) pRetrig = new Fraction(fsd.reduce((a, c, k) => a + (k >= fs.trigger ? BigInt(c) : 0n), 0n), fsTotal);
    const growth = pRetrig.mul(fs.spins);
    if (growth.cmp(1) >= 0) {
      throw new ModelError('إعادة تفعيل الفري سبين تجعل عدد الجولات المتوقع لا نهائيًا (احتمال إعادة التفعيل × عدد الجولات ≥ 1)',
        'Free-spin retriggers make the expected number of spins infinite (retrigger probability × spins ≥ 1)');
    }
    const expectedSpins = new Fraction(BigInt(fs.spins)).div(new Fraction(1n).sub(growth));
    fsEV = expectedSpins.mul(fsSpinEV);
    fsInfo = { triggerProbability: frac(pTrigger), retriggerProbability: frac(pRetrig), expectedSpinsPerTrigger: frac(expectedSpins), evPerTrigger: frac(fsEV.div(totalBet)), spinEV: frac(fsSpinEV.div(totalBet)) };
  }
  const evLines = new Fraction(lineSum * BigInt(L), total);
  const evScatter = new Fraction(scatterSum, total);
  const evFs = pTrigger.mul(fsEV);
  const ev = evLines.add(evScatter).add(evFs);
  const rtp = ev.div(totalBet);

  const symbols = new Map();
  let wildAssisted = 0n;
  for (const o of par) {
    const name = model.symbols[o.sym];
    if (!symbols.has(name)) symbols.set(name, { symbol: name, isWild: o.sym === model.wild, sum: 0n, byCount: new Map() });
    const s = symbols.get(name);
    const v = o.combos * BigInt(o.pay);
    s.sum += v;
    const bc = s.byCount.get(o.count) || { count: o.count, combos: 0n, pay: o.pay / scale, sum: 0n };
    bc.combos += o.combos; bc.sum += v;
    s.byCount.set(o.count, bc);
    if (o.wildAssisted) wildAssisted += v;
  }
  const perLineTotal = total * BigInt(scale); // a line's own bet is 1/L of the total bet
  const symbolTable = [...symbols.values()].map((s) => ({
    symbol: s.symbol, isWild: s.isWild,
    rtp: frac(new Fraction(s.sum, perLineTotal)),
    byCount: [...s.byCount.values()].sort((a, b) => a.count - b.count).map((b) => ({
      count: b.count, pay: b.pay, combosPerLine: b.combos.toString(),
      probabilityPerLine: frac(new Fraction(b.combos, total)), rtp: frac(new Fraction(b.sum, perLineTotal)),
    })),
  })).sort((a, b) => b.rtp.value - a.rtp.value);
  const scatterTable = model.scatter >= 0 ? sd.map((c, k) => ({ count: k, combos: String(c), probability: frac(new Fraction(BigInt(c), total)), pay: (model.scatterPays[k] || 0) / totalBet, triggers: Boolean(fs && k >= fs.trigger) })).filter((r) => r.combos !== '0') : [];

  const result = {
    model: { name: model.name, reels: model.nReels, rows: model.rows, lines: L, stops: model.reels.map((s) => s.length), symbols: model.symbols.length, combinations: total.toString() },
    rtp: frac(rtp),
    contributions: {
      lines: frac(evLines.div(totalBet)), scatter: frac(evScatter.div(totalBet)), freeSpins: frac(evFs.div(totalBet)),
      wildAssistedLines: frac(new Fraction(wildAssisted * BigInt(L), total).div(totalBet)),
    },
    symbols: symbolTable, scatter: scatterTable, freeSpins: fsInfo,
    distribution: null, distributionError: null,
  };

  // Exact distribution: hit frequency, variance, max win.
  try {
    const progress = opts.onProgress || (() => {});
    const base = jointDistribution(model, model.reels, { ...opts, onProgress: (p) => progress(fs && !fs.sameReels ? p / 2 : p) });
    const b = spinMoments(model, base, true);
    const check = new Fraction(b.s1, total).add(evFs);
    if (!check.equals(ev)) throw new Error('internal check failed: distribution EV != per-line EV');
    let ew2 = new Fraction(b.s2, total);
    let maxWin = { base: b.maxAll / totalBet, withFeature: b.maxAll / totalBet, unbounded: false };
    if (fs) {
      const fsEntries = fs.sameReels ? base : jointDistribution(model, fs.reels, { ...opts, onProgress: (p) => progress(0.5 + p / 2) });
      const x = spinMoments(model, fsEntries, fs.retrigger);
      const m = fs.multiplier, F = BigInt(fs.spins);
      const EX = new Fraction(x.s1, fsTotal).mul(m);
      const EX2 = new Fraction(x.s2, fsTotal).mul(m).mul(m);
      const EXI = new Fraction(x.sXJ, fsTotal).mul(m);
      const p = new Fraction(x.sJ, fsTotal);
      const oneMinus = new Fraction(1n).sub(p.mul(F));
      const EZ = EX.div(oneMinus);
      const EZ2 = EX2.add(EXI.mul(EZ).mul(2n * F)).add(p.mul(F * (F - 1n)).mul(EZ).mul(EZ)).div(oneMinus);
      const EFv = EZ.mul(F);
      const EFv2 = EZ2.mul(F).add(EZ.mul(EZ).mul(F * (F - 1n)));
      if (!EFv.equals(fsEV)) throw new Error('internal check failed: free-spin EV mismatch');
      const pJ = new Fraction(b.sJ, total);
      ew2 = ew2.add(new Fraction(b.sXJ, total).mul(EFv).mul(2n)).add(pJ.mul(EFv2));
      const maxFsSpin = m.mul(x.maxAll).toNumber();
      maxWin = {
        base: b.maxAll / totalBet,
        perFreeSpin: maxFsSpin / totalBet,
        withFeature: fs.retrigger ? null : Math.max(b.maxNoJ, b.maxJ + fs.spins * maxFsSpin) / totalBet,
        unbounded: fs.retrigger,
      };
    }
    const variance = ew2.sub(ev.mul(ev)).div(totalBet * totalBet);
    const sdev = Math.sqrt(variance.toNumber());
    result.distribution = {
      hitFrequency: frac(new Fraction(b.hits, total)),
      variance: frac(variance),
      sd: sdev,
      volatilityIndex90: 1.645 * sdev,
      volatilityIndex95: 1.96 * sdev,
      volatilityClass: sdev < 4 ? 'low' : sdev < 8 ? 'medium' : sdev < 15 ? 'high' : 'veryHigh',
      maxWin,
      buckets: b.buckets.map((c, i) => ({
        from: i === 0 ? 0 : BUCKETS[i - 1], to: i === 0 ? 0 : i < BUCKETS.length ? BUCKETS[i] : null,
        probability: frac(new Fraction(c, total)),
      })),
      states: base.length,
      pmf: spinPmf(model, base, total),
    };
  } catch (e) {
    if (!(e instanceof ModelError)) throw e;
    result.distributionError = { ar: e.ar, en: e.en };
  }
  return result;
}

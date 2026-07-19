// Vercel Serverless Function: proxies file-hash / URL reputation lookups to
// the VirusTotal Public API v3 using a server-side VIRUSTOTAL_API_KEY.
// Two modes:
//   - hash: look up an existing report for a file hash (MD5/SHA1/SHA256).
//   - url: submit a URL for analysis (or fetch existing report) and return
//          the multi-engine verdict (malicious/suspicious/harmless counts).
// VirusTotal's public API free tier is rate-limited (~4 req/min), so this
// endpoint applies its own lightweight per-IP throttling on top to avoid
// burning the daily quota.
const crypto = require('crypto');

const BLOB_TOKEN = process.env.BLOB_READ_WRITE_TOKEN;
const BLOB_BASE = 'https://blob.vercel-storage.com';
const STORE_ID = process.env.BLOB_STORE_ID || '6tfgxvttzyoiavtu';
const PUBLIC_BASE = 'https://' + STORE_ID + '.public.blob.vercel-storage.com/';

const VT_BASE = 'https://www.virustotal.com/api/v3';
const DAILY_LIMIT = 15; // per guest/user id, keeps free-tier quota safe

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function usagePath(id) {
  return 'taryam/db/vt_usage/' + encodeURIComponent(id) + '.json';
}

async function readBlobJson(path, fallback) {
  try {
    const res = await fetch(PUBLIC_BASE + path + '?_=' + Date.now(), { cache: 'no-store' });
    if (!res.ok) return fallback;
    return await res.json();
  } catch (e) {
    return fallback;
  }
}

async function writeBlobJson(path, data) {
  try {
    await fetch(BLOB_BASE + '/' + path, {
      method: 'PUT',
      headers: {
        Authorization: 'Bearer ' + BLOB_TOKEN,
        'x-content-type': 'application/json',
        'x-add-random-suffix': '0',
        'x-cache-control-max-age': '0',
      },
      body: JSON.stringify(data),
    });
  } catch (e) {
    // best-effort
  }
}

function summarize(attrs) {
  const stats = (attrs && attrs.last_analysis_stats) || {};
  const malicious = stats.malicious || 0;
  const suspicious = stats.suspicious || 0;
  const harmless = stats.harmless || 0;
  const undetected = stats.undetected || 0;
  const total = malicious + suspicious + harmless + undetected + (stats.timeout || 0);
  let verdict = 'unknown';
  if (malicious > 0) verdict = 'malicious';
  else if (suspicious > 0) verdict = 'suspicious';
  else if (total > 0) verdict = 'clean';
  return {
    verdict,
    stats: { malicious, suspicious, harmless, undetected, total },
    reputation: attrs && typeof attrs.reputation === 'number' ? attrs.reputation : null,
    names: (attrs && attrs.names) || undefined,
    type_description: attrs && attrs.type_description,
    last_analysis_date: attrs && attrs.last_analysis_date,
  };
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  try {
    const apiKey = process.env.VIRUSTOTAL_API_KEY;
    if (!apiKey) {
      res.status(200).json({ notConfigured: true });
      return;
    }

    const body = req.body || {};
    const { mode, value, guestId } = body;
    const q = String(value || '').trim();
    if (!q || q.length > 2048) {
      res.status(400).json({ error: 'Invalid input value' });
      return;
    }
    if (!['hash', 'url'].includes(mode)) {
      res.status(400).json({ error: 'mode must be "hash" or "url"' });
      return;
    }

    const id = String(guestId || req.headers['x-forwarded-for'] || 'anon').slice(0, 100);
    const today = todayStr();
    let usage = await readBlobJson(usagePath(id), null);
    if (!usage || usage.date !== today) usage = { date: today, count: 0 };
    if (usage.count >= DAILY_LIMIT) {
      res.status(429).json({ error: 'limit', message: 'وصلت للحد اليومي المسموح لهذه الأداة (' + DAILY_LIMIT + ' فحوصات/يوم). حاول غدًا.' });
      return;
    }

    let upstream;
    if (mode === 'hash') {
      if (!/^[a-fA-F0-9]{32}$|^[a-fA-F0-9]{40}$|^[a-fA-F0-9]{64}$/.test(q)) {
        res.status(400).json({ error: 'Invalid hash format (expected MD5/SHA1/SHA256)' });
        return;
      }
      upstream = await fetch(`${VT_BASE}/files/${q}`, { headers: { 'x-apikey': apiKey } });
    } else {
      // URL mode: VT requires a URL-safe base64 id derived from the URL, OR
      // we can submit it fresh. Submitting is simplest and works even for
      // URLs VT hasn't seen before.
      const submit = await fetch(`${VT_BASE}/urls`, {
        method: 'POST',
        headers: { 'x-apikey': apiKey, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'url=' + encodeURIComponent(q),
      });
      if (!submit.ok) {
        const txt = await submit.text().catch(() => '');
        res.status(submit.status).json({ error: 'VirusTotal submit failed (' + submit.status + ')', detail: txt.slice(0, 300) });
        return;
      }
      const submitData = await submit.json();
      const analysisId = submitData && submitData.data && submitData.data.id;
      if (!analysisId) {
        res.status(502).json({ error: 'VirusTotal did not return an analysis id' });
        return;
      }
      // Poll briefly for completion (VT analyses of known URLs finish almost
      // instantly; new URLs may take longer — we give it a couple of tries).
      let analysis = null;
      for (let i = 0; i < 3; i++) {
        const check = await fetch(`${VT_BASE}/analyses/${analysisId}`, { headers: { 'x-apikey': apiKey } });
        if (check.ok) {
          const data = await check.json();
          if (data && data.data && data.data.attributes && data.data.attributes.status === 'completed') {
            analysis = data;
            break;
          }
        }
        await new Promise((r) => setTimeout(r, 1500));
      }
      usage.count += 1;
      await writeBlobJson(usagePath(id), usage);
      if (!analysis) {
        res.status(200).json({ pending: true, message: 'التحليل قيد التنفيذ، حاول مرة أخرى خلال دقيقة.', remaining: DAILY_LIMIT - usage.count });
        return;
      }
      const attrs = analysis.data.attributes;
      const stats = attrs.stats || {};
      const malicious = stats.malicious || 0;
      const suspicious = stats.suspicious || 0;
      const harmless = stats.harmless || 0;
      const undetected = stats.undetected || 0;
      let verdict = 'unknown';
      if (malicious > 0) verdict = 'malicious';
      else if (suspicious > 0) verdict = 'suspicious';
      else verdict = 'clean';
      res.status(200).json({
        target: q,
        mode,
        verdict,
        stats: { malicious, suspicious, harmless, undetected },
        remaining: DAILY_LIMIT - usage.count,
      });
      return;
    }

    usage.count += 1;
    await writeBlobJson(usagePath(id), usage);

    if (upstream.status === 404) {
      res.status(200).json({ target: q, mode, verdict: 'not_found', message: 'لا يوجد سجل لهذا الـ Hash في قاعدة بيانات VirusTotal (لا يعني أنه آمن بالضرورة).', remaining: DAILY_LIMIT - usage.count });
      return;
    }
    if (!upstream.ok) {
      const txt = await upstream.text().catch(() => '');
      res.status(upstream.status).json({ error: 'VirusTotal lookup failed (' + upstream.status + ')', detail: txt.slice(0, 300) });
      return;
    }
    const data = await upstream.json();
    const attrs = data && data.data && data.data.attributes;
    const summary = summarize(attrs);
    res.status(200).json({ target: q, mode, ...summary, remaining: DAILY_LIMIT - usage.count });
  } catch (e) {
    res.status(500).json({ error: 'Proxy error: ' + (e && e.message ? e.message : String(e)) });
  }
};

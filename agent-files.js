/*
 * TARYAM Cyber — project file operations for the chat assistant
 * ------------------------------------------------------------------
 * When "file editing" is on, the assistant can create, edit and delete files in
 * the current project by writing explicit blocks in its reply:
 *
 *   <<<FILE path="src/app.js">>>
 *   ...the whole new file...
 *   <<<END>>>
 *
 *   <<<EDIT path="src/app.js">>>
 *   <<<SEARCH>>>
 *   exact text that is in the file now
 *   <<<REPLACE>>>
 *   what it becomes
 *   <<<END>>>
 *
 *   <<<DELETE path="old.txt">>>
 *
 * This module parses those blocks, checks paths, applies them to an in-memory
 * { path: content } map without touching the original (so the UI can preview a
 * change and apply it only after the user agrees), and has two helpers the
 * workspace needs: inlining local CSS/JS into the preview, and zipping the project.
 *
 * Browser global `AgentFiles`, and `module.exports` for the unit tests.
 */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.AgentFiles = api;
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
  'use strict';

  const LIMITS = { files: 200, fileChars: 500000, ops: 50, pathChars: 200, depth: 10 };

  // ---- paths --------------------------------------------------------------
  // Returns a normalized relative path, or null if it is not acceptable.
  function safePath(p) {
    let s = String(p == null ? '' : p).trim().replace(/\\/g, '/');
    while (s.startsWith('./')) s = s.slice(2);
    if (!s || s.length > LIMITS.pathChars) return null;
    if (s.startsWith('/') || /^[a-z]:/i.test(s)) return null;           // absolute
    if (/[\u0000-\u001f\u007f<>:"|?*]/.test(s)) return null;            // control / reserved chars
    const parts = s.split('/');
    if (parts.length > LIMITS.depth) return null;
    if (parts.some((x) => x === '' || x === '.' || x === '..')) return null;
    return parts.join('/');
  }

  // ---- parsing ------------------------------------------------------------
  const OPEN = /<<<(FILE|EDIT|DELETE)\s+path\s*=\s*"([^"\n]*)"\s*>>>/g;

  // Drops one leading and one trailing newline so a block's body is exactly the
  // text between the marker lines.
  function body(s) {
    return s.replace(/^\r?\n/, '').replace(/\r?\n$/, '');
  }

  function parseEdits(inner) {
    const edits = [];
    const re = /<<<SEARCH>>>([\s\S]*?)<<<REPLACE>>>([\s\S]*?)(?=<<<SEARCH>>>|$)/g;
    let m;
    while ((m = re.exec(inner))) edits.push({ search: body(m[1]), replace: body(m[2]) });
    return edits;
  }

  // Returns { ops, text } — text is the reply with every block removed.
  function parseOps(reply) {
    const src = String(reply || '');
    const ops = [];
    let text = '';
    let last = 0;
    OPEN.lastIndex = 0;
    let m;
    while ((m = OPEN.exec(src)) && ops.length < LIMITS.ops) {
      const [marker, kind, rawPath] = m;
      text += src.slice(last, m.index);
      const path = safePath(rawPath);
      if (kind === 'DELETE') {
        ops.push({ type: 'delete', path, rawPath });
        last = m.index + marker.length;
        OPEN.lastIndex = last;
        continue;
      }
      const end = src.indexOf('<<<END>>>', m.index + marker.length);
      if (end < 0) { // unterminated block: keep the rest as text, do not guess
        last = m.index;
        break;
      }
      const inner = src.slice(m.index + marker.length, end);
      if (kind === 'FILE') ops.push({ type: 'write', path, rawPath, content: body(inner) });
      else ops.push({ type: 'edit', path, rawPath, edits: parseEdits(inner) });
      last = end + '<<<END>>>'.length;
      OPEN.lastIndex = last;
    }
    text += src.slice(last);
    return { ops, text: text.replace(/\n{3,}/g, '\n\n').trim() };
  }

  // ---- diff stats ---------------------------------------------------------
  // Lines added/removed, counted as a multiset difference (cheap, order-blind;
  // good enough for a +N / -M badge).
  function diffStat(before, after) {
    const a = before == null ? [] : String(before).split('\n');
    const b = after == null ? [] : String(after).split('\n');
    const count = new Map();
    a.forEach((l) => count.set(l, (count.get(l) || 0) + 1));
    let added = 0;
    b.forEach((l) => { const c = count.get(l) || 0; if (c > 0) count.set(l, c - 1); else added++; });
    let removed = 0;
    count.forEach((c) => { removed += c; });
    if (before == null || before === '') removed = 0;
    if (after == null) added = 0;
    return { added, removed };
  }

  function occurrences(hay, needle) {
    if (!needle) return 0;
    let n = 0, i = 0;
    // Step one char, not needle.length, so overlapping matches count too:
    // '}\n}' occurs twice in '}\n}\n}' and must be rejected as ambiguous.
    while ((i = hay.indexOf(needle, i)) !== -1) { n++; i += 1; }
    return n;
  }

  // ---- applying -----------------------------------------------------------
  // Applies ops in order to a copy of `files`. Each op is all-or-nothing.
  // Returns { files, results: [{ type, path, ok, error, created, added, removed }] }.
  function applyOps(files, ops) {
    const out = Object.assign({}, files || {});
    const results = [];
    for (const op of ops || []) {
      const r = { type: op.type, path: op.path || op.rawPath || '', ok: false, error: null, created: false, added: 0, removed: 0 };
      results.push(r);
      if (!op.path) { r.error = 'invalid path'; continue; }
      const exists = Object.prototype.hasOwnProperty.call(out, op.path);

      if (op.type === 'delete') {
        if (!exists) { r.error = 'file not found'; continue; }
        r.removed = String(out[op.path]).split('\n').length;
        delete out[op.path];
        r.ok = true;
        continue;
      }

      if (op.type === 'write') {
        const content = String(op.content == null ? '' : op.content);
        if (content.length > LIMITS.fileChars) { r.error = 'file too large'; continue; }
        if (!exists && Object.keys(out).length >= LIMITS.files) { r.error = 'too many files'; continue; }
        const st = diffStat(exists ? out[op.path] : null, content);
        r.added = exists ? st.added : content.split('\n').length;
        r.removed = exists ? st.removed : 0;
        r.created = !exists;
        out[op.path] = content;
        r.ok = true;
        continue;
      }

      if (op.type === 'edit') {
        if (!exists) { r.error = 'file not found'; continue; }
        if (!op.edits || !op.edits.length) { r.error = 'no SEARCH/REPLACE pairs'; continue; }
        let text = String(out[op.path]);
        let failed = null;
        for (const e of op.edits) {
          const n = occurrences(text, e.search);
          if (n === 0) { failed = 'search text not found'; break; }
          if (n > 1) { failed = 'search text matches ' + n + ' places; make it unique'; break; }
          text = text.replace(e.search, () => e.replace);
        }
        if (failed) { r.error = failed; continue; }
        if (text.length > LIMITS.fileChars) { r.error = 'file too large'; continue; }
        const st = diffStat(out[op.path], text);
        r.added = st.added;
        r.removed = st.removed;
        out[op.path] = text;
        r.ok = true;
        continue;
      }
      r.error = 'unknown operation';
    }
    return { files: out, results };
  }

  // ---- prompt helpers -----------------------------------------------------
  function protocolPrompt(ar) {
    if (ar) {
      return [
        'لديك صلاحية تعديل ملفات المشروع الحالي. المستخدم يراجع كل تغيير قبل تطبيقه.',
        'لإنشاء ملف أو استبداله كاملًا:',
        '<<<FILE path="المسار/الاسم.ext">>>',
        'المحتوى الكامل للملف',
        '<<<END>>>',
        'لتعديل جزء من ملف موجود (النص في SEARCH يجب أن يطابق الملف حرفيًا ويظهر مرة واحدة):',
        '<<<EDIT path="المسار/الاسم.ext">>>',
        '<<<SEARCH>>>',
        'النص الحالي',
        '<<<REPLACE>>>',
        'النص الجديد',
        '<<<END>>>',
        'لحذف ملف: <<<DELETE path="المسار/الاسم.ext">>>',
        'استخدم مسارات نسبية فقط (بدون / في البداية وبدون ..). اشرح التغيير باختصار خارج الكتل. صفحة المعاينة هي index.html، ويمكنها استخدام ملفات css/js محلية.',
      ].join('\n');
    }
    return [
      'You may edit the files of the current project. The user reviews every change before it is applied.',
      'To create a file or replace it entirely:',
      '<<<FILE path="dir/name.ext">>>',
      'the whole file',
      '<<<END>>>',
      'To change part of an existing file (SEARCH must match the file exactly and occur once):',
      '<<<EDIT path="dir/name.ext">>>',
      '<<<SEARCH>>>',
      'current text',
      '<<<REPLACE>>>',
      'new text',
      '<<<END>>>',
      'To delete a file: <<<DELETE path="dir/name.ext">>>',
      'Use relative paths only (no leading /, no ..). Explain the change briefly outside the blocks. The preview page is index.html and may use local css/js files.',
    ].join('\n');
  }

  // The project as prompt context. Files beyond the budget are listed by name only.
  function filesContext(files, budget) {
    const max = budget || 60000;
    const names = Object.keys(files || {}).sort();
    if (!names.length) return '(the project has no files yet)';
    let used = 0;
    const parts = [];
    const skipped = [];
    for (const n of names) {
      const c = String(files[n]);
      if (used + c.length > max) { skipped.push(n + ' (' + c.length + ' chars)'); continue; }
      used += c.length;
      parts.push('--- ' + n + ' ---\n' + c);
    }
    if (skipped.length) parts.push('--- not shown (too large for this message; replace with FILE only if you know the content) ---\n' + skipped.join('\n'));
    return parts.join('\n\n');
  }

  // ---- preview ------------------------------------------------------------
  // Resolves ref the way a browser would from the page at `base` (a project
  // path such as 'site/index.html'; '' means a page at the root): relative to
  // that page's folder, or to the project root when it starts with '/'.
  // Returns the project path if that file exists, else null.
  function resolveRef(ref, files, base) {
    const clean = String(ref || '').split(/[?#]/)[0].trim().replace(/\\/g, '/');
    if (/^[a-z][a-z0-9+.-]*:|^\/\//i.test(clean)) return null; // external URL
    const parts = clean.startsWith('/') ? [] : String(base || '').split('/').slice(0, -1);
    for (const seg of clean.split('/')) {
      if (seg === '' || seg === '.') continue;
      if (seg === '..') { if (!parts.length) return null; parts.pop(); } // above the root
      else parts.push(seg);
    }
    const p = safePath(parts.join('/'));
    return p && Object.prototype.hasOwnProperty.call(files, p) ? p : null;
  }

  // Inlines <link rel=stylesheet href=local.css> and <script src=local.js> so a
  // multi-file project renders in a srcdoc iframe. External URLs are left alone.
  // htmlPath is the page's own project path (e.g. mainHtml(files)), so refs
  // resolve from its folder; omit it for a page at the root.
  function inlineAssets(html, files, htmlPath) {
    const f = files || {};
    const base = htmlPath || '';
    let out = String(html || '');
    out = out.replace(/<link\b[^>]*>/gi, (tag) => {
      if (!/rel\s*=\s*["']?stylesheet/i.test(tag)) return tag;
      const m = tag.match(/href\s*=\s*["']([^"']+)["']/i);
      const p = m && resolveRef(m[1], f, base);
      return p ? '<style data-src="' + p + '">\n' + String(f[p]).replace(/<\/style/gi, '<\\/style') + '\n</style>' : tag;
    });
    out = out.replace(/<script\b([^>]*)\bsrc\s*=\s*["']([^"']+)["']([^>]*)>\s*<\/script>/gi, (tag, pre, src, post) => {
      const p = resolveRef(src, f, base);
      if (!p) return tag;
      const attrs = (pre + post).replace(/\s+/g, ' ').trim();
      return '<script' + (attrs ? ' ' + attrs : '') + ' data-src="' + p + '">\n' + String(f[p]).replace(/<\/script/gi, '<\\/script') + '\n</script>';
    });
    return out;
  }

  // ---- zip (store method, UTF-8 names) ------------------------------------
  const CRC_TABLE = (function () {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();
  function crc32(bytes) {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }
  function utf8(s) {
    if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(s);
    return Uint8Array.from(Buffer.from(s, 'utf8'));
  }

  function zip(files, date) {
    const d = date || new Date();
    const dosTime = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
    const dosDate = ((Math.max(1980, d.getFullYear()) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
    const local = [];
    const central = [];
    let offset = 0;
    for (const name of Object.keys(files || {}).sort()) {
      const nameBytes = utf8(name);
      const data = utf8(String(files[name]));
      const crc = crc32(data);
      const lh = new DataView(new ArrayBuffer(30));
      lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true);
      lh.setUint16(8, 0, true); lh.setUint16(10, dosTime, true); lh.setUint16(12, dosDate, true);
      lh.setUint32(14, crc, true); lh.setUint32(18, data.length, true); lh.setUint32(22, data.length, true);
      lh.setUint16(26, nameBytes.length, true); lh.setUint16(28, 0, true);
      local.push(new Uint8Array(lh.buffer), nameBytes, data);
      const ch = new DataView(new ArrayBuffer(46));
      ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true);
      ch.setUint16(8, 0x0800, true); ch.setUint16(10, 0, true); ch.setUint16(12, dosTime, true);
      ch.setUint16(14, dosDate, true); ch.setUint32(16, crc, true); ch.setUint32(20, data.length, true);
      ch.setUint32(24, data.length, true); ch.setUint16(28, nameBytes.length, true);
      ch.setUint32(42, offset, true);
      central.push(new Uint8Array(ch.buffer), nameBytes);
      offset += 30 + nameBytes.length + data.length;
    }
    const cdSize = central.reduce((s, a) => s + a.length, 0);
    const end = new DataView(new ArrayBuffer(22));
    const count = central.length / 2;
    end.setUint32(0, 0x06054b50, true); end.setUint16(8, count, true); end.setUint16(10, count, true);
    end.setUint32(12, cdSize, true); end.setUint32(16, offset, true);
    const chunks = local.concat(central, [new Uint8Array(end.buffer)]);
    const total = chunks.reduce((s, a) => s + a.length, 0);
    const out = new Uint8Array(total);
    let p = 0;
    chunks.forEach((a) => { out.set(a, p); p += a.length; });
    return out;
  }

  // The file the preview shows: index.html, else the first .html file.
  function mainHtml(files) {
    const names = Object.keys(files || {});
    if (names.includes('index.html')) return 'index.html';
    return names.filter((n) => /\.html?$/i.test(n)).sort()[0] || null;
  }

  return { parseOps, applyOps, safePath, diffStat, protocolPrompt, filesContext, inlineAssets, zip, crc32, mainHtml, LIMITS };
});

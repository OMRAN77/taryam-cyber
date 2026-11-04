// Reads the files embedded in a PDF (the EmbeddedFiles name tree), so a lab report
// can be checked from its own bytes. Written for the files core/pdf.js produces:
// a classic PDF 1.4 body of "n 0 obj ... endobj" objects, streams with a direct
// /Length, one xref table and a trailer. Other PDFs are read when they follow the
// same plain structure (an indirect /Length is resolved, or found by searching for
// "endstream"); anything else is refused with a PdfReadError, never a crash.
//
// Objects are read in file order and stream data is skipped by its length, so bytes
// inside an attachment (which may look like PDF syntax) are never parsed. When an
// object number appears again (an incremental update), the later one wins.
const WS = new Set([0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20]);
const DELIMS = new Set([0x28, 0x29, 0x3c, 0x3e, 0x5b, 0x5d, 0x7b, 0x7d, 0x2f, 0x25]); // ()<>[]{}/%
const MAX_DEPTH = 64;
const MAX_OBJECTS = 1000000;

export class PdfReadError extends Error {
  constructor(code, ar, en, offset = null) {
    super(en);
    this.code = code;
    this.ar = ar;
    this.en = en;
    this.offset = offset;
  }
}

// What was wrong at that byte, in Arabic and English; {w} is the word found or
// expected (PDF syntax from the file, quoted as is).
const PROBLEMS = {
  expected: ['كان يُنتظر هنا "{w}"', '"{w}" expected'],
  integer: ['كان يُنتظر عدد صحيح', 'integer expected'],
  deep: ['التداخل أعمق من المسموح', 'nesting too deep'],
  eof: ['انتهى الملف قبل أوانه', 'unexpected end of file'],
  array: ['مصفوفة لم تُغلق', 'unterminated array'],
  word: ['كلمة غير متوقعة "{w}"', 'unexpected "{w}"'],
  char: ['حرف غير متوقع', 'unexpected character'],
  dict: ['قاموس لم يُغلق', 'unterminated dictionary'],
  key: ['مفتاح القاموس ليس اسمًا', 'dictionary key must be a name'],
  string: ['نص لم يُغلق', 'unterminated string'],
  hex: ['نص ست عشري غير صالح', 'bad hex string'],
  hexEnd: ['نص ست عشري لم يُغلق', 'unterminated hex string'],
  number: ['رقم غير صالح', 'bad number'],
  xref: ['جدول مواقع الكائنات (xref) غير صالح', 'bad xref table'],
  trailer: ['ذيل الملف (trailer) ليس قاموسًا', 'trailer is not a dictionary'],
  object: ['كان يُنتظر كائن', 'object expected'],
  streamDict: ['تدفق بيانات بلا قاموس', 'stream without a dictionary'],
  streamLength: ['طول تدفق البيانات لا يطابق الطول المذكور', 'stream length does not match'],
  streamEnd: ['تدفق بيانات لم يُغلق', 'unterminated stream'],
  objects: ['عدد الكائنات أكبر من الحد', 'too many objects'],
};
const malformed = (pos, problem, w = '') => {
  const [ar, en] = PROBLEMS[problem].map((t) => t.replace('{w}', () => w));
  return new PdfReadError('malformed',
    `تعذّرت قراءة بنية ملف الـPDF عند البايت ${pos} (${ar}). الملف تالف أو ليس من النوع الذي يكتبه المختبر.`,
    `Could not read the PDF structure at byte ${pos} (${en}). The file is damaged or not of the kind the lab writes.`, pos);
};

export class PdfName { constructor(name) { this.name = name; } }
export class PdfString { constructor(bytes) { this.bytes = bytes; } }
export class PdfRef { constructor(num, gen) { this.num = num; this.gen = gen; } }

const isDigit = (c) => c >= 0x30 && c <= 0x39;
const isRegular = (c) => c !== undefined && !WS.has(c) && !DELIMS.has(c);

export function indexOfBytes(bytes, pattern, from = 0) {
  const first = pattern[0], last = bytes.length - pattern.length;
  outer: for (let i = bytes.indexOf(first, from); i !== -1 && i <= last; i = bytes.indexOf(first, i + 1)) {
    for (let j = 1; j < pattern.length; j++) if (bytes[i + j] !== pattern[j]) continue outer;
    return i;
  }
  return -1;
}
const ascii = (s) => Uint8Array.from(s, (c) => c.charCodeAt(0));
function latin1(b) {
  let out = '';
  for (let i = 0; i < b.length; i += 8192) out += String.fromCharCode(...b.subarray(i, i + 8192));
  return out;
}
const ENDSTREAM = ascii('endstream');

class Parser {
  constructor(bytes) {
    this.b = bytes;
    this.pos = 0;
  }

  skipWs() {
    const b = this.b;
    for (;;) {
      while (this.pos < b.length && WS.has(b[this.pos])) this.pos++;
      if (b[this.pos] !== 0x25) return; // '%' comment to end of line
      while (this.pos < b.length && b[this.pos] !== 0x0a && b[this.pos] !== 0x0d) this.pos++;
    }
  }

  // A run of regular characters (a keyword or number) without consuming it; at most
  // 64 are looked at, more than any keyword or number the reader accepts.
  peekWord() {
    let end = this.pos;
    while (end < this.b.length && end < this.pos + 64 && isRegular(this.b[end])) end++;
    return latin1(this.b.subarray(this.pos, end));
  }

  word() {
    const w = this.peekWord();
    this.pos += w.length;
    return w;
  }

  expectWord(w) {
    this.skipWs();
    const at = this.pos;
    if (this.word() !== w) throw malformed(at, 'expected', w);
  }

  integer() {
    this.skipWs();
    const at = this.pos;
    const w = this.word();
    if (!/^\d{1,15}$/.test(w)) throw malformed(at, 'integer');
    return Number(w);
  }

  value(depth = 0) {
    if (depth > MAX_DEPTH) throw malformed(this.pos, 'deep');
    this.skipWs();
    const b = this.b, at = this.pos, c = b[at];
    if (c === undefined) throw malformed(at, 'eof');
    if (c === 0x2f) return this.name();
    if (c === 0x28) return this.literalString();
    if (c === 0x3c && b[at + 1] === 0x3c) return this.dict(depth);
    if (c === 0x3c) return this.hexString();
    if (c === 0x5b) {
      this.pos++;
      const arr = [];
      for (;;) {
        this.skipWs();
        if (this.pos >= b.length) throw malformed(at, 'array');
        if (b[this.pos] === 0x5d) { this.pos++; return arr; }
        arr.push(this.value(depth + 1));
      }
    }
    if (isDigit(c) || c === 0x2b || c === 0x2d || c === 0x2e) return this.numberOrRef();
    const w = this.word();
    if (w === 'true') return true;
    if (w === 'false') return false;
    if (w === 'null') return null;
    throw (w ? malformed(at, 'word', w) : malformed(at, 'char'));
  }

  dict(depth) {
    const at = this.pos;
    this.pos += 2;
    const d = new Map();
    for (;;) {
      this.skipWs();
      if (this.pos >= this.b.length) throw malformed(at, 'dict');
      if (this.b[this.pos] === 0x3e && this.b[this.pos + 1] === 0x3e) { this.pos += 2; return d; }
      const key = this.value(depth + 1);
      if (!(key instanceof PdfName)) throw malformed(this.pos, 'key');
      d.set(key.name, this.value(depth + 1));
    }
  }

  name() {
    const b = this.b;
    this.pos++;
    const out = [];
    while (this.pos < b.length && isRegular(b[this.pos])) {
      if (b[this.pos] === 0x23 && /^[0-9a-f]{2}$/i.test(String.fromCharCode(b[this.pos + 1], b[this.pos + 2]))) {
        out.push(parseInt(String.fromCharCode(b[this.pos + 1], b[this.pos + 2]), 16));
        this.pos += 3;
      } else out.push(b[this.pos++]);
    }
    return new PdfName(new TextDecoder().decode(Uint8Array.from(out)));
  }

  literalString() {
    const b = this.b, at = this.pos;
    this.pos++;
    const out = [];
    let level = 1;
    while (this.pos < b.length) {
      const c = b[this.pos++];
      if (c === 0x5c) { // backslash
        const e = b[this.pos++];
        const simple = { 0x6e: 10, 0x72: 13, 0x74: 9, 0x62: 8, 0x66: 12, 0x28: 0x28, 0x29: 0x29, 0x5c: 0x5c };
        if (e in simple) out.push(simple[e]);
        else if (e >= 0x30 && e <= 0x37) {
          let v = e - 0x30;
          for (let k = 0; k < 2 && b[this.pos] >= 0x30 && b[this.pos] <= 0x37; k++) v = v * 8 + (b[this.pos++] - 0x30);
          out.push(v & 255);
        } else if (e === 0x0d) { if (b[this.pos] === 0x0a) this.pos++; } // line continuation
        else if (e !== 0x0a && e !== undefined) out.push(e);
        continue;
      }
      if (c === 0x28) level++;
      if (c === 0x29 && --level === 0) return new PdfString(Uint8Array.from(out));
      out.push(c);
    }
    throw malformed(at, 'string');
  }

  hexString() {
    const b = this.b, at = this.pos;
    this.pos++;
    let hex = '';
    while (this.pos < b.length && b[this.pos] !== 0x3e) {
      const c = b[this.pos++];
      if (WS.has(c)) continue;
      const ch = String.fromCharCode(c);
      if (!/[0-9a-f]/i.test(ch)) throw malformed(this.pos - 1, 'hex');
      hex += ch;
    }
    if (this.pos >= b.length) throw malformed(at, 'hexEnd');
    this.pos++;
    if (hex.length % 2) hex += '0';
    return new PdfString(Uint8Array.from(hex.match(/../g) || [], (h) => parseInt(h, 16)));
  }

  numberOrRef() {
    const at = this.pos;
    const w = this.word();
    if (!/^[+-]?(\d+\.?\d*|\.\d+)$/.test(w)) throw malformed(at, 'number');
    if (/^\d+$/.test(w)) {
      // "n g R" is a reference.
      const save = this.pos;
      this.skipWs();
      const g = this.peekWord();
      if (/^\d+$/.test(g)) {
        this.pos += g.length;
        this.skipWs();
        if (this.peekWord() === 'R') { this.pos++; return new PdfRef(Number(w), Number(g)); }
      }
      this.pos = save;
    }
    return Number(w);
  }
}

// Text strings: UTF-16BE with a byte-order mark, UTF-8 with one (PDF 2.0), or
// PDFDocEncoding, which matches Latin-1 for the characters that matter here.
export function decodeTextString(s) {
  if (!(s instanceof PdfString)) return null;
  const b = s.bytes;
  if (b[0] === 0xfe && b[1] === 0xff) {
    let out = '';
    for (let i = 2; i + 1 < b.length; i += 2) out += String.fromCharCode((b[i] << 8) | b[i + 1]);
    return out;
  }
  if (b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) return new TextDecoder().decode(b.subarray(3));
  return latin1(b);
}

function readBody(bytes, start) {
  const p = new Parser(bytes);
  p.pos = start;
  const objects = new Map();
  let trailer = null, seenEnd = false;
  const problems = [];
  for (;;) {
    p.skipWs();
    if (p.pos >= bytes.length) break;
    const at = p.pos;
    try {
      const w = p.peekWord();
      if (w === 'xref') {
        p.word();
        // Subsection headers and 20-byte entries; only the trailer after them matters.
        for (;;) {
          p.skipWs();
          const t = p.peekWord();
          if (t === 'trailer' || p.pos >= bytes.length) break;
          if (!/^(\d+|f|n)$/.test(t)) throw malformed(p.pos, 'xref');
          p.word();
        }
        continue;
      }
      if (w === 'trailer') {
        p.word();
        const d = p.value();
        if (!(d instanceof Map)) throw malformed(at, 'trailer');
        trailer = d;
        continue;
      }
      if (w === 'startxref') {
        p.word();
        p.integer();
        seenEnd = true;
        continue;
      }
      if (!/^\d+$/.test(w)) throw malformed(at, 'object');
      const num = p.integer(), gen = p.integer();
      p.expectWord('obj');
      const value = p.value();
      p.skipWs();
      let stream = null;
      if (p.peekWord() === 'stream') {
        if (!(value instanceof Map)) throw malformed(p.pos, 'streamDict');
        p.pos += 6;
        if (bytes[p.pos] === 0x0d) p.pos++;
        if (bytes[p.pos] === 0x0a) p.pos++;
        const start = p.pos;
        let length = value.get('Length'), source = 'direct';
        if (length instanceof PdfRef) {
          const target = objects.get(length.num);
          length = target && typeof target.value === 'number' ? target.value : null;
          source = 'reference';
        }
        let end = Number.isInteger(length) && length >= 0 && start + length <= bytes.length ? start + length : -1;
        if (end >= 0) {
          p.pos = end;
          p.skipWs();
          if (p.peekWord() !== 'endstream') end = -1;
        }
        if (end < 0) {
          // No usable length: the data ends at the next "endstream" (minus its EOL).
          if (source === 'direct' && Number.isInteger(length)) throw malformed(start, 'streamLength');
          const found = indexOfBytes(bytes, ENDSTREAM, start);
          if (found < 0) throw malformed(start, 'streamEnd');
          end = found;
          if (bytes[end - 1] === 0x0a) end--;
          if (bytes[end - 1] === 0x0d) end--;
          end = Math.max(start, end);
          source = 'search';
          p.pos = found;
        }
        p.expectWord('endstream');
        stream = { dict: value, offset: start, length: end - start, lengthSource: source };
      }
      p.expectWord('endobj');
      if (objects.size >= MAX_OBJECTS && !objects.has(num)) throw malformed(at, 'objects');
      objects.set(num, { num, gen, value, stream, offset: at });
    } catch (e) {
      // Bytes after the end of a complete file (e.g. added by a mail gateway) are
      // reported, not fatal: the signature checks will show the file changed.
      if (seenEnd && e instanceof PdfReadError) { problems.push({ code: 'trailing-data', offset: at }); break; }
      throw e;
    }
  }
  return { objects, trailer, problems };
}

// Reads every embedded file. Returns { version, attachments, problems }, where each
// attachment is { name, key, data, offset, length, mime, declaredSize, description,
// encoded }: data is a view of the stream bytes (encoded: true when a /Filter is set,
// i.e. compressed, which the lab never writes) and offset is where they start in
// the file.
export function readPdfAttachments(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const head = latin1(bytes.subarray(0, 1024));
  const h = head.indexOf('%PDF-');
  if (h < 0) throw new PdfReadError('not-pdf', 'الملف ليس PDF', 'The file is not a PDF');
  const version = (/^%PDF-(\d\.\d)/.exec(head.slice(h)) || [])[1] || '?';
  const { objects, trailer, problems } = readBody(bytes, h);

  const entry = (v) => (v instanceof PdfRef ? objects.get(v.num) || null : null);
  const resolve = (v) => (v instanceof PdfRef ? (entry(v) ? entry(v).value : null) : v);
  let root = trailer ? resolve(trailer.get('Root')) : null;
  if (!(root instanceof Map)) {
    for (const o of objects.values()) if (o.value instanceof Map && o.value.get('Type') instanceof PdfName && o.value.get('Type').name === 'Catalog') root = o.value;
  }
  if (!(root instanceof Map)) throw new PdfReadError('no-catalog', 'ملف الـPDF بلا فهرس (Catalog)', 'The PDF has no catalog');

  const names = resolve(root.get('Names'));
  const tree = names instanceof Map ? resolve(names.get('EmbeddedFiles')) : null;
  const pairs = [];
  const seen = new Set();
  const walk = (node, depth) => {
    if (!(node instanceof Map) || depth > 32 || seen.has(node)) return;
    seen.add(node);
    const arr = resolve(node.get('Names'));
    if (Array.isArray(arr)) for (let i = 0; i + 1 < arr.length; i += 2) pairs.push([arr[i], arr[i + 1]]);
    const kids = resolve(node.get('Kids'));
    if (Array.isArray(kids)) for (const k of kids) walk(resolve(k), depth + 1);
  };
  walk(tree, 0);

  const attachments = [];
  for (const [key, specRef] of pairs) {
    const spec = resolve(specRef);
    if (!(spec instanceof Map)) continue;
    const ef = resolve(spec.get('EF'));
    const fileEntry = ef instanceof Map ? entry(ef.get('UF')) || entry(ef.get('F')) : null;
    if (!fileEntry || !fileEntry.stream) continue;
    const s = fileEntry.stream;
    const filter = resolve(s.dict.get('Filter'));
    const params = resolve(s.dict.get('Params'));
    const subtype = s.dict.get('Subtype');
    attachments.push({
      name: decodeTextString(resolve(spec.get('UF'))) || decodeTextString(resolve(spec.get('F'))) || decodeTextString(key) || '',
      key: decodeTextString(key),
      data: bytes.subarray(s.offset, s.offset + s.length),
      offset: s.offset,
      length: s.length,
      lengthSource: s.lengthSource,
      mime: subtype instanceof PdfName ? subtype.name : null,
      declaredSize: params instanceof Map && typeof params.get('Size') === 'number' ? params.get('Size') : null,
      description: decodeTextString(resolve(spec.get('Desc'))),
      encoded: filter !== null && filter !== undefined && !(Array.isArray(filter) && filter.length === 0),
    });
  }
  return { version, attachments, problems, objectCount: objects.size };
}

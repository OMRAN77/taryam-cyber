// Minimal PDF 1.4 writer with no dependencies. Pages are a full-page JPEG (the
// report page drawn on a canvas, so Arabic is shaped by the browser) and/or real
// text in the standard Helvetica / Courier fonts (ASCII only). Files can be
// attached, so the PDF carries the exact input data it describes.
const enc = new TextEncoder();
export const A4 = { width: 595.28, height: 841.89 };

function pdfString(s) {
  // ASCII literal string; anything else becomes '?'.
  return '(' + String(s).replace(/[^\x20-\x7e]/g, '?').replace(/[\\()]/g, (c) => '\\' + c) + ')';
}

function textString(s) {
  // Document-info text: UTF-16BE with BOM, as a hex string.
  let hex = 'FEFF';
  for (const ch of String(s)) {
    const cp = ch.codePointAt(0);
    const units = cp > 0xffff ? [0xd800 + ((cp - 0x10000) >> 10), 0xdc00 + ((cp - 0x10000) & 0x3ff)] : [cp];
    for (const u of units) hex += u.toString(16).padStart(4, '0').toUpperCase();
  }
  return '<' + hex + '>';
}

function pdfDate(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `D:${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

export class PdfBuilder {
  constructor(info = {}) {
    this.info = info;
    this.objects = []; // { body: Uint8Array[] }
    this.pages = [];
    this.files = [];
    this.catalog = this.reserve();
    this.pagesObj = this.reserve();
    this.fonts = {
      F1: this.add(`<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>`),
      F2: this.add(`<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>`),
      F3: this.add(`<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>`),
    };
  }

  reserve() { this.objects.push(null); return this.objects.length; }

  set(id, ...parts) { this.objects[id - 1] = parts.map((p) => (typeof p === 'string' ? enc.encode(p) : p)); return id; }

  add(...parts) { return this.set(this.reserve(), ...parts); }

  stream(dict, bytes) {
    return this.add(`<< ${dict} /Length ${bytes.length} >>\nstream\n`, bytes, '\nendstream');
  }

  // lines: [{ text, x, y, size = 9, font = 'F3' }] in PDF points from the bottom-left.
  addPage({ jpeg = null, pixelWidth = 0, pixelHeight = 0, lines = [] } = {}) {
    let content = '';
    let xobjects = '';
    if (jpeg) {
      const img = this.stream(`/Type /XObject /Subtype /Image /Width ${pixelWidth} /Height ${pixelHeight} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode`, jpeg);
      xobjects = `/XObject << /Im0 ${img} 0 R >>`;
      content += `q ${A4.width} 0 0 ${A4.height} 0 0 cm /Im0 Do Q\n`;
    }
    for (const l of lines) {
      content += `BT /${l.font || 'F3'} ${l.size || 9} Tf ${l.x.toFixed(2)} ${l.y.toFixed(2)} Td ${pdfString(l.text)} Tj ET\n`;
    }
    const contents = this.stream('', enc.encode(content));
    const fonts = Object.entries(this.fonts).map(([k, v]) => `/${k} ${v} 0 R`).join(' ');
    const page = this.add(`<< /Type /Page /Parent ${this.pagesObj} 0 R /MediaBox [0 0 ${A4.width} ${A4.height}] /Resources << /Font << ${fonts} >> ${xobjects} >> /Contents ${contents} 0 R >>`);
    this.pages.push(page);
    return page;
  }

  // Returns the id of the embedded-file stream (see dataOffset).
  attach(name, bytes, { mime = 'application/octet-stream', description = '' } = {}) {
    const subtype = mime.replace('/', '#2F');
    const ef = this.stream(`/Type /EmbeddedFile /Subtype /${subtype} /Params << /Size ${bytes.length} >>`, bytes);
    const spec = this.add(`<< /Type /Filespec /F ${pdfString(name)} /UF ${textString(name)} /EF << /F ${ef} 0 R >> /Desc ${textString(description)} >>`);
    this.files.push({ name, spec });
    return ef;
  }

  // Where the data of stream object `id` starts in the output of the last build().
  dataOffset(id) {
    return this.objectOffsets[id - 1] + `${id} 0 obj\n`.length + this.objects[id - 1][0].length;
  }

  build() {
    this.set(this.pagesObj, `<< /Type /Pages /Kids [${this.pages.map((p) => p + ' 0 R').join(' ')}] /Count ${this.pages.length} >>`);
    let names = '';
    if (this.files.length) {
      const sorted = [...this.files].sort((a, b) => (a.name < b.name ? -1 : 1));
      const tree = this.add(`<< /Names [${sorted.map((f) => pdfString(f.name) + ' ' + f.spec + ' 0 R').join(' ')}] >>`);
      names = ` /Names << /EmbeddedFiles ${tree} 0 R >>`;
    }
    this.set(this.catalog, `<< /Type /Catalog /Pages ${this.pagesObj} 0 R${names} >>`);
    const i = this.info;
    const infoParts = [];
    for (const k of ['Title', 'Subject', 'Author', 'Keywords', 'Creator']) if (i[k.toLowerCase()]) infoParts.push(`/${k} ${textString(i[k.toLowerCase()])}`);
    infoParts.push(`/Producer ${pdfString('TARYAM RTP Lab')}`);
    infoParts.push(`/CreationDate ${pdfString(pdfDate(i.creationDate || new Date()))}`);
    const info = this.add(`<< ${infoParts.join(' ')} >>`);

    const chunks = [enc.encode('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n')];
    let offset = chunks[0].length;
    const offsets = [];
    this.objects.forEach((parts, idx) => {
      offsets.push(offset);
      const head = enc.encode(`${idx + 1} 0 obj\n`), tail = enc.encode('\nendobj\n');
      chunks.push(head, ...parts, tail);
      offset += head.length + parts.reduce((a, p) => a + p.length, 0) + tail.length;
    });
    this.objectOffsets = offsets;
    const xref = offset;
    let x = `xref\n0 ${this.objects.length + 1}\n0000000000 65535 f \n`;
    for (const o of offsets) x += String(o).padStart(10, '0') + ' 00000 n \n';
    const id = (i.id || '0'.repeat(32)).slice(0, 32);
    x += `trailer\n<< /Size ${this.objects.length + 1} /Root ${this.catalog} 0 R /Info ${info} 0 R /ID [<${id}> <${id}>] >>\nstartxref\n${xref}\n%%EOF\n`;
    chunks.push(enc.encode(x));
    const out = new Uint8Array(chunks.reduce((a, c) => a + c.length, 0));
    let p = 0;
    for (const c of chunks) { out.set(c, p); p += c.length; }
    return out;
  }
}

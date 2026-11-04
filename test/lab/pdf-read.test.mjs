// Reading embedded files back out of PDFs (lab/core/pdf-read.js). The expected
// bytes are the original arrays handed to the writer; offsets are cross-checked
// against the writer's own bookkeeping (PdfBuilder.dataOffset), a second,
// independent computation; the hand-written PDF's values are read off by hand.
import test from 'node:test';
import assert from 'node:assert';
import { PdfBuilder } from '../../lab/core/pdf.js';
import { readPdfAttachments, PdfReadError } from '../../lab/core/pdf-read.js';
import { Xoshiro128ss } from '../../lab/core/prng.js';

const enc = new TextEncoder();
const latin1 = (s) => Uint8Array.from(s, (c) => c.charCodeAt(0));
const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};

// Bytes that look like PDF syntax, so a reader that scanned stream data would trip.
const TRAPS = latin1('\nendstream\nendobj\n9 0 obj\n<< /Type /Catalog >>\ntrailer\n<< /Root 9 0 R >>\nstartxref\n0\n%%EOF\n(unbalanced \\');

function samplePdf() {
  const allBytes = new Uint8Array(256 * 4);
  for (let i = 0; i < allBytes.length; i++) allBytes[i] = i & 255;
  const inner = new PdfBuilder();
  inner.addPage({ lines: [{ text: 'inner', x: 40, y: 800 }] });
  inner.attach('report.json', enc.encode('{"inner":true}'));
  const files = [
    { name: 'report.json', bytes: enc.encode('{"format":"taryam-rtp-lab-report/1","x":1}'), mime: 'application/json' },
    { name: 'all-bytes.bin', bytes: concat(allBytes, TRAPS, allBytes) },
    { name: 'empty.txt', bytes: new Uint8Array(0), mime: 'text/plain' },
    { name: 'نموذج عربي.json', bytes: enc.encode('{"name":"صحراء"}'), mime: 'application/json' },
    { name: 'a (b) \\ c.csv', bytes: enc.encode('bet,win\n1,0\n'), mime: 'text/csv' },
    { name: 'nested.pdf', bytes: inner.build(), mime: 'application/pdf' },
  ];
  const pdf = new PdfBuilder({ title: 'test' });
  pdf.addPage({ lines: [{ text: 'page one', x: 40, y: 800 }] });
  pdf.addPage({ jpeg: concat(Uint8Array.of(0xff, 0xd8), TRAPS, Uint8Array.of(0xff, 0xd9)), pixelWidth: 2, pixelHeight: 2 });
  const ids = files.map((f) => pdf.attach(f.name, f.bytes, { mime: f.mime || 'application/octet-stream', description: 'd ' + f.name }));
  const bytes = pdf.build();
  return { bytes, files, offsets: ids.map((id) => pdf.dataOffset(id)) };
}

test('reads every attachment of a lab PDF: names, exact bytes (binary included) and offsets', () => {
  const { bytes, files, offsets } = samplePdf();
  const r = readPdfAttachments(bytes);
  assert.strictEqual(r.version, '1.4');
  assert.deepStrictEqual(r.problems, []);
  assert.strictEqual(r.attachments.length, files.length);
  files.forEach((f, i) => {
    const a = r.attachments.find((x) => x.name === f.name);
    assert.ok(a, 'attachment ' + f.name);
    assert.deepStrictEqual(a.data, f.bytes, 'bytes of ' + f.name);
    assert.strictEqual(a.length, f.bytes.length);
    assert.strictEqual(a.declaredSize, f.bytes.length);
    assert.strictEqual(a.offset, offsets[i], 'offset of ' + f.name + ' (writer vs reader)');
    assert.deepStrictEqual(bytes.subarray(a.offset, a.offset + a.length), f.bytes);
    assert.strictEqual(a.mime, f.mime || 'application/octet-stream');
    assert.strictEqual(a.description, 'd ' + f.name);
    assert.strictEqual(a.encoded, false);
  });
  // The Arabic name is kept in /UF; the ASCII-only /F and tree key carry '?'.
  assert.strictEqual(r.attachments.find((x) => x.name === 'نموذج عربي.json').key, '????? ????.json');
  // The nested PDF is just data: its own report.json is not mistaken for ours.
  assert.strictEqual(r.attachments.filter((x) => x.name === 'report.json').length, 1);
  assert.deepStrictEqual(readPdfAttachments(r.attachments.find((x) => x.name === 'nested.pdf').data).attachments.map((a) => a.name), ['report.json']);
});

test('a PDF from another writer: CRLF, comments, name-tree kids, hex keys, indirect and missing lengths, compression', () => {
  // Hand-written. abc.txt's /Length points at an object defined later, so its end
  // is found by searching for "endstream": the data is "Hello, world" (12 bytes).
  // early.txt's /Length points at object 11 (= 5), already read: "ABCDE".
  // packed.bin is FlateDecode-compressed (4 bytes as stored) and must be flagged.
  const utf16 = (s) => '<FEFF' + [...s].map((c) => c.charCodeAt(0).toString(16).padStart(4, '0')).join('') + '>';
  const src = [
    '%PDF-1.7\r\n%\xe2\xe3\xcf\xd3\r\n',
    '1 0 obj\r\n<< /Type /Catalog % the catalog\r\n /Pages 2 0 R /Names << /EmbeddedFiles 3 0 R >> >>\r\nendobj\r\n',
    '2 0 obj\r\n<< /Type /Pages /Kids [] /Count 0 >>\r\nendobj\r\n',
    '11 0 obj\r\n5\r\nendobj\r\n',
    '3 0 obj\r\n<< /Kids [4 0 R 10 0 R] >>\r\nendobj\r\n',
    '4 0 obj\r\n<< /Limits [<6162> (p)] /Names [<6162632E747874> 5 0 R (packed.bin) 7 0 R] >>\r\nendobj\r\n',
    '5 0 obj\r\n<< /Type /Filespec /F (abc.txt) /EF << /F 6 0 R >> >>\r\nendobj\r\n',
    '6 0 obj\r\n<< /Type /EmbeddedFile /Length 9 0 R >>\r\nstream\r\nHello, world\r\nendstream\r\nendobj\r\n',
    `7 0 obj\r\n<< /Type /Filespec /F (x) /UF ${utf16('packed.bin')} /EF << /F 8 0 R >> >>\r\nendobj\r\n`,
    '8 0 obj\r\n<< /Type /EmbeddedFile /Filter /FlateDecode /Length 4 >>\r\nstream\r\n\x78\x9c\x03\x00\r\nendstream\r\nendobj\r\n',
    '9 0 obj\r\n12\r\nendobj\r\n',
    '10 0 obj\r\n<< /Names [(early.txt) 12 0 R] >>\r\nendobj\r\n',
    '12 0 obj\r\n<< /Type /Filespec /F (early.txt) /EF << /F 13 0 R >> >>\r\nendobj\r\n',
    '13 0 obj\r\n<< /Type /EmbeddedFile /Length 11 0 R >>\r\nstream\r\nABCDE\r\nendstream\r\nendobj\r\n',
    'trailer\r\n<< /Root 1 0 R /Size 14 >>\r\nstartxref\r\n0\r\n%%EOF\r\n',
  ].join('');
  const r = readPdfAttachments(latin1(src));
  assert.strictEqual(r.version, '1.7');
  const by = Object.fromEntries(r.attachments.map((a) => [a.name, a]));
  assert.deepStrictEqual(Object.keys(by).sort(), ['abc.txt', 'early.txt', 'packed.bin']);
  assert.strictEqual(new TextDecoder().decode(by['abc.txt'].data), 'Hello, world');
  assert.strictEqual(by['abc.txt'].lengthSource, 'search');
  assert.strictEqual(new TextDecoder().decode(by['early.txt'].data), 'ABCDE');
  assert.strictEqual(by['early.txt'].lengthSource, 'reference');
  assert.strictEqual(by['packed.bin'].encoded, true);
  assert.strictEqual(by['packed.bin'].length, 4);
});

test('anything else is refused with a PdfReadError, never a crash', () => {
  const refuse = (bytes, code) => assert.throws(() => readPdfAttachments(bytes), (e) => e instanceof PdfReadError && (!code || e.code === code) && Boolean(e.ar && e.en));
  refuse(new Uint8Array(0), 'not-pdf');
  refuse(enc.encode('bet,win\n1,0\n'), 'not-pdf');
  refuse(Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a), 'not-pdf');
  refuse(latin1('%PDF-1.4\n1 0 obj\n<< /Type /Catalog'), 'malformed');
  refuse(latin1('%PDF-1.4\nhello world\n'), 'malformed');
  refuse(latin1('%PDF-1.4\n1 0 obj\n' + '['.repeat(500) + '\nendobj\n'), 'malformed');
  refuse(latin1('%PDF-1.4\n1 0 obj\n<< /Length 5 >>\nstream\nab\nendstream\nendobj\n'), 'malformed');
  refuse(latin1('%PDF-1.4\n1 0 obj\n<< /Type /Pages >>\nendobj\ntrailer\n<< /Size 2 >>\n'), 'no-catalog');
  // A complete PDF without attachments reads fine, with none found.
  const plain = new PdfBuilder();
  plain.addPage({ lines: [{ text: 'no files', x: 40, y: 800 }] });
  assert.deepStrictEqual(readPdfAttachments(plain.build()).attachments, []);

  // Cut short inside an attachment: refused.
  const { bytes, files, offsets } = samplePdf();
  const cut = offsets[1] + Math.floor(files[1].bytes.length / 2);
  refuse(bytes.slice(0, cut), 'malformed');
  // Bytes appended after %%EOF (e.g. by a mail gateway) are reported, not fatal.
  const tail = readPdfAttachments(concat(bytes, enc.encode('\r\n-- appended footer --\r\n')));
  assert.strictEqual(tail.attachments.length, files.length);
  assert.strictEqual(tail.problems[0].code, 'trailing-data');
});

test('fuzz: 600 damaged copies of a report PDF either read or are refused cleanly', () => {
  const { bytes } = samplePdf();
  const rng = new Xoshiro128ss(0x5eed, 0x7a17, 0x0b0b, 0x1234);
  let read = 0, refused = 0;
  for (let n = 0; n < 600; n++) {
    let b = bytes.slice();
    const kind = n % 3;
    if (kind === 0) for (let k = 0, m = 1 + rng.nextBelow(4); k < m; k++) b[rng.nextBelow(b.length)] ^= 1 + rng.nextBelow(255);
    else if (kind === 1) { const at = rng.nextBelow(b.length); b = concat(b.subarray(0, at), b.subarray(Math.min(b.length, at + 1 + rng.nextBelow(40)))); }
    else { const at = rng.nextBelow(b.length); b = concat(b.subarray(0, at), latin1(['(', ')', '<<', '>>', '[', '%', 'endobj', '7 0 R', '\\'][rng.nextBelow(9)]), b.subarray(at)); }
    try { readPdfAttachments(b); read++; } catch (e) {
      assert.ok(e instanceof PdfReadError, `copy ${n}: ${e && e.stack}`);
      refused++;
    }
  }
  assert.strictEqual(read + refused, 600);
  assert.ok(refused > 0 && read > 0, `read ${read}, refused ${refused}`);
});

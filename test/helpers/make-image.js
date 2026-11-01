'use strict';
// Synthesize tiny but byte-accurate test images (TIFF/EXIF stream wrapped in
// JPEG, or a PNG with chunks) so metadata tests have known expected values and
// need no binary fixtures. Shared by the EXIF unit tests and the browser test.
//
// entries: [{ tag, type, values }]
//   type 2 = ASCII (values: string), 3 = SHORT (number[]), 4 = LONG (number[]),
//   5 = RATIONAL (Array<[num, den]>).

const SIZE = { 2: 1, 3: 2, 4: 4, 5: 8 };

function entryByteLen(e) {
  if (e.type === 2) return e.values.length + 1;
  return e.values.length * SIZE[e.type];
}
function entryCount(e) {
  if (e.type === 2) return e.values.length + 1;
  return e.values.length;
}

function buildTiff(opts) {
  const little = !!opts.little;
  const ifd0 = (opts.ifd0 || []).slice();
  const exifEntries = opts.exif ? opts.exif.slice() : null;
  const gpsEntries = opts.gps ? opts.gps.slice() : null;
  const ifdLen = (list) => 2 + 12 * list.length + 4;

  const ifd0Base = 8;
  const ifd0Count = ifd0.length + (exifEntries ? 1 : 0) + (gpsEntries ? 1 : 0);
  const ifd0Size = 2 + 12 * ifd0Count + 4;
  const exifOffset = exifEntries ? ifd0Base + ifd0Size : 0;
  const exifSize = exifEntries ? ifdLen(exifEntries) : 0;
  const gpsOffset = gpsEntries ? ifd0Base + ifd0Size + exifSize : 0;
  const gpsSize = gpsEntries ? ifdLen(gpsEntries) : 0;
  const dataStart = ifd0Base + ifd0Size + exifSize + gpsSize;

  const buf = Buffer.alloc(dataStart + 4096);
  const w16 = (o, v) => little ? buf.writeUInt16LE(v, o) : buf.writeUInt16BE(v, o);
  const w32 = (o, v) => little ? buf.writeUInt32LE(v >>> 0, o) : buf.writeUInt32BE(v >>> 0, o);

  if (little) { buf[0] = 0x49; buf[1] = 0x49; } else { buf[0] = 0x4d; buf[1] = 0x4d; }
  w16(2, 42);
  w32(4, ifd0Base);

  let dataCursor = dataStart;

  function writeEntryValue(fieldOff, e) {
    const total = entryByteLen(e);
    const at = total <= 4 ? fieldOff : dataCursor;
    if (total > 4) w32(fieldOff, dataCursor);
    if (e.type === 2) {
      for (let i = 0; i < e.values.length; i++) buf[at + i] = e.values.charCodeAt(i) & 0xff;
      buf[at + e.values.length] = 0;
    } else if (e.type === 3) {
      e.values.forEach((v, i) => w16(at + i * 2, v));
    } else if (e.type === 4) {
      e.values.forEach((v, i) => w32(at + i * 4, v));
    } else if (e.type === 5) {
      e.values.forEach((pair, i) => { w32(at + i * 8, pair[0]); w32(at + i * 8 + 4, pair[1]); });
    }
    if (total > 4) dataCursor += total;
  }

  function writeIFD(off, list, pointerEntries) {
    const all = list.slice();
    if (pointerEntries) pointerEntries.forEach((pe) => all.push(pe));
    w16(off, all.length);
    let p = off + 2;
    for (const e of all) {
      w16(p, e.tag);
      w16(p + 2, e.type);
      w32(p + 4, entryCount(e));
      writeEntryValue(p + 8, e);
      p += 12;
    }
    w32(p, 0);
  }

  const ptrEntries = [];
  if (exifEntries) ptrEntries.push({ tag: 0x8769, type: 4, values: [exifOffset] });
  if (gpsEntries) ptrEntries.push({ tag: 0x8825, type: 4, values: [gpsOffset] });

  writeIFD(ifd0Base, ifd0, ptrEntries);
  if (exifEntries) writeIFD(exifOffset, exifEntries, null);
  if (gpsEntries) writeIFD(gpsOffset, gpsEntries, null);

  return buf.subarray(0, dataCursor);
}

function wrapJpeg(tiff, dims) {
  const parts = [Buffer.from([0xff, 0xd8])];
  const header = Buffer.from('Exif\0\0', 'latin1');
  const segLen = 2 + header.length + tiff.length;
  const app1 = Buffer.alloc(4 + header.length);
  app1[0] = 0xff; app1[1] = 0xe1;
  app1.writeUInt16BE(segLen, 2);
  header.copy(app1, 4);
  parts.push(app1, Buffer.from(tiff));
  if (dims) {
    const sof = Buffer.alloc(2 + 2 + 6);
    sof[0] = 0xff; sof[1] = 0xc0;
    sof.writeUInt16BE(8 + 3, 2);
    sof[4] = 8;
    sof.writeUInt16BE(dims.height, 5);
    sof.writeUInt16BE(dims.width, 7);
    sof[9] = 1;
    parts.push(sof, Buffer.from([0x01, 0x11, 0x00]));
  }
  parts.push(Buffer.from([0xff, 0xd9]));
  return Buffer.concat(parts);
}

function pngChunk(type, data) {
  const b = Buffer.alloc(8 + data.length + 4);
  b.writeUInt32BE(data.length, 0);
  b.write(type, 4, 'latin1');
  data.copy(b, 8);
  b.writeUInt32BE(0, 8 + data.length); // CRC not validated by the parser
  return b;
}

function buildPng(opts) {
  opts = opts || {};
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(opts.width || 1, 0);
  ihdr.writeUInt32BE(opts.height || 1, 4);
  ihdr[8] = opts.bitDepth || 8;
  ihdr[9] = opts.colorType == null ? 6 : opts.colorType;
  const chunks = [sig, pngChunk('IHDR', ihdr)];
  if (opts.text) {
    Object.keys(opts.text).forEach((k) => {
      chunks.push(pngChunk('tEXt', Buffer.concat([Buffer.from(k, 'latin1'), Buffer.from([0]), Buffer.from(String(opts.text[k]), 'latin1')])));
    });
  }
  chunks.push(pngChunk('IEND', Buffer.alloc(0)));
  return Buffer.concat(chunks);
}

// A full JPEG with camera make/model, timestamp, exposure and GPS — the
// canonical "photo from a phone" used by the browser test.
function sampleGeoJpeg() {
  const tiff = buildTiff({
    little: false,
    ifd0: [
      { tag: 0x010f, type: 2, values: 'TARYAM' },
      { tag: 0x0110, type: 2, values: 'CyberCam X1' },
      { tag: 0x0112, type: 3, values: [1] },
      { tag: 0x0131, type: 2, values: 'taryam-fw 2.0' },
    ],
    exif: [
      { tag: 0x9003, type: 2, values: '2024:05:01 13:45:30' },
      { tag: 0x829d, type: 5, values: [[28, 10]] },
      { tag: 0x920a, type: 5, values: [[50, 1]] },
      { tag: 0x8827, type: 3, values: [400] },
    ],
    gps: [
      { tag: 0x0001, type: 2, values: 'N' },
      { tag: 0x0002, type: 5, values: [[25, 1], [11, 1], [497, 10]] },
      { tag: 0x0003, type: 2, values: 'E' },
      { tag: 0x0004, type: 5, values: [[55, 1], [16, 1], [280, 10]] },
      { tag: 0x0006, type: 5, values: [[120, 1]] },
    ],
  });
  return wrapJpeg(tiff, { width: 4000, height: 3000 });
}

module.exports = { buildTiff, wrapJpeg, buildPng, pngChunk, sampleGeoJpeg };

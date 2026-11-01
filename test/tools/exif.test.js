'use strict';
// Unit tests for the EXIF / image-metadata parser (../../exif.js).
// Test images are synthesized byte-for-byte here (a hand-built TIFF/EXIF
// stream wrapped in JPEG/PNG), so every field has a known expected value and
// no binary fixtures are needed. Covers both byte orders, GPS decoding,
// PNG text chunks, and that malformed input never throws.
const test = require('node:test');
const assert = require('node:assert');
const ExifParser = require('../../exif.js');
const { buildTiff, wrapJpeg } = require('../helpers/make-image');

// Test images are synthesized byte-for-byte by test/helpers/make-image.js, so
// every field below has a known expected value and no binary fixtures are needed.
// ------------------------------------------------------------------------
test('detects JPEG and parses camera make/model + orientation (big-endian)', () => {
  const tiff = buildTiff({
    little: false,
    ifd0: [
      { tag: 0x010f, type: 2, values: 'TARYAM' },           // Make
      { tag: 0x0110, type: 2, values: 'CyberCam X1' },      // Model
      { tag: 0x0112, type: 3, values: [6] },                // Orientation = Rotate 90 CW
      { tag: 0x0131, type: 2, values: 'taryam-fw 2.0' },    // Software
    ],
    exif: [
      { tag: 0x9003, type: 2, values: '2024:05:01 13:45:30' }, // DateTimeOriginal
      { tag: 0x829d, type: 5, values: [[28, 10]] },            // FNumber 2.8
      { tag: 0x920a, type: 5, values: [[50, 1]] },             // FocalLength 50mm
      { tag: 0x8827, type: 3, values: [400] },                 // ISO
    ],
  });
  const jpeg = wrapJpeg(tiff, { width: 4000, height: 3000 });
  const r = ExifParser.parse(jpeg);

  assert.strictEqual(r.format, 'JPEG');
  assert.strictEqual(r.mime, 'image/jpeg');
  assert.strictEqual(r.hasExif, true);
  assert.strictEqual(r.byteOrder, 'big-endian (MM)');
  assert.strictEqual(r.camera.make, 'TARYAM');
  assert.strictEqual(r.camera.model, 'CyberCam X1');
  assert.strictEqual(r.camera.software, 'taryam-fw 2.0');
  assert.strictEqual(r.camera.orientation, 'Rotate 90 CW');
  assert.strictEqual(r.datetime.original, '2024:05:01 13:45:30');
  assert.strictEqual(r.exposure.fNumber, 'f/2.8');
  assert.strictEqual(r.exposure.focalLength, '50 mm');
  assert.strictEqual(r.exposure.iso, 400);
  assert.deepStrictEqual(r.dimensions, { width: 4000, height: 3000 });
});

test('parses little-endian EXIF identically', () => {
  const tiff = buildTiff({
    little: true,
    ifd0: [{ tag: 0x010f, type: 2, values: 'Acme' }, { tag: 0x0110, type: 2, values: 'LE-1' }],
    exif: [{ tag: 0x829d, type: 5, values: [[40, 10]] }], // f/4
  });
  const jpeg = wrapJpeg(tiff);
  const r = ExifParser.parse(jpeg);
  assert.strictEqual(r.byteOrder, 'little-endian (II)');
  assert.strictEqual(r.camera.make, 'Acme');
  assert.strictEqual(r.camera.model, 'LE-1');
  assert.strictEqual(r.exposure.fNumber, 'f/4');
});

test('decodes GPS coordinates to decimal degrees and flags the privacy risk', () => {
  // 25°11'49.7"N  55°16'28.0"E  (Dubai area)
  const tiff = buildTiff({
    little: false,
    ifd0: [{ tag: 0x010f, type: 2, values: 'Phone' }],
    exif: [{ tag: 0x9003, type: 2, values: '2023:01:02 03:04:05' }],
    gps: [
      { tag: 0x0001, type: 2, values: 'N' },
      { tag: 0x0002, type: 5, values: [[25, 1], [11, 1], [497, 10]] },
      { tag: 0x0003, type: 2, values: 'E' },
      { tag: 0x0004, type: 5, values: [[55, 1], [16, 1], [280, 10]] },
      { tag: 0x0006, type: 5, values: [[120, 1] ] }, // altitude 120m
    ],
  });
  const r = ExifParser.parse(wrapJpeg(tiff));
  assert.ok(r.gps, 'gps extracted');
  assert.ok(Math.abs(r.gps.latitude - 25.197138) < 1e-4, 'lat ' + r.gps.latitude);
  assert.ok(Math.abs(r.gps.longitude - 55.274444) < 1e-4, 'lon ' + r.gps.longitude);
  assert.strictEqual(r.gps.altitude, 120);
  assert.match(r.gps.googleMapsUrl, /maps\?q=25\.19/);
  assert.ok(r.warnings.some((w) => /GPS/.test(w)), 'privacy warning present');
});

test('southern/western refs produce negative coordinates', () => {
  const dec = ExifParser._internal.dmsToDecimal([{ value: 33 }, { value: 52 }, { value: 0 }], 'S');
  assert.ok(Math.abs(dec - (-33.866667)) < 1e-5, 'lat ' + dec);
});

test('reads PNG dimensions and tEXt metadata', () => {
  const { buildPng } = require('../helpers/make-image');
  const png = buildPng({ width: 800, height: 600, colorType: 6, text: { Software: 'TARYAM Editor' } });
  const r = ExifParser.parse(png);
  assert.strictEqual(r.format, 'PNG');
  assert.deepStrictEqual(r.dimensions, { width: 800, height: 600 });
  assert.strictEqual(r.colorType, 'RGBA');
  assert.strictEqual(r.text.Software, 'TARYAM Editor');
});

test('accepts ArrayBuffer and Uint8Array, not just Buffer', () => {
  const tiff = buildTiff({ little: true, ifd0: [{ tag: 0x010f, type: 2, values: 'X' }] });
  const jpeg = wrapJpeg(tiff);
  const ab = jpeg.buffer.slice(jpeg.byteOffset, jpeg.byteOffset + jpeg.byteLength);
  assert.strictEqual(ExifParser.parse(ab).camera.make, 'X');
  assert.strictEqual(ExifParser.parse(new Uint8Array(ab)).camera.make, 'X');
});

test('image with no EXIF reports hasExif=false without error', () => {
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.from([0xff, 0xd9])]);
  const r = ExifParser.parse(jpeg);
  assert.strictEqual(r.format, 'JPEG');
  assert.strictEqual(r.hasExif, false);
  assert.deepStrictEqual(r.warnings, []);
});

test('malformed / truncated / random input never throws', () => {
  const samples = [
    Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0x00, 0xff, 0x45, 0x78, 0x69, 0x66]), // APP1 claims length past EOF
    Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0x00, 0x08, 0x45, 0x78, 0x69, 0x66, 0x00, 0x00]), // Exif header, no TIFF
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0xff, 0xff, 0xff]), // PNG sig + garbage chunk len
    Buffer.alloc(0),
    Buffer.from([0x00, 0x01, 0x02, 0x03]),
    crypto_random(2048),
  ];
  for (const s of samples) {
    assert.doesNotThrow(() => { const r = ExifParser.parse(s); assert.ok(r && typeof r.format === 'string'); });
  }
});

function crypto_random(n) {
  const b = Buffer.alloc(n);
  for (let i = 0; i < n; i++) b[i] = (Math.random() * 256) | 0;
  return b;
}

test('detect() identifies formats by magic bytes', () => {
  assert.strictEqual(ExifParser.detect(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), 'JPEG');
  assert.strictEqual(ExifParser.detect(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0])), 'PNG');
  assert.strictEqual(ExifParser.detect(Buffer.from([0x47, 0x49, 0x46, 0x38])), 'GIF');
  assert.strictEqual(ExifParser.detect(Buffer.from([0x00, 0x00, 0x00, 0x00])), 'unknown');
});

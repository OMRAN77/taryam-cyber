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
  const w = ExifParser._internal.dmsToDecimal([{ value: 151 }, { value: 12 }, { value: 0 }], 'W');
  assert.ok(Math.abs(w - (-151.2)) < 1e-5, 'lon ' + w);
});

// The full path: refs are read as 'S\0' / 'W\0' ASCII tags from the GPS IFD
// of a real JPEG, in both byte orders, and each axis uses its own ref.
function geoJpeg(little, latRef, lonRef, extraGps) {
  return wrapJpeg(buildTiff({
    little,
    ifd0: [{ tag: 0x010f, type: 2, values: 'Phone' }],
    gps: [
      { tag: 0x0001, type: 2, values: latRef },
      { tag: 0x0002, type: 5, values: [[33, 1], [52, 1], [0, 1]] },
      { tag: 0x0003, type: 2, values: lonRef },
      { tag: 0x0004, type: 5, values: [[151, 1], [12, 1], [0, 1]] },
    ].concat(extraGps || []),
  }));
}

for (const little of [false, true]) {
  const order = little ? 'little-endian' : 'big-endian';

  test('S/W refs give negative latitude and longitude through parse() (' + order + ')', () => {
    // GPSAltitudeRef is a BYTE in the spec; the helper has no BYTE type, and
    // the parser reads a one-value SHORT the same way, which is all this needs.
    const r = ExifParser.parse(geoJpeg(little, 'S', 'W', [
      { tag: 0x0005, type: 3, values: [1] },       // below sea level
      { tag: 0x0006, type: 5, values: [[30, 1]] }, // 30 m
    ]));
    assert.ok(r.gps, 'gps extracted');
    assert.ok(Math.abs(r.gps.latitude - (-33.866667)) < 1e-5, 'lat ' + r.gps.latitude);
    assert.ok(Math.abs(r.gps.longitude - (-151.2)) < 1e-5, 'lon ' + r.gps.longitude);
    assert.strictEqual(r.gps.latitudeRef, 'S');
    assert.strictEqual(r.gps.longitudeRef, 'W');
    assert.strictEqual(r.gps.altitude, -30);
    assert.match(r.gps.googleMapsUrl, /maps\?q=-33\.86\d*,-151\.2$/);
  });

  test('mixed hemispheres keep each axis on its own ref (' + order + ')', () => {
    const nw = ExifParser.parse(geoJpeg(little, 'N', 'W')).gps;
    assert.ok(nw.latitude > 0 && nw.longitude < 0, JSON.stringify(nw));
    const se = ExifParser.parse(geoJpeg(little, 'S', 'E')).gps;
    assert.ok(se.latitude < 0 && se.longitude > 0, JSON.stringify(se));
  });
}

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
    Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x4a, 0x46]), // APP0 'JF' at EOF, no version bytes
    Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x08, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]), // JFIF, minor version cut off
  ];
  for (const s of samples) {
    assert.doesNotThrow(() => { const r = ExifParser.parse(s); assert.ok(r && typeof r.format === 'string'); });
  }
});

// A minimal JFIF JPEG: SOI, APP0 "JFIF\0" v1.01, EOI.
const JFIF_BODY = [0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00];
function jfifJpeg() {
  return Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 2 + JFIF_BODY.length].concat(JFIF_BODY, [0xff, 0xd9]));
}

test('JFIF version is read from a full APP0 and never past a short one', () => {
  assert.ok(ExifParser.parse(jfifJpeg()).notes.includes('JFIF 1.01'));
  // Every APP0 length 0..20 at the very end of the file, cut at every point.
  for (let segLen = 0; segLen <= 20; segLen++) {
    const full = [0xff, 0xd8, 0xff, 0xe0, 0x00, segLen].concat(JFIF_BODY, JFIF_BODY);
    for (let end = 4; end <= full.length; end++) {
      const s = Buffer.from(full.slice(0, end));
      assert.doesNotThrow(() => ExifParser.parse(s), 'segLen ' + segLen + ' cut at ' + end);
    }
  }
  // A short APP0 mid-file must not borrow the next segment's bytes as a version.
  const short = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x4a, 0x46, 0xff, 0xfe, 0x00, 0x08, 0x41, 0x41, 0x41, 0x41, 0x41, 0x41, 0xff, 0xd9]);
  const r = ExifParser.parse(short);
  assert.ok(!r.notes.some((n) => /^JFIF/.test(n)), JSON.stringify(r.notes));
  assert.deepStrictEqual(r.comments, ['AAAAAA']);
});

// Seeded, so a failure reproduces: mutate and truncate valid JPEG/PNG files
// (random bytes alone almost never pass detect(), so no parser would run).
test('mutated and truncated real images never throw', () => {
  let seed = 0x7a2f;
  const rand = (n) => { seed = (seed * 1103515245 + 12345) >>> 0; return (seed >>> 8) % n; };
  const { buildPng, sampleGeoJpeg } = require('../helpers/make-image');
  const seeds = [
    sampleGeoJpeg(),
    jfifJpeg(),
    buildPng({ width: 8, height: 8, text: { Software: 'x', Comment: 'y' } }),
  ];
  for (const base of seeds) {
    for (let k = 0; k < 1500; k++) {
      const s = Buffer.from(base);
      const flips = 1 + rand(4);
      for (let j = 0; j < flips; j++) s[4 + rand(s.length - 4)] = rand(256); // keep the magic bytes
      const cut = rand(3) === 0 ? s.subarray(0, 4 + rand(s.length - 4)) : s;
      assert.doesNotThrow(() => ExifParser.parse(cut), 'seed case ' + k);
    }
  }
});

test('detect() identifies formats by magic bytes', () => {
  assert.strictEqual(ExifParser.detect(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), 'JPEG');
  assert.strictEqual(ExifParser.detect(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0])), 'PNG');
  assert.strictEqual(ExifParser.detect(Buffer.from([0x47, 0x49, 0x46, 0x38])), 'GIF');
  assert.strictEqual(ExifParser.detect(Buffer.from([0x00, 0x00, 0x00, 0x00])), 'unknown');
});

/*
 * TARYAM Cyber — EXIF / image metadata parser
 * ------------------------------------------------------------------
 * Dependency-free reader for the metadata embedded in image files:
 *   - JPEG  : APP0 (JFIF), APP1 (EXIF/TIFF + XMP), COM comments, SOF size.
 *   - TIFF  : raw TIFF/EXIF IFD stream (II/MM, IFD0, ExifIFD, GPS, IFD1).
 *   - PNG   : IHDR size, tEXt / zTXt(uncompressed only) / iTXt, tIME, eXIf.
 *
 * Runs entirely on an in-memory buffer — it makes no network calls and
 * writes nothing, so a user's photo never leaves their machine. It is
 * meant for privacy review, OSINT and forensics on images you are
 * authorized to inspect.
 *
 * Works in the browser (attaches `window.ExifParser`) and in Node
 * (`module.exports`), so the same code backs the UI and the unit tests.
 *
 * API:
 *   ExifParser.parse(input) -> report object  (see buildReport)
 *   input may be an ArrayBuffer, a TypedArray/DataView, a Node Buffer,
 *   or a plain array of byte values.
 */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.ExifParser = api;
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
  'use strict';

  // ---- limits (defensive: images are untrusted input) -------------------
  const MAX_IFD_ENTRIES = 512;     // per IFD
  const MAX_IFDS = 64;             // total IFDs walked (loop guard)
  const MAX_STRING = 4096;         // ASCII value cap
  const MAX_JPEG_SEGMENTS = 4096;  // segment-walk guard

  // ---- byte helpers ------------------------------------------------------
  function toUint8(input) {
    if (input == null) throw new TypeError('no data');
    if (input instanceof Uint8Array) return input;
    if (typeof ArrayBuffer !== 'undefined' && input instanceof ArrayBuffer) return new Uint8Array(input);
    if (typeof Buffer !== 'undefined' && Buffer.isBuffer && Buffer.isBuffer(input)) {
      return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
    }
    if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
    if (Array.isArray(input)) return new Uint8Array(input);
    throw new TypeError('unsupported input type');
  }

  // A small view over a Uint8Array with explicit endianness and bounds checks.
  function Reader(bytes, little) {
    this.b = bytes;
    this.little = !!little;
    this.len = bytes.length;
  }
  Reader.prototype.u8 = function (o) {
    if (o < 0 || o >= this.len) throw new RangeError('oob u8 @' + o);
    return this.b[o];
  };
  Reader.prototype.u16 = function (o) {
    if (o < 0 || o + 2 > this.len) throw new RangeError('oob u16 @' + o);
    return this.little ? (this.b[o] | (this.b[o + 1] << 8)) : ((this.b[o] << 8) | this.b[o + 1]);
  };
  Reader.prototype.u32 = function (o) {
    if (o < 0 || o + 4 > this.len) throw new RangeError('oob u32 @' + o);
    const b = this.b;
    const v = this.little
      ? (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24))
      : ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]);
    return v >>> 0; // unsigned
  };
  Reader.prototype.s32 = function (o) {
    const v = this.u32(o);
    return v | 0;
  };
  Reader.prototype.ascii = function (o, n) {
    if (o < 0 || o + n > this.len) throw new RangeError('oob ascii');
    let s = '';
    for (let i = 0; i < n; i++) {
      const c = this.b[o + i];
      if (c === 0) break;
      s += String.fromCharCode(c);
    }
    return s;
  };

  // ---- TIFF type sizes ---------------------------------------------------
  const TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8 };

  // ---- tag dictionaries --------------------------------------------------
  const TAGS_IFD = {
    0x0100: 'ImageWidth', 0x0101: 'ImageLength', 0x0102: 'BitsPerSample',
    0x0103: 'Compression', 0x0106: 'PhotometricInterpretation', 0x010e: 'ImageDescription',
    0x010f: 'Make', 0x0110: 'Model', 0x0111: 'StripOffsets', 0x0112: 'Orientation',
    0x0115: 'SamplesPerPixel', 0x011a: 'XResolution', 0x011b: 'YResolution',
    0x0128: 'ResolutionUnit', 0x0131: 'Software', 0x0132: 'DateTime',
    0x013b: 'Artist', 0x013e: 'WhitePoint', 0x0211: 'YCbCrCoefficients',
    0x0213: 'YCbCrPositioning', 0x8298: 'Copyright', 0x8769: 'ExifIFDPointer',
    0x8825: 'GPSInfoIFDPointer', 0xa005: 'InteroperabilityIFDPointer', 0xc4a5: 'PrintImageMatching',
  };
  const TAGS_EXIF = {
    0x829a: 'ExposureTime', 0x829d: 'FNumber', 0x8822: 'ExposureProgram',
    0x8827: 'ISOSpeedRatings', 0x8830: 'SensitivityType', 0x8832: 'RecommendedExposureIndex',
    0x9000: 'ExifVersion', 0x9003: 'DateTimeOriginal', 0x9004: 'DateTimeDigitized',
    0x9010: 'OffsetTime', 0x9011: 'OffsetTimeOriginal', 0x9012: 'OffsetTimeDigitized',
    0x9101: 'ComponentsConfiguration', 0x9102: 'CompressedBitsPerPixel',
    0x9201: 'ShutterSpeedValue', 0x9202: 'ApertureValue', 0x9203: 'BrightnessValue',
    0x9204: 'ExposureBiasValue', 0x9205: 'MaxApertureValue', 0x9206: 'SubjectDistance',
    0x9207: 'MeteringMode', 0x9208: 'LightSource', 0x9209: 'Flash', 0x920a: 'FocalLength',
    0x9286: 'UserComment', 0x9290: 'SubSecTime', 0x9291: 'SubSecTimeOriginal',
    0x9292: 'SubSecTimeDigitized', 0xa000: 'FlashpixVersion', 0xa001: 'ColorSpace',
    0xa002: 'PixelXDimension', 0xa003: 'PixelYDimension', 0xa210: 'FocalPlaneResolutionUnit',
    0xa215: 'ExposureIndex', 0xa217: 'SensingMethod', 0xa300: 'FileSource',
    0xa301: 'SceneType', 0xa401: 'CustomRendered', 0xa402: 'ExposureMode',
    0xa403: 'WhiteBalance', 0xa404: 'DigitalZoomRatio', 0xa405: 'FocalLengthIn35mmFilm',
    0xa406: 'SceneCaptureType', 0xa407: 'GainControl', 0xa408: 'Contrast',
    0xa409: 'Saturation', 0xa40a: 'Sharpness', 0xa420: 'ImageUniqueID',
    0xa430: 'CameraOwnerName', 0xa431: 'BodySerialNumber', 0xa432: 'LensSpecification',
    0xa433: 'LensMake', 0xa434: 'LensModel', 0xa435: 'LensSerialNumber',
  };
  const TAGS_GPS = {
    0x0000: 'GPSVersionID', 0x0001: 'GPSLatitudeRef', 0x0002: 'GPSLatitude',
    0x0003: 'GPSLongitudeRef', 0x0004: 'GPSLongitude', 0x0005: 'GPSAltitudeRef',
    0x0006: 'GPSAltitude', 0x0007: 'GPSTimeStamp', 0x0008: 'GPSSatellites',
    0x0009: 'GPSStatus', 0x000a: 'GPSMeasureMode', 0x000b: 'GPSDOP',
    0x000c: 'GPSSpeedRef', 0x000d: 'GPSSpeed', 0x0010: 'GPSImgDirectionRef',
    0x0011: 'GPSImgDirection', 0x0012: 'GPSMapDatum', 0x001d: 'GPSDateStamp',
  };

  // Enumerated-value labels for the common tags.
  const ENUMS = {
    Orientation: { 1: 'Normal', 2: 'Mirror horizontal', 3: 'Rotate 180', 4: 'Mirror vertical', 5: 'Mirror + rotate 270 CW', 6: 'Rotate 90 CW', 7: 'Mirror + rotate 90 CW', 8: 'Rotate 270 CW' },
    ResolutionUnit: { 1: 'None', 2: 'inches', 3: 'cm' },
    FocalPlaneResolutionUnit: { 1: 'None', 2: 'inches', 3: 'cm' },
    ExposureProgram: { 0: 'Not defined', 1: 'Manual', 2: 'Normal', 3: 'Aperture priority', 4: 'Shutter priority', 5: 'Creative', 6: 'Action', 7: 'Portrait', 8: 'Landscape' },
    MeteringMode: { 0: 'Unknown', 1: 'Average', 2: 'Center-weighted', 3: 'Spot', 4: 'Multi-spot', 5: 'Pattern', 6: 'Partial', 255: 'Other' },
    LightSource: { 0: 'Unknown', 1: 'Daylight', 2: 'Fluorescent', 3: 'Tungsten', 4: 'Flash', 9: 'Fine weather', 10: 'Cloudy', 11: 'Shade', 255: 'Other' },
    ColorSpace: { 1: 'sRGB', 2: 'Adobe RGB', 0xffff: 'Uncalibrated' },
    ExposureMode: { 0: 'Auto', 1: 'Manual', 2: 'Auto bracket' },
    WhiteBalance: { 0: 'Auto', 1: 'Manual' },
    SceneCaptureType: { 0: 'Standard', 1: 'Landscape', 2: 'Portrait', 3: 'Night' },
    Contrast: { 0: 'Normal', 1: 'Soft', 2: 'Hard' },
    Saturation: { 0: 'Normal', 1: 'Low', 2: 'High' },
    Sharpness: { 0: 'Normal', 1: 'Soft', 2: 'Hard' },
    SensingMethod: { 1: 'Not defined', 2: 'One-chip color area', 3: 'Two-chip color area', 4: 'Three-chip color area', 5: 'Color sequential area', 7: 'Trilinear', 8: 'Color sequential linear' },
    CustomRendered: { 0: 'Normal', 1: 'Custom' },
    GainControl: { 0: 'None', 1: 'Low gain up', 2: 'High gain up', 3: 'Low gain down', 4: 'High gain down' },
    Compression: { 1: 'Uncompressed', 6: 'JPEG', 7: 'JPEG' },
  };

  function flashLabel(v) {
    if (typeof v !== 'number') return v;
    const fired = (v & 0x1) ? 'fired' : 'did not fire';
    const red = (v & 0x40) ? ', red-eye reduction' : '';
    const noFn = (v & 0x20) ? ', no flash function' : '';
    return 'Flash ' + fired + red + noFn + ' (0x' + v.toString(16) + ')';
  }

  // ---- IFD reader --------------------------------------------------------
  // Parses one IFD at `offset` (relative to TIFF start). Returns
  // { tags: {name->value}, next: nextIfdOffset, pointers: {Exif,GPS,Interop} }.
  function readIFD(r, offset, dict) {
    const out = { tags: {}, next: 0, pointers: {} };
    if (offset <= 0 || offset + 2 > r.len) return out;
    const count = r.u16(offset);
    if (count > MAX_IFD_ENTRIES) return out;
    let p = offset + 2;
    for (let i = 0; i < count; i++, p += 12) {
      if (p + 12 > r.len) break;
      const tag = r.u16(p);
      const type = r.u16(p + 2);
      const num = r.u32(p + 4);
      const size = TYPE_SIZE[type];
      if (!size) continue;
      const byteLen = size * num;
      if (byteLen > 0x7fffffff) continue;
      let valueOffset = p + 8;
      if (byteLen > 4) {
        valueOffset = r.u32(p + 8);
        if (valueOffset < 0 || valueOffset + byteLen > r.len) continue;
      }

      // Pointer tags steer the walk; keep their raw value too.
      if (tag === 0x8769) out.pointers.Exif = r.u32(valueOffset);
      else if (tag === 0x8825) out.pointers.GPS = r.u32(valueOffset);
      else if (tag === 0xa005) out.pointers.Interop = r.u32(valueOffset);

      const name = (dict && dict[tag]) || ('Tag0x' + tag.toString(16));
      let value;
      try {
        value = readValue(r, type, num, valueOffset);
      } catch (e) {
        continue;
      }
      out.tags[name] = decodeTag(name, value);
    }
    if (p + 4 <= r.len) out.next = r.u32(p);
    return out;
  }

  function readValue(r, type, num, off) {
    // ASCII
    if (type === 2) return r.ascii(off, Math.min(num, MAX_STRING));
    // UNDEFINED / BYTE blobs -> array of bytes (short), else summarized
    if (type === 7 || type === 1 || type === 6) {
      const n = Math.min(num, 64);
      const arr = [];
      for (let i = 0; i < n; i++) arr.push(r.u8(off + i));
      if (type === 7 && num > 64) arr.push('…(+' + (num - 64) + ' bytes)');
      return arr.length === 1 ? arr[0] : arr;
    }
    const vals = [];
    const n = Math.min(num, 256);
    for (let i = 0; i < n; i++) {
      if (type === 3 || type === 8) { // SHORT / SSHORT
        let v = r.u16(off + i * 2);
        if (type === 8 && v > 0x7fff) v -= 0x10000;
        vals.push(v);
      } else if (type === 4 || type === 9) { // LONG / SLONG
        vals.push(type === 9 ? r.s32(off + i * 4) : r.u32(off + i * 4));
      } else if (type === 5 || type === 10) { // RATIONAL / SRATIONAL
        const nu = type === 10 ? r.s32(off + i * 8) : r.u32(off + i * 8);
        const de = type === 10 ? r.s32(off + i * 8 + 4) : r.u32(off + i * 8 + 4);
        vals.push({ n: nu, d: de, value: de === 0 ? 0 : nu / de });
      } else if (type === 11) { // FLOAT
        vals.push(readFloat32(r, off + i * 4));
      } else if (type === 12) { // DOUBLE
        vals.push(readFloat64(r, off + i * 8));
      }
    }
    return vals.length === 1 ? vals[0] : vals;
  }

  function readFloat32(r, o) {
    const b = new ArrayBuffer(4), dv = new DataView(b);
    for (let i = 0; i < 4; i++) dv.setUint8(i, r.u8(o + i));
    return dv.getFloat32(0, r.little);
  }
  function readFloat64(r, o) {
    const b = new ArrayBuffer(8), dv = new DataView(b);
    for (let i = 0; i < 8; i++) dv.setUint8(i, r.u8(o + i));
    return dv.getFloat64(0, r.little);
  }

  // Turn a RATIONAL (or array) into a readable number/label where useful.
  function decodeTag(name, value) {
    if (ENUMS[name] && typeof value === 'number' && ENUMS[name][value] != null) {
      return { raw: value, label: ENUMS[name][value] };
    }
    if (name === 'Flash' && typeof value === 'number') return { raw: value, label: flashLabel(value) };
    if (value && typeof value === 'object' && !Array.isArray(value) && 'value' in value) {
      return value; // single rational
    }
    return value;
  }

  // ---- TIFF entry point --------------------------------------------------
  function parseTiff(bytes) {
    if (bytes.length < 8) throw new Error('TIFF too short');
    let little;
    if (bytes[0] === 0x49 && bytes[1] === 0x49) little = true;       // "II"
    else if (bytes[0] === 0x4d && bytes[1] === 0x4d) little = false; // "MM"
    else throw new Error('not a TIFF header');
    const r = new Reader(bytes, little);
    if (r.u16(2) !== 42) throw new Error('bad TIFF magic');

    const result = { byteOrder: little ? 'little-endian (II)' : 'big-endian (MM)', IFD0: {}, Exif: {}, GPS: {}, Interop: {}, IFD1: {} };
    const visited = new Set();
    let ifdCount = 0;

    const ifd0off = r.u32(4);
    const ifd0 = readIFD(r, ifd0off, TAGS_IFD);
    result.IFD0 = ifd0.tags;
    visited.add(ifd0off);
    ifdCount++;

    if (ifd0.pointers.Exif && !visited.has(ifd0.pointers.Exif) && ifdCount < MAX_IFDS) {
      visited.add(ifd0.pointers.Exif); ifdCount++;
      const ex = readIFD(r, ifd0.pointers.Exif, TAGS_EXIF);
      result.Exif = ex.tags;
      if (ex.pointers.Interop && !visited.has(ex.pointers.Interop) && ifdCount < MAX_IFDS) {
        visited.add(ex.pointers.Interop); ifdCount++;
        result.Interop = readIFD(r, ex.pointers.Interop, {}).tags;
      }
    }
    if (ifd0.pointers.GPS && !visited.has(ifd0.pointers.GPS) && ifdCount < MAX_IFDS) {
      visited.add(ifd0.pointers.GPS); ifdCount++;
      result.GPS = readIFD(r, ifd0.pointers.GPS, TAGS_GPS).tags;
    }
    // IFD1 = thumbnail
    if (ifd0.next && !visited.has(ifd0.next) && ifdCount < MAX_IFDS) {
      visited.add(ifd0.next); ifdCount++;
      result.IFD1 = readIFD(r, ifd0.next, TAGS_IFD).tags;
    }
    return result;
  }

  // ---- JPEG --------------------------------------------------------------
  function parseJpeg(bytes) {
    const r = new Reader(bytes, false);
    const info = { format: 'JPEG', segments: [], tiff: null, xmp: null, comments: [], jfif: null, dimensions: null };
    let p = 2; // skip SOI FFD8
    let guard = 0;
    while (p + 4 <= bytes.length && guard++ < MAX_JPEG_SEGMENTS) {
      if (bytes[p] !== 0xff) { p++; continue; }
      let marker = bytes[p + 1];
      while (marker === 0xff && p + 2 < bytes.length) { p++; marker = bytes[p + 1]; } // skip fill
      p += 2;
      if (marker === 0xd9 || marker === 0xda) break; // EOI / SOS (entropy data follows)
      if (marker >= 0xd0 && marker <= 0xd7) continue; // RSTn, no length
      if (p + 2 > bytes.length) break;
      const segLen = r.u16(p);
      if (segLen < 2 || p + segLen > bytes.length) break;
      const dataStart = p + 2;
      const dataLen = segLen - 2;
      info.segments.push({ marker: '0x' + marker.toString(16), length: segLen });

      // SOF0..SOF15 (except DHT=C4, DAC=CC, RSTn) carry frame size.
      if ((marker >= 0xc0 && marker <= 0xcf) && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        if (dataLen >= 5) info.dimensions = { height: r.u16(dataStart + 1), width: r.u16(dataStart + 3) };
      } else if (marker === 0xe0) { // APP0 / JFIF
        // "JFIF\0" + major + minor: a shorter segment has no version to read.
        if (dataLen >= 7 && bytes[dataStart] === 0x4a && bytes[dataStart + 1] === 0x46 &&
            bytes[dataStart + 2] === 0x49 && bytes[dataStart + 3] === 0x46 && bytes[dataStart + 4] === 0) {
          info.jfif = { version: r.u8(dataStart + 5) + '.' + String(r.u8(dataStart + 6)).padStart(2, '0') };
        }
      } else if (marker === 0xe1) { // APP1 : EXIF or XMP
        if (dataLen >= 6 && bytes[dataStart] === 0x45 && bytes[dataStart + 1] === 0x78 &&
            bytes[dataStart + 2] === 0x69 && bytes[dataStart + 3] === 0x66 &&
            bytes[dataStart + 4] === 0 && bytes[dataStart + 5] === 0) {
          const tiffBytes = bytes.subarray(dataStart + 6, dataStart + dataLen);
          try { info.tiff = parseTiff(tiffBytes); } catch (e) { info.tiffError = e.message; }
        } else {
          const hdr = r.ascii(dataStart, Math.min(29, dataLen));
          if (hdr.indexOf('http://ns.adobe.com/xap/1.0/') === 0) {
            const xmpStart = dataStart + 29;
            info.xmp = utf8(bytes.subarray(xmpStart, dataStart + dataLen)).slice(0, MAX_STRING);
          }
        }
      } else if (marker === 0xfe) { // COM
        info.comments.push(utf8(bytes.subarray(dataStart, dataStart + dataLen)).slice(0, MAX_STRING));
      }
      p += segLen;
    }
    return info;
  }

  // ---- PNG ---------------------------------------------------------------
  function parsePng(bytes) {
    const r = new Reader(bytes, false); // PNG is big-endian
    const info = { format: 'PNG', dimensions: null, bitDepth: null, colorType: null, text: {}, time: null, tiff: null, chunks: [] };
    let p = 8; // skip signature
    let guard = 0;
    while (p + 8 <= bytes.length && guard++ < MAX_JPEG_SEGMENTS) {
      const len = r.u32(p);
      const type = r.ascii(p + 4, 4);
      const dataStart = p + 8;
      if (dataStart + len + 4 > bytes.length) break;
      info.chunks.push(type);
      if (type === 'IHDR' && len >= 13) {
        info.dimensions = { width: r.u32(dataStart), height: r.u32(dataStart + 4) };
        info.bitDepth = r.u8(dataStart + 8);
        const ct = r.u8(dataStart + 9);
        info.colorType = ({ 0: 'Grayscale', 2: 'RGB', 3: 'Palette', 4: 'Grayscale+Alpha', 6: 'RGBA' })[ct] || ct;
      } else if (type === 'tEXt') {
        const raw = bytes.subarray(dataStart, dataStart + len);
        const z = raw.indexOf(0);
        if (z > 0) info.text[latin1(raw.subarray(0, z))] = latin1(raw.subarray(z + 1)).slice(0, MAX_STRING);
      } else if (type === 'iTXt') {
        const raw = bytes.subarray(dataStart, dataStart + len);
        const z = raw.indexOf(0);
        if (z > 0) {
          // keyword \0 compressionFlag compressionMethod langTag \0 translatedKeyword \0 text
          const compFlag = raw[z + 1];
          let q = z + 3;
          const l2 = raw.indexOf(0, q); if (l2 < 0) { p = dataStart + len + 4; continue; }
          const l3 = raw.indexOf(0, l2 + 1); if (l3 < 0) { p = dataStart + len + 4; continue; }
          if (compFlag === 0) info.text[latin1(raw.subarray(0, z))] = utf8(raw.subarray(l3 + 1)).slice(0, MAX_STRING);
        }
      } else if (type === 'tIME' && len >= 7) {
        info.time = r.u16(dataStart) + '-' + pad(r.u8(dataStart + 2)) + '-' + pad(r.u8(dataStart + 3)) + ' ' +
          pad(r.u8(dataStart + 4)) + ':' + pad(r.u8(dataStart + 5)) + ':' + pad(r.u8(dataStart + 6)) + ' UTC';
      } else if (type === 'eXIf') {
        try { info.tiff = parseTiff(bytes.subarray(dataStart, dataStart + len)); } catch (e) { info.tiffError = e.message; }
      }
      if (type === 'IEND') break;
      p = dataStart + len + 4; // + CRC
    }
    return info;
  }

  // ---- text decoders -----------------------------------------------------
  function latin1(u8) { let s = ''; for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]); return s; }
  function utf8(u8) {
    if (typeof TextDecoder !== 'undefined') { try { return new TextDecoder('utf-8').decode(u8); } catch (e) { /* fall */ } }
    if (typeof Buffer !== 'undefined') return Buffer.from(u8).toString('utf8');
    return latin1(u8);
  }
  function pad(n) { return String(n).padStart(2, '0'); }

  // ---- format detection --------------------------------------------------
  function detect(bytes) {
    if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'JPEG';
    if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'PNG';
    if (bytes.length >= 4 && ((bytes[0] === 0x49 && bytes[1] === 0x49 && bytes[2] === 42 && bytes[3] === 0) ||
        (bytes[0] === 0x4d && bytes[1] === 0x4d && bytes[2] === 0 && bytes[3] === 42))) return 'TIFF';
    if (bytes.length >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
        bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return 'WEBP';
    if (bytes.length >= 12 && bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70) return 'HEIC';
    if (bytes.length >= 3 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return 'GIF';
    return 'unknown';
  }
  const MIME = { JPEG: 'image/jpeg', PNG: 'image/png', TIFF: 'image/tiff', WEBP: 'image/webp', HEIC: 'image/heic', GIF: 'image/gif', unknown: 'application/octet-stream' };

  // ---- GPS --------------------------------------------------------------
  function ratVal(x) {
    if (x == null) return null;
    if (typeof x === 'number') return x;
    if (typeof x === 'object' && 'value' in x) return x.value;
    return null;
  }
  function dmsToDecimal(arr, ref) {
    if (!Array.isArray(arr) || arr.length < 3) return null;
    const d = ratVal(arr[0]) || 0, m = ratVal(arr[1]) || 0, s = ratVal(arr[2]) || 0;
    let dec = d + m / 60 + s / 3600;
    if (ref === 'S' || ref === 'W') dec = -dec;
    return dec;
  }
  function extractGps(gpsTags) {
    if (!gpsTags || !gpsTags.GPSLatitude || !gpsTags.GPSLongitude) return null;
    const lat = dmsToDecimal(gpsTags.GPSLatitude, gpsTags.GPSLatitudeRef);
    const lon = dmsToDecimal(gpsTags.GPSLongitude, gpsTags.GPSLongitudeRef);
    if (lat == null || lon == null || !isFinite(lat) || !isFinite(lon)) return null;
    const out = {
      latitude: round(lat, 7), longitude: round(lon, 7),
      latitudeRef: gpsTags.GPSLatitudeRef || null, longitudeRef: gpsTags.GPSLongitudeRef || null,
    };
    const alt = ratVal(gpsTags.GPSAltitude);
    if (alt != null) {
      const below = gpsTags.GPSAltitudeRef === 1 || gpsTags.GPSAltitudeRef === '1';
      out.altitude = round(below ? -alt : alt, 2);
    }
    if (gpsTags.GPSDateStamp) out.dateStamp = gpsTags.GPSDateStamp;
    if (Array.isArray(gpsTags.GPSTimeStamp)) {
      const t = gpsTags.GPSTimeStamp.map(ratVal);
      if (t.length >= 3) out.timeStamp = pad(t[0]) + ':' + pad(t[1]) + ':' + pad(Math.round(t[2])) + ' UTC';
    }
    out.googleMapsUrl = 'https://www.google.com/maps?q=' + out.latitude + ',' + out.longitude;
    out.openStreetMapUrl = 'https://www.openstreetmap.org/?mlat=' + out.latitude + '&mlon=' + out.longitude + '#map=16/' + out.latitude + '/' + out.longitude;
    return out;
  }
  function round(n, d) { const f = Math.pow(10, d); return Math.round(n * f) / f; }

  // ---- report assembly ---------------------------------------------------
  function buildReport(bytes) {
    const format = detect(bytes);
    const report = {
      format: format,
      mime: MIME[format],
      fileSize: bytes.length,
      dimensions: null,
      byteOrder: null,
      hasExif: false,
      camera: {}, datetime: {}, exposure: {}, gps: null,
      tags: {}, text: {}, comments: [], xmp: null,
      warnings: [], notes: [],
    };

    let parsed = null;
    if (format === 'JPEG') parsed = parseJpeg(bytes);
    else if (format === 'PNG') parsed = parsePng(bytes);
    else if (format === 'TIFF') { try { parsed = { format: 'TIFF', tiff: parseTiff(bytes), dimensions: null }; } catch (e) { report.warnings.push('TIFF parse failed: ' + e.message); } }

    if (parsed) {
      if (parsed.dimensions) report.dimensions = parsed.dimensions;
      if (parsed.colorType != null) report.colorType = parsed.colorType;
      if (parsed.bitDepth != null) report.bitDepth = parsed.bitDepth;
      if (parsed.comments) report.comments = parsed.comments;
      if (parsed.text) report.text = parsed.text;
      if (parsed.xmp) report.xmp = parsed.xmp;
      if (parsed.jfif) report.notes.push('JFIF ' + parsed.jfif.version);
      if (parsed.time) report.datetime.pngTime = parsed.time;
      if (parsed.tiffError) report.warnings.push('EXIF block present but unreadable: ' + parsed.tiffError);

      const tiff = parsed.tiff;
      if (tiff) {
        report.hasExif = true;
        report.byteOrder = tiff.byteOrder;
        report.tags = { IFD0: tiff.IFD0, Exif: tiff.Exif, GPS: tiff.GPS, Interop: tiff.Interop, thumbnail: tiff.IFD1 };
        enrich(report, tiff);
      }
    } else if (format === 'unknown') {
      report.warnings.push('Unrecognized or unsupported image format.');
    } else if (format === 'WEBP' || format === 'HEIC' || format === 'GIF') {
      report.notes.push('Format detected; embedded EXIF extraction for ' + format + ' is not supported yet.');
    }

    if (report.gps) {
      report.warnings.push('⚠️ This image embeds GPS coordinates — it reveals where the photo was taken.');
    }
    if (report.camera.serialNumber) {
      report.warnings.push('⚠️ A camera body serial number is embedded, which can link photos to one device.');
    }
    return report;
  }

  function enrich(report, tiff) {
    const ifd0 = tiff.IFD0 || {}, ex = tiff.Exif || {};
    const str = (v) => (v == null ? null : String(v).trim() || null);
    report.camera = clean({
      make: str(ifd0.Make),
      model: str(ifd0.Model),
      lensModel: str(ex.LensModel),
      lensMake: str(ex.LensMake),
      software: str(ifd0.Software),
      serialNumber: str(ex.BodySerialNumber) || str(ex.CameraOwnerName),
      orientation: label(ifd0.Orientation),
    });
    report.datetime = clean(Object.assign(report.datetime, {
      original: str(ex.DateTimeOriginal),
      digitized: str(ex.DateTimeDigitized),
      modified: str(ifd0.DateTime),
      offset: str(ex.OffsetTimeOriginal) || str(ex.OffsetTime),
    }));
    report.exposure = clean({
      fNumber: fmtF(ex.FNumber),
      exposureTime: fmtShutter(ex.ExposureTime),
      iso: firstNum(ex.ISOSpeedRatings),
      focalLength: fmtMm(ex.FocalLength),
      focalLength35mm: ex.FocalLengthIn35mmFilm != null ? ex.FocalLengthIn35mmFilm + ' mm' : null,
      exposureBias: ratVal(ex.ExposureBiasValue) != null ? ratVal(ex.ExposureBiasValue) + ' EV' : null,
      flash: label(ex.Flash),
      meteringMode: label(ex.MeteringMode),
      exposureProgram: label(ex.ExposureProgram),
      whiteBalance: label(ex.WhiteBalance),
      colorSpace: label(ex.ColorSpace),
    });
    if (!report.dimensions && (ex.PixelXDimension || ifd0.ImageWidth)) {
      report.dimensions = { width: numOf(ex.PixelXDimension || ifd0.ImageWidth), height: numOf(ex.PixelYDimension || ifd0.ImageLength) };
    }
    report.gps = extractGps(tiff.GPS);
  }

  // value formatting helpers
  function label(v) { return v && typeof v === 'object' && 'label' in v ? v.label : (v == null ? null : v); }
  function numOf(v) { if (v && typeof v === 'object') return 'raw' in v ? v.raw : ('value' in v ? v.value : null); return v; }
  function firstNum(v) { return Array.isArray(v) ? v[0] : (v == null ? null : numOf(v)); }
  function fmtF(v) { const n = ratVal(v) != null ? ratVal(v) : numOf(v); return n == null ? null : 'f/' + round(n, 2); }
  function fmtMm(v) { const n = ratVal(v) != null ? ratVal(v) : numOf(v); return n == null ? null : round(n, 1) + ' mm'; }
  function fmtShutter(v) {
    if (v == null) return null;
    if (typeof v === 'object' && 'n' in v && 'd' in v) {
      if (v.n && v.d && v.value < 1) return v.n + '/' + v.d + ' s';
      return round(v.value, 3) + ' s';
    }
    const n = ratVal(v); return n == null ? null : round(n, 3) + ' s';
  }
  function clean(o) { Object.keys(o).forEach((k) => { if (o[k] == null) delete o[k]; }); return o; }

  // ---- public API --------------------------------------------------------
  function parse(input) {
    const bytes = toUint8(input);
    return buildReport(bytes);
  }

  return {
    parse: parse,
    detect: function (input) { return detect(toUint8(input)); },
    _internal: { parseTiff: function (i) { return parseTiff(toUint8(i)); }, dmsToDecimal: dmsToDecimal, extractGps: extractGps },
    version: '1.0.0',
  };
});

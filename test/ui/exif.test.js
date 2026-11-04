// Browser test for the EXIF tool in index.html: a synthesized photo (camera
// make/model, timestamp, exposure and GPS) is fed to the real file input, and
// the rendered panel must show the decoded values, a working map link and the
// GPS privacy warning — proving the parser is wired in and runs entirely in the
// page (nothing about the image leaves the browser).
//
// It also pins the verdict line: "no hidden metadata" (.exif-clean) may only appear when the
// file was actually parsed and nothing identifying was found. Unsupported formats
// (HEIC/WebP/GIF/unknown), an unreadable EXIF block, author/owner/serial tags or
// GPS tags that do not decode must never be reported as clean.
const test = require('node:test');
const assert = require('node:assert');
const { startServer } = require('../helpers/dev-server');
const { sampleGeoJpeg, buildTiff, wrapJpeg } = require('../helpers/make-image');

let chromium;
try {
  ({ chromium } = require('playwright'));
} catch (e) {
  throw new Error('These tests need Playwright: npm install --no-save playwright && npx playwright install chromium');
}

async function openExifTool(page, server) {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(server.url + '/', { waitUntil: 'load' });
  await page.click('#btnGuestMode').catch(() => {});
  await page.click('#btnHeaderMenu');
  await page.click('#btnSecTools');
  await page.waitForSelector('#secToolsDialog[open]');
  // The EXIF tool button is the one whose handler opens the file input.
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll('#secToolsNav button')].find((b) => /EXIF/i.test(b.textContent));
    if (!btn) throw new Error('EXIF tool button not found');
    btn.click();
  });
  await page.waitForSelector('#exifFileInput');
  return errors;
}

async function newExifPage(t) {
  const server = await startServer();
  const browser = await chromium.launch();
  t.after(async () => { await browser.close(); await server.close(); });
  const page = await (await browser.newContext({ viewport: { width: 420, height: 900 } })).newPage();
  page.setDefaultTimeout(30000);
  const errors = await openExifTool(page, server);
  return { page, errors };
}

// Feed one file and return what the user sees: the panel's rendered text (innerText
// skips the collapsed raw-JSON <details>) and which verdict boxes were drawn.
async function analyse(page, name, mimeType, buffer) {
  await page.evaluate(() => { document.querySelector('#exifResult').innerHTML = ''; });
  await page.setInputFiles('#exifFileInput', { name, mimeType, buffer });
  await page.waitForFunction(() => document.querySelector('#exifResult details'));
  return page.evaluate(() => {
    const box = document.querySelector('#exifResult');
    const warn = box.querySelector('.exif-warnings');
    return {
      visible: box.innerText,
      clean: Boolean(box.querySelector('.exif-clean')),
      unchecked: box.querySelector('.exif-unchecked')?.innerText || null,
      warnings: warn ? warn.innerText : null,
    };
  });
}

// The test TIFF builder only writes ASCII/SHORT/LONG/RATIONAL entries; byte-blob
// tags (XP*, UserComment) are written as ASCII and then retyped in place.
function retype(tiff, tag, type) {
  const at = [];
  for (let i = 8; i + 4 <= tiff.length; i += 2) {
    if (tiff[i] === tag >> 8 && tiff[i + 1] === (tag & 0xff) && tiff[i + 2] === 0 && tiff[i + 3] === 2) at.push(i);
  }
  assert.strictEqual(at.length, 1, 'tag 0x' + tag.toString(16) + ' found once');
  tiff[at[0] + 3] = type;
  return tiff;
}

test('EXIF tool decodes a photo and renders GPS + privacy warning in the page', async (t) => {
  const server = await startServer();
  const browser = await chromium.launch();
  t.after(async () => { await browser.close(); await server.close(); });

  const ctx = await browser.newContext({ viewport: { width: 420, height: 900 } });
  const page = await ctx.newPage();
  page.setDefaultTimeout(30000);

  // Record every network request so we can prove the image is never uploaded.
  const posts = [];
  ctx.on('request', (r) => { if (r.method() !== 'GET') posts.push(r.url()); });

  const errors = await openExifTool(page, server);

  await page.setInputFiles('#exifFileInput', {
    name: 'holiday.jpg', mimeType: 'image/jpeg', buffer: sampleGeoJpeg(),
  });

  await page.waitForFunction(() => /CyberCam X1/.test(document.querySelector('#exifResult')?.textContent || ''));
  const text = await page.textContent('#exifResult');

  assert.match(text, /TARYAM/, 'camera make shown');
  assert.match(text, /CyberCam X1/, 'camera model shown');
  assert.match(text, /2024:05:01 13:45:30/, 'capture time shown');
  assert.match(text, /f\/2\.8/, 'aperture shown');
  assert.match(text, /50 mm/, 'focal length shown');
  assert.match(text, /25\.19/, 'decoded latitude shown');
  assert.match(text, /55\.27/, 'decoded longitude shown');

  // GPS section, the privacy warning box itself, and a real map link. The checks
  // read the rendered text only, so the raw-JSON "GPS" key cannot satisfy them.
  const visible = await page.innerText('#exifResult');
  assert.match(visible, /الموقع الجغرافي \(GPS\)/, 'GPS section shown');
  const warning = await page.$eval('#exifResult .exif-warnings', (el) => el.innerText).catch(() => null);
  assert.ok(warning, 'privacy warning box is rendered');
  assert.match(warning, /reveals where the photo was taken/, 'GPS privacy warning shown in the box');
  assert.strictEqual(await page.$('#exifResult .exif-clean'), null, 'a geotagged photo is not called clean');
  const mapHref = await page.getAttribute('#exifResult a[href*="openstreetmap"]', 'href');
  assert.match(mapHref, /mlat=25\.19/, 'OpenStreetMap link carries the coordinates');

  assert.deepStrictEqual(errors, [], 'no page errors');
  assert.deepStrictEqual(posts, [], 'the image was parsed locally; nothing was POSTed');
});

test('EXIF tool reports a clean image as having no hidden metadata', async (t) => {
  const { page, errors } = await newExifPage(t);

  // A valid JPEG with an EXIF block that carries no tags at all.
  const emptyTiff = buildTiff({ little: false, ifd0: [] });
  let r = await analyse(page, 'clean.jpg', 'image/jpeg', wrapJpeg(emptyTiff));
  assert.ok(r.clean && /لم يُعثر/.test(r.visible), 'states no hidden metadata was found');
  assert.strictEqual(r.unchecked, null);

  // Structural tags that survive stripping (resolution), a blank UserComment and a
  // GPS block holding only its version do not identify anyone: still clean.
  const harmless = retype(buildTiff({
    little: false,
    ifd0: [
      { tag: 0x011a, type: 5, values: [[72, 1]] },   // XResolution
      { tag: 0x011b, type: 5, values: [[72, 1]] },   // YResolution
      { tag: 0x0128, type: 3, values: [2] },         // ResolutionUnit
    ],
    exif: [{ tag: 0x9286, type: 2, values: '\0'.repeat(8) + ' '.repeat(8) }], // UserComment, empty
    gps: [{ tag: 0x0000, type: 4, values: [0x02020000] }],                    // GPSVersionID only
  }), 0x9286, 7);
  r = await analyse(page, 'stripped.jpg', 'image/jpeg', wrapJpeg(harmless));
  assert.ok(r.clean, 'harmless structural tags keep the clean verdict:\n' + r.visible);
  assert.strictEqual(r.unchecked, null);
  assert.deepStrictEqual(errors, [], 'no page errors');
});

test('EXIF tool never calls an unsupported or unknown format clean', async (t) => {
  const { page, errors } = await newExifPage(t);

  const heic = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypheic\0\0\0\0mif1heic', 'latin1'), Buffer.alloc(32)]);
  const webpBody = Buffer.concat([Buffer.from('WEBPVP8X', 'latin1'), Buffer.from([10, 0, 0, 0, 0x08, 0, 0, 0, 0, 0, 0, 0, 0, 0])]);
  const webp = Buffer.concat([Buffer.from('RIFF', 'latin1'), Buffer.from([webpBody.length, 0, 0, 0]), webpBody]);
  const gif = Buffer.concat([Buffer.from('GIF89a', 'latin1'), Buffer.alloc(16)]);
  const unknown = Buffer.from('this is not an image at all', 'latin1');

  for (const [name, mime, buf, format] of [
    ['IMG_0001.heic', 'image/heic', heic, 'HEIC'],
    ['photo.webp', 'image/webp', webp, 'WEBP'],
    ['anim.gif', 'image/gif', gif, 'GIF'],
    ['mystery.jpg', 'image/jpeg', unknown, null],
  ]) {
    const r = await analyse(page, name, mime, buf);
    assert.ok(!r.clean, `${name}: must not claim there is no hidden metadata:\n${r.visible}`);
    assert.ok(r.unchecked, `${name}: says the file could not be checked`);
    assert.match(r.unchecked, /لا يمكن الجزم/, `${name}: says absence of metadata is not established`);
    if (format) assert.match(r.unchecked, new RegExp(format), `${name}: names the unsupported format`);
    else assert.match(r.unchecked, /غير معروفة/, `${name}: says the format is unknown`);
    assert.doesNotMatch(r.visible, /not supported yet/, `${name}: no untranslated English note`);
  }
  assert.deepStrictEqual(errors, [], 'no page errors');
});

test('EXIF tool does not call a file with an unreadable EXIF block clean', async (t) => {
  const { page, errors } = await newExifPage(t);

  const tiff = buildTiff({ little: false, ifd0: [{ tag: 0x010f, type: 2, values: 'TARYAM' }] });
  tiff[3] = 43; // bad TIFF magic: the block is there but cannot be decoded
  const r = await analyse(page, 'broken.jpg', 'image/jpeg', wrapJpeg(tiff));
  assert.match(r.warnings || '', /unreadable/, 'the parser warning is shown');
  assert.ok(!r.clean, 'no clean verdict under an unreadable-EXIF warning:\n' + r.visible);
  assert.match(r.unchecked || '', /تعذّرت قراءتها/, 'says the EXIF block could not be read');
  assert.deepStrictEqual(errors, [], 'no page errors');
});

test('EXIF tool shows author, owner and serial tags and does not call them clean', async (t) => {
  const { page, errors } = await newExifPage(t);

  let tiff = buildTiff({
    little: false,
    ifd0: [
      { tag: 0x010e, type: 2, values: 'Home, 12 Example St' },               // ImageDescription
      { tag: 0x013b, type: 2, values: 'Jane Doe <jane@example.com>' },       // Artist
      { tag: 0x8298, type: 2, values: '(c) 2024 Jane Doe' },                 // Copyright
      { tag: 0x9c9d, type: 2, values: 'Jane Roe'.split('').join('\0') + '\0' }, // XPAuthor (UCS-2LE)
    ],
    exif: [
      { tag: 0xa435, type: 2, values: 'LNS-778899' },                        // LensSerialNumber
      { tag: 0xa420, type: 2, values: 'a1b2c3d4e5f60718' },                  // ImageUniqueID
      { tag: 0x9286, type: 2, values: 'ASCII\0\0\0call me on 555-0100' },    // UserComment
    ],
  });
  tiff = retype(retype(tiff, 0x9c9d, 1), 0x9286, 7);
  const r = await analyse(page, 'identity.jpg', 'image/jpeg', wrapJpeg(tiff));

  assert.ok(!r.clean, 'identifying tags must not get the clean verdict:\n' + r.visible);
  assert.strictEqual(r.unchecked, null, 'the file was parsed');
  assert.match(r.visible, /بيانات تعريفية/, 'an identifying-data section is shown');
  for (const v of ['Home, 12 Example St', 'Jane Doe <jane@example.com>', '(c) 2024 Jane Doe', 'Jane Roe', 'LNS-778899', 'a1b2c3d4e5f60718', 'call me on 555-0100']) {
    assert.ok(r.visible.includes(v), `"${v}" is visible outside the raw JSON`);
  }
  assert.deepStrictEqual(errors, [], 'no page errors');
});

test('EXIF tool flags GPS tags that do not decode into coordinates', async (t) => {
  const { page, errors } = await newExifPage(t);

  // Latitude/longitude stored as one decimal rational each: the parser cannot turn
  // them into coordinates, but they still give the location away.
  const tiff = buildTiff({
    little: false,
    ifd0: [],
    gps: [
      { tag: 0x0001, type: 2, values: 'N' },
      { tag: 0x0002, type: 5, values: [[2519, 100]] },
      { tag: 0x0003, type: 2, values: 'E' },
      { tag: 0x0004, type: 5, values: [[5527, 100]] },
    ],
  });
  const r = await analyse(page, 'odd-gps.jpg', 'image/jpeg', wrapJpeg(tiff));
  assert.ok(!r.clean, 'GPS tags must not get the clean verdict:\n' + r.visible);
  assert.match(r.visible, /الموقع الجغرافي \(GPS\)/, 'GPS section shown');
  assert.match(r.visible, /تعذّر تحويلها إلى إحداثيات/, 'says the GPS data could not be decoded');
  assert.match(r.visible, /25\.19/, 'raw latitude value is visible');
  assert.deepStrictEqual(errors, [], 'no page errors');
});

test('EXIF tool does not call a PNG with compressed metadata clean', async (t) => {
  const { page, errors } = await newExifPage(t);
  const { buildPng, pngChunk } = require('../helpers/make-image');
  const base = buildPng({ width: 2, height: 2 });
  const ztxt = pngChunk('zTXt', Buffer.concat([Buffer.from('Raw profile type exif', 'latin1'), Buffer.from([0, 0, 0x78, 0x9c, 1, 2, 3])]));
  const png = Buffer.concat([base.subarray(0, base.length - 12), ztxt, base.subarray(base.length - 12)]);
  const r = await analyse(page, 'profile.png', 'image/png', png);
  assert.ok(!r.clean, 'not called clean:\n' + r.visible);
  assert.match(r.unchecked || '', /لم يستطع الفحص فكّها/, 'says the metadata could not be decoded');
  assert.match(r.warnings || '', /not decoded/);
  assert.deepStrictEqual(errors, [], 'no page errors');
});

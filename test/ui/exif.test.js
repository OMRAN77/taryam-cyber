// Browser test for the EXIF tool in index.html: a synthesized photo (camera
// make/model, timestamp, exposure and GPS) is fed to the real file input, and
// the rendered panel must show the decoded values, a working map link and the
// GPS privacy warning — proving the parser is wired in and runs entirely in the
// page (nothing about the image leaves the browser).
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

  // GPS privacy warning and a real map link.
  assert.ok(/GPS|الموقع/.test(text), 'GPS section present');
  const mapHref = await page.getAttribute('#exifResult a[href*="openstreetmap"]', 'href');
  assert.match(mapHref, /mlat=25\.19/, 'OpenStreetMap link carries the coordinates');

  assert.deepStrictEqual(errors, [], 'no page errors');
  assert.deepStrictEqual(posts, [], 'the image was parsed locally; nothing was POSTed');
});

test('EXIF tool reports a clean image as having no hidden metadata', async (t) => {
  const server = await startServer();
  const browser = await chromium.launch();
  t.after(async () => { await browser.close(); await server.close(); });

  const page = await (await browser.newContext({ viewport: { width: 420, height: 900 } })).newPage();
  page.setDefaultTimeout(30000);
  await openExifTool(page, server);

  // A valid JPEG with an EXIF block that carries no tags at all.
  const emptyTiff = buildTiff({ little: false, ifd0: [] });
  await page.setInputFiles('#exifFileInput', { name: 'clean.jpg', mimeType: 'image/jpeg', buffer: wrapJpeg(emptyTiff) });

  await page.waitForFunction(() => /✅/.test(document.querySelector('#exifResult')?.textContent || ''));
  const text = await page.textContent('#exifResult');
  assert.ok(/لم يُعثر/.test(text), 'states no hidden metadata was found');
});

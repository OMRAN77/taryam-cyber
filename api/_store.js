// Vercel Blob helpers for server-only data (user records, counters, audit logs).
// The store is public-read: anything written at a guessable path can be fetched
// by anyone. Server-only records therefore live at an HMAC-derived path and are
// encrypted with AES-256-GCM, both keyed from AUTH_SECRET (see _secrets.js).
// Rotating AUTH_SECRET makes existing records unreadable, so don't rotate it
// without migrating them first.
const crypto = require('crypto');
const { deriveKey } = require('./_secrets');

const BLOB_BASE = 'https://blob.vercel-storage.com';
// Base backoff between read retries; tests lower it.
const config = { retryDelayMs: 300 };

function publicBase() {
  return 'https://' + (process.env.BLOB_STORE_ID || '6tfgxvttzyoiavtu') + '.public.blob.vercel-storage.com/';
}

function requireKey(purpose) {
  const key = deriveKey(purpose);
  if (!key) throw new Error('AUTH_SECRET is not configured');
  return key;
}

function secretPath(namespace, id) {
  const name = crypto.createHmac('sha256', requireKey('blob-path')).update(namespace + '\0' + id).digest('hex');
  return 'taryam/s/' + namespace + '/' + name + '.json';
}

// Directory prefix for per-caller quota markers. Derived the same way as secretPath so
// the caller address never appears in a path, but returned without the filename so a
// day's markers can be listed and counted.
function quotaPrefix(namespace, id) {
  const name = crypto.createHmac('sha256', requireKey('blob-path')).update(namespace + '\0' + id).digest('hex');
  return 'taryam/q/' + namespace + '/' + name + '/';
}

// Lists blob paths under a prefix through the authenticated Blob API rather than the
// public CDN. This matters for counters: public reads are CDN-cached and eventually
// consistent, so a read-modify-write counter built on readPublicJson can serve a stale
// count and stop counting. The list endpoint reflects what we just wrote.
async function listUnder(prefix, limit = 500) {
  const found = [];
  let cursor;
  for (let page = 0; page < 10; page++) {
    const url = new URL(BLOB_BASE + '/');
    url.searchParams.set('prefix', prefix);
    url.searchParams.set('limit', String(Math.min(1000, limit)));
    if (cursor) url.searchParams.set('cursor', cursor);
    const res = await fetch(url.toString(), { headers: { Authorization: 'Bearer ' + process.env.BLOB_READ_WRITE_TOKEN } });
    if (!res.ok) throw new Error('Blob list failed (' + res.status + ')');
    const data = await res.json();
    for (const b of data.blobs || []) found.push(b.pathname || b.url);
    if (!data.hasMore || !data.cursor || found.length >= limit) break;
    cursor = data.cursor;
  }
  return found;
}

// The path is bound in as associated data, so a record copied to another path won't decrypt.
function encrypt(obj, path) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', requireKey('blob-encryption'), iv);
  cipher.setAAD(Buffer.from(path));
  const ct = Buffer.concat([cipher.update(JSON.stringify(obj), 'utf8'), cipher.final()]);
  return { v: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ct: ct.toString('base64') };
}

function decrypt(box, path) {
  if (!box || box.v !== 1) throw new Error('Unrecognized record format at ' + path);
  const decipher = crypto.createDecipheriv('aes-256-gcm', requireKey('blob-encryption'), Buffer.from(box.iv, 'base64'));
  decipher.setAAD(Buffer.from(path));
  decipher.setAuthTag(Buffer.from(box.tag, 'base64'));
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(box.ct, 'base64')), decipher.final()]).toString('utf8'));
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// Public reads are eventually consistent: a blob written a moment ago can briefly
// 404, so callers that just wrote can ask for a few attempts with short backoff.
async function readPublicJson(path, attempts = 1) {
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(publicBase() + path + '?_=' + Date.now(), { cache: 'no-store' });
      if (res.ok) return await res.json();
    } catch (e) {
      // network hiccup: treat like a miss and retry
    }
    if (i < attempts - 1) await sleep(config.retryDelayMs * (i + 1));
  }
  return null;
}

async function writePublicJson(path, data) {
  const res = await fetch(BLOB_BASE + '/' + path, {
    method: 'PUT',
    headers: {
      Authorization: 'Bearer ' + process.env.BLOB_READ_WRITE_TOKEN,
      'x-content-type': 'application/json',
      'x-add-random-suffix': '0',
      'x-cache-control-max-age': '0',
    },
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error('Blob write failed (' + res.status + ') for ' + path);
}

// Returns the decrypted record, or null if nothing is stored there. Throws if a
// record exists but cannot be decrypted, so callers never mistake it for "free".
async function readSecret(path, attempts = 1) {
  const box = await readPublicJson(path, attempts);
  return box ? decrypt(box, path) : null;
}

async function writeSecret(path, obj) {
  await writePublicJson(path, encrypt(obj, path));
}

module.exports = { secretPath, quotaPrefix, listUnder, readSecret, writeSecret, readPublicJson, writePublicJson, config };

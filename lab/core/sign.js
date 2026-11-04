// Digital signatures for lab reports, with the browser's Web Crypto API only.
//
// Algorithm: Ed25519 (RFC 8032) where the browser has it, otherwise ECDSA on the
// P-256 curve with SHA-256 (FIPS 186-5). An ECDSA signature is the 64-byte r||s
// form Web Crypto produces (IEEE P1363), not DER.
//
// The auditor's key pair is created once, in the browser. The private key is
// non-extractable: the page can sign with it, but no script can read it out. It is
// kept in IndexedDB; when storage is unavailable, a key for this session only is
// used and the caller is told so (storage: 'session').
//
// Public keys travel as SPKI (RFC 5280 SubjectPublicKeyInfo, DER bytes). A key's
// fingerprint is the SHA-256 of those bytes.
export const ED25519 = 'Ed25519';
export const ECDSA_P256 = 'ECDSA-P256-SHA256';

const ALGS = {
  [ED25519]: { key: { name: 'Ed25519' }, sign: { name: 'Ed25519' } },
  [ECDSA_P256]: { key: { name: 'ECDSA', namedCurve: 'P-256' }, sign: { name: 'ECDSA', hash: 'SHA-256' } },
};
// In order of preference.
export const SIGNATURE_ALGORITHMS = [ED25519, ECDSA_P256];
export const ALGORITHM_INFO = {
  [ED25519]: { label: 'Ed25519', reference: 'RFC 8032', encoding: 'Ed25519 signature, 64 bytes' },
  [ECDSA_P256]: { label: 'ECDSA P-256 / SHA-256', reference: 'FIPS 186-5', encoding: 'IEEE P1363 r||s, 64 bytes' },
};

export class SignError extends Error {
  constructor(code, ar, en) {
    super(en);
    this.code = code;
    this.ar = ar;
    this.en = en;
  }
}

function getSubtle(subtle) {
  const s = subtle || (globalThis.crypto && globalThis.crypto.subtle);
  if (!s) throw new SignError('no-webcrypto', 'التوقيع يحتاج Web Crypto، وهي متاحة فقط في صفحة آمنة (https)', 'Signing needs Web Crypto, which is only available on a secure (https) page');
  return s;
}

const enc = new TextEncoder();
export const toHex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

export async function sha256(bytes, subtle) {
  return new Uint8Array(await getSubtle(subtle).digest('SHA-256', typeof bytes === 'string' ? enc.encode(bytes) : bytes));
}

// ---------- base64 (standard alphabet, padded) ----------
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export function toBase64(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63]
      + (i + 1 < bytes.length ? B64[(n >> 6) & 63] : '=')
      + (i + 2 < bytes.length ? B64[n & 63] : '=');
  }
  return out;
}

// Strict: only the canonical padded form is accepted (anything else gives null), so
// one signature has exactly one text form.
export function fromBase64(text) {
  if (typeof text !== 'string' || text.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(text)) return null;
  const pad = text.endsWith('==') ? 2 : text.endsWith('=') ? 1 : 0;
  const out = new Uint8Array((text.length / 4) * 3 - pad);
  let o = 0;
  for (let i = 0; i < text.length; i += 4) {
    let n = 0;
    for (let j = 0; j < 4; j++) n = (n << 6) | (text[i + j] === '=' ? 0 : B64.indexOf(text[i + j]));
    for (const shift of [16, 8, 0]) if (o < out.length) out[o++] = (n >> shift) & 255;
  }
  return toBase64(out) === text ? out : null;
}

// ---------- fingerprints ----------
export async function keyFingerprint(spki, subtle) {
  return toHex(await sha256(spki, subtle));
}

// "AB12 CD34 …": 16 groups of 4 hex digits, easy to read aloud and compare.
export function formatFingerprint(hex) {
  return String(hex).toUpperCase().match(/.{1,4}/g).join(' ');
}

// A fingerprint the user pastes: spaces, colons and dashes are ignored, case too.
// Blank gives null; anything but 64 hex digits is refused.
export function parseTrustedFingerprint(text) {
  if (text === null || text === undefined || String(text).trim() === '') return null;
  const hex = String(text).replace(/[\s:-]+/g, '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(hex)) {
    throw new SignError('bad-fingerprint', 'البصمة يجب أن تتكون من 64 خانة ست عشرية (0–9 و A–F)، والمسافات مسموحة', 'The fingerprint must be 64 hexadecimal digits (0–9, A–F); spaces are allowed');
  }
  return hex;
}

// ---------- keys, signing, verifying ----------
// Tries each algorithm in turn; the first one this browser supports is used.
export async function generateKeyPair({ algorithms = SIGNATURE_ALGORITHMS, subtle } = {}) {
  const s = getSubtle(subtle);
  for (const alg of algorithms) {
    try {
      const pair = await s.generateKey(ALGS[alg].key, false, ['sign', 'verify']);
      const spki = new Uint8Array(await s.exportKey('spki', pair.publicKey));
      return { alg, privateKey: pair.privateKey, publicKey: pair.publicKey, spki, fingerprint: await keyFingerprint(spki, s) };
    } catch (e) { /* not supported here: try the next one */ }
  }
  throw new SignError('no-algorithm', 'هذا المتصفح لا يدعم Ed25519 ولا ECDSA P-256 في Web Crypto', 'This browser supports neither Ed25519 nor ECDSA P-256 in Web Crypto');
}

export async function signBytes(key, bytes, { subtle } = {}) {
  return new Uint8Array(await getSubtle(subtle).sign(ALGS[key.alg].sign, key.privateKey, bytes));
}

// true or false. Throws SignError('unsupported') when this browser cannot check the
// algorithm at all, which is not the same as an invalid signature.
export async function verifyBytes({ alg, spki, signature, bytes }, { subtle } = {}) {
  const s = getSubtle(subtle);
  const a = ALGS[alg];
  if (!a) throw unsupported(alg);
  let key;
  try {
    key = await s.importKey('spki', spki, a.key, false, ['verify']);
  } catch (e) {
    if (e && e.name === 'NotSupportedError') throw unsupported(alg);
    return false; // not a valid public key for this algorithm
  }
  try { return await s.verify(a.sign, key, signature, bytes); } catch (e) { return false; }
}

function unsupported(alg) {
  return new SignError('unsupported', `هذا المتصفح لا يستطيع التحقق من توقيعات ${alg}`, `This browser cannot check ${alg} signatures`);
}

// ---------- key storage (IndexedDB) ----------
const DB_NAME = 'taryam-rtp-lab';
const STORE = 'keys';
const RECORD = 'report-signing-key';

function request(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('IndexedDB request failed'));
  });
}

function withTimeout(promise, ms) {
  let timer;
  const late = new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error('IndexedDB did not answer')), ms); });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

function openDb(idb) {
  return new Promise((resolve, reject) => {
    const req = idb.open(DB_NAME, 1);
    req.onupgradeneeded = () => { if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE); };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('IndexedDB open failed'));
    req.onblocked = () => reject(new Error('IndexedDB open blocked'));
  });
}

function readRecord(db) {
  return request(db.transaction(STORE, 'readonly').objectStore(STORE).get(RECORD));
}

// add() fails if another tab stored a key first; replace uses put().
function writeRecord(db, record, replace) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    const req = replace ? store.put(record, RECORD) : store.add(record, RECORD);
    req.onerror = (e) => { if (e && e.preventDefault) e.preventDefault(); reject(req.error || new Error('IndexedDB write failed')); };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || req.error || new Error('IndexedDB write failed'));
    tx.onabort = () => reject(tx.error || req.error || new Error('IndexedDB write aborted'));
  });
}

// A stored record is used only if it still signs, and its SPKI verifies that signature.
async function usableKey(record, subtle) {
  if (!record || !ALGS[record.alg] || !record.privateKey || !(record.spki instanceof Uint8Array)) return null;
  try {
    const probe = enc.encode('taryam-rtp-lab key check');
    const sig = await signBytes(record, probe, { subtle });
    if (!(await verifyBytes({ alg: record.alg, spki: record.spki, signature: sig, bytes: probe }, { subtle }))) return null;
    return { alg: record.alg, privateKey: record.privateKey, publicKey: record.publicKey, spki: record.spki, fingerprint: await keyFingerprint(record.spki, subtle), created: record.created || null };
  } catch (e) { return null; }
}

// The auditor's signing key: the stored one, or a new one that is stored for next
// time. When storage fails, a session-only key is returned with storage: 'session'
// and the reason in storageProblem. Pass idb: null to skip storage.
export async function loadSigningKey({ idb, algorithms, subtle, timeoutMs = 5000, now = () => new Date() } = {}) {
  let db = null, problem = null;
  try {
    const factory = idb === undefined ? globalThis.indexedDB : idb;
    if (!factory) throw new Error('IndexedDB is not available');
    db = await withTimeout(openDb(factory), timeoutMs);
    const stored = await withTimeout(readRecord(db), timeoutMs);
    const found = await usableKey(stored, subtle);
    if (found) return { ...found, storage: 'persistent' };
    const key = await generateKeyPair({ algorithms, subtle });
    const created = now().toISOString();
    const record = { alg: key.alg, privateKey: key.privateKey, publicKey: key.publicKey, spki: key.spki, created };
    try {
      await withTimeout(writeRecord(db, record, stored !== undefined && stored !== null), timeoutMs);
    } catch (e) {
      // Another tab stored its key first: use that one, so both sign with one key.
      const other = e && e.name === 'ConstraintError' ? await usableKey(await withTimeout(readRecord(db), timeoutMs), subtle) : null;
      if (other) return { ...other, storage: 'persistent' };
      throw e;
    }
    return { ...key, created, storage: 'persistent', replaced: stored !== undefined && stored !== null };
  } catch (e) {
    problem = e;
  } finally {
    try { if (db) db.close(); } catch (e) { /* already closed */ }
  }
  const key = await generateKeyPair({ algorithms, subtle });
  return { ...key, created: now().toISOString(), storage: 'session', storageProblem: String((problem && (problem.message || problem.name)) || problem) };
}

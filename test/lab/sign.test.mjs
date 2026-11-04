// Report signing keys (lab/core/sign.js). Expected values come from independent
// sources: RFC 8032's published test vectors, Node's own crypto module (base64,
// SHA-256 and signature verification are recomputed with node:crypto, not with the
// code under test), and hand-built inputs.
import test from 'node:test';
import assert from 'node:assert';
import nodeCrypto from 'node:crypto';
import {
  ED25519, ECDSA_P256, toBase64, fromBase64, keyFingerprint, formatFingerprint, parseTrustedFingerprint,
  generateKeyPair, signBytes, verifyBytes, loadSigningKey, SignError, isCanonicalSignature,
} from '../../lab/core/sign.js';

const hex = (h) => Uint8Array.from(Buffer.from(h, 'hex'));
const nodeSha256 = (b) => nodeCrypto.createHash('sha256').update(b).digest('hex');
const enc = new TextEncoder();

// ---- base64 ----
test('base64 matches Node for every length 0..70, and only the canonical form is read', () => {
  for (let n = 0; n <= 70; n++) {
    const bytes = Uint8Array.from({ length: n }, (_, i) => (i * 97 + n * 13) & 255);
    const expected = Buffer.from(bytes).toString('base64'); // independent encoder
    assert.strictEqual(toBase64(bytes), expected, 'length ' + n);
    assert.deepStrictEqual(fromBase64(expected), bytes, 'decode length ' + n);
  }
  // "QQ==" is the only form of the byte 0x41; "QR==" has non-zero padding bits.
  assert.deepStrictEqual(fromBase64('QQ=='), Uint8Array.of(0x41));
  for (const bad of ['QR==', 'QQ', 'QQ=', '====', 'QUJD\n', 'QU JD', 'QUJD-_==', 42, null]) assert.strictEqual(fromBase64(bad), null, String(bad));
});

// ---- fingerprints ----
test('fingerprint is SHA-256 of the SPKI bytes; formatting and parsing of pasted fingerprints', async () => {
  const spki = hex('302a300506032b6570032100' + 'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a');
  const fp = await keyFingerprint(spki);
  assert.strictEqual(fp, nodeSha256(spki));
  const shown = formatFingerprint(fp);
  assert.strictEqual(shown.split(' ').length, 16);
  assert.strictEqual(shown.replace(/ /g, '').toLowerCase(), fp);
  assert.strictEqual(parseTrustedFingerprint(shown), fp);
  assert.strictEqual(parseTrustedFingerprint(shown.toLowerCase().replace(/ /g, ':')), fp);
  assert.strictEqual(parseTrustedFingerprint('  '), null);
  assert.strictEqual(parseTrustedFingerprint(null), null);
  for (const bad of [fp.slice(1), fp + '0', fp.slice(0, 63) + 'g']) {
    assert.throws(() => parseTrustedFingerprint(bad), (e) => e instanceof SignError && e.code === 'bad-fingerprint' && Boolean(e.ar && e.en));
  }
});

// ---- published vectors ----
// RFC 8032 section 7.1, TEST 1 (empty message) and TEST 2 (one byte, 0x72). The
// SPKI wrapping of a raw Ed25519 key is the fixed 12-byte prefix of RFC 8410.
const RFC8032 = [
  { pk: 'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a', msg: '', sig: 'e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b' },
  { pk: '3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c', msg: '72', sig: '92a009a9f0d4cab8720e820b5f642540a2b27b5416503f8fb3762223ebdb69da085ac1e43e15996e458f3613d0f11d8c387b2eaeb4302aeeb00d291612bb0c00' },
];
test('Ed25519 verification accepts the RFC 8032 test vectors and rejects altered ones', async () => {
  for (const v of RFC8032) {
    const spki = hex('302a300506032b6570032100' + v.pk);
    const signature = hex(v.sig), bytes = hex(v.msg);
    assert.strictEqual(await verifyBytes({ alg: ED25519, spki, signature, bytes }), true);
    const badSig = signature.slice(); badSig[10] ^= 1;
    assert.strictEqual(await verifyBytes({ alg: ED25519, spki, signature: badSig, bytes }), false);
    assert.strictEqual(await verifyBytes({ alg: ED25519, spki, signature, bytes: Uint8Array.of(...bytes, 0) }), false);
  }
  // The other vector's key does not verify this signature.
  assert.strictEqual(await verifyBytes({ alg: ED25519, spki: hex('302a300506032b6570032100' + RFC8032[1].pk), signature: hex(RFC8032[0].sig), bytes: new Uint8Array(0) }), false);
});

// ---- round trips, both algorithms ----
for (const alg of [ED25519, ECDSA_P256]) {
  test(`${alg}: sign/verify round trip, cross-checked with node:crypto; tampering and wrong keys fail`, async () => {
    const key = await generateKeyPair({ algorithms: [alg] });
    assert.strictEqual(key.alg, alg);
    assert.strictEqual(key.privateKey.extractable, false, 'private key is not extractable');
    assert.strictEqual(key.fingerprint, nodeSha256(key.spki));
    const message = enc.encode('{"format":"taryam-rtp-lab-report/1","rtp":"0.955175"}');
    const sig = await signBytes(key, message);
    assert.strictEqual(sig.length, 64);
    assert.strictEqual(await verifyBytes({ alg, spki: key.spki, signature: sig, bytes: message }), true);

    // Independent verifier: Node's crypto module with the exported SPKI.
    const pub = nodeCrypto.createPublicKey({ key: Buffer.from(key.spki), format: 'der', type: 'spki' });
    const nodeOk = alg === ED25519
      ? nodeCrypto.verify(null, message, pub, sig)
      : nodeCrypto.verify('sha256', message, { key: pub, dsaEncoding: 'ieee-p1363' }, sig);
    assert.strictEqual(nodeOk, true, 'node:crypto accepts the signature');

    // One byte of the message or of the signature changed: rejected, at every position tried.
    for (const i of [0, 7, message.length - 1]) {
      const m = message.slice(); m[i] ^= 0x01;
      assert.strictEqual(await verifyBytes({ alg, spki: key.spki, signature: sig, bytes: m }), false, 'message byte ' + i);
    }
    for (const i of [0, 31, 32, 63]) {
      const s = sig.slice(); s[i] ^= 0x80;
      assert.strictEqual(await verifyBytes({ alg, spki: key.spki, signature: s, bytes: message }), false, 'signature byte ' + i);
    }
    // Another key of the same algorithm, and a key of the other algorithm.
    const other = await generateKeyPair({ algorithms: [alg] });
    assert.strictEqual(await verifyBytes({ alg, spki: other.spki, signature: sig, bytes: message }), false);
    const foreign = await generateKeyPair({ algorithms: [alg === ED25519 ? ECDSA_P256 : ED25519] });
    assert.strictEqual(await verifyBytes({ alg, spki: foreign.spki, signature: sig, bytes: message }), false);
    assert.strictEqual(await verifyBytes({ alg, spki: Uint8Array.of(1, 2, 3), signature: sig, bytes: message }), false, 'garbage key');
  });
}

// A Web Crypto stand-in that lacks Ed25519, like browsers before it shipped.
function subtleWithoutEd25519() {
  const real = globalThis.crypto.subtle;
  const no = () => Promise.reject(Object.assign(new Error('Unrecognized algorithm name'), { name: 'NotSupportedError' }));
  const isEd = (a) => (typeof a === 'string' ? a : a && a.name) === 'Ed25519';
  return {
    digest: (...a) => real.digest(...a),
    generateKey: (a, ...r) => (isEd(a) ? no() : real.generateKey(a, ...r)),
    importKey: (f, k, a, ...r) => (isEd(a) ? no() : real.importKey(f, k, a, ...r)),
    exportKey: (...a) => real.exportKey(...a),
    sign: (...a) => real.sign(...a),
    verify: (...a) => real.verify(...a),
  };
}

test('without Ed25519 the key falls back to ECDSA P-256, and Ed25519 signatures are "unsupported", not invalid', async () => {
  const subtle = subtleWithoutEd25519();
  const key = await generateKeyPair({ subtle });
  assert.strictEqual(key.alg, ECDSA_P256);
  const msg = enc.encode('fallback');
  assert.strictEqual(await verifyBytes({ alg: ECDSA_P256, spki: key.spki, signature: await signBytes(key, msg, { subtle }), bytes: msg }, { subtle }), true);
  const v = RFC8032[0];
  await assert.rejects(
    verifyBytes({ alg: ED25519, spki: hex('302a300506032b6570032100' + v.pk), signature: hex(v.sig), bytes: new Uint8Array(0) }, { subtle }),
    (e) => e instanceof SignError && e.code === 'unsupported',
  );
  await assert.rejects(verifyBytes({ alg: 'RSA-PSS', spki: key.spki, signature: new Uint8Array(64), bytes: msg }), (e) => e.code === 'unsupported');
  await assert.rejects(generateKeyPair({ algorithms: [ED25519], subtle }), (e) => e instanceof SignError && e.code === 'no-algorithm');
});

// ---- key storage ----
// In-memory stand-in for IndexedDB with the same asynchronous request/transaction
// events. Options make it fail the way real browsers can.
function fakeIndexedDB({ throwOnOpen = false, failWrites = false, neverAnswer = false } = {}) {
  const data = new Map();
  let created = false;
  const later = (fn) => setTimeout(fn, 1);
  const request = () => ({ onsuccess: null, onerror: null, result: undefined, error: null });
  const db = {
    objectStoreNames: { contains: () => created },
    createObjectStore: () => { created = true; },
    close: () => {},
    transaction: () => {
      const tx = { oncomplete: null, onerror: null, onabort: null, error: null };
      const write = (value, key, overwrite) => {
        const r = request();
        later(() => {
          if (failWrites || (!overwrite && data.has(key))) {
            r.error = failWrites ? Object.assign(new Error('quota exceeded'), { name: 'QuotaExceededError' }) : Object.assign(new Error('key exists'), { name: 'ConstraintError' });
            if (r.onerror) r.onerror({ preventDefault() {} });
            tx.error = r.error;
            if (tx.onabort) tx.onabort();
            return;
          }
          data.set(key, value);
          r.result = key;
          if (r.onsuccess) r.onsuccess();
          later(() => tx.oncomplete && tx.oncomplete());
        });
        return r;
      };
      tx.objectStore = () => ({
        get: (key) => { const r = request(); later(() => { r.result = data.get(key); if (r.onsuccess) r.onsuccess(); }); return r; },
        add: (value, key) => write(value, key, false),
        put: (value, key) => write(value, key, true),
      });
      return tx;
    },
  };
  return {
    data,
    open() {
      if (throwOnOpen) throw Object.assign(new Error('The operation is insecure.'), { name: 'SecurityError' });
      const r = request();
      if (!neverAnswer) later(() => { r.result = db; if (!created && r.onupgradeneeded) r.onupgradeneeded(); if (r.onsuccess) r.onsuccess(); });
      return r;
    },
  };
}

test('the signing key is stored once and found again; the private key stays non-extractable', async () => {
  const idb = fakeIndexedDB();
  const first = await loadSigningKey({ idb });
  assert.strictEqual(first.storage, 'persistent');
  assert.strictEqual(first.alg, ED25519, 'Node has Ed25519, so it is preferred');
  assert.strictEqual(idb.data.size, 1);
  const second = await loadSigningKey({ idb });
  assert.strictEqual(second.storage, 'persistent');
  assert.strictEqual(second.fingerprint, first.fingerprint);
  assert.strictEqual(second.privateKey.extractable, false);
  assert.strictEqual(second.fingerprint, nodeSha256(second.spki));
  // It still signs, and the signature checks out with the stored public key.
  const msg = enc.encode('again');
  assert.ok(await verifyBytes({ alg: second.alg, spki: second.spki, signature: await signBytes(second, msg), bytes: msg }));
});

test('two tabs creating a key at the same time end up with the same stored key', async () => {
  const idb = fakeIndexedDB();
  const [a, b] = await Promise.all([loadSigningKey({ idb }), loadSigningKey({ idb })]);
  assert.strictEqual(a.storage, 'persistent');
  assert.strictEqual(b.storage, 'persistent');
  assert.strictEqual(a.fingerprint, b.fingerprint);
});

test('a stored key that no longer works is replaced, and the caller is told', async () => {
  const idb = fakeIndexedDB();
  const good = await loadSigningKey({ idb });
  const other = await generateKeyPair();
  const record = [...idb.data.values()][0];
  record.spki = other.spki; // public key no longer matches the private key
  const next = await loadSigningKey({ idb });
  assert.strictEqual(next.storage, 'persistent');
  assert.strictEqual(next.replaced, true);
  assert.notStrictEqual(next.fingerprint, good.fingerprint);
  // The fingerprint the stored record carried, for the page to show: SHA-256 of
  // its SPKI bytes, recomputed with node:crypto.
  assert.strictEqual(next.previousFingerprint, nodeSha256(other.spki));
  const again = await loadSigningKey({ idb });
  assert.strictEqual(again.fingerprint, next.fingerprint);
  assert.strictEqual(again.replaced, undefined, 'a key that works is not reported as replaced');
  // The reviewer's record: no private key and an all-zero 44-byte SPKI.
  const [k] = [...idb.data.keys()];
  idb.data.set(k, { alg: ED25519, privateKey: null, spki: new Uint8Array(44) });
  const fresh = await loadSigningKey({ idb });
  assert.strictEqual(fresh.replaced, true);
  assert.strictEqual(fresh.previousFingerprint, nodeSha256(new Uint8Array(44)));
});

// ---- one accepted form per signature ----
// n: order of the P-256 group (SEC 2 secp256r1, FIPS 186-5). L: order of the
// Ed25519 base point, written in RFC 8032 5.1 as 2^252 + 27742317777372353535851937790883648493;
// its usual hex form is checked against that decimal form here.
const P256_N = BigInt('0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551');
const ED25519_L = 2n ** 252n + 27742317777372353535851937790883648493n;
const bigBE = (b) => BigInt('0x' + Buffer.from(b).toString('hex'));
const be32 = (x) => Uint8Array.from(Buffer.from(x.toString(16).padStart(64, '0'), 'hex'));

test('ECDSA: the lab signs with s <= n/2, and refuses (r, n - s), which node:crypto accepts', async () => {
  const key = await generateKeyPair({ algorithms: [ECDSA_P256] });
  const pub = nodeCrypto.createPublicKey({ key: Buffer.from(key.spki), format: 'der', type: 'spki' });
  const nodeOk = (msg, sig) => nodeCrypto.verify('sha256', msg, { key: pub, dsaEncoding: 'ieee-p1363' }, sig);
  // 64 signatures: each comes out high with probability 1/2, so without the rule at
  // least one would be high (all low by chance: 2^-64).
  for (let i = 0; i < 64; i++) {
    const msg = enc.encode('low-s ' + i);
    const sig = await signBytes(key, msg);
    const s = bigBE(sig.subarray(32));
    assert.ok(s >= 1n && s <= P256_N / 2n, 'signature ' + i + ' has a high s');
    assert.ok(nodeOk(msg, sig), 'node:crypto accepts signature ' + i);
    assert.strictEqual(await verifyBytes({ alg: ECDSA_P256, spki: key.spki, signature: sig, bytes: msg }), true);
    const high = Uint8Array.of(...sig.subarray(0, 32), ...be32(P256_N - s));
    assert.ok(nodeOk(msg, high), 'the mirrored signature is mathematically valid');
    assert.strictEqual(await verifyBytes({ alg: ECDSA_P256, spki: key.spki, signature: high, bytes: msg }), false);
  }
  // A high-s signature made by node:crypto's own key is refused; its low twin passes.
  const { privateKey, publicKey } = nodeCrypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const spki = Uint8Array.from(publicKey.export({ type: 'spki', format: 'der' }));
  const msg = enc.encode('made by node');
  const raw = Uint8Array.from(nodeCrypto.sign('sha256', msg, { key: privateKey, dsaEncoding: 'ieee-p1363' }));
  const s = bigBE(raw.subarray(32));
  const low = Uint8Array.of(...raw.subarray(0, 32), ...be32(s <= P256_N / 2n ? s : P256_N - s));
  const high = Uint8Array.of(...raw.subarray(0, 32), ...be32(s <= P256_N / 2n ? P256_N - s : s));
  assert.strictEqual(await verifyBytes({ alg: ECDSA_P256, spki, signature: low, bytes: msg }), true);
  assert.strictEqual(await verifyBytes({ alg: ECDSA_P256, spki, signature: high, bytes: msg }), false);
});

test('Ed25519: a signature whose S is not below L is refused (RFC 8032 5.1.7)', async () => {
  assert.strictEqual(ED25519_L, BigInt('0x1000000000000000000000000000000014def9dea2f79cd65812631a5cf5d3ed'));
  for (const v of RFC8032) {
    const spki = hex('302a300506032b6570032100' + v.pk);
    const sig = hex(v.sig), bytes = hex(v.msg);
    assert.strictEqual(await verifyBytes({ alg: ED25519, spki, signature: sig, bytes }), true);
    // S is little-endian in bytes 32..63; S + L (< 2^253) still fits in 32 bytes.
    const S = bigBE(Uint8Array.from(sig.subarray(32)).reverse());
    const plusL = Uint8Array.from(be32(S + ED25519_L)).reverse();
    const forged = Uint8Array.of(...sig.subarray(0, 32), ...plusL);
    assert.strictEqual(await verifyBytes({ alg: ED25519, spki, signature: forged, bytes }), false);
    assert.strictEqual(isCanonicalSignature(ED25519, forged), false);
    assert.strictEqual(isCanonicalSignature(ED25519, sig), true);
  }
  // Wrong lengths are refused for both algorithms, before Web Crypto is asked.
  for (const alg of [ED25519, ECDSA_P256]) {
    assert.strictEqual(isCanonicalSignature(alg, new Uint8Array(63)), false);
    assert.strictEqual(isCanonicalSignature(alg, new Uint8Array(65)), false);
  }
  // The check does not change the caller's bytes (a Node Buffer's slice is a view).
  const buf = Buffer.from(RFC8032[0].sig, 'hex');
  isCanonicalSignature(ED25519, buf);
  assert.strictEqual(buf.toString('hex'), RFC8032[0].sig);
});

test('without usable storage a session-only key is used and the reason is kept', async () => {
  const cases = [
    [{ idb: null }, /not available/],
    [{ idb: fakeIndexedDB({ throwOnOpen: true }) }, /insecure/],
    [{ idb: fakeIndexedDB({ failWrites: true }) }, /quota/],
    [{ idb: fakeIndexedDB({ neverAnswer: true }), timeoutMs: 30 }, /did not answer/],
  ];
  for (const [opts, reason] of cases) {
    const key = await loadSigningKey(opts);
    assert.strictEqual(key.storage, 'session');
    assert.match(key.storageProblem, reason);
    const msg = enc.encode('session');
    assert.ok(await verifyBytes({ alg: key.alg, spki: key.spki, signature: await signBytes(key, msg), bytes: msg }));
  }
  // A failing store and no Ed25519: still a working session key, on ECDSA.
  const key = await loadSigningKey({ idb: null, subtle: subtleWithoutEd25519() });
  assert.strictEqual(key.alg, ECDSA_P256);
  assert.strictEqual(key.storage, 'session');
});

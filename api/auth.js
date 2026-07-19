// Vercel Serverless Function: full signup/login account system.
// Each user is stored as its OWN blob file (db/users/{username}.json) in Vercel Blob
// storage. This avoids any read-modify-write race across concurrent signups/logins
// that a single shared JSON file would have (lost updates when two requests land
// close together). Passwords are NEVER stored in plain text — scrypt hash + random
// salt per user. Sessions are signed tokens (HMAC-SHA256) — no plaintext secrets
// ever reach the client.
const crypto = require('crypto');

const BLOB_TOKEN = process.env.BLOB_READ_WRITE_TOKEN;
const AUTH_SECRET = process.env.AUTH_SECRET || 'fallback-dev-secret-change-me';
const BLOB_BASE = 'https://blob.vercel-storage.com';
const STORE_ID = process.env.BLOB_STORE_ID || '6tfgxvttzyoiavtu';
const PUBLIC_BASE = 'https://' + STORE_ID + '.public.blob.vercel-storage.com/';

function userPath(key) {
  // key must already be the normalized (lowercased, trimmed) username.
  return 'taryam/db/users/' + encodeURIComponent(key) + '.json';
}

function hashPassword(password, salt) {
  salt = salt || crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { salt, hash };
}

function verifyPassword(password, salt, hash) {
  const check = crypto.scryptSync(password, salt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(check), Buffer.from(hash));
}

function genRecoveryCode() {
  const bytes = crypto.randomBytes(10).toString('hex').toUpperCase(); // 20 hex chars
  return bytes.match(/.{1,4}/g).join('-'); // XXXX-XXXX-XXXX-XXXX-XXXX
}

function makeToken(username) {
  const payload = Buffer.from(JSON.stringify({ u: username, exp: Date.now() + 1000 * 60 * 60 * 24 * 30 })).toString('base64url');
  const sig = crypto.createHmac('sha256', AUTH_SECRET).update(payload).digest('base64url');
  return payload + '.' + sig;
}

function verifyToken(token) {
  try {
    const [payload, sig] = String(token).split('.');
    const expected = crypto.createHmac('sha256', AUTH_SECRET).update(payload).digest('base64url');
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
    if (data.exp < Date.now()) return null;
    return data.u;
  } catch (e) {
    return null;
  }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function getUserOnce(key) {
  try {
    const res = await fetch(PUBLIC_BASE + userPath(key) + '?_=' + Date.now(), { cache: 'no-store' });
    if (!res.ok) return null;
    return await res.json();
  } catch (e) {
    return null;
  }
}

// Vercel Blob's public read URL is eventually consistent — a blob written a
// moment ago (e.g. right after signup/reset) can briefly 404 on read. Retry a
// few times with short backoff to smooth over that window before giving up.
async function getUser(key, attempts) {
  attempts = attempts || 4;
  for (let i = 0; i < attempts; i++) {
    const user = await getUserOnce(key);
    if (user) return user;
    if (i < attempts - 1) await sleep(300 * (i + 1));
  }
  return null;
}

async function putUser(key, user) {
  await fetch(BLOB_BASE + '/' + userPath(key), {
    method: 'PUT',
    headers: {
      Authorization: 'Bearer ' + BLOB_TOKEN,
      'x-content-type': 'application/json',
      'x-add-random-suffix': '0',
      'x-cache-control-max-age': '0',
    },
    body: JSON.stringify(user),
  });
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  if (!BLOB_TOKEN) {
    res.status(500).json({ error: 'Server is missing BLOB_READ_WRITE_TOKEN' });
    return;
  }

  try {
    let body = req.body;
    if (!body || typeof body === 'string') body = JSON.parse(body || '{}');
    const { action, username, password, token, recoveryCode, newPassword, newUsername, currentPassword, avatarDataUrl, lang } = body;
    const isEn = lang === 'en';
    // Small helper to return the message matching the caller's UI language
    // (client always sends its current language along with every request).
    const m = (ar, en) => (isEn ? en : ar);

    if (action === 'signup') {
      if (!username || !password || String(username).length < 3 || String(password).length < 4) {
        res.status(400).json({ error: m('اسم المستخدم يجب أن يكون 3 أحرف على الأقل وكلمة المرور 4 أحرف على الأقل', 'Username must be at least 3 characters and password at least 4 characters') });
        return;
      }
      const key = String(username).trim().toLowerCase();
      const existing = await getUser(key);
      if (existing && !existing.deleted) {
        res.status(409).json({ error: m('اسم المستخدم مستخدم من قبل', 'Username already taken') });
        return;
      }
      const { salt, hash } = hashPassword(password);
      const recCode = genRecoveryCode();
      const rec = hashPassword(recCode);
      const user = {
        username: String(username).trim(), salt, hash,
        recoverySalt: rec.salt, recoveryHash: rec.hash,
        avatar: null,
        createdAt: Date.now(),
      };
      await putUser(key, user);
      res.status(200).json({ ok: true, token: makeToken(key), username: user.username, recoveryCode: recCode, avatar: null });
      return;
    }

    if (action === 'changeUsername') {
      const u = verifyToken(token);
      if (!u) {
        res.status(401).json({ error: m('الجلسة منتهية، سجل الدخول من جديد', 'Session expired, please log in again') });
        return;
      }
      if (!newUsername || String(newUsername).trim().length < 3) {
        res.status(400).json({ error: m('اسم المستخدم يجب أن يكون 3 أحرف على الأقل', 'Username must be at least 3 characters') });
        return;
      }
      const oldKey = u;
      const newKey = String(newUsername).trim().toLowerCase();
      if (newKey === oldKey) {
        res.status(200).json({ ok: true, token, username: newUsername.trim() });
        return;
      }
      const clash = await getUser(newKey);
      if (clash && !clash.deleted) {
        res.status(409).json({ error: m('اسم المستخدم مستخدم من قبل', 'Username already taken') });
        return;
      }
      const user = await getUser(oldKey);
      if (!user) {
        res.status(404).json({ error: m('تعذر العثور على الحساب', 'Could not find the account') });
        return;
      }
      const movedUser = Object.assign({}, user, { username: String(newUsername).trim() });
      await putUser(newKey, movedUser);
      // Free up the old key so it can't be logged into or re-claimed while pointing here.
      await putUser(oldKey, { deleted: true, movedTo: newKey });
      res.status(200).json({ ok: true, token: makeToken(newKey), username: movedUser.username, avatar: movedUser.avatar || null });
      return;
    }

    if (action === 'changePassword') {
      const u = verifyToken(token);
      if (!u) {
        res.status(401).json({ error: m('الجلسة منتهية، سجل الدخول من جديد', 'Session expired, please log in again') });
        return;
      }
      if (!currentPassword || !newPassword || String(newPassword).length < 4) {
        res.status(400).json({ error: m('أدخل كلمة المرور الحالية وكلمة مرور جديدة (4 أحرف على الأقل)', 'Enter your current password and a new password (at least 4 characters)') });
        return;
      }
      const user = await getUser(u);
      if (!user || user.deleted || !verifyPassword(currentPassword, user.salt, user.hash)) {
        res.status(401).json({ error: m('كلمة المرور الحالية غير صحيحة', 'Current password is incorrect') });
        return;
      }
      const { salt, hash } = hashPassword(newPassword);
      user.salt = salt;
      user.hash = hash;
      await putUser(u, user);
      res.status(200).json({ ok: true });
      return;
    }

    if (action === 'setAvatar') {
      const u = verifyToken(token);
      if (!u) {
        res.status(401).json({ error: m('الجلسة منتهية، سجل الدخول من جديد', 'Session expired, please log in again') });
        return;
      }
      if (!avatarDataUrl || typeof avatarDataUrl !== 'string' || avatarDataUrl.length > 300000) {
        res.status(400).json({ error: m('الصورة غير صالحة أو كبيرة جدًا', 'Image is invalid or too large') });
        return;
      }
      const user = await getUser(u);
      if (!user || user.deleted) {
        res.status(404).json({ error: m('تعذر العثور على الحساب', 'Could not find the account') });
        return;
      }
      user.avatar = avatarDataUrl;
      await putUser(u, user);
      res.status(200).json({ ok: true, avatar: avatarDataUrl });
      return;
    }

    if (action === 'reset') {
      if (!username || !recoveryCode || !newPassword || String(newPassword).length < 4) {
        res.status(400).json({ error: m('أدخل اسم المستخدم ورمز الاسترجاع وكلمة مرور جديدة (4 أحرف على الأقل)', 'Enter your username, recovery code, and a new password (at least 4 characters)') });
        return;
      }
      const key = String(username).trim().toLowerCase();
      const user = await getUser(key);
      if (!user || user.deleted || !user.recoveryHash || !verifyPassword(String(recoveryCode).trim().toUpperCase(), user.recoverySalt, user.recoveryHash)) {
        res.status(401).json({ error: m('اسم المستخدم أو رمز الاسترجاع غير صحيح', 'Incorrect username or recovery code') });
        return;
      }
      const { salt, hash } = hashPassword(newPassword);
      const newRec = genRecoveryCode();
      const rec = hashPassword(newRec);
      user.salt = salt;
      user.hash = hash;
      user.recoverySalt = rec.salt;
      user.recoveryHash = rec.hash;
      await putUser(key, user);
      res.status(200).json({ ok: true, token: makeToken(key), username: user.username, recoveryCode: newRec, avatar: user.avatar || null });
      return;
    }

    if (action === 'login') {
      if (!username || !password) {
        res.status(400).json({ error: m('أدخل اسم المستخدم وكلمة المرور', 'Enter your username and password') });
        return;
      }
      const key = String(username).trim().toLowerCase();
      const user = await getUser(key);
      if (!user || user.deleted || !verifyPassword(password, user.salt, user.hash)) {
        res.status(401).json({ error: m('اسم المستخدم أو كلمة المرور غير صحيحة', 'Incorrect username or password') });
        return;
      }
      res.status(200).json({ ok: true, token: makeToken(key), username: user.username, avatar: user.avatar || null });
      return;
    }

    if (action === 'verify') {
      const u = verifyToken(token);
      if (!u) {
        res.status(401).json({ error: m('الجلسة منتهية، سجل الدخول من جديد', 'Session expired, please log in again') });
        return;
      }
      // Trust a validly-signed, unexpired token even if the user record lookup
      // is momentarily unavailable (e.g. right after signup) — avoids forcing a
      // fresh login due to brief storage propagation delay.
      const user = await getUser(u);
      if (user && user.deleted) {
        res.status(401).json({ error: m('الجلسة منتهية، سجل الدخول من جديد', 'Session expired, please log in again') });
        return;
      }
      res.status(200).json({ ok: true, username: user ? user.username : u, avatar: user ? (user.avatar || null) : null });
      return;
    }

    res.status(400).json({ error: 'Unknown action' });
  } catch (e) {
    res.status(500).json({ error: 'Auth error: ' + (e && e.message ? e.message : String(e)) });
  }
};

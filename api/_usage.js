// Shared helper for the free server-proxied providers (Groq / OpenAI / Claude),
// which run on the site owner's own API keys. Enforces a daily message cap per
// logged-in account so a single account can't run up the owner's bill. Usage is
// stored as one small JSON blob per user (db/usage/<username>.json), separate
// from the account record in db/users/, and resets automatically each day (UTC).
const crypto = require('crypto');

const AUTH_SECRET = process.env.AUTH_SECRET || 'fallback-dev-secret-change-me';
const BLOB_TOKEN = process.env.BLOB_READ_WRITE_TOKEN;
const BLOB_BASE = 'https://blob.vercel-storage.com';
const STORE_ID = process.env.BLOB_STORE_ID || '6tfgxvttzyoiavtu';
const PUBLIC_BASE = 'https://' + STORE_ID + '.public.blob.vercel-storage.com/';

// Combined daily limit shared across all three free server-proxied providers
// (Groq + OpenAI + Claude), per logged-in account.
const DAILY_LIMIT = 20;

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

function usagePath(key) {
  return 'taryam/db/usage/' + encodeURIComponent(key) + '.json';
}

function todayStr() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
}

async function getUsage(key) {
  try {
    const res = await fetch(PUBLIC_BASE + usagePath(key) + '?_=' + Date.now(), { cache: 'no-store' });
    if (!res.ok) return null;
    return await res.json();
  } catch (e) {
    return null;
  }
}

async function putUsage(key, usage) {
  try {
    await fetch(BLOB_BASE + '/' + usagePath(key), {
      method: 'PUT',
      headers: {
        Authorization: 'Bearer ' + BLOB_TOKEN,
        'x-content-type': 'application/json',
        'x-add-random-suffix': '0',
        'x-cache-control-max-age': '0',
      },
      body: JSON.stringify(usage),
    });
  } catch (e) {
    // Best-effort: if this fails, worst case is one extra free message slips
    // through today — never block the actual AI request over a bookkeeping write.
  }
}

// Lifetime cap (not daily) for anonymous guests trying the app before creating
// an account. Tracked by a random client-generated id stored in localStorage
// (see aiapp_guest_id / getGuestId() in index.html), never used for anything
// sensitive — it only limits how many free trial messages one browser gets.
const GUEST_LIMIT = 20;

function isValidGuestId(id) {
  return typeof id === 'string' && /^[a-zA-Z0-9_-]{6,64}$/.test(id);
}

// Verifies the session token and, if valid and under quota, atomically-ish
// consumes one message from today's allowance. Returns:
//   { allowed: true,  username, remaining }
//   { allowed: false, reason: 'auth' | 'limit', username }
// If there is no valid login token but a guestId is supplied, falls back to a
// lifetime free-trial allowance for that anonymous browser instead of hard
// requiring an account (guest mode UX promise: N free messages, no login).
async function checkAndConsume(token, guestId) {
  const username = verifyToken(token);
  if (username) {
    const today = todayStr();
    let usage = await getUsage(username);
    if (!usage || usage.date !== today) {
      usage = { date: today, count: 0 };
    }
    if (usage.count >= DAILY_LIMIT) {
      return { allowed: false, reason: 'limit', username };
    }
    usage.count += 1;
    await putUsage(username, usage);
    return { allowed: true, username, remaining: DAILY_LIMIT - usage.count };
  }

  if (isValidGuestId(guestId)) {
    const key = 'guest_' + guestId;
    let usage = await getUsage(key);
    if (!usage) usage = { count: 0 };
    if (usage.count >= GUEST_LIMIT) {
      return { allowed: false, reason: 'limit', username: null };
    }
    usage.count += 1;
    await putUsage(key, usage);
    return { allowed: true, username: null, remaining: GUEST_LIMIT - usage.count };
  }

  return { allowed: false, reason: 'auth', username: null };
}

module.exports = { checkAndConsume, DAILY_LIMIT, GUEST_LIMIT };

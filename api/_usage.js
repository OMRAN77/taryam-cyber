// Shared quota helper for the server-proxied providers (chat, speech-to-text and
// text-to-speech), which run on the site owner's own API keys. Logged-in accounts
// get a daily allowance per bucket; guests get a daily allowance per client IP.
// The guestId the browser sends is not used for this, since anyone can change it.
// Counters are stored encrypted at unguessable Blob paths (see _store.js) and reset
// automatically each day (UTC).
const { verifyToken } = require('./_secrets');
const store = require('./_store');
const { clientIp } = require('./_client');

// Combined daily chat limit shared across all server-proxied chat providers and STT.
const DAILY_LIMIT = 20;
const GUEST_LIMIT = 20;
const LIMITS = {
  chat: { account: DAILY_LIMIT, guest: GUEST_LIMIT },
  tts: { account: 30, guest: 10 },
  // The owner's TARYAM browser extension (asks Claude/GPT/DeepSeek once per roulette
  // round). Its own bucket so it never eats the site's chat quota; the high cap
  // only protects the owner's API keys from a runaway loop or a stranger.
  ext: { account: 1000, guest: 1000 },
};

function todayStr() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
}

// Verifies the session token and, if under quota, atomically-ish consumes one unit
// of today's allowance for the bucket. Returns:
//   { allowed: true,  username, remaining }
//   { allowed: false, reason: 'auth' | 'limit' | 'config', username, limit }
// Without a valid token the request counts against the caller's IP as a guest.
// Missing AUTH_SECRET / BLOB_READ_WRITE_TOKEN fails closed ('config'), otherwise
// the owner's keys would run with no quota at all.
async function checkAndConsume(token, req, bucket = 'chat') {
  const limits = LIMITS[bucket];
  const session = verifyToken(token);
  const username = session ? session.u : null;
  const ip = clientIp(req);
  if (!username && !ip) return { allowed: false, reason: 'auth', username: null };
  const limit = username ? limits.account : limits.guest;
  if (!process.env.BLOB_READ_WRITE_TOKEN) return { allowed: false, reason: 'config', username, limit };

  let path, usage;
  try {
    path = store.secretPath('usage-' + bucket, username ? 'user:' + username : 'ip:' + ip);
    usage = await store.readSecret(path);
  } catch (e) {
    return { allowed: false, reason: 'config', username, limit };
  }
  const today = todayStr();
  if (!usage || usage.date !== today) usage = { date: today, count: 0 };
  if (usage.count >= limit) return { allowed: false, reason: 'limit', username, limit };
  usage.count += 1;
  try {
    await store.writeSecret(path, usage);
  } catch (e) {
    // Best-effort: if this fails, worst case is one extra free message slips
    // through today — never block the actual AI request over a bookkeeping write.
  }
  return { allowed: true, username, remaining: limit - usage.count };
}

function rejectUsage(res, usage) {
  if (usage.reason === 'auth') {
    res.status(401).json({ error: 'الجلسة منتهية، الرجاء تسجيل الدخول من جديد' });
  } else if (usage.reason === 'config') {
    res.status(503).json({ error: 'الخادم غير مهيأ بعد (AUTH_SECRET / BLOB_READ_WRITE_TOKEN)' });
  } else {
    res.status(402).json({ error: 'وصلت للحد اليومي المجاني (' + usage.limit + ' رسالة) لهذا المزوّد. جرّب مزودًا آخر بمفتاحك الخاص أو انتظر الغد.' });
  }
}

module.exports = { checkAndConsume, rejectUsage, DAILY_LIMIT, GUEST_LIMIT, LIMITS };

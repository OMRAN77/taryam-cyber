// Daily per-caller quota shared by the public scan tools (webscan, recon, iprep).
//
// Two properties matter here:
//
//   1. The key is the caller address the platform sets (clientIp), never a body
//      field. A client that sends its own id (guestId) gets a fresh quota with every
//      request, which is what this replaced.
//
//   2. The count is derived by listing markers under a per-caller, per-day prefix
//      through the authenticated Blob API. A read-modify-write counter on a single
//      blob looks simpler but is unsafe twice over: public blob reads are CDN-cached
//      and eventually consistent (a stale count stops counting), and two concurrent
//      requests both read the same value. Counting immutable markers removes the
//      read-modify-write race entirely; only the list call can lag, and it is served
//      by the same API that accepted the previous write.
//
// Concurrent requests can still overshoot the limit by a small amount before their
// markers are visible. That is bounded and acceptable for cost control; a hard
// ceiling needs an atomic counter (Redis/Upstash INCR), which this deployment does
// not have.
const crypto = require('crypto');
const { clientIp } = require('./_client');
const store = require('./_store');
const { quotaEnabled, isOwnerToken } = require('./_quota');

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

class QuotaUnavailable extends Error {}

// Consumes one unit and reports the state back to the handler.
// Returns { allowed, used, limit, unlimited, remaining, noAddress }.
async function consume(req, { namespace, limit, token } = {}) {
  if (!quotaEnabled() || isOwnerToken(token)) {
    return { allowed: true, used: 0, limit, unlimited: true, remaining: null };
  }
  const id = clientIp(req);
  if (!id) return { allowed: false, used: 0, limit, remaining: 0, noAddress: true };

  let used;
  let prefix;
  try {
    prefix = store.quotaPrefix(namespace, id) + todayStr() + '/';
    used = (await store.listUnder(prefix, limit + 20)).length;
  } catch (e) {
    throw new QuotaUnavailable(e && e.message ? e.message : String(e));
  }

  if (used >= limit) return { allowed: false, used, limit, remaining: 0 };

  // One immutable marker per request; the count above is the number of markers.
  const marker = prefix + Date.now().toString(36) + '-' + crypto.randomBytes(6).toString('hex') + '.json';
  // Best-effort: an uncounted scan is cheaper than failing a request that would work.
  try { await store.writePublicJson(marker, { t: Date.now() }); } catch (e) {}

  return { allowed: true, used: used + 1, limit, remaining: limit - (used + 1) };
}

// Shared 429 body so the three tools answer the same way.
function limitResponse(res, limit) {
  res.status(429).json({
    error: 'limit',
    message: 'وصلت للحد اليومي المسموح لهذه الأداة (' + limit + ' فحوصات/يوم). حاول غدًا.',
  });
}

module.exports = { consume, limitResponse, todayStr, QuotaUnavailable };

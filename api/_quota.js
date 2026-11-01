// Who the daily limits apply to.
// TARYAM is the owner's own tool, but it is reachable by anyone at its public URL and
// the proxies accept cross-site requests (the TARYAM browser extension needs that), so
// limits stay on for everyone except the owner's account(s):
//   OWNER_USERNAMES  comma-separated usernames that are never limited (default: taryam)
//   QUOTA=off        turn every limit off (only for a deployment nobody else can reach)
// Everyone else keeps the original allowances: chat/voice in _usage.js and each scan
// tool's DAILY_LIMIT (webscan, iprep, virustotal, recon).
const { verifyToken } = require('./_secrets');

const DEFAULT_OWNERS = 'taryam';

function quotaEnabled() {
  return String(process.env.QUOTA || '').trim().toLowerCase() !== 'off';
}

function ownerUsernames() {
  const raw = process.env.OWNER_USERNAMES != null ? process.env.OWNER_USERNAMES : DEFAULT_OWNERS;
  return String(raw).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
}

// `username` is the lowercased account key that session tokens carry (auth.js makeToken).
function isOwner(username) {
  return !!username && ownerUsernames().includes(String(username).toLowerCase());
}

// For endpoints that receive the raw session token (the scan tools).
function isOwnerToken(token) {
  if (!token) return false;
  const session = verifyToken(token);
  return !!session && isOwner(session.u);
}

module.exports = { quotaEnabled, ownerUsernames, isOwner, isOwnerToken };

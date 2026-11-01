// Usage limits are off unless the deployment sets QUOTA=on.
// TARYAM is run privately by its owner, so by default nothing is counted or capped.
// If the site is ever opened to the public, set QUOTA=on in Vercel -> Settings ->
// Environment Variables to restore the daily allowances: chat/voice in _usage.js and
// each scan tool's DAILY_LIMIT (webscan, iprep, virustotal, recon).
function quotaEnabled() {
  return String(process.env.QUOTA || '').trim().toLowerCase() === 'on';
}

module.exports = { quotaEnabled };

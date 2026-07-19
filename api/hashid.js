// Vercel Serverless Function: hash type identifier + small dictionary cracker.
// - Identifies likely hash algorithm(s) from length/charset/format (MD5,
//   SHA1, SHA256, SHA512, bcrypt, MD5-crypt, NTLM-ish, etc.)
// - For common fast hash types (MD5/SHA1/SHA256/SHA512/MD4-ish), attempts to
//   crack it against a small built-in wordlist of common passwords — purely
//   educational/audit use (e.g. checking if your own hash is trivially weak).
// No external API/key needed.
const crypto = require('crypto');

const COMMON_PASSWORDS = [
  '123456', 'password', '123456789', '12345678', '12345', 'qwerty', '123123',
  '1234567890', 'abc123', '111111', '1234567', 'iloveyou', 'admin', 'welcome',
  'monkey', 'password1', 'letmein', 'dragon', 'sunshine', 'master', '000000',
  '666666', '123321', 'football', 'trustno1', 'superman', 'hello', 'freedom',
  'passw0rd', '1q2w3e4r', 'starwars', 'qazwsx', 'shadow', 'baseball', 'test',
  'access', 'love', 'michael', 'jennifer', 'jordan', 'hunter', 'ranger', 'buster',
];

function identify(hash) {
  const h = hash.trim();
  const guesses = [];
  if (/^[a-f0-9]{32}$/i.test(h)) guesses.push('MD5', 'NTLM', 'MD4');
  else if (/^[a-f0-9]{40}$/i.test(h)) guesses.push('SHA1', 'RIPEMD-160');
  else if (/^[a-f0-9]{56}$/i.test(h)) guesses.push('SHA224');
  else if (/^[a-f0-9]{64}$/i.test(h)) guesses.push('SHA256', 'SHA3-256');
  else if (/^[a-f0-9]{96}$/i.test(h)) guesses.push('SHA384');
  else if (/^[a-f0-9]{128}$/i.test(h)) guesses.push('SHA512', 'SHA3-512', 'Whirlpool');
  else if (/^\$2[aby]?\$\d{2}\$[./A-Za-z0-9]{53}$/.test(h)) guesses.push('bcrypt');
  else if (/^\$1\$/.test(h)) guesses.push('MD5-crypt (Unix)');
  else if (/^\$5\$/.test(h)) guesses.push('SHA256-crypt (Unix)');
  else if (/^\$6\$/.test(h)) guesses.push('SHA512-crypt (Unix)');
  else if (/^\$argon2(id|i|d)\$/.test(h)) guesses.push('Argon2');
  else if (/^[A-Za-z0-9+/]{20,}={0,2}$/.test(h) && h.length % 4 === 0) guesses.push('Base64 (not a hash, encoded data)');
  else guesses.push('Unknown / unrecognized format');
  return guesses;
}

function crackFast(hash, algo) {
  const h = hash.trim().toLowerCase();
  for (const pw of COMMON_PASSWORDS) {
    let digest;
    try { digest = crypto.createHash(algo).update(pw).digest('hex'); } catch (e) { return null; }
    if (digest === h) return pw;
  }
  return null;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  try {
    const body = req.body || {};
    const hash = String(body.hash || '').trim();
    if (!hash) {
      res.status(400).json({ error: 'يرجى إدخال Hash' });
      return;
    }
    const guesses = identify(hash);

    let cracked = null;
    let crackedAs = null;
    if (/^[a-f0-9]{32}$/i.test(hash)) { cracked = crackFast(hash, 'md5'); crackedAs = 'MD5'; }
    else if (/^[a-f0-9]{40}$/i.test(hash)) { cracked = crackFast(hash, 'sha1'); crackedAs = 'SHA1'; }
    else if (/^[a-f0-9]{64}$/i.test(hash)) { cracked = crackFast(hash, 'sha256'); crackedAs = 'SHA256'; }
    else if (/^[a-f0-9]{128}$/i.test(hash)) { cracked = crackFast(hash, 'sha512'); crackedAs = 'SHA512'; }

    res.status(200).json({ hash, guesses, cracked, crackedAs, dictionarySize: COMMON_PASSWORDS.length });
  } catch (e) {
    res.status(500).json({ error: 'Analysis error: ' + (e && e.message ? e.message : String(e)) });
  }
};

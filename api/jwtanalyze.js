// Vercel Serverless Function: JWT (JSON Web Token) analyzer.
// Purely client-request driven: decodes header + payload (base64url, no
// signature verification needed for that), flags common misconfigurations
// (alg:none, weak/guessable HMAC secret via a small common-secrets wordlist,
// missing exp, long-lived tokens), and reports whether the signature matches
// if a secret is supplied for testing. No external API/key needed.
const crypto = require('crypto');

const COMMON_SECRETS = [
  'secret', 'password', '123456', 'your-256-bit-secret', 'jwt_secret', 'jwtsecret',
  'changeme', 'supersecret', 'secretkey', 'mysecret', 'test', 'admin', 'key',
  'private', 'qwerty', 'letmein', 'default', 'jwt-secret', 'appsecret', 'apikey',
];

function b64urlDecode(str) {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  return Buffer.from(str, 'base64').toString('utf8');
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
    const token = String(body.token || '').trim();
    if (!token) {
      res.status(400).json({ error: 'يرجى إدخال JWT' });
      return;
    }
    const parts = token.split('.');
    if (parts.length !== 3) {
      res.status(400).json({ error: 'صيغة JWT غير صحيحة (يجب أن تتكون من 3 أجزاء مفصولة بنقاط)' });
      return;
    }
    const [headerB64, payloadB64, sig] = parts;
    let header, payload;
    try {
      header = JSON.parse(b64urlDecode(headerB64));
      payload = JSON.parse(b64urlDecode(payloadB64));
    } catch (e) {
      res.status(400).json({ error: 'تعذر فك تشفير JWT — تحقق من صحة النص' });
      return;
    }

    const findings = [];
    const alg = (header.alg || '').toLowerCase();

    if (alg === 'none') {
      findings.push({ severity: 'critical', msg: 'الخوارزمية "none" — يقبل أي توقيع بدون تحقق فعلي! ثغرة خطيرة جدًا.' });
    }
    if (!header.alg) {
      findings.push({ severity: 'high', msg: 'لا يوجد حقل "alg" في الرأس.' });
    }
    if (!payload.exp) {
      findings.push({ severity: 'medium', msg: 'لا يوجد وقت انتهاء صلاحية (exp) — التوكن قد يبقى صالحًا للأبد.' });
    } else {
      const expDate = new Date(payload.exp * 1000);
      const now = new Date();
      if (expDate < now) {
        findings.push({ severity: 'info', msg: `التوكن منتهي الصلاحية بتاريخ ${expDate.toISOString()}.` });
      } else {
        const daysLeft = Math.round((expDate - now) / 86400000);
        if (daysLeft > 365) {
          findings.push({ severity: 'medium', msg: `مدة صلاحية طويلة جدًا (${daysLeft} يومًا) — يزيد من خطر إساءة الاستخدام إذا سُرق.` });
        }
      }
    }
    if (payload.alg === 'HS256' || alg === 'hs256' || alg === 'hs384' || alg === 'hs512') {
      // Try common weak secrets (only meaningful for symmetric algorithms).
      const hmacAlg = alg === 'hs384' ? 'sha384' : alg === 'hs512' ? 'sha512' : 'sha256';
      const signingInput = headerB64 + '.' + payloadB64;
      let crackedSecret = null;
      for (const secret of COMMON_SECRETS) {
        const expected = crypto.createHmac(hmacAlg, secret).update(signingInput).digest('base64url');
        if (expected === sig) { crackedSecret = secret; break; }
      }
      if (crackedSecret) {
        findings.push({ severity: 'critical', msg: `تم كسر السر! السر المستخدم للتوقيع هو كلمة شائعة جدًا: "${crackedSecret}".` });
      }
    }
    if (alg.startsWith('rs') || alg.startsWith('es') || alg.startsWith('ps')) {
      findings.push({ severity: 'info', msg: 'يستخدم خوارزمية غير متماثلة (asymmetric) — لا يمكن كسر التوقيع بدون المفتاح الخاص.' });
    }

    // Manual secret verification (if the user supplies a secret to test against).
    let secretCheck = null;
    if (body.testSecret) {
      const hmacAlg = alg === 'hs384' ? 'sha384' : alg === 'hs512' ? 'sha512' : 'sha256';
      const signingInput = headerB64 + '.' + payloadB64;
      const expected = crypto.createHmac(hmacAlg, String(body.testSecret)).update(signingInput).digest('base64url');
      secretCheck = { matches: expected === sig };
    }

    res.status(200).json({ header, payload, findings, secretCheck });
  } catch (e) {
    res.status(500).json({ error: 'Analysis error: ' + (e && e.message ? e.message : String(e)) });
  }
};

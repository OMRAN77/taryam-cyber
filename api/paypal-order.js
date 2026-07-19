// Vercel Serverless Function: creates & captures PayPal orders using the
// PayPal REST API directly (no SDK dependency). Uses PAYPAL_CLIENT_ID +
// PAYPAL_SECRET env vars. Auto-detects sandbox vs live based on key type is
// not reliable, so we use PAYPAL_MODE env var ('sandbox' default, or 'live').

const PLANS = {
  basic: { amount: '5.00', name: 'خطة 5$ - 300 رسالة شهريًا / Basic Plan' },
  pro: { amount: '15.00', name: 'خطة 15$ - رسائل غير محدودة / Pro Plan' },
};

function baseUrl() {
  return (process.env.PAYPAL_MODE === 'live')
    ? 'https://api-m.paypal.com'
    : 'https://api-m.sandbox.paypal.com';
}

async function getAccessToken() {
  const clientId = process.env.PAYPAL_CLIENT_ID;
  const secret = process.env.PAYPAL_SECRET;
  if (!clientId || !secret) return null;
  const auth = Buffer.from(`${clientId}:${secret}`).toString('base64');
  const r = await fetch(`${baseUrl()}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  const data = await r.json();
  return data.access_token || null;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  try {
    let body = req.body;
    if (!body || typeof body === 'string') body = JSON.parse(body || '{}');
    const { action } = body;

    const accessToken = await getAccessToken();
    if (!accessToken) {
      res.status(500).json({ error: 'الدفع عبر PayPal غير مفعّل بعد / PayPal not configured yet' });
      return;
    }

    if (action === 'create') {
      const planInfo = PLANS[body.plan];
      if (!planInfo) { res.status(400).json({ error: 'Invalid plan' }); return; }

      const r = await fetch(`${baseUrl()}/v2/checkout/orders`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          intent: 'CAPTURE',
          purchase_units: [{
            description: planInfo.name,
            amount: { currency_code: 'USD', value: planInfo.amount },
          }],
        }),
      });
      const data = await r.json();
      if (!r.ok) { res.status(500).json({ error: data.message || 'PayPal error' }); return; }
      res.status(200).json({ id: data.id });
      return;
    }

    if (action === 'capture') {
      const { orderId } = body;
      if (!orderId) { res.status(400).json({ error: 'Missing orderId' }); return; }
      const r = await fetch(`${baseUrl()}/v2/checkout/orders/${orderId}/capture`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
      });
      const data = await r.json();
      if (!r.ok) { res.status(500).json({ error: data.message || 'PayPal capture error' }); return; }
      res.status(200).json({ status: data.status, id: data.id });
      return;
    }

    res.status(400).json({ error: 'Invalid action' });
  } catch (e) {
    res.status(500).json({ error: e.message || 'Server error' });
  }
};

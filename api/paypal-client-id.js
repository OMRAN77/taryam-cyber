// Returns the PayPal Client ID (public, safe to expose) so the frontend can
// dynamically load the PayPal SDK script without hardcoding the key in source.
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const clientId = process.env.PAYPAL_CLIENT_ID || '';
  res.status(200).json({ clientId, configured: !!clientId });
};

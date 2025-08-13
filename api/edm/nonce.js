const { randomUUID } = require('crypto');

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});

    const resp = await fetch('https://api.printful.com/embedded-designer/nonces', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.PRINTFUL_TOKEN_EDM}`,
        'Content-Type': 'application/json',
        'X-PF-Store-Id': process.env.PRINTFUL_STORE_ID // <-- ton Store ID (ex: "16601022") en ENV Vercel
      },
      body: JSON.stringify({
        external_product_id: body.external_product_id || randomUUID(),
        user_agent: req.headers['user-agent'] || nu_

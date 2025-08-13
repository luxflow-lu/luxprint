const { randomUUID } = require('crypto');

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}


headers: {
  Authorization: `Bearer ${process.env.PRINTFUL_TOKEN_EDM}`,
  'Content-Type': 'application/json',
  'X-PF-Store-Id': process.env.16601022   // ← ajouter
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
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        external_product_id: body.external_product_id || randomUUID(),
        user_agent: req.headers['user-agent'] || null
      })
    });

    const data = await resp.json();
    if (!resp.ok) return res.status(resp.status).json(data);
    return res.status(200).json({ nonce: data?.result?.nonce });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};

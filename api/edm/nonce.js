const { randomUUID } = require('crypto');

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*'); // ou mets ton domaine Webflow si tu veux restreindre
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');
  res.setHeader('Access-Control-Max-Age', '86400');
}

module.exports = async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(204).end(); // réponse préflight OK

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const resp = await fetch('https://api.printful.com/embedded-designer/nonces', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.PRINTFUL_TOKEN_EDM}`,
        'Content-Type': 'application/json',
        'X-PF-Store-Id': process.env.16601022 // mets la valeur (ex. "16601022") dans Vercel
      },
      body: JSON.stringify({
        external_product_id: body.external_product_id || randomUUID(),
        user_agent: req.headers['user-agent'] || null
      })
    });

    const data = await resp.json();
    // renvoie TOUJOURS CORS, même en erreur
    return res.status(resp.ok ? 200 : resp.status).json(resp.ok ? { nonce: data?.result?.nonce } : data);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};

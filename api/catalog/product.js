// /api/catalog/product.js
// GET ?id=71  -> { product: {...raw...}, variants: [...] }
// Lis v2: /v2/catalog-products/{id} + /v2/catalog-products/{id}/catalog-variants

function cors(res){
  res.setHeader('Access-Control-Allow-Origin','*'); // ou restreins à Webflow
  res.setHeader('Access-Control-Allow-Methods','GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type');
  res.setHeader('Access-Control-Max-Age','86400');
}

async function pfGet(url, token, storeId){
  const h = { Authorization:`Bearer ${token}` };
  if (storeId) h['X-PF-Store-Id'] = String(storeId);
  const r = await fetch(url, { headers: h });
  const j = await r.json().catch(()=> ({}));
  if (!r.ok) { const e=new Error(j?.error?.message || JSON.stringify(j)); e.status=r.status; e.details=j; throw e; }
  return j;
}

module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ error:'Method not allowed' });

  try{
    const id = Number(req.query.id || 0);
    if (!id) return res.status(400).json({ error:'Missing product id' });

    const PF_TOKEN    = process.env.PRINTFUL_TOKEN_ORDERS || process.env.PRINTFUL_TOKEN_CATALOG;
    const PF_STORE_ID = process.env.PRINTFUL_STORE_ID || '';
    if (!PF_TOKEN) return res.status(500).json({ error:'Missing PRINTFUL token env' });

    const base = 'https://api.printful.com/v2/catalog-products';
    const product  = await pfGet(`${base}/${id}`, PF_TOKEN, PF_STORE_ID);               // schéma complet
    const variants = await pfGet(`${base}/${id}/catalog-variants`, PF_TOKEN, PF_STORE_ID); // variantes

    return res.status(200).json({
      product: product?.data || product,         // la doc v2 renvoie sous .data
      variants: variants?.data || []
    });
  }catch(e){
    return res.status(e.status||500).json({ error: e.message, details: e.details });
  }
};

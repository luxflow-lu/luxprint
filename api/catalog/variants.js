// api/catalog/variants.js
function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}
module.exports = async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();

  try {
    const { product_id } = req.query || {};
    if (!product_id) return res.status(400).json({ error: 'Missing product_id' });

    // Appelle l’API Catalogue Printful (v2/beta expose les options & variantes)
    const r = await fetch(`https://api.printful.com/v2/catalog-products/${product_id}`, {
      headers: {
        Authorization: `Bearer ${process.env.PRINTFUL_TOKEN_ORDERS}`, // ou un token dédié "catalog"
        'Content-Type': 'application/json'
      }
    });
    const j = await r.json();
    if (!r.ok) return res.status(r.status).json(j);

    // Normalise en {variant_id, size, color, name}
    const variants = (j?.result?.variants || j?.result?.data?.variants || []).map(v => ({
      variant_id: v.id || v.variant_id || v.catalog_variant_id,
      size: v.size || v.size_name || v.attributes?.size || '',
      color: v.color || v.color_name || v.attributes?.color || '',
      name: v.name || `${v.color || ''} ${v.size || ''}`.trim()
    })).filter(v => v.variant_id);

    return res.json({ variants });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};

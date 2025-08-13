// api/catalog/variants.js
function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*'); // tu pourras restreindre à https://luxprint.webflow.io
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Max-Age', '86400');
}

module.exports = async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();

  try {
    const { product_id } = req.query || {};
    if (!product_id) return res.status(400).json({ error: 'Missing product_id' });

    const token = process.env.PRINTFUL_TOKEN_ORDERS || process.env.PRINTFUL_TOKEN_CATALOG;
    if (!token) return res.status(500).json({ error: 'Missing PRINTFUL_TOKEN_ORDERS (or PRINTFUL_TOKEN_CATALOG) env var' });

    const url = `https://api.printful.com/v2/catalog-products/${product_id}`;
    const r = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
        // 'X-PF-Store-Id': process.env.PRINTFUL_STORE_ID // en général pas requis pour le catalogue
      }
    });

    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      return res.status(r.status).json({
        error: 'Upstream Printful error',
        status: r.status,
        details: j
      });
    }

    // Normalisation -> renvoie un tableau simple {variant_id, size, color, name}
    const variantsSrc = j?.result?.variants || j?.result?.data?.variants || [];
    const variants = variantsSrc.map(v => ({
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

// Cherche dans le listing v2 et filtre côté serveur par nom/marque/modèle
module.exports = async (req, res) => {
  try {
    const q = (req.query.q || '').toLowerCase();
    const token = process.env.PRINTFUL_TOKEN_ORDERS || process.env.PRINTFUL_TOKEN_CATALOG;
    if (!token) return res.status(500).json({ error: 'Missing token' });

    // on prend une page large et on filtre (tu peux paginer si besoin)
    const r = await fetch('https://api.printful.com/v2/catalog-products?limit=200', {
      headers: { Authorization: `Bearer ${token}` }
    });
    const j = await r.json();
    const list = j?.data || j?.result || [];
    const hits = list.filter(p => {
      const s = `${p.name || ''} ${p.brand || ''} ${p.model || ''}`.toLowerCase();
      return q.split(' ').every(w => s.includes(w));
    }).map(p => ({ id: p.id, name: p.name, brand: p.brand, model: p.model }));
    return res.json({ results: hits });
  } catch (e) { return res.status(500).json({ error: e.message }); }
};

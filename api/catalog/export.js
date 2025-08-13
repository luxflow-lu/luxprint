// api/catalog/export.js
function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*'); // tu peux restreindre plus tard
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');
  res.setHeader('Access-Control-Max-Age', '86400');
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function csvEscape(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

module.exports = async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();

  const token = process.env.PRINTFUL_TOKEN_CATALOG || process.env.PRINTFUL_TOKEN_ORDERS;
  if (!token) return res.status(500).json({ error: 'Missing PRINTFUL token (PRINTFUL_TOKEN_CATALOG or PRINTFUL_TOKEN_ORDERS)' });

  try {
    const q = (req.query.q || '').toLowerCase().trim();          // filtre texte (nom/marque/modèle)
    const maxProducts = Math.min(parseInt(req.query.max || '2000', 10) || 2000, 10000);
    const pageSize = Math.min(parseInt(req.query.limit || '200', 10) || 200, 200);
    const delay = Math.min(parseInt(req.query.delay || '50', 10) || 50, 500);

    let offset = 0;
    let fetched = 0;
    const rows = [];
    rows.push([
      'catalog_product_id','product_name','brand','model',
      'catalog_variant_id','color','size','variant_name'
    ].join(','));

    // 1) Parcours des produits du catalogue (paginated)
    while (fetched < maxProducts) {
      const url = `https://api.printful.com/v2/catalog-products?limit=${pageSize}&offset=${offset}`;
      const rp = await fetch(url, { headers: { Authorization: `Bearer ${token}` }});
      const jp = await rp.json().catch(()=>({}));
      if (!rp.ok) {
        return res.status(rp.status).json({ error: 'Upstream Printful error (products)', status: rp.status, details: jp });
      }

      const list = jp?.data || jp?.result || [];
      if (!list.length) break;

      for (const p of list) {
        const hay = `${p.name||''} ${p.brand||''} ${p.model||''}`.toLowerCase();
        if (q && !q.split(/\s+/).every(w => hay.includes(w))) continue;

        const productId = p.id;
        const pName = p.name || '';
        const brand = p.brand || '';
        const model = p.model || '';

        // 2) Variantes du produit
        const vurl = `https://api.printful.com/v2/catalog-products/${productId}/catalog-variants`;
        const rv = await fetch(vurl, { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }});
        const jv = await rv.json().catch(()=>({}));
        if (!rv.ok) {
          // si l'endpoint échoue, on écrit au moins la ligne produit vide
          rows.push([productId, pName, brand, model, '', '', '', ''].map(csvEscape).join(','));
          continue;
        }

        const variants = jv?.data || jv?.result?.data || [];
        if (!variants.length) {
          rows.push([productId, pName, brand, model, '', '', '', ''].map(csvEscape).join(','));
        } else {
          for (const v of variants) {
            const vid = v.id || v.catalog_variant_id || '';
            const color = (v.attributes?.color || v.color || '') || '';
            const size  = (v.attributes?.size  || v.size  || '') || '';
            const vname = v.name || `${color} ${size}`.trim();
            rows.push([productId, pName, brand, model, vid, color, size, vname].map(csvEscape).join(','));
          }
        }

        await sleep(delay); // petite pause pour éviter d’ennuyer l’API
      }

      fetched += list.length;
      offset  += list.length;
      if (list.length < pageSize) break;
    }

    const csv = rows.join('\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="printful_catalog_export.csv"`);
    return res.status(200).send(csv);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};

// /api/stripe/checkout.js
function cors(res){
  res.setHeader('Access-Control-Allow-Origin','*'); // en prod, mets https://luxprint.webflow.io
  res.setHeader('Vary','Origin');
  res.setHeader('Access-Control-Allow-Methods','POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type, Authorization, X-Requested-With');
  res.setHeader('Access-Control-Max-Age','86400');
}

// Liste officielle des codes pays que Stripe accepte pour shipping_address_collection
// (inclut quelques codes “spéciaux” Stripe comme AC, TA, XK, ZZ).
const STRIPE_ALLOWED = new Set([
  'AC','AD','AE','AF','AG','AI','AL','AM','AO','AQ','AR','AT','AU','AW','AX','AZ','BA','BB','BD','BE','BF','BG','BH','BI','BJ','BL','BM','BN','BO','BQ','BR','BS','BT','BV','BW','BY','BZ','CA','CD','CF','CG','CH','CI','CK','CL','CM','CN','CO','CR','CV','CW','CY','CZ','DE','DJ','DK','DM','DO','DZ','EC','EE','EG','EH','ER','ES','ET','FI','FJ','FK','FO','FR','GA','GB','GD','GE','GF','GG','GH','GI','GL','GM','GN','GP','GQ','GR','GS','GT','GU','GW','GY','HK','HN','HR','HT','HU','ID','IE','IL','IM','IN','IO','IQ','IS','IT','JE','JM','JO','JP','KE','KG','KH','KI','KM','KN','KR','KW','KY','KZ','LA','LB','LC','LI','LK','LR','LS','LT','LU','LV','LY','MA','MC','MD','ME','MF','MG','MK','ML','MM','MN','MO','MQ','MR','MS','MT','MU','MV','MW','MX','MY','MZ','NA','NC','NE','NG','NI','NL','NO','NP','NR','NU','NZ','OM','PA','PE','PF','PG','PH','PK','PL','PM','PN','PR','PS','PT','PY','QA','RE','RO','RS','RU','RW','SA','SB','SC','SD','SE','SG','SH','SI','SJ','SK','SL','SM','SN','SO','SR','SS','ST','SV','SX','SZ','TA','TC','TD','TF','TG','TH','TJ','TK','TL','TM','TN','TO','TR','TT','TV','TW','TZ','UA','UG','US','UY','UZ','VA','VC','VE','VG','VN','VNU','VU','WF','WS','XK','YE','YT','ZA','ZM','ZW','ZZ'
]);

module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const SK = process.env.STRIPE_SECRET_KEY;
    if (!SK) return res.status(500).json({ error: 'Missing STRIPE_SECRET_KEY' });

    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const {
      currency = 'eur',
      product_id = 0,
      items = [],
      shipping = { name: 'Livraison standard UE', amount: 479 },
      success_url = (req.headers.origin || 'https://luxprint.webflow.io') + '/merci?session_id={CHECKOUT_SESSION_ID}',
      cancel_url  = (req.headers.origin || 'https://luxprint.webflow.io')
    } = body;

    if (!Array.isArray(items) || !items.length) {
      return res.status(400).json({ error: 'No items' });
    }

    // Construire les lignes Stripe
    const line_items = items.map(it => ({
      quantity: Number(it.quantity || 1),
      price_data: {
        currency,
        unit_amount: Number(it.unit_amount || 0),
        product_data: {
          name: it.name || 'Produit LuxPrint',
          images: it.image ? [it.image] : []
        }
      }
    }));

    // Panier compact dans la metadata (pour /api/stripe/confirm)
    const compactCart = items.map((it, idx) => ({
      i: idx,
      variant_id: Number(it.catalog_variant_id || it.variant_id || 0),
      placements: it.placements || [],
      options: it.options || []
    }));

    // ---------- Params Stripe (toujours via append)
    const params = new URLSearchParams();
    params.append('mode', 'payment');
    params.append('success_url', success_url);
    params.append('cancel_url', cancel_url);

    // Tarif de livraison
    params.append('shipping_options[0][shipping_rate_data][type]', 'fixed_amount');
    params.append('shipping_options[0][shipping_rate_data][display_name]', shipping.name || 'Livraison');
    params.append('shipping_options[0][shipping_rate_data][fixed_amount][amount]', String(Number(shipping.amount || 0)));
    params.append('shipping_options[0][shipping_rate_data][fixed_amount][currency]', currency);

    // ✅ Pays : **tous** les pays supportés par Stripe (liste officielle ci-dessus)
    const allowedCountries = Array.from(STRIPE_ALLOWED).sort();
    for (const c of allowedCountries) {
      params.append('shipping_address_collection[allowed_countries][]', c);
    }

    // Lignes
    line_items.forEach((li, idx) => {
      params.append(`line_items[${idx}][quantity]`,               String(li.quantity));
      params.append(`line_items[${idx}][price_data][currency]`,    li.price_data.currency);
      params.append(`line_items[${idx}][price_data][unit_amount]`, String(li.price_data.unit_amount));
      params.append(`line_items[${idx}][price_data][product_data][name]`, li.price_data.product_data.name);
      (li.price_data.product_data.images||[]).slice(0,1).forEach((img,i)=>{
        params.append(`line_items[${idx}][price_data][product_data][images][${i}]`, img);
      });
    });

    // Metadata pour post-paiement
    params.append('metadata[product_id]', String(product_id || ''));
    params.append('metadata[cart_json]', JSON.stringify(compactCart));

    // Appel Stripe
    const resp = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${SK}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params
    });

    const data = await resp.json();
    if (!resp.ok) {
      return res.status(resp.status).json({ error: data?.error?.message || 'Stripe error', details: data });
    }

    return res.status(200).json({ url: data.url });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};

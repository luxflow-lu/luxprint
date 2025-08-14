// /api/stripe/checkout.js
function cors(res){
  res.setHeader('Access-Control-Allow-Origin','*'); // en prod: mets ton domaine Webflow
  res.setHeader('Vary','Origin');
  res.setHeader('Access-Control-Allow-Methods','POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type, Authorization, X-Requested-With');
  res.setHeader('Access-Control-Max-Age','86400');
}

// Stripe: liste officielle des codes pays acceptés (ISO2 + codes spéciaux Stripe)
const STRIPE_ALLOWED = new Set([
  'AC','AD','AE','AF','AG','AI','AL','AM','AO','AQ','AR','AT','AU','AW','AX','AZ','BA','BB','BD','BE','BF','BG','BH','BI','BJ','BL','BM','BN','BO','BQ','BR','BS','BT','BV','BW','BY','BZ','CA','CD','CF','CG','CH','CI','CK','CL','CM','CN','CO','CR','CV','CW','CY','CZ','DE','DJ','DK','DM','DO','DZ','EC','EE','EG','EH','ER','ES','ET','FI','FJ','FK','FO','FR','GA','GB','GD','GE','GF','GG','GH','GI','GL','GM','GN','GP','GQ','GR','GS','GT','GU','GW','GY','HK','HN','HR','HT','HU','ID','IE','IL','IM','IN','IO','IQ','IS','IT','JE','JM','JO','JP','KE','KG','KH','KI','KM','KN','KR','KW','KY','KZ','LA','LB','LC','LI','LK','LR','LS','LT','LU','LV','LY','MA','MC','MD','ME','MF','MG','MK','ML','MM','MN','MO','MQ','MR','MS','MT','MU','MV','MW','MX','MY','MZ','NA','NC','NE','NG','NI','NL','NO','NP','NR','NU','NZ','OM','PA','PE','PF','PG','PH','PK','PL','PM','PN','PR','PS','PT','PY','QA','RE','RO','RS','RU','RW','SA','SB','SC','SD','SE','SG','SH','SI','SJ','SK','SL','SM','SN','SO','SR','SS','ST','SV','SX','SZ','TA','TC','TD','TF','TG','TH','TJ','TK','TL','TM','TN','TO','TR','TT','TV','TW','TZ','UA','UG','US','UY','UZ','VA','VC','VE','VG','VN','VU','WF','WS','XK','YE','YT','ZA','ZM','ZW','ZZ'
]);

// Printful: pays (ISO2) – on filtre ensuite par la whitelist Stripe
async function pfCountries(token){
  const r = await fetch('https://api.printful.com/v2/countries', {
    headers: token ? { Authorization: `Bearer ${token}` } : {}
  });
  const j = await r.json().catch(()=> ({}));
  if (!r.ok) {
    const e = new Error(j?.error?.message || 'Printful countries'); e.status=r.status; e.details=j; throw e;
  }
  const arr = (j.data || j || []).map(c =>
    String(c.code || c.country_code || c.alpha2 || c.id || '').toUpperCase()
  );
  // garde ISO2 uniquement
  return Array.from(new Set(arr.filter(c => /^[A-Z]{2}$/.test(c))));
}

module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const SK = process.env.STRIPE_SECRET_KEY;
    if (!SK) return res.status(500).json({ error: 'Missing STRIPE_SECRET_KEY' });

    const PF_TOKEN = process.env.PRINTFUL_TOKEN_ORDERS || process.env.PRINTFUL_TOKEN_CATALOG;

    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const {
      currency = 'eur',
      product_id = 0,
      items = [],
      shipping = { name: 'Livraison standard', amount: 499 },
      success_url = (req.headers.origin || 'https://luxprint.webflow.io') + '/merci?session_id={CHECKOUT_SESSION_ID}',
      cancel_url  = (req.headers.origin || 'https://luxprint.webflow.io')
    } = body;

    if (!Array.isArray(items) || !items.length) {
      return res.status(400).json({ error: 'No items' });
    }

    // lignes Stripe
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

    // panier compact pour metadata
    const compactCart = items.map((it, idx) => ({
      i: idx,
      variant_id: Number(it.catalog_variant_id || it.variant_id || 0),
      placements: it.placements || [],
      options: it.options || []
    }));

    // ----- params Stripe (avec append)
    const params = new URLSearchParams();
    params.append('mode', 'payment');
    params.append('success_url', success_url);
    params.append('cancel_url', cancel_url);

    // Livraison
    params.append('shipping_options[0][shipping_rate_data][type]', 'fixed_amount');
    params.append('shipping_options[0][shipping_rate_data][display_name]', shipping.name || 'Livraison');
    params.append('shipping_options[0][shipping_rate_data][fixed_amount][amount]', String(Number(shipping.amount || 0)));
    params.append('shipping_options[0][shipping_rate_data][fixed_amount][currency]', currency);

    // ✅ Pays : Printful ∩ Stripe
    let allowedCountries = ['FR','DE','LU','BE','NL','ES','IT','PT','GB','IE','US','CA']; // fallback
    try {
      const pf = await pfCountries(PF_TOKEN);
      const filtered = pf.filter(c => STRIPE_ALLOWED.has(c));
      if (filtered.length) allowedCountries = filtered;
    } catch (_) { /* garde fallback */ }

    // Tri pour UX stable
    allowedCountries.sort();
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

    // Metadata pour /api/stripe/confirm
    params.append('metadata[product_id]', String(product_id || ''));
    params.append('metadata[cart_json]', JSON.stringify(compactCart));

    const resp = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${SK}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params
    });

    const data = await resp.json();
    if (!resp.ok) return res.status(resp.status).json({ error: data?.error?.message || 'Stripe error', details: data });

    return res.status(200).json({ url: data.url });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};

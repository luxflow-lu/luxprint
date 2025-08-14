// /api/stripe/checkout.js
// Crée une session de paiement Stripe en sérialisant toutes les infos utiles en metadata.
// Requiert STRIPE_SECRET_KEY en variable d'env.

function cors(res){
  res.setHeader('Access-Control-Allow-Origin','*'); // restreins à ton domaine en prod
  res.setHeader('Vary','Origin');
  res.setHeader('Access-Control-Allow-Methods','POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type, Authorization, X-Requested-With');
  res.setHeader('Access-Control-Max-Age','86400');
}

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
      shipping = { name: 'Livraison standard', amount: 499 },
      success_url = (req.headers.origin || 'https://luxprint.webflow.io') + '/merci?session_id={CHECKOUT_SESSION_ID}',
      cancel_url  = (req.headers.origin || 'https://luxprint.webflow.io')
    } = body;

    if (!Array.isArray(items) || !items.length) {
      return res.status(400).json({ error: 'No items' });
    }

    // Ligne(s) Stripe
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

    // On compacte le panier pour la metadata (mono-produit ici, mais compatible multi)
    const compactCart = items.map((it, idx) => ({
      i: idx,
      variant_id: Number(it.catalog_variant_id || it.variant_id || 0),
      placements: it.placements || [],
      options: it.options || []
    }));

    // NB: Stripe metadata max ~ 500 chars par champ; on compacte et on stocke
    const metadata = {
      product_id: String(product_id || ''),
      cart_json: JSON.stringify(compactCart) // le confirm reconstituera depuis ça
    };

    const resp = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${SK}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: new URLSearchParams({
        mode: 'payment',
        success_url,
        cancel_url,
        // Shipping (forfait)
        'shipping_options[0][shipping_rate_data][type]': 'fixed_amount',
        'shipping_options[0][shipping_rate_data][display_name]': shipping.name || 'Livraison',
        'shipping_options[0][shipping_rate_data][fixed_amount][amount]': String(Number(shipping.amount || 0)),
        'shipping_options[0][shipping_rate_data][fixed_amount][currency]': currency,
        // On collecte adresse de livraison (utile pour Printful)
        'shipping_address_collection[allowed_countries][]': 'LU',
        'shipping_address_collection[allowed_countries][]': 'FR',
        'shipping_address_collection[allowed_countries][]': 'BE',
        'shipping_address_collection[allowed_countries][]': 'DE',
        'shipping_address_collection[allowed_countries][]': 'NL',
        // Items
        ...Object.fromEntries(
          line_items.flatMap((li, idx) => ([
            [`line_items[${idx}][quantity]`,               String(li.quantity)],
            [`line_items[${idx}][price_data][currency]`,    li.price_data.currency],
            [`line_items[${idx}][price_data][unit_amount]`, String(li.price_data.unit_amount)],
            [`line_items[${idx}][price_data][product_data][name]`, li.price_data.product_data.name],
            ...((li.price_data.product_data.images||[]).slice(0,1).map((img, i) =>
              [`line_items[${idx}][price_data][product_data][images][${i}]`, img]
            ))
          ]))
        ),
        // Metadata
        ...Object.fromEntries(Object.entries(metadata).map(([k,v]) => [`metadata[${k}]`, String(v)]))
      })
    });

    const data = await resp.json();
    if (!resp.ok) return res.status(resp.status).json({ error: data?.error?.message || 'Stripe error', details: data });

    return res.status(200).json({ url: data.url });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};

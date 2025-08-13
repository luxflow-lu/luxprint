// api/stripe/checkout.js
// Crée une session Stripe Checkout via l'API REST (pas besoin du SDK)
// Requiert: STRIPE_SECRET_KEY (sk_test_...), SITE_URL (ex: https://luxprint.webflow.io)

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*'); // tu peux restreindre à ton domaine Webflow
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Max-Age', '86400');
}

async function createCheckoutSession(order, secret, origin) {
  // On construit un body x-www-form-urlencoded pour l'API Stripe
  const form = new URLSearchParams();
  form.set('mode', 'payment');
  form.set('success_url', `${origin}/merci`);
  form.set('cancel_url', `${origin}/panier?canceled=1`);
  form.set('customer_creation', 'always'); // optionnel

  // Shipping (forfait fixe)
  form.append('shipping_options[0][shipping_rate_data][type]', 'fixed_amount');
  form.append('shipping_options[0][shipping_rate_data][display_name]', order?.shipping?.name || 'Livraison standard');
  form.append('shipping_options[0][shipping_rate_data][fixed_amount][amount]', String(order?.shipping?.amount || 0));
  form.append('shipping_options[0][shipping_rate_data][fixed_amount][currency]', order?.currency || 'eur');

  // Une seule ligne pour démarrer
  const item = (order?.items && order.items[0]) || {};
  form.append('line_items[0][quantity]', String(item.quantity || 1));
  form.append('line_items[0][price_data][currency]', order?.currency || 'eur');
  form.append('line_items[0][price_data][unit_amount]', String(item.unit_amount || 0));
  form.append('line_items[0][price_data][product_data][name]', item.name || 'Article');
  if (item.image) form.append('line_items[0][price_data][product_data][images][0]', item.image);

  // On transmet des infos utiles à la suite (Printful) via metadata
  // (récupérées ensuite dans le webhook Stripe)
  form.append('metadata[catalog_variant_id]', String(item.catalog_variant_id || ''));
  form.append('metadata[design_url]', item.design_url || '');
  form.append('metadata[placement]', item.placement || 'front');
  form.append('metadata[technique]', item.technique || 'dtg');

  const resp = await fetch('https://api.stripe.com/v1/checkout/sessions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${secret}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: form
  });

  const data = await resp.json();
  if (!resp.ok) {
    return { ok: false, status: resp.status, error: data.error?.message || 'Stripe error', raw: data };
  }
  return { ok: true, url: data.url };
}

module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const secret = process.env.STRIPE_SECRET_KEY;
    const origin = process.env.SITE_URL || 'https://luxprint.webflow.io';
    if (!secret) return res.status(500).json({ error: 'Missing STRIPE_SECRET_KEY env' });

    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    if (!body?.items || !body.items.length) return res.status(400).json({ error: 'Missing items' });

    const { ok, url, status, error, raw } = await createCheckoutSession(body, secret, origin);
    if (!ok) return res.status(status || 400).json({ error, details: raw });

    return res.status(200).json({ url });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};

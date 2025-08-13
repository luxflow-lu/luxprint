// /api/stripe/checkout.js
function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://luxprint.webflow.io'); // mets * si tu préfères
  res.setHeader('Vary', 'Origin'); // bon pour caches
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');
  res.setHeader('Access-Control-Max-Age', '86400');
}

function toCents(txt) {
  if (typeof txt === 'number') return Math.round(txt);
  const s = String(txt || '').replace(/\s/g,'').replace(',', '.');
  const m = s.match(/([0-9]+(?:\.[0-9]+)?)/);
  const n = m ? parseFloat(m[1]) : 0;
  return Math.round(n * 100);
}

async function createCheckoutSession(order, secret, origin) {
  const form = new URLSearchParams();
  form.set('mode', 'payment');

  // retourne avec l'id de session pour /merci
  form.set('success_url', `${origin}/merci?session_id={CHECKOUT_SESSION_ID}`);
  form.set('cancel_url', `${origin}/panier?canceled=1`);

  // collecter adresses
  form.set('billing_address_collection', 'required');
  form.append('phone_number_collection[enabled]', 'true');
  for (const c of ['LU','FR','BE','DE','NL','ES','IT','PT','AT','IE','CH','GB']) {
    form.append('shipping_address_collection[allowed_countries][]', c);
  }

  // shipping simple
  const ship = order.shipping || {};
  form.append('shipping_options[0][shipping_rate_data][type]', 'fixed_amount');
  form.append('shipping_options[0][shipping_rate_data][display_name]', ship.name || 'Livraison standard');
  form.append('shipping_options[0][shipping_rate_data][fixed_amount][amount]', String(ship.amount || 0));
  form.append('shipping_options[0][shipping_rate_data][fixed_amount][currency]', order.currency || 'eur');

  // ligne produit
  const item = (order.items && order.items[0]) || {};
  form.append('line_items[0][quantity]', String(item.quantity || 1));
  form.append('line_items[0][price_data][currency]', order.currency || 'eur');
  form.append('line_items[0][price_data][unit_amount]', String(item.unit_amount || 0));
  form.append('line_items[0][price_data][product_data][name]', item.name || 'Article');
  if (item.image) form.append('line_items[0][price_data][product_data][images][0]', item.image);

  // metadata utiles pour /merci -> Printful
  form.append('metadata[catalog_variant_id]', String(item.catalog_variant_id || ''));
  form.append('metadata[design_url]', item.design_url || '');
  form.append('metadata[placement]', item.placement || 'front');
  form.append('metadata[technique]', item.technique || 'dtg');

  const resp = await fetch('https://api.stripe.com/v1/checkout/sessions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${secret}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: form
  });

  const data = await resp.json().catch(()=> ({}));
  if (!resp.ok) {
    return { ok: false, status: resp.status, error: data?.error?.message || 'Stripe error', raw: data };
  }
  return { ok: true, url: data.url };
}

module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();

  try {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const secret = process.env.STRIPE_SECRET_KEY;
    const origin = process.env.SITE_URL || 'https://luxprint.webflow.io';
    if (!secret) return res.status(500).json({ error: 'Missing STRIPE_SECRET_KEY env' });

    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    // garde-fous
    if (!body?.items?.length) return res.status(400).json({ error: 'Missing items' });
    if (!body.currency) body.currency = 'eur';
    // tolère un prix passé en “30” côté front
    if (typeof body.items[0].unit_amount !== 'number') {
      body.items[0].unit_amount = toCents(body.items[0].unit_amount);
    }

    const out = await createCheckoutSession(body, secret, origin);
    if (!out.ok) return res.status(out.status || 400).json({ error: out.error, details: out.raw });
    return res.status(200).json({ url: out.url });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};

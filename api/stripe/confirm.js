// api/stripe/confirm.js
// POST { session_id } -> récupère la session Stripe + line_items,
// puis crée/confirm une commande Printful v2.
//
// Env requises (Vercel -> Settings -> Environment Variables):
// - STRIPE_SECRET_KEY           (ex: sk_test_...)
// - PRINTFUL_TOKEN_ORDERS       (ou PRINTFUL_TOKEN_CATALOG)
// - PRINTFUL_STORE_ID           (optionnel ; ex: 16601022 si ton token n'est pas scoping store)
// - PRINTFUL_CONFIRM            (optionnel ; 'false' pour créer en draft; par défaut true)

const { createHash } = require('crypto');

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*'); // tu peux restreindre à https://luxprint.webflow.io
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');
  res.setHeader('Access-Control-Max-Age', '86400');
}

async function getStripeSession(sessionId, secret) {
  const base = 'https://api.stripe.com/v1/checkout/sessions';
  const h = { Authorization: `Bearer ${secret}` };

  // Session
  const sRes = await fetch(`${base}/${sessionId}`, { headers: h });
  const session = await sRes.json();
  if (!sRes.ok) {
    const msg = session?.error?.message || 'Stripe session error';
    throw new Error(msg);
  }

  // Line items (pour qty)
  const iRes = await fetch(`${base}/${sessionId}/line_items?limit=100`, { headers: h });
  const items = await iRes.json();
  if (!iRes.ok) {
    const msg = items?.error?.message || 'Stripe line_items error';
    throw new Error(msg);
  }

  return { session, items: items.data || [] };
}

async function createPrintfulOrder(payload, token, storeId) {
  const headers = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  };
  if (storeId) headers['X-PF-Store-Id'] = String(storeId);

  const resp = await fetch('https://api.printful.com/v2/orders', {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  });

  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    // Printful structure d'erreur: { error: { message, reason, ... }, code, result? }
    const msg = data?.error?.message || JSON.stringify(data);
    const err = new Error(msg);
    err.details = data;
    err.status = resp.status;
    throw err;
  }
  return data;
}

module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method not allowed' });

  try {
    const STRIPE_SK = process.env.STRIPE_SECRET_KEY;
    const PF_TOKEN = process.env.PRINTFUL_TOKEN_ORDERS || process.env.PRINTFUL_TOKEN_CATALOG;
    const PF_STORE_ID = process.env.PRINTFUL_STORE_ID || '';
    const PF_CONFIRM = (process.env.PRINTFUL_CONFIRM || 'true').toLowerCase() !== 'false'; // default true

    if (!STRIPE_SK) return res.status(500).json({ ok: false, error: 'Missing STRIPE_SECRET_KEY env' });
    if (!PF_TOKEN) return res.status(500).json({ ok: false, error: 'Missing PRINTFUL token env' });

    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const session_id = body?.session_id;
    if (!session_id) return res.status(400).json({ ok: false, error: 'Missing session_id' });

    // 1) Stripe: session + items
    const { session, items } = await getStripeSession(session_id, STRIPE_SK);

    // Assure-toi que le paiement est bien capturé
    if (session.payment_status !== 'paid') {
      return res.status(400).json({ ok: false, error: 'Payment not settled', payment_status: session.payment_status });
    }

    // 2) Récup metadata posées dans /api/stripe/checkout
    const m = session.metadata || {};
    const variantId = Number(m.catalog_variant_id || 0);
    const designUrl = m.design_url || '';
    const placement = m.placement || 'front';
    const technique = m.technique || 'dtg';

    if (!variantId || !designUrl) {
      return res.status(400).json({ ok: false, error: 'Missing required metadata (catalog_variant_id or design_url)' });
    }

    // 3) Quantité (on prend la 1ère ligne pour démarrer; tu pourras itérer ensuite)
    const qty = Math.max(1, Number(items[0]?.quantity || 1));

    // 4) Adresse & contact
    const ship = session.shipping_details || {};
    const addr = ship.address || {};
    const email = session.customer_details?.email || '';
    const phone = session.customer_details?.phone || '';
    const name = ship.name || session.customer_details?.name || 'LuxPrint Client';

    // 5) external_id <= 32 chars (Printful)
    // On dérive un hash court/idempotent à partir de l'id de session Stripe
    const external_id = 'cs_' + createHash('sha256').update(session.id).digest('hex').slice(0, 29);

    // 6) Payload Printful v2
    const order = {
      external_id,
      confirm: PF_CONFIRM, // true => lance la production; false => brouillon
      recipient: {
        name,
        address1: addr.line1 || '',
        address2: addr.line2 || '',
        city: addr.city || '',
        state_code: addr.state || '',
        country_code: addr.country || '',
        zip: addr.postal_code || '',
        phone,
        email,
      },
      items: [
        {
          catalog_variant_id: variantId,
          quantity: qty,
          files: [{ type: 'default', url: designUrl }],
          // Certaines catégories ignorent ces options. Si Printful renvoie "invalid option id",
          // commente/supprime le bloc `options` ci-dessous.
          options: [
            { id: 'placement', value: placement },
            { id: 'technique', value: technique },
          ],
        },
      ],
    };

    // 7) Appel Printful
    const pf = await createPrintfulOrder(order, PF_TOKEN, PF_STORE_ID);

    return res.status(200).json({ ok: true, printful: pf });
  } catch (e) {
    const status = e.status || 500;
    return res.status(status).json({
      ok: false,
      error: e.message || 'Internal error',
      details: e.details || undefined,
    });
  }
};

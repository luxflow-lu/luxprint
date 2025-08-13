// api/stripe/confirm.js
// POST { session_id } -> récupère la session Stripe (+ PI/charge pour l'adresse),
// puis crée (et éventuellement confirme) une commande Printful v2.
//
// ENV requises (Vercel → Settings → Environment Variables):
// - STRIPE_SECRET_KEY            (ex: sk_test_***)
// - PRINTFUL_TOKEN_ORDERS        (ou PRINTFUL_TOKEN_CATALOG)
// - PRINTFUL_STORE_ID            (optionnel; ex: 16601022)
// - PRINTFUL_CONFIRM             ('false' pour créer en brouillon, sinon true par défaut)

const { createHash } = require('crypto');

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*'); // restreins à ton domaine si tu veux
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');
  res.setHeader('Access-Control-Max-Age', '86400');
}

async function stripeGet(path, secret) {
  const r = await fetch(`https://api.stripe.com/v1${path}`, {
    headers: { Authorization: `Bearer ${secret}` }
  });
  const j = await r.json();
  if (!r.ok) {
    const msg = j?.error?.message || `Stripe error on GET ${path}`;
    const e = new Error(msg);
    e.details = j;
    e.status = r.status;
    throw e;
  }
  return j;
}

async function getStripeData(sessionId, secret) {
  // 1) Session Checkout
  const session = await stripeGet(`/checkout/sessions/${sessionId}`, secret);

  // 2) PaymentIntent (pour récupérer shipping/billing si absents de la session)
  let paymentIntent = null;
  let latestCharge = null;
  if (session.payment_intent) {
    // on expand latest_charge pour avoir shipping/billing
    paymentIntent = await stripeGet(`/payment_intents/${session.payment_intent}?expand[]=latest_charge`, secret);
    latestCharge = paymentIntent.latest_charge || null;
    // fallback: si pas d'expand, tente charges list
    if (!latestCharge && paymentIntent.charges && paymentIntent.charges.data && paymentIntent.charges.data.length) {
      latestCharge = paymentIntent.charges.data[0];
    }
  }

  return { session, paymentIntent, latestCharge };
}

function pickAddress({ session, paymentIntent, latestCharge }) {
  // Candidats "shipping"
  const shipCandidates = [
    session.shipping_details,                    // Checkout Session
    paymentIntent && paymentIntent.shipping,     // PaymentIntent
    latestCharge && latestCharge.shipping        // Charge
  ].filter(Boolean);

  // Candidats "billing"
  const billCandidates = [
    session.customer_details,                    // Checkout Session
    latestCharge && latestCharge.billing_details // Charge
  ].filter(Boolean);

  // Choix: shipping prioritaire; sinon billing
  let chosen = null;
  for (const c of shipCandidates) if (c?.address?.line1) { chosen = { kind: 'shipping', src: c }; break; }
  if (!chosen) for (const c of billCandidates) if (c?.address?.line1) { chosen = { kind: 'billing', src: c }; break; }

  if (!chosen) {
    return { ok: false, reason: 'no_address' };
  }

  const name = chosen.src.name || (session.customer_details && session.customer_details.name) || 'LuxPrint Client';
  const email = (session.customer_details && session.customer_details.email) || '';
  const phone = (session.customer_details && session.customer_details.phone) || '';

  const a = chosen.src.address || {};
  const addr = {
    name,
    address1: a.line1 || '',
    address2: a.line2 || '',
    city: a.city || '',
    state_code: a.state || '',
    country_code: a.country || '',
    zip: a.postal_code || '',
    phone,
    email
  };

  // mini validation
  if (!addr.address1 || !addr.city || !addr.country_code) {
    return { ok: false, reason: 'incomplete', addr };
  }

  return { ok: true, addr };
}

async function createPrintfulOrder(payload, token, storeId) {
  const headers = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json'
  };
  if (storeId) headers['X-PF-Store-Id'] = String(storeId);

  const r = await fetch('https://api.printful.com/v2/orders', {
    method: 'POST',
    headers,
    body: JSON.stringify(payload)
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const e = new Error(j?.error?.message || JSON.stringify(j));
    e.details = j;
    e.status = r.status;
    throw e;
  }
  return j;
}

module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method not allowed' });

  try {
    const STRIPE_SK   = process.env.STRIPE_SECRET_KEY;
    const PF_TOKEN    = process.env.PRINTFUL_TOKEN_ORDERS || process.env.PRINTFUL_TOKEN_CATALOG;
    const PF_STORE_ID = process.env.PRINTFUL_STORE_ID || '';
    const PF_CONFIRM  = (process.env.PRINTFUL_CONFIRM || 'true').toLowerCase() !== 'false';

    if (!STRIPE_SK) return res.status(500).json({ ok: false, error: 'Missing STRIPE_SECRET_KEY env' });
    if (!PF_TOKEN)  return res.status(500).json({ ok: false, error: 'Missing PRINTFUL token env' });

    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const session_id = body.session_id;
    if (!session_id) return res.status(400).json({ ok: false, error: 'Missing session_id' });

    // 1) Stripe: session + PI/charge
    const { session, paymentIntent, latestCharge } = await getStripeData(session_id, STRIPE_SK);

    // 2) Vérifie paiement bien "paid"
    if (session.payment_status !== 'paid') {
      return res.status(400).json({ ok: false, error: 'Payment not settled', payment_status: session.payment_status });
    }

    // 3) Récup metadata utiles pour item Printful
    const m = session.metadata || {};
    const variantId = Number(m.catalog_variant_id || 0);
    const designUrl = (m.design_url || '').replace('ucarecd.net', 'ucarecdn.com'); // sécurise domaine
    if (!variantId || !designUrl) {
      return res.status(400).json({ ok: false, error: 'Missing required metadata (catalog_variant_id or design_url)' });
    }
    const qty = 1; // tu pourras mapper toutes les lignes plus tard

    // 4) Adresse: multi-fallback (shipping -> billing -> charge)
    const pick = pickAddress({ session, paymentIntent, latestCharge });
    if (!pick.ok) {
      return res.status(400).json({
        ok: false,
        error: pick.reason === 'no_address'
          ? 'No address found in Checkout Session / PaymentIntent / Charge'
          : 'Incomplete address (need address1/city/country)',
        stripe_debug: {
          has_session_shipping: !!session.shipping_details,
          has_customer_details: !!session.customer_details,
          has_pi: !!paymentIntent,
          has_latest_charge: !!latestCharge
        }
      });
    }
    const recipient = pick.addr;

    // 5) external_id ≤ 32 chars (hash du session.id)
    const external_id = 'cs_' + createHash('sha256').update(session.id).digest('hex').slice(0, 29);

    // 6) Payload Printful (sans "options" pour éviter invalid option id)
    const order = {
      external_id,
      confirm: PF_CONFIRM,
      recipient,
      items: [
        {
          catalog_variant_id: variantId,
          quantity: qty,
          files: [{ type: 'default', url: designUrl }]
          // Si tu veux retenter avec options: décommente ci-dessous
          // options: [
          //   { id: 'placement', value: m.placement || 'front' },
          //   { id: 'technique', value: m.technique || 'dtg' }
          // ]
        }
      ]
    };

    // 7) Création Printful
    const pf = await createPrintfulOrder(order, PF_TOKEN, PF_STORE_ID);

    return res.status(200).json({ ok: true, printful: pf });
  } catch (e) {
    const status = e.status || 500;
    return res.status(status).json({ ok: false, error: e.message || 'Internal error', details: e.details || undefined });
  }
};

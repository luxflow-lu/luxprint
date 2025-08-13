// api/stripe/confirm.js
// POST { session_id } -> crée/confirm la commande Printful à partir de la session Stripe

function cors(res){
  res.setHeader('Access-Control-Allow-Origin','*'); // tu peux restreindre à ton domaine Webflow
  res.setHeader('Access-Control-Allow-Methods','POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type');
  res.setHeader('Access-Control-Max-Age','86400');
}

async function getStripeSession(sessionId, secret){
  // Récupère la session + ses line_items
  const sessResp = await fetch(`https://api.stripe.com/v1/checkout/sessions/${sessionId}`, {
    headers: { 'Authorization': `Bearer ${secret}` }
  });
  const session = await sessResp.json();
  if (!sessResp.ok) throw new Error(session.error?.message || 'Stripe session error');

  const itemsResp = await fetch(`https://api.stripe.com/v1/checkout/sessions/${sessionId}/line_items?limit=100`, {
    headers: { 'Authorization': `Bearer ${secret}` }
  });
  const items = await itemsResp.json();
  if (!itemsResp.ok) throw new Error(items.error?.message || 'Stripe line_items error');

  return { session, items: items.data || [] };
}

async function createPrintfulOrder(payload, token, storeId){
  const headers = {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json',
  };
  if (storeId) headers['X-PF-Store-Id'] = storeId; // optionnel si ton token n’est pas “scopé” à une store

  const resp = await fetch('https://api.printful.com/v2/orders', {
    method: 'POST',
    headers,
    body: JSON.stringify(payload)
  });
  const data = await resp.json().catch(()=> ({}));
  if (!resp.ok) {
    const msg = data?.error?.message || JSON.stringify(data);
    throw new Error(msg);
  }
  return data;
}

module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try{
    const { session_id } = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    if (!session_id) return res.status(400).json({ error: 'Missing session_id' });

    const STRIPE_SK = process.env.STRIPE_SECRET_KEY;
    if (!STRIPE_SK) return res.status(500).json({ error: 'Missing STRIPE_SECRET_KEY env' });

    const PF_TOKEN = process.env.PRINTFUL_TOKEN_ORDERS || process.env.PRINTFUL_TOKEN_CATALOG;
    if (!PF_TOKEN) return res.status(500).json({ error: 'Missing PRINTFUL token env' });

    const PF_STORE_ID = process.env.PRINTFUL_STORE_ID || ''; // optionnel

    // 1) Récup Stripe
    const { session, items } = await getStripeSession(session_id, STRIPE_SK);

    // 2) Récup metadata (posées sur la session côté checkout)
    const m = session.metadata || {};
    const variantId = Number(m.catalog_variant_id || 0);
    const designUrl = m.design_url || '';
    const placement  = m.placement || 'front';
    const technique  = m.technique || 'dtg';

    // quantité (on prend la 1ère ligne pour démarrer)
    const qty = (items[0]?.quantity) || 1;

    // 3) Adresse & contact
    const ship = session.shipping_details || {};
    const addr = ship.address || {};
    const email = session.customer_details?.email || '';

    // 4) Construire la commande Printful v2
    const order = {
      external_id: session.id,     // pour faire l’upsert si besoin
      confirm: true,               // ⚠️ confirme et lance en prod; mets false si tu veux prévisualiser d’abord
      recipient: {
        name: ship.name || session.customer_details?.name || 'LuxPrint Client',
        address1: addr.line1 || '',
        address2: addr.line2 || '',
        city: addr.city || '',
        state_code: addr.state || '',
        country_code: addr.country || '',
        zip: addr.postal_code || '',
        phone: session.customer_details?.phone || '',
        email
      },
      items: [{
        catalog_variant_id: variantId,
        quantity: qty,
        files: [
          { type: 'default', url: designUrl }
        ],
        // certaines catégories ignorent placement/technique; tu peux les retirer si besoin
        options: [
          { id: 'placement', value: placement },
          { id: 'technique', value: technique }
        ]
      }]
    };

    // 5) Appel Printful
    const pf = await createPrintfulOrder(order, PF_TOKEN, PF_STORE_ID);
    return res.status(200).json({ ok: true, printful: pf });
  }catch(e){
    return res.status(500).json({ ok:false, error: e.message });
  }
};

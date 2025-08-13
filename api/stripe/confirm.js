// api/stripe/confirm.js
// POST { session_id } -> récupère la session Stripe (+ PI/charge pour l'adresse),
// crée un ordre Printful v2 (order_items + source=catalog + placements/layers),
// et confirme l'ordre si PRINTFUL_CONFIRM !== 'false'.
//
// Env (Vercel → Settings → Environment Variables):
// - STRIPE_SECRET_KEY
// - PRINTFUL_TOKEN_ORDERS  (ou PRINTFUL_TOKEN_CATALOG)
// - PRINTFUL_STORE_ID      (optionnel, ex "16601022")
// - PRINTFUL_CONFIRM       ('false' pour ne PAS confirmer automatiquement)

const { createHash } = require('crypto');

function cors(res){
  res.setHeader('Access-Control-Allow-Origin','*'); // restreins à ton domaine si tu veux
  res.setHeader('Vary','Origin');
  res.setHeader('Access-Control-Allow-Methods','POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type, Authorization, X-Requested-With');
  res.setHeader('Access-Control-Max-Age','86400');
}

async function stripeGet(path, secret){
  const r = await fetch(`https://api.stripe.com/v1${path}`, {
    headers: { Authorization: `Bearer ${secret}` }
  });
  const j = await r.json();
  if (!r.ok) {
    const e = new Error(j?.error?.message || `Stripe error on GET ${path}`);
    e.status = r.status; e.details = j; throw e;
  }
  return j;
}

async function getStripeData(sessionId, secret){
  const session = await stripeGet(`/checkout/sessions/${sessionId}`, secret);
  let paymentIntent = null, latestCharge = null;
  if (session.payment_intent) {
    paymentIntent = await stripeGet(`/payment_intents/${session.payment_intent}?expand[]=latest_charge`, secret);
    latestCharge = paymentIntent.latest_charge || (paymentIntent.charges?.data?.[0] || null);
  }
  return { session, paymentIntent, latestCharge };
}

function pickAddress({ session, paymentIntent, latestCharge }){
  const ships = [session.shipping_details, paymentIntent?.shipping, latestCharge?.shipping].filter(Boolean);
  const bills = [session.customer_details, latestCharge?.billing_details].filter(Boolean);

  let chosen = null;
  for (const c of ships) if (c?.address?.line1) { chosen = { src: c }; break; }
  if (!chosen) for (const c of bills) if (c?.address?.line1) { chosen = { src: c }; break; }
  if (!chosen) return { ok:false, reason:'no_address' };

  const name  = chosen.src.name || session.customer_details?.name || 'LuxPrint Client';
  const email = session.customer_details?.email || '';
  const phone = session.customer_details?.phone || '';
  const a = chosen.src.address || {};
  const addr = {
    name,
    address1: a.line1 || '',
    address2: a.line2 || '',
    city: a.city || '',
    state_code: a.state || '',
    country_code: a.country || '',
    zip: a.postal_code || '',
    phone, email
  };
  if (!addr.address1 || !addr.city || !addr.country_code) return { ok:false, reason:'incomplete', addr };
  return { ok:true, addr };
}

// --- Printful helpers (v2) ---
function pfHeaders(token, storeId){
  const h = { Authorization: `Bearer ${token}`, 'Content-Type':'application/json' };
  if (storeId) h['X-PF-Store-Id'] = String(storeId);
  return h;
}

async function pfCreateOrder(payload, token, storeId){
  const r = await fetch('https://api.printful.com/v2/orders', {
    method:'POST', headers: pfHeaders(token, storeId), body: JSON.stringify(payload)
  });
  const j = await r.json().catch(()=> ({}));
  if (!r.ok) { const e = new Error(j?.error?.message || JSON.stringify(j)); e.status=r.status; e.details=j; throw e; }
  return j; // { data: { id, status, ... }, _links: {...} }
}

async function pfGetOrder(id, token, storeId){
  const r = await fetch(`https://api.printful.com/v2/orders/${id}`, {
    headers: pfHeaders(token, storeId)
  });
  const j = await r.json().catch(()=> ({}));
  if (!r.ok) { const e = new Error(j?.error?.message || JSON.stringify(j)); e.status=r.status; e.details=j; throw e; }
  return j;
}

async function pfConfirmOrder(id, token, storeId){
  const r = await fetch(`https://api.printful.com/v2/orders/${id}/confirmation`, {
    method:'POST', headers: pfHeaders(token, storeId)
  });
  const j = await r.json().catch(()=> ({}));
  if (!r.ok) { const e = new Error(j?.error?.message || JSON.stringify(j)); e.status=r.status; e.details=j; throw e; }
  return j;
}

const sleep = ms => new Promise(r=>setTimeout(r, ms));

module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ ok:false, error:'Method not allowed' });

  try{
    const STRIPE_SK   = process.env.STRIPE_SECRET_KEY;
    const PF_TOKEN    = process.env.PRINTFUL_TOKEN_ORDERS || process.env.PRINTFUL_TOKEN_CATALOG;
    const PF_STORE_ID = process.env.PRINTFUL_STORE_ID || '';
    const PF_CONFIRM  = (process.env.PRINTFUL_CONFIRM || 'true').toLowerCase() !== 'false';

    if (!STRIPE_SK) return res.status(500).json({ ok:false, error:'Missing STRIPE_SECRET_KEY env' });
    if (!PF_TOKEN)  return res.status(500).json({ ok:false, error:'Missing PRINTFUL token env' });

    const body = typeof req.body==='string' ? JSON.parse(req.body) : (req.body || {});
    const session_id = body.session_id;
    if (!session_id) return res.status(400).json({ ok:false, error:'Missing session_id' });

    // 1) Stripe
    const { session, paymentIntent, latestCharge } = await getStripeData(session_id, STRIPE_SK);
    if (session.payment_status !== 'paid') {
      return res.status(400).json({ ok:false, error:'Payment not settled', payment_status: session.payment_status });
    }

    // 2) Metadata → produit + design
    const m = session.metadata || {};
    const variantId = Number(m.catalog_variant_id || 0);
    let   designUrl = (m.design_url || '').trim();
    if (!variantId || !designUrl) {
      return res.status(400).json({ ok:false, error:'Missing required metadata (catalog_variant_id or design_url)' });
    }
    // Corrige un domaine mal formé éventuel
    designUrl = designUrl.replace('ucarecd.net', 'ucarecdn.com');

    // 3) Adresse
    const pick = pickAddress({ session, paymentIntent, latestCharge });
    if (!pick.ok) {
      return res.status(400).json({
        ok:false,
        error: pick.reason==='no_address'
          ? 'No address found in Session/PI/Charge'
          : 'Incomplete address (need address1/city/country)'
      });
    }
    const recipient = pick.addr;

    // 4) external_id ≤ 32
    const external_id = 'cs_' + createHash('sha256').update(session.id).digest('hex').slice(0, 29);

    // 5) Construire l'ordre v2 avec "order_items" + "source=catalog" + placements/layers (file url)
    // Doc: v2 requires `source` + `placements[].layers[].type=url` when creating from catalog. :contentReference[oaicite:1]{index=1}
    const placement = (m.placement || 'front');
    const technique = (m.technique || 'dtg');

    const orderPayload = {
      external_id,
      recipient,
      order_items: [
        {
          catalog_variant_id: variantId,
          source: 'catalog',
          quantity: 1,
          placements: [
            {
              placement,
              technique,
              layers: [
                { type: 'file', url: designUrl }
              ]
            }
          ]
        }
      ]
    };

    // 6) Create order (draft)
    const created = await pfCreateOrder(orderPayload, PF_TOKEN, PF_STORE_ID);
    const orderId = created?.data?.id;
    if (!orderId) return res.status(500).json({ ok:false, error:'Printful returned no order id', details: created });

    // 7) Optionnel: confirmer (avec retry si le calcul des coûts est en cours)
    let confirmation = null;
    if (PF_CONFIRM) {
      let tries = 0;
      while (tries < 6) {
        try {
          confirmation = await pfConfirmOrder(orderId, PF_TOKEN, PF_STORE_ID);
          break; // ok
        } catch (e) {
          const msg = (e.details?.error?.message || '').toLowerCase();
          // Ex: "order cost is still calculating" → attends et ré-essaie
          if (e.status === 409 || msg.includes('calculat')) {
            await sleep(1500); tries++; continue;
          }
          // autres erreurs: on remonte
          throw e;
        }
      }
    }

    return res.status(200).json({ ok:true, printful: { created, confirmation } });
  } catch (e) {
    const status = e.status || 500;
    return res.status(status).json({ ok:false, error: e.message || 'Internal error', details: e.details || undefined });
  }
};

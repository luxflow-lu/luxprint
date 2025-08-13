const Stripe = require('stripe');
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

// Stripe a besoin du raw body pour vérifier la signature
function rawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).end();

  let event;
  try {
    const buf = await rawBody(req);
    const sig = req.headers['stripe-signature'];
    event = stripe.webhooks.constructEvent(buf, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type !== 'checkout.session.completed') {
    return res.status(200).end();
  }

  try {
    const session = event.data.object;
    const cust = session.customer_details;
    const itemsMeta = JSON.parse(session.metadata?.order || '[]');

    const orderPayload = {
      recipient: {
        name: cust?.name || '',
        address1: cust?.address?.line1 || '',
        city: cust?.address?.city || '',
        country_code: (cust?.address?.country || 'LU'),
        zip: cust?.address?.postal_code || '',
        email: cust?.email || ''
      },
      items: itemsMeta.map(it => ({
        variant_id: Number(it.variant_id),
        quantity: Number(it.quantity || 1),
        product_template_id: Number(it.product_template_id)
      }))
    };

    const resp = await fetch('https://api.printful.com/orders?confirm=true', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.PRINTFUL_TOKEN_ORDERS}`,
        'Content-Type': 'application/json',
        'X-PF-Store-Id': process.env.PRINTFUL_STORE_ID
      },
      body: JSON.stringify(orderPayload)
    });

    const data = await resp.json();
    if (!resp.ok) throw new Error(JSON.stringify(data));
    return res.status(200).end();
  } catch (e) {
    console.error('Printful order error', e);
    return res.status(500).end();
  }
};

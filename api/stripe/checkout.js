const Stripe = require('stripe');
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();

  try {
    const { currency, items, shipping } =
      typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});

    const line_items = (items || []).map(it => ({
      price_data: {
        currency: currency || 'eur',
        unit_amount: it.unit_amount, // TTC en cents
        product_data: { name: it.name, images: it.image ? [it.image] : [] }
      },
      quantity: it.quantity || 1
    }));

    const shipping_options = shipping ? [{
      shipping_rate_data: {
        display_name: shipping.name || 'Livraison',
        fixed_amount: { amount: shipping.amount, currency: currency || 'eur' },
        type: 'fixed_amount'
      }
    }] : [];

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items,
      shipping_options,
      automatic_tax: { enabled: true },
      success_url: `${process.env.SITE_URL}/suivi?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.SITE_URL}/panier`,
      metadata: {
        order: JSON.stringify((items || []).map(({ variant_id, product_template_id, quantity }) => ({
          variant_id, product_template_id, quantity
        })))
      }
    });

    return res.status(200).json({ url: session.url });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};

// ... à l'intérieur de createCheckoutSession()
const form = new URLSearchParams();
form.set('mode', 'payment');

// ✅ reviens avec l'ID de session (on s’en sert pour créer la commande Printful)
form.set('success_url', `${origin}/merci?session_id={CHECKOUT_SESSION_ID}`);
form.set('cancel_url', `${origin}/panier?canceled=1`);

// ➕ collecte des adresses + téléphone
form.set('billing_address_collection', 'required');
form.append('phone_number_collection[enabled]', 'true');

// adresse de livraison requise (pays UE + CH/UK si tu veux)
for (const c of ['LU','FR','BE','DE','NL','ES','IT','PT','AT','IE','CH','GB']) {
  form.append('shipping_address_collection[allowed_countries][]', c);
}

// option de livraison simple (forfait) — tu as déjà ça mais je rappelle
form.append('shipping_options[0][shipping_rate_data][type]', 'fixed_amount');
form.append('shipping_options[0][shipping_rate_data][display_name]', order?.shipping?.name || 'Livraison standard');
form.append('shipping_options[0][shipping_rate_data][fixed_amount][amount]', String(order?.shipping?.amount || 0));
form.append('shipping_options[0][shipping_rate_data][fixed_amount][currency]', order?.currency || 'eur');

// 🧾 ta ligne (1 article pour commencer)
const item = order.items[0] || {};
form.append('line_items[0][quantity]', String(item.quantity || 1));
form.append('line_items[0][price_data][currency]', order?.currency || 'eur');
form.append('line_items[0][price_data][unit_amount]', String(item.unit_amount || 0));
form.append('line_items[0][price_data][product_data][name]', item.name || 'Article');
if (item.image) form.append('line_items[0][price_data][product_data][images][0]', item.image);

// 🧷 metadata (on les récupèrera sur /merci)
form.append('metadata[catalog_variant_id]', String(item.catalog_variant_id || ''));
form.append('metadata[design_url]', item.design_url || '');
form.append('metadata[placement]', item.placement || 'front');
form.append('metadata[technique]', item.technique || 'dtg');

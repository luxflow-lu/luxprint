// /api/stripe/checkout.js
function cors(res){
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Vary','Origin');
  res.setHeader('Access-Control-Allow-Methods','POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type, Authorization, X-Requested-With');
  res.setHeader('Access-Control-Max-Age','86400');
}
module.exports=async(req,res)=>{
  cors(res);
  if(req.method==='OPTIONS') return res.status(204).end();
  if(req.method!=='POST') return res.status(405).json({error:'Method not allowed'});
  try{
    const SK=process.env.STRIPE_SECRET_KEY;
    const ORIGIN=process.env.SITE_URL||'https://luxprint.webflow.io';
    if(!SK) return res.status(500).json({error:'Missing STRIPE_SECRET_KEY env'});
    const body=typeof req.body==='string'?JSON.parse(req.body):(req.body||{});
    const item=(body.items&&body.items[0])||{};
    if(!item||!item.unit_amount) return res.status(400).json({error:'Missing item/unit_amount'});

    const meta={
      catalog_variant_id: String(item.catalog_variant_id||''),
      placements_json: JSON.stringify(item.placements||[]),
      options_json: JSON.stringify(item.options||[]),
      product_id: String(body.product_id||'')
    };

    const form=new URLSearchParams();
    form.set('mode','payment');
    form.set('success_url',`${ORIGIN}/merci?session_id={CHECKOUT_SESSION_ID}`);
    form.set('cancel_url',`${ORIGIN}/panier?canceled=1`);
    form.set('billing_address_collection','required');
    form.append('phone_number_collection[enabled]','true');
    for(const c of ['LU','FR','BE','DE','NL','ES','IT','PT','AT','IE','CH','GB']){
      form.append('shipping_address_collection[allowed_countries][]',c);
    }
    const ship=body.shipping||{};
    form.append('shipping_options[0][shipping_rate_data][type]','fixed_amount');
    form.append('shipping_options[0][shipping_rate_data][display_name]',ship.name||'Livraison standard');
    form.append('shipping_options[0][shipping_rate_data][fixed_amount][amount]',String(ship.amount||0));
    form.append('shipping_options[0][shipping_rate_data][fixed_amount][currency]',body.currency||'eur');

    form.append('line_items[0][quantity]', String(item.quantity||1));
    form.append('line_items[0][price_data][currency]', body.currency||'eur');
    form.append('line_items[0][price_data][unit_amount]', String(item.unit_amount));
    form.append('line_items[0][price_data][product_data][name]', item.name||'Article');
    if(item.image) form.append('line_items[0][price_data][product_data][images][0]', item.image);

    for(const [k,v] of Object.entries(meta)) form.append(`metadata[${k}]`, v);

    const r=await fetch('https://api.stripe.com/v1/checkout/sessions',{
      method:'POST', headers:{Authorization:`Bearer ${SK}`,'Content-Type':'application/x-www-form-urlencoded'}, body:form
    });
    const j=await r.json();
    if(!r.ok) return res.status(r.status).json({error:j?.error?.message||'Stripe error', details:j});
    res.status(200).json({url:j.url});
  }catch(e){ res.status(500).json({error:e.message}); }
};

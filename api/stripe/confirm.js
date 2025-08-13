// /api/stripe/confirm.js
const { createHash } = require('crypto');

function cors(res){
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Vary','Origin');
  res.setHeader('Access-Control-Allow-Methods','POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type, Authorization, X-Requested-With');
  res.setHeader('Access-Control-Max-Age','86400');
}
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function sget(path,sk){
  const r=await fetch(`https://api.stripe.com/v1${path}`,{headers:{Authorization:`Bearer ${sk}`}});
  const j=await r.json();
  if(!r.ok){ const e=new Error(j?.error?.message||`Stripe GET ${path}`); e.status=r.status; e.details=j; throw e; }
  return j;
}
function pickAddr({session,pi,charge}){
  const ships=[session.shipping_details, pi?.shipping, charge?.shipping].filter(Boolean);
  const bills=[session.customer_details, charge?.billing_details].filter(Boolean);
  let src=null;
  for(const c of ships) if(c?.address?.line1){ src=c; break; }
  if(!src) for(const c of bills) if(c?.address?.line1){ src=c; break; }
  if(!src) return null;
  const a=src.address||{}, name=src.name||session.customer_details?.name||'LuxPrint Client';
  const email=session.customer_details?.email||'', phone=session.customer_details?.phone||'';
  if(!a.line1||!a.city||!a.country) return null;
  return { name, address1:a.line1, address2:a.line2||'', city:a.city||'', state_code:a.state||'', country_code:a.country||'', zip:a.postal_code||'', phone, email };
}
function pfHeaders(token,storeId){
  const h={Authorization:`Bearer ${token}`,'Content-Type':'application/json'}; if(storeId) h['X-PF-Store-Id']=String(storeId); return h;
}
async function pfCreate(payload,token,storeId){
  const r=await fetch('https://api.printful.com/v2/orders',{method:'POST',headers:pfHeaders(token,storeId),body:JSON.stringify(payload)});
  const j=await r.json().catch(()=> ({}));
  if(!r.ok){ const e=new Error(j?.error?.message||JSON.stringify(j)); e.status=r.status; e.details=j; throw e; }
  return j;
}
async function pfConfirm(id,token,storeId){
  const r=await fetch(`https://api.printful.com/v2/orders/${id}/confirmation`,{method:'POST',headers:pfHeaders(token,storeId)});
  const j=await r.json().catch(()=> ({}));
  if(!r.ok){ const e=new Error(j?.error?.message||JSON.stringify(j)); e.status=r.status; e.details=j; throw e; }
  return j;
}

module.exports=async(req,res)=>{
  cors(res);
  if(req.method==='OPTIONS') return res.status(204).end();
  if(req.method!=='POST') return res.status(405).json({ok:false,error:'Method not allowed'});
  try{
    const SK=process.env.STRIPE_SECRET_KEY;
    const PF_TOKEN=process.env.PRINTFUL_TOKEN_ORDERS||process.env.PRINTFUL_TOKEN_CATALOG;
    const PF_STORE_ID=process.env.PRINTFUL_STORE_ID||'';
    const PF_CONFIRM=(process.env.PRINTFUL_CONFIRM||'true').toLowerCase()!=='false';
    if(!SK) return res.status(500).json({ok:false,error:'Missing STRIPE_SECRET_KEY env'});
    if(!PF_TOKEN) return res.status(500).json({ok:false,error:'Missing PRINTFUL token env'});

    const {session_id}=typeof req.body==='string'?JSON.parse(req.body):(req.body||{});
    if(!session_id) return res.status(400).json({ok:false,error:'Missing session_id'});

    const session=await sget(`/checkout/sessions/${session_id}`,SK);
    const pi=session.payment_intent?await sget(`/payment_intents/${session.payment_intent}?expand[]=latest_charge`,SK):null;
    const charge=pi?.latest_charge||(pi?.charges?.data?.[0]||null);
    if(session.payment_status!=='paid') return res.status(400).json({ok:false,error:'Payment not settled',payment_status:session.payment_status});

    // Metadata -> produit
    const m=session.metadata||{};
    const variantId=Number(m.catalog_variant_id||0);
    let placements=[]; try{ placements=JSON.parse(m.placements_json||'[]'); }catch(_){}
    let options=[];    try{ options=JSON.parse(m.options_json||'[]'); }catch(_){}
    if(!variantId) return res.status(400).json({ok:false,error:'Missing catalog_variant_id metadata'});

    // Adresse
    const recipient=pickAddr({session,pi,charge});
    if(!recipient) return res.status(400).json({ok:false,error:'Missing or incomplete recipient address'});

    // external_id <= 32
    const external_id='cs_'+createHash('sha256').update(session.id).digest('hex').slice(0,29);

    // Normalise placements -> layers
    const normPlacements=(Array.isArray(placements)?placements:[]).map(p=>({
      placement: p.placement||'front',
      technique: p.technique||'dtg',
      layers: (p.layers||[]).map(l=>({type:'file', url:String(l.url||'').replace('ucarecd.net','ucarecdn.com')}))
    })).filter(p=>p.layers.length);

    const orderPayload={
      external_id,
      recipient,
      order_items:[{
        catalog_variant_id: variantId,
        source:'catalog',
        quantity: 1,
        options: (options||[]).map(o=>({id:o.id, value:o.value})),
        placements: normPlacements
      }]
    };

    const created=await pfCreate(orderPayload,PF_TOKEN,PF_STORE_ID);
    const oid=created?.data?.id;
    if(!oid) return res.status(500).json({ok:false,error:'Printful returned no order id',details:created});

    let confirmation=null;
    if(PF_CONFIRM){
      for(let i=0;i<6;i++){
        try{ confirmation=await pfConfirm(oid,PF_TOKEN,PF_STORE_ID); break; }
        catch(e){ const msg=(e.details?.error?.message||'').toLowerCase(); if(e.status===409||msg.includes('calculat')){ await sleep(1500); continue; } throw e; }
      }
    }
    res.status(200).json({ok:true, printful:{created,confirmation}});
  }catch(e){ res.status(e.status||500).json({ok:false,error:e.message,details:e.details}); }
};

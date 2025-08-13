// /api/stripe/confirm.js
// Récupère la session Stripe -> adresse -> lit metadata (variant, placements, options, product_id) ->
// Normalise placements/techniques avec schéma produit v2 -> ajoute options requises (stitch_color, etc.) ->
// Crée l'ordre v2 (order_items + source:'catalog' + placements/layers + options) ->
// Confirme l'ordre avec retry si "design/cost calculating".

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

// ---- Printful helpers (v2)
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
async function pfGetProduct(productId, token, storeId){
  const r=await fetch(`https://api.printful.com/v2/catalog-products/${productId}`,{headers:pfHeaders(token,storeId)});
  const j=await r.json().catch(()=> ({}));
  if(!r.ok){ const e=new Error(j?.error?.message||JSON.stringify(j)); e.status=r.status; e.details=j; throw e; }
  return j?.data || j;
}

// ---- Build/normalise placements & ensure required options
function buildPlacementSpec(schema){
  const arr = schema?.placements || schema?.available_placements || [];
  const spec = {};
  for (const p of arr){
    const key = p?.key || p?.placement || p?.id || p?.name;
    if (!key || key === 'mockup') continue;
    const techs = Array.isArray(p?.techniques) ? p.techniques
                : Array.isArray(p?.available_techniques) ? p.available_techniques
                : [];
    spec[key] = techs.map(t => String(t).toLowerCase());
  }
  return spec;
}
function normalisePlacements(incoming, spec){
  if (!Array.isArray(incoming)) return [];
  const keys = Object.keys(spec);
  const out = [];
  for (const p of incoming){
    const url = p?.layers?.[0]?.url;
    if (!url) continue;
    let plc = p.placement || 'front';
    if (!spec[plc]) plc = keys[0] || 'front';

    let tech = String(p.technique || '').toLowerCase();
    const allowed = spec[plc] || [];
    if (allowed.length){
      if (!allowed.includes(tech)) tech = allowed[0];
    }
    const item = { placement: plc, technique: tech || undefined, layers: [{ type:'file', url: String(url).replace('ucarecd.net','ucarecdn.com') }] };
    const i = out.findIndex(x => x.placement === plc);
    if (i >= 0) out[i] = item; else out.push(item);
  }
  return out;
}
function ensureRequiredOptions(options, productSchema, placements){
  const out = Array.isArray(options) ? [...options] : [];
  const opts = productSchema?.options || productSchema?.product_options || [];

  // stitch_color si embroidery détecté
  const usesEmbroidery = Array.isArray(placements) && placements.some(p => /embro/i.test(p.technique||''));
  if (usesEmbroidery && !out.find(o => o.id === 'stitch_color')) {
    out.push({ id: 'stitch_color', value: 'black' });
  }

  // autres options requises -> 1ère valeur par défaut
  for (const o of (opts||[])) {
    const id = o.id || o.code || o.name;
    if (!id) continue;
    const isReq = !!(o.required || o.is_required);
    if (!isReq) continue;
    if (out.find(x => x.id === id)) continue;

    const values = o.values || o.allowed_values || [];
    if (Array.isArray(values) && values.length) {
      const first = values[0];
      out.push({ id, value: (first.value ?? first) });
    } else {
      out.push({ id, value: id==='stitch_color' ? 'black' : true });
    }
  }
  return out;
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

    // 1) Stripe
    const session=await sget(`/checkout/sessions/${session_id}`,SK);
    const pi=session.payment_intent?await sget(`/payment_intents/${session.payment_intent}?expand[]=latest_charge`,SK):null;
    const charge=pi?.latest_charge||(pi?.charges?.data?.[0]||null);
    if(session.payment_status!=='paid') return res.status(400).json({ok:false,error:'Payment not settled',payment_status:session.payment_status});

    // 2) Metadata
    const m=session.metadata||{};
    const variantId=Number(m.catalog_variant_id||0);
    const productId=Number(m.product_id||0);
    let placements=[]; try{ placements=JSON.parse(m.placements_json||'[]'); }catch(_){}
    let options=[];    try{ options   =JSON.parse(m.options_json   ||'[]'); }catch(_){}
    if(!variantId) return res.status(400).json({ok:false,error:'Missing catalog_variant_id metadata'});

    // 3) Adresse
    const recipient=pickAddr({session,pi,charge});
    if(!recipient) return res.status(400).json({ok:false,error:'Missing or incomplete recipient address'});

    // 4) external_id ≤ 32
    const external_id='cs_'+createHash('sha256').update(session.id).digest('hex').slice(0,29);

    // 5) Schéma produit + normalisation placements/techniques
    let productSchema=null;
    if (productId) {
      try { productSchema = await pfGetProduct(productId, PF_TOKEN, PF_STORE_ID); } catch(_) {}
    }
    const spec = productSchema ? buildPlacementSpec(productSchema) : {};
    let normPlacements = normalisePlacements(placements, spec);
    if (!normPlacements.length) {
      return res.status(400).json({ ok:false, error:'No design layers provided' });
    }

    // 6) Options sûres (stitch_color + requises)
    let safeOptions = ensureRequiredOptions(options, productSchema, normPlacements);

    // 7) Payload Printful v2
    const orderPayload={
      external_id,
      recipient,
      order_items:[{
        catalog_variant_id: variantId,
        source:'catalog',
        quantity:1,
        options: safeOptions.map(o=>({id:o.id, value:o.value})),
        placements: normPlacements
      }]
    };

    // 8) Create + (optionnel) confirm avec retry si coûts/design en cours
    const created=await pfCreate(orderPayload,PF_TOKEN,PF_STORE_ID);
    const oid=created?.data?.id;
    if(!oid) return res.status(500).json({ok:false,error:'Printful returned no order id',details:created});

    let confirmation=null;
    if(PF_CONFIRM){
      for(let i=0;i<12;i++){
        try{ confirmation=await pfConfirm(oid,PF_TOKEN,PF_STORE_ID); break; }
        catch(e){
          const msg=(e.details?.error?.message||'').toLowerCase();
          if (e.status===409 || msg.includes('calculat') || msg.includes('process')) {
            await sleep(2000); // 2s
            continue;
          }
          throw e;
        }
      }
    }

    res.status(200).json({ok:true, printful:{created,confirmation}});
  }catch(e){
    res.status(e.status||500).json({ok:false,error:e.message,details:e.details});
  }
};

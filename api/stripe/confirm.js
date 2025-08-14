// /api/stripe/confirm.js
// Stripe -> metadata(cart_json) -> charge le schéma produit via product_id OU via variant_id
// -> normalise placements/techniques -> ajoute l'option de couleur de couture (stitch/seam/thread) si nécessaire
// -> crée et confirme l'ordre Printful v2 (avec retry)

const { createHash } = require('crypto');

function cors(res){
  res.setHeader('Access-Control-Allow-Origin','*');   // restreins en prod
  res.setHeader('Vary','Origin');
  res.setHeader('Access-Control-Allow-Methods','POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type, Authorization, X-Requested-With');
  res.setHeader('Access-Control-Max-Age','86400');
}
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

// ---- Stripe
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

// ---- Printful v2
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
async function pfGetVariant(variantId, token, storeId){
  const r=await fetch(`https://api.printful.com/v2/catalog-variants/${variantId}`,{headers:pfHeaders(token,storeId)});
  const j=await r.json().catch(()=> ({}));
  if(!r.ok){ const e=new Error(j?.error?.message||JSON.stringify(j)); e.status=r.status; e.details=j; throw e; }
  return j?.data || j;
}

// ---- Normalisation placements/techniques
function deriveTechsFromKey(key){
  const k=String(key||'').toLowerCase();
  if (/_dtf$/.test(k) || k.includes('dtf')) return ['dtfilm'];           // DTF
  if (k.includes('embroider')) return ['embroidery'];                    // Broderie
  if (k.includes('all-over') || k.includes('sublim')) return ['sublimation']; // AOP
  return ['dtfilm','dtg'];                                               // favorise dtfilm si doute
}
function buildPlacementSpec(schema){
  const arr = schema?.placements || schema?.available_placements || [];
  const spec = {};
  for (const p of arr){
    const key = p?.key || p?.placement || p?.id || p?.name;
    if (!key || key === 'mockup') continue;
    let techs = [];
    if (Array.isArray(p?.techniques) && p.techniques.length) techs = p.techniques;
    else if (Array.isArray(p?.available_techniques) && p.available_techniques.length) techs = p.available_techniques;
    else techs = deriveTechsFromKey(key);
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
    const allowed = spec[plc] || deriveTechsFromKey(plc).map(x=>String(x).toLowerCase());

    if (!tech || !allowed.includes(tech)) {
      if (tech==='dtg' && allowed.includes('dtfilm')) tech='dtfilm';
      else tech = allowed[0];
    }

    const item = { placement: plc, technique: tech || undefined, layers: [{ type:'file', url: String(url).replace('ucarecd.net','ucarecdn.com') }] };
    const i = out.findIndex(x => x.placement === plc);
    if (i >= 0) out[i] = item; else out.push(item);
  }
  return out;
}

// ---- Options : détection robuste de "stitch/seam/thread color"
function findStitchOptionId(schema){
  const opts = schema?.options || schema?.product_options || [];
  let best = null;

  for (const o of opts){
    const id   = (o.id || o.code || o.name || '').toString();
    const title= (o.title || '').toString();
    const both = `${id} ${title}`.toLowerCase();

    // match forts
    if (/\bstitch(?:_|\s)*color\b/.test(both)) { best = id; break; }

    // match souples
    if (/\bstitch/.test(both) && /\bcolor\b/.test(both)) best = id;
    if (/\bseam/.test(both)   && /\bcolor\b/.test(both)) best = best || id;
    if (/\bthread/.test(both) && /\bcolor\b/.test(both)) best = best || id;
  }
  return best; // peut être 'stitch_color', 'seam_color', etc.
}
function pickStitchValue(schema){
  const opts = schema?.options || schema?.product_options || [];
  const id = findStitchOptionId(schema);
  if (!id) return { id:null, value:null };

  const opt = opts.find(o => (o.id||o.code||o.name) === id);
  const values = opt ? (opt.values || opt.allowed_values || []) : [];

  // Préfère 'black' si dispo, sinon 1ʳᵉ valeur
  if (Array.isArray(values) && values.length){
    const vBlack = values.find(v => String(v.value||v).toLowerCase()==='black');
    if (vBlack) return { id, value: (vBlack.value||vBlack) };
    return { id, value: (values[0].value||values[0]) };
  }
  // Fallback sans liste explicite
  return { id, value: 'black' };
}
function ensureOptions(options, productSchema, placements){
  const out = Array.isArray(options) ? [...options] : [];

  // 1) Ajoute stitch/seam/thread color si :
  //    - l'option existe dans le schéma, OU
  //    - une technique embroidery/sublimation est utilisée (AOP/broderie).
  const stitchId = findStitchOptionId(productSchema);
  const needsByTechnique = Array.isArray(placements) && placements.some(p => /embro|sublim/i.test(p.technique||''));
  if ((stitchId || needsByTechnique) && !out.find(o => o.id === (stitchId || 'stitch_color') )) {
    const pick = pickStitchValue(productSchema);
    const id   = stitchId || pick.id || 'stitch_color';
    const val  = pick.value || 'black';
    out.push({ id, value: val });
  }

  // 2) Les autres options "required" -> 1ère valeur par défaut si absentes
  const opts = productSchema?.options || productSchema?.product_options || [];
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
      out.push({ id, value: true });
    }
  }
  return out;
}

// ---- Handler
module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ ok:false, error:'Method not allowed' });

  try{
    const SK=process.env.STRIPE_SECRET_KEY;
    const PF_TOKEN=process.env.PRINTFUL_TOKEN_ORDERS||process.env.PRINTFUL_TOKEN_CATALOG;
    const PF_STORE_ID=process.env.PRINTFUL_STORE_ID||'';
    const PF_CONFIRM=(process.env.PRINTFUL_CONFIRM||'true').toLowerCase()!=='false';
    if(!SK) return res.status(500).json({ok:false,error:'Missing STRIPE_SECRET_KEY'});
    if(!PF_TOKEN) return res.status(500).json({ok:false,error:'Missing PRINTFUL token'});

    const {session_id}=typeof req.body==='string'?JSON.parse(req.body):(req.body||{});
    if(!session_id) return res.status(400).json({ok:false,error:'Missing session_id'});

    // 1) Stripe
    const session=await sget(`/checkout/sessions/${session_id}`,SK);
    if(session.payment_status!=='paid') return res.status(400).json({ok:false,error:'Payment not settled',payment_status:session.payment_status});
    const pi=session.payment_intent?await sget(`/payment_intents/${session.payment_intent}?expand[]=latest_charge`,SK):null;
    const charge=pi?.latest_charge||(pi?.charges?.data?.[0]||null);

    // 2) Cart depuis metadata
    const m = session.metadata || {};
    const productIdMeta = Number(m.product_id || 0);
    let cart=[]; try{ cart=JSON.parse(m.cart_json||'[]'); }catch(_){}
    if(!Array.isArray(cart) || !cart.length) return res.status(400).json({ok:false,error:'Missing cart metadata'});

    const item = cart[0]; // mono-produit pour l’instant
    const variantId = Number(item?.variant_id || 0);
    let placements = item?.placements || [];
    let options    = item?.options    || [];
    if(!variantId) return res.status(400).json({ok:false,error:'Missing catalog_variant_id'});

    // 3) Adresse
    const recipient = pickAddr({session,pi,charge});
    if(!recipient) return res.status(400).json({ok:false,error:'Missing or incomplete recipient address'});

    // 4) external_id ≤ 32
    const external_id='cs_'+createHash('sha256').update(session.id).digest('hex').slice(0,29);

    // 5) Schéma produit (via product_id, sinon via variant -> product)
    let productSchema=null;
    let productId = productIdMeta;
    if (!productId) {
      try { const v = await pfGetVariant(variantId, PF_TOKEN, PF_STORE_ID); productId = Number(v?.product?.id || v?.product_id || 0); } catch(_) {}
    }
    if (productId) {
      try { productSchema = await pfGetProduct(productId, PF_TOKEN, PF_STORE_ID); } catch(_) {}
    }

    // 6) Normalisation placements/techniques
    const spec = productSchema ? buildPlacementSpec(productSchema) : {};
    const normPlacements = normalisePlacements(placements, spec);
    if (!normPlacements.length) return res.status(400).json({ ok:false, error:'No design layers provided' });

    // 7) Options (détection robuste stitch/seam/thread + required)
    const safeOptions = ensureOptions(options, productSchema, normPlacements);

    // 8) Payload Printful v2
    const orderPayload = {
      external_id,
      recipient,
      order_items: [{
        catalog_variant_id: variantId,
        source: 'catalog',
        quantity: 1,
        options: safeOptions.map(o => ({ id:o.id, value:o.value })),
        placements: normPlacements
      }]
    };

    // 9) Create + confirm (retry si design/cost en cours)
    const created = await pfCreate(orderPayload, PF_TOKEN, PF_STORE_ID);
    const oid = created?.data?.id;
    if(!oid) return res.status(500).json({ok:false,error:'Printful returned no order id',details:created});

    let confirmation=null;
    if(PF_CONFIRM){
      for(let i=0;i<12;i++){
        try{ confirmation=await pfConfirm(oid,PF_TOKEN,PF_STORE_ID); break; }
        catch(e){
          const msg=(e.details?.error?.message||'').toLowerCase();
          if (e.status===409 || msg.includes('calculat') || msg.includes('process')) { await sleep(2000); continue; }
          throw e;
        }
      }
    }

    res.status(200).json({ok:true, printful:{created,confirmation}});
  }catch(e){
    res.status(e.status||500).json({ok:false,error:e.message,details:e.details});
  }
};

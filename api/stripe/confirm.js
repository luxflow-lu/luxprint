// /api/stripe/confirm.js
// Stripe -> lit metadata(cart_json) -> récupère schéma produit (via product_id ou via variant_id)
// -> normalise placements/techniques (force techniques autorisées : cut-sew, dtfilm, embroidery, etc.)
// -> assemble toutes les product_options requises dynamiquement (inclut stitch/seam/thread color)
// -> crée + confirme la commande Printful v2, avec fallback si technique invalide détectée.

const { createHash } = require('crypto');

function cors(res){
  res.setHeader('Access-Control-Allow-Origin','*'); // restreins à ton domaine en prod
  res.setHeader('Vary','Origin');
  res.setHeader('Access-Control-Allow-Methods','POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type, Authorization, X-Requested-With');
  res.setHeader('Access-Control-Max-Age','86400');
}
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

// ---------- Stripe
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

// ---------- Printful v2
function pfHeaders(token,storeId){
  const h={Authorization:`Bearer ${token}`,'Content-Type':'application/json'};
  if(storeId) h['X-PF-Store-Id']=String(storeId);
  return h;
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

// ---------- Utilitaires schéma
function collectAllOptions(schema){
  if (!schema) return [];
  const keys = Object.keys(schema || {}).filter(k => /option/i.test(k)); // options, product_options, available_options...
  const arrs = keys.map(k => Array.isArray(schema[k]) ? schema[k] : []).flat();
  return arrs.map(o => ({
    id: (o.id||o.code||o.name||'').toString(),
    title: (o.title||'').toString(),
    values: Array.isArray(o.values) ? o.values
          : Array.isArray(o.allowed_values) ? o.allowed_values
          : [],
    required: !!(o.required || o.is_required)
  })).filter(o => o.id || o.title);
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
function deriveTechsFromKey(key){
  const k=String(key||'').toLowerCase();
  if (/\ball[-_\s]?over\b/.test(k) || /\bcut[-_\s]?&?[-_\s]?sew\b/.test(k) || /\bsublim/.test(k)) return ['cut-sew'];
  if (/_dtf$/.test(k) || /\bdtf\b/.test(k)) return ['dtfilm'];
  if (/\bembroider/.test(k)) return ['embroidery'];
  return ['dtfilm','dtg'];
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
      // Ex: dtg -> cut-sew si c'est un cut&sew-only
      tech = allowed[0];
    }

    const item = { placement: plc, technique: tech || undefined, layers: [{ type:'file', url: String(url).replace('ucarecd.net','ucarecdn.com') }] };
    const i = out.findIndex(x => x.placement === plc);
    if (i >= 0) out[i] = item; else out.push(item);
  }
  return out;
}

// ---------- Options produit (v2 = product_options [{name,value}])
function findStitchLikeIds(schema){
  const all = collectAllOptions(schema);
  const ids = [];
  for (const o of all){
    const both = `${o.id} ${o.title}`.toLowerCase();
    if ((/\bstitch/.test(both) || /\bseam/.test(both) || /\bthread/.test(both)) && /\bcolor\b/.test(both)){
      ids.push(o.id);
    }
  }
  ids.sort((a,b)=> (a==='stitch_color'? -1 : b==='stitch_color'? 1 : 0));
  return Array.from(new Set(ids));
}
function pickFirstValue(opt){
  const values = opt?.values || [];
  if (Array.isArray(values) && values.length){
    const vBlack = values.find(v => String(v.value||v).toLowerCase()==='black');
    if (vBlack) return (vBlack.value||vBlack);
    return (values[0].value||values[0]);
  }
  return 'black'; // fallback sensé pour couleurs de fil
}
function ensureProductOptions(incoming, schema, placements){
  // transforme ce qui vient du client (id/name,value) vers [{name,value}]
  const out = Array.isArray(incoming)
    ? incoming.map(o => ({ name: (o.name||o.id), value: o.value }))
    : [];

  // Index des options déjà posées
  const has = n => out.find(x => String(x.name) === String(n));

  const all = collectAllOptions(schema);

  // 1) Toujours poser les options "required" si absentes (valeur par défaut = 1ère valeur connue ou true)
  for (const opt of all){
    if (!opt.required) continue;
    if (has(opt.id)) continue;
    const def = Array.isArray(opt.values) && opt.values.length ? (opt.values[0].value||opt.values[0]) : true;
    out.push({ name: opt.id, value: def });
  }

  // 2) Couture (stitch/seam/thread color) — ajouter si le schéma la liste OU si technique embroidery/cut&sew détectée
  const stitchIds = findStitchLikeIds(schema);
  const needsByTechnique = Array.isArray(placements) && placements.some(p => /embro|cut[-_\s]?sew/i.test(p.technique||''));

  if (stitchIds.length){
    for (const id of stitchIds){
      if (!has(id)) {
        const opt = all.find(o => o.id === id);
        out.push({ name:id, value: pickFirstValue(opt) });
      }
    }
  } else if (needsByTechnique && !out.find(o => /stitch|seam|thread/i.test(String(o.name)) && /color/i.test(String(o.name)))){
    out.push({ name:'stitch_color', value:'black' });
  }

  // 3) Dédupe par name (le dernier gagne)
  const map = new Map();
  for (const o of out){ map.set(String(o.name), o.value); }
  return Array.from(map, ([name,value]) => ({ name, value }));
}

// ---------- Handler
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

    // 2) Cart metadata
    const m = session.metadata || {};
    const productIdMeta = Number(m.product_id || 0);
    let cart=[]; try{ cart=JSON.parse(m.cart_json||'[]'); }catch(_){}
    if(!Array.isArray(cart) || !cart.length) return res.status(400).json({ok:false,error:'Missing cart metadata'});

    const item = cart[0]; // mono-produit
    const variantId = Number(item?.variant_id || 0);
    let placements = item?.placements || [];
    let options    = item?.options    || []; // client options (peuvent être vides)
    if(!variantId) return res.status(400).json({ok:false,error:'Missing catalog_variant_id'});

    // 3) Adresse
    const recipient = pickAddr({session,pi,charge});
    if(!recipient) return res.status(400).json({ok:false,error:'Missing or incomplete recipient address'});

    // 4) external_id ≤ 32
    const external_id='cs_'+createHash('sha256').update(session.id).digest('hex').slice(0,29);

    // 5) Schéma produit (via product_id, sinon via variant → product)
    let productSchema=null;
    let productId = productIdMeta;
    try {
      if (!productId) {
        const v = await pfGetVariant(variantId, PF_TOKEN, PF_STORE_ID);
        productId = Number(v?.product?.id || v?.product_id || 0);
      }
      if (productId) {
        productSchema = await pfGetProduct(productId, PF_TOKEN, PF_STORE_ID);
      }
    } catch(_) {}

    // 6) Normalise placements/techniques avec liste autorisée (schema-first)
    const spec = productSchema ? buildPlacementSpec(productSchema) : {};
    let normPlacements = normalisePlacements(placements, spec);
    if (!normPlacements.length) return res.status(400).json({ ok:false, error:'No design layers provided' });

    // 7) Product options dynamiques (v2 = product_options [{name,value}])
    let product_options = ensureProductOptions(options, productSchema, normPlacements);

    // 8) Payload v2
    let orderPayload = {
      external_id,
      recipient,
      order_items: [{
        catalog_variant_id: variantId,
        source: 'catalog',
        quantity: 1,
        product_options,
        placements: normPlacements
      }]
    };

    // 9) Create avec fallback si technique invalide (ex: "dtg one of: [cut-sew]")
    let created;
    try{
      created = await pfCreate(orderPayload, PF_TOKEN, PF_STORE_ID);
    }catch(e1){
      const msg = (e1.details?.error?.message || e1.message || '').toLowerCase();
      const mTech = msg.match(/invalid technique used:\s*`?([a-z\-]+)`?.*?\[(.*?)\]/i);
      if (mTech) {
        const allowed = mTech[2].split(',').map(s=>s.trim().replace(/[\s'"]/g,'')).filter(Boolean);
        if (allowed.length){
          normPlacements = normPlacements.map(p => ({ ...p, technique: allowed[0] }));
          orderPayload.order_items[0].placements = normPlacements;
          created = await pfCreate(orderPayload, PF_TOKEN, PF_STORE_ID);
        } else throw e1;
      } else {
        throw e1;
      }
    }

    const oid = created?.data?.id;
    if(!oid) return res.status(500).json({ok:false,error:'Printful returned no order id',details:created});

    // 10) Confirm (retry si coût/design en cours)
    let confirmation=null;
    if(PF_CONFIRM){
      for(let i=0;i<12;i++){
        try{ confirmation=await pfConfirm(oid,PF_TOKEN,PF_STORE_ID); break; }
        catch(e){
          const m=(e.details?.error?.message||'').toLowerCase();
          if (e.status===409 || m.includes('calculat') || m.includes('process')) { await sleep(2000); continue; }
          throw e;
        }
      }
    }

    res.status(200).json({ok:true, printful:{created,confirmation}});
  }catch(e){
    res.status(e.status||500).json({ok:false,error:e.message,details:e.details});
  }
};

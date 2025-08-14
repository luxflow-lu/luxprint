// /api/stripe/confirm.js
const { createHash } = require('crypto');

function cors(res){
  res.setHeader('Access-Control-Allow-Origin','*'); // en prod: restreins à ton domaine
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

// ---------- Schéma / placements / options
function collectAllOptions(schema){
  if (!schema) return [];
  const keys = Object.keys(schema || {}).filter(k => /option/i.test(k));
  const arrs = keys.map(k => Array.isArray(schema[k]) ? schema[k] : []).flat();
  return arrs.map(o => ({
    id: (o.id||o.code||o.name||'').toString(),
    title: (o.title||'').toString(),
    values: Array.isArray(o.values) ? o.values
          : Array.isArray(o.allowed_values) ? o.allowed_values
          : [],
    required: !!(o.required || o.is_required),
    type: String(o.type||'').toLowerCase()
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
  return ['dtg','dtfilm'];
}
function normalisePlacements(incoming, spec){
  if (!Array.isArray(incoming)) return [];
  const keys = Object.keys(spec||{});
  const out = [];
  for (const p of incoming){
    const layer = (p?.layers||[])[0];
    const url = layer?.url;
    if (!url) continue;

    let plc = p.placement || 'front';
    if (!spec[plc] && keys.length) plc = keys[0];

    let tech = String(p.technique || '').toLowerCase();
    const allowed = spec[plc] || deriveTechsFromKey(plc).map(x=>String(x).toLowerCase());
    if (!tech || !allowed.includes(tech)) tech = allowed[0];

    const filename = layer.filename || (()=>{ try{ const u=new URL(url); const parts=u.pathname.split('/').filter(Boolean); return parts[parts.length-1] || 'design.png'; }catch(_){ return 'design.png'; } })();

    const item = {
      placement: plc,
      technique: tech || undefined,
      layers: [{ type:'file', url: String(url).replace('ucarecd.net','ucarecdn.com'), filename }]
    };
    const i = out.findIndex(x => x.placement === plc);
    if (i >= 0) out[i] = item; else out.push(item);
  }
  return out;
}

// options produit (booléens, valeurs autorisées, couture auto)
function coerceBoolean(v){
  if (v === true || v === false) return v;
  const s = String(v).toLowerCase();
  return (s==='true'||s==='1'||s==='yes'||s==='on');
}
function pickFirstValue(opt){
  const values = opt?.values || [];
  if (Array.isArray(values) && values.length){
    const vBlack = values.find(v => String(v.value||v).toLowerCase()==='black');
    if (vBlack) return (vBlack.value||vBlack);
    return (values[0].value||values[0]);
  }
  return true;
}
function ensureProductOptions(incoming, schema, placements){
  const all = collectAllOptions(schema);

  let out = Array.isArray(incoming)
    ? incoming.map(o => {
        const name = (o.name || o.id);
        const def  = all.find(x => x.id === name);
        let value  = o.value;
        if (def?.type === 'boolean') value = coerceBoolean(value);
        if (Array.isArray(def?.values) && def.values.length){
          const allowed = def.values.map(v => v.value ?? v);
          if (!allowed.some(av => String(av) === String(value))) {
            value = allowed[0];
          }
        }
        return { name, value };
      })
    : [];

  const has = n => out.find(x => String(x.name) === String(n));
  const get = n => all.find(x => x.id === n);

  // lifelike : si non requis → supprime
  const likeDef = get('lifelike');
  if (likeDef && !likeDef.required) out = out.filter(x => x.name !== 'lifelike');

  // ajouter les REQUIRED manquantes
  for (const opt of all){
    if (!opt.required) continue;
    if (has(opt.id)) continue;
    let defVal;
    if (opt.type === 'boolean') defVal = false;
    else if (Array.isArray(opt.values) && opt.values.length) defVal = (opt.values[0].value||opt.values[0]);
    else defVal = pickFirstValue(opt);
    out.push({ name: opt.id, value: defVal });
  }

  // --- PATCH ROBUSTE stitch_color ---
  const needCutSew = Array.isArray(placements) && placements.some(p => /cut[-_\s]?sew|all[-_\s]?over/i.test(p.technique||p.placement||''));
  const schemaHasStitch = !!get('stitch_color');
  const hasStitch = !!has('stitch_color');
  if ((needCutSew || schemaHasStitch) && !hasStitch){
    const def = get('stitch_color');
    let val = 'black';
    if (def && Array.isArray(def.values) && def.values.length){
      const allowed = def.values.map(v => v.value ?? v);
      val = allowed.includes('black') ? 'black' : allowed[0];
    }
    out.push({ name:'stitch_color', value: val });
  }
  // -----------------------------------

  // dédup (le dernier gagne)
  const map = new Map();
  for (const o of out) map.set(String(o.name), o.value);
  return Array.from(map, ([name,value]) => ({ name, value }));
}

// fallbacks placements
function fillMissingPlacements(placements, spec){
  if (!placements.length) return placements;
  const firstLayer = placements[0]?.layers?.[0];
  if (!firstLayer?.url) return placements;

  const keys = Object.keys(spec||{});
  if (!keys.length) return placements;

  const out = [...placements];
  for (const key of keys){
    if (!out.find(p => p.placement === key)){
      const techs = spec[key] || deriveTechsFromKey(key);
      out.push({
        placement: key,
        technique: (techs[0]||'dtg'),
        layers: [{ type:'file', url: firstLayer.url, filename: firstLayer.filename || 'design.png' }]
      });
    }
  }
  return out;
}
function forceAllowedTechniqueForPlacement(placements, spec){
  return placements.map(p=>{
    const allowed = (spec && spec[p.placement]) || deriveTechsFromKey(p.placement);
    const tech = String(p.technique||'').toLowerCase();
    if (!allowed.includes(tech)) return { ...p, technique: allowed[0] };
    return p;
  });
}

// ---------- Handler
module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ ok:false, error:'Method not allowed' });

  try{
    const SK=process.env.STRIPE_SECRET_KEY;
    const PF_TOKEN=process.env.PRINTFUL_TOKEN_ORDERS||process.env.PRINTFUL_TOKEN_CATALOG;
    const PF_STORE_ID=process.env.PRINTFUL_STORE_ID;
    const PF_CONFIRM=(process.env.PRINTFUL_CONFIRM||'true').toLowerCase()!=='false';

    if(!SK) return res.status(500).json({ok:false,error:'Missing STRIPE_SECRET_KEY'});
    if(!PF_TOKEN) return res.status(500).json({ok:false,error:'Missing PRINTFUL token'});
    if(!PF_STORE_ID) return res.status(500).json({ok:false,error:'Missing PRINTFUL_STORE_ID'});

    const {session_id}=typeof req.body==='string'?JSON.parse(req.body):(req.body||{});
    if(!session_id) return res.status(400).json({ok:false,error:'Missing session_id'});

    // Stripe
    const session=await sget(`/checkout/sessions/${session_id}`,SK);
    if(session.payment_status!=='paid') return res.status(400).json({ok:false,error:'Payment not settled',payment_status:session.payment_status});
    const pi=session.payment_intent?await sget(`/payment_intents/${session.payment_intent}?expand[]=latest_charge`,SK):null;
    const charge=pi?.latest_charge||(pi?.charges?.data?.[0]||null);

    // Metadata cart
    const m = session.metadata || {};
    const productIdMeta = Number(m.product_id || 0);
    let cart=[]; try{ cart=JSON.parse(m.cart_json||'[]'); }catch(_){}
    if(!Array.isArray(cart) || !cart.length) return res.status(400).json({ok:false,error:'Missing cart metadata'});

    const item = cart[0];
    const variantId = Number(item?.variant_id || 0);
    const quantity  = Math.max(1, parseInt(item?.quantity || 1, 10));
    let placements = item?.placements || [];
    let options    = item?.options    || [];
    if(!variantId) return res.status(400).json({ok:false,error:'Missing catalog_variant_id'});

    // Adresse
    const recipient = pickAddr({session,pi,charge});
    if(!recipient) return res.status(400).json({ok:false,error:'Missing or incomplete recipient address'});

    // external_id ≤ 32
    const external_id='cs_'+createHash('sha256').update(session.id).digest('hex').slice(0,29);

    // Schéma produit
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

    const spec = productSchema ? buildPlacementSpec(productSchema) : {};
    let normPlacements = normalisePlacements(placements, spec);
    if (!normPlacements.length) return res.status(400).json({ ok:false, error:'No design layers provided' });

    let product_options = ensureProductOptions(options, productSchema, normPlacements);

    let orderPayload = {
      external_id,
      recipient,
      order_items: [{
        catalog_variant_id: variantId,
        source: 'catalog',
        quantity: quantity,
        product_options,
        placements: normPlacements
      }]
    };

    // Create + fallbacks
    let created;
    try{
      created = await pfCreate(orderPayload, PF_TOKEN, PF_STORE_ID);
    }catch(e1){
      const msg = (e1.details?.error?.message || e1.message || '').toLowerCase();

      // technique non autorisée pour ce placement
      const mPlcTech = msg.match(/placement\s*`?([a-z0-9_\-]+)`?\s*cannot be used with\s*`?([a-z0-9_\-]+)`?\s*technique/i);
      if (mPlcTech){
        const badPlc = mPlcTech[1];
        const allowed = (spec && spec[badPlc]) || deriveTechsFromKey(badPlc);
        orderPayload.order_items[0].placements = orderPayload.order_items[0].placements.map(p=>{
          if (p.placement === badPlc){
            return { ...p, technique: allowed[0] || 'dtg' };
          }
          return p;
        });
        created = await pfCreate(orderPayload, PF_TOKEN, PF_STORE_ID);
      }
      // placements supplémentaires requis → réplique le visuel + force techniques autorisées
      else if (/must use additional placements|available placements are/i.test(msg)){
        orderPayload.order_items[0].placements = fillMissingPlacements(orderPayload.order_items[0].placements, spec);
        orderPayload.order_items[0].placements = forceAllowedTechniqueForPlacement(orderPayload.order_items[0].placements, spec);
        // (re)vérifie stitch_color après duplication si besoin
        orderPayload.order_items[0].product_options = ensureProductOptions(product_options, productSchema, orderPayload.order_items[0].placements);
        created = await pfCreate(orderPayload, PF_TOKEN, PF_STORE_ID);
      }
      // technique invalide → remappe sur la 1ʳᵉ autorisée renvoyée par l’erreur
      else {
        const mTech = msg.match(/invalid technique used:\s*`?([a-z\-]+)`?.*?\[(.*?)\]/i);
        if (mTech) {
          const allowed = mTech[2].split(',').map(s=>s.trim().replace(/[\s'"]/g,'')).filter(Boolean);
          if (allowed.length){
            orderPayload.order_items[0].placements = orderPayload.order_items[0].placements.map(p=> ({ ...p, technique: allowed[0] }));
            created = await pfCreate(orderPayload, PF_TOKEN, PF_STORE_ID);
          } else throw e1;
        } else {
          throw e1;
        }
      }
    }

    const oid = created?.data?.id;
    if(!oid) return res.status(500).json({ok:false,error:'Printful returned no order id',details:created, store_id: PF_STORE_ID});

    // Confirm avec retry
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

    res.status(200).json({
      ok:true,
      printful_order_id: oid,
      store_id: PF_STORE_ID,
      printful:{created,confirmation}
    });
  }catch(e){
    res.status(e.status||500).json({ok:false,error:e.message,details:e.details});
  }
};

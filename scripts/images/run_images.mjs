// scripts/images/run_images.mjs
import fs from 'node:fs/promises';
import path from 'node:path';

// --------- Config/ENV ----------
const BASE_URL = process.env.BASE_URL || 'https://api.printful.com';
const TOKEN = process.env.PRINTFUL_TOKEN;
const PAGE_LIMIT = Math.min(Math.max(parseInt(process.env.PAGE_LIMIT||'100',10)||100,1),100);
let   CONC = Math.min(Math.max(parseInt(process.env.INIT_CONCURRENCY||'6',10)||6,1),8);
const STRICT = String(process.env.STRICT||'true').toLowerCase()==='true';

if(!TOKEN){
  console.error('Missing PRINTFUL_TOKEN in env.');
  process.exit(1);
}

// --------- Utils ----------
const sleep = (ms)=> new Promise(res=>setTimeout(res,ms));
const ensureDir = async (p)=>{ await fs.mkdir(p,{recursive:true}); };
const now = ()=> new Date().toISOString();

function csvEscape(v){
  if (v==null) return '';
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g,'""')}"` : s;
}
async function writeCSV(rows, outPath){
  const header = Object.keys(rows[0]||{
    key:'',product_id:'',variant_id:'',placement:'',angle:'',color_label:'',color_hex:'',image_url:'',thumb_url:'',source:''
  });
  const lines = [header.join(',')];
  for(const r of rows){
    lines.push(header.map(k=>csvEscape(r[k])).join(','));
  }
  await ensureDir(path.dirname(outPath));
  await fs.writeFile(outPath, lines.join('\n'), 'utf8');
  console.log(`Wrote ${outPath} — ${rows.length} rows`);
}

// Simple fetch JSON with 429 backoff + concurrency gate
let active = 0;
const queue = [];
async function withGate(fn){
  if(active >= CONC){
    await new Promise(res=>queue.push(res));
  }
  active++;
  try { return await fn(); }
  finally {
    active--;
    if(queue.length) queue.shift()();
  }
}

async function getJSON(apiPath, params={}){
  const url = new URL(apiPath, BASE_URL);
  Object.entries(params).forEach(([k,v])=>{
    if(v!==undefined && v!==null && v!=='') url.searchParams.set(k, String(v));
  });

  return await withGate(async ()=>{
    while(true){
      const r = await fetch(url, {
        headers:{ 'Authorization': `Bearer ${TOKEN}` }
      });
      if(r.status===429){
        const ra = Number(r.headers.get('retry-after')||'2')*1000 || 2000;
        const jitter = Math.floor(Math.random()*400);
        const wait = ra + jitter;
        console.warn(`[429] waiting ~${wait}ms (retry-after=${Math.round(ra/1000)})`);
        // baisser la concurrence si on se fait taper
        if(CONC>1){ console.warn(`[rate] decrease concurrency ${CONC} -> ${CONC-1}`); CONC = CONC-1; }
        await sleep(wait);
        continue;
      }
      if(!r.ok){
        let txt='';
        try{ txt = await r.text(); }catch(_){}
        throw new Error(`HTTP ${r.status} - ${txt||r.statusText}`);
      }
      try {
        return await r.json();
      } catch(e){
        throw new Error(`Invalid JSON: ${e.message}`);
      }
    }
  });
}

// --------- Normalisation / extraction ----------
const PLACEMENT_ALIASES = {
  front: ['front','center front','front print','front_print'],
  back:  ['back','center back','back print','back_print'],
  left:  ['left','left sleeve','left side','left_print','sleeve_left'],
  right: ['right','right sleeve','right side','right_print','sleeve_right'],
  label_outside: ['label outside','outside label','outside_label'],
  label_inside:  ['label inside','inside label','inside_label'],
  pocket: ['pocket','front pocket','pocket_print'],
  hood: ['hood','hood print'],
  brim: ['brim','visor','bill'],
  leg_left: ['left leg','leg left'],
  leg_right:['right leg','leg right'],
};

function normPlacement(x){
  const k = String(x||'').toLowerCase().trim();
  if(!k) return '';
  for(const [norm, list] of Object.entries(PLACEMENT_ALIASES)){
    if(list.includes(k)) return norm;
  }
  // heuristique simple
  if(/front/.test(k)) return 'front';
  if(/back/.test(k))  return 'back';
  if(/\bleft\b/.test(k)) return 'left';
  if(/\bright\b/.test(k)) return 'right';
  return k.replace(/\s+/g,'_');
}

function collectUrls(obj, currentPlacement=''){
  const out=[];
  if(!obj || typeof obj!=='object') return out;

  // champs classiques
  const directUrl = obj.image_url || obj.preview_url || obj.url || obj.image || obj.thumbnail_url;
  const placement = normPlacement(obj.placement || obj.side || currentPlacement || '');

  // si on a un url "image-like"
  if (directUrl && /^https?:\/\/.+\.(png|jpg|jpeg|webp)(\?|$)/i.test(String(directUrl))){
    out.push({
      placement,
      image_url: obj.image_url || obj.url || obj.image || obj.preview_url || '',
      thumb_url: obj.thumbnail_url || '',
      angle: obj.angle || obj.view || '',
      source: obj.source || obj.type || ''
    });
  }

  // tableaux connus
  for(const key of ['images','files','mockups','variants','items','options']){
    const val = obj[key];
    if(Array.isArray(val)){
      for(const it of val){
        out.push(...collectUrls(it, placement));
      }
    }
  }

  // profondeur sur objets imbriqués (limité)
  for(const [k,v] of Object.entries(obj)){
    if(v && typeof v==='object' && !Array.isArray(v) && k!=='parent'){
      out.push(...collectUrls(v, placement));
    }
  }
  return out;
}

function uniqBy(arr, keyFn){
  const seen = new Set();
  const out=[];
  for(const it of arr){
    const key = keyFn(it);
    if(seen.has(key)) continue;
    seen.add(key);
    out.push(it);
  }
  return out;
}

function toKey({product_id, variant_id, placement, image_url}, i){
  return `${product_id || 'p'}__${variant_id || 'v'}__${placement || 'any'}__${i}`;
}

// --------- API wrappers (souples, tolérants) ----------
async function listCatalogProductIds(){
  let offset=0, total=Infinity;
  const ids=[];
  console.log(`Images v2 start — PAGE_LIMIT=${PAGE_LIMIT}, INIT_CONC=${CONC}`);

  while(offset < total){
    let j;
    try{
      // Essai 1: /v2/catalog/products
      j = await getJSON('/v2/catalog/products', { limit: PAGE_LIMIT, offset });
    }catch(e){
      // Essai 2: /v2/products (fallback anciens tenants)
      console.warn(`[catalog list] fallback v2/products due to: ${e.message}`);
      j = await getJSON('/v2/products', { limit: PAGE_LIMIT, offset });
    }
    const items = j?.result?.items || j?.result || [];
    if(!Array.isArray(items)) throw new Error('Invalid products list payload');
    items.forEach(p => {
      const pid = p.id || p.product_id || p.catalog_product_id;
      if(pid) ids.push(Number(pid));
    });
    const paging = j?.result?.paging || j?.paging || {};
    const got = items.length;
    total = Number(paging?.total ?? (got ? offset+got+PAGE_LIMIT : ids.length));
    console.log(`...products listed ${offset+got}/${isFinite(total)?total:'?'}`);
    if (!got) break;
    offset += got;
  }
  console.log(`Found ${ids.length} catalog products`);
  return ids;
}

async function fetchProductDetails(pid){
  try{
    const j = await getJSON(`/v2/catalog/products/${pid}`);
    return j?.result || j?.product || j || {};
  }catch(e){
    // fallback legacy
    try{
      const j2 = await getJSON(`/v2/products/${pid}`);
      return j2?.result || j2?.product || j2 || {};
    }catch(e2){
      console.warn(`product ${pid} details failed:`, e2.message);
      return {};
    }
  }
}

async function fetchProductVariants(pid){
  try{
    const j = await getJSON(`/v2/catalog/variants`, { product_id: pid, limit: 100, offset: 0 });
    const items = j?.result?.items || j?.result?.variants || j?.variants || j?.result || [];
    return Array.isArray(items) ? items : [];
  }catch(e){
    // fallback legacy
    try{
      const j2 = await getJSON(`/v2/variants`, { product_id: pid, limit: 100, offset: 0 });
      const items = j2?.result?.items || j2?.result?.variants || j2?.variants || j2?.result || [];
      return Array.isArray(items) ? items : [];
    }catch(e2){
      console.warn(`product ${pid} variants failed:`, e2.message);
      return [];
    }
  }
}

// --------- Main pipeline ----------
(async function main(){
  try{
    const outRows = [];
    const ids = await listCatalogProductIds();

    // petit pool manuel
    let scanned=0;
    const tasks = ids.map(pid => withGate(async ()=>{
      // détail produit
      const detail = await fetchProductDetails(pid);
      const product = detail.product || detail;

      // images niveau produit
      const prodImgs = uniqBy(
        collectUrls(product)
          .map(x=>({ ...x, placement: normPlacement(x.placement), product_id: pid, variant_id: '' }))
          .filter(x=>x.image_url),
        x=>x.image_url
      );

      // variantes (pour choper previews couleurs/taille si dispo)
      const variants = await fetchProductVariants(pid);
      const varImgs = [];
      for (const v of variants){
        const vid = v.id || v.variant_id || v.catalog_variant_id || '';
        const color_label = v.color || v.color_name || (v.attributes?.color)||'';
        const color_hex   = v.color_code || v.color_hex || '';
        const imgs = collectUrls(v).map(x=>({
          ...x,
          placement: normPlacement(x.placement),
          product_id: pid,
          variant_id: vid || '',
          color_label,
          color_hex
        })).filter(x=>x.image_url);
        varImgs.push(...imgs);
      }
      const varImgsUniq = uniqBy(varImgs, x=>`${x.variant_id}::${x.image_url}`);

      // fusion
      const merged = uniqBy([...prodImgs, ...varImgsUniq], x=>`${x.product_id}::${x.variant_id}::${x.image_url}`);

      // pousse au format CSV
      merged.forEach((rec,i)=>{
        outRows.push({
          key: toKey(rec,i),
          product_id: rec.product_id || '',
          variant_id: rec.variant_id || '',
          placement: rec.placement || '',
          angle: rec.angle || '',
          color_label: rec.color_label || '',
          color_hex: rec.color_hex || '',
          image_url: rec.image_url || '',
          thumb_url: rec.thumb_url || '',
          source: rec.source || (rec.variant_id?'variant':'product')
        });
      });

      scanned++;
      if(scanned % 20 === 0){
        console.log(`...processed ${scanned}/${ids.length} products (rows=${outRows.length}) | conc=${CONC}, active=${active}`);
      }
    }));

    // Attendre toutes les tâches
    await Promise.all(tasks);

    // écrire CSV
    const outPath = path.join('data','product_images_by_placement.csv');
    if(STRICT && outRows.length===0){
      console.warn('No rows produced — failing (STRICT=true)');
      process.exit(1);
    }
    // tri stable : product_id, placement, variant_id
    outRows.sort((a,b)=>{
      if(a.product_id!==b.product_id) return a.product_id - b.product_id;
      if(a.placement!==b.placement) return String(a.placement).localeCompare(String(b.placement));
      return (a.variant_id||'').localeCompare(b.variant_id||'');
    });
    await writeCSV(outRows, outPath);
    console.log('=== IMAGES SUMMARY ===');
    console.log(`Started: ${now()}`);
    console.log(`Products: ${ids.length}`);
    console.log(`Rows:     ${outRows.length}`);
    console.log('Done.');
  }catch(e){
    console.error('IMAGES failed:', e.message);
    process.exit(1);
  }
})();

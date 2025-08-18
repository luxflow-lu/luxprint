// scripts/images/run_images.mjs
import fs from 'node:fs/promises';
import path from 'node:path';

// --------- ENV / Config ----------
const BASE_URL  = process.env.BASE_URL || 'https://api.printful.com';
const TOKEN     = process.env.PRINTFUL_TOKEN || '';       // pas requis pour /catalog
const PAGE_LIMIT= Math.min(Math.max(parseInt(process.env.PAGE_LIMIT||'100',10)||100,1),100);
let   CONC      = Math.min(Math.max(parseInt(process.env.INIT_CONCURRENCY||'6',10)||6,1),8);
const STRICT    = String(process.env.STRICT||'true').toLowerCase()==='true';

const MAX_RETRIES_5XX = parseInt(process.env.MAX_RETRIES_5XX||'6',10); // ~exponentiel
const RETRY_BASE_MS   = parseInt(process.env.RETRY_BASE_MS||'600',10); // base pour backoff 5xx
const PRODUCT_IDS_ENV = (process.env.PRODUCT_IDS||'').trim();          // ex: "360,640,854"
const FALLBACK_PRODUCTS_CSV = process.env.FALLBACK_PRODUCTS_CSV || 'data/products.csv';

const sleep = (ms)=> new Promise(res=>setTimeout(res,ms));
const ensureDir = async (p)=>{ await fs.mkdir(p,{recursive:true}); };
const now = ()=> new Date().toISOString();
const exists = async (p)=>!!(await fs.access(p).then(()=>true).catch(()=>false));

// --------- CSV helpers ----------
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
  for (const r of rows){ lines.push(header.map(k=>csvEscape(r[k])).join(',')); }
  await ensureDir(path.dirname(outPath));
  await fs.writeFile(outPath, lines.join('\n'),'utf8');
  console.log(`Wrote ${outPath} — ${rows.length} rows`);
}

// --------- Concurrency gate ----------
let active = 0;
const queue = [];
async function withGate(fn){
  if(active >= CONC){ await new Promise(res=>queue.push(res)); }
  active++;
  try { return await fn(); }
  finally {
    active--;
    if(queue.length) queue.shift()();
  }
}

// --------- Robust fetch JSON ----------
async function getJSON(apiPath, params={}){
  const url = new URL(apiPath, BASE_URL);
  Object.entries(params).forEach(([k,v])=>{
    if(v!==undefined && v!==null && v!=='') url.searchParams.set(k, String(v));
  });

  return await withGate(async ()=>{
    let attempt = 0;
    while(true){
      let r;
      try{
        r = await fetch(url, { headers: TOKEN ? { 'Authorization': `Bearer ${TOKEN}` } : {} });
      }catch(e){
        // erreur réseau -> traiter comme 5xx
        if(attempt < MAX_RETRIES_5XX){
          const wait = Math.round(Math.min(120000, (RETRY_BASE_MS * Math.pow(2,attempt)) + Math.random()*400));
          if(CONC>1){ console.warn(`[net] drop concurrency ${CONC} -> ${CONC-1}`); CONC--; }
          console.warn(`[net] ${e.message} — retry in ~${wait}ms (attempt ${attempt+1}/${MAX_RETRIES_5XX})`);
          attempt++; await sleep(wait); continue;
        }
        throw new Error(`Network error (after retries): ${e.message} @ ${url.pathname}${url.search}`);
      }

      // 429: respect Retry-After + baisse conc
      if(r.status===429){
        const ra = Number(r.headers.get('retry-after')||'2')*1000 || 2000;
        const wait = ra + Math.floor(Math.random()*400);
        console.warn(`[429] waiting ~${wait}ms (retry-after=${Math.round(ra/1000)})`);
        if(CONC>1){ console.warn(`[rate] decrease concurrency ${CONC} -> ${CONC-1}`); CONC = CONC-1; }
        await sleep(wait);
        continue;
      }

      // 5xx: retry exponentiel
      if(r.status>=500 && r.status<600){
        if(attempt < MAX_RETRIES_5XX){
          const wait = Math.round(Math.min(120000, (RETRY_BASE_MS * Math.pow(2,attempt)) + Math.random()*600));
          console.warn(`[5xx ${r.status}] ${url.pathname} — retry in ~${wait}ms (attempt ${attempt+1}/${MAX_RETRIES_5XX})`);
          if(CONC>1){ console.warn(`[rate] decrease concurrency ${CONC} -> ${CONC-1}`); CONC = CONC-1; }
          attempt++; await sleep(wait); continue;
        }
        let txt=''; try{ txt = await r.text(); }catch(_){}
        throw new Error(`HTTP ${r.status} - ${txt||r.statusText} @ ${url.pathname}${url.search}`);
      }

      // autres erreurs
      if(!r.ok){
        let txt=''; try{ txt = await r.text(); }catch(_){}
        throw new Error(`HTTP ${r.status} - ${txt||r.statusText} @ ${url.pathname}${url.search}`);
      }

      // OK
      try { return await r.json(); }
      catch(e){ throw new Error(`Invalid JSON: ${e.message}`); }
    }
  });
}

// --------- Normalisation / extraction ----------
const PLACEMENT_ALIASES = {
  front: ['front','center front','front print','front_print'],
  back:  ['back','center back','back print','back_print'],
  left:  ['left','left sleeve','left side','left_print','sleeve_left'],
  right: ['right','right sleeve','right side','right_print','sleeve_right'],
  pocket: ['pocket','front pocket','pocket_print'],
  hood: ['hood','hood print'],
  label_outside: ['label outside','outside label','outside_label'],
  label_inside:  ['label inside','inside label','inside_label'],
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
  if(/front/.test(k)) return 'front';
  if(/back/.test(k))  return 'back';
  if(/\bleft\b/.test(k)) return 'left';
  if(/\bright\b/.test(k)) return 'right';
  return k.replace(/\s+/g,'_');
}
function collectUrls(obj, currentPlacement=''){
  const out=[];
  if(!obj || typeof obj!=='object') return out;

  const directUrl = obj.image_url || obj.preview_url || obj.url || obj.image || obj.thumbnail_url;
  const placement = normPlacement(obj.placement || obj.side || currentPlacement || '');

  if (directUrl && /^https?:\/\/.+\.(png|jpg|jpeg|webp)(\?|$)/i.test(String(directUrl))){
    out.push({
      placement,
      image_url: obj.image_url || obj.url || obj.image || obj.preview_url || '',
      thumb_url: obj.thumbnail_url || '',
      angle: obj.angle || obj.view || '',
      source: obj.source || obj.type || ''
    });
  }

  for(const key of ['images','files','mockups','variants','items','options']){
    const val = obj[key];
    if(Array.isArray(val)){
      for(const it of val){ out.push(...collectUrls(it, placement)); }
    }
  }
  for(const [k,v] of Object.entries(obj)){
    if(v && typeof v==='object' && !Array.isArray(v) && k!=='parent'){
      out.push(...collectUrls(v, placement));
    }
  }
  return out;
}
function uniqBy(arr, keyFn){
  const seen = new Set(); const out=[];
  for(const it of arr){ const key=keyFn(it); if(seen.has(key)) continue; seen.add(key); out.push(it); }
  return out;
}
function toKey({product_id, variant_id, placement, image_url}, i){
  return `${product_id || 'p'}__${variant_id || 'v'}__${placement || 'any'}__${i}`;
}

// --------- API wrappers (catalog public) ----------
async function listCatalogProductIdsFromAPI(){
  let offset=0;
  let total=Infinity;
  const ids=[];
  console.log(`Images (catalog) — PAGE_LIMIT=${PAGE_LIMIT}, INIT_CONC=${CONC}`);

  while(offset < total){
    const j = await getJSON('/catalog/products', { limit: PAGE_LIMIT, offset });
    const items = j?.result?.items || j?.result || [];
    if(!Array.isArray(items)) throw new Error('Invalid products list payload (/catalog/products)');

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
  console.log(`Found ${ids.length} catalog products (API)`);
  return ids;
}
async function fetchProductDetails(pid){
  const j = await getJSON(`/catalog/products/${pid}`);
  return j?.result || j?.product || j || {};
}
async function fetchProductVariants(pid){
  const j = await getJSON(`/catalog/variants`, { product_id: pid, limit: 100, offset: 0 });
  const items = j?.result?.items || j?.result?.variants || j?.variants || j?.result || [];
  return Array.isArray(items) ? items : [];
}

// --------- Fallbacks (CSV/local) ----------
async function loadProductIdsFallback(){
  // 1) PRODUCT_IDS env
  if(PRODUCT_IDS_ENV){
    const ids = PRODUCT_IDS_ENV.split(',').map(s=>Number(String(s).trim())).filter(n=>Number.isFinite(n)&&n>0);
    if(ids.length){ console.log(`Using PRODUCT_IDS env (${ids.length} ids)`); return ids; }
  }
  // 2) CSV local (data/products.csv par défaut)
  if(await exists(FALLBACK_PRODUCTS_CSV)){
    console.warn(`[fallback] Listing via ${FALLBACK_PRODUCTS_CSV}`);
    const raw = await fs.readFile(FALLBACK_PRODUCTS_CSV,'utf8');
    const lines = raw.split(/\r?\n/).filter(Boolean);
    const header = lines[0].split(',');
    const idxId = header.findIndex(h=>/^id$|^product_id$/i.test(h.trim()));
    const ids=new Set();
    for(let i=1;i<lines.length;i++){
      const cols = parseCsvLine(lines[i]);
      const v = cols[idxId]||'';
      const n = Number(String(v).trim());
      if(Number.isFinite(n)&&n>0) ids.add(n);
    }
    const out = Array.from(ids);
    console.log(`Found ${out.length} product ids in fallback CSV`);
    return out;
  }
  console.warn('[fallback] No PRODUCT_IDS and no CSV found — nothing to do.');
  return [];
}
function parseCsvLine(line){
  // simple parser for commas + quotes
  const res=[]; let cur=''; let inQ=false;
  for(let i=0;i<line.length;i++){
    const ch=line[i];
    if(inQ){
      if(ch === '"'){
        if(line[i+1] === '"'){ cur+='"'; i++; }
        else { inQ=false; }
      }else{ cur+=ch; }
    }else{
      if(ch === ','){ res.push(cur); cur=''; }
      else if(ch === '"'){ inQ=true; }
      else{ cur+=ch; }
    }
  }
  res.push(cur);
  return res;
}

// --------- Main ----------
(async function main(){
  try{
    let productIds = [];
    // 1) essayer API
    try{
      productIds = await listCatalogProductIdsFromAPI();
    }catch(e){
      console.warn(`[catalog list via API failed] ${e.message}`);
      productIds = await loadProductIdsFallback();
      if(!productIds.length) throw e; // rethrow si aucun fallback
    }

    // Sécurité: dédupe & tri
    productIds = Array.from(new Set(productIds.map(n=>Number(n)).filter(n=>Number.isFinite(n)&&n>0))).sort((a,b)=>a-b);
    console.log(`Processing ${productIds.length} product ids`);

    const outRows=[];
    let scanned=0;

    const tasks = productIds.map(pid => withGate(async ()=>{
      try{
        const detail = await fetchProductDetails(pid);
        const product = detail.product || detail;

        const prodImgs = uniqBy(
          collectUrls(product)
            .map(x=>({ ...x, placement: normPlacement(x.placement), product_id: pid, variant_id: '' }))
            .filter(x=>x.image_url),
          x=>x.image_url
        );

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
        const merged = uniqBy([...prodImgs, ...varImgsUniq], x=>`${x.product_id}::${x.variant_id}::${x.image_url}`);

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
      }catch(err){
        console.warn(`[product ${pid}] ${err.message}`);
      }finally{
        scanned++;
        if(scanned % 20 === 0){
          console.log(`...processed ${scanned}/${productIds.length} products (rows=${outRows.length}) | conc=${CONC}, active=${active}`);
        }
      }
    }));

    await Promise.all(tasks);

    outRows.sort((a,b)=>{
      if(a.product_id!==b.product_id) return Number(a.product_id)-Number(b.product_id);
      if(a.placement!==b.placement) return String(a.placement).localeCompare(String(b.placement));
      return String(a.variant_id||'').localeCompare(String(b.variant_id||''));
    });

    const outPath = path.join('data','product_images_by_placement.csv');
    if(STRICT && outRows.length===0){
      console.warn('No rows produced — failing (STRICT=true)');
      process.exit(1);
    }
    await writeCSV(outRows, outPath);

    console.log('=== IMAGES SUMMARY ===');
    console.log(`Finished: ${now()}`);
    console.log(`Rows:     ${outRows.length}`);
    console.log(`Products: ${productIds.length}`);
  }catch(e){
    console.error('IMAGES failed:', e.message);
    process.exit(1);
  }
})();

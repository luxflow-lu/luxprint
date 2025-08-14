// api/export.js — Single route: HTML admin + CSV per table + ZIP pack
import JSZip from 'jszip';

const API_BASE = 'https://api.printful.com';
const DEFAULT_REGION = process.env.DEFAULT_REGION || 'europe';

function wait(ms){ return new Promise(r=>setTimeout(r,ms)); }
function csvEscape(val){ if(val==null) return ''; const s=String(val); return /[",\n]/.test(s)?`"${s.replace(/"/g,'""')}"`:s; }
function buildCSVString(rows, headerOrder=null){
  const headers = headerOrder || (rows?.[0] ? Object.keys(rows[0]) : []);
  const lines = [headers.map(csvEscape).join(',')];
  for(const row of rows||[]) lines.push(headers.map(h => csvEscape(row[h] ?? '')).join(','));
  return lines.join('\n');
}
function normStr(x){ return (x??'').toString().trim(); }
function toBool(x){ return !!x; }

async function getJSON(url, { retry=5, backoff=800 } = {}) {
  const TOKEN = process.env.PRINTFUL_TOKEN;
  if (!TOKEN) throw new Error('PRINTFUL_TOKEN manquant (Vercel → Env Vars)');
  for (let a=1;a<=retry;a++){
    const r = await fetch(url, { headers:{ Authorization:`Bearer ${TOKEN}` } }).catch(()=>null);
    if (!r){ if(a===retry) throw new Error('Fetch échoué'); await wait(backoff*a); continue; }
    if (r.status===429 || (r.status>=500 && r.status<=599)){
      const ra = Number(r.headers.get('retry-after')) || backoff*a;
      if(a===retry) throw new Error(`HTTP ${r.status} ${url}`);
      await wait(ra); continue;
    }
    if(!r.ok){ const t=await r.text().catch(()=> ''); throw new Error(`HTTP ${r.status} ${url} :: ${t}`); }
    return r.json();
  }
}

async function listAllProducts({ region, dest, max=200 }){
  const params = new URLSearchParams();
  if (dest) params.set('destination_country', dest);
  else if (region) params.set('selling_region_name', region);
  params.set('limit','200');
  let offset=0, all=[];
  while(true){
    params.set('offset', String(offset));
    const j = await getJSON(`${API_BASE}/v2/catalog-products?${params.toString()}`);
    const data = j?.result || j?.data || j || {};
    const list = data.items || data.products || data || [];
    if (!Array.isArray(list) || !list.length) break;
    for (const it of list){
      all.push(it);
      if (max && all.length >= max) return all;
    }
    offset += list.length;
    if (data.total && offset>=data.total) break;
    if (list.length<200) break;
  }
  return all;
}

// ---- Pullers per table (to avoid pulling everything for HTML) ----
async function pullCountries(){
  const out=[];
  try{
    const cj = await getJSON(`${API_BASE}/v2/countries`);
    const list = cj?.result || cj?.data || cj || [];
    for (const c of (list.items || list)){
      out.push({ code: c?.code||'', name: c?.name||'' });
    }
  }catch(_){}
  return out;
}

async function pullProducts({ region, dest, max }){
  const rows=[];
  const base = await listAllProducts({ region, dest, max });
  for (const p of base){
    const pid = p?.id || p?.product_id; if(!pid) continue;
    let pd = p;
    try{ const r=await getJSON(`${API_BASE}/v2/catalog-products/${pid}`); pd=r?.result||r?.data||r||pd; }catch(_){}
    rows.push({
      product_id: pid,
      main_category_id: pd.main_category_id ?? '',
      type: String(pd.type ?? ''),
      name: String(pd.name ?? ''),
      brand: String(pd.brand ?? ''),
      model: String(pd.model ?? ''),
      image_hero: String(pd.image ?? ''),
      variant_count: pd.variant_count ?? '',
      is_discontinued: String(!!pd.is_discontinued),
      description: String(pd.description ?? ''),
      sizes_list: JSON.stringify(pd.sizes || []),
      colors_list: JSON.stringify(pd.colors || []),
      techniques: JSON.stringify(pd.techniques || []),
      placements_schema: JSON.stringify(pd.placements || pd.available_placements || []),
      product_options: JSON.stringify(pd.product_options || []),
      _links_self: pd?._links?.self?.href || '',
      _links_variants: pd?._links?.variants?.href || '',
      _links_categories: pd?._links?.categories?.href || '',
      _links_prices: pd?._links?.product_prices?.href || '',
      _links_sizes: pd?._links?.product_sizes?.href || '',
      _links_images: pd?._links?.product_images?.href || '',
      _links_availability: pd?._links?.availability?.href || ''
    });
  }
  return rows;
}

async function pullCategoriesAndJoinsForProducts({ region, dest, max }){
  const products = await listAllProducts({ region, dest, max });
  const cats = new Map();
  const joins = [];
  for(const p of products){
    const pid = p?.id || p?.product_id; if(!pid) continue;
    try{
      const r = await getJSON(`${API_BASE}/v2/catalog-products/${pid}/catalog-categories`);
      const arr = r?.result || r?.data || r || [];
      for(const it of (arr.items || arr)){
        const cid = it?.id; if(!cid) continue;
        const row = { category_id: cid, name: String(it?.name||''), parent_id: it?.parent_id ?? '' };
        if(!cats.has(String(cid))) cats.set(String(cid), row);
        joins.push({ product_id: pid, category_id: cid });
      }
    }catch(_){}
  }
  return { categories: Array.from(cats.values()), product_categories: joins };
}

async function pullProductImages({ region, dest, max }){
  const rows=[];
  const products = await listAllProducts({ region, dest, max });
  for (const p of products){
    const pid = p?.id || p?.product_id; if(!pid) continue;
    try{
      const r = await getJSON(`${API_BASE}/v2/catalog-products/${pid}/images`);
      const arr = r?.result || r?.data || r || [];
      for(const im of (arr.items || arr)){
        rows.push({ product_id: pid, image_url: String(im?.image||im?.url||''), color: String(im?.color||''), is_default: String(!!im?.is_default) });
      }
    }catch(_){}
  }
  return rows;
}

async function pullSizes({ region, dest, max }){
  const rows=[];
  const products = await listAllProducts({ region, dest, max });
  for (const p of products){
    const pid = p?.id || p?.product_id; if(!pid) continue;
    try{
      const r = await getJSON(`${API_BASE}/v2/catalog-products/${pid}/sizes`);
      const arr = r?.result || r?.data || r || [];
      for(const s of (arr.items || arr)){
        rows.push({ product_id: pid, size_code: String(s?.size_code||s?.size||''), measurements_json: JSON.stringify(s?.measurements||s?.table||{}), units: String(s?.units||'') });
      }
    }catch(_){}
  }
  return rows;
}

async function pullVariants({ region, dest, max }){
  const rows=[];
  const products = await listAllProducts({ region, dest, max });
  for (const p of products){
    const pid = p?.id || p?.product_id; if(!pid) continue;
    let vlist=[];
    try{
      const r = await getJSON(`${API_BASE}/v2/catalog-products/${pid}/catalog-variants`);
      vlist = (r?.result || r?.data || r || []);
      vlist = vlist.items || vlist || [];
    }catch(_){ vlist=[]; }
    for(const v of vlist){
      const vid = v?.id; if(!vid) continue;
      let vd=v;
      try{ const d=await getJSON(`${API_BASE}/v2/catalog-variants/${vid}`); vd=d?.result||d?.data||d||vd; }catch(_){}
      rows.push({
        catalog_variant_id: vid,
        catalog_product_id: pid,
        name: String(vd?.name||v?.name||''),
        size: String(vd?.size||v?.size||''),
        color: String(vd?.color||v?.color||''),
        color_code: String(vd?.color_code||v?.color_code||''),
        color_code2: String(vd?.color_code2||v?.color_code2||''),
        image_main: String(vd?.image||v?.image||''),
        placement_dimensions: JSON.stringify(vd?.placement_dimensions||v?.placement_dimensions||[]),
        _links_self: vd?._links?.self?.href || '',
        _links_variant_prices: vd?._links?.variant_prices?.href || '',
        _links_variant_images: vd?._links?.variant_images?.href || '',
        _links_variant_availability: vd?._links?.variant_availability?.href || ''
      });
    }
  }
  return rows;
}

async function pullVariantImages({ region, dest, max }){
  const rows=[];
  const variants = await pullVariants({ region, dest, max });
  for(const v of variants){
    const vid = v.catalog_variant_id;
    try{
      const r = await getJSON(`${API_BASE}/v2/catalog-variants/${vid}/images`);
      const arr = r?.result || r?.data || r || [];
      for(const im of (arr.items || arr)){
        rows.push({ catalog_variant_id: vid, image_url: String(im?.image||im?.url||''), angle: String(im?.angle||''), color: String(im?.color||''), is_default: String(!!im?.is_default) });
      }
    }catch(_){}
  }
  return rows;
}

async function pullPrices({ region, dest, max }){
  const rows=[];
  const variants = await pullVariants({ region, dest, max });
  // Variant prices
  for(const v of variants){
    const vid = v.catalog_variant_id;
    try{
      const base = `${API_BASE}/v2/catalog-variants/${vid}/variant_prices`;
      const u = new URL(base);
      if (region) u.searchParams.set('region', region);
      const r = await getJSON(u.toString());
      const arr = r?.result || r?.data || r || [];
      for(const pr of (arr.items || arr)){
        rows.push({ product_id: v.catalog_product_id, variant_id: vid, currency: String(pr?.currency||''), retail_price: String(pr?.retail_price||''), region: String(pr?.region||region||'') });
      }
    }catch(_){}
  }
  // Optional: product-level prices could be added too if needed.
  return rows;
}

async function pullAvailability({ region, dest, max }){
  const rows=[];
  const variants = await pullVariants({ region, dest, max });
  for(const v of variants){
    const vid = v.catalog_variant_id;
    try{
      const r = await getJSON(`${API_BASE}/v2/catalog-variants/${vid}/availability`);
      const items = r?.result || r?.data || r || [];
      const arr = items?.items || items;
      const list = Array.isArray(arr) ? arr : [arr];
      for(const a of list){
        rows.push({
          catalog_variant_id: vid,
          selling_region_name: String(a?.selling_region_name || region || ''),
          available: String(!!(a?.available ?? a?.in_stock)),
          stock: typeof a?.stock==='number' ? a.stock : '',
          warehouses_json: JSON.stringify(a?.warehouses || a?.locations || {})
        });
      }
    }catch(_){}
  }
  return rows;
}

// --------- Handler ---------
export default async function handler(req, res){
  try{
    // basic params
    const region = (req.query.region || DEFAULT_REGION).toString();
    const dest   = (req.query.dest || '').toString(); // ex FR
    const max    = Number(req.query.max || 200);       // cap products to avoid timeouts on Hobby
    const dl     = (req.query.download || '').toString(); // '', 'zip', 'products', etc.

    // HTML admin: DON'T PULL DATA HERE (avoid timeouts)
    if (!dl){
      const base = req.url.replace(/\/api\/export.*/,'/api/export');
      res.setHeader('Content-Type','text/html; charset=utf-8');
      res.status(200).send(`<!doctype html>
<html><head><meta charset="utf-8"><title>LuxPrint Export</title>
<style>
body{font-family:ui-sans-serif,system-ui,Segoe UI,Roboto,Helvetica,Arial,sans-serif;padding:24px}
h1{font-size:20px;margin:0 0 12px}
.grid{display:grid;gap:8px;grid-template-columns:repeat(auto-fit,minmax(260px,1fr))}
.card{border:1px solid #e5e7eb;border-radius:12px;padding:12px}
a.btn{display:inline-block;padding:8px 12px;border:1px solid #111;border-radius:8px;text-decoration:none}
small{color:#6b7280}
label{display:inline-block;margin:0 8px 0 0}
</style></head>
<body>
<h1>LuxPrint — Export CSV Webflow</h1>
<p><small>Filtre: ${dest?`destination_country=${dest}`:`selling_region_name=${region}`} — cap: max=${max} produits</small></p>
<div class="grid">
  <div class="card"><b>Pack ZIP (tout)</b><br>
    <a class="btn" href="${base}?${dest?`dest=${dest}`:`region=${region}`}&max=${max}&download=zip">Télécharger</a>
  </div>
  <div class="card"><b>Produits</b><br>
    <a class="btn" href="${base}?${dest?`dest=${dest}`:`region=${region}`}&max=${max}&download=products">Télécharger</a>
  </div>
  <div class="card"><b>Variantes</b><br>
    <a class="btn" href="${base}?${dest?`dest=${dest}`:`region=${region}`}&max=${max}&download=variants">Télécharger</a>
  </div>
  <div class="card"><b>Catégories</b><br>
    <a class="btn" href="${base}?${dest?`dest=${dest}`:`region=${region}`}&max=${max}&download=categories">Télécharger</a>
  </div>
  <div class="card"><b>Relations Produit↔Catégorie</b><br>
    <a class="btn" href="${base}?${dest?`dest=${dest}`:`region=${region}`}&max=${max}&download=product_categories">Télécharger</a>
  </div>
  <div class="card"><b>Images Produit</b><br>
    <a class="btn" href="${base}?${dest?`dest=${dest}`:`region=${region}`}&max=${max}&download=product_images">Télécharger</a>
  </div>
  <div class="card"><b>Images Variante</b><br>
    <a class="btn" href="${base}?${dest?`dest=${dest}`:`region=${region}`}&max=${max}&download=variant_images">Télécharger</a>
  </div>
  <div class="card"><b>Tailles</b><br>
    <a class="btn" href="${base}?${dest?`dest=${dest}`:`region=${region}`}&max=${max}&download=sizes">Télécharger</a>
  </div>
  <div class="card"><b>Prix (variante)</b><br>
    <a class="btn" href="${base}?${dest?`dest=${dest}`:`region=${region}`}&max=${max}&download=prices">Télécharger</a>
  </div>
  <div class="card"><b>Disponibilités (variante)</b><br>
    <a class="btn" href="${base}?${dest?`dest=${dest}`:`region=${region}`}&max=${max}&download=availability">Télécharger</a>
  </div>
  <div class="card"><b>Pays</b><br>
    <a class="btn" href="${base}?download=countries">Télécharger</a>
  </div>
</div>
<p><small>Astuce: commence avec <code>?dest=FR&max=100</code> pour rester sous la limite de 10s, puis augmente.</small></p>
</body></html>`);
      return;
    }

    // Build data only for what is requested
    const headerMap = {
      products: ['product_id','main_category_id','type','name','brand','model','image_hero','variant_count','is_discontinued','description','sizes_list','colors_list','techniques','placements_schema','product_options','_links_self','_links_variants','_links_categories','_links_prices','_links_sizes','_links_images','_links_availability'],
      variants: ['catalog_variant_id','catalog_product_id','name','size','color','color_code','color_code2','image_main','placement_dimensions','_links_self','_links_variant_prices','_links_variant_images','_links_variant_availability'],
      categories: ['category_id','name','parent_id'],
      product_categories: ['product_id','category_id'],
      product_images: ['product_id','image_url','color','is_default'],
      variant_images: ['catalog_variant_id','image_url','angle','color','is_default'],
      sizes: ['product_id','size_code','measurements_json','units'],
      prices: ['product_id','variant_id','currency','retail_price','region'],
      availability: ['catalog_variant_id','selling_region_name','available','stock','warehouses_json'],
      countries: ['code','name']
    };

    async function buildTable(name){
      switch(name){
        case 'products':           return await pullProducts({ region, dest, max });
        case 'variants':           return await pullVariants({ region, dest, max });
        case 'categories':         return (await pullCategoriesAndJoinsForProducts({ region, dest, max })).categories;
        case 'product_categories': return (await pullCategoriesAndJoinsForProducts({ region, dest, max })).product_categories;
        case 'product_images':     return await pullProductImages({ region, dest, max });
        case 'variant_images':     return await pullVariantImages({ region, dest, max });
        case 'sizes':              return await pullSizes({ region, dest, max });
        case 'prices':             return await pullPrices({ region, dest, max });
        case 'availability':       return await pullAvailability({ region, dest, max });
        case 'countries':          return await pullCountries();
        default: return [];
      }
    }

    if (dl === 'zip'){
      // build each table sequentially to keep within time/memory
      const zip = new JSZip();
      for (const name of Object.keys(headerMap)){
        const rows = await buildTable(name);
        const csv = buildCSVString(rows, headerMap[name]);
        zip.file(`${name}.csv`, csv ?? '');
      }
      const blob = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
      res.status(200);
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', `attachment; filename="luxprint_export_${dest || region}_${max}.zip"`);
      res.send(blob);
      return;
    }

    if (!headerMap[dl]){ res.status(400).send('download param invalide'); return; }

    const rows = await buildTable(dl);
    const csv  = buildCSVString(rows, headerMap[dl]);
    res.status(200);
    res.setHeader('Content-Type','text/csv; charset=utf-8');
    res.setHeader('Content-Disposition',`attachment; filename="${dl}.csv"`);
    res.send(csv);
  }catch(e){
    res.status(500).send(`Error: ${e.message}`);
  }
}

Verify Production env has PRINTFUL_TO

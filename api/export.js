// api/export.js
// Single serverless function for: HTML admin + CSVs + ZIP (Vercel Hobby friendly)

import JSZip from 'jszip';

// ---------- CONFIG ----------
const API_BASE = 'https://api.printful.com';
const DEFAULT_REGION = process.env.DEFAULT_REGION || 'europe';

// ---------- UTILS ----------
function wait(ms){ return new Promise(r=>setTimeout(r,ms)); }
function csvEscape(val){
  if (val===null || val===undefined) return '';
  const s=String(val);
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g,'""')}"`;
  return s;
}
function buildCSVString(rows, headerOrder=null){
  if (!rows || rows.length===0) return '';
  const headers = headerOrder || Array.from(rows.reduce((set,row)=>{ Object.keys(row).forEach(k=>set.add(k)); return set; }, new Set()));
  const lines = [];
  lines.push(headers.map(csvEscape).join(','));
  for (const row of rows){
    const line = headers.map(h => csvEscape(row[h] ?? '')).join(',');
    lines.push(line);
  }
  return lines.join('\n');
}
function normStr(x){ return (x??'').toString().trim(); }
function toBool(x){ return !!x; }

async function getJSON(url, { retry=5, backoff=800 } = {}) {
  const TOKEN = process.env.PRINTFUL_TOKEN;
  if (!TOKEN) throw new Error('PRINTFUL_TOKEN manquant');
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

// ---------- DATA PULL (tout-en-un) ----------
async function listAllProducts({ region, dest }){
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
    all = all.concat(list);
    offset += list.length;
    if (data.total && offset>=data.total) break;
    if (list.length<200) break;
  }
  return all;
}

async function pullAll({ region=DEFAULT_REGION, dest=null } = {}){
  const products = [];
  const variants = [];
  const cats = new Map();
  const product_categories = [];
  const product_images = [];
  const variant_images = [];
  const sizes = [];
  const prices = [];
  const availability = [];
  const countries = [];

  // Countries
  try{
    const cj = await getJSON(`${API_BASE}/v2/countries`);
    const list = cj?.result || cj?.data || cj || [];
    for (const c of (list.items || list)){
      countries.push({ code: c?.code||'', name: c?.name||'' });
    }
  }catch(_){}

  const base = await listAllProducts({ region, dest });

  for (const p of base){
    const pid = p?.id || p?.product_id; if(!pid) continue;

    // Détails produit
    let pd=null;
    try{
      const r = await getJSON(`${API_BASE}/v2/catalog-products/${pid}`);
      pd = r?.result || r?.data || r || {};
    }catch(_){ pd=p; }

    products.push({
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

    // Catégories
    try{
      const cj = pd?._links?.categories?.href
        ? await getJSON(pd._links.categories.href)
        : await getJSON(`${API_BASE}/v2/catalog-products/${pid}/catalog-categories`);
      const arr = cj?.result || cj?.data || cj || [];
      for (const c of (arr.items || arr)){
        const cid = c?.id; if(!cid) continue;
        const row = { category_id: cid, name: String(c?.name||''), parent_id: c?.parent_id ?? '' };
        if (!cats.has(String(cid))) cats.set(String(cid), row);
        product_categories.push({ product_id: pid, category_id: cid });
      }
    }catch(_){}

    // Images produit
    try{
      const ij = pd?._links?.product_images?.href
        ? await getJSON(pd._links.product_images.href)
        : await getJSON(`${API_BASE}/v2/catalog-products/${pid}/images`);
      const arr = ij?.result || ij?.data || ij || [];
      for (const im of (arr.items || arr)){
        product_images.push({
          product_id: pid,
          image_url: String(im?.image || im?.url || ''),
          color: String(im?.color || ''),
          is_default: String(!!im?.is_default)
        });
      }
    }catch(_){}

    // Tailles
    try{
      const sj = pd?._links?.product_sizes?.href
        ? await getJSON(pd._links.product_sizes.href)
        : await getJSON(`${API_BASE}/v2/catalog-products/${pid}/sizes`);
      const arr = sj?.result || sj?.data || sj || [];
      for (const s of (arr.items || arr)){
        sizes.push({
          product_id: pid,
          size_code: String(s?.size_code || s?.size || ''),
          measurements_json: JSON.stringify(s?.measurements || s?.table || {}),
          units: String(s?.units || '')
        });
      }
    }catch(_){}

    // Prix produit
    try{
      if (pd?._links?.product_prices?.href){
        const u = new URL(pd._links.product_prices.href);
        if (region) u.searchParams.set('region', region);
        const prj = await getJSON(u.toString());
        const arr = prj?.result || prj?.data || prj || [];
        for (const pr of (arr.items || arr)){
          prices.push({
            product_id: pid, variant_id: '',
            currency: String(pr?.currency || ''),
            retail_price: String(pr?.retail_price || ''),
            region: String(pr?.region || region || '')
          });
        }
      }
    }catch(_){}

    // Variantes
    let vlist=[];
    try{
      const vj = await getJSON(`${API_BASE}/v2/catalog-products/${pid}/catalog-variants`);
      vlist = (vj?.result || vj?.data || vj || []);
      vlist = vlist.items || vlist;
    }catch(_){ vlist=[]; }

    for (const v of vlist){
      const vid = v?.id; if(!vid) continue;

      let vd=v;
      try{
        const d = await getJSON(`${API_BASE}/v2/catalog-variants/${vid}`);
        vd = d?.result || d?.data || d || vd;
      }catch(_){}

      variants.push({
        catalog_variant_id: vid,
        catalog_product_id: pid,
        name: String(vd?.name || v?.name || ''),
        size: String(vd?.size || v?.size || ''),
        color: String(vd?.color || v?.color || ''),
        color_code: String(vd?.color_code || v?.color_code || ''),
        color_code2: String(vd?.color_code2 || v?.color_code2 || ''),
        image_main: String(vd?.image || v?.image || ''),
        placement_dimensions: JSON.stringify(vd?.placement_dimensions || v?.placement_dimensions || []),
        _links_self: vd?._links?.self?.href || '',
        _links_variant_prices: vd?._links?.variant_prices?.href || '',
        _links_variant_images: vd?._links?.variant_images?.href || '',
        _links_variant_availability: vd?._links?.variant_availability?.href || ''
      });

      // Images variante
      try{
        const iv = vd?._links?.variant_images?.href
          ? await getJSON(vd._links.variant_images.href)
          : await getJSON(`${API_BASE}/v2/catalog-variants/${vid}/images`);
        const arr = iv?.result || iv?.data || iv || [];
        for (const im of (arr.items || arr)){
          variant_images.push({
            catalog_variant_id: vid,
            image_url: String(im?.image || im?.url || ''),
            angle: String(im?.angle || ''),
            color: String(im?.color || ''),
            is_default: String(!!im?.is_default)
          });
        }
      }catch(_){}

      // Prix variante
      try{
        const base = vd?._links?.variant_prices?.href || `${API_BASE}/v2/catalog-variants/${vid}/variant_prices`;
        const u = new URL(base);
        if (region) u.searchParams.set('region', region);
        const pv = await getJSON(u.toString());
        const arr = pv?.result || pv?.data || pv || [];
        for (const pr of (arr.items || arr)){
          prices.push({
            product_id: pid, variant_id: vid,
            currency: String(pr?.currency || ''),
            retail_price: String(pr?.retail_price || ''),
            region: String(pr?.region || region || '')
          });
        }
      }catch(_){}

      // Disponibilité variante
      try{
        const av = vd?._links?.variant_availability?.href
          ? await getJSON(vd._links.variant_availability.href)
          : await getJSON(`${API_BASE}/v2/catalog-variants/${vid}/availability`);
        const items = av?.result || av?.data || av || [];
        const arr = items?.items || items;
        const list = Array.isArray(arr) ? arr : [arr];
        for (const a of list){
          availability.push({
            catalog_variant_id: vid,
            selling_region_name: String(a?.selling_region_name || region || ''),
            available: String(!!(a?.available ?? a?.in_stock)),
            stock: typeof a?.stock==='number' ? a.stock : '',
            warehouses_json: JSON.stringify(a?.warehouses || a?.locations || {})
          });
        }
      }catch(_){}
    }
  }

  return {
    products,
    categories: Array.from(cats.values()),
    product_categories,
    variants,
    product_images,
    variant_images,
    sizes,
    prices,
    availability,
    countries
  };
}

// ---------- HANDLER ----------
export default async function handler(req, res){
  try{
    const TOKEN = process.env.PRINTFUL_TOKEN;
    if (!TOKEN) {
      res.status(500).send('PRINTFUL_TOKEN manquant dans Vercel → Settings → Environment Variables');
      return;
    }

    const region = req.query.region || DEFAULT_REGION;
    const dest   = req.query.dest || ''; // ex: FR
    const download = (req.query.download || '').toString(); // '', 'products', 'zip', etc.

    // Pull all once (caching possible si besoin)
    const data = await pullAll({ region, dest: dest || null });

    // ZIP?
    if (download === 'zip'){
      const zip = new JSZip();

      const files = [
        ['products.csv', data.products, [
          'product_id','main_category_id','type','name','brand','model','image_hero','variant_count','is_discontinued','description',
          'sizes_list','colors_list','techniques','placements_schema','product_options',
          '_links_self','_links_variants','_links_categories','_links_prices','_links_sizes','_links_images','_links_availability'
        ]],
        ['variants.csv', data.variants, [
          'catalog_variant_id','catalog_product_id','name','size','color','color_code','color_code2','image_main','placement_dimensions',
          '_links_self','_links_variant_prices','_links_variant_images','_links_variant_availability'
        ]],
        ['categories.csv', data.categories, ['category_id','name','parent_id']],
        ['product_categories.csv', data.product_categories, ['product_id','category_id']],
        ['product_images.csv', data.product_images, ['product_id','image_url','color','is_default']],
        ['variant_images.csv', data.variant_images, ['catalog_variant_id','image_url','angle','color','is_default']],
        ['sizes.csv', data.sizes, ['product_id','size_code','measurements_json','units']],
        ['prices.csv', data.prices, ['product_id','variant_id','currency','retail_price','region']],
        ['availability.csv', data.availability, ['catalog_variant_id','selling_region_name','available','stock','warehouses_json']],
        ['countries.csv', data.countries, ['code','name']]
      ];

      for (const [name, rows, headers] of files){
        const csv = buildCSVString(rows, headers);
        zip.file(name, csv ?? '');
      }

      const blob = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
      res.status(200);
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', `attachment; filename="luxprint_export_${dest || region}.zip"`);
      res.send(blob);
      return;
    }

    // CSV one-by-one?
    const tableMap = {
      products:        { rows: data.products, headers: ['product_id','main_category_id','type','name','brand','model','image_hero','variant_count','is_discontinued','description','sizes_list','colors_list','techniques','placements_schema','product_options','_links_self','_links_variants','_links_categories','_links_prices','_links_sizes','_links_images','_links_availability'] },
      variants:        { rows: data.variants, headers: ['catalog_variant_id','catalog_product_id','name','size','color','color_code','color_code2','image_main','placement_dimensions','_links_self','_links_variant_prices','_links_variant_images','_links_variant_availability'] },
      categories:      { rows: data.categories, headers: ['category_id','name','parent_id'] },
      product_categories: { rows: data.product_categories, headers: ['product_id','category_id'] },
      product_images:  { rows: data.product_images, headers: ['product_id','image_url','color','is_default'] },
      variant_images:  { rows: data.variant_images, headers: ['catalog_variant_id','image_url','angle','color','is_default'] },
      sizes:           { rows: data.sizes, headers: ['product_id','size_code','measurements_json','units'] },
      prices:          { rows: data.prices, headers: ['product_id','variant_id','currency','retail_price','region'] },
      availability:    { rows: data.availability, headers: ['catalog_variant_id','selling_region_name','available','stock','warehouses_json'] },
      countries:       { rows: data.countries, headers: ['code','name'] }
    };

    if (download && tableMap[download]){
      const { rows, headers } = tableMap[download];
      const body = buildCSVString(rows, headers);
      res.status(200);
      res.setHeader('Content-Type','text/csv; charset=utf-8');
      res.setHeader('Content-Disposition',`attachment; filename="${download}.csv"`);
      res.send(body);
      return;
    }

    // HTML admin (default)
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
</style></head>
<body>
<h1>LuxPrint — Export CSV Webflow</h1>
<p><small>Filtre: ${dest?`destination_country=${dest}`:`selling_region_name=${region}`}</small></p>
<div class="grid">
  <div class="card"><b>Pack ZIP (tout)</b><br><a class="btn" href="${base}?${dest?`dest=${dest}`:`region=${region}`}&download=zip">Télécharger</a></div>
  <div class="card"><b>Produits</b><br><a class="btn" href="${base}?${dest?`dest=${dest}`:`region=${region}`}&download=products">Télécharger</a></div>
  <div class="card"><b>Variantes</b><br><a class="btn" href="${base}?${dest?`dest=${dest}`:`region=${region}`}&download=variants">Télécharger</a></div>
  <div class="card"><b>Catégories</b><br><a class="btn" href="${base}?${dest?`dest=${dest}`:`region=${region}`}&download=categories">Télécharger</a></div>
  <div class="card"><b>Relations Produit↔Catégorie</b><br><a class="btn" href="${base}?${dest?`dest=${dest}`:`region=${region}`}&download=product_categories">Télécharger</a></div>
  <div class="card"><b>Images Produit</b><br><a class="btn" href="${base}?${dest?`dest=${dest}`:`region=${region}`}&download=product_images">Télécharger</a></div>
  <div class="card"><b>Images Variante</b><br><a class="btn" href="${base}?${dest?`dest=${dest}`:`region=${region}`}&download=variant_images">Télécharger</a></div>
  <div class="card"><b>Tailles</b><br><a class="btn" href="${base}?${dest?`dest=${dest}`:`region=${region}`}&download=sizes">Télécharger</a></div>
  <div class="card"><b>Prix</b><br><a class="btn" href="${base}?${dest?`dest=${dest}`:`region=${region}`}&download=prices">Télécharger</a></div>
  <div class="card"><b>Disponibilités</b><br><a class="btn" href="${base}?${dest?`dest=${dest}`:`region=${region}`}&download=availability">Télécharger</a></div>
  <div class="card"><b>Pays</b><br><a class="btn" href="${base}?download=countries">Télécharger</a></div>
</div>
</body></html>`);
  }catch(e){
    res.status(500).send(`Error: ${e.message}`);
  }
}

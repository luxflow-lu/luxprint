import { API_BASE, getJSON } from './_utils.js';

// liste paginée des produits (filtre region/destination)
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

export async function pullAll({ region='europe', dest=null }={}){
  const products = [];
  const variants = [];
  const cats = new Map(); // dedup
  const joins = [];
  const pImgs = [];
  const vImgs = [];
  const sizes = [];
  const prices = [];
  const avail = [];
  const countries = [];

  // pays
  try{
    const cj = await getJSON(`${API_BASE}/v2/countries`);
    const items = cj?.result || cj?.data || cj || [];
    for (const c of (items.items||items)){
      countries.push({ code: c.code||'', name: c.name||'' });
    }
  }catch(_){}

  const base = await listAllProducts({ region, dest });

  for (const p of base){
    const pid = p?.id || p?.product_id; if(!pid) continue;

    // details produit
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

    // catégories
    try{
      const c = pd?._links?.categories?.href
        ? await getJSON(pd._links.categories.href)
        : await getJSON(`${API_BASE}/v2/catalog-products/${pid}/catalog-categories`);
      const arr = c?.result || c?.data || c || [];
      for (const it of (arr.items || arr)){
        const cid = it?.id; if(!cid) continue;
        const row = { category_id: cid, name: String(it?.name||''), parent_id: it?.parent_id ?? '' };
        if(!cats.has(String(cid))) cats.set(String(cid), row);
        joins.push({ product_id: pid, category_id: cid });
      }
    }catch(_){}

    // images produit
    try{
      const im = pd?._links?.product_images?.href
        ? await getJSON(pd._links.product_images.href)
        : await getJSON(`${API_BASE}/v2/catalog-products/${pid}/images`);
      const arr = im?.result || im?.data || im || [];
      for (const x of (arr.items || arr)){
        pImgs.push({
          product_id: pid,
          image_url: String(x?.image || x?.url || ''),
          color: String(x?.color || ''),
          is_default: String(!!x?.is_default)
        });
      }
    }catch(_){}

    // tailles
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

    // prix produit (si exposé)
    try{
      if (pd?._links?.product_prices?.href){
        const u = new URL(pd._links.product_prices.href);
        if (region) u.searchParams.set('region', region);
        const pr = await getJSON(u.toString());
        const arr = pr?.result || pr?.data || pr || [];
        for (const r of (arr.items || arr)){
          prices.push({
            product_id: pid, variant_id: '',
            currency: String(r?.currency || ''),
            retail_price: String(r?.retail_price || ''),
            region: String(r?.region || region || '')
          });
        }
      }
    }catch(_){}

    // variantes
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

      // images variante
      try{
        const im = vd?._links?.variant_images?.href
          ? await getJSON(vd._links.variant_images.href)
          : await getJSON(`${API_BASE}/v2/catalog-variants/${vid}/images`);
        const arr = im?.result || im?.data || im || [];
        for (const x of (arr.items || arr)){
          vImgs.push({
            catalog_variant_id: vid,
            image_url: String(x?.image || x?.url || ''),
            angle: String(x?.angle || ''),
            color: String(x?.color || ''),
            is_default: String(!!x?.is_default)
          });
        }
      }catch(_){}

      // prix variante
      try{
        const base = vd?._links?.variant_prices?.href || `${API_BASE}/v2/catalog-variants/${vid}/variant_prices`;
        const u = new URL(base);
        if (region) u.searchParams.set('region', region);
        const pr = await getJSON(u.toString());
        const arr = pr?.result || pr?.data || pr || [];
        for (const r of (arr.items || arr)){
          prices.push({
            product_id: pid, variant_id: vid,
            currency: String(r?.currency || ''),
            retail_price: String(r?.retail_price || ''),
            region: String(r?.region || region || '')
          });
        }
      }catch(_){}

      // disponibilité
      try{
        const av = vd?._links?.variant_availability?.href
          ? await getJSON(vd._links.variant_availability.href)
          : await getJSON(`${API_BASE}/v2/catalog-variants/${vid}/availability`);
        const items = av?.result || av?.data || av || [];
        const arr = items?.items || items;
        const list = Array.isArray(arr) ? arr : [arr];
        for (const a of list){
          avail.push({
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
    product_categories: joins,
    variants,
    product_images: pImgs,
    variant_images: vImgs,
    sizes,
    prices,
    availability: avail,
    countries
  };
}

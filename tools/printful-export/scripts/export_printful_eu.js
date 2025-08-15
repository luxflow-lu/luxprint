#!/usr/bin/env node
'use strict';

// Load .env locally (ignored in git). In CI, PRINTFUL_TOKEN comes from secrets.
try { require('dotenv').config(); } catch (_) {}

const fs = require('fs');
const path = require('path');

const API_BASE = 'https://api.printful.com';
const TOKEN = process.env.PRINTFUL_TOKEN;
if (!TOKEN) throw new Error('PRINTFUL_TOKEN missing. Put it in tools/printful-export/.env or as a GitHub Secret.');

const argv = process.argv.slice(2);
function arg(name, def = null) {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? (argv[i + 1] ?? true) : def;
}

// ====== RÉGLAGES POUR RUN LONG ET STABLE ======
const REGION      = arg('region', 'europe');    // selling_region_name (ex: "europe")
const DEST        = arg('dest', null);          // destination_country (ex: "FR"); si présent, override region
const MAX         = Number(arg('max', 0));      // 0 = pas de limite produits (MAX RUN)
const OUTDIR      = arg('out', 'printful_export');
const WANT_ZIP    = argv.includes('--zip');     // nécessite jszip
const DEBUG       = argv.includes('--debug');   // logs de progression
const LITE        = argv.includes('--lite');    // saute images/prix/dispo/tailles (pour tests rapides)
const SKIP_IMAGES = argv.includes('--no-images'); // pour alléger si besoin (garde prix/dispo/tailles)
const DELAY       = Number(arg('delay', 300));  // délai global après chaque requête OK (ms) — par défaut 300ms
const MAX_RETRY   = Number(arg('retry', 10));   // nb de tentatives sur 429/5xx
const BASE_BACKOFF= Number(arg('backoff', 1000)); // backoff de base (ms) — sera multiplié par l’essai

fs.mkdirSync(OUTDIR, { recursive: true });

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// GET JSON avec retries/backoff + respect Retry-After (secondes ou date HTTP)
async function getJSON(url, { retry = MAX_RETRY, backoff = BASE_BACKOFF } = {}) {
  for (let a = 1; a <= retry; a++) {
    let r = null;
    try {
      r = await fetch(url, { headers: { Authorization: `Bearer ${TOKEN}` } });
    } catch (_) {}

    if (!r) {
      if (a === retry) throw new Error(`Fetch failed: ${url}`);
      const ms = backoff * a;
      if (DEBUG) console.log(`[retry] network wait=${ms}ms ${url}`);
      await sleep(ms);
      continue;
    }

    if (r.status === 429 || (r.status >= 500 && r.status <= 599)) {
      const raHeader = r.headers.get('retry-after');
      let raMs = backoff * a;
      if (raHeader) {
        const num = Number(raHeader);
        if (Number.isFinite(num) && num > 0) {
          raMs = Math.max(raMs, num * 1000); // header en secondes → ms
        } else {
          const date = Date.parse(raHeader);
          if (Number.isFinite(date)) {
            const diff = date - Date.now();
            if (diff > 0) raMs = Math.max(raMs, diff);
          }
        }
      }
      raMs += Math.floor(Math.random() * 250); // jitter
      if (a === retry) {
        const t = await r.text().catch(() => '');
        throw new Error(`HTTP ${r.status} ${url} :: ${t}`);
      }
      if (DEBUG) console.log(`[retry] ${r.status} wait=${raMs}ms ${url}`);
      await sleep(raMs);
      continue;
    }

    if (!r.ok) {
      const t = await r.text().catch(() => '');
      throw new Error(`HTTP ${r.status}: ${url} :: ${t}`);
    }

    const json = await r.json();
    if (DELAY > 0) await sleep(DELAY); // lissage global post-réussite
    return json;
  }
}

// CSV helpers
function csvEscape(v) {
  if (v == null) return '';
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function writeCSV(name, rows, headers = null) {
  const out = path.join(OUTDIR, name);
  if (!rows?.length) { fs.writeFileSync(out, ''); console.log(`↳ ${name} (empty)`); return; }
  const cols = headers || Array.from(rows.reduce((s, r) => { Object.keys(r).forEach(k => s.add(k)); return s; }, new Set()));
  const lines = [cols.map(csvEscape).join(',')];
  for (const r of rows) lines.push(cols.map(h => csvEscape(r[h] ?? '')).join(','));
  fs.writeFileSync(out, lines.join('\n'));
  console.log(`✓ ${name} (${rows.length} rows)`);
}

// Pagination produits (limit <= 100)
async function listAllProducts({ region, dest, max = 0 }) {
  const PAGE_LIMIT = 100;
  const params = new URLSearchParams();
  if (dest) params.set('destination_country', dest);
  else if (region) params.set('selling_region_name', region);
  params.set('limit', String(PAGE_LIMIT));

  let offset = 0, all = [];
  while (true) {
    params.set('offset', String(offset));
    const url = `${API_BASE}/v2/catalog-products?${params.toString()}`;
    const j = await getJSON(url);
    const data = j?.result || j?.data || j || {};
    const list = data.items || data.products || data || [];
    if (!Array.isArray(list) || list.length === 0) break;

    all.push(...list);
    if (DEBUG) console.log(`[page] products offset=${offset} got=${list.length} total=${all.length}`);

    // max=0 → pas de limite
    if (max && all.length >= max) return all.slice(0, max);
    offset += list.length;

    if ((data.total && offset >= data.total) || list.length < PAGE_LIMIT) break;
    await sleep(150);
  }
  return all;
}

// Pagination variantes (limit <= 100)
async function fetchVariantsForProduct(pid) {
  const PAGE_LIMIT = 100;
  let offset = 0, all = [];
  while (true) {
    const url = `${API_BASE}/v2/catalog-products/${pid}/catalog-variants?limit=${PAGE_LIMIT}&offset=${offset}`;
    const vj = await getJSON(url);
    const data = vj?.result || vj?.data || vj || {};
    const list = data.items || data || [];
    if (!Array.isArray(list) || list.length === 0) break;

    all.push(...list);
    if (DEBUG) console.log(`[page] variants pid=${pid} offset=${offset} got=${list.length} total=${all.length}`);

    offset += list.length;
    if ((data.total && offset >= data.total) || list.length < PAGE_LIMIT) break;
    await sleep(120);
  }
  return all;
}

async function main() {
  console.log('Export Printful → CSV');
  console.log(DEST ? `  Filter: destination_country=${DEST}` : `  Filter: selling_region_name=${REGION}`);
  console.log(`  Cap: max=${MAX || 'ALL'} products`);
  console.log(`  Out: ${OUTDIR}`);
  if (LITE)  console.log('  Mode: LITE (skipping images/prices/availability/sizes)');
  if (DEBUG) console.log(`  Logs: DEBUG enabled | delay=${DELAY}ms retry=${MAX_RETRY} backoff=${BASE_BACKOFF}ms\n`);

  const productsRows = [];
  const variantsRows = [];
  const categoriesRows = [];
  const productCategoriesRows = [];
  const productImagesRows = [];
  const variantImagesRows = [];
  const sizesRows = [];
  const pricesRows = [];
  const availabilityRows = [];
  const countriesRows = [];

  // Countries
  try {
    const cj = await getJSON(`${API_BASE}/v2/countries`);
    const list = cj?.result || cj?.data || cj || [];
    for (const c of (list.items || list)) {
      countriesRows.push({ code: c?.code || '', name: c?.name || '' });
    }
  } catch (e) {
    console.warn('countries skipped:', e.message);
  }

  // Products base list
  const base = await listAllProducts({ region: REGION, dest: DEST, max: MAX });
  console.log(`Found products: ${base.length}`);

  for (let idx = 0; idx < base.length; idx++) {
    const p = base[idx];
    const pid = p?.id || p?.product_id;
    if (!pid) continue;
    if (DEBUG) console.log(`\n[product] #${pid} (${idx + 1}/${base.length})`);

    // product details
    let pd = p;
    try {
      const r = await getJSON(`${API_BASE}/v2/catalog-products/${pid}`);
      pd = r?.result || r?.data || r || pd;
    } catch (e) {
      console.warn(`detail #${pid}:`, e.message);
    }

    productsRows.push({
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
      __links_sizes: pd?._links?.product_sizes?.href || '',
      _links_images: pd?._links?.product_images?.href || '',
      _links_availability: pd?._links?.availability?.href || ''
    });

    // categories + join
    if (!LITE) {
      try {
        const c = await getJSON(`${API_BASE}/v2/catalog-products/${pid}/catalog-categories`);
        const arr = c?.result || c?.data || c || [];
        for (const it of (arr.items || arr)) {
          const cid = it?.id; if (!cid) continue;
          categoriesRows.push({ category_id: cid, name: String(it?.name || ''), parent_id: it?.parent_id ?? '' });
          productCategoriesRows.push({ product_id: pid, category_id: cid });
        }
      } catch (_) {}
    }

    // product images
    if (!LITE && !SKIP_IMAGES) {
      try {
        const im = await getJSON(`${API_BASE}/v2/catalog-products/${pid}/images`);
        const arr = im?.result || im?.data || im || [];
        for (const x of (arr.items || arr)) {
          productImagesRows.push({
            product_id: pid,
            image_url: String(x?.image || x?.url || ''),
            color: String(x?.color || ''),
            is_default: String(!!x?.is_default)
          });
        }
      } catch (_) {}
    }

    // sizes
    if (!LITE) {
      try {
        const sj = await getJSON(`${API_BASE}/v2/catalog-products/${pid}/sizes`);
        const arr = sj?.result || sj?.data || sj || [];
        for (const s of (arr.items || arr)) {
          sizesRows.push({
            product_id: pid,
            size_code: String(s?.size_code || s?.size || ''),
            measurements_json: JSON.stringify(s?.measurements || s?.table || {}),
            units: String(s?.units || '')
          });
        }
      } catch (_) {}
    }

    // product-level prices (if provided)
    if (!LITE) {
      try {
        const prUrl = pd?._links?.product_prices?.href;
        if (prUrl) {
          const u = new URL(prUrl);
          if (REGION) u.searchParams.set('region', REGION);
          const pr = await getJSON(u.toString());
          const arr = pr?.result || pr?.data || pr || [];
          for (const r of (arr.items || arr)) {
            pricesRows.push({
              product_id: pid, variant_id: '',
              currency: String(r?.currency || ''),
              retail_price: String(r?.retail_price || ''),
              region: String(r?.region || REGION || '')
            });
          }
        }
      } catch (_) {}
    }

    // variants (paged)
    let vlist = [];
    try {
      vlist = await fetchVariantsForProduct(pid);
    } catch (_) {
      vlist = [];
    }

    for (const v of vlist) {
      const vid = v?.id;
      if (!vid) continue;

      if (DEBUG) console.log(`  [variant] ${vid}`);

      // variant detail (light)
      let vd = v;
      try {
        const d = await getJSON(`${API_BASE}/v2/catalog-variants/${vid}`);
        vd = d?.result || d?.data || d || vd;
      } catch (_) {}

      variantsRows.push({
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

      if (!LITE && !SKIP_IMAGES) {
        // variant images
        try {
          const iv = await getJSON(`${API_BASE}/v2/catalog-variants/${vid}/images`);
          const arr = iv?.result || iv?.data || iv || [];
          for (const im of (arr.items || arr)) {
            variantImagesRows.push({
              catalog_variant_id: vid,
              image_url: String(im?.image || im?.url || ''),
              angle: String(im?.angle || ''),
              color: String(im?.color || ''),
              is_default: String(!!im?.is_default)
            });
          }
        } catch (_) {}
      }

      if (!LITE) {
        // variant prices
        try {
          const u = new URL(`${API_BASE}/v2/catalog-variants/${vid}/variant_prices`);
          if (REGION) u.searchParams.set('region', REGION);
          const pv = await getJSON(u.toString());
          const arr = pv?.result || pv?.data || pv || [];
          for (const pr of (arr.items || arr)) {
            pricesRows.push({
              product_id: pid, variant_id: vid,
              currency: String(pr?.currency || ''),
              retail_price: String(pr?.retail_price || ''),
              region: String(pr?.region || REGION || '')
            });
          }
        } catch (_) {}

        // availability
        try {
          const av = await getJSON(`${API_BASE}/v2/catalog-variants/${vid}/availability`);
          const items = av?.result || av?.data || av || [];
          const arr = items?.items || items;
          const list = Array.isArray(arr) ? arr : [arr];
          for (const a of list) {
            availabilityRows.push({
              catalog_variant_id: vid,
              selling_region_name: String(a?.selling_region_name || REGION || ''),
              available: String(!!(a?.available ?? a?.in_stock)),
              stock: typeof a?.stock === 'number' ? a.stock : '',
              warehouses_json: JSON.stringify(a?.warehouses || a?.locations || {})
            });
          }
        } catch (_) {}
      }
    }

    await sleep(120); // anti rafale entre produits
  }

  // Dédup
  const catMap = new Map();
  for (const c of categoriesRows) {
    const key = String(c.category_id);
    if (!catMap.has(key)) catMap.set(key, c);
  }
  const categoriesDedup = Array.from(catMap.values());

  const countryMap = new Map();
  for (const c of countriesRows) {
    const key = String(c.code);
    if (!countryMap.has(key)) countryMap.set(key, c);
  }
  const countriesDedup = Array.from(countryMap.values());

  // Écriture CSV
  writeCSV('products.csv', productsRows, [
    'product_id','main_category_id','type','name','brand','model','image_hero','variant_count','is_discontinued','description',
    'sizes_list','colors_list','techniques','placements_schema','product_options',
    '_links_self','_links_variants','_links_categories','_links_prices','_links_sizes','_links_images','_links_availability'
  ]);
  writeCSV('variants.csv', variantsRows, [
    'catalog_variant_id','catalog_product_id','name','size','color','color_code','color_code2','image_main','placement_dimensions',
    '_links_self','_links_variant_prices','_links_variant_images','_links_variant_availability'
  ]);
  writeCSV('categories.csv', categoriesDedup, ['category_id','name','parent_id']);
  writeCSV('product_categories.csv', productCategoriesRows, ['product_id','category_id']);
  writeCSV('product_images.csv', productImagesRows, ['product_id','image_url','color','is_default']);
  writeCSV('variant_images.csv', variantImagesRows, ['catalog_variant_id','image_url','angle','color','is_default']);
  writeCSV('sizes.csv', sizesRows, ['product_id','size_code','measurements_json','units']);
  writeCSV('prices.csv', pricesRows, ['product_id','variant_id','currency','retail_price','region']);
  writeCSV('availability.csv', availabilityRows, ['catalog_variant_id','selling_region_name','available','stock','warehouses_json']);
  writeCSV('countries.csv', countriesDedup, ['code','name']);

  if (WANT_ZIP) {
    let JSZip;
    try { JSZip = require('jszip'); }
    catch (e) {
      console.warn('jszip not installed. Run: npm i jszip');
      return;
    }
    const zip = new JSZip();
    const files = fs.readdirSync(OUTDIR).filter(f => f.endsWith('.csv'));
    for (const f of files) {
      zip.file(f, fs.readFileSync(path.join(OUTDIR, f), 'utf8'));
    }
    const blob = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    const zipName = `luxprint_export_${DEST || REGION}_${MAX || 'ALL'}${LITE ? '_lite' : ''}.zip`;
    fs.writeFileSync(path.join(OUTDIR, zipName), blob);
    console.log(`ZIP -> ${zipName}`);
  }

  console.log('\nExport terminé ->', OUTDIR);
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });

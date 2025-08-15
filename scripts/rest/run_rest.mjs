// REST (v2 only):
// - /v2/catalog-categories                    -> categories.csv
// - /v2/countries                             -> countries.csv
// - /v2/catalog-products (paged)              -> parcours produits, puis :
//    * /v2/catalog-products/{id}/catalog-categories -> product_categories.csv
//    * /v2/catalog-products/{id}/prices            -> product_prices.csv
//    * /v2/catalog-products/{id}/sizes             -> sizes.csv   <-- NEW
//    * /v2/catalog-products/{id}/catalog-variants  -> variantes (paged) puis :
//         - /v2/catalog-variants/{vid}/images       -> product_images.csv
//         - /v2/catalog-variants/{vid}/availability -> availability.csv
//         - /v2/catalog-variants/{vid}/prices       -> prices.csv
//
// - Peut s’exécuter AVANT le CORE (pas besoin de variants.csv).
// - Auth: PRINTFUL_TOKEN (Bearer). Pagination par défaut: PAGE_LIMIT=100.

import fs from "node:fs";
import path from "node:path";

const API_KEY = process.env.PRINTFUL_TOKEN;
if (!API_KEY) {
  console.error("Missing PRINTFUL_TOKEN in env.");
  process.exit(1);
}

const BASE_URL = (process.env.BASE_URL || "https://api.printful.com").replace(/\/+$/, "");
const LIMIT = Number.parseInt(process.env.PAGE_LIMIT || "100", 10);

const OUT_DIR = path.resolve("data");
fs.mkdirSync(OUT_DIR, { recursive: true });

const headers = {
  "Authorization": `Bearer ${API_KEY}`,
  "User-Agent": "printful-catalog-rest-v2/1.2",
  // "X-PF-Language": "en",
};

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ---------------- HTTP utils ----------------
async function fetchJsonWithRetry(url, maxRetries = 8, backoff = 1000) {
  for (let a = 0; a <= maxRetries; a++) {
    try {
      const res = await fetch(url, { headers });
      if (res.status === 429) {
        const ra = res.headers.get("retry-after");
        const wait = ra ? Math.ceil(Number(ra) * 1000) : backoff * (2 ** a);
        await sleep(wait);
        continue;
      }
      if (res.status >= 500) {
        await sleep(backoff * (2 ** a));
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status} - ${await res.text()}`);
      return await res.json();
    } catch (e) {
      if (a === maxRetries) throw e;
      await sleep(backoff * (2 ** a));
    }
  }
  throw new Error("fetchJsonWithRetry exhausted");
}

// v2 payload helper -> {items[], paging|null}
function parseItemsAndPaging(payload) {
  if (!payload) return { items: [], paging: null };
  if ("data" in payload) {
    const items = Array.isArray(payload.data) ? payload.data : (payload.data != null ? [payload.data] : []);
    return { items, paging: payload.paging || null };
  }
  // v1 fallback (rare)
  if ("result" in payload) {
    const res = payload.result;
    const items = Array.isArray(res) ? res : (res?.items ?? (res ? [res] : []));
    return { items, paging: payload.paging || null };
  }
  return { items: [], paging: null };
}

async function pagedGET(pathname, limit = LIMIT) {
  let offset = 0;
  let total = null;
  const all = [];
  while (true) {
    const url = `${BASE_URL}${pathname}?limit=${limit}&offset=${offset}`;
    const json = await fetchJsonWithRetry(url);
    const { items, paging } = parseItemsAndPaging(json);
    all.push(...items.map(i => (typeof i === "object" ? i : { value: i })));
    const fetched = items.length;
    if (!paging || typeof paging.total !== "number" || fetched === 0) break;
    offset += fetched;
    if (offset >= paging.total) break;
  }
  return all;
}

// ---------------- CSV utils ----------------
function writeCsv(filePath, rows) {
  const headersSet = new Set();
  rows.forEach(r => Object.keys(r).forEach(k => headersSet.add(k)));
  const cols = Array.from(headersSet).sort();
  const esc = (s) => `"${String(s).replace(/"/g, '""')}"`;

  const lines = [];
  lines.push(cols.map(esc).join(","));
  for (const r of rows) {
    const line = cols.map(c => {
      let v = r[c];
      if (v && typeof v === "object") v = JSON.stringify(v);
      if (v === undefined || v === null) v = "";
      return esc(v);
    }).join(",");
    lines.push(line);
  }
  fs.writeFileSync(filePath, lines.join("\n"), "utf8");
  console.log(`Wrote ${filePath} — ${rows.length} rows`);
}

// ---------------- Top-level dumps ----------------
async function dumpCategories() {
  try {
    const rows = await pagedGET("/v2/catalog-categories");
    writeCsv(path.join(OUT_DIR, "categories.csv"), rows);
  } catch (e) {
    console.warn("Warn: catalog-categories failed — writing empty CSV.", e.message || e);
    writeCsv(path.join(OUT_DIR, "categories.csv"), []);
  }
}

async function dumpCountries() {
  try {
    const rows = await pagedGET("/v2/countries");
    writeCsv(path.join(OUT_DIR, "countries.csv"), rows);
  } catch (e) {
    console.warn("Warn: countries failed — writing empty CSV.", e.message || e);
    writeCsv(path.join(OUT_DIR, "countries.csv"), []);
  }
}

// ---------------- Per product/variant fetchers ----------------
async function listCatalogProducts() {
  return await pagedGET("/v2/catalog-products");
}

async function listVariantsForProduct(pid) {
  return await pagedGET(`/v2/catalog-products/${encodeURIComponent(pid)}/catalog-variants`);
}

async function fetchProductCategories(pid) {
  const json = await fetchJsonWithRetry(`${BASE_URL}/v2/catalog-products/${encodeURIComponent(pid)}/catalog-categories`);
  const { items } = parseItemsAndPaging(json);
  return items.map(it => ({
    product_id: pid,
    category_id: it?.id ?? it?.category_id ?? null,
    category_name: it?.name ?? it?.category_name ?? null,
    ...it
  }));
}

async function fetchProductPrices(pid) {
  const json = await fetchJsonWithRetry(`${BASE_URL}/v2/catalog-products/${encodeURIComponent(pid)}/prices`);
  const { items } = parseItemsAndPaging(json);
  return items.map(it => ({
    product_id: pid,
    ...it
  }));
}

// NEW: sizes (size guides + available_sizes) per product
async function fetchProductSizes(pid) {
  const json = await fetchJsonWithRetry(`${BASE_URL}/v2/catalog-products/${encodeURIComponent(pid)}/sizes`);
  const { items } = parseItemsAndPaging(json);
  // items est normalement un objet unique ProductSizeGuide -> on normalise
  return items.map(it => ({
    product_id: pid,
    available_sizes: it?.available_sizes ?? null,
    size_tables: it?.size_tables ?? null
  }));
}

async function fetchVariantImages(vid) {
  const json = await fetchJsonWithRetry(`${BASE_URL}/v2/catalog-variants/${encodeURIComponent(vid)}/images`);
  const { items } = parseItemsAndPaging(json);
  return items.map(it => ({ ...(typeof it === "object" ? it : { value: it }), variant_id: vid }));
}

async function fetchVariantAvailability(vid) {
  const json = await fetchJsonWithRetry(`${BASE_URL}/v2/catalog-variants/${encodeURIComponent(vid)}/availability`);
  const { items } = parseItemsAndPaging(json);
  return items.map(it => ({ ...(typeof it === "object" ? it : { value: it }), variant_id: vid }));
}

async function fetchVariantPrices(vid) {
  const json = await fetchJsonWithRetry(`${BASE_URL}/v2/catalog-variants/${encodeURIComponent(vid)}/prices`);
  const { items } = parseItemsAndPaging(json);
  return items.map(it => ({ ...(typeof it === "object" ? it : { value: it }), variant_id: vid }));
}

// ---------------- Main ----------------
(async function main() {
  try {
    console.log("REST v2 start");

    await dumpCategories();
    await dumpCountries();

    const productCategories = [];
    const productPrices = [];
    const productSizes = [];        // <-- NEW
    const variantImages = [];
    const variantAvailability = [];
    const variantPrices = [];

    const products = await listCatalogProducts();
    console.log(`Found ${products.length} catalog products`);

    let pCount = 0;
    let vCount = 0;

    for (const p of products) {
      const pid = p?.id ?? p?.product_id ?? p?.catalog_product_id;
      if (pid == null) continue;

      // per-product: categories + prices + sizes
      try {
        const [pcats, ppr, psz] = await Promise.all([
          fetchProductCategories(pid).catch(e => { console.warn(`product ${pid} categories failed:`, e.message); return []; }),
          fetchProductPrices(pid).catch(e => { console.warn(`product ${pid} prices failed:`, e.message); return []; }),
          fetchProductSizes(pid).catch(e => { console.warn(`product ${pid} sizes failed:`, e.message); return []; }), // NEW
        ]);
        productCategories.push(...pcats);
        productPrices.push(...ppr);
        productSizes.push(...psz);  // NEW
      } catch {}

      // variants for product
      let variants = [];
      try {
        variants = await listVariantsForProduct(pid);
      } catch (e) {
        console.warn(`product ${pid} variants failed:`, e.message || e);
      }

      for (const v of variants) {
        const vid = v?.id ?? v?.variant_id;
        if (vid == null) continue;

        try {
          const [imgs, avs, vprs] = await Promise.all([
            fetchVariantImages(vid).catch(e => { console.warn(`variant ${vid} images failed:`, e.message); return []; }),
            fetchVariantAvailability(vid).catch(e => { console.warn(`variant ${vid} availability failed:`, e.message); return []; }),
            fetchVariantPrices(vid).catch(e => { console.warn(`variant ${vid} prices failed:`, e.message); return []; }),
          ]);
          variantImages.push(...imgs);
          variantAvailability.push(...avs);
          variantPrices.push(...vprs);
        } catch {}
        vCount++;
        if (vCount % 250 === 0) console.log(`...processed ${vCount} variants so far`);
      }

      pCount++;
      if (pCount % 50 === 0) console.log(`...processed ${pCount} products so far`);
    }

    // Écritures
    writeCsv(path.join(OUT_DIR, "product_categories.csv"), productCategories);
    writeCsv(path.join(OUT_DIR, "product_images.csv"), variantImages);
    writeCsv(path.join(OUT_DIR, "availability.csv"), variantAvailability);
    writeCsv(path.join(OUT_DIR, "prices.csv"), variantPrices);           // par variante
    writeCsv(path.join(OUT_DIR, "product_prices.csv"), productPrices);   // par produit
    writeCsv(path.join(OUT_DIR, "sizes.csv"), productSizes);             // <-- NEW

    console.log("REST v2 done.");
  } catch (e) {
    console.error("REST failed:", e?.message || e);
    process.exit(1);
  }
})();

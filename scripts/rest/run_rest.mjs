// REST (v2 only, EU-only par défaut)
//
// Génère :
// - categories.csv              (GET /v2/catalog-categories)
// - countries.csv               (GET /v2/countries)
// - product_categories.csv      (GET /v2/catalog-products/{id}/catalog-categories)
// - product_prices.csv          (GET /v2/catalog-products/{id}/prices)
// - sizes.csv                   (GET /v2/catalog-products/{id}/sizes) [silence "No size guides"]
// - product_images.csv          (GET /v2/catalog-variants/{vid}/images)   [EU-only variants]
// - availability.csv            (GET /v2/catalog-variants/{vid}/availability) [EU-only entries]
// - prices.csv                  (GET /v2/catalog-variants/{vid}/prices)   [EU-only variants]
//
// Peut tourner AVANT CORE. Concurrence contrôlée sur variantes.
// Auth: PRINTFUL_TOKEN (Bearer)

import fs from "node:fs";
import path from "node:path";

const API_KEY = process.env.PRINTFUL_TOKEN;
if (!API_KEY) {
  console.error("Missing PRINTFUL_TOKEN in env.");
  process.exit(1);
}

const BASE_URL = (process.env.BASE_URL || "https://api.printful.com").replace(/\/+$/, "");
const LIMIT = Number.parseInt(process.env.PAGE_LIMIT || "200", 10);
const CONCURRENCY = Number.parseInt(process.env.CONCURRENCY || "8", 10);
const LOG_EVERY = Number.parseInt(process.env.LOG_EVERY || "200", 10);

const EU_ONLY = (process.env.EU_ONLY ?? "true") === "true";
const EU_COUNTRIES = (process.env.EU_COUNTRIES ??
  "AT,BE,BG,HR,CY,CZ,DK,EE,FI,FR,DE,GR,HU,IE,IT,LV,LT,LU,MT,NL,PL,PT,RO,SK,SI,ES,SE,GB,NO,CH,IS,LI"
).split(",").map(s => s.trim().toUpperCase()).filter(Boolean);

const OUT_DIR = path.resolve("data");
fs.mkdirSync(OUT_DIR, { recursive: true });

const headers = {
  "Authorization": `Bearer ${API_KEY}`,
  "User-Agent": "printful-catalog-rest-v2/1.3",
  // "X-PF-Language": "en",
};

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ---------- utils ----------
function isEUCountry(code) {
  return !!code && EU_COUNTRIES.includes(String(code).toUpperCase());
}
function filterAvailabilityToEU(items) {
  if (!EU_ONLY) return Array.isArray(items) ? items : (items ? [items] : []);
  const arr = Array.isArray(items) ? items : (items ? [items] : []);
  return arr.filter(it => {
    if (isEUCountry(it?.country_code)) return true;
    if (Array.isArray(it?.countries) && it.countries.some(isEUCountry)) return true;
    if (Array.isArray(it?.country_codes) && it.country_codes.some(isEUCountry)) return true;
    if (typeof it?.region === "string" && it.region.toUpperCase() === "EU") return true;
    return false;
  });
}

async function fetchJsonWithRetry(url, maxRetries = 8, backoff = 1000) {
  for (let a = 0; a <= maxRetries; a++) {
    try {
      const res = await fetch(url, { headers });
      if (res.status === 429) {
        const ra = res.headers.get("retry-after");
        const wait = ra ? Math.ceil(Number(ra) * 1000) : backoff * (2 ** a);
        console.log(`429 received, waiting ${wait}ms`);
        await sleep(wait);
        continue;
      }
      if (res.status >= 500) {
        const wait = backoff * (2 ** a);
        console.log(`5xx received, waiting ${wait}ms`);
        await sleep(wait);
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status} - ${await res.text()}`);
      return await res.json();
    } catch (e) {
      if (a === maxRetries) throw e;
      const wait = backoff * (2 ** a);
      console.log(`Retrying after error (${e?.message || e}) in ${wait}ms`);
      await sleep(wait);
    }
  }
  throw new Error("fetchJsonWithRetry exhausted");
}

function parseItemsAndPaging(payload) {
  if (!payload) return { items: [], paging: null };
  if ("data" in payload) {
    const items = Array.isArray(payload.data) ? payload.data : (payload.data != null ? [payload.data] : []);
    return { items, paging: payload.paging || null };
  }
  if ("result" in payload) {
    const r = payload.result;
    const items = Array.isArray(r) ? r : (r?.items ?? (r ? [r] : []));
    return { items, paging: payload.paging || null };
  }
  return { items: [], paging: null };
}

async function pagedGET(pathname, limit = LIMIT) {
  let offset = 0, total = null;
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

function writeCsv(filePath, rows) {
  const set = new Set();
  rows.forEach(r => Object.keys(r).forEach(k => set.add(k)));
  const cols = Array.from(set).sort();
  const esc = s => `"${String(s).replace(/"/g, '""')}"`;
  const lines = [cols.map(esc).join(",")];
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

async function mapLimit(items, limit, iteratee) {
  const results = new Array(items.length);
  let i = 0;
  const workers = Array(Math.min(limit, items.length)).fill(0).map(async () => {
    while (true) {
      const idx = i++;
      if (idx >= items.length) break;
      results[idx] = await iteratee(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return results;
}

// ---------- top-level dumps ----------
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

// ---------- per product / per variant ----------
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
  return items.map(it => ({ product_id: pid, ...it }));
}
async function fetchProductSizes(pid) {
  try {
    const json = await fetchJsonWithRetry(`${BASE_URL}/v2/catalog-products/${encodeURIComponent(pid)}/sizes`);
    const { items } = parseItemsAndPaging(json);
    return items.map(it => ({
      product_id: pid,
      available_sizes: it?.available_sizes ?? null,
      size_tables: it?.size_tables ?? null
    }));
  } catch (e) {
    const msg = e?.message || "";
    if (msg.includes("No size guides") || msg.includes("HTTP 404")) return [];
    throw e;
  }
}

async function fetchVariantAvailability(vid) {
  const json = await fetchJsonWithRetry(`${BASE_URL}/v2/catalog-variants/${encodeURIComponent(vid)}/availability`);
  const { items } = parseItemsAndPaging(json);
  return filterAvailabilityToEU(items).map(it => ({ ...(typeof it === "object" ? it : { value: it }), variant_id: vid }));
}
async function fetchVariantImages(vid) {
  const json = await fetchJsonWithRetry(`${BASE_URL}/v2/catalog-variants/${encodeURIComponent(vid)}/images`);
  const { items } = parseItemsAndPaging(json);
  return items.map(it => ({ ...(typeof it === "object" ? it : { value: it }), variant_id: vid }));
}
async function fetchVariantPrices(vid) {
  const json = await fetchJsonWithRetry(`${BASE_URL}/v2/catalog-variants/${encodeURIComponent(vid)}/prices`);
  const { items } = parseItemsAndPaging(json);
  return items.map(it => ({ ...(typeof it === "object" ? it : { value: it }), variant_id: vid }));
}

// ---------- main ----------
(async function main() {
  try {
    console.log(`REST v2 start — EU_ONLY=${EU_ONLY}, PAGE_LIMIT=${LIMIT}, CONCURRENCY=${CONCURRENCY}`);

    await dumpCategories();
    await dumpCountries();

    const productCategories = [];
    const productPrices = [];
    const productSizes = [];
    const variantImages = [];
    const variantAvailability = [];
    const variantPrices = [];

    const products = await listCatalogProducts();
    console.log(`Found ${products.length} catalog products`);

    let pCount = 0;
    let keptProductsEU = 0;
    let vCount = 0;
    let keptVariantsEU = 0;

    for (const p of products) {
      const pid = p?.id ?? p?.product_id ?? p?.catalog_product_id;
      if (pid == null) continue;

      // Liste des variantes (toutes) de ce produit
      let variants = [];
      try {
        variants = await listVariantsForProduct(pid);
      } catch (e) {
        console.warn(`product ${pid} variants failed:`, e.message || e);
      }

      // On évalue d'abord l'EU pour les variantes (availability) avec concurrence
      // => si EU_ONLY, on garde uniquement les variantes EU
      const EU_checked = await mapLimit(variants, CONCURRENCY, async (v) => {
        const vid = v?.id ?? v?.variant_id;
        if (vid == null) return null;

        let avs = [];
        try {
          avs = await fetchVariantAvailability(vid); // déjà filtré EU si EU_ONLY
        } catch (e) {
          // indispo / erreur => on considère non-EU si EU_ONLY
          avs = [];
        }

        const isEU = EU_ONLY ? (avs.length > 0) : true;
        return { v, vid, avs, isEU };
      });

      const keptVariantEntries = EU_checked.filter(x => x && x.isEU);
      if (!EU_ONLY || keptVariantEntries.length > 0) {
        // Ce produit est gardé (EU-only => au moins 1 variante EU)
        keptProductsEU++;
        // 1) Infos produit (cats/prices/sizes)
        try {
          const [pcats, ppr, psz] = await Promise.all([
            fetchProductCategories(pid).catch(e => { console.warn(`product ${pid} categories failed:`, e.message); return []; }),
            fetchProductPrices(pid).catch(e => { console.warn(`product ${pid} prices failed:`, e.message); return []; }),
            fetchProductSizes(pid).catch(e => { console.warn(`product ${pid} sizes failed:`, e.message); return []; }),
          ]);
          productCategories.push(...pcats);
          productPrices.push(...ppr);
          productSizes.push(...psz);
        } catch {}

        // 2) Pour chaque variante EU gardée : images + prices
        await mapLimit(keptVariantEntries, CONCURRENCY, async (entry) => {
          const { vid, avs } = entry;
          try {
            const [imgs, vprs] = await Promise.all([
              fetchVariantImages(vid).catch(() => []),
              fetchVariantPrices(vid).catch(() => []),
            ]);
            // availability déjà filtrée EU
            variantAvailability.push(...avs);
            variantImages.push(...imgs);
            variantPrices.push(...vprs);
            keptVariantsEU++;
          } catch {}
          vCount++;
          if (vCount % LOG_EVERY === 0) console.log(`...processed ${vCount} variants (${keptVariantsEU} kept EU)`);
        });
      } else {
        // produit non EU => skip infos produit
        vCount += variants.length;
      }

      pCount++;
      if (pCount % Math.max(1, Math.floor(LOG_EVERY / 5)) === 0) {
        console.log(`...processed ${pCount} products (${keptProductsEU} kept EU)`);
      }
    }

    // Écritures
    writeCsv(path.join(OUT_DIR, "product_categories.csv"), productCategories);
    writeCsv(path.join(OUT_DIR, "product_images.csv"), variantImages);
    writeCsv(path.join(OUT_DIR, "availability.csv"), variantAvailability);
    writeCsv(path.join(OUT_DIR, "prices.csv"), variantPrices);           // par variante (EU)
    writeCsv(path.join(OUT_DIR, "product_prices.csv"), productPrices);   // par produit  (EU)
    writeCsv(path.join(OUT_DIR, "sizes.csv"), productSizes);             // par produit  (EU)

    console.log("REST v2 done.",
      `Products scanned=${pCount}, keptEU=${keptProductsEU}; Variants scanned=${vCount}, keptEU=${keptVariantsEU}`
    );
  } catch (e) {
    console.error("REST failed:", e?.message || e);
    process.exit(1);
  }
})();

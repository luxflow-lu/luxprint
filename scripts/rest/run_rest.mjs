// REST (v2 only, EU-only par défaut)
// Génère :
// - categories.csv
// - countries.csv
// - product_categories.csv
// - product_prices.csv
// - sizes.csv
// - product_images.csv
// - availability.csv  (EU-only)
// - prices.csv        (EU-only)
// Anti-429 : pause globale + concurrence dynamique (AIMD)

import fs from "node:fs";
import path from "node:path";

const API_KEY = process.env.PRINTFUL_TOKEN;
if (!API_KEY) { console.error("Missing PRINTFUL_TOKEN in env."); process.exit(1); }

const BASE_URL = (process.env.BASE_URL || "https://api.printful.com").replace(/\/+$/, "");
const LIMIT = Number.parseInt(process.env.PAGE_LIMIT || "150", 10);
const LOG_EVERY = Number.parseInt(process.env.LOG_EVERY || "200", 10);

// Concurrence dynamique
const INIT_CONC = Number.parseInt(process.env.CONCURRENCY || "8", 10);
let targetConc = Math.max(2, INIT_CONC);  // cible dynamique
const MIN_CONC = 2;
const MAX_CONC = Math.max(INIT_CONC, 8);

const EU_ONLY = (process.env.EU_ONLY ?? "true") === "true";
const EU_COUNTRIES = (process.env.EU_COUNTRIES ??
  "AT,BE,BG,HR,CY,CZ,DK,EE,FI,FR,DE,GR,HU,IE,IT,LV,LT,LU,MT,NL,PL,PT,RO,SK,SI,ES,SE,GB,NO,CH,IS,LI"
).split(",").map(s => s.trim().toUpperCase()).filter(Boolean);

const OUT_DIR = path.resolve("data");
fs.mkdirSync(OUT_DIR, { recursive: true });

// ---------- Concurrence & pause globale ----------
let active = 0;
let globalPauseUntil = 0;
let successStreak = 0;

function now() { return Date.now(); }
function jitter(ms) { return Math.floor(ms * (0.85 + Math.random() * 0.3)); }

async function acquireSlot() {
  while (true) {
    const waitMs = globalPauseUntil - now();
    if (waitMs > 0) await sleep(waitMs);

    if (active < targetConc) { active++; return; }
    await sleep(25);
  }
}
function releaseSlot() { active = Math.max(0, active - 1); }

function reduceConcurrency() {
  const old = targetConc;
  targetConc = Math.max(MIN_CONC, Math.floor(targetConc / 2));
  successStreak = 0;
  if (targetConc < old) console.log(`[rate] decrease concurrency ${old} -> ${targetConc}`);
}
function maybeIncreaseConcurrency() {
  // augmente doucement après une longue série de succès
  if (successStreak >= 200 && targetConc < MAX_CONC) {
    const old = targetConc;
    targetConc = Math.min(MAX_CONC, targetConc + 1);
    successStreak = 0;
    console.log(`[rate] increase concurrency ${old} -> ${targetConc}`);
  }
}

const headers = {
  "Authorization": `Bearer ${API_KEY}`,
  "User-Agent": "printful-catalog-rest-v2/1.4",
  // "X-PF-Language": "en",
};

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function fetchJsonWithRetry(url, maxRetries = 8, baseBackoff = 1000) {
  for (let a = 0; a <= maxRetries; a++) {
    await acquireSlot();
    try {
      // Respecte une éventuelle pause globale
      const waitMs = globalPauseUntil - now();
      if (waitMs > 0) await sleep(waitMs);

      const res = await fetch(url, { headers });
      if (res.status === 429) {
        // Retry-After ou backoff exponentiel + jitter, et baisse de la concurrence
        const ra = res.headers.get("retry-after");
        let wait = ra ? Math.ceil(Number(ra) * 1000) : baseBackoff * (2 ** a);
        wait = jitter(wait);
        globalPauseUntil = now() + wait;
        console.log(`[429] waiting ~${wait}ms (retry-after=${ra || "n/a"}), active=${active}`);
        reduceConcurrency();
        continue; // on relance l'essai (sans compter comme succès)
      }
      if (res.status >= 500) {
        const wait = jitter(baseBackoff * (2 ** a));
        globalPauseUntil = now() + wait;
        console.log(`[5xx:${res.status}] waiting ~${wait}ms`);
        continue;
      }
      if (!res.ok) {
        const txt = await res.text();
        throw new Error(`HTTP ${res.status} - ${txt}`);
      }

      const json = await res.json();
      successStreak++;
      maybeIncreaseConcurrency();
      return json;
    } catch (e) {
      if (a === maxRetries) throw e;
      const wait = jitter(baseBackoff * (2 ** a));
      console.log(`[error:${e?.message || e}] backing off ~${wait}ms`);
      globalPauseUntil = now() + wait;
    } finally {
      releaseSlot();
    }
  }
  throw new Error("fetchJsonWithRetry exhausted");
}

// ---------- Helpers v2 ----------
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

// ---------- EU helpers ----------
function isEUCountry(code) {
  return !!code && EU_COUNTRIES.includes(String(code).toUpperCase());
}
function filterAvailabilityToEU(items) {
  const arr = Array.isArray(items) ? items : (items ? [items] : []);
  return arr.filter(it => {
    if (isEUCountry(it?.country_code)) return true;
    if (Array.isArray(it?.countries) && it.countries.some(isEUCountry)) return true;
    if (Array.isArray(it?.country_codes) && it.country_codes.some(isEUCountry)) return true;
    if (typeof it?.region === "string" && it.region.toUpperCase() === "EU") return true;
    return false;
  });
}

// ---------- CSV ----------
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

// ---------- Top-level dumps ----------
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

// ---------- Per product / variant ----------
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

// ---------- Main ----------
(async function main() {
  try {
    console.log(`REST v2 start — EU_ONLY=${EU_ONLY}, PAGE_LIMIT=${LIMIT}, INIT_CONCURRENCY=${INIT_CONC}`);

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

    let pCount = 0, keptProductsEU = 0;
    let vCount = 0, keptVariantsEU = 0;

    for (const p of products) {
      const pid = p?.id ?? p?.product_id ?? p?.catalog_product_id;
      if (pid == null) continue;

      // 1) Variantes du produit
      let variants = [];
      try {
        variants = await listVariantsForProduct(pid);
      } catch (e) {
        console.warn(`product ${pid} variants failed:`, e.message || e);
      }

      // 2) Vérifie EU via availability (déjà filtrée)
      const checked = await Promise.all(variants.map(async (v) => {
        const vid = v?.id ?? v?.variant_id;
        if (vid == null) return null;
        let avs = [];
        try { avs = await fetchVariantAvailability(vid); } catch { avs = []; }
        const isEU = EU_ONLY ? (avs.length > 0) : true;
        return { v, vid, avs, isEU };
      }));

      const kept = checked.filter(x => x && x.isEU);
      const productHasEU = (!EU_ONLY) || kept.length > 0;

      // 3) Infos produit seulement si on garde le produit (EU)
      if (productHasEU) {
        keptProductsEU++;
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
      }

      // 4) Pour chaque variante EU retenue, on récupère images & prices
      await Promise.all(kept.map(async ({ vid, avs }) => {
        try {
          const [imgs, vprs] = await Promise.all([
            fetchVariantImages(vid).catch(() => []),
            fetchVariantPrices(vid).catch(() => []),
          ]);
          variantAvailability.push(...avs);      // déjà filtrée EU
          variantImages.push(...imgs);
          variantPrices.push(...vprs);
          keptVariantsEU++;
        } catch {}
        vCount++;
        if (vCount % LOG_EVERY === 0) {
          console.log(`...variants processed=${vCount}, keptEU=${keptVariantsEU}, concurrency=${targetConc}, active=${active}`);
        }
      }));

      pCount++;
      if (pCount % Math.max(1, Math.floor(LOG_EVERY / 5)) === 0) {
        console.log(`...products processed=${pCount}, keptEU=${keptProductsEU}, concurrency=${targetConc}, active=${active}`);
      }
    }

    // Écritures
    writeCsv(path.join(OUT_DIR, "product_categories.csv"), productCategories);
    writeCsv(path.join(OUT_DIR, "product_images.csv"), variantImages);
    writeCsv(path.join(OUT_DIR, "availability.csv"), variantAvailability);
    writeCsv(path.join(OUT_DIR, "prices.csv"), variantPrices);           // par variante (EU)
    writeCsv(path.join(OUT_DIR, "product_prices.csv"), productPrices);   // par produit  (EU)
    writeCsv(path.join(OUT_DIR, "sizes.csv"), productSizes);             // par produit  (EU)

    console.log(
      "REST v2 done.",
      `Products scanned=${pCount}, keptEU=${keptProductsEU}; Variants scanned=${vCount}, keptEU=${keptVariantsEU}.`,
      `Final concurrency=${targetConc}`
    );
  } catch (e) {
    console.error("REST failed:", e?.message || e);
    process.exit(1);
  }
})();

// REST (v2 only, EU-only) — hard rate limiter + anti-429 adaptatif, no-retry 4xx (sauf 429)
// Extrait : categories.csv, countries.csv, product_categories.csv, product_prices.csv,
// sizes.csv, availability.csv (EU), prices.csv (EU), product_images.csv (images par variante)
// Produit un rapport : data/_rest_run_report.json et .txt
//
// Env utiles (workflow):
// - PRINTFUL_TOKEN  (obligatoire)
// - PAGE_LIMIT      (1..100; on cappe de toute façon)
// - CONCURRENCY     (concurrence initiale; AIMD + rate limiter global ensuite)
// - EU_ONLY         ("true"/"false"; défaut "true")
// - EU_COUNTRIES    (liste CSV; défaut: UE élargie + GB/NO/CH/IS/LI)
// - LOG_EVERY       (progress logs; défaut 200)
// - STRICT          ("true"/"false"; défaut "true" => exit 1 si erreurs critiques)

import fs from "node:fs";
import path from "node:path";

const API_KEY = process.env.PRINTFUL_TOKEN;
if (!API_KEY) { console.error("Missing PRINTFUL_TOKEN in env."); process.exit(1); }

const RAW_LIMIT = Number.parseInt(process.env.PAGE_LIMIT || "100", 10);
const LIMIT = Math.min(Math.max(isNaN(RAW_LIMIT) ? 100 : RAW_LIMIT, 1), 100); // cap 1..100
const LOG_EVERY = Number.parseInt(process.env.LOG_EVERY || "200", 10);
const INIT_CONC = Number.parseInt(process.env.CONCURRENCY || "8", 10);
const STRICT = (process.env.STRICT ?? "true") === "true";

const BASE_URL = (process.env.BASE_URL || "https://api.printful.com").replace(/\/+$/, "");
const EU_ONLY = (process.env.EU_ONLY ?? "true") === "true";
const EU_COUNTRIES = (process.env.EU_COUNTRIES ??
  "AT,BE,BG,HR,CY,CZ,DK,EE,FI,FR,DE,GR,HU,IE,IT,LV,LT,LU,MT,NL,PL,PT,RO,SK,SI,ES,SE,GB,NO,CH,IS,LI"
).split(",").map(s => s.trim().toUpperCase()).filter(Boolean);

const OUT_DIR = path.resolve("data");
fs.mkdirSync(OUT_DIR, { recursive: true });

// ---------------- Rate limiter global ----------------
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const now = () => Date.now();
const jitter = (ms) => Math.floor(ms * (0.85 + Math.random() * 0.3));

class RateLimiter {
  constructor(minIntervalMs = 500) {
    this.minIntervalMs = minIntervalMs; // intervalle minimal entre DEBUTS de requêtes
    this.nextAt = 0;
  }
  async waitTurn() {
    const n = now();
    if (n < this.nextAt) await sleep(this.nextAt - n);
    this.nextAt = Math.max(this.nextAt, now()) + this.minIntervalMs;
  }
  bumpFromRetryAfter(sec) {
    const ms = Math.ceil(Number(sec) * 1000);
    if (!isNaN(ms) && ms > 0) {
      this.minIntervalMs = Math.max(this.minIntervalMs, ms);
      this.nextAt = now() + this.minIntervalMs;
      console.log(`[rate] set minInterval=${this.minIntervalMs}ms from Retry-After=${sec}s`);
    }
  }
}
const rate = new RateLimiter(500);

// ---------------- Concurrence & anti-429 ----------------
let targetConc = Math.max(2, INIT_CONC);
const MIN_CONC = 1;
const MAX_CONC = Math.max(INIT_CONC, 8);
let active = 0;
let globalPauseUntil = 0;
let successStreak = 0;

const headers = { "Authorization": `Bearer ${API_KEY}`, "User-Agent": "printful-catalog-rest-v2/1.7" };

async function acquireSlot() {
  while (true) {
    const waitMs = globalPauseUntil - now();
    if (waitMs > 0) await sleep(waitMs);
    if (active < targetConc) { active++; return; }
    await sleep(15);
  }
}
function releaseSlot() { active = Math.max(0, active - 1); }
function reduceConcurrency() {
  const old = targetConc; targetConc = Math.max(MIN_CONC, Math.floor(targetConc / 2)); successStreak = 0;
  if (targetConc < old) console.log(`[rate] decrease concurrency ${old} -> ${targetConc}`);
}
function maybeIncreaseConcurrency() {
  if (successStreak >= 200 && targetConc < MAX_CONC) {
    const old = targetConc; targetConc = Math.min(MAX_CONC, targetConc + 1); successStreak = 0;
    console.log(`[rate] increase concurrency ${old} -> ${targetConc}`);
  }
}

async function fetchJsonWithRetry(url, maxRetries = 8, baseBackoff = 1000) {
  for (let a = 0; a <= maxRetries; a++) {
    await acquireSlot();
    try {
      await rate.waitTurn();
      const waitMs = globalPauseUntil - now();
      if (waitMs > 0) await sleep(waitMs);

      const res = await fetch(url, { headers });

      if (res.status === 429) {
        const ra = res.headers.get("retry-after");
        if (ra) rate.bumpFromRetryAfter(Number(ra));
        let wait = ra ? Math.ceil(Number(ra) * 1000) : baseBackoff * (2 ** a);
        wait = jitter(wait);
        globalPauseUntil = now() + wait;
        console.log(`[429] waiting ~${wait}ms (retry-after=${ra || "n/a"}), conc=${targetConc}, active=${active}`);
        reduceConcurrency();
        continue;
      }
      if (res.status >= 500) {
        const wait = jitter(baseBackoff * (2 ** a));
        globalPauseUntil = now() + wait;
        console.log(`[5xx:${res.status}] waiting ~${wait}ms`);
        continue;
      }
      if (!res.ok) {
        const txt = await res.text();
        const err = new Error(`HTTP ${res.status} - ${txt}`);
        if (res.status >= 400 && res.status < 500 && res.status !== 429) err._noRetry = true;
        throw err;
      }

      const json = await res.json();
      successStreak++; maybeIncreaseConcurrency();
      return json;

    } catch (e) {
      if (e?._noRetry) throw e;
      if (a === maxRetries) throw e;
      const wait = jitter(baseBackoff * (2 ** a));
      globalPauseUntil = now() + wait;
      console.log(`[error:${e?.message || e}] backing off ~${wait}ms`);
    } finally {
      releaseSlot();
    }
  }
  throw new Error("fetchJsonWithRetry exhausted");
}

// ---------------- v2 helpers ----------------
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
  let offset = 0;
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

// ---------------- EU helpers ----------------
function isEUCountry(code) { return !!code && EU_COUNTRIES.includes(String(code).toUpperCase()); }
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

// ---------------- CSV ----------------
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

// ---------------- Top-level dumps ----------------
async function dumpCategories() {
  try {
    const rows = await pagedGET("/v2/catalog-categories", LIMIT);
    writeCsv(path.join(OUT_DIR, "categories.csv"), rows);
  } catch (e) {
    console.warn("Warn: catalog-categories failed — writing empty CSV.", e.message || e);
    writeCsv(path.join(OUT_DIR, "categories.csv"), []);
  }
}
async function dumpCountries() {
  try {
    const rows = await pagedGET("/v2/countries", LIMIT);
    writeCsv(path.join(OUT_DIR, "countries.csv"), rows);
  } catch (e) {
    console.warn("Warn: countries failed — writing empty CSV.", e.message || e);
    writeCsv(path.join(OUT_DIR, "countries.csv"), []);
  }
}

// ---------------- Per product / variant ----------------
async function listCatalogProducts() {
  return await pagedGET("/v2/catalog-products", LIMIT);
}
async function listVariantsForProduct(pid) {
  return await pagedGET(`/v2/catalog-products/${encodeURIComponent(pid)}/catalog-variants`, LIMIT);
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

let sizesNoGuideCount = 0;
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
    if (msg.includes("No size guides") || msg.includes("HTTP 404")) { sizesNoGuideCount++; return []; }
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

// ---------------- Main ----------------
(async function main() {
  const startedAt = new Date().toISOString();
  const errors = [];
  const warnings = [];

  try {
    console.log(`REST v2 start — EU_ONLY=${EU_ONLY}, PAGE_LIMIT=${LIMIT} (raw=${RAW_LIMIT}), INIT_CONCURRENCY=${INIT_CONC}`);

    await dumpCategories();
    await dumpCountries();

    const productCategories = [];
    const productPrices = [];
    const productSizes = [];
    const variantImages = [];
    const variantAvailability = [];
    const variantPrices = [];

    const keptProductIds = new Set();
    const keptVariantIds = new Set();

    const products = await listCatalogProducts();
    console.log(`Found ${products.length} catalog products`);

    let pCount = 0, keptProductsEU = 0;
    let vCount = 0, keptVariantsEU = 0;

    for (const p of products) {
      const pid = p?.id ?? p?.product_id ?? p?.catalog_product_id;
      if (pid == null) continue;

      // Variantes du produit
      let variants = [];
      try { variants = await listVariantsForProduct(pid); }
      catch (e) { console.warn(`product ${pid} variants failed:`, e.message || e); }

      // Vérifie EU via availability (déjà filtrée)
      const checked = [];
      for (const v of variants) {
        const vid = v?.id ?? v?.variant_id;
        if (vid == null) continue;
        let avs = [];
        try { avs = await fetchVariantAvailability(vid); } catch { avs = []; }
        const isEU = EU_ONLY ? (avs.length > 0) : true;
        checked.push({ v, vid, avs, isEU });
      }

      const kept = checked.filter(x => x && x.isEU);
      const productHasEU = (!EU_ONLY) || kept.length > 0;

      // Infos produit (cats/prices/sizes) seulement si ≥ 1 variante EU
      if (productHasEU) {
        keptProductsEU++; keptProductIds.add(String(pid));
        try {
          const [pcats, ppr, psz] = await Promise.all([
            fetchProductCategories(pid).catch(e => { warnings.push(`product ${pid} categories failed: ${e.message}`); return []; }),
            fetchProductPrices(pid).catch(e => { warnings.push(`product ${pid} prices failed: ${e.message}`); return []; }),
            fetchProductSizes(pid).catch(e => { warnings.push(`product ${pid} sizes failed: ${e.message}`); return []; }),
          ]);
          productCategories.push(...pcats);
          productPrices.push(...ppr);
          productSizes.push(...psz);
        } catch (e) {
          warnings.push(`product ${pid} meta failed: ${e?.message || e}`);
        }
      }

      // variantes retenues EU : images + prices (+ availability déjà filtrée EU)
      for (const { vid, avs } of kept) {
        try {
          const [imgs, vprs] = await Promise.all([
            fetchVariantImages(vid).catch(e => { warnings.push(`variant ${vid} images failed: ${e.message}`); return []; }),
            fetchVariantPrices(vid).catch(e => { warnings.push(`variant ${vid} prices failed: ${e.message}`); return []; }),
          ]);
          variantAvailability.push(...avs);
          variantImages.push(...imgs);
          variantPrices.push(...vprs);
          keptVariantsEU++; keptVariantIds.add(String(vid));
        } catch (e) {
          warnings.push(`variant ${vid} meta failed: ${e?.message || e}`);
        }
        vCount++;
        if (vCount % LOG_EVERY === 0) {
          console.log(`...variants processed=${vCount}, keptEU=${keptVariantsEU}, minInterval=${(rate.minIntervalMs||0)}ms, conc=${targetConc}, active=${active}`);
        }
      }

      pCount++;
      if (pCount % Math.max(1, Math.floor(LOG_EVERY / 5)) === 0) {
        console.log(`...products processed=${pCount}, keptEU=${keptProductsEU}, minInterval=${(rate.minIntervalMs||0)}ms, conc=${targetConc}, active=${active}`);
      }
    }

    // Écritures CSV
    const files = {
      categories: path.join(OUT_DIR, "categories.csv"),
      countries: path.join(OUT_DIR, "countries.csv"),
      product_categories: path.join(OUT_DIR, "product_categories.csv"),
      product_prices: path.join(OUT_DIR, "product_prices.csv"),
      sizes: path.join(OUT_DIR, "sizes.csv"),
      availability: path.join(OUT_DIR, "availability.csv"),
      variant_prices: path.join(OUT_DIR, "prices.csv"),
      product_images: path.join(OUT_DIR, "product_images.csv"),
    };

    function countRows(arr) { return Array.isArray(arr) ? arr.length : 0; }

    writeCsv(files.product_categories, productCategories);
    writeCsv(files.product_images, variantImages);
    writeCsv(files.availability, variantAvailability);
    writeCsv(files.variant_prices, variantPrices);
    writeCsv(files.product_prices, productPrices);
    writeCsv(files.sizes, productSizes);

    // ---------------- Contrôles de complétude ----------------
    const endedAt = new Date().toISOString();

    // Charger les compteurs de categories/countries écrits au début
    const readCsvCount = (filePath) => {
      try {
        const txt = fs.readFileSync(filePath, "utf8");
        const lines = txt.split(/\r?\n/).filter(Boolean);
        return Math.max(0, lines.length - (lines.length > 0 ? 1 : 0)); // - header si présent
      } catch { return 0; }
    };

    const counts = {
      categories: readCsvCount(files.categories),
      countries: readCsvCount(files.countries),
      product_categories: countRows(productCategories),
      product_prices: countRows(productPrices),
      sizes: countRows(productSizes),
      availability: countRows(variantAvailability),
      variant_prices: countRows(variantPrices),
      product_images: countRows(variantImages),
      kept_products_eu: keptProductIds.size,
      kept_variants_eu: keptVariantIds.size,
      sizes_no_guide: sizesNoGuideCount,
    };

    // 1) Critiques : ces jeux doivent être non vides
    if (counts.categories === 0) errors.push("categories.csv est vide");
    if (counts.countries === 0) errors.push("countries.csv est vide");
    if (counts.kept_products_eu === 0) errors.push("Aucun produit EU retenu");
    if (counts.kept_variants_eu === 0) errors.push("Aucune variante EU retenue");
    if (counts.availability === 0) errors.push("availability.csv est vide (EU)");

    // 2) Cohérence : chaque variante EU doit avoir ≥1 dispo EU enregistrée
    const availVariantIds = new Set(variantAvailability.map(r => String(r.variant_id ?? "")));
    const missingAvail = [];
    for (const vid of keptVariantIds) {
      if (!availVariantIds.has(String(vid))) missingAvail.push(vid);
    }
    if (missingAvail.length > 0) {
      errors.push(`Disponibilité manquante pour ${missingAvail.length} variantes EU`);
    }

    // 3) Non critique : images/prices peuvent être absents pour certaines variantes/prods
    //    On l'indique en warning informatif
    const imageVariantIds = new Set(variantImages.map(r => String(r.variant_id ?? "")));
    const priceVariantIds = new Set(variantPrices.map(r => String(r.variant_id ?? "")));
    const variantsWithoutImages = [];
    const variantsWithoutPrices = [];
    for (const vid of keptVariantIds) {
      if (!imageVariantIds.has(vid)) variantsWithoutImages.push(vid);
      if (!priceVariantIds.has(vid)) variantsWithoutPrices.push(vid);
    }
    if (variantsWithoutImages.length > 0) warnings.push(`${variantsWithoutImages.length} variantes EU sans images`);
    if (variantsWithoutPrices.length > 0) warnings.push(`${variantsWithoutPrices.length} variantes EU sans prices`);

    // Rapport
    const report = {
      startedAt, endedAt,
      base_url: BASE_URL, eu_only: EU_ONLY,
      page_limit_raw: RAW_LIMIT, page_limit_effective: LIMIT,
      rate_min_interval_ms: rate.minIntervalMs,
      concurrency_final: targetConc,
      counts,
      errors,
      warnings,
    };
    const reportJson = path.join(OUT_DIR, "_rest_run_report.json");
    const reportTxt = path.join(OUT_DIR, "_rest_run_report.txt");
    fs.writeFileSync(reportJson, JSON.stringify(report, null, 2), "utf8");
    fs.writeFileSync(
      reportTxt,
      [
        `REST v2 report`,
        `Started: ${startedAt}`,
        `Ended:   ${endedAt}`,
        `EU_ONLY: ${EU_ONLY}`,
        `Limit:   raw=${RAW_LIMIT} effective=${LIMIT}`,
        `Rate:    minInterval=${rate.minIntervalMs}ms, final concurrency=${targetConc}`,
        ``,
        `Counts:`,
        `- categories.csv        : ${counts.categories}`,
        `- countries.csv         : ${counts.countries}`,
        `- product_categories.csv: ${counts.product_categories}`,
        `- product_prices.csv    : ${counts.product_prices}`,
        `- sizes.csv             : ${counts.sizes} (no guide: ${counts.sizes_no_guide})`,
        `- availability.csv (EU) : ${counts.availability}`,
        `- prices.csv (EU)       : ${counts.variant_prices}`,
        `- product_images.csv    : ${counts.product_images}`,
        `- kept products (EU)    : ${counts.kept_products_eu}`,
        `- kept variants (EU)    : ${counts.kept_variants_eu}`,
        ``,
        `Errors (${errors.length}) :`,
        ...(errors.length ? errors.map(e => `  - ${e}`) : ["  (none)"]),
        `Warnings (${warnings.length}):`,
        ...(warnings.length ? warnings.map(w => `  - ${w}`) : ["  (none)"]),
        ``,
      ].join("\n"),
      "utf8"
    );

    console.log(`\n=== RUN SUMMARY ===`);
    console.log(fs.readFileSync(reportTxt, "utf8"));

    if (STRICT && errors.length > 0) {
      console.error("REST completed with critical errors — failing as STRICT=true");
      process.exit(1);
    }

    console.log("REST v2 done (strict mode:", STRICT, ").");
  } catch (e) {
    console.error("REST failed:", e?.message || e);
    process.exit(1);
  }
})();

// Single-collection collector (v2, EU-only option, product-level availability)
// Collections supportées (COLLECTION, une seule) :
//   - categories            -> data/categories.csv
//   - countries             -> data/countries.csv
//   - availability          -> data/availability.csv (EU filtrée si EU_ONLY=true) + écrit cache EU
//   - prices                -> data/prices.csv         (par variante)
//   - product_images        -> data/product_images.csv (images par variante)
//   - product_categories    -> data/product_categories.csv
//   - product_prices        -> data/product_prices.csv
//   - sizes                 -> data/sizes.csv
//   - products              -> data/products.csv
//   - variants              -> data/variants.csv
//
// Robustesse : rate limiter global + backoff, cap limit 1..100, EU_ONLY par défaut, STRICT checks, logs.
// Availability : /v2/catalog-products/{id}/availability?selling_region_name=europe (ou all)
//
// Env requis : PRINTFUL_TOKEN
// Env optionnels : BASE_URL, COLLECTION, PAGE_LIMIT, CONCURRENCY, EU_ONLY, AV_REGION, EU_REGION_NAMES,
//                  USE_EU_CACHE, STRICT, LOG_EVERY, EU_COUNTRIES

import fs from "node:fs";
import path from "node:path";

// --------- Env & options
const API_KEY = process.env.PRINTFUL_TOKEN;
if (!API_KEY) { console.error("Missing PRINTFUL_TOKEN in env."); process.exit(1); }

const BASE_URL = (process.env.BASE_URL || "https://api.printful.com").replace(/\/+$/, "");
const COLLECTION = (process.env.COLLECTION || "availability").toLowerCase().trim();

const RAW_LIMIT = Number.parseInt(process.env.PAGE_LIMIT || "100", 10);
const LIMIT = Math.min(Math.max(isNaN(RAW_LIMIT) ? 100 : RAW_LIMIT, 1), 100); // cap 1..100
const INIT_CONC = Number.parseInt(process.env.CONCURRENCY || "8", 10);
const LOG_EVERY = Number.parseInt(process.env.LOG_EVERY || "200", 10);

const EU_ONLY = (process.env.EU_ONLY ?? "true") === "true";
const USE_EU_CACHE = (process.env.USE_EU_CACHE ?? "true") === "true";
const STRICT = (process.env.STRICT ?? "true") === "true";

// Availability options
const AV_REGION = (process.env.AV_REGION || "europe").toLowerCase(); // "europe" | "all"
const EU_REGION_NAMES = (process.env.EU_REGION_NAMES || "europe,uk,france,germany,italy,spain,latvia")
  .split(",").map(s => s.trim().toLowerCase()).filter(Boolean);

const EU_COUNTRIES = (process.env.EU_COUNTRIES ??
  "AT,BE,BG,HR,CY,CZ,DK,EE,FI,FR,DE,GR,HU,IE,IT,LV,LT,LU,MT,NL,PL,PT,RO,SK,SI,ES,SE,GB,NO,CH,IS,LI"
).split(",").map(s => s.trim().toUpperCase()).filter(Boolean);

const OUT_DIR = path.resolve("data");
fs.mkdirSync(OUT_DIR, { recursive: true });

// Valid collections set (accept aliases)
const VALID = new Map([
  ["categories", "categories"],
  ["countries", "countries"],
  ["availability", "availability"],
  ["prices", "prices"],                 // variant prices
  ["variant_prices", "prices"],
  ["product_images", "product_images"], // images per variant
  ["variant_images", "product_images"],
  ["product_categories", "product_categories"],
  ["product_prices", "product_prices"],
  ["sizes", "sizes"],
  ["products", "products"],
  ["variants", "variants"],
]);

const SELECTED = VALID.get(COLLECTION) || null;
if (!SELECTED) {
  console.error(`Unknown COLLECTION="${COLLECTION}". Allowed: ${Array.from(VALID.keys()).join(", ")}`);
  process.exit(1);
}

// EU cache files
const EU_PROD_JSON = path.join(OUT_DIR, "_eu_product_ids.json");
const EU_PROD_TXT  = path.join(OUT_DIR, "_eu_product_ids.txt");
const EU_VAR_JSON  = path.join(OUT_DIR, "_eu_variant_ids.json");
const EU_VAR_TXT   = path.join(OUT_DIR, "_eu_variant_ids.txt");

function readIdSet(jsonPath, txtPath) {
  try {
    if (fs.existsSync(jsonPath)) {
      const arr = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
      return new Set(arr.map(v => String(v)));
    }
    if (fs.existsSync(txtPath)) {
      const arr = fs.readFileSync(txtPath, "utf8").split(/\r?\n/).map(s => s.trim()).filter(Boolean);
      return new Set(arr.map(v => String(v)));
    }
  } catch {}
  return null;
}
function writeIdSet(set, jsonPath, txtPath) {
  const arr = Array.from(set);
  fs.writeFileSync(jsonPath, JSON.stringify(arr, null, 2), "utf8");
  fs.writeFileSync(txtPath, arr.join("\n") + "\n", "utf8");
}

// --------- Rate limiter & fetch with retry
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const now = () => Date.now();
const jitter = (ms) => Math.floor(ms * (0.85 + Math.random() * 0.3));

class RateLimiter {
  constructor(minIntervalMs = 500) {
    this.minIntervalMs = minIntervalMs;
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

let targetConc = Math.max(2, INIT_CONC);
const MIN_CONC = 1;
const MAX_CONC = Math.max(targetConc, 8);
let active = 0;
let globalPauseUntil = 0;
let successStreak = 0;

const headers = { "Authorization": `Bearer ${API_KEY}`, "User-Agent": "printful-collection-v2/1.1" };

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

// --------- helpers v2 & CSV
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

// --------- EU utils
function isEUCountry(code) { return !!code && EU_COUNTRIES.includes(String(code).toUpperCase()); }

// --------- API helpers (product/variant)
async function listCatalogProducts() {
  return await pagedGET("/v2/catalog-products", LIMIT);
}
async function pagedVariantsForProduct(pid) {
  return await pagedGET(`/v2/catalog-products/${encodeURIComponent(pid)}/catalog-variants`, LIMIT);
}
async function fetchProductCategories(pid) {
  const json = await fetchJsonWithRetry(`${BASE_URL}/v2/catalog-products/${encodeURIComponent(pid)}/catalog-categories`);
  const { items } = parseItemsAndPaging(json);
  return items.map(it => ({ product_id: pid, ...it }));
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

// --------- Availability (product-level)
async function fetchProductAvailability(pid, region = AV_REGION) {
  const q = region ? `?selling_region_name=${encodeURIComponent(region)}` : "";
  const url = `${BASE_URL}/v2/catalog-products/${encodeURIComponent(pid)}/availability${q}`;
  const json = await fetchJsonWithRetry(url);
  const { items } = parseItemsAndPaging(json);
  return items || [];
}

function hasEUAvailability(item) {
  // item: { catalog_variant_id, techniques: [{ technique, selling_regions: [{ name, availability, placement_option_availability: [...] }]}]}
  const techs = Array.isArray(item?.techniques) ? item.techniques : [];
  for (const t of techs) {
    const regs = Array.isArray(t?.selling_regions) ? t.selling_regions : [];
    for (const r of regs) {
      const name = String(r?.name || "").toLowerCase();
      if (AV_REGION === "europe") {
        const a = String(r?.availability || "").toLowerCase();
        if (name === "europe" && a !== "not available") return true;
      } else {
        if (EU_REGION_NAMES.includes(name)) {
          const a = String(r?.availability || "").toLowerCase();
          if (a !== "not available") return true;
          if (Array.isArray(r?.placement_option_availability) && r.placement_option_availability.some(po => !!po?.availability)) {
            return true;
          }
        }
      }
    }
  }
  return false;
}

function flattenEUAvailability(item) {
  const rows = [];
  const vid = item?.catalog_variant_id ?? item?.variant_id;
  if (!vid) return rows;

  const techs = Array.isArray(item?.techniques) ? item.techniques : [];
  for (const t of techs) {
    const regs = Array.isArray(t?.selling_regions) ? t.selling_regions : [];
    for (const r of regs) {
      const name = String(r?.name || "");
      const lname = name.toLowerCase();
      const isEU = AV_REGION === "europe" ? (lname === "europe") : EU_REGION_NAMES.includes(lname);
      if (!isEU) continue;

      rows.push({
        variant_id: vid,
        technique: t?.technique ?? null,
        region: name,
        availability: r?.availability ?? null,
        placement_option_availability: r?.placement_option_availability ?? null
      });
    }
  }
  return rows;
}

// --------- EU discovery (scan) if needed — via product availability
async function discoverEUIds() {
  const euProd = new Set();
  const euVar = new Set();
  const availabilityRows = []; // rempli seulement si SELECTED === "availability"

  const products = await listCatalogProducts();
  console.log(`Found ${products.length} catalog products`);

  let pCount = 0, keptP = 0, keptV = 0;

  for (const p of products) {
    const pid = p?.id ?? p?.product_id ?? p?.catalog_product_id;
    if (pid == null) continue;

    let avItems = [];
    try {
      avItems = await fetchProductAvailability(pid, AV_REGION);
    } catch (e) {
      console.warn(`product ${pid} availability failed:`, e.message || e);
      avItems = [];
    }

    let anyEU = false;
    for (const it of avItems) {
      const vid = it?.catalog_variant_id ?? it?.variant_id;
      if (!vid) continue;

      const isEU = EU_ONLY ? hasEUAvailability(it) : true;
      if (isEU) {
        anyEU = true;
        euVar.add(String(vid));
        keptV++;
        if (SELECTED === "availability") {
          availabilityRows.push(...flattenEUAvailability(it));
        }
      }
    }

    if (!EU_ONLY || anyEU) {
      euProd.add(String(pid));
      keptP++;
    }

    pCount++;
    if (pCount % Math.max(1, Math.floor(LOG_EVERY / 5)) === 0) {
      console.log(`...products scanned=${pCount}, keptEU=${keptP}`);
    }
  }

  return { euProd, euVar, availabilityRows };
}

// --------- Main (per collection)
(async function main() {
  const startedAt = new Date().toISOString();
  const warnings = [];
  const counts = {};
  let usedCache = false;

  try {
    console.log(`Collector start — collection=${SELECTED}, EU_ONLY=${EU_ONLY}, PAGE_LIMIT=${LIMIT} (raw=${RAW_LIMIT}), INIT_CONC=${INIT_CONC}`);
    console.log(`Availability: AV_REGION=${AV_REGION}${AV_REGION === "all" ? `, EU_REGION_NAMES=[${EU_REGION_NAMES.join(", ")}]` : ""}`);

    const file = {
      categories:       path.join(OUT_DIR, "categories.csv"),
      countries:        path.join(OUT_DIR, "countries.csv"),
      availability:     path.join(OUT_DIR, "availability.csv"),
      prices:           path.join(OUT_DIR, "prices.csv"),            // variant prices
      product_images:   path.join(OUT_DIR, "product_images.csv"),
      product_categories:path.join(OUT_DIR, "product_categories.csv"),
      product_prices:   path.join(OUT_DIR, "product_prices.csv"),
      sizes:            path.join(OUT_DIR, "sizes.csv"),
      products:         path.join(OUT_DIR, "products.csv"),
      variants:         path.join(OUT_DIR, "variants.csv"),
    };

    // Simple ones
    if (SELECTED === "categories") {
      const rows = await pagedGET("/v2/catalog-categories", LIMIT);
      writeCsv(file.categories, rows);
      counts.categories = rows.length;
    }
    else if (SELECTED === "countries") {
      const rows = await pagedGET("/v2/countries", LIMIT);
      writeCsv(file.countries, rows);
      counts.countries = rows.length;
    }
    else {
      // Collections nécessitant produits/variantes
      let euProd = null, euVar = null, availabilityRows = null;

      if (USE_EU_CACHE) {
        const pCache = readIdSet(EU_PROD_JSON, EU_PROD_TXT);
        const vCache = readIdSet(EU_VAR_JSON, EU_VAR_TXT);
        if (pCache && vCache) {
          euProd = pCache; euVar = vCache; usedCache = true;
          console.log(`EU cache loaded: products=${euProd.size}, variants=${euVar.size}`);
        }
      }

      // Si pas de cache, ou si on veut availability (toujours reconstruit), on (re)scanne via availability produit
      if (!euProd || !euVar || SELECTED === "availability") {
        ({ euProd, euVar, availabilityRows } = await discoverEUIds());
        if (EU_ONLY && USE_EU_CACHE) {
          writeIdSet(euProd, EU_PROD_JSON, EU_PROD_TXT);
          writeIdSet(euVar, EU_VAR_JSON, EU_VAR_TXT);
          console.log(`EU cache saved: products=${euProd.size}, variants=${euVar.size}`);
        }
      }

      if (SELECTED === "availability") {
        writeCsv(file.availability, availabilityRows || []);
        counts.availability = (availabilityRows || []).length;
      }
      else if (SELECTED === "product_images") {
        const out = [];
        for (const vid of euVar) {
          try { out.push(...await fetchVariantImages(vid)); }
          catch (e) { warnings.push(`variant ${vid} images failed: ${e.message}`); }
          if (out.length % LOG_EVERY === 0) {
            console.log(`...images collected=${out.length}`);
          }
        }
        writeCsv(file.product_images, out);
        counts.product_images = out.length;
      }
      else if (SELECTED === "prices") {
        const out = [];
        for (const vid of euVar) {
          try { out.push(...await fetchVariantPrices(vid)); }
          catch (e) { warnings.push(`variant ${vid} prices failed: ${e.message}`); }
          if (out.length % LOG_EVERY === 0) {
            console.log(`...variant prices collected=${out.length}`);
          }
        }
        writeCsv(file.prices, out);
        counts.prices = out.length;
      }
      else if (SELECTED === "product_categories" || SELECTED === "product_prices" || SELECTED === "sizes") {
        const prods = Array.from(euProd);
        const out = [];
        for (const pid of prods) {
          try {
            if (SELECTED === "product_categories") out.push(...await fetchProductCategories(pid));
            if (SELECTED === "product_prices")    out.push(...await fetchProductPrices(pid));
            if (SELECTED === "sizes")             out.push(...await fetchProductSizes(pid));
          } catch (e) {
            warnings.push(`product ${pid} ${SELECTED} failed: ${e.message}`);
          }
          if (out.length % LOG_EVERY === 0) console.log(`...${SELECTED} collected=${out.length}`);
        }
        const target = SELECTED === "product_categories" ? file.product_categories
                    : SELECTED === "product_prices"    ? file.product_prices
                    : file.sizes;
        writeCsv(target, out);
        counts[SELECTED] = out.length;
      }
      else if (SELECTED === "products") {
        const products = await listCatalogProducts();
        const rows = [];
        for (const p of products) {
          const pid = p?.id ?? p?.product_id ?? p?.catalog_product_id;
          if (pid == null) continue;
          if (!EU_ONLY || euProd.has(String(pid))) rows.push(p);
        }
        writeCsv(file.products, rows);
        counts.products = rows.length;
      }
      else if (SELECTED === "variants") {
        const products = await listCatalogProducts();
        const rows = [];
        let vCount = 0;
        for (const p of products) {
          const pid = p?.id ?? p?.product_id ?? p?.catalog_product_id;
          if (pid == null) continue;
          const vs = await pagedVariantsForProduct(pid);
          for (const v of vs) {
            const vid = v?.id ?? v?.variant_id;
            if (vid == null) continue;
            if (!EU_ONLY || euVar.has(String(vid))) {
              const row = (typeof v === "object") ? { ...v } : { value: v };
              if (row.product_id == null) row.product_id = pid;
              rows.push(row);
            }
            vCount++;
            if (vCount % LOG_EVERY === 0) console.log(`...variants iterated=${vCount}, kept=${rows.length}`);
          }
        }
        writeCsv(file.variants, rows);
        counts.variants = rows.length;
      }
    }

    // ---- Checks (STRICT) & report
    const endedAt = new Date().toISOString();
    const errorsCrit = [];
    if (SELECTED === "categories" && (!counts.categories || counts.categories === 0)) errorsCrit.push("categories.csv est vide");
    if (SELECTED === "countries"  && (!counts.countries  || counts.countries  === 0)) errorsCrit.push("countries.csv est vide");
    if (SELECTED === "availability" && (!counts.availability || counts.availability === 0)) errorsCrit.push("availability.csv est vide (EU)");
    if (SELECTED === "product_images" && (!counts.product_images || counts.product_images === 0)) warnings.push("Aucune image de variante récupérée");
    if (SELECTED === "prices" && (!counts.prices || counts.prices === 0)) warnings.push("Aucun price de variante récupéré");
    if (SELECTED === "product_categories" && (!counts.product_categories || counts.product_categories === 0)) warnings.push("product_categories.csv vide");
    if (SELECTED === "product_prices" && (!counts.product_prices || counts.product_prices === 0)) warnings.push("product_prices.csv vide");
    if (SELECTED === "sizes" && (!counts.sizes || counts.sizes === 0)) warnings.push("sizes.csv vide (size guides absents)");
    if (SELECTED === "products" && (!counts.products || counts.products === 0)) errorsCrit.push("products.csv est vide");
    if (SELECTED === "variants" && (!counts.variants || counts.variants === 0)) errorsCrit.push("variants.csv est vide");

    const report = {
      startedAt, endedAt,
      base_url: BASE_URL,
      collection: SELECTED,
      eu_only: EU_ONLY,
      av_region: AV_REGION,
      eu_region_names: AV_REGION === "all" ? EU_REGION_NAMES : undefined,
      page_limit_raw: RAW_LIMIT, page_limit_effective: LIMIT,
      rate_min_interval_ms: rate.minIntervalMs,
      concurrency_final: targetConc,
      used_eu_cache: usedCache,
      counts, warnings, errors: errorsCrit,
    };
    const reportJson = path.join(OUT_DIR, `_run_report_${SELECTED}.json`);
    const reportTxt  = path.join(OUT_DIR, `_run_report_${SELECTED}.txt`);
    fs.writeFileSync(reportJson, JSON.stringify(report, null, 2), "utf8");
    fs.writeFileSync(
      reportTxt,
      [
        `Collection: ${SELECTED}`,
        `Started: ${startedAt}`,
        `Ended:   ${endedAt}`,
        `EU_ONLY: ${EU_ONLY}`,
        `AV_REGION: ${AV_REGION}${AV_REGION === "all" ? ` (EU_REGION_NAMES=[${EU_REGION_NAMES.join(", ")}])` : ""}`,
        `Limit:   raw=${RAW_LIMIT} effective=${LIMIT}`,
        `Rate:    minInterval=${rate.minIntervalMs}ms, final concurrency=${targetConc}`,
        `EU cache used: ${usedCache}`,
        ``,
        `Counts:`,
        ...(Object.entries(counts).map(([k,v]) => `- ${k}: ${v}`)),
        ``,
        `Errors (${errorsCrit.length}) :`,
        ...(errorsCrit.length ? errorsCrit.map(e => `  - ${e}`) : ["  (none)"]),
        `Warnings (${warnings.length}):`,
        ...(warnings.length ? warnings.map(w => `  - ${w}`) : ["  (none)"]),
        ``,
      ].join("\n"),
      "utf8"
    );
    console.log("\n=== RUN SUMMARY ===\n" + fs.readFileSync(reportTxt, "utf8"));

    if (STRICT && errorsCrit.length > 0) {
      console.error("Run completed with critical errors — failing as STRICT=true");
      process.exit(1);
    }

    console.log(`Done: ${SELECTED}`);
  } catch (e) {
    console.error("Collector failed:", e?.message || e);
    process.exit(1);
  }
})();

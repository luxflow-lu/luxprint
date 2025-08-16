// CORE (v2): products & variants, EU_ONLY option, cap limit 1..100, no-retry sur 400

import fs from "node:fs";
import path from "node:path";

const API_KEY = process.env.PRINTFUL_TOKEN;
if (!API_KEY) { console.error("Missing PRINTFUL_TOKEN in env."); process.exit(1); }

const RAW_LIMIT = Number.parseInt(process.env.PAGE_LIMIT || "100", 10);
const LIMIT = Math.min(Math.max(isNaN(RAW_LIMIT) ? 100 : RAW_LIMIT, 1), 100); // <- cap
const LOG_EVERY = Number.parseInt(process.env.LOG_EVERY || "200", 10);
const EU_ONLY = (process.env.EU_ONLY ?? "true") === "true";

const BASE_URL = (process.env.BASE_URL || "https://api.printful.com").replace(/\/+$/, "");
const OUT_DIR = path.resolve("data");
const CKPT_DIR = path.resolve(".checkpoints");
fs.mkdirSync(OUT_DIR, { recursive: true });
fs.mkdirSync(CKPT_DIR, { recursive: true });

const CKPT_PRODUCTS = path.join(CKPT_DIR, "core_v2_catalog-products.json");

const headers = { "Authorization": `Bearer ${API_KEY}`, "User-Agent": "printful-catalog-core-v2/1.3" };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const EU_COUNTRIES = (process.env.EU_COUNTRIES ??
  "AT,BE,BG,HR,CY,CZ,DK,EE,FI,FR,DE,GR,HU,IE,IT,LV,LT,LU,MT,NL,PL,PT,RO,SK,SI,ES,SE,GB,NO,CH,IS,LI"
).split(",").map(s => s.trim().toUpperCase()).filter(Boolean);
const isEUCountry = (c) => !!c && EU_COUNTRIES.includes(String(c).toUpperCase());

async function fetchJsonWithRetry(url, maxRetries = 8, backoff = 1000) {
  for (let a = 0; a <= maxRetries; a++) {
    try {
      const res = await fetch(url, { headers });
      if (res.status === 429) {
        const ra = res.headers.get("retry-after");
        const wait = ra ? Math.ceil(Number(ra) * 1000) : backoff * (2 ** a);
        console.log(`429 received, waiting ${wait}ms`);
        await sleep(wait); continue;
      }
      if (res.status >= 500) {
        const wait = backoff * (2 ** a);
        console.log(`5xx received, waiting ${wait}ms`);
        await sleep(wait); continue;
      }
      if (!res.ok) {
        const txt = await res.text();
        const err = new Error(`HTTP ${res.status} - ${txt}`);
        if (res.status >= 400 && res.status < 500 && res.status !== 429) err._noRetry = true;
        throw err;
      }
      return await res.json();
    } catch (e) {
      if (e?._noRetry) throw e;
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
    const items = Array.isArray(payload.data) ? payload.data : (payload.data ? [payload.data] : []);
    return { items, paging: payload.paging || null };
  }
  if ("result" in payload) {
    const r = payload.result;
    const items = Array.isArray(r) ? r : (r?.items ?? (r ? [r] : []));
    return { items, paging: payload.paging || null };
  }
  return { items: [], paging: null };
}

function writeCsv(filePath, rows) {
  const set = new Set(); rows.forEach(r => Object.keys(r).forEach(k => set.add(k)));
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

function loadProductOffset() {
  try { if (fs.existsSync(CKPT_PRODUCTS)) {
    const j = JSON.parse(fs.readFileSync(CKPT_PRODUCTS, "utf8"));
    return Number(j.product_offset || 0) || 0;
  }} catch {}
  return 0;
}
function saveProductOffset(off) {
  fs.writeFileSync(CKPT_PRODUCTS, JSON.stringify({ product_offset: off }), "utf8");
}

async function* pageProducts(limit, start = 0) {
  let offset = start;
  while (true) {
    const url = `${BASE_URL}/v2/catalog-products?limit=${limit}&offset=${offset}`;
    const json = await fetchJsonWithRetry(url);
    const { items, paging } = parseItemsAndPaging(json);
    const fetched = items.length;
    yield { items, offset, fetched };
    offset += fetched;
    if (!paging || typeof paging.total !== "number" || fetched === 0 || offset >= paging.total) break;
  }
}

async function pagedVariantsForProduct(pid, limit) {
  const rows = []; let offset = 0;
  while (true) {
    const url = `${BASE_URL}/v2/catalog-products/${encodeURIComponent(pid)}/catalog-variants?limit=${limit}&offset=${offset}`;
    const json = await fetchJsonWithRetry(url);
    const { items, paging } = parseItemsAndPaging(json);
    rows.push(...items);
    const fetched = items.length; offset += fetched;
    if (!paging || typeof paging.total !== "number" || fetched === 0 || offset >= paging.total) break;
  }
  return rows;
}

async function isVariantEU(vid) {
  if (!EU_ONLY) return true;
  try {
    const json = await fetchJsonWithRetry(`${BASE_URL}/v2/catalog-variants/${encodeURIComponent(vid)}/availability`);
    const { items } = parseItemsAndPaging(json);
    const arr = Array.isArray(items) ? items : (items ? [items] : []);
    for (const it of arr) {
      if (isEUCountry(it?.country_code)) return true;
      if (Array.isArray(it?.countries) && it.countries.some(isEUCountry)) return true;
      if (Array.isArray(it?.country_codes) && it.country_codes.some(isEUCountry)) return true;
      if (typeof it?.region === "string" && it.region.toUpperCase() === "EU") return true;
    }
    return false;
  } catch { return false; }
}

(async function main() {
  try {
    console.log(`CORE v2 start — EU_ONLY=${EU_ONLY}, PAGE_LIMIT=${LIMIT} (raw=${RAW_LIMIT})`);
    const productsOut = [];
    const variantsOut = [];

    let startOffset = loadProductOffset();
    let pCount = 0, keptProductsEU = 0, vCount = 0, keptVariantsEU = 0;

    for await (const { items: products, offset, fetched } of pageProducts(LIMIT, startOffset)) {
      if (fetched === 0) break;

      for (const p of products) {
        const prodRow = (typeof p === "object") ? { ...p } : { value: p };
        const pid = prodRow.id ?? prodRow.product_id ?? prodRow.catalog_product_id;
        if (pid == null) continue;

        let variants = [];
        try { variants = await pagedVariantsForProduct(pid, LIMIT); }
        catch (e) { console.warn(`Warn: variants for product ${pid} failed:`, e?.message || e); }

        if (!EU_ONLY) {
          productsOut.push(prodRow); keptProductsEU++;
          for (const v of variants) {
            const row = (typeof v === "object") ? { ...v } : { value: v };
            if (row.product_id == null) row.product_id = pid;
            variantsOut.push(row);
          }
          vCount += variants.length; keptVariantsEU += variants.length;
        } else {
          let productHasEU = false;
          for (const v of variants) {
            const vid = v?.id ?? v?.variant_id;
            if (vid == null) continue;
            const ok = await isVariantEU(vid);
            vCount++;
            if (ok) {
              productHasEU = true;
              const row = (typeof v === "object") ? { ...v } : { value: v };
              if (row.product_id == null) row.product_id = pid;
              variantsOut.push(row);
              keptVariantsEU++;
            }
            if (vCount % LOG_EVERY === 0) console.log(`...variants processed=${vCount}, keptEU=${keptVariantsEU}`);
          }
          if (productHasEU) { productsOut.push(prodRow); keptProductsEU++; }
        }
      }

      const nextOffset = offset + fetched;
      saveProductOffset(nextOffset);
      pCount += fetched;
      console.log(`...products processed=${pCount}, keptEU=${keptProductsEU}`);
    }

    writeCsv(path.join(OUT_DIR, "products.csv"), productsOut);
    writeCsv(path.join(OUT_DIR, "variants.csv"), variantsOut);

    console.log("CORE v2 done.",
      `Products keptEU=${keptProductsEU}/${pCount}, Variants keptEU=${keptVariantsEU}/${vCount}`
    );
  } catch (e) {
    console.error("CORE v2 failed:", e?.message || e);
    process.exit(1);
  }
})();

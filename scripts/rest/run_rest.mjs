// REST (v2): categories, countries + agrégations par produit/variante:
// - product_categories.csv via /v2/catalog-products/{id}/catalog-categories
// - product_images.csv via /v2/catalog-variants/{id}/images
// - availability.csv   via /v2/catalog-variants/{id}/availability
// - prices.csv         via /v2/catalog-variants/{id}/prices
// - product_prices.csv via /v2/catalog-products/{id}/prices
// Peut tourner AVANT CORE (on parcourt /v2/catalog-products).
// Auth: PRINTFUL_TOKEN (Bearer)

import fs from "node:fs";
import path from "node:path";

const API_KEY = process.env.PRINTFUL_TOKEN;
if (!API_KEY) { console.error("Missing PRINTFUL_TOKEN in env."); process.exit(1); }

const BASE_URL = (process.env.BASE_URL || "https://api.printful.com").replace(/\/+$/, "");
const LIMIT = Number.parseInt(process.env.PAGE_LIMIT || "100", 10);
const OUT_DIR = path.resolve("data");
fs.mkdirSync(OUT_DIR, { recursive: true });

const headers = {
  "Authorization": `Bearer ${API_KEY}`,
  // Vous pouvez passer la langue si utile: "X-PF-Language": "en",
  "User-Agent": "printful-catalog-rest-v2/1.0"
};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function fetchJsonWithRetry(url, maxRetries = 8, backoff = 1000) {
  for (let a = 0; a <= maxRetries; a++) {
    try {
      const res = await fetch(url, { headers });
      if (res.status === 429) {
        const ra = res.headers.get("retry-after");
        const wait = ra ? Math.ceil(Number(ra) * 1000) : backoff * (2 ** a);
        await sleep(wait); continue;
      }
      if (res.status >= 500) { await sleep(backoff * (2 ** a)); continue; }
      if (!res.ok) throw new Error(`HTTP ${res.status} - ${await res.text()}`);
      return await res.json();
    } catch (e) {
      if (a === maxRetries) throw e;
      await sleep(backoff * (2 ** a));
    }
  }
  throw new Error("fetchJsonWithRetry exhausted");
}

// Helpers v1/v2 : renvoie {items[], paging|null}
function parseItemsAndPaging(payload) {
  if (!payload) return { items: [], paging: null };
  // v2
  if (Array.isArray(payload.data) || typeof payload.data === "object") {
    const items = Array.isArray(payload.data) ? payload.data : [payload.data];
    return { items, paging: payload.paging || null };
  }
  // v1 (fallback)
  if (payload.result !== undefined) {
    const res = payload.result;
    const items = Array.isArray(res) ? res : (res?.items ?? (res ? [res] : []));
    return { items, paging: payload.paging || null };
  }
  return { items: [], paging: null };
}

async function pagedGET(pathname, limit = LIMIT, startOffset = 0) {
  let offset = startOffset;
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

// CSV writer (json flattish)
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

// ----- Top-level v2 collections: categories & countries ----------------------
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
    writeCsv(path.join(

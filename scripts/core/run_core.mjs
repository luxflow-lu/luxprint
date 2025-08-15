// CORE (v2 only): /v2/catalog-products + /v2/catalog-products/{id}/catalog-variants
// - Pagine les produits (limit=PAGE_LIMIT, offset)
// - Pour chaque produit, pagine ses variantes
// - Ecrit data/products.csv et data/variants.csv
// - Checkpoint: reprend au prochain offset produit si le job s'arrête
// - Auth: PRINTFUL_TOKEN

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
const CKPT_DIR = path.resolve(".checkpoints");
fs.mkdirSync(OUT_DIR, { recursive: true });
fs.mkdirSync(CKPT_DIR, { recursive: true });

const CKPT_PRODUCTS = path.join(CKPT_DIR, "core_v2_catalog-products.json");

const headers = {
  "Authorization": `Bearer ${API_KEY}`,
  "User-Agent": "printful-catalog-core-v2/1.0",
  // "X-PF-Language": "en",
};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ---------- HTTP utils ----------
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

// v2 shape helper: return {items[], paging|null}
function parseItemsAndPaging(payload) {
  if (!payload) return { items: [], paging: null };
  if (payload.data !== undefined) {
    const items = Array.isArray(payload.data) ? payload.data : (payload.data ? [payload.data] : []);
    return { items, paging: payload.paging || null };
  }
  // fallback (v1-ish)
  if (payload.result !== undefined) {
    const r = payload.result;
    const items = Array.isArray(r) ? r : (r?.items ?? (r ? [r] : []));
    return { items, paging: payload.paging || null };
  }
  return { items: [], paging: null };
}

// ---------- CSV ----------
function writeCsv(filePath, rows) {
  const headersSet = new Set();
  rows.forEach(r => Object.keys(r).forEach(k => headersSet.add(k)));
  const cols = Array.from(headersSet).sort();

  const esc = (s) => `"${String(s).replace(/"/g, '""')}"`;
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

// ---------- Checkpoint ----------
function loadProductOffset() {
  try {
    if (fs.existsSync(CKPT_PRODUCTS)) {
      const j = JSON.parse(fs.readFileSync(CKPT_PRODUCTS, "utf8"));
      return Number(j.product_offset || 0) || 0;
    }
  } catch {}
  return 0;
}
function saveProductOffset(off) {
  fs.writeFileSync(CKPT_PRODUCTS, JSON.stringify({ product_offset: off }), "utf8");
}

// ---------- Paging helpers ----------
async function* pageThroughCatalogProducts(limit, startOffset = 0) {
  let offset = startOffset;
  let total = null;

  while (true) {
    const url = `${BASE_URL}/v2/catalog-products?limit=${limit}&offset=${offset}`;
    const json = await fetchJsonWithRetry(url);
    const { items, paging } = parseItemsAndPaging(json);

    const fetched = items.length;
    yield { items, offset, fetched };
    offset += fetched;

    if (!paging || typeof paging.total !== "number" || fetched === 0) break;
    total = paging.total;
    if (offset >= total) break;
  }
}

async function pagedVariantsForProduct(productId, limit) {
  const rows = [];
  let offset = 0;

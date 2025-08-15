// REST: categories, product_categories, countries, availability, product_images*
// Pagination auto (limit=PAGE_LIMIT, offset++). Peut s'exécuter AVANT CORE.
// * product_images :
//    - si data/variants.csv existe -> lit les IDs et récupère les images.
//    - sinon -> pagine /v2/catalog/variants (IDs) pour récupérer les images.
//
import fs from "node:fs";
import path from "node:path";

const API_KEY = process.env.PRINTFUL_TOKEN;
if (!API_KEY) {
  console.error("Missing PRINTFUL_TOKEN in env.");
  process.exit(1);
}
const BASE_URL = (process.env.BASE_URL || "https://api.printful.com").replace(/\/+$/, "");
const LIMIT = parseInt(process.env.PAGE_LIMIT || "100", 10);

const OUT_DIR = path.resolve("data");
fs.mkdirSync(OUT_DIR, { recursive: true });

const headers = {
  "Authorization": `Bearer ${API_KEY}`,
  "User-Agent": "printful-catalog-rest/1.1",
};

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchJsonWithRetry(url, maxRetries = 8, backoffBase = 1000) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetch(url, { headers, method: "GET" });
      if (res.status === 429) {
        const ra = res.headers.get("retry-after");
        const wait = ra ? Math.ceil(Number(ra) * 1000) : backoffBase * (2 ** attempt);
        await sleep(wait);
        continue;
      }
      if (res.status >= 500) {
        await sleep(backoffBase * (2 ** attempt));
        continue;
      }
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`HTTP ${res.status} - ${text}`);
      }
      return await res.json();
    } catch (err) {
      if (attempt === maxRetries) throw err;
      await sleep(backoffBase * (2 ** attempt));
    }
  }
  throw new Error("Unreachable");
}

// Paginé: tente ?limit&offset, sinon lit tout (si pas de paging renvoyé par l'API).
async function pagedFetch(endpointPath, limit) {
  let offset = 0;
  const rows = [];
  let total = null;

  while (true) {
    const url = `${BASE_URL}${endpointPath}?limit=${limit}&offset=${offset}`;
    const data = await fetchJsonWithRetry(url);
    const result = data?.result ?? [];
    const paging = data?.paging ?? {};

    const items = (result && typeof result === "object" && "items" in result) ? result.items : result;

    // Si l'API ne pagine pas (pas de tableau paginé, ni paging), on prend tout et on sort.
    if (!Array.isArray(items) || (!paging || typeof paging.total !== "number")) {
      const flat = Array.isArray(items) ? items : (Array.isArray(result) ? result : []);
      for (const it of flat) rows.push(typeof it === "object" ? it : { value: it });
      break; // pas de pagination à poursuivre
    }

    if (total == null && typeof paging.total === "number") total = paging.total;

    for (const it of items) rows.push(typeof it === "object" ? it : { value: it });

    const fetched = items.length;
    offset += fetched;

    if (fetched === 0) break;
    if (total != null && offset >= total) break;
  }
  return rows;
}

function writeCsv(filePath, rows) {
  const headersSet = new Set();
  for (const r of rows) Object.keys(r).forEach(k => headersSet.add(k));
  const cols = Array.from(headersSet).sort();

  const lines = [];
  lines.push(cols.map(c => `"${c.replace(/"/g, '""')}"`).join(","));
  for (const r of rows) {
    const o = {};
    for (const c of cols) {
      const v = r[c];
      let s = v;
      if (v && typeof v === "object") s = JSON.stringify(v);
      if (s === undefined || s === null) s = "";
      const cell = String(s).replace(/"/g, '""');
      o[c] = `"${cell}"`;
    }
    lines.push(cols.map(c => o[c]).join(","));
  }
  fs.writeFileSync(filePath, lines.join("\n"), "utf8");
  console.log(`Wrote ${filePath} — ${rows.length} rows`);
}

function variantsCsvPath() {
  const p = path.join(OUT_DIR, "variants.csv");
  return fs.existsSync(p) ? p : null;
}

function* readCsvIds(filePath, idKeys = ["id", "variant_id", "variantId"]) {
  const text = fs.readFileSync(filePath, "utf8");
  const lines = text.split(/\r?\n/).filter(l => l.length > 0);
  if (lines.length === 0) return;
  const headers = lines[0].split(",").map(h => h.replace(/^"|"$/g, "").trim());
  const keyIdx = idKeys
    .map(k => headers.findIndex(h => h === k))
    .find(idx => idx !== -1);
  if (keyIdx === undefined || keyIdx === -1) return;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    const cols = line.match(/("([^"]|"")*"|[^,]*)/g)?.map(s => s.replace(/^"|"$/g, "").replace(/""/g, '"')) || [];
    const val = cols[keyIdx];
    if (val) yield val;
  }
}

async function fetchVariantImages(variantId) {
  const url = `${BASE_URL}/v2/catalog-variants/${encodeURIComponent(variantId)}/images`;
  const data = await fetchJsonWithRetry(url);
  let items = data?.result ?? [];
  if (items && typeof items === "object" && "items" in items) items = items.items;
  return (items || []).map(img => (typeof img === "object" ? { ...img } : { value: img })).map(r => ({ ...r, variant_id: variantId }));
}

// Pagine les IDs de variantes si variants.csv n’existe pas encore (REST avant CORE)
async function* iterateVariantIds(limit) {
  // On stream les IDs en paginant /catalog/variants
  let offset = 0;
  let total = null;

  while (true) {
    const url = `${BASE_URL}/v2/catalog/variants?limit=${limit}&offset=${offset}`;
    const data = await fetchJsonWithRetry(url);
    const result = data?.result ?? [];
    const paging = data?.paging ?? {};
    const items = (result && typeof result === "object" && "items" in result) ? result.items : result;

    if (!Array.isArray(items) || items.length === 0) break;

    for (const it of items) {
      const id = (it && typeof it === "object") ? (it.id ?? it.variant_id ?? it.variantId) : null;
      if (id != null) yield String(id);
    }

    if (total == null && typeof paging.total === "number") total = paging.total;
    offset += items.length;
    if (total != null && offset >= total) break;
  }
}

(async () => {
  try {
    // 1) Categories (paginées si applicable)
    const categories = await pagedFetch("/v2/catalog/categories", LIMIT);
    writeCsv(path.join(OUT_DIR, "categories.csv"), categories);

    // 2) Product categories (paginées si applicable)
    try {
      const productCategories = await pagedFetch("/v2/catalog/product-categories", LIMIT);
      writeCsv(path.join(OUT_DIR, "product_categories.csv"), productCategories);
    } catch (e) {
      console.warn("product-categories endpoint failed; writing empty CSV.");
      writeCsv(path.join(OUT_DIR, "product_categories.csv"), []);
    }

    // 3) Countries (paginées si applicable)
    const countries = await pagedFetch("/v2/countries", LIMIT);
    writeCsv(path.join(OUT_DIR, "countries.csv"), countries);

    // 4) Availability (paginées si applicable)
    try {
      const availability = await pagedFetch("/v2/catalog/availability", LIMIT);
      writeCsv(path.join(OUT_DIR, "availability.csv"), availability);
    } catch (e) {
      console.warn("availability endpoint failed; writing empty CSV.");
      writeCsv(path.join(OUT_DIR, "availability.csv"), []);
    }

    // 5) Product images
    const vcsv = variantsCsvPath();
    const images_rows = [];
    if (vcsv) {
      // Lire les IDs depuis variants.csv
      let count = 0;
      for (const vid of readCsvIds(vcsv)) {
        const imgs = await fetchVariantImages(vid);
        images_rows.push(...imgs);
        count++;
        if (count % 250 === 0) console.log(`...fetched images for ${count} variants`);
      }
    } else {
      // REST avant CORE : pagine les variantes pour récupérer au moins les images
      let count = 0;
      for await (const vid of iterateVariantIds(LIMIT)) {
        const imgs = await fetchVariantImages(vid);
        images_rows.push(...imgs);
        count++;
        if (count % 250 === 0) console.log(`...fetched images for ${count} variants (REST pre-core)`);
      }
    }
    writeCsv(path.join(OUT_DIR, "product_images.csv"), images_rows);

    console.log("REST done.");
  } catch (e) {
    console.error("REST failed:", e?.message || e);
    process.exit(1);
  }
})();

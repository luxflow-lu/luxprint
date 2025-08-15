// REST: toutes les "collections" catalogue (hors products/variants) + countries,
//       et aussi product_images & availability par variante.
// - Pagination généralisée (limit=PAGE_LIMIT, offset++)
// - Tolérant aux 404/401 : on log, on écrit un CSV vide, on continue
// - Peut tourner AVANT CORE : si variants.csv absent, on streame les IDs de variantes.
// - Secret: PRINTFUL_TOKEN

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

const headers = { "Authorization": `Bearer ${API_KEY}`, "User-Agent": "printful-catalog-rest/1.6" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- Endpoints ---------------------------------------------------------------
function splitCsvEndpoints(input) {
  if (!input || !input.trim()) return null;
  const csv = input.trim();
  // split sur virgules/points-virgules/espaces/nouvelles lignes
  let parts = csv.split(/[,;\n\r\t ]+/).map(s => s.trim()).filter(Boolean);
  // Cas GitHub qui colle tout: "/v2/a/v2/b/v2/c..."
  if (parts.length <= 1 && csv.includes("/v2/")) {
    parts = csv.split(/(?=\/v2\/)/g).map(s => s.trim()).filter(Boolean);
  }
  return parts;
}

const DEFAULT_ENDPOINTS = [
  "/v2/catalog/categories",
  "/v2/catalog/product-categories",
  "/v2/catalog/prices",
  "/v2/countries",
  // alternates hyphen
  "/v2/catalog-categories",
  "/v2/catalog-product-categories",
  "/v2/catalog-prices",
  // autres fréquences possibles
  "/v2/catalog/colors",
  "/v2/catalog/size-guides",
  "/v2/catalog/placements",
  "/v2/catalog/techniques",
  "/v2/catalog/materials",
  "/v2/catalog/brands",
  // alternates hyphen
  "/v2/catalog-colors",
  "/v2/catalog-size-guides",
  "/v2/catalog-placements",
  "/v2/catalog-techniques",
  "/v2/catalog-materials",
  "/v2/catalog-brands",
];

function getEndpoints() {
  const envList = splitCsvEndpoints(process.env.REST_ENDPOINTS_CSV || "");
  const list = envList && envList.length ? envList : DEFAULT_ENDPOINTS;
  // filtre sécurité
  return list.filter(ep => !/\/v2\/catalog\/(products|variants)\b/.test(ep));
}

// --- HTTP + pagination -------------------------------------------------------
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
  throw new Error("fetchJsonWithRetry exhausted");
}

function endpointToCsvName(endpointPath) {
  const map = {
    "/v2/catalog/categories": "categories.csv",
    "/v2/catalog/product-categories": "product_categories.csv",
    "/v2/catalog/prices": "prices.csv",
    "/v2/countries": "countries.csv",

    "/v2/catalog-categories": "categories_v2.csv",
    "/v2/catalog-product-categories": "product_categories_v2.csv",
    "/v2/catalog-prices": "prices_v2.csv",

    "/v2/catalog/colors": "colors.csv",
    "/v2/catalog/size-guides": "size_guides.csv",
    "/v2/catalog/placements": "placements.csv",
    "/v2/catalog/techniques": "techniques.csv",
    "/v2/catalog/materials": "materials.csv",
    "/v2/catalog/brands": "brands.csv",

    "/v2/catalog-colors": "colors_v2.csv",
    "/v2/catalog-size-guides": "size_guides_v2.csv",
    "/v2/catalog-placements": "placements_v2.csv",
    "/v2/catalog-techniques": "techniques_v2.csv",
    "/v2/catalog-materials": "materials_v2.csv",
    "/v2/catalog-brands": "brands_v2.csv",
  };
  return map[endpointPath] || endpointPath.replace(/^\/+/, "").replace(/\/+/g, "_") + ".csv";
}

async function pagedFetch(endpointPath, limit) {
  let offset = 0;
  let total = null;
  const rows = [];
  while (true) {
    const url = `${BASE_URL}${endpointPath}?limit=${limit}&offset=${offset}`;
    const data = await fetchJsonWithRetry(url);
    const result = data?.result ?? [];
    const paging = data?.paging ?? {};
    const items = (result && typeof result === "object" && "items" in result) ? result.items : result;

    // Pas de pagination signalée => on prend tout et on sort
    if (!Array.isArray(items) || (!paging || typeof paging.total !== "number")) {
      const flat = Array.isArray(items) ? items : (Array.isArray(result) ? result : []);
      for (const it of flat) rows.push(typeof it === "object" ? it : { value: it });
      break;
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

// --- CSV ---------------------------------------------------------------------
function writeCsv(filePath, rows) {
  const headersSet = new Set();
  rows.forEach(r => Object.keys(r).forEach(k => headersSet.add(k)));
  const cols = Array.from(headersSet).sort();

  const lines = [];
  lines.push(cols.map(c => `"${c.replace(/"/g, '""')}"`).join(","));
  for (const r of rows) {
    const out = cols.map(c => {
      let v = r[c];
      if (v && typeof v === "object") v = JSON.stringify(v);
      const s = (v ?? "").toString().replace(/"/g, '""');
      return `"${s}"`;
    });
    lines.push(out.join(","));
  }
  fs.writeFileSync(filePath, lines.join("\n"), "utf8");
  console.log(`Wrote ${filePath} — ${rows.length} rows`);
}

// --- Variants helpers --------------------------------------------------------
const variantsCsvPath = () => path.join(OUT_DIR, "variants.csv");

function* readCsvIds(filePath, idKeys = ["id", "variant_id", "variantId"]) {
  if (!fs.existsSync(filePath)) return;
  const text = fs.readFileSync(filePath, "utf8");
  const lines = text.split(/\r?\n/).filter(Boolean);
  if (lines.length === 0) return;
  const headers = lines[0].split(",").map(h => h.replace(/^"|"$/g, "").trim());
  const keyIdx = idKeys.map(k => headers.findIndex(h => h === k)).find(idx => idx !== -1);
  if (keyIdx === undefined || keyIdx === -1) return;
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].match(/("([^"]|"")*"|[^,]*)/g)?.map(s => s.replace(/^"|"$/g, "").replace(/""/g, '"')) || [];
    const val = cols[keyIdx];
    if (val) yield val;
  }
}

async function fetchVariantImages(variantId) {
  const url = `${BASE_URL}/v2/catalog-variants/${encodeURIComponent(variantId)}/images`;
  const data = await fetchJsonWithRetry(url);
  let items = data?.result ?? [];
  if (items && typeof items === "object" && "items" in items) items = items.items;
  return (items || []).map(img => (typeof img === "object" ? { ...img } : { value: img }))
                      .map(r => ({ ...r, variant_id: variantId }));
}

async function fetchVariantAvailability(variantId) {
  const url = `${BASE_URL}/v2/catalog-variants/${encodeURIComponent(variantId)}/availability`;
  const data = await fetchJsonWithRetry(url);
  let items = data?.result ?? [];
  if (!Array.isArray(items)) items = [items];
  return (items || []).map(row => (typeof row === "object" ? { ...row } : { value: row }))
                      .map(r => ({ ...r, variant_id: variantId }));
}

async function* iterateVariantIds(limit) {
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

// --- Main --------------------------------------------------------------------
(async function main() {
  try {
    // 1) Collections "catalogue" (hors products/variants)
    const endpoints = getEndpoints();
    console.log("REST endpoints:", endpoints.join(", "));
    for (const ep of endpoints) {
      try {
        const rows = await pagedFetch(ep, LIMIT);
        const outName = endpointToCsvName(ep);
        writeCsv(path.join(OUT_DIR, outName), rows);
      } catch (e) {
        console.warn(`Warn: ${ep} failed — writing empty CSV.`, e?.message || e);
        const outName = endpointToCsvName(ep);
        writeCsv(path.join(OUT_DIR, outName), []);
      }
    }

    // 2) Images & Availability par variante (fonctionne même si CORE pas lancé)
    const images_rows = [];
    const availability_rows = [];

    if (fs.existsSync(variantsCsvPath())) {
      let count = 0;
      for (const vid of readCsvIds(variantsCsvPath())) {
        try {
          const [imgs, avs] = await Promise.all([
            fetchVariantImages(vid),
            fetchVariantAvailability(vid),
          ]);
          images_rows.push(...imgs);
          availability_rows.push(...avs);
        } catch (e) {
          console.warn(`Warn: variant ${vid} images/availability failed:`, e?.message || e);
        }
        if (++count % 250 === 0) console.log(`...processed ${count} variants`);
      }
    } else {
      let count = 0;
      for await (const vid of iterateVariantIds(LIMIT)) {
        try {
          const [imgs, avs] = await Promise.all([
            fetchVariantImages(vid),
            fetchVariantAvailability(vid),
          ]);
          images_rows.push(...imgs);
          availability_rows.push(...avs);
        } catch (e) {
          console.warn(`Warn: variant ${vid} images/availability failed:`, e?.message || e);
        }
        if (++count % 250 === 0) console.log(`...processed ${count} variants (REST pre-core)`);
      }
    }

    writeCsv(path.join(OUT_DIR, "product_images.csv"), images_rows);
    writeCsv(path.join(OUT_DIR, "availability.csv"), availability_rows);

    console.log("REST done.");
  } catch (e) {
    console.error("REST failed:", e?.message || e);
    process.exit(1);
  }
})();

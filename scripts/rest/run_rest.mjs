// REST: tente toutes les "collections" catalogue connues (hors products/variants) + countries,
//       et récupère aussi product_images & availability par variante.
// - Pagination généralisée (limit=PAGE_LIMIT, offset++)
// - Tolérant aux 404/401 : on log, on écrit un CSV vide, on continue
// - Peut tourner AVANT CORE : si variants.csv absent, on streame les IDs de variantes à la volée.
// - Secret: PRINTFUL_TOKEN

import fs from "node:fs";
import path from "node:path";

const API_KEY = process.env.PRINTFUL_TOKEN;
if (!API_KEY) { console.error("Missing PRINTFUL_TOKEN in env."); process.exit(1); }
const BASE_URL = (process.env.BASE_URL || "https://api.printful.com").replace(/\/+$/, "");
const LIMIT = parseInt(process.env.PAGE_LIMIT || "100", 10);
const OUT_DIR = path.resolve("data");
fs.mkdirSync(OUT_DIR, { recursive: true });

const headers = { "Authorization": `Bearer ${API_KEY}`, "User-Agent": "printful-catalog-rest/1.5" };
const sleep = ms => new Promise(r => setTimeout(r, ms));

function fromCsvOrDefault() {
  const csv = (process.env.REST_ENDPOINTS_CSV ?? "").trim();
  if (csv) {
    let list = csv.split(/[,;\s]+/).map(s => s.trim()).filter(Boolean);
    if (list.length <= 1 && csv.includes("/v2/")) {
      list = csv.split(/(?=\/v2\/)/g).map(s => s.trim()).filter(Boolean);
    }
    return list;
  }

  // --- Grosse liste "catalogue" (on laissera 404=vide si non dispo sur ton compte) ---
  // Legacy "slash" + v2 "hyphen" twins pour maximiser la couverture.
  const CATALOG = [
    // basiques
    "/v2/catalog/categories",
    "/v2/catalog/product-categories",
    "/v2/catalog/prices",
    "/v2/countries",

    // équivalents/variantes v2-hyphen
    "/v2/catalog-categories",
    "/v2/catalog-product-categories",
    "/v2/catalog-prices",

    // collections potentielles (selon comptes/regions/version API)
    "/v2/catalog/colors",
    "/v2/catalog/size-guides",
    "/v2/catalog/placements",
    "/v2/catalog/techniques",
    "/v2/catalog/materials",
    "/v2/catalog/brands",

    // twins hyphen potentiels
    "/v2/catalog-colors",
    "/v2/catalog-size-guides",
    "/v2/catalog-placements",
    "/v2/catalog-techniques",
    "/v2/catalog-materials",
    "/v2/catalog-brands",
  ];

  // filtrage de sécurité (au cas où)
  return CATALOG.filter(ep => !/\/v2\/catalog\/(products|variants)\b/.test(ep));
}

async function fetchJsonWithRetry(url, maxRetries = 8, backoffBase = 1000) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetch(url, { headers, method: "GET" });
      if (res.status === 429) {
        const ra = res.headers.get("retry-after");
        const wait = ra ? Math.ceil(Number(ra) * 1000) : backoffBase * (2 ** attempt);
        await sleep(wait); continue;
      }
      if (res.status >= 500) { await sleep(backoffBase * (2 ** attempt)); continue; }
      if (!res.ok) throw new Error(`HTTP ${res.status} - ${await res.text()}`);
      return await res.json();
    } catch (err) {
      if (attempt === maxRetries) throw err;
      await sleep(backoffBase * (2 ** attempt));
    }
  }
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
  let offset = 0, total = null;
  const rows = [];
  while (true) {
    const url = `${BASE_URL}${endpointPath}?limit=${limit}&offset=${offset}`;
    const data = await fetchJsonWithRetry(url);
    const result = data?.result ?? [];
    const paging = data?.paging ?? {};
    const items = (result && typeof result === "object" && "items" in result) ? result.items : result;

    // Si l'endpoint ne pagine pas, on prend tout et on sort.
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

function writeCsv(filePath, rows) {
  const headersSet = new Set(); rows.forEach(r => Object.keys(r).forEach(k => headersSet.add(k)));
  const cols = Array.from(headersSet).sort();
  const lines = [];
  lines.push(cols.map(c => `"${c.replace(/"/g, '""')}"`).join(","));
  for (const r of rows) {
    const out = cols.map(c => {
      let v = r[c]; if (v && typeof v === "object") v = JSON.stringify(v);
      const s = (v ?? "").toString().replace(/"/g, '""');
      return `"${s}"`;
    });
    lines.push(out.join(","));
  }
  fs.writeFileSync(filePath, lines.join("\n"), "utf8");
  console.log(`Wrote ${filePath} — ${rows.length} rows`);
}

const variantsCsvPath = () => {
  const p = pa

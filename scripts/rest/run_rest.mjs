// REST: endpoints multiples (config via REST_ENDPOINTS_CSV) + product_images
// - Pagine (limit=PAGE_LIMIT, offset++) pour chaque endpoint déclaré
// - Génère 1 CSV par endpoint (nom basé sur le chemin), + product_images.csv
// - Peut tourner AVANT CORE : si variants.csv absent, on pagine /catalog/variants pour récupérer les images
// - Tolérant aux 404 : on log, on écrit un CSV vide, et on continue.

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

const headers = { "Authorization": `Bearer ${API_KEY}`, "User-Agent": "printful-catalog-rest/1.3" };
const sleep = ms => new Promise(r => setTimeout(r, ms));

function parseEndpoints() {
  // 1) CSV depuis l'input du workflow
  const csv = (process.env.REST_ENDPOINTS_CSV ?? "").trim();
  if (csv) {
    let list = csv.split(/[,;\s]+/).map(s => s.trim()).filter(Boolean);
    // Cas GitHub qui colle tout: "/v2/a/v2/b/v2/c..."
    if (list.length <= 1 && csv.includes("/v2/")) {
      list = csv.split(/(?=\/v2\/)/g).map(s => s.trim()).filter(Boolean);
    }
    return list;
  }
  // 2) Fallback (très peu probable)
  return [
    "/v2/catalog/categories",
    "/v2/catalog/product-categories",
    "/v2/countries",
    "/v2/catalog/availability",
    "/v2/catalog/prices",
  ];
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
  return endpointPath.replace(/^\/+/, "").replace(/\/+/g, "_") + ".csv";
}

// Paginé quand dispo, sinon récupère tout d'un coup
async function pagedFetch(endpointPath, limit) {
  let offset = 0, total = null;
  const rows = [];
  while (true) {
    const url = `${BASE_URL}${endpointPath}?limit=${limit}&offset=${offset}`;
    const data = await fetchJsonWithRetry(url);
    const result = data?.result ?? [];
    const paging = data?.paging ?? {};
    const items = (result && typeof result === "object" && "items" in result) ? result.items : result;

    // Pas de pagination (endpoint renvoie tout)
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
  const p = path.join(OUT_DIR, "variants.csv");
  return fs.existsSync(p) ? p : null;
};

function* readCsvIds(filePath, idKeys = ["id", "variant_id", "variantId"]) {
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

// Stream d'IDs variantes si variants.csv n’existe pas encore (REST avant CORE)
async function* iterateVariantIds(limit) {
  let offset = 0, total = null;
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
    // 1) Endpoints REST dynamiques (tolérant aux erreurs)
    const endpoints = parseEndpoints();
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

    // 2) Product images (fonctionne même si CORE pas encore lancé)
    try {
      const pimgOut = path.join(OUT_DIR, "product_images.csv");
      const images_rows = [];
      const vcsv = variantsCsvPath();

      if (vcsv) {
        let count = 0;
        for (const vid of readCsvIds(vcsv)) {
          const imgs = await fetchVariantImages(vid);
          images_rows.push(...imgs);
          if (++count % 250 === 0) console.log(`...fetched images for ${count} variants`);
        }
      } else {
        let count = 0;
        for await (const vid of iterateVariantIds(LIMIT)) {
          const imgs = await fetchVariantImages(vid);
          images_rows.push(...imgs);
          if (++count % 250 === 0) console.log(`...fetched images for ${count} variants (REST pre-core)`);
        }
      }

      writeCsv(pimgOut, images_rows);
    } catch (e) {
      console.warn("Warn: product_images step failed — writing empty CSV.", e?.message || e);
      writeCsv(path.join(OUT_DIR, "product_images.csv"), []);
    }

    console.log("REST done.");
  } catch (e) {
    console.error("REST failed:", e?.message || e);
    process.exit(1);
  }
})();

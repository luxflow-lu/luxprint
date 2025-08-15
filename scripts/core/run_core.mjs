// CORE: products + variants (lourd), pagination auto (limit=PAGE_LIMIT, offset++)
// Peut être lancé après REST. Checkpoints pour reprendre en cas de rate-limit.

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
const CKPT_DIR = path.resolve(".checkpoints");
fs.mkdirSync(OUT_DIR, { recursive: true });
fs.mkdirSync(CKPT_DIR, { recursive: true });

const headers = { "Authorization": `Bearer ${API_KEY}`, "User-Agent": "printful-catalog-core/1.2" };
const sleep = ms => new Promise(r => setTimeout(r, ms));

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

const ckptPath = key => path.join(CKPT_DIR, `${key.replace(/[^\w.-]+/g, "_")}.json`);
const loadOffset = key => {
  try { if (fs.existsSync(ckptPath(key))) return Number(JSON.parse(fs.readFileSync(ckptPath(key), "utf8")).offset || 0) || 0; }
  catch {}
  return 0;
};
const saveOffset = (key, off) => fs.writeFileSync(ckptPath(key), JSON.stringify({ offset: off }), "utf8");

async function pagedFetch(endpointPath, limit) {
  let offset = loadOffset(endpointPath);
  const rows = [];
  let total = null;

  while (true) {
    const url = `${BASE_URL}${endpointPath}?limit=${limit}&offset=${offset}`;
    const data = await fetchJsonWithRetry(url);
    const result = data?.result ?? [];
    const paging = data?.paging ?? {};
    const items = (result && typeof result === "object" && "items" in result) ? result.items : result;

    if (total == null && typeof paging.total === "number") total = paging.total;
    for (const it of items) rows.push(typeof it === "object" ? it : { value: it });

    const fetched = items.length;
    offset += fetched; saveOffset(endpointPath, offset);
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

(async () => {
  try {
    const products = await pagedFetch("/v2/catalog/products", LIMIT);
    writeCsv(path.join(OUT_DIR, "products.csv"), products);

    const variants = await pagedFetch("/v2/catalog/variants", LIMIT);
    writeCsv(path.join(OUT_DIR, "variants.csv"), variants);

    console.log("CORE done.");
  } catch (e) {
    console.error("CORE failed:", e?.message || e);
    process.exit(1);
  }
})();

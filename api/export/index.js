import { pullAll } from './catalog.js';

export default async function handler(req, res){
  const region = req.query.region || process.env.DEFAULT_REGION || 'europe';
  const dest   = req.query.dest || '';
  const base   = req.url.replace(/\/api\/export.*/,'/api/export');

  res.setHeader('Content-Type','text/html; charset=utf-8');
  res.status(200).send(`<!doctype html>
<html><head><meta charset="utf-8"><title>LuxPrint Export</title>
<style>
body{font-family:ui-sans-serif,system-ui,Segoe UI,Roboto,Helvetica,Arial,sans-serif;padding:24px}
h1{font-size:20px;margin:0 0 12px}
.grid{display:grid;gap:8px;grid-template-columns:repeat(auto-fit,minmax(260px,1fr))}
.card{border:1px solid #e5e7eb;border-radius:12px;padding:12px}
a.btn{display:inline-block;padding:8px 12px;border:1px solid #111;border-radius:8px;text-decoration:none}
small{color:#6b7280}
</style></head>
<body>
<h1>LuxPrint — Export CSV Webflow</h1>
<p><small>Filtre: ${dest?`destination_country=${dest}`:`selling_region_name=${region}`}</small></p>
<div class="grid">
  <div class="card"><b>Produits</b><br><a class="btn" href="${base}/products${dest?`?dest=${dest}`:`?region=${region}`}">Télécharger</a></div>
  <div class="card"><b>Variantes</b><br><a class="btn" href="${base}/variants${dest?`?dest=${dest}`:`?region=${region}`}">Télécharger</a></div>
  <div class="card"><b>Catégories</b><br><a class="btn" href="${base}/categories${dest?`?dest=${dest}`:`?region=${region}`}">Télécharger</a></div>
  <div class="card"><b>Relations Produit↔Catégorie</b><br><a class="btn" href="${base}/product_categories${dest?`?dest=${dest}`:`?region=${region}`}">Télécharger</a></div>
  <div class="card"><b>Images Produit</b><br><a class="btn" href="${base}/product_images${dest?`?dest=${dest}`:`?region=${region}`}">Télécharger</a></div>
  <div class="card"><b>Images Variante</b><br><a class="btn" href="${base}/variant_images${dest?`?dest=${dest}`:`?region=${region}`}">Télécharger</a></div>
  <div class="card"><b>Tailles</b><br><a class="btn" href="${base}/sizes${dest?`?dest=${dest}`:`?region=${region}`}">Télécharger</a></div>
  <div class="card"><b>Prix</b><br><a class="btn" href="${base}/prices${dest?`?dest=${dest}`:`?region=${region}`}">Télécharger</a></div>
  <div class="card"><b>Disponibilités</b><br><a class="btn" href="${base}/availability${dest?`?dest=${dest}`:`?region=${region}`}">Télécharger</a></div>
  <div class="card"><b>Pays</b><br><a class="btn" href="${base}/countries">Télécharger</a></div>
</div>
</body></html>`);
}

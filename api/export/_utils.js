// utils communs: fetch + CSV
export const API_BASE = 'https://api.printful.com';

function wait(ms){ return new Promise(r=>setTimeout(r,ms)); }

export async function getJSON(url, { retry=5, backoff=800 } = {}) {
  const TOKEN = process.env.PRINTFUL_TOKEN;
  if (!TOKEN) throw new Error('PRINTFUL_TOKEN manquant');
  for (let a=1;a<=retry;a++){
    const r = await fetch(url, { headers:{ Authorization:`Bearer ${TOKEN}` } }).catch(()=>null);
    if (!r){ if(a===retry) throw new Error('Fetch échoué'); await wait(backoff*a); continue; }
    if (r.status===429 || (r.status>=500 && r.status<=599)){
      const ra = Number(r.headers.get('retry-after')) || backoff*a;
      if(a===retry) throw new Error(`HTTP ${r.status} ${url}`);
      await wait(ra); continue;
    }
    if(!r.ok){ const t=await r.text().catch(()=> ''); throw new Error(`HTTP ${r.status} ${url} :: ${t}`); }
    return r.json();
  }
}

export function csvEscape(val){
  if (val===null || val===undefined) return '';
  const s=String(val);
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g,'""')}"`;
  return s;
}

export function sendCSV(res, filename, rows, headerOrder=null){
  const headers = headerOrder || (rows[0] ? Object.keys(rows[0]) : []);
  const lines = [];
  lines.push(headers.map(csvEscape).join(','));
  for (const row of rows){
    const line = headers.map(h => csvEscape(row[h] ?? '')).join(',');
    lines.push(line);
  }
  const body = lines.join('\n');
  res.status(200);
  res.setHeader('Content-Type','text/csv; charset=utf-8');
  res.setHeader('Content-Disposition',`attachment; filename="${filename}"`);
  res.send(body);
}

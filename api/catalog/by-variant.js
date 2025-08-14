// /api/catalog/by-variant.js
function cors(res){
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Vary','Origin');
  res.setHeader('Access-Control-Allow-Methods','GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type');
}
function pfHeaders(token,storeId){
  const h={Authorization:`Bearer ${token}`,'Content-Type':'application/json'};
  if (storeId) h['X-PF-Store-Id']=String(storeId);
  return h;
}
module.exports = async (req,res)=>{
  cors(res);
  if (req.method==='OPTIONS') return res.status(204).end();
  try{
    const id = Number(req.query.id||req.query.variant_id||0);
    const PF_TOKEN = process.env.PRINTFUL_TOKEN_CATALOG || process.env.PRINTFUL_TOKEN_ORDERS;
    const PF_STORE_ID = process.env.PRINTFUL_STORE_ID || '';
    if(!id) return res.status(400).json({error:'Missing variant id'});
    if(!PF_TOKEN) return res.status(500).json({error:'Missing PRINTFUL token'});

    const r = await fetch(`https://api.printful.com/v2/catalog-variants/${id}`,{ headers: pfHeaders(PF_TOKEN, PF_STORE_ID) });
    const j = await r.json();
    if(!r.ok) return res.status(r.status).json(j);

    const product_id = j?.data?.product?.id || j?.data?.product_id || null;
    return res.status(200).json({ ok:true, product_id, variant:j?.data||j });
  }catch(e){
    return res.status(500).json({error:e.message});
  }
};

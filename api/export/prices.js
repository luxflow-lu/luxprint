import { pullAll } from './catalog.js';
import { sendCSV } from './_utils.js';

export default async function handler(req,res){
  const region = req.query.region || process.env.DEFAULT_REGION || 'europe';
  const dest   = req.query.dest || '';
  const data = await pullAll({ region, dest });
  sendCSV(res, 'prices.csv', data.prices, ['product_id','variant_id','currency','retail_price','region']);
}

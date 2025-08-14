import { pullAll } from './catalog.js';
import { sendCSV } from './_utils.js';

export default async function handler(req,res){
  const region = req.query.region || process.env.DEFAULT_REGION || 'europe';
  const dest   = req.query.dest || '';
  const data = await pullAll({ region, dest });
  sendCSV(res, 'variants.csv', data.variants, [
    'catalog_variant_id','catalog_product_id','name','size','color','color_code','color_code2','image_main','placement_dimensions',
    '_links_self','_links_variant_prices','_links_variant_images','_links_variant_availability'
  ]);
}

import { pullAll } from './catalog.js';
import { sendCSV } from './_utils.js';

export default async function handler(req,res){
  const region = req.query.region || process.env.DEFAULT_REGION || 'europe';
  const dest   = req.query.dest || '';
  const data = await pullAll({ region, dest });
  const rows = data.products;
  sendCSV(res, 'products.csv', rows, [
    'product_id','main_category_id','type','name','brand','model','image_hero','variant_count','is_discontinued','description',
    'sizes_list','colors_list','techniques','placements_schema','product_options',
    '_links_self','_links_variants','_links_categories','_links_prices','_links_sizes','_links_images','_links_availability'
  ]);
}

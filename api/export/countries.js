import { pullAll } from './catalog.js';
import { sendCSV } from './_utils.js';

export default async function handler(_req,res){
  // pas de filtre nécessaire pour la liste des pays
  const data = await pullAll({ region:'europe' });
  sendCSV(res, 'countries.csv', data.countries, ['code','name']);
}

/** Install strict, free production-plan ingestion after the existing native service planners. */
import {existsSync,readFileSync} from 'node:fs';
import {resolve} from 'node:path';

/**
 * Prepare tenant-local plan parsing, keyed native import and exact asset adoption routes.
 * @param {string} root Pinned upstream checkout.
 * @param {(path:string)=>string} readSource Latest staged source from earlier planners.
 * @returns {Array<[string,string]>} New owned files and the one route registration edit.
 */
export function planMuseProductionPlan(root,readSource=path=>readFileSync(path,'utf8')){
 const outputs=[];
 for(const [source,target]of [['muse-production-plan.cjs','services/museProductionPlan.js'],
  ['muse-production-plan.schema.json','services/museProductionPlan.schema.json'],
  ['muse-production-adoption.cjs','services/museProductionAdoption.js'],
  ['muse-production-plan-routes.cjs','routes/museProductionPlanRoutes.js']]){
  const file=resolve(root,'backend-node/src',target);
  if(existsSync(file))throw Error('Production plan owned file already exists: '+target);
  outputs.push([file,readFileSync(new URL('../extensions/'+source,import.meta.url),'utf8').replaceAll('\r\n','\n')]);
 }
 const file=resolve(root,'backend-node/src/routes/index.js'),source=readSource(file).replaceAll('\r\n','\n');
 const before='  const r = express.Router();';
 if(source.split(before).length!==2||source.includes("require('./museProductionPlanRoutes')"))throw Error('Production plan route patch does not match pinned source');
 outputs.push([file,source.replace(before,before+"\n  require('./museProductionPlanRoutes').register(r, db, cfg);")]);
 return outputs;
}

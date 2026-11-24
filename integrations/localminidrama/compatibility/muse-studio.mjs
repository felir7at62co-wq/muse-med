/** Install Studio version evidence before generation admission without changing paid dispatch ownership. */
import {existsSync,readFileSync} from 'node:fs';
import {resolve} from 'node:path';
/**
 * Prepare immutable Studio input/media tables, tenant trace routes and bound CLI validation.
 * @param root Pinned upstream checkout.
 * @param readSource Earlier planners' staged source.
 * @returns Exact owned files and narrow native route/CLI adapter changes.
 */
export function planMuseStudio(root,readSource=path=>readFileSync(path,'utf8')){
 const result=[];for(const[source,target]of [['muse-studio-inputs.cjs','services/museStudioInputs.js'],['muse-studio.cjs','services/museStudio.js'],['muse-studio-routes.cjs','routes/museStudioRoutes.js']]){const path=resolve(root,'backend-node/src',target);if(existsSync(path))throw Error('Muse Studio owned file exists: '+target);result.push([path,readFileSync(new URL('../extensions/'+source,import.meta.url),'utf8')]);}
 const routes=resolve(root,'backend-node/src/routes/index.js'),text=readSource(routes).replaceAll('\r\n','\n'),anchor='  const r = express.Router();';if(text.split(anchor).length!==2||text.includes("require('./museStudioRoutes')"))throw Error('Muse Studio router differs from pinned source');result.push([routes,text.replace(anchor,anchor+"\n  require('./museStudioRoutes').register(r, db, cfg);")]);
 const cli=resolve(root,'backend-node/src/services/museLibTvCli.js'),original=readSource(cli);if(!original.includes('module.exports={')||original.includes('museStudioOriginalReserve'))throw Error('Muse Studio requires staged CLI receipts');result.push([cli,original+`\nconst museStudioOriginalReserve=module.exports.reserve;\nmodule.exports.reserve=function(db,cfg,input){if(input.muse_prompt_revision_id===undefined)return museStudioOriginalReserve(db,cfg,input);const studio=require('./museStudioInputs'),captured=studio.validateCli(db,cfg,input);return db.transaction(()=>{const result=museStudioOriginalReserve(db,cfg,input);studio.captureCli(db,cfg,input,captured);return result;}).immediate();};\n`]);
 return result;
}

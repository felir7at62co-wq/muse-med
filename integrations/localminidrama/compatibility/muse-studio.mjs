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
 return result;
}

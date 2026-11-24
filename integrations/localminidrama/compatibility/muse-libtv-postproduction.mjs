/** Install immutable LibTV API derivatives alongside the existing company CLI source records. */
import {existsSync,readFileSync} from 'node:fs';
import {resolve} from 'node:path';
/** Plan tenant-owned imports; the public cloud proxy refuses the internal mutation route.
 * @param root Pinned upstream checkout.
 * @param readSource Current staged source after the CLI planner.
 * @returns New services, routes and history wrappers without touching live data.
 */
export function planMuseLibTvPostproduction(root,readSource=path=>readFileSync(path,'utf8')){
 const pending=[];
 for(const [source,target] of [['muse-libtv-postproduction.cjs','backend-node/src/services/museLibTvPostproduction.js'],['muse-libtv-timing.cjs','backend-node/src/services/museLibTvTiming.js'],['muse-libtv-postproduction-routes.cjs','backend-node/src/routes/museLibTvPostproductionRoutes.js']]){
  const file=resolve(root,target);if(existsSync(file))throw new Error('LibTV postproduction file already exists: '+target);pending.push([file,readFileSync(new URL('../extensions/'+source,import.meta.url),'utf8').replaceAll('\r\n','\n')]);
 }
 const file=resolve(root,'backend-node/src/routes/index.js'),source=readSource(file),anchor="  require('./museLibTvCliRoutes').register(r,db,cfg);";
 if(source.split(anchor).length!==2)throw new Error('LibTV routes registration changed');
 pending.push([file,source.replace(anchor,anchor+"\n  require('./museLibTvPostproductionRoutes').register(r, db, cfg);")]);
 const video=resolve(root,'backend-node/src/services/videoService.js');pending.push([video,readSource(video)+"\nconst museLibTvApiOriginalGet=module.exports.getById;\nmodule.exports.getById=function(db,id){const value=museLibTvApiOriginalGet(db,id),source=value&&require('./museLibTvPostproduction').generationInputs(db,'video',{id});return source?{...value,libtv_api_source:source,postproduction:source.postproduction}:value};\n"]);return pending;
}

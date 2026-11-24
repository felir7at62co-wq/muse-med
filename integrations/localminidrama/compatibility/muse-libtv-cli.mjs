/** Connect Host-executed CLI reservations and verified media to the authenticated studio. */
import {existsSync,readFileSync} from 'node:fs';
import {resolve} from 'node:path';
/** Plan account-local CLI receipts, chunk routes and native generation lineage.
 * @param root Pinned companion source root.
 * @param readSource Current staged source after budget and LibTV API planners.
 * @returns Validated replacements without launching a process or reading credentials.
 */
export function planMuseLibTvCli(root,readSource=path=>readFileSync(path,'utf8')){
 const result=[];for(const[owned,destination]of [['muse-libtv-cli.cjs','backend-node/src/services/museLibTvCli.js'],['muse-libtv-cli-media.cjs','backend-node/src/services/museLibTvCliMedia.js'],['muse-libtv-cli-routes.cjs','backend-node/src/routes/museLibTvCliRoutes.js']]){const file=resolve(root,destination);if(existsSync(file))throw Error('Muse LibTV CLI owned file already exists: '+destination);result.push([file,readFileSync(new URL('../extensions/'+owned,import.meta.url),'utf8')]);}
 const routes=resolve(root,'backend-node/src/routes/index.js'),source=readSource(routes).replaceAll('\r\n','\n'),anchor='  return r;';if(source.split(anchor).length!==2)throw Error('Muse LibTV CLI router does not match staged source');result.push([routes,source.replace(anchor,"  require('./museLibTvCliRoutes').register(r,db,cfg);\n"+anchor)]);
 for(const kind of ['image','video']){const file=resolve(root,'backend-node/src/services/'+kind+'Service.js'),value=readSource(file);if(value.includes('museLibTvCliOriginalGet'))throw Error('Muse LibTV CLI lineage already installed');result.push([file,value+`\nconst museLibTvCliOriginalGet=module.exports.getById;\nmodule.exports.getById=function(db,id){const value=museLibTvCliOriginalGet(db,id);return value?{...value,libtv_cli_source:require('./museLibTvCli').generationOrigin(db,'${kind}',id)}:value};\n`]);}
 const assetFile=resolve(root,'backend-node/src/services/assetService.js');result.push([assetFile,readSource(assetFile)+`\nconst museLibTvCliAudioOriginalGet=module.exports.getById;\nmodule.exports.getById=function(db,id){const value=museLibTvCliAudioOriginalGet(db,id);return value?.type==='audio'?{...value,libtv_cli_source:require('./museLibTvCli').generationOrigin(db,'audio',id)}:value};\n`]);
 return result;
}

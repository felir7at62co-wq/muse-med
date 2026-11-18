/** Enforce database-scoped snapshots for native content saves and preserve local edits on conflict. */
import {existsSync,readFileSync} from 'node:fs'
import {resolve} from 'node:path'

const writes=[
 ['project','id','put','/dramas/:id','drama.updateDrama'],['project','id','delete','/dramas/:id','drama.deleteDrama'],
 ...[['outline','saveOutline'],['characters','saveCharacters'],['episodes','saveEpisodes'],['progress','saveProgress'],['canvas-layout','saveCanvasLayout']].map(([path,fn])=>['project','id','put','/dramas/:id/'+path,'drama.'+fn]),
 ...[['character_library','character-library','charLibrary'],['scene_library','scene-library','sceneLibrary'],['prop_library','prop-library','propLibrary'],['character','characters','characters'],['prop','props','prop'],['media','assets','assets'],['storyboard','storyboards','storyboards']].flatMap(([kind,path,owner])=>[['put','update'],['delete','delete']].map(([verb,fn])=>[kind,'id',verb,'/'+path+'/:id',owner+'.'+(owner==='prop'?fn==='update'?'updateProp':'deleteProp':fn)])),
 ['scene','scene_id','put','/scenes/:scene_id','scenes.update'],['scene','scene_id','put','/scenes/:scene_id/prompt','scenes.updatePrompt'],['scene','scene_id','delete','/scenes/:scene_id','scenes.delete'],
 ['character','id','put','/characters/:id/image','characters.putImage'],['character','id','put','/characters/:id/image-from-library','characters.imageFromLibrary'],
 ['storyboard','id','post','/storyboards/:id/props','prop.associateProps'],['storyboard','id','put','/storyboards/:id/frame-prompts/:frame_type','storyboards.framePromptSave'],
]
const reads=[
 ['project','/dramas','drama.listDramas'],['project','/dramas/:id','drama.getDrama'],['character','/dramas/:id/characters','drama.getCharacters'],['prop','/dramas/:id/props','drama.listProps'],['storyboard','/episodes/:episode_id/storyboards','storyboards.episodeStoryboardsGet'],['storyboard','/storyboards/:id','storyboards.getOne'],
 ...[['character_library','character-library','charLibrary'],['scene_library','scene-library','sceneLibrary'],['prop_library','prop-library','propLibrary'],['media','assets','assets']].flatMap(([kind,path,owner])=>[[kind,'/'+path,owner+'.list'],[kind,'/'+path+'/:id',owner+'.get']]),
 ['character','/characters/:id','characters.getOne'],['scene','/scenes/:scene_id','scenes.getOne'],
]
function replace(source,before,after,file){if(source.split(before).length!==2)throw Error(`Muse edit CAS patch does not match pinned source: ${file}: ${before}`);return source.replace(before,after)}
/**
 * Plan atomic ordinary edits after the existing studio planners.
 * @param root - Pinned LocalMiniDrama checkout.
 * @param readSource - Latest staged source, including admission and package changes.
 * @returns New owned files and precise replacements; no runtime data is changed.
 */
export function planMuseEditCas(root,readSource=path=>readFileSync(path,'utf8')){
 const result=[];
 for(const[owned,path]of [['muse-edit-cas.cjs','backend-node/src/services/museEditCas.js'],['muse-edit-client.js','frontweb/src/utils/museEditCas.js']]){const file=resolve(root,path);if(existsSync(file))throw Error(`Muse edit CAS owned file already exists: ${path}`);result.push([file,readFileSync(new URL('../extensions/'+owned,import.meta.url),'utf8').replaceAll('\r\n','\n')])}
 const catalog=resolve(root,'frontweb/src/utils/museEditCatalog.json');if(existsSync(catalog))throw Error('Muse edit CAS catalog already exists');result.push([catalog,JSON.stringify(writes.map(([kind,,method,path])=>({kind,method,pattern:'^'+path.replace(':frame_type','[^/]+').replace(/:[a-z_]+/g,'([0-9]+)')+'/?$'})),null,2)+'\n']);
 const patch=(name,fn)=>{const file=resolve(root,name);result.push([file,fn(readSource(file).replaceAll('\r\n','\n'),name)])};
 patch('backend-node/src/routes/index.js',(source,file)=>{source=replace(source,'  const r = express.Router();',"  const r = express.Router();\n  const museEdit = require('../services/museEditCas').create(db, cfg);\n  museEdit.register(r);",file);for(const[kind,param,method,path,handler]of writes)source=replace(source,`  r.${method}('${path}', ${handler});`,`  r.${method}('${path}', museEdit.write('${kind}', '${param}', ${handler}));`,file);for(const[kind,path,handler]of reads)source=replace(source,`  r.get('${path}', ${handler});`,`  r.get('${path}', museEdit.read('${kind}', ${handler}));`,file);return source});
 patch('frontweb/src/utils/request.js',(source,file)=>{source="import { prepareMuseEdit, observeMuseEdit, resolveMuseEditConflict } from './museEditCas'\n"+source;source=replace(source,'request.interceptors.response.use(',"request.interceptors.request.use(config => prepareMuseEdit(config))\n\nrequest.interceptors.response.use(",file);source=replace(source,'  (response) => {','  (response) => {\n    observeMuseEdit(response.data, response.config)',file);source=replace(source,'  (error) => {',`  async (error) => {
    const retry = await resolveMuseEditConflict(error)
    if (retry) return request(retry)`,file);return source});
 return result;
}

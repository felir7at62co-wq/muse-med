/** Keep standalone storage available while no generation backend is configured. */
import {existsSync,readFileSync} from 'node:fs';
import {resolve} from 'node:path';

function replace(source,before,after,file){if(source.split(before).length!==2)throw Error(`Muse generation patch does not match pinned source: ${file}`);return source.replace(before,after);}

/**
 * Plan the disabled-generation router and prevent background supplier work during startup.
 * @param root Pinned upstream checkout.
 * @param readSource Latest staged sources from the storage and editing planners.
 * @returns Staged files; no databases or running services are modified.
 */
export function planMuseGeneration(root,readSource=path=>readFileSync(path,'utf8')){
 const pending=[];
 const owned=resolve(root,'backend-node/src/services/museGeneration.js');
 if(existsSync(owned))throw Error('Muse generation owner already exists');
 pending.push([owned,readFileSync(new URL('../extensions/muse-generation.cjs',import.meta.url),'utf8').replaceAll('\r\n','\n')]);
 const patch=(name,fn)=>{const file=resolve(root,name);pending.push([file,fn(readSource(file).replaceAll('\r\n','\n'),name)]);};
 patch('backend-node/src/routes/index.js',(source,file)=>{
  source=replace(source,'  const r = express.Router();',"  const r = express.Router();\n  const museGeneration = require('../services/museGeneration').register(r, cfg);",file);
  return replace(source,"r.post('/dramas/import-novel', importUpload.single('file'), ","r.post('/dramas/import-novel', importUpload.single('file'), museGeneration, ",file);
 });
 patch('backend-node/src/app.js',(source,file)=>{
  source=replace(source,'  const config = loadConfig();',"  const config = loadConfig();\n  const generationEnabled = require('./services/museGeneration').enabled(config);",file);
  source=replace(source,'  applyVendorLock(db, logger, config);','  if (generationEnabled) applyVendorLock(db, logger, config);',file);
  source=replace(source,'  taskService.failOrphanedAsyncTasksOnStartup(db, log);','  if (generationEnabled) taskService.failOrphanedAsyncTasksOnStartup(db, log);',file);
  source=replace(source,'  resumeProcessingVideoGenerations(db, log);','  if (generationEnabled) resumeProcessingVideoGenerations(db, log);',file);
  return replace(source,"      status: 'ok',","      status: 'ok',\n      generationBackend: generationEnabled ? 'configured' : 'unconfigured',\n      backgroundGeneration: generationEnabled,",file);
 });
 patch('backend-node/src/server.js',(source,file)=>{
  source=replace(source,"    const { initAgent } = await import('./mastra/index.mjs');","    if (require('./services/museGeneration').enabled(config)) {\n      const { initAgent } = await import('./mastra/index.mjs');",file);
  return replace(source,'    await initAgent({ db, log: logger, config, dataDir });','      await initAgent({ db, log: logger, config, dataDir });\n    }',file);
 });
 for(const[name,signatures]of [
  ['aiClient.js',['async function generateText(db, log, serviceType, userPrompt, systemPrompt, options = {}) {']],
  ['imageClient.js',['async function callImageApi(db, log, opts) {','function createAndGenerateImage(db, log, opts) {']],
  ['videoClient.js',['async function callVideoApi(db, log, opts) {']],
 ])patch('backend-node/src/services/'+name,(source,file)=>{
  for(const signature of signatures)source=replace(source,signature,signature+"\n  require('./museGeneration').assertEnabled(require('../config').loadConfig());",file);
  return source;
 });
 patch('backend-node/src/services/museAdmission.js',(source,file)=>{
  source=replace(source,"  db.prepare(\"UPDATE muse_native_operations SET state='unknown',error_code=CASE WHEN error_code='supplier_usage_not_saved' THEN error_code ELSE 'operation_interrupted' END,updated_at=? WHERE state='reserved'\").run(new Date().toISOString());",
   "  if(require('./museGeneration').enabled(cfg)) db.prepare(\"UPDATE muse_native_operations SET state='unknown',error_code=CASE WHEN error_code='supplier_usage_not_saved' THEN error_code ELSE 'operation_interrupted' END,updated_at=? WHERE state='reserved'\").run(new Date().toISOString());",file);
  return replace(source,'function refreshed(db,row){',"function refreshed(db,row){\n if(!require('./museGeneration').backgroundEnabled())return row;",file);
 });
 patch('backend-node/src/services/museAudioService.js',(source,file)=>replace(source,"db.prepare(\"UPDATE muse_tts_generations SET state='unknown',error_code='process_interrupted' WHERE state='generating'\").run();",
  "if(require('./museGeneration').backgroundEnabled())db.prepare(\"UPDATE muse_tts_generations SET state='unknown',error_code='process_interrupted' WHERE state='generating'\").run();",file));
 patch('backend-node/src/services/musePostproduction.js',(source,file)=>{
  for(const sql of ["UPDATE muse_postproduction_segments SET state='unknown',error_code='process_interrupted' WHERE state='submitting'",
   "UPDATE muse_postproduction_segments SET state='upload_failed',error_code='process_interrupted_before_submit' WHERE state='uploading'"]){
   source=replace(source,`db.prepare(${JSON.stringify(sql)}).run();`,`if(require('./museGeneration').backgroundEnabled())db.prepare(${JSON.stringify(sql)}).run();`,file);
  }
  return source;
 });
 patch('backend-node/src/services/museBudget.js',(source,file)=>{
  const statement="db.prepare(\"UPDATE muse_budget_entries SET outcome='unknown',revision=revision+1,updated_at=? WHERE settled_minor IS NULL AND outcome IN('reserved','accepted') AND source NOT IN('libtv','libtv-cli') AND json_extract(profile_json,'$.currency')<>'LTV' AND json_extract(profile_json,'$.provider') NOT IN('libtv','libtv-cli','libtv-api')\").run(new Date().toISOString());";
  source=replace(source,statement,"if(require('./museGeneration').enabled(cfg)) "+statement,file);
  return replace(source,'function refresh(db,cfg,row){',"function refresh(db,cfg,row){if(!require('./museGeneration').enabled(cfg))return row;",file);
 });
 return pending;
}

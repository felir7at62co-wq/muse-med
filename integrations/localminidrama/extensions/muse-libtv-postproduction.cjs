/** Verified LibTV API derivatives imported by the account gateway; originals and captured inputs remain immutable. */
const {randomUUID,createHash}=require('node:crypto');
const media=require('./musePostproductionMedia'),timing=require('./museLibTvTiming');
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const fail=(code,status=409)=>Object.assign(new Error(code),{code,status});
const sha=value=>createHash('sha256').update(value).digest('hex');
const canonical=value=>Array.isArray(value)?'['+value.map(canonical).join(',')+']':object(value)?'{'+Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>JSON.stringify(key)+':'+canonical(item)).join(',')+'}':JSON.stringify(value);
const digest=value=>sha(canonical(value));
const positive=value=>Number.isSafeInteger(value)&&value>0;
const hex=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
function identifier(value){if(typeof value!=='string'||!/^[A-Za-z0-9_:-]{1,128}$/.test(value))throw fail('libtv_postproduction_invalid_identity',400);return value;}
function limits(cfg){
 const value={...require('./musePostproduction').limits(cfg),output_hosts:['libtv-res.liblib.art'],...cfg.muse_libtv_postproduction};
 if(!Array.isArray(value.output_hosts)||!value.output_hosts.length||value.output_hosts.some(host=>typeof host!=='string'||!/^[a-z0-9.-]+$/.test(host)))throw fail('libtv_postproduction_invalid_hosts',503);
 if(!positive(value.max_input_bytes)||value.max_input_bytes>512*1024*1024||!positive(value.max_output_bytes)||value.max_output_bytes>512*1024*1024||!positive(value.http_timeout_ms)||value.http_timeout_ms>300000||!positive(value.media_timeout_ms)||value.media_timeout_ms>3600000||!positive(value.json_bytes)||value.json_bytes>8*1024*1024)throw fail('libtv_postproduction_invalid_limits',503);
 return value;
}
function schema(db){
 db.exec('CREATE TABLE IF NOT EXISTS muse_libtv_postproduction_schema(version INTEGER NOT NULL,database_id TEXT NOT NULL)');
 const rows=db.prepare('SELECT * FROM muse_libtv_postproduction_schema').all();
 if(rows.length>1||rows[0]&&rows[0].version!==1)throw fail('libtv_postproduction_unsupported_schema',503);
 if(!rows.length)db.transaction(()=>{
  db.exec(`CREATE TABLE muse_libtv_postproduction_imports(operation_id TEXT PRIMARY KEY,request_sha256 TEXT NOT NULL,source_generation_id INTEGER NOT NULL,generation_id INTEGER NOT NULL UNIQUE,project_id INTEGER NOT NULL,storyboard_id INTEGER NOT NULL,record_json TEXT NOT NULL,inputs_json TEXT NOT NULL,receipt_json TEXT NOT NULL,created_at TEXT NOT NULL);
   CREATE TRIGGER muse_libtv_postproduction_import_immutable BEFORE UPDATE ON muse_libtv_postproduction_imports BEGIN SELECT RAISE(ABORT,'libtv_postproduction_import_immutable'); END;`);
  db.prepare('INSERT INTO muse_libtv_postproduction_schema VALUES(1,?)').run(randomUUID());
 }).immediate();
 return db.prepare('SELECT database_id FROM muse_libtv_postproduction_schema').get().database_id;
}
function source(db,generationId){
 if(!positive(generationId))throw fail('libtv_postproduction_source_required',400);
 const row=db.prepare('SELECT g.*,s.video_url AS adopted_url,e.drama_id AS episode_drama_id FROM video_generations g JOIN storyboards s ON s.id=g.storyboard_id JOIN episodes e ON e.id=s.episode_id JOIN dramas d ON d.id=g.drama_id WHERE g.id=? AND g.deleted_at IS NULL AND s.deleted_at IS NULL AND e.deleted_at IS NULL AND d.deleted_at IS NULL').get(generationId);
 if(!row||row.status!=='completed'||!row.local_path||row.drama_id!==row.episode_drama_id)throw fail('libtv_postproduction_completed_source_required');
 return row;
}
function sourceOrigin(db,row,sourceSha){
 const derived=db.prepare('SELECT record_json,receipt_json FROM muse_libtv_postproduction_imports WHERE generation_id=?').get(row.id);
 if(derived){const saved=JSON.parse(derived.record_json),receipt=JSON.parse(derived.receipt_json);if(receipt.sha256!==sourceSha)throw fail('libtv_postproduction_source_changed');return {provider:'libtv-api',operation_id:saved.company_operation_id,project_uuid:saved.origin.project_uuid,node_id:null,result_url:saved.result_url,owner:saved.origin.owner,provider_task_id:saved.provider_task_id};}
 const exists=db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='muse_libtv_cli_imports'").get();
 if(!exists)throw fail('libtv_postproduction_source_origin_unavailable');
 const origins=db.prepare("SELECT i.receipt_json,o.operation_id,o.project_uuid,o.spec_json,o.result_json,u.result_id,u.sha256,u.state FROM muse_libtv_cli_imports i JOIN muse_libtv_cli_operations o ON o.operation_id=i.source_operation_id JOIN muse_libtv_cli_uploads u ON u.upload_id=i.upload_id WHERE i.kind='video' AND i.generation_id=? AND o.state='completed'").all(row.id);
 if(origins.length!==1||origins[0].sha256!==sourceSha||origins[0].state!=='verified')throw fail('libtv_postproduction_source_origin_unavailable');
 const original=origins[0],result=JSON.parse(original.result_json),spec=JSON.parse(original.spec_json);
 const outputs=Array.isArray(result.media_outputs)?result.media_outputs.map((item,index)=>({index,node:item.node,nodeId:item.nodeKey,url:item.url,valid:item.kind==='video'&&item.node?.nodeKey===item.nodeKey&&digest(item.node)===item.nodeSha256&&(item.node.url??item.node.data?.url)?.[item.outputIndex]===item.url})):(result.url??result.data?.url??[]).map((url,index)=>({index,node:result,nodeId:result.nodeKey,url,valid:result.nodeType==='video'||result.data?.type==='video'}));
 const match=outputs.filter(item=>item.valid&&original.result_id==='cli-result-'+item.index+'-'+digest({url:item.url}));
 if(match.length!==1||typeof match[0].nodeId!=='string'||!object(spec.cli_owner))throw fail('libtv_postproduction_source_origin_unavailable');
 return {provider:'libtv-cli',operation_id:original.operation_id,project_uuid:original.project_uuid,node_id:match[0].nodeId,result_url:match[0].url,owner:spec.cli_owner};
}
/** Read source bytes and their recorded vendor result; this performs no supplier request. */
function inspect(db,cfg,generationId){
 const databaseId=schema(db),row=source(db,generationId),policy=limits(cfg),bytes=media.read(cfg,row.local_path,policy.max_input_bytes),sourceSha=sha(bytes);
 return {database_id:databaseId,project_id:row.drama_id,storyboard_id:row.storyboard_id,generation_id:row.id,source_sha256:sourceSha,local_path:row.local_path,metadata:media.probe(cfg,row.local_path,policy),origin:sourceOrigin(db,row,sourceSha)};
}
function validateRecord(db,cfg,input){
 if(!object(input)||input.database_id!==schema(db)||!hex(input.request_sha256)||!hex(input.source_sha256)||input.model!=='volcano-subtitle-eraser'||!object(input.parameters)||!object(input.origin)||!object(input.quote)||!positive(input.project_id)||!positive(input.storyboard_id))throw fail('libtv_postproduction_invalid_import',400);
 identifier(input.operation_id);identifier(input.company_id);identifier(input.company_operation_id);identifier(input.provider_task_id);
 const selected=inspect(db,cfg,input.source_generation_id);
 if(selected.project_id!==input.project_id||selected.storyboard_id!==input.storyboard_id||selected.source_sha256!==input.source_sha256||digest(selected.origin)!==digest(input.origin))throw fail('libtv_postproduction_source_changed');
 if(input.quote.currency!=='LTV'||!(positive(input.quote.reserved_minor)||input.quote.reserved_minor===0&&input.quote.zeroQuote===true)||typeof input.quote.identity!=='string'||!input.quote.identity)throw fail('libtv_postproduction_fee_record_required',400);
 const url=new URL(input.result_url),policy=limits(cfg);
 if(url.protocol!=='https:'||url.username||url.password||url.hash||!policy.output_hosts.includes(url.hostname))throw fail('libtv_postproduction_result_host_refused',400);
 return selected;
}
async function download(fetchImpl,cfg,url){
 const policy=limits(cfg),controller=new AbortController(),timer=setTimeout(()=>controller.abort(),policy.http_timeout_ms);timer.unref?.();
 try{
  const response=await fetchImpl(url,{redirect:'error',signal:controller.signal,headers:{Accept:'video/mp4'}});
  if(!response.ok||!response.body)throw fail('libtv_postproduction_download_unavailable',502);
  const declared=response.headers.get('content-length');if(declared!==null&&(!/^\d+$/.test(declared)||Number(declared)>policy.max_output_bytes)){await response.body.cancel();throw fail('libtv_postproduction_output_limit',413);}
  const reader=response.body.getReader(),parts=[];let size=0;
  try{for(;;){const item=await reader.read();if(item.done)break;size+=item.value.byteLength;if(size>policy.max_output_bytes){await reader.cancel();throw fail('libtv_postproduction_output_limit',413);}parts.push(Buffer.from(item.value));}}finally{reader.releaseLock();}
  if(!size)throw fail('libtv_postproduction_download_empty',502);return Buffer.concat(parts,size);
 }catch(error){if(error.code?.startsWith('libtv_postproduction_'))throw error;throw fail(controller.signal.aborted?'libtv_postproduction_download_timeout':'libtv_postproduction_download_unavailable',502);}
 finally{clearTimeout(timer);}
}
/** Own free imports and deduplicate concurrent requests; the supplier only runs in the company gateway. */
function create({fetchImpl=globalThis.fetch}={}){
 const pending=new WeakMap();
 async function importResult(db,cfg,input){
  schema(db);identifier(input?.operation_id);
  const fingerprint=digest(input),prior=db.prepare('SELECT * FROM muse_libtv_postproduction_imports WHERE operation_id=?').get(input.operation_id);
  if(prior){if(prior.request_sha256!==fingerprint)throw fail('libtv_postproduction_import_conflict');const receipt=JSON.parse(prior.receipt_json);if(sha(media.read(cfg,receipt.local_path,limits(cfg).max_output_bytes))!==receipt.sha256)throw fail('libtv_postproduction_saved_media_changed');return {...receipt,replayed:true};}
  const selected=validateRecord(db,cfg,input);let active=pending.get(db);if(!active){active=new Map();pending.set(db,active);}
  if(active.has(input.operation_id)){const original=active.get(input.operation_id);if(original.fingerprint!==fingerprint)throw fail('libtv_postproduction_import_conflict');return await original.promise;}
  const promise=(async()=>{
   const raw=await download(fetchImpl,cfg,input.result_url),key=sha(input.operation_id),rawPath='libtv-api/raw/'+key+'.mp4',outputPath='libtv-api/media/'+key+'.mp4';
   if(raw.length<12||raw.toString('ascii',4,8)!=='ftyp')throw fail('libtv_postproduction_output_format_changed',422);
   media.save(cfg,rawPath,raw);
   const policy=limits(cfg),prepared=timing.prepare(cfg,selected.local_path,rawPath,'libtv-api/timing/'+key+'.mp4',policy),facts=media.restore(cfg,selected.local_path,prepared.path,outputPath,'erase_subtitles',policy),bytes=media.read(cfg,outputPath,policy.max_output_bytes);
   return db.transaction(()=>{
    const current=inspect(db,cfg,input.source_generation_id);if(current.source_sha256!==selected.source_sha256||digest(current.origin)!==digest(selected.origin))throw fail('libtv_postproduction_source_changed');
    const old=db.prepare('SELECT * FROM muse_libtv_postproduction_imports WHERE operation_id=?').get(input.operation_id);if(old){if(old.request_sha256!==fingerprint)throw fail('libtv_postproduction_import_conflict');return {...JSON.parse(old.receipt_json),replayed:true};}
    const parent=source(db,input.source_generation_id),parentInputs=require('./museStudio').generationInputs(db,cfg,'video',parent),at=new Date().toISOString(),url=String(cfg.storage.base_url||'/static').replace(/\/$/,'')+'/'+outputPath;
    const values={drama_id:parent.drama_id,storyboard_id:parent.storyboard_id,provider:'libtv_api',model:input.model,prompt:parentInputs.prompt??parent.prompt,local_path:outputPath,video_url:url,status:'completed',duration:facts.duration_seconds,created_at:at,updated_at:at,completed_at:at},columns=new Set(db.prepare('PRAGMA table_info(video_generations)').all().map(column=>column.name));
    for(const name of ['drama_id','storyboard_id','provider','model','prompt','local_path','video_url','status'])if(!columns.has(name))throw fail('libtv_postproduction_native_schema_changed',503);
    const entries=Object.entries(values).filter(([name])=>columns.has(name)),inserted=db.prepare('INSERT INTO video_generations('+entries.map(([name])=>name).join(',')+') VALUES('+entries.map(()=>'?').join(',')+')').run(...entries.map(([,value])=>value));
    const generationId=Number(inserted.lastInsertRowid),record={...input,raw_sha256:sha(raw),raw_path:rawPath,metadata:facts,timing_correction:prepared.correction},captured={...parentInputs,media:facts,source:'libtv-api-capture',model:input.model,operationId:input.company_operation_id,requestSha256:input.request_sha256,postproduction:{kind:'erase_subtitles',provider:'libtv-api',parameters:input.parameters,sourceState:'matched',sourceOperationId:parentInputs.operationId??input.origin.operation_id,parentGenerationId:parent.id,sourceNodeId:input.origin.node_id,sourceUrl:input.origin.result_url,sourceModel:parent.model,parent:parentInputs.postproduction??null,providerTaskId:input.provider_task_id,companyId:input.company_id,companyOperationId:input.company_operation_id,quote:input.quote,timingCorrection:prepared.correction}};
    const receipt={operation_id:input.operation_id,source_operation_id:input.company_operation_id,provider:'libtv-api',generation_id:generationId,source_generation_id:parent.id,sha256:sha(bytes),local_path:outputPath,url,raw_sha256:record.raw_sha256,metadata:facts,timing_correction:prepared.correction,replayed:false,adopted:false};
    db.prepare('INSERT INTO muse_libtv_postproduction_imports VALUES(?,?,?,?,?,?,?,?,?,?)').run(input.operation_id,fingerprint,parent.id,generationId,parent.drama_id,parent.storyboard_id,JSON.stringify(record),JSON.stringify(captured),JSON.stringify(receipt),at);
    return receipt;
   }).immediate();
  })();active.set(input.operation_id,{fingerprint,promise});try{return await promise;}finally{active.delete(input.operation_id);}
 }
 return {importResult};
}
/** Read immutable derived inputs without consulting current asset selections. */
function generationInputs(db,kind,row){
 if(kind!=='video'||!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='muse_libtv_postproduction_imports'").get())return null;
 const saved=db.prepare('SELECT inputs_json FROM muse_libtv_postproduction_imports WHERE generation_id=?').get(row.id);return saved?JSON.parse(saved.inputs_json):null;
}
module.exports={schema,inspect,create,generationInputs,...create()};

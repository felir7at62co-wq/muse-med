/** Account-database video postproduction: durable per-segment queues, retained originals and explicit complete-version adoption. */
const {randomUUID}=require('node:crypto');
const media=require('./musePostproductionMedia'),fal=require('./musePostproductionFal');
const active=new WeakMap(),fail=(code,status=400)=>Object.assign(Error(code),{code,status});
const positive=value=>Number.isSafeInteger(Number(value))&&Number(value)>0;
const hash=value=>media.sha(Buffer.from(JSON.stringify(value)));
function operation(value){if(typeof value!=='string'||!/^[A-Za-z0-9_-]{8,128}$/.test(value))throw fail('postproduction_operation_id_required');return value;}
function limits(cfg){const configured=cfg.muse_postproduction||{},values={max_input_bytes:80*1024*1024,max_output_bytes:256*1024*1024,
 http_timeout_ms:120000,media_timeout_ms:180000,json_bytes:2*1024*1024,erase_segment_seconds:4,max_segments:256,concat_batch_size:24,video_crf:18,video_preset:'fast',...configured};
 for(const name of ['max_input_bytes','max_output_bytes','http_timeout_ms','media_timeout_ms','json_bytes'])if(!Number.isSafeInteger(values[name])||values[name]<1)throw fail('postproduction_invalid_limits',503);
 if(values.max_input_bytes>90*1024*1024||values.max_output_bytes>512*1024*1024||values.http_timeout_ms>300000||values.media_timeout_ms>3600000||values.json_bytes>8*1024*1024)throw fail('postproduction_invalid_limits',503);
 if(!Number.isFinite(values.erase_segment_seconds)||values.erase_segment_seconds<=0||values.erase_segment_seconds>=5
  ||!Number.isSafeInteger(values.max_segments)||values.max_segments<1||values.max_segments>4096
  ||!Number.isSafeInteger(values.concat_batch_size)||values.concat_batch_size<2||values.concat_batch_size>64
  ||!Number.isSafeInteger(values.video_crf)||values.video_crf<0||values.video_crf>51||!['ultrafast','superfast','veryfast','faster','fast','medium','slow','slower','veryslow'].includes(values.video_preset))throw fail('postproduction_invalid_segment_limits',503);
 values.output_hosts=configured.output_hosts||['v3.fal.media','v3b.fal.media','storage.googleapis.com'];
 if(!Array.isArray(values.output_hosts)||!values.output_hosts.length||values.output_hosts.some(host=>typeof host!=='string'||!/^[a-z0-9.-]+$/.test(host)))throw fail('postproduction_invalid_hosts',503);return values;}
function schema(db){
 db.exec('CREATE TABLE IF NOT EXISTS muse_postproduction_schema(version INTEGER NOT NULL,database_id TEXT NOT NULL)');
 const versions=db.prepare('SELECT version FROM muse_postproduction_schema').all();
 if(versions.length>1||versions[0]&&versions[0].version!==1)throw fail('postproduction_unsupported_schema',503);
 if(!versions.length)db.transaction(()=>{db.exec(`
 CREATE TABLE muse_postproduction_tasks(operation_id TEXT PRIMARY KEY,request_sha256 TEXT NOT NULL,source_generation_id INTEGER NOT NULL,drama_id INTEGER NOT NULL,storyboard_id INTEGER NOT NULL,kind TEXT NOT NULL,config_id INTEGER NOT NULL,credential_sha256 TEXT NOT NULL,model TEXT NOT NULL,source_path TEXT NOT NULL,source_sha256 TEXT NOT NULL,source_metadata_json TEXT NOT NULL,parameters_json TEXT NOT NULL,segment_plan_json TEXT NOT NULL,checkpoint_path TEXT NOT NULL,state TEXT NOT NULL,raw_path TEXT,raw_sha256 TEXT,local_path TEXT,output_sha256 TEXT,output_metadata_json TEXT,generation_id INTEGER,error_code TEXT,error_origin TEXT,created_at TEXT NOT NULL,completed_at TEXT);
 CREATE TABLE muse_postproduction_segments(task_operation_id TEXT NOT NULL,segment_index INTEGER NOT NULL,start_frame INTEGER NOT NULL,end_frame INTEGER NOT NULL,input_path TEXT,input_sha256 TEXT,source_upload_url TEXT,state TEXT NOT NULL,request_id TEXT,status_url TEXT,response_url TEXT,result_url TEXT,provider_seed INTEGER,raw_path TEXT,raw_sha256 TEXT,error_code TEXT,error_origin TEXT,PRIMARY KEY(task_operation_id,segment_index));
 CREATE TABLE muse_postproduction_adoptions(operation_id TEXT PRIMARY KEY,request_sha256 TEXT NOT NULL,task_operation_id TEXT NOT NULL,created_at TEXT NOT NULL);
 CREATE TRIGGER muse_postproduction_input_immutable BEFORE UPDATE OF request_sha256,source_sha256,source_generation_id,source_path,parameters_json,segment_plan_json,checkpoint_path,model,credential_sha256 ON muse_postproduction_tasks BEGIN SELECT RAISE(ABORT,'postproduction_input_immutable'); END;
 CREATE TRIGGER muse_postproduction_segment_input_immutable BEFORE UPDATE OF start_frame,end_frame,input_sha256 ON muse_postproduction_segments WHEN OLD.input_sha256 IS NOT NULL BEGIN SELECT RAISE(ABORT,'postproduction_segment_input_immutable'); END;
 CREATE TRIGGER muse_postproduction_segment_output_immutable BEFORE UPDATE OF raw_sha256 ON muse_postproduction_segments WHEN OLD.raw_sha256 IS NOT NULL AND NEW.raw_sha256 IS NOT OLD.raw_sha256 BEGIN SELECT RAISE(ABORT,'postproduction_segment_output_immutable'); END;
 CREATE TRIGGER muse_postproduction_output_immutable BEFORE UPDATE OF output_sha256 ON muse_postproduction_tasks WHEN OLD.output_sha256 IS NOT NULL AND NEW.output_sha256 IS NOT OLD.output_sha256 BEGIN SELECT RAISE(ABORT,'postproduction_output_immutable'); END;`);
 db.prepare('INSERT INTO muse_postproduction_schema VALUES(1,?)').run(randomUUID());}).immediate();
 if(!active.has(db)){db.prepare("UPDATE muse_postproduction_segments SET state='unknown',error_code='process_interrupted' WHERE state='submitting'").run();
  db.prepare("UPDATE muse_postproduction_segments SET state='upload_failed',error_code='process_interrupted_before_submit' WHERE state='uploading'").run();active.set(db,new Set());}
}
function database(db,value){schema(db);if(value!==db.prepare('SELECT database_id FROM muse_postproduction_schema').get().database_id)throw fail('postproduction_database_changed',409);}
function source(db,id){if(!positive(id))throw fail('postproduction_source_required');
 const row=db.prepare('SELECT g.*,s.video_url AS adopted_url,e.drama_id AS episode_drama_id FROM video_generations g JOIN storyboards s ON s.id=g.storyboard_id JOIN episodes e ON e.id=s.episode_id WHERE g.id=? AND g.deleted_at IS NULL AND s.deleted_at IS NULL AND e.deleted_at IS NULL').get(Number(id));
 if(!row||row.status!=='completed'||row.drama_id!==row.episode_drama_id||!row.local_path)throw fail('postproduction_completed_source_required',409);return row;}
function inspect(db,cfg,id){schema(db);const row=source(db,id),policy=limits(cfg),bytes=media.read(cfg,row.local_path,policy.max_input_bytes),facts=media.probe(cfg,row.local_path,policy),plan=media.segments(facts,policy);
 return {generation_id:row.id,drama_id:row.drama_id,storyboard_id:row.storyboard_id,source_sha256:media.sha(bytes),local_path:row.local_path,
  adopted:row.adopted_url==='/static/'+row.local_path,metadata:facts,erase_segments:plan,erase_submission_count:plan.length,usage_status:'unreported'};}
function config(db,id,expected){if(!positive(id))throw fail('postproduction_config_required');const row=require('./aiConfigService').getConfig(db,Number(id));
 if(!row||!row.is_active||row.provider!=='fal'||row.service_type!=='muse_postproduction'||!row.api_key||row.base_url!=='https://queue.fal.run')throw fail('postproduction_not_configured',503);
 if(expected&&media.sha(Buffer.from(row.api_key))!==expected)throw fail('postproduction_configuration_changed',409);return row;}
function capabilities(db,cfg){schema(db);limits(cfg);const configs=require('./aiConfigService').listConfigs(db,'muse_postproduction').filter(row=>row.provider==='fal').map(row=>({id:row.id,name:row.name,is_active:row.is_active,key_configured:!!row.api_key}));
 return {database_id:db.prepare('SELECT database_id FROM muse_postproduction_schema').get().database_id,configs,
  upscale:{model:fal.models.upscale,factor:2},erase_subtitles:{model:fal.models.erase_subtitles,per_segment_max_duration_exclusive:5,automatic_frame_segments:true,auto_trim:false},usage_status:'unreported'};}
function saveConfig(db,cfg,log,input){database(db,input.database_id);const configs=require('./aiConfigService');if(configs.getVendorLockStatus(cfg).enabled)throw fail('postproduction_config_locked',403);
 if(typeof input.api_key!=='string'||!input.api_key.trim()||/[\r\n]/.test(input.api_key))throw fail('postproduction_key_required');
 const settings={service_type:'muse_postproduction',provider:'fal',name:typeof input.name==='string'&&input.name.trim()?input.name.trim().slice(0,100):'Fal 视频后期',
  api_key:input.api_key.trim(),base_url:'https://queue.fal.run',model:Object.values(fal.models),is_active:true};
 if(input.id!==undefined){const existing=config(db,input.id);configs.updateConfig(db,log,existing.id,settings);}else configs.createConfig(db,log,settings);
 return capabilities(db,cfg);}
function task(db,id){schema(db);operation(id);const row=db.prepare('SELECT * FROM muse_postproduction_tasks WHERE operation_id=?').get(id);if(!row)throw fail('postproduction_task_not_found',404);return row;}
function parts(db,id){return db.prepare('SELECT * FROM muse_postproduction_segments WHERE task_operation_id=? ORDER BY segment_index').all(id);}
function stateOf(row,segments){if(!segments.length)throw fail('postproduction_segment_records_missing',503);if(row.state==='completed')return 'completed';if(segments.some(part=>part.state==='unknown'))return 'unknown';
 if(row.state==='media_unverified'&&row.error_code)return 'media_unverified';
 if(segments.some(part=>['pending','upload_failed'].includes(part.state)))return 'submission_incomplete';if(segments.some(part=>part.state==='media_unverified'))return 'media_unverified';
 if(segments.every(part=>part.state==='verified'))return 'assembling';if(segments.some(part=>part.state==='uploading'||part.state==='submitting'))return 'submitting';
 return segments.some(part=>part.state==='processing')?'processing':'queued';}
function view(db,row){const storyboard=db.prepare('SELECT video_url FROM storyboards WHERE id=? AND deleted_at IS NULL').get(row.storyboard_id),segments=parts(db,row.operation_id),first=segments[0],error=segments.find(part=>part.error_code);
 return {operation_id:row.operation_id,source_generation_id:row.source_generation_id,drama_id:row.drama_id,storyboard_id:row.storyboard_id,kind:row.kind,model:row.model,
  state:stateOf(row,segments),source_sha256:row.source_sha256,source_metadata:JSON.parse(row.source_metadata_json),parameters:JSON.parse(row.parameters_json),request_id:segments.length===1?first?.request_id:null,
  segment_count:segments.length,segments:segments.map(part=>({index:part.segment_index,start_frame:part.start_frame,end_frame:part.end_frame,state:part.state,request_id:part.request_id,
   input_sha256:part.input_sha256,source_upload_url:part.source_upload_url,raw_sha256:part.raw_sha256,error_code:part.error_code,error_origin:part.error_origin,provider_seed:part.provider_seed})),
  provider_input:segments.length===1&&first?.source_upload_url?{...JSON.parse(row.parameters_json),video_url:first.source_upload_url}:null,provider_seed:segments.length===1?first?.provider_seed:null,
  raw_sha256:row.raw_sha256,output_sha256:row.output_sha256,output_metadata:row.output_metadata_json?JSON.parse(row.output_metadata_json):null,
  generation_id:row.generation_id,local_path:row.local_path,url:row.local_path?'/static/'+row.local_path:null,error_code:row.error_code||error?.error_code||null,error_origin:row.error_origin||error?.error_origin||null,
  adopted:!!row.local_path&&storyboard?.video_url==='/static/'+row.local_path,created_at:row.created_at,completed_at:row.completed_at,usage_status:'unreported',quality_review:'not_reviewed'};}
function readTask(db,id){return view(db,task(db,id));}
function history(db,input){schema(db);if(!positive(input.drama_id))throw fail('postproduction_project_required');const rows=db.prepare('SELECT * FROM muse_postproduction_tasks WHERE drama_id=? ORDER BY created_at DESC LIMIT 200').all(Number(input.drama_id));return {items:rows.filter(row=>input.storyboard_id===undefined||row.storyboard_id===Number(input.storyboard_id)).map(row=>view(db,row))};}
function sources(db,input){if(!positive(input.drama_id))throw fail('postproduction_project_required');return {items:db.prepare("SELECT id,drama_id,storyboard_id,provider,model,status,local_path FROM video_generations WHERE drama_id=? AND status='completed' AND local_path IS NOT NULL AND deleted_at IS NULL ORDER BY id DESC LIMIT 500").all(Number(input.drama_id))};}
function policyFor(cfg,row){return {...limits(cfg),...JSON.parse(row.segment_plan_json).encoding};}
function engine(db,cfg){return require('./musePostproductionSegments').create(db,cfg,{
 active:active.get(db),task:id=>task(db,id),read:id=>readTask(db,id),config:(id,expected)=>config(db,id,expected),policy:row=>policyFor(cfg,row),safeError,safeOrigin,
 complete:(row,path,outputSha,facts,segments)=>db.transaction(()=>{
  const now=new Date().toISOString(),saved=task(db,row.operation_id);if(saved.generation_id)return;
  const original=source(db,row.source_generation_id),one=segments.length===1?segments[0]:null;
  const generated=db.prepare(`INSERT INTO video_generations(drama_id,storyboard_id,provider,prompt,model,duration,video_url,local_path,status,task_id,completed_at,created_at,updated_at,seed) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
   .run(row.drama_id,row.storyboard_id,'fal',original.prompt||'',row.model,facts.duration_seconds,'/static/'+path,path,'completed',one?.request_id||null,now,now,now,one?.provider_seed??null);
  db.prepare("UPDATE muse_postproduction_tasks SET state='completed',local_path=?,output_sha256=?,output_metadata_json=?,generation_id=?,error_code=NULL,error_origin=NULL,completed_at=? WHERE operation_id=?")
   .run(path,outputSha,JSON.stringify(facts),Number(generated.lastInsertRowid),now,row.operation_id);
 }).immediate(),
 });}
async function submit(db,cfg,input){
 database(db,input.database_id);const id=operation(input.operation_id),kind=input.kind;if(!Object.hasOwn(fal.models,kind))throw fail('postproduction_kind_required');
 if(!positive(input.source_generation_id)||!positive(input.config_id)||typeof input.source_sha256!=='string'||!/^[a-f0-9]{64}$/.test(input.source_sha256))throw fail('postproduction_explicit_source_required');
 const parameters=kind==='upscale'?{upscale_mode:'factor',upscale_factor:2,output_format:'X264 (.mp4)',enable_safety_checker:true,sync_mode:false}
  :{prompt:typeof input.prompt==='string'?input.prompt.trim():'',auto_trim:false,preserve_audio:true,output_container_and_codec:'mp4_h264'};
 if(kind==='erase_subtitles'&&(!parameters.prompt||parameters.prompt.length>500))throw fail('postproduction_erase_prompt_required');
 const requestHash=hash({source_generation_id:Number(input.source_generation_id),config_id:Number(input.config_id),source_sha256:input.source_sha256,kind,parameters});
 const previous=db.prepare('SELECT * FROM muse_postproduction_tasks WHERE operation_id=?').get(id);
 if(previous){if(previous.request_sha256!==requestHash)throw fail('postproduction_operation_conflict',409);return view(db,previous);}
 const current=inspect(db,cfg,input.source_generation_id),policy=limits(cfg),provider=config(db,input.config_id);
 if(current.source_sha256!==input.source_sha256)throw fail('postproduction_source_changed',409);
 if(!current.adopted)throw fail('postproduction_source_must_be_adopted',409);
 const segments=kind==='erase_subtitles'?media.segments(current.metadata,policy):[{index:1,start_frame:0,end_frame:current.metadata.frames}];
 const bytes=media.read(cfg,current.local_path,policy.max_input_bytes);if(media.sha(bytes)!==current.source_sha256)throw fail('postproduction_source_changed',409);
 const extension=/\.(mp4|mov|webm|mkv)$/i.exec(current.local_path)?.[1]?.toLowerCase()||'mp4';
 const checkpoint='video/muse/postproduction/'+id+'/original-'+current.source_sha256+'.'+extension;
 const plan={segments,encoding:{erase_segment_seconds:policy.erase_segment_seconds,video_crf:policy.video_crf,video_preset:policy.video_preset,concat_batch_size:policy.concat_batch_size}};
 db.transaction(()=>{
  db.prepare(`INSERT INTO muse_postproduction_tasks(operation_id,request_sha256,source_generation_id,drama_id,storyboard_id,kind,config_id,credential_sha256,model,source_path,source_sha256,source_metadata_json,parameters_json,segment_plan_json,checkpoint_path,state,created_at)
   VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'preparing',?)`).run(id,requestHash,current.generation_id,current.drama_id,current.storyboard_id,kind,provider.id,media.sha(Buffer.from(provider.api_key)),fal.models[kind],current.local_path,current.source_sha256,JSON.stringify(current.metadata),JSON.stringify(parameters),JSON.stringify(plan),checkpoint,new Date().toISOString());
  for(const part of segments)db.prepare("INSERT INTO muse_postproduction_segments(task_operation_id,segment_index,start_frame,end_frame,state) VALUES(?,?,?,?,'pending')").run(id,part.index,part.start_frame,part.end_frame);
 }).immediate();
 media.save(cfg,checkpoint,bytes);
 return await engine(db,cfg).dispatch(id);
}
function safeError(error){return typeof error.code==='string'&&/^[a-z_]+$/.test(error.code)?error.code:'postproduction_unconfirmed';}
function safeOrigin(error){if(typeof error.origin!=='string')return null;try{const url=new URL(error.origin);return url.protocol==='https:'&&url.origin===error.origin?url.origin:null;}catch(invalid){return null;}}
async function continueSubmission(db,cfg,id,input){database(db,input.database_id);return await engine(db,cfg).dispatch(operation(id));}
async function refresh(db,cfg,id){task(db,id);return await engine(db,cfg).refresh(id);}
function adopt(db,cfg,id,input){database(db,input.database_id);const row=task(db,id),adoption=operation(input.operation_id),policy=limits(cfg);
 if(row.state!=='completed'||input.sha256!==row.output_sha256||typeof input.expected_video_url!=='string')throw fail('postproduction_verified_version_required',409);
 if(media.sha(media.read(cfg,row.local_path,policy.max_output_bytes))!==row.output_sha256||media.sha(media.read(cfg,row.source_path,policy.max_input_bytes))!==row.source_sha256)throw fail('postproduction_media_changed',409);
 media.probe(cfg,row.local_path,policy);const requestHash=hash({task:id,sha256:input.sha256,expected_video_url:input.expected_video_url});
 db.transaction(()=>{
  const previous=db.prepare('SELECT * FROM muse_postproduction_adoptions WHERE operation_id=?').get(adoption);
  if(previous){if(previous.request_sha256!==requestHash)throw fail('postproduction_operation_conflict',409);return;}
  const current=db.prepare('SELECT video_url FROM storyboards WHERE id=? AND deleted_at IS NULL').get(row.storyboard_id);
  const generation=db.prepare('SELECT local_path FROM video_generations WHERE id=? AND deleted_at IS NULL').get(row.generation_id);
  if(!generation||generation.local_path!==row.local_path||!current||current.video_url!==input.expected_video_url)throw fail('postproduction_adoption_changed',409);
  db.prepare('UPDATE storyboards SET video_url=?,updated_at=? WHERE id=?').run('/static/'+row.local_path,new Date().toISOString(),row.storyboard_id);
  db.prepare('INSERT INTO muse_postproduction_adoptions VALUES(?,?,?,?)').run(adoption,requestHash,id,new Date().toISOString());
 }).immediate();return readTask(db,id);}
function generationSource(db,id){schema(db);const row=db.prepare('SELECT * FROM muse_postproduction_tasks WHERE generation_id=?').get(Number(id));
 if(!row)return null;const value=view(db,row);return {operation_id:value.operation_id,source_generation_id:value.source_generation_id,source_sha256:value.source_sha256,
  kind:value.kind,model:value.model,request_id:value.request_id,parameters:value.parameters,provider_seed:value.provider_seed,provider_input:value.provider_input,
  segments:value.segments,output_sha256:value.output_sha256,quality_review:'not_reviewed'};}
module.exports={schema,limits,capabilities,saveConfig,sources,inspect,submit,continueSubmission,refresh,readTask,history,adopt,generationSource};

/** Durable LibTV Agent tasks, explicit result import and immutable native-generation lineage. */
const fs=require('node:fs'),path=require('node:path'),{createHash,randomUUID}=require('node:crypto');
const http=require('./museLibTvHttp'),media=require('./musePostproductionMedia'),audio=require('./museLibTvAudio'),budget=require('./museBudget');
const running=new WeakMap(),imports=new WeakMap(),observations=new WeakMap(),sha=value=>createHash('sha256').update(value).digest('hex'),digest=value=>sha(JSON.stringify(value)),now=()=>new Date().toISOString(),fail=http.fail;
const operation=value=>{if(typeof value!=='string'||!/^[A-Za-z0-9_-]{8,128}$/.test(value))throw fail('libtv_operation_id_required',400);return value};
function schema(db){
 db.exec('CREATE TABLE IF NOT EXISTS muse_libtv_schema(version INTEGER NOT NULL,database_id TEXT NOT NULL)');const rows=db.prepare('SELECT * FROM muse_libtv_schema').all();
 if(rows.length>1||rows[0]&&![1,2,3].includes(rows[0].version))throw fail('libtv_unsupported_schema',503);
 if(!rows.length)db.transaction(()=>{db.exec(`
 CREATE TABLE muse_libtv_tasks(operation_id TEXT PRIMARY KEY,request_sha256 TEXT NOT NULL,config_id INTEGER NOT NULL,credential_sha256 TEXT NOT NULL,api_origin TEXT NOT NULL,drama_id INTEGER NOT NULL,storyboard_id INTEGER,kind TEXT NOT NULL,prompt TEXT NOT NULL,frame_type TEXT,references_json TEXT NOT NULL,state TEXT NOT NULL,session_id TEXT,remote_project_id TEXT,baseline_json TEXT,messages_json TEXT NOT NULL DEFAULT '[]',results_json TEXT NOT NULL DEFAULT '[]',sent_message TEXT,error_code TEXT,operator_note TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
 CREATE UNIQUE INDEX muse_libtv_one_open_credential ON muse_libtv_tasks(credential_sha256) WHERE state NOT IN ('operator_confirmed','preparation_failed');
 CREATE TABLE muse_libtv_imports(operation_id TEXT PRIMARY KEY,request_sha256 TEXT NOT NULL,task_id TEXT NOT NULL,result_id TEXT NOT NULL,state TEXT NOT NULL,local_path TEXT NOT NULL,sha256 TEXT,media_json TEXT,generation_id INTEGER,error_code TEXT,created_at TEXT NOT NULL,UNIQUE(task_id,result_id));
 CREATE TRIGGER muse_libtv_task_input_immutable BEFORE UPDATE OF request_sha256,config_id,credential_sha256,api_origin,drama_id,storyboard_id,kind,prompt,frame_type,references_json ON muse_libtv_tasks BEGIN SELECT RAISE(ABORT,'libtv_input_immutable'); END;
 CREATE TRIGGER muse_libtv_import_output_immutable BEFORE UPDATE OF sha256,generation_id ON muse_libtv_imports WHEN OLD.sha256 IS NOT NULL AND (NEW.sha256 IS NOT OLD.sha256 OR NEW.generation_id IS NOT OLD.generation_id) BEGIN SELECT RAISE(ABORT,'libtv_output_immutable'); END;
 `);db.prepare('INSERT INTO muse_libtv_schema VALUES(1,?)').run(randomUUID())}).immediate();
 if(db.prepare('SELECT version FROM muse_libtv_schema').get().version===1)db.transaction(()=>{
  db.exec('CREATE TABLE muse_libtv_abandoned_submissions(operation_id TEXT PRIMARY KEY,created_at TEXT NOT NULL)');
  db.prepare('UPDATE muse_libtv_schema SET version=2 WHERE version=1').run();
 }).immediate();
 if(db.prepare('SELECT version FROM muse_libtv_schema').get().version===2)db.transaction(()=>{
  db.exec(`CREATE TABLE muse_libtv_project_bindings(drama_id INTEGER NOT NULL,credential_sha256 TEXT NOT NULL,config_id INTEGER NOT NULL,session_id TEXT NOT NULL,remote_project_id TEXT NOT NULL,context_mode TEXT NOT NULL,binding_sha256 TEXT NOT NULL,revision INTEGER NOT NULL,PRIMARY KEY(drama_id,credential_sha256),UNIQUE(credential_sha256,session_id),UNIQUE(credential_sha256,remote_project_id));
  CREATE TRIGGER muse_libtv_task_binding_immutable BEFORE UPDATE OF session_id,remote_project_id ON muse_libtv_tasks WHEN OLD.session_id IS NOT NULL AND (NEW.session_id IS NOT OLD.session_id OR NEW.remote_project_id IS NOT OLD.remote_project_id) BEGIN SELECT RAISE(ABORT,'libtv_task_binding_immutable'); END;`);
  db.prepare('UPDATE muse_libtv_schema SET version=3 WHERE version=2').run();
 }).immediate();
 if(!running.has(db)){db.prepare("UPDATE muse_libtv_tasks SET state='unknown',error_code='libtv_submission_interrupted',updated_at=? WHERE state IN ('preparing','sending')").run(now());running.set(db,new Map());imports.set(db,new Map());observations.set(db,new Set())}
 return db.prepare('SELECT database_id FROM muse_libtv_schema').get().database_id;
}
function config(db,cfg,id,expected){const c=require('./aiConfigService').getConfig(db,Number(id));
 if(!c||!c.is_active||c.provider!=='libtv'||c.service_type!=='libtv')throw fail('libtv_not_configured',503);
 const limits=http.limits(cfg),origin=http.url(c.base_url,limits.api_origins,limits).origin,identity=sha(origin+'\n'+c.api_key);
 if(expected&&identity!==expected)throw fail('libtv_credentials_changed',409);return {c,limits,origin,identity,api:http.create(c,limits)};
}
function target(db,input){const id=Number(input.project_id),project=db.prepare('SELECT id FROM dramas WHERE id=? AND deleted_at IS NULL').get(id);if(!project)throw fail('libtv_project_not_found',404);
 const storyboard=input.storyboard_id==null?null:Number(input.storyboard_id);if(storyboard!==null&&!db.prepare('SELECT s.id FROM storyboards s JOIN episodes e ON e.id=s.episode_id WHERE s.id=? AND e.drama_id=? AND s.deleted_at IS NULL AND e.deleted_at IS NULL').get(storyboard,id))throw fail('libtv_package_not_found',404);
 return {drama_id:id,storyboard_id:storyboard};
}
const bindingRow=(db,project,identity)=>db.prepare('SELECT * FROM muse_libtv_project_bindings WHERE drama_id=? AND credential_sha256=?').get(project,identity);
const publicBinding=value=>value?{session_id:value.session_id,remote_project_id:value.remote_project_id,context_mode:value.context_mode,binding_sha256:value.binding_sha256}:null;
function projectBinding(db,cfg,project,input){const database_id=schema(db),selected=config(db,cfg,input.config_id),where=target(db,{project_id:project});return {database_id,project_id:where.drama_id,config_id:Number(input.config_id),binding:publicBinding(bindingRow(db,where.drama_id,selected.identity))};}
function previewHash(database,project,configId,credential,session,remote,mode,previous){return digest([database,project,configId,credential,session,remote,mode,previous]);}
async function previewBinding(db,cfg,project,input){
 const database=schema(db);if(input.database_id!==database)throw fail('libtv_database_changed',409);
 const selected=config(db,cfg,input.config_id),where=target(db,{project_id:project}),mode=input.session_id===undefined?'shared_default':'selected_session';
 const bound=await selected.api.bind(input.session_id);config(db,cfg,input.config_id,selected.identity);
 const previous=bindingRow(db,where.drama_id,selected.identity)?.binding_sha256??null;
 return {database_id:database,project_id:where.drama_id,config_id:Number(input.config_id),session_id:bound.session_id,remote_project_id:bound.project_id,context_mode:mode,expected_binding_sha256:previous,
  preview_sha256:previewHash(database,where.drama_id,Number(input.config_id),selected.identity,bound.session_id,bound.project_id,mode,previous)};
}
async function bindProject(db,cfg,project,input){
 const database=schema(db);if(input.database_id!==database)throw fail('libtv_database_changed',409);
 if(input.project_id!==undefined&&Number(input.project_id)!==Number(project))throw fail('libtv_binding_preview_changed',409);
 const selected=config(db,cfg,input.config_id),where=target(db,{project_id:project}),session=http.identity(input.session_id),remote=http.identity(input.remote_project_id),mode=input.context_mode;
 if(input.acknowledge_context!==true||!['selected_session','shared_default'].includes(mode)||mode==='shared_default'&&input.acknowledge_shared_default!==true)throw fail('libtv_context_acknowledgement_required',400);
 if(input.expected_binding_sha256!==null&&(typeof input.expected_binding_sha256!=='string'||!/^[a-f0-9]{64}$/.test(input.expected_binding_sha256)))throw fail('libtv_binding_changed',409);
 if(input.preview_sha256!==previewHash(database,where.drama_id,Number(input.config_id),selected.identity,session,remote,mode,input.expected_binding_sha256))throw fail('libtv_binding_preview_changed',409);
 const actual=await selected.api.bind(session);if(actual.project_id!==remote)throw fail('libtv_project_changed',409);
 return db.transaction(()=>{
  config(db,cfg,input.config_id,selected.identity);target(db,{project_id:project});
  const previous=bindingRow(db,where.drama_id,selected.identity);
  if(previous?.session_id===session&&previous.remote_project_id===remote&&previous.context_mode===mode&&previous.config_id===Number(input.config_id))return projectBinding(db,cfg,project,input);
  if((previous?.binding_sha256??null)!==input.expected_binding_sha256)throw fail('libtv_binding_changed',409);
  if(db.prepare("SELECT 1 FROM muse_libtv_tasks WHERE drama_id=? AND credential_sha256=? AND state NOT IN ('operator_confirmed','preparation_failed')").get(where.drama_id,selected.identity))throw fail('libtv_previous_task_still_open',409);
  if(db.prepare('SELECT 1 FROM muse_libtv_project_bindings WHERE credential_sha256=? AND (session_id=? OR remote_project_id=?) AND drama_id<>?').get(selected.identity,session,remote,where.drama_id))throw fail('libtv_session_already_bound',409);
  const revision=(previous?.revision??0)+1,binding=digest([where.drama_id,selected.identity,Number(input.config_id),session,remote,mode,revision]);
  db.prepare('INSERT INTO muse_libtv_project_bindings VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(drama_id,credential_sha256) DO UPDATE SET config_id=excluded.config_id,session_id=excluded.session_id,remote_project_id=excluded.remote_project_id,context_mode=excluded.context_mode,binding_sha256=excluded.binding_sha256,revision=excluded.revision').run(where.drama_id,selected.identity,Number(input.config_id),session,remote,mode,binding,revision);
  return projectBinding(db,cfg,project,input);
 }).immediate();
}
function reference(cfg,input,c){if(!input||typeof input.local_path!=='string'||!/^(?:image\/(?:png|jpeg|webp)|video\/(?:mp4|webm|quicktime))$/.test(input.mime_type||''))throw fail('libtv_reference_type_refused',400);
 const bytes=media.read(cfg,input.local_path,c.max_upload_bytes);if(input.sha256!==sha(bytes))throw fail('libtv_reference_changed',409);return {local_path:input.local_path,mime_type:input.mime_type,sha256:input.sha256,size_bytes:bytes.length};
}
function referenceSources(db,projectId){target(db,{project_id:projectId});return ['image','video'].flatMap(kind=>db.prepare('SELECT id,local_path FROM '+kind+"_generations WHERE drama_id=? AND status='completed' AND deleted_at IS NULL AND local_path IS NOT NULL ORDER BY id DESC LIMIT 100").all(Number(projectId)).map(v=>({source_id:kind+':'+v.id,label:(kind==='image'?'图片':'视频')+' #'+v.id,kind})));}
function resolveReference(db,cfg,input){if(input.database_id!==schema(db))throw fail('libtv_database_changed',409);target(db,{project_id:input.project_id});const match=/^(image|video):([1-9]\d*)$/.exec(input.source_id||'');if(!match)throw fail('libtv_reference_not_found',404);
 const v=db.prepare('SELECT local_path FROM '+match[1]+"_generations WHERE id=? AND drama_id=? AND status='completed' AND deleted_at IS NULL").get(Number(match[2]),Number(input.project_id));if(!v?.local_path)throw fail('libtv_reference_not_found',404);
 const bytes=media.read(cfg,v.local_path,http.limits(cfg).max_upload_bytes),ext=path.extname(v.local_path).toLowerCase(),mime={'.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.mp4':'video/mp4','.mov':'video/quicktime','.webm':'video/webm'}[ext];
 if(!mime||!mime.startsWith(match[1]+'/'))throw fail('libtv_reference_type_refused',400);return reference(cfg,{local_path:v.local_path,mime_type:mime,sha256:sha(bytes)},http.limits(cfg));
}
function row(db,id){const value=db.prepare('SELECT * FROM muse_libtv_tasks WHERE operation_id=?').get(operation(id));if(!value)throw fail('libtv_task_not_found',404);return value}
function snapshot(value){return digest([value.operation_id,value.state,value.messages_json,value.results_json,value.error_code,value.operator_note,value.updated_at])}
function view(db,value){const {credential_sha256,baseline_json,sent_message,references_json,messages_json,results_json,...safe}=value;return {...safe,database_id:schema(db),snapshot:snapshot(value),references:JSON.parse(references_json),messages:JSON.parse(messages_json),results:JSON.parse(results_json),
  capabilities:{model_selection_verified:false,duration_enforced:false,formal_voice_binding:false,supplier_terminal_reported:false,usage_reported:false,billing_verified:false,cannot_enforce_supplier_cap:true}};
}
function get(db,id){schema(db);return view(db,row(db,id))}
/** Read original submission ownership without dispatching; absence alone does not cancel a late request. */
function submission(db,id){const databaseId=schema(db);id=operation(id);const value=db.prepare('SELECT * FROM muse_libtv_tasks WHERE operation_id=?').get(id),abandoned=db.prepare('SELECT created_at FROM muse_libtv_abandoned_submissions WHERE operation_id=?').get(id);
 return {database_id:databaseId,operation_id:id,state:abandoned?'abandoned':value?'recorded':'not_recorded',can_abandon:!abandoned&&(!value||value.state==='preparation_failed'),task:value?view(db,value):null};
}
/** Atomically refuse future dispatch of a never-submitted ID; active or uncertain supplier work is retained. */
function abandonSubmission(db,id,input){if(input.database_id!==schema(db))throw fail('libtv_database_changed',409);id=operation(id);if(input.acknowledge_no_paid_dispatch!==true)throw fail('libtv_submission_abandonment_required',400);
 return db.transaction(()=>{const current=submission(db,id);if(current.state==='abandoned')return current;if(!current.can_abandon)throw fail('libtv_submission_not_abandonable',409);
  db.prepare('INSERT INTO muse_libtv_abandoned_submissions VALUES(?,?)').run(id,now());return submission(db,id);
 }).immediate();
}
function list(db,projectId){schema(db);const rows=projectId===undefined?db.prepare('SELECT * FROM muse_libtv_tasks ORDER BY created_at DESC LIMIT 100').all():db.prepare('SELECT * FROM muse_libtv_tasks WHERE drama_id=? ORDER BY created_at DESC LIMIT 100').all(Number(projectId));return rows.map(value=>view(db,value))}
function update(db,id,state,extra={}){const allowed=['session_id','remote_project_id','baseline_json','messages_json','results_json','sent_message','error_code','operator_note'];if(Object.keys(extra).some(key=>!allowed.includes(key)))throw fail('libtv_internal_update_refused',503);
 db.prepare(`UPDATE muse_libtv_tasks SET state=?,updated_at=?${Object.keys(extra).map(key=>','+key+'=?').join('')} WHERE operation_id=?`).run(state,now(),...Object.values(extra),id);
}
function cleanMessages(values,c){return values.map(v=>{if(!v||typeof v.id!=='string'||!v.id||v.id.length>256||typeof v.role!=='string'||v.role.length>32||typeof v.content!=='string'||v.content.length>c.max_message_chars)throw fail('libtv_message_identity_missing');
 return {id:v.id,role:v.role,content:v.content,...Number.isSafeInteger(v.seq)&&v.seq>=0?{seq:v.seq}:{}}});}
function candidates(messages,c){const found=[];
 for(const m of messages){let entries=[];if(m.role==='tool'){let parsed;try{parsed=JSON.parse(m.content)}catch(error){if(!(error instanceof SyntaxError))throw error}
  const result=parsed?.task_result;if(result&&typeof result==='object')for(const [name,kind]of [['images','image'],['videos','video'],['audios','audio']])if(Array.isArray(result[name]))for(const item of result[name])if(item&&typeof item==='object')entries.push({url:item.previewPath||item.url,kind});
 }else if(m.role==='assistant'){for(const match of m.content.matchAll(/https:\/\/libtv-res\.liblib\.art\/[^\s"'<>]+\.(?:png|jpe?g|webp|mp4|mov|webm)(?:\?[^\s"'<>]*)?/gi))entries.push({url:match[0],kind:/\.(mp4|mov|webm)(?:\?|$)/i.test(match[0])?'video':'image'})}
 for(const entry of entries){if(typeof entry.url!=='string')continue;try{const address=http.url(entry.url,c.media_origins,c).href,id=digest([m.id,entry.kind,address]);if(!found.some(item=>item.id===id))found.push({id,message_id:m.id,...m.seq===undefined?{}:{seq:m.seq},kind:entry.kind,url:address,finality:'unverified'})}catch(error){if(error.code!=='libtv_origin_refused'&&error.code!=='libtv_invalid_url')throw error}}
 }return found;
}
async function prepare(db,cfg,id){let dispatched=false;
 try{const t=row(db,id),selected=config(db,cfg,t.config_id,t.credential_sha256),bound=await selected.api.bind(t.session_id);if(bound.session_id!==t.session_id||bound.project_id!==t.remote_project_id)throw fail('libtv_project_changed',409);
  const baseline=cleanMessages(await selected.api.observe(bound.session_id),selected.limits);update(db,id,'preparing',{baseline_json:JSON.stringify(baseline.map(v=>v.id))});
  const uploaded=[];for(const ref of JSON.parse(t.references_json)){const bytes=media.read(cfg,ref.local_path,selected.limits.max_upload_bytes);if(sha(bytes)!==ref.sha256)throw fail('libtv_reference_changed',409);
   if(ref.mime_type.startsWith('image/'))await require('sharp')(bytes,{limitInputPixels:64000000}).raw().toBuffer();else media.probe(cfg,ref.local_path,{...selected.limits,max_output_bytes:selected.limits.max_upload_bytes});
   uploaded.push(await selected.api.upload(bytes,path.basename(ref.local_path),ref.mime_type))}
  const message=t.prompt+(uploaded.length?'\n\n参考素材：\n'+uploaded.join('\n'):'');if(message.length>selected.limits.max_message_chars)throw fail('libtv_message_limit',400);config(db,cfg,t.config_id,t.credential_sha256);update(db,id,'sending',{sent_message:message});dispatched=true;
  const ack=await selected.api.send(bound.session_id,message);if(ack.project_id!==bound.project_id)throw fail('libtv_project_changed');
  update(db,id,'submitted');budget.outcome(db,cfg,'libtv',id,'accepted');
 }catch(error){update(db,id,dispatched?'unknown':'preparation_failed',{error_code:/^libtv_/.test(error.code||'')?error.code:'libtv_operation_unconfirmed'});budget.outcome(db,cfg,'libtv',id,dispatched?'unknown':'failed')}
}
function start(db,cfg,input){if(input.database_id!==schema(db))throw fail('libtv_database_changed',409);const id=operation(input.operation_id);if(db.prepare('SELECT 1 FROM muse_libtv_abandoned_submissions WHERE operation_id=?').get(id))throw fail('libtv_submission_abandoned',409);const selected=config(db,cfg,input.config_id),where=target(db,input);
 if(input.acknowledge_agent_mode!==true||!['image','video'].includes(input.kind)||typeof input.prompt!=='string'||!input.prompt.trim()||input.prompt.length>selected.limits.max_message_chars)throw fail('libtv_agent_acknowledgement_required',400);
 if(input.model||input.duration||input.formal_voice_references?.length)throw fail('libtv_precise_controls_not_supported',400);
 if(input.frame_type!=null&&!['first','last','key'].includes(input.frame_type))throw fail('libtv_frame_type_invalid',400);const refs=input.references??[];if(!Array.isArray(refs)||refs.length>selected.limits.max_references)throw fail('libtv_reference_limit',400);
 const frozen=refs.map(ref=>reference(cfg,ref,selected.limits)),spec={...where,config_id:Number(input.config_id),kind:input.kind,prompt:input.prompt,frame_type:input.frame_type??null,references:frozen,agent_mode_acknowledged:true,...input.binding_sha256===undefined?{}:{binding_sha256:input.binding_sha256}},hash=digest(spec);
 const existing=db.prepare('SELECT * FROM muse_libtv_tasks WHERE operation_id=?').get(id);if(existing){if(existing.request_sha256!==hash)throw fail('libtv_operation_changed',409);return view(db,existing)}
 const binding=bindingRow(db,where.drama_id,selected.identity);if(!binding||input.binding_sha256!==binding.binding_sha256)throw fail('libtv_project_binding_required',409);
 db.transaction(()=>{config(db,cfg,input.config_id,selected.identity);if(bindingRow(db,where.drama_id,selected.identity)?.binding_sha256!==binding.binding_sha256)throw fail('libtv_binding_changed',409);if(db.prepare('SELECT 1 FROM muse_libtv_abandoned_submissions WHERE operation_id=?').get(id))throw fail('libtv_submission_abandoned',409);if(db.prepare("SELECT operation_id FROM muse_libtv_tasks WHERE credential_sha256=? AND state NOT IN ('operator_confirmed','preparation_failed')").get(selected.identity))throw fail('libtv_previous_task_still_open',409);
  const reservation=budget.reserve(db,cfg,{source:'libtv',operation_id:id,project_id:where.drama_id,request_sha256:hash,service:'agent-task',config_id:Number(input.config_id),provider:'libtv',model:'agent-task',origin:selected.origin,quantity:1});if(!reservation.dispatch_allowed)throw fail('libtv_budget_submission_already_reserved',409);
  db.prepare('INSERT INTO muse_libtv_tasks(operation_id,request_sha256,config_id,credential_sha256,api_origin,drama_id,storyboard_id,kind,prompt,frame_type,references_json,state,created_at,updated_at,session_id,remote_project_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id,hash,Number(input.config_id),selected.identity,selected.origin,where.drama_id,where.storyboard_id,input.kind,input.prompt,spec.frame_type,JSON.stringify(frozen),'preparing',now(),now(),binding.session_id,binding.remote_project_id);
 }).immediate();
 const active=running.get(db),promise=prepare(db,cfg,id).catch(error=>{console.error('[muse-libtv] Task outcome could not be saved; inspect the original operation before any new submission.');try{update(db,id,'unknown',{error_code:'libtv_outcome_not_saved'})}catch(storageError){console.error('[muse-libtv] Task storage is unavailable.')}}).finally(()=>active.delete(id));active.set(id,promise);return get(db,id);
}
async function observe(db,cfg,id){schema(db);const busy=observations.get(db);if(busy.has(id))throw fail('libtv_observation_busy',409);busy.add(id);try{const t=row(db,id);if(!t.session_id||!t.baseline_json)throw fail('libtv_no_observable_session',409);const selected=config(db,cfg,t.config_id,t.credential_sha256),all=cleanMessages(await selected.api.observe(t.session_id),selected.limits),baseline=new Set(JSON.parse(t.baseline_json)),fresh=all.filter(v=>!baseline.has(v.id)),current=row(db,id),old=JSON.parse(current.messages_json);
 const combined=new Map(old.map(v=>[v.id,v]));for(const item of fresh)combined.set(item.id,item);if(combined.size>selected.limits.max_messages)throw fail('libtv_saved_message_limit',413);
 const inputUrls=new Set([...String(current.sent_message||'').matchAll(/https?:\/\/[^\s"'<>]+/g)].map(v=>{try{const u=new URL(v[0]);return u.origin+u.pathname}catch(error){return ''}}));
 const messages=[...combined.values()],previous=JSON.parse(current.results_json),results=new Map(previous.map(v=>[v.id,v]));for(const item of candidates(fresh,selected.limits)){const u=new URL(item.url);if(!inputUrls.has(u.origin+u.pathname))results.set(item.id,item)}
 update(db,id,current.state==='operator_confirmed'?current.state:results.size?'results_available':current.state==='unknown'?'unknown':'observing',{messages_json:JSON.stringify(messages),results_json:JSON.stringify([...results.values()])});return get(db,id)}finally{busy.delete(id)}
}
function confirm(db,cfg,id,input){schema(db);return db.transaction(()=>{const t=row(db,id);if(input.database_id!==schema(db)||input.expected_snapshot!==snapshot(t))throw fail('libtv_confirmation_conflict',409);
 if(input.acknowledge_external_task_may_continue!==true||typeof input.note!=='string'||!input.note.trim()||input.note.length>2000||['preparing','sending','preparation_failed'].includes(t.state))throw fail('libtv_confirmation_required',400);
 update(db,id,'operator_confirmed',{operator_note:input.note});budget.outcome(db,cfg,'libtv',id,'operator-confirmed');return get(db,id);
 }).immediate()}
function generationOrigin(db,kind,id){if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='muse_libtv_imports'").get())return null;
 const matches=db.prepare('SELECT i.*,t.session_id,t.remote_project_id,t.prompt,t.config_id,t.kind FROM muse_libtv_imports i JOIN muse_libtv_tasks t ON t.operation_id=i.task_id WHERE i.generation_id=? AND i.state=?').all(Number(id),'completed').filter(value=>{const facts=JSON.parse(value.media_json);return (facts.native_kind??value.kind)===kind});
 if(matches.length>1)throw fail('libtv_generation_lineage_conflict',503);const v=matches[0];return v?{task_operation_id:v.task_id,result_id:v.result_id,sha256:v.sha256,media:JSON.parse(v.media_json),session_id:v.session_id,remote_project_id:v.remote_project_id,protocol:'libtv-agent-im',model_verified:false,supplier_finality_verified:false}:null;
}
async function importResult(db,cfg,id,resultId,input){schema(db);const t=row(db,id),selected=config(db,cfg,t.config_id,t.credential_sha256),candidate=JSON.parse(t.results_json).find(v=>v.id===resultId);
 if(!candidate||!['image','video','audio'].includes(candidate.kind))throw fail('libtv_result_not_found',404);const kind=candidate.kind;target(db,{project_id:t.drama_id,storyboard_id:t.storyboard_id});
 const op=operation(input.operation_id),hash=digest([id,resultId]),prior=db.prepare('SELECT * FROM muse_libtv_imports WHERE operation_id=? OR (task_id=? AND result_id=?)').get(op,id,resultId);
 if(prior&&prior.request_sha256!==hash)throw fail('libtv_operation_changed',409);if(prior?.state==='completed')return {...kind==='audio'?{asset_id:prior.generation_id}:{generation_id:prior.generation_id},kind,sha256:prior.sha256,local_path:prior.local_path,replayed:true};
 const active=imports.get(db);if(active.size)throw fail('libtv_import_busy',409);const extension=path.extname(new URL(candidate.url).pathname).toLowerCase(),suffix=(kind==='video'?['.mp4','.mov','.webm']:kind==='audio'?['.wav','.mp3','.flac','.ogg','.m4a']:['.png','.jpg','.jpeg','.webp']).includes(extension)?extension:kind==='video'?'.mp4':kind==='audio'?'.wav':'.png';
 const replaceFailed=prior?.state==='download_failed'&&input.retry_download===true,local=prior&&!replaceFailed?prior.local_path:'libtv/'+randomUUID()+suffix;
 if(replaceFailed)db.prepare("UPDATE muse_libtv_imports SET state='downloading',local_path=?,error_code=NULL WHERE task_id=? AND result_id=? AND generation_id IS NULL").run(local,id,resultId);
 if(!prior)db.prepare('INSERT INTO muse_libtv_imports(operation_id,request_sha256,task_id,result_id,state,local_path,created_at) VALUES(?,?,?,?,?,?,?)').run(op,hash,id,resultId,'downloading',local,now());
 active.set(op,true);try{
  let data;try{data=media.read(cfg,local,selected.limits.max_media_bytes)}catch(error){if(error.code!=='ENOENT')throw error;data=await http.download(candidate.url,selected.limits);media.save(cfg,local,data)}
  let facts;if(kind==='audio')facts=audio.facts(cfg,local,audio.mime(data),selected.limits);else if(kind==='video')facts=media.probe(cfg,local,{...selected.limits,max_output_bytes:selected.limits.max_media_bytes});else{const sharp=require('sharp'),image=sharp(data,{limitInputPixels:64000000}),metadata=await image.metadata();await image.raw().toBuffer();if(!metadata.width||!metadata.height||!['png','jpeg','webp'].includes(metadata.format))throw fail('libtv_image_unverified');facts={width:metadata.width,height:metadata.height,format:metadata.format,complete_decode:true}}facts.native_kind=kind;
  const contentHash=sha(data),created=now();return db.transaction(()=>{target(db,{project_id:t.drama_id,storyboard_id:t.storyboard_id});if(kind==='audio'){const assetId=audio.insertAsset(db,cfg,{project_id:t.drama_id,name:'LibTV audio '+id,category:'libtv-agent-im',local_path:local,size_bytes:data.length,media:facts});db.prepare("UPDATE muse_libtv_imports SET state='completed',sha256=?,media_json=?,generation_id=?,error_code=NULL WHERE task_id=? AND result_id=?").run(contentHash,JSON.stringify(facts),assetId,id,resultId);return {asset_id:assetId,kind,sha256:contentHash,local_path:local,adopted:false};}const common={drama_id:t.drama_id,storyboard_id:t.storyboard_id,provider:'libtv_agent_im',prompt:t.prompt,model:'LibTV Agent',local_path:local,status:'completed',created_at:created,updated_at:created,completed_at:created},table=kind==='video'?'video_generations':'image_generations';
   const localUrl=String(cfg.storage.base_url||'/static').replace(/\/$/,'')+'/'+local;const values=kind==='video'?{...common,duration:facts.duration_seconds,video_url:localUrl,provider_task_id:t.session_id}:{...common,image_url:localUrl,frame_type:t.frame_type};
   const columns=new Set(db.prepare('PRAGMA table_info('+table+')').all().map(v=>v.name));for(const key of ['drama_id','storyboard_id','provider','prompt','model','local_path','status'])if(!columns.has(key))throw fail('libtv_native_generation_schema_changed',503);
   const entries=Object.entries(values).filter(([key])=>columns.has(key)),result=db.prepare('INSERT INTO '+table+'('+entries.map(([key])=>key).join(',')+') VALUES('+entries.map(()=>'?').join(',')+')').run(...entries.map(([,value])=>value));
   const generation=Number(result.lastInsertRowid);db.prepare("UPDATE muse_libtv_imports SET state='completed',sha256=?,media_json=?,generation_id=?,error_code=NULL WHERE task_id=? AND result_id=?").run(contentHash,JSON.stringify(facts),generation,id,resultId);
   return {generation_id:generation,kind,sha256:contentHash,local_path:local,adopted:false};
  }).immediate();
 }catch(error){db.prepare("UPDATE muse_libtv_imports SET state='download_failed',error_code=? WHERE task_id=? AND result_id=?").run(/^libtv_/.test(error.code||'')?error.code:'libtv_import_unconfirmed',id,resultId);throw error}
 finally{active.delete(op)}
}
function activeCount(db){return (running.get(db)?.size||0)+(imports.get(db)?.size||0)}
module.exports={schema,projectBinding,previewBinding,bindProject,get,submission,abandonSubmission,list,start,observe,confirm,importResult,generationOrigin,activeCount,candidates,cleanMessages,referenceSources,resolveReference};

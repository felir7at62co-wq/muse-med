/** Reserve native generation requests before dispatch; uncertain operations are never redispatched. */
const {createHash,randomUUID}=require('node:crypto');
const {AsyncLocalStorage}=require('node:async_hooks');
const catalog=require('./museAdmissionCatalog.json');
const owners=new WeakMap(),supplierContext=new AsyncLocalStorage(),idPattern=/^[A-Za-z0-9_-]{8,128}$/;
const failure=(code,status=409,operation_id)=>Object.assign(new Error(code),{code,status,operation_id});
const digest=value=>createHash('sha256').update(value).digest('hex');
const secretKey=/^(?:operation_id|api[_-]?key|access[_-]?(?:key|token)|bearer[_-]?token|authorization|password|secret(?:[_-]?key)?|credentials|cookies?)$/i;
function canonical(value){if(Array.isArray(value))return value.map(item=>canonical(item??null));if(value&&typeof value==='object'){const output=Object.create(null);for(const key of Object.keys(value).sort())if(!secretKey.test(key)&&value[key]!==undefined)output[key]=canonical(value[key]);return output;}return value;}
function pathOf(path){try{return decodeURIComponent(path.split('?')[0]).replace(/\/+$/,'').toLowerCase()||'/';}catch(error){throw failure('invalid_operation_path',400);}}
function match(path,body){path=pathOf(path);const route=catalog.find(item=>new RegExp(item.pattern).test(path));if(route?.kind==='connection-test'){const service=String(body?.service_type||'').toLowerCase(),model=Array.isArray(body?.model)?body.model[0]:body?.model;if(route.configuration_only_services.includes(service)||!service&&new RegExp(route.configuration_only_model_pattern,'i').test(String(model??'')))return null;}return route?.kind==='novel'&&body?.ai_summarize!==true&&body?.ai_summarize!=='true'?null:route;}
function requestHash(path,body,file){return digest(JSON.stringify(canonical({method:'POST',path:pathOf(path),body:body??{},file:file?{sha256:digest(file.buffer),sizeBytes:file.buffer.length}:null})));}
function schema(db,cfg={}){
 let owner=owners.get(db);const limit=cfg.muse_admission?.max_receipt_bytes??2097152;if(!Number.isSafeInteger(limit)||limit<1024||limit>16777216)throw failure('invalid_operation_receipt_limit',503);
 if(owner){owner.limit=limit;return owner;}
 db.exec('CREATE TABLE IF NOT EXISTS muse_admission_schema(version INTEGER NOT NULL,database_id TEXT NOT NULL)');const versions=db.prepare('SELECT * FROM muse_admission_schema').all();if(versions.length>1||versions[0]&&versions[0].version!==1)throw failure('unsupported_admission_schema',503);
 const context=supplierContext;db.function('muse_admission_operation',()=>context.getStore()?.db===db?context.getStore().operation_id:null);
 db.transaction(()=>{
  if(!versions.length){db.exec(`CREATE TABLE muse_native_operations(operation_id TEXT PRIMARY KEY,request_sha256 TEXT NOT NULL,path TEXT NOT NULL,kind TEXT NOT NULL,label TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN('authorized','reserved','accepted','completed','failed','unknown')),previous_operation_id TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,http_status INTEGER,content_type TEXT,receipt TEXT,error_code TEXT);
   CREATE INDEX muse_native_operations_request ON muse_native_operations(request_sha256,created_at);
   CREATE TABLE muse_native_operation_resources(operation_id TEXT NOT NULL,kind TEXT NOT NULL,resource_id TEXT NOT NULL,PRIMARY KEY(operation_id,kind,resource_id));
   CREATE TABLE muse_native_supplier_usage(operation_id TEXT NOT NULL,call_id TEXT NOT NULL,usage_json TEXT NOT NULL,recorded_at TEXT NOT NULL,PRIMARY KEY(operation_id,call_id));`);
   for(const[kind,table]of [['task','async_tasks'],['image','image_generations'],['video','video_generations']])db.exec(`CREATE TRIGGER muse_admission_${kind}_resource AFTER INSERT ON ${table} WHEN muse_admission_operation() IS NOT NULL BEGIN INSERT OR IGNORE INTO muse_native_operation_resources(operation_id,kind,resource_id) VALUES(muse_admission_operation(),'${kind}',CAST(NEW.id AS TEXT)); END;`);
   db.prepare('INSERT INTO muse_admission_schema VALUES(1,?)').run(randomUUID());}
  db.prepare("UPDATE muse_native_operations SET state='unknown',error_code=CASE WHEN error_code='supplier_usage_not_saved' THEN error_code ELSE 'operation_interrupted' END,updated_at=? WHERE state='reserved'").run(new Date().toISOString());
 }).immediate();
 owner={limit,active:new Set(),usageFailures:new Set(),context,database_id:db.prepare('SELECT database_id FROM muse_admission_schema').get().database_id};owners.set(db,owner);return owner;
}
const rowById=(db,id)=>db.prepare('SELECT rowid AS sequence,* FROM muse_native_operations WHERE operation_id=?').get(id);
function track(db,id,kind,resource){if(resource!==undefined&&resource!==null&&String(resource))db.prepare('INSERT OR IGNORE INTO muse_native_operation_resources VALUES(?,?,?)').run(id,kind,String(resource));}
function safeReceipt(value,kind){
 if(value===null||typeof value!=='object')return value;
 if(Array.isArray(value))return value.map(item=>safeReceipt(item,kind));
 const result=Object.create(null);for(const[key,item]of Object.entries(value)){
  if(secretKey.test(key))continue;
  if((kind==='image'||kind==='video')&&['prompt','negative_prompt','reference_images','reference_image_urls','image_url','first_frame_url','last_frame_url','video_url','local_path'].includes(key))continue;
  result[key]=safeReceipt(item,kind);
 }return result;
}
function resources(db,id,payload,route){
 const data=payload?.data??payload;if(!data||typeof data!=='object')return;
 if(data.task_id)track(db,id,'task',data.task_id);
 if(data.image_generation){track(db,id,'image',data.image_generation.id);track(db,id,'task',data.image_generation.task_id);}
 if(route.kind==='image'&&route.path==='/images')track(db,id,'image',data.id);
 if(route.kind==='video')track(db,id,'video',data.id);
 if(Array.isArray(data.task_ids))for(const task of data.task_ids)track(db,id,'task',task);
}
function refreshed(db,row){
 if(!['accepted','unknown'].includes(row.state))return row;
 const related=db.prepare('SELECT kind,resource_id FROM muse_native_operation_resources WHERE operation_id=?').all(row.operation_id);
 if(!related.length)return row;
 const statuses=related.map(resource=>{
  const table=resource.kind==='image'?'image_generations':resource.kind==='video'?'video_generations':'async_tasks';
  return db.prepare(`SELECT status FROM ${table} WHERE id=?`).get(resource.resource_id)?.status??'unknown';
 });
 let state=statuses.every(status=>status==='completed')?'completed':row.state==='unknown'?'unknown':statuses.some(status=>['pending','processing','generating','running'].includes(status))?'accepted':statuses.some(status=>status==='failed')?'failed':'unknown';
 if(state!==row.state){db.prepare("UPDATE muse_native_operations SET state=?,updated_at=?,error_code=CASE WHEN error_code='supplier_usage_not_saved' THEN error_code ELSE ? END WHERE operation_id=?").run(state,new Date().toISOString(),state==='unknown'?'native_result_unconfirmed':null,row.operation_id);row=rowById(db,row.operation_id);}return row;
}
function info(db,row,includeReceipt=false){row=refreshed(db,row);const usage=db.prepare('SELECT call_id,usage_json,recorded_at FROM muse_native_supplier_usage WHERE operation_id=? ORDER BY rowid').all(row.operation_id).map(item=>({call_id:item.call_id,usage:JSON.parse(item.usage_json),recorded_at:item.recorded_at}));return {operation_id:row.operation_id,request_sha256:row.request_sha256,path:row.path,kind:row.kind,label:row.label,state:row.state,previous_operation_id:row.previous_operation_id,created_at:row.created_at,updated_at:row.updated_at,http_status:row.http_status,error_code:row.error_code,billing_verified:false,supplier_usage:usage.length?usage:null,usage_status:usage.length?'reported':'unreported',usage_health:row.error_code==='supplier_usage_not_saved'||owners.get(db)?.usageFailures.has(row.operation_id)?'error':'ok',can_create_version:['completed','failed'].includes(row.state),resources:db.prepare('SELECT kind,resource_id FROM muse_native_operation_resources WHERE operation_id=?').all(row.operation_id),...includeReceipt&&row.receipt!==null?{receipt:{status:row.http_status,content_type:row.content_type,body:row.receipt}}:{}};}
function usageSnapshot(payload){const source=payload?.usage;if(!source||typeof source!=='object'||Array.isArray(source))return null;const usage={};let reported=false;for(const key of ['prompt_tokens','completion_tokens','total_tokens','input_tokens','output_tokens','cached_tokens','reasoning_tokens','input_audio_tokens','output_audio_tokens']){const value=source[key];usage[key]=Number.isSafeInteger(value)&&value>=0?value:null;reported||=usage[key]!==null;}return reported?usage:null;}
function usageFailure(db,id){owners.get(db)?.usageFailures.add(id);try{db.prepare('UPDATE muse_native_operations SET error_code=? WHERE operation_id=?').run('supplier_usage_not_saved',id);}catch(error){void error;}}
/** Save a supplier-reported resource snapshot by original native ownership, including polls without request context. */
function recordResourceUsage(db,kind,id,payload,providerTaskId){const usage=usageSnapshot(payload);if(!usage)return false;let operations=[];try{if(!['image','video'].includes(kind))return false;if(!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='muse_native_operation_resources'").get())return false;operations=db.prepare('SELECT r.operation_id FROM muse_native_operation_resources r JOIN muse_native_operations o ON o.operation_id=r.operation_id WHERE r.kind=? AND r.resource_id=? ORDER BY o.rowid LIMIT 1').all(kind,String(id));for(const row of operations)db.prepare('INSERT INTO muse_native_supplier_usage VALUES(?,?,?,?) ON CONFLICT(operation_id,call_id) DO UPDATE SET usage_json=excluded.usage_json,recorded_at=excluded.recorded_at').run(row.operation_id,'resource:'+kind+':'+String(id),JSON.stringify(usage),new Date().toISOString());return operations.length>0;}catch(error){for(const row of operations)usageFailure(db,row.operation_id);return false;}}
function startSupplierCall(url,body){const context=supplierContext.getStore();if(!context)return ()=>{};const {db,operation_id}=context,call_id=randomUUID();owners.get(db)?.budget?.transport(operation_id,call_id,url,body);return payload=>{
 const usage=usageSnapshot(payload);if(!usage)return;
 try{db.prepare('INSERT INTO muse_native_supplier_usage VALUES(?,?,?,?) ON CONFLICT(operation_id,call_id) DO UPDATE SET usage_json=excluded.usage_json,recorded_at=excluded.recorded_at').run(operation_id,call_id,JSON.stringify(usage),new Date().toISOString());}catch(error){usageFailure(db,operation_id);throw failure('supplier_usage_not_saved',503,operation_id);}
 };}
function latest(db,hash){const row=db.prepare('SELECT rowid AS sequence,* FROM muse_native_operations WHERE request_sha256=? ORDER BY rowid DESC LIMIT 1').get(hash);return row?refreshed(db,row):null;}
function reserve(db,cfg,id,path,body,file){const owner=schema(db,cfg),route=match(path,body);if(!route)throw failure('not_a_generation_route',400);if(route.kind==='video'&&cfg.muse_jubian?.video_only===true)throw failure('jubian_video_required',409,id);if(typeof id!=='string'||!idPattern.test(id))throw failure('operation_id_required',428);
 const hash=requestHash(path,body,file),result=db.transaction(()=>{
  const prior=rowById(db,id);if(prior){if(prior.request_sha256!==hash)throw failure('operation_input_changed',409,id);if(prior.state==='authorized'){owner.budget?.intent(id,hash,pathOf(path),body);db.prepare("UPDATE muse_native_operations SET state='reserved',updated_at=? WHERE operation_id=?").run(new Date().toISOString(),id);return {row:rowById(db,id),dispatch:true,route};}return {row:refreshed(db,prior),dispatch:false,route};}
  const existing=latest(db,hash);if(existing)throw failure(['unknown','reserved','accepted','authorized'].includes(existing.state)?'operation_requires_reconciliation':'operation_version_permission_required',409,existing.operation_id);
  owner.budget?.intent(id,hash,pathOf(path),body);const now=new Date().toISOString();db.prepare("INSERT INTO muse_native_operations(operation_id,request_sha256,path,kind,label,state,created_at,updated_at) VALUES(?,?,?,?,?,'reserved',?,?)").run(id,hash,pathOf(path),route.kind,route.label,now,now);return {row:rowById(db,id),dispatch:true,route};
 }).immediate();
 if(result.dispatch)owner.active.add(id);return result;
}
function nextVersion(db,cfg,id,newId){schema(db,cfg);if(typeof newId!=='string'||!idPattern.test(newId))throw failure('operation_id_required',400);return db.transaction(()=>{
 const previous=rowById(db,id);if(!previous)throw failure('operation_not_found',404);const old=refreshed(db,previous),present=rowById(db,newId);if(present){if(present.previous_operation_id!==id||present.request_sha256!==old.request_sha256)throw failure('operation_input_changed',409,newId);return info(db,present);}
 if(!['completed','failed'].includes(old.state))throw failure('operation_requires_reconciliation',409,id);
 const current=latest(db,old.request_sha256);if(current.operation_id!==id)throw failure('operation_newer_version_exists',409,current.operation_id);
 const now=new Date().toISOString();db.prepare("INSERT INTO muse_native_operations(operation_id,request_sha256,path,kind,label,state,previous_operation_id,created_at,updated_at) VALUES(?,?,?,?,?,'authorized',?,?,?)").run(newId,old.request_sha256,old.path,old.kind,old.label,id,now,now);return info(db,rowById(db,newId));
 }).immediate();}
function markUnknown(db,id,code){db.prepare("UPDATE muse_native_operations SET state='unknown',error_code=CASE WHEN error_code='supplier_usage_not_saved' THEN error_code ELSE ? END,updated_at=? WHERE operation_id=? AND state='reserved'").run(code,new Date().toISOString(),id);owners.get(db)?.active.delete(id);}
function commit(db,id,status,type,receipt,route,payload){const owner=owners.get(db);if(Buffer.byteLength(receipt)>owner.limit)throw failure('operation_receipt_too_large',503,id);
 db.transaction(()=>{if(payload)resources(db,id,payload,{...route,path:rowById(db,id).path});const count=db.prepare('SELECT COUNT(*) AS count FROM muse_native_operation_resources WHERE operation_id=?').get(id).count,state=count?'accepted':route.kind==='batch'?'unknown':'completed';
  const result=db.prepare("UPDATE muse_native_operations SET state=?,http_status=?,content_type=?,receipt=?,updated_at=?,error_code=CASE WHEN error_code='supplier_usage_not_saved' THEN error_code ELSE ? END WHERE operation_id=? AND state IN('reserved','unknown')").run(state,status,type,receipt,new Date().toISOString(),state==='unknown'?'batch_resources_unconfirmed':null,id);if(result.changes!==1)throw failure('operation_receipt_not_saved',503,id);
 }).immediate();owner.active.delete(id);
}
function errorResponse(res,error){return res.status(error.status??503).json({success:false,error:{code:error.code??'operation_unconfirmed',message:'生成提交未确认。请使用原提交记录核对结果，不要直接重新生成。',operation_id:error.operation_id??null}});}
function guard(db,cfg,req,res,next){
 let admission;try{admission=reserve(db,cfg,req.get('x-muse-operation-id'),req.path,req.body,req.file);}catch(error){return errorResponse(res,error);}
 const {row,route}=admission,id=row.operation_id;res.setHeader('X-Muse-Operation-Id',id);
 if(!admission.dispatch){if(row.receipt!==null)return res.status(row.http_status).type(row.content_type).send(row.receipt);return errorResponse(res,failure('operation_requires_reconciliation',409,id));}
 const originalJson=res.json.bind(res),originalWrite=res.write.bind(res),originalEnd=res.end.bind(res);let settled=false,chunks=[],bytes=0,overflow=false,held=[],streamError=false,streamDone=false;
 function unknown(code){if(settled)return;settled=true;try{markUnknown(db,id,code);}catch(error){owners.get(db)?.active.delete(id);}}
 res.once('close',()=>{if(!settled){try{db.prepare("UPDATE muse_native_operations SET state='unknown',error_code=CASE WHEN error_code='supplier_usage_not_saved' THEN error_code ELSE 'operation_response_lost' END,updated_at=? WHERE operation_id=? AND state='reserved'").run(new Date().toISOString(),id);}catch(error){void error;}}});
 res.json=payload=>{
  if(settled)return originalJson(payload);
  if(res.statusCode<200||res.statusCode>=300||payload?.success===false){
   if(typeof payload?.error?.code==='string'&&payload.error.code.startsWith('budget_')&&owners.get(db).budget?.noDispatch(id)){
    const safe={success:false,error:{code:payload.error.code,message:'预算检查拒绝了本次派发，未发起付费调用。请先核对项目预算与有效价格，再明确授权新版本。',operation_id:id}};
    try{db.prepare("UPDATE muse_native_operations SET state='failed',http_status=?,content_type='application/json',receipt=?,error_code=?,updated_at=? WHERE operation_id=? AND state IN('reserved','unknown')").run(res.statusCode,JSON.stringify(safe),payload.error.code,new Date().toISOString(),id);owners.get(db).active.delete(id);settled=true;return originalJson(safe);}catch(error){unknown('operation_receipt_not_saved');}
   }
   unknown('native_http_failure');return originalJson({success:false,error:{code:'operation_result_unconfirmed',message:'原请求可能已产生供应商调用，请在生成提交记录核对，不要直接重复生成。',operation_id:id}});
  }
  try{const receipt=safeReceipt(payload,route.kind);commit(db,id,res.statusCode,'application/json',JSON.stringify(receipt),route,receipt);settled=true;return originalJson(receipt);}catch(error){unknown(error.code??'operation_receipt_not_saved');if(!res.headersSent)res.status(503);return originalJson({success:false,error:{code:'operation_receipt_not_saved',message:'生成结果回执未保存，原任务结果待核对。',operation_id:id}});}
 };
 res.write=(chunk,encoding,callback)=>{
  if(settled)return originalWrite(chunk,encoding,callback);
  const buffer=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk,typeof encoding==='string'?encoding:undefined);bytes+=buffer.length;if(bytes>owners.get(db).limit){overflow=true;chunks=[];}else if(!overflow)chunks.push(buffer);
  let isTerminal=false;for(const line of buffer.toString('utf8').trim().split('\n')){try{const value=JSON.parse(line);if(value.type==='done'){streamDone=true;isTerminal=true;}if(value.type==='error'){streamError=true;isTerminal=true;}}catch(error){void error;}}
  if(isTerminal){held.push(buffer);if(typeof encoding==='function')encoding();if(typeof callback==='function')callback();return true;}return originalWrite(chunk,encoding,callback);
 };
 res.end=(chunk,encoding,callback)=>{
  if(settled)return originalEnd(chunk,encoding,callback);
  if(chunk)res.write(chunk,encoding);
  if(route.kind==='stream'&&streamDone&&!streamError&&!overflow){try{commit(db,id,res.statusCode,'application/x-ndjson',Buffer.concat(chunks).toString('utf8'),route);settled=true;for(const terminal of held)originalWrite(terminal);return originalEnd(undefined,undefined,callback);}catch(error){unknown(error.code??'operation_receipt_not_saved');}}
  else unknown(overflow?'operation_receipt_too_large':'operation_result_unconfirmed');
  if(route.kind==='stream')originalWrite(JSON.stringify({type:'error',message:'原生成结果未确认，请使用提交记录核对，不能自动重发。',operation_id:id})+'\n');
  return originalEnd(undefined,undefined,callback);
 };
 owners.get(db).context.run({operation_id:id,db},()=>next());
}
function register(router,db,cfg={}){schema(db,cfg);const handle=fn=>(req,res)=>{try{res.json({success:true,data:fn(req)});}catch(error){errorResponse(res,error);}};
 router.get('/muse/admission/capabilities',handle(()=>({database_id:schema(db,cfg).database_id,routes:catalog,receipt_limit_bytes:owners.get(db).limit})));
 router.get('/muse/admission/lookup',handle(req=>{if(!/^[a-f0-9]{64}$/.test(req.query.request_sha256??''))throw failure('operation_hash_required',400);const row=latest(db,req.query.request_sha256);return {item:row?info(db,row):null};}));
 router.get('/muse/admission',handle(()=>({database_id:schema(db,cfg).database_id,items:db.prepare('SELECT rowid AS sequence,* FROM muse_native_operations ORDER BY rowid DESC LIMIT 100').all().map(row=>info(db,row))})));
 router.get('/muse/admission/:id',handle(req=>{const row=rowById(db,req.params.id);if(!row)throw failure('operation_not_found',404);return info(db,row,true);}));
 router.post('/muse/admission/:id/next-version',handle(req=>nextVersion(db,cfg,req.params.id,req.body?.operation_id)));
 router.use((req,res,next)=>{if(req.method!=='POST'||pathOf(req.path)==='/dramas/import-novel'||!match(req.path,req.body))return next();return guard(db,cfg,req,res,next);});
 return {novel:(req,res,next)=>match(req.path,req.body)?guard(db,cfg,req,res,next):next()};
}
/** Attach the installed project-budget owner before paid routes can dispatch. */
function configureBudget(db,adapter){const owner=owners.get(db);if(!owner)throw failure('budget_admission_not_initialized',503);owner.budget=adapter;}
module.exports={register,schema,reserve,nextVersion,requestHash,match,info,startSupplierCall,recordResourceUsage,configureBudget,currentOperation:db=>supplierContext.getStore()?.db===db?supplierContext.getStore().operation_id:undefined,isOperationActive:(db,id)=>owners.get(db)?.active.has(id)??false,getActiveOperationCount:db=>owners.get(db)?.active.size??0};

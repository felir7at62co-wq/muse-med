/** Authenticated company CLI orchestration; paid execution survives a disconnected desktop. */
import {createHash,randomUUID,randomBytes} from 'node:crypto';
import {mkdir,writeFile,lstat,readFile,unlink,rmdir} from 'node:fs/promises';
import {join,isAbsolute,extname,dirname} from 'node:path';
import {companyCliDigest,decodeCompanyCliArgv,createCompanyCliExecutor,companyAdvancedMetadataCommand} from './company-cli-executor.mjs';
import {openCompanyCliStore} from './company-cli-store.mjs';
import {createCompanyCliPricing} from './company-cli-pricing.mjs';
import {createCompanyCliDownloads} from './company-cli-downloads.mjs';
import {createLibTvSubtitleProvider} from './company-libtv-subtitles.mjs';
import {createCompanyPostproductionService} from './company-postproduction-service.mjs';

const prefix='/studio/api/v1/muse/company-cli';
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const fail=(code,status=400)=>Object.assign(new Error(code),{code,status});
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const own=(value,keys)=>{if(!object(value)||Object.keys(value).some(key=>!keys.includes(key)))throw fail('company_cli_invalid_request');return value;};
const positive=value=>Number.isSafeInteger(value)&&value>0;
const id=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,128}$/u.test(value);
const writes=new Set(['project_create','project_update','node_create','node_edit','node_delete','group_create','group_edit','upload','workspace_create','workspace_update']);
const paid=new Set(['node_run','group_run','image_shortcut','video_hd','video_final','script_storyboard']);
function record(result){if(result.exit_code!==0||result.records.length!==1||!object(result.records[0]))throw fail('company_cli_read_failed',502);return result.records[0];}

/**
 * Create a company API around trusted account lookup, private connections and tenant leases.
 * The controller alone reserves jobs, dispatches prepared commands and writes native receipts.
 * @param {object} options Company store, executor, native request adapter and private operator configuration.
 * @returns {object} Authenticated route handler and ordered shutdown.
 */
export function createCompanyCliService({store,executor,pricing,downloads,apiPostproduction,nativeRequest,connections,publicOrigin,stageRoot,maxUploadBytes=16777216,maxRequestBytes=25165824,maxReadParallel=2,requestTimeoutMs=30000,chargeApprovalTtlMs=600000,maxChargeApprovals=1000,maxDownloadBytes=67108864,downloadChunkBytes=262144,now=Date.now,onError=()=>console.error('[muse-company-cli] A saved job needs inspection.')}){
 if(!store||!executor||typeof nativeRequest!=='function'||!Array.isArray(connections)||!isAbsolute(stageRoot)||!positive(maxUploadBytes)||!positive(maxRequestBytes))throw fail('company_cli_invalid_configuration',500);
 if(!positive(chargeApprovalTtlMs)||!positive(maxChargeApprovals)||!positive(maxDownloadBytes)||!positive(downloadChunkBytes))throw fail('company_cli_invalid_configuration',500);
 const running=new Map(),setup=new Map(),pending=new Set(),chargeApprovals=new Map(),downloadSetups=new Map(),priceLifetime=new AbortController(),priceReader=pricing??createCompanyCliPricing({now}),downloadFiles=downloads??createCompanyCliDownloads({root:join(stageRoot,'downloads'),maxBytes:maxDownloadBytes,chunkBytes:downloadChunkBytes,maxResponseBytes:Math.min(maxRequestBytes,16777216)});let closing=false,activeReads=0;
 if(typeof priceReader.resolve!=='function')throw fail('company_cli_invalid_configuration',500);
 function context(actor,companyId){const all=store.context(actor).companies;const company=companyId?all.find(item=>item.id===companyId):all.length===1?all[0]:null;if(!company)throw fail(companyId?'company_cli_forbidden':'company_cli_company_selection_required',403);return company;}
 function connection(company,project){const rows=company.connections.filter(item=>item.active&&(!project?.connectionId||item.id===project.connectionId));if(rows.length!==1)throw fail('company_cli_connection_selection_required',409);const value=rows[0],privateConfig=connections.find(item=>item.id===value.id&&item.companyId===company.id);if(!privateConfig)throw fail('company_cli_connection_unavailable',503);if(project?.connectionRevision&&project.connectionRevision!==value.revision)throw fail('company_cli_project_connection_changed',409);return {value,privateConfig};}
 function binding(company,project){const c=connection(company,project);return {companyId:company.id,projectId:project?.id??'catalog',connectionId:c.value.id,connectionRevision:c.value.revision,credentialsDir:c.privateConfig.credentialsDir,owner:c.value.owner,canvasUuid:project?.canvasUuid??undefined,workspaceId:c.privateConfig.workspaceId,teamId:c.privateConfig.teamId,catalogAdmin:false};}
 function native(actor,project,method,path,body){return nativeRequest(project?.tenantAccountId??actor.id,{method,path,...body===undefined?{}:{body}});}
 async function projectFor(actor,company,scope={},create=false){
  let p=scope.projectUuid?company.projects.find(item=>item.canvasUuid===scope.projectUuid):null;
  if(!p&&positive(scope.nativeProjectId))p=company.projects.find(item=>item.nativeProjectId===scope.nativeProjectId&&item.tenantAccountId===actor.id);
  if(p)return store.getProject(actor,p.id);
  if(!create||!positive(scope.nativeProjectId))throw fail('company_cli_project_not_found',404);
  const key=company.id+':'+actor.id+':'+scope.nativeProjectId;
  if(setup.has(key))return setup.get(key);
  const task=(async()=>{
   const raw=await native(actor,null,'GET','/api/v1/dramas/'+scope.nativeProjectId);
   if(!object(raw)||Number(raw.id)!==scope.nativeProjectId)throw fail('company_cli_native_project_not_found',404);
   const caps=await native(actor,null,'GET','/api/v1/muse/libtv-cli/capabilities');
   if(typeof caps?.database_id!=='string')throw fail('company_cli_native_database_unavailable',503);
   return store.createProject(actor,{companyId:company.id,id:randomUUID(),name:String(raw.title??raw.name??'Muse project'),tenantAccountId:actor.id,nativeProjectId:scope.nativeProjectId,nativeDatabaseId:caps.database_id});
  })();setup.set(key,task);try{return await task;}finally{setup.delete(key);}
 }
 async function executeRead(command,bound){if(activeReads>=maxReadParallel)throw fail('company_cli_reads_busy',429);activeReads++;try{return await executor.execute(await executor.prepare(command,bound),{operationId:randomUUID()});}finally{activeReads--;}}
 async function registerExistingProject(actor,input){
  own(input,['companyId','nativeProjectId','canvasUuid']);
  if(!positive(input.nativeProjectId)||!id(input.canvasUuid))throw fail('company_cli_invalid_project_binding');
  const company=context(actor,input.companyId);if(company.role==='viewer')throw fail('company_cli_project_read_only',403);
  const original=await native(actor,null,'GET','/api/v1/dramas/'+input.nativeProjectId);
  if(!object(original)||Number(original.id)!==input.nativeProjectId||original.deleted_at||original.deletedAt||original.delFlag===1||original.del_flag===1)throw fail('company_cli_native_project_not_found',404);
  context(actor,company.id);
  const caps=await native(actor,null,'GET','/api/v1/muse/libtv-cli/capabilities');
  if(typeof caps?.database_id!=='string'||!caps.database_id)throw fail('company_cli_native_database_unavailable',503);
  const current=context(actor,company.id),existing=current.projects.find(project=>project.tenantAccountId===actor.id&&project.nativeDatabaseId===caps.database_id&&project.nativeProjectId===input.nativeProjectId);
  if(existing?.canvasUuid&&existing.canvasUuid!==input.canvasUuid)throw fail('company_cli_canvas_already_bound',409);
  const bound=binding(current,{...existing,id:existing?.id??'registration-'+input.nativeProjectId,canvasUuid:input.canvasUuid});
  const canvas=record(await executeRead({method:'project_read',body:{project_uuid:input.canvasUuid}},bound));
  if(canvas.projectUuid!==input.canvasUuid||!Array.isArray(canvas.nodes)||!Array.isArray(canvas.edges))throw fail('company_cli_canvas_identity_mismatch',409);
  return store.registerProject(actor,{companyId:company.id,name:String(original.title??original.name??'Muse project'),tenantAccountId:actor.id,nativeProjectId:input.nativeProjectId,nativeDatabaseId:caps.database_id,canvasUuid:input.canvasUuid,connectionId:bound.connectionId,connectionRevision:bound.connectionRevision});
 }
 async function stage(upload){
  own(upload,['file_name','sha256','data_base64']);
  if(typeof upload.file_name!=='string'||typeof upload.data_base64!=='string'||!/^[a-f0-9]{64}$/u.test(upload.sha256))throw fail('company_cli_invalid_upload');
  const suffix=extname(upload.file_name).toLowerCase();if(!/^\.[a-z0-9]{1,8}$/u.test(suffix))throw fail('company_cli_invalid_upload');
  const bytes=Buffer.from(upload.data_base64,'base64');if(!bytes.length||bytes.length>maxUploadBytes||bytes.toString('base64')!==upload.data_base64||hash(bytes)!==upload.sha256)throw fail('company_cli_invalid_upload');
  const folder=join(stageRoot,randomUUID());await mkdir(folder,{recursive:true,mode:0o700});const path=join(folder,upload.sha256+suffix);await writeFile(path,bytes,{flag:'wx',mode:0o600});return {path,sha256:upload.sha256,bytes:bytes.length};
 }
 function finish(id,operation){const task=operation().catch(()=>onError()).finally(()=>running.delete(id));running.set(id,task);return task;}
 function publicContext(actor,companyId){const company=context(actor,companyId);return {...company,execution_mode:'company',permissions:{manage:['owner','admin'].includes(company.role),generate:company.role!=='viewer',approve_budget:company.role!=='viewer'},capacity:{max_parallel:Math.min(...company.connections.filter(c=>c.active).map(c=>c.maxParallel),1024),active:company.projects.reduce((count,p)=>count+store.listJobs(actor,{projectId:p.id}).filter(j=>['reserved','running','unknown'].includes(j.state)).length,0)}};}
 function downloadManifest(job){
  const request=job.inputCapture?.downloadRequest;
  if(job.method!=='download'||!object(request))throw fail('company_cli_operation_conflict',409);
  const state=['reserved','running'].includes(job.state)?'pending':job.state==='cancelled'?'failed':job.state;
  return {operationId:job.operationId,state,projectUuid:request.projectUuid,nodeId:request.nodeId,snapshotSha256:request.snapshotSha256,watermark:request.watermark,files:job.state==='completed'?job.result?.files??[]:[],...job.result?.error_code?{error_code:job.result.error_code}:{}};
 }
 function downloadJob(actor,companyId,operationId){
  const company=context(actor,companyId),job=store.findJob(actor,{companyId:company.id,operationId});
  if(!job)throw fail('company_cli_download_not_found',404);
  downloadManifest(job);return job;
 }
 async function download(actor,input){
  own(input,['companyId','operationId','projectUuid','nodeId','snapshotSha256','watermark','maxBytes']);
  if(!id(input.operationId)||!id(input.projectUuid)||!id(input.nodeId)||typeof input.snapshotSha256!=='string'||!/^[a-f0-9]{64}$/u.test(input.snapshotSha256)||typeof input.watermark!=='boolean'||input.maxBytes!==undefined&&!positive(input.maxBytes))throw fail('company_cli_invalid_download');
  const company=context(actor,input.companyId),request={operationId:input.operationId,projectUuid:input.projectUuid,nodeId:input.nodeId,snapshotSha256:input.snapshotSha256,watermark:input.watermark,maxBytes:Math.min(input.maxBytes??maxDownloadBytes,maxDownloadBytes)},requestHash=companyCliDigest(request);
  const prior=store.findJob(actor,{companyId:company.id,operationId:input.operationId});
  if(prior){if(prior.method!=='download'||prior.inputCapture?.downloadRequestHash!==requestHash)throw fail('company_cli_operation_conflict',409);return downloadManifest(prior);}
  const key=company.id+':'+actor.id+':'+input.operationId,existing=downloadSetups.get(key);
  if(existing){if(existing.requestHash!==requestHash)throw fail('company_cli_operation_conflict',409);return existing.task;}
  const task=startDownload(actor,company,request,requestHash);downloadSetups.set(key,{requestHash,task});
  try{return await task;}finally{downloadSetups.delete(key);}
 }
 async function startDownload(actor,company,request,requestHash){
  const p=await projectFor(actor,company,{projectUuid:request.projectUuid}),bound=binding(company,p);
  const source=record(await executeRead({method:'node_read',body:{project_uuid:p.canvasUuid,node_id:request.nodeId}},bound));
  if(companyCliDigest(source)!==request.snapshotSha256)throw fail('company_cli_download_source_changed',409);
  if(!['image','video','audio'].includes(source.data?.type))throw fail('company_cli_download_type_unsupported',428);
  const frozen={method:'download',body:{project_uuid:p.canvasUuid,node_id:request.nodeId,watermark:request.watermark},paid:false,requestSha256:companyCliDigest({request,companyId:company.id,projectId:p.id,connectionId:bound.connectionId,connectionRevision:bound.connectionRevision,owner:bound.owner,source}),resourceKey:'canvas:'+p.id+':node:'+request.nodeId,resources:[{key:'canvas:'+p.id+':edges',mode:'read'},{key:'canvas:'+p.id+':node:'+request.nodeId,mode:'read'}],inputCapture:{downloadRequest:request,downloadRequestHash:requestHash,source}};
  const job=store.admit(actor,{companyId:company.id,projectId:p.id,connectionId:bound.connectionId,operationId:request.operationId,prepared:frozen});
  if(job.replayed)return downloadManifest(job);
  let prepared;
  try{
   const directory=await downloadFiles.allocate(job.id);
   prepared=await executor.prepare({method:'download',body:{project_uuid:p.canvasUuid,node_id:request.nodeId,watermark:String(request.watermark),directory}},{...bound,downloadDir:directory});
   store.claimJob(job.id);
  }catch(error){store.cancelReservedJob(job.id);try{await downloadFiles.discard(job.id);}catch{onError();}throw error;}
  finish(job.id,async()=>{
   // The read-only executor drains its child before returning or rejecting.
   let state='failed',files=[],errorCode;
   try{
    const output=await executor.execute(prepared,{operationId:job.id});state=output.state==='completed'?'completed':'failed';errorCode=output.error_code;
    if(state==='completed'){
     const current=record(await executeRead({method:'node_read',body:{project_uuid:p.canvasUuid,node_id:request.nodeId}},bound));
     if(companyCliDigest(current)!==request.snapshotSha256)throw fail('company_cli_download_source_changed',409);
     files=await downloadFiles.capture(job.id,{records:output.records,kind:source.data.type,maxBytes:request.maxBytes});
    }
   }catch(error){state='failed';errorCode=error.code??'company_cli_download_unconfirmed';}
   if(state!=='completed')try{await downloadFiles.discard(job.id);}catch{onError();}
   store.finishJob(job.id,{state,result:{files,...errorCode?{error_code:errorCode}:{}}});
  });
  return downloadManifest(store.getJob(actor,job.id));
 }
 async function command(actor,input){
  own(input,['companyId','argv','scope','upload']);const scope=input.scope??{};own(scope,['operationId','nativeProjectId','projectUuid']);
  const command=decodeCompanyCliArgv(input.argv),company=context(actor,input.companyId);
  if(paid.has(command.method))throw fail('company_cli_use_generation_admission',428);
  if(command.method==='download')throw fail('company_cli_use_download_endpoint',428);
  if(command.method==='project_list')return {exit_code:0,records:[{projects:company.projects.map(p=>({projectUuid:p.canvasUuid,name:p.name,nativeProjectId:p.nativeProjectId})).filter(p=>p.projectUuid)}]};
  const needsProject=!!command.body.project_uuid||command.method==='project_create';
  const p=needsProject?await projectFor(actor,company,{...scope,projectUuid:command.body.project_uuid},command.method==='project_create'):null;
  const bound=binding(company,p),requestHash=companyCliDigest({command,upload:input.upload?{file_name:input.upload.file_name,sha256:input.upload.sha256}:null});
  if(writes.has(command.method)){
   if(!p||!id(scope.operationId))throw fail('company_cli_write_identity_required');
   const prior=store.findJob(actor,{companyId:company.id,projectId:p.id,operationId:scope.operationId});
   if(prior){if(prior.inputCapture.commandHash!==requestHash)throw fail('company_cli_operation_conflict',409);if(prior.result?.output)return prior.result.output;throw fail('company_cli_original_operation_pending',409);}
  }
  let asset;
  if(input.upload!==undefined){
   const field=command.method==='upload'?'file':command.method==='node_edit'?'attachment':null;
   if(!field||command.body[field]!=='muse-staged-upload')throw fail('company_cli_invalid_upload');
   asset=await stage(input.upload);command.body[field]=asset.path;bound.stagedAssets=[asset];
  }else if(command.method==='upload')throw fail('company_cli_invalid_upload');
  if(!writes.has(command.method)){
   const output=await executeRead(command,bound);
   if(command.method==='status')return {...output,execution_mode:'company',company:{id:company.id,name:company.name,role:company.role},capacity:publicContext(actor,company.id).capacity,permissions:publicContext(actor,company.id).permissions};
   return output;
  }
  let job,prepared;
  try{prepared=await executor.prepare(command,bound);job=store.admit(actor,{companyId:company.id,projectId:p.id,connectionId:bound.connectionId,operationId:scope.operationId,prepared:{...prepared,resources:[{key:'canvas:'+p.id+':edges',mode:'write'}],inputCapture:{commandHash:requestHash}}});}
  catch(error){if(asset){await unlink(asset.path);await rmdir(dirname(asset.path));}throw error;}
  if(job.replayed){if(job.result?.output)return job.result.output;throw fail('company_cli_original_operation_pending',409);}
  store.claimJob(job.id);
  let output;
  await finish(job.id,async()=>{
   try{
    output=await executor.execute(prepared,{operationId:job.id});
    if(command.method==='project_create'&&output.state==='completed'){
     const created=record(output),canvas=created.projectUuid??created.project_uuid??created.uuid??created.project?.projectUuid;
     if(typeof canvas!=='string')throw fail('company_cli_created_project_unidentified',502);
     const current=store.getProject(actor,p.id);
     store.bindCanvas(actor,{projectId:p.id,canvasUuid:canvas,connectionId:bound.connectionId,expectedRevision:current.revision});
    }
    store.finishJob(job.id,{state:output.state,result:{output}});
   }catch(error){store.finishJob(job.id,{state:'unknown',result:{error_code:error.code??'company_cli_execution_unconfirmed'}});throw error;}
   finally{if(asset){try{await unlink(asset.path);await rmdir(dirname(asset.path));}catch(error){onError();}}}
  });
  if(!output)throw fail('company_cli_execution_unconfirmed',503);return output;
 }
 function receipt(job){
  const saved=job.inputCapture,request=saved?.nativeRequest??{},capture=saved?.nativeCapture;
  const advanced=capture?.protocol==='libtv-cli-advanced-input-v1';
  return {schema:'muse-localminidrama-operation-v1',operation_id:job.operationId,fingerprint:job.requestSha256,studio_url:publicOrigin+'/studio#account='+job.actorId,request_status:job.state==='unknown'?'unknown':'recorded',created_at:job.createdAt,request:{method:'POST',path:advanced?'/cli/advanced':'/cli/run',body:request},before:(advanced?capture:capture?.node)??null,data:{state:['completed','failed'].includes(job.state)?job.state:'unknown',result:originalOutput(job.result?.output),job_id:job.id,company_id:job.companyId,reserved_minor:job.reservedMinor,native_recorded:job.result?.nativeRecorded===true}};
 }
 function originalOutput(output){const records=output?.records??[];return output?.mediaOutputs?{records,media_outputs:output.mediaOutputs,...output.mediaCaptureErrors?.length?{media_capture_errors:output.mediaCaptureErrors}:{}}:records.length===1?records[0]:{records};}
 async function mirrorNativeBudget(actor,p,job){
  const catalog=await native(actor,p,'GET','/api/v1/muse/budget/catalog');
  if(typeof catalog?.database_id!=='string'||!Array.isArray(catalog.items))throw fail('company_cli_native_budget_unavailable',503);
  const matches=catalog.items.filter(item=>item.active&&item.currency==='LTV'&&item.provider==='libtv-cli'&&item.service===job.service&&item.model===job.model&&item.origin==='https://api.liblib.tv');
  const priceId='company-'+hash(job.connectionId+':'+job.service+':'+job.model).slice(0,40),existing=catalog.items.find(item=>item.id===priceId);
  const savePrice=async()=>{
   const revision=existing?Number(String(existing.revision).replace(/^owner:/u,'')):0;
   if(!Number.isSafeInteger(revision)||revision<0)throw fail('company_cli_native_price_locked',409);
   await native(actor,p,'PUT','/api/v1/muse/budget/catalog/'+priceId,{database_id:catalog.database_id,id:priceId,operation_id:'company-price-'+job.id,expected_revision:revision,operator_accepted:true,service:job.service,provider:'libtv-cli',model:job.model,origin:'https://api.liblib.tv',currency:'LTV',reserve_minor:job.price.unitMinor,source:job.price.source,effective_at:new Date().toISOString(),expires_at:job.price.expiresAt,estimate_kind:job.service==='agent-task'?'operator-task-envelope':'per-dispatch-estimate'});
  };
  if(job.price?.protocol==='muse-company-cli-hd-quote-v1'){
   const relevant=catalog.items.filter(item=>item.currency==='LTV'&&item.provider==='libtv-cli'&&item.service===job.service&&item.model===job.model&&item.origin==='https://api.liblib.tv');
   if(relevant.some(item=>item.reserve_minor!==job.price.unitMinor))throw fail('company_cli_native_price_mismatch',409);
   if(relevant.some(item=>item.id!==priceId)||existing&&(!relevant.includes(existing)||!/^owner:\d+$/u.test(existing.revision)||existing.source!==job.price.source))throw fail('company_cli_native_price_locked',409);
   if(!existing||!existing.active||Date.parse(existing.expires_at)<Date.parse(job.price.expiresAt))await savePrice();
  }else if(!matches.length)await savePrice();
  else if(matches.length!==1||matches[0].reserve_minor!==job.price.unitMinor)throw fail('company_cli_native_price_mismatch',409);
  for(let attempt=0;attempt<3;attempt++){
   const current=await native(actor,p,'GET','/api/v1/muse/budget/projects/'+p.nativeProjectId);
   if(current.database_id!==catalog.database_id||!Number.isSafeInteger(current.reserved_minor)||!Number.isSafeInteger(current.settled_minor))throw fail('company_cli_native_budget_changed',409);
   const companyReserved=store.readBudget(actor,{companyId:p.companyId,scope:'project',targetId:p.id}).reservedMinor;
   const target=Math.max(current.limit_minor??0,current.reserved_minor+current.settled_minor+companyReserved);
   if(!Number.isSafeInteger(target))throw fail('company_cli_budget_overflow',400);
   if(current.currency==='LTV'&&current.limit_minor>=target&&current.allow_estimates&&current.allow_task_envelopes)break;
   try{
    await native(actor,p,'PUT','/api/v1/muse/budget/projects/'+p.nativeProjectId,{database_id:catalog.database_id,operation_id:'company-budget-'+job.id,expected_revision:current.revision,expected_reserved_minor:current.reserved_minor,expected_settled_minor:current.settled_minor,currency:'LTV',limit_minor:target,allow_estimates:true,allow_task_envelopes:true});break;
   }catch(error){if(error.status!==409||attempt===2)throw error;}
  }
  const quote=await native(actor,p,'POST','/api/v1/muse/budget/quote',{database_id:catalog.database_id,project_id:p.nativeProjectId,service:job.service,provider:'libtv-cli',model:job.model,origin:'https://api.liblib.tv',quantity:job.quantity});
  if(quote.reserved_minor!==job.reservedMinor||quote.currency!=='LTV'||!quote.within_limit)throw fail('company_cli_native_quote_mismatch',409);
 }
 async function inspectGeneration(actor,input){
  own(input,['kind','companyId','operationId','nativeProjectId','databaseId','request','inputCapture','approvalToken']);
  if(!id(input.operationId)||!positive(input.nativeProjectId)||!object(input.request)||!object(input.inputCapture))throw fail('company_cli_invalid_generation');
  const advanced=input.kind==='advanced';if(input.kind!==undefined&&!advanced)throw fail('company_cli_invalid_generation');
  const projectUuid=advanced?input.request.spec?.project_uuid:input.request.project_uuid;
  const company=context(actor,input.companyId),p=await projectFor(actor,company,{nativeProjectId:input.nativeProjectId,projectUuid});
  if(p.nativeDatabaseId!==input.databaseId||p.nativeProjectId!==input.request.project_id||p.nativeDatabaseId!==input.request.database_id||p.canvasUuid!==projectUuid)throw fail('company_cli_generation_scope_mismatch',403);
  const prior=store.findJob(actor,{companyId:company.id,projectId:p.id,operationId:input.operationId});
  if(prior){if(companyCliDigest(prior.inputCapture.nativeRequest)!==companyCliDigest(input.request)||companyCliDigest(prior.inputCapture.nativeCapture)!==companyCliDigest(input.inputCapture))throw fail('company_cli_operation_conflict',409);return {prior};}
  const bound=binding(company,p),capture=input.inputCapture;
  if(companyCliDigest(input.request.cli_owner)!==companyCliDigest(bound.owner))throw fail('company_cli_owner_changed',409);
  const read=async(method,body)=>record(await executeRead({method,body},bound));
  if(advanced){
   const spec=input.request.spec;
   if(input.request.accept_task_envelope!==true||!object(spec)||capture.protocol!=='libtv-cli-advanced-input-v1'||companyCliDigest(spec)!==companyCliDigest(capture.spec)||companyCliDigest(capture)!==input.request.plan_sha256)throw fail('company_cli_advanced_review_required',428);
   const project=await read('project_read',{project_uuid:p.canvasUuid});
   if(!Array.isArray(project.nodes)||!Array.isArray(project.edges)||project.nodes.length>1000)throw fail('company_cli_invalid_canvas',502);
   const nodes=[];for(const item of project.nodes){const nodeId=item.id??item.nodeKey;if(typeof nodeId!=='string')throw fail('company_cli_invalid_canvas',502);nodes.push(await read('node_read',{project_uuid:p.canvasUuid,node_id:nodeId}));}
   const node=nodes.find(item=>item.nodeKey===spec.node_id);if(!node)throw fail('company_cli_node_not_found',404);
   let metadata=null;const command=companyAdvancedMetadataCommand(spec);
   if(command){metadata=await read(command.method,command.body);if(spec.kind==='script_storyboard'){
    const models=Array.isArray(metadata)?metadata:metadata.matches??metadata.models;
    const matches=Array.isArray(models)?models.filter(model=>model.modelName===spec.params?.model):[];
    if(matches.length!==1)throw fail('company_cli_model_selection_required',428);
    metadata=await read('model_schema',{model_key:matches[0].modelKey});
   }}
   const snapshot={project,nodes},fresh={...capture,snapshot,snapshot_sha256:companyCliDigest(snapshot),node,node_sha256:companyCliDigest(node),metadata,metadata_sha256:companyCliDigest(metadata)};
   if(companyCliDigest(fresh)!==input.request.plan_sha256)throw fail('company_cli_generation_inputs_changed',409);
   bound.advancedPlan=fresh;const {kind,...body}=spec;
   const prepared=await executor.prepare({method:kind,body},bound);
   const resolvedPrice=kind==='video_hd'?await priceReader.resolve({prepared,binding:bound,read,signal:priceLifetime.signal}):undefined;
   const resources=[{key:'canvas:'+p.id+':edges',mode:'write'}];
   return {company,p,bound,capture:fresh,node,prepared,resolvedPrice,resources,advanced:true};
  }
  const node=await read('node_read',{node_id:input.request.node_id,project_uuid:p.canvasUuid}),metadata=await read('model_schema',{model_key:input.request.model_key});
  const discovery=await read('model_search',{keywords:input.request.model_name});
  const canvas=await read('project_read',{project_uuid:p.canvasUuid});
  if(!Array.isArray(canvas.edges))throw fail('company_cli_canvas_edges_required',502);
  const edges=canvas.edges.filter(edge=>edge.target===input.request.node_id);
  if(new Set(edges.map(edge=>edge.source)).size!==edges.length)throw fail('company_cli_ambiguous_references',409);
  const nodes=[];for(const edge of edges){const source=await read('node_read',{node_id:edge.source,project_uuid:p.canvasUuid});nodes.push({node_id:edge.source,node:source,node_sha256:companyCliDigest(source),media_sha256:null});}
  if(companyCliDigest(node)!==capture.node_sha256||companyCliDigest(metadata)!==capture.model_schema_sha256||companyCliDigest(discovery)!==capture.model_discovery_sha256||companyCliDigest({edges,nodes})!==capture.references_sha256||companyCliDigest(capture.node)!==capture.node_sha256||companyCliDigest(capture.model)!==capture.model_schema_sha256||companyCliDigest(capture.references)!==capture.references_sha256)throw fail('company_cli_generation_inputs_changed',409);
  bound.generation={node,metadata,executionModelName:capture.model_execution_name,references:nodes.map(source=>source.node)};
  const prepared=await executor.prepare({method:'node_run',body:{node_id:input.request.node_id,project_uuid:p.canvasUuid}},bound);
  return {company,p,bound,capture,node,prepared,advanced:false,resources:[{key:'canvas:'+p.id+':edges',mode:'read'},{key:'canvas:'+p.id+':node:'+input.request.node_id,mode:'write'},...edges.map(edge=>({key:'canvas:'+p.id+':node:'+edge.source,mode:'read'}))]};
 }
 function pricedPreparation(inspected){return {...inspected.prepared,...inspected.resolvedPrice?{resolvedPrice:inspected.resolvedPrice}:{}};}
 function quoted(actor,input,inspected){const {company,p,bound,prepared}=inspected;return {...store.quote(actor,{companyId:company.id,projectId:p.id,connectionId:bound.connectionId,prepared:pricedPreparation(inspected)}),operationId:input.operationId,commandKind:prepared.method,model:prepared.model,quantity:prepared.quantity};}
 function approvedRequest(input,quote){
  const stable=quote.price?.quoteIdentity?{...quote,price:{protocol:quote.price.protocol,quoteIdentity:quote.price.quoteIdentity,model:quote.price.model,apiModel:quote.price.apiModel,unitMinor:quote.price.unitMinor,source:quote.price.source,locked:false}}:quote;
  return companyCliDigest({kind:input.kind,operationId:input.operationId,request:input.request,inputCapture:input.inputCapture,quote:stable});
 }
 function issueCharge(actor,input,quote){
  if(!quote.withinLimit)return {quote};
  for(const [key,approval] of chargeApprovals)if(approval.expiresAt<=now())chargeApprovals.delete(key);
  if(chargeApprovals.size>=maxChargeApprovals)throw fail('company_cli_approval_capacity',429);
  const approvalToken=randomBytes(32).toString('base64url'),expiresAt=Math.min(now()+chargeApprovalTtlMs,quote.price?.quoteIdentity?Date.parse(quote.price.expiresAt):Infinity);
  chargeApprovals.set(hash(approvalToken),{actorId:actor.id,digest:approvedRequest(input,quote),expiresAt});return {quote,approvalToken,expiresAt};
 }
 function consumeCharge(actor,input,quote,token){
  const key=typeof token==='string'?hash(token):'',approval=chargeApprovals.get(key);
  if(!approval||approval.actorId!==actor.id||approval.expiresAt<=now())throw fail('company_cli_user_approval_required',428);
  if(approval.digest!==approvedRequest(input,quote))throw fail('company_cli_approval_stale',409);
  chargeApprovals.delete(key);return {actorId:actor.id,approvedAt:new Date(now()).toISOString(),quoteSha256:companyCliDigest(quote),reservedMinor:quote.reservedMinor};
 }
 async function prepareCharge(actor,input){
  if(input.kind!=='advanced'||input.approvalToken!==undefined)throw fail('company_cli_advanced_review_required',428);
  const inspected=await inspectGeneration(actor,input);if(inspected.prior)return {receipt:receipt(inspected.prior)};
  return issueCharge(actor,input,quoted(actor,input,inspected));
 }
 async function generation(actor,input){
  const inspected=await inspectGeneration(actor,input);if(inspected.prior)return receipt(inspected.prior);
  const {company,p,bound,capture,node,prepared,resources,advanced}=inspected;
  let chargeApproval;
  if(advanced){
   chargeApproval=consumeCharge(actor,input,quoted(actor,input,inspected),input.approvalToken);
  }
  // Admission retains the user's exact review and the independently reread supplier evidence.
  const admission={...pricedPreparation(inspected),resources,inputCapture:{nativeRequest:input.request,nativeCapture:capture,...chargeApproval?{chargeApproval}:{}}};
  const job=store.admit(actor,{companyId:company.id,projectId:p.id,connectionId:bound.connectionId,operationId:input.operationId,prepared:admission});
  if(job.replayed)return receipt(job);
  let reserved,nativeAdmissionStarted=false;
  try{
   await mirrorNativeBudget(actor,p,job);
   const value=input.request;
   nativeAdmissionStarted=true;
   reserved=await native(actor,p,'POST','/api/v1/muse/libtv-cli/operations/reserve',{database_id:p.nativeDatabaseId,project_id:p.nativeProjectId,project_uuid:p.canvasUuid,node_id:advanced?value.spec.node_id:value.node_id,cli_owner:bound.owner,operation_id:input.operationId,request_sha256:companyCliDigest(value),model:prepared.model,max_reserved_minor:Math.min(value.max_reserved_minor??job.reservedMinor,job.reservedMinor),model_schema_sha256:advanced?capture.metadata_sha256:value.schema_sha256,node_snapshot_sha256:advanced?capture.node_sha256:value.node_sha256,service:prepared.service,quantity:prepared.quantity,...value.storyboard_id===undefined?{}:{storyboard_id:value.storyboard_id},prompt:advanced?'':node.data.params.prompt,reference_sha256s:[],input_capture:capture,...value.muse_prompt_revision_id===undefined?{}:{muse_prompt_revision_id:value.muse_prompt_revision_id,muse_studio_database_id:value.muse_studio_database_id??null,muse_prompt_references:value.muse_prompt_references??[]}});
  }catch(error){
   // A received validation refusal is definite; a transport failure may have reserved natively.
   if(!nativeAdmissionStarted||error.status>=400&&error.status<500)store.cancelReservedJob(job.id);else{store.claimJob(job.id);store.finishJob(job.id,{state:'unknown',result:{error_code:'company_cli_native_admission_unconfirmed'}});}
   throw error;
  }
  if(!reserved.dispatch_allowed){store.claimJob(job.id);store.finishJob(job.id,{state:'unknown',result:{error_code:'company_cli_native_original_operation'}});return receipt(store.getJob(actor,job.id));}
  store.claimJob(job.id);
  finish(job.id,async()=>{
   let output,state='unknown';
   try{output=await executor.execute(prepared,{operationId:job.id});state=output.state;}catch(error){output={records:[],error_code:error.code??'company_cli_execution_unconfirmed'};}
   let nativeRecorded=false;
   try{await native(actor,p,'POST','/api/v1/muse/libtv-cli/operations/'+input.operationId+'/status',{database_id:p.nativeDatabaseId,request_sha256:companyCliDigest(input.request),state,result:originalOutput(output)});nativeRecorded=true;}catch(error){onError();}
   store.finishJob(job.id,{state,result:{output,nativeRecorded}});
  });
  return receipt(store.getJob(actor,job.id));
 }
 const postproduction=createCompanyPostproductionService({store,provider:apiPostproduction??createLibTvSubtitleProvider({now}),signal:priceLifetime.signal,native,read:async(command,bound)=>record(await executeRead(command,bound)),approvals:{issue:issueCharge,consume:consumeCharge},
  scope:async(actor,input)=>{const company=context(actor,input.companyId);if(input.nativeProjectId===undefined)return {company,bound:binding(company)};const p=await projectFor(actor,company,{nativeProjectId:input.nativeProjectId});return {company,p,bound:binding(company,p)};},
  jobScope:async(actor,job)=>{const p=store.getProject(actor,job.projectId),c=connections.find(item=>item.id===job.connectionId&&item.companyId===job.companyId);return {p,bound:c?{companyId:job.companyId,projectId:p.id,connectionId:job.connectionId,connectionRevision:job.connectionRevision,credentialsDir:c.credentialsDir,owner:job.owner,canvasUuid:p.canvasUuid,workspaceId:c.workspaceId,teamId:c.teamId,catalogAdmin:false}:undefined};}});
 async function dispatch(actor,{method,path,body={}}){
  if(closing)throw fail('company_cli_draining',503);
  const url=new URL(path,'http://localhost'),route=url.pathname;
  if(route==='/context'&&method==='GET'){
   const selected=url.searchParams.get('companyId');
   if(selected)return {companies:[publicContext(actor,selected)]};
   return {companies:store.context(actor).companies.map(c=>publicContext(actor,c.id))};
  }
  if(route==='/command'&&method==='POST')return command(actor,body);
  if(route==='/projects/register'&&method==='POST')return registerExistingProject(actor,body);
  if(route==='/postproduction/capabilities'&&method==='GET')return postproduction.capabilities(actor,url.searchParams.get('companyId')||undefined);
  if(route==='/postproduction/prepare'&&method==='POST')return postproduction.prepare(actor,body);
  if(route==='/postproduction'&&method==='POST')return postproduction.run(actor,body);
  if(route.startsWith('/postproduction/')&&['GET','POST'].includes(method)){
   const parts=route.split('/').slice(2);if(!id(parts[0]))throw fail('company_postproduction_invalid_request',400);
   if(parts.length===1&&method==='GET')return postproduction.get(actor,url.searchParams.get('companyId')||undefined,parts[0]);
   if(parts.length===2&&parts[1]==='import'&&method==='POST'){own(body,['companyId']);return postproduction.importResult(actor,body.companyId,parts[0]);}
  }
  if(route==='/downloads'&&method==='POST')return download(actor,body);
  if(route.startsWith('/downloads/')&&method==='GET'){
   const parts=route.split('/').slice(2);if(parts.length!==1&&(parts.length!==5||parts[1]!=='files'||parts[3]!=='chunks'))throw fail('company_cli_download_not_found',404);
   if(!id(parts[0]))throw fail('company_cli_invalid_download');const job=downloadJob(actor,url.searchParams.get('companyId')||undefined,parts[0]),manifest=downloadManifest(job);
   if(parts.length===1)return manifest;
   if(manifest.state!=='completed')throw fail('company_cli_download_not_ready',409);
   const file=manifest.files.find(item=>item.fileId===parts[2]),index=Number(parts[4]);
   if(!file||!/^\d+$/u.test(parts[4])||!Number.isSafeInteger(index))throw fail('company_cli_download_not_found',404);
   return downloadFiles.readChunk(job.id,file,index);
  }
  if(route==='/generations/prepare'&&method==='POST')return prepareCharge(actor,body);
  if(route==='/generations'&&method==='POST')return generation(actor,body);
  if(route.startsWith('/generations/')&&method==='GET'){
   const company=context(actor,url.searchParams.get('companyId')||undefined),operationId=decodeURIComponent(route.slice('/generations/'.length)),nativeId=Number(url.searchParams.get('projectId'));
   const p=positive(nativeId)?company.projects.find(row=>row.nativeProjectId===nativeId&&row.tenantAccountId===actor.id):null;
   const job=store.findJob(actor,{companyId:company.id,operationId,...p?{projectId:p.id}:{}});if(!job)throw fail('company_cli_job_not_found',404);return receipt(job);
  }
  if(route==='/budget/prepare'&&method==='POST'){own(body,['companyId','scope','targetId','limitMinor','reason']);return store.prepareBudgetChange(actor,body);}
  if(route==='/budget/confirm'&&method==='POST'){own(body,['proposalId','approvalNonce','approved']);return store.confirmBudgetChange(actor,body);}
  if(route==='/manage'&&method==='POST'){
   own(body,['companyId','method','input']);const company=context(actor,body.companyId);own(body.input,body.method==='set_member'?['userId','role','active','expectedRevision']:['projectId','userId','role']);
   if(body.method==='set_member')return store.setMember(actor,{...body.input,companyId:company.id});
   if(body.method==='set_project_member'){if(store.getProject(actor,body.input.projectId).companyId!==company.id)throw fail('company_cli_project_not_found',404);return store.setProjectMember(actor,body.input);}
   throw fail('company_cli_unknown_method');
  }
  throw fail('company_cli_route_not_found',404);
 }
 function trackedDispatch(actor,input){const task=dispatch(actor,input);pending.add(task);task.finally(()=>pending.delete(task)).catch(()=>{});return task;}
 return {dispatch:trackedDispatch,async handle(req,res,{actor,isAuthorized}){
  if(!req.url?.startsWith(prefix+'/'))return false;
  const answer=(status,value)=>{if(!res.destroyed){res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'});res.end(JSON.stringify(value));}};
  try{
   if(!isAuthorized())throw fail('account_session_expired',401);
   const chunks=[];let size=0;const timer=setTimeout(()=>req.destroy(),requestTimeoutMs);timer.unref();
   try{for await(const chunk of req){size+=chunk.length;if(size>maxRequestBytes)throw fail('company_cli_request_too_large',413);chunks.push(chunk);}}finally{clearTimeout(timer);}
   if(!isAuthorized())throw fail('account_session_expired',401);
   let body={};if(size){if(req.headers['content-type']?.split(';')[0]!=='application/json')throw fail('company_cli_json_required',415);try{body=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw fail('company_cli_invalid_json');}}
   const value=await trackedDispatch(actor,{method:req.method,path:req.url.slice(prefix.length),body});
   if(!isAuthorized())throw fail('account_session_expired',401);answer(200,{success:true,data:value});
  }catch(error){answer(error.status??503,{success:false,error:{code:error.code??'company_cli_unavailable'},...error.budget?{budget:error.budget}:{}});}
  return true;
 },async close(){closing=true;chargeApprovals.clear();priceLifetime.abort();await Promise.allSettled([...pending]);await executor.close();await Promise.allSettled([...running.values()]);store.close();}};
}

/**
 * Load private operator configuration; absent configuration leaves the shared route disabled.
 * @param {string|undefined} file Absolute private JSON configuration path.
 * @param {object} options Live account store, tenant runtime and public origin.
 * @returns {Promise<object|undefined>} Owned company service.
 */
export async function loadCompanyCliService(file,{accounts,studioRuntime,publicOrigin}){
 if(!file)return undefined;
 if(!isAbsolute(file)||!studioRuntime)throw fail('company_cli_invalid_configuration',500);
 const info=await lstat(file);if(!info.isFile()||info.isSymbolicLink()||process.platform!=='win32'&&(info.mode&0o077)!==0)throw fail('company_cli_configuration_not_private',500);
 const cfg=JSON.parse(await readFile(file,'utf8'));own(cfg,['file','stageRoot','executable','workRoot','maxParallel','maxReadParallel','requestTimeoutMs','maxOutputBytes','timeoutMs','graceMs','companies','connections','prices','openingReservations','chargeApprovalTtlMs','maxChargeApprovals','maxLedgerRecordBytes','maxDownloadBytes','downloadChunkBytes']);
 const recordBytes=cfg.maxLedgerRecordBytes??cfg.maxOutputBytes*4;
 if(!positive(recordBytes)||recordBytes<cfg.maxOutputBytes+4096||recordBytes>67108864)throw fail('company_cli_invalid_configuration',500);
 const downloadChunkBytes=cfg.downloadChunkBytes??Math.min(262144,Math.floor((cfg.maxOutputBytes-4096)*3/4));
 if(!positive(downloadChunkBytes)||4*Math.ceil(downloadChunkBytes/3)+4096>cfg.maxOutputBytes)throw fail('company_cli_invalid_configuration',500);
 const store=await openCompanyCliStore({file:cfg.file,accountById:id=>accounts.get(id),maxParallel:cfg.maxParallel,maxRequestBytes:recordBytes});
 if(!positive(cfg.maxReadParallel)||!positive(cfg.requestTimeoutMs))throw fail('company_cli_invalid_configuration',500);
 const executor=createCompanyCliExecutor({executable:cfg.executable,workRoot:cfg.workRoot,maxConcurrent:cfg.maxParallel+cfg.maxReadParallel,maxOutputBytes:cfg.maxOutputBytes,timeoutMs:cfg.timeoutMs,graceMs:cfg.graceMs});
 try{
  for(const company of cfg.companies){const actor={id:company.ownerId};if(!store.context(actor).companies.some(c=>c.id===company.id))store.bootstrapCompany(company);}
  for(const opening of cfg.openingReservations??[])store.bootstrapOpeningBalance(opening);
  for(const c of cfg.connections){const owner=cfg.companies.find(p=>p.id===c.companyId)?.ownerId;if(!owner)throw fail('company_cli_invalid_configuration',500);const actor={id:owner},current=store.context(actor).companies.find(p=>p.id===c.companyId)?.connections.find(p=>p.id===c.id);if(!current)store.setConnection(actor,{id:c.id,companyId:c.companyId,label:c.label,environment:c.environment,owner:c.owner,maxParallel:c.maxParallel,active:c.active,expectedRevision:0});else if(companyCliDigest(current.owner)!==companyCliDigest(c.owner)||current.maxParallel!==c.maxParallel||current.active!==c.active)throw fail('company_cli_connection_config_changed',500);}
  for(const price of cfg.prices??[]){const owner=cfg.companies.find(c=>c.id===price.companyId)?.ownerId;if(!owner)throw fail('company_cli_invalid_configuration',500);const current=store.getPrice({id:owner},price);if(!current||current.unitMinor!==price.unitMinor||current.source!==price.source||current.expiresAt!==price.expiresAt)store.setPrice({id:owner},{...price,expectedRevision:current?.revision??0});}
  store.recoverInterruptedJobs();
  const nativeRequest=async(accountId,{method,path,body})=>{
   if(!/^\/api\/v1\/(?:dramas\/\d+|muse\/(?:libtv-cli|libtv-postproduction|budget)\/)/u.test(path))throw fail('company_cli_native_path_refused',500);
   const bytes=body===undefined?undefined:JSON.stringify(body),lease=await studioRuntime.acquire(accountId,{write:method!=='GET',requestBytes:bytes?Buffer.byteLength(bytes):0});
   try{
    const response=await fetch(new URL(path,lease.target),{method,headers:{'x-muse-studio-worker':lease.token,origin:publicOrigin,...bytes?{'content-type':'application/json'}:{}},body:bytes,redirect:'error',signal:AbortSignal.timeout(60000)});
    const chunks=[];let size=0;for await(const chunk of response.body){size+=chunk.length;if(size>4194304)throw fail('company_cli_native_response_too_large',502);chunks.push(chunk);}const text=Buffer.concat(chunks).toString('utf8');
    let result;try{result=JSON.parse(text);}catch{throw fail('company_cli_native_invalid_response',502);}
    if(!response.ok||result.success!==true)throw fail(result.error?.code??'company_cli_native_refused',response.status>=400?response.status:502);return result.data;
   }finally{lease.release();}
  };
  return createCompanyCliService({store,executor,nativeRequest,connections:cfg.connections,publicOrigin,stageRoot:cfg.stageRoot,maxReadParallel:cfg.maxReadParallel,requestTimeoutMs:cfg.requestTimeoutMs,downloadChunkBytes,...cfg.maxDownloadBytes===undefined?{}:{maxDownloadBytes:cfg.maxDownloadBytes},...cfg.chargeApprovalTtlMs===undefined?{}:{chargeApprovalTtlMs:cfg.chargeApprovalTtlMs},...cfg.maxChargeApprovals===undefined?{}:{maxChargeApprovals:cfg.maxChargeApprovals}});
 }catch(error){await executor.close();store.close();throw error;}
}

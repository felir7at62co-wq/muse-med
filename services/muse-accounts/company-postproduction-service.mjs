/** Company-authorized LibTV API postproduction with immutable source and provider task identities. */
import {createHash} from 'node:crypto';
import {companyCliDigest as digest} from './company-cli-executor.mjs';

const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const positive=value=>Number.isSafeInteger(value)&&value>0;
const id=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,128}$/u.test(value);
const sha=value=>typeof value==='string'&&/^[a-f0-9]{64}$/u.test(value);
const fail=(code,status=409)=>Object.assign(new Error(code),{code,status});
const model='volcano-subtitle-eraser',method='libtv_api_erase_subtitles';
function parsed(input,approval=false){
 const fields=['companyId','operationId','nativeProjectId','databaseId','sourceGenerationId','sourceSha256','kind',...approval?['approvalToken']:[]];
 if(!object(input)||Object.keys(input).some(key=>!fields.includes(key))||!id(input.operationId)||!positive(input.nativeProjectId)||typeof input.databaseId!=='string'||!positive(input.sourceGenerationId)||!sha(input.sourceSha256)||input.kind!=='erase_subtitles')throw fail('company_postproduction_invalid_request',400);
 const {approvalToken,...request}=input;return {request,approvalToken};
}
function outputId(companyId,actorId,operationId){const hex=createHash('sha256').update(companyId+':'+actorId+':'+operationId).digest('hex');return hex.slice(0,8)+'-'+hex.slice(8,12)+'-4'+hex.slice(13,16)+'-a'+hex.slice(17,20)+'-'+hex.slice(20,32);}

/**
 * Create the private API controller. Every callback retains the parent service's authentication and lifetime.
 * @param {object} options Company ledger, fixed provider, project/native readers and private human approval callbacks.
 * @returns {object} Read-only capabilities/prepare/get, explicitly authorized run and idempotent native import.
 */
export function createCompanyPostproductionService({store,provider,scope,jobScope,native,read,approvals,signal}){
 function view(job){
  const capture=job.inputCapture;if(job.method!==method||capture?.provider!=='libtv-api')throw fail('company_postproduction_operation_conflict');
  const request=capture.request;
  return {operationId:job.operationId,provider:'libtv-api',kind:'erase_subtitles',paid:true,state:job.state,companyId:job.companyId,nativeProjectId:request.nativeProjectId,databaseId:request.databaseId,sourceGenerationId:request.sourceGenerationId,sourceSha256:request.sourceSha256,sourceKind:capture.source.kind,projectUuid:capture.source.kind==='libtv-cli'?capture.source.projectUuid:null,nodeId:capture.source.kind==='libtv-cli'?capture.source.nodeId:null,nodeSha256:capture.source.kind==='libtv-cli'?capture.source.nodeSha256:null,model:job.model,reservedMinor:job.reservedMinor,
   ...job.result?.providerTask?{taskId:job.result.providerTask.taskId}:{},...job.result?.providerResult?{result:job.result.providerResult}:{},...job.result?.billing?{billing:job.result.billing}:{},...job.result?.nativeImport?{nativeImport:job.result.nativeImport}:{},...job.result?.nativeImportError?{importError:job.result.nativeImportError}:{},...job.result?.errorCode?{errorCode:job.result.errorCode}:{}};
 }
 async function existing(actor,companyId,operationId){const {company}=await scope(actor,{companyId});const job=store.findJob(actor,{companyId:company.id,operationId});if(!job)throw fail('company_postproduction_not_found',404);view(job);return job;}
 async function inspect(actor,input){
  const {request,approvalToken}=parsed(input,true),resolved=await scope(actor,request),{company,p,bound}=resolved;
  if(p.nativeDatabaseId!==request.databaseId)throw fail('company_postproduction_database_changed');
  const old=store.findJob(actor,{companyId:company.id,operationId:request.operationId});
  if(old){if(old.method!==method||digest(old.inputCapture?.request)!==digest(request))throw fail('company_postproduction_operation_conflict');return {old};}
  const origin=await native(actor,p,'GET','/api/v1/muse/libtv-postproduction/sources/'+request.sourceGenerationId+'/inspect');
  if(!object(origin)||origin.generation_id!==request.sourceGenerationId||origin.project_id!==p.nativeProjectId||origin.source_sha256!==request.sourceSha256||typeof origin.database_id!=='string'||!object(origin.origin)||!object(origin.origin.owner)||!['libtv-cli','libtv-api'].includes(origin.origin.provider)||digest(origin.origin.owner)!==digest(bound.owner))throw fail('company_postproduction_source_changed');
  let sourceNode;
  if(origin.origin.provider==='libtv-cli'){
   if(origin.origin.project_uuid!==p.canvasUuid||!id(origin.origin.node_id))throw fail('company_postproduction_source_changed');
   sourceNode=await read({method:'node_read',body:{project_uuid:p.canvasUuid,node_id:origin.origin.node_id}},bound);
   if(sourceNode.nodeKey!==origin.origin.node_id||!Array.isArray(sourceNode.data?.url)||!sourceNode.data.url.includes(origin.origin.result_url))throw fail('company_postproduction_source_changed');
  }else sourceNode={nodeKey:'native-generation-'+request.sourceGenerationId,data:{type:'video',url:[origin.origin.result_url],taskInfo:{status:2,loading:false},resourceMeta:{items:[{kind:'video',width:origin.metadata?.width,height:origin.metadata?.height,durationSec:origin.metadata?.duration_seconds}]}}};
  const source={kind:origin.origin.provider,projectUuid:p.canvasUuid,nodeId:sourceNode.nodeKey,nodeSha256:digest(sourceNode),node:sourceNode,outputNodeId:outputId(company.id,actor.id,request.operationId),measuredMedia:{width:origin.metadata?.width,height:origin.metadata?.height,durationSec:origin.metadata?.duration_seconds}};
  const prepared=await provider.prepare({binding:bound,source,read:async(method,body)=>read({method,body},bound)});
  if(prepared.method!==method||prepared.model!==model||!sha(prepared.requestSha256))throw fail('company_postproduction_invalid_preparation',502);
  const rawQuote=await provider.quote({prepared,binding:bound,signal}),resolvedPrice={...rawQuote,sourceSha256:request.sourceSha256};
  const admission={...prepared,body:prepared.request,provider:'libtv-api',service:'postproduction',paid:true,quantity:1,sourceSha256:request.sourceSha256,resolvedPrice,
   resourceKey:'canvas:'+p.id+':node:'+source.nodeId,resources:[{key:'canvas:'+p.id+':edges',mode:'read'},{key:'canvas:'+p.id+':node:'+source.nodeId,mode:'read'},{key:'canvas:'+p.id+':node:'+source.outputNodeId,mode:'write'}],
   inputCapture:{provider:'libtv-api',request,source,nativeSource:origin,providerRequest:prepared.request}};
  const quote={...store.quote(actor,{companyId:company.id,projectId:p.id,connectionId:bound.connectionId,prepared:admission}),operationId:request.operationId,provider:'libtv-api',kind:'erase_subtitles',commandKind:'erase_subtitles',model,quantity:1};
  const approvalInput={kind:'libtv-api',operationId:request.operationId,request,inputCapture:{provider:'libtv-api',request,source,nativeSource:origin,requestSha256:prepared.requestSha256}};
  return {request,approvalToken,company,p,bound,source,prepared,rawQuote,admission,quote,approvalInput};
 }
 async function prepare(actor,input){parsed(input);const inspected=await inspect(actor,input);if(inspected.old)return {operation:view(inspected.old)};return approvals.issue(actor,inspected.approvalInput,inspected.quote);}
 async function run(actor,input){
  const current=await inspect(actor,input);if(current.old)return {operation:view(current.old)};
  const {request,approvalToken,company,p,bound,prepared,rawQuote,admission,quote,approvalInput,source}=current;
  const decision=approvals.consume(actor,approvalInput,quote,approvalToken);
  const job=store.admit(actor,{companyId:company.id,projectId:p.id,connectionId:bound.connectionId,operationId:request.operationId,prepared:{...admission,inputCapture:{...admission.inputCapture,chargeApproval:decision}}});
  if(job.replayed)return {operation:view(job)};
  try{
   const unchanged=await native(actor,p,'GET','/api/v1/muse/libtv-postproduction/sources/'+request.sourceGenerationId+'/inspect');
   if(digest(unchanged)!==digest(admission.inputCapture.nativeSource))throw fail('company_postproduction_source_changed');
   if(source.kind==='libtv-cli'&&digest(await read({method:'node_read',body:{project_uuid:p.canvasUuid,node_id:source.nodeId}},bound))!==source.nodeSha256)throw fail('company_postproduction_source_changed');
   store.claimJob(job.id);
  }catch(error){store.cancelReservedJob(job.id);throw error;}
  try{const ack=await provider.create({prepared,binding:bound,quote:rawQuote,signal});store.recordProviderTask(job.id,{provider:'libtv-api',taskId:ack.taskId,ack});}
  catch(error){store.finishJob(job.id,{state:'unknown',result:{errorCode:error.code??'company_postproduction_submission_unconfirmed'}});}
  return {operation:view(store.getJob(actor,job.id))};
 }
 async function get(actor,companyId,operationId){
  const job=await existing(actor,companyId,operationId);if(['completed','failed'].includes(job.state)||!job.result?.providerTask)return {operation:view(job)};
  const {bound}=await jobScope(actor,job);if(!bound)throw fail('company_cli_connection_unavailable',503);await read({method:'status',body:{}},bound);
  const result=await provider.progress({taskId:job.result.providerTask.taskId,binding:bound,signal});
  if(result.taskId!==job.result.providerTask.taskId)throw fail('company_postproduction_task_changed',502);
  if(['completed','failed','unknown'].includes(result.state))store.finishJob(job.id,{state:result.state,result:{...job.result,providerResult:result}});
  return {operation:view(store.getJob(actor,job.id))};
 }
 async function importResult(actor,companyId,operationId){
  const job=await existing(actor,companyId,operationId);if(job.result?.nativeImport)return {...job.result.nativeImport,replayed:true};
  if(job.state!=='completed'||job.result?.providerResult?.state!=='completed')throw fail('company_postproduction_not_completed');
  const outputs=job.result.providerResult.outputs;if(!Array.isArray(outputs)||outputs.length!==1||outputs[0].kind!=='video')throw fail('company_postproduction_output_unconfirmed',502);
  const {p}=await jobScope(actor,job),capture=job.inputCapture,original=capture.nativeSource;
  const body={database_id:original.database_id,operation_id:'api-import-'+job.id,request_sha256:job.requestSha256,project_id:p.nativeProjectId,storyboard_id:original.storyboard_id,source_generation_id:capture.request.sourceGenerationId,source_sha256:capture.request.sourceSha256,origin:original.origin,model,parameters:capture.providerRequest.params,provider_task_id:job.result.providerTask.taskId,result_url:outputs[0].url,company_id:job.companyId,company_operation_id:job.operationId,quote:{currency:'LTV',reserved_minor:job.reservedMinor,identity:job.price.quoteIdentity,...job.price.zeroQuote===true?{zeroQuote:true,response:job.price.response}:{},...job.result.billing?{billing:job.result.billing}:{}}};
  try{
   const imported=await native(actor,p,'POST','/api/v1/muse/libtv-postproduction/internal/imports',body);
   if(imported?.provider!=='libtv-api'||imported.source_operation_id!==job.operationId||imported.source_generation_id!==capture.request.sourceGenerationId||imported.operation_id!==body.operation_id||!positive(imported.generation_id)||!sha(imported.sha256)||imported.adopted!==false)throw fail('company_postproduction_import_unconfirmed',502);
   const stable={...imported,replayed:false};store.recordProviderImport(job.id,stable);return {...stable,replayed:imported.replayed===true};
  }catch(error){store.recordProviderImportFailure(job.id,{errorCode:typeof error.code==='string'&&/^[a-z0-9_]+$/u.test(error.code)?error.code:'company_postproduction_import_unconfirmed'});throw error;}
 }
 return {prepare,run,get,importResult,async capabilities(actor,companyId){await scope(actor,{companyId});return {available:true,provider:'libtv-api',kind:'erase_subtitles',model};}};
}

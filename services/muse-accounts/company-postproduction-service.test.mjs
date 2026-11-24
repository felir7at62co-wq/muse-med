/** Private approval and two-ledger isolation for LibTV API subtitles; all provider requests are local fixtures. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openCompanyCliStore} from './company-cli-store.mjs';
import {createCompanyCliService} from './company-cli-service.mjs';
import {companyCliDigest as digest} from './company-cli-executor.mjs';
import {createLibTvSubtitleProvider} from './company-libtv-subtitles.mjs';

const actor={id:'aaaaaaaaaaaaaaaa'},other={id:'bbbbbbbbbbbbbbbb'},owner={user_uuid:'fixture-user',account_id:'fixture-account',team_id:null};
const model='volcano-subtitle-eraser',sourceSha='b'.repeat(64);
async function fixture(t,{realProvider=false,limit=10000,opening=7100}={}){
 const root=await mkdtemp(join(tmpdir(),'muse-company-api-')),file=join(root,'company.sqlite');let now=Date.now();
 const accounts=new Map([actor,other].map(value=>[value.id,{...value,disabled:false}]));
 const store=await openCompanyCliStore({file,accountById:id=>accounts.get(id),maxParallel:4,now:()=>now});
 store.bootstrapCompany({id:'company',name:'Company',ownerId:actor.id});store.setMember(actor,{companyId:'company',userId:other.id,role:'member',active:true,expectedRevision:0});
 store.setConnection(actor,{id:'connection',companyId:'company',label:'Test',environment:'test',owner,maxParallel:4,active:true,expectedRevision:0});
 const p=store.createProject(actor,{id:'project',companyId:'company',name:'Original',tenantAccountId:actor.id,nativeProjectId:1,nativeDatabaseId:'native-cli-db'});store.bindCanvas(actor,{projectId:p.id,canvasUuid:'canvas',connectionId:'connection',expectedRevision:p.revision});
 for(const [scope,targetId] of [['company','company'],['member',actor.id],['project','project']]){const proposal=store.prepareBudgetChange(actor,{companyId:'company',scope,targetId,limitMinor:limit});store.confirmBudgetChange(actor,{proposalId:proposal.proposal.id,approvalNonce:proposal.approvalNonce,approved:true});}
 store.bootstrapOpeningBalance({companyId:'company',userId:actor.id,minor:opening,source:'verified prior charges',operationId:'old-71'});
 const node={nodeKey:'source-node',data:{type:'video',url:['https://libtv-res.liblib.art/original.mp4'],resourceMeta:{items:[{kind:'video',width:1280,height:720,durationSec:6}]},taskInfo:{status:2}}};
 const nativeSource={database_id:'postproduction-db',project_id:1,storyboard_id:2,generation_id:3,source_sha256:sourceSha,local_path:'video/original.mp4',metadata:{width:1280,height:720,duration_seconds:6},origin:{provider:'libtv-cli',operation_id:'old-generation',project_uuid:'canvas',node_id:'source-node',result_url:node.data.url[0],owner}};
 const calls={create:0,quote:0,progress:0,native:[]},state={price:1000,terminal:'running',createError:false,zeroPrice:false},quotes=new WeakMap();
 const mockProvider={async prepare({source,binding}){const request={params:{model,mode:'Subtitle',videoList:[source.node.data.url[0]]},requestId:'random-'+calls.quote};return {method:'libtv_api_erase_subtitles',model,request,requestSha256:digest({source,binding:{...binding,credentialsDir:undefined}})};},async quote({prepared,binding}){
  calls.quote++;if(state.zeroPrice)throw Object.assign(new Error('Unknown zero estimate'),{code:'company_libtv_subtitles_unknown_price',status:428});
  const value={protocol:'muse-company-libtv-api-quote-v1',provider:'libtv-api',service:'postproduction',model,quantity:1,currency:'LTV',unitMinor:state.price,priceMinor:state.price,reservedMinor:state.price,source:'https://api.liblib.tv/api/task/generation/power/calculator',quotedAt:new Date(now).toISOString(),expiresAt:new Date(now+60000).toISOString(),requestSha256:prepared.requestSha256,connectionId:binding.connectionId,connectionRevision:binding.connectionRevision,owner:binding.owner,quoteIdentity:digest({requestSha256:prepared.requestSha256,price:state.price}),locked:false};quotes.set(value,prepared);return value;
 },async create({prepared,quote}){assert.equal(quotes.get(quote),prepared);calls.create++;if(state.createError)throw Object.assign(new Error('Uncertain create'),{code:'company_libtv_subtitles_submission_unknown'});return {provider:'libtv-api',taskId:'provider-task',requestSha256:prepared.requestSha256};},async progress({taskId}){assert.equal(taskId,'provider-task');calls.progress++;return {taskId,state:state.terminal,outputs:state.terminal==='completed'?[{kind:'video',url:'https://media.example/result.mp4'}]:[]};}};
 const provider=realProvider?createLibTvSubtitleProvider({now:()=>now,fetchImpl:async(endpoint,options)=>{
  const body=JSON.parse(options.body);
  if(endpoint.endsWith('/calculator')){calls.quote++;return Response.json({code:0,data:{power:state.price/100,originalPrice:state.price/100,...state.verifiedZero?{taskWeight:0,type:0,discountRatio:1}:{}}});}
  if(endpoint.endsWith('/create')){calls.create++;assert.notEqual(body.metadata.node_id,node.nodeKey);return Response.json({code:0,data:{taskId:'provider-task'}});}
  calls.progress++;return Response.json({code:0,data:{progresses:[{taskId:'provider-task',status:state.terminal==='completed'?2:1,power:state.price/100,taskResult:JSON.stringify({videos:[{previewPath:'https://libtv-res.liblib.art/result.mp4'}]})}]}});
 }}):mockProvider;
 await writeFile(join(root,'credentials.json'),JSON.stringify({usertoken:'local-private-token',webid:'local-webid',useruuid:owner.user_uuid}),{mode:0o600});
 const schema={modelKey:model,modality:'video',schema:{modelKey:model,modelVendor:'volcano',properties:{},config:{generateTypes:{text:119,image:119}},rules:[{check:'videoFormat',allow:['mp4','flv','ts','avi','mov','mkv','wmv']},{check:'videoMaxResolution',max:2048},{check:'videoMinDuration',min:3}]}};
 const executor={async prepare(command,binding){assert.deepEqual(binding.owner,owner);return command;},async execute(command){return {exit_code:0,state:'completed',records:[command.method==='node_read'?structuredClone(node):command.method==='model_schema'?schema:{ok:true}]};},async close(){}};
 const service=createCompanyCliService({store,executor,apiPostproduction:provider,connections:[{id:'connection',companyId:'company',credentialsDir:root,workspaceId:0,teamId:0}],publicOrigin:'https://muse.example',stageRoot:root,now:()=>now,nativeRequest:async(account,request)=>{
  assert.equal(account,actor.id);calls.native.push(request);
  if(request.method==='GET'&&request.path.includes('/sources/'))return structuredClone(nativeSource);
  if(request.path==='/api/v1/muse/libtv-postproduction/internal/imports'){if(state.importFailure)throw Object.assign(new Error('fixture import failure'),{code:'libtv_postproduction_media_changed'});return {operation_id:request.body.operation_id,source_operation_id:request.body.company_operation_id,provider:'libtv-api',generation_id:4,source_generation_id:request.body.source_generation_id,sha256:'c'.repeat(64),local_path:'video/derived.mp4',url:'/static/video/derived.mp4',adopted:false,replayed:false};}
  throw new Error('Unexpected native request '+request.path);
 }});
 t.after(async()=>{await service.close();await rm(root,{recursive:true,force:true});});
 const input={companyId:'company',operationId:'api-erase',nativeProjectId:1,databaseId:'native-cli-db',sourceGenerationId:3,sourceSha256:sourceSha,kind:'erase_subtitles'};
 const call=(method,path,body)=>service.dispatch(actor,{method,path,body});
 return {store,service,provider,calls,state,node,nativeSource,input,call,accounts,advance:value=>{now+=value;}};
}
const prepare=f=>f.call('POST','/postproduction/prepare',f.input);
const run=(f,token)=>f.call('POST','/postproduction',{...f.input,...token?{approvalToken:token}:{}});

test('API subtitles require private approval, retain the task and import without a native CLI reservation',async t=>{
 const f=await fixture(t);await assert.rejects(run(f),{code:'company_cli_user_approval_required'});assert.equal(f.calls.create,0);
 const reviewed=await prepare(f);assert.equal(reviewed.quote.reservedMinor,1000);assert.equal(reviewed.quote.provider,'libtv-api');assert.equal(reviewed.quote.budgets[0].availableMinor,2900);
 const accepted=await run(f,reviewed.approvalToken);assert.equal(accepted.operation.taskId,'provider-task');assert.equal(f.calls.create,1);assert.equal(f.store.readBudget(actor,{companyId:'company'}).reservedMinor,8100);
 const job=f.store.findJob(actor,{companyId:'company',operationId:'api-erase'});assert.equal(job.result.providerTask.taskId,'provider-task');assert.equal(JSON.stringify(job).includes(reviewed.approvalToken),false);
 await run(f,reviewed.approvalToken);assert.equal(f.calls.create,1);
 f.state.terminal='completed';const result=await f.call('GET','/postproduction/api-erase?companyId=company');assert.equal(result.operation.state,'completed');
 const imported=await f.call('POST','/postproduction/api-erase/import',{companyId:'company'});assert.equal(imported.provider,'libtv-api');assert.equal(imported.adopted,false);
 await f.call('POST','/postproduction/api-erase/import',{companyId:'company'});
 assert.equal(f.calls.native.filter(row=>row.method==='POST').length,1);assert.equal(f.calls.native.some(row=>row.path.includes('/budget/')||row.path.includes('/libtv-cli/operations/reserve')),false);
});

test('changed price, source or expired approval cannot create an API task',async t=>{
 const f=await fixture(t),review=await prepare(f);f.state.price=1200;
 await assert.rejects(run(f,review.approvalToken),{code:'company_cli_approval_stale'});f.state.price=1000;
 f.node.data.url=['https://media.example/changed.mp4'];await assert.rejects(run(f,review.approvalToken),{code:'company_postproduction_source_changed'});f.node.data.url=[f.nativeSource.origin.result_url];
 const fresh=await prepare(f);f.advance(60001);await assert.rejects(run(f,fresh.approvalToken),{code:'company_cli_user_approval_required'});assert.equal(f.calls.create,0);
});

test('zero quotes and requests beyond the remaining company allowance never provide spending authority',async t=>{
 const f=await fixture(t);f.state.zeroPrice=true;await assert.rejects(prepare(f),{code:'company_libtv_subtitles_unknown_price'});f.state.zeroPrice=false;f.state.price=3000;
 const quote=await prepare(f);assert.equal(quote.quote.withinLimit,false);assert.equal(quote.approvalToken,undefined);assert.equal(f.calls.create,0);assert.equal(f.store.readBudget(actor,{companyId:'company'}).reservedMinor,7100);
});

test('uncertain API submission retains its reservation and never repeats create',async t=>{
 const f=await fixture(t);f.state.createError=true;const review=await prepare(f),result=await run(f,review.approvalToken);assert.equal(result.operation.state,'unknown');assert.equal(result.operation.taskId,undefined);
 await run(f,review.approvalToken);await f.call('GET','/postproduction/api-erase?companyId=company');assert.equal(f.calls.create,1);assert.equal(f.calls.progress,0);assert.equal(f.store.readBudget(actor,{companyId:'company'}).reservedMinor,8100);
});

test('foreign actors and source identities cannot use another member’s API job',async t=>{
 const f=await fixture(t),review=await prepare(f);await run(f,review.approvalToken);
 await assert.rejects(f.service.dispatch(other,{method:'GET',path:'/postproduction/api-erase?companyId=company'}),{code:'company_postproduction_not_found'});
 await assert.rejects(f.call('POST','/postproduction',{...f.input,sourceGenerationId:99,approvalToken:review.approvalToken}),{code:'company_postproduction_operation_conflict'});
 f.accounts.set(actor.id,{...actor,disabled:true});await assert.rejects(f.call('GET','/postproduction/api-erase?companyId=company'),{code:'company_cli_unauthenticated'});
});

test('the real API adapter preserves its private prepared quote through company approval and import',async t=>{
 const f=await fixture(t,{realProvider:true}),review=await prepare(f);assert.equal(f.calls.create,0);
 await run(f,review.approvalToken);assert.equal(f.calls.create,1);f.state.terminal='completed';
 const result=await f.call('GET','/postproduction/api-erase?companyId=company');assert.equal(result.operation.state,'completed');
 const imported=await f.call('POST','/postproduction/api-erase/import',{companyId:'company'});assert.equal(imported.source_generation_id,3);
 const saved=f.store.findJob(actor,{companyId:'company',operationId:'api-erase'});assert.equal(JSON.stringify(saved).includes('local-private-token'),false);
});

test('API-derived sources remain eligible without pretending to have an original CLI node',async t=>{
 const f=await fixture(t,{realProvider:true});f.nativeSource.origin.provider='libtv-api';f.nativeSource.origin.node_id=null;
 const reviewed=await prepare(f);await run(f,reviewed.approvalToken);f.state.terminal='completed';
 const result=await f.call('GET','/postproduction/api-erase?companyId=company');assert.equal(result.operation.sourceKind,'libtv-api');
 assert.equal(result.operation.projectUuid,null);assert.equal(result.operation.nodeId,null);assert.equal(result.operation.nodeSha256,null);
});

test('verified zero quotes still require human authority and preserve a paid intent with zero allowances',async t=>{
 const f=await fixture(t,{realProvider:true,limit:0,opening:0});f.state.price=0;f.state.verifiedZero=true;
 await assert.rejects(run(f),{code:'company_cli_user_approval_required'});assert.equal(f.calls.create,0);
 const zero=await prepare(f);assert.equal(zero.quote.price.zeroQuote,true);assert.equal(zero.quote.reservedMinor,0);assert.equal(typeof zero.approvalToken,'string');
 f.state.price=100;await assert.rejects(run(f,zero.approvalToken),{code:'company_cli_approval_stale'});assert.equal(f.calls.create,0);
 f.state.price=0;const fresh=await prepare(f);await run(f,fresh.approvalToken);assert.equal(f.calls.create,1);
 const job=f.store.findJob(actor,{companyId:'company',operationId:'api-erase'});assert.equal(job.paid,true);assert.equal(job.reservedMinor,0);assert.equal(job.price.zeroQuote,true);
 f.state.terminal='completed';await f.call('GET','/postproduction/api-erase?companyId=company');await f.call('POST','/postproduction/api-erase/import',{companyId:'company'});
 const imported=f.calls.native.find(request=>request.path.endsWith('/internal/imports'));assert.equal(imported.body.quote.zeroQuote,true);assert.equal(imported.body.quote.reserved_minor,0);
 assert.deepEqual(imported.body.quote.response,{power:0,originalPrice:0,taskWeight:0,type:0,discountRatio:1});
});

test('failed native imports retain the task and result in history and retry only the same free import',async t=>{
 const f=await fixture(t),review=await prepare(f);await run(f,review.approvalToken);f.state.terminal='completed';await f.call('GET','/postproduction/api-erase?companyId=company');
 f.state.importFailure=true;await assert.rejects(f.call('POST','/postproduction/api-erase/import',{companyId:'company'}),{code:'libtv_postproduction_media_changed'});
 const failed=await f.call('GET','/postproduction/api-erase?companyId=company');assert.equal(failed.operation.importError.errorCode,'libtv_postproduction_media_changed');assert.equal(failed.operation.importError.taskId,'provider-task');assert.equal(failed.operation.importError.resultUrl,'https://media.example/result.mp4');
 assert.ok(f.store.audit(actor,'company').some(row=>row.event==='provider-import-failed'));
 f.state.importFailure=false;await f.call('POST','/postproduction/api-erase/import',{companyId:'company'});assert.equal(f.calls.create,1);
 const requests=f.calls.native.filter(row=>row.path.endsWith('/internal/imports'));assert.equal(requests.length,2);assert.equal(requests[0].body.operation_id,requests[1].body.operation_id);
 const recovered=await f.call('GET','/postproduction/api-erase?companyId=company');assert.equal(recovered.operation.importError,undefined);assert.equal(recovered.operation.nativeImport.generation_id,4);
});

test('an unexpected actual charge retains the output, conservatively covers cost and blocks more paid work',async t=>{
 const f=await fixture(t,{realProvider:true,limit:0,opening:0});f.state.price=0;f.state.verifiedZero=true;
 const review=await prepare(f);await run(f,review.approvalToken);f.state.terminal='completed';f.state.price=500;
 const result=await f.call('GET','/postproduction/api-erase?companyId=company');assert.equal(result.operation.state,'completed');
 assert.equal(result.operation.billing.observedChargedMinor,500);assert.equal(result.operation.billing.quotedMinor,0);assert.equal(result.operation.billing.requiresReview,true);
 assert.equal(f.store.readBudget(actor,{companyId:'company'}).reservedMinor,500);assert.equal(f.store.readBudget(actor,{companyId:'company',scope:'member',targetId:actor.id}).reservedMinor,500);assert.equal(f.store.readBudget(actor,{companyId:'company',scope:'project',targetId:'project'}).reservedMinor,500);
 const imported=await f.call('POST','/postproduction/api-erase/import',{companyId:'company'});assert.equal(imported.generation_id,4);
 f.input.operationId='another-api-erase';await assert.rejects(prepare(f),{code:'company_cli_billing_review_required'});assert.equal(f.calls.create,1);
});

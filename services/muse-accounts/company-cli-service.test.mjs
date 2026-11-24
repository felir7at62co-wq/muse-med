import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createRequire} from 'node:module';
import {DatabaseSync} from 'node:sqlite';
import {setTimeout as delay} from 'node:timers/promises';
import {openCompanyCliStore} from './company-cli-store.mjs';
import {createCompanyCliService,loadCompanyCliService} from './company-cli-service.mjs';
import {createCompanyCliPricing} from './company-cli-pricing.mjs';
import {companyCliDigest as digest} from './company-cli-executor.mjs';

const alice={id:'aaaaaaaaaaaaaaaa'},bob={id:'bbbbbbbbbbbbbbbb'},eve={id:'eeeeeeeeeeeeeeee'};
const owner={user_uuid:'test-user',account_id:'test-account',team_id:null};
const node={nodeKey:'node-a',status:0,data:{type:'image',params:{model:'Model',count:1,prompt:'A bird'}}};
const metadata={modelKey:'model-a',modelName:'Model',schema:{properties:{count:{enum:[1]}}}};
const discovery={matches:[{modelKey:'model-a',modelName:'Model'}]};
function deferred(){let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};}
test('explicit download chunks must fit the configured encoded output budget before starting services',async t=>{
 const root=await mkdtemp(join(tmpdir(),'muse-company-config-')),file=join(root,'private.json');
 t.after(()=>rm(root,{recursive:true,force:true}));
 await writeFile(file,JSON.stringify({maxOutputBytes:8192,maxLedgerRecordBytes:32768,downloadChunkBytes:4096}),{mode:0o600});
 await assert.rejects(loadCompanyCliService(file,{accounts:{get(){throw new Error('unreachable');}},studioRuntime:{},publicOrigin:'https://muse.example'}),{code:'company_cli_invalid_configuration'});
});
async function setup(t,{budget=1000,nativeFailure,nativeBridge,onNative,testNode=node,testSchema=metadata,clock=Date.now,pricing,advancedKind='video_final',nativeMinor=600}={}){
 const root=await mkdtemp(join(tmpdir(),'muse-company-service-'));
 const store=await openCompanyCliStore({file:join(root,'company.sqlite'),accountById:id=>[alice.id,bob.id,eve.id].includes(id)?{id,disabled:false}:null,maxParallel:4,now:clock});
 store.bootstrapCompany({id:'company-a',name:'Test company',ownerId:alice.id});
 store.setMember(alice,{companyId:'company-a',userId:bob.id,role:'member',active:true,expectedRevision:0});
 store.setConnection(alice,{id:'test-cli',companyId:'company-a',label:'Test',environment:'test',owner,maxParallel:4,active:true,expectedRevision:0});
 function limit(actor,scope,targetId,limitMinor){const proposal=store.prepareBudgetChange(actor,{companyId:'company-a',scope,targetId,limitMinor});store.confirmBudgetChange(actor,{proposalId:proposal.proposal.id,approvalNonce:proposal.approvalNonce,approved:true});}
 limit(alice,'company','company-a',budget);limit(alice,'member',alice.id,budget);limit(bob,'member',bob.id,budget);
 const projects={};for(const actor of [alice,bob]){const p=store.createProject(actor,{companyId:'company-a',id:'project-'+actor.id[0],name:'Private',tenantAccountId:actor.id,nativeProjectId:1,nativeDatabaseId:'db-'+actor.id[0]});store.bindCanvas(actor,{projectId:p.id,canvasUuid:'canvas-'+actor.id[0],connectionId:'test-cli',expectedRevision:p.revision});limit(actor,'project',p.id,budget);projects[actor.id]=store.getProject(actor,p.id);}
 store.setPrice(alice,{companyId:'company-a',connectionId:'test-cli',service:'image',model:'model-a',unitMinor:600,source:'operator-entered',expiresAt:'2099-01-01T00:00:00.000Z',expectedRevision:0});
 store.setPrice(alice,{companyId:'company-a',connectionId:'test-cli',service:'agent-task',model:'advanced:video_final',unitMinor:600,source:'operator-entered',expiresAt:'2099-01-01T00:00:00.000Z',expectedRevision:0});
 const gate=deferred(),started=deferred(),both=deferred();let count=0,executorClosed=false;const calls=[],nativeCalls=[];
 const executor={async prepare(command,binding){const inputCapture=binding.advancedPlan??binding.generation;return {...command,requestSha256:digest({command,companyId:binding.companyId,projectId:binding.projectId,connectionId:binding.connectionId,connectionRevision:binding.connectionRevision,owner:binding.owner,inputCapture,uploadSha:null}),resourceKey:binding.canvasUuid+':'+command.body.node_id,paid:['node_run','video_final','video_hd'].includes(command.method),service:binding.advancedPlan?'agent-task':'image',model:binding.advancedPlan?'advanced:'+command.method:'model-a',quantity:1,inputCapture};},async execute(prepared){if(executorClosed)throw Object.assign(new Error('executor closed'),{code:'company_cli_executor_closed'});calls.push(prepared);let value;if(['node_run','video_final','video_hd'].includes(prepared.method)){count++;started.resolve();if(count===2)both.resolve();await gate.promise;value={...testNode,status:2,url:['https://example.com/a.png']};}else if(prepared.method==='node_read')value=testNode;else if(prepared.method==='model_schema')value=testSchema;else if(prepared.method==='model_search')value=discovery;else if(prepared.method==='video_hd_models')value=hdModels;else if(prepared.method==='project_read')value={edges:[],nodes:[{id:'node-a'}]};else value={ok:true};return {exit_code:0,records:[value],state:'completed'};},async close(){executorClosed=true;gate.resolve();}};
 const nativeRequest=async(accountId,request)=>{nativeCalls.push({accountId,...request});await onNative?.(request);if(nativeBridge)return nativeBridge(accountId,request);if(request.path.endsWith('/reserve')){if(nativeFailure)throw Object.assign(new Error('native refusal'),nativeFailure);return {dispatch_allowed:true};}if(request.path.endsWith('/catalog'))return {database_id:'budget-db',items:[['image','model-a'],['agent-task','advanced:'+advancedKind]].map(([service,model])=>({active:true,currency:'LTV',provider:'libtv-cli',service,model,origin:'https://api.liblib.tv',reserve_minor:nativeMinor}))};if(request.path.includes('/budget/projects/'))return {database_id:'budget-db',reserved_minor:0,settled_minor:0,limit_minor:2000,currency:'LTV',allow_estimates:true,allow_task_envelopes:true,revision:1};if(request.path.endsWith('/budget/quote'))return {reserved_minor:nativeMinor,currency:'LTV',within_limit:true};return {};};
 const service=createCompanyCliService({store,executor,pricing,nativeRequest,connections:[{id:'test-cli',companyId:'company-a',credentialsDir:root,workspaceId:0,teamId:0}],publicOrigin:'https://muse.example',stageRoot:root,now:clock,chargeApprovalTtlMs:1000});
 t.after(async()=>{await service.close();await rm(root,{recursive:true,force:true});});
 const input=actor=>{const p=projects[actor.id],references={edges:[],nodes:[]};return {operationId:'test-operation-'+actor.id[0],nativeProjectId:1,databaseId:p.nativeDatabaseId,request:{database_id:p.nativeDatabaseId,project_id:1,project_uuid:p.canvasUuid,node_id:'node-a',cli_owner:owner,model_key:'model-a',model_name:'Model',schema_sha256:digest(metadata),node_sha256:digest(node),references_sha256:digest(references),prompt:'A bird'},inputCapture:{protocol:'libtv-cli-input-v1',node,node_sha256:digest(node),node_type:'image',generation_count:1,model:metadata,model_schema_sha256:digest(metadata),model_execution_name:'Model',model_discovery:discovery,model_discovery_sha256:digest(discovery),references,references_sha256:digest(references)}};};
 return {store,service,calls,nativeCalls,input,gate,started,both,projects,limit,advancedKind,testNode,root};
}
const videoNode={nodeKey:'node-a',status:2,data:{type:'video',params:{model:'Video',prompt:'A bird'}}};
const hdModels={models:[{modelKey:'volcano-video-upscaler',modelName:'HuoShan'}]};
function advancedInput(f,actor=alice){
 const kind=f.advancedKind??'video_final',p=f.projects[actor.id],spec={kind,project_uuid:p.canvasUuid,node_id:'node-a',...kind==='video_hd'?{model_name:'HuoShan'}:{}};
 const capturedNode=f.testNode??videoNode,snapshot={project:{edges:[],nodes:[{id:'node-a'}]},nodes:[capturedNode]};
 const selected=kind==='video_hd'?hdModels:null;
 const capture={protocol:'libtv-cli-advanced-input-v1',command_kind:kind,spec,snapshot,snapshot_sha256:digest(snapshot),node:capturedNode,node_sha256:digest(capturedNode),metadata:selected,metadata_sha256:digest(selected),budget_model:'advanced:'+kind,service:'agent-task',quantity:1};
 return {kind:'advanced',operationId:'advanced-operation-'+actor.id[0],nativeProjectId:1,databaseId:p.nativeDatabaseId,request:{cli_owner:owner,spec,plan_sha256:digest(capture),database_id:p.nativeDatabaseId,project_id:1,accept_task_envelope:true},inputCapture:capture};
}
const preview=(service,actor,body)=>service.dispatch(actor,{method:'POST',path:'/generations/prepare',body});
const generate=(service,actor,body)=>service.dispatch(actor,{method:'POST',path:'/generations',body});

async function downloadFixture(t,{afterDownload,downloadFailure,kind='video'}={}){
 const root=await mkdtemp(join(tmpdir(),'muse-company-download-service-')),file=join(root,'company.sqlite'),accounts=new Map([alice,bob].map(actor=>[actor.id,{...actor,disabled:false}]));
 const store=await openCompanyCliStore({file,accountById:id=>accounts.get(id),maxParallel:4});
 store.bootstrapCompany({id:'company-a',name:'Test company',ownerId:alice.id});store.setMember(alice,{companyId:'company-a',userId:bob.id,role:'member',active:true,expectedRevision:0});
 store.setConnection(alice,{id:'test-cli',companyId:'company-a',label:'Test',environment:'test',owner,maxParallel:4,active:true,expectedRevision:0});
 const project=store.createProject(alice,{id:'download-project',companyId:'company-a',name:'Original video',tenantAccountId:alice.id,nativeProjectId:1,nativeDatabaseId:'db-a'});
 store.bindCanvas(alice,{projectId:project.id,canvasUuid:'canvas-a',connectionId:'test-cli',expectedRevision:project.revision});
 const source={nodeKey:'node-a',data:{type:kind,url:['https://example.com/source.mp4'],taskInfo:{status:2}}},calls=[];
 const bytes=Buffer.concat([Buffer.from([0,0,0,24]),Buffer.from('ftypisom'),Buffer.alloc(16),Buffer.from('fixture media bytes')]);let closed=false;
 const executor={async prepare(command,binding){assert.deepEqual(binding.owner,owner);return {command,binding};},async execute(prepared){
  if(closed)throw Object.assign(new Error('closed'),{code:'company_cli_executor_closed'});
  const {command}=prepared;calls.push(command);
  if(command.method==='node_read')return {exit_code:0,state:'completed',records:[structuredClone(source)]};
  assert.equal(command.method,'download');
  if(downloadFailure)return {exit_code:1,state:'failed',records:[],error_code:downloadFailure};
  const local=join(command.body.directory,'private-server-original-title.'+(kind==='audio'?'wav':'mp4'));await writeFile(local,bytes);await afterDownload?.(source);
  return {exit_code:0,state:'completed',records:[{local_file:local}]};
 },async close(){closed=true;}};
 const options={executor,nativeRequest:async()=>{throw new Error('A free download must not call native budgets');},connections:[{id:'test-cli',companyId:'company-a',credentialsDir:root,workspaceId:0,teamId:0}],publicOrigin:'https://muse.example',stageRoot:root};
 const service=createCompanyCliService({store,...options});
 t.after(async()=>{await service.close();await rm(root,{recursive:true,force:true});});
 const input={companyId:'company-a',operationId:'download-original',projectUuid:'canvas-a',nodeId:'node-a',snapshotSha256:digest(source),watermark:true};
 return {store,service,source,calls,bytes,root,file,accounts,options,input};
}
const startDownload=(fixture,body=fixture.input,actor=alice)=>fixture.service.dispatch(actor,{method:'POST',path:'/downloads',body});
const readDownload=(fixture,operation=fixture.input.operationId,actor=alice)=>fixture.service.dispatch(actor,{method:'GET',path:'/downloads/'+operation+'?companyId=company-a'});
async function settledDownload(fixture,operation=fixture.input.operationId){
 const deadline=Date.now()+5000;for(;;){const value=await readDownload(fixture,operation);if(value.state!=='pending')return value;if(Date.now()>deadline)throw new Error('Local download did not settle');await delay(5);}
}

test('company downloads persist a path-free manifest and verified chunks without changing credits',async t=>{
 const f=await downloadFixture(t),initial=f.store.readBudget(alice,{companyId:'company-a'});
 const [first,second]=await Promise.all([startDownload(f),startDownload(f)]);assert.equal(first.operationId,second.operationId);
 const manifest=await settledDownload(f);assert.equal(manifest.state,'completed',JSON.stringify(manifest));assert.equal(manifest.files.length,1);
 assert.equal(f.calls.filter(call=>call.method==='download').length,1);assert.deepEqual(f.store.readBudget(alice,{companyId:'company-a'}),initial);
 const file=manifest.files[0],chunks=[];
 for(let index=0;index<file.chunkCount;index++){
  const chunk=await f.service.dispatch(alice,{method:'GET',path:'/downloads/download-original/files/'+file.fileId+'/chunks/'+index+'?companyId=company-a'});
  assert.equal(chunk.fileId,file.fileId);const bytes=Buffer.from(chunk.data_base64,'base64');assert.equal(chunk.bytes,bytes.length);chunks.push(bytes);
 }
 assert.deepEqual(Buffer.concat(chunks),f.bytes);
 assert.equal(JSON.stringify(manifest).includes(f.root),false);assert.equal(JSON.stringify(manifest).includes('private-server-original-title'),false);
 const job=f.store.findJob(alice,{companyId:'company-a',operationId:f.input.operationId});assert.equal(JSON.stringify(job.result).includes(f.root),false);
 const generic=await f.service.dispatch(alice,{method:'GET',path:'/generations/download-original?companyId=company-a'});assert.equal(JSON.stringify(generic).includes(f.root),false);
 await startDownload(f);assert.equal(f.calls.filter(call=>call.method==='download').length,1);
});

test('downloads reject changed inputs, foreign actors and raw command bypasses',async t=>{
 const f=await downloadFixture(t);
 await assert.rejects(startDownload(f,{...f.input,snapshotSha256:'0'.repeat(64)}),{code:'company_cli_download_source_changed'});
 await startDownload(f);await settledDownload(f);
 await assert.rejects(startDownload(f,{...f.input,watermark:false}),{code:'company_cli_operation_conflict'});
 await assert.rejects(readDownload(f,f.input.operationId,bob),{code:'company_cli_download_not_found'});
 const manifest=await readDownload(f),chunkPath='/downloads/download-original/files/'+manifest.files[0].fileId+'/chunks/0?companyId=company-a';
 await assert.rejects(f.service.dispatch(bob,{method:'GET',path:chunkPath}),{code:'company_cli_download_not_found'});
 await assert.rejects(f.service.dispatch(alice,{method:'GET',path:'/downloads/download-original/files/unknown/chunks/0?companyId=company-a'}),{code:'company_cli_download_not_found'});
 await assert.rejects(startDownload(f,{...f.input,operationId:'invalid-limit',maxBytes:0}),{code:'company_cli_invalid_download'});
 await assert.rejects(f.service.dispatch(alice,{method:'POST',path:'/command',body:{argv:['download','--project','canvas-a','--node','node-a','--out','ignored']}}),{code:'company_cli_use_download_endpoint'});
 f.accounts.set(alice.id,{...alice,disabled:true});await assert.rejects(readDownload(f),{code:'company_cli_unauthenticated'});
});

test('changed source and explicit CLI download errors remain terminal without automatic retry',async t=>{
 const changed=await downloadFixture(t,{afterDownload:source=>{source.data.url=['https://example.com/new.mp4'];}});
 await startDownload(changed);const stale=await settledDownload(changed);assert.equal(stale.state,'failed');assert.equal(stale.error_code,'company_cli_download_source_changed');assert.deepEqual(stale.files,[]);
 await startDownload(changed);assert.equal(changed.calls.filter(call=>call.method==='download').length,1);
 const failed=await downloadFixture(t,{downloadFailure:'company_cli_download_watermark_required'});
 await startDownload(failed);const result=await settledDownload(failed);assert.equal(result.state,'failed');assert.equal(result.error_code,'company_cli_download_watermark_required');
 await startDownload(failed);assert.equal(failed.calls.filter(call=>call.method==='download').length,1);
});

test('client download limits clamp to the server ceiling and failed captures release their resource leases',async t=>{
 const f=await downloadFixture(t);
 await startDownload(f,{...f.input,maxBytes:1});const limited=await settledDownload(f);assert.equal(limited.state,'failed');assert.equal(limited.error_code,'company_cli_download_size_limit');
 assert.equal(f.store.listJobs(alice,{projectId:'download-project'}).some(job=>['reserved','running','unknown'].includes(job.state)),false);
 const next={...f.input,operationId:'download-larger-limit',maxBytes:268435456};await startDownload(f,next);assert.equal((await settledDownload(f,next.operationId)).state,'completed');
 assert.equal(f.store.findJob(alice,{companyId:'company-a',operationId:next.operationId}).inputCapture.downloadRequest.maxBytes,67108864);
 const audio=await downloadFixture(t,{kind:'audio'});await startDownload(audio);const sound=await settledDownload(audio);assert.equal(sound.state,'completed');assert.match(sound.files[0].name,/\.wav$/u);
});

test('completed downloads remain available after reopening with a different supplier connection',async t=>{
 const f=await downloadFixture(t);await startDownload(f);const manifest=await settledDownload(f);await f.service.close();
 const store=await openCompanyCliStore({file:f.file,accountById:id=>f.accounts.get(id),maxParallel:4});
 store.setConnection(alice,{id:'test-cli',companyId:'company-a',label:'Replacement',environment:'test',owner:{...owner,account_id:'replacement'},maxParallel:4,active:true,expectedRevision:1});
 const service=createCompanyCliService({store,...f.options});
 try{
  const restored=await service.dispatch(alice,{method:'GET',path:'/downloads/download-original?companyId=company-a'});assert.deepEqual(restored,manifest);
  const chunk=await service.dispatch(alice,{method:'GET',path:'/downloads/download-original/files/'+manifest.files[0].fileId+'/chunks/0?companyId=company-a'});assert.ok(chunk.bytes>0);
 }finally{await service.close();}
});

async function registrationFixture(t,{remoteId='existing-canvas',nativeId=3,readFailure,onNative}={}){
 const root=await mkdtemp(join(tmpdir(),'muse-company-registration-')),accounts=new Map([alice,bob,eve].map(actor=>[actor.id,{...actor,disabled:false}]));
 const store=await openCompanyCliStore({file:join(root,'company.sqlite'),accountById:id=>accounts.get(id),maxParallel:2});
 store.bootstrapCompany({id:'company-a',name:'Test company',ownerId:alice.id});
 store.setMember(alice,{companyId:'company-a',userId:bob.id,role:'member',active:true,expectedRevision:0});
 store.setMember(alice,{companyId:'company-a',userId:eve.id,role:'viewer',active:true,expectedRevision:0});
 store.setConnection(alice,{id:'test-cli',companyId:'company-a',label:'Test',environment:'test',owner,maxParallel:2,active:true,expectedRevision:0});
 const nativeCalls=[],cliCalls=[];
 const nativeRequest=async(accountId,request)=>{nativeCalls.push({accountId,...request});await onNative?.(request,accounts);assert.equal(request.method,'GET');if(request.path.startsWith('/api/v1/dramas/'))return {id:nativeId,title:'Existing script'};if(request.path==='/api/v1/muse/libtv-cli/capabilities')return {database_id:'db-'+accountId[0]};throw new Error('Unexpected native registration request');};
 const executor={async prepare(command,binding){assert.equal(command.method,'project_read');assert.equal(command.body.project_uuid,binding.canvasUuid);assert.deepEqual(binding.owner,owner);return {command,binding};},async execute(value){cliCalls.push(value);if(readFailure)throw Object.assign(new Error(readFailure),{code:readFailure,status:409});return {exit_code:0,state:'completed',records:[{projectUuid:remoteId,name:'Existing project',nodes:[],edges:[]}]};},async close(){}};
 const service=createCompanyCliService({store,executor,nativeRequest,connections:[{id:'test-cli',companyId:'company-a',credentialsDir:root,workspaceId:0,teamId:0}],publicOrigin:'https://muse.example',stageRoot:root});
 t.after(async()=>{await service.close();await rm(root,{recursive:true,force:true});});
 return {store,service,accounts,nativeCalls,cliCalls};
}
const registerProject=(fixture,actor=alice,body={})=>fixture.service.dispatch(actor,{method:'POST',path:'/projects/register',body:{companyId:'company-a',nativeProjectId:3,canvasUuid:'existing-canvas',...body}});

test('an existing canvas binds to its native owner without creating supplier data or spending',async t=>{
 const f=await registrationFixture(t),before=f.store.readBudget(alice,{companyId:'company-a'}),first=await registerProject(f);
 assert.equal(first.registered,true);assert.equal(first.replayed,false);
 assert.equal(first.project.nativeProjectId,3);assert.equal(first.project.nativeDatabaseId,'db-a');assert.equal(first.project.tenantAccountId,alice.id);
 assert.equal(first.project.canvasUuid,'existing-canvas');assert.equal(first.project.connectionId,'test-cli');assert.deepEqual(first.project.connectionOwner,owner);
 assert.deepEqual(f.store.readBudget(alice,{companyId:'company-a'}),before);
 assert.equal(f.store.listJobs(alice,{projectId:first.project.id}).length,0);
 const replay=await registerProject(f);assert.equal(replay.replayed,true);assert.equal(replay.project.id,first.project.id);assert.equal(f.cliCalls.length,2);
 assert.ok(f.cliCalls.every(call=>call.command.method==='project_read'));assert.ok(f.nativeCalls.every(call=>call.method==='GET'));
});

test('registration refuses viewers, disabled accounts and forged company selection before reading the supplier',async t=>{
 const f=await registrationFixture(t);
 await assert.rejects(registerProject(f,eve),{code:'company_cli_project_read_only'});
 f.accounts.set(bob.id,{id:bob.id,disabled:true});await assert.rejects(registerProject(f,bob),{code:'company_cli_unauthenticated'});
 await assert.rejects(registerProject(f,alice,{companyId:'other-company'}),{code:'company_cli_forbidden'});
 assert.equal(f.cliCalls.length,0);assert.equal(f.nativeCalls.length,0);
});

test('registration rejects a different remote canvas or failed supplier owner proof without creating a project',async t=>{
 const different=await registrationFixture(t,{remoteId:'other-canvas'});
 await assert.rejects(registerProject(different),{code:'company_cli_canvas_identity_mismatch'});
 assert.equal(different.store.context(alice).companies[0].projects.length,0);
 const changed=await registrationFixture(t,{readFailure:'company_cli_account_changed'});
 await assert.rejects(registerProject(changed),{code:'company_cli_account_changed'});
 assert.equal(changed.store.context(alice).companies[0].projects.length,0);
});

test('registration refuses a wrong native project response and permissions revoked during verification',async t=>{
 const different=await registrationFixture(t,{nativeId:4});
 await assert.rejects(registerProject(different),{code:'company_cli_native_project_not_found'});assert.equal(different.cliCalls.length,0);
 const revoked=await registrationFixture(t,{onNative:(_request,accounts)=>accounts.set(alice.id,{id:alice.id,disabled:true})});
 await assert.rejects(registerProject(revoked),{code:'company_cli_unauthenticated'});
 assert.equal(revoked.store.context(bob).companies[0].projects.length,0);
});

test('registration does not rebind a native project or share a canvas with another native project',async t=>{
 const f=await registrationFixture(t),first=await registerProject(f);
 await assert.rejects(registerProject(f,alice,{canvasUuid:'other-canvas'}));
 await assert.rejects(registerProject(f,bob),{code:'company_cli_canvas_already_bound'});
 assert.equal(f.store.context(alice).companies[0].projects.length,1);
 assert.equal(f.store.getProject(alice,first.project.id).canvasUuid,'existing-canvas');
});

test('concurrent repeated registration creates one binding and rejects unsupported operation identifiers',async t=>{
 const f=await registrationFixture(t);
 const [one,two]=await Promise.all([registerProject(f),registerProject(f)]);
 assert.equal(one.project.id,two.project.id);assert.equal([one,two].filter(value=>value.replayed).length,1);
 assert.equal(f.store.context(alice).companies[0].projects.length,1);
 await assert.rejects(registerProject(f,alice,{operationId:'not-a-supported-field'}),{code:'company_cli_invalid_request'});
});

test('ordinary members register their own native project with zero allowance',async t=>{
 const f=await registrationFixture(t),result=await registerProject(f,bob);
 assert.equal(result.project.tenantAccountId,bob.id);assert.equal(result.project.nativeDatabaseId,'db-b');
 assert.equal(f.store.readBudget(bob,{companyId:'company-a',scope:'project',targetId:result.project.id}).limitMinor,0);
 assert.ok(f.nativeCalls.every(call=>call.accountId===bob.id));
});
test('two employees run concurrently, retain frozen inputs, and recover without another charge',async t=>{
 const f=await setup(t,{budget:2000});const one=await generate(f.service,alice,f.input(alice)),two=await generate(f.service,bob,f.input(bob));await f.both.promise;
 assert.notEqual(one.data.job_id,two.data.job_id);assert.equal(f.calls.filter(c=>c.method==='node_run').length,2);
 assert.deepEqual(f.nativeCalls.filter(c=>c.path.endsWith('/reserve')).map(c=>c.accountId),[alice.id,bob.id]);
 const replay=await generate(f.service,alice,f.input(alice));assert.equal(replay.data.job_id,one.data.job_id);assert.equal(f.calls.filter(c=>c.method==='node_run').length,2);
 f.gate.resolve();await f.service.close();
});
test('global budget wins over each member and project limit during concurrent admissions',async t=>{
 const f=await setup(t);await generate(f.service,alice,f.input(alice));await f.started.promise;
 await assert.rejects(generate(f.service,bob,f.input(bob)),{code:'company_cli_budget_exceeded'});
 assert.equal(f.calls.filter(c=>c.method==='node_run').length,1);assert.equal(f.nativeCalls.filter(c=>c.path.endsWith('/reserve')).length,1);f.gate.resolve();
});
test('unregistered accounts and cross-project spoofing cannot read or submit',async t=>{
 const f=await setup(t);
 assert.deepEqual(await f.service.dispatch(eve,{method:'GET',path:'/context'}),{companies:[]});
 const forged=f.input(alice);forged.request.project_uuid=f.projects[bob.id].canvasUuid;
 await assert.rejects(generate(f.service,alice,forged),{code:'company_cli_generation_scope_mismatch'});
 assert.equal(f.nativeCalls.length,0);assert.equal(f.calls.length,0);
});
test('changed live node refuses generation before either ledger reserves',async t=>{
 const f=await setup(t),input=f.input(alice);input.inputCapture.node_sha256='a'.repeat(64);
 await assert.rejects(generate(f.service,alice,input),{code:'company_cli_generation_inputs_changed'});
 assert.equal(f.nativeCalls.length,0);assert.equal(f.calls.filter(c=>c.method==='node_run').length,0);
 assert.equal(f.store.readBudget(alice,{companyId:'company-a'}).reservedMinor,0);
});
test('native admission refusal releases only the undispatched global reservation',async t=>{
 const f=await setup(t,{nativeFailure:{status:402,code:'native_budget_exceeded'}});
 await assert.rejects(generate(f.service,alice,f.input(alice)),{code:'native_budget_exceeded'});
 assert.equal(f.store.readBudget(alice,{companyId:'company-a'}).reservedMinor,0);
 assert.equal(f.calls.filter(c=>c.method==='node_run').length,0);
});
test('uncertain native admission retains the reservation and never resubmits',async t=>{
 const f=await setup(t,{nativeFailure:{code:'network'}});
 await assert.rejects(generate(f.service,alice,f.input(alice)),{code:'network'});
 assert.equal(f.store.readBudget(alice,{companyId:'company-a'}).reservedMinor,600);
 const replay=await generate(f.service,alice,f.input(alice));assert.equal(replay.request_status,'unknown');assert.equal(f.nativeCalls.filter(c=>c.path.endsWith('/reserve')).length,1);
});
test('raw command route cannot bypass generation budget admission',async t=>{
 const f=await setup(t);
 await assert.rejects(f.service.dispatch(alice,{method:'POST',path:'/command',body:{argv:['node','node-a','--project','canvas-a','--run']}}),{code:'company_cli_use_generation_admission'});
 assert.equal(f.calls.length,0);assert.equal(f.nativeCalls.length,0);
});
test('advanced generation requires a private approval and previews without any admission',async t=>{
 const f=await setup(t,{testNode:videoNode}),input=advancedInput(f);
 await assert.rejects(generate(f.service,alice,input),{code:'company_cli_user_approval_required'});
 const review=await preview(f.service,alice,input);
 assert.equal(review.quote.reservedMinor,600);assert.equal(typeof review.approvalToken,'string');
 assert.equal(f.store.listJobs(alice,{projectId:f.projects[alice.id].id}).length,0);
 assert.equal(f.nativeCalls.length,0);assert.equal(f.calls.filter(c=>c.method==='video_final').length,0);
 const accepted=await generate(f.service,alice,{...input,approvalToken:review.approvalToken});await f.started.promise;
 assert.equal(accepted.request.path,'/cli/advanced');assert.deepEqual(accepted.before,input.inputCapture);
 const held=f.store.findJob(alice,{companyId:'company-a',operationId:input.operationId});
 assert.equal(held.inputCapture.chargeApproval.actorId,alice.id);assert.equal(JSON.stringify(held).includes(review.approvalToken),false);
 await generate(f.service,alice,{...input,approvalToken:review.approvalToken});assert.equal(f.calls.filter(c=>c.method==='video_final').length,1);f.gate.resolve();
});
test('expired approvals and approvals from another actor never dispatch',async t=>{
 let now=1000;const f=await setup(t,{testNode:videoNode,clock:()=>now}),input=advancedInput(f),review=await preview(f.service,alice,input);
 await assert.rejects(generate(f.service,bob,{...advancedInput(f,bob),approvalToken:review.approvalToken}),{code:'company_cli_user_approval_required'});
 now=2001;await assert.rejects(generate(f.service,alice,{...input,approvalToken:review.approvalToken}),{code:'company_cli_user_approval_required'});
 assert.equal(f.nativeCalls.length,0);
});
test('a changed price or budget invalidates an unanswered advanced review',async t=>{
 const f=await setup(t,{testNode:videoNode}),input=advancedInput(f),review=await preview(f.service,alice,input);
 f.limit(alice,'project',f.projects[alice.id].id,1100);
 await assert.rejects(generate(f.service,alice,{...input,approvalToken:review.approvalToken}),{code:'company_cli_approval_stale'});
 const current=await preview(f.service,alice,input);
 f.store.setPrice(alice,{companyId:'company-a',connectionId:'test-cli',service:'agent-task',model:'advanced:video_final',unitMinor:700,source:'operator-entered',expiresAt:'2099-01-01T00:00:00.000Z',expectedRevision:1});
 await assert.rejects(generate(f.service,alice,{...input,approvalToken:current.approvalToken}),{code:'company_cli_approval_stale'});
 assert.equal(f.nativeCalls.length,0);
});
test('insufficient budget produces a review without a spending proof',async t=>{
 const f=await setup(t,{budget:500,testNode:videoNode}),review=await preview(f.service,alice,advancedInput(f));
 assert.equal(review.quote.withinLimit,false);assert.equal(review.approvalToken,undefined);assert.equal(f.nativeCalls.length,0);
});

function hdPricing(clock){
 const state={minor:200,ttl:500,version:1,calls:0,error:null};
 const pricing={async resolve({prepared,binding,read,signal}){
  state.calls++;assert.equal(signal.aborted,false);await read('model_schema',{model_key:'volcano-video-upscaler'});
  if(state.error)throw Object.assign(new Error(state.error),{code:state.error,status:503});
  return {protocol:'muse-company-cli-hd-quote-v1',source:'https://api.liblib.tv/api/task/generation/power/calculator',service:'agent-task',model:'volcano-video-upscaler',billingModel:prepared.model,quantity:1,currency:'LTV',priceMinor:state.minor,unitMinor:state.minor,reservedMinor:state.minor,requestSha256:prepared.requestSha256,nodeSha256:prepared.inputCapture.node_sha256,planSha256:digest(prepared.inputCapture),modelSchemaSha256:digest(metadata),connectionId:binding.connectionId,connectionRevision:binding.connectionRevision,owner:binding.owner,quotedAt:new Date(clock()).toISOString(),expiresAt:new Date(clock()+state.ttl).toISOString(),request:{requestId:'request-'+state.calls},response:{trace_id:'trace-'+state.calls},requestHash:digest(state.calls),responseHash:digest(state.calls+1),quoteIdentity:digest({minor:state.minor,version:state.version,requestSha256:prepared.requestSha256}),locked:false};
 }};return {pricing,state};
}

test('HD review accepts fresh matching prices despite changing quotation timestamps and tracing',async t=>{
 let now=Date.parse('2026-11-14T00:00:00.000Z');const quote=hdPricing(()=>now);
 const f=await setup(t,{testNode:videoNode,clock:()=>now,pricing:quote.pricing,advancedKind:'video_hd',nativeBridge:(_actor,request)=>{
  if(request.path.endsWith('/catalog'))return {database_id:'budget-db',items:[]};
  if(request.path.includes('/budget/projects/'))return {database_id:'budget-db',reserved_minor:0,settled_minor:0,limit_minor:2000,currency:'LTV',allow_estimates:true,allow_task_envelopes:true,revision:1};
  if(request.path.endsWith('/quote'))return {reserved_minor:200,currency:'LTV',within_limit:true};
  if(request.path.endsWith('/reserve'))return {dispatch_allowed:true};return {};
 }}),input=advancedInput(f);
 const review=await preview(f.service,alice,input);
 assert.equal(review.quote.reservedMinor,200);assert.equal(review.quote.price.apiModel,'volcano-video-upscaler');assert.equal(review.quote.price.locked,false);assert.equal(review.expiresAt,now+500);
 assert.equal(f.nativeCalls.length,0);assert.equal(f.calls.filter(call=>call.method==='video_hd').length,0);
 now+=50;await generate(f.service,alice,{...input,approvalToken:review.approvalToken});await f.started.promise;
 const job=f.store.findJob(alice,{companyId:'company-a',operationId:input.operationId});
 assert.equal(job.reservedMinor,200);assert.equal(job.model,'advanced:video_hd');assert.equal(job.price.apiModel,'volcano-video-upscaler');
 assert.equal(job.price.quotedAt,new Date(now).toISOString());assert.equal(job.price.response.trace_id,'trace-2');
 assert.equal(job.price.quoteIdentity,review.quote.price.quoteIdentity);assert.equal(quote.state.calls,2);
 await generate(f.service,alice,{...input,approvalToken:review.approvalToken});assert.equal(quote.state.calls,2);
 f.gate.resolve();
});

test('HD price changes and expired original quotations require another human review',async t=>{
 let now=Date.parse('2026-11-14T00:00:00.000Z');const quote=hdPricing(()=>now);
 const f=await setup(t,{testNode:videoNode,clock:()=>now,pricing:quote.pricing,advancedKind:'video_hd',nativeMinor:200}),input=advancedInput(f);
 const review=await preview(f.service,alice,input);quote.state.minor=300;
 await assert.rejects(generate(f.service,alice,{...input,approvalToken:review.approvalToken}),{code:'company_cli_approval_stale'});
 quote.state.minor=200;quote.state.version++;
 await assert.rejects(generate(f.service,alice,{...input,approvalToken:review.approvalToken}),{code:'company_cli_approval_stale'});
 const fresh=await preview(f.service,alice,input);now+=501;
 await assert.rejects(generate(f.service,alice,{...input,approvalToken:fresh.approvalToken}),{code:'company_cli_user_approval_required'});
 assert.equal(f.nativeCalls.length,0);assert.equal(f.store.listJobs(alice,{projectId:f.projects[alice.id].id}).length,0);
});

test('HD pricing failure cannot fall back to a configured generic amount',async t=>{
 const now=Date.parse('2026-11-14T00:00:00.000Z'),quote=hdPricing(()=>now);quote.state.error='company_cli_quote_unavailable';
 const f=await setup(t,{testNode:videoNode,clock:()=>now,pricing:quote.pricing,advancedKind:'video_hd'});
 f.store.setPrice(alice,{companyId:'company-a',connectionId:'test-cli',service:'agent-task',model:'advanced:video_hd',unitMinor:200,source:'old-generic-price',expiresAt:'2099-01-01T00:00:00.000Z',expectedRevision:0});
 await assert.rejects(preview(f.service,alice,advancedInput(f)),{code:'company_cli_quote_unavailable'});
 assert.equal(f.nativeCalls.length,0);assert.equal(f.store.listJobs(alice,{projectId:f.projects[alice.id].id}).length,0);
});

test('a conflicting native HD price refuses dispatch and releases only the company reservation',async t=>{
 const now=Date.parse('2026-11-14T00:00:00.000Z'),quote=hdPricing(()=>now);
 const f=await setup(t,{testNode:videoNode,clock:()=>now,pricing:quote.pricing,advancedKind:'video_hd',nativeMinor:2000}),input=advancedInput(f),review=await preview(f.service,alice,input);
 await assert.rejects(generate(f.service,alice,{...input,approvalToken:review.approvalToken}),{code:'company_cli_native_price_mismatch'});
 assert.equal(f.calls.filter(call=>call.method==='video_hd').length,0);assert.equal(f.nativeCalls.filter(call=>call.path.endsWith('/reserve')).length,0);
 assert.equal(f.store.readBudget(alice,{companyId:'company-a'}).reservedMinor,0);
 const job=f.store.findJob(alice,{companyId:'company-a',operationId:input.operationId});assert.equal(job.state,'cancelled');assert.equal(job.price.unitMinor,200);
});

test('an unrelated same-price native HD entry is never taken over',async t=>{
 const now=Date.now(),quote=hdPricing(()=>now);
 const f=await setup(t,{testNode:videoNode,clock:()=>now,pricing:quote.pricing,advancedKind:'video_hd',nativeMinor:200}),input=advancedInput(f),review=await preview(f.service,alice,input);
 await assert.rejects(generate(f.service,alice,{...input,approvalToken:review.approvalToken}),{code:'company_cli_native_price_locked'});
 assert.equal(f.nativeCalls.some(call=>call.method==='PUT'),false);assert.equal(f.calls.filter(call=>call.method==='video_hd').length,0);
});
test('shutdown waits for status persistence from an admission that finishes during shutdown',async t=>{
 const reserveStarted=deferred(),allowReserve=deferred(),statusStarted=deferred(),allowStatus=deferred();
 const f=await setup(t,{onNative:async request=>{
  if(request.path.endsWith('/reserve')){reserveStarted.resolve();await allowReserve.promise;}
  if(request.path.endsWith('/status')){assert.equal(request.body.state,'completed');statusStarted.resolve();await allowStatus.promise;}
 }});
 const generation=generate(f.service,alice,f.input(alice));await reserveStarted.promise;
 let closed=false;const closing=f.service.close().then(()=>{closed=true;});
 allowReserve.resolve();await generation;await statusStarted.promise;await Promise.resolve();
 assert.equal(closed,false);allowStatus.resolve();await closing;
 assert.equal(closed,true);assert.equal(f.calls.filter(call=>call.method==='node_run').length,1);
});
function nativeBudget(t){
 const budget=createRequire(import.meta.url)('../../integrations/localminidrama/extensions/muse-budget.cjs');
 const db=new DatabaseSync(':memory:');
 db.transaction=callback=>{const run=(...args)=>{db.exec('BEGIN IMMEDIATE');try{const result=callback(...args);db.exec('COMMIT');return result;}catch(error){db.exec('ROLLBACK');throw error;}};run.immediate=run;return run;};
 db.exec('CREATE TABLE dramas(id INTEGER PRIMARY KEY,deleted_at TEXT);INSERT INTO dramas VALUES(1,NULL);CREATE TABLE ai_service_configs(id INTEGER PRIMARY KEY,name TEXT,service_type TEXT,provider TEXT,base_url TEXT,model TEXT,is_active INTEGER,deleted_at TEXT)');
 t.after(()=>db.close());
 const cfg={},bridge=(_account,{method,path,body})=>{
  if(path.endsWith('/catalog'))return budget.catalog(db,cfg);
  if(path.includes('/catalog/'))return budget.savePrice(db,cfg,body);
  if(path.includes('/budget/projects/'))return method==='GET'?budget.readProject(db,cfg,1):budget.updateProject(db,cfg,1,body);
  if(path.endsWith('/quote'))return budget.quote(db,cfg,body);
  if(path.endsWith('/reserve')){const result=budget.reserve(db,cfg,{source:'libtv-cli',...body,provider:'libtv-cli',origin:'https://api.liblib.tv'});return {dispatch_allowed:result.dispatch_allowed};}
  return {};
 };
 return {budget,db,bridge,cfg};
}

test('only an owned matching HD price refreshes its expiry while a different expired price remains unchanged',async t=>{
 let now=Date.now();const quote=hdPricing(()=>now);quote.state.ttl=60000;
 const {db,bridge}=nativeBudget(t),f=await setup(t,{testNode:videoNode,clock:()=>now,pricing:quote.pricing,advancedKind:'video_hd',nativeBridge:(actor,request)=>{
  if(request.path.endsWith('/reserve'))throw Object.assign(new Error('fixture reservation refused'),{code:'fixture_refusal',status:400});
  return bridge(actor,request);
 }});
 for(let attempt=0;attempt<3;attempt++){
  const input={...advancedInput(f),operationId:'hd-refresh-'+attempt},review=await preview(f.service,alice,input);
  await assert.rejects(generate(f.service,alice,{...input,approvalToken:review.approvalToken}),{code:'fixture_refusal'});
  const row=db.prepare('SELECT * FROM muse_budget_prices').get(),price=JSON.parse(row.profile_json);
  assert.equal(row.revision,attempt+1);assert.equal(price.reserve_minor,200);assert.equal(price.expires_at,review.quote.price.expiresAt);
  if(attempt===1){price.expires_at='2020-01-01T00:00:00.000Z';db.prepare('UPDATE muse_budget_prices SET profile_json=? WHERE id=?').run(JSON.stringify(price),row.id);}
  now+=1000;
 }
 const row=db.prepare('SELECT * FROM muse_budget_prices').get(),price=JSON.parse(row.profile_json);price.reserve_minor=2000;price.expires_at='2020-01-01T00:00:00.000Z';
 const original=JSON.stringify(price);db.prepare('UPDATE muse_budget_prices SET profile_json=? WHERE id=?').run(original,row.id);
 const input={...advancedInput(f),operationId:'hd-different-expired'},review=await preview(f.service,alice,input);
 await assert.rejects(generate(f.service,alice,{...input,approvalToken:review.approvalToken}),{code:'company_cli_native_price_mismatch'});
 assert.equal(db.prepare('SELECT profile_json FROM muse_budget_prices WHERE id=?').get(row.id).profile_json,original);
 assert.equal(f.store.readBudget(alice,{companyId:'company-a'}).reservedMinor,0);assert.equal(f.calls.filter(call=>call.method==='video_hd').length,0);
});

test('an approved company allowance configures a fresh native budget without another user setting',async t=>{
 const {budget,db,bridge,cfg}=nativeBudget(t),f=await setup(t,{nativeBridge:bridge});
 const receipt=await generate(f.service,alice,f.input(alice));
 assert.equal(receipt.data.state,'unknown');assert.equal(budget.readProject(db,cfg,1).currency,'LTV');assert.equal(budget.readProject(db,cfg,1).reserved_minor,600);
 assert.equal(f.calls.filter(call=>call.method==='node_run').length,1);f.gate.resolve();
});

test('official HD quotation fields reach both real budget ledgers without configuring a generic price',async t=>{
 const {budget,db,bridge}=nativeBudget(t),requests=[];
 const pricing=createCompanyCliPricing({fetchImpl:async(url,options)=>{
  requests.push({url,body:JSON.parse(options.body)});
  return Response.json({code:0,data:{power:2,originalPrice:2},trace_id:'quote-'+requests.length});
 }});
 const hdNode={...videoNode,data:{...videoNode.data,url:['https://libtv-res.liblib.art/fixture.mp4'],resourceMeta:{items:[{kind:'video',width:1280,height:720,durationSec:5}]},taskInfo:{status:2,loading:false}}};
 const hdSchema={modelKey:'volcano-video-upscaler',modality:'video',schema:{modelKey:'volcano-video-upscaler',modelVendor:'volcano',active:true,properties:{resolution:{default:'1080p',enum:['720p','1080p','2K','4K']},fps:{default:30,min:1,max:120}},config:{settings:['resolution','fps']}}};
 const f=await setup(t,{nativeBridge:bridge,pricing,testNode:hdNode,testSchema:hdSchema,advancedKind:'video_hd'});
 await writeFile(join(f.root,'credentials.json'),JSON.stringify({usertoken:'private-hd-fixture',webid:'fixture',useruuid:owner.user_uuid}),{mode:0o600});
 const input=advancedInput(f),review=await preview(f.service,alice,input);
 assert.equal(review.quote.reservedMinor,200);assert.equal(f.nativeCalls.length,0);
 await generate(f.service,alice,{...input,approvalToken:review.approvalToken});await f.started.promise;
 const job=f.store.findJob(alice,{companyId:'company-a',operationId:input.operationId});
 assert.equal(job.price.unitMinor,200);assert.equal(job.price.request.params.model,'volcano-video-upscaler');assert.equal(job.price.request.params.fps,30);
 assert.equal(budget.readProject(db,{},1).reserved_minor,200);assert.equal(f.store.readBudget(alice,{companyId:'company-a'}).reservedMinor,200);
 assert.equal(requests.length,2);assert.ok(requests.every(request=>request.url==='https://api.liblib.tv/api/task/generation/power/calculator'));
 assert.equal(f.store.getPrice(alice,{companyId:'company-a',connectionId:'test-cli',service:'agent-task',model:'advanced:video_hd'}),null);
 assert.equal(JSON.stringify(job).includes('private-hd-fixture'),false);f.gate.resolve();
});

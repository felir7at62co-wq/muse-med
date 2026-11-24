/** Real SQLite reservations and authorization decisions across separate company-store connections. */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {openCompanyCliStore} from './company-cli-store.mjs';

const owner={id:'aaaaaaaaaaaaaaaa'},member={id:'bbbbbbbbbbbbbbbb'},viewer={id:'cccccccccccccccc'},stranger={id:'dddddddddddddddd'};
const supplier={user_uuid:'supplier-user',account_id:'test-account',team_id:'test-team'};
const fails=(code)=>error=>error.code===code;

async function fixture(t,{parallel=4}={}){
 const root=await mkdtemp(join(tmpdir(),'muse-company-cli-')),file=join(root,'company.sqlite');let clock=Date.parse('2026-11-14T00:00:00.000Z');
 const accounts=new Map([owner,member,viewer,stranger].map(value=>[value.id,{...value,admin:false,disabled:false}])),handles=[];
 const open=async()=>{const value=await openCompanyCliStore({file,accountById:id=>accounts.get(id),maxParallel:parallel,approvalTtlMs:60000,now:()=>clock});handles.push(value);return value;};
 const store=await open();t.after(async()=>{for(const handle of handles)handle.close();await rm(root,{recursive:true,force:true});});
 store.bootstrapCompany({id:'company',name:'Test company',ownerId:owner.id});
 store.setMember(owner,{companyId:'company',userId:member.id,role:'member',active:true,expectedRevision:0});
 store.setMember(owner,{companyId:'company',userId:viewer.id,role:'viewer',active:true,expectedRevision:0});
 store.createProject(owner,{id:'project-owner',companyId:'company',name:'Owner project',tenantAccountId:owner.id,nativeProjectId:1,nativeDatabaseId:'native-owner'});
 store.createProject(member,{id:'project-member',companyId:'company',name:'Member project',tenantAccountId:member.id,nativeProjectId:1,nativeDatabaseId:'native-member'});
 store.setConnection(owner,{id:'test-connection',companyId:'company',label:'Test account',environment:'test',owner:supplier,maxParallel:parallel,active:true,expectedRevision:0});
 store.setPrice(owner,{companyId:'company',connectionId:'test-connection',service:'video',model:'wanx3.0',unitMinor:5000,source:'operator-confirmed-test-quote',expiresAt:'2026-12-01T00:00:00.000Z',expectedRevision:0});
 const grant=(scope,targetId,limitMinor)=>{const prepared=store.prepareBudgetChange(owner,{companyId:'company',scope,targetId,limitMinor});return store.confirmBudgetChange(owner,{proposalId:prepared.proposal.id,approvalNonce:prepared.approvalNonce,approved:true});};
 const funded=()=>{grant('company','company',20000);grant('member',owner.id,20000);grant('member',member.id,20000);grant('project','project-owner',20000);grant('project','project-member',20000);};
 const request=(suffix='one',projectId='project-owner')=>({companyId:'company',projectId,connectionId:'test-connection',operationId:'generate-'+suffix,prepared:{method:'run',body:{nodeId:'node-'+suffix},requestSha256:'a'.repeat(64),resourceKey:'canvas:'+projectId+':node:'+suffix,paid:true,service:'video',model:'wanx3.0',quantity:1}});
 return {store,file,root,accounts,open,grant,funded,request,advance:ms=>{clock+=ms;}};
}

function hdRequest(f,suffix='hd',minor=200){
 const request=f.request(suffix),price={protocol:'muse-company-cli-hd-quote-v1',source:'https://api.liblib.tv/api/task/generation/power/calculator',service:'agent-task',model:minor===200?'volcano-video-upscaler':'topaz-video-upscaler',billingModel:'advanced:video_hd',quantity:1,currency:'LTV',priceMinor:minor,unitMinor:minor,reservedMinor:minor,requestSha256:request.prepared.requestSha256,nodeSha256:'b'.repeat(64),planSha256:'c'.repeat(64),modelSchemaSha256:'d'.repeat(64),connectionId:'test-connection',connectionRevision:1,owner:supplier,quotedAt:'2026-11-14T00:00:00.000Z',expiresAt:'2026-11-14T00:01:00.000Z',request:{model:'test'},response:{code:0,data:{power:minor/100}},requestHash:'e'.repeat(64),responseHash:'f'.repeat(64),quoteIdentity:String(minor===200?'a':'b').repeat(64),locked:false};
 request.prepared={...request.prepared,method:'video_hd',service:'agent-task',model:'advanced:video_hd',quantity:1,resolvedPrice:price};return request;
}
function apiRequest(f){
 const request=hdRequest(f,'api',200),sourceSha256='1'.repeat(64);
 request.prepared={...request.prepared,method:'libtv_api_erase_subtitles',provider:'libtv-api',service:'postproduction',model:'volcano-subtitle-eraser',sourceSha256};
 request.prepared.resolvedPrice={...request.prepared.resolvedPrice,protocol:'muse-company-libtv-api-quote-v1',provider:'libtv-api',service:'postproduction',model:'volcano-subtitle-eraser',sourceSha256};
 return request;
}

test('API postproduction requires a bound positive quote and retains one immutable provider acknowledgement',async t=>{
 const f=await fixture(t);f.funded();const request=apiRequest(f);
 const unpriced=structuredClone(request);delete unpriced.prepared.resolvedPrice;assert.throws(()=>f.store.admit(owner,unpriced),fails('company_cli_price_required'));
 const wrong=structuredClone(request);wrong.prepared.resolvedPrice.sourceSha256='2'.repeat(64);assert.throws(()=>f.store.admit(owner,wrong),fails('company_cli_invalid_resolved_price'));
 const job=f.store.admit(owner,request);f.store.claimJob(job.id);
 const accepted={provider:'libtv-api',taskId:'original-task',ack:{taskId:'original-task',requestSha256:request.prepared.requestSha256}};
 const captured=f.store.recordProviderTask(job.id,accepted);assert.equal(captured.result.providerTask.taskId,'original-task');
 assert.deepEqual(f.store.recordProviderTask(job.id,accepted).result,captured.result);
 assert.throws(()=>f.store.recordProviderTask(job.id,{...accepted,taskId:'replacement-task'}),fails('company_cli_provider_task_changed'));
 assert.throws(()=>f.store.finishJob(job.id,{state:'completed',result:{providerResult:{state:'completed'}}}),fails('company_cli_provider_task_changed'));
 const result={...captured.result,providerResult:{state:'completed',taskId:'original-task',outputs:[{kind:'video',url:'https://example.com/result.mp4'}]}};
 f.store.finishJob(job.id,{state:'completed',result});
 const imported={provider:'libtv-api',generation_id:5,source_operation_id:request.operationId};f.store.recordProviderImport(job.id,imported);
 assert.equal(f.store.getJob(owner,job.id).result.providerTask.taskId,'original-task');
 assert.throws(()=>f.store.recordProviderImport(job.id,{...imported,generation_id:6}),fails('company_cli_provider_import_changed'));
});

test('accepted API tasks survive process recovery without acquiring a new task identity or reservation',async t=>{
 const f=await fixture(t);f.funded();const request=apiRequest(f),job=f.store.admit(owner,request);f.store.claimJob(job.id);
 f.store.recordProviderTask(job.id,{provider:'libtv-api',taskId:'original-task',ack:{taskId:'original-task'}});
 const reopened=await f.open();assert.equal(reopened.recoverInterruptedJobs(),1);const recovered=reopened.getJob(owner,job.id);
 assert.equal(recovered.state,'unknown');assert.equal(recovered.result.providerTask.taskId,'original-task');assert.equal(reopened.readBudget(owner,{companyId:'company'}).reservedMinor,200);
 assert.equal(reopened.admit(owner,request).id,job.id);assert.equal(reopened.readBudget(owner,{companyId:'company'}).reservedMinor,200);
});

test('only a complete fixed-model zero quote reserves a paid API intent against zero allowances',async t=>{
 const f=await fixture(t),request=apiRequest(f);
 Object.assign(request.prepared.resolvedPrice,{unitMinor:0,priceMinor:0,reservedMinor:0,zeroQuote:true,response:{power:0,originalPrice:0,taskWeight:0,type:0,discountRatio:1}});
 for(const mutate of [item=>{delete item.prepared.resolvedPrice.response.taskWeight;},item=>{item.prepared.resolvedPrice.zeroQuote=false;},item=>{item.prepared.paid=false;},item=>{item.prepared.resolvedPrice.model='unknown-model';}]){
  const invalid=structuredClone(request);mutate(invalid);assert.throws(()=>f.store.admit(owner,invalid));
 }
 const job=f.store.admit(owner,request);assert.equal(job.paid,true);assert.equal(job.service,'postproduction');assert.equal(job.reservedMinor,0);assert.equal(job.price.zeroQuote,true);
 assert.equal(f.store.readBudget(owner,{companyId:'company'}).limitMinor,0);assert.equal(f.store.readBudget(owner,{companyId:'company'}).reservedMinor,0);
});

test('resolved HD quotations retain separate model evidence without changing the generic price catalog',async t=>{
 const f=await fixture(t);f.funded();
 f.store.setPrice(owner,{companyId:'company',connectionId:'test-connection',service:'agent-task',model:'advanced:video_hd',unitMinor:9900,source:'old-generic-price',expiresAt:'2026-12-01T00:00:00.000Z',expectedRevision:0});
 const huoshan=hdRequest(f,'huoshan',200),topaz=hdRequest(f,'topaz',2000);
 assert.equal(f.store.quote(owner,huoshan).reservedMinor,200);assert.equal(f.store.quote(owner,topaz).reservedMinor,2000);
 const first=f.store.admit(owner,huoshan),second=f.store.admit(owner,topaz);
 assert.equal(first.price.apiModel,'volcano-video-upscaler');assert.equal(second.price.apiModel,'topaz-video-upscaler');
 assert.equal(first.price.model,'advanced:video_hd');assert.equal(first.price.requestSha256,first.requestSha256);
 assert.deepEqual(second.price.response,topaz.prepared.resolvedPrice.response);
 assert.equal(f.store.getPrice(owner,{companyId:'company',connectionId:'test-connection',service:'agent-task',model:'advanced:video_hd'}).unitMinor,9900);
 assert.equal(f.store.readBudget(owner,{companyId:'company'}).reservedMinor,2200);
});

test('resolved quotations are restricted to the exact HD request, connection and supplier owner',async t=>{
 const f=await fixture(t);f.funded();
 for(const change of [
  request=>{request.prepared.resolvedPrice.requestSha256='0'.repeat(64);},
  request=>{request.prepared.resolvedPrice.connectionId='other-connection';},
  request=>{request.prepared.resolvedPrice.connectionRevision=2;},
  request=>{request.prepared.resolvedPrice.owner={...supplier,account_id:'other-account'};},
  request=>{request.prepared.resolvedPrice.unitMinor=100;},
  request=>{request.prepared.resolvedPrice.locked=true;},
  request=>{request.prepared.method='video_final';},
  request=>{request.prepared.paid=false;},
 ]){
  const request=hdRequest(f);change(request);assert.throws(()=>f.store.admit(owner,request),fails('company_cli_invalid_resolved_price'));
 }
 assert.equal(f.store.listJobs(owner,{projectId:'project-owner'}).length,0);
 const stale=hdRequest(f);f.advance(60000);
 assert.throws(()=>f.store.admit(owner,stale),fails('company_cli_price_required'));
});

test('resolved HD reservations enforce the company ceiling across independent store connections',async t=>{
 const f=await fixture(t);f.funded();f.grant('company','company',2100);
 const second=await f.open();f.store.admit(owner,hdRequest(f,'first',2000));
 assert.throws(()=>second.admit(owner,hdRequest(f,'second',200)),fails('company_cli_budget_exceeded'));
 assert.equal(second.readBudget(owner,{companyId:'company'}).reservedMinor,2000);
});

test('bootstrap grants no spending and unknown company users cannot enumerate projects',async t=>{
 const f=await fixture(t);
 assert.equal(f.store.readBudget(owner,{companyId:'company'}).limitMinor,0);
 assert.equal(f.store.readBudget(owner,{companyId:'company'}).reservedMinor,0);
 assert.throws(()=>f.store.admit(owner,f.request()),fails('company_cli_budget_exceeded'));
 assert.deepEqual(f.store.context(stranger),{companies:[]});
 assert.throws(()=>f.store.createCompany(member,{id:'other',name:'Other'}),fails('company_cli_site_admin_required'));
 assert.throws(()=>f.store.getProject(member,'project-owner'),fails('company_cli_project_not_found'));
 assert.throws(()=>f.store.createProject(member,{companyId:'company',name:'Foreign',tenantAccountId:owner.id,nativeProjectId:2,nativeDatabaseId:'native-owner'}),fails('company_cli_foreign_tenant'));
});

test('project grants authorize editing without granting company administration',async t=>{
 const f=await fixture(t);f.funded();
 f.store.setProjectMember(owner,{projectId:'project-owner',userId:member.id,role:'editor'});
 assert.equal(f.store.getProject(member,'project-owner').ownerId,owner.id);
 assert.equal(f.store.admit(member,f.request()).actorId,member.id);
 f.store.setProjectMember(owner,{projectId:'project-owner',userId:viewer.id,role:'viewer'});
 assert.equal(f.store.getProject(viewer,'project-owner').id,'project-owner');
 assert.throws(()=>f.store.admit(viewer,f.request('view')),fails('company_cli_project_read_only'));
 assert.throws(()=>f.store.setConnection(member,{companyId:'company'}),fails('company_cli_admin_required'));
 assert.throws(()=>f.store.setMember(owner,{companyId:'company',userId:member.id,role:'member',active:true,limitMinor:90000,expectedRevision:2}),fails('company_cli_budget_approval_required'));
 assert.throws(()=>f.store.setMember(owner,{companyId:'company',userId:owner.id,role:'member',active:true,expectedRevision:2}),fails('company_cli_last_owner'));
});

test('private nonce is actor-bound, single-use and the sole budget mutation path',async t=>{
 const f=await fixture(t),proposal=f.store.prepareBudgetChange(owner,{companyId:'company',scope:'company',limitMinor:10000});
 assert.equal(proposal.proposal.approvalNonce,undefined);
 assert.equal(JSON.stringify(f.store.listBudgetChanges(owner,'company')).includes(proposal.approvalNonce),false);
 assert.throws(()=>f.store.confirmBudgetChange(owner,{proposalId:proposal.proposal.id,approved:true}),fails('company_cli_approval_required'));
 assert.throws(()=>f.store.confirmBudgetChange(member,{proposalId:proposal.proposal.id,approvalNonce:proposal.approvalNonce,approved:true}),fails('company_cli_admin_required'));
 const result=f.store.confirmBudgetChange(owner,{proposalId:proposal.proposal.id,approvalNonce:proposal.approvalNonce,approved:true});
 assert.equal(result.budget.limitMinor,10000);
 assert.equal(f.store.confirmBudgetChange(owner,{proposalId:proposal.proposal.id,approvalNonce:proposal.approvalNonce,approved:true}).replayed,true);
 const declined=f.store.prepareBudgetChange(owner,{companyId:'company',scope:'company',limitMinor:12000});
 f.store.confirmBudgetChange(owner,{proposalId:declined.proposal.id,approvalNonce:declined.approvalNonce,approved:false});
 assert.equal(f.store.readBudget(owner,{companyId:'company'}).limitMinor,10000);
 const expired=f.store.prepareBudgetChange(owner,{companyId:'company',scope:'company',limitMinor:12000});f.advance(60001);
 assert.throws(()=>f.store.confirmBudgetChange(owner,{proposalId:expired.proposal.id,approvalNonce:expired.approvalNonce,approved:true}),fails('company_cli_approval_stale'));
});

test('members confirm their own allowance without company administration',async t=>{
 const f=await fixture(t);const requested=f.store.prepareBudgetChange(member,{companyId:'company',scope:'member',targetId:member.id,limitMinor:5000});
 f.store.confirmBudgetChange(member,{proposalId:requested.proposal.id,approvalNonce:requested.approvalNonce,approved:true});
 assert.equal(f.store.readBudget(member,{companyId:'company',scope:'member',targetId:member.id}).limitMinor,5000);
 assert.equal(f.store.readBudget(member,{companyId:'company'}).limitMinor,0);
 assert.throws(()=>f.store.prepareBudgetChange(member,{companyId:'company',scope:'company',limitMinor:5000}),fails('company_cli_admin_required'));
 assert.throws(()=>f.store.prepareBudgetChange(member,{companyId:'company',scope:'member',targetId:owner.id,limitMinor:5000}),fails('company_cli_forbidden'));
 assert.throws(()=>f.store.prepareBudgetChange(viewer,{companyId:'company',scope:'member',targetId:viewer.id,limitMinor:5000}),fails('company_cli_forbidden'));
 const companyProposal=f.store.prepareBudgetChange(owner,{companyId:'company',scope:'member',targetId:owner.id,limitMinor:5000});
 assert.throws(()=>f.store.challengeBudgetChange(member,companyProposal.proposal.id),fails('company_cli_forbidden'));
 assert.throws(()=>f.store.confirmBudgetChange(member,{proposalId:companyProposal.proposal.id,approvalNonce:companyProposal.approvalNonce,approved:true}),fails('company_cli_forbidden'));
});

test('project editors adjust local limits while the company budget remains a hard ceiling',async t=>{
 const f=await fixture(t);f.grant('company','company',5000);
 f.store.setProjectMember(owner,{projectId:'project-owner',userId:member.id,role:'editor'});
 for(const [scope,targetId] of [['member',member.id],['project','project-owner']]){const p=f.store.prepareBudgetChange(member,{companyId:'company',scope,targetId,limitMinor:20000});f.store.confirmBudgetChange(member,{proposalId:p.proposal.id,approvalNonce:p.approvalNonce,approved:true});}
 const job=f.store.admit(member,f.request());assert.equal(job.reservedMinor,5000);
 assert.throws(()=>f.store.admit(member,f.request('two')),fails('company_cli_budget_exceeded'));
 assert.throws(()=>f.store.prepareBudgetChange(member,{companyId:'company',scope:'project',targetId:'project-owner',limitMinor:4999}),fails('company_cli_limit_below_reservations'));
 f.store.setProjectMember(owner,{projectId:'project-owner',userId:viewer.id,role:'viewer'});
 assert.throws(()=>f.store.prepareBudgetChange(viewer,{companyId:'company',scope:'project',targetId:'project-owner',limitMinor:20000}),fails('company_cli_project_read_only'));
});

test('revoking project edit permission invalidates a pending local budget approval',async t=>{
 const f=await fixture(t);f.store.setProjectMember(owner,{projectId:'project-owner',userId:member.id,role:'editor'});
 const requested=f.store.prepareBudgetChange(member,{companyId:'company',scope:'project',targetId:'project-owner',limitMinor:10000});
 f.store.setProjectMember(owner,{projectId:'project-owner',userId:member.id,role:'viewer'});
 assert.throws(()=>f.store.confirmBudgetChange(member,{proposalId:requested.proposal.id,approvalNonce:requested.approvalNonce,approved:true}),fails('company_cli_project_read_only'));
 const requestedByOwner=f.store.challengeBudgetChange(owner,requested.proposal.id);
 assert.notEqual(requestedByOwner.approvalNonce,requested.approvalNonce);
 f.store.confirmBudgetChange(owner,{proposalId:requested.proposal.id,approvalNonce:requestedByOwner.approvalNonce,approved:true});
 assert.equal(f.store.readBudget(owner,{companyId:'company',scope:'project',targetId:'project-owner'}).limitMinor,10000);
});

test('separate SQLite connections share atomic company budget and independent node slots',async t=>{
 const f=await fixture(t);f.funded();f.grant('company','company',5000);const second=await f.open();
 const first=f.store.admit(owner,f.request());assert.equal(first.reservedMinor,5000);
 assert.throws(()=>second.admit(member,f.request('two','project-member')),fails('company_cli_budget_exceeded'));
 assert.equal(f.store.readBudget(owner,{companyId:'company'}).reservedMinor,5000);
 assert.equal(second.listJobs(member,{projectId:'project-member'}).length,0);
 f.grant('company','company',10000);
 const another=second.admit(member,f.request('two','project-member'));assert.equal(another.state,'reserved');
 assert.equal(second.readBudget(owner,{companyId:'company'}).reservedMinor,10000);
});

test('a spending change after the question invalidates the approved snapshot',async t=>{
 const f=await fixture(t);f.funded();const proposal=f.store.prepareBudgetChange(owner,{companyId:'company',scope:'company',limitMinor:25000});
 f.store.admit(owner,f.request());
 assert.throws(()=>f.store.confirmBudgetChange(owner,{proposalId:proposal.proposal.id,approvalNonce:proposal.approvalNonce,approved:true}),fails('company_cli_approval_stale'));
 assert.equal(f.store.readBudget(owner,{companyId:'company'}).limitMinor,20000);
});

test('identical operations replay once and a second writer cannot reuse a live node',async t=>{
 const f=await fixture(t);f.funded();const request=f.request(),first=f.store.admit(owner,request),again=f.store.admit(owner,request);
 assert.equal(again.id,first.id);assert.equal(again.replayed,true);
 assert.equal(f.store.readBudget(owner,{companyId:'company'}).reservedMinor,5000);
 assert.throws(()=>f.store.admit(owner,{...request,prepared:{...request.prepared,body:{nodeId:'changed'}}}),fails('company_cli_operation_conflict'));
 assert.throws(()=>f.store.admit(owner,{...request,operationId:'another-operation'}),fails('company_cli_resource_busy'));
 f.store.claimJob(first.id);assert.throws(()=>f.store.claimJob(first.id),fails('company_cli_job_already_claimed'));
});

test('unknown operations retain slots and money across recovery and connection rotation',async t=>{
 const f=await fixture(t,{parallel:1});f.funded();const first=f.store.admit(owner,f.request());f.store.claimJob(first.id);
 assert.equal(f.store.recoverInterruptedJobs(),1);assert.equal(f.store.getJob(owner,first.id).state,'unknown');
 assert.throws(()=>f.store.admit(owner,f.request('two')),fails('company_cli_parallel_limit'));
 assert.throws(()=>f.store.claimJob(first.id),fails('company_cli_job_already_claimed'));
 assert.throws(()=>f.store.setConnection(owner,{id:'test-connection',companyId:'company',label:'Company account',environment:'production',owner:{...supplier,account_id:'company-account'},maxParallel:1,active:true,expectedRevision:1}),fails('company_cli_connection_busy'));
 f.store.finishJob(first.id,{state:'completed',result:{media:[{url:'https://media.example.test/result.mp4'}]}});
 f.store.setConnection(owner,{id:'test-connection',companyId:'company',label:'Company account',environment:'production',owner:{...supplier,account_id:'company-account'},maxParallel:1,active:true,expectedRevision:1});
 assert.equal(f.store.getJob(owner,first.id).owner.account_id,'test-account');
 assert.equal(f.store.readBudget(owner,{companyId:'company'}).reservedMinor,5000);
});

test('revoked members cannot dispatch an already admitted operation or read its history',async t=>{
 const f=await fixture(t);f.funded();const job=f.store.admit(member,f.request('member','project-member'));
 f.store.setMember(owner,{companyId:'company',userId:member.id,role:'member',active:false,expectedRevision:2});
 assert.throws(()=>f.store.claimJob(job.id),fails('company_cli_forbidden'));
 assert.throws(()=>f.store.getJob(member,job.id),fails('company_cli_forbidden'));
 f.store.cancelReservedJob(job.id);assert.equal(f.store.readBudget(owner,{companyId:'company'}).reservedMinor,0);
});

test('missing, expired and unsafe prices fail before a reservation exists',async t=>{
 const f=await fixture(t);f.funded();
 assert.equal(f.store.getPrice(owner,{companyId:'company',connectionId:'test-connection',service:'video',model:'wanx3.0'}).revision,1);
 assert.equal(f.store.getPrice(owner,{companyId:'company',connectionId:'test-connection',service:'video',model:'not-priced'}),null);
 assert.throws(()=>f.store.getPrice(stranger,{companyId:'company',connectionId:'test-connection',service:'video',model:'wanx3.0'}),fails('company_cli_forbidden'));
 assert.throws(()=>f.store.setPrice(owner,{companyId:'company',connectionId:'test-connection',service:'video',model:'bad-date',unitMinor:1,source:'operator',expiresAt:'not-a-date',expectedRevision:0}),fails('company_cli_invalid_price'));
 assert.throws(()=>f.store.admit(owner,{...f.request(),prepared:{...f.request().prepared,model:'not-priced'}}),fails('company_cli_price_required'));
 f.advance(40*86400000);assert.throws(()=>f.store.admit(owner,f.request()),fails('company_cli_price_required'));
 assert.equal(f.store.listJobs(owner,{projectId:'project-owner'}).length,0);
});

test('generation inputs and audit history cannot be rewritten in SQLite',async t=>{
 const f=await fixture(t);f.funded();const job=f.store.admit(owner,f.request());const db=new DatabaseSync(f.file);
 try{assert.throws(()=>db.prepare('UPDATE company_cli_jobs SET body_json=? WHERE id=?').run('{}',job.id),/company_cli_job_inputs_immutable/);assert.throws(()=>db.exec('DELETE FROM company_cli_jobs'),/company_cli_jobs_immutable/);assert.throws(()=>db.exec('DELETE FROM company_cli_audit'),/company_cli_audit_immutable/);}finally{db.close();}
 assert.equal(f.store.getJob(owner,job.id).body.nodeId,'node-one');
 assert.ok(f.store.audit(owner,'company').some(row=>row.event==='job-admitted'));
 f.store.claimJob(job.id);f.store.finishJob(job.id,{state:'unknown',result:{error_code:'response_lost'}});f.store.finishJob(job.id,{state:'completed',result:{url:'https://example.test/result.mp4'}});
 assert.ok(f.store.audit(owner,'company').some(row=>row.event==='job-unknown'&&row.detail.result.error_code==='response_lost'));
});

test('server capture remains bound to the original request and account after reopening',async t=>{
 const f=await fixture(t);f.funded();const request=f.request();request.prepared.inputCapture={node:{prompt:'Wave',images:['https://example.test/hero.png']},metadata:{model:'wanx3.0'}};
 const job=f.store.admit(owner,request),second=await f.open();
 assert.deepEqual(second.getJob(owner,job.id).inputCapture,request.prepared.inputCapture);
 f.store.claimJob(job.id);f.store.finishJob(job.id,{state:'completed',result:{url:'https://example.test/video.mp4'}});
 f.store.setConnection(owner,{id:'test-connection',companyId:'company',label:'Company account',environment:'production',owner:{...supplier,account_id:'company-account'},maxParallel:4,active:true,expectedRevision:1});
 assert.throws(()=>f.store.admit(owner,f.request('new')),fails('company_cli_price_required'));
 assert.equal(second.getJob(owner,job.id).connectionRevision,1);
 assert.equal(second.getJob(owner,job.id).owner.account_id,'test-account');
});

test('a future database version is rejected before adding feature tables',async t=>{
 const root=await mkdtemp(join(tmpdir(),'muse-company-future-')),file=join(root,'future.sqlite');t.after(()=>rm(root,{recursive:true,force:true}));
 const original=new DatabaseSync(file);original.exec('CREATE TABLE company_cli_schema(version INTEGER NOT NULL); INSERT INTO company_cli_schema VALUES(2)');original.close();
 await assert.rejects(openCompanyCliStore({file,accountById:()=>owner,maxParallel:1}),fails('company_cli_unsupported_schema'));
 const check=new DatabaseSync(file);try{assert.deepEqual(check.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(x=>x.name),['company_cli_schema']);}finally{check.close();}
});

test('canvas bindings retain the exact connection and operation lookups preserve actor isolation',async t=>{
 const f=await fixture(t);f.funded();
 const project=f.store.bindCanvas(owner,{projectId:'project-owner',canvasUuid:'canvas-one',connectionId:'test-connection',expectedRevision:2});
 assert.equal(project.connectionRevision,1);assert.deepEqual(project.connectionOwner,supplier);
 const job=f.store.admit(owner,f.request());
 assert.equal(f.store.findJob(owner,{companyId:'company',operationId:'generate-one'}).id,job.id);
 assert.equal(f.store.findJob(member,{companyId:'company',operationId:'generate-one'}),null);
 assert.throws(()=>f.store.findJob(owner,{companyId:'company',operationId:'generate-one',projectId:'project-member'}),fails('company_cli_operation_conflict'));
 f.store.cancelReservedJob(job.id);
 f.store.setConnection(owner,{id:'test-connection',companyId:'company',label:'Company account',environment:'production',owner:{...supplier,account_id:'company-account'},maxParallel:4,active:true,expectedRevision:1});
 assert.equal(f.store.getProject(owner,'project-owner').connectionOwner.account_id,'test-account');
 assert.throws(()=>f.store.quote(owner,f.request('two')),fails('company_cli_connection_changed'));
 assert.throws(()=>f.store.bindCanvas(owner,{projectId:'project-owner',canvasUuid:'canvas-one',connectionId:'test-connection',expectedRevision:3}),fails('company_cli_canvas_already_bound'));
});

test('context exposes membership revisions only to company administrators',async t=>{
 const f=await fixture(t);f.funded();
 const admin=f.store.context(owner).companies[0],ordinary=f.store.context(member).companies[0];
 assert.equal(admin.members.find(x=>x.userId===member.id).revision,2);
 assert.equal(admin.projects.find(x=>x.id==='project-owner').budget.limitMinor,20000);
 assert.ok(Array.isArray(admin.projects.find(x=>x.id==='project-owner').members));
 assert.equal(ordinary.members,undefined);assert.equal(ordinary.projects.length,1);
 assert.equal(ordinary.projects[0].budget.limitMinor,20000);
 assert.deepEqual(ordinary.projects[0].members,[]);
});

test('different target nodes share read leases while reference writers are refused',async t=>{
 const f=await fixture(t);f.funded();const second=await f.open();
 const request=target=>{const value=f.request(target);value.prepared.resources=[{key:'canvas:one:edges',mode:'read'},{key:'canvas:one:node:'+target,mode:'write'},{key:'canvas:one:node:hero',mode:'read'}];return value;};
 const first=f.store.admit(owner,request('target-one')),other=second.admit(owner,request('target-two'));
 assert.equal(first.resources.length,3);assert.equal(other.resources.length,3);
 const writer=request('edit-hero');writer.prepared.resources=[{key:'canvas:one:node:hero',mode:'write'}];
 assert.throws(()=>second.admit(owner,writer),fails('company_cli_resource_busy'));
 const edges=request('edit-edges');edges.prepared.resources=[{key:'canvas:one:edges',mode:'write'}];
 assert.throws(()=>f.store.admit(owner,edges),fails('company_cli_resource_busy'));
 f.store.cancelReservedJob(first.id);second.cancelReservedJob(other.id);
 assert.equal(f.store.admit(owner,writer).resources[0].mode,'write');
});

test('explicit read leases permit sharing the primary resource label',async t=>{
 const f=await fixture(t);f.funded();const input=f.request('read-one');input.prepared={...input.prepared,paid:false,resourceKey:'shared-edge',resources:[{key:'shared-edge',mode:'read'}]};
 const first=f.store.admit(owner,input),second=f.store.admit(owner,{...input,operationId:'read-two'});assert.notEqual(first.id,second.id);
});

test('resource leases collapse duplicate keys and preserve the strongest mode',async t=>{
 const f=await fixture(t);f.funded();const input=f.request();input.prepared.resources=[{key:'same',mode:'read'},{key:'same',mode:'write'},{key:'same',mode:'read'}];
 const job=f.store.admit(owner,input);assert.deepEqual(job.resources,[{key:'same',mode:'write'}]);
 const invalid=f.request('invalid');invalid.prepared.resources=[];assert.throws(()=>f.store.admit(owner,invalid),fails('company_cli_invalid_resources'));
 const db=new DatabaseSync(f.file);try{assert.throws(()=>db.exec('DELETE FROM company_cli_resources'),/company_cli_resources_immutable/);}finally{db.close();}
});

test('an interrupted native reservation is retained before supplier dispatch',async t=>{
 const f=await fixture(t);f.funded();const job=f.store.admit(owner,f.request());
 assert.equal(f.store.recoverInterruptedJobs(),1);assert.equal(f.store.getJob(owner,job.id).state,'unknown');
 assert.throws(()=>f.store.cancelReservedJob(job.id),fails('company_cli_job_already_claimed'));
 assert.equal(f.store.readBudget(owner,{companyId:'company'}).reservedMinor,5000);
});

test('verified opening charges survive restart and consume company and member allowances once',async t=>{
 const f=await fixture(t),opening={companyId:'company',userId:owner.id,operationId:'legacy-charge',minor:6900,source:'verified-native-ledger'};
 f.store.bootstrapOpeningBalance(opening);assert.equal(f.store.bootstrapOpeningBalance(opening).replayed,true);
 assert.throws(()=>f.store.bootstrapOpeningBalance({...opening,minor:6000}),fails('company_cli_operation_conflict'));
 const second=await f.open();assert.equal(second.readBudget(owner,{companyId:'company'}).reservedMinor,6900);
 assert.equal(second.readBudget(owner,{companyId:'company',scope:'member',targetId:owner.id}).reservedMinor,6900);
 assert.equal(second.readBudget(owner,{companyId:'company',scope:'project',targetId:'project-owner'}).reservedMinor,0);
 assert.equal(second.listJobs(owner,{projectId:'project-owner'}).length,0);
 f.grant('company','company',10000);f.grant('member',owner.id,10000);f.grant('project','project-owner',10000);
 assert.throws(()=>f.store.admit(owner,f.request()),fails('company_cli_budget_exceeded'));
 const db=new DatabaseSync(f.file);try{assert.throws(()=>db.exec('DELETE FROM company_cli_opening_balances'),/company_cli_opening_immutable/);}finally{db.close();}
});

test('existing project registration is atomic and replayable through another store connection',async t=>{
 const f=await fixture(t),input={companyId:'company',name:'Existing canvas',tenantAccountId:owner.id,nativeProjectId:9,nativeDatabaseId:'native-owner',canvasUuid:'old-canvas',connectionId:'test-connection',connectionRevision:1};
 const first=f.store.registerProject(owner,input),second=await f.open(),replay=second.registerProject(owner,input);
 assert.equal(first.replayed,false);assert.equal(replay.replayed,true);assert.equal(replay.project.id,first.project.id);
 assert.equal(first.project.connectionRevision,1);assert.deepEqual(first.project.connectionOwner,supplier);
 assert.equal(f.store.readBudget(owner,{companyId:'company',scope:'project',targetId:first.project.id}).limitMinor,0);
 assert.equal(f.store.listJobs(owner,{projectId:first.project.id}).length,0);
 assert.equal(f.store.context(owner).companies[0].projects.length,3);
});

test('registration conflicts and stale connections cannot leave partially created projects',async t=>{
 const f=await fixture(t),input={companyId:'company',name:'Existing canvas',tenantAccountId:owner.id,nativeProjectId:1,nativeDatabaseId:'native-owner',canvasUuid:'old-canvas',connectionId:'test-connection',connectionRevision:1};
 assert.equal(f.store.registerProject(owner,input).project.id,'project-owner');
 assert.throws(()=>f.store.registerProject(member,{...input,tenantAccountId:member.id,nativeDatabaseId:'native-member',nativeProjectId:9}),fails('company_cli_canvas_already_bound'));
 assert.throws(()=>f.store.registerProject(owner,{...input,canvasUuid:'different-canvas'}),fails('company_cli_canvas_already_bound'));
 assert.throws(()=>f.store.registerProject(owner,{...input,nativeProjectId:9,canvasUuid:'new-canvas',connectionRevision:3}),fails('company_cli_revision_conflict'));
 assert.throws(()=>f.store.registerProject(owner,{...input,tenantAccountId:member.id,canvasUuid:'new-canvas'}),fails('company_cli_foreign_tenant'));
 assert.equal(f.store.context(owner).companies[0].projects.length,2);
});

test('registration refuses an unbound project with a reserved, running or unknown supplier operation',async t=>{
 for(const state of ['reserved','running','unknown']){
  const f=await fixture(t),request={...f.request(state),prepared:{method:'project_create',body:{name:'New canvas'},requestSha256:'b'.repeat(64),resourceKey:'project:project-owner:create',paid:false}};
  const job=f.store.admit(owner,request);
  if(state!=='reserved')f.store.claimJob(job.id);
  if(state==='unknown')f.store.finishJob(job.id,{state:'unknown',result:{error:'unconfirmed'}});
  assert.throws(()=>f.store.registerProject(owner,{companyId:'company',name:'Existing',tenantAccountId:owner.id,nativeProjectId:1,nativeDatabaseId:'native-owner',canvasUuid:'existing-canvas',connectionId:'test-connection',connectionRevision:1}),fails('company_cli_project_busy'));
  assert.equal(f.store.getProject(owner,'project-owner').canvasUuid,null);
  assert.equal(f.store.getJob(owner,job.id).state,state);
 }
});

test('a stale prepared project creation cannot dispatch after an existing canvas is registered',async t=>{
 const f=await fixture(t),request={...f.request('stale-create'),prepared:{method:'project_create',body:{name:'New canvas'},requestSha256:'b'.repeat(64),resourceKey:'project:project-owner:create',paid:false}};
 f.store.registerProject(owner,{companyId:'company',name:'Existing',tenantAccountId:owner.id,nativeProjectId:1,nativeDatabaseId:'native-owner',canvasUuid:'existing-canvas',connectionId:'test-connection',connectionRevision:1});
 assert.throws(()=>f.store.admit(owner,request),fails('company_cli_canvas_already_bound'));
 assert.equal(f.store.listJobs(owner,{projectId:'project-owner'}).length,0);
 assert.equal(f.store.getProject(owner,'project-owner').canvasUuid,'existing-canvas');
});

test('a completed project creation remains replayable and a cancelled creation permits registration',async t=>{
 const f=await fixture(t),request={...f.request('completed-create'),prepared:{method:'project_create',body:{name:'New canvas'},requestSha256:'b'.repeat(64),resourceKey:'project:project-owner:create',paid:false}},job=f.store.admit(owner,request);
 f.store.claimJob(job.id);f.store.bindCanvas(owner,{projectId:'project-owner',canvasUuid:'created-canvas',connectionId:'test-connection',expectedRevision:1});
 f.store.finishJob(job.id,{state:'completed',result:{projectUuid:'created-canvas'}});
 assert.equal(f.store.admit(owner,request).id,job.id);assert.equal(f.store.admit(owner,request).replayed,true);
 const other=await fixture(t),pending=other.store.admit(owner,{...request,operationId:'cancelled-create'});other.store.cancelReservedJob(pending.id);
 const registered=other.store.registerProject(owner,{companyId:'company',name:'Existing',tenantAccountId:owner.id,nativeProjectId:1,nativeDatabaseId:'native-owner',canvasUuid:'existing-canvas',connectionId:'test-connection',connectionRevision:1});
 assert.equal(registered.registered,true);assert.equal(other.store.getJob(owner,pending.id).state,'cancelled');
});

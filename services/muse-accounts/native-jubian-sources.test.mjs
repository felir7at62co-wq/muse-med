/** Source admission exercises only local metadata, trusted proof fixtures and independent SQLite connections. */
import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir as systemTmpdir} from 'node:os';
import {realpathSync as realpathOfTmpdir} from 'node:fs';
// Private-directory checks compare real paths; the system temp directory can be reached through a link (macOS /var).
const tmpdir=()=>realpathOfTmpdir(systemTmpdir());
import {join,resolve,sep} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {Worker} from 'node:worker_threads';
import {openNativeJubianAdmission,resolveNativeJubianAdmissionConfig} from './native-jubian-admission.mjs';
import {nativeJubianSourceCanonical,resolveNativeJubianSourcesConfig,NATIVE_JUBIAN_SOURCE_TABLES} from './native-jubian-sources.mjs';

const alice='aaaaaaaaaaaaaaaa',bob='bbbbbbbbbbbbbbbb',viewer='cccccccccccccccc';
const origin='https://supplier.invalid';
const sha=value=>createHash('sha256').update(typeof value==='string'?value:JSON.stringify(value)).digest('hex');
const context=(accountId=alice,session='initial')=>({accountId,sessionId:sha(accountId+session),deviceId:null});
const clone=value=>JSON.parse(JSON.stringify(value));
let networkCalls=0;const originalFetch=globalThis.fetch;
before(()=>{globalThis.fetch=()=>{networkCalls++;throw Error('source metadata tests prohibit network');};});
after(()=>{globalThis.fetch=originalFetch;assert.equal(networkCalls,0);});
const word=(suffix='')=>({kind:'word_pair',manuscript:{sha256:sha('word'+suffix),bytes:1234,name_sha256:sha('word-name')},
 original:{sha256:sha('original'+suffix),bytes:1024,name_sha256:sha('original-name')},declarations_sha256:sha('declarations'),catalogue_sha256:sha('catalogue')});
const descriptor=(operation='source',source={kind:'existing_manuscript',manuscript_id:71})=>({company_id:'company',provider_origin:origin,
 provider_connection_revision:sha('connection'),operation_id:operation,method:source.kind==='word_pair'?'manuscript_submit':'manual_project_create',source,plan_sha256:sha('plan'+operation)});
const sourcePolicy=()=>({version:1,revision:1,companies:[{companyId:'company',namespace:'trusted-provider',allowedOrigins:[origin],roles:['owner','admin','editor'],
 maxPendingSources:5,maxPendingSourcesPerMember:3,maxActiveEffects:5,maxActiveEffectsPerMember:3,newProjectMaxParallel:4}]});
const configuration=home=>({version:1,databaseFile:join(home,'native-source.sqlite'),busyTimeoutMs:10000,maxBatchItems:5,sources:sourcePolicy(),
 policy:{revision:1,companies:[{id:'company',limitMinor:100,maxParallel:10,members:[
  {accountId:alice,role:'owner',active:true,limitMinor:100,maxParallel:10},{accountId:bob,role:'editor',active:true,limitMinor:100,maxParallel:10},
  {accountId:viewer,role:'viewer',active:true,limitMinor:100,maxParallel:10}],
 projects:[{providerOrigin:origin,scriptId:61,active:true,limitMinor:100,maxParallel:10}]}]}});
function proof(canonical,domain,grantId=domain+'-'+sha(canonical)){
 return {domain,canonical_sha256:sha(canonical),grant_id:grantId};
}
function approvals(){
 const verify=(domain,actor,proof,expected)=>{
  if(proof?.domain!==domain||proof.canonical_sha256!==sha(expected))throw Object.assign(Error('fixture proof changed'),{code:'source_fixture_invalid_proof',status:403});
  assert.equal(expected.account_id,actor.accountId);assert.equal(expected.login_session_id,actor.sessionId);
  return {grant_id:proof.grant_id,issuer_id:sha('managed-issuer'),expires_at:2000000};
 };
 return {verifySourceConsent:(...args)=>verify('source-consent',...args),verifySourceManaged:(...args)=>verify('source-managed',...args),
  verify:(...args)=>verify('fee',...args),verifyBudget:(...args)=>verify('budget',...args)};
}
async function fixture(t,change=()=>{},nativeApprovals=approvals()){
 const home=await mkdtemp(join(tmpdir(),'muse-native-source-')),config=configuration(home),disabled=new Set(),stores=[],workers=[];
 change(config);const accounts={get:id=>[alice,bob,viewer].includes(id)?{id,disabled:disabled.has(id)}:undefined};
 const options={config,accounts,nativeApprovals,now:()=>1000000},service=await openNativeJubianAdmission(options);stores.push(service);
 t.after(async()=>{
  await Promise.all(workers.map(worker=>worker.terminate()));for(const store of stores)store.close();
  assert.equal(resolve(home).startsWith(resolve(tmpdir())+sep),true);await rm(home,{recursive:true,force:true});
 });
 const request=(input,actor=context(),store=service)=>store.request(actor,input);
 const reserve=(input=descriptor(),actor=context(),store=service)=>{
  const quoted=request({...input,type:'source_quote'},actor,store);
  if(quoted.canonical===undefined)return request({...input,type:'source_reserve'},actor,store);
  return request({...input,type:'source_reserve',managed_proof:proof(quoted.canonical,'source-managed'),
   ...input.source.kind==='word_pair'?{consent_proof:proof(quoted.canonical,'source-consent')}:{}},actor,store);
 };
 const effect=(input,kind,changes={})=>{
  const role=kind==='upload_manuscript'?'manuscript':'original',file=input.source[role];
  return {company_id:input.company_id,operation_id:input.operation_id,kind,request_sha256:sha(input.operation_id+kind),
   destination:kind.startsWith('upload_')?{object_key:'prod/sys-material-video/2026/11/17/'+sha(kind).slice(0,32)+'.docx',sha256:file.sha256,bytes:file.bytes}:null,...changes};
 };
 const signedEffect=(input,actor=context(),store=service)=>{
  const quoted=request({...input,type:'source_effect_quote'},actor,store);return {...input,managed_proof:proof(quoted.canonical,'source-managed')};
 };
 const dispatch=(input,actor=context(),store=service)=>{
  const signed=signedEffect(input,actor,store);request({...signed,type:'source_effect_reserve'},actor,store);
  return request({...signed,type:'source_effect_dispatch'},actor,store);
 };
 const observe=(input,receipt,actor=context(),store=service)=>{
  const quoted=request({...input,type:'source_effect_observation_quote',receipt},actor,store);
  if(quoted.canonical===undefined)return request({...input,type:'source_effect_observe',receipt},actor,store);
  return request({...input,type:'source_effect_observe',receipt,managed_proof:proof(quoted.canonical,'source-managed')},actor,store);
 };
 const rows=table=>{const db=new DatabaseSync(config.databaseFile,{readOnly:true});try{return db.prepare('SELECT * FROM '+table).all();}finally{db.close();}};
 return {home,config,options,service,stores,workers,disabled,request,reserve,effect,signedEffect,dispatch,observe,rows};
}
const uploadReceipt=input=>({kind:'upload',role:input.kind==='upload_manuscript'?'manuscript':'original',...input.destination});
const projectReceipt=(input,id=81)=>({kind:'project',script_id:id,manuscript_id:71,matched_request_sha256:input.request_sha256,readback_sha256:sha('project-readback'+id)});

test('source configuration is explicit, validates tunables and leaves existing company production available when disabled',async t=>{
 assert.equal(resolveNativeJubianSourcesConfig(undefined),undefined);
 for(const change of [value=>{value.revision=0;},value=>{value.companies[0].roles=['viewer'];},value=>{value.companies[0].maxPendingSources=0;},
  value=>{value.companies[0].allowedOrigins=['http://supplier.invalid'];},value=>{value.extra=true;}]){
  const value=sourcePolicy();change(value);assert.throws(()=>resolveNativeJubianSourcesConfig(value));
 }
 const f=await fixture(t,value=>{delete value.sources;});
 assert.equal(f.request({type:'policy',company_id:'company'}).projects.length,1);
 assert.throws(()=>f.reserve(),{code:'native_jubian_source_scope_unavailable'});
 assert.equal(f.rows('native_jubian_source_operations').length,0);
});

test('source configuration rejects a company referent absent from the trusted base policy before opening a database',()=>{
 const config=configuration(resolve(tmpdir(),'muse-source-config-validation'));
 config.sources.companies[0].companyId='missing-company';
 assert.throws(()=>resolveNativeJubianAdmissionConfig(config),{code:'native_jubian_admission_source_company_missing',status:500});
});

test('source consent and managed preflight are independent of fee proof and missing authority performs no writes',async t=>{
 const f=await fixture(t,()=>{},{}),input=descriptor('word',word()),quote=f.request({...input,type:'source_quote'});
 assert.equal(quote.managed_proof_available,false);assert.equal(quote.consent_available,false);
 assert.throws(()=>f.request({...input,type:'source_reserve',managed_proof:{approved:true},consent_proof:{approved:true}}),{code:'native_jubian_source_managed_proof_unavailable'});
 assert.equal(f.rows('native_jubian_source_operations').length,0);assert.equal(f.rows('native_jubian_source_effects').length,0);
 const denied=await fixture(t,()=>{},{...approvals(),verifySourceManaged(){throw Object.assign(Error('supplier role forbidden'),{code:'supplier_role_forbidden'});}});
 assert.throws(()=>denied.reserve(input),{code:'supplier_role_forbidden'});assert.equal(denied.rows('native_jubian_source_operations').length,0);
 const genuine=await fixture(t),quoted=genuine.request({...input,type:'source_quote'});
 const managed=proof(quoted.canonical,'source-managed');
 assert.throws(()=>genuine.request({...input,type:'source_reserve',managed_proof:managed,consent_proof:proof(quoted.canonical,'fee')}),{code:'source_fixture_invalid_proof'});
 assert.equal(genuine.rows('native_jubian_source_operations').length,0);assert.equal(genuine.rows('native_jubian_source_grants').length,0);
 let revoked=false;const authority=approvals(),roleChanged=await fixture(t,()=>{},{...authority,verifySourceManaged(...args){
  if(revoked)throw Object.assign(Error('supplier role forbidden'),{code:'supplier_role_forbidden'});return authority.verifySourceManaged(...args);
 }});
 const manual=descriptor();roleChanged.reserve(manual);revoked=true;
 const effect=roleChanged.effect(manual,'create_project'),signed=roleChanged.signedEffect(effect);
 assert.throws(()=>roleChanged.request({...signed,type:'source_effect_reserve'}),{code:'supplier_role_forbidden'});
 assert.equal(roleChanged.rows('native_jubian_source_effects').length,0);
});

test('source canonical normalization detaches exact signed fields and rejects purpose, identity and receipt drift',async t=>{
 const f=await fixture(t),input=descriptor('word',word()),quoted=f.request({...input,type:'source_quote'}),canonical=quoted.canonical;
 const detached=nativeJubianSourceCanonical(clone(canonical));assert.deepEqual(detached,canonical);assert.equal(Object.hasOwn(detached,'source_id'),false);
 detached.source.manuscript.bytes++;assert.notEqual(detached.source.manuscript.bytes,canonical.source.manuscript.bytes);
 for(const change of [value=>{value.source_id='random';},value=>{value.source.manuscript.extra=1;},value=>{value.account_id='forged';},
  value=>{value.purpose='source_observation';},value=>{value.source={kind:'existing_manuscript',manuscript_id:0};}]){
  const value=clone(canonical);change(value);assert.throws(()=>nativeJubianSourceCanonical(value));
 }
 f.reserve(input);const upload=f.effect(input,'upload_manuscript');f.dispatch(upload);
 const observation=f.request({...upload,type:'source_effect_observation_quote',receipt:uploadReceipt(upload)}).canonical;
 assert.deepEqual(nativeJubianSourceCanonical(clone(observation)),observation);
 const wrong=clone(observation);wrong.observation.receipt.role='original';assert.throws(()=>nativeJubianSourceCanonical(wrong));
 const fee=clone(observation);fee.purpose='source_effect';assert.throws(()=>nativeJubianSourceCanonical(fee));
});

test('source operations bind trusted members, exact source identities and current origin without accepting script or actor spoofing',async t=>{
 const f=await fixture(t),input=descriptor();
 assert.throws(()=>f.request({...input,type:'source_quote',script_id:0}),{code:'native_jubian_source_invalid_request'});
 assert.throws(()=>f.request({...input,type:'source_quote',actor_id:bob}),{code:'native_jubian_source_invalid_request'});
 assert.throws(()=>f.reserve(input,context(viewer)),{code:'native_jubian_source_scope_unavailable'});
 assert.throws(()=>f.reserve({...input,provider_origin:'https://other.invalid'}),{code:'native_jubian_source_origin_forbidden'});
 assert.throws(()=>f.reserve({...input,source:{kind:'existing_manuscript',manuscript_id:0}}),{code:'native_jubian_source_invalid_source'});
 const saved=f.reserve(input);assert.equal(saved.state,'open');
 assert.throws(()=>f.request({type:'source_status',company_id:'company',operation_id:input.operation_id},context(bob)),{code:'native_jubian_source_operation_forbidden'});
 assert.throws(()=>f.reserve({...input,provider_connection_revision:sha('another-token')}),{code:'native_jubian_source_operation_conflict'});
 assert.equal(f.request({type:'source_status',company_id:'company',operation_id:input.operation_id},context(alice,'relogin')).source_admission_id,saved.source_admission_id);
 f.disabled.add(alice);assert.throws(()=>f.request({type:'source_status',company_id:'company',operation_id:input.operation_id}),{code:'native_jubian_source_account_forbidden'});
});

test('independent Hosts cannot bypass source deduplication by changing operation, Token, plan or declaration hashes',async t=>{
 const f=await fixture(t),other=await openNativeJubianAdmission(f.options);f.stores.push(other);
 const first=descriptor('one',word());f.reserve(first);
 const changed={...descriptor('two',word()),provider_connection_revision:sha('other-token'),plan_sha256:sha('other-plan')};changed.source.declarations_sha256=sha('new-rights');
 assert.throws(()=>f.reserve(changed,context(bob),other),{code:'native_jubian_source_duplicate_source'});
 f.reserve(descriptor('manual'));
 assert.throws(()=>f.reserve(descriptor('manual-other'),context(bob),other),{code:'native_jubian_source_duplicate_source'});
 assert.equal(f.rows('native_jubian_source_operations').length,2);
 const replay=f.reserve(first);assert.equal(replay.replayed,true);
});

test('two worker Hosts contend for one logical source and leave exactly one source and one consumed managed grant',async t=>{
 const f=await fixture(t),ready=[],exit=[],out=[];
 const workerCode=`import{parentPort,workerData}from'node:worker_threads';import{createHash}from'node:crypto';import{openNativeJubianAdmission}from${JSON.stringify(new URL('./native-jubian-admission.mjs',import.meta.url).href)};
 const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');globalThis.fetch=()=>{throw Error('network forbidden');};
 const account=workerData.account,ctx={accountId:account,sessionId:'a'.repeat(64),deviceId:null};
 const service=await openNativeJubianAdmission({config:workerData.config,accounts:{get:id=>({id,disabled:false})},now:()=>1000000,nativeApprovals:{verifySourceManaged:(_actor,_proof,value)=>({grant_id:account+digest(value),issuer_id:'d'.repeat(64),expires_at:2000000})}});
 parentPort.postMessage({ready:true});parentPort.once('message',()=>{try{parentPort.postMessage({result:service.request(ctx,{...workerData.input,type:'source_reserve',managed_proof:{}})});}catch(error){parentPort.postMessage({code:error.code});}finally{service.close();parentPort.close();}});`;
 for(const [account,operation]of [[alice,'worker-a'],[bob,'worker-b']]){
  const worker=new Worker(new URL('data:text/javascript,'+encodeURIComponent(workerCode)),{workerData:{account,config:f.config,input:descriptor(operation)}});f.workers.push(worker);
  ready.push(new Promise((resolve,reject)=>{worker.on('message',message=>{if(message.ready)resolve();else out.push(message);});worker.once('error',reject);}));
  exit.push(new Promise((resolve,reject)=>{worker.once('exit',code=>code===0?resolve():reject(Error('worker exit '+code)));worker.once('error',reject);}));
 }
 await Promise.all(ready);for(const worker of f.workers)worker.postMessage('go');await Promise.all(exit);
 assert.equal(out.filter(value=>value.result?.state==='open').length,1);assert.equal(out.filter(value=>value.code==='native_jubian_source_duplicate_source').length,1);
 assert.equal(f.rows('native_jubian_source_operations').length,1);assert.equal(f.rows('native_jubian_source_grants').length,1);
});

test('upload permits are once-only, preserve unknown and bind each role to its original hash and distinct official object',async t=>{
 const f=await fixture(t),input=descriptor('word',word());f.reserve(input);
 const upload=f.effect(input,'upload_manuscript'),signed=f.signedEffect(upload);
 f.request({...signed,type:'source_effect_reserve'});
 const first=f.request({...signed,type:'source_effect_dispatch'});assert.equal(first.dispatch_allowed,true);assert.equal(first.state,'unknown');
 assert.equal(f.request({...signed,type:'source_effect_dispatch'}).dispatch_allowed,false);
 assert.equal(f.request({...signed,type:'source_effect_reserve'}).replayed,true);
 assert.throws(()=>f.request({...upload,type:'source_effect_quote',request_sha256:sha('changed')}),{code:'native_jubian_source_effect_conflict'});
 assert.throws(()=>f.request({...upload,type:'source_effect_quote',destination:{...upload.destination,sha256:sha('different-image')}}),{code:'native_jubian_source_upload_identity_conflict'});
 const original=f.effect(input,'upload_original');original.destination.object_key=upload.destination.object_key;
 assert.throws(()=>f.request({...original,type:'source_effect_quote'}),{code:'native_jubian_source_upload_destination_conflict'});
 assert.throws(()=>f.request({type:'source_cancel',company_id:'company',operation_id:input.operation_id}),{code:'native_jubian_source_effect_may_have_started'});
 const receipt=uploadReceipt(upload);
 assert.throws(()=>f.request({...upload,type:'source_effect_observe',receipt,managed_proof:{approved:true}}),{code:'source_fixture_invalid_proof'});
 assert.equal(f.rows('native_jubian_source_effects')[0].phase,'unknown');
 assert.equal(f.observe(upload,receipt).state,'confirmed');assert.equal(f.observe(upload,receipt).replayed,true);
 assert.equal(f.request({...signed,type:'source_effect_dispatch'}).dispatch_allowed,false);
});

test('a Word submission requires both verified uploaded files and preserves normal review rather than registering an approved project',async t=>{
 const f=await fixture(t),input=descriptor('word',word());f.reserve(input);const submit=f.effect(input,'submit_manuscript');
 assert.throws(()=>f.signedEffect(submit),{code:'native_jubian_source_uploads_unverified'});
 for(const kind of ['upload_manuscript','upload_original']){const upload=f.effect(input,kind);f.dispatch(upload);f.observe(upload,uploadReceipt(upload));}
 assert.equal(f.dispatch(submit).dispatch_allowed,true);
 const receipt={kind:'manuscript',manuscript_id:72,matched_plan_sha256:input.plan_sha256,readback_sha256:sha('real-author-readback')};
 assert.throws(()=>f.observe(submit,{...receipt,matched_plan_sha256:sha('unrelated')}),{code:'native_jubian_source_observation_conflict'});
 assert.equal(f.observe(submit,receipt).state,'confirmed');
 assert.equal(f.request({type:'source_status',company_id:'company',operation_id:input.operation_id}).state,'completed');
 assert.equal(f.rows('native_jubian_company_projects').length,0);
 assert.throws(()=>f.reserve({...input,operation_id:'resubmit'}),{code:'native_jubian_source_duplicate_source'});
 assert.equal(f.rows('native_jubian_source_effects').length,3);
});

test('a signed real project readback registers only the real remote ID with shared visibility, zero budget and preserved overrides',async t=>{
 const f=await fixture(t),input=descriptor();
 const change={company_id:'company',change_id:'existing-project-budget',target:{kind:'project',provider_origin:origin,script_id:61},new_limit_minor:50};
 const budget=f.request({...change,type:'budget_quote'}).canonical;
 f.request({...change,type:'budget_update',expected_revision:budget.target_revision,base_policy_revision:budget.base_policy_revision,budget_proof:proof(budget,'budget')});
 f.reserve(input);const create=f.effect(input,'create_project');f.dispatch(create);
 const receipt=projectReceipt(create);
 for(const wrong of [{...receipt,script_id:0},{...receipt,manuscript_id:72},{...receipt,matched_request_sha256:sha('other')}]){
  assert.throws(()=>f.observe(create,wrong),{code:'native_jubian_source_observation_conflict'});
 }
 assert.equal(f.rows('native_jubian_company_projects').length,0);f.observe(create,receipt);
 const policy=f.request({type:'policy',company_id:'company'},context(bob)),project=policy.projects.find(value=>value.script_id===receipt.script_id);
 assert.equal(policy.policy_revision,1);assert.equal(project.limit_minor,0);assert.equal(project.target_revision,0);assert.equal(project.max_parallel,4);
 assert.equal(policy.projects.find(value=>value.script_id===61).limit_minor,50);
 const request={company_id:'company',provider_origin:origin,script_id:81,operation_id:'new-shared-project',method:'asset_rename',
  provider_connection_revision:sha('token'),request_sha256:sha('rename'),quote_sha256:sha('free'),currency:'CNY',amount_minor:0,
  resources:[{kind:'asset',id:1}],policy_revision:1};
 assert.equal(f.request({...request,type:'reserve',attempt_id:'free'},context(bob)).state,'reserved');
 assert.equal(f.request({type:'budget_quote',company_id:'company',change_id:'raise-new-project',target:{kind:'project',provider_origin:origin,script_id:81},new_limit_minor:40},context(bob)).canonical.previous_limit_minor,0);
 const row=f.rows('native_jubian_company_projects')[0];assert.equal(row.manuscript_id,71);
 const serialized=JSON.stringify(row);assert.equal(serialized.includes('manuscript bytes'),false);assert.equal(serialized.includes('Token'),false);
});

test('a project observation never replaces an existing configured project or its allowance and rolls back its grant',async t=>{
 const f=await fixture(t),input=descriptor();f.reserve(input);const create=f.effect(input,'create_project');f.dispatch(create);
 const grants=f.rows('native_jubian_source_grants').length;
 assert.throws(()=>f.observe(create,projectReceipt(create,61)),{code:'native_jubian_source_project_registry_conflict'});
 assert.equal(f.rows('native_jubian_source_grants').length,grants);assert.equal(f.rows('native_jubian_company_projects').length,0);
 assert.equal(f.rows('native_jubian_source_effects')[0].phase,'unknown');
 assert.equal(f.request({type:'policy',company_id:'company'}).projects[0].limit_minor,100);
});

test('historical observations recover after relogin and source disablement, while new writes stop and the registered directory persists',async t=>{
 const f=await fixture(t),input=descriptor();f.reserve(input);const create=f.effect(input,'create_project');f.dispatch(create);f.service.close();
 const disabledConfig=clone(f.config);delete disabledConfig.sources;
 const reopened=await openNativeJubianAdmission({...f.options,config:disabledConfig});f.stores.push(reopened);
 assert.equal(f.request({type:'source_status',company_id:'company',operation_id:input.operation_id},context(alice,'second'),reopened).effects[0].state,'unknown');
 assert.throws(()=>f.request({...create,type:'source_effect_dispatch'},context(alice,'second'),reopened),{code:'native_jubian_source_scope_unavailable'});
 assert.equal(f.observe(create,projectReceipt(create),context(alice,'second'),reopened).state,'confirmed');
 assert.equal(f.request({type:'policy',company_id:'company'},context(bob),reopened).projects.find(value=>value.script_id===81).limit_minor,0);
 assert.throws(()=>f.reserve(descriptor('new',{kind:'existing_manuscript',manuscript_id:73}),context(),reopened),{code:'native_jubian_source_scope_unavailable'});
 const row=f.rows('native_jubian_admission_audit').find(value=>value.event==='source-observed');assert.equal(row.session_id,context(alice,'second').sessionId);
});

test('predispatch cancellation frees only pending source capacity and keeps immutable actor, consent and original source records',async t=>{
 const f=await fixture(t,value=>{value.sources.companies[0].maxPendingSources=1;}),input=descriptor();f.reserve(input);
 const effect=f.effect(input,'create_project'),signed=f.signedEffect(effect);f.request({...signed,type:'source_effect_reserve'});
 assert.throws(()=>f.reserve(descriptor('different',{kind:'existing_manuscript',manuscript_id:72})),{code:'native_jubian_source_capacity'});
 const result=f.request({type:'source_cancel',company_id:'company',operation_id:input.operation_id});assert.equal(result.state,'cancelled');
 assert.equal(f.rows('native_jubian_source_effects')[0].phase,'cancelled');
 assert.throws(()=>f.request({...signed,type:'source_effect_dispatch'}),{code:'native_jubian_source_cancelled'});
 assert.equal(f.reserve({...input,operation_id:'new-attempt'}).state,'open');
 assert.equal(f.rows('native_jubian_source_operations').length,2);assert.equal(f.rows('native_jubian_source_grants').length,3);
 const db=new DatabaseSync(f.config.databaseFile);try{assert.throws(()=>db.prepare('DELETE FROM native_jubian_source_grants').run(),/immutable/);}finally{db.close();}
});

test('schema v2 migration adds source and queue tables, preserves every original operation and budget row and refuses a future schema unchanged',async t=>{
 const f=await fixture(t),paid={company_id:'company',provider_origin:origin,script_id:61,operation_id:'old-generation',method:'storyboard_native_submit',
  provider_connection_revision:sha('old-connection'),request_sha256:sha('old-request'),quote_sha256:sha('old-quote'),currency:'CNY',amount_minor:10,
  resources:[{kind:'card',id:1}],policy_revision:1};
 const quote=f.request({...paid,type:'quote'}),fee=proof(quote.canonical,'fee'),saved=f.request({...paid,type:'reserve',attempt_id:'original',approval_proof:fee});
 f.request({...paid,type:'dispatch',attempt_id:'original',admission_id:saved.admission_id,approval_proof:fee});
 const change={company_id:'company',change_id:'old-project-budget',target:{kind:'project',provider_origin:origin,script_id:61},new_limit_minor:50};
 const budget=f.request({...change,type:'budget_quote'}).canonical;
 f.request({...change,type:'budget_update',expected_revision:budget.target_revision,base_policy_revision:budget.base_policy_revision,budget_proof:proof(budget,'budget')});
 f.service.close();const db=new DatabaseSync(f.config.databaseFile);
 for(const table of ['native_jubian_admission_queue_cursors','native_jubian_admission_queue','native_jubian_company_projects','native_jubian_source_grants','native_jubian_source_effects','native_jubian_source_operations'])db.exec('DROP TABLE '+table);
 db.exec('UPDATE native_jubian_admission_meta SET version=2');
 const before={};for(const {name}of db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name!='native_jubian_admission_meta'").all())before[name]=db.prepare('SELECT * FROM '+name).all();
 db.close();const migrated=await openNativeJubianAdmission(f.options);f.stores.push(migrated);
 const after=new DatabaseSync(f.config.databaseFile);try{
  assert.equal(after.prepare('SELECT version FROM native_jubian_admission_meta').get().version,4);
  for(const [table,rows]of Object.entries(before))assert.deepEqual(after.prepare('SELECT * FROM '+table).all(),rows);
  for(const table of NATIVE_JUBIAN_SOURCE_TABLES)assert.equal(after.prepare('SELECT COUNT(*) AS count FROM '+table).get().count,0);
 }finally{after.close();}
 assert.equal(f.request({...paid,type:'status'},context(),migrated).state,'unknown');
 const policy=f.request({type:'policy',company_id:'company'},context(),migrated);
 assert.equal(policy.company_held_minor,10);assert.equal(policy.projects[0].limit_minor,50);
 migrated.close();const future=new DatabaseSync(f.config.databaseFile);future.exec('UPDATE native_jubian_admission_meta SET version=999');future.close();
 await assert.rejects(openNativeJubianAdmission(f.options),{code:'native_jubian_admission_unsupported_schema'});
 const unchanged=new DatabaseSync(f.config.databaseFile,{readOnly:true});try{assert.equal(unchanged.prepare('SELECT version FROM native_jubian_admission_meta').get().version,999);}finally{unchanged.close();}
});

test('schema v3 migration retains populated source effects, registered projects, grants, budgets and unknown paid work exactly',async t=>{
 const f=await fixture(t),wordSource=descriptor('old-word-unknown',word('migration'));f.reserve(wordSource);
 const upload=f.effect(wordSource,'upload_manuscript');f.dispatch(upload);
 const original=descriptor('old-registered-source');f.reserve(original);const create=f.effect(original,'create_project');
 f.dispatch(create);f.observe(create,projectReceipt(create));
 const change={company_id:'company',change_id:'old-source-project-budget',target:{kind:'project',provider_origin:origin,script_id:81},new_limit_minor:60},
  budget=f.request({...change,type:'budget_quote'}).canonical;
 f.request({...change,type:'budget_update',expected_revision:budget.target_revision,base_policy_revision:budget.base_policy_revision,budget_proof:proof(budget,'budget')});
 const paid={company_id:'company',provider_origin:origin,script_id:81,operation_id:'old-project-generation',method:'storyboard_native_submit',
  provider_connection_revision:sha('old-token'),request_sha256:sha('old-body'),quote_sha256:sha('old-price'),currency:'CNY',amount_minor:20,
  resources:[{kind:'card',id:4}],policy_revision:1},fee=proof(f.request({...paid,type:'quote'}).canonical,'fee'),
  reserved=f.request({...paid,type:'reserve',attempt_id:'original',approval_proof:fee});
 f.request({...paid,type:'dispatch',attempt_id:'original',admission_id:reserved.admission_id,approval_proof:fee});f.service.close();
 const old=new DatabaseSync(f.config.databaseFile);old.exec('DROP TABLE native_jubian_admission_queue_cursors;DROP TABLE native_jubian_admission_queue;UPDATE native_jubian_admission_meta SET version=3');
 const names=old.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name<>'native_jubian_admission_meta'").all().map(row=>row.name),
  before=Object.fromEntries(names.map(name=>[name,old.prepare('SELECT * FROM '+name).all()]));old.close();
 for(const name of NATIVE_JUBIAN_SOURCE_TABLES)assert.ok(before[name].length>0,name+' must contain real source history');
 assert.ok(before.native_jubian_admission_budget_changes.length>0);assert.ok(before.native_jubian_admission_grants.length>0);
 const restored=await openNativeJubianAdmission(f.options);f.stores.push(restored);
 const after=new DatabaseSync(f.config.databaseFile,{readOnly:true});try{
  assert.equal(after.prepare('SELECT version FROM native_jubian_admission_meta').get().version,4);
  for(const [name,rows]of Object.entries(before))assert.deepEqual(after.prepare('SELECT * FROM '+name).all(),rows,name);
 }finally{after.close();}
 assert.equal(f.request({...paid,type:'status'},context(alice,'renewed'),restored).state,'unknown');
 const status=f.request({type:'source_status',company_id:'company',operation_id:wordSource.operation_id},context(alice,'renewed'),restored);
 assert.equal(status.effects[0].state,'unknown');
 const policy=f.request({type:'policy',company_id:'company'},context(bob),restored);
 assert.equal(policy.projects.find(project=>project.script_id===81).limit_minor,60);assert.equal(policy.company_held_minor,20);
});

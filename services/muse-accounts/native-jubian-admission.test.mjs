/** Private SQLite and independent worker connections exercise admission without supplier traffic. */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir as systemTmpdir} from 'node:os';
import {realpathSync as realpathOfTmpdir} from 'node:fs';
// Private-directory checks compare real paths; the system temp directory can be reached through a link (macOS /var).
const tmpdir=()=>realpathOfTmpdir(systemTmpdir());
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {Worker} from 'node:worker_threads';
import {openNativeJubianAdmission,resolveNativeJubianAdmissionConfig} from './native-jubian-admission.mjs';

const alice='aaaaaaaaaaaaaaaa',bob='bbbbbbbbbbbbbbbb',viewer='cccccccccccccccc';
const origin='https://web.jubianai.net',sha=value=>createHash('sha256').update(typeof value==='string'?value:JSON.stringify(value)).digest('hex');
const context=(accountId=alice,session='first')=>({accountId,sessionId:sha(accountId+session),deviceId:null});
function configuration(home){return {version:1,databaseFile:join(home,'native-jubian.sqlite'),busyTimeoutMs:10000,maxBatchItems:5,
 policy:{revision:1,companies:[{id:'company',limitMinor:100,maxParallel:10,members:[
  {accountId:alice,role:'owner',active:true,limitMinor:100,maxParallel:10},
  {accountId:bob,role:'editor',active:true,limitMinor:100,maxParallel:10},
  {accountId:viewer,role:'viewer',active:true,limitMinor:100,maxParallel:10},
 ],projects:[{providerOrigin:origin,scriptId:6613,active:true,limitMinor:100,maxParallel:10},
  {providerOrigin:origin,scriptId:4660,active:true,limitMinor:100,maxParallel:10}]}]}};}
function common(operation='one',changes={}){return {company_id:'company',provider_origin:origin,script_id:6613,
 operation_id:operation,method:'storyboard_native_submit',provider_connection_revision:'c'.repeat(64),request_sha256:sha(operation),
 quote_sha256:sha('quote-'+operation),currency:'CNY',amount_minor:40,resources:[{kind:'card',id:1}],policy_revision:1,...changes};}
function nativeVerifier(){return {verify(actor,proof,expected){
 if(proof?.signature!=='test-native-user-signature'||proof.canonical_sha256!==sha(expected))throw Object.assign(Error('native proof mismatch'),{code:'production_fee_grant_changed',status:403});
 assert.equal(expected.account_id,actor.accountId);assert.equal(expected.login_session_id,actor.sessionId);
 return {grant_id:proof.grant_id,issuer_id:'d'.repeat(64),expires_at:proof.expires_at};
},verifyObservation(actor,proof,expected){
 if(proof?.signature!=='test-host-observation-signature'||proof.canonical_sha256!==sha(expected))throw Object.assign(Error('observation proof mismatch'),{code:'native_jubian_invalid_observation_proof',status:403});
 assert.equal(expected.account_id,actor.accountId);assert.equal(expected.login_session_id,actor.sessionId);
 return {grant_id:proof.grant_id,issuer_id:'d'.repeat(64),expires_at:proof.expires_at};
},verifyBudget(actor,proof,expected){
 if(proof?.signature!=='test-native-budget-signature'||proof.canonical_sha256!==sha(expected))throw Object.assign(Error('budget proof mismatch'),{code:'native_jubian_invalid_budget_proof',status:403});
 assert.equal(expected.account_id,actor.accountId);assert.equal(expected.login_session_id,actor.sessionId);
 return {grant_id:proof.grant_id,issuer_id:'d'.repeat(64),expires_at:proof.expires_at};
}};}
async function fixture(t,change=()=>{},native=true){
 const home=await mkdtemp(join(tmpdir(),'muse-native-jubian-admission-')),config=configuration(home);change(config);
 const disabled=new Set(),accounts={get:id=>[alice,bob,viewer].includes(id)?{id,disabled:disabled.has(id)}:undefined};
 const stores=[],workers=[];let clock=1000000;
 const options={config,accounts,now:()=>clock,...native?{nativeApprovals:nativeVerifier()}:{}};
 const service=await openNativeJubianAdmission(options);stores.push(service);
 t.after(async()=>{await Promise.all(workers.map(worker=>worker.terminate()));for(const store of stores)store.close();await rm(home,{recursive:true,force:true});});
 const signed=(input,actor=context(),suffix='original')=>{
  const quote=service.request(actor,{...input,type:'quote'});
  return {...input,type:'reserve',attempt_id:'attempt-'+input.operation_id,approval_proof:{signature:'test-native-user-signature',
   canonical_sha256:sha(quote.canonical),grant_id:actor.accountId+input.operation_id+suffix,expires_at:clock+60000}};
 };
 const phase=(type,request,saved,extras={})=>{const {type:old,approval_proof,attempt_id,...fields}=request;return {...fields,type,attempt_id,
  admission_id:saved.admission_id,...type==='dispatch'?{approval_proof}:{},...extras};};
 const observed=(store,value,actor=context())=>{
  const {type,observation_proof,...input}=value,quoted=store.request(actor,{...input,type:'observation_quote'});
  return {...value,observation_proof:{signature:'test-host-observation-signature',canonical_sha256:sha(quoted.canonical),
   grant_id:'observation-'+value.operation_id+'-'+sha(value.observation_sha256),expires_at:clock+60000}};
 };
 const budgetSigned=(value,actor=context(),store=service)=>{
  const quoted=store.request(actor,{...value,type:'budget_quote'});
  return {...value,type:'budget_update',expected_revision:quoted.canonical.target_revision,base_policy_revision:quoted.canonical.base_policy_revision,
   budget_proof:{signature:'test-native-budget-signature',canonical_sha256:sha(quoted.canonical),grant_id:'budget-'+value.change_id,expires_at:clock+60000}};
 };
 return {home,config,accounts,service,disabled,stores,workers,options,signed,phase,observed,budgetSigned,setClock:value=>{clock=value;}};
}

const budgetChange=(change_id,new_limit_minor,target={kind:'member',account_id:alice})=>({company_id:'company',change_id,target,new_limit_minor});

test('only explicit free metadata bypasses native proof and paid zero quotes still require a genuine native grant',async t=>{
 const f=await fixture(t,()=>{},false),zero=common('paid-zero',{amount_minor:0});
 const quote=f.service.request(context(),{...zero,type:'quote'});assert.equal(quote.native_approval_required,true);assert.equal(quote.native_approval_available,false);
 assert.throws(()=>f.service.request(context(),{...zero,type:'reserve',attempt_id:'original'}),{code:'native_jubian_admission_native_approval_unavailable'});
 const free=common('rename',{method:'asset_rename',amount_minor:0,resources:[{kind:'asset',id:21}]}),saved=f.service.request(context(),{...free,type:'reserve',attempt_id:'free'});
 assert.equal(saved.state,'reserved');assert.equal(f.service.request(context(),{...free,type:'dispatch',attempt_id:'free',admission_id:saved.admission_id}).dispatch_allowed,true);
 assert.throws(()=>f.service.request(context(),{...free,type:'quote',method:'any_supplier_endpoint'}),{code:'native_jubian_admission_invalid_request'});
 assert.throws(()=>f.service.request(context(),{...free,type:'quote',amount_minor:1}),{code:'native_jubian_admission_free_method_amount_must_be_zero'});
});

test('a reference-image object upload is free but reserves only its real asset and never authorizes material registration',async t=>{
 const f=await fixture(t),upload=common('image-object-upload',{method:'asset_reference_upload',amount_minor:0,resources:[{kind:'asset',id:21}]});
 const quoted=f.service.request(context(),{...upload,type:'quote'});assert.equal(quoted.native_approval_required,false);
 for(const resources of [[{kind:'card',id:21}],[{kind:'project',id:6613}],
  [{kind:'asset',id:21},{kind:'asset',id:22}],[{kind:'draft_asset',id:'a'.repeat(64)}]]){
  assert.throws(()=>f.service.request(context(),{...upload,type:'quote',resources}),{code:'native_jubian_admission_invalid_resource'});
 }
 assert.throws(()=>f.service.request(context(),{...upload,type:'quote',amount_minor:1}),{code:'native_jubian_admission_free_method_amount_must_be_zero'});
 const reserved=f.service.request(context(),{...upload,type:'reserve',attempt_id:'upload-original'});
 const permit=f.service.request(context(),{...upload,type:'dispatch',attempt_id:'upload-original',admission_id:reserved.admission_id});
 assert.equal(permit.dispatch_allowed,true);assert.equal(permit.state,'unknown');
 const altered={...upload,type:'dispatch',attempt_id:'upload-original',admission_id:reserved.admission_id,method:'asset_material_register'};
 assert.throws(()=>f.service.request(context(),altered),{code:'native_jubian_admission_operation_conflict'});
 assert.equal(f.service.request(context(),{...upload,type:'dispatch',attempt_id:'upload-original',admission_id:reserved.admission_id}).dispatch_allowed,false);
});

test('audio object uploads and new audio parents have independent zero-cost resource admissions',async t=>{
 const f=await fixture(t),upload=common('audio-object',{method:'audio_reference_upload',amount_minor:0,
  resources:[{kind:'storage_object',id:'0'.repeat(64)}]}),register=common('audio-parent',{method:'audio_asset_register',amount_minor:0,
  resources:[{kind:'draft_asset',id:'0'.repeat(64)}]});
 for(const request of [upload,register]){
  assert.equal(f.service.request(context(),{...request,type:'quote'}).native_approval_required,false);
  assert.throws(()=>f.service.request(context(viewer),{...request,type:'reserve',attempt_id:'viewer'}),{code:'native_jubian_admission_member_forbidden'});
  assert.throws(()=>f.service.request(context(),{...request,type:'reserve',attempt_id:'charged',amount_minor:1}),
   {code:'native_jubian_admission_free_method_amount_must_be_zero'});
  for(const resources of [[{kind:'project',id:6613}],[{kind:'asset',id:21}],
   [{kind:request.resources[0].kind,id:21}],[{kind:request.resources[0].kind,id:'not-a-hash'}],
   [request.resources[0],request.resources[0]]]){
   assert.throws(()=>f.service.request(context(),{...request,type:'quote',resources}),{code:'native_jubian_admission_invalid_resource'});
  }
 }
 const first=f.service.request(context(),{...upload,type:'reserve',attempt_id:'upload-original'});
 const parent=f.service.request(context(),{...register,type:'reserve',attempt_id:'register-original'});
 assert.equal(first.state,'reserved');assert.equal(parent.state,'reserved');
 assert.throws(()=>f.service.request(context(bob),{...upload,operation_id:'other-object',type:'reserve',attempt_id:'other'}),
  {code:'native_jubian_admission_resource_busy'});
 const unrelated=f.service.request(context(bob),{...upload,operation_id:'independent-object',type:'reserve',attempt_id:'independent',
  resources:[{kind:'storage_object',id:'1'.repeat(64)}]});
 assert.equal(unrelated.state,'reserved');
 const dispatch={...upload,type:'dispatch',attempt_id:'upload-original',admission_id:first.admission_id};
 assert.equal(f.service.request(context(),dispatch).dispatch_allowed,true);
 assert.equal(f.service.request(context(),dispatch).dispatch_allowed,false);
 assert.throws(()=>f.service.request(context(),{...dispatch,request_sha256:'f'.repeat(64)}),{code:'native_jubian_admission_operation_conflict'});
 f.setClock(86400000);f.service.close();const reopened=await openNativeJubianAdmission(f.options);f.stores.push(reopened);
 const stored=reopened.request(context(),{...upload,type:'status'});
 assert.equal(stored.state,'unknown');assert.deepEqual(stored.descriptor.resources,upload.resources);
 assert.throws(()=>reopened.request(context(bob),{...upload,operation_id:'after-restart-object',type:'reserve',attempt_id:'other'}),
  {code:'native_jubian_admission_resource_busy'});
 const unsigned={...upload,type:'settle',attempt_id:'upload-original',admission_id:first.admission_id,state:'completed',observation_sha256:sha('object-bytes')};
 assert.throws(()=>reopened.request(context(),unsigned),{code:'native_jubian_invalid_observation_proof'});
 const completed=reopened.request(context(),f.observed(reopened,unsigned));assert.equal(completed.state,'completed');
 assert.equal(completed.amount_minor,0);
});

test('audio-only logical resources cannot admit generation or other metadata methods',async t=>{
 const f=await fixture(t),base=common('wrong-storage-kind',{resources:[{kind:'storage_object',id:'a'.repeat(64)}]});
 for(const method of ['image_generate','audio_generate','storyboard_native_submit','video_upscale','erase_subtitle','asset_reference_upload','asset_material_register']){
  assert.throws(()=>f.service.request(context(),{...base,type:'quote',method,amount_minor:0}),{code:'native_jubian_admission_invalid_resource'});
 }
 for(const [method,kind]of [['audio_reference_upload','draft_asset'],['audio_asset_register','storage_object']]){
  assert.throws(()=>f.service.request(context(),{...base,type:'quote',method,amount_minor:0,resources:[{kind,id:'a'.repeat(64)}]}),
   {code:'native_jubian_admission_invalid_resource'});
 }
});

test('audio generation holds its exact parent and CNY quote until a signed terminal observation without a second dispatch',async t=>{
 const f=await fixture(t),audio=common('voice-original',{method:'audio_generate',amount_minor:100,resources:[{kind:'asset',id:84}]}),
  request=f.signed(audio),reserved=f.service.request(context(),request);
 assert.equal(reserved.state,'reserved');
 assert.equal(f.service.request(context(),f.phase('dispatch',request,reserved)).dispatch_allowed,true);
 assert.equal(f.service.request(context(),f.phase('dispatch',request,reserved)).dispatch_allowed,false);
 assert.throws(()=>f.service.request(context(),{...request,method:'image_generate'}),{code:'native_jubian_admission_operation_conflict'});
 assert.throws(()=>f.service.request(context(),f.phase('cancel',request,reserved,{reason:'not_dispatched'})),{code:'native_jubian_admission_dispatch_may_have_started'});
 const terminal=f.phase('settle',request,reserved,{state:'completed',observation_sha256:sha('actual-audio-task-and-material')});
 assert.throws(()=>f.service.request(context(),terminal),{code:'native_jubian_invalid_observation_proof'});
 assert.equal(f.service.request(context(),{...audio,type:'status'}).state,'unknown');
 assert.equal(f.service.request(context(),f.observed(f.service,terminal)).state,'completed');
 const after=f.service.request(context(),{...common('after-audio',{amount_minor:1,resources:[{kind:'card',id:2}]}),type:'quote'});
 assert.equal(after.available_minor,0);assert.equal(after.scopes.company.used_minor,100);assert.equal(after.scopes.company.held_minor,0);
 const zero=common('zero-audio',{method:'audio_generate',amount_minor:0,resources:[{kind:'asset',id:85}]});
 assert.equal(f.service.request(context(),{...zero,type:'quote'}).native_approval_required,true);
 assert.throws(()=>f.service.request(context(),{...zero,type:'reserve',attempt_id:'zero'}),{code:'production_fee_grant_changed'});
});

test('a new voice uses an exclusive draft hash and neither an image proof nor a claimed asset ID can replace it',async t=>{
 const f=await fixture(t),identity=sha('assetType4:formal-voice-name'),audio=common('new-voice',{method:'audio_generate',amount_minor:20,
  resources:[{kind:'draft_asset',id:identity}]}),request=f.signed(audio),reserved=f.service.request(context(),request);
 assert.equal(reserved.descriptor.resources[0].id,identity);
 const same=f.signed({...audio,operation_id:'other-host-voice'},context(bob));
 assert.throws(()=>f.service.request(context(bob),same),{code:'native_jubian_admission_resource_busy'});
 for(const resources of [[{kind:'draft_asset',id:4}],[{kind:'draft_asset',id:'bad'}],
  [{kind:'draft_asset',id:identity},{kind:'asset',id:84}]]){
  assert.throws(()=>f.service.request(context(),{...audio,type:'quote',resources}),{code:'native_jubian_admission_invalid_resource'});
 }
 assert.throws(()=>f.service.request(context(),{...request,resources:[{kind:'asset',id:84}]}),{code:'native_jubian_admission_operation_conflict'});
 const image=f.signed({...audio,operation_id:'another-new-voice',method:'image_generate',resources:[{kind:'draft_asset',id:sha('another-draft')}]});
 assert.throws(()=>f.service.request(context(),{...image,method:'audio_generate'}),{code:'production_fee_grant_changed'});
});

test('a company policy read exposes only the authenticated member and shared supplier project allowances',async t=>{
 const f=await fixture(t),value=f.service.request(context(viewer),{type:'policy',company_id:'company'});
 assert.equal(value.policy_revision,1);assert.equal(value.currency,'CNY');assert.equal(value.role,'viewer');assert.equal(value.company_limit_minor,100);
 assert.equal(value.projects.length,2);assert.equal(value.projects[0].provider_origin,origin);assert.equal(value.projects[0].active,true);
 assert.equal(value.projects[0].active_count,0);assert.equal(Object.hasOwn(value,'members'),false);
 assert.equal(JSON.stringify(value).includes(alice),false);
 assert.throws(()=>f.service.request(context(viewer),{type:'policy',company_id:'other-company'}),{code:'native_jubian_admission_member_forbidden'});
 assert.throws(()=>f.service.request(context(viewer),{type:'policy',company_id:'company',actor_id:alice}),{code:'native_jubian_admission_invalid_request'});
 assert.throws(()=>f.service.request(context(viewer),{...common(),type:'reserve',attempt_id:'viewer'}),{code:'native_jubian_admission_member_forbidden'});
});

test('company member and real remote-project money limits are reserved together',async t=>{
 const f=await fixture(t,config=>{const company=config.policy.companies[0];company.members[0].limitMinor=60;company.projects[0].limitMinor=50;});
 f.service.request(context(),f.signed(common()));
 assert.equal(f.service.request(context(),{...common('inspect',{resources:[{kind:'card',id:9}]}),type:'quote'}).available_minor,10);
 assert.throws(()=>f.service.request(context(),f.signed(common('project-full',{amount_minor:11,resources:[{kind:'card',id:2}]}))),{code:'native_jubian_admission_budget_exceeded'});
 assert.throws(()=>f.service.request(context(),f.signed(common('member-full',{script_id:4660,amount_minor:21,resources:[{kind:'card',id:2}]}))),{code:'native_jubian_admission_budget_exceeded'});
 f.service.request(context(bob),f.signed(common('bob',{script_id:4660,amount_minor:60,resources:[{kind:'card',id:3}]}),context(bob)));
 assert.equal(f.service.request(context(),{...common('company-full',{script_id:4660,amount_minor:1,resources:[{kind:'card',id:4}]}),type:'quote'}).available_minor,0);
});

test('one operation binds payload price provider connection and resources and never permits a second dispatch',async t=>{
 const f=await fixture(t),request=f.signed(common()),saved=f.service.request(context(),request);
 assert.equal(f.service.request(context(),request).allowed,false);assert.equal(f.service.request(context(),request).replayed,true);
 for(const change of [{request_sha256:'f'.repeat(64)},{amount_minor:39},{resources:[{kind:'card',id:2}]},{provider_connection_revision:'e'.repeat(64)}])
  assert.throws(()=>f.service.request(context(),{...request,...change}),{code:'native_jubian_admission_operation_conflict'});
 const dispatch=f.phase('dispatch',request,saved);assert.equal(f.service.request(context(),dispatch).dispatch_allowed,true);
 assert.equal(f.service.request(context(),dispatch).dispatch_allowed,false);
 assert.throws(()=>f.service.request(context(),f.phase('cancel',request,saved,{reason:'not_dispatched'})),{code:'native_jubian_admission_dispatch_may_have_started'});
});

test('pre-dispatch cancellation restores money and capacity once while preserving immutable audit and grants',async t=>{
 const f=await fixture(t,config=>{config.policy.companies[0].projects[0].maxParallel=1;}),request=f.signed(common()),saved=f.service.request(context(),request);
 assert.throws(()=>f.service.request(context(),f.signed(common('other',{resources:[{kind:'card',id:2}]}))),{code:'native_jubian_admission_capacity_exceeded'});
 const cancel=f.phase('cancel',request,saved,{reason:'not_dispatched'});assert.equal(f.service.request(context(),cancel).state,'cancelled');assert.equal(f.service.request(context(),cancel).replayed,true);
 assert.equal(f.service.request(context(),f.signed(common('fresh'))).state,'reserved');
 const db=new DatabaseSync(f.config.databaseFile);try{
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM native_jubian_admission_operations WHERE phase='cancelled'").get().count,1);
  const row=db.prepare("SELECT * FROM native_jubian_admission_audit WHERE event='cancelled'").get();assert.equal(row.actor_id,alice);assert.equal(row.session_id,context().sessionId);assert.equal(row.device_id,null);
  assert.throws(()=>db.prepare('DELETE FROM native_jubian_admission_audit').run(),/immutable/);
  assert.throws(()=>db.prepare("UPDATE native_jubian_admission_grants SET issuer_id='edited'").run(),/immutable/);
 }finally{db.close();}
});

test('unknown outcomes retain money and resource locks through restart and expiry while terminal results retain cost',async t=>{
 const f=await fixture(t),request=f.signed(common()),saved=f.service.request(context(),request);
 f.service.request(context(),f.phase('dispatch',request,saved));f.setClock(999999999);f.service.close();
 const restored=await openNativeJubianAdmission(f.options);f.stores.push(restored);
 assert.equal(restored.request(context(alice,'relogin'),{...common(),type:'status'}).state,'unknown');
 assert.equal(restored.request(context(),{...common('availability',{resources:[{kind:'card',id:5}]}),type:'quote'}).scopes.company.held_minor,40);
 assert.throws(()=>restored.request(context(),f.phase('cancel',request,saved,{reason:'not_dispatched'})),{code:'native_jubian_admission_dispatch_may_have_started'});
 const terminal=f.phase('settle',request,saved,{state:'failed',observation_sha256:sha('supplier-original-task')});
 assert.equal(restored.request(context(),f.observed(restored,terminal)).state,'failed');
 const available=restored.request(context(),{...common('after',{resources:[{kind:'card',id:1}]}),type:'quote'});
 assert.equal(available.available_minor,60);assert.equal(available.scopes.company.held_minor,0);assert.equal(available.resource_ready,true);
 assert.throws(()=>restored.request(context(),f.phase('settle',request,saved,{state:'completed',observation_sha256:sha('contradiction')})),{code:'native_jubian_admission_terminal_conflict'});
});

test('raw terminal state and hash cannot release even a zero-cost metadata operation without a trusted observation authority',async t=>{
 const f=await fixture(t,()=>{},false),input=common('free-original',{method:'asset_rename',amount_minor:0,resources:[{kind:'asset',id:4}]}),
  request={...input,type:'reserve',attempt_id:'original'},saved=f.service.request(context(),request);
 f.service.request(context(),f.phase('dispatch',request,saved));
 const terminal=f.phase('settle',request,saved,{state:'completed',observation_sha256:sha('claimed-result')});
 const {type,...fields}=terminal,quoted=f.service.request(context(),{...fields,type:'observation_quote'});
 assert.equal(quoted.observation_approval_available,false);assert.equal(quoted.canonical.operation_actor_id,alice);
 assert.throws(()=>f.service.request(context(),terminal),{code:'native_jubian_admission_observation_approval_unavailable'});
 assert.equal(f.service.request(context(),{...input,type:'status'}).state,'unknown');
 assert.equal(f.service.request(context(),{...common('another',{method:'asset_rename',amount_minor:0,resources:[{kind:'asset',id:4}]}),type:'quote'}).resource_ready,false);
});

test('expense approval signatures cannot attest observations and missing or altered evidence keeps the original hold',async t=>{
 const f=await fixture(t),request=f.signed(common()),saved=f.service.request(context(),request);f.service.request(context(),f.phase('dispatch',request,saved));
 const terminal=f.phase('settle',request,saved,{state:'completed',observation_sha256:sha('real-original-task')});
 assert.throws(()=>f.service.request(context(),terminal),{code:'native_jubian_invalid_observation_proof'});
 assert.throws(()=>f.service.request(context(),{...terminal,observation_proof:request.approval_proof}),{code:'native_jubian_invalid_observation_proof'});
 const attested=f.observed(f.service,terminal);
 assert.throws(()=>f.service.request(context(),{...attested,observation_sha256:sha('substituted')}),{code:'native_jubian_invalid_observation_proof'});
 assert.throws(()=>f.service.request(context(),{...attested,state:'failed'}),{code:'native_jubian_invalid_observation_proof'});
 assert.equal(f.service.request(context(),{...common(),type:'status'}).state,'unknown');
 assert.equal(f.service.request(context(),{type:'policy',company_id:'company'}).company_held_minor,40);
});

test('verified observations bind original policy and current login, release once and cannot be replaced by another terminal claim',async t=>{
 const f=await fixture(t),request=f.signed(common()),saved=f.service.request(context(),request);f.service.request(context(),f.phase('dispatch',request,saved));
 const terminal=f.phase('settle',request,saved,{state:'completed',observation_sha256:sha('verified-original-supplier-task')});
 const old=f.observed(f.service,terminal),next=structuredClone(f.config.policy);next.revision=2;next.companies[0].projects=[];f.service.installPolicy(next);
 const loggedIn=context(alice,'renewed'),fresh=f.observed(f.service,terminal,loggedIn);
 const {type,observation_proof,...fields}=fresh,quoted=f.service.request(loggedIn,{...fields,type:'observation_quote'});
 assert.equal(quoted.canonical.policy_revision,1);assert.equal(quoted.canonical.current_policy_revision,2);
 assert.equal(quoted.canonical.login_session_id,loggedIn.sessionId);assert.equal(quoted.canonical.admission_id,saved.admission_id);
 assert.throws(()=>f.service.request(loggedIn,old),{code:'native_jubian_invalid_observation_proof'});
 assert.equal(f.service.request(loggedIn,fresh).state,'completed');
 assert.equal(f.service.request(loggedIn,terminal).replayed,true);
 assert.throws(()=>f.service.request(loggedIn,{...terminal,observation_sha256:sha('different-task')}),{code:'native_jubian_admission_observation_conflict'});
 assert.throws(()=>f.service.request(loggedIn,{...terminal,state:'failed'}),{code:'native_jubian_admission_terminal_conflict'});
 const db=new DatabaseSync(f.config.databaseFile,{readOnly:true});try{
  const rows=db.prepare("SELECT * FROM native_jubian_admission_audit WHERE event='observed-completed'").all();assert.equal(rows.length,1);
  assert.equal(rows[0].session_id,loggedIn.sessionId);assert.equal(rows[0].issuer_id,'d'.repeat(64));
  assert.equal(JSON.parse(rows[0].detail_json).observation_sha256,terminal.observation_sha256);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM native_jubian_admission_grants').get().count,2);
 }finally{db.close();}
 assert.equal(f.service.request(loggedIn,{type:'policy',company_id:'company'}).company_held_minor,0);
 assert.equal(f.service.request(loggedIn,{type:'policy',company_id:'company'}).company_used_minor,40);
});

test('an observation cannot reuse a consumed expense grant even when an injected verifier returns its identifier',async t=>{
 const f=await fixture(t),request=f.signed(common()),saved=f.service.request(context(),request);f.service.request(context(),f.phase('dispatch',request,saved));
 const terminal=f.phase('settle',request,saved,{state:'failed',observation_sha256:sha('original-task-failure')}),attested=f.observed(f.service,terminal);
 attested.observation_proof.grant_id=request.approval_proof.grant_id;
 assert.throws(()=>f.service.request(context(),attested),{code:'native_jubian_admission_native_grant_consumed'});
 assert.equal(f.service.request(context(),{...common(),type:'status'}).state,'unknown');
 assert.equal(f.service.request(context(),f.observed(f.service,terminal)).state,'failed');
});

test('current policy is rechecked before dispatch and a fresh login grant continues the exact reserved business request',async t=>{
 const f=await fixture(t),request=f.signed(common()),saved=f.service.request(context(),request);
 const next=structuredClone(f.config.policy);next.revision=2;next.companies[0].members[0].limitMinor=90;f.service.installPolicy(next);
 assert.throws(()=>f.service.request(context(),f.phase('dispatch',request,saved)),{code:'native_jubian_admission_policy_revision_changed'});
 const fresh=context(alice,'new-login'),updated={...common(),policy_revision:2};
 const quote=f.service.request(fresh,{...updated,type:'quote'});assert.equal(quote.within_limit,true);assert.equal(quote.resource_ready,true);assert.equal(quote.canonical.login_session_id,fresh.sessionId);
 const proof={signature:'test-native-user-signature',grant_id:'grant-fresh-login',expires_at:1050000,canonical_sha256:sha(quote.canonical)};
 assert.equal(f.service.request(fresh,{...updated,type:'dispatch',attempt_id:request.attempt_id,admission_id:saved.admission_id,approval_proof:proof}).dispatch_allowed,true);
});

test('revocation blocks dispatch, a read-only member may cancel its proven-unsent reservation, and caller spoofing is rejected',async t=>{
 const f=await fixture(t),request=f.signed(common(),context(bob)),saved=f.service.request(context(bob),request);
 const next=structuredClone(f.config.policy);next.revision=2;next.companies[0].members[1].role='viewer';f.service.installPolicy(next);
 assert.throws(()=>f.service.request(context(bob),f.phase('dispatch',request,saved)),{code:'native_jubian_admission_member_forbidden'});
 assert.equal(f.service.request(context(bob),f.phase('cancel',request,saved,{reason:'not_dispatched'})).state,'cancelled');
 f.disabled.add(alice);assert.throws(()=>f.service.request(context(),{...common(),type:'quote',policy_revision:2}),{code:'native_jubian_admission_account_forbidden'});
 assert.throws(()=>f.service.request(context(viewer),{...common('unknown',{script_id:999,policy_revision:2}),type:'quote'}),{code:'native_jubian_admission_project_forbidden'});
 assert.throws(()=>f.service.request(context(bob),{...common('spoof',{policy_revision:2}),type:'quote',actor_id:alice}),{code:'native_jubian_admission_invalid_request'});
});

test('project revocation blocks new dispatches while exact historical operations remain queryable and cancellable',async t=>{
 const f=await fixture(t),request=f.signed(common()),saved=f.service.request(context(),request);
 const next=structuredClone(f.config.policy);next.revision=2;next.companies[0].projects=[];f.service.installPolicy(next);
 assert.throws(()=>f.service.request(context(),f.phase('dispatch',request,saved)),{code:'native_jubian_admission_project_forbidden'});
 assert.equal(f.service.request(context(alice,'restored-login'),{...common(),type:'status'}).state,'reserved');
 assert.equal(f.service.request(context(),f.phase('cancel',request,saved,{reason:'not_dispatched'})).state,'cancelled');
 assert.equal(f.service.request(context(),{type:'policy',company_id:'company'}).company_held_minor,0);
});

test('a cancelled grant remains consumed and a different provider fingerprint cannot evade the same real card lock',async t=>{
 const f=await fixture(t),request=f.signed(common()),saved=f.service.request(context(),request);
 const different=f.signed(common('same-card',{provider_connection_revision:'e'.repeat(64),amount_minor:1}));
 assert.throws(()=>f.service.request(context(),different),{code:'native_jubian_admission_resource_busy'});
 f.service.request(context(),f.phase('cancel',request,saved,{reason:'not_dispatched'}));
 const fresh=f.signed(common('new-op',{resources:[{kind:'card',id:2}]}));fresh.approval_proof.grant_id=request.approval_proof.grant_id;
 assert.throws(()=>f.service.request(context(),fresh),{code:'native_jubian_admission_native_grant_consumed'});
 assert.equal(f.service.request(context(),{...common('new-op',{resources:[{kind:'card',id:2}]}),type:'status'}).state,'missing');
});

test('budget changes require their own native permission and never authorize video generation',async t=>{
 const absent=await fixture(t,()=>{},false),value=budgetChange('lower',80);
 assert.equal(absent.service.request(context(),{...value,type:'budget_quote'}).budget_approval_available,false);
 assert.throws(()=>absent.service.request(context(),{...value,type:'budget_update',expected_revision:0,base_policy_revision:1,budget_proof:{approved:true}}),{code:'native_jubian_admission_budget_approval_unavailable'});
 const f=await fixture(t),update=f.budgetSigned(value),fee=f.signed(common());
 assert.throws(()=>f.service.request(context(),{...update,budget_proof:fee.approval_proof}),{code:'native_jubian_invalid_budget_proof'});
 assert.equal(f.service.request(context(),{type:'policy',company_id:'company'}).member_limit_minor,100);
 assert.equal(f.service.request(context(),update).target_revision,1);
 assert.equal(f.service.request(context(alice,'relogin'),update).replayed,true);
 assert.throws(()=>f.service.request(context(),{...fee,approval_proof:update.budget_proof}),{code:'production_fee_grant_changed'});
 assert.equal(f.service.request(context(),{...common(),type:'status'}).state,'missing');
});

test('editors adjust only themselves or shared projects while administrators can adjust same-company members',async t=>{
 const f=await fixture(t,config=>{config.policy.companies[0].members[1].limitMinor=40;});
 const originalFee=f.signed(common('independent-project',{script_id:4660}));
 const own=budgetChange('bob-raise',80,{kind:'member',account_id:bob});f.service.request(context(bob),f.budgetSigned(own,context(bob)));
 assert.equal(f.service.request(context(bob),{type:'policy',company_id:'company'}).member_limit_minor,80);
 assert.throws(()=>f.service.request(context(bob),{...budgetChange('not-alice',50),type:'budget_quote'}),{code:'native_jubian_admission_budget_target_forbidden'});
 assert.throws(()=>f.service.request(context(bob),{...budgetChange('not-company',50,{kind:'company'}),type:'budget_quote'}),{code:'native_jubian_admission_budget_target_forbidden'});
 const project=budgetChange('shared-project',60,{kind:'project',provider_origin:origin,script_id:6613});f.service.request(context(bob),f.budgetSigned(project,context(bob)));
 const shared=f.service.request(context(),{type:'policy',company_id:'company'});assert.equal(shared.policy_revision,1);
 assert.equal(shared.projects.find(row=>row.script_id===6613).limit_minor,60);assert.equal(shared.projects.find(row=>row.script_id===4660).target_revision,0);
 assert.equal(f.service.request(context(),originalFee).state,'reserved');
 const admin=budgetChange('admin-bob',70,{kind:'member',account_id:bob});f.service.request(context(),f.budgetSigned(admin));
 assert.equal(f.service.request(context(bob),{type:'policy',company_id:'company'}).member_limit_minor,70);
});

test('company restoration uses its configured hard cap while member increases respect remaining company money and unknown holds',async t=>{
 const f=await fixture(t,config=>{config.policy.companies[0].members[1].limitMinor=20;});
 const request=f.signed(common('held',{amount_minor:40})),saved=f.service.request(context(),request);f.service.request(context(),f.phase('dispatch',request,saved));
 f.service.request(context(),f.budgetSigned(budgetChange('company-lower',50,{kind:'company'})));
 assert.equal(f.service.request(context(),{type:'policy',company_id:'company'}).company_available_minor,10);
 const restore=f.budgetSigned(budgetChange('company-restore',100,{kind:'company'}));f.service.request(context(),restore);
 assert.equal(f.service.request(context(),{type:'policy',company_id:'company'}).company_limit_minor,100);
 assert.throws(()=>f.service.request(context(),{...budgetChange('above-hard',101,{kind:'company'}),type:'budget_quote'}),{code:'native_jubian_admission_budget_increase_exceeds_company'});
 assert.throws(()=>f.service.request(context(),{...budgetChange('below-held',39),type:'budget_quote'}),{code:'native_jubian_admission_budget_below_usage'});
 assert.throws(()=>f.service.request(context(bob),{...budgetChange('too-much',61,{kind:'member',account_id:bob}),type:'budget_quote'}),{code:'native_jubian_admission_budget_increase_exceeds_company'});
 f.service.request(context(),f.budgetSigned(budgetChange('member-lower',50)));
 const read=f.service.request(context(),{type:'policy',company_id:'company'});assert.equal(read.company_held_minor,40);assert.equal(read.member_limit_minor,50);
 assert.equal(f.service.request(context(),{...common('held',{amount_minor:40}),type:'status'}).state,'unknown');
});

test('budget CAS and stable change keys reject stale, changed and wrong-login grants with no partial override',async t=>{
 const f=await fixture(t),a=f.budgetSigned(budgetChange('a',80)),b=f.budgetSigned(budgetChange('b',90));
 assert.throws(()=>f.service.request(context(alice,'other-login'),a),{code:'native_jubian_invalid_budget_proof'});
 f.service.request(context(),a);
 assert.throws(()=>f.service.request(context(),b),{code:'native_jubian_admission_budget_revision_conflict'});
 assert.throws(()=>f.service.request(context(),{...a,new_limit_minor:70}),{code:'native_jubian_admission_budget_change_conflict'});
 const read=f.service.request(context(),{type:'policy',company_id:'company'});assert.equal(read.member_target_revision,1);assert.equal(read.member_limit_minor,80);
 const db=new DatabaseSync(f.config.databaseFile);try{
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM native_jubian_admission_budget_changes').get().count,1);
  assert.throws(()=>db.prepare('DELETE FROM native_jubian_admission_budget_changes').run(),/immutable/);
 }finally{db.close();}
});

test('v1 migration preserves original operations and runtime budgets survive reopening with the unchanged base configuration',async t=>{
 const f=await fixture(t),request=f.signed(common()),saved=f.service.request(context(),request);f.service.request(context(),f.phase('dispatch',request,saved));f.service.close();
 const old=new DatabaseSync(f.config.databaseFile);const before=old.prepare('SELECT * FROM native_jubian_admission_operations').all(),audit=old.prepare('SELECT * FROM native_jubian_admission_audit').all();
 old.exec('DROP TABLE native_jubian_admission_queue_cursors;DROP TABLE native_jubian_admission_queue;DROP TABLE native_jubian_company_projects;DROP TABLE native_jubian_source_grants;DROP TABLE native_jubian_source_effects;DROP TABLE native_jubian_source_operations;DROP TABLE native_jubian_admission_budget_changes;DROP TABLE native_jubian_admission_budget_overrides;UPDATE native_jubian_admission_meta SET version=1');old.close();
 const restored=await openNativeJubianAdmission(f.options);f.stores.push(restored);
 const migrated=new DatabaseSync(f.config.databaseFile,{readOnly:true});try{
  assert.equal(migrated.prepare('SELECT version FROM native_jubian_admission_meta').get().version,4);
  assert.deepEqual(migrated.prepare('SELECT * FROM native_jubian_admission_operations').all(),before);assert.deepEqual(migrated.prepare('SELECT * FROM native_jubian_admission_audit').all(),audit);
 }finally{migrated.close();}
 const update=f.budgetSigned(budgetChange('persistent',50),context(),restored);restored.request(context(),update);restored.close();
 const reopened=await openNativeJubianAdmission(f.options);f.stores.push(reopened);
 const read=reopened.request(context(),{type:'policy',company_id:'company'});assert.equal(read.policy_revision,1);assert.equal(read.member_limit_minor,50);assert.equal(read.member_held_minor,40);
 assert.equal(reopened.request(context(),update).replayed,true);assert.equal(reopened.request(context(),{...common(),type:'status'}).state,'unknown');
});

test('independent Hosts compare and swap one budget target without overwriting the other native-authorized change',async t=>{
 const f=await fixture(t),ready=[],results=[],exits=[];
 for(const [changeId,limit]of [['worker-a',80],['worker-b',90]]){
  const source=String.raw`const {parentPort,workerData}=require('node:worker_threads');const {createHash}=require('node:crypto');
const sha=value=>createHash('sha256').update(typeof value==='string'?value:JSON.stringify(value)).digest('hex');
(async()=>{const {openNativeJubianAdmission}=await import(workerData.module);const actor={accountId:workerData.accountId,sessionId:sha(workerData.changeId),deviceId:null};
const store=await openNativeJubianAdmission({config:workerData.config,accounts:{get:id=>({id})},nativeApprovals:{verifyBudget:(ctx,proof,expected)=>{if(proof.sha!==sha(expected))throw Error('bad budget proof');return {grant_id:workerData.changeId,issuer_id:'d'.repeat(64),expires_at:Date.now()+60000};}}});
const input={type:'budget_quote',company_id:'company',change_id:workerData.changeId,target:{kind:'member',account_id:workerData.accountId},new_limit_minor:workerData.limit};
const quote=store.request(actor,input);parentPort.postMessage('ready');parentPort.once('message',()=>{try{parentPort.postMessage({result:store.request(actor,{...input,type:'budget_update',expected_revision:quote.canonical.target_revision,base_policy_revision:quote.canonical.base_policy_revision,budget_proof:{sha:sha(quote.canonical)}})});}catch(error){parentPort.postMessage({code:error.code});}finally{store.close();parentPort.close();}});})().catch(error=>{throw error;});`;
  const worker=new Worker(source,{eval:true,workerData:{module:new URL('./native-jubian-admission.mjs',import.meta.url).href,config:f.config,accountId:alice,changeId,limit}});f.workers.push(worker);
  exits.push(new Promise((resolve,reject)=>{worker.once('error',reject);worker.once('exit',code=>code===0?resolve():reject(Error('worker exit '+code)));}));
  let mark;ready.push(new Promise(resolve=>{mark=resolve;}));results.push(new Promise((resolve,reject)=>{worker.once('error',reject);worker.once('message',value=>{assert.equal(value,'ready');worker.once('message',resolve);mark();});}));
 }
 await Promise.all(ready);for(const worker of f.workers)worker.postMessage('go');const values=await Promise.all(results);await Promise.all(exits);
 assert.equal(values.filter(value=>value.result?.state==='applied').length,1);assert.equal(values.find(value=>value.code)?.code,'native_jubian_admission_budget_revision_conflict');
 const read=f.service.request(context(),{type:'policy',company_id:'company'});assert.equal(read.member_target_revision,1);assert.equal([80,90].includes(read.member_limit_minor),true);
});

test('batch reservation rolls back every money hold and grant on failure and refuses mixed old and new keys',async t=>{
 const f=await fixture(t),first=f.signed(common('a',{amount_minor:60})),second=f.signed(common('b',{amount_minor:60,resources:[{kind:'card',id:2}]}));
 assert.equal(f.service.request(context(),{type:'quote_batch',items:[common('a',{amount_minor:60}),common('b',{amount_minor:60,resources:[{kind:'card',id:2}]})]}).within_limit,false);
 assert.throws(()=>f.service.request(context(),{type:'reserve_batch',items:[first,second]}),{code:'native_jubian_admission_budget_exceeded'});
 assert.equal(f.service.request(context(),{...common('a',{amount_minor:60}),type:'status'}).state,'missing');
 const db=new DatabaseSync(f.config.databaseFile,{readOnly:true});try{assert.equal(db.prepare('SELECT COUNT(*) AS count FROM native_jubian_admission_grants').get().count,0);}finally{db.close();}
 const small=f.signed(common('b',{amount_minor:40,resources:[{kind:'card',id:2}]}));
 const batch=f.service.request(context(),{type:'reserve_batch',items:[first,small]});assert.equal(batch.allowed,true);assert.equal(batch.items.length,2);
 assert.equal(f.service.request(context(),{type:'reserve_batch',items:[first,small]}).replayed,true);
 const fresh=f.signed(common('c',{amount_minor:0,resources:[{kind:'card',id:3}]}));
 assert.throws(()=>f.service.request(context(),{type:'reserve_batch',items:[first,fresh]}),{code:'native_jubian_admission_batch_partial_replay'});
 assert.equal(f.service.request(context(),{...common('c',{amount_minor:0,resources:[{kind:'card',id:3}]}),type:'status'}).state,'missing');
});

test('batch proof and same-card conflicts roll back earlier items and a project write excludes all descendants',async t=>{
 const f=await fixture(t),first=f.signed(common('one',{amount_minor:20})),second=f.signed(common('two',{amount_minor:20,resources:[{kind:'card',id:2}]}));
 assert.throws(()=>f.service.request(context(),{type:'reserve_batch',items:[first,{...second,approval_proof:{approved:true}}]}),{code:'production_fee_grant_changed'});
 assert.throws(()=>f.service.request(context(),{type:'reserve_batch',items:[first,f.signed(common('same',{amount_minor:20}))]}),{code:'native_jubian_admission_resource_busy'});
 assert.equal(f.service.request(context(),{...common('one',{amount_minor:20}),type:'status'}).state,'missing');
 f.service.request(context(),first);
 const project=common('rename',{method:'project_rename',amount_minor:0,resources:[{kind:'project',id:6613}]});
 assert.throws(()=>f.service.request(context(),{...project,type:'reserve',attempt_id:'rename'}),{code:'native_jubian_admission_resource_busy'});
 assert.equal(f.service.request(context(),f.signed(common('different-project',{script_id:4660,amount_minor:20}))).state,'reserved');
});

test('draft assets admit distinct new image parents atomically while the same logical identity remains exclusive across Hosts',async t=>{
 const f=await fixture(t),character=sha('character:synthetic-lead'),scene=sha('scene:synthetic-office');
 const first=f.signed(common('new-character',{method:'image_generate',amount_minor:20,resources:[{kind:'draft_asset',id:character}]}));
 const second=f.signed(common('new-scene',{method:'image_generate',amount_minor:20,resources:[{kind:'draft_asset',id:scene}]}));
 const result=f.service.request(context(),{type:'reserve_batch',items:[first,second]});assert.equal(result.allowed,true);assert.equal(result.items.length,2);
 assert.deepEqual(result.items.map(item=>item.descriptor.resources[0].id),[character,scene]);
 const other=await openNativeJubianAdmission(f.options);f.stores.push(other);
 const same=f.signed(common('other-host-same-character',{method:'image_generate',amount_minor:20,resources:[{kind:'draft_asset',id:character}]}),context(bob));
 assert.throws(()=>other.request(context(bob),same),{code:'native_jubian_admission_resource_busy'});
 const project=common('whole-project',{method:'project_rename',amount_minor:0,resources:[{kind:'project',id:6613}]});
 assert.throws(()=>other.request(context(),{...project,type:'reserve',attempt_id:'project-attempt'}),{code:'native_jubian_admission_resource_busy'});
});

test('draft hash keys preserve all-digit identities exactly in SQLite and remain exclusive after restart',async t=>{
 const f=await fixture(t),identity='1'.repeat(64),input=common('all-digit-draft',{method:'image_generate',resources:[{kind:'draft_asset',id:identity}]}),
  reserved=f.service.request(context(),f.signed(input));f.service.close();
 const db=new DatabaseSync(f.config.databaseFile,{readOnly:true});try{
  const row=db.prepare('SELECT resource_id,typeof(resource_id) AS storage_type FROM native_jubian_admission_resources').get();
  assert.equal(row.resource_id,'sha256:'+identity);assert.equal(row.storage_type,'text');
  assert.equal(db.prepare('SELECT version FROM native_jubian_admission_meta').get().version,4);
 }finally{db.close();}
 const reopened=await openNativeJubianAdmission(f.options);f.stores.push(reopened);
 assert.equal(reopened.request(context(),{...input,type:'status'}).admission_id,reserved.admission_id);
 const repeated={...input,operation_id:'another-digit-draft',type:'reserve',attempt_id:'another'};
 assert.throws(()=>reopened.request(context(),repeated),{code:'native_jubian_admission_resource_busy'});
 const numeric=common('real-asset',{method:'image_generate',resources:[{kind:'asset',id:7}]});
 assert.equal(reopened.request(context(),{...numeric,type:'quote'}).resource_ready,true);
});

test('draft resources never replace real asset IDs or another method and fee signatures bind the exact logical key',async t=>{
 const f=await fixture(t),draft=sha('character:lead'),base=common('invalid-draft',{method:'image_generate'});
 for(const resources of [[{kind:'draft_asset',id:0}],[{kind:'draft_asset',id:'a'.repeat(63)}],[{kind:'asset',id:draft}],
  [{kind:'draft_asset',id:draft},{kind:'asset',id:1}]]){
  assert.throws(()=>f.service.request(context(),{...base,type:'quote',resources}),{code:'native_jubian_admission_invalid_resource'});
 }
 assert.throws(()=>f.service.request(context(),{...common('wrong-method'),type:'quote',resources:[{kind:'draft_asset',id:draft}]}),{code:'native_jubian_admission_invalid_resource'});
 const real=f.signed(common('existing-parent',{method:'image_generate',amount_minor:20,resources:[{kind:'asset',id:7}]}));f.service.request(context(),real);
 assert.throws(()=>f.service.request(context(),{...real,resources:[{kind:'draft_asset',id:draft}]}),{code:'native_jubian_admission_operation_conflict'});
 assert.throws(()=>f.service.request(context(),{...real,operation_id:'pretend-new-parent',attempt_id:'new-attempt',resources:[{kind:'draft_asset',id:draft}]}),{code:'production_fee_grant_changed'});
 const fresh=f.signed(common('fresh-new-parent',{method:'image_generate',amount_minor:20,resources:[{kind:'draft_asset',id:draft}]}));
 assert.throws(()=>f.service.request(context(),{...fresh,resources:[{kind:'draft_asset',id:sha('different-formal-asset')}]}),{code:'production_fee_grant_changed'});
});

test('draft descendants respect a project ancestor reservation and same-draft batches roll back as one unit',async t=>{
 const f=await fixture(t),identity=sha('prop:synthetic-phone');
 const project=common('project-exclusive',{method:'project_rename',amount_minor:0,resources:[{kind:'project',id:6613}]}),
  projectRequest={...project,type:'reserve',attempt_id:'project'},held=f.service.request(context(),projectRequest);
 const draft=common('blocked-draft',{method:'image_generate',amount_minor:20,resources:[{kind:'draft_asset',id:identity}]});
 assert.throws(()=>f.service.request(context(),f.signed(draft)),{code:'native_jubian_admission_resource_busy'});
 f.service.request(context(),f.phase('cancel',projectRequest,held,{reason:'not_dispatched'}));
 const first=f.signed(draft),second=f.signed({...draft,operation_id:'duplicate-logical-draft'});
 assert.throws(()=>f.service.request(context(),{type:'reserve_batch',items:[first,second]}),{code:'native_jubian_admission_resource_busy'});
 assert.equal(f.service.request(context(),{...draft,type:'status'}).state,'missing');
 const valid=f.service.request(context(),first);assert.equal(valid.state,'reserved');
});

test('future schemas and unrelated databases remain intact and policy revisions never decrease',async t=>{
 const f=await fixture(t),db=new DatabaseSync(f.config.databaseFile);db.prepare('UPDATE native_jubian_admission_meta SET version=999').run();db.close();
 await assert.rejects(openNativeJubianAdmission(f.options),{code:'native_jubian_admission_unsupported_schema'});
 const check=new DatabaseSync(f.config.databaseFile);assert.equal(check.prepare('SELECT version FROM native_jubian_admission_meta').get().version,999);check.prepare('UPDATE native_jubian_admission_meta SET version=4').run();check.close();
 const next=structuredClone(f.config.policy);next.revision=2;f.service.installPolicy(next);
 assert.throws(()=>f.service.installPolicy(f.config.policy),{code:'native_jubian_admission_policy_revision_stale'});
 assert.throws(()=>f.service.installPolicy({...next,companies:[]}),{code:'native_jubian_admission_invalid_policy'});
 const path=join(f.home,'unrelated.sqlite'),other=new DatabaseSync(path);other.exec('CREATE TABLE production_projects(id INTEGER)');other.close();
 if(process.platform!=='win32'){const {chmod}=await import('node:fs/promises');await chmod(path,0o600);}
 await assert.rejects(openNativeJubianAdmission({...f.options,config:{...f.config,databaseFile:path}}),{code:'native_jubian_admission_unrelated_database'});
 assert.throws(()=>resolveNativeJubianAdmissionConfig({...f.config,maxBatchItems:0}),{code:'native_jubian_admission_invalid_configuration'});
});

test('independent Hosts atomically compete for a company allowance without overselling',async t=>{
 const f=await fixture(t,config=>{config.policy.companies[0].limitMinor=60;}),ready=[],results=[],exits=[];
 for(const [accountId,scriptId]of [[alice,6613],[bob,4660]]){
  const source=String.raw`const {parentPort,workerData}=require('node:worker_threads');const {createHash}=require('node:crypto');
const sha=value=>createHash('sha256').update(typeof value==='string'?value:JSON.stringify(value)).digest('hex');
(async()=>{const {openNativeJubianAdmission}=await import(workerData.module);const actor={accountId:workerData.accountId,sessionId:sha(workerData.accountId),deviceId:null};
const store=await openNativeJubianAdmission({config:workerData.config,accounts:{get:id=>({id})},nativeApprovals:{verify:(actor,proof,expected)=>{if(proof.sha!==sha(expected))throw Error('bad proof');return {grant_id:workerData.accountId,issuer_id:'d'.repeat(64),expires_at:Date.now()+60000};}}});
const input=workerData.input,quote=store.request(actor,{...input,type:'quote'});parentPort.postMessage('ready');parentPort.once('message',()=>{try{parentPort.postMessage({result:store.request(actor,{...input,type:'reserve',attempt_id:'original',approval_proof:{sha:sha(quote.canonical)}})});}catch(error){parentPort.postMessage({code:error.code});}finally{store.close();parentPort.close();}});})().catch(error=>{throw error;});`;
  const worker=new Worker(source,{eval:true,workerData:{module:new URL('./native-jubian-admission.mjs',import.meta.url).href,config:f.config,accountId,input:common('race-'+accountId,{script_id:scriptId,amount_minor:60})}});f.workers.push(worker);
  exits.push(new Promise((resolve,reject)=>{worker.once('error',reject);worker.once('exit',code=>code===0?resolve():reject(Error('worker exit '+code)));}));
  let mark;ready.push(new Promise(resolve=>{mark=resolve;}));results.push(new Promise((resolve,reject)=>{worker.once('error',reject);worker.once('message',value=>{assert.equal(value,'ready');worker.once('message',resolve);mark();});}));
 }
 await Promise.all(ready);for(const worker of f.workers)worker.postMessage('go');const values=await Promise.all(results);await Promise.all(exits);
 assert.equal(values.filter(value=>value.result?.allowed).length,1);assert.equal(values.find(value=>!value.result)?.code,'native_jubian_admission_budget_exceeded');
 assert.equal(f.service.request(context(),{...common('availability',{resources:[{kind:'card',id:9}]}),type:'quote'}).scopes.company.used_minor,60);
});

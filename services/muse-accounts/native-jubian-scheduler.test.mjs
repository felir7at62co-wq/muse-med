/** Real private SQLite scheduling and reservations; no supplier request is made. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {Worker} from 'node:worker_threads';
import {openNativeJubianAdmission,resolveNativeJubianAdmissionConfig} from './native-jubian-admission.mjs';
import {NATIVE_JUBIAN_QUEUE_TABLES} from './native-jubian-scheduler.mjs';

const alice='a'.repeat(16),bob='b'.repeat(16),carol='c'.repeat(16),origin='https://web.jubianai.net';
const sha=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const actor=(accountId=alice,session='first')=>({accountId,sessionId:sha(accountId+session),deviceId:null});
const item=(operation,card=1,changes={})=>({company_id:'company',provider_origin:origin,script_id:61,operation_id:operation,
 method:'storyboard_save',provider_connection_revision:'c'.repeat(64),request_sha256:sha('body-'+operation),quote_sha256:sha('quote-'+operation),
 currency:'CNY',amount_minor:0,resources:[{kind:'card',id:card}],policy_revision:1,...changes});
async function fixture(t,change=()=>{}){
 const home=await mkdtemp(join(tmpdir(),'muse-native-queue-')),allowance={limitMinor:1000,maxParallel:1};
 const config={version:1,databaseFile:join(home,'admission.sqlite'),busyTimeoutMs:5000,maxBatchItems:10,
  scheduler:{maxQueuedPerCompany:10,maxQueuedPerMember:5,offerTtlMs:1000,queuedTicketRetentionMs:5000},
  policy:{revision:1,companies:[{id:'company',...allowance,
   members:[alice,bob,carol].map((accountId,index)=>({accountId,role:index===0?'owner':'editor',active:true,...allowance})),
   projects:[61,62].map(scriptId=>({providerOrigin:origin,scriptId,active:true,...allowance}))}]}};
 change(config);let clock=10000;const stores=[],disabled=new Set();
 const options={config,accounts:{get:id=>[alice,bob,carol].includes(id)?{id,disabled:disabled.has(id)}:undefined},now:()=>clock,
  nativeApprovals:{verify(_actor,proof,canonical){
   if(proof?.sha!==sha(canonical))throw Object.assign(Error('genuine fee required'),{code:'production_fee_invalid_proof'});
   return {grant_id:'fee-'+canonical.operation_id,issuer_id:'d'.repeat(64),expires_at:clock+60000};
  },verifyObservation(_actor,proof,canonical){
   if(proof?.sha!==sha(canonical))throw Object.assign(Error('real observation required'),{code:'native_jubian_invalid_observation_proof'});
   return {grant_id:'observation-'+canonical.operation_id,issuer_id:'d'.repeat(64),expires_at:clock+60000};
  }}};
 const service=await openNativeJubianAdmission(options);stores.push(service);
 t.after(async()=>{for(const store of stores)store.close();await rm(home,{recursive:true,force:true});});
 const joinQueue=(value,who=actor(),key=value.operation_id,store=service)=>store.request(who,{type:'queue_join',company_id:'company',queue_key:key,items:[value]});
 const status=(ticket,who=actor(),store=service)=>store.request(who,{type:'queue_status',company_id:'company',queue_id:ticket.queue_id});
 const reserve=(value,ticket,who=actor(),store=service,extras={})=>store.request(who,{...value,type:'reserve',attempt_id:'attempt-'+value.operation_id,queue_id:ticket.queue_id,...extras});
 const finish=(value,saved,who=actor(),store=service)=>{
  const descriptor={...value,attempt_id:saved.attempt_id,admission_id:saved.admission_id};
  assert.equal(store.request(who,{...descriptor,type:'dispatch'}).dispatch_allowed,true);
  const observation={...descriptor,state:'completed',observation_sha256:sha('actual-'+value.operation_id)},quote=store.request(who,{...observation,type:'observation_quote'});
  assert.equal(store.request(who,{...observation,type:'settle',observation_proof:{sha:sha(quote.canonical)}}).state,'completed');
 };
 return {config,options,service,stores,disabled,joinQueue,status,reserve,finish,setClock:value=>{clock=value;}};
}

test('round-robin company turns admit Bob and Carol before a second ready Alice group',async t=>{
 const f=await fixture(t),a1=item('a1'),a2=item('a2',2),b1=item('b1',3),c1=item('c1',4),
  first=f.joinQueue(a1),second=f.joinQueue(a2),bobTicket=f.joinQueue(b1,actor(bob)),carolTicket=f.joinQueue(c1,actor(carol));
 assert.equal(first.state,'offered');assert.equal(second.state,'queued');assert.equal(bobTicket.state,'queued');
 const original=f.reserve(a1,first);f.finish(a1,original);
 assert.equal(f.status(second).state,'queued');assert.equal(f.status(bobTicket,actor(bob)).state,'offered');
 f.finish(b1,f.reserve(b1,bobTicket,actor(bob)),actor(bob));
 assert.equal(f.status(second).state,'queued');assert.equal(f.status(carolTicket,actor(carol)).state,'offered');
 f.finish(c1,f.reserve(c1,carolTicket,actor(carol)),actor(carol));
 assert.equal(f.status(second).state,'offered');
 const before=f.service.request(actor(),{type:'policy',company_id:'company'});assert.equal(before.company_used_minor,0);assert.equal(before.company_active,0);
 assert.equal(f.reserve(a2,second).state,'reserved');
});

test('unrelated resources and members may run in parallel while same-card work cannot block a ready card',async t=>{
 const f=await fixture(t,config=>{config.policy.companies[0].maxParallel=3;config.policy.companies[0].projects[0].maxParallel=3;}),
  a=item('same-card-a'),b=item('same-card-b'),ready=item('ready-card-b',2),first=f.joinQueue(a),blocked=f.joinQueue(b,actor(bob)),other=f.joinQueue(ready,actor(bob));
 assert.equal(first.state,'offered');assert.equal(blocked.state,'queued');assert.equal(blocked.reason,'resource_busy');assert.equal(other.state,'offered');
 const ar=f.reserve(a,first),br=f.reserve(ready,other,actor(bob));
 assert.equal(f.service.request(actor(),{type:'policy',company_id:'company'}).company_active,2);
 assert.equal(f.status(blocked,actor(bob)).state,'queued');f.finish(a,ar);
 assert.equal(f.status(blocked,actor(bob)).reason,'capacity_exceeded');f.finish(ready,br,actor(bob));
 assert.equal(f.status(blocked,actor(bob)).state,'offered');
});

test('a fair turn never grants money, and failed fee validation leaves no admission or consumed ticket',async t=>{
 const f=await fixture(t),paid=item('paid-audio',4,{method:'audio_generate',amount_minor:100,resources:[{kind:'asset',id:84}]}),ticket=f.joinQueue(paid);
 assert.equal(ticket.state,'offered');
 assert.throws(()=>f.service.request(actor(),{...paid,type:'reserve',attempt_id:'no-turn'}),{code:'native_jubian_admission_queue_turn_required'});
 assert.throws(()=>f.reserve(paid,ticket),{code:'production_fee_invalid_proof'});
 assert.equal(f.status(ticket).state,'offered');assert.equal(f.service.request(actor(),{...paid,type:'status'}).state,'missing');
 const quote=f.service.request(actor(),{...paid,type:'quote'}),saved=f.reserve(paid,ticket,actor(),f.service,{approval_proof:{sha:sha(quote.canonical)}});
 assert.equal(saved.state,'reserved');assert.equal(f.status(ticket).state,'consumed');
 assert.throws(()=>f.service.request(actor(),{type:'queue_cancel',company_id:'company',queue_id:ticket.queue_id}),{code:'native_jubian_admission_queue_already_reserved'});
 const {queue_id,...replay}= {...paid,type:'reserve',attempt_id:'attempt-'+paid.operation_id};
 assert.equal(f.service.request(actor(alice,'relogin'),replay).replayed,true);
});

test('a batch claims one exact turn atomically and cannot reserve a subset or reuse another actor ticket',async t=>{
 const f=await fixture(t,config=>{const c=config.policy.companies[0];c.maxParallel=3;c.members[0].maxParallel=3;c.projects[0].maxParallel=3;}),a=item('batch-a'),b=item('batch-b',2);
 const ticket=f.service.request(actor(),{type:'queue_join',company_id:'company',queue_key:'atomic-batch',items:[a,b]});
 assert.equal(ticket.state,'offered');
 assert.throws(()=>f.reserve(a,ticket),{code:'native_jubian_admission_queue_identity_conflict'});
 assert.throws(()=>f.service.request(actor(bob),{type:'reserve_batch',queue_id:ticket.queue_id,items:[a,b].map(value=>({...value,attempt_id:'original-'+value.operation_id}))}),{code:'native_jubian_admission_queue_missing'});
 const result=f.service.request(actor(),{type:'reserve_batch',queue_id:ticket.queue_id,items:[a,b].map(value=>({...value,attempt_id:'original-'+value.operation_id}))});
 assert.equal(result.items.length,2);assert.equal(f.status(ticket).state,'consumed');
 assert.equal(f.service.request(actor(),{type:'policy',company_id:'company'}).company_active,2);
});

test('offer expiry and a disconnected Host release only soft turns and never a dispatched unknown operation',async t=>{
 const f=await fixture(t),a=item('unknown-original'),b=item('waiting-other',2),first=f.joinQueue(a),second=f.joinQueue(b,actor(bob)),saved=f.reserve(a,first);
 f.service.request(actor(),{...a,type:'dispatch',attempt_id:saved.attempt_id,admission_id:saved.admission_id});
 f.setClock(20000);assert.equal(f.status(second,actor(bob)).state,'cancelled');
 assert.equal(f.service.request(actor(),{...a,type:'status'}).state,'unknown');
 const returned=f.joinQueue(b,actor(bob));assert.equal(returned.queue_id,second.queue_id);assert.equal(returned.state,'queued');assert.equal(returned.reason,'capacity_exceeded');
 const db=new DatabaseSync(f.config.databaseFile,{readOnly:true});try{
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM native_jubian_admission_resources WHERE released_at IS NULL').get().count,1);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM native_jubian_admission_queue').get().count,2);
 }finally{db.close();}
});

test('expiry fairly offers another waiting member and exact tickets recover after server and Muse login restart',async t=>{
 const f=await fixture(t),a=item('stalled-offer'),b=item('next-member',2),first=f.joinQueue(a),second=f.joinQueue(b,actor(bob));
 f.setClock(11001);assert.equal(f.status(second,actor(bob)).state,'offered');assert.equal(f.status(first).state,'queued');f.service.close();
 const restored=await openNativeJubianAdmission(f.options);f.stores.push(restored);
 const fresh=actor(bob,'new-login');assert.equal(f.status(second,fresh,restored).state,'offered');
 assert.equal(f.reserve(b,second,fresh,restored).state,'reserved');
 assert.throws(()=>f.joinQueue({...a,request_sha256:sha('changed')},actor(),a.operation_id,restored),{code:'native_jubian_admission_queue_identity_conflict'});
});

test('queue policy changes revoke access and require current policy before renewed reservation without discarding metadata',async t=>{
 const f=await fixture(t),a=item('policy-original'),b=item('policy-other',2),first=f.joinQueue(a),second=f.joinQueue(b,actor(bob));
 const next=structuredClone(f.config.policy);next.revision=2;next.companies[0].members[0].active=false;next.companies[0].members[1].role='owner';f.service.installPolicy(next);
 assert.throws(()=>f.status(first),{code:'native_jubian_admission_member_forbidden'});
 assert.equal(f.status(second,actor(bob)).reason,'policy_revision_changed');
 const renewed=f.joinQueue({...b,policy_revision:2},actor(bob));assert.equal(renewed.state,'offered');assert.equal(renewed.queue_id,second.queue_id);
 assert.equal(f.reserve({...b,policy_revision:2},renewed,actor(bob)).state,'reserved');
 const db=new DatabaseSync(f.config.databaseFile,{readOnly:true});try{
  assert.equal(db.prepare('SELECT state FROM native_jubian_admission_queue WHERE queue_id=?').get(first.queue_id).state,'cancelled');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM native_jubian_admission_queue').get().count,2);
 }finally{db.close();}
});

test('pending company and member limits, exact fields and current identity are enforced without storing source content',async t=>{
 const f=await fixture(t,config=>{config.scheduler.maxQueuedPerCompany=3;config.scheduler.maxQueuedPerMember=2;}),first=f.joinQueue(item('bounded-first'));
 f.joinQueue(item('bounded-second',2));assert.throws(()=>f.joinQueue(item('member-overflow',3)),{code:'native_jubian_admission_queue_full'});
 f.joinQueue(item('company-third',4),actor(bob));assert.throws(()=>f.joinQueue(item('company-overflow',5),actor(carol)),{code:'native_jubian_admission_queue_full'});
 assert.throws(()=>f.status(first,actor(bob)),{code:'native_jubian_admission_queue_missing'});
 for(const extra of [{actor_id:bob},{token:'never-stored'},{prompt:'never-stored'},{approved:true}]){
  assert.throws(()=>f.service.request(actor(),{type:'queue_join',company_id:'company',queue_key:'forged',items:[{...item('forged'),...extra}]}),{code:'native_jubian_admission_invalid_request'});
 }
 f.disabled.add(alice);assert.throws(()=>f.status(first),{code:'native_jubian_admission_account_forbidden'});
 const db=new DatabaseSync(f.config.databaseFile,{readOnly:true});try{
  assert.equal(JSON.stringify(db.prepare('SELECT * FROM native_jubian_admission_queue').all()).includes('never-stored'),false);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM native_jubian_admission_operations').get().count,0);
 }finally{db.close();}
});

test('schema v3 adds queue tables while preserving every existing operation, resource, grant, source and budget row',async t=>{
 const f=await fixture(t,config=>{delete config.scheduler;}),value=item('before-queue'),saved=f.service.request(actor(),{...value,type:'reserve',attempt_id:'old'});
 f.service.request(actor(),{...value,type:'dispatch',attempt_id:'old',admission_id:saved.admission_id});f.service.close();
 const old=new DatabaseSync(f.config.databaseFile);for(const table of NATIVE_JUBIAN_QUEUE_TABLES)old.exec('DROP TABLE '+table);
 old.exec('UPDATE native_jubian_admission_meta SET version=3');
 const names=old.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name<>'native_jubian_admission_meta'").all().map(row=>row.name),
  before=Object.fromEntries(names.map(name=>[name,old.prepare('SELECT * FROM '+name).all()]));old.close();
 const restored=await openNativeJubianAdmission(f.options);f.stores.push(restored);
 const after=new DatabaseSync(f.config.databaseFile,{readOnly:true});try{
  assert.equal(after.prepare('SELECT version FROM native_jubian_admission_meta').get().version,4);
  for(const [name,rows]of Object.entries(before))assert.deepEqual(after.prepare('SELECT * FROM '+name).all(),rows);
  for(const name of NATIVE_JUBIAN_QUEUE_TABLES)assert.equal(after.prepare('SELECT COUNT(*) AS count FROM '+name).get().count,0);
 }finally{after.close();}
 assert.equal(restored.request(actor(),{...value,type:'status'}).state,'unknown');
});

test('scheduler activation and all deployment bounds are explicit',async t=>{
 const f=await fixture(t,config=>{delete config.scheduler;});assert.equal(f.service.queueEnabled,false);
 assert.throws(()=>f.joinQueue(item('disabled')),{code:'native_jubian_admission_scheduler_not_configured'});
 const scheduler={maxQueuedPerCompany:10,maxQueuedPerMember:2,offerTtlMs:1000,queuedTicketRetentionMs:5000};
 assert.deepEqual(resolveNativeJubianAdmissionConfig({...f.config,scheduler}).scheduler,scheduler);
 for(const invalid of [{...scheduler,unexpected:true},{...scheduler,maxQueuedPerMember:11},{...scheduler,offerTtlMs:0},
  {...scheduler,queuedTicketRetentionMs:999},{...scheduler,maxQueuedPerCompany:1.5}]){
  assert.throws(()=>resolveNativeJubianAdmissionConfig({...f.config,scheduler:invalid}),{code:'native_jubian_admission_invalid_scheduler_configuration'});
 }
});

test('overlapping tickets retire after any original operation is reserved without holding a second soft company slot',async t=>{
 const f=await fixture(t),value=item('original-overlap'),first=f.joinQueue(value),duplicate=f.joinQueue(value,actor(),'same-operation-another-host'),
  batch=f.service.request(actor(),{type:'queue_join',company_id:'company',queue_key:'overlap-batch',items:[value,item('unsubmitted-extra',3)]});
 const saved=f.reserve(value,first);
 assert.equal(f.status(duplicate).state,'cancelled');assert.equal(f.status(batch).state,'cancelled');
 const waiting=item('independent-bob',2),bobTicket=f.joinQueue(waiting,actor(bob));assert.equal(bobTicket.state,'queued');
 f.finish(value,saved);
 assert.equal(f.status(duplicate).state,'cancelled');assert.equal(f.status(batch).state,'cancelled');
 assert.equal(f.status(bobTicket,actor(bob)).state,'offered');
 assert.equal(f.service.request(actor(),{...item('unsubmitted-extra',3),type:'status'}).state,'missing');
 assert.equal(f.service.request(actor(),{...value,type:'status'}).state,'completed');
 const db=new DatabaseSync(f.config.databaseFile,{readOnly:true});try{
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM native_jubian_admission_operations').get().count,1);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM native_jubian_admission_audit WHERE event='queue-cancelled' AND detail_json LIKE '%operation-already-reserved%'").get().count,2);
 }finally{db.close();}
});

test('a policy changed by another Host is read on the next transaction without caching actor or project permissions',async t=>{
 const f=await fixture(t),value=item('before-other-policy'),ticket=f.joinQueue(value),other=await openNativeJubianAdmission(f.options);f.stores.push(other);
 const next=structuredClone(f.config.policy);next.revision=2;next.companies[0].members[0].active=false;next.companies[0].members[1].role='owner';other.installPolicy(next);
 assert.throws(()=>f.status(ticket),{code:'native_jubian_admission_member_forbidden'});
 assert.equal(f.joinQueue(item('after-other-policy',2,{policy_revision:2}),actor(bob)).state,'offered');
 assert.throws(()=>f.service.request(actor(),{...value,type:'quote',policy_revision:2}),{code:'native_jubian_admission_member_forbidden'});
});

test('a full company queue does not repeat every waiting candidate allowance query on a new join',async t=>{
 const f=await fixture(t,config=>{config.scheduler.maxQueuedPerCompany=100;config.scheduler.maxQueuedPerMember=100;});
 assert.equal(f.joinQueue(item('full-company-slot')).state,'offered');
 const measuredJoin=value=>{
  const original=DatabaseSync.prototype.prepare;let totals=0;
  try{
   DatabaseSync.prototype.prepare=function(statement,...args){
    if(statement.startsWith('SELECT COALESCE(SUM'))totals++;
    return Reflect.apply(original,this,[statement,...args]);
   };
   const result=f.joinQueue(value);assert.equal(result.state,'queued');assert.equal(result.reason,'capacity_exceeded');
  }finally{DatabaseSync.prototype.prepare=original;}
  return totals;
 };
 const small=measuredJoin(item('small-waiting-list',2));
 for(let index=0;index<40;index++)f.joinQueue(item('larger-wait-'+index,index+3));
 const large=measuredJoin(item('large-waiting-list',50));
 assert.ok(small>0);assert.ok(large<=small*2,`${large} allowance queries grew with the 40 additional waiting tickets`);
 assert.equal(f.service.request(actor(),{type:'policy',company_id:'company'}).company_active,0);
});

test('independent Hosts cannot receive or consume the same last company slot concurrently',async t=>{
 const f=await fixture(t),workers=[],readies=[],results=[],exits=[];
 t.after(async()=>{await Promise.all(workers.map(worker=>worker.terminate()));});
 for(const [index,accountId]of [alice,bob].entries()){
  const source=String.raw`const {parentPort,workerData}=require('node:worker_threads');
(async()=>{const {openNativeJubianAdmission}=await import(workerData.module),store=await openNativeJubianAdmission({config:workerData.config,accounts:{get:id=>({id})},now:()=>10000});
parentPort.postMessage('ready');parentPort.once('message',()=>{try{const actor=workerData.actor,value=workerData.item,
ticket=store.request(actor,{type:'queue_join',company_id:'company',queue_key:value.operation_id,items:[value]}),
saved=ticket.state==='offered'?store.request(actor,{...value,type:'reserve',queue_id:ticket.queue_id,attempt_id:'original'}):null;
parentPort.postMessage({ticket,saved,actor});}finally{store.close();parentPort.close();}});})().catch(error=>{throw error;});`;
  const worker=new Worker(source,{eval:true,workerData:{module:new URL('./native-jubian-admission.mjs',import.meta.url).href,
   config:f.config,actor:actor(accountId),item:item('worker-'+accountId,index+1)}});workers.push(worker);
  exits.push(new Promise((resolve,reject)=>{worker.once('error',reject);worker.once('exit',code=>code===0?resolve():reject(Error('worker exit '+code)));}));
  let mark;readies.push(new Promise(resolve=>{mark=resolve;}));results.push(new Promise((resolve,reject)=>{
   worker.once('error',reject);worker.once('message',value=>{assert.equal(value,'ready');worker.once('message',resolve);mark();});
  }));
 }
 await Promise.all(readies);for(const worker of workers)worker.postMessage('go');
 const values=await Promise.all(results);await Promise.all(exits);
 const winner=values.find(value=>value.saved!==null),waiting=values.find(value=>value.saved===null);
 assert.equal(values.filter(value=>value.saved!==null).length,1);assert.equal(waiting.ticket.state,'queued');
 assert.equal(f.service.request(actor(),{type:'policy',company_id:'company'}).company_active,1);
 const actual=item(winner.ticket.operation_ids[0],winner.actor.accountId===alice?1:2);
 f.finish(actual,winner.saved,winner.actor);
 assert.equal(f.status(waiting.ticket,waiting.actor).state,'offered');
});

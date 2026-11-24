/** Real account transport tests for metadata admission; no provider or generation requests. */
import assert from 'node:assert/strict';
import {createHash,generateKeyPairSync,sign} from 'node:crypto';
import {once} from 'node:events';
import {mkdtemp,rm} from 'node:fs/promises';
import http from 'node:http';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {createAccountServer} from './gateway.mjs';
import {createNativeJubianHttp} from './native-jubian-http.mjs';
import {openNativeJubianAdmission} from './native-jubian-admission.mjs';
import {openStore} from './store.mjs';
import {createMemorySessionStore} from './session-store.mjs';
import {openProductionFees} from './production-fees.mjs';

const prefix='/api/muse/native-jubian';
const request={type:'quote',method:'storyboard_native_submit',company_id:'company',provider_origin:'https://web.jubianai.net',
 provider_connection_revision:'c'.repeat(64),script_id:6613,operation_id:'original-operation',request_sha256:'a'.repeat(64),
 quote_sha256:'b'.repeat(64),currency:'CNY',amount_minor:100,resources:[{kind:'card',id:11}],policy_revision:1};
const issuer='d'.repeat(64);
const challengeId='11111111-1111-4111-8111-111111111111';
const observationId='22222222-2222-4222-8222-222222222222';
const budgetId='33333333-3333-4333-8333-333333333333';
const failure=(code,status)=>Object.assign(Error(code),{code,status});
function companyPolicy(f,revision=1,limitMinor=10000,maxParallel=3){
 const allowance={limitMinor,maxParallel};
 return {revision,companies:[{id:'company',...allowance,
  members:[{accountId:f.alice.id,role:'owner',active:true,...allowance},{accountId:f.bob.id,role:'editor',active:true,...allowance}],
  projects:[{providerOrigin:request.provider_origin,scriptId:request.script_id,active:true,...allowance}]}]};
}
function signedObservation(key,challenge,prefix){
 return {challenge_id:challenge.id,issuer_id:challenge.issuer_id,decision:'approved',signature:sign(null,
  Buffer.from(prefix+'\n'+challenge.id+'\n'+challenge.nonce+'\n'+challenge.payload_sha256+'\napproved'),key).toString('base64url')};
}

async function fixture(t,{configured=true,approval=true,maxRequestBytes=2048,rate=240}={}){
 const root=await mkdtemp(join(tmpdir(),'muse-native-jubian-http-'));let server;
 const releases=[],owners=[];
 t.after(async()=>{
  for(const release of releases)release();
  if(server){server.closeAllConnections();if(server.listening)await new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()));await server.closeNativeJubian?.();}
  for(const owner of owners)await owner.close();
  await rm(root,{recursive:true,force:true});
 });
 const store=await openStore(join(root,'accounts.json')),alice=await store.create('alice','password'),bob=await store.create('bob','password');
 const calls=[],feesCalls=[];let implementation;
 const admission={async request(context,value){
  calls.push({context:structuredClone(context),value:structuredClone(value)});
  if(implementation)return implementation(context,value);
  if(context.accountId!==alice.id)throw failure('native_jubian_project_forbidden',403);
  return {within_limit:true,capacity_ready:true,resource_ready:true,canonical:{...value,provider:'jubian',account_id:context.accountId,
   login_session_id:context.sessionId,device_id:null,canonical_marker:'trusted-core'}};
 }};
 const fees={
  async createNativeJubianChallenge(actor,canonical,selectedIssuer,review){
   feesCalls.push({actor,canonical,selectedIssuer,review});return {version:1,id:challengeId,action:'native-jubian'};
  },
  async nativeJubianChallenge(context,id){
   feesCalls.push({context,id});if(context.accountId!==alice.id)throw failure('production_fee_not_found',404);
   return {version:1,id,action:'native-jubian'};
  },
  async createNativeJubianObservationChallenge(actor,canonical,selectedIssuer){
   feesCalls.push({actor,canonical,selectedIssuer,observation:true});return {version:1,id:observationId,action:'native-jubian-observation'};
  },
  async nativeJubianObservation(context,id){
   feesCalls.push({context,id,observation:true});if(context.accountId!==alice.id)throw failure('production_fee_not_found',404);
   return {version:1,id,action:'native-jubian-observation'};
  },
  async createNativeJubianBudgetChallenge(actor,canonical,selectedIssuer){
   feesCalls.push({actor,canonical,selectedIssuer,budget:true});return {version:1,id:budgetId,action:'native-jubian-budget'};
  },
  async nativeJubianBudget(context,id){
   feesCalls.push({context,id,budget:true});if(context.accountId!==alice.id)throw failure('production_fee_not_found',404);
   return {version:1,id,action:'native-jubian-budget'};
  },
 };
 const origin='https://muse.native.test',sessionStore=createMemorySessionStore();
 server=createAccountServer({store,sessionStore,workspaceMode:'desktop',publicOrigin:origin,
  nativeJubianAdmission:configured?admission:undefined,nativeJubianApprovals:approval?fees:undefined,
  nativeJubianMaxRequestBytes:maxRequestBytes,nativeJubianRequestRatePerMinute:rate});
 server.listen(0,'127.0.0.1');await once(server,'listening');const base='http://127.0.0.1:'+server.address().port;
 const call=(path,{cookie,token,method='GET',value,raw,headers={}}={})=>fetch(base+path,{method,redirect:'manual',headers:{origin,
  ...cookie?{cookie}:{},...token?{authorization:'Bearer '+token}:{},...value!==undefined||raw!==undefined?{'content-type':'application/json'}:{},...headers},
  body:raw!==undefined?raw:value!==undefined?JSON.stringify(value):undefined});
 const login=async username=>{
  const response=await fetch(base+'/login',{method:'POST',redirect:'manual',headers:{origin},body:new URLSearchParams({username,password:'password'})});
  assert.equal(response.status,303);return response.headers.get('set-cookie').split(';')[0];
 };
 return {root,store,sessionStore,alice,bob,server,base,origin,call,login,calls,feesCalls,admission,fees,releases,owners,
  implement:value=>{implementation=value;}};
}

async function realAuthorities(f,policy=companyPolicy(f),sources,scheduler){
 const keys=generateKeyPairSync('ed25519'),actualIssuer=createHash('sha256')
  .update(keys.publicKey.export({type:'spki',format:'der'})).digest('hex');
 const authority=await openProductionFees({accounts:f.store,publicOrigin:f.origin,config:{version:1,
  databaseFile:join(f.root,'fees.sqlite'),challengeTtlMs:60000,maxPendingPerAccount:20,busyTimeoutMs:1000,maxIssuersPerAccount:3}});
 f.owners.push(authority);authority.enroll(f.store.get(f.alice.id),{issuerId:actualIssuer,
  publicKey:keys.publicKey.export({type:'spki',format:'pem'}),deviceName:'Synthetic company Host'});
 Object.assign(f.fees,authority);
 const core=await openNativeJubianAdmission({accounts:f.store,nativeApprovals:{verify:authority.verifyNativeJubian,
  verifyObservation:authority.verifyNativeJubianObservation,verifyBudget:authority.verifyNativeJubianBudget,
  verifySourceConsent:authority.verifyNativeJubianSourceConsent,verifySourceManaged:authority.verifyNativeJubianSourceManaged},
 config:{version:1,databaseFile:join(f.root,'admission.sqlite'),busyTimeoutMs:1000,maxBatchItems:10,policy,
  ...sources===undefined?{}:{sources},...scheduler===undefined?{}:{scheduler}}});
 f.admission.queueEnabled=core.queueEnabled;
 f.owners.unshift(core);f.implement((context,value)=>core.request(context,value));
 return {core,authority,keys,issuerId:actualIssuer};
}

test('uses real Cookie and Bearer account identities without trusting body actor or exposing credentials',async t=>{
 const f=await fixture(t),cookie=await f.login('alice'),token=cookie.slice(cookie.indexOf('=')+1);
 assert.equal((await f.call(prefix+'/capabilities')).status,401);
 assert.deepEqual(await(await f.call(prefix+'/capabilities',{cookie})).json(),{configured:true,nativeApprovalAvailable:true,fairQueueConfigured:false});
 assert.equal((await f.call(prefix+'/admission',{token,method:'POST',value:request})).status,200);
 assert.deepEqual(f.calls[0].context,{accountId:f.alice.id,sessionId:createHash('sha256').update(token).digest('hex'),deviceId:null});
 assert.ok(!JSON.stringify(f.calls).includes(token));
 for(const supplied of [{actor_id:f.bob.id},{account_id:f.bob.id},{device_id:'invented'},{approved:true},
  {token:'invented'},{database_id:challengeId},{type:'installPolicy'}]){
  assert.equal((await f.call(prefix+'/admission',{cookie,method:'POST',value:{...request,...supplied}})).status,400);
 }
 assert.equal(f.calls.length,1);
 const bob=await f.login('bob');
 assert.equal((await f.call(prefix+'/admission',{cookie:bob,method:'POST',value:request})).status,403);
 assert.equal(f.calls[1].context.accountId,f.bob.id);
});

test('enforces Origin, methods, namespace, bounded JSON and metadata fields before admission',async t=>{
 const f=await fixture(t),cookie=await f.login('alice');
 assert.equal((await f.call(prefix+'/admission',{cookie,method:'POST',value:request,headers:{origin:'https://foreign.test'}})).status,403);
 assert.equal((await f.call(prefix+'/admission',{cookie})).status,405);
 assert.equal((await f.call(prefix+'/arbitrary-provider-route',{cookie,method:'POST',value:request})).status,404);
 assert.equal((await f.call(prefix+'/admission?actor=other',{cookie,method:'POST',value:request})).status,400);
 assert.equal((await f.call(prefix+'/admission',{cookie,method:'POST',raw:'not JSON'})).status,400);
 assert.equal((await f.call(prefix+'/admission',{cookie,method:'POST',raw:'x'.repeat(2049)})).status,413);
 assert.equal((await f.call(prefix+'/admission',{cookie,method:'POST',value:request,headers:{'content-type':'text/plain'}})).status,415);
 assert.equal((await f.call(prefix+'/admission',{cookie,method:'POST',value:{...request,resources:[{kind:'card',id:11,token:'not metadata'}]}})).status,400);
 assert.equal(f.calls.length,0);
});

test('uses the stored Feishu account binding rather than caller-supplied external identity',async t=>{
 const f=await fixture(t),member=await f.store.resolveFeishuIdentity({appId:'company-app',tenantKey:'company-tenant',openId:'member-open-id',name:'Company member'});
 const token=await f.sessionStore.issue({id:member.id,revision:member.revision,expiry:Date.now()+60000});
 f.implement(async context=>({authenticatedAccount:context.accountId}));
 const response=await f.call(prefix+'/admission',{token,method:'POST',value:request});
 assert.equal(response.status,200);assert.deepEqual(await response.json(),{authenticatedAccount:member.id});
 assert.equal(f.calls[0].context.accountId,member.id);
 assert.equal((await f.call(prefix+'/admission',{token,method:'POST',value:{...request,feishu_open_id:'another-member'}})).status,400);
 assert.equal(f.calls.length,1);
});

test('creates native challenges only from the account-authorized canonical quote',async t=>{
 const f=await fixture(t),cookie=await f.login('alice');
 const response=await f.call(prefix+'/challenges',{cookie,method:'POST',value:{input:request,issuer_id:issuer,review:{model:'Seedance'}}});
 assert.equal(response.status,200);assert.equal((await response.json()).action,'native-jubian');
 assert.equal(f.calls[0].value.type,'quote');assert.equal(f.feesCalls[0].actor,f.alice.id);
 assert.equal(f.feesCalls[0].canonical.canonical_marker,'trusted-core');assert.equal(f.feesCalls[0].canonical.account_id,f.alice.id);
 assert.equal(f.feesCalls[0].selectedIssuer,issuer);
 assert.equal((await f.call(prefix+'/challenges/'+challengeId,{cookie})).status,200);
 const bob=await f.login('bob');assert.equal((await f.call(prefix+'/challenges/'+challengeId,{cookie:bob})).status,404);
 assert.equal((await f.call(prefix+'/challenges',{cookie,method:'POST',value:{input:request,issuer_id:issuer,actor_id:f.bob.id}})).status,400);
 assert.equal((await f.call(prefix+'/challenges',{cookie,method:'POST',value:{input:{...request,type:'reserve'},issuer_id:issuer}})).status,400);
 assert.equal((await f.call(prefix+'/challenges',{cookie,method:'POST',value:{input:request,issuer_id:issuer,review:{prompt:'private screenplay'}}})).status,400);
});

test('refuses unavailable policy, missing native approval and unavailable aggregate capacity without a false grant',async t=>{
 const absent=await fixture(t,{configured:false}),cookie=await absent.login('alice');
 assert.equal((await absent.call(prefix+'/capabilities',{cookie})).status,503);
 const f=await fixture(t,{approval:false}),own=await f.login('alice');
 assert.deepEqual(await(await f.call(prefix+'/capabilities',{cookie:own})).json(),{configured:true,nativeApprovalAvailable:false,fairQueueConfigured:false});
 assert.equal((await f.call(prefix+'/challenges',{cookie:own,method:'POST',value:{input:request,issuer_id:issuer}})).status,503);
 const ready=await fixture(t),authenticated=await ready.login('alice');
 for(const unavailable of [{within_limit:false,capacity_ready:true,resource_ready:true},
  {within_limit:true,capacity_ready:false,resource_ready:true},{within_limit:true,capacity_ready:true,resource_ready:false}]){
  ready.implement(async()=>({...unavailable,canonical:{...request}}));
  assert.equal((await ready.call(prefix+'/challenges',{cookie:authenticated,method:'POST',value:{input:request,issuer_id:issuer}})).status,409);
 }
 assert.equal(ready.feesCalls.length,0);
});

test('checks the complete batch before issuing ordered per-request challenges',async t=>{
 const f=await fixture(t),cookie=await f.login('alice'),{type,...item}=request;
 assert.equal(type,'quote');
 const second={...item,operation_id:'second-original',resources:[{kind:'card',id:12}]},items=[item,second];
 f.implement(async(context,value)=>({within_limit:true,capacity_ready:true,resource_ready:true,
  items:value.items.map(row=>({canonical:{...row,provider:'jubian',account_id:context.accountId,login_session_id:context.sessionId,device_id:null}}))}));
 const response=await f.call(prefix+'/challenges',{cookie,method:'POST',value:{input:{type:'quote_batch',items},issuer_id:issuer}});
 assert.equal(response.status,200);assert.equal((await response.json()).items.length,2);
 assert.deepEqual(f.feesCalls.map(row=>row.canonical.operation_id),['original-operation','second-original']);
 assert.equal(f.calls.length,1);assert.equal(f.calls[0].value.type,'quote_batch');
 f.implement(async()=>({within_limit:false,capacity_ready:true,resource_ready:true,items:[]}));
 assert.equal((await f.call(prefix+'/challenges',{cookie,method:'POST',value:{input:{type:'quote_batch',items},issuer_id:issuer}})).status,409);
 assert.equal(f.feesCalls.length,2);
 assert.equal((await f.call(prefix+'/admission',{cookie,method:'POST',value:{type:'reserve_batch',items:[{...item,actor_id:f.bob.id}]}})).status,400);
});

test('real HTTP fair turns and Ed25519 approvals keep waiting members separate from fees and unknown supplier results',async t=>{
 const f=await fixture(t,{maxRequestBytes:8192}),cookie=await f.login('alice'),bobCookie=await f.login('bob'),
  authority=await realAuthorities(f,companyPolicy(f,1,10000,1),undefined,
   {maxQueuedPerCompany:600,maxQueuedPerMember:10,offerTtlMs:60000,queuedTicketRetentionMs:300000});
 const {type,...descriptor}=request;assert.equal(type,'quote');
 const send=async(value,own=cookie)=>{const response=await f.call(prefix+'/admission',{cookie:own,method:'POST',value});
  assert.equal(response.status,200);return response.json();};
 assert.equal((await(await f.call(prefix+'/capabilities',{cookie})).json()).fairQueueConfigured,true);
 const first=await send({type:'queue_join',company_id:'company',queue_key:'first-supplier-task',items:[descriptor]});
 assert.equal(first.state,'offered');
 assert.equal((await f.call(prefix+'/admission',{cookie:bobCookie,method:'POST',value:{type:'queue_status',company_id:'company',queue_id:first.queue_id}})).status,404);
 for(const injected of [{actor_id:f.bob.id},{approved:true},{token:'refused-token'}]){
  assert.equal((await f.call(prefix+'/admission',{cookie,method:'POST',value:{type:'queue_join',company_id:'company',queue_key:'forged',items:[{...descriptor,...injected}]}})).status,400);
 }
 const reserve={...descriptor,type:'reserve',attempt_id:'original-paid-attempt'};
 assert.equal((await f.call(prefix+'/admission',{cookie,method:'POST',value:reserve})).status,409);
 assert.equal((await f.call(prefix+'/admission',{cookie,method:'POST',value:{...reserve,queue_id:first.queue_id}})).status,403);
 assert.equal((await send({type:'policy',company_id:'company'})).company_held_minor,0);
 const response=await f.call(prefix+'/challenges',{cookie,method:'POST',value:{input:{...descriptor,type:'quote'},issuer_id:authority.issuerId}});
 assert.equal(response.status,200);const challenge=await response.json(),fee=signedObservation(authority.keys.privateKey,challenge,'muse-native-jubian-fee-v2');
 const saved=await send({...reserve,queue_id:first.queue_id,approval_proof:fee});assert.equal(saved.state,'reserved');
 const other={...descriptor,operation_id:'second-member-original',method:'storyboard_save',amount_minor:0,resources:[{kind:'card',id:12}]},
  second=await send({type:'queue_join',company_id:'company',queue_key:'second-member-turn',items:[other]},bobCookie);
 assert.equal(second.state,'queued');assert.equal(second.reason,'capacity_exceeded');
 const original={...descriptor,attempt_id:reserve.attempt_id,admission_id:saved.admission_id};
 assert.equal((await send({...original,type:'dispatch',approval_proof:fee})).dispatch_allowed,true);
 assert.equal((await send({...descriptor,type:'status'})).state,'unknown');
 assert.equal((await send({type:'queue_status',company_id:'company',queue_id:second.queue_id},bobCookie)).state,'queued');
 const observed={...original,state:'completed',observation_sha256:'f'.repeat(64)},
  observationResponse=await f.call(prefix+'/observations',{cookie,method:'POST',value:{input:{...observed,type:'observation_quote'},issuer_id:authority.issuerId}});
 assert.equal(observationResponse.status,200);const observation=await observationResponse.json();
 const completed=await send({...observed,type:'settle',observation_proof:signedObservation(authority.keys.privateKey,observation,'muse-native-jubian-observation-v1')});
 assert.equal(completed.state,'completed');
 assert.equal((await send({type:'queue_status',company_id:'company',queue_id:second.queue_id},bobCookie)).state,'offered');
 assert.equal((await send({...other,type:'reserve',attempt_id:'bob-original',queue_id:second.queue_id},bobCookie)).state,'reserved');
 const policy=await send({type:'policy',company_id:'company'});assert.equal(policy.company_used_minor,100);assert.equal(policy.company_active,1);
 assert.equal((await send({...descriptor,type:'status'})).state,'completed');
 assert.equal(JSON.stringify(first).includes(f.bob.id),false);
});

test('parallel employee requests share a provider connection while retaining separate ownership and same-card locks',async t=>{
 const f=await fixture(t,{maxRequestBytes:8192}),cookies=await Promise.all([f.login('alice'),f.login('bob')]);
 const authority=await realAuthorities(f,companyPolicy(f,1,10000,3),undefined,
  {maxQueuedPerCompany:600,maxQueuedPerMember:10,offerTtlMs:60000,queuedTicketRetentionMs:300000});
 const bobKeys=generateKeyPairSync('ed25519'),bobIssuer=createHash('sha256')
  .update(bobKeys.publicKey.export({type:'spki',format:'der'})).digest('hex');
 authority.authority.enroll(f.store.get(f.bob.id),{issuerId:bobIssuer,
  publicKey:bobKeys.publicKey.export({type:'spki',format:'pem'}),deviceName:'Synthetic second employee Host'});
 const send=async(value,cookie=cookies[0],status=200)=>{
  const response=await f.call(prefix+'/admission',{cookie,method:'POST',value}),body=await response.json();
  assert.equal(response.status,status,JSON.stringify(body));return body;
 };
 const {type,...base}=request;assert.equal(type,'quote');
 const items=[11,12].map((id,index)=>({...base,method:'storyboard_save',amount_minor:0,
  operation_id:'parallel-employee-'+index,resources:[{kind:'card',id}]}));
 const tickets=await Promise.all(items.map((item,index)=>send({type:'queue_join',company_id:'company',
  queue_key:item.operation_id,items:[item]},cookies[index])));
 assert.ok(tickets.every(ticket=>ticket.state==='offered'));
 assert.notEqual(tickets[0].queue_id,tickets[1].queue_id);
 await send({type:'queue_status',company_id:'company',queue_id:tickets[0].queue_id},cookies[1],404);
 const reservations=await Promise.all(items.map((item,index)=>send({...item,type:'reserve',
  attempt_id:'parallel-attempt-'+index,queue_id:tickets[index].queue_id},cookies[index])));
 const originals=items.map((item,index)=>({...item,attempt_id:'parallel-attempt-'+index,
  admission_id:reservations[index].admission_id}));
 const dispatched=await Promise.all(originals.map((item,index)=>send({...item,type:'dispatch'},cookies[index])));
 assert.ok(dispatched.every(value=>value.dispatch_allowed===true));
 assert.equal((await send({type:'policy',company_id:'company'})).company_active,2);
 const duplicates=await Promise.all(originals.map((item,index)=>send({...item,type:'dispatch'},cookies[index])));
 assert.ok(duplicates.every(value=>value.dispatch_allowed===false));
 const sameCard={...items[0],operation_id:'same-card-later'};
 const waiting=await send({type:'queue_join',company_id:'company',queue_key:sameCard.operation_id,items:[sameCard]},cookies[1]);
 assert.equal(waiting.state,'queued');assert.equal(waiting.reason,'resource_busy');
 const before=await send({...items[0],type:'status'});assert.equal(before.state,'unknown');
 await send({...originals[0],type:'cancel',reason:'not_dispatched'},cookies[1],403);
 const identities=[{keys:authority.keys,issuer:authority.issuerId},{keys:bobKeys,issuer:bobIssuer}];
 const settled=await Promise.all(originals.map(async(item,index)=>{
  const observed={...item,state:'completed',observation_sha256:String(index+1).repeat(64)};
  const response=await f.call(prefix+'/observations',{cookie:cookies[index],method:'POST',
   value:{input:{...observed,type:'observation_quote'},issuer_id:identities[index].issuer}});
  const challenge=await response.json();assert.equal(response.status,200,JSON.stringify(challenge));
  return send({...observed,type:'settle',observation_proof:signedObservation(identities[index].keys.privateKey,
   challenge,'muse-native-jubian-observation-v1')},cookies[index]);
 }));
 assert.ok(settled.every(value=>value.state==='completed'));
 assert.equal((await send({type:'policy',company_id:'company'})).company_active,0);
 assert.equal((await send({type:'policy',company_id:'company'})).company_used_minor,0);
 assert.equal((await send({type:'queue_status',company_id:'company',queue_id:waiting.queue_id},cookies[1])).state,'offered');
 assert.deepEqual(await Promise.all(items.map((item,index)=>send({...item,type:'status'},cookies[index]).then(value=>value.state))),
  ['completed','completed']);
});

test('rate-limits metadata calls before another core request',async t=>{
 const f=await fixture(t,{rate:1}),cookie=await f.login('alice');
 assert.equal((await f.call(prefix+'/admission',{cookie,method:'POST',value:request})).status,200);
 assert.equal((await f.call(prefix+'/admission',{cookie,method:'POST',value:request})).status,429);
 assert.equal(f.calls.length,1);
});

test('accepts a representative 100-item signed metadata batch within the configured 256 KiB bound',async t=>{
 const f=await fixture(t,{maxRequestBytes:262144}),cookie=await f.login('alice'),{type,...descriptor}=request;
 assert.equal(type,'quote');
 const items=Array.from({length:100},(_,index)=>({...descriptor,operation_id:String(index).padStart(64,'a'),
  attempt_id:challengeId,approval_proof:{challenge_id:challengeId,issuer_id:issuer,signature:'s'.repeat(86),decision:'approved'}}));
 const value={type:'reserve_batch',items},bytes=Buffer.byteLength(JSON.stringify(value));
 assert.ok(bytes>65536&&bytes<262144);
 f.implement(async(_context,input)=>({accepted:input.items.length}));
 const response=await f.call(prefix+'/admission',{cookie,method:'POST',value});
 assert.equal(response.status,200);assert.deepEqual(await response.json(),{accepted:100});
 assert.equal(f.calls.length,1);
});

test('reads trusted current policy through the same authenticated metadata service without body identity',async t=>{
 const f=await fixture(t),cookie=await f.login('alice');
 f.implement(async()=>({policy_revision:3,role:'editor',projects:[]}));
 const value={type:'policy',company_id:'company'};
 const response=await f.call(prefix+'/admission',{cookie,method:'POST',value});
 assert.equal(response.status,200);assert.deepEqual(await response.json(),{policy_revision:3,role:'editor',projects:[]});
 assert.deepEqual(f.calls[0].value,value);assert.equal(f.calls[0].context.accountId,f.alice.id);
 for(const extra of [{actor_id:f.bob.id},{policy_revision:999},{approved:true}]){
  assert.equal((await f.call(prefix+'/admission',{cookie,method:'POST',value:{...value,...extra}})).status,400);
 }
 assert.equal(f.calls.length,1);
});

test('passes real free reserve, once-only dispatch and observation settlement through the account gateway',async t=>{
 const f=await fixture(t),cookie=await f.login('alice'),bobCookie=await f.login('bob');
 const core=await openNativeJubianAdmission({accounts:f.store,config:{version:1,databaseFile:join(f.root,'native-admission.sqlite'),
  busyTimeoutMs:1000,maxBatchItems:10,policy:companyPolicy(f)}});
 f.owners.push(core);f.implement((context,value)=>core.request(context,value));
 const zeroPaid=await f.call(prefix+'/admission',{cookie,method:'POST',value:{...request,amount_minor:0,
  operation_id:'zero-priced-paid-method',type:'reserve',attempt_id:'zero-attempt'}});
 assert.equal(zeroPaid.status,503);assert.equal((await zeroPaid.json()).error.code,'native_jubian_admission_native_approval_unavailable');
 assert.equal((await f.call(prefix+'/admission',{cookie,method:'POST',value:{...request,company_id:'another-company'}})).status,403);
 const free={...request,method:'storyboard_save',amount_minor:0};
 const send=async value=>{const response=await f.call(prefix+'/admission',{cookie,method:'POST',value});assert.equal(response.status,200);return response.json();};
 const quote=await send(free);assert.equal(quote.canonical.account_id,f.alice.id);assert.equal(quote.native_approval_required,false);
 const reserved=await send({...free,type:'reserve',attempt_id:'original-attempt'});assert.equal(reserved.state,'reserved');
 const dispatch={...free,type:'dispatch',attempt_id:'original-attempt',admission_id:reserved.admission_id};
 assert.equal((await send(dispatch)).dispatch_allowed,true);assert.equal((await send(dispatch)).dispatch_allowed,false);
 const settle={...free,type:'settle',attempt_id:'original-attempt',admission_id:reserved.admission_id,state:'completed',observation_sha256:'f'.repeat(64)};
 const unsigned=await f.call(prefix+'/admission',{cookie,method:'POST',value:settle});
 assert.equal(unsigned.status,503);assert.equal((await unsigned.json()).error.code,'native_jubian_admission_observation_approval_unavailable');
 assert.equal((await send({...settle,state:'unknown'})).state,'unknown');assert.equal((await send({...free,type:'status'})).state,'unknown');
 assert.equal((await f.call(prefix+'/admission',{cookie,method:'POST',value:{...settle,observed_cost:0}})).status,400);
 const shared=await f.call(prefix+'/admission',{cookie:bobCookie,method:'POST',value:{...free,operation_id:'bob-operation',resources:[{kind:'card',id:12}]}});
 assert.equal(shared.status,200);assert.equal((await shared.json()).canonical.account_id,f.bob.id);
 assert.equal(f.feesCalls.length,0);
});

test('uses original historical observation fields without demanding current budget or capacity',async t=>{
 const f=await fixture(t),cookie=await f.login('alice');
 const canonical={admission_id:'original-admission',current_policy_revision:2,operation_actor_id:f.alice.id};
 f.implement(async()=>({allowed:true,canonical,observation_approval_available:true,state:'unknown',
  within_limit:false,capacity_ready:false,resource_ready:false}));
 const value={input:{...request,type:'observation_quote',admission_id:'original-admission',attempt_id:'original-attempt',
  state:'completed',observation_sha256:'f'.repeat(64)},issuer_id:issuer};
 const response=await f.call(prefix+'/observations',{cookie,method:'POST',value});
 assert.equal(response.status,200);assert.equal((await response.json()).id,observationId);
 assert.deepEqual(f.feesCalls[0],{actor:f.alice.id,canonical,selectedIssuer:issuer,observation:true});
 assert.equal((await f.call(prefix+'/observations/'+observationId,{cookie})).status,200);
 const other=await f.login('bob');assert.equal((await f.call(prefix+'/observations/'+observationId,{cookie:other})).status,404);
 assert.equal((await f.call(prefix+'/observations',{cookie,method:'POST',value:{...value,approved:true}})).status,400);
 assert.equal((await f.call(prefix+'/observations',{cookie,method:'POST',value:{...value,input:{...request}}})).status,400);
});

test('uses the real actor and canonical target for budget questions and returns completed changes without another challenge',async t=>{
 const f=await fixture(t),cookie=await f.login('alice');
 const input={type:'budget_quote',company_id:'company',change_id:'member-limit',target:{kind:'member',account_id:f.alice.id},new_limit_minor:2000};
 const canonical={target:input.target,previous_limit_minor:1000,new_limit_minor:2000,target_revision:0,base_policy_revision:1};
 f.implement(async()=>({allowed:true,state:'quoted',canonical,budget_approval_available:true,capacity_ready:false,resource_ready:false}));
 const response=await f.call(prefix+'/budgets',{cookie,method:'POST',value:{input,issuer_id:issuer}});
 assert.equal(response.status,200);assert.equal((await response.json()).id,budgetId);
 assert.deepEqual(f.feesCalls[0],{actor:f.alice.id,canonical,selectedIssuer:issuer,budget:true});
 assert.equal((await f.call(prefix+'/budgets/'+budgetId,{cookie})).status,200);
 assert.equal((await f.call(prefix+'/budgets',{cookie,method:'POST',value:{input,issuer_id:issuer,approved:true}})).status,400);
 assert.equal((await f.call(prefix+'/budgets',{cookie,method:'POST',value:{input:{...input,target:{...input.target,actor_id:f.bob.id}},issuer_id:issuer}})).status,400);
 const count=f.feesCalls.length,applied={allowed:true,state:'applied',replayed:true,target_revision:1};
 f.implement(async()=>applied);
 assert.deepEqual(await(await f.call(prefix+'/budgets',{cookie,method:'POST',value:{input,issuer_id:issuer}})).json(),applied);
 assert.equal(f.feesCalls.length,count);
});

test('requires independent real budget signatures for company, member and project changes without granting generation',async t=>{
 const f=await fixture(t),cookie=await f.login('alice'),policy=companyPolicy(f);
 policy.companies[0].members[1].limitMinor=1000;policy.companies[0].projects[0].limitMinor=2000;
 const {authority,keys,issuerId:actualIssuer}=await realAuthorities(f,policy);
 const send=async(value,expected=200,selected=cookie)=>{
  const response=await f.call(prefix+'/admission',{cookie:selected,method:'POST',value});assert.equal(response.status,expected);return response.json();
 };
 const feeResponse=await f.call(prefix+'/challenges',{cookie,method:'POST',value:{input:request,issuer_id:actualIssuer}});
 assert.equal(feeResponse.status,200);const fee=await feeResponse.json(),feeProof=signedObservation(keys.privateKey,fee,'muse-native-jubian-fee-v2');
 const targets=[{kind:'member',account_id:f.bob.id},{kind:'company'},
  {kind:'project',provider_origin:request.provider_origin,script_id:request.script_id}];
 const limits=[1500,9000,2500];let firstBudgetProof;
 for(const [index,target] of targets.entries()){
  const proposal={type:'budget_quote',company_id:'company',change_id:'budget-change-'+index,target,new_limit_minor:limits[index]};
  const response=await f.call(prefix+'/budgets',{cookie,method:'POST',value:{input:proposal,issuer_id:actualIssuer}});
  assert.equal(response.status,200);const challenge=await response.json(),payload=JSON.parse(challenge.payload);
  assert.equal(challenge.version,1);assert.equal(payload.version,2);assert.equal(payload.action,'native-jubian-budget');
  assert.deepEqual(payload.target,target);assert.equal(payload.new_limit_minor,limits[index]);assert.equal(payload.target_revision,0);
  const budgetProof=signedObservation(keys.privateKey,challenge,'muse-native-jubian-budget-v1');
  const update={...proposal,type:'budget_update',expected_revision:payload.target_revision,
   base_policy_revision:payload.base_policy_revision,budget_proof:budgetProof};
  if(index===0){
   firstBudgetProof=budgetProof;
   assert.equal((await f.call(prefix+'/budgets/'+challenge.id,{cookie})).status,200);
   assert.equal((await f.call(prefix+'/challenges/'+challenge.id,{cookie})).status,409);
   assert.equal((await f.call(prefix+'/observations/'+challenge.id,{cookie})).status,409);
   assert.equal((await f.call(prefix+'/budgets/'+fee.id,{cookie})).status,409);
   const wrongFee=await f.call(prefix+'/admission',{cookie,method:'POST',value:{...update,budget_proof:feeProof}});
   assert.equal(wrongFee.status,409);
   const changed=await f.call(prefix+'/admission',{cookie,method:'POST',value:{...update,new_limit_minor:1501}});
   assert.equal(changed.status,409);
  }
  const result=await send(update);assert.equal(result.state,'applied');assert.equal(result.target_revision,1);
  assert.equal((await send(update)).replayed,true);
  const restored=await f.call(prefix+'/budgets',{cookie,method:'POST',value:{input:proposal,issuer_id:actualIssuer}});
  assert.equal(restored.status,200);assert.equal((await restored.json()).state,'applied');
 }
 const unrelated=await f.call(prefix+'/admission',{cookie,method:'POST',value:{...request,type:'reserve',
  attempt_id:'budget-is-not-generation',approval_proof:firstBudgetProof}});
 assert.equal(unrelated.status,409);
 const bobCookie=await f.login('bob'),bobKeys=generateKeyPairSync('ed25519');
 const bobIssuer=createHash('sha256').update(bobKeys.publicKey.export({type:'spki',format:'der'})).digest('hex');
 authority.enroll(f.store.get(f.bob.id),{issuerId:bobIssuer,publicKey:bobKeys.publicKey.export({type:'spki',format:'pem'}),deviceName:'Synthetic member Host'});
 const self={type:'budget_quote',company_id:'company',change_id:'member-self-change',target:{kind:'member',account_id:f.bob.id},new_limit_minor:2000};
 const ownResponse=await f.call(prefix+'/budgets',{cookie:bobCookie,method:'POST',value:{input:self,issuer_id:bobIssuer}});
 assert.equal(ownResponse.status,200);const own=await ownResponse.json(),ownPayload=JSON.parse(own.payload);
 assert.equal(ownPayload.previous_limit_minor,1500);assert.equal(ownPayload.target_revision,1);
 assert.equal((await send({...self,type:'budget_update',expected_revision:1,base_policy_revision:1,
  budget_proof:signedObservation(bobKeys.privateKey,own,'muse-native-jubian-budget-v1')},200,bobCookie)).state,'applied');
 await send({...self,change_id:'other-member',target:{kind:'member',account_id:f.alice.id}},403,bobCookie);
 await send({...self,change_id:'other-company',company_id:'another-company'},403,bobCookie);
 const reserved=await send({...request,type:'reserve',attempt_id:'native-fee-only',approval_proof:feeProof});
 const floor=await send({type:'budget_quote',company_id:'company',change_id:'below-live-hold',target:{kind:'company'},new_limit_minor:50},409);
 assert.equal(floor.error.code,'native_jubian_admission_budget_below_usage');
 assert.equal((await send({type:'policy',company_id:'company'})).company_held_minor,100);
 await send({...request,type:'cancel',attempt_id:'native-fee-only',admission_id:reserved.admission_id,reason:'not_dispatched'});
});

test('requires a distinct signed observation before a terminal settlement can release real SQLite resources',async t=>{
 const f=await fixture(t),cookie=await f.login('alice'),{core,keys,issuerId:actualIssuer}=await realAuthorities(f);
 const free={...request,method:'storyboard_save',amount_minor:0};
 const send=async value=>{const response=await f.call(prefix+'/admission',{cookie,method:'POST',value});assert.equal(response.status,200);return response.json();};
 const feeResponse=await f.call(prefix+'/challenges',{cookie,method:'POST',value:{input:free,issuer_id:actualIssuer}});
 assert.equal(feeResponse.status,200);const fee=await feeResponse.json();
 const feeProof=signedObservation(keys.privateKey,fee,'muse-native-jubian-fee-v2');
 const saved=await send({...free,type:'reserve',attempt_id:'original-attempt'});
 const original={...free,admission_id:saved.admission_id,attempt_id:'original-attempt'};
 assert.equal((await send({...original,type:'dispatch'})).dispatch_allowed,true);
 core.installPolicy(companyPolicy(f,2,0,1));
 const observed={...original,state:'completed',observation_sha256:'f'.repeat(64)};
 const observationResponse=await f.call(prefix+'/observations',{cookie,method:'POST',value:{
  input:{...observed,type:'observation_quote'},issuer_id:actualIssuer}});
 assert.equal(observationResponse.status,200);const observation=await observationResponse.json(),payload=JSON.parse(observation.payload);
 assert.equal(observation.version,1);assert.equal(payload.version,2);assert.equal(payload.action,'native-jubian-observation');
 assert.equal(payload.policy_revision,1);assert.equal(payload.current_policy_revision,2);
 assert.equal((await f.call(prefix+'/observations/'+fee.id,{cookie})).status,409);
 assert.equal((await f.call(prefix+'/challenges/'+observation.id,{cookie})).status,409);
 const newLogin=await f.login('alice');assert.equal((await f.call(prefix+'/observations/'+observation.id,{cookie:newLogin})).status,409);
 const proof=signedObservation(keys.privateKey,observation,'muse-native-jubian-observation-v1');
 for(const rejected of [{...observed,observation_proof:feeProof},
  {...observed,observation_sha256:'e'.repeat(64),observation_proof:proof},{...observed}]){
  const result=await f.call(prefix+'/admission',{cookie,method:'POST',value:{...rejected,type:'settle'}});
  assert.ok(result.status>=400&&result.status<500);assert.equal((await send({...free,type:'status'})).state,'unknown');
 }
 const held=await send({...free,type:'quote',operation_id:'other-writer',policy_revision:2});
 assert.equal(held.capacity_ready,false);assert.equal(held.resource_ready,false);
 assert.equal((await send({...observed,type:'settle',observation_proof:proof})).state,'completed');
 const released=await send({...free,type:'quote',operation_id:'other-writer',policy_revision:2});
 assert.equal(released.capacity_ready,true);assert.equal(released.resource_ready,true);
});

test('rechecks a revoked account after canonical lookup before creating any native challenge',async t=>{
 const f=await fixture(t),cookie=await f.login('alice'),entered=Promise.withResolvers(),release=Promise.withResolvers();
 f.releases.push(()=>release.resolve());
 f.implement(async()=>{entered.resolve();await release.promise;return {within_limit:true,capacity_ready:true,resource_ready:true,canonical:{...request}};});
 const pending=f.call(prefix+'/challenges',{cookie,method:'POST',value:{input:request,issuer_id:issuer}});
 await entered.promise;await f.store.setDisabled(f.alice.id,true);release.resolve();
 assert.equal((await pending).status,401);assert.equal(f.feesCalls.length,0);
});

test('drains admitted metadata work before its injected stores can close',async t=>{
 const entered=Promise.withResolvers(),release=Promise.withResolvers(),finished=[];
 const context={id:'a'.repeat(16),token:'authenticated-login-token',account:{revision:1}};
 const adapter=createNativeJubianHttp({admission:{async request(){entered.resolve();await release.promise;return {state:'reserved'};}}});
 const server=http.createServer((req,res)=>{void adapter.route(req,res,{path:prefix+'/admission',session:context,
  currentSession:()=>context,publicOrigin:'https://muse.native.test',rate:()=>true});});
 t.after(async()=>{release.resolve();server.closeAllConnections();if(server.listening)await new Promise(resolve=>server.close(resolve));await adapter.close();});
 server.listen(0,'127.0.0.1');await once(server,'listening');
 const pending=fetch('http://127.0.0.1:'+server.address().port+prefix+'/admission',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(request)});
 await entered.promise;const closing=adapter.close().then(()=>finished.push('closed'));
 await Promise.resolve();assert.deepEqual(finished,[]);release.resolve();await closing;
 assert.equal((await pending).status,200);assert.deepEqual(finished,['closed']);
});

test('cancels an incomplete bounded body and never starts admission while closing',async t=>{
 const entered=Promise.withResolvers(),clientClosed=Promise.withResolvers(),calls=[];
 const context={id:'a'.repeat(16),token:'authenticated-login-token',account:{revision:1}};
 const adapter=createNativeJubianHttp({admission:{request(){calls.push('unexpected');return {};}}});
 const server=http.createServer((req,res)=>{
  void adapter.route(req,res,{path:prefix+'/admission',session:context,currentSession:()=>context,
   publicOrigin:'https://muse.native.test',rate:()=>true});
  queueMicrotask(()=>entered.resolve());
 });
 t.after(async()=>{server.closeAllConnections();if(server.listening)await new Promise(resolve=>server.close(resolve));await adapter.close();});
 server.listen(0,'127.0.0.1');await once(server,'listening');
 const client=http.request({hostname:'127.0.0.1',port:server.address().port,path:prefix+'/admission',method:'POST',
  headers:{'content-type':'application/json','content-length':100}},res=>{res.resume();res.on('end',()=>clientClosed.resolve());});
 client.once('error',()=>clientClosed.resolve());t.after(()=>client.destroy());client.write('{');
 await entered.promise;await adapter.close();await clientClosed.promise;assert.deepEqual(calls,[]);
});

test('real source signatures carry Word metadata through once-only intents and register only the observed company project',async t=>{
 const f=await fixture(t,{maxRequestBytes:8192}),cookie=await f.login('alice');
 const sources={version:1,revision:1,companies:[{companyId:'company',namespace:'company-source',allowedOrigins:[request.provider_origin],
  roles:['owner','admin','editor'],maxPendingSources:10,maxPendingSourcesPerMember:5,maxActiveEffects:10,maxActiveEffectsPerMember:5,newProjectMaxParallel:2}]};
 const {keys,issuerId:actualIssuer}=await realAuthorities(f,companyPolicy(f),sources);
 const send=async(value,status=200,selectedCookie=cookie)=>{
  const response=await f.call(prefix+'/admission',{cookie:selectedCookie,method:'POST',value});
  const result=await response.json();assert.equal(response.status,status,JSON.stringify(result));return result;
 };
 const sourceChallenge=async(proposal,consent=false)=>{
  const response=await f.call(prefix+'/sources/'+(consent?'consents':'managed'),{cookie,method:'POST',value:{input:proposal,issuer_id:actualIssuer}});
  const result=await response.json();assert.equal(response.status,200,JSON.stringify(result));return result;
 };
 const signature=(challenge,consent=false)=>signedObservation(keys.privateKey,challenge,
  consent?'muse-native-jubian-source-consent-v1':'muse-native-jubian-source-managed-v1');
 const word={type:'source_quote',company_id:'company',provider_origin:request.provider_origin,
  provider_connection_revision:request.provider_connection_revision,operation_id:'first-word-company-source',method:'manuscript_submit',plan_sha256:'7'.repeat(64),
  source:{kind:'word_pair',manuscript:{sha256:'1'.repeat(64),bytes:1200,name_sha256:'2'.repeat(64)},
   original:{sha256:'3'.repeat(64),bytes:800,name_sha256:'4'.repeat(64)},declarations_sha256:'5'.repeat(64),catalogue_sha256:'6'.repeat(64)}};
 const quote=await send(word);
 assert.equal(quote.canonical.account_id,f.alice.id);assert.equal(quote.canonical.source_actor_id,f.alice.id);
 assert.equal(quote.canonical.namespace,'company-source');assert.equal(Object.hasOwn(quote.canonical,'script_id'),false);
 await send({...word,account_id:f.bob.id},400);await send({...word,script_id:1},400);
 const consent=await sourceChallenge(word,true),managed=await sourceChallenge(word),
  rights=signature(consent,true),attestation=signature(managed);
 assert.equal(JSON.parse(consent.payload).canonical.purpose,'source_scope');
 assert.equal((await f.call(prefix+'/sources/consents/'+consent.id,{cookie})).status,200);
 assert.equal((await f.call(prefix+'/sources/managed/'+consent.id,{cookie})).status,409);
 assert.equal((await f.call(prefix+'/challenges/'+managed.id,{cookie})).status,409);
 const reserved={...word,type:'source_reserve',consent_proof:rights,managed_proof:attestation};
 await send({...reserved,managed_proof:rights},409);
 const scope=await send(reserved);assert.equal(scope.state,'open');assert.equal((await send(reserved)).replayed,true);
 const common={company_id:'company',operation_id:word.operation_id};
 const effect=async(kind,destination,receipt,operation=common)=>{
  const proposal={type:'source_effect_quote',...operation,kind,request_sha256:kind==='create_project'?'e'.repeat(64):'9'.repeat(64),destination};
  const question=await sourceChallenge(proposal),approved=signature(question);
  const pending=await send({...proposal,type:'source_effect_reserve',managed_proof:approved});assert.equal(pending.state,'reserved');
  const dispatch={...proposal,type:'source_effect_dispatch',managed_proof:approved},permitted=await send(dispatch);
  assert.equal(permitted.dispatch_allowed,true);assert.equal(permitted.state,'unknown');
  assert.equal((await send(dispatch)).dispatch_allowed,false);
  const observing={...proposal,type:'source_effect_observation_quote',receipt},readback=await sourceChallenge(observing);
  const observed=await send({...observing,type:'source_effect_observe',managed_proof:signature(readback)});
  assert.equal(observed.state,'confirmed');assert.deepEqual(observed.receipt,receipt);
  assert.equal((await send({...observing,type:'source_effect_observe',managed_proof:signature(readback)})).replayed,true);
 };
 await send({type:'source_effect_quote',...common,kind:'submit_manuscript',request_sha256:'9'.repeat(64),destination:null},409);
 for(const [index,role] of ['manuscript','original'].entries()){
  const file=word.source[role],destination={object_key:'prod/sys-material-video/2026/11/17/'+String(index+1).repeat(32)+'.docx',
   sha256:file.sha256,bytes:file.bytes};
  await effect('upload_'+role,destination,{kind:'upload',role,...destination});
 }
 await effect('submit_manuscript',null,{kind:'manuscript',manuscript_id:45,matched_plan_sha256:word.plan_sha256,readback_sha256:'d'.repeat(64)});
 const submitted=await send({type:'source_status',...common});assert.equal(submitted.state,'completed');assert.equal(submitted.effects.length,3);
 assert.equal((await send({type:'policy',company_id:'company'})).projects.length,1);
 const manual={...word,type:'source_quote',operation_id:'manual-company-project',method:'manual_project_create',source:{kind:'existing_manuscript',manuscript_id:45}};
 const manualScope=await sourceChallenge(manual);
 await send({...manual,type:'source_reserve',managed_proof:signature(manualScope)});
 await effect('create_project',null,{kind:'project',script_id:999,manuscript_id:45,matched_request_sha256:'e'.repeat(64),readback_sha256:'d'.repeat(64)},
  {...common,operation_id:manual.operation_id});
 const bob=await f.login('bob'),policy=await send({type:'policy',company_id:'company'},200,bob),project=policy.projects.find(row=>row.script_id===999);
 assert.equal(project.limit_minor,0);assert.equal(project.max_parallel,2);assert.equal(project.active,true);
 const paid={...request,script_id:999,operation_id:'new-project-paid-first'};
 assert.equal((await send(paid)).within_limit,false);
 const proposal={type:'budget_quote',company_id:'company',change_id:'new-project-user-approved-limit',
  target:{kind:'project',provider_origin:request.provider_origin,script_id:999},new_limit_minor:500};
 const budgetResponse=await f.call(prefix+'/budgets',{cookie,method:'POST',value:{input:proposal,issuer_id:actualIssuer}});
 assert.equal(budgetResponse.status,200);const budget=await budgetResponse.json(),payload=JSON.parse(budget.payload);
 await send({...proposal,type:'budget_update',expected_revision:payload.target_revision,base_policy_revision:payload.base_policy_revision,
  budget_proof:signedObservation(keys.privateKey,budget,'muse-native-jubian-budget-v1')});
 assert.equal((await send(paid)).within_limit,true);
 assert.ok(!JSON.stringify(f.calls).includes(cookie.slice(cookie.indexOf('=')+1)));
});

test('source challenge routes fail closed without their authority and reject arbitrary proof or actor fields',async t=>{
 const f=await fixture(t),cookie=await f.login('alice');
 const proposal={type:'source_quote',company_id:'company',provider_origin:request.provider_origin,
  provider_connection_revision:request.provider_connection_revision,operation_id:'manual-company-project',method:'manual_project_create',
  source:{kind:'existing_manuscript',manuscript_id:45},plan_sha256:'7'.repeat(64)};
 f.implement(()=>({allowed:true,state:'quoted',canonical:{marker:'trusted-core'},managed_proof_available:true}));
 assert.equal((await f.call(prefix+'/sources/managed',{cookie,method:'POST',value:{input:proposal,issuer_id:issuer}})).status,503);
 assert.equal((await f.call(prefix+'/sources/consents',{cookie,method:'POST',value:{input:proposal,issuer_id:issuer}})).status,503);
 assert.equal((await f.call(prefix+'/sources/managed/'+challengeId,{cookie})).status,503);
 assert.equal((await f.call(prefix+'/admission',{cookie,method:'POST',value:{...proposal,managed_proof:{approved:true}}})).status,400);
 assert.equal((await f.call(prefix+'/sources/managed',{cookie,method:'POST',value:{input:proposal,issuer_id:issuer,account_id:f.bob.id}})).status,400);
});

test('company Feishu membership uses verified account bindings and independent native budgets without a per-employee policy rewrite',async t=>{
 const f=await fixture(t,{maxRequestBytes:8192}),policy=companyPolicy(f),company=policy.companies[0];
 company.members=company.members.filter(row=>row.accountId===f.alice.id);
 company.memberDirectory={kind:'feishu',active:true,appId:'cli_company',tenantKey:'company-tenant',role:'editor',limitMinor:0,maxParallel:2};
 const sourcePolicy={version:1,revision:1,companies:[{companyId:'company',namespace:'company-source',allowedOrigins:[request.provider_origin],
  roles:['owner','admin','editor'],maxPendingSources:10,maxPendingSourcesPerMember:5,maxActiveEffects:10,maxActiveEffectsPerMember:5,newProjectMaxParallel:2}]};
 const {core,authority}=await realAuthorities(f,policy,sourcePolicy);
 const employee=await f.store.resolveFeishuIdentity({appId:'cli_company',tenantKey:'company-tenant',openId:'employee-open-id',name:'Employee'});
 const token=await f.sessionStore.issue({id:employee.id,revision:employee.revision,expiry:Date.now()+60000});
 const send=async(value,status=200,selectedToken=token)=>{
  const response=await f.call(prefix+'/admission',{token:selectedToken,method:'POST',value}),body=await response.json();
  assert.equal(response.status,status,JSON.stringify(body));return body;
 };
 const visible=await send({type:'policy',company_id:'company'});
 assert.equal(visible.role,'editor');assert.equal(visible.member_limit_minor,0);assert.equal(visible.member_max_parallel,2);
 assert.equal(visible.projects.length,1);assert.equal(JSON.stringify(visible).includes('employee-open-id'),false);
 assert.equal(JSON.stringify(visible).includes('company-tenant'),false);
 assert.equal((await send({...request,amount_minor:1})).within_limit,false);
 await send({type:'policy',company_id:'company',feishuIdentities:[{appId:'cli_company',tenantKey:'company-tenant'}]},400);
 const bob=await f.login('bob');
 assert.equal((await f.call(prefix+'/admission',{cookie:bob,method:'POST',value:{type:'policy',company_id:'company'}})).status,403);
 for(const identity of [{appId:'cli_company',tenantKey:'another-tenant'},{appId:'another-app',tenantKey:'company-tenant'}]){
  const outsider=await f.store.resolveFeishuIdentity({...identity,openId:'outsider-open-id',name:'Outsider'});
  const outsiderToken=await f.sessionStore.issue({id:outsider.id,revision:outsider.revision,expiry:Date.now()+60000});
  await send({type:'policy',company_id:'company'},403,outsiderToken);
 }
 const source={type:'source_quote',company_id:'company',provider_origin:request.provider_origin,
  provider_connection_revision:request.provider_connection_revision,operation_id:'employee-source',method:'manual_project_create',
  source:{kind:'existing_manuscript',manuscript_id:45},plan_sha256:'7'.repeat(64)};
 assert.equal((await send(source)).canonical.account_id,employee.id);
 const keys=generateKeyPairSync('ed25519'),employeeIssuer=createHash('sha256')
  .update(keys.publicKey.export({type:'spki',format:'der'})).digest('hex');
 authority.enroll(f.store.get(employee.id),{issuerId:employeeIssuer,
  publicKey:keys.publicKey.export({type:'spki',format:'pem'}),deviceName:'Synthetic employee Host'});
 const proposal={type:'budget_quote',company_id:'company',change_id:'employee-self-allowance',target:{kind:'member',account_id:employee.id},new_limit_minor:200};
 const budgetResponse=await f.call(prefix+'/budgets',{token,method:'POST',value:{input:proposal,issuer_id:employeeIssuer}});
 const challenge=await budgetResponse.json();assert.equal(budgetResponse.status,200,JSON.stringify(challenge));
 const payload=JSON.parse(challenge.payload);
 assert.equal(payload.previous_limit_minor,0);assert.equal(payload.account_id,employee.id);
 const adjusted=await send({...proposal,type:'budget_update',expected_revision:payload.target_revision,
  base_policy_revision:payload.base_policy_revision,budget_proof:signedObservation(keys.privateKey,challenge,'muse-native-jubian-budget-v1')});
 assert.equal(adjusted.state,'applied');assert.equal((await send({type:'policy',company_id:'company'})).member_limit_minor,200);
 const free={...request,type:'reserve',operation_id:'employee-free-original',method:'asset_rename',resources:[{kind:'asset',id:21}],amount_minor:0,attempt_id:'employee-original'};
 const reserved=await send(free),dispatched=await send({...free,type:'dispatch',admission_id:reserved.admission_id});
 assert.equal(dispatched.dispatch_allowed,true);
 core.installPolicy({...policy,revision:2,companies:[{...company,members:[...company.members,
  {accountId:employee.id,role:'editor',active:false,limitMinor:0,maxParallel:1}]}]});
 await send({type:'policy',company_id:'company'},403);await send(source,403);
 const descriptor=Object.fromEntries(Object.entries(free).filter(([key])=>key!=='attempt_id'));
 const ownerCookie=await f.login('alice'),historical=await f.call(prefix+'/admission',{cookie:ownerCookie,method:'POST',value:{...descriptor,type:'status'}});
 assert.equal(historical.status,200);assert.equal((await historical.json()).state,'unknown');
 core.installPolicy({...policy,revision:3,companies:[{...company,memberDirectory:{...company.memberDirectory,role:'viewer'}}]});
 assert.equal((await send({type:'policy',company_id:'company'})).role,'viewer');
 await send({...free,operation_id:'viewer-cannot-reserve',policy_revision:3},403);
 assert.equal((await send({type:'policy',company_id:'company'})).member_limit_minor,200);
});

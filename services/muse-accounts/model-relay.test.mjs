import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import http from 'node:http';
import https from 'node:https';
import {Readable} from 'node:stream';
import {createModelRelay,accountToken,resolveModelReasoning,fetchPublicModelListing,publicLookup} from './model-relay.mjs';
import {createDesktopModels} from './desktop-models.mjs';
import {createModelKeyPool} from './model-key-pool.mjs';
import {createAccountServer} from './gateway.mjs';
import {openStore} from './store.mjs';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const settings={model:'glm-5.3-flash',apiKey:'synthetic-private-key',maxTokens:32768,reasoningEfforts:{low:'wire-low',high:'wire-high'},defaultReasoningEffort:'low'};

test('model listing transport pins public DNS, retains cancellation and refuses redirects',async t=>{
 const calls=[],signal=new AbortController().signal;let status=200;
 t.mock.method(https,'request',(url,options,receive)=>{
  calls.push({url,options});const request=new EventEmitter();request.end=()=>{
   const response=Readable.from([Buffer.from('{"data":[{"id":"fixture-model"}]}')]);
   response.statusCode=status;response.headers={'content-type':'application/json','x-fixture':['one','two'],'x-absent':undefined};receive(response);
  };return request;
 });
 const response=await fetchPublicModelListing('https://provider.example/v1/models',{headers:new Headers({authorization:'Bearer synthetic-key'}),signal});
 assert.deepEqual(await response.json(),{data:[{id:'fixture-model'}]});assert.equal(response.headers.get('x-fixture'),'one, two');
 assert.equal(calls[0].options.lookup,publicLookup);assert.equal(calls[0].options.signal,signal);assert.equal(calls[0].options.method,'GET');
 assert.equal(calls[0].options.headers.authorization,'Bearer synthetic-key');
 for(const code of [302,401,204,600]){status=code;const failure=await fetchPublicModelListing('https://provider.example/v1/models',{headers:{},signal});
  assert.equal(failure.status,code===600?502:code);assert.equal(await failure.text(),'');}
 for(const url of ['http://provider.example/v1/models','https://127.0.0.1/v1/models','https://user:password@provider.example/v1/models'])await assert.rejects(fetchPublicModelListing(url,{headers:{},signal}));
 assert.equal(calls.length,5);
 t.mock.method(https,'request',()=>{const request=new EventEmitter();request.end=()=>request.emit('error',Error('synthetic-transport-failure'));return request;});
 await assert.rejects(fetchPublicModelListing('https://provider.example/v1/models',{headers:{},signal}),/synthetic-transport-failure/);
});

test('Desktop relay keeps one thousand synthetic account requests active without an imposed shared limit',{timeout:30000},async t=>{
 let release,entered;const held=new Promise(r=>{release=r;}),allStarted=new Promise(r=>{entered=r;});let calls=0;
 const desktop=createDesktopModels({globalModels:{resolve:()=>settings},forward:async({res})=>{if(++calls===1000)entered();await held;res.end('done');}});
 const requests=Array.from({length:1000},(_,index)=>{
  const req=Readable.from([Buffer.from(JSON.stringify({model:settings.model,messages:[]}))]);req.method='POST';
  const res=new EventEmitter();res.writeHead=()=>{};res.end=()=>{};
  return desktop.handle(req,res,{id:'account-'+index,token:'session-'+index,expiry:Date.now()+60000},'/api/desktop-models/studio/chat/completions');
 });
 try{
  await Promise.race([allStarted,new Promise((_,reject)=>t.signal.addEventListener('abort',()=>reject(Error('Concurrent relay fixture timed out')),{once:true}))]);
  assert.equal(calls,1000);
 }finally{release();await Promise.all(requests);desktop.close();}
});

test('cloud workspace relay forwards eight simultaneous requests and cancels them on account revocation',{timeout:30000},async t=>{
 const id='0123456789abcdef',secret='synthetic-test-secret',accounts=new EventEmitter();accounts.get=()=>({id});
 let entered;const allStarted=new Promise(r=>{entered=r;});let calls=0,aborted=0;
 const server=createModelRelay({accounts,secret,globalModels:{resolve:()=>settings},forward:async({res,signal})=>{
  if(++calls===8)entered();
  await new Promise(resolve=>signal.addEventListener('abort',()=>{aborted++;resolve();},{once:true}));
  res.end('done');
 }});
 t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+server.address().port;
 const pending=Array.from({length:8},()=>fetch(base+'/v1/studio/chat/completions',{method:'POST',headers:{authorization:'Bearer '+accountToken(secret,id),'content-type':'application/json'},body:JSON.stringify({model:settings.model,messages:[]})}));
 await allStarted;assert.equal(calls,8);accounts.emit('change',id);
 const responses=await Promise.all(pending);assert.ok(responses.every(response=>response.status===200));
 await Promise.all(responses.map(response=>response.text()));assert.equal(aborted,8);
});

test('model default maps to its wire value and explicit efforts remain selected',()=>{
 const omitted={};resolveModelReasoning(settings,omitted);assert.deepEqual(omitted,{reasoning_effort:'wire-low',thinking:{type:'enabled',clear_thinking:false}});
 const explicit={reasoning_effort:'wire-high'};resolveModelReasoning(settings,explicit);assert.equal(explicit.reasoning_effort,'wire-high');
 assert.throws(()=>resolveModelReasoning(settings,{reasoning_effort:'unknown'}),/思考档位/);
 assert.throws(()=>resolveModelReasoning(settings,{thinking:{type:'disabled'}}),/不支持关闭思考/);
 const unrelated={};resolveModelReasoning({...settings,model:'writer',defaultReasoningEffort:undefined},unrelated);assert.deepEqual(unrelated,{});
 const disabled={};resolveModelReasoning({...settings,model:'writer',thinking:'disabled'},disabled);assert.deepEqual(disabled,{thinking:{type:'disabled'}});
});

test('account relay forwards model defaults and caps output without modifying tool history',async t=>{
 const id='0123456789abcdef',secret='synthetic-test-secret',accounts=new EventEmitter();accounts.get=()=>({id});const calls=[];
 const server=createModelRelay({accounts,secret,globalModels:{resolve:()=>settings},forward:async({body,res})=>{calls.push(structuredClone(body));res.end('done');}});
 t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+server.address().port;
 const post=body=>fetch(base+'/v1/studio/chat/completions',{method:'POST',headers:{authorization:'Bearer '+accountToken(secret,id),'content-type':'application/json'},body:JSON.stringify({model:settings.model,messages:[{role:'assistant',reasoning_content:'saved reasoning',content:'answer'}],...body})});
 assert.equal((await post({})).status,200);assert.equal(calls[0].max_tokens,32768);assert.equal(calls[0].reasoning_effort,'wire-low');assert.equal(calls[0].messages[0].reasoning_content,'saved reasoning');
 assert.equal((await post({reasoning_effort:'wire-high',max_tokens:40000})).status,200);assert.equal(calls[1].max_tokens,32768);assert.equal(calls[1].reasoning_effort,'wire-high');
 assert.equal((await post({reasoning_effort:'unknown'})).status,400);assert.equal(calls.length,2);
});

test('Desktop relay uses the same defaults and releases rejected requests',async()=>{
 const calls=[],desktop=createDesktopModels({globalModels:{resolve:()=>settings},forward:async({body,res})=>{calls.push(structuredClone(body));res.end('done');}});
 const invoke=async body=>{
  const request=Readable.from([Buffer.from(JSON.stringify({model:settings.model,messages:[],...body}))]);request.method='POST';
  const response=new EventEmitter();response.writeHead=status=>{response.statusCode=status;};response.end=()=>{};
  await desktop.handle(request,response,{id:'alice',token:'session',expiry:Date.now()+60000},'/api/desktop-models/studio/chat/completions');return response.statusCode;
 };
 try{await invoke({});assert.equal(calls[0].max_tokens,32768);assert.equal(calls[0].reasoning_effort,'wire-low');assert.equal(await invoke({reasoning_effort:'unknown'}),400);await invoke({max_tokens:1234,reasoning_effort:'wire-high'});assert.equal(calls[1].max_tokens,1234);assert.equal(calls[1].reasoning_effort,'wire-high');}finally{desktop.close();}
});

test('Desktop and cloud share one whole-stream supplier slot, logout and account revocation release it',{timeout:30000},async t=>{
 const dir=await mkdtemp(join(tmpdir(),'muse-shared-model-pool-')),servers=[],pending=[];
 const keys=['synthetic-independent-key'],policy={concurrency:1,maxQueued:1,waitMs:30000};
 const pool=createModelKeyPool({keys:()=>keys,...policy});let acquisitions=0,queued;
 const queueEntered=new Promise(resolve=>{queued=resolve;});
 const shared={...pool,acquire(signal){if(++acquisitions===2)queued();return pool.acquire(signal);}};
 t.after(async()=>{pool.close();for(const server of servers)server.closeAllConnections();
  await Promise.allSettled(pending);await Promise.all(servers.map(server=>new Promise(resolve=>server.close(resolve))));
  await rm(dir,{recursive:true,force:true});});
 const store=await openStore(join(dir,'accounts.json'));await store.create('desktop-editor','pw');
 const cloudAccount=await store.create('cloud-editor','pw'),origin='https://muse.test',secret='synthetic-model-secret';
 const globalModels={credentialPool:route=>route==='zhipu-official'?keys:undefined,
  resolve:(route,id)=>route==='zhipu-official'&&id===settings.model?{...settings,apiKey:keys[0],baseURL:'https://supplier.test/v1'}:undefined};
 let active=0,peak=0,calls=0,aborted=0,firstEntered,secondEntered;
 const firstStarted=new Promise(resolve=>{firstEntered=resolve;}),secondStarted=new Promise(resolve=>{secondEntered=resolve;});
 const forward=async({config,res,signal})=>{
  assert.equal(config.apiKey,keys[0]);active++;peak=Math.max(peak,active);calls++;
  res.writeHead(200,{'content-type':'text/event-stream'});res.write('data: {"choices":[]}\n\n');
  if(calls===1)firstEntered();if(calls===2)secondEntered();
  try{signal.throwIfAborted();await new Promise((_,reject)=>signal.addEventListener('abort',()=>{aborted++;reject(Error('revoked stream'));},{once:true}));}
  finally{active--;}
 };
 const desktop=createAccountServer({store,globalModels,publicOrigin:origin,modelForward:forward,modelKeyPool:shared});servers.push(desktop);
 const cloud=createModelRelay({accounts:store,secret,globalModels,forward,keyPool:shared});servers.push(cloud);
 for(const server of servers)await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const desktopBase='http://127.0.0.1:'+desktop.address().port,cloudBase='http://127.0.0.1:'+cloud.address().port;
 const track=promise=>{pending.push(promise);return promise;};
 const login=await fetch(desktopBase+'/login',{method:'POST',redirect:'manual',headers:{origin},body:'username=desktop-editor&password=pw'});
 assert.equal(login.status,303);const cookie=login.headers.get('set-cookie').split(';')[0];
 const body=JSON.stringify({model:settings.model,messages:[],stream:true});
 const first=track(fetch(desktopBase+'/api/desktop-models/zhipu-official/chat/completions',{method:'POST',headers:{cookie,origin,'content-type':'application/json'},body}));
 await firstStarted;const firstResponse=await first;assert.equal(firstResponse.status,200);
 const firstReading=track(firstResponse.text());const firstCancelled=assert.rejects(firstReading);
 const second=track(fetch(cloudBase+'/v1/zhipu-official/chat/completions',{method:'POST',headers:{authorization:'Bearer '+accountToken(secret,cloudAccount.id),'content-type':'application/json'},body}));
 await queueEntered;
 const overflow=await fetch(desktopBase+'/api/desktop-models/zhipu-official/chat/completions',{method:'POST',headers:{cookie,origin,'content-type':'application/json'},body});
 assert.equal(overflow.status,503);assert.equal(overflow.headers.get('retry-after'),'1');await overflow.text();assert.equal(calls,1);
 const logout=await fetch(desktopBase+'/logout',{method:'POST',redirect:'manual',headers:{cookie,origin}});assert.equal(logout.status,303);
 await firstCancelled;await secondStarted;const secondResponse=await second;assert.equal(secondResponse.status,200);
 assert.equal(active,1);assert.equal(peak,1);assert.equal(calls,2);
 const secondReading=track(secondResponse.text());const secondCancelled=assert.rejects(secondReading);
 await store.setDisabled(cloudAccount.id,true);await secondCancelled;
 assert.equal(active,0);assert.equal(aborted,2);assert.equal(calls,2);
 const free=await pool.acquire(new AbortController().signal);free.release();
});

async function pooledCloudFixture(t,{forward,keys=['synthetic-old-key'],policy={concurrency:1,maxQueued:1,waitMs:30000}}={}){
 const id='0123456789abcdef',secret='synthetic-test-secret',accounts=new EventEmitter();accounts.get=()=>({id});
 const pending=[];let current={...settings,baseURL:'https://old-supplier.test/v1'},keyList=keys,attempts=0,entered;
 const acquired=new Promise(resolve=>{entered=resolve;});
 const pool=createModelKeyPool({keys:()=>keyList,...policy});
 const shared={...pool,acquire(signal){attempts++;entered();return pool.acquire(signal);}};
 const globalModels={credentialPool:route=>route==='zhipu-official'?keyList:undefined,
  resolve:(route,model)=>route==='zhipu-official'&&model===settings.model?current:undefined};
 const server=createModelRelay({accounts,secret,globalModels,forward,keyPool:shared});
 t.after(async()=>{pool.close();server.closeAllConnections();await Promise.allSettled(pending);await new Promise(resolve=>server.close(resolve));});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base='http://127.0.0.1:'+server.address().port;
 return {pool,server,acquired,revoke:()=>accounts.emit('change',id),attempts:()=>attempts,setCurrent:value=>{current=value;},setKeys:value=>{keyList=value;},
  post:body=>{const response=fetch(base+'/v1/zhipu-official/chat/completions',{method:'POST',headers:{authorization:'Bearer '+accountToken(secret,id),'content-type':'application/json'},body:JSON.stringify({model:settings.model,messages:[],...body})});pending.push(response);return response;}};
}

test('queued cloud calls re-resolve the current endpoint, key and output and reasoning settings without a second dispatch',async t=>{
 const calls=[],fixture=await pooledCloudFixture(t,{forward:async({config,body,res})=>{calls.push({config,body});res.end('done');}});
 const blocker=await fixture.pool.acquire(new AbortController().signal);
 const pending=fixture.post({max_tokens:40000});await fixture.acquired;assert.equal(calls.length,0);
 fixture.setKeys(['synthetic-new-key']);fixture.setCurrent({...settings,apiKey:'synthetic-new-key',baseURL:'https://new-supplier.test/v1',maxTokens:1234,defaultReasoningEffort:'high'});
 blocker.release();const response=await pending;assert.equal(response.status,200);assert.equal(await response.text(),'done');
 assert.equal(calls.length,1);assert.equal(calls[0].config.baseURL,'https://new-supplier.test/v1');assert.equal(calls[0].config.apiKey,'synthetic-new-key');
 assert.equal(calls[0].body.max_tokens,1234);assert.equal(calls[0].body.reasoning_effort,'wire-high');
});

test('withdrawn queued cloud models never reach the supplier and release their reserved key',async t=>{
 let calls=0;const fixture=await pooledCloudFixture(t,{forward:async({res})=>{calls++;res.end('unexpected');}});
 const blocker=await fixture.pool.acquire(new AbortController().signal),pending=fixture.post({});await fixture.acquired;
 fixture.setCurrent(undefined);blocker.release();const response=await pending;
 assert.equal(response.status,503);await response.text();assert.equal(calls,0);
 const next=await fixture.pool.acquire(new AbortController().signal);next.release();
});

test('cloud payload errors never reserve a slot and forwarding failure releases it without automatic retry',async t=>{
 let calls=0;const fixture=await pooledCloudFixture(t,{forward:async()=>{calls++;throw Error('synthetic provider failure');}});
 const blocker=await fixture.pool.acquire(new AbortController().signal);
 for(const body of [{max_tokens:'32768'},{max_completion_tokens:0},{max_tokens:1.5},{reasoning_effort:'unsupported'}]){
  const response=await fixture.post(body);assert.equal(response.status,400);await response.text();
 }
 assert.equal(fixture.attempts(),0);assert.equal(calls,0);blocker.release();
 const response=await fixture.post({});assert.equal(response.status,502);await response.text();assert.equal(calls,1);
 const next=await fixture.pool.acquire(new AbortController().signal);next.release();
});

test('cloud account revocation removes a waiting request before dispatch and does not consume its next slot',async t=>{
 let calls=0;const fixture=await pooledCloudFixture(t,{forward:async({res})=>{calls++;res.end('done');}});
 const blocker=await fixture.pool.acquire(new AbortController().signal),pending=fixture.post({});await fixture.acquired;
 fixture.revoke();const revoked=await pending;assert.equal(revoked.status,401);await revoked.text();assert.equal(calls,0);
 blocker.release();const resumed=await fixture.post({});assert.equal(resumed.status,200);await resumed.text();assert.equal(calls,1);
});

test('closing a cloud relay leaves its externally owned pool available to other request owners',async t=>{
 const fixture=await pooledCloudFixture(t,{forward:async({res})=>res.end('done')});
 await new Promise(resolve=>fixture.server.close(resolve));
 const lease=await fixture.pool.acquire(new AbortController().signal);lease.release();
});

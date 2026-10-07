import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import http from 'node:http';
import https from 'node:https';
import {Readable} from 'node:stream';
import {createModelRelay,accountToken,resolveModelReasoning,fetchPublicModelListing,publicLookup} from './model-relay.mjs';
import {createDesktopModels} from './desktop-models.mjs';

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

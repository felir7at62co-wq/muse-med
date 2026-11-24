import {test} from 'node:test';
import assert from 'node:assert/strict';
import {desktopModelCatalog} from './desktop-models.mjs';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {openStore} from './store.mjs';
import {createAccountServer} from './gateway.mjs';
import {openSessionStore} from './session-store.mjs';
import {openGlobalModels} from './global-models.mjs';
import {addJubianTestedModels,JUBIAN_TESTED_PROVIDER} from './jubian-tested-models.mjs';

test('Muse login exposes website models, streams through account auth and revokes on logout',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'muse-desktop-models-'));let server;
 try{
  const store=await openStore(join(dir,'accounts.json'));await store.create('editor','pw');
  let hold=false,started;const entered=new Promise(r=>{started=r;});
 const requests=[];const origin='https://muse.test';
  const globalModels={metadata:()=>({providers:{studio:{displayName:'工作室',models:[{id:'writer',name:'编剧',contextWindow:128000,maxTokens:8192,input:['text'],reasoningEfforts:false}]}}}),resolve:(route,id)=>route==='studio'&&id==='writer'?{model:id,apiKey:'server-only-key',baseURL:'https://provider.test/v1',maxTokens:8192,reasoningEfforts:false}:undefined};
  server=createAccountServer({store,runtime:{ensure:()=>{throw Error('No workspace backend needed');}},globalModels,modelCatalog:'all',publicOrigin:origin,modelForward:async({config,body,res,signal})=>{requests.push({config,body});if(hold){started();await new Promise((resolve,reject)=>{signal.addEventListener('abort',()=>reject(Error('revoked')),{once:true});});}res.setHeader('content-type','text/event-stream');res.end('data: [DONE]\n\n');}});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+server.address().port;
  const call=(path,options={})=>fetch(base+path,{redirect:'manual',...options});
  assert.equal((await call('/api/desktop-models/providers')).status,401);
  const login=await call('/login',{method:'POST',headers:{origin},body:'username=editor&password=pw'});
  const cookie=login.headers.get('set-cookie').split(';')[0];const token=cookie.slice(cookie.indexOf('=')+1);
  const metadata=await (await call('/api/desktop-models/providers',{headers:{cookie}})).json();
  assert.equal(metadata.providers[0].id,'studio');assert.equal(metadata.providers[0].models[0].id,'writer');
  assert.ok(!JSON.stringify(metadata).includes('server-only-key'));
  const headers={authorization:'Bearer '+token,origin,'content-type':'application/json'};
  const body=JSON.stringify({model:'writer',messages:[],stream:true,max_tokens:99999});
  const response=await call('/api/desktop-models/studio/chat/completions',{method:'POST',headers,body});
  assert.equal(response.status,200);assert.match(await response.text(),/DONE/);
  assert.equal(requests[0].config.apiKey,'server-only-key');assert.equal(requests[0].body.max_tokens,8192);
  assert.equal((await call('/api/desktop-models/other/chat/completions',{method:'POST',headers,body})).status,400);
  assert.equal((await call('/api/desktop-models/studio/chat/completions',{method:'POST',headers:{...headers,origin:'https://evil.test'},body})).status,403);
  hold=true;const pending=call('/api/desktop-models/studio/chat/completions',{method:'POST',headers,body});await entered;
  await call('/logout',{method:'POST',headers:{cookie,origin}});
  assert.equal((await call('/api/desktop-models/studio/chat/completions',{method:'POST',headers,body})).status,401);
  assert.equal((await pending).status,401);
  assert.equal(requests.length,2);
 }finally{if(server){server.closeAllConnections();await new Promise(r=>server.close(r));}await rm(dir,{recursive:true,force:true});}
});

test('Desktop login survives gateway restart while expiry and account revocation stay durable',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'muse-session-restart-'));
 const accountsFile=join(dir,'accounts.json'),sessionsFile=join(dir,'sessions.json'),origin='https://muse.test';let clock=100000,active;
 t.after(async()=>{if(active?.server.listening){active.server.closeAllConnections();await new Promise(resolve=>active.server.close(resolve));}await rm(dir,{recursive:true,force:true});});
 const setup=await openStore(accountsFile),account=await setup.create('editor','pw');
 const start=async()=>{
  const store=await openStore(accountsFile),sessionStore=await openSessionStore(sessionsFile,{now:()=>clock});
  const server=createAccountServer({store,sessionStore,sessionTtlMs:1000,now:()=>clock,publicOrigin:origin});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base='http://127.0.0.1:'+server.address().port;
  return {store,sessionStore,server,call:(path,options={})=>fetch(base+path,{redirect:'manual',...options})};
 };
 const stop=async()=>{active.server.closeAllConnections();await new Promise(resolve=>active.server.close(resolve));};
 const login=async password=>{const response=await active.call('/login',{method:'POST',headers:{origin},body:new URLSearchParams({username:'editor',password})});assert.equal(response.status,303);return response.headers.get('set-cookie').split(';')[0];};
 active=await start();const first=await login('pw'),token=first.slice(first.indexOf('=')+1);await stop();
 active=await start();assert.equal((await active.call('/api/desktop-models/providers',{headers:{cookie:first}})).status,200);assert.equal((await active.call('/api/desktop-models/providers',{headers:{authorization:'Bearer '+token}})).status,200);
 assert.equal((await active.call('/logout',{method:'POST',headers:{cookie:first,origin}})).status,303);await stop();
 active=await start();assert.equal((await active.call('/api/desktop-models/providers',{headers:{authorization:'Bearer '+token}})).status,401);
 const changed=await login('pw');assert.equal((await active.call('/account/password',{method:'POST',headers:{cookie:changed,origin},body:new URLSearchParams({originalPassword:'pw',password:'new-pw'})})).status,303);await stop();
 active=await start();assert.equal((await active.call('/api/desktop-models/providers',{headers:{cookie:changed}})).status,401);
 const disabled=await login('new-pw');await active.store.setDisabled(account.id,true);await active.sessionStore.flush();await stop();
 active=await start();assert.equal((await active.call('/api/desktop-models/providers',{headers:{cookie:disabled}})).status,401);await active.store.setDisabled(account.id,false);await active.sessionStore.flush();
 const expiring=await login('new-pw');clock+=1000;await stop();active=await start();assert.equal((await active.call('/api/desktop-models/providers',{headers:{cookie:expiring}})).status,401);await stop();
});

test('native DeepSeek metadata exposes capacity and reasoning without private configuration',()=>{
 const result=desktopModelCatalog({metadata:()=>({deepseek:{baseURL:'https://private.test',apiKeyEnv:'SECRET',defaultContextWindow:128000,maxTokens:8192,thinking:'enabled',models:[{id:'deepseek-test'}]}})});
 assert.deepEqual(result.providers[0].models[0],{id:'deepseek-test',name:'deepseek-test',contextWindow:128000,maxTokens:8192,input:['text'],reasoningEfforts:{off:null,low:'low',high:'high',max:'max'}});
 assert.ok(!JSON.stringify(result).includes('SECRET'));
});

test('supplier credentials never leave the gateway, even for clients that ask for direct access',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'muse-no-direct-access-'));let server;
 t.after(async()=>{if(server){server.closeAllConnections();await new Promise(r=>server.close(r));}await rm(dir,{recursive:true,force:true});});
 const store=await openStore(join(dir,'accounts.json'));await store.create('editor','pw');
 const key='gateway-only-test-key',baseURL='https://provider.test/v1';
 const globalModels={metadata:()=>({providers:{studio:{models:[{id:'writer',contextWindow:128000,maxTokens:8192,reasoningEfforts:false}]},
  'zhipu-official':{models:[{id:'glm',contextWindow:128000,maxTokens:8192,reasoningEfforts:false}]}}}),
  resolve:(route,id)=>({model:id,apiKey:key,baseURL,maxTokens:8192,reasoningEfforts:false}),credentialPool:()=>[key]};
 const origin='https://muse.test';
 server=createAccountServer({store,globalModels,publicOrigin:origin});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+server.address().port;
 const call=(path,options={})=>fetch(base+path,{redirect:'manual',...options});
 const login=await call('/login',{method:'POST',headers:{origin},body:'username=editor&password=pw'});
 const cookie=login.headers.get('set-cookie').split(';')[0];
 const headers={cookie,origin,'x-muse-model-access':'direct-v1','x-muse-provider-routing':'mixed-v1','x-muse-zhipu-direct':'leased-v1'};
 const catalog=await call('/api/desktop-models/providers',{headers});
 const text=await catalog.text();
 assert.equal(catalog.status,200);assert.ok(!text.includes(key));assert.ok(!text.includes(baseURL));
 assert.equal(JSON.parse(text).transport,undefined);
 assert.ok(JSON.parse(text).providers.every(provider=>provider.transport===undefined&&provider.access===undefined));
 for(const [path,method] of [['/api/desktop-models/access','GET'],['/api/desktop-models/zhipu-official/leases','POST'],
  ['/api/desktop-models/zhipu-official/leases/c0b928a2-9bea-416b-80f0-cbd051fba1c9','GET']]){
  const response=await call(path,{method,headers:{...headers,'content-type':'application/json'},...method==='POST'?{body:JSON.stringify({model:'glm'})}:{}});
  assert.equal(response.status,404,path);assert.ok(!(await response.text()).includes(key),path);
 }
});

test('desktop usage self-reports are no longer accepted',async t=>{
 const fixture=await capacityFixture(t);
 const cookie=await fixture.login('editor-one');
 const response=await fixture.call('/api/muse.account/usage',{method:'POST',headers:{cookie,origin:'https://muse.test','content-type':'application/json'},
  body:JSON.stringify({id:'c0b928a2-9bea-416b-80f0-cbd051fba1c9',provider:'studio',model:'writer',status:200,inputTokens:1,outputTokens:1,totalTokens:2,cachedInputTokens:0,reasoningTokens:0})});
 assert.notEqual(response.status,204);assert.ok(response.status>=400,String(response.status));
});

async function capacityFixture(t,options={}){
 const dir=await mkdtemp(join(tmpdir(),'muse-desktop-capacity-'));let server;
 t.after(async()=>{if(server){server.closeAllConnections();await new Promise(r=>server.close(r));}await rm(dir,{recursive:true,force:true});});
 const store=await openStore(join(dir,'accounts.json'));await store.create('editor-one','pw');await store.create('editor-two','pw');
 const origin='https://muse.test';
 const globalModels={metadata:()=>({providers:{studio:{models:[{id:'writer',contextWindow:128000,maxTokens:8192,reasoningEfforts:false}]}}}),
  resolve:(route,id)=>route==='studio'&&id==='writer'?{model:id,apiKey:'test-only-key',maxTokens:8192,reasoningEfforts:false}:undefined};
 server=createAccountServer({store,runtime:{},globalModels,publicOrigin:origin,...options});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+server.address().port;
 const call=(path,options={})=>fetch(base+path,{redirect:'manual',...options});
 const login=async username=>{const response=await call('/login',{method:'POST',headers:{origin},body:new URLSearchParams({username,password:'pw'})});assert.equal(response.status,303);return response.headers.get('set-cookie').split(';')[0];};
 const generate=(cookie,options={})=>call('/api/desktop-models/studio/chat/completions',{method:'POST',headers:{cookie,origin,'content-type':'application/json'},body:JSON.stringify({model:'writer',messages:[],stream:true}),...options});
 return {call,login,generate};
}

test('verified Jubian catalog exposes only admitted models and forwards their exact model to the bound supplier',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'muse-jubian-catalog-'));
 t.after(()=>rm(dir,{recursive:true,force:true}));
 const secret='pilot-test-key';
 const source={version:2,revision:0,metadataRevision:0,credentials:{TEST:secret},providers:{
  original:{api:'openai-completions',baseURL:'https://gw.jubianai.net/v1',apiKeyEnv:'TEST',models:[]},
 }};
 const path=join(dir,'models.native');
 await writeFile(path,JSON.stringify(addJubianTestedModels(source,{credentialRef:'TEST'})),{mode:0o600});
 const globalModels=await openGlobalModels(path);
 const requested=[];
 const fixture=await capacityFixture(t,{globalModels,modelCatalog:'all',modelForward:async({config,body,res})=>{
  requested.push(body.model);
  assert.equal(config.apiKey,secret);
  assert.equal(config.baseURL,'https://gw.jubianai.net/v1');
  assert.equal(body.max_tokens,32000);
  res.end('data: [DONE]\n\n');
 }});
 const cookie=await fixture.login('editor-one');
 const catalog=await (await fixture.call('/api/desktop-models/providers',{headers:{cookie}})).text();
 assert.doesNotMatch(catalog,/pilot-test-key|gw\.jubianai/);
 const pilot=JSON.parse(catalog).providers.find(provider=>provider.id===JUBIAN_TESTED_PROVIDER);
 const ids=['claude-haiku-5-5','claude-sonnet-5-5','claude-opus-5-5','claude-fable-5-2'];
 assert.deepEqual(pilot.models.map(model=>model.id),ids);
 for(const model of pilot.models)assert.deepEqual(model.input,['text']);
 const call=(model,extra={})=>fixture.call(`/api/desktop-models/${JUBIAN_TESTED_PROVIDER}/chat/completions`,{
  method:'POST',headers:{cookie,origin:'https://muse.test','content-type':'application/json'},
  body:JSON.stringify({model,messages:[],stream:true,max_tokens:99999,...extra}),
 });
 for(const id of ids)assert.match(await (await call(id)).text(),/DONE/);
 for(const excluded of ['gpt-6.1-sol','gemini-3.1-pro-preview'])assert.equal((await call(excluded)).status,400);
 assert.equal((await call(ids[0],{reasoning_effort:'high'})).status,400);
 assert.deepEqual(requested,ids);
});

test('Desktop model requests exceed the old account and shared caps without local 429 responses',{timeout:30000},async t=>{
 let release,entered;const held=new Promise(r=>{release=r;}),allStarted=new Promise(r=>{entered=r;});let calls=0;
 t.after(()=>release());
 const fixture=await capacityFixture(t,{modelForward:async({res})=>{if(++calls===40)entered();await held;res.end('done');}});
 const one=await fixture.login('editor-one'),two=await fixture.login('editor-two');
 const pending=Array.from({length:40},(_,index)=>fixture.generate(index%2?one:two));
 try{await allStarted;assert.equal(calls,40);assert.equal((await fixture.call('/api/desktop-models/providers',{headers:{cookie:one}})).status,200);}
 finally{release();}
 const responses=await Promise.all(pending);assert.ok(responses.every(response=>response.status===200));
 await Promise.all(responses.map(response=>response.text()));
 const later=await Promise.all(Array.from({length:121},()=>fixture.generate(one)));
 assert.ok(later.every(response=>response.status===200));await Promise.all(later.map(response=>response.text()));
});

test('client cancellation releases the global slot after the active forwarding call exits',async t=>{
 let exited;const finished=new Promise(r=>{exited=r;});let calls=0;
 const fixture=await capacityFixture(t,{modelForward:async({res,signal})=>{
  if(++calls===1){res.writeHead(200,{'content-type':'text/event-stream'});res.write('data: started\n\n');await new Promise(r=>signal.addEventListener('abort',r,{once:true}));exited();return;}res.end('done');
 }});
 const one=await fixture.login('editor-one'),two=await fixture.login('editor-two');const controller=new AbortController();
 const first=await fixture.generate(one,{signal:controller.signal});const reading=first.text();controller.abort();await assert.rejects(reading);await finished;
 assert.equal((await fixture.generate(two)).status,200);assert.equal(calls,2);
});

test('malformed input and upstream failures release capacity before later submissions',async t=>{
 let calls=0;
 const fixture=await capacityFixture(t,{modelForward:async({res})=>{if(++calls===1)throw Error('test upstream failure');res.end('done');}});
 const one=await fixture.login('editor-one'),two=await fixture.login('editor-two');
 assert.equal((await fixture.generate(one,{body:'{'})).status,400);
 assert.equal((await fixture.generate(one)).status,502);
 assert.equal((await fixture.generate(two)).status,200);assert.equal(calls,2);
});

for(const [name,value] of [['MUSE_DESKTOP_MODEL_TRANSPORT','direct'],['MUSE_ZHIPU_DIRECT_TOKEN_MS','60000'],['MUSE_USAGE_RATE_PER_MINUTE','600']]){
 test(`removed direct access setting ${name} stops startup before listening`,async()=>{
  await assert.rejects(promisify(execFile)(process.execPath,[fileURLToPath(new URL('./gateway.mjs',import.meta.url))],{
   env:{[name]:value},timeout:20000,
  }),error=>{assert.match(error.stderr,new RegExp(name));assert.match(error.stderr,/direct/i);assert.doesNotMatch(error.stdout,/listening/);return true;});
 });
}

test('the public catalog lists only the selected company models unless every provider is explicitly published',async()=>{
 const model=id=>({id,contextWindow:128000,maxTokens:8192,input:['text'],reasoningEfforts:false});
 const providers={'deepseek-official':{models:[model('deepseek-v4.1-flash-261017')]},'volcengine-ark':{models:[model('glm-5.3-flash-260828'),model('ark-other')]},
  yunying:{models:[model('gpt-6.1-sol'),model('gemini-3.1-pro'),model('gpt-6-sol')]},'alibaba-bailian':{models:[model('deepseek-v4.1-flash-1017'),model('qwen-other')]},
  jubian:{models:[model('claude-sonnet-5-5')]},'jubian-gpt':{models:[model('gpt-6.1-sol')]},studio:{models:[model('writer')]}};
 const globalModels={metadata:()=>({providers})};
 const listed=catalog=>catalog.providers.map(provider=>[provider.id,provider.models.map(item=>item.id)]);
 const selected=[['deepseek-official',['deepseek-v4.1-flash-261017']],['volcengine-ark',['glm-5.3-flash-260828']],['yunying',['gpt-6.1-sol','gemini-3.1-pro']],
  ['alibaba-bailian',['deepseek-v4.1-flash-1017']],['jubian',['claude-sonnet-5-5']]];
 assert.deepEqual(listed(desktopModelCatalog(globalModels)),selected);
 assert.deepEqual(listed(desktopModelCatalog(globalModels,undefined,undefined,'selected')),selected);
 // Every configured provider except the internal GPT reroute target.
 assert.deepEqual(listed(desktopModelCatalog(globalModels,undefined,undefined,'all')),Object.entries(providers).filter(([id])=>id!=='jubian-gpt').map(([id,provider])=>[id,provider.models.map(item=>item.id)]));
 for(const value of ['','ALL','everything',null])assert.throws(()=>desktopModelCatalog(globalModels,undefined,undefined,value),/selected or all/);
 assert.throws(()=>createAccountServer({store:{},modelCatalog:'everything'}),/selected or all/);
 for(const value of ['','everything'])await assert.rejects(promisify(execFile)(process.execPath,[fileURLToPath(new URL('./gateway.mjs',import.meta.url))],{
  env:{MUSE_PUBLIC_MODEL_CATALOG:value},timeout:20000,
 }),error=>{assert.match(error.stderr,/MUSE_PUBLIC_MODEL_CATALOG must be selected or all/);assert.doesNotMatch(error.stdout,/listening/);return true;});
});

test('removed Desktop capacity configuration fails with an operator migration instruction',async()=>{
 await assert.rejects(promisify(execFile)(process.execPath,[fileURLToPath(new URL('./gateway.mjs',import.meta.url))],{
  env:{MUSE_DESKTOP_MODEL_MAX_TOTAL:'0'},timeout:20000,
 }),error=>{assert.match(error.stderr,/MUSE_DESKTOP_MODEL_MAX_TOTAL.*remove/);assert.doesNotMatch(error.stdout,/listening/);return true;});
});


test('two supplier credentials hold twenty whole streams each and reuse a released slot without replay',{timeout:30000},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'muse-stream-pool-')),origin='https://muse.test';let server;
 const gates=[],pending=[],seen=[];let hold=true;
 try{
  const store=await openStore(join(dir,'accounts.json'));await store.create('editor','pw');
  const keys=['pool-account-one','pool-account-two'];
  const globalModels={credentialPool:route=>route==='zhipu-official'?keys:undefined,
   resolve:(route,id)=>route==='zhipu-official'&&id==='writer'?{model:id,apiKey:keys[0],maxTokens:8192,reasoningEfforts:false}:undefined};
  server=createAccountServer({store,globalModels,publicOrigin:origin,
   modelKeyPoolPolicy:{concurrency:20,maxQueued:0,waitMs:1000},
   modelForward:async({config,res})=>{
    seen.push(config.apiKey);res.writeHead(200,{'content-type':'text/event-stream'});res.write('data: started\n\n');
    if(hold)await new Promise(resolve=>gates.push(resolve));res.end('data: [DONE]\n\n');
   }});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base='http://127.0.0.1:'+server.address().port;
  const login=await fetch(base+'/login',{method:'POST',redirect:'manual',headers:{origin},body:'username=editor&password=pw'});
  const cookie=login.headers.get('set-cookie').split(';')[0];
  const generate=(limits={})=>fetch(base+'/api/desktop-models/zhipu-official/chat/completions',{method:'POST',headers:{cookie,origin,'content-type':'application/json'},body:JSON.stringify({model:'writer',messages:[],stream:true,...limits})});
  pending.push(...Array.from({length:40},generate));const streams=await Promise.all(pending);
  assert.ok(streams.every(response=>response.status===200));assert.equal(gates.length,40);
  assert.deepEqual(keys.map(key=>seen.filter(value=>value===key).length),[20,20]);
  const blocked=await generate();assert.equal(blocked.status,503);assert.equal(blocked.headers.get('retry-after'),'1');await blocked.text();
  for(const field of ['max_tokens','max_completion_tokens']){
   const invalid=await generate({[field]:-1});assert.equal(invalid.status,400);assert.match(await invalid.text(),/输出上限无效/);
  }
  assert.equal(seen.length,40);
  hold=false;const completed=streams[0].text();gates[0]();await completed;
  const next=await generate();assert.equal(next.status,200);await next.text();assert.equal(seen.length,41);
  assert.equal(seen[40],seen[0]);
  gates.forEach(release=>release());await Promise.all(streams.slice(1).map(response=>response.text()));
 }finally{
  gates.forEach(release=>release());await Promise.allSettled(pending.map(async request=>(await request).text()));
  if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
  await rm(dir,{recursive:true,force:true});
 }
});

test('a queued request rechecks its absolute login expiry before supplier dispatch',{timeout:30000},async t=>{
 const dir=await mkdtemp(join(tmpdir(),'muse-queued-expiry-'));let server,releaseFirst;
 const requests=[];let clock=10000;
 t.after(async()=>{
  releaseFirst?.();server?.closeAllConnections();
  await Promise.allSettled(requests.map(async pending=>(await pending).text()));
  if(server)await new Promise(resolve=>server.close(resolve));
  await rm(dir,{recursive:true,force:true});
 });
 const store=await openStore(join(dir,'accounts.json'));await store.create('editor','pw');
 let started,queued;const entered=new Promise(resolve=>{started=resolve;}),waiting=new Promise(resolve=>{queued=resolve;});
 const hold=new Promise(resolve=>{releaseFirst=resolve;}),dispatches=[];
 const globalModels={credentialPool:()=>['test-account-key'],resolve:()=>{
  if(dispatches.length===1)queued();
  return {model:'writer',apiKey:'test-account-key',maxTokens:8192,reasoningEfforts:false};
 }};
 const origin='https://muse.test';
 server=createAccountServer({store,globalModels,publicOrigin:origin,now:()=>clock,sessionTtlMs:1000,
  modelKeyPoolPolicy:{concurrency:1,maxQueued:5,waitMs:2000},modelForward:async({res})=>{
   dispatches.push(clock);if(dispatches.length===1){started();await hold;}res.end('done');
  }});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base='http://127.0.0.1:'+server.address().port;
 const login=await fetch(base+'/login',{method:'POST',redirect:'manual',headers:{origin},body:'username=editor&password=pw'});
 await login.text();const cookie=login.headers.get('set-cookie').split(';')[0];
 const generate=()=>fetch(base+'/api/desktop-models/zhipu-official/chat/completions',{method:'POST',headers:{cookie,origin,'content-type':'application/json'},body:JSON.stringify({model:'writer',messages:[],stream:true})});
 const first=generate();requests.push(first);await entered;
 const second=generate();requests.push(second);await waiting;
 clock=11001;releaseFirst();
 const completed=await first;assert.equal(completed.status,200);await completed.text();
 const expired=await second;assert.equal(expired.status,401);await expired.text();
 assert.deepEqual(dispatches,[10000]);
});

for(const change of ['endpoint-and-key','model-removed','key-removed'])test('queued supplier dispatch uses the current configuration: '+change,{timeout:30000},async t=>{
 const dir=await mkdtemp(join(tmpdir(),'muse-queued-configuration-'));let server,releaseFirst;
 const requests=[];
 t.after(async()=>{
  releaseFirst?.();server?.closeAllConnections();
  await Promise.allSettled(requests.map(async pending=>(await pending).text()));
  if(server)await new Promise(resolve=>server.close(resolve));
  await rm(dir,{recursive:true,force:true});
 });
 const file=join(dir,'models.json');
 await writeFile(file,JSON.stringify({version:2,revision:0,metadataRevision:0,
  credentials:{OLD:['old-account-key'],NEW:['new-account-key']},providers:{'zhipu-official':{
   api:'openai-completions',baseURL:'https://old-provider.test/v1',apiKeyEnv:'OLD',models:[{id:'writer',maxTokens:8192}],
  }}}));
 const original=await openGlobalModels(file),store=await openStore(join(dir,'accounts.json'));await store.create('editor','pw');
 let started,queued;const entered=new Promise(resolve=>{started=resolve;}),waiting=new Promise(resolve=>{queued=resolve;});
 const hold=new Promise(resolve=>{releaseFirst=resolve;}),dispatches=[];
 const globalModels={...original,resolve:(route,id)=>{
  if(dispatches.length===1)queued();return original.resolve(route,id);
 }};
 const origin='https://muse.test';
 server=createAccountServer({store,globalModels,publicOrigin:origin,modelKeyPoolPolicy:{concurrency:1,maxQueued:5,waitMs:2000},
  modelForward:async({config,body,res})=>{
   dispatches.push({baseURL:config.baseURL,key:config.apiKey,maxTokens:body.max_tokens});
   if(dispatches.length===1){started();await hold;}res.end('done');
  }});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base='http://127.0.0.1:'+server.address().port;
 const login=await fetch(base+'/login',{method:'POST',redirect:'manual',headers:{origin},body:'username=editor&password=pw'});
 await login.text();const cookie=login.headers.get('set-cookie').split(';')[0];
 const generate=()=>fetch(base+'/api/desktop-models/zhipu-official/chat/completions',{method:'POST',headers:{cookie,origin,'content-type':'application/json'},body:JSON.stringify({model:'writer',messages:[],stream:true,max_tokens:999})});
 const first=generate();requests.push(first);await entered;
 const second=generate();requests.push(second);await waiting;
 if(change==='endpoint-and-key')await original.mutate({ns:'llm-pi-ai',expectedRevision:0,ops:[
  {op:'set',path:['providers','zhipu-official','baseURL'],value:'https://new-provider.test/v1'},
  {op:'set',path:['providers','zhipu-official','apiKeyEnv'],value:'NEW'},
  {op:'set',path:['providers','zhipu-official','models'],value:[{id:'writer',maxTokens:32}]},
 ]});
 else if(change==='model-removed')await original.mutate({ns:'llm-pi-ai',expectedRevision:0,
  ops:[{op:'set',path:['providers','zhipu-official','models'],value:[]}]});
 else await original.unsetCredential('OLD');
 releaseFirst();
 const completed=await first;assert.equal(completed.status,200);await completed.text();
 const refreshed=await second;assert.equal(refreshed.status,change==='endpoint-and-key'?200:503);await refreshed.text();
 assert.deepEqual(dispatches,[{baseURL:'https://old-provider.test/v1',key:'old-account-key',maxTokens:999},
  ...change==='endpoint-and-key'?[{baseURL:'https://new-provider.test/v1',key:'new-account-key',maxTokens:32}]:[]]);
});

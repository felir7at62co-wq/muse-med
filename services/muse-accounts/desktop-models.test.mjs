import {test} from 'node:test';
import assert from 'node:assert/strict';
import {desktopModelCatalog,createDesktopModels} from './desktop-models.mjs';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {openStore} from './store.mjs';
import {createAccountServer} from './gateway.mjs';

test('Muse login exposes website models, streams through account auth and revokes on logout',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'muse-desktop-models-'));let server;
 try{
  const store=await openStore(join(dir,'accounts.json'));await store.create('editor','pw');
  let hold=false,started;const entered=new Promise(r=>{started=r;});
 const requests=[];const origin='https://muse.test';
  const globalModels={metadata:()=>({providers:{studio:{displayName:'工作室',models:[{id:'writer',name:'编剧',contextWindow:128000,maxTokens:8192,input:['text'],reasoningEfforts:false}]}}}),resolve:(route,id)=>route==='studio'&&id==='writer'?{model:id,apiKey:'server-only-key',baseURL:'https://provider.test/v1',maxTokens:8192,reasoningEfforts:false}:undefined};
  server=createAccountServer({store,runtime:{ensure:()=>{throw Error('No workspace backend needed');}},globalModels,publicOrigin:origin,modelForward:async({config,body,res,signal})=>{requests.push({config,body});if(hold){started();await new Promise((resolve,reject)=>{signal.addEventListener('abort',()=>reject(Error('revoked')),{once:true});});}res.setHeader('content-type','text/event-stream');res.end('data: [DONE]\n\n');}});
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

test('native DeepSeek metadata exposes capacity and reasoning without private configuration',()=>{
 const result=desktopModelCatalog({metadata:()=>({deepseek:{baseURL:'https://private.test',apiKeyEnv:'SECRET',defaultContextWindow:128000,maxTokens:8192,thinking:'enabled',models:[{id:'deepseek-test'}]}})});
 assert.deepEqual(result.providers[0].models[0],{id:'deepseek-test',name:'deepseek-test',contextWindow:128000,maxTokens:8192,input:['text'],reasoningEfforts:{off:null,low:'low',high:'high',max:'max'}});
 assert.ok(!JSON.stringify(result).includes('SECRET'));
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

test('removed Desktop capacity configuration fails with an operator migration instruction',async()=>{
 await assert.rejects(promisify(execFile)(process.execPath,[fileURLToPath(new URL('./gateway.mjs',import.meta.url))],{
  env:{MUSE_DESKTOP_MODEL_MAX_TOTAL:'0'},timeout:20000,
 }),error=>{assert.match(error.stderr,/MUSE_DESKTOP_MODEL_MAX_TOTAL.*remove/);assert.doesNotMatch(error.stdout,/listening/);return true;});
});

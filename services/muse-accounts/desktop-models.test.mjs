import {test} from 'node:test';
import assert from 'node:assert/strict';
import {desktopModelCatalog} from './desktop-models.mjs';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
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

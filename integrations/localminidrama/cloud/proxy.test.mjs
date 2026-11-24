/** Streaming proxy ownership, cancellation and header isolation without a supplier. */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {studioRoute} from './proxy.mjs';

const origin='https://muse.fixture.test',accountId='a'.repeat(16);
const listen=server=>new Promise(resolve=>server.listen(0,'127.0.0.1',()=>resolve(new URL('http://127.0.0.1:'+server.address().port))));
const close=async server=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));};
const deferred=()=>{let resolve;return {promise:new Promise(value=>{resolve=value;}),resolve:value=>resolve(value)};};
async function fixture(t,handler,{configured=true}={}){
 let releases=0,acquires=0,authorized=true;const received=[],controllers=[];let released=deferred();
 const upstream=createServer((req,res)=>{received.push({url:req.url,headers:req.headers});handler(req,res);}),target=await listen(upstream);
 const runtime={limits:{maxRequestBytes:1024,requestTimeoutMs:10000},async acquire(id){assert.equal(id,accountId);acquires++;return {target,token:'private-worker-fixture-token',release(){releases++;released.resolve();}};}};
 const server=createServer(async(req,res)=>{const controller=new AbortController();controllers.push(controller);if(!await studioRoute(req,res,{runtime:configured?runtime:undefined,session:{id:accountId,token:'private-login-token'},isAuthorized:()=>authorized,publicOrigin:origin,signal:controller.signal})){res.writeHead(404);res.end();}}),base=await listen(server);
 t.after(async()=>{await close(server);await close(upstream);});
 return {received,controllers,call:(path,options={})=>fetch(new URL(path,base),{redirect:'manual',...options}),releases:()=>releases,acquires:()=>acquires,done:()=>released.promise,reset(){released=deferred();},revoke(){authorized=false;controllers.forEach(controller=>controller.abort());}};
}

test('only production paths and public request headers reach a selected worker',async t=>{
 const f=await fixture(t,(req,res)=>{res.writeHead(302,{'set-cookie':'must-not-escape=1','x-muse-studio-worker':'must-not-escape','x-powered-by':'Express','location':'/api/v1/dramas','content-type':'text/plain'});res.end('fixture');});
 const response=await f.call('/studio/api/v1/dramas?keyword=ok',{headers:{cookie:'private-login-token',authorization:'Bearer private-provider-token','x-account-id':'b'.repeat(16),'x-muse-studio-worker':'forged','x-original-url':'/api/v1/agent/chat','x-muse-operation-id':'fixture-operation-id',forwarded:'host=other',range:'bytes=0-1'}});assert.equal(response.status,302);assert.equal(await response.text(),'fixture');await f.done();
 assert.equal(f.received[0].url,'/api/v1/dramas?keyword=ok');assert.equal(f.received[0].headers['x-muse-studio-worker'],'private-worker-fixture-token');assert.equal(f.received[0].headers.range,'bytes=0-1');assert.equal(f.received[0].headers['x-muse-operation-id'],'fixture-operation-id');
 for(const header of ['cookie','authorization','x-account-id','x-original-url','forwarded'])assert.equal(f.received[0].headers[header],undefined);
 for(const header of ['set-cookie','x-muse-studio-worker','x-powered-by'])assert.equal(response.headers.get(header),null);assert.equal(response.headers.get('location'),'/studio/api/v1/dramas');assert.equal(f.releases(),1);
 assert.equal((await f.call('/studio/api/v1/agent/history')).status,404);assert.equal(f.acquires(),1);
});

test('client cancellation closes both owned upstream streams before releasing its lease',async t=>{
 const closed=deferred(),f=await fixture(t,(req,res)=>{res.once('close',()=>closed.resolve());res.writeHead(200,{'content-type':'text/event-stream'});res.write('data: first\n\n');});
 const controller=new AbortController(),response=await f.call('/studio/api/v1/dramas',{signal:controller.signal}),reader=response.body.getReader();assert.equal((await reader.read()).done,false);controller.abort();
 await assert.rejects(reader.read());await f.done();await closed.promise;assert.equal(f.releases(),1);
});

test('account revocation interrupts a held response before any private bytes are forwarded',async t=>{
 const entered=deferred(),finish=deferred(),f=await fixture(t,async(req,res)=>{entered.resolve();await finish.promise;if(!res.destroyed)res.end('must not reach revoked account');});
 const pending=f.call('/studio/api/v1/dramas');await entered.promise;f.revoke();const response=await pending;assert.equal(response.status,401);assert.equal((await response.json()).error.code,'account_session_expired');await f.done();finish.resolve();assert.equal(f.releases(),1);
});

test('missing configuration, unsafe GET generation and body limits fail before opening a worker',async t=>{
 const f=await fixture(t,(req,res)=>res.end('unused'));
 assert.equal((await f.call('/studio')).status,303);assert.equal((await f.call('/studio?view=projects')).headers.get('location'),'/studio/?view=projects');
 assert.equal((await f.call('/studio/api/v1/STORYBOARDS/episode/1/GENERATE',{headers:{'sec-fetch-site':'same-site'}})).status,403);
 assert.equal((await f.call('/studio/api/v1/dramas',{method:'POST',headers:{origin,'content-type':'application/json'},body:'x'.repeat(1025)})).status,413);assert.equal(f.acquires(),0);
 const disabled=await fixture(t,(req,res)=>res.end('unused'),{configured:false});assert.equal((await disabled.call('/studio/')).status,404);assert.equal(disabled.acquires(),0);
});

test('public callers can inspect LibTV sources but cannot reach internal result imports',async t=>{
 const f=await fixture(t,(_req,res)=>res.end('source inspection'));
 assert.equal((await f.call('/studio/api/v1/muse/libtv-postproduction/sources/1/inspect')).status,200);await f.done();
 for(const path of ['/studio/api/v1/muse/libtv-postproduction/internal/imports','/studio/API/v1/muse/libtv-postproduction/internal/imports','/studio/api/v1/muse/libtv-postproduction%2Finternal/imports']){
  const response=await f.call(path,{method:'POST',headers:{origin,'content-type':'application/json'},body:'{}'});
  assert.equal(response.status,403);assert.equal((await response.json()).error.code,'studio_internal_route_refused');
 }
 assert.equal(f.acquires(),1);assert.equal(f.received.length,1);
});

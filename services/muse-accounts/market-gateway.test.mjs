/** Actual HTTP account admission, proxy bounds and fixed-origin market transport. */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtemp,writeFile,rm,symlink} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createMarketProxy} from './market-proxy.mjs';
import {loadMarket} from './market.mjs';
import {createAccountServer,installGatewayShutdown} from './gateway.mjs';
import {openStore} from './store.mjs';

const listen=server=>new Promise(resolve=>server.listen(0,'127.0.0.1',()=>resolve('http://127.0.0.1:'+server.address().port)));
async function close(server){server.closeAllConnections();if(server.listening)await new Promise(resolve=>server.close(resolve));}
const request=(base,path,options={})=>fetch(base+path,{redirect:'manual',signal:AbortSignal.timeout(15000),...options});
function raw(base,path,{method='GET',headers={},chunks=[]}={}){
 return new Promise((resolve,reject)=>{
  const target=new URL(base),client=http.request({hostname:target.hostname,port:target.port,path,method,headers,agent:false},response=>{
   const parts=[];response.on('data',chunk=>parts.push(chunk));response.on('error',reject);
   response.on('end',()=>resolve({status:response.statusCode,headers:response.headers,body:Buffer.concat(parts)}));
  });
  client.on('error',reject);client.setTimeout(15000,()=>client.destroy(Error('raw test request timed out')));
  for(const chunk of chunks)client.write(chunk);client.end();
 });
}
async function fixture(t,{handler,policy:overrides={}}={}){
 const root=await mkdtemp(join(tmpdir(),'muse-market-gateway-')),servers=[],seen=[];let market;
 t.after(async()=>{await market?.close();for(const server of servers.reverse())await close(server);await rm(root,{recursive:true,force:true});});
 const secret='a'.repeat(48),secretFile=join(root,'secret');await writeFile(secretFile,secret,{mode:0o600});
 const upstream=http.createServer(handler??(async(req,res)=>{
  const chunks=[];try{for await(const chunk of req)chunks.push(chunk);}catch{return;}
  const actor=req.headers['x-muse-market-actor']?JSON.parse(Buffer.from(req.headers['x-muse-market-actor'],'base64url')):null;
  seen.push({url:req.url,method:req.method,headers:req.headers,body:Buffer.concat(chunks),actor});
  res.writeHead(200,{'content-type':'application/json','set-cookie':'market=private','x-content-sha256':'f'.repeat(64)});
  res.end(JSON.stringify({actor}));
 }));servers.push(upstream);const upstreamUrl=await listen(upstream);
 const policy={upstream:upstreamUrl,secretFile,archiveBytes:1024,jsonRequestBytes:4096,jsonResponseBytes:4096,
  requestTimeoutMs:5000,requestRatePerMinute:1000,...overrides};market=await createMarketProxy(policy);
 return {root,servers,seen,secret,secretFile,market,policy,upstreamUrl};
}

test('market policy is explicit, private and disabled without configuration',async t=>{
 const f=await fixture(t);assert.equal(await loadMarket({}),undefined);
 const file=join(f.root,'policy.json');await writeFile(file,JSON.stringify(f.policy),{mode:0o600});
 const loaded=await loadMarket({MUSE_MARKET_CONFIG:file});await loaded.close();
 for(const bad of [{...f.policy,upstream:'https://127.0.0.1/'},{...f.policy,upstream:'http://example.com/'},
  {...f.policy,jsonResponseBytes:0},{...f.policy,jsonRequestBytes:undefined},{...f.policy,other:true}]){
  await assert.rejects(createMarketProxy(bad),/Invalid market proxy policy/);
 }
 const link=join(f.root,'secret-link');await symlink(f.secretFile,link);
 await assert.rejects(createMarketProxy({...f.policy,secretFile:link}),/secret must be private/);
 await assert.rejects(loadMarket({MUSE_MARKET_CONFIG:'relative-policy.json'}),/absolute/);
});

test('proxy strips browser credentials and forwards only gateway-owned actor fields',async t=>{
 const f=await fixture(t),actor={id:'0123456789abcdef',username:'作者',admin:false,passwordHash:'must-not-leave'};
 const server=http.createServer((req,res)=>{void f.market.handle(req,res,actor);});f.servers.push(server);const base=await listen(server);
 const response=await request(base,'/api/market/v1/catalog?q=scene',{headers:{cookie:'private=browser',authorization:'Bearer browser',
  'x-muse-market-actor':'forged','x-account-id':'forged','x-forwarded-for':'forged'}});
 assert.equal(response.status,200);assert.deepEqual(await response.json(),{actor:{id:actor.id,username:actor.username,admin:false}});
 assert.equal(response.headers.get('set-cookie'),null);assert.equal(response.headers.get('x-content-sha256'),'f'.repeat(64));
 const forwarded=f.seen[0];assert.equal(forwarded.url,'/api/market/v1/catalog?q=scene');assert.equal(forwarded.headers.authorization,'Bearer '+f.secret);
 for(const key of ['cookie','x-account-id','x-forwarded-for'])assert.equal(forwarded.headers[key],undefined);
 assert.deepEqual(forwarded.actor,{id:actor.id,username:actor.username,admin:false});
 const upload=await request(base,'/api/market/v1/uploads',{method:'POST',headers:{'content-type':'application/zip',
  'x-market-publisher':'b'.repeat(32),'idempotency-key':'original-key'},body:Buffer.alloc(1024)});
 assert.equal(upload.status,200);await upload.arrayBuffer();assert.equal(f.seen.at(-1).body.byteLength,1024);
 assert.equal(f.seen.at(-1).headers['idempotency-key'],'original-key');
 assert.equal((await request(base,'/api/market/v1/uploads',{method:'POST',body:Buffer.alloc(1025)})).status,413);
});

test('raw ambiguous origin targets never reach either configured upstream or a second loopback trap',async t=>{
 const f=await fixture(t),trapped=[];
 const trap=http.createServer((req,res)=>{trapped.push({url:req.url,headers:req.headers});res.end('trap');});f.servers.push(trap);
 const trapUrl=await listen(trap),trapHost=new URL(trapUrl).host;
 const direct=http.createServer((req,res)=>{void f.market.handle(req,res,{id:'0123456789abcdef',username:'actor',admin:false});});f.servers.push(direct);const directUrl=await listen(direct);
 const store=await openStore(join(f.root,'accounts.json'));await store.create('author','pw');
 const origin='https://muse.test',gateway=createAccountServer({store,market:f.market,workspaceMode:'desktop',publicOrigin:origin,
  runtime:{ensure:async()=>{throw Error('Market must not start a tenant');}}});f.servers.push(gateway);const gatewayUrl=await listen(gateway);
 const login=await request(gatewayUrl,'/login',{method:'POST',headers:{origin},body:new URLSearchParams({username:'author',password:'pw'})});
 const cookie=login.headers.get('set-cookie').split(';')[0];await login.arrayBuffer();
 for(const [base,headers] of [[directUrl,{}],[gatewayUrl,{cookie}]]){
  const count=f.seen.length;
  for(const target of [`/\\${trapHost}/api/market/v1/catalog`,`//${trapHost}/api/market/v1/catalog`,`${trapUrl}/api/market/v1/catalog`,'/api/market/v1/catalog#fragment']){
   assert.equal((await raw(base,target,{headers})).status,400,target);
  }
  assert.equal(f.seen.length,count);assert.deepEqual(trapped,[]);
  assert.equal((await raw(base,'/api/market/v1/catalog?q=normal',{headers})).status,200);
  assert.equal(f.seen.at(-1).url,'/api/market/v1/catalog?q=normal');assert.deepEqual(trapped,[]);
 }
});

test('gateway uses current login, CSRF, administrator and enabled target-account authority',async t=>{
 const f=await fixture(t),store=await openStore(join(f.root,'accounts.json'));
 const admin=await store.create('admin','pw',{admin:true}),author=await store.create('author','pw');let tenantStarts=0;
 const origin='https://muse.test',gateway=createAccountServer({store,market:f.market,workspaceMode:'desktop',publicOrigin:origin,
  runtime:{ensure:async()=>{tenantStarts++;throw Error('No tenant needed');}}});f.servers.push(gateway);const base=await listen(gateway);
 const login=async username=>{const response=await request(base,'/login',{method:'POST',headers:{origin},body:new URLSearchParams({username,password:'pw'})});await response.arrayBuffer();return response.headers.get('set-cookie').split(';')[0];};
 const adminCookie=await login('admin'),authorCookie=await login('author');
 assert.equal((await request(base,'/market')).status,200);
 assert.deepEqual(await(await request(base,'/api/market/v1/catalog')).json(),{actor:null});
 assert.equal((await request(base,'/api/market/v1/me')).status,401);
 assert.equal((await request(base,'/api/market/v1/catalog?mine=true')).status,401);
 const me=await(await request(base,'/api/market/v1/me',{headers:{cookie:authorCookie,'x-muse-market-actor':'forged'}})).json();
 assert.deepEqual(me.actor,{id:author.id,username:'author',admin:false});
 const body=JSON.stringify({title:'Studio',accountId:author.id}),count=f.seen.length;
 const post=(cookie,requestOrigin=origin,payload=body)=>request(base,'/api/market/v1/publishers',{method:'POST',
  headers:{cookie,origin:requestOrigin,'content-type':'application/json'},body:payload});
 assert.equal((await post(adminCookie,'https://evil.test')).status,403);
 assert.equal((await post(authorCookie)).status,403);assert.equal(f.seen.length,count);
 assert.equal((await post(adminCookie,origin,JSON.stringify({title:'Studio',accountId:'f'.repeat(16)}))).status,400);
 assert.equal((await post(adminCookie)).status,200);
 assert.deepEqual(f.seen.at(-1).actor,{id:admin.id,username:'admin',admin:true});assert.equal(f.seen.at(-1).body.toString(),body);
 await store.setDisabled(author.id,true);
 assert.equal((await post(adminCookie)).status,400);
 assert.equal((await request(base,'/api/market/v1/me',{headers:{cookie:authorCookie}})).status,401);
 const valid=await login('admin');assert.equal((await request(base,'/logout',{method:'POST',headers:{origin,cookie:valid}})).status,303);
 assert.equal((await request(base,'/api/market/v1/me',{headers:{cookie:valid}})).status,401);
 assert.equal(tenantStarts,0);
});

test('configured market rate and shutdown admission apply before upstream work',async t=>{
 const f=await fixture(t,{policy:{requestRatePerMinute:2}}),store=await openStore(join(f.root,'accounts.json'));
 const gateway=createAccountServer({store,market:f.market,workspaceMode:'desktop',publicOrigin:'https://muse.test'});f.servers.push(gateway);const base=await listen(gateway);
 for(let index=0;index<2;index++)assert.equal((await request(base,'/api/market/v1/catalog')).status,200);
 assert.equal((await request(base,'/api/market/v1/catalog')).status,429);assert.equal(f.seen.length,2);
 gateway.stopAdmission();assert.equal((await request(base,'/api/market/v1/catalog')).status,503);assert.equal(f.seen.length,2);
});

test('publisher invitation buffering obeys the same request deadline and JSON byte budget',async t=>{
 const f=await fixture(t,{policy:{requestTimeoutMs:50,jsonRequestBytes:64}}),store=await openStore(join(f.root,'accounts.json'));
 await store.create('admin','pw',{admin:true});const origin='https://muse.test';
 const gateway=createAccountServer({store,market:f.market,workspaceMode:'desktop',publicOrigin:origin});f.servers.push(gateway);const base=await listen(gateway);
 const login=await request(base,'/login',{method:'POST',headers:{origin},body:new URLSearchParams({username:'admin',password:'pw'})});
 await login.arrayBuffer();const cookie=login.headers.get('set-cookie').split(';')[0];
 const headers={origin,cookie,'content-type':'application/json'};
 const tooLarge=await raw(base,'/api/market/v1/publishers',{method:'POST',headers,chunks:['x'.repeat(65)]});
 assert.equal(tooLarge.status,413);assert.deepEqual(JSON.parse(tooLarge.body),{error:'request-too-large'});
 const stalled=await new Promise((resolve,reject)=>{
  const endpoint=new URL(base),client=http.request({hostname:endpoint.hostname,port:endpoint.port,path:'/api/market/v1/publishers',method:'POST',headers,agent:false},response=>{
   const chunks=[];response.on('data',chunk=>chunks.push(chunk));response.on('error',reject);
   response.on('end',()=>resolve({status:response.statusCode,body:Buffer.concat(chunks)}));
  });
  t.after(()=>client.destroy());client.on('error',reject);client.setTimeout(15000,()=>client.destroy(Error('stalled request exceeded its test deadline')));
  client.write('{"title":');
 });
 assert.equal(stalled.status,504);assert.deepEqual(JSON.parse(stalled.body),{error:'market-timeout'});assert.deepEqual(f.seen,[]);
});

test('the account factory attaches to the same reserved HTTP carrier with its actual origin',async t=>{
 const f=await fixture(t),store=await openStore(join(f.root,'accounts.json'));await store.create('author','pw');
 const carrier=http.createServer();f.servers.push(carrier);const origin=await listen(carrier);
 const gateway=createAccountServer({store,market:f.market,workspaceMode:'desktop',publicOrigin:origin,httpServer:carrier});
 assert.equal(gateway,carrier);assert.equal(carrier.listenerCount('request'),1);assert.equal(carrier.listenerCount('upgrade'),1);
 const response=await request(origin,'/login',{method:'POST',headers:{origin},body:new URLSearchParams({username:'author',password:'pw'})});
 assert.equal(response.status,303);await response.arrayBuffer();const cookie=response.headers.get('set-cookie').split(';')[0];
 assert.equal((await request(origin,'/api/market/v1/me',{headers:{cookie,origin}})).status,200);
 assert.throws(()=>createAccountServer({store,httpServer:carrier}),/no request or upgrade handlers/);
 await close(carrier);assert.equal(store.listenerCount('change'),0);
});

test('unknown-length request and response streams enforce complete byte budgets',async t=>{
 const f=await fixture(t,{policy:{archiveBytes:4,jsonResponseBytes:4},handler:(req,res)=>{
  req.on('error',()=>{});if(req.url.includes('/download')){res.writeHead(200,{'content-length':'5'});res.end('12345');return;}
  req.resume();res.end('1234');
 }});
 const server=http.createServer((req,res)=>{void f.market.handle(req,res,null);});f.servers.push(server);const base=await listen(server);
 assert.equal((await raw(base,'/api/market/v1/uploads',{method:'POST',chunks:['12','345']})).status,413);
 const exact=await request(base,'/api/market/v1/catalog');assert.equal(exact.status,200);assert.equal(await exact.text(),'1234');
 const tooLarge=await request(base,'/api/market/v1/releases/'+'a'.repeat(32)+'/download');assert.equal(tooLarge.status,502);
 assert.deepEqual(await tooLarge.json(),{error:'response-too-large'});
});

test('a late oversized response fails its stream instead of completing a truncated success',async t=>{
 const release=Promise.withResolvers();t.after(()=>release.resolve());
 const f=await fixture(t,{policy:{jsonResponseBytes:4},handler:(req,res)=>{
  req.resume();res.writeHead(200);res.write('1234');void release.promise.then(()=>{if(!res.destroyed)res.end('5');});
 }});
 const server=http.createServer((req,res)=>{void f.market.handle(req,res,null);});f.servers.push(server);const base=await listen(server);
 const response=await request(base,'/api/market/v1/catalog'),reader=response.body.getReader();
 assert.equal(Buffer.from((await reader.read()).value).toString(),'1234');release.resolve();
 await assert.rejects(reader.read());
});

test('timeout and close release owned upstream connections and reject later work',async t=>{
 const f=await fixture(t,{policy:{requestTimeoutMs:50},handler:(req,res)=>{req.resume();}});
 const server=http.createServer((req,res)=>{void f.market.handle(req,res,null);});f.servers.push(server);const base=await listen(server);
 const response=await request(base,'/api/market/v1/catalog');assert.equal(response.status,504);assert.deepEqual(await response.json(),{error:'market-timeout'});
 const first=f.market.close(),second=f.market.close();assert.equal(first,second);await first;
 assert.equal((await request(base,'/api/market/v1/catalog')).status,503);
});

test('gateway shutdown awaits the optional market close operation',async()=>{
 const server=http.createServer((_req,res)=>res.end());server.stopAdmission=()=>{};await listen(server);
 const signals=new (await import('node:events')).EventEmitter(),release=Promise.withResolvers(),entered=Promise.withResolvers();let calls=0;
 const controller=installGatewayShutdown({accountServer:server,signals,market:{close:async()=>{calls++;entered.resolve();await release.promise;}}});
 const pending=controller.close();
 try{await entered.promise;assert.equal(calls,1);assert.equal(server.listening,true);}
 finally{release.resolve();await pending;}
 assert.equal(server.listening,false);assert.equal(signals.listenerCount('SIGTERM'),0);
});

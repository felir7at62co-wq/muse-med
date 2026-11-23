import assert from 'node:assert/strict';
import {once} from 'node:events';
import {mkdtemp,rm} from 'node:fs/promises';
import http from 'node:http';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {setTimeout as delay} from 'node:timers/promises';
import {WebSocket,WebSocketServer} from 'ws';
import {createCentralServer} from './central-web.mjs';
import {createAccountServer} from './gateway.mjs';
import {openStore} from './store.mjs';

const publicOrigin='https://muse.test';
const nativeCookie='dsh=native';
const secret='synthetic-password';

async function listen(t,server){
 const sockets=new Set();
 server.on('connection',socket=>{sockets.add(socket);socket.once('close',()=>sockets.delete(socket));});
 server.listen(0,'127.0.0.1');
 await once(server,'listening');
 t.after(async()=>{
  for(const socket of sockets)socket.destroy();
  if(server.listening)await new Promise(resolve=>server.close(resolve));
 });
 return `http://127.0.0.1:${server.address().port}`;
}

async function fixture(t,{allowEditor=false,backendResponseTimeoutMs,serveNative}={}){
 const dir=await mkdtemp(join(tmpdir(),'muse-central-web-'));
 t.after(()=>rm(dir,{recursive:true,force:true}));
 const store=await openStore(join(dir,'accounts.json'));
 const ownerAccount=await store.create('owner',secret,{admin:true});
 const editorAccount=await store.create('editor',secret);
 const otherAdminAccount=await store.create('different-admin',secret,{admin:true});
 await store.create('unlisted-admin',secret,{admin:true});
 const accounts=createAccountServer({store,publicOrigin,workspaceMode:'desktop',devOnlyAdmin:false,environment:'production',cookieName:'__Host-muse'});
 const accountsOrigin=await listen(t,accounts);
 const login=async(username)=>{
  const response=await fetch(accountsOrigin+'/login',{method:'POST',headers:{origin:publicOrigin},body:new URLSearchParams({username,password:secret}),redirect:'manual'});
  assert.equal(response.status,303);
  const cookie=response.headers.get('set-cookie')?.split(';')[0];
  assert.match(cookie??'',/^__Host-muse=/u);
  return cookie;
 };
 const [owner,editor,otherAdmin,unlistedAdmin]=await Promise.all(['owner','editor','different-admin','unlisted-admin'].map(login));
 const requests=[],upgrades=[];
 const record=req=>({url:req.url,cookie:req.headers.cookie,origin:req.headers.origin,host:req.headers.host,authorization:req.headers.authorization});
 const backend=http.createServer((req,res)=>{
  requests.push(record(req));
  if(req.headers.cookie!==nativeCookie){res.writeHead(401);res.end();return;}
  if(serveNative?.(req,res))return;
  if(req.url==='/'){
   res.writeHead(200,{'content-type':'text/html'});
   res.end('<html><head><base href="./"><script src="./bundle.js"></script></head><body>private central host</body></html>');
   return;
  }
  if(req.url==='/redirect'){res.writeHead(302,{location:'/home?q=a%2Fb#part'});res.end();return;}
  res.writeHead(200,{'content-type':'text/plain','set-cookie':'unforwarded=private; Path=/'});
  res.end(`central ${req.url}`);
 });
 const sockets=new WebSocketServer({noServer:true});
 backend.on('upgrade',(req,socket,head)=>{
  upgrades.push(record(req));
  if(req.headers.cookie!==nativeCookie){socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');return;}
  sockets.handleUpgrade(req,socket,head,client=>client.on('message',bytes=>{
   const input=JSON.parse(bytes.toString());
   client.send(JSON.stringify({type:'item',id:input.id,source:'private-central'}));
  }));
 });
 t.after(()=>{for(const socket of sockets.clients)socket.terminate();sockets.close();});
 const backendOrigin=await listen(t,backend);
 let cookieReads=0;
 const central=createCentralServer({publicOrigin,accountsOrigin,backendOrigin,ownerAccountId:ownerAccount.id,authorizationIntervalMs:100,
  backendResponseTimeoutMs,
  ...(allowEditor?{allowedAccountIds:[ownerAccount.id,editorAccount.id,otherAdminAccount.id]}:{}),
  getBackendCookie:async()=>{cookieReads++;return nativeCookie;},
 });
 const origin=await listen(t,central);
 const request=(path,cookie,init={})=>fetch(origin+path,{...init,redirect:'manual',headers:{...(cookie?{cookie}:{}),...init.headers}});
 const socketUrl=origin.replace('http:','ws:')+'/central/api/remote.mux';
 const openSocket=(cookie,browserOrigin=publicOrigin)=>{
  const socket=new WebSocket(socketUrl,{headers:{...(cookie?{cookie}:{}),origin:browserOrigin}});
  socket.on('error',()=>{});
  t.after(()=>socket.terminate());
  return socket;
 };
 return {store,ownerAccount,editorAccount,owner,editor,otherAdmin,unlistedAdmin,requests,upgrades,backend,backendOrigin,accountsOrigin,origin,request,openSocket,cookieReads:()=>cookieReads};
}

test('the gateway returns 504 if the central Host stalls before sending headers',async t=>{
 const f=await fixture(t,{backendResponseTimeoutMs:100,serveNative:req=>req.url==='/stalled'});
 const response=await f.request('/central/stalled',f.owner,{signal:AbortSignal.timeout(3000)});
 assert.equal(response.status,504);
 assert.match(await response.text(),/响应超时，请稍后重试/u);
 assert.equal((await f.request('/central/',f.owner)).status,200);
});

test('the gateway preserves a slow upload and an idle response stream',async t=>{
 const backendResponseTimeoutMs=100;
 const uploadObserved=Promise.withResolvers();
 const finishStream=Promise.withResolvers();
 const f=await fixture(t,{backendResponseTimeoutMs,serveNative(req,res){
  if(req.url==='/upload'){
   let body='';
   req.setEncoding('utf8');
   req.on('data',chunk=>{body+=chunk;uploadObserved.resolve();});
   req.once('end',()=>res.end(body));
   return true;
  }
  if(req.url==='/stream'){
   res.write('first ');
   void finishStream.promise.then(()=>res.end('last'));
   return true;
  }
  return false;
 }});
 const upload=await f.request('/central/upload',f.owner,{
  method:'POST',headers:{origin:publicOrigin},duplex:'half',signal:AbortSignal.timeout(3000),
  body:(async function*(){
   yield 'first ';
   await uploadObserved.promise;
   await delay(backendResponseTimeoutMs*3);
   yield 'last';
  })(),
 });
 assert.equal(upload.status,200);
 assert.equal(await upload.text(),'first last');
 const stream=await f.request('/central/stream',f.owner,{signal:AbortSignal.timeout(3000)});
 assert.equal(stream.status,200);
 await delay(backendResponseTimeoutMs*3);
 finishStream.resolve();
 assert.equal(await stream.text(),'first last');
});

test('explicitly granted accounts can enter and lose access when disabled',async t=>{
 const f=await fixture(t,{allowEditor:true});
 assert.equal((await f.request('/central/',f.owner)).status,200);
 assert.equal((await f.request('/central/',f.editor)).status,200);
 assert.equal((await f.request('/central/',f.otherAdmin)).status,200);
 assert.equal((await f.request('/central/',f.unlistedAdmin)).status,403);
 const socket=f.openSocket(f.editor);
 await once(socket,'open',{signal:AbortSignal.timeout(3000)});
 const closed=once(socket,'close',{signal:AbortSignal.timeout(3000)});
 await f.store.setDisabled(f.editorAccount.id,true);
 await closed;
 assert.equal((await f.request('/central/',f.editor)).status,200);
 assert.equal((await f.request('/central/bundle.js',f.editor)).status,303);
});

test('the central host is visible only to the designated administrator',async t=>{
 const f=await fixture(t);
 const anonymous=await f.request('/central/bundle.js');
 assert.equal(anonymous.status,303);
 assert.equal(anonymous.headers.get('location'),'/login');
 for(const cookie of [f.editor,f.otherAdmin]){
  assert.equal((await f.request('/central/',cookie)).status,403);
  assert.equal((await f.request('/central/bundle.js',cookie)).status,403);
 }
 assert.deepEqual(f.requests,[]);
 assert.equal(f.cookieReads(),0);
 const response=await f.request('/central/',f.owner);
 assert.equal(response.status,200);
 const html=await response.text();
 assert.match(html,/<base href="\.\/">/u);
 assert.match(html,/<script src="\.\/bundle\.js">/u);
 assert.match(html,/private central host/u);
 assert.equal((await f.request('/central/bundle.js',f.owner)).status,200);
 assert.deepEqual(f.requests.map(req=>[req.url,req.cookie]),[['/',nativeCookie],['/bundle.js',nativeCookie]]);
});

test('the anonymous entry exposes Feishu and the existing administrator password flow',async t=>{
 const f=await fixture(t);
 const entry=await f.request('/central/');
 assert.equal(entry.status,200);
 const html=await entry.text();
 assert.match(html,/href="\/login"/u);
 assert.match(html,/action="\/central\/login"/u);
 assert.doesNotMatch(html,/private central host/u);
 assert.equal(f.cookieReads(),0);

 const passwordLogin=(username,password,origin=publicOrigin)=>f.request('/central/login',undefined,{method:'POST',headers:{origin},body:new URLSearchParams({username,password})});
 assert.equal((await passwordLogin('owner',secret,'https://different.test')).status,403);
 const rejected=await passwordLogin('owner','invalid-password');
 assert.equal(rejected.status,401);
 assert.equal(rejected.headers.get('set-cookie'),null);
 for(const username of ['editor','different-admin']){
  const unauthorized=await passwordLogin(username,secret);
  assert.equal(unauthorized.status,403);
  assert.equal(unauthorized.headers.get('set-cookie'),null);
 }
 const login=await passwordLogin('owner',secret);
 assert.equal(login.status,303);
 assert.equal(login.headers.get('location'),'/central/');
 const cookie=login.headers.get('set-cookie')?.split(';')[0];
 assert.match(cookie??'',/^__Host-muse=/u);
 const central=await f.request('/central/',cookie);
 assert.equal(central.status,200);
 assert.match(await central.text(),/private central host/u);
});

test('the mount preserves native asset requests, same-host redirects and the private Host authority',async t=>{
 const f=await fixture(t);
 const path='/plugins/??bundle.js&rev=one%2Ftwo';
 const response=await f.request('/central'+path,`${f.owner}; untrusted=browser`,{headers:{origin:publicOrigin,authorization:'Bearer browser-only'}});
 assert.equal(response.status,200);
 assert.equal(await response.text(),`central ${path}`);
 assert.equal(response.headers.get('set-cookie'),null);
 assert.deepEqual(f.requests,[{url:path,cookie:nativeCookie,host:new URL(f.backendOrigin).host,origin:f.backendOrigin,authorization:undefined}]);
 const redirect=await f.request('/central/redirect',f.owner);
 assert.equal(redirect.status,302);
 assert.equal(redirect.headers.get('location'),'/central/home?q=a%2Fb#part');
 const outsideOrigin=await f.request('/central/api/edit',f.owner,{method:'POST',headers:{origin:'https://different.test'},body:'change'});
 assert.equal(outsideOrigin.status,403);
 assert.equal(f.requests.some(req=>req.url==='/api/edit'),false);
});

test('central WebSocket access rejects foreign sessions and closes on account revocation',async t=>{
 const f=await fixture(t);
 for(const [cookie,origin,status] of [[undefined,publicOrigin,401],[f.editor,publicOrigin,403],[f.otherAdmin,publicOrigin,403],[f.owner,'https://different.test',403]]){
  const [,response]=await once(f.openSocket(cookie,origin),'unexpected-response',{signal:AbortSignal.timeout(3000)});
  response.destroy();
  assert.equal(response.statusCode,status);
 }
 assert.deepEqual(f.upgrades,[]);
 const client=f.openSocket(f.owner);
 await once(client,'open',{signal:AbortSignal.timeout(3000)});
 const received=once(client,'message',{signal:AbortSignal.timeout(3000)});
 client.send(JSON.stringify({type:'open',id:'central-probe'}));
 assert.deepEqual(JSON.parse((await received)[0].toString()),{type:'item',id:'central-probe',source:'private-central'});
 assert.deepEqual(f.upgrades,[{url:'/api/remote.mux',cookie:nativeCookie,host:new URL(f.backendOrigin).host,origin:f.backendOrigin,authorization:undefined}]);
 const closed=once(client,'close',{signal:AbortSignal.timeout(3000)});
 await f.store.setDisabled(f.ownerAccount.id,true);
 await closed;
 assert.equal((await f.request('/central/bundle.js',f.owner)).status,303);
 const ordinaryComputers=await fetch(f.accountsOrigin+'/computers',{headers:{cookie:f.editor}});
 assert.equal(ordinaryComputers.status,200);
 assert.match(await ordinaryComputers.text(),/选择电脑/u);
});

test('the desktop chooser remains available when the central Host is down',async t=>{
 const f=await fixture(t);
 await new Promise(resolve=>f.backend.close(resolve));
 const central=await f.request('/central/',f.owner);
 assert.ok(central.status===502||central.status===503);
 const desktop=await fetch(f.accountsOrigin+'/computers',{headers:{cookie:f.editor}});
 assert.equal(desktop.status,200);
 assert.match(await desktop.text(),/选择电脑/u);
});

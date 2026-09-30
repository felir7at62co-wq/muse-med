/** Real pinned desktop client paired with the account gateway over local HTTP and WebSocket. */
import assert from 'node:assert/strict';
import {once} from 'node:events';
import http from 'node:http';
import {cp,mkdtemp,rm,symlink,unlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {randomUUID} from 'node:crypto';
import {gzipSync} from 'node:zlib';
import {test} from 'node:test';
import {WebSocket,WebSocketServer} from 'ws';
import {openStore} from './store.mjs';
import {createAccountServer} from './gateway.mjs';
import {applyBridgeDesktopCompatibility} from '../../third_party/plugins/compatibility/bridge-desktop.mjs';

const repository=fileURLToPath(new URL('../../',import.meta.url));

async function listen(server){server.listen(0,'127.0.0.1');await once(server,'listening');return `http://127.0.0.1:${server.address().port}`;}
async function fixture(t,desktopRelayOptions={}){
 const root=await mkdtemp(join(tmpdir(),'muse-real-desktop-')),tunnels=[],servers=[],wsServers=[];
 t.after(async()=>{await Promise.allSettled(tunnels.map(x=>x.stop()));for(const wss of wsServers){for(const ws of wss.clients)ws.terminate();await new Promise(r=>wss.close(r));}for(const server of servers){server.closeAllConnections();await new Promise(r=>server.close(r));}await unlink(join(root,'plugin/node_modules'));await rm(root,{recursive:true,force:true});});
 const plugin=join(root,'plugin');await cp(join(repository,'third_party/plugins/dsh-bridge'),plugin,{recursive:true});applyBridgeDesktopCompatibility(plugin);
 await symlink(join(repository,'third_party/plugins/toolchain/node_modules'),join(plugin,'node_modules'),process.platform==='win32'?'junction':'dir');
 const {createMuseDesktopTunnel}=await import(pathToFileURL(join(plugin,'lib/muse-desktop-tunnel.mjs')).href);
 const store=await openStore(join(root,'accounts.json'));await store.create('alice','password');await store.create('bob','password');
 const origin='https://muse.test',gateway=createAccountServer({store,workspaceMode:'desktop',publicOrigin:origin,desktopRelayOptions});servers.push(gateway);const base=await listen(gateway);
 async function login(username){const r=await fetch(base+'/login',{method:'POST',headers:{origin},body:new URLSearchParams({username,password:'password'}),redirect:'manual'});assert.equal(r.status,303);return r.headers.get('set-cookie').split(';')[0];}
 const alice=await login('alice'),bob=await login('bob');
 async function desktop(cookie,handler,deviceId=randomUUID()){
  const host=http.createServer(handler);servers.push(host);await listen(host);
  const tunnel=createMuseDesktopTunnel({serverUrl:base.replace('http:','ws:')+'/api/desktop/connect',headers:{cookie,origin},localPort:host.address().port,loopbackCookie:'host=local-private',deviceId,chunkBytes:32768,ackTimeoutMs:5000,reconnectMaxIntervalMs:1000});tunnels.push(tunnel);await tunnel.start();return {tunnel,host,deviceId};
 }
 return {base,origin,alice,bob,store,desktop,wsServers,login};
}

test('website forwards the same desktop, private settings, binary uploads and video ranges',async t=>{
 const f=await fixture(t),upload=Buffer.alloc(190000,72),video=Buffer.alloc(155000,91);let mutations=0;
 await f.desktop(f.alice,async(req,res)=>{
  assert.equal(req.headers.cookie,'host=local-private');assert.equal(req.headers.origin,`http://127.0.0.1:${req.socket.localPort}`);
  if(req.url==='/api/video'){assert.equal(req.headers.range,'bytes=100-155099');res.writeHead(206,{'content-type':'video/mp4','content-range':'bytes 100-155099/300000','content-length':video.length});res.end(video);}
  else if(req.url==='/api/settings/mutate'){mutations++;const chunks=[];for await(const c of req)chunks.push(c);assert.deepEqual(Buffer.concat(chunks),upload);res.end('desktop settings saved');}
  else res.end('ALICE DESKTOP SESSION');
 });
 await f.desktop(f.bob,(_req,res)=>res.end('BOB DESKTOP SESSION'));
 assert.equal(await(await fetch(f.base+'/',{headers:{cookie:f.alice}})).text(),'ALICE DESKTOP SESSION');
 assert.equal(await(await fetch(f.base+'/',{headers:{cookie:f.bob}})).text(),'BOB DESKTOP SESSION');
 const mutation=await fetch(f.base+'/api/settings/mutate',{method:'POST',headers:{cookie:f.alice,origin:f.origin},body:upload});assert.equal(await mutation.text(),'desktop settings saved');assert.equal(mutations,1);
 const result=await fetch(f.base+'/api/video',{headers:{cookie:f.alice,range:'bytes=100-155099'}});assert.equal(result.status,206);assert.equal(result.headers.get('content-range'),'bytes 100-155099/300000');assert.deepEqual(Buffer.from(await result.arrayBuffer()),video);
 assert.equal(result.headers.get('set-cookie'),null);
});

test('remote mux retains its desktop Host authority and streams real WebSocket frames',async t=>{
 const f=await fixture(t),d=await f.desktop(f.alice,(_req,res)=>res.end());
 const wss=new WebSocketServer({noServer:true});f.wsServers.push(wss);let native;
 d.host.on('upgrade',(req,socket,head)=>{assert.equal(req.url,'/api/remote.mux');assert.equal(req.headers.cookie,'host=local-private');wss.handleUpgrade(req,socket,head,ws=>{native=ws;ws.on('message',(bytes,binary)=>ws.send(bytes,{binary}));ws.send(Buffer.alloc(90000,44));});});
 const socket=new WebSocket(f.base.replace('http:','ws:')+'/api/remote.mux',{headers:{cookie:f.alice,origin:f.origin}});t.after(()=>socket.terminate());
 const first=once(socket,'message');await once(socket,'open');assert.deepEqual((await first)[0],Buffer.alloc(90000,44));
 const echo=once(socket,'message');socket.send('same-session-progress');assert.equal((await echo)[0].toString(),'same-session-progress');
 const ping=once(socket,'ping',{signal:AbortSignal.timeout(2000)}),pong=once(native,'pong',{signal:AbortSignal.timeout(2000)});
 native.ping('desktop-presence');await ping;await pong;
 socket.close();await once(socket,'close');
});

test('a second computer cannot replace a connected desktop and account revocation closes access',async t=>{
 const f=await fixture(t);await f.desktop(f.alice,(_req,res)=>res.end('original desktop'));
 await assert.rejects(f.desktop(f.alice,(_req,res)=>res.end('unwanted replacement')));
 assert.equal(await(await fetch(f.base+'/',{headers:{cookie:f.alice}})).text(),'original desktop');
 const id=f.store.list().find(a=>a.username==='alice').id;await f.store.resetPassword(id,'new-password');
 const response=await fetch(f.base+'/api/desktop/status',{headers:{cookie:f.alice},redirect:'manual'});assert.equal(response.status,303);
 assert.deepEqual(await(await fetch(f.base+'/api/desktop/status',{headers:{cookie:f.bob}})).json(),{state:'offline'});
});

test('a silent desktop loses online status after its server heartbeat deadline',async t=>{
 const f=await fixture(t,{heartbeatIntervalMs:300,heartbeatTimeoutMs:600});
 const control=new WebSocket(f.base.replace('http:','ws:')+'/api/desktop/connect',{autoPong:false,headers:{cookie:f.alice,origin:f.origin}});
 t.after(()=>control.terminate());
 await once(control,'open');const ready=once(control,'message');
 control.send(JSON.stringify({type:'connect',version:1,deviceId:randomUUID()}));
 assert.equal(JSON.parse((await ready)[0].toString()).type,'ready');
 assert.deepEqual(await(await fetch(f.base+'/api/desktop/status',{headers:{cookie:f.alice}})).json(),{state:'online'});
 await once(control,'close');
 assert.deepEqual(await(await fetch(f.base+'/api/desktop/status',{headers:{cookie:f.alice}})).json(),{state:'offline'});
});

test('only a complete unencoded entry page gains the private desktop presence observer',async t=>{
 const f=await fixture(t),body='<html><body><input value="draft"></body></html>';
 await f.desktop(f.alice,(req,res)=>{
  assert.equal(req.headers['accept-encoding'],'identity');
  if(req.url==='/?compressed=1') {
   const encoded=gzipSync(body);res.writeHead(200,{'content-type':'text/html','content-encoding':'gzip','content-length':encoded.length,etag:'encoded'});res.end(encoded);return;
  }
  res.writeHead(req.headers.range?206:200,{'content-type':'text/html','content-length':Buffer.byteLength(body),etag:'original'});res.end(body);
 });
 const response=await fetch(f.base+'/',{headers:{cookie:f.alice}});
 assert.equal(response.headers.get('content-length'),null);assert.equal(response.headers.get('etag'),null);
 assert.equal(await response.text(),body+'<script src="/desktop-presence.js"></script>');
 const head=await fetch(f.base+'/',{method:'HEAD',headers:{cookie:f.alice}});assert.equal(head.headers.get('content-length'),String(Buffer.byteLength(body)));
 const range=await fetch(f.base+'/',{headers:{cookie:f.alice,range:'bytes=0-99'}});assert.equal(range.status,206);assert.equal(await range.text(),body);
 const encoded=await fetch(f.base+'/?compressed=1',{headers:{cookie:f.alice}});assert.equal(encoded.headers.get('etag'),'encoded');assert.equal(encoded.headers.get('content-length'),String(gzipSync(body).length));assert.equal(await encoded.text(),body);
 const script=await fetch(f.base+'/desktop-presence.js',{headers:{cookie:f.alice}});assert.equal(script.status,200);assert.match(await script.text(),/您的电脑上的 Muse 未启动/);
 assert.equal((await fetch(f.base+'/desktop-presence.js',{redirect:'manual'})).status,303);
});

test('closing a browser response detaches its stream without cancelling or repeating desktop work',async t=>{
 const f=await fixture(t);let submits=0,closed;const detached=new Promise(r=>closed=r);
 await f.desktop(f.alice,(req,res)=>{if(req.url==='/api/job/submit'){submits++;res.writeHead(200,{'content-type':'text/event-stream'});res.write('data: task accepted\n\n');res.once('close',closed);}else res.end('agent keeps working');});
 const controller=new AbortController(),r=await fetch(f.base+'/api/job/submit',{method:'POST',headers:{cookie:f.alice,origin:f.origin},signal:controller.signal});await r.body.getReader().read();controller.abort();await detached;
 assert.equal(submits,1);assert.equal(await(await fetch(f.base+'/',{headers:{cookie:f.alice}})).text(),'agent keeps working');
});

test('an aborted Host response ends its browser stream while the desktop stays online',async t=>{
 const f=await fixture(t);let hostResponse;
 await f.desktop(f.alice,(req,res)=>{
  if(req.url==='/api/stream'){hostResponse=res;res.writeHead(200,{'content-type':'text/event-stream'});res.write('data: first\n\n');}
  else res.end('desktop still available');
 });
 const response=await fetch(f.base+'/api/stream',{headers:{cookie:f.alice},signal:AbortSignal.timeout(5000)});
 const reader=response.body.getReader();assert.equal(Buffer.from((await reader.read()).value).toString(),'data: first\n\n');
 const ended=reader.read();hostResponse.destroy();await assert.rejects(ended,/terminated/);
 assert.deepEqual(await(await fetch(f.base+'/api/desktop/status',{headers:{cookie:f.alice}})).json(),{state:'online'});
 assert.equal(await(await fetch(f.base+'/',{headers:{cookie:f.alice}})).text(),'desktop still available');
});

test('a refused native WebSocket upgrade leaves other desktop requests connected',async t=>{
 const f=await fixture(t),d=await f.desktop(f.alice,(_req,res)=>res.end('desktop still available'));
 d.host.on('upgrade',(_req,socket)=>socket.end('HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n'));
 const browser=new WebSocket(f.base.replace('http:','ws:')+'/api/remote.mux',{headers:{cookie:f.alice,origin:f.origin}});
 // A refused handshake also emits an error when its unfinished request is terminated.
 browser.on('error',()=>{});
 t.after(async()=>{if(browser.readyState===WebSocket.CLOSED)return;const closed=new Promise(resolve=>browser.once('close',resolve));browser.terminate();await closed;});
 const [,response]=await once(browser,'unexpected-response');assert.equal(response.statusCode,503);response.destroy();
 assert.deepEqual(await(await fetch(f.base+'/api/desktop/status',{headers:{cookie:f.alice}})).json(),{state:'online'});
 assert.equal(await(await fetch(f.base+'/',{headers:{cookie:f.alice}})).text(),'desktop still available');
});

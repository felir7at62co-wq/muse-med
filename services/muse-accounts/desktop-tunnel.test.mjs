/** Real pinned desktop client paired with the account gateway over local HTTP and WebSocket. */
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import {gzipSync} from 'node:zlib';
import {test} from 'node:test';
import {WebSocket,WebSocketServer} from 'ws';

import {fixture} from './desktop-test-fixture.mjs';

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

test('two computers remain connected independently and password reset revokes both',async t=>{
 const f=await fixture(t),first=await f.desktop(f.alice,(_req,res)=>res.end('first desktop'));
 const second=await f.desktop(f.alice,(_req,res)=>res.end('second desktop'));
 assert.match(await(await fetch(f.base+'/',{headers:{cookie:f.alice}})).text(),/选择电脑/);
 for(const [device,text] of [[first,'first desktop'],[second,'second desktop']])assert.equal(await(await fetch(`${f.base}/desktop/${device.deviceId}/`,{headers:{cookie:f.alice}})).text(),text);
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
 const desktop=await f.desktop(f.alice,(req,res)=>{
  assert.equal(req.headers['accept-encoding'],'identity');
  if(req.url==='/?compressed=1') {
   const encoded=gzipSync(body);res.writeHead(200,{'content-type':'text/html','content-encoding':'gzip','content-length':encoded.length,etag:'encoded'});res.end(encoded);return;
  }
  res.writeHead(req.headers.range?206:200,{'content-type':'text/html','content-length':Buffer.byteLength(body),etag:'original'});res.end(body);
 });
 const response=await fetch(f.base+'/',{headers:{cookie:f.alice}});
 assert.equal(response.headers.get('content-length'),null);assert.equal(response.headers.get('etag'),null);
 assert.equal(await response.text(),body+`<script src="/desktop/${desktop.deviceId}/desktop-presence.js" data-name="电脑 · ${desktop.deviceId.slice(0,8)}"></script>`);
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

test('two tabs route mutations and streams to their selected computer and reject another account device',async t=>{
 const f=await fixture(t),seen=[[],[]],streams=[];
 function handler(index){return async(req,res)=>{
  seen[index].push(req.url);assert.equal(req.headers.cookie,'host=local-private');
  if(req.url==='/api/live'){res.writeHead(200,{'content-type':'text/event-stream'});res.write(`data: computer-${index}\n\n`);streams[index]=res;return;}
  const chunks=[];for await(const chunk of req)chunks.push(chunk);
  res.end(JSON.stringify({computer:index,path:req.url,body:Buffer.concat(chunks).toString()}));
 };}
 const one=await f.desktop(f.alice,handler(0),randomUUID(),{deviceName:'剪辑电脑',platform:'win32'});
 const two=await f.desktop(f.alice,handler(1),randomUUID(),{deviceName:'外出 Mac',platform:'darwin'});
 const other=await f.desktop(f.bob,(_req,res)=>res.end('PRIVATE BOB'));
 const devices=await(await fetch(f.base+'/api/desktop/devices',{headers:{cookie:f.alice}})).json();
 assert.deepEqual(devices.devices.map(d=>[d.name,d.platform,d.state]),[['剪辑电脑','win32','online'],['外出 Mac','darwin','online']]);
 assert.doesNotMatch(JSON.stringify(devices),new RegExp(other.deviceId+'|local-private|__Host-muse'));
 const picker=await(await fetch(f.base+'/',{headers:{cookie:f.alice}})).text();
 assert.match(picker,/剪辑电脑/);assert.match(picker,/外出 Mac/);assert.doesNotMatch(picker,new RegExp(other.deviceId));
 const controllers=[new AbortController(),new AbortController()];t.after(()=>controllers.forEach(c=>c.abort()));
 const mounts=[one,two].map(d=>`${f.base}/desktop/${d.deviceId}/`);
 const live=await Promise.all(mounts.map((mount,index)=>fetch(mount+'api/live',{headers:{cookie:f.alice},signal:controllers[index].signal})));
 for(let index=0;index<2;index++)assert.equal(Buffer.from((await live[index].body.getReader().read()).value).toString(),`data: computer-${index}\n\n`);
 const mutations=await Promise.all(mounts.map((mount,index)=>fetch(mount+'api/write?file=script.md',{method:'POST',headers:{cookie:f.alice,origin:f.origin},body:`tab-${index}`})));
 assert.deepEqual(await Promise.all(mutations.map(r=>r.json())),[{computer:0,path:'/api/write?file=script.md',body:'tab-0'},{computer:1,path:'/api/write?file=script.md',body:'tab-1'}]);
 assert.deepEqual(seen,[['/api/live','/api/write?file=script.md'],['/api/live','/api/write?file=script.md']]);
 assert.equal((await fetch(f.base+'/api/write',{method:'POST',headers:{cookie:f.alice,origin:f.origin},body:'ambiguous'})).status,503);
 assert.equal((await fetch(`${f.base}/desktop/${other.deviceId}/api/write`,{method:'POST',headers:{cookie:f.alice,origin:f.origin}})).status,404);
 streams.forEach(s=>s.end());
});

test('each computer has its own mounted WebSocket even with the same browser login',async t=>{
 const f=await fixture(t),devices=[];
 for(const label of ['first','second']){
  const device=await f.desktop(f.alice,(_req,res)=>res.end(label));devices.push(device);
  const native=new WebSocketServer({noServer:true});f.wsServers.push(native);
  device.host.on('upgrade',(req,socket,head)=>{assert.equal(req.url,'/api/remote.mux');native.handleUpgrade(req,socket,head,ws=>ws.on('message',bytes=>ws.send(label+':'+bytes.toString())));});
 }
 const browsers=devices.map(d=>new WebSocket(`${f.base.replace('http:','ws:')}/desktop/${d.deviceId}/api/remote.mux`,{headers:{cookie:f.alice,origin:f.origin}}));
 t.after(()=>browsers.forEach(s=>s.terminate()));await Promise.all(browsers.map(s=>once(s,'open')));
 const replies=browsers.map(s=>once(s,'message'));browsers.forEach(s=>s.send('my-tab'));
 assert.deepEqual((await Promise.all(replies)).map(x=>x[0].toString()),['first:my-tab','second:my-tab']);
 await Promise.all(browsers.map(async s=>{const closed=once(s,'close');s.close();await closed;}));
});

test('an offline tab waits for its original installation while another computer remains online',async t=>{
 const f=await fixture(t),one=await f.desktop(f.alice,(_req,res)=>res.end('FIRST'));
 const two=await f.desktop(f.alice,(_req,res)=>res.end('SECOND'));
 const mounted=`${f.base}/desktop/${one.deviceId}/`;
 await one.tunnel.stop();
 const offline=await fetch(mounted+'api/read',{headers:{cookie:f.alice}});assert.equal(offline.status,503);
 assert.equal((await(await fetch(mounted+'api/desktop/status',{headers:{cookie:f.alice}})).json()).state,'offline');
 assert.match(await(await fetch(mounted,{headers:{cookie:f.alice}})).text(),/连接恢复后会返回这台电脑/);
 assert.equal(await(await fetch(`${f.base}/desktop/${two.deviceId}/`,{headers:{cookie:f.alice}})).text(),'SECOND');
 const restored=await f.desktop(f.alice,(_req,res)=>res.end('FIRST RESTORED'),one.deviceId);
 assert.equal(restored.deviceId,one.deviceId);
 assert.equal(await(await fetch(mounted+'api/read',{headers:{cookie:f.alice}})).text(),'FIRST RESTORED');
 assert.equal((await(await fetch(f.base+'/api/desktop/devices',{headers:{cookie:f.alice}})).json()).devices.length,2);
});

test('browser logout leaves independently authenticated computers connected and revokes its own observations',async t=>{
 const f=await fixture(t),desktopCookie=await f.login('alice');
 const one=await f.desktop(desktopCookie,(_req,res)=>res.end('ONE')),two=await f.desktop(desktopCookie,(_req,res)=>res.end('TWO'));
 const logout=await fetch(f.base+'/logout',{method:'POST',headers:{cookie:f.alice,origin:f.origin},redirect:'manual'});assert.equal(logout.status,303);
 assert.equal((await fetch(`${f.base}/desktop/${one.deviceId}/`,{headers:{cookie:f.alice},redirect:'manual'})).status,303);
 for(const d of [one,two])assert.equal((await(await fetch(`${f.base}/desktop/${d.deviceId}/api/desktop/status`,{headers:{cookie:desktopCookie}})).json()).state,'online');
});


test('reconnecting the same installation replaces only its previous tunnel',async t=>{
 const f=await fixture(t),states=[];
 const first=await f.desktop(f.alice,(_req,res)=>res.end('OLD'),randomUUID(),{onState:state=>states.push(state)});
 const other=await f.desktop(f.alice,(_req,res)=>res.end('OTHER'));
 await f.desktop(f.alice,(_req,res)=>res.end('NEW'),first.deviceId);
 assert.equal(await(await fetch(`${f.base}/desktop/${first.deviceId}/`,{headers:{cookie:f.alice}})).text(),'NEW');
 assert.equal(await(await fetch(`${f.base}/desktop/${other.deviceId}/`,{headers:{cookie:f.alice}})).text(),'OTHER');
 assert.equal((await(await fetch(f.base+'/api/desktop/devices',{headers:{cookie:f.alice}})).json()).devices.length,2);
 assert.ok(states.includes('rejected'));
});


test('desktop redirects retain the selected mount and resolve relative paths from the request',async t=>{
 const f=await fixture(t),device=await f.desktop(f.alice,(req,res)=>{res.writeHead(302,{location:req.url==='/section/start'?'next?file=%2Fa.md#result':'/login-local'});res.end();});
 const mount=`/desktop/${device.deviceId}/`;
 const relative=await fetch(f.base+mount+'section/start',{headers:{cookie:f.alice},redirect:'manual'});
 assert.equal(relative.headers.get('location'),mount+'section/next?file=%2Fa.md#result');
 const absolute=await fetch(f.base+mount+'anything',{headers:{cookie:f.alice},redirect:'manual'});
 assert.equal(absolute.headers.get('location'),mount+'login-local');
 const canonical=await fetch(f.base+mount.slice(0,-1)+'?lang=zh',{headers:{cookie:f.alice},redirect:'manual'});
 assert.equal(canonical.status,303);assert.equal(canonical.headers.get('location'),mount+'?lang=zh');
});

test('another account cannot open a computer WebSocket',async t=>{
 const f=await fixture(t),device=await f.desktop(f.bob,(_req,res)=>res.end());
 const socket=new WebSocket(`${f.base.replace('http:','ws:')}/desktop/${device.deviceId}/api/remote.mux`,{headers:{cookie:f.alice,origin:f.origin}});
 socket.on('error',()=>{});t.after(()=>socket.terminate());
 const [,response]=await once(socket,'unexpected-response');assert.equal(response.statusCode,404);response.destroy();
});


test('a rejected additional installation leaves the admitted computer usable',async t=>{
 const f=await fixture(t,{maxDevices:1}),first=await f.desktop(f.alice,(_req,res)=>res.end('ADMITTED'));
 const states=[];await assert.rejects(f.desktop(f.alice,(_req,res)=>res.end('OVER LIMIT'),randomUUID(),{onState:state=>states.push(state)}));assert.ok(states.includes('rejected'));
 assert.equal(await(await fetch(`${f.base}/desktop/${first.deviceId}/`,{headers:{cookie:f.alice}})).text(),'ADMITTED');
 const devices=(await(await fetch(f.base+'/api/desktop/devices',{headers:{cookie:f.alice}})).json()).devices;
 assert.equal(devices.length,1);assert.equal(devices[0].state,'online');
});

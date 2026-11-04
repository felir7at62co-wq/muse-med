/** Mobile entry URLs retain one authenticated desktop for installation and task interaction. */
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {test} from 'node:test';
import {desktopPrefix} from './desktop-route.mjs';
import {fixture} from './desktop-test-fixture.mjs';

test('a mounted mobile manifest installs within its selected computer and requires the same account',async t=>{
 const f=await fixture(t),seen=[];
 const manifest=await readFile(new URL('../../apps/web/public/manifest.webmanifest',import.meta.url),'utf8');
 const device=await f.desktop(f.alice,(req,res)=>{
  seen.push(req.url);
  if(req.url==='/manifest.webmanifest'){res.setHeader('content-type','application/manifest+json');res.end(manifest);return;}
  res.setHeader('content-type','text/html');res.end('<!doctype html><head><link rel="manifest" href="./manifest.webmanifest"></head><body>Muse</body>');
 });
 const prefix=desktopPrefix(device.deviceId),entry=f.base+prefix+'?mobile=1';
 const response=await fetch(entry,{headers:{cookie:f.alice}}),html=await response.text();
 assert.equal(response.status,200);assert.match(html,/desktop-presence\.js/);
 const manifestUrl=new URL(html.match(/rel="manifest" href="([^"]+)"/)[1],entry);
 assert.equal(manifestUrl.pathname,prefix+'manifest.webmanifest');
 const manifestResponse=await fetch(manifestUrl,{headers:{cookie:f.alice}});
 assert.equal(manifestResponse.status,200);
 const installed=await manifestResponse.json();
 const startUrl=new URL(installed.start_url,manifestUrl);
 assert.equal(startUrl.pathname,prefix);
 const identity=typeof installed.id==='string'?new URL(installed.id,startUrl.origin):startUrl;
 assert.equal(identity.pathname,prefix);
 assert.equal(new URL(installed.scope,manifestUrl).pathname,prefix);
 assert.ok(installed.icons.every(icon=>new URL(icon.src,manifestUrl).pathname.startsWith(prefix)));
 assert.deepEqual(seen,['/?mobile=1','/manifest.webmanifest']);
 assert.equal((await fetch(manifestUrl,{redirect:'manual'})).status,303);
 assert.equal((await fetch(manifestUrl,{headers:{cookie:f.bob},redirect:'manual'})).status,404);
 assert.deepEqual(seen,['/?mobile=1','/manifest.webmanifest']);
});

test('mobile task, confirmation, live progress and result requests use the selected desktop',async t=>{
 const f=await fixture(t),writes=[],controllers=[];let stream;
 t.after(()=>controllers.forEach(controller=>controller.abort()));
 const device=await f.desktop(f.alice,async(req,res)=>{
  assert.equal(req.headers.cookie,'host=local-private');
  if(req.url==='/api/bot/feed'){
   res.writeHead(200,{'content-type':'text/event-stream'});res.write('event: live\ndata: {"work":{"bots":{"editor":{"status":"running"}}}}\n\n');stream=res;return;
  }
  if(req.url==='/api/bot'){
   const chunks=[];for await(const chunk of req)chunks.push(chunk);
   writes.push(JSON.parse(Buffer.concat(chunks).toString()));res.setHeader('content-type','application/json');res.end(JSON.stringify({ok:true,value:{accepted:true}}));return;
  }
  if(req.url==='/results/episode.mp4'){
   assert.equal(req.headers.range,'bytes=0-3');res.writeHead(206,{'content-type':'video/mp4','content-range':'bytes 0-3/8','accept-ranges':'bytes','content-length':'4'});res.end('MP4!');return;
  }
  res.writeHead(404);res.end();
 });
 const prefix=f.base+desktopPrefix(device.deviceId),headers={cookie:f.alice,origin:f.origin,'content-type':'application/json'};
 for(const body of [{endpoint:'send',payload:{sessionId:'editor',text:'检查选材',clientRequestId:'mobile-one'}},{endpoint:'answer-question',payload:{sessionId:'editor',questionId:'question-one',answer:'继续'}}]){
  const response=await fetch(prefix+'api/bot',{method:'POST',headers,body:JSON.stringify(body)});
  assert.equal(response.status,200);assert.equal((await response.json()).value.accepted,true);
 }
 const controller=new AbortController();controllers.push(controller);
 const progress=await fetch(prefix+'api/bot/feed',{headers:{cookie:f.alice},signal:controller.signal});
 const reader=progress.body.getReader();assert.match(Buffer.from((await reader.read()).value).toString(),/"status":"running"/);
 controller.abort();stream.end();
 const result=await fetch(prefix+'results/episode.mp4',{headers:{cookie:f.alice,range:'bytes=0-3'}});
 assert.equal(result.status,206);assert.equal(result.headers.get('content-range'),'bytes 0-3/8');assert.equal(await result.text(),'MP4!');
 assert.deepEqual(writes.map(write=>write.endpoint),['send','answer-question']);
 const refused=await fetch(prefix+'api/bot',{method:'POST',headers:{...headers,origin:'https://another.invalid'},body:JSON.stringify({endpoint:'send',payload:{text:'wrong-origin'}})});
 assert.equal(refused.status,403);assert.equal(writes.length,2);
});

test('computer selection and an offline mobile entry preserve mobile mode without changing targets',async t=>{
 const f=await fixture(t),one=await f.desktop(f.alice,(_req,res)=>res.end('FIRST'));
 const two=await f.desktop(f.alice,(_req,res)=>res.end('SECOND'));
 const picker=await(await fetch(f.base+'/computers?mobile=1',{headers:{cookie:f.alice}})).text();
 for(const device of [one,two])assert.ok(picker.includes(`href="${desktopPrefix(device.deviceId)}?mobile=1"`));
 assert.match(picker,/data-mobile="true"/);
 const plain=await(await fetch(f.base+'/computers?mobile=unexpected',{headers:{cookie:f.alice}})).text();
 assert.match(plain,/data-mobile="false"/);assert.doesNotMatch(plain,/\?mobile=1/);
 await one.tunnel.stop();
 const waiting=await(await fetch(f.base+desktopPrefix(one.deviceId)+'?mobile=1',{headers:{cookie:f.alice}})).text();
 assert.match(waiting,/data-mobile="true"/);assert.ok(waiting.includes(`data-selected="${one.deviceId}"`));
 assert.ok(waiting.includes(`href="${desktopPrefix(two.deviceId)}?mobile=1"`));
 assert.match(waiting,/连接恢复后会返回这台电脑/);
});

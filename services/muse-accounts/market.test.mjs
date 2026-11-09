/** Matching-built cloud API and account gateway, including committed-response loss. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {mkdtemp,writeFile,rm,readdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import http from 'node:http';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createMarketProxy} from './market-proxy.mjs';
import {createAccountServer} from './gateway.mjs';
import {openStore} from './store.mjs';

const root=fileURLToPath(new URL('../../',import.meta.url)),cloud=join(root,'packages/host/muse-market/lib/cloud-host.js');
const listen=server=>new Promise(resolve=>server.listen(0,'127.0.0.1',()=>resolve('http://127.0.0.1:'+server.address().port)));
async function close(server){server.closeAllConnections();if(server.listening)await new Promise(resolve=>server.close(resolve));}

test('real gateway keeps original upload identity and review revision after committed replies are lost',{
 skip:!existsSync(cloud)?'requires the normal matching DSH cloud-host build':false,
},async t=>{
 const [{Context},{default:WebServer},CloudHost,{createMarketPackage}]=await Promise.all([
  import('@deepseek-ai/cordis'),import(pathToFileURL(join(root,'packages/host/webserver/lib/index.js')).href),
  import(pathToFileURL(cloud).href),import(pathToFileURL(join(root,'packages/host/muse-market/lib/package.js')).href),
 ]);
 const directory=await mkdtemp(join(tmpdir(),'muse-market-full-http-')),ctx=new Context(),servers=[],active=new Set();let proxy;
 t.after(async()=>{await proxy?.close();for(const request of active)request.destroy();for(const server of servers.reverse())await close(server);await ctx.fiber.dispose();await rm(directory,{recursive:true,force:true});});
 const secret='s'.repeat(48),secretFile=join(directory,'secret'),policyFile=join(directory,'cloud-policy.json'),storage=join(directory,'catalog');
 await writeFile(secretFile,secret,{mode:0o600});
 const limits={archiveBytes:1048576,expandedBytes:2097152,fileCount:32,recordBytes:1048576};
 await writeFile(policyFile,JSON.stringify({root:storage,secretFile,maxReleases:20,maxActiveUploads:4,
  jsonRequestBytes:4096,jsonResponseBytes:1048576,catalogLimit:100,limits}),{mode:0o600});
 await ctx.plugin(WebServer,{host:'127.0.0.1',port:0,compression:'none'}).await();
 await ctx.plugin(CloudHost,{policyFile}).await();const backend=new URL(ctx.webServer.getOrigin());
 const faults={upload:true,review:true},dropped=[];
 const carrier=http.createServer((req,res)=>{
  let lost=false;
  const request=http.request({hostname:backend.hostname,port:backend.port,path:req.url,method:req.method,
   headers:{...req.headers,host:backend.host},agent:false},response=>{
   const kind=req.method==='POST'&&req.url==='/api/market/v1/uploads'&&response.statusCode===201?'upload'
    :req.method==='POST'&&req.url.endsWith('/review')&&response.statusCode===200?'review':undefined;
   if(kind&&faults[kind]){faults[kind]=false;lost=true;dropped.push(kind);res.destroy();response.resume();return;}
   res.writeHead(response.statusCode,response.headers);response.pipe(res);
  });
  active.add(request);request.once('close',()=>active.delete(request));
  request.on('error',()=>{if(!res.destroyed)res.destroy();});
  req.on('aborted',()=>request.destroy());res.on('close',()=>{if(!lost)request.destroy();});req.pipe(request);
 });servers.push(carrier);const upstream=await listen(carrier);
 proxy=await createMarketProxy({upstream,secretFile,archiveBytes:limits.archiveBytes,jsonRequestBytes:4096,
  jsonResponseBytes:1048576,requestTimeoutMs:5000,requestRatePerMinute:1000});
 const accounts=await openStore(join(directory,'accounts.json'));
 const admin=await accounts.create('admin','pw',{admin:true}),author=await accounts.create('author','pw'),reader=await accounts.create('reader','pw');
 let tenants=0;const server=http.createServer();servers.push(server);const origin=await listen(server);
 createAccountServer({httpServer:server,publicOrigin:origin,store:accounts,market:proxy,workspaceMode:'desktop',
  runtime:{ensure:async()=>{tenants++;throw Error('Market must not start a tenant');}}});
 const request=(path,{cookie,headers={},...options}={})=>fetch(origin+path,{redirect:'manual',signal:AbortSignal.timeout(15000),
  ...options,headers:{origin,...cookie?{cookie}:{},...headers}});
 const login=async username=>{const response=await request('/login',{method:'POST',body:new URLSearchParams({username,password:'pw'})});
  assert.equal(response.status,303);await response.arrayBuffer();return response.headers.get('set-cookie').split(';')[0];};
 const adminCookie=await login('admin'),authorCookie=await login('author'),readerCookie=await login('reader');
 const json=(path,cookie,value)=>request(path,{cookie,method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(value)});
 assert.deepEqual(await(await request('/api/market/v1/catalog')).json(),{items:[]});
 const invitation=await json('/api/market/v1/publishers',adminCookie,{title:'Studio',accountId:author.id});
 assert.equal(invitation.status,201);const publisher=(await invitation.json()).id;assert.match(publisher,/^[a-f0-9]{32}$/u);
 const identity=await(await request('/api/market/v1/me',{cookie:authorCookie})).json();
 assert.deepEqual(identity,{publishers:[{id:publisher,title:'Studio'}],admin:false});
 function archive(version){return Buffer.from(createMarketPackage({name:'gateway-scene-review',title:'Scene review',
  description:'Retain original dialogue while reviewing a scene.',version,license:'MIT',category:'writing',
  examples:['Review the scene.'],requirements:['The original scene.'],formatVersion:1,kind:'skill',
  skills:[{name:'scene-review',path:'skills/scene-review/SKILL.md'}]}, {
  'skills/scene-review/SKILL.md':Buffer.from('---\nname: scene-review\ndescription: Review the scene.\n---\nKeep the original dialogue.\n'),
  'skills/scene-review/references/rules.md':Buffer.from('Original reference.\n'),
 },limits));}
 const bytes=archive('1.0.0'),sha256=createHash('sha256').update(bytes).digest('hex'),key='original-upload-key';
 const upload=(cookie=authorCookie,body=bytes,target=publisher)=>request('/api/market/v1/uploads',{cookie,method:'POST',
  headers:{'content-type':'application/zip','x-market-publisher':target,'idempotency-key':key},body});
 assert.equal((await upload(readerCookie)).status,403);
 const lost=await upload();assert.equal(lost.status,503);assert.deepEqual(await lost.json(),{error:'market-unavailable'});
 const repeated=await upload();assert.equal(repeated.status,201);const draft=await repeated.json();
 assert.match(draft.id,/^[a-f0-9]{32}$/u);assert.notEqual(draft.id,sha256);assert.equal(draft.sha256,sha256);
 assert.equal(draft.status,'draft');assert.equal(draft.revision,1);assert.equal(draft.bytes,bytes.length);
 const mine=await(await request('/api/market/v1/catalog?mine=true',{cookie:authorCookie})).json();assert.deepEqual(mine.items,[draft]);
 assert.deepEqual(await readdir(join(storage,'blobs')),[sha256+'.zip']);
 const changed=await upload(authorCookie,archive('2.0.0'));assert.equal(changed.status,409);await changed.arrayBuffer();
 const second=await json('/api/market/v1/publishers',adminCookie,{title:'Other Studio',accountId:author.id});
 const other=(await second.json()).id;const differentTeam=await upload(authorCookie,bytes,other);assert.equal(differentTeam.status,409);await differentTeam.arrayBuffer();
 assert.equal((await request('/api/market/v1/releases/'+draft.id,{cookie:readerCookie})).status,404);
 const reviewPath='/api/market/v1/releases/'+draft.id+'/review';
 const submitted=await json(reviewPath,authorCookie,{revision:1,action:'submit',note:''});
 assert.equal(submitted.status,503);await submitted.arrayBuffer();
 const pending=await(await request('/api/market/v1/releases/'+draft.id,{cookie:authorCookie})).json();
 assert.equal(pending.id,draft.id);assert.equal(pending.status,'pending');assert.equal(pending.revision,2);
 const stale=await json(reviewPath,authorCookie,{revision:1,action:'submit',note:''});assert.equal(stale.status,409);await stale.arrayBuffer();
 const forged=await request(reviewPath,{cookie:authorCookie,method:'POST',headers:{'content-type':'application/json',
  'x-muse-market-actor':Buffer.from(JSON.stringify({id:admin.id,username:'admin',admin:true})).toString('base64url')},
  body:JSON.stringify({revision:2,action:'approve',note:''})});assert.equal(forged.status,403);await forged.arrayBuffer();
 faults.review=true;
 const approved=await json(reviewPath,adminCookie,{revision:2,action:'approve',note:''});assert.equal(approved.status,503);await approved.arrayBuffer();
 const published=await(await request('/api/market/v1/releases/'+draft.id,{cookie:readerCookie})).json();
 assert.equal(published.id,draft.id);assert.equal(published.status,'published');assert.equal(published.revision,3);
 const repeatedReview=await json(reviewPath,adminCookie,{revision:2,action:'approve',note:''});assert.equal(repeatedReview.status,409);await repeatedReview.arrayBuffer();
 const publicRows=await(await request('/api/market/v1/catalog?q='+draft.id)).json();assert.deepEqual(publicRows.items,[published]);
 const downloaded=await request('/api/market/v1/releases/'+draft.id+'/download',{cookie:readerCookie});
 assert.equal(downloaded.status,200);assert.equal(downloaded.headers.get('x-content-sha256'),sha256);
 assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()),bytes);
 assert.equal((await request('/api/market/v1/releases/'+draft.id+'/download')).status,401);
 await accounts.setDisabled(reader.id,true);
 assert.equal((await request('/api/market/v1/releases/'+draft.id+'/download',{cookie:readerCookie})).status,401);
 assert.deepEqual(await readdir(join(storage,'blobs')),[sha256+'.zip']);assert.deepEqual(dropped,['upload','review','review']);assert.equal(tenants,0);
});

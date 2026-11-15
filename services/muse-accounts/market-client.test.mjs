/** Source HTTP owner: node --import tsx/esm --test services/muse-accounts/market-client.test.mjs. */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtemp,writeFile,rm,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Context} from '@deepseek-ai/cordis';
import WebServer from '../../packages/host/webserver/src/index.ts';
import * as CloudHost from '../../packages/host/muse-market/src/cloud-host.ts';
import * as protocol from '../../packages/host/muse-market/src/cloud-values.ts';
import {createMarketPackage} from '../../packages/host/muse-market/src/package.ts';
import {createMarketBrowserClient,createUploadAttempt,marketWebPolicy} from './market-client.js';
import {createMarketProxy} from './market-proxy.mjs';
import {createAccountServer} from './gateway.mjs';
import {openStore} from './store.mjs';

const listen=server=>new Promise(resolve=>server.listen(0,'127.0.0.1',()=>resolve('http://127.0.0.1:'+server.address().port)));
async function close(server){server.closeAllConnections();if(server.listening)await new Promise(resolve=>server.close(resolve));}
const limits={archiveBytes:1048576,expandedBytes:2097152,fileCount:32,recordBytes:1048576};
const manifest={name:'browser-scene-review',title:'Scene review',description:'Review an original scene.',version:'1.0.0',license:'MIT',category:'writing',examples:['Review this scene.'],requirements:['An original scene.'],formatVersion:1,kind:'skill',skills:[{name:'browser-scene-review',path:'skills/browser-scene-review/SKILL.md'}]};
const archive=()=>new Uint8Array(createMarketPackage(manifest,{'skills/browser-scene-review/SKILL.md':new TextEncoder().encode('---\nname: browser-scene-review\ndescription: Review an original scene.\n---\nKeep original dialogue.\n')},limits));

async function fixture(t){
 const root=await mkdtemp(join(tmpdir(),'muse-market-browser-client-')),ctx=new Context(),servers=[],clients=[],active=new Set(),seen=[],faults={},release=Promise.withResolvers(),entered=Promise.withResolvers();let proxy;
 t.after(async()=>{release.resolve();await Promise.all(clients.map(client=>client.close()));await proxy?.close();for(const request of active)request.destroy();for(const server of servers.reverse())await close(server);await ctx.fiber.dispose();await rm(root,{recursive:true,force:true});});
 const secretFile=join(root,'secret'),policyFile=join(root,'policy.json'),storage=join(root,'catalog');await writeFile(secretFile,'k'.repeat(48),{mode:0o600});
 await writeFile(policyFile,JSON.stringify({root:storage,secretFile,maxReleases:20,maxActiveUploads:4,jsonRequestBytes:4096,jsonResponseBytes:1048576,catalogLimit:100,limits}),{mode:0o600});
 await ctx.plugin(WebServer,{host:'127.0.0.1',port:0,compression:'none'}).await();await ctx.plugin(CloudHost,{policyFile}).await();const backend=new URL(ctx.webServer.getOrigin());
 const carrier=http.createServer(async(req,res)=>{
  seen.push({path:req.url,method:req.method,key:req.headers['idempotency-key'],expectedAccount:req.headers['x-muse-market-account']});
  if(faults.hold&&req.url.startsWith('/api/market/v1/catalog')){entered.resolve();await release.promise;if(res.destroyed)return;}
  if(faults.largeJson&&req.url.startsWith('/api/market/v1/catalog')){res.setHeader('content-type','application/json');res.end(JSON.stringify({items:[],padding:'x'.repeat(5000)}));return;}
  const request=http.request({hostname:backend.hostname,port:backend.port,path:req.url,method:req.method,headers:{...req.headers,host:backend.host},agent:false},response=>{
   const lost=req.method==='POST'&&req.url.endsWith('/uploads')&&response.statusCode===201&&faults.upload
    ||req.method==='POST'&&req.url.endsWith('/review')&&response.statusCode===200&&faults.review;
   if(lost){if(req.url.endsWith('/uploads'))faults.upload=false;else faults.review=false;response.resume();res.destroy();return;}
   const headers={...response.headers},download=req.url.endsWith('/download');
   if(download&&faults.download==='hash')headers['x-content-sha256']='0'.repeat(64);
   if(download&&faults.download==='append')delete headers['content-length'];
   res.writeHead(response.statusCode,headers);
   if(download&&faults.download==='append'){response.pipe(res,{end:false});response.once('end',()=>res.end('x'.repeat(1500)));}else response.pipe(res);
  });active.add(request);request.once('close',()=>active.delete(request));request.on('error',()=>res.destroy());req.on('aborted',()=>request.destroy());res.on('close',()=>request.destroy());req.pipe(request);
 });servers.push(carrier);const upstream=await listen(carrier),policy={upstream,secretFile,archiveBytes:limits.archiveBytes,jsonRequestBytes:4096,jsonResponseBytes:1048576,requestTimeoutMs:5000,requestRatePerMinute:1000};proxy=await createMarketProxy(policy);
 const accounts=await openStore(join(root,'accounts.json')),admin=await accounts.create('admin','pw',{admin:true}),author=await accounts.create('author','pw'),reader=await accounts.create('reader','pw');
 const server=http.createServer();servers.push(server);const origin=await listen(server);let tenants=0;
 createAccountServer({httpServer:server,store:accounts,market:proxy,publicOrigin:origin,workspaceMode:'desktop',runtime:{ensure:async()=>{tenants++;throw Error('No tenant is permitted');}}});
 const login=async username=>{const response=await fetch(origin+'/login',{method:'POST',headers:{origin},body:new URLSearchParams({username,password:'pw'}),redirect:'manual'});assert.equal(response.status,303);await response.arrayBuffer();return response.headers.get('set-cookie').split(';')[0];};
 const cookies={admin:await login('admin'),author:await login('author'),reader:await login('reader')};let cookie=cookies.author;
 const invited=await fetch(origin+'/api/market/v1/publishers',{method:'POST',headers:{origin,cookie:cookies.admin,'content-type':'application/json','x-muse-market-account':admin.id},body:JSON.stringify({title:'Writing team',accountId:author.id})});assert.equal(invited.status,201);const publisher=(await invited.json()).id;
 const makeClient=(overrides,onAccessLost=()=>{})=>{const client=createMarketBrowserClient({...Object.fromEntries(['archiveBytes','jsonRequestBytes','jsonResponseBytes','requestTimeoutMs'].map(key=>[key,policy[key]])),...overrides},protocol,{onAccessLost,fetcher:(path,options)=>fetch(origin+path,{...options,headers:{...options.headers,origin,cookie}})});clients.push(client);return client;};
 return {root,storage,seen,faults,release,entered,accounts,admin,author,reader,publisher,cookies,login,makeClient,setCookie:value=>{cookie=value;},tenantStarts:()=>tenants};
}

test('public browser policy admits only explicit transport budgets',()=>{
 const policy={archiveBytes:1024,jsonRequestBytes:4096,jsonResponseBytes:4096,requestTimeoutMs:5000};assert.deepEqual(marketWebPolicy(policy),policy);
 for(const value of [{...policy,upstream:'private'}, {...policy,jsonResponseBytes:0},{...policy,requestTimeoutMs:undefined}])assert.throws(()=>marketWebPolicy(value));
});

test('original selected bytes and key survive a lost reply, account switch and same-account relogin',async t=>{
 const f=await fixture(t),client=f.makeClient({jsonRequestBytes:1}),identity=await client.identity();assert.equal(identity.accountId,f.author.id);
 const selected=archive(),original=selected.slice(),attempt=await createUploadAttempt({bytes:selected,publisherId:f.publisher,accountId:identity.accountId,fileName:'selected.zip'});selected.fill(0);
 f.faults.upload=true;await assert.rejects(attempt.send(client,identity),error=>error.status===503);
 const before=f.seen.filter(row=>row.method==='POST'&&row.path.endsWith('/uploads')).length;assert.equal(before,1);
 await client.logout(identity.accountId);await assert.rejects(client.identity(),error=>error.status===401);
 f.setCookie(f.cookies.reader);const other=await client.identity();assert.equal(other.accountId,f.reader.id);
 await assert.rejects(attempt.send(client,other),error=>error.code==='account-changed');
 await assert.rejects(client.upload(original,f.publisher,attempt.key,identity.accountId),error=>error.code==='account-changed'&&error.status===409);
 assert.equal(f.seen.filter(row=>row.method==='POST'&&row.path.endsWith('/uploads')).length,before);
 f.setCookie(await f.login('author'));const same=await client.identity();assert.equal(same.accountId,identity.accountId);const draft=await attempt.send(client,same);
 assert.equal(draft.status,'draft');assert.equal(draft.sha256,attempt.facts.sha256);assert.equal(draft.bytes,original.length);
 assert.deepEqual((await client.catalog('',true)).map(item=>item.id),[draft.id]);assert.deepEqual(await readdir(join(f.storage,'blobs')),[draft.sha256+'.zip']);
 assert.deepEqual((await client.download(draft)).bytes,original);
 const uploads=f.seen.filter(row=>row.method==='POST'&&row.path.endsWith('/uploads'));assert.deepEqual(uploads.map(row=>row.key),[attempt.key,attempt.key]);assert.ok(uploads.every(row=>row.expectedAccount===undefined));assert.equal(f.tenantStarts(),0);
});

test('lost review replies read the original publication and never write a newer revision automatically',async t=>{
 const f=await fixture(t),client=f.makeClient(),identity=await client.identity(),attempt=await createUploadAttempt({bytes:archive(),publisherId:f.publisher,accountId:identity.accountId,fileName:'scene.zip'}),draft=await attempt.send(client,identity);
 f.faults.review=true;const pending=await client.review(draft,'submit','',identity.accountId);assert.equal(pending.id,draft.id);assert.equal(pending.revision,2);assert.equal(pending.status,'pending');
 assert.equal(f.seen.filter(row=>row.method==='POST'&&row.path.endsWith('/review')).length,1);
 await assert.rejects(client.review(draft,'submit','',identity.accountId),error=>error.status===409&&error.details.observed.revision===2);
 assert.equal(f.seen.filter(row=>row.method==='POST'&&row.path.endsWith('/review')).length,2);
 assert.equal((await client.getPublication(draft.id)).revision,2);
});

test('an account precondition refusal revokes authority without reading the original private publication',async t=>{
 const f=await fixture(t),lost=[],client=f.makeClient({},error=>lost.push(error.code)),identity=await client.identity();
 const attempt=await createUploadAttempt({bytes:archive(),publisherId:f.publisher,accountId:identity.accountId,fileName:'scene.zip'}),draft=await attempt.send(client,identity);
 f.setCookie(f.cookies.reader);
 await assert.rejects(client.review(draft,'submit','',identity.accountId),error=>error.code==='account-changed'&&error.status===409);
 assert.equal(f.seen.filter(row=>row.method==='POST'&&row.path.endsWith('/review')).length,0);
 assert.equal(f.seen.filter(row=>row.method==='GET'&&row.path==='/api/market/v1/releases/'+draft.id).length,0);
 assert.deepEqual(lost,['account-changed']);assert.equal((await client.identity()).accountId,f.reader.id);
});

test('corrupt downloads and over-budget bodies fail before bytes can be saved',async t=>{
 const f=await fixture(t),client=f.makeClient({archiveBytes:1024,jsonResponseBytes:4096}),identity=await client.identity(),attempt=await createUploadAttempt({bytes:archive(),publisherId:f.publisher,accountId:identity.accountId,fileName:'scene.zip'}),draft=await attempt.send(client,identity);
 f.faults.download='hash';await assert.rejects(client.download(draft),error=>error.code==='archive-mismatch');
 f.faults.download='append';await assert.rejects(client.download(draft),error=>error.code==='response-too-large');
 f.faults.largeJson=true;await assert.rejects(client.catalog('',false),error=>error.code==='response-too-large');
 assert.equal((await readdir(join(f.storage,'blobs'))).length,1);
});

test('close aborts an entered HTTP read and awaits its response-reader cleanup',async t=>{
 const f=await fixture(t),client=f.makeClient();f.faults.hold=true;
 const read=client.catalog('',false),rejected=assert.rejects(read);await f.entered.promise;
 const first=client.close(),second=client.close();assert.equal(first,second);await first;await rejected;f.release.resolve();
 await assert.rejects(client.catalog('',false));
});

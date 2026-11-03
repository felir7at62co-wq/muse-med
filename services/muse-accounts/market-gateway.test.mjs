import {test} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openStore} from './store.mjs';
import {createAccountServer} from './gateway.mjs';
import {createMarketProxy} from './market-proxy.mjs';
import {loadMarket} from './market.mjs';

const listen=server=>new Promise(resolve=>server.listen(0,'127.0.0.1',()=>resolve(`http://127.0.0.1:${server.address().port}`)));
const close=server=>new Promise((resolve,reject)=>{if(!server?.listening){resolve();return;}server.close(error=>error?reject(error):resolve());server.closeAllConnections();});

test('market routes stay independent from Desktop startup and bind only validated account identity',async t=>{
 const root=await mkdtemp(join(tmpdir(),'market-gateway-')),servers=[];t.after(async()=>{for(const server of servers.reverse())await close(server);await rm(root,{recursive:true,force:true});});
 const store=await openStore(join(root,'accounts.json')),admin=await store.create('admin','pw',{admin:true}),author=await store.create('author','pw');
 const calls=[];let tenantStarts=0;
 const market={handle:async(req,res,actor,prepared)=>{calls.push({url:req.url,method:req.method,actor,body:prepared?.toString('utf8')});res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({ok:true,actor:actor?.id??null}));}};
 const origin='https://muse.test',server=createAccountServer({store,market,workspaceMode:'desktop',publicOrigin:origin,runtime:{ensure:async()=>{tenantStarts++;throw Error('market must not start a tenant');}}});servers.push(server);const base=await listen(server);
 const request=(path,options={})=>fetch(base+path,{redirect:'manual',...options});
 const login=async username=>(await request('/login',{method:'POST',headers:{origin},body:new URLSearchParams({username,password:'pw'})})).headers.get('set-cookie').split(';')[0];
 const adminCookie=await login('admin'),authorCookie=await login('author');
 const page=await request('/market');assert.equal(page.status,200);assert.match(await page.text(),/Bot 与 Skills 市场/);assert.match(page.headers.get('content-security-policy'),/script-src 'self'/);
 assert.equal((await request('/market/client.js')).status,200);assert.equal((await request('/market/style.css')).status,200);assert.equal((await request('/market/missing')).status,404);
 assert.deepEqual(await(await request('/api/market/v1/catalog')).json(),{ok:true,actor:null});assert.equal(calls.at(-1).actor,null);
 assert.deepEqual(await(await request('/api/market/v1/me',{headers:{cookie:authorCookie}})).json(),{ok:true,actor:author.id});assert.equal(calls.at(-1).actor.username,'author');assert.equal(calls.at(-1).actor.admin,false);
 const count=calls.length;assert.equal((await request('/api/market/v1/publishers',{method:'POST',headers:{origin:'https://evil.test',cookie:adminCookie},body:'{}'})).status,403);assert.equal(calls.length,count);
 assert.equal((await request('/api/market/v1/publishers',{method:'POST',headers:{origin,cookie:authorCookie},body:'{}'})).status,403);assert.equal(calls.length,count);
 assert.equal((await request('/api/market/v1/publishers',{method:'POST',headers:{origin,cookie:adminCookie},body:JSON.stringify({title:'missing',accountId:'f'.repeat(16)})})).status,400);assert.equal(calls.length,count);
 const invitation=JSON.stringify({title:'Studio',accountId:author.id}),published=await request('/api/market/v1/publishers',{method:'POST',headers:{origin,cookie:adminCookie,'content-type':'application/json'},body:invitation});assert.equal(published.status,200);assert.equal(calls.at(-1).actor.id,admin.id);assert.equal(calls.at(-1).body,invitation);
 await store.setDisabled(author.id,true);assert.equal((await request('/api/market/v1/publishers',{method:'POST',headers:{origin,cookie:adminCookie},body:invitation})).status,400);
 assert.equal(tenantStarts,0);
 const disabled=createAccountServer({store,workspaceMode:'desktop',publicOrigin:origin});servers.push(disabled);const disabledBase=await listen(disabled);assert.equal((await fetch(disabledBase+'/market',{redirect:'manual'})).status,404);
});

test('market proxy is loopback-only, bounded and strips browser authority headers',async t=>{
 const root=await mkdtemp(join(tmpdir(),'market-proxy-')),servers=[];let market;t.after(async()=>{await market?.close();for(const server of servers.reverse())await close(server);await rm(root,{recursive:true,force:true});});
 const secret='a'.repeat(48),secretFile=join(root,'secret');await writeFile(secretFile,secret,{mode:0o600});
 const seen=[];const upstream=http.createServer(async(req,res)=>{const chunks=[];try{for await(const chunk of req)chunks.push(chunk);}catch{return;}seen.push({url:req.url,method:req.method,headers:req.headers,body:Buffer.concat(chunks)});res.writeHead(200,{'content-type':'application/json','set-cookie':'market=private','x-content-sha256':'abc'});res.end(JSON.stringify({ok:true}));});servers.push(upstream);const upstreamUrl=await listen(upstream);
 assert.equal(await loadMarket({}),undefined);
 await assert.rejects(createMarketProxy({upstream:'https://127.0.0.1/',secretFile,archiveBytes:1024,requestTimeoutMs:5000}),/Invalid market proxy policy/);
 const policyFile=join(root,'policy.json');await writeFile(policyFile,JSON.stringify({upstream:upstreamUrl,secretFile,archiveBytes:1024,requestTimeoutMs:5000}),{mode:0o600});market=await loadMarket({MUSE_MARKET_CONFIG:policyFile});
 const actor={id:'0123456789abcdef',username:'author',admin:false,passwordHash:'must-not-leave'};
 const gateway=http.createServer((req,res)=>market.handle(req,res,actor));servers.push(gateway);const base=await listen(gateway);
 const response=await fetch(base+'/api/market/v1/catalog?q=test',{headers:{authorization:'Bearer browser','x-muse-market-actor':'forged',cookie:'session=private','content-type':'application/json'}});assert.equal(response.status,200);assert.deepEqual(await response.json(),{ok:true});assert.equal(response.headers.get('set-cookie'),null);assert.equal(response.headers.get('x-content-sha256'),'abc');
 const forwarded=seen.at(-1);assert.equal(forwarded.url,'/api/market/v1/catalog?q=test');assert.equal(forwarded.headers.authorization,'Bearer '+secret);assert.equal(forwarded.headers.cookie,undefined);const identity=JSON.parse(Buffer.from(forwarded.headers['x-muse-market-actor'],'base64url').toString('utf8'));assert.deepEqual(identity,{id:actor.id,username:actor.username,admin:false});assert.doesNotMatch(JSON.stringify(identity),/password/i);
 const valid=await fetch(base+'/api/market/v1/uploads',{method:'POST',headers:{'content-type':'application/zip','x-market-publisher':'studio','idempotency-key':'upload-1'},body:Buffer.alloc(1024)});assert.equal(valid.status,200);assert.equal(seen.at(-1).body.byteLength,1024);assert.equal(seen.at(-1).headers['x-market-publisher'],'studio');assert.equal(seen.at(-1).headers['idempotency-key'],'upload-1');
 const oversized=await fetch(base+'/api/market/v1/uploads',{method:'POST',headers:{'content-type':'application/zip'},body:Buffer.alloc(1025)});assert.equal(oversized.status,413);assert.deepEqual(await oversized.json(),{error:'request-too-large'});
 const oversizedJson=await fetch(base+'/api/market/v1/review',{method:'POST',headers:{'content-type':'application/json'},body:Buffer.alloc(16385)});assert.equal(oversizedJson.status,413);assert.deepEqual(await oversizedJson.json(),{error:'request-too-large'});
 await market.close();assert.equal((await fetch(base+'/api/market/v1/catalog')).status,503);
});

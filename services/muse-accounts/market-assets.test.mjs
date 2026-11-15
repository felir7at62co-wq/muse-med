/** Real gateway delivery of the independent market document and its public assets. */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createMarketProxy} from './market-proxy.mjs';
import {createAccountServer} from './gateway.mjs';
import {openStore} from './store.mjs';

const listen=server=>new Promise(resolve=>server.listen(0,'127.0.0.1',()=>resolve('http://127.0.0.1:'+server.address().port)));
async function close(server){server.closeAllConnections();if(server.listening)await new Promise(resolve=>server.close(resolve));}
test('market assets are same-origin, credential-free and bounded by the active proxy policy',async t=>{
 const root=await mkdtemp(join(tmpdir(),'muse-market-assets-')),servers=[];let market;let upstreamRequests=0;
 t.after(async()=>{await market?.close();for(const server of servers.reverse())await close(server);await rm(root,{recursive:true,force:true});});
 const upstream=http.createServer((_req,res)=>{upstreamRequests++;res.end('{}');});servers.push(upstream);const target=await listen(upstream),secretFile=join(root,'secret');await writeFile(secretFile,'r'.repeat(48),{mode:0o600});
 const policy={upstream:target,secretFile,archiveBytes:1024,jsonRequestBytes:2048,jsonResponseBytes:4096,requestTimeoutMs:5000,requestRatePerMinute:1000};market=await createMarketProxy(policy);
 const store=await openStore(join(root,'accounts.json')),server=createAccountServer({store,market,workspaceMode:'desktop',runtime:{ensure:async()=>{throw Error('Assets must not start a tenant');}}});servers.push(server);const origin=await listen(server);
 const request=(path,options)=>fetch(origin+path,{redirect:'manual',...options});
 const page=await request('/market');assert.equal(page.status,200);const html=await page.text();assert.match(html,/<script type="module" src="\/market\/client\.js"><\/script>/u);assert.match(html,/<link rel="stylesheet" href="\/market\/style\.css">/u);assert.match(page.headers.get('content-security-policy'),/script-src 'self'/u);assert.doesNotMatch(html,/<script[^>]*>[^<]+/u);
 for(const[id]of [['market-language'],['market-theme'],['catalog-search'],['catalog-list'],['publisher-select'],['archive-input'],['upload-retry'],['draft-result']])assert.ok(html.includes('id="'+id+'"'));
 for(const[path,file,type]of [['/market/client.js','market-client.js','text/javascript'],['/market/style.css','market.css','text/css']]){
  const response=await request(path);assert.equal(response.status,200);assert.ok(response.headers.get('content-type').startsWith(type));assert.equal(await response.text(),await readFile(new URL('./'+file,import.meta.url),'utf8'));assert.equal(response.headers.get('x-content-type-options'),'nosniff');
  const head=await request(path,{method:'HEAD'});assert.equal(head.status,200);assert.equal(await head.text(),'');
 }
 const config=await request('/market/config.json');assert.equal(config.status,200);assert.deepEqual(await config.json(),{archiveBytes:1024,jsonRequestBytes:2048,jsonResponseBytes:4096,requestTimeoutMs:5000});
 const css=await readFile(new URL('./market.css',import.meta.url),'utf8');assert.match(css,/data-theme=dark/u);assert.match(css,/data-theme=light/u);assert.doesNotMatch(css,/font-weight:\s*(?:[6-9]00|bold)/u);assert.match(css,/prefers-reduced-motion/u);
 assert.equal((await request('/market/missing.js')).status,404);assert.equal(upstreamRequests,0);
});

test('unconfigured gateways expose neither market UI assets nor public policy',async t=>{
 const root=await mkdtemp(join(tmpdir(),'muse-market-assets-disabled-')),store=await openStore(join(root,'accounts.json'));
 const server=createAccountServer({store,workspaceMode:'desktop'});t.after(async()=>{await close(server);await rm(root,{recursive:true,force:true});});const origin=await listen(server);
 for(const path of ['/market','/market/client.js','/market/style.css','/market/protocol.js','/market/config.json'])assert.equal((await fetch(origin+path,{redirect:'manual'})).status,404);
});

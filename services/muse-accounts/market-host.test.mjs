import {test} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtemp,mkdir,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Context} from '../../vendor/cordis/lib/index.js';
import Loader from '../../vendor/loader/lib/index.js';
import Group from '../../vendor/group/lib/index.js';
import Llm from '../../packages/llm/llm/lib/index.js';
import Sessions,{SessionId} from '../../packages/core/session/lib/index.js';
import Projections from '../../packages/session/session-projection/lib/index.js';
import Tools from '../../packages/core/tools/lib/index.js';
import Agents from '../../packages/core/agent/lib/index.js';
import AgentLoop from '../../packages/core/agent-loop/lib/index.js';
import SystemPrompt from '../../packages/core/system-prompt/lib/index.js';
import Presets from '../../packages/preset/agent-preset-registry/lib/index.js';
import Skills from '../../packages/skill/skill/lib/index.js';
import MuseMarket from '../../packages/host/muse-market/lib/index.js';
import * as CloudHost from '../../packages/host/muse-market/lib/cloud-host.js';
import {WebServer} from '../../packages/host/webserver/lib/index.js';
import {bindMarketPortrait} from '../../packages/host/muse-market/lib/format.js';
import {marketDigest} from '../../packages/host/muse-market/lib/package.js';
import {writeMuseSession} from '../../packages/host/muse-account/lib/types/session.js';
import {createMarketBrowserClient,marketWebConfig} from '../../apps/market-web/lib/types/api.js';
import {openStore} from './store.mjs';
import {createAccountServer} from './gateway.mjs';
import {createMarketProxy} from './market-proxy.mjs';

const listen=server=>new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',()=>{server.off('error',reject);resolve('http://127.0.0.1:'+server.address().port);});});
const close=server=>new Promise((resolve,reject)=>{if(!server?.listening){resolve();return;}server.close(error=>error?reject(error):resolve());server.closeAllConnections();});

test('browser publishes a Skill through review and a reader installs and reuses it in Muse Host',async t=>{
 const root=await mkdtemp(join(tmpdir(),'muse-market-host-http-'));let cloud,native,proxy,browser,gateway,front;
 t.after(async()=>{try{await browser?.close();await native?.fiber.dispose();await close(front);await close(gateway);}finally{try{await proxy?.close();await cloud?.fiber.dispose();}finally{await rm(root,{recursive:true,force:true});}}});
 const allowedPlugins=['@deepseek-ai/dsh-persona','@deepseek-ai/dsh-tool-skill'];
 const limits={archiveBytes:1048576,expandedBytes:4194304,fileCount:64};
 const policy=join(root,'policy.json'),secret=join(root,'secret');await writeFile(secret,'s'.repeat(48),{mode:0o600});
 await writeFile(policy,JSON.stringify({root:join(root,'cloud'),secretFile:secret,limits,allowedPlugins,maxReleases:10,maxActiveUploads:2}),{mode:0o600});
 cloud=new Context();await cloud.plugin(WebServer,{host:'127.0.0.1',port:0});await cloud.plugin(CloudHost,{policyFile:policy});
 proxy=await createMarketProxy({upstream:'http://127.0.0.1:'+cloud.webServer.port,secretFile:secret,archiveBytes:limits.archiveBytes,requestTimeoutMs:5000});
 let gatewayPort;
 front=http.createServer((req,res)=>{
  if(!gatewayPort){res.writeHead(503);res.end();return;}
  const call=http.request({hostname:'127.0.0.1',port:gatewayPort,path:req.url,method:req.method,headers:req.headers},reply=>{res.writeHead(reply.statusCode,reply.headers);reply.pipe(res);});
  call.on('error',()=>{if(!res.headersSent)res.writeHead(502);res.end();});res.once('close',()=>call.destroy());req.pipe(call);
 });
 const base=await listen(front),store=await openStore(join(root,'accounts.json'));let tenantStarts=0;
 await store.create('fixture-admin','fixture',{admin:true});const author=await store.create('fixture-author','fixture');
 gateway=createAccountServer({store,publicOrigin:base,market:proxy,workspaceMode:'desktop',runtime:{ensure:async()=>{tenantStarts++;throw Error('Market must not start a cloud tenant');}}});
 await listen(gateway);gatewayPort=gateway.address().port;
 const login=async username=>{const response=await fetch(base+'/login',{method:'POST',headers:{origin:base},body:new URLSearchParams({username,password:'fixture'}),redirect:'manual'});assert.equal(response.status,303);return response.headers.get('set-cookie').split(';')[0];};
 await store.create('fixture-reader','fixture');
 const adminCookie=await login('fixture-admin'),authorCookie=await login('fixture-author'),readerCookie=await login('fixture-reader');
 const admission=await fetch(base+'/api/market/v1/publishers',{method:'POST',headers:{origin:base,cookie:adminCookie,'content-type':'application/json'},body:JSON.stringify({title:'Host integration fixture',accountId:author.id})});assert.equal(admission.status,201);const publisherId=(await admission.json()).id;
 const wire=(url,options={})=>fetch(base+url,{...options,headers:{...Object.fromEntries(new Headers(options.headers)),origin:base,cookie:authorCookie}});
 browser=createMarketBrowserClient(marketWebConfig({limits,allowedPlugins,requestTimeoutMs:5000,metadataBytes:1048576}),wire);
 assert.equal((await browser.actions.identity()).publishers[0].id,publisherId);
 const releases=[],archives=[];
 for(const name of ['storyboard-starter']){
  const bytes=new Uint8Array(await readFile(new URL('../../packages/host/muse-market/tests/fixtures/handoff/'+name+'-1.0.0.zip',import.meta.url)));
  assert.equal((await browser.actions.previewArchive(bytes)).name,name);
  const portrait='storyboard-reviewer';
  const release=await browser.actions.uploadArchive(bytes,publisherId,'browser-host-'+name,portrait);
  assert.equal(release.status,'draft');assert.equal(release.manifest.presetPortrait,portrait);
  const expected=bindMarketPortrait(bytes,portrait,limits,allowedPlugins);
  assert.equal(marketDigest((await browser.actions.downloadArchive(release)).bytes),marketDigest(expected));releases.push(release);archives.push(expected);
 }
 const reader=createMarketBrowserClient(marketWebConfig({limits,allowedPlugins,requestTimeoutMs:5000,metadataBytes:1048576}),
  (url,options={})=>fetch(base+url,{...options,headers:{...Object.fromEntries(new Headers(options.headers)),origin:base,cookie:readerCookie}}));
 t.after(()=>reader.close());
 assert.deepEqual(await reader.actions.catalog('','',false),[]);
 for(const [index,draft] of releases.entries()){
  assert.equal((await fetch(base+'/api/market/v1/releases/'+draft.id+'/download',{headers:{cookie:readerCookie}})).status,404);
  const review=async (cookie,action,revision)=>{
   const response=await fetch(base+'/api/market/v1/releases/'+draft.id+'/review',{
    method:'POST',headers:{origin:base,cookie,'content-type':'application/json'},body:JSON.stringify({action,revision})});
   assert.equal(response.status,200);
   return await response.json();
  };
  const pending=await review(authorCookie,'submit',draft.revision);assert.equal(pending.status,'pending');
  const published=await review(adminCookie,'approve',pending.revision);assert.equal(published.status,'published');
  releases[index]=published;
 }
 const visible=await reader.actions.catalog('','',false);
 assert.deepEqual(visible.map(row=>row.id).sort(),releases.map(row=>row.id).sort());
 assert.equal(visible[0]?.manifest.presetPortrait,'storyboard-reviewer');
 const accountHome=join(root,'account'),marketRoot=join(root,'local');await mkdir(accountHome);await writeMuseSession(join(accountHome,'session.json'),{baseUrl:base,cookie:readerCookie,username:'fixture-reader'});
 const boot=async()=>{
  const ctx=new Context();await ctx.plugin(Loader);ctx.loader.builtins.group=Group;
  for(const plugin of [Llm,Sessions,Projections,Tools,Agents,Skills])await ctx.plugin(plugin);
  await ctx.plugin(SystemPrompt,{personaPrefix:''});await ctx.plugin(AgentLoop,{agents:[]});
  await ctx.plugin(Presets,{default:'standard',selectablePresets:['standard']});await ctx.agentPresets.register({id:'standard',plugins:[]});
  await ctx.plugin(MuseMarket,{baseUrl:base,root:marketRoot,accountHome,requestTimeoutMs:5000,...limits,allowedPlugins});return ctx;
 };
 native=await boot();assert.equal((await native.museMarket.catalog('','',false)).length,1);
 const local=[];
 for(const [index,release]of releases.entries()){
  const item=await native.museMarket.install(release.id);assert.equal(item.enabled,false);assert.equal(item.release.sha256,release.sha256);assert.equal(item.release.id,release.id);
  const imported=await native.museMarket.importPackage(Buffer.from((await reader.actions.downloadArchive(release)).bytes).toString('base64'));assert.deepEqual(imported,item);
  assert.equal(marketDigest(Buffer.from((await native.museMarket.exportPackage(item.release.id)).base64,'base64')),marketDigest(archives[index]));
  assert.equal((await native.museMarket.enable(item.release.id,true)).enabled,true);local.push(item);
 }
 const preset='standard';
 assert.equal((await native.agentPresets.resolveForCreation(preset)).id,preset);
 const created=await native.agents.create({sessionId:SessionId('http-installed-skill'),setup:async scope=>{await native.agentPresets.mount(scope,preset);}});
 const definition=await native.skills.get('storyboard-starter',{scope:created.agent});assert.ok(definition?.content);assert.equal(definition.source,'muse-market');
 await native.fiber.dispose();native=undefined;native=await boot();
 const restored=await native.museMarket.installed();assert.equal(restored.length,1);assert.ok(restored.every(row=>row.enabled));assert.deepEqual(restored.map(row=>row.release.id).sort(),local.map(row=>row.release.id).sort());
 assert.equal((await native.agentPresets.resolveForCreation(preset)).id,preset);
 const resumed=await native.agents.create({sessionId:SessionId('http-installed-skill'),setup:async scope=>{await native.agentPresets.mount(scope,preset);}});
 assert.equal((await native.skills.get('storyboard-starter',{scope:resumed.agent}))?.content,definition.content);
 assert.equal(tenantStarts,0);
});

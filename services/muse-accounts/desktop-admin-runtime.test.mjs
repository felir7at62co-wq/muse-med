/** Desktop routing with explicit administrator access through the lazy runtime broker. */
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {once} from 'node:events';
import {cp,mkdtemp,rm,symlink,unlink,writeFile} from 'node:fs/promises';
import http from 'node:http';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {applyBridgeDesktopCompatibility} from '../../third_party/plugins/compatibility/bridge-desktop.mjs';
import {openAdminAccess} from './admin-access.mjs';
import {createAccountServer} from './gateway.mjs';
import {createRuntime} from './runtime.mjs';
import {openStore} from './store.mjs';
import {test} from 'node:test';

const repository=fileURLToPath(new URL('../../',import.meta.url));
async function listen(server,address='127.0.0.1') {
 server.listen(address==='127.0.0.1'?0:address,...(address==='127.0.0.1'?[address]:[]));
 await once(server,'listening');
 return address==='127.0.0.1'?`http://127.0.0.1:${server.address().port}`:address;
}

for(const launch of ['factory','executable'])test(`desktop ${launch} preserves elevated administrator access and account-bound desktops`,{timeout:30000},async t=>{
 const root=await mkdtemp(join(tmpdir(),'muse-desktop-admin-')),servers=[],tunnels=[];
 let child,childClosed,pluginLinked=false;
 const previousSocket=process.env.MUSE_RUNTIME_SOCKET;
 t.after(async()=>{
  const disposed=await Promise.allSettled(tunnels.map(tunnel=>tunnel.stop()));
  if(child&&child.exitCode===null&&child.signalCode===null)child.kill();
  disposed.push(...await Promise.allSettled([
   ...(child?[childClosed]:[]),
   ...servers.map(async server=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}),
  ]));
  if(previousSocket===undefined)delete process.env.MUSE_RUNTIME_SOCKET;else process.env.MUSE_RUNTIME_SOCKET=previousSocket;
  if(pluginLinked)await unlink(join(root,'plugin/node_modules'));
  await rm(root,{recursive:true,force:true});
  const failures=disposed.filter(result=>result.status==='rejected').map(result=>result.reason);
  if(failures.length)throw new AggregateError(failures,'Desktop administrator fixture disposal failed');
 });
 const accountFile=join(root,'accounts.json'),store=await openStore(accountFile);
 await store.create('ylk','pw',{admin:true});const alice=await store.create('alice','pw'),bob=await store.create('bob','pw');
 const adminRoot=join(root,'admin'),adminAccess=await openAdminAccess(adminRoot);
 await adminAccess.configure('test-elevation-password');
 const nativeRequests=[],upstream=http.createServer((req,res)=>{
  if(req.url==='/bootstrap'){res.setHeader('set-cookie','native=admin-private');res.end();return;}
  nativeRequests.push({url:req.url,cookie:req.headers.cookie,authorization:req.headers.authorization});
  res.setHeader('content-type','application/json');res.end(JSON.stringify({owner:alice.id,kind:'administrator-runtime'}));
 });servers.push(upstream);
 const upstreamUrl=await listen(upstream),bootstrapPath=join(root,'bootstrap');await writeFile(bootstrapPath,upstreamUrl+'/bootstrap');
 const starts=[],broker=http.createServer((req,res)=>{
  const url=new URL(req.url,'http://broker');
  if(url.pathname==='/ensure')starts.push(url.searchParams.get('id'));
  res.setHeader('content-type','application/json');res.end(JSON.stringify(url.pathname==='/ensure'?{upstream:upstreamUrl,bootstrapPath}:{}));
 });servers.push(broker);
 const socketPath=process.platform==='win32'?`\\\\.\\pipe\\muse-desktop-admin-${randomUUID()}`:join(root,'broker.sock');
 await listen(broker,socketPath);
 const origin='https://muse.test',touches=[];let base;
 if(launch==='factory'){
  process.env.MUSE_RUNTIME_SOCKET=socketPath;
  const runtime=createRuntime(),touch=runtime.touch;runtime.touch=id=>{touches.push(id);return touch(id);};
  const server=createAccountServer({store,runtime,workspaceMode:'desktop',adminAccess,publicOrigin:origin});servers.push(server);base=await listen(server);
 }else{
  const preload=join(root,'listening.mjs');
  await writeFile(preload,"import http from 'node:http'; const listen=http.Server.prototype.listen; http.Server.prototype.listen=function(...args){this.once('listening',()=>process.send({port:this.address().port}));return listen.apply(this,args);};\n");
  const environment={...process.env};for(const name of Object.keys(environment))if(name.startsWith('MUSE_'))delete environment[name];
  Object.assign(environment,{MUSE_PORT:'0',MUSE_ACCOUNTS_FILE:accountFile,MUSE_PUBLIC_ORIGIN:origin,MUSE_WORKSPACE_MODE:'desktop',MUSE_ADMIN_ROOT:adminRoot,MUSE_RUNTIME_SOCKET:socketPath});
  child=spawn(process.execPath,['--import',pathToFileURL(preload).href,fileURLToPath(new URL('./gateway.mjs',import.meta.url))],{env:environment,stdio:['ignore','ignore','pipe','ipc']});
  childClosed=once(child,'close');let stderr='';child.stderr.on('data',chunk=>{stderr=(stderr+chunk).slice(-2000);});
  const [message]=await Promise.race([once(child,'message',{signal:AbortSignal.timeout(10000)}),childClosed.then(([code,signal])=>{throw Error(`Gateway exited before listening: ${code}/${signal}: ${stderr}`);})]);
  assert.ok(Number.isInteger(message.port)&&message.port>0);base=`http://127.0.0.1:${message.port}`;
 }
 const login=async username=>{
  const response=await fetch(base+'/login',{method:'POST',headers:{origin},body:new URLSearchParams({username,password:'pw'}),redirect:'manual'});
  assert.equal(response.status,303);return response.headers.get('set-cookie').split(';')[0];
 };
 const ac=await login('alice'),bc=await login('bob'),administrator=await login('ylk');
 const request=(path,cookie,{method='GET',body}={})=>fetch(base+path,{method,headers:{origin,cookie},body:body&&new URLSearchParams(body),redirect:'manual'});
 assert.match(await(await request('/',ac)).text(),/您的电脑上的 Muse 未启动/);
 assert.deepEqual(starts,[]);assert.deepEqual(touches,[]);
 assert.equal((await request('/admin/control/open',administrator,{method:'POST',body:{target:alice.id}})).status,403);
 assert.equal((await request('/admin/control/unlock',ac,{method:'POST',body:{password:'test-elevation-password'}})).status,403);
 assert.equal((await request('/admin/control/unlock',administrator,{method:'POST',body:{password:'test-elevation-password'}})).status,303);
 const opened=await request('/admin/control/open',administrator,{method:'POST',body:{target:alice.id}});assert.equal(opened.status,303);
 const grant=new URL(opened.headers.get('location'),base).searchParams.get('muse_admin');assert.ok(grant);
 assert.equal((await request('/api/session/list?muse_admin='+grant,ac)).status,403);assert.deepEqual(starts,[]);
 const authorized=await request('/api/session/list?muse_admin='+grant,administrator);
 assert.equal(authorized.status,200);assert.deepEqual(await authorized.json(),{owner:alice.id,kind:'administrator-runtime'});
 assert.deepEqual(starts,[alice.id]);assert.deepEqual(nativeRequests,[{url:'/api/session/list',cookie:'native=admin-private',authorization:undefined}]);
 const plugin=join(root,'plugin');await cp(join(repository,'third_party/plugins/dsh-bridge'),plugin,{recursive:true});applyBridgeDesktopCompatibility(plugin);
 await symlink(join(repository,'third_party/plugins/toolchain/node_modules'),join(plugin,'node_modules'),process.platform==='win32'?'junction':'dir');pluginLinked=true;
 const {createMuseDesktopTunnel}=await import(pathToFileURL(join(plugin,'lib/muse-desktop-tunnel.mjs')).href);
 for(const [account,cookie]of [[alice,ac],[bob,bc]]){
  const host=http.createServer((req,res)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify({owner:account.id,cookie:req.headers.cookie,origin:req.headers.origin}));});servers.push(host);await listen(host);
  const tunnel=createMuseDesktopTunnel({serverUrl:base.replace('http:','ws:')+'/api/desktop/connect',headers:{cookie,origin},localPort:host.address().port,loopbackCookie:'desktop='+account.id,deviceId:randomUUID(),chunkBytes:32768,ackTimeoutMs:5000,reconnectMaxIntervalMs:1000});tunnels.push(tunnel);await tunnel.start();
  const result=await(await request('/api/session/list?accountId='+bob.id,cookie)).json();assert.equal(result.owner,account.id);assert.equal(result.cookie,'desktop='+account.id);assert.equal(result.origin,`http://127.0.0.1:${host.address().port}`);
 }
 const stillAuthorized=await request('/api/session/list?muse_admin='+grant,administrator);assert.equal(stillAuthorized.status,200);assert.equal((await stillAuthorized.json()).kind,'administrator-runtime');
 assert.deepEqual(starts,[alice.id]);
 assert.equal((await request('/api/session/list?muse_admin='+grant,bc)).status,403);
 assert.equal((await request('/logout',administrator,{method:'POST'})).status,303);
 const replacement=await login('ylk');assert.equal((await request('/api/session/list?muse_admin='+grant,replacement)).status,403);
 assert.equal((await(await request('/api/session/list',ac)).json()).owner,alice.id);assert.deepEqual(starts,[alice.id]);
 assert.ok(touches.every(id=>id===alice.id));
});

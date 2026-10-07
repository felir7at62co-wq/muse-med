import {test} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import {mkdtemp,writeFile,rm,symlink} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {openStore} from './store.mjs';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const listen=s=>new Promise(r=>s.listen(0,'127.0.0.1',()=>r(`http://127.0.0.1:${s.address().port}`)));
test('native built-in DeepSeek settings are global and never written to a tenant',async t=>{
 const {createAccountServer}=await import('./gateway.mjs'),{openGlobalModels}=await import('./global-models.mjs');
 const dir=await mkdtemp(join(tmpdir(),'muse-official-rpc-'));t.after(()=>rm(dir,{recursive:true,force:true}));const store=await openStore(join(dir,'accounts'));await store.create('admin','pw',{admin:true});await store.create('editor','pw');
 const globalModels=await openGlobalModels(join(dir,'models'),{official:{schema:{type:'object'},defaults:{baseURL:'https://api.deepseek.com',protocol:'chat-completions',apiKeyEnv:'DEEPSEEK_API_KEY',maxTokens:100,defaultContextWindow:1000,models:[{id:'flash'}]}}});
 let tenantWrites=0;const origin='https://muse.test',server=createAccountServer({store,globalModels,runtime:{ensure:async()=>{tenantWrites++;throw Error('tenant must not own model writes');}},publicOrigin:origin});const base=await listen(server);t.after(()=>new Promise(r=>server.close(r)));
 const login=async username=>(await fetch(base+'/login',{method:'POST',headers:{origin},body:new URLSearchParams({username,password:'pw'}),redirect:'manual'})).headers.get('set-cookie').split(';')[0];
 const cookie=await login('admin');const method='settings/mutate',args={ns:'llm-deepseek',expectedRevision:0,ops:[{op:'set',path:['baseURL'],value:'https://example.com/v1'}]};
 const call=token=>fetch(base+'/api/'+method,{method:'POST',headers:{origin,cookie:token},body:JSON.stringify({type:'client-request',rpcId:1,method,payload:{args}})});
 assert.equal((await call(await login('editor'))).status,403);
 const response=await call(cookie);assert.equal(response.status,200);assert.equal((await response.json()).result.ok,true);assert.equal(tenantWrites,0);
 assert.equal(globalModels.resolve('deepseek-official','flash').baseURL,'https://example.com/v1');
});
test('native model RPC uses admin-only global settings and redacted credentials with revision fencing',async t=>{
 const {createAccountServer}=await import('./gateway.mjs'),{openGlobalModels}=await import('./global-models.mjs');const dir=await mkdtemp(join(tmpdir(),'muse-native-'));t.after(()=>rm(dir,{recursive:true,force:true}));const store=await openStore(join(dir,'accounts'));await store.create('admin','pw',{admin:true});await store.create('editor','pw');const globalModels=await openGlobalModels(join(dir,'native'),{schema:{type:'object'}}),origin='https://muse.test';
 const server=createAccountServer({store,globalModels,runtime:{ensure:async()=>{throw Error('No tenant needed');}},publicOrigin:origin});const base=await listen(server);t.after(()=>new Promise(r=>server.close(r)));
 const login=async username=>(await fetch(base+'/login',{method:'POST',headers:{origin},body:new URLSearchParams({username,password:'pw'}),redirect:'manual'})).headers.get('set-cookie').split(';')[0];const admin=await login('admin'),editor=await login('editor');
 const rpc=(method,args={},cookie=admin)=>fetch(base+'/api/'+method,{method:'POST',headers:{origin,cookie,'content-type':'application/json'},body:JSON.stringify({type:'client-request',rpcId:'rpc-1',method,payload:{args}})});
 assert.equal((await rpc('settings/describe',{},editor)).status,403);
 const first=await(await rpc('settings/describe')).json();assert.equal(first.type,'server-response');assert.equal(first.rpcId,'rpc-1');assert.equal(first.result.value.namespaces[0].ns,'llm-pi-ai');
 const args={ns:'llm-pi-ai',expectedRevision:0,ops:[{op:'set',path:['providers','example'],value:{displayName:'Example',baseURL:'https://api.example.com/v1',api:'openai-completions',apiKeyEnv:'KEY',models:[{id:'m'}]}}]};
 assert.equal((await(await rpc('settings/mutate',args)).json()).result.value.revision,1);
 assert.equal((await(await rpc('settings/mutate',args)).json()).result.error.code,'settings/conflict');
 assert.equal((await(await rpc('credentials/set',{ref:'KEY',value:'secret-key'})).json()).result.ok,true);
 const creds=await(await rpc('credentials/describe',{refs:['KEY']})).json();assert.equal(creds.result.value.KEY.configured,true);assert.doesNotMatch(JSON.stringify(creds),/secret-key/);
 assert.deepEqual((await(await rpc('llm/listProviders')).json()).result.value,[{id:'example',name:'Example'}]);
 const discovered=await(await rpc('llm/discoverModels',{settingsNs:'llm-pi-ai',request:{provider:'example'}})).json();
 assert.deepEqual(discovered.result,{ok:true,value:[{id:'m',name:'m'}]});
 const invalid=await(await rpc('llm/discoverModels',{settingsNs:'llm-pi-ai',request:{}})).json();assert.equal(invalid.result.error.code,'llm/model-discovery-rejected');assert.deepEqual(invalid.result.error.details,{settingsNs:'llm-pi-ai'});
 assert.equal((await rpc('llm/listConfigurableProviders',{},editor)).status,403);
 const legacy=await fetch(base+'/admin/models',{headers:{cookie:admin}});assert.equal(legacy.status,200);assert.match(await legacy.text(),/设置/);
 assert.equal((await fetch(base+'/admin/models',{method:'POST',headers:{cookie:admin,origin},body:'revision=0'})).status,409);
});
test('gateway CLI starts through a release directory symlink',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'muse-cli-'));let child;
 try{
  const link=join(dir,'current');await symlink(fileURLToPath(new URL('.',import.meta.url)),link,process.platform==='win32'?'junction':'dir');
  const result=await new Promise(resolve=>{
   child=spawn(process.execPath,[join(link,'gateway.mjs')],{env:{...process.env,MUSE_PORT:'0',MUSE_ACCOUNTS_FILE:join(dir,'accounts.json'),MUSE_PUBLIC_ORIGIN:'https://muse.test'}});
   let output='';const timer=setTimeout(()=>resolve({started:false,output:'startup timeout'}),5000);
   child.stdout.on('data',chunk=>{output+=chunk;if(output.includes('listening on loopback')){clearTimeout(timer);resolve({started:true,output});}});
   child.stderr.on('data',chunk=>output+=chunk);child.on('close',code=>{clearTimeout(timer);resolve({started:false,output,code});});
  });
  assert.equal(result.started,true,JSON.stringify(result));
 }finally{if(child&&child.exitCode===null){const closed=new Promise(r=>child.once('close',r));child.kill();await closed;}await rm(dir,{recursive:true,force:true});}
});
test('active HTTP streams terminate on logout, reset, disable and expiry',async()=>{
 const {createAccountServer}=await import('./gateway.mjs');const dir=await mkdtemp(join(tmpdir(),'muse-stream-'));let server;const clients=[];
 const upstream=http.createServer((q,r)=>{if(q.url==='/bootstrap'){r.setHeader('set-cookie','dsh=secret');r.end();}else{r.writeHead(200);r.write('private stream');}});
 try{const target=await listen(upstream),bootstrapPath=join(dir,'bootstrap');await writeFile(bootstrapPath,target+'/bootstrap');const store=await openStore(join(dir,'accounts.json'));const a=await store.create('streamer','pw');const origin='https://muse.test';server=createAccountServer({store,runtime:{ensure:async()=>({upstream:target,bootstrapPath})},publicOrigin:origin,sessionTtlMs:1000});const base=await listen(server);
 for(const action of ['logout','reset','disable','expiry']){
  if(action==='expiry')await store.setDisabled(a.id,false);
  const login=await fetch(base+'/login',{method:'POST',headers:{origin},body:'username=streamer&password=pw',redirect:'manual'});const cookie=login.headers.get('set-cookie').split(';')[0];
  const response=await new Promise((resolve,reject)=>{const client=http.get(base+'/download',{headers:{cookie}},res=>{res.once('data',()=>resolve(res));res.on('error',()=>{});});clients.push(client);client.on('error',reject);});
  const closed=new Promise(resolve=>response.once('close',()=>resolve(true)));
  if(action==='logout')await fetch(base+'/logout',{method:'POST',headers:{origin,cookie},redirect:'manual'});
  if(action==='reset')await store.resetPassword(a.id,'pw');
  if(action==='disable')await store.setDisabled(a.id,true);
  let timer;const didClose=await Promise.race([closed,new Promise(resolve=>{timer=setTimeout(()=>resolve(false),action==='expiry'?1800:400);})]);clearTimeout(timer);assert.equal(didClose,true,action+' must terminate HTTP stream');
 }
 }finally{for(const c of clients)c.destroy();for(const s of [server,upstream].filter(Boolean)){s.closeAllConnections();await new Promise(r=>s.close(r));}await rm(dir,{recursive:true,force:true});}
});
test('HTTP and WS isolation, CSRF, admin and immediate revocation',async()=>{
 const {createAccountServer}=await import('./gateway.mjs');const dir=await mkdtemp(join(tmpdir(),'muse-http-'));const servers=[];const sockets=[];
 try{
 const store=await openStore(join(dir,'accounts.json'));const a=await store.create('alice','pw'),b=await store.create('bob','pw'),admin=await store.create('ylk','1234',{admin:true});const backends=new Map();
 for(const user of [a,b,admin]){const backend=http.createServer((q,r)=>{if(q.url==='/bootstrap'){r.setHeader('set-cookie',`dsh=${user.id}; HttpOnly`);r.end();}else{r.setHeader('content-type','application/json');r.end(JSON.stringify({owner:user.id,cookie:q.headers.cookie,authorization:q.headers.authorization,origin:q.headers.origin,forwarded:q.headers['x-forwarded-for']}));}});backend.on('upgrade',(q,s)=>{sockets.push(s);s.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n');});servers.push(backend);const upstream=await listen(backend);const bootstrapPath=join(dir,user.id);await writeFile(bootstrapPath,upstream+'/bootstrap');backends.set(user.id,{upstream,bootstrapPath});}
 const origin='https://muse.test';const server=createAccountServer({store,runtime:{ensure:async id=>backends.get(id)},publicOrigin:origin});servers.push(server);const base=await listen(server);
 const req=(path,opts={})=>fetch(base+path,{redirect:'manual',...opts});
 const login=async name=>{const r=await req('/login',{method:'POST',headers:{origin,'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({username:name,password:name==='ylk'?'1234':'pw'})});assert.equal(r.status,303);return r.headers.get('set-cookie').split(';')[0];};
 assert.equal((await req('/')).status,303);assert.equal((await req('/login',{method:'POST',body:'username=alice&password=pw'})).status,403);
 const ca=await login('alice'),cb=await login('bob'),cc=await login('ylk');
 const payload=await (await req('/?accountId='+b.id,{headers:{cookie:ca+'; dsh=evil',authorization:'Bearer evil','x-forwarded-for':'evil','x-account-id':b.id,origin}})).json();assert.equal(payload.owner,a.id);assert.equal(payload.cookie,'dsh='+a.id);assert.equal(payload.authorization,undefined);assert.equal(payload.forwarded,undefined);assert.equal(payload.origin,backends.get(a.id).upstream);
 assert.equal((await (await req('/',{headers:{cookie:cb}})).json()).owner,b.id);
 assert.equal((await req('/admin',{headers:{cookie:ca}})).status,403);assert.equal((await req('/admin',{headers:{cookie:cc}})).status,200);
 assert.equal((await req('/admin/disable',{method:'POST',headers:{cookie:cc,origin},body:new URLSearchParams({id:admin.id,disabled:'true'})})).status,400);
 assert.equal((await req('/api/muse.account',{headers:{cookie:ca}})).status,200);
 const socket=net.connect(server.address().port,'127.0.0.1');sockets.push(socket);await new Promise((resolve,reject)=>{socket.once('error',reject);socket.once('data',d=>{assert.match(d.toString(),/101/);resolve();});socket.write(`GET /ws HTTP/1.1\r\nHost: muse.test\r\nOrigin: ${origin}\r\nCookie: ${ca}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n`);});
 const closed=new Promise(r=>socket.once('close',r));await store.resetPassword(a.id,'changed');await closed;
 assert.equal((await req('/',{headers:{cookie:ca}})).status,303);
 assert.equal((await req('/logout',{method:'POST',headers:{cookie:cb,origin:'https://evil.test'}})).status,403);
 assert.equal((await req('/logout',{method:'POST',headers:{cookie:cb,origin}})).status,303);assert.equal((await req('/',{headers:{cookie:cb}})).status,303);
 for(let i=0;i<7;i++)assert.equal((await req('/login',{method:'POST',headers:{origin},body:'username=alice&password=wrong'})).status,401);
 assert.equal((await req('/login',{method:'POST',headers:{origin},body:'username=alice&password=wrong'})).status,429);
 const reg=await req('/register',{method:'POST',headers:{origin},body:'username=newuser&password=pw'});assert.equal(reg.status,303);assert.equal(store.list().length,4);
 const cookieReg=reg.headers.get('set-cookie').split(';')[0];await store.setDisabled(store.list().find(x=>x.username==='newuser').id,true);assert.equal((await req('/',{headers:{cookie:cookieReg}})).status,303);
 assert.equal((await req('/register',{method:'POST',headers:{origin},body:'x'.repeat(9000)})).status,413);
 }finally{for(const s of sockets)s.destroy();for(const s of servers){s.closeAllConnections();await new Promise(r=>s.close(r));}await rm(dir,{recursive:true,force:true});}
});
test('administrator forms navigate away instead of answering a bare method error',async t=>{
 const {createAccountServer}=await import('./gateway.mjs'),{openAdminAccess}=await import('./admin-access.mjs');
 const dir=await mkdtemp(join(tmpdir(),'muse-admin-form-'));const servers=[];t.after(async()=>{for(const s of servers){s.closeAllConnections();await new Promise(r=>s.close(r));}await rm(dir,{recursive:true,force:true});});
 const store=await openStore(join(dir,'accounts'));await store.create('ylk','pw',{admin:true});const adminAccess=await openAdminAccess(join(dir,'privileged'));await adminAccess.configure('admin-secret');
 const origin='https://muse.test',bootstrapPath=join(dir,'server-bootstrap');await writeFile(bootstrapPath,'http://127.0.0.1:1/');
 const server=createAccountServer({store,adminAccess,adminHosts:{server:{upstream:'http://127.0.0.1:1',bootstrapPath}},runtime:{ensure:async()=>{throw Error('No tenant needed');}},publicOrigin:origin});servers.push(server);const base=await listen(server);
 const login=async()=>(await fetch(base+'/login',{method:'POST',headers:{origin},body:new URLSearchParams({username:'ylk',password:'pw'}),redirect:'manual'})).headers.get('set-cookie').split(';')[0];
 const request=(path,{method='GET',cookie,form}={})=>fetch(base+path,{method,headers:{origin,...cookie?{cookie}:{}},body:form&&new URLSearchParams(form),redirect:'manual'});
 for(const path of ['/admin/control/unlock','/admin/control/lock','/admin/control/open']){
  const anonymous=await request(path);assert.equal(anonymous.status,303,path);assert.equal(anonymous.headers.get('location'),'/login');
  const cookie=await login(),mine=await request(path,{cookie});assert.equal(mine.status,303,path);assert.equal(mine.headers.get('location'),'/admin/control');
 }
 const cookie=await login();const unlocked=await request('/admin/control/unlock',{method:'POST',cookie,form:{password:'admin-secret'}});assert.equal(unlocked.status,303);assert.equal(unlocked.headers.get('location'),'/');
 const control=await request('/admin/control',{cookie});assert.equal(control.status,200);assert.match(await control.text(),/验证并解锁|短时授权/);
});
test('administrator seed reads stdin and never outputs password',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'muse-seed-'));try{const secret='seed-test-'+Date.now();const file=join(dir,'accounts.json');const result=await new Promise(resolve=>{const child=spawn(process.execPath,[fileURLToPath(new URL('./setup-admin.mjs',import.meta.url)),'ylk'],{env:{...process.env,MUSE_ACCOUNTS_FILE:file}});let output='';child.stdout.on('data',c=>output+=c);child.stderr.on('data',c=>output+=c);child.on('close',code=>resolve({code,output}));child.stdin.end(secret+'\n');});assert.equal(result.code,0,result.output);assert.ok(!result.output.includes(secret));const store=await openStore(file);assert.equal((await store.authenticate('ylk',secret)).admin,true);}finally{await rm(dir,{recursive:true,force:true});}
});
test('logout and session expiry close live websockets',async()=>{
 const {createAccountServer}=await import('./gateway.mjs');const dir=await mkdtemp(join(tmpdir(),'muse-expiry-'));const sockets=[];let server;const upstream=http.createServer((q,r)=>{r.setHeader('set-cookie','dsh=secret');r.end();});upstream.on('upgrade',(q,s)=>{sockets.push(s);s.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n');});
 try{const target=await listen(upstream),bootstrapPath=join(dir,'bootstrap');await writeFile(bootstrapPath,target);const store=await openStore(join(dir,'accounts.json'));await store.create('person','pw');const origin='https://muse.test';server=createAccountServer({store,runtime:{ensure:async()=>({upstream:target,bootstrapPath})},publicOrigin:origin,sessionTtlMs:500});const base=await listen(server);
 const connect=async()=>{const r=await fetch(base+'/login',{method:'POST',headers:{origin},body:'username=person&password=pw',redirect:'manual'});const cookie=r.headers.get('set-cookie').split(';')[0];const socket=net.connect(server.address().port,'127.0.0.1');sockets.push(socket);await new Promise((resolve,reject)=>{socket.once('error',reject);socket.once('data',d=>{assert.match(d.toString(),/101/);resolve();});socket.write(`GET /ws HTTP/1.1\r\nHost: muse.test\r\nOrigin: ${origin}\r\nCookie: ${cookie}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n`);});return {socket,cookie};};
 const first=await connect();const closed=new Promise(r=>first.socket.once('close',r));assert.equal((await fetch(base+'/logout',{method:'POST',headers:{origin,cookie:first.cookie},redirect:'manual'})).status,303);await closed;
 const second=await connect();await new Promise(r=>second.socket.once('close',r));assert.equal((await fetch(base+'/',{headers:{cookie:second.cookie},redirect:'manual'})).status,303);
 }finally{for(const s of sockets)s.destroy();for(const s of [server,upstream].filter(Boolean)){s.closeAllConnections();await new Promise(r=>s.close(r));}await rm(dir,{recursive:true,force:true});}
});

import {test} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {openStore} from './store.mjs';
import {createAccountServer} from './gateway.mjs';
const origin='https://muse.test';
const listen=s=>new Promise(r=>s.listen(0,'127.0.0.1',()=>r(`http://127.0.0.1:${s.address().port}`)));
async function fixture(t,options={}){
 const dir=await mkdtemp(join(tmpdir(),'muse-account-')),store=await openStore(join(dir,'accounts.json'));
 await store.create('person','old');await store.create('admin','old',{admin:true});let calls=0;
 const upstream=http.createServer((q,r)=>{calls++;if(q.url==='/bootstrap')r.setHeader('set-cookie','dsh=secret');r.end('upstream');});
 const target=await listen(upstream),bootstrapPath=join(dir,'bootstrap');await writeFile(bootstrapPath,target+'/bootstrap');
 const maintenanceFile=join(dir,'maintenance');const server=createAccountServer({store,runtime:{ensure:async()=>({upstream:target,bootstrapPath})},publicOrigin:origin,maintenanceFile,...options});const base=await listen(server);
 t.after(async()=>{for(const s of [server,upstream]){s.closeAllConnections();await new Promise(r=>s.close(r));}await rm(dir,{recursive:true,force:true});});
 const req=(path,opts={})=>fetch(base+path,{redirect:'manual',...opts});
 const post=(path,cookie,body)=>req(path,{method:'POST',headers:{origin,...cookie&&{cookie}},body:new URLSearchParams(body)});
 const login=async(name='person')=>{const r=await post('/login',null,{username:name,password:'old'});return {response:r,cookie:r.headers.get('set-cookie')?.split(';')[0]};};
 return {req,post,login,store,server,maintenanceFile,calls:()=>calls};
}
test('own password form, original-password check, CSRF and immediate session invalidation',async t=>{
 const f=await fixture(t),{cookie}=await f.login();
 assert.match(await (await f.req('/account',{headers:{cookie}})).text(),/name="originalPassword"/);
 assert.equal((await f.req('/account/password',{method:'POST',headers:{cookie},body:'originalPassword=old&password=new'})).status,403);
 assert.equal((await f.post('/account/password',cookie,{originalPassword:'wrong',password:'new'})).status,400);
 assert.equal((await f.post('/account/password',cookie,{originalPassword:'old',password:'new'})).status,303);
 assert.equal((await f.req('/api/muse.account',{headers:{cookie}})).status,303);
 assert.ok(await f.store.authenticate('person','new'));
});
test('dev mode only permits administrator login and no registration',async t=>{
 const f=await fixture(t,{devOnlyAdmin:true,cookieName:'__Host-muse-dev'});
 assert.equal((await f.req('/register')).status,403);
 assert.equal((await f.post('/register',null,{username:'newuser',password:'pw'})).status,403);
 assert.equal((await f.login()).response.status,401);
 const a=await f.login('admin');assert.match(a.cookie,/^__Host-muse-dev=/);
 const account=await (await f.req('/api/muse.account',{headers:{cookie:a.cookie}})).json();assert.equal(account.workspaceLabel,'admin');assert.equal(account.environment,'development');
 assert.match(await (await f.req('/account',{headers:{cookie:a.cookie}})).text(),/开发验证环境/);
 const adminPage=await (await f.req('/admin',{headers:{cookie:a.cookie}})).text();assert.match(adminPage,/修改密码/);assert.doesNotMatch(adminPage,/重置密码/);
 assert.doesNotMatch(await (await f.req('/login')).text(),/href="\/register"/);
});
test('workspace mutations blocked before upstream, normal follow and session commands allowed',async t=>{
 const f=await fixture(t),{cookie}=await f.login();
 for(const separator of ['.','/'])for(const method of ['create','delete','rename','update','change','insertBefore'])assert.equal((await f.post('/api/workspace'+separator+method,cookie,{})).status,403,method);
 assert.equal(f.calls(),0);
 assert.equal((await f.post('/api/workspace.archiveSession',cookie,{})).status,200);
 assert.equal((await f.req('/api/workspace.follow',{headers:{cookie}})).status,200);
});
test('administrator must use original password to change own password',async t=>{
 const f=await fixture(t),{cookie}=await f.login('admin'),admin=f.store.list().find(a=>a.admin);
 const page=await (await f.req('/admin',{headers:{cookie}})).text();
 const row=page.match(/<tr><td>admin[\s\S]*?<\/tr>/)?.[0];assert.ok(row);assert.doesNotMatch(row,/action="\/admin\/reset"/);assert.match(row,/href="\/account"/);
 assert.equal((await f.post('/admin/reset',cookie,{id:admin.id,password:'bypass'})).status,400);
 assert.ok(await f.store.authenticate('admin','old'));
 const person=f.store.list().find(a=>!a.admin);assert.equal((await f.post('/admin/reset',cookie,{id:person.id,password:'changed'})).status,303);assert.ok(await f.store.authenticate('person','changed'));
});
test('maintenance is checked per HTTP and WS request but account pages stay available',async t=>{
 const f=await fixture(t),{cookie}=await f.login();assert.equal((await f.req('/',{headers:{cookie}})).status,200);
 await writeFile(f.maintenanceFile,'release');const before=f.calls();
 assert.equal((await f.req('/',{headers:{cookie}})).status,503);assert.equal(f.calls(),before);
 assert.equal((await f.req('/account',{headers:{cookie}})).status,200);
 const response=await new Promise((resolve,reject)=>{const s=net.connect(f.server.address().port,'127.0.0.1');s.on('error',reject);s.once('data',d=>{resolve(d.toString());s.destroy();});s.write(`GET /ws HTTP/1.1\r\nHost: muse.test\r\nOrigin: ${origin}\r\nCookie: ${cookie}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n`);});assert.match(response,/503/);
 await rm(f.maintenanceFile);assert.equal((await f.req('/',{headers:{cookie}})).status,200);
});

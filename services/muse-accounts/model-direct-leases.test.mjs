import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,createHmac} from 'node:crypto';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createModelKeyPool} from './model-key-pool.mjs';
import {openDirectModelLeases,resolveDirectLeasePolicy} from './model-direct-leases.mjs';
import {createAccountServer} from './gateway.mjs';
import {openStore} from './store.mjs';

const policy={tokenMs:1000,requestMs:10000,checkMs:1000,graceMs:10};
async function fixture(t,{file,clock,keys=['one.secret','two.secret'],concurrency=1}={}){
 const root=await mkdtemp(join(tmpdir(),'muse-direct-lease-')),pool=createModelKeyPool({keys:()=>keys,concurrency,maxQueued:100,waitMs:5000});
 const directory={credentialPool:()=>keys,resolve:(_provider,model)=>model==='glm-test'?{apiKey:keys[0],baseURL:'https://open.bigmodel.cn/api/paas/v4',maxTokens:128000}:undefined,
 metadata:()=>({providers:{'zhipu-official':{models:[{id:'glm-test',contextWindow:1000000,maxTokens:128000}]}}})};
 const path=file??join(root,'leases.json'),leases=await openDirectModelLeases({pool,globalModels:directory,file:path,policy,...clock?{now:clock}:{}});
 t.after(async()=>{await leases.close();pool.close();await rm(root,{recursive:true,force:true});});
 const session={id:'a',token:'session-a',expiry:Date.now()+1000000};
 return {root,pool,directory,path,leases,session,keys};
}

test('forty direct requests distribute over five accounts and credentials never enter durable reservations',async t=>{
 const f=await fixture(t,{keys:['a.secret','b.secret','c.secret','d.secret','e.secret'],concurrency:20});
 const results=await Promise.all(Array.from({length:40},()=>f.leases.acquire(f.session,'glm-test')));
 const counts=new Map();for(const result of results){const [header,payload,signature]=result.apiKey.split('.'),data=JSON.parse(Buffer.from(payload,'base64url'));
  assert.equal(JSON.parse(Buffer.from(header,'base64url')).sign_type,'SIGN');assert.equal(signature,createHmac('sha256','secret').update(header+'.'+payload).digest('base64url'));
  assert.equal(data.exp-data.timestamp,1000);counts.set(data.api_key,(counts.get(data.api_key)??0)+1);
 }
 assert.deepEqual([...counts.values()],[8,8,8,8,8]);
 const text=await readFile(f.path,'utf8');assert.equal(JSON.parse(text).leases.length,40);
 for(const key of f.keys)assert.ok(!text.includes(key));for(const result of results)assert.ok(!text.includes(result.apiKey));assert.ok(!text.includes(f.session.token));
});

test('persisted reservations survive restart and count against the shared relay pool',async t=>{
 let current=Date.now();const f=await fixture(t,{keys:['a.secret'],clock:()=>current});
 const first=await f.leases.acquire(f.session,'glm-test');await f.leases.close();f.pool.close();
 const pool=createModelKeyPool({keys:()=>f.keys,concurrency:1,maxQueued:2,waitMs:5000});
 const restored=await openDirectModelLeases({pool,globalModels:f.directory,file:f.path,policy,now:()=>current});
 t.after(async()=>{await restored.close();pool.close();});
 let admitted=false;const waiting=pool.acquire().then(slot=>{admitted=true;return slot;});await Promise.resolve();assert.equal(admitted,false);
 await assert.rejects(restored.release({...f.session,token:'another-login'},first.id),error=>error.status===404);
 await restored.release(f.session,first.id);current+=policy.graceMs;
 const slot=await waiting;slot.release();assert.equal(JSON.parse(await readFile(f.path,'utf8')).leases.length,0);
});

test('expired and malformed reservations fail safely without supplier dispatch',async t=>{
 const f=await fixture(t);const lease=await f.leases.acquire(f.session,'glm-test');
 assert.throws(()=>f.leases.check({...f.session,token:'wrong'},lease.id),error=>error.status===404);
 await assert.rejects(f.leases.acquire(f.session,'unknown'),error=>error.status===400);
 const controller=new AbortController();controller.abort(Error('cancelled'));
 await assert.rejects(f.leases.acquire(f.session,'glm-test',controller.signal),/cancelled/);
 const text=JSON.parse(await readFile(f.path,'utf8'));assert.equal(text.leases.length,1);
 await f.leases.close();await writeFile(f.path,JSON.stringify({version:1,leases:[{...text.leases[0],keyHash:'secret'}]}));
 await assert.rejects(openDirectModelLeases({pool:f.pool,globalModels:f.directory,file:f.path,policy}),/Invalid direct model reservation/);
});

test('expired request deadlines retain capacity until the conservative recovery deadline',async t=>{
 let current=Date.now();const f=await fixture(t,{clock:()=>current});const lease=await f.leases.acquire(f.session,'glm-test');
 current=lease.deadline;assert.throws(()=>f.leases.check(f.session,lease.id),error=>error.status===410);
 const rows=JSON.parse(await readFile(f.path,'utf8')).leases;assert.equal(rows[0].releaseAt,lease.deadline+policy.graceMs);
});

test('unsupported keys, nonpublic endpoints and expired sessions never issue direct credentials',async t=>{
 for(const key of ['malformed','id.secret']){
  const f=await fixture(t,{keys:[key]});
  if(key==='malformed')await assert.rejects(f.leases.acquire(f.session,'glm-test'),error=>error.status===503);
  await assert.rejects(f.leases.acquire({...f.session,expiry:1},'glm-test'),error=>error.status===401);
 }
 const f=await fixture(t);f.directory.resolve=()=>({apiKey:'a.secret',baseURL:'http://127.0.0.1'});
 await assert.rejects(f.leases.acquire(f.session,'glm-test'));
});

test('lease policy refuses invalid values and inconsistent durations',()=>{
 assert.equal(resolveDirectLeasePolicy().tokenMs,60000);
 for(const name of ['MUSE_ZHIPU_DIRECT_TOKEN_MS','MUSE_ZHIPU_DIRECT_REQUEST_MS','MUSE_ZHIPU_DIRECT_CHECK_MS','MUSE_ZHIPU_DIRECT_GRACE_MS'])for(const value of ['0','secret','-1','1.5'])assert.throws(()=>resolveDirectLeasePolicy({[name]:value}),/Invalid/);
 assert.throws(()=>resolveDirectLeasePolicy({MUSE_ZHIPU_DIRECT_REQUEST_MS:'10000'}),/timing/);
});

test('HTTP negotiation keeps older Hosts on relay and grants only session-owned small admission requests',async t=>{
 const f=await fixture(t),store=await openStore(join(f.root,'accounts.json'));await store.create('editor','pw');
 let relayed=0;const origin='https://muse.test';
 const server=createAccountServer({store,globalModels:f.directory,desktopModelTransport:'direct',modelKeyPool:f.pool,directModelLeases:f.leases,publicOrigin:origin,modelForward:()=>{relayed++;}});
 t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base='http://127.0.0.1:'+server.address().port;
 const login=await fetch(base+'/login',{method:'POST',headers:{origin},body:new URLSearchParams({username:'editor',password:'pw'}),redirect:'manual'}),cookie=login.headers.get('set-cookie').split(';')[0];
 const headers={cookie,origin,'content-type':'application/json','x-muse-model-access':'direct-v1','x-muse-provider-routing':'mixed-v1'};
 const old=await(await fetch(base+'/api/desktop-models/access',{headers})).json();assert.equal(old.providers[0].transport,'relay');
 headers['x-muse-zhipu-direct']='leased-v1';
 const modern=await(await fetch(base+'/api/desktop-models/access',{headers})).json();assert.equal(modern.providers[0].transport,'leased');assert.equal(modern.providers[0].access,undefined);
 const path='/api/desktop-models/zhipu-official/leases';
 assert.equal((await fetch(base+path,{method:'POST',headers:{...headers,cookie:''},body:'{}'})).status,401);
 assert.equal((await fetch(base+path,{method:'POST',headers,body:'not json'})).status,400);
 assert.equal((await fetch(base+path,{method:'POST',headers,body:JSON.stringify({model:'x'.repeat(4096)})})).status,413);
 const response=await fetch(base+path,{method:'POST',headers,body:JSON.stringify({model:'glm-test'})});assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');
 const lease=await response.json();assert.equal((await fetch(base+path+'/'+lease.id,{headers})).status,200);
 assert.equal((await fetch(base+path+'/'+lease.id,{method:'DELETE',headers})).status,200);assert.equal(relayed,0);
 await fetch(base+'/logout',{method:'POST',headers});
 assert.equal((await fetch(base+path+'/'+lease.id,{headers})).status,401);
});

test('restored pool counts a removed key if the same credential is reintroduced',async t=>{
 let keys=['other.secret'];const pool=createModelKeyPool({keys:()=>keys,concurrency:1,maxQueued:2,waitMs:5000});t.after(()=>pool.close());
 const release=pool.restore(createHash('sha256').update('old.secret').digest('hex'));
 keys=['old.secret'];let admitted=false;const pending=pool.acquire().then(slot=>{admitted=true;return slot;});await Promise.resolve();assert.equal(admitted,false);
 release();release();(await pending).release();assert.throws(()=>pool.restore('bad'),/Invalid/);
});

test('persistence failure stops direct admissions and conservatively retains the acquired slot',async t=>{
 const {mkdir}=await import('node:fs/promises');
 const f=await fixture(t,{keys:['a.secret']});await mkdir(f.path);
 await assert.rejects(f.leases.acquire(f.session,'glm-test'));
 await assert.rejects(f.leases.acquire(f.session,'glm-test'),error=>error.status===503);
 const controller=new AbortController();const pending=assert.rejects(f.pool.acquire(controller.signal),/cancelled/);
 controller.abort(Error('cancelled'));await pending;
});

test('catalog changes between admission and issuance release the unused slot',async t=>{
 const f=await fixture(t,{keys:['a.secret']});let reads=0;
 f.directory.resolve=()=>++reads===1?{apiKey:'a.secret'}:undefined;
 await assert.rejects(f.leases.acquire(f.session,'glm-test'),error=>error.status===503);
 const slot=await f.pool.acquire();slot.release();
});

test('recovery refuses an unknown store version and prunes expired reservations',async t=>{
 const f=await fixture(t);const first=await f.leases.acquire(f.session,'glm-test');await f.leases.close();
 const data=JSON.parse(await readFile(f.path,'utf8'));
 await writeFile(f.path,JSON.stringify({...data,version:2}));
 await assert.rejects(openDirectModelLeases({pool:f.pool,globalModels:f.directory,file:f.path,policy}),/Invalid direct model lease store/);
 await writeFile(f.path,JSON.stringify(data));
 const empty=createModelKeyPool({keys:()=>f.keys,concurrency:1,maxQueued:1,waitMs:1000});
 const restored=await openDirectModelLeases({pool:empty,globalModels:f.directory,file:f.path,policy,now:()=>first.deadline+policy.graceMs+1});
 t.after(async()=>{await restored.close();empty.close();});
 const slots=await Promise.all([empty.acquire(),empty.acquire()]);for(const slot of slots)slot.release();
 await assert.rejects(openDirectModelLeases({pool:empty,globalModels:f.directory,file:'relative.json',policy}),/absolute/);
});

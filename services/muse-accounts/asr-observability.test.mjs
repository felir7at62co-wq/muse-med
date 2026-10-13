import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {mkdtemp,readFile,readdir,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Readable} from 'node:stream';
import {createAsrService} from './asr-service.mjs';
import {createAccountServer} from './gateway.mjs';
import {openAdminAccess} from './admin-access.mjs';
import {openStore} from './store.mjs';

const audio=Buffer.from('synthetic audio');
const hash=createHash('sha256').update(audio).digest('hex');
const deferred=()=>Promise.withResolvers();
const storage={key:id=>id+'.mp3',assertPrivateBeforeUpload:async()=>{},upload:async()=>{},signedReadUrl:async()=> 'https://synthetic.invalid/audio',assertPrivateAndReadable:async()=>{},remove:async()=>{}};
const limits={probe:async()=>10,maxAudioBytes:1024,maxDurationSeconds:7200,maxDailySeconds:180000,maxDailyJobs:1000,maxActiveJobs:1,maxPendingUploadsPerAccount:4,retentionSeconds:86400,pollIntervalMs:10};
const submit=(service,account,id=randomUUID(),purpose)=>service.submit(account,id,hash,'zh',Readable.from(audio),purpose);

async function receipts(root){
 const names=(await readdir(join(root,'jobs'))).filter(name=>name.endsWith('.json')).sort();
 return await Promise.all(names.map(name=>readFile(join(root,'jobs',name),'utf8')));
}

function mixedConfig(root,provider,now){return {
 root,storage,providerKind:'flash',defaultPoolId:'flash-pool',routes:{subtitles:'flash',screenplay:'standard-v2'},now,
 resources:[
  {poolId:'flash-pool',appId:'flash-app',serviceVersion:'flash',resourceId:'volc.bigasr.auc_turbo',quotaGroup:'flash-group',maxConcurrentJobs:1,provider},
  {poolId:'standard-pool',appId:'standard-app',serviceVersion:'standard-v2',resourceId:'volc.seedasr.auc',quotaGroup:'standard-group',maxConcurrentJobs:1,provider},
 ],
 quotaGroups:[{id:'flash-group',maxConcurrentJobs:1},{id:'standard-group',maxConcurrentJobs:1,submitQps:10}],
 maxQueuedJobs:1,...limits,
};}

test('diagnostics aggregate long-lived standard uncertainty and waiting-capacity refusal without changing receipts',async t=>{
 const root=await mkdtemp(join(tmpdir(),'muse-asr-observe-')),entered=deferred(),release=deferred();let clock=1_000_000,queries=0;
 const provider={recognize:async()=>({status:'silent'}),submit:async()=>{throw Error('unknown submit');},query:async()=>{queries++;entered.resolve();await release.promise;return {status:'silent'};}};
 const service=createAsrService(mixedConfig(root,provider,()=>clock));t.after(async()=>{release.resolve();await service.close();await rm(root,{recursive:true,force:true});});
 try{
  const first=randomUUID(),second=randomUUID(),third=randomUUID();
  await submit(service,'alice',first,'screenplay');await entered.promise;clock+=31*60*1000;
  assert.equal((await submit(service,'bob',second,'screenplay')).queued,true);
  await assert.rejects(submit(service,'carol',third,'screenplay'),{status:429,code:'queue_full'});
  const before=await receipts(root),snapshot=service.diagnostics(),after=await receipts(root);
  assert.deepEqual(after,before);assert.equal(queries,1);
  assert.deepEqual(snapshot.occupancy,{active:0,workers:1,waiting:1,occupied_unique:2,worker_limit:2,waiting_limit:1});
  assert.deepEqual(snapshot.by_service_version.find(row=>row.service_version==='standard-v2'),{service_version:'standard-v2',active:0,workers:1,waiting:1,occupied_unique:2});
  assert.deepEqual(snapshot.by_quota_group.find(row=>row.quota_group==='standard-group'),{quota_group:'standard-group',configured_worker_limit:1,active:0,workers:1,waiting:1,occupied_unique:2});
  assert.equal(snapshot.active_unassigned_to_quota_group,0);
  assert.equal(snapshot.standard_unresolved.uncertain.count,1);assert.equal(snapshot.standard_unresolved.uncertain.age_buckets['30_minutes_to_2_hours'],1);
  assert.equal(snapshot.standard_unresolved.processing.count,0);
  assert.deepEqual(snapshot.queue_full_since_start.categories.map(row=>[row.category,row.count]),[['occupied_total',0],['waiting_capacity',1]]);
  const serialized=JSON.stringify(snapshot);
  for(const privateValue of ['alice','bob','carol',first,second,third,'flash-app','standard-app'])assert.doesNotMatch(serialized,new RegExp(privateValue));
  assert.doesNotMatch(serialized,/taskId|appId|resourceId|audio|hash|path/i);
 }finally{release.resolve();}
 await service.idle();
});

test('diagnostics distinguish the total-occupancy queue refusal',async t=>{
 const root=await mkdtemp(join(tmpdir(),'muse-asr-observe-full-')),entered=deferred(),release=deferred();
 const provider={submit:async()=>{throw Error('unknown submit');},query:async()=>{entered.resolve();await release.promise;return {status:'silent'};}};
 const service=createAsrService({root,storage,provider,maxConcurrentJobs:1,maxQueuedJobs:1,...limits});t.after(async()=>{release.resolve();await service.close();await rm(root,{recursive:true,force:true});});
 try{
  await submit(service,'alice');await entered.promise;await submit(service,'bob');
  await assert.rejects(submit(service,'carol'),{status:429,code:'queue_full'});
  const summary=service.diagnostics().queue_full_since_start;
  assert.equal(summary.total,1);assert.deepEqual(summary.categories.map(row=>[row.category,row.count]),[['occupied_total',1],['waiting_capacity',0]]);
 }finally{release.resolve();}
 await service.idle();
});

test('diagnostics count an upload before it receives a quota-group assignment',async t=>{
 const root=await mkdtemp(join(tmpdir(),'muse-asr-observe-active-')),entered=deferred(),release=deferred();
 const provider={submit:async()=>{},query:async()=>({status:'silent'})};
 const service=createAsrService({root,storage,provider,maxConcurrentJobs:1,maxQueuedJobs:1,...limits,probe:async()=>{entered.resolve();await release.promise;return 10;}});t.after(async()=>{release.resolve();await service.close();await rm(root,{recursive:true,force:true});});
 const pending=submit(service,'alice');await entered.promise;
 const snapshot=service.diagnostics();assert.equal(snapshot.occupancy.active,1);assert.equal(snapshot.occupancy.occupied_unique,1);assert.equal(snapshot.active_unassigned_to_quota_group,1);
 assert.deepEqual(snapshot.by_service_version.find(row=>row.service_version==='standard-v1'),{service_version:'standard-v1',active:1,workers:0,waiting:0,occupied_unique:1});
 release.resolve();await pending;await service.idle();
});

test('a terminal pre-submit failure releases capacity and diagnostics remain read-only',async t=>{
 const root=await mkdtemp(join(tmpdir(),'muse-asr-observe-failed-'));let uploads=0,submits=0;
 const failingStorage={...storage,upload:async()=>{if(++uploads===1)throw Error('storage unavailable');}};
 const provider={submit:async()=>{submits++;},query:async()=>({status:'silent'})};
 const service=createAsrService({root,storage:failingStorage,provider,maxConcurrentJobs:1,maxQueuedJobs:1,...limits});t.after(async()=>{await service.close();await rm(root,{recursive:true,force:true});});
 const id=randomUUID();await submit(service,'alice',id);await service.idle();assert.equal((await service.get('alice',id)).status,'failed');
 const before=await receipts(root);assert.deepEqual(service.diagnostics().occupancy,{active:0,workers:0,waiting:0,occupied_unique:0,worker_limit:1,waiting_limit:1});assert.deepEqual(await receipts(root),before);
 await submit(service,'alice',id);await service.idle();assert.equal((await service.get('alice',id)).status,'silent');assert.equal(submits,1);
});

test('HTTP diagnostics require an elevated administrator and return only the supplied aggregate',async t=>{
 const root=await mkdtemp(join(tmpdir(),'muse-asr-observe-http-')),servers=[];let clock=Date.now(),reads=0;
 t.after(async()=>{for(const server of servers){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}await rm(root,{recursive:true,force:true});});
 const store=await openStore(join(root,'accounts'));await store.create('admin','pw',{admin:true});await store.create('editor','pw');
 const adminAccess=await openAdminAccess(join(root,'privileged'),{now:()=>clock,ttlMs:1000});await adminAccess.configure('test-admin-secret');
 const snapshot={schema_version:1,occupancy:{active:0,workers:0,waiting:0,occupied_unique:0,worker_limit:2,waiting_limit:3}};
 const asr={diagnostics:()=>{reads++;return snapshot;}};
 const origin='https://muse.test',server=createAccountServer({store,adminAccess,asr,publicOrigin:origin,now:()=>clock});servers.push(server);
 const base=await new Promise(resolve=>server.listen(0,'127.0.0.1',()=>resolve('http://127.0.0.1:'+server.address().port)));
 const login=async username=>(await fetch(base+'/login',{method:'POST',headers:{origin},body:new URLSearchParams({username,password:'pw'}),redirect:'manual'})).headers.get('set-cookie').split(';')[0];
 const admin=await login('admin'),editor=await login('editor');
 const request=(cookie,options={})=>fetch(base+'/api/admin/asr/diagnostics',{method:options.method??'GET',headers:{cookie,origin},redirect:'manual'});
 assert.equal((await fetch(base+'/api/admin/asr/diagnostics',{redirect:'manual'})).status,303);
 assert.equal((await request(editor)).status,403);assert.equal((await request(admin)).status,403);assert.equal(reads,0);
 const unlock=await fetch(base+'/admin/control/unlock',{method:'POST',headers:{cookie:admin,origin},body:new URLSearchParams({password:'test-admin-secret'}),redirect:'manual'});assert.equal(unlock.status,303);
 assert.equal((await request(admin,{method:'POST'})).status,405);
 const response=await request(admin);assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');assert.deepEqual(await response.json(),snapshot);assert.equal(reads,1);
 for(let index=1;index<12;index++)assert.equal((await request(admin)).status,200);
 const limited=await request(admin);assert.equal(limited.status,429);assert.equal(limited.headers.get('cache-control'),'no-store');assert.equal(reads,12);
 const audit=(await readFile(join(root,'privileged','audit.jsonl'),'utf8')).trim().split('\n').map(line=>JSON.parse(line));
 assert.equal(audit.filter(row=>row.event==='GET /api/admin/asr/diagnostics').length,12);
 clock+=1001;assert.equal((await request(admin)).status,403);assert.equal(reads,12);
});

test('an elevated administrator receives an uncached unavailable response when ASR is absent',async t=>{
 const root=await mkdtemp(join(tmpdir(),'muse-asr-observe-unavailable-'));
 const store=await openStore(join(root,'accounts'));await store.create('admin','pw',{admin:true});
 const adminAccess=await openAdminAccess(join(root,'privileged'));await adminAccess.configure('test-admin-secret');
 const origin='https://muse.test',server=createAccountServer({store,adminAccess,publicOrigin:origin});
 t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await rm(root,{recursive:true,force:true});});
 const base=await new Promise(resolve=>server.listen(0,'127.0.0.1',()=>resolve('http://127.0.0.1:'+server.address().port)));
 const login=await fetch(base+'/login',{method:'POST',headers:{origin},body:new URLSearchParams({username:'admin',password:'pw'}),redirect:'manual'});
 const cookie=login.headers.get('set-cookie').split(';')[0];
 const unlock=await fetch(base+'/admin/control/unlock',{method:'POST',headers:{cookie,origin},body:new URLSearchParams({password:'test-admin-secret'}),redirect:'manual'});assert.equal(unlock.status,303);
 const response=await fetch(base+'/api/admin/asr/diagnostics',{headers:{cookie},redirect:'manual'});
 assert.equal(response.status,503);assert.equal(response.headers.get('cache-control'),'no-store');
 assert.deepEqual(await response.json(),{error:'Muse cloud transcription is not configured on this server'});
});

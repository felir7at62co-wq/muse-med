import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {mkdtemp,readFile,rm,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Readable} from 'node:stream';
import {createAsrService} from './asr-service.mjs';
import {AsrProviderError} from './asr-provider.mjs';

const bytes=Buffer.from('synthetic queue expiry audio'),hash=createHash('sha256').update(bytes).digest('hex');
const deferred=()=>Promise.withResolvers();
const digest=(account,id)=>createHash('sha256').update(account+'\0'+id).digest('hex');

async function fixture(t,extra={},release=()=>{}){
 const root=await mkdtemp(join(tmpdir(),'muse-asr-queue-expiry-')),services=[];
 let clock=Date.UTC(2026,9,20);
 t.after(async()=>{
  release();
  try{for(const service of services)await service.close();}
  finally{await rm(root,{recursive:true,force:true});}
 });
 const settings={root,providerKind:'flash',maxAudioBytes:1024,maxDurationSeconds:600,maxDailySeconds:72000,maxDailyJobs:100,maxActiveJobs:1,retentionSeconds:86400,maxConcurrentJobs:1,maxQueuedJobs:20,maxPendingUploadsPerAccount:4,pollIntervalMs:1000,terminalQueryConfirmations:3,probe:async()=>10,now:()=>clock,...extra};
 const create=(overrides={})=>{const service=createAsrService({...settings,...overrides});services.push(service);return service;};
 const service=create();await service.ready();
 return {root,service,create,expire:()=>{clock+=settings.retentionSeconds*1000+1;},
  submit:(account,id=randomUUID())=>service.submit(account,id,hash,'zh',Readable.from(bytes)),
  read:(account,id)=>readFile(join(root,'jobs',digest(account,id)+'.json'),'utf8').then(JSON.parse),
  audio:(account,id)=>join(root,'audio',digest(account,id)+'.mp3')};
}

async function assertExpired(env,account,id,service=env.service){
 const status=await service.get(account,id),saved=await env.read(account,id);
 assert.equal(status.status,'failed');assert.equal(status.retentionExpired,true);
 assert.deepEqual(status.recovery,{capability:'none',next_action:'inspect_receipt',automatic_resubmit:false});
 assert.equal(status.queued,undefined);assert.equal(saved.status,'failed');assert.equal(saved.retentionExpired,true);
 assert.equal(saved.submittedAtMs,undefined);assert.equal(saved.id,id);
 await assert.rejects(stat(env.audio(account,id)),{code:'ENOENT'});
 return saved;
}

test('expired waiting Flash audio is cleaned without waiting for the occupied worker',async t=>{
 const entered=deferred(),release=deferred();let calls=0;
 const env=await fixture(t,{provider:{recognize:async()=>{calls++;entered.resolve();await release.promise;return {status:'silent'};}}},()=>release.resolve());
 const running=await env.submit('running');await entered.promise;
 const queued=await env.submit('waiting'),before=await env.read('waiting',queued.id);
 assert.equal(queued.queued,true);await stat(env.audio('waiting',queued.id));
 env.expire();await env.service.sweep();
 const after=await assertExpired(env,'waiting',queued.id);
 assert.equal(after.taskId,before.taskId);assert.equal(after.poolId,before.poolId);assert.equal(after.hash,before.hash);
 assert.equal(calls,1);assert.equal((await env.service.get('running',running.id)).status,'submitting');
 assert.equal(env.service.diagnostics().occupancy.workers,1);assert.equal(env.service.diagnostics().occupancy.waiting,0);
 await stat(env.audio('running',running.id));
});

test('expiry releases waiting capacity without releasing an unknown standard task or changing its identity',async t=>{
 const entered=deferred(),release=deferred(),submissions=[],queries=[],removals=[];
 const storage={key:id=>id,assertPrivateBeforeUpload:async()=>{},upload:async()=>{},signedReadUrl:async()=>'https://synthetic.invalid/audio',assertPrivateAndReadable:async()=>{},remove:async key=>{removals.push(key);}};
 const env=await fixture(t,{providerKind:'standard',storage,provider:{
  submit:async({id})=>{submissions.push(id);throw new AsrProviderError('submit','timeout');},
  query:async id=>{queries.push(id);entered.resolve();await release.promise;return {status:'processing'};},
 }},()=>release.resolve());
 const running=await env.submit('running');await entered.promise;
 const original=await env.read('running',running.id),queued=await env.submit('waiting');
 env.expire();await env.service.sweep();await assertExpired(env,'waiting',queued.id);
 const status=await env.service.get('running',running.id),saved=await env.read('running',running.id);
 assert.equal(status.status,'uncertain');assert.equal(status.recovery.next_action,'poll_original');
 assert.equal(saved.taskId,original.taskId);assert.equal(saved.poolId,original.poolId);assert.equal(saved.submittedAtMs,original.submittedAtMs);
 assert.deepEqual(submissions,[original.taskId]);assert.deepEqual(queries,[original.taskId]);
 assert.ok(!removals.includes(original.taskId));
 assert.equal(env.service.diagnostics().occupancy.workers,1);assert.equal(env.service.diagnostics().occupancy.waiting,0);
});

test('reading an expired waiting receipt ends its wait without requiring a sweep or a free worker',async t=>{
 const entered=deferred(),release=deferred();let calls=0;
 const env=await fixture(t,{provider:{recognize:async()=>{calls++;entered.resolve();await release.promise;return {status:'silent'};}}},()=>release.resolve());
 await env.submit('running');await entered.promise;
 const queued=await env.submit('waiting');env.expire();
 await assertExpired(env,'waiting',queued.id);
 assert.equal(calls,1);assert.equal(env.service.diagnostics().occupancy.workers,1);assert.equal(env.service.diagnostics().occupancy.waiting,0);
});

test('a paused restarted gateway can sweep expired unsubmitted audio without starting a provider request',async t=>{
 let calls=0;
 const env=await fixture(t,{autoStart:false,provider:{recognize:async()=>{calls++;return {status:'silent'};}}});
 const queued=await env.submit('waiting'),before=await env.read('waiting',queued.id);
 assert.equal(queued.queued,true);assert.equal(calls,0);await env.service.close();env.expire();
 const restarted=env.create();await restarted.ready();await restarted.sweep();
 const after=await assertExpired(env,'waiting',queued.id,restarted);
 assert.equal(after.taskId,before.taskId);assert.equal(after.poolId,before.poolId);assert.equal(calls,0);
 assert.equal(restarted.diagnostics().occupancy.waiting,0);assert.equal(restarted.diagnostics().occupancy.workers,0);
 await restarted.start();await restarted.idle();assert.equal(calls,0);
});

test('sweeping cannot expire a queued-status receipt already owned by a dispatching standard worker',async t=>{
 const firstQuery=deferred(),releaseFirst=deferred(),secondUpload=deferred(),releaseUpload=deferred(),submissions=[];
 let uploads=0;
 const storage={key:id=>id,assertPrivateBeforeUpload:async()=>{},upload:async()=>{if(++uploads===2){secondUpload.resolve();await releaseUpload.promise;}},signedReadUrl:async()=>'https://synthetic.invalid/audio',assertPrivateAndReadable:async()=>{},remove:async()=>{}};
 const env=await fixture(t,{providerKind:'standard',storage,provider:{
  submit:async({id})=>{submissions.push(id);},
  query:async id=>{if(id===submissions[0]){firstQuery.resolve();await releaseFirst.promise;}return {status:'silent'};},
 }},()=>{releaseFirst.resolve();releaseUpload.resolve();});
 await env.submit('first');await firstQuery.promise;
 const queued=await env.submit('second');assert.equal(queued.queued,true);
 releaseFirst.resolve();await secondUpload.promise;
 const before=await env.read('second',queued.id);assert.equal(before.status,'queued');assert.equal(before.submittedAtMs,undefined);
 assert.equal(env.service.diagnostics().occupancy.workers,1);assert.equal(env.service.diagnostics().occupancy.waiting,0);
 env.expire();await env.service.sweep();
 const during=await env.read('second',queued.id);
 assert.equal(during.status,'queued');assert.equal(during.retentionExpired,undefined);assert.equal(during.taskId,before.taskId);
 await stat(env.audio('second',queued.id));assert.equal(submissions.length,1);
 releaseUpload.resolve();await env.service.idle();
 const complete=await env.service.get('second',queued.id),saved=await env.read('second',queued.id);
 assert.equal(complete.status,'silent');assert.equal(saved.taskId,before.taskId);
 assert.equal(submissions.length,2);assert.equal(submissions[1],before.taskId);
});

test('failed queued-audio cleanup is retried without requeueing or submitting its expired identity',async t=>{
 const entered=deferred(),release=deferred(),submissions=[],removals=[];
 let cleanupTask;
 const storage={key:id=>id,assertPrivateBeforeUpload:async()=>{},upload:async()=>{},signedReadUrl:async()=>'https://synthetic.invalid/audio',assertPrivateAndReadable:async()=>{},remove:async key=>{
  removals.push(key);if(key===cleanupTask&&removals.filter(value=>value===key).length===1)throw Error('synthetic storage cleanup failure');
 }};
 const env=await fixture(t,{providerKind:'standard',storage,provider:{
  submit:async({id})=>{submissions.push(id);throw new AsrProviderError('submit','timeout');},
  query:async()=>{entered.resolve();await release.promise;return {status:'processing'};},
 }},()=>release.resolve());
 const running=await env.submit('running');await entered.promise;
 const original=await env.read('running',running.id),queued=await env.submit('waiting'),before=await env.read('waiting',queued.id);
 cleanupTask=before.taskId;env.expire();await env.service.sweep();
 const pending=await env.read('waiting',queued.id);
 assert.equal(pending.status,'failed');assert.equal(pending.retentionExpired,true);assert.equal(pending.cleanupPending,true);
 assert.equal(pending.taskId,before.taskId);assert.equal(pending.submittedAtMs,undefined);await stat(env.audio('waiting',queued.id));
 assert.equal(env.service.diagnostics().occupancy.waiting,0);assert.equal(env.service.diagnostics().occupancy.workers,1);
 assert.deepEqual(removals,[before.taskId]);assert.deepEqual(submissions,[original.taskId]);
 const after=await assertExpired(env,'waiting',queued.id);
 assert.equal(after.cleanupPending,false);assert.equal(after.taskId,before.taskId);assert.equal(after.poolId,before.poolId);
 assert.deepEqual(removals,[before.taskId,before.taskId]);assert.deepEqual(submissions,[original.taskId]);
 await env.service.sweep();assert.equal(removals.length,2);assert.equal(env.service.diagnostics().occupancy.waiting,0);
});

test('shutdown waits for an already-started queued expiry cleanup before settling',async t=>{
 const cleanupEntered=deferred(),releaseCleanup=deferred(),submissions=[];
 let cleanupTask,blockCleanup=false;
 const storage={key:id=>id,assertPrivateBeforeUpload:async()=>{},upload:async()=>{},signedReadUrl:async()=>'https://synthetic.invalid/audio',assertPrivateAndReadable:async()=>{},remove:async key=>{
  if(blockCleanup&&key===cleanupTask){cleanupEntered.resolve();await releaseCleanup.promise;}
 }};
 const env=await fixture(t,{providerKind:'standard',storage,provider:{submit:async({id})=>{submissions.push(id);},query:async()=>({status:'silent'})}},()=>releaseCleanup.resolve());
 const original=await env.submit('original');await env.service.idle();await env.service.close();
 const originalSaved=await env.read('original',original.id),restarted=env.create({autoStart:false});await restarted.ready();
 const queued=await restarted.submit('waiting',randomUUID(),hash,'zh',Readable.from(bytes)),before=await env.read('waiting',queued.id);
 cleanupTask=before.taskId;blockCleanup=true;env.expire();
 const sweeping=restarted.sweep();await cleanupEntered.promise;
 let closed=false;const closing=restarted.close().then(()=>{closed=true;});
 await restarted.sweep();assert.equal(closed,false);
 const pending=await env.read('waiting',queued.id);
 assert.equal(pending.status,'failed');assert.equal(pending.retentionExpired,true);assert.equal(pending.cleanupPending,true);
 assert.equal(restarted.diagnostics().occupancy.workers,0);assert.equal(restarted.diagnostics().occupancy.waiting,0);
 assert.deepEqual(submissions,[originalSaved.taskId]);
 releaseCleanup.resolve();await Promise.all([sweeping,closing]);assert.equal(closed,true);
 const after=await env.read('waiting',queued.id);
 assert.equal(after.cleanupPending,false);assert.equal(after.taskId,before.taskId);assert.equal(after.submittedAtMs,undefined);
 await assert.rejects(stat(env.audio('waiting',queued.id)),{code:'ENOENT'});
 assert.deepEqual(submissions,[originalSaved.taskId]);assert.equal((await env.read('original',original.id)).taskId,originalSaved.taskId);
});

test('blocked expiry deletion leaves other account admission available but rejects an upload to its own key',{timeout:30_000},async t=>{
 const entered=deferred(),release=deferred();let calls=0;
 const storage={key:id=>id,assertPrivateBeforeUpload:async()=>{},upload:async()=>{},signedReadUrl:async()=>'https://synthetic.invalid/audio',assertPrivateAndReadable:async()=>{},remove:async()=>{entered.resolve();await release.promise;}};
 const env=await fixture(t,{providerKind:'standard',autoStart:false,storage,provider:{submit:async()=>{calls++;},query:async()=>({status:'silent'})}},()=>release.resolve());
 const queued=await env.submit('expiring'),before=await env.read('expiring',queued.id),audioBefore=await readFile(env.audio('expiring',queued.id));
 env.expire();const sweeping=env.service.sweep();await entered.promise;
 // The case deadline bounds a lock-regression deadlock; cleanup remains blocked until admission has completed.
 const independent=await env.submit('independent');assert.equal(independent.queued,true);
 const changed=Buffer.from('must not replace an expiring audio file');
 await assert.rejects(env.service.submit('expiring',queued.id,hash,'zh',Readable.from(changed)),{status:429,code:'upload_busy'});
 assert.deepEqual(await readFile(env.audio('expiring',queued.id)),audioBefore);
 assert.deepEqual(await readFile(env.audio('independent',independent.id)),bytes);
 assert.equal(env.service.diagnostics().occupancy.waiting,1);assert.equal(calls,0);
 release.resolve();await sweeping;
 const after=await assertExpired(env,'expiring',queued.id);
 assert.equal(after.cleanupPending,false);assert.equal(after.taskId,before.taskId);assert.equal(calls,0);
 assert.equal((await env.service.get('independent',independent.id)).queued,true);
});

test('concurrent receipt reads and a sweep share one in-flight expiry deletion',{timeout:30_000},async t=>{
 const entered=deferred(),release=deferred();let removals=0,calls=0;
 const storage={key:id=>id,assertPrivateBeforeUpload:async()=>{},upload:async()=>{},signedReadUrl:async()=>'https://synthetic.invalid/audio',assertPrivateAndReadable:async()=>{},remove:async()=>{removals++;entered.resolve();await release.promise;}};
 const env=await fixture(t,{providerKind:'standard',autoStart:false,storage,provider:{submit:async()=>{calls++;},query:async()=>({status:'silent'})}},()=>release.resolve());
 const queued=await env.submit('waiting');env.expire();
 const first=env.service.get('waiting',queued.id);await entered.promise;
 const second=env.service.get('waiting',queued.id),sweeping=env.service.sweep();
 const pending=await env.read('waiting',queued.id);assert.equal(pending.cleanupPending,true);assert.equal(removals,1);
 release.resolve();const [firstResult,secondResult]=await Promise.all([first,second,sweeping]);
 assert.equal(firstResult.status,'failed');assert.deepEqual(secondResult,firstResult);
 const after=await assertExpired(env,'waiting',queued.id);assert.equal(after.cleanupPending,false);
 assert.equal(removals,1);assert.equal(calls,0);assert.equal(env.service.diagnostics().occupancy.waiting,0);
});

test('shutdown waits for expiry cleanup owned only by a status read',{timeout:30_000},async t=>{
 const entered=deferred(),release=deferred();let removals=0;
 const storage={key:id=>id,assertPrivateBeforeUpload:async()=>{},upload:async()=>{},signedReadUrl:async()=>'https://synthetic.invalid/audio',assertPrivateAndReadable:async()=>{},remove:async()=>{removals++;entered.resolve();await release.promise;}};
 const env=await fixture(t,{providerKind:'standard',autoStart:false,storage,provider:{submit:async()=>{assert.fail('Expired work must not reach the provider');},query:async()=>({status:'silent'})}},()=>release.resolve());
 const queued=await env.submit('waiting');env.expire();
 const reading=env.service.get('waiting',queued.id);await entered.promise;
 let closed=false;const closing=env.service.close().then(()=>{closed=true;});
 await env.service.sweep();assert.equal(closed,false);
 assert.equal(env.service.diagnostics().occupancy.workers,0);assert.equal(env.service.diagnostics().occupancy.waiting,0);
 assert.equal((await env.read('waiting',queued.id)).cleanupPending,true);
 release.resolve();const [result]=await Promise.all([reading,closing]);
 assert.equal(result.status,'failed');assert.equal(closed,true);assert.equal(removals,1);
 assert.equal((await env.read('waiting',queued.id)).cleanupPending,false);
 await assert.rejects(stat(env.audio('waiting',queued.id)),{code:'ENOENT'});
});

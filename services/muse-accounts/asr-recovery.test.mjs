import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {mkdtemp,readdir,readFile,writeFile,rm,rename} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname,join} from 'node:path';
import {Readable} from 'node:stream';
import {createAsrService} from './asr-service.mjs';
import {AsrProviderError,recognizeFlashAsr,queryAsr,submitAsr} from './asr-provider.mjs';

const bytes=Buffer.from('synthetic audio'),hash=createHash('sha256').update(bytes).digest('hex'),deferred=()=>Promise.withResolvers();
const limits={providerKind:'flash',maxAudioBytes:1024,maxDurationSeconds:7200,maxDailySeconds:100000,maxDailyJobs:1000,maxActiveJobs:1,retentionSeconds:86400,maxQueuedJobs:50,probe:async()=>10};
async function receipts(root){return await Promise.all((await readdir(join(root,'jobs'))).filter(name=>name.endsWith('.json')).map(async name=>({name,job:JSON.parse(await readFile(join(root,'jobs',name),'utf8'))})));}
async function fixture(t,resources,quotaGroups,extra={}){
 const root=await mkdtemp(join(tmpdir(),'muse-asr-recovery-'));
 const settings={root,...limits,defaultPoolId:resources[0].poolId,resources,quotaGroups,...extra};
 const service=createAsrService(settings);t.after(async()=>{await service.close();await rm(root,{recursive:true,force:true});});
 return {root,settings,service,submit:(account,id=randomUUID(),purpose)=>service.submit(account,id,hash,'zh',Readable.from(bytes),purpose)};
}
function resource(poolId,recognize,extra={}){return {poolId,appId:'app-'+poolId,serviceVersion:'flash',quotaGroup:poolId,maxConcurrentJobs:1,provider:{recognize},...extra};}

test('shutdown reports a response persistence failure after its only provider request settles',async t=>{
 const root=await mkdtemp(join(tmpdir(),'muse-asr-close-ledger-')),entered=deferred(),release=deferred();let calls=0;
 const service=createAsrService({...limits,root,maxConcurrentJobs:1,provider:{recognize:async()=>{calls++;entered.resolve();await release.promise;return {status:'complete',segments:[{start:0,end:1,text:'original response'}]};}}});
 t.after(async()=>{release.resolve();await Promise.allSettled([service.close()]);await rm(root,{recursive:true,force:true});});
 await service.ready();await service.submit('alice',randomUUID(),hash,'zh',Readable.from(bytes));await entered.promise;
 const saved=join(root,'original-jobs');await rename(join(root,'jobs'),saved);await writeFile(join(root,'jobs'),'blocked ledger');
 const stopped=service.close();release.resolve();
 // The blocked ledger fails either its write or temporary-file cleanup, with platform-owned error codes.
 await assert.rejects(stopped,error=>['ENOTDIR','ENOENT'].includes(error.code)&&['open','lstat'].includes(error.syscall)&&typeof error.path==='string'&&dirname(error.path)===join(root,'jobs'));
 const [file]=await readdir(saved),job=JSON.parse(await readFile(join(saved,file),'utf8'));
 assert.equal(calls,1);assert.equal(job.status,'submitting');assert.ok(Number.isFinite(job.submittedAtMs));
});

test('shutdown reports an owned retention sweep failure after cleanup settles',async t=>{
 const root=await mkdtemp(join(tmpdir(),'muse-asr-close-sweep-'));
 const service=createAsrService({...limits,root,maxConcurrentJobs:1,provider:{recognize:async()=>({status:'silent'})}});
 t.after(async()=>{await service.close();await rm(root,{recursive:true,force:true});});
 await service.ready();await writeFile(join(root,'jobs','malformed.json'),'invalid json');
 const sweep=service.sweep(),stopped=service.close();
 await assert.rejects(sweep,SyntaxError);await assert.rejects(stopped,SyntaxError);
});

test('queued jobs use newly freed same-service applications instead of remaining pinned to a busy application',async t=>{
 const entered=[deferred(),deferred(),deferred()],release=[deferred(),deferred(),deferred()],calls=[];
 const resources=['first','second'].map(poolId=>resource(poolId,async input=>{const n=calls.length;calls.push({poolId,taskId:input.id});entered[n].resolve();await release[n].promise;return {status:'silent'};}));
 const env=await fixture(t,resources,resources.map(row=>({id:row.quotaGroup,maxConcurrentJobs:1})));
 try{
  const first=await env.submit('a');await entered[0].promise;await env.submit('b');await entered[1].promise;
  const queued=await env.submit('c'),before=(await receipts(env.root)).find(row=>row.job.id===queued.id).job;
  assert.equal(before.poolId,'first');assert.equal(before.status,'queued');assert.equal(before.submittedAtMs,undefined);
  release[1].resolve();await entered[2].promise;
  const after=(await receipts(env.root)).find(row=>row.job.id===queued.id).job;
  assert.equal(after.poolId,'second');assert.equal(after.taskId,before.taskId);assert.equal(after.hash,before.hash);assert.equal(after.reservedAtMs,before.reservedAtMs);assert.equal(after.day,before.day);
  assert.equal((await receipts(env.root)).find(row=>row.job.id===first.id).job.poolId,'first');assert.equal(calls[2].poolId,'second');
 }finally{release.forEach(row=>row.resolve());}
 await env.service.idle();assert.equal(calls.length,3);
});

test('an account can use idle Flash capacity while its standard queue is full and blocked',async t=>{
 const standardEntered=deferred(),standardRelease=deferred(),flashEntered=deferred(),flashRelease=deferred();let standardCalls=0,flashCalls=0;
 const resources=[resource('flash',async()=>{flashCalls++;flashEntered.resolve();await flashRelease.promise;return {status:'silent'};}),{poolId:'standard',appId:'app-standard',serviceVersion:'standard-v2',quotaGroup:'standard',maxConcurrentJobs:1,provider:{submit:async()=>{standardCalls++;},query:async()=>{standardEntered.resolve();await standardRelease.promise;return {status:'silent'};}}}];
 const storage={key:id=>id,assertPrivateBeforeUpload:async()=>{},upload:async()=>{},signedReadUrl:async()=>'https://signed.invalid/audio',assertPrivateAndReadable:async()=>{},remove:async()=>{}};
 const env=await fixture(t,resources,[{id:'flash',maxConcurrentJobs:1},{id:'standard',maxConcurrentJobs:1}],{providerKind:'standard',storage,maxConcurrentJobs:2,maxQueuedJobs:1,routes:{subtitles:'flash',screenplay:'standard-v2'}});
 try{
  await env.submit('same-account',randomUUID(),'screenplay');await standardEntered.promise;
  const blocked=await env.submit('same-account',randomUUID(),'screenplay');assert.equal(blocked.queued,true);
  const independent=await env.submit('same-account',randomUUID(),'subtitles');await flashEntered.promise;
  assert.equal(independent.queued,undefined);assert.equal(flashCalls,1);assert.equal(standardCalls,1);
  assert.equal(env.service.diagnostics().occupancy.workers,2);assert.equal(env.service.diagnostics().occupancy.waiting,1);
 }finally{standardRelease.resolve();flashRelease.resolve();}
 await env.service.idle();assert.equal(standardCalls,2);assert.equal(flashCalls,1);
});

test('reassignment cannot spend another shared group daily or rolling allowance',async t=>{
 for(const budget of [{maxDailyJobs:1},{rollingAudioWindowSeconds:1800,maxRollingAudioSeconds:10}]){
  const entered=[deferred(),deferred(),deferred()],release=[deferred(),deferred(),deferred()];let calls=0;
  const resources=['first','second'].map(poolId=>resource(poolId,async()=>{const n=calls++;entered[n].resolve();await release[n].promise;return {status:'silent'};}));
  const env=await fixture(t,resources,[{id:'first',maxConcurrentJobs:1},{id:'second',maxConcurrentJobs:1,...budget}]);
  try{await env.submit('a');await entered[0].promise;await env.submit('b');await entered[1].promise;const queued=await env.submit('c');release[1].resolve();await env.service.get('c',queued.id);assert.equal(calls,2);assert.equal((await env.service.get('c',queued.id)).queued,true);release[0].resolve();await entered[2].promise;assert.equal((await receipts(env.root)).find(row=>row.job.id===queued.id).job.poolId,'first');}
  finally{release.forEach(row=>row.resolve());await env.service.idle();}
 }
});

test('nine Flash services and shared standard services fill only forty explicitly granted slots',async t=>{
 const release=deferred(),entered=deferred(),calls=new Map();let total=0;
 const resources=[],quotaGroups=[];
 for(let index=0;index<9;index++){
  const group=index<2?'old-shared':'group-'+index;
  if(index!==1)quotaGroups.push({id:group,maxConcurrentJobs:5,submitQps:10,queryQps:10,rollingAudioWindowSeconds:1800,maxRollingAudioSeconds:1800000});
  for(const version of ['flash','standard-v2',...index<2?['standard-v1']:[]]){
   const poolId='pool-'+index+'-'+version;
   resources.push(resource(poolId,async()=>{calls.set(poolId,(calls.get(poolId)??0)+1);if(++total===40)entered.resolve();await release.promise;return {status:'silent'};},{appId:'app-'+index,serviceVersion:version,quotaGroup:group,maxConcurrentJobs:5,provider:{recognize:async()=>{calls.set(poolId,(calls.get(poolId)??0)+1);if(++total===40)entered.resolve();await release.promise;return {status:'silent'};},submit:async()=>{},query:async()=>({status:'silent'})}}));
  }
 }
 const storage={key:id=>id,assertPrivateBeforeUpload:async()=>{},upload:async()=>{},signedReadUrl:async()=>'https://signed.invalid/audio',assertPrivateAndReadable:async()=>{},remove:async()=>{}};
 const env=await fixture(t,resources,quotaGroups,{storage,routes:{subtitles:'flash',screenplay:'standard-v2'}});
 try{
  for(let i=0;i<40;i++)await env.submit('account-'+i,randomUUID(),'subtitles');await entered.promise;
  assert.equal(total,40);assert.equal(env.service.diagnostics().occupancy.workers,40);assert.equal(env.service.diagnostics().by_quota_group.find(row=>row.quota_group==='old-shared').workers,5);
  assert.ok(calls.get('pool-0-flash')>0);assert.ok(calls.get('pool-1-flash')>0);
  for(let index=2;index<9;index++)assert.equal(calls.get('pool-'+index+'-flash'),5);
  const queued=await env.submit('queued',randomUUID(),'screenplay');assert.equal(queued.queued,true);assert.equal(total,40);
 }finally{release.resolve();}
 await env.service.idle();assert.equal((await env.service.get('queued',(await receipts(env.root)).find(row=>row.job.account==='queued').job.id)).status,'silent');
});

test('restarted charged standard work retains its original application while unsubmitted work may rebalance',async t=>{
 const queried=deferred(),release=deferred();let submissions=0;const queryPools=[];
 const resources=['first','second'].map(poolId=>({poolId,appId:'app-'+poolId,serviceVersion:'standard-v2',quotaGroup:poolId,maxConcurrentJobs:1,provider:{submit:async()=>{submissions++;},query:async()=>{queryPools.push(poolId);queried.resolve();await release.promise;return {status:'silent'};}}}));
 const storage={key:id=>id,assertPrivateBeforeUpload:async()=>{},upload:async()=>{},signedReadUrl:async()=>'https://signed.invalid/audio',assertPrivateAndReadable:async()=>{},remove:async()=>{}};
 const env=await fixture(t,resources,resources.map(row=>({id:row.quotaGroup,maxConcurrentJobs:1})),{providerKind:'standard',storage});
 try{const first=await env.submit('alice');await queried.promise;const receipt=(await receipts(env.root)).find(row=>row.job.id===first.id).job;assert.equal(receipt.poolId,'first');const closing=env.service.close();release.resolve();await closing;const [saved]=await receipts(env.root);saved.job.status='uncertain';await writeFile(join(env.root,'jobs',saved.name),JSON.stringify(saved.job));const restarted=createAsrService({...env.settings,resources:[...resources].reverse()});await restarted.ready();await restarted.idle();await restarted.close();assert.deepEqual(queryPools,['first','first']);assert.equal(submissions,1);}
 finally{release.resolve();}
});

for(const [reason,fetcher] of Object.entries({timeout:async()=>{throw Object.assign(Error('private-secret'),{name:'TimeoutError'});},transport:async()=>{throw Error('private-secret');},http:async()=>new Response('private-secret',{status:503}),json:async()=>new Response('private-secret',{headers:{'X-Api-Status-Code':'20000000'}}),result:async()=>new Response('{}',{headers:{'X-Api-Status-Code':'20000000'}}),response:async()=>new Response('{}',{headers:{'X-Api-Status-Code':'45000001'}})})){
 test('ended Flash '+reason+' reports safe diagnostics and stops unsupported recovery',async t=>{
  let calls=0;const env=await fixture(t,[resource('first',input=>recognizeFlashAsr({appId:'synthetic',accessToken:'private-secret',timeoutMs:1000},input,async(...args)=>{calls++;return fetcher(...args);} ))],[{id:'first',maxConcurrentJobs:1}]);
  const job=await env.submit('alice');await env.service.idle();const result=await env.service.get('alice',job.id);assert.equal(result.status,'uncertain');assert.equal(result.service_version,'flash');assert.equal(result.provider_diagnostic.reason,reason);assert.deepEqual(result.recovery,{capability:'no_query',next_action:'inspect_receipt',automatic_resubmit:false});assert.doesNotMatch(JSON.stringify(result),/private-secret|appId|taskId|file|stack|accessToken/);await env.submit('alice',job.id);assert.equal(calls,1);
 });
}

test('running Flash waits for its original response and old missing diagnostic reasons remain unknown',async t=>{
 const entered=deferred(),release=deferred();const env=await fixture(t,[resource('first',async()=>{entered.resolve();await release.promise;throw Error('private upstream');})],[{id:'first',maxConcurrentJobs:1}]);
 try{const job=await env.submit('alice');await entered.promise;assert.equal((await env.service.get('alice',job.id)).recovery.next_action,'wait');release.resolve();await env.service.idle();const result=await env.service.get('alice',job.id);assert.equal(result.provider_diagnostic,undefined);assert.equal(result.recovery.next_action,'inspect_receipt');}
 finally{release.resolve();}
});

test('provider timeout reason is explicit for submit and query without retaining raw error text',async()=>{
 for(const invoke of [()=>submitAsr({appId:'a',accessToken:'b',timeoutMs:1000},{id:'id',url:'https://signed.invalid',language:'zh'},async()=>{throw Object.assign(Error('private'),{name:'TimeoutError'});}),()=>queryAsr({appId:'a',accessToken:'b',timeoutMs:1000},'id',async()=>{throw Object.assign(Error('private'),{name:'TimeoutError'});})])await assert.rejects(invoke(),error=>error instanceof AsrProviderError&&error.reason==='timeout'&&!String(error).includes('private'));
});

test('overlapping same-key uploads join the original admission and conflicting audio is rejected before billing',async t=>{
 const entered=deferred(),release=deferred();let calls=0;
 const env=await fixture(t,[resource('first',async()=>{calls++;return {status:'silent'};})],[{id:'first',maxConcurrentJobs:1}],{probe:async()=>{entered.resolve();await release.promise;return 10;}});
 const id=randomUUID(),first=env.submit('alice',id);await entered.promise;
 try{
  const replay=env.submit('alice',id);
  await assert.rejects(env.service.submit('alice',id,'a'.repeat(64),'zh',Readable.from(bytes)),{status:409,code:'idempotency_conflict'});
  release.resolve();assert.deepEqual(await replay,await first);await env.service.idle();assert.equal(calls,1);
 }finally{release.resolve();}
});

test('a server-confirmed pre-submit failure permits only a same-key upload recovery',async t=>{
 let submissions=0;
 const storage={key:id=>id,assertPrivateBeforeUpload:async()=>{throw Error('private storage failure');},upload:async()=>{},signedReadUrl:async()=>'https://signed.invalid/audio',assertPrivateAndReadable:async()=>{},remove:async()=>{}};
 const resources=[{poolId:'first',appId:'app-first',serviceVersion:'standard-v2',quotaGroup:'first',maxConcurrentJobs:1,provider:{submit:async()=>{submissions++;},query:async()=>({status:'silent'})}}];
 const env=await fixture(t,resources,[{id:'first',maxConcurrentJobs:1}],{providerKind:'standard',storage});
 const result=await env.submit('alice');await env.service.idle();const failed=await env.service.get('alice',result.id);
 assert.equal(failed.status,'failed');assert.equal(failed.recovery.next_action,'resume_upload');assert.equal(failed.recovery.automatic_resubmit,false);assert.equal(submissions,0);
});

test('a submitted Flash receipt cannot become billable again by relabeling it queued',async t=>{
 let calls=0;const env=await fixture(t,[resource('first',async()=>{calls++;return {status:'silent'};})],[{id:'first',maxConcurrentJobs:1}]);
 const job=await env.submit('alice');await env.service.idle();await env.service.close();const [saved]=await receipts(env.root);assert.ok(Number.isFinite(saved.job.submittedAtMs));saved.job.status='queued';await writeFile(join(env.root,'jobs',saved.name),JSON.stringify(saved.job));
 const restarted=createAsrService(env.settings);await restarted.ready();await restarted.idle();const result=await restarted.get('alice',job.id);assert.equal(result.status,'uncertain');assert.equal(result.recovery.next_action,'inspect_receipt');assert.equal(calls,1);assert.equal((await restarted.submit('alice',job.id,hash,'zh',Readable.from(bytes))).status,'uncertain');await restarted.close();
});

test('shutdown awaits an already-running retention cleanup and stops new sweeps',async t=>{
 const entered=deferred(),release=deferred();let block=false,removals=0;
 const storage={key:id=>id,assertPrivateBeforeUpload:async()=>{},upload:async()=>{},signedReadUrl:async()=>'https://signed.invalid/audio',assertPrivateAndReadable:async()=>{},remove:async()=>{removals++;if(block){entered.resolve();await release.promise;}}};
 const resources=[{poolId:'first',appId:'app-first',serviceVersion:'standard-v2',quotaGroup:'first',maxConcurrentJobs:1,provider:{submit:async()=>{},query:async()=>({status:'silent'})}}];
 const env=await fixture(t,resources,[{id:'first',maxConcurrentJobs:1}],{providerKind:'standard',storage});await env.submit('alice');await env.service.idle();const [saved]=await receipts(env.root);saved.job.cleanupPending=true;await writeFile(join(env.root,'jobs',saved.name),JSON.stringify(saved.job));block=true;
 const sweeping=env.service.sweep();await entered.promise;let closed=false;const closing=env.service.close().then(()=>{closed=true;});
 try{await env.service.sweep();assert.equal(closed,false);assert.equal(removals,2);}finally{release.resolve();}
 await sweeping;await closing;assert.equal(closed,true);assert.equal((await receipts(env.root))[0].job.cleanupPending,false);
});

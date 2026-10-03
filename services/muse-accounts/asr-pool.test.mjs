import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {mkdtemp,readdir,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Readable} from 'node:stream';
import {createAsrService,resolveAsrConfig} from './asr-service.mjs';
import {AsrProviderError} from './asr-provider.mjs';

const bytes=Buffer.from('fixture audio'),hash=createHash('sha256').update(bytes).digest('hex');
const deferred=()=>Promise.withResolvers();
const limits={providerKind:'flash',maxAudioBytes:1024,maxDurationSeconds:7200,maxDailySeconds:72000,maxDailyJobs:100,maxActiveJobs:1,retentionSeconds:86400,maxQueuedJobs:12,maxPendingUploadsPerAccount:4};
function pool(recognize,{shared=false,concurrency=1}={}){
 return {defaultPoolId:'old',legacyAppId:'fixture-app-0',resources:['old','new'].map((poolId,index)=>({poolId,appId:'fixture-app-'+index,quotaGroup:shared?'shared':poolId,maxConcurrentJobs:concurrency,provider:{recognize:input=>recognize(poolId,input),query:async()=>({status:'silent'})}})),quotaGroups:shared?[{id:'shared',maxConcurrentJobs:concurrency}]:['old','new'].map(id=>({id,maxConcurrentJobs:concurrency}))};
}
async function fixture(t,recognize,options={}){
 const root=await mkdtemp(join(tmpdir(),'muse-asr-pool-'));
 let service;
 t.after(async()=>{if(service)await service.idle();await rm(root,{recursive:true,force:true});});
 const settings={root,...limits,...pool(recognize,options),probe:async()=>10,...options.overrides};
 service=createAsrService(settings);
 return {root,settings,service,submit:(account='alice',id=randomUUID())=>service.submit(account,id,hash,'zh',Readable.from(bytes))};
}
async function receipts(root){
 const names=await readdir(join(root,'jobs'));
 return await Promise.all(names.filter(name=>name.endsWith('.json')).map(async name=>({name,job:JSON.parse(await readFile(join(root,'jobs',name),'utf8'))})));
}

test('independent declared quota groups execute concurrently and persist application ownership',async t=>{
 const release=deferred(),entered=deferred();const calls=[];
 const env=await fixture(t,async(poolId,input)=>{calls.push({poolId,id:input.id});if(calls.length===2)entered.resolve();await release.promise;return {status:'silent'};});
 try{
  await env.submit('alice');await env.submit('bob');await entered.promise;
  assert.deepEqual(calls.map(row=>row.poolId).sort(),['new','old']);
  const jobs=await receipts(env.root);assert.equal(jobs.length,2);
  for(const {job} of jobs){assert.ok(['old','new'].includes(job.poolId));assert.equal(job.appId,'fixture-app-'+(job.poolId==='old'?0:1));assert.equal(job.quotaGroup,job.poolId);}
 }finally{release.resolve();}
});

test('two applications sharing a quota group do not double its execution allowance',async t=>{
 const release=deferred(),entered=deferred();let calls=0;
 const env=await fixture(t,async()=>{calls++;entered.resolve();await release.promise;return {status:'silent'};},{shared:true});
 try{await env.submit('alice');await entered.promise;await env.submit('bob');assert.equal(calls,1);}
 finally{release.resolve();}
 await env.service.idle();assert.equal(calls,2);
});

test('accepted work alternates accounts while preserving each account order',async t=>{
 const releases=Array.from({length:4},deferred),entries=Array.from({length:4},deferred);const calls=[];
 const env=await fixture(t,async(_pool,input)=>{const index=calls.length;calls.push(input.id);entries[index].resolve();await releases[index].promise;return {status:'silent'};},{shared:true});
 try{
  const a1=await env.submit('alice');await entries[0].promise;
  await env.submit('alice');const a3=await env.submit('alice');const b1=await env.submit('bob');
  releases[0].resolve();await entries[1].promise;
  let jobs=await receipts(env.root);assert.equal(calls[1],jobs.find(row=>row.job.id===b1.id).job.taskId);
  releases[1].resolve();await entries[2].promise;
  releases[2].resolve();await entries[3].promise;
  jobs=await receipts(env.root);assert.equal(calls[0],jobs.find(row=>row.job.id===a1.id).job.taskId);assert.equal(calls[3],jobs.find(row=>row.job.id===a3.id).job.taskId);
 }finally{for(const release of releases)release.resolve();}
});

test('lost response stays on its original application through replay and restart',async t=>{
 const calls=[];const env=await fixture(t,async poolId=>{calls.push(poolId);throw Error('private upstream body');});
 const first=await env.submit();await env.service.idle();
 const saved=(await receipts(env.root))[0].job;
 assert.equal((await env.service.get('alice',first.id)).status,'uncertain');
 const restarted=createAsrService(env.settings);await restarted.ready();
 assert.equal((await restarted.submit('alice',first.id,hash,'zh',Readable.from(bytes))).status,'uncertain');
 assert.deepEqual(calls,[saved.poolId]);
 assert.ok(!JSON.stringify(await restarted.get('alice',first.id)).includes('private upstream body'));
});

test('restart rejects a missing application or changed application behind a durable pool ID',async t=>{
 const env=await fixture(t,async()=>({status:'silent'}));await env.submit();await env.service.idle();
 const [saved]=await receipts(env.root);const selected=saved.job.poolId;
 const missing=createAsrService({...env.settings,resources:env.settings.resources.filter(row=>row.poolId!==selected),defaultPoolId:selected==='old'?'new':'old',quotaGroups:env.settings.quotaGroups.filter(group=>group.id!==selected)});
 await assert.rejects(missing.ready(),/resource.*missing/i);
 const changed=createAsrService({...env.settings,resources:env.settings.resources.map(row=>row.poolId===selected?{...row,appId:'replacement-app'}:row)});
 await assert.rejects(changed.ready(),/application.*changed/i);
});

test('legacy receipts without a resource binding use only the explicit default application',async t=>{
 const calls=[];const env=await fixture(t,async(poolId)=>{calls.push(poolId);return {status:'silent'};});
 await env.submit();await env.service.idle();const [saved]=await receipts(env.root);
 delete saved.job.poolId;delete saved.job.appId;delete saved.job.quotaGroup;saved.job.status='queued';
 await writeFile(join(env.root,'jobs',saved.name),JSON.stringify(saved.job));
 await writeFile(join(env.root,'audio',createHash('sha256').update('alice\0'+saved.job.id).digest('hex')+'.mp3'),bytes);
 const restarted=createAsrService(env.settings);await restarted.ready();await restarted.idle();assert.equal(calls.at(-1),'old');
});

test('parallel admission from one account is serialized and preserves daily reservations',async t=>{
 const entered=deferred(),release=deferred();let probes=0,maxProbes=0,current=0;
 const env=await fixture(t,async()=>({status:'silent'}),{overrides:{maxDailyJobs:1,probe:async()=>{probes++;current++;maxProbes=Math.max(maxProbes,current);entered.resolve();await release.promise;current--;return 10;}}});
 const first=env.submit();await entered.promise;const second=env.submit();
 try{release.resolve();await first;await assert.rejects(second,{status:429,code:'daily_quota'});assert.equal(maxProbes,1);assert.equal(probes,2);}
 finally{release.resolve();}
});

test('queue capacity and bounded account admission report different retryable reasons',async t=>{
 const release=deferred(),entered=deferred();const env=await fixture(t,async()=>({status:'silent'}),{overrides:{maxPendingUploadsPerAccount:1,probe:async()=>{entered.resolve();await release.promise;return 10;}}});
 const first=env.submit();await entered.promise;
 try{await assert.rejects(env.submit(),{status:429,code:'upload_busy'});}
 finally{release.resolve();await first;}
 const running=deferred(),started=deferred();const full=await fixture(t,async()=>{started.resolve();await running.promise;return {status:'silent'};},{shared:true,overrides:{maxQueuedJobs:1}});
 try{await full.submit('alice');await started.promise;await full.submit('bob');await assert.rejects(full.submit('carol'),{status:429,code:'queue_full'});}
 finally{running.resolve();}
});

test('group daily allowance is reserved across accounts and selects another independently funded group',async t=>{
 const calls=[];const env=await fixture(t,async poolId=>{calls.push(poolId);return {status:'silent'};});
 env.settings.quotaGroups.forEach(group=>group.maxDailyJobs=1);
 // Construct after assigning the deployment's explicit shared billing ceilings.
 const service=createAsrService({...env.settings,root:join(env.root,'daily')});
 await service.submit('alice',randomUUID(),hash,'zh',Readable.from(bytes));await service.idle();
 await service.submit('bob',randomUUID(),hash,'zh',Readable.from(bytes));await service.idle();
 await assert.rejects(service.submit('carol',randomUUID(),hash,'zh',Readable.from(bytes)),{status:429,code:'daily_quota'});
 assert.deepEqual(calls.sort(),['new','old']);
});

test('configuration distinguishes shared applications from independent grants and never infers capacity from keys',()=>{
 const base={appId:'legacy-app',accessToken:'synthetic-token',root:join(tmpdir(),'muse-pool-config'),ffprobePath:'ffprobe',timeoutMs:1000,maxAudioBytes:1024,maxDurationSeconds:600,maxDailySeconds:1000,maxDailyJobs:10,maxActiveJobs:1,retentionSeconds:86400,sweepIntervalSeconds:60,providerKind:'flash'};
 const legacy=resolveAsrConfig(base);assert.equal(legacy.resources.length,1);assert.equal(legacy.defaultPoolId,'default');assert.equal(legacy.maxConcurrentJobs,5);
 const input={...base,appId:undefined,accessToken:undefined,...pool(async()=>({status:'silent'}),{concurrency:5})};
 input.resources=input.resources.map(row=>({...row,provider:undefined,accessToken:'synthetic-'+row.poolId}));
 assert.equal(resolveAsrConfig(input).maxConcurrentJobs,10);
 assert.throws(()=>resolveAsrConfig({...input,defaultPoolId:'missing'}),/configuration/);
 assert.throws(()=>resolveAsrConfig({...input,quotaGroups:[]}),/configuration/);
 assert.throws(()=>resolveAsrConfig({...input,resources:input.resources.map(row=>({...row,appId:'same-app'}))}),/configuration/);
 assert.throws(()=>resolveAsrConfig({...input,resources:input.resources.map(row=>({...row,accessToken:''}))}),/configuration/);
 assert.throws(()=>resolveAsrConfig({...input,resources:input.resources.map(row=>({...row,maxConcurrentJobs:0}))}),/configuration/);
 const padded=input.resources.map((row,index)=>({...row,appId:index?' same-app ':'same-app'}));
 assert.equal(new Headers({'X-Api-App-Key':padded[0].appId}).get('X-Api-App-Key'),new Headers({'X-Api-App-Key':padded[1].appId}).get('X-Api-App-Key'));
 assert.throws(()=>resolveAsrConfig({...input,resources:padded}),/configuration/);
});

test('two keys for one application retain one application capacity',async t=>{
 const entered=deferred(),release=deferred();let calls=0;
 const env=await fixture(t,async()=>{calls++;entered.resolve();await release.promise;return {status:'silent'};},{shared:true});
 const resources=env.settings.resources.map(resource=>({...resource,appId:'same-app'}));
 const service=createAsrService({...env.settings,root:join(env.root,'same-app'),resources,quotaGroups:[{id:'shared',maxConcurrentJobs:2}]});
 try{await service.submit('alice',randomUUID(),hash,'zh',Readable.from(bytes));await entered.promise;await service.submit('bob',randomUUID(),hash,'zh',Readable.from(bytes));assert.equal(calls,1);}
 finally{release.resolve();await service.idle();}
});

test('same UUID from different accounts still reserves shared billing allowance independently',async t=>{
 const env=await fixture(t,async()=>({status:'silent'}),{shared:true});
 const service=createAsrService({...env.settings,root:join(env.root,'shared-billing'),quotaGroups:[{id:'shared',maxConcurrentJobs:1,maxDailyJobs:1}]});
 const id=randomUUID();await service.submit('alice',id,hash,'zh',Readable.from(bytes));await service.idle();
 await assert.rejects(service.submit('bob',id,hash,'zh',Readable.from(bytes)),{status:429,code:'daily_quota'});
});

test('supplier refusal remains uncertain and writes only approved diagnostic fields',async t=>{
 const env=await fixture(t,async()=>{throw new AsrProviderError('flash','http',new Response('synthetic-secret-body',{status:429,headers:{'X-Api-Status-Code':'45000081'}}));});
 const job=await env.submit();await env.service.idle();const result=await env.service.get('alice',job.id),saved=(await receipts(env.root))[0].job;
 assert.equal(result.status,'uncertain');assert.equal(result.error_code,'provider_rejected');
 assert.deepEqual(saved.providerFailure,{code:'provider_rejected',operation:'flash',httpStatus:429,providerCode:'45000081'});
 assert.doesNotMatch(JSON.stringify({result,saved}),/synthetic-secret-body|accessToken|apiKey|stack|cause/);
 assert.equal(result.poolId,undefined);assert.equal(result.appId,undefined);assert.equal(result.quotaGroup,undefined);
});

test('restart validates all application bindings before changing any submitting receipt',async t=>{
 const env=await fixture(t,async()=>({status:'silent'}));await env.submit('alice');await env.submit('bob');await env.service.idle();
 const jobs=await receipts(env.root);jobs[0].job.status='submitting';jobs[1].job.poolId='missing';
 for(const row of jobs)await writeFile(join(env.root,'jobs',row.name),JSON.stringify(row.job));
 const before=await readFile(join(env.root,'jobs',jobs[0].name),'utf8');
 const service=createAsrService(env.settings);await assert.rejects(service.ready(),/resource.*missing/);
 assert.equal(await readFile(join(env.root,'jobs',jobs[0].name),'utf8'),before);
});

test('three independently declared five-slot grants run fifteen requests and keep the sixteenth queued',async t=>{
 const root=await mkdtemp(join(tmpdir(),'muse-asr-fifteen-')),release=deferred();let service;const counts=new Map(),entered=deferred();let total=0;
 t.after(async()=>{release.resolve();if(service)await service.idle();await rm(root,{recursive:true,force:true});});
 const resources=['default','second','third'].map(poolId=>({poolId,appId:'synthetic-'+poolId,quotaGroup:poolId,maxConcurrentJobs:5,provider:{recognize:async()=>{counts.set(poolId,(counts.get(poolId)??0)+1);if(++total===15)entered.resolve();await release.promise;return {status:'silent'};}}}));
 service=createAsrService({root,...limits,resources,quotaGroups:resources.map(row=>({id:row.quotaGroup,maxConcurrentJobs:5})),defaultPoolId:'default',probe:async()=>10});
 for(let index=0;index<15;index++)await service.submit('account-'+index,randomUUID(),hash,'zh',Readable.from(bytes));
 await entered.promise;assert.deepEqual([...counts.values()],[5,5,5]);
 const queued=await service.submit('last-account',randomUUID(),hash,'zh',Readable.from(bytes));assert.equal(queued.status,'processing');assert.equal(queued.queued,true);assert.equal(total,15);
 release.resolve();await service.idle();assert.equal(total,16);
});

test('standard unknown jobs query their original application after pool ordering changes',async t=>{
 const root=await mkdtemp(join(tmpdir(),'muse-asr-standard-pin-'));t.after(()=>rm(root,{recursive:true,force:true}));const queries=[];let submissions=0;
 const resources=['old','new'].map(poolId=>({poolId,appId:'app-'+poolId,quotaGroup:poolId,maxConcurrentJobs:1,provider:{submit:async()=>{submissions++;throw Error('lost response');},query:async()=>{queries.push(poolId);return {status:'silent'};}}}));
 const settings={root,...limits,providerKind:'standard',resources,quotaGroups:resources.map(row=>({id:row.quotaGroup,maxConcurrentJobs:1})),defaultPoolId:'old',probe:async()=>10,storage:{key:id=>id,assertPrivateBeforeUpload:async()=>{},upload:async()=>{},signedReadUrl:async()=>'https://signed.invalid/audio',assertPrivateAndReadable:async()=>{},remove:async()=>{}}};
 const service=createAsrService(settings),id=randomUUID();assert.equal((await service.submit('alice',id,hash,'zh',Readable.from(bytes))).status,'uncertain');
 const restarted=createAsrService({...settings,resources:[...resources].reverse()});await restarted.ready();assert.equal((await restarted.get('alice',id)).status,'silent');assert.deepEqual(queries,['old']);assert.equal(submissions,1);
});

test('legacy migration requires the original application and leaves mismatched receipts unchanged',async t=>{
 const env=await fixture(t,async()=>({status:'silent'}));await env.submit();await env.service.idle();const [saved]=await receipts(env.root);
 delete saved.job.poolId;delete saved.job.appId;delete saved.job.quotaGroup;saved.job.status='uncertain';
 await writeFile(join(env.root,'jobs',saved.name),JSON.stringify(saved.job));const before=await readFile(join(env.root,'jobs',saved.name),'utf8');
 const missing=createAsrService({...env.settings,legacyAppId:undefined});await assert.rejects(missing.ready(),/legacy.*application/i);
 const changed=createAsrService({...env.settings,legacyAppId:'fixture-app-0',defaultPoolId:'new'});await assert.rejects(changed.ready(),/legacy.*application/i);
 assert.equal(await readFile(join(env.root,'jobs',saved.name),'utf8'),before);
});

test('migration pins complete and uncertain legacy receipts before the default can change',async t=>{
 const env=await fixture(t,async()=>({status:'silent'}));await env.submit('alice');await env.submit('bob');await env.service.idle();
 const jobs=await receipts(env.root);
 for(const [index,row] of jobs.entries()){delete row.job.poolId;delete row.job.appId;delete row.job.quotaGroup;delete row.job.providerKind;row.job.status=index===0?'complete':'uncertain';await writeFile(join(env.root,'jobs',row.name),JSON.stringify(row.job));}
 const migrated=createAsrService({...env.settings,legacyAppId:'fixture-app-0'});await migrated.ready();
 for(const {job} of await receipts(env.root)){assert.equal(job.poolId,'old');assert.equal(job.appId,'fixture-app-0');}
 const calls=[];
 const restarted=createAsrService({...env.settings,defaultPoolId:'new',legacyAppId:undefined,resources:env.settings.resources.map(resource=>({...resource,provider:{...resource.provider,query:async()=>{calls.push(resource.poolId);return {status:'silent'};}}}))});
 await restarted.ready();assert.equal((await restarted.get(jobs[1].job.account,jobs[1].job.id)).status,'silent');assert.deepEqual(calls,['old']);
});

test('a free application in a saturated shared group cannot hide an available independent group',async t=>{
 const root=await mkdtemp(join(tmpdir(),'muse-asr-available-')),release=deferred();let service;
 t.after(async()=>{release.resolve();if(service)await service.idle();await rm(root,{recursive:true,force:true});});
 const resources=['first','shared','independent'].map(poolId=>({poolId,appId:'app-'+poolId,quotaGroup:poolId==='independent'?'independent':'shared',maxConcurrentJobs:1,provider:{recognize:async()=>{await release.promise;return {status:'silent'};}}}));
 service=createAsrService({root,...limits,resources,quotaGroups:[{id:'shared',maxConcurrentJobs:1},{id:'independent',maxConcurrentJobs:1}],defaultPoolId:'first',probe:async()=>10});
 await service.submit('alice',randomUUID(),hash,'zh',Readable.from(bytes));
 const second=await service.submit('bob',randomUUID(),hash,'zh',Readable.from(bytes));
 assert.notEqual((await service.get('bob',second.id)).queued,true);
 const jobs=await receipts(root);assert.equal(jobs.find(row=>row.job.id===second.id).job.poolId,'independent');
});

test('waiting capacity stays bounded when another independent group has exhausted its daily allowance',async t=>{
 const root=await mkdtemp(join(tmpdir(),'muse-asr-real-waiting-')),release=deferred();let service;
 t.after(async()=>{release.resolve();if(service)await service.idle();await rm(root,{recursive:true,force:true});});
 const resources=['old','exhausted'].map(poolId=>({poolId,appId:'app-'+poolId,quotaGroup:poolId,maxConcurrentJobs:1,provider:{recognize:async()=>{if(poolId==='old')await release.promise;return {status:'silent'};}}}));
 const groups=[{id:'old',maxConcurrentJobs:1},{id:'exhausted',maxConcurrentJobs:1,maxDailyJobs:1}];
 const seed=createAsrService({root,...limits,resources:[resources[1]],quotaGroups:[groups[1]],defaultPoolId:'exhausted',probe:async()=>10});
 await seed.submit('seed',randomUUID(),hash,'zh',Readable.from(bytes));await seed.idle();
 service=createAsrService({root,...limits,maxQueuedJobs:1,resources,quotaGroups:groups,defaultPoolId:'old',probe:async()=>10});
 await service.submit('alice',randomUUID(),hash,'zh',Readable.from(bytes));await service.submit('bob',randomUUID(),hash,'zh',Readable.from(bytes));
 await assert.rejects(service.submit('carol',randomUUID(),hash,'zh',Readable.from(bytes)),{status:429,code:'queue_full'});
});

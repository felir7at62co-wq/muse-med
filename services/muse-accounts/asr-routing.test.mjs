import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {mkdtemp,readFile,readdir,rm,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Readable} from 'node:stream';
import {resolveAsrResources} from './asr-resources.mjs';
import {createAsrService,resolveAsrConfig} from './asr-service.mjs';
import {submitAsr,queryAsr} from './asr-provider.mjs';

const bytes=Buffer.from('synthetic audio'),hash=createHash('sha256').update(bytes).digest('hex');
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
const resourceIds={flash:'volc.bigasr.auc_turbo','standard-v1':'volc.bigasr.auc','standard-v2':'volc.seedasr.auc'};
const storage={key:id=>id+'.mp3',assertPrivateBeforeUpload:async()=>{},upload:async()=>{},signedReadUrl:async()=> 'https://synthetic.invalid/audio',assertPrivateAndReadable:async()=>{},remove:async()=>{}};
async function ledger(root){return await Promise.all((await readdir(join(root,'jobs'))).filter(name=>name.endsWith('.json')).map(async name=>JSON.parse(await readFile(join(root,'jobs',name),'utf8'))));}
function declaration(provider){return {
 providerKind:'flash',defaultPoolId:'old-flash',legacyAppId:'old-app',routes:{subtitles:'flash',screenplay:'standard-v2'},
 resources:['old','second','third'].flatMap(app=>Object.entries(resourceIds).map(([serviceVersion,resourceId])=>({poolId:app+'-'+serviceVersion,appId:app+'-app',serviceVersion,resourceId,quotaGroup:serviceVersion==='flash'?app+'-flash':'standard-shared',maxConcurrentJobs:5,provider:provider(app,serviceVersion)}))),
 quotaGroups:[...['old','second','third'].map(app=>({id:app+'-flash',maxConcurrentJobs:5})),{id:'standard-shared',maxConcurrentJobs:5,submitQps:10}],
 };}
async function fixture(t,provider,extra={}){
 const root=await mkdtemp(join(tmpdir(),'muse-asr-route-'));
 const config={root,storage,...declaration(provider),probe:async()=>10,maxAudioBytes:1024,maxDurationSeconds:7200,maxDailySeconds:180000,maxDailyJobs:1000,maxActiveJobs:1,maxQueuedJobs:30,maxPendingUploadsPerAccount:4,retentionSeconds:86400,pollIntervalMs:10,...extra};
 const service=createAsrService(config);t.after(async()=>{await service.close?.();await rm(root,{recursive:true,force:true});});await service.ready();
 return {root,service,config,submit:(purpose,account='alice',id=randomUUID())=>service.submit(account,id,hash,'zh',Readable.from(bytes),purpose)};
}

test('three applications expose nine services without multiplying the shared standard grant',()=>{
 const config=resolveAsrResources(declaration(()=>({recognize:async()=>{},submit:async()=>{},query:async()=>{}})));
 assert.equal(config.resources.length,9);assert.equal(config.maxConcurrentJobs,20);
 assert.deepEqual(config.routes,{subtitles:'flash',screenplay:'standard-v2'});
 const shared={...declaration(()=>({})),resources:declaration(()=>({})).resources.map(row=>row.serviceVersion==='flash'?row:{...row,maxConcurrentJobs:20})};
 assert.equal(resolveAsrResources(shared).maxConcurrentJobs,20);
 assert.throws(()=>resolveAsrResources({...shared,quotaGroups:shared.quotaGroups.map(row=>row.id==='standard-shared'?{...row,submitQps:21}:row)}),/configuration/);
});

test('standard 2.0 uses the v3 endpoints and its exact resource without changing the request model',async()=>{
 const requests=[],fetcher=async(url,init)=>{requests.push({url,init});return new Response(JSON.stringify({result:{utterances:[{start_time:0,end_time:1000,text:'hello'}]}}),{headers:{'X-Api-Status-Code':'20000000'}});};
 const config={appId:'synthetic',accessToken:'synthetic',timeoutMs:1000,resourceId:resourceIds['standard-v2']};
 await submitAsr(config,{id:randomUUID(),url:'https://synthetic.invalid/audio',language:'auto'},fetcher);await queryAsr(config,randomUUID(),fetcher);
 assert.deepEqual(requests.map(row=>row.init.headers['X-Api-Resource-Id']),[resourceIds['standard-v2'],resourceIds['standard-v2']]);
 assert.match(requests[0].url,/\/api\/v3\/auc\/bigmodel\/submit$/);assert.match(requests[1].url,/\/api\/v3\/auc\/bigmodel\/query$/);
 assert.equal(JSON.parse(requests[0].init.body).request.model_name,'bigmodel');
});

test('purpose routes pin service and application; changing purpose under the same key is rejected',async t=>{
 const queried=deferred(),release=deferred(),calls=[];
 const env=await fixture(t,(app,version)=>({recognize:async()=>{calls.push(version);return {status:'silent'};},submit:async()=>{calls.push(version);},query:async()=>{queried.resolve();await release.promise;return {status:'silent'};}}));
 try{
  const subtitle=await env.submit('subtitles');const screenplay=await env.submit('screenplay');await queried.promise;
  const jobs=await ledger(env.root);assert.equal(jobs.find(row=>row.id===subtitle.id).resourceId,resourceIds.flash);
  assert.equal(jobs.find(row=>row.id===screenplay.id).serviceVersion,'standard-v2');assert.equal(screenplay.purpose,'screenplay');
  await assert.rejects(env.submit('subtitles','alice',screenplay.id),{status:409,code:'idempotency_conflict'});
  await assert.rejects(env.submit(undefined,'alice',screenplay.id),{status:409});assert.ok(calls.includes('standard-v2'));assert.ok(calls.includes('flash'));
 }finally{release.resolve();}
});

test('standard jobs retain their worker until completion and queued accounts share capacity fairly',async t=>{
 const entered=[deferred(),deferred()],release=[deferred(),deferred()],calls=[];
 const config=declaration(()=>({}));config.quotaGroups=config.quotaGroups.map(group=>group.id==='standard-shared'?{...group,maxConcurrentJobs:1}:group);
 const env=await fixture(t,(app,version)=>({recognize:async()=>({status:'silent'}),submit:async()=>{calls.push({app,version});},query:async()=>{const index=calls.length-1;entered[index].resolve();await release[index].promise;return {status:'silent'};}}),{quotaGroups:config.quotaGroups});
 try{
  await env.submit('screenplay','alice');await entered[0].promise;
  const second=await env.submit('screenplay','bob');assert.equal(second.queued,true);assert.equal(calls.length,1);
  release[0].resolve();await entered[1].promise;assert.equal(calls.length,2);release[1].resolve();await env.service.idle();
  assert.equal((await env.service.get('bob',second.id)).status,'silent');
 }finally{for(const gate of release)gate.resolve();}
});

test('omitted purpose preserves the default flash route while explicit screenplay can select standard 1.0',async t=>{
 const calls=[];const env=await fixture(t,(app,version)=>({recognize:async()=>{calls.push(version);return {status:'silent'};},submit:async()=>{calls.push(version);},query:async()=>({status:'silent'})}),{routes:{subtitles:'flash',screenplay:'standard-v1'}});
 const old=await env.submit(undefined),script=await env.submit('screenplay');await env.service.idle();
 assert.equal(old.purpose,undefined);assert.equal(old.service_version,undefined);assert.equal(script.service_version,'standard-v1');assert.deepEqual(calls,['flash','standard-v1']);
 await assert.rejects(env.submit('subtitles','alice',old.id),{status:409});
});

test('restart queries an unknown standard 2.0 task on its original app and version without resubmission',async t=>{
 const entered=deferred(),release=deferred();let submits=0,resuming=false;const queryCalls=[];
 const env=await fixture(t,(app,version)=>({recognize:async()=>({status:'silent'}),submit:async()=>{submits++;throw Error('synthetic secret body');},query:async id=>{queryCalls.push({app,version,id});entered.resolve();await release.promise;return {status:resuming?'silent':'processing'};}}));
 const task=await env.submit('screenplay');await entered.promise;const original=(await ledger(env.root))[0];
 release.resolve();await env.service.close();resuming=true;
 const restarted=createAsrService({...env.config,resources:[...env.config.resources].reverse(),routes:{subtitles:'flash',screenplay:'standard-v1'},defaultPoolId:'second-flash'});t.after(()=>restarted.close());
 await restarted.ready();await restarted.idle();
 assert.equal((await restarted.get('alice',task.id)).status,'silent');assert.equal(submits,1);assert.ok(queryCalls.length>=2);
 assert.ok(queryCalls.every(row=>row.version==='standard-v2'&&row.app+'-app'===original.appId&&row.id===original.taskId));
 assert.doesNotMatch(JSON.stringify(await restarted.get('alice',task.id)),/synthetic secret|appId|resourceId|quotaGroup|poolId/);
});

test('standard unknown queries hold capacity; a full queue still permits replay of its original key',async t=>{
 const entered=deferred(),release=deferred();let submits=0;
 const groups=declaration(()=>({})).quotaGroups.map(group=>group.id==='standard-shared'?{...group,maxConcurrentJobs:1}:group);
 const env=await fixture(t,()=>({recognize:async()=>({status:'silent'}),submit:async()=>{submits++;throw Error('unknown submit');},query:async()=>{entered.resolve();await release.promise;return {status:'silent'};}}),{quotaGroups:groups,maxQueuedJobs:1});
 try{
  const first=await env.submit('screenplay','alice');await entered.promise;
  const second=await env.submit('screenplay','bob');assert.equal(second.queued,true);
  await assert.rejects(env.submit('screenplay','carol'),{status:429,code:'queue_full'});
  assert.equal((await env.submit('screenplay','alice',first.id)).status,'uncertain');assert.equal(submits,1);
  assert.equal((await ledger(env.root)).length,2);release.resolve();await env.service.idle();assert.equal(submits,2);
 }finally{release.resolve();}
});

test('queued standard audio survives restart and is submitted once after its storage endpoint starts',async t=>{
 let submits=0;const env=await fixture(t,()=>({recognize:async()=>({status:'silent'}),submit:async()=>{submits++;},query:async()=>({status:'silent'})}),{autoStart:false});
 const job=await env.submit('screenplay');assert.equal(job.queued,true);await env.service.close();assert.equal(submits,0);
 const restarted=createAsrService({...env.config,autoStart:false});t.after(()=>restarted.close());await restarted.ready();assert.equal(submits,0);
 await restarted.start();await restarted.idle();assert.equal(submits,1);assert.equal((await restarted.get('alice',job.id)).status,'silent');
 assert.deepEqual(await readdir(join(env.root,'audio')),[]);
});

test('closing waits for an owned query when an overlapping upload is rejected during shutdown',async t=>{
 const querying=deferred(),queryRelease=deferred(),probing=deferred(),probeRelease=deferred();let probes=0;
 const env=await fixture(t,()=>({recognize:async()=>({status:'silent'}),submit:async()=>{},query:async()=>{querying.resolve();await queryRelease.promise;return {status:'silent'};}}),{probe:async()=>{if(++probes>1){probing.resolve();await probeRelease.promise;}return 10;}});
 try{
  await env.submit('screenplay','alice');await querying.promise;
  const upload=env.submit('screenplay','bob');await probing.promise;
  let closeSettled=false;const closing=env.service.close();const observed=closing.then(()=>{closeSettled=true;},error=>{closeSettled=true;throw error;});observed.catch(()=>{});
  probeRelease.resolve();await assert.rejects(upload,{status:503});await new Promise(setImmediate);assert.equal(closeSettled,false);
  queryRelease.resolve();await observed;assert.equal(closeSettled,true);
 }finally{probeRelease.resolve();queryRelease.resolve();}
});

test('standard receipts reject changed service IDs before recovery or migration writes',async t=>{
 const env=await fixture(t,()=>({recognize:async()=>({status:'silent'}),submit:async()=>{},query:async()=>({status:'silent'})}));
 await env.submit('screenplay');await env.service.idle();await env.service.close();
 const [name]=await readdir(join(env.root,'jobs')),before=await readFile(join(env.root,'jobs',name),'utf8');
 const selected=JSON.parse(before).poolId;
 const changed=createAsrService({...env.config,resources:env.config.resources.map(row=>row.poolId===selected?{...row,serviceVersion:'standard-v1',resourceId:resourceIds['standard-v1']}:row)});
 await assert.rejects(changed.ready(),/service version.*changed/);assert.equal(await readFile(join(env.root,'jobs',name),'utf8'),before);
});

test('rolling audio allowance is shared across standard versions and UTC midnight without charging a refusal',async t=>{
 let clock=Date.UTC(2026,9,3,23,59,55),submits=0;
 const groups=declaration(()=>({})).quotaGroups.map(group=>group.id==='standard-shared'?{...group,rollingAudioWindowSeconds:1800,maxRollingAudioSeconds:15}:group);
 const env=await fixture(t,()=>({recognize:async()=>({status:'silent'}),submit:async()=>{submits++;},query:async()=>({status:'silent'})}),{quotaGroups:groups,now:()=>clock});
 await env.submit('screenplay','alice');await env.service.idle();clock+=10000;
 await assert.rejects(env.submit('screenplay','bob'),{status:429,code:'provider_rate'});assert.equal((await ledger(env.root)).length,1);
 await env.submit('subtitles','bob');await env.service.idle();assert.equal(submits,1);
 clock+=1800000;await env.submit('screenplay','bob');await env.service.idle();assert.equal(submits,2);
 assert.ok((await ledger(env.root)).filter(row=>row.serviceVersion!=='flash').every(row=>Number.isSafeInteger(row.reservedAtMs)));
});

test('standard submit frequency is distinct from the shared in-flight job limit',async t=>{
 const stamps=[];const env=await fixture(t,()=>({recognize:async()=>({status:'silent'}),submit:async()=>{stamps.push(performance.now());},query:async()=>({status:'silent'})}));
 await Promise.all(['alice','bob','carol'].map(account=>env.submit('screenplay',account)));await env.service.idle();
 assert.equal(stamps.length,3);assert.ok(stamps[1]-stamps[0]>=90);assert.ok(stamps[2]-stamps[1]>=90);
});

test('legacy receipt migration retains provider kind and does not invent a purpose',async t=>{
 const env=await fixture(t,()=>({recognize:async()=>({status:'silent'}),submit:async()=>{},query:async()=>({status:'silent'})}));await env.submit(undefined);await env.service.idle();await env.service.close();
 const [name]=await readdir(join(env.root,'jobs')),file=join(env.root,'jobs',name),receipt=JSON.parse(await readFile(file,'utf8'));
 for(const key of ['poolId','appId','quotaGroup','resourceId','serviceVersion'])delete receipt[key];await writeFile(file,JSON.stringify(receipt));
 const restarted=createAsrService(env.config);t.after(()=>restarted.close());await restarted.ready();const saved=JSON.parse(await readFile(file,'utf8'));
 assert.equal(saved.providerKind,'flash');assert.equal(saved.purpose,undefined);assert.equal(saved.resourceId,resourceIds.flash);
 for(const [key,value] of Object.entries(receipt))assert.deepEqual(saved[key],value);
});

test('gateway download signatures cover processing and retained audio without exceeding seven days',()=>{
 const input={...declaration(()=>({})),resources:declaration(()=>({})).resources.map(row=>({...row,accessToken:'synthetic'})),root:join(tmpdir(),'synthetic-jobs'),ffprobePath:'ffprobe',timeoutMs:180000,maxAudioBytes:100000000,maxDurationSeconds:7200,maxDailySeconds:180000,maxDailyJobs:1000,maxActiveJobs:1,retentionSeconds:86400,sweepIntervalSeconds:60,storageKind:'gateway',signedUrlTtlSeconds:86400,gatewayStorage:{root:join(tmpdir(),'synthetic-private-audio'),baseURL:'https://synthetic.invalid/api/asr/audio/',secret:'synthetic'.repeat(8)}};
 assert.equal(resolveAsrConfig(input).retentionSeconds,86400);
 for(const gatewayStorage of [{...input.gatewayStorage,baseURL:'http://synthetic.invalid/api/asr/audio/'},{...input.gatewayStorage,root:input.root},{...input.gatewayStorage,secret:'short'}])assert.throws(()=>resolveAsrConfig({...input,gatewayStorage}),/configuration/);
 assert.equal(resolveAsrConfig({...input,signedUrlTtlSeconds:604800}).signedUrlTtlSeconds,604800);
 for(const signedUrlTtlSeconds of [3600,10799,86399,604801])assert.throws(()=>resolveAsrConfig({...input,signedUrlTtlSeconds}),/configuration/);
});

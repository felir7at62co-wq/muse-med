import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {mkdtemp,readFile,readdir,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Readable} from 'node:stream';
import {setImmediate as immediate} from 'node:timers/promises';
import {AsrProviderError,queryAsr} from './asr-provider.mjs';
import {createAsrService,resolveAsrConfig} from './asr-service.mjs';
import {createAccountServer} from './gateway.mjs';
import {openStore} from './store.mjs';

const audio=Buffer.from('synthetic query-recovery audio'),hash=createHash('sha256').update(audio).digest('hex');
const storage={key:id=>id,assertPrivateBeforeUpload:async()=>{},upload:async()=>{},signedReadUrl:async()=>'https://signed.invalid/audio',assertPrivateAndReadable:async()=>{},remove:async()=>{}};
const limits={storage,probe:async()=>10,maxAudioBytes:1024,maxDurationSeconds:600,maxDailySeconds:72000,maxDailyJobs:100,maxActiveJobs:1,retentionSeconds:86400,maxConcurrentJobs:2,pollIntervalMs:20,queryBackoffMaxMs:80,queryBlockedRetryMs:200};
const limited=(quota='qps',retry='1')=>new AsrProviderError('query','http',new Response('private-body',{status:429,headers:{'X-Api-Status-Code':'45000292','X-Api-Message':'quota exceeded for types: '+quota,'Retry-After':retry}}));

async function receipt(root,id){for(const name of await readdir(join(root,'jobs'))){const path=join(root,'jobs',name),job=JSON.parse(await readFile(path,'utf8'));if(job.id===id)return {path,job};}assert.fail('Missing receipt');}
async function until(predicate){const deadline=performance.now()+5000;while(performance.now()<deadline){const result=await predicate();if(result)return result;await immediate();}assert.fail('Expected durable query transition');}
async function fixture(t,query,extra={}){
 const root=await mkdtemp(join(tmpdir(),'muse-asr-query-retry-'));let submissions=0;
 const settings={root,...limits,provider:{submit:async()=>{submissions++;},query},...extra};
 const service=createAsrService(settings);t.after(async()=>{await service.close();await rm(root,{recursive:true,force:true});});
 return {root,settings,service,submissions:()=>submissions,submit:(account,id=randomUUID())=>service.submit(account,id,hash,'zh',Readable.from(audio))};
}

test('query quota diagnostics retain only known types and numeric Retry-After seconds',async()=>{
 for(const quota of ['qps','concurrency','audio_duration_lifetime','text_words_lifetime','tokens_lifetime']){
  const error=limited(quota,'60');assert.equal(error.quotaType,quota);assert.equal(error.retryAfterSeconds,60);
  assert.doesNotMatch(JSON.stringify(error),/private-body|quota exceeded/);
 }
 for(const quota of ['private-token','qps private-token','qps\nprivate-token']){
  const error=new AsrProviderError('query','http',{status:429,headers:new Map([['X-Api-Message','quota exceeded for types: '+quota]])});assert.equal(error.quotaType,undefined);assert.doesNotMatch(JSON.stringify(error),/private-token/);
 }
 for(const retry of ['0','-1','1.5','86401','private-token','Mon, 26 Oct 2026 00:00:00 GMT'])assert.equal(limited('qps',retry).retryAfterSeconds,undefined);
 const response=new Response('{}',{status:429,headers:{'X-Api-Status-Code':'45000292'}});
 await assert.rejects(queryAsr({timeoutMs:1000},'original-task',async()=>response),error=>error.providerCode==='45000292'&&error.quotaType===undefined);
});

test('supplier query cooldown survives restart and cached receipt reads never resubmit or query',async t=>{
 let queries=0;const queriedIds=[],times=[];
 const env=await fixture(t,async id=>{queriedIds.push(id);times.push(Date.now());if(++queries===1)throw limited();return {status:'silent'};});
 const created=await env.submit('alice');
 await until(async()=>((await env.service.get('alice',created.id)).recovery.retry_after??0)>0);
 const before=await receipt(env.root,created.id);
 assert.equal(before.job.queryRetry.count,1);assert.equal(before.job.providerFailure.quotaType,'qps');
 for(let read=0;read<20;read++){
  const cached=await env.service.get('alice',created.id);assert.equal(cached.status,'uncertain');assert.equal(cached.provider_diagnostic.quota_type,'qps');assert.equal(cached.recovery.retry_after,1);
 }
 assert.equal(queries,1);await env.service.close();
 const restarted=createAsrService(env.settings);t.after(()=>restarted.close());await restarted.ready();
 assert.equal(queries,1);assert.equal((await restarted.get('alice',created.id)).recovery.retry_after,1);
 await restarted.idle();const after=await receipt(env.root,created.id);
 assert.equal(after.job.taskId,before.job.taskId);assert.equal(after.job.poolId,before.job.poolId);assert.equal(after.job.submittedAtMs,before.job.submittedAtMs);assert.equal(after.job.hash,before.job.hash);
 assert.equal(env.submissions(),1);assert.deepEqual(queriedIds,[before.job.taskId,before.job.taskId]);
 assert.ok(times[1]>=before.job.queryRetry.nextAttemptAtMs);assert.equal(after.job.queryRetry,undefined);assert.equal(after.job.providerFailure,undefined);
 assert.deepEqual((await restarted.get('alice',created.id)).recovery,{capability:'none',next_action:'use_result',automatic_resubmit:false});
});

test('an upstream 429 delays other original tasks sharing its declared quota group',async t=>{
 let queries=0;const times=[];
 const env=await fixture(t,async()=>{times.push(Date.now());if(++queries===1)throw limited();return {status:'silent'};});
 const first=await env.submit('alice');await until(async()=>((await env.service.get('alice',first.id)).recovery.retry_after??0)>0);
 const saved=await receipt(env.root,first.id);await env.submit('bob');assert.equal(queries,1);
 await env.service.idle();assert.equal(queries,3);assert.equal(env.submissions(),2);
 assert.ok(times.slice(1).every(value=>value>=saved.job.queryRetry.nextAttemptAtMs));
});

test('one unavailable task does not delay another task behind its private retry deadline',async t=>{
 let firstId;const queried=[],env=await fixture(t,async id=>{queried.push(id);if(firstId===undefined){firstId=id;throw new AsrProviderError('query','http',new Response('',{status:503,headers:{'Retry-After':'1'}}));}return {status:'silent'};});
 const first=await env.submit('alice');await until(async()=>((await env.service.get('alice',first.id)).recovery.retry_after??0)>0);
 const second=await env.submit('bob');await until(async()=>(await env.service.get('bob',second.id)).status==='silent');
 assert.equal(queried.length,2);assert.notEqual(queried[1],firstId);await env.service.idle();assert.deepEqual(queried,[firstId,queried[1],firstId]);
});

for(const quota of ['audio_duration_lifetime','unrecognized_private_value'])test('one application '+quota+' limit leaves another application in its shared group usable',async t=>{
 let exhaustedQueries=0,healthyQueries=0;
 const resources=[{poolId:'exhausted',appId:'exhausted-app',quotaGroup:'shared',serviceVersion:'standard-v2',maxConcurrentJobs:1,provider:{submit:async()=>{},query:async()=>{exhaustedQueries++;throw limited(quota,quota==='audio_duration_lifetime'?'0':'10');}}},{poolId:'healthy',appId:'healthy-app',quotaGroup:'shared',serviceVersion:'standard-v2',maxConcurrentJobs:1,provider:{submit:async()=>{},query:async()=>{healthyQueries++;return {status:'silent'};}}}];
 const env=await fixture(t,async()=>assert.fail('A pooled task must retain its selected application'),{resources,defaultPoolId:'exhausted',quotaGroups:[{id:'shared',maxConcurrentJobs:2}],queryBlockedRetryMs:2000});
 const first=await env.submit('alice');await until(async()=>((await env.service.get('alice',first.id)).recovery.retry_after??0)>0);
 const status=await env.service.get('alice',first.id);assert.equal(status.recovery.next_action,quota==='audio_duration_lifetime'?'inspect_receipt':'poll_original');assert.equal(status.recovery.capability,'query_original_task');
 const second=await env.submit('bob');await until(async()=>(await env.service.get('bob',second.id)).status==='silent');
 assert.equal(exhaustedQueries,1);assert.equal(healthyQueries,1);assert.equal((await receipt(env.root,first.id)).job.poolId,'exhausted');assert.equal((await receipt(env.root,second.id)).job.poolId,'healthy');
});

test('HTTP cached status exposes safe quota and remaining query delay without an extra supplier call',async t=>{
 let queries=0;const env=await fixture(t,async()=>{queries++;throw limited('audio_duration_lifetime');});
 const store=await openStore(join(env.root,'accounts.json'));const account=await store.create('fixture-editor','fixture-password');
 const first=await env.submit(account.id);await until(async()=>((await env.service.get(account.id,first.id)).recovery.retry_after??0)>0);
 const origin='https://muse.test',server=createAccountServer({store,asr:env.service,publicOrigin:origin,workspaceMode:'desktop'});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
 const base='http://127.0.0.1:'+server.address().port;
 const login=await fetch(base+'/login',{method:'POST',headers:{origin},body:new URLSearchParams({username:'fixture-editor',password:'fixture-password'}),redirect:'manual'}),cookie=login.headers.get('set-cookie').split(';')[0];
 const response=await fetch(base+'/api/asr/jobs/'+first.id,{headers:{cookie}});assert.equal(response.status,200);
 const body=await response.json();assert.equal(body.status,'uncertain');assert.equal(body.provider_diagnostic.quota_type,'audio_duration_lifetime');assert.equal(body.provider_diagnostic.provider_code,'45000292');assert.equal(body.provider_diagnostic.http_status,429);assert.equal(body.recovery.retry_after,1);assert.equal(body.recovery.next_action,'inspect_receipt');assert.equal(body.recovery.automatic_resubmit,false);assert.equal(queries,1);
 assert.doesNotMatch(JSON.stringify(body),/private-body|quota exceeded|accessToken|taskId|poolId/);
});

test('repeated unavailable queries back off to the configured cap and preserve the paid task',async t=>{
 let queries=0;const times=[],release=Promise.withResolvers(),entered=Promise.withResolvers();
 const env=await fixture(t,async()=>{times.push(Date.now());if(++queries<=4)throw new AsrProviderError('query','http',new Response('',{status:503}));entered.resolve();await release.promise;return {status:'silent'};});
 t.after(release.resolve);const first=await env.submit('alice');await entered.promise;
 const saved=await receipt(env.root,first.id);assert.equal(saved.job.queryRetry.count,4);
 assert.ok(times[2]-times[1]>=35);assert.ok(times[3]-times[2]>=75);assert.ok(times[4]-times[3]>=75);
 release.resolve();await env.service.idle();assert.equal(env.submissions(),1);
});

test('known lifetime quota uses the configured long retry without pretending the task failed',async t=>{
 const env=await fixture(t,async()=>{throw limited('audio_duration_lifetime','0');});
 const first=await env.submit('alice');await until(async()=>((await env.service.get('alice',first.id)).recovery.retry_after??0)>0);
 const saved=await receipt(env.root,first.id);assert.equal(saved.job.status,'uncertain');assert.equal(saved.job.queryRetry.count,1);
 assert.ok(saved.job.queryRetry.nextAttemptAtMs>=saved.job.submittedAtMs+200);assert.equal((await env.service.get('alice',first.id)).recovery.next_action,'inspect_receipt');assert.equal(env.submissions(),1);
});

test('malformed retry receipts fail before querying or rewriting the original ledger',async t=>{
 const env=await fixture(t,async()=>{throw limited();});const first=await env.submit('alice');
 await until(async()=>((await env.service.get('alice',first.id)).recovery.retry_after??0)>0);await env.service.close();
 const saved=await receipt(env.root,first.id);saved.job.queryRetry.count=-1;await writeFile(saved.path,JSON.stringify(saved.job));
 const before=await readFile(saved.path,'utf8'),restarted=createAsrService(env.settings);
 await assert.rejects(restarted.ready(),/Invalid ASR query retry receipt/);assert.equal(await readFile(saved.path,'utf8'),before);assert.equal(env.submissions(),1);
});

test('query retry timings are validated deployment settings',()=>{
 const config={providerKind:'flash',appId:'synthetic',accessToken:'synthetic',root:join(tmpdir(),'synthetic-retry-root'),ffprobePath:'ffprobe',timeoutMs:1000,maxAudioBytes:1024,maxDurationSeconds:600,maxDailySeconds:72000,maxDailyJobs:100,maxActiveJobs:1,retentionSeconds:86400,sweepIntervalSeconds:60};
 assert.equal(resolveAsrConfig(config).queryBackoffMaxMs,60000);assert.equal(resolveAsrConfig(config).queryBlockedRetryMs,300000);
 for(const queryBackoffMaxMs of [0,4999,86400001,'60000'])assert.throws(()=>resolveAsrConfig({...config,queryBackoffMaxMs}),/query retry configuration/);
 for(const queryBlockedRetryMs of [0,59999,86400001,'300000'])assert.throws(()=>resolveAsrConfig({...config,queryBlockedRetryMs}),/query retry configuration/);
});

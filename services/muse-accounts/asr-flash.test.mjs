import {test} from 'node:test';
import assert from 'node:assert/strict';
import * as provider from './asr-provider.mjs';
test('flash uses turbo resource and preserves word timings',async()=>{
 assert.equal(typeof provider.recognizeFlashAsr,'function');
 let request;
 const result=await provider.recognizeFlashAsr({appId:'app',accessToken:'token',timeoutMs:1000},{id:'task',url:'https://signed.invalid/audio',language:'zh'},async(url,init)=>{request={url,init};return new Response(JSON.stringify({result:{utterances:[{start_time:0,end_time:1000,text:'hello',words:[{start_time:0,end_time:500,text:'hello'}]}]}}),{headers:{'X-Api-Status-Code':'20000000'}});});
 assert.match(request.url,/recognize\/flash$/);assert.equal(request.init.headers['X-Api-Resource-Id'],'volc.bigasr.auc_turbo');
 assert.deepEqual(result,{status:'complete',segments:[{start:0,end:1,text:'hello',words:[{start:0,end:0.5,text:'hello'}]}]});
});
import {createAsrService} from './asr-service.mjs';
import {mkdtemp,rm,readdir,readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID,createHash} from 'node:crypto';
import {Readable} from 'node:stream';
const bytes=Buffer.from('mp3'),hash=createHash('sha256').update(bytes).digest('hex');
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
async function fixture(t,recognize){
 const root=await mkdtemp(join(tmpdir(),'muse-flash-'));let queries=0;
 const options={root,storage:{key:id=>id,assertPrivateBeforeUpload:async()=>{},upload:async()=>{},signedReadUrl:async()=> 'https://signed.invalid/audio',assertPrivateAndReadable:async()=>{},remove:async()=>{}},provider:{recognize,query:async()=>{queries++;return {status:'silent'};}},providerKind:'flash',maxConcurrentJobs:1,maxQueuedJobs:1,probe:async()=>10,maxAudioBytes:1024,maxDurationSeconds:7200,maxDailySeconds:120,maxDailyJobs:10,maxActiveJobs:1,retentionSeconds:86400};
 const service=createAsrService(options);t.after(async()=>{await service.idle?.();await rm(root,{recursive:true,force:true});});
 return {service,options,root,queries:()=>queries,submit:(account,id=randomUUID())=>service.submit(account,id,hash,'zh',Readable.from(bytes))};
}
test('flash runs in background with one shared slot and bounded waiting across accounts',async t=>{
 const entered=deferred(),release=deferred();let calls=0;
 const env=await fixture(t,async()=>{calls++;entered.resolve();await release.promise;return {status:'silent'};});
 try{
 const first=await env.submit('alice');assert.equal(first.status,'processing');await entered.promise;
 const second=await env.submit('bob');assert.equal(second.status,'processing');assert.equal(calls,1);
 await assert.rejects(env.submit('carol'),{status:429});
 await assert.rejects(env.submit('alice'),{status:429});
 release.resolve();await env.service.idle();assert.equal(calls,2);
 assert.equal((await env.service.get('alice',first.id)).status,'silent');assert.equal((await env.service.get('bob',second.id)).status,'silent');
 }finally{release.resolve();}
});
test('flash lost responses never query or resubmit even after restart',async t=>{
 let calls=0;const env=await fixture(t,async()=>{calls++;throw Error('lost response');});
 const first=await env.submit('alice');await env.service.idle();
 assert.equal((await env.service.get('alice',first.id)).status,'uncertain');
 const restarted=createAsrService(env.options);await restarted.ready();
 assert.equal((await restarted.submit('alice',first.id,hash,'zh',Readable.from(bytes))).status,'uncertain');
 assert.equal((await restarted.get('alice',first.id)).status,'uncertain');assert.equal(calls,1);assert.equal(env.queries(),0);
});
test('restart resumes unsubmitted flash queue, quarantines submitting flash, and queries legacy standard jobs',async t=>{
 let calls=0;const env=await fixture(t,async()=>{calls++;return {status:'silent'};});
 const first=await env.submit('alice');await env.service.idle();
 const [name]=await readdir(join(env.root,'jobs'));const path=join(env.root,'jobs',name);const receipt=JSON.parse(await readFile(path,'utf8'));
 receipt.status='queued';await writeFile(path,JSON.stringify(receipt));await writeFile(join(env.root,'audio',createHash('sha256').update('alice\0'+first.id).digest('hex')+'.mp3'),bytes);
 const resumed=createAsrService(env.options);await resumed.ready();await resumed.idle();assert.equal(calls,2);
 receipt.status='submitting';await writeFile(path,JSON.stringify(receipt));
 const uncertain=createAsrService(env.options);await uncertain.ready();await uncertain.idle();assert.equal((await uncertain.get('alice',first.id)).status,'uncertain');assert.equal(calls,2);
 delete receipt.providerKind;receipt.status='processing';await writeFile(path,JSON.stringify(receipt));
 const legacy=createAsrService(env.options);await legacy.ready();assert.equal((await legacy.get('alice',first.id)).status,'silent');assert.equal(env.queries(),1);
});
test('flash malformed, HTTP failure, timeout, and provider rejection remain unknown; silence is terminal',async()=>{
 const config={appId:'app',accessToken:'token',timeoutMs:1000},input={id:'task',url:'https://signed.invalid/audio',language:'auto'};
 for(const fetcher of [async()=>{throw Error('secret-token');},async()=>new Response('{}',{status:503}),async()=>new Response('{}',{headers:{'X-Api-Status-Code':'45000001'}}),async()=>new Response('{',{headers:{'X-Api-Status-Code':'20000000'}})])await assert.rejects(provider.recognizeFlashAsr(config,input,fetcher),error=>!error.message.includes('secret-token'));
 assert.deepEqual(await provider.recognizeFlashAsr(config,input,async()=>new Response('{}',{headers:{'X-Api-Status-Code':'20000003'}})),{status:'silent'});
});
test('gateway rejects flash limits above provisioned concurrency and media limits before startup',()=>{
 const common={root:'unused',storage:{},provider:{recognize:async()=>{}},providerKind:'flash',maxAudioBytes:100_000_000,maxDurationSeconds:7200,maxDailySeconds:7200,maxDailyJobs:1,maxActiveJobs:1,retentionSeconds:86400};
 for(const invalid of [{maxConcurrentJobs:6},{maxQueuedJobs:0},{maxDurationSeconds:7201},{maxAudioBytes:100_000_001},{providerKind:'typo'}])assert.throws(()=>createAsrService({...common,...invalid}),/configuration/);
});
test('flash ignores blank or zero-duration punctuation words and validates ordered spoken words',async()=>{
 const config={appId:'app',accessToken:'token',timeoutMs:1000},input={id:'task',url:'https://signed.invalid/audio',language:'zh'};
 const recognize=words=>provider.recognizeFlashAsr(config,input,async()=>new Response(JSON.stringify({result:{utterances:[{start_time:0,end_time:1000,text:'hello!',words}]}}),{headers:{'X-Api-Status-Code':'20000000'}}));
 assert.deepEqual((await recognize([{start_time:0,end_time:500,text:'hello'},{start_time:500,end_time:500,text:'!'},{start_time:500,end_time:900,text:' '}])).segments[0].words,[{start:0,end:0.5,text:'hello'}]);
 await assert.rejects(recognize([{start_time:500,end_time:900,text:'two'},{start_time:0,end_time:500,text:'one'}]));
});
test('concurrent replay of one flash key shares its upload and paid request',async t=>{
 const release=deferred();let calls=0;
 const env=await fixture(t,async()=>{calls++;await release.promise;return {status:'silent'};});
 try{const id=randomUUID();const result=await Promise.all([env.submit('alice',id),env.submit('alice',id)]);assert.deepEqual(result[0],result[1]);}
 finally{release.resolve();}
 await env.service.idle();assert.equal(calls,1);
});
test('flash uses durable private audio without TOS and deletes it after completion',async t=>{
 const release=deferred(),entered=deferred();let file;
 const env=await fixture(t,async input=>{file=input.file;entered.resolve();await release.promise;return {status:'silent'};});
 try{
 const direct=createAsrService({...env.options,root:join(env.root,'direct'),storage:undefined});
 const job=await direct.submit('alice',randomUUID(),hash,'zh',Readable.from(bytes));await entered.promise;
 assert.deepEqual(await readFile(file),bytes);assert.equal(job.status,'processing');release.resolve();await direct.idle();
 await assert.rejects(readFile(file),{code:'ENOENT'});
 }finally{release.resolve();}
});
test('flash sends private file bytes as base64 without a storage URL',async t=>{
 const root=await mkdtemp(join(tmpdir(),'muse-flash-data-'));t.after(()=>rm(root,{recursive:true,force:true}));const file=join(root,'audio.mp3');await writeFile(file,bytes);
 let body;await provider.recognizeFlashAsr({appId:'app',accessToken:'token',timeoutMs:1000},{id:'task',file,language:'zh'},async(_url,init)=>{body=JSON.parse(init.body);return new Response('{}',{headers:{'X-Api-Status-Code':'20000003'}});});
 assert.deepEqual(body.audio,{data:bytes.toString('base64')});
});
test('flash startup configuration requires no TOS credentials and rejects incomplete standard configuration',async()=>{
 const module=await import('./asr-service.mjs');assert.equal(typeof module.resolveAsrConfig,'function');
 const input={providerKind:'flash',appId:'app',accessToken:'token',root:join(tmpdir(),'muse-flash'),ffprobePath:'ffprobe',timeoutMs:180000,maxAudioBytes:100000000,maxDurationSeconds:7200,maxDailySeconds:14400,maxDailyJobs:20,maxActiveJobs:1,retentionSeconds:86400,sweepIntervalSeconds:60};
 const config=module.resolveAsrConfig(input);assert.equal(config.maxConcurrentJobs,5);assert.equal(config.maxQueuedJobs,20);
 assert.throws(()=>module.resolveAsrConfig({...input,providerKind:'standard'}),/configuration/);
 assert.throws(()=>module.resolveAsrConfig({...input,accessKeyId:'partial'}),/configuration/);
 assert.throws(()=>module.resolveAsrConfig({...input,maxConcurrentJobs:6}),/configuration/);
});
test('uncertain flash audio expires locally while the charged receipt remains immutable',async t=>{
 let calls=0;const env=await fixture(t,async()=>{calls++;throw Error('lost response');});
 const first=await env.submit('alice');await env.service.idle();const file=join(env.root,'audio',createHash('sha256').update('alice\0'+first.id).digest('hex')+'.mp3');
 assert.deepEqual(await readFile(file),bytes);
 const restarted=createAsrService({...env.options,now:()=>Date.now()+86401*1000});await restarted.ready();await restarted.sweep();
 await assert.rejects(readFile(file),{code:'ENOENT'});const result=await restarted.get('alice',first.id);assert.equal(result.status,'uncertain');assert.equal(result.retentionExpired,true);
 assert.equal((await restarted.submit('alice',first.id,hash,'zh',Readable.from(bytes))).status,'uncertain');assert.equal(calls,1);
});
test('gateway audio metadata accepts PCM WAV or MP3 and rejects mismatched containers',async()=>{
 const module=await import('./asr-service.mjs');assert.equal(typeof module.parseAudioMetadata,'function');
 assert.deepEqual(module.parseAudioMetadata({format:{duration:'10',format_name:'wav'},streams:[{codec_name:'pcm_s16le',sample_rate:'16000',channels:1}]}),{duration:10,format:'wav'});
 assert.deepEqual(module.parseAudioMetadata({format:{duration:'10',format_name:'mp3'},streams:[{codec_name:'mp3'}]}),{duration:10,format:'mp3'});
 for(const stream of [{codec_name:'aac'},{codec_name:'pcm_s16le',sample_rate:'48000',channels:1},{codec_name:'pcm_s16le',sample_rate:'16000',channels:2}])assert.throws(()=>module.parseAudioMetadata({format:{duration:'10',format_name:'wav'},streams:[stream]}));
 assert.throws(()=>module.parseAudioMetadata({format:{duration:'10',format_name:'mp4'},streams:[{codec_name:'mp3'}]}));
});
test('standard provider accepts gateway-verified WAV format',async()=>{
 let body;await provider.submitAsr({appId:'app',accessToken:'token',timeoutMs:1000},{id:'task',url:'https://signed.invalid/audio',format:'wav',language:'zh'},async(_url,init)=>{body=JSON.parse(init.body);return new Response('{}',{headers:{'X-Api-Status-Code':'20000000'}});});
 assert.equal(body.audio.format,'wav');
});
test('switching new jobs to standard keeps the audio of a recovered flash job',async t=>{
 const gate=deferred(),entered=deferred();let block=false;
 const env=await fixture(t,async()=>{if(block){entered.resolve();await gate.promise;}return {status:'silent'};});
 const first=await env.submit('alice');await env.service.idle();const [name]=await readdir(join(env.root,'jobs'));const path=join(env.root,'jobs',name),receipt=JSON.parse(await readFile(path,'utf8'));
 receipt.status='queued';await writeFile(path,JSON.stringify(receipt));const file=join(env.root,'audio',createHash('sha256').update('alice\0'+first.id).digest('hex')+'.mp3');await writeFile(file,bytes);block=true;
 const resumed=createAsrService({...env.options,providerKind:'standard'});
 try{await resumed.ready();await entered.promise;await resumed.submit('alice',first.id,hash,'zh',Readable.from(bytes));assert.deepEqual(await readFile(file),bytes);}
 finally{gate.resolve();await resumed.idle();}
});
test('flash uses provider language detection without unsupported request language fields',async()=>{
 for(const language of ['zh','auto']){
 let body;await provider.recognizeFlashAsr({appId:'app',accessToken:'token',timeoutMs:1000},{id:'task',url:'https://signed.invalid/audio',language},async(_url,init)=>{body=JSON.parse(init.body);return new Response('{}',{headers:{'X-Api-Status-Code':'20000003'}});});
 assert.equal('language' in body.request,false);assert.equal('enable_auto_lang' in body.request,false);
 }
});

test('one account can queue the next audio part while its first part is running',async t=>{
 const entered=deferred(),release=deferred();let calls=0;
 const env=await fixture(t,async()=>{calls++;entered.resolve();await release.promise;return {status:'silent'};});
 try{
  const first=await env.submit('alice');await entered.promise;
  const second=await env.submit('alice');assert.equal(second.status,'processing');assert.equal(calls,1);
  release.resolve();await env.service.idle();assert.equal(calls,2);
  assert.equal((await env.service.get('alice',first.id)).status,'silent');
  assert.equal((await env.service.get('alice',second.id)).status,'silent');
 }finally{release.resolve();}
});

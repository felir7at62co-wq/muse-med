import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {mkdtemp,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createAccountServer} from './gateway.mjs';
import {createAsrService} from './asr-service.mjs';
import {createGatewayAudioStore} from './asr-gateway-storage.mjs';
import {openStore} from './store.mjs';

const bytes=Buffer.from('synthetic private audio'),hash=createHash('sha256').update(bytes).digest('hex'),origin='https://muse.test';
async function fixture(t){
 const root=await mkdtemp(join(tmpdir(),'muse-asr-routing-http-'));let base,server,service;const submits=[],queries=[];
 t.after(async()=>{await service?.close();if(server?.listening)await new Promise(resolve=>server.close(resolve));await rm(root,{recursive:true,force:true});});
 const fetcher=async(url,options)=>{const target=new URL(url);assert.equal(target.origin,origin);return await fetch(base+target.pathname+target.search,options);};
 const storage=createGatewayAudioStore({root:join(root,'private-audio'),baseURL:origin+'/api/asr/audio/',secret:'synthetic-private'.repeat(4),signedUrlTtlSeconds:86400,timeoutMs:5000,fetcher});await storage.ready();
 const resourceIds={flash:'volc.bigasr.auc_turbo','standard-v1':'volc.bigasr.auc','standard-v2':'volc.seedasr.auc'};
 const resources=Object.entries(resourceIds).map(([serviceVersion,resourceId])=>({poolId:serviceVersion,appId:'synthetic-app',serviceVersion,resourceId,quotaGroup:serviceVersion==='flash'?'flash':'standard',maxConcurrentJobs:1,provider:{recognize:async()=>({status:'silent'}),submit:async input=>{const audio=await fetcher(input.url);assert.equal(audio.status,200);assert.deepEqual(Buffer.from(await audio.arrayBuffer()),bytes);submits.push({id:input.id,version:serviceVersion});},query:async id=>{queries.push(id);return {status:'complete',segments:[{start:0,end:1,text:'hello'}]};}}}));
 service=createAsrService({root:join(root,'ledger'),storage,storageKind:'gateway',providerKind:'flash',resources,quotaGroups:[{id:'flash',maxConcurrentJobs:1},{id:'standard',maxConcurrentJobs:1,submitQps:10,queryQps:10}],defaultPoolId:'flash',legacyAppId:'synthetic-app',routes:{subtitles:'flash',screenplay:'standard-v2'},autoStart:false,probe:async()=>10,maxAudioBytes:1024,maxDurationSeconds:7200,maxDailySeconds:180000,maxDailyJobs:1000,maxActiveJobs:1,maxQueuedJobs:30,retentionSeconds:86400});await service.ready();
 const store=await openStore(join(root,'accounts.json'));for(const user of ['alice','bob'])await store.create(user,'synthetic-password');
 server=createAccountServer({store,asr:service,asrStorage:storage,publicOrigin:origin,workspaceMode:'desktop'});
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});base='http://127.0.0.1:'+server.address().port;await service.start();
 const cookies=new Map();for(const username of ['alice','bob']){
  const response=await fetch(base+'/login',{method:'POST',headers:{origin},body:new URLSearchParams({username,password:'synthetic-password'}),redirect:'manual'});cookies.set(username,response.headers.get('set-cookie').split(';')[0]);
 }
 return {root,base,service,submits,queries,cookies,post:(id,purpose)=>fetch(base+'/api/asr/jobs',{method:'POST',headers:{origin,cookie:cookies.get('alice'),'content-type':'audio/mpeg','idempotency-key':id,'x-audio-sha256':hash,'x-audio-language':'zh',...purpose===undefined?{}:{'X-Muse-Asr-Purpose':purpose}},body:bytes})};
}

test('signed standard audio is fetched through the real unauthenticated gateway route and removed after completion',async t=>{
 const env=await fixture(t),id=randomUUID();
 const unsigned=await fetch(env.base+'/api/asr/audio/'+randomUUID()+'.mp3',{method:'HEAD',redirect:'manual'});assert.equal(unsigned.status,403);assert.equal(unsigned.headers.get('location'),null);
 const response=await env.post(id,'screenplay');assert.equal(response.status,202);const accepted=await response.json();assert.equal(accepted.purpose,'screenplay');assert.equal(accepted.service_version,'standard-v2');
 await env.service.idle();assert.equal(env.submits.length,1);assert.equal(env.submits[0].version,'standard-v2');assert.deepEqual(env.queries,[env.submits[0].id]);
 const finished=await (await fetch(env.base+'/api/asr/jobs/'+id,{headers:{cookie:env.cookies.get('alice')}})).json();assert.deepEqual(finished.segments,[{start:0,end:1,text:'hello'}]);
 assert.doesNotMatch(JSON.stringify(finished),/signature|private|secret|appId|resourceId|poolId/);assert.deepEqual(await readdir(join(env.root,'private-audio')),[]);assert.deepEqual(await readdir(join(env.root,'ledger','audio')),[]);
 assert.equal((await fetch(env.base+'/api/asr/jobs/'+id,{headers:{cookie:env.cookies.get('bob')}})).status,404);
});

test('HTTP purpose conflicts and unsupported purposes are explicit without exposing supplier details',async t=>{
 const env=await fixture(t),id=randomUUID();assert.equal((await env.post(id,'subtitles')).status,202);await env.service.idle();
 for(const purpose of ['screenplay',undefined]){const response=await env.post(id,purpose);assert.equal(response.status,409);assert.equal((await response.json()).error_code,'idempotency_conflict');}
 const invalid=await env.post(randomUUID(),'other');assert.equal(invalid.status,400);assert.equal((await invalid.json()).error_code,'invalid_request');
 assert.equal(env.submits.length,0);assert.equal((await env.post(id,'subtitles')).status,202);
});

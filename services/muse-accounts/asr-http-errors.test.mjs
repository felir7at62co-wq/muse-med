import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createAsrService} from './asr-service.mjs';
import {createAccountServer} from './gateway.mjs';
import {openStore} from './store.mjs';

const bytes=Buffer.from('fixture audio'),hash=createHash('sha256').update(bytes).digest('hex'),origin='https://muse.test';
async function fixture(t,{recognize=async()=>({status:'silent'}),probe=async()=>10,...options}={}){
 const root=await mkdtemp(join(tmpdir(),'muse-asr-http-'));let service,server;const releases=[];
 t.after(async()=>{for(const release of releases)release();if(server?.listening)await new Promise(resolve=>server.close(resolve));if(service)await service.idle();await rm(root,{recursive:true,force:true});});
 service=createAsrService({root,providerKind:'flash',provider:{recognize},probe,maxAudioBytes:1024,maxDurationSeconds:7200,maxDailySeconds:1000,maxDailyJobs:100,maxActiveJobs:1,retentionSeconds:86400,maxConcurrentJobs:1,maxQueuedJobs:1,...options});
 const store=await openStore(join(root,'accounts.json'));await store.create('alice','synthetic-password');await store.create('bob','synthetic-password');await store.create('carol','synthetic-password');
 server=createAccountServer({store,asr:service,publicOrigin:origin,workspaceMode:'desktop'});
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
 const base='http://127.0.0.1:'+server.address().port;
 const cookies=new Map();for(const username of ['alice','bob','carol']){
  const response=await fetch(base+'/login',{method:'POST',headers:{origin},body:new URLSearchParams({username,password:'synthetic-password'}),redirect:'manual'});
  cookies.set(username,response.headers.get('set-cookie').split(';')[0]);
 }
 return {base,service,releases,post:(username='alice',id=randomUUID())=>fetch(base+'/api/asr/jobs',{method:'POST',headers:{origin,cookie:cookies.get(username),'content-type':'audio/mpeg','idempotency-key':id,'x-audio-sha256':hash,'x-audio-language':'zh'},body:bytes}),get:id=>fetch(base+'/api/asr/jobs/'+id,{headers:{cookie:cookies.get('alice')}})};
}

test('HTTP queue refusal keeps legacy error text and adds a safe retry reason and header',async t=>{
 const entered=Promise.withResolvers(),release=Promise.withResolvers();
 const env=await fixture(t,{recognize:async()=>{entered.resolve();await release.promise;return {status:'silent'};}});env.releases.push(release.resolve);
 assert.equal((await env.post('alice')).status,202);await entered.promise;assert.equal((await env.post('bob')).status,202);
 const response=await env.post('carol');assert.equal(response.status,429);assert.equal(response.headers.get('retry-after'),'2');
 assert.deepEqual(await response.json(),{error:'Cloud transcription queue is full',error_code:'queue_full',retry_after:2});
 release.resolve();await env.service.idle();
});

test('HTTP per-account upload bound is distinguishable from queue capacity',async t=>{
 const entered=Promise.withResolvers(),release=Promise.withResolvers();
 const env=await fixture(t,{maxQueuedJobs:5,maxPendingUploadsPerAccount:1,probe:async()=>{entered.resolve();await release.promise;return 10;}});env.releases.push(release.resolve);
 const first=env.post();await entered.promise;
 const second=await env.post();assert.equal(second.status,429);assert.equal((await second.json()).error_code,'upload_busy');
 release.resolve();assert.equal((await first).status,202);
});

test('HTTP daily quota refuses a new task without exposing credentials or a retry invitation',async t=>{
 const env=await fixture(t,{maxDailyJobs:1});assert.equal((await env.post()).status,202);await env.service.idle();
 const response=await env.post();assert.equal(response.status,429);assert.equal(response.headers.get('retry-after'),null);
 assert.deepEqual(await response.json(),{error:'Daily cloud transcription limit reached',error_code:'daily_quota'});
});

test('ASR submission and polling share sixty requests per account and return request_rate separately',async t=>{
 const env=await fixture(t),id=randomUUID();assert.equal((await env.post('alice',id)).status,202);
 for(let count=0;count<59;count++)assert.equal((await env.get(id)).status,200);
 const response=await env.get(id);assert.equal(response.status,429);assert.equal(response.headers.get('retry-after'),'60');
 assert.deepEqual(await response.json(),{error:'Cloud transcription request rate exceeded',error_code:'request_rate',retry_after:60});
 assert.equal((await env.post('bob')).status,202);
});

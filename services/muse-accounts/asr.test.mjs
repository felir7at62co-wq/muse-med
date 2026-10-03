import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {mkdtemp,readFile,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Readable} from 'node:stream';
import {createAsrService} from './asr-service.mjs';
import {createAccountServer} from './gateway.mjs';
import {openStore} from './store.mjs';
import {queryAsr,submitAsr} from './asr-provider.mjs';
import {createTosAudioStore} from './asr-storage.mjs';

const audio=Buffer.from('mock mp3 bytes');
const hash=createHash('sha256').update(audio).digest('hex');
const deferred=()=>Promise.withResolvers();
const makeStorage=()=>({key:id=>`temporary/${id}.mp3`,assertPrivateBeforeUpload:async()=>{},upload:async()=>{},signedReadUrl:async()=> 'https://signed.invalid/audio',assertPrivateAndReadable:async()=>{},remove:async()=>{}});
async function setup(options={}){const root=await mkdtemp(join(tmpdir(),'muse-asr-'));let submits=0,queries=0;
 const provider={submit:async()=>{submits++;if(options.submitUnknown)throw Error('network outcome unknown');},query:async()=>{queries++;if(options.query)return await options.query();return options.queryResult??{status:'complete',segments:[{start:0,end:1,text:'你好'}]};}};
 const service=createAsrService({root,storage:makeStorage(),provider,probe:async()=>options.duration??60,maxAudioBytes:1024,maxDurationSeconds:18000,maxDailySeconds:120,maxDailyJobs:2,maxActiveJobs:1,maxPendingUploadsPerAccount:options.maxPendingUploadsPerAccount??4,retentionSeconds:86400});
 return {root,service,counts:()=>({submits,queries}),close:async()=>{await service.close();await rm(root,{recursive:true,force:true});}};}

test('one account/key submits once, survives service restart, and returns timed results',async t=>{
 const env=await setup();t.after(env.close);const id=randomUUID();
 const first=await env.service.submit('alice',id,hash,'zh',Readable.from(audio));assert.equal(first.status,'processing');
 await env.service.idle();const replay=await env.service.submit('alice',id,hash,'zh',Readable.from(audio));assert.equal(replay.status,'complete');assert.equal(env.counts().submits,1);
 const result=await env.service.get('alice',id);assert.deepEqual(result.segments,[{start:0,end:1,text:'你好'}]);
 assert.equal((await env.service.get('alice',id)).status,'complete');assert.equal(env.counts().queries,1);
 await assert.rejects(env.service.get('bob',id),{status:404});
 await assert.rejects(env.service.submit('alice',id,'f'.repeat(64),'zh',Readable.from(audio)),{status:409});
});
test('uncertain submit is queried and never submitted twice',async t=>{
 const entered=deferred(),release=deferred();const env=await setup({submitUnknown:true,query:async()=>{entered.resolve();await release.promise;return {status:'complete',segments:[{start:0,end:1,text:'你好'}]};}});t.after(env.close);const id=randomUUID();
 try{
  assert.equal((await env.service.submit('alice',id,hash,'zh',Readable.from(audio))).status,'processing');await entered.promise;
  assert.equal((await env.service.get('alice',id)).status,'uncertain');
  assert.equal((await env.service.submit('alice',id,hash,'zh',Readable.from(audio))).status,'uncertain');
 }finally{release.resolve();}
 await env.service.idle();assert.equal((await env.service.get('alice',id)).status,'complete');assert.equal(env.counts().submits,1);
});
test('duration and daily quota stop new paid submissions',async t=>{
 const env=await setup({duration:100});t.after(env.close);
 await env.service.submit('alice',randomUUID(),hash,'zh',Readable.from(audio));
 await env.service.idle();
 await assert.rejects(env.service.submit('alice',randomUUID(),hash,'zh',Readable.from(audio)),{status:429});
 assert.equal(env.counts().submits,1);
});
test('one account reserves its configured upload slot before asynchronous job lookup',async t=>{
 const env=await setup({maxPendingUploadsPerAccount:1});t.after(env.close);
 const first=env.service.submit('alice',randomUUID(),hash,'zh',Readable.from(audio));
 const second=env.service.submit('alice',randomUUID(),hash,'zh',Readable.from(audio));
 await assert.rejects(second,{status:429});
 assert.equal((await first).status,'processing');
 await env.service.idle();
 assert.equal(env.counts().submits,1);
});
test('a pre-submit storage failure can resume under the same account/key',async t=>{
 const root=await mkdtemp(join(tmpdir(),'muse-asr-retry-'));let uploads=0,submits=0;
 const storage={...makeStorage(),upload:async()=>{if(++uploads===1)throw Error('storage offline');}};
 const service=createAsrService({root,storage,provider:{submit:async()=>{submits++;},query:async()=>({status:'silent'})},probe:async()=>30,maxAudioBytes:1024,maxDurationSeconds:18000,maxDailySeconds:120,maxDailyJobs:2,maxActiveJobs:1,retentionSeconds:86400});t.after(async()=>{await service.close();await rm(root,{recursive:true,force:true});});
 const id=randomUUID();await service.submit('alice',id,hash,'zh',Readable.from(audio));await service.idle();
 assert.equal((await service.get('alice',id)).status,'failed');
 assert.equal((await service.submit('alice',id,hash,'zh',Readable.from(audio))).status,'processing');
 await service.idle();
 assert.equal(submits,1);
});
test('a private-storage preflight failure never uploads audio and leaves a job audit',async t=>{
 const root=await mkdtemp(join(tmpdir(),'muse-asr-private-'));let uploads=0,submits=0;
 const storage={...makeStorage(),assertPrivateBeforeUpload:async()=>{throw Error('private storage not proven');},upload:async()=>{uploads++;}};
 const service=createAsrService({root,storage,provider:{submit:async()=>{submits++;},query:async()=>({status:'processing'})},probe:async()=>30,maxAudioBytes:1024,maxDurationSeconds:18000,maxDailySeconds:120,maxDailyJobs:2,maxActiveJobs:1,retentionSeconds:86400});
 t.after(async()=>{await service.close();await rm(root,{recursive:true,force:true});});
 const id=randomUUID();await service.submit('alice',id,hash,'zh',Readable.from(audio));await service.idle();
 assert.equal(uploads,0);assert.equal(submits,0);
 const names=await readdir(join(root,'jobs'));assert.equal(names.length,1);
 const receipt=JSON.parse(await readFile(join(root,'jobs',names[0]),'utf8'));
 assert.equal(receipt.status,'failed');assert.equal(receipt.failureStage,'storage-preflight');
});
test('expired standard audio is deleted while its original in-flight task keeps its slot and query ID',async t=>{
 const root=await mkdtemp(join(tmpdir(),'muse-asr-retention-'));
 let clock=1000,removes=0,submits=0,queries=0;
 const entered=deferred(),removed=deferred(),ids=[];
 const storage={...makeStorage(),remove:async()=>{removes++;removed.resolve();}};
 const provider={submit:async()=>{submits++;throw Error('submit outcome unknown');},query:async id=>{queries++;ids.push(id);entered.resolve();return {status:'processing'};}};
 const service=createAsrService({root,storage,provider,pollIntervalMs:10,probe:async()=>30,now:()=>clock,maxAudioBytes:1024,maxDurationSeconds:18000,maxDailySeconds:120,maxDailyJobs:2,maxActiveJobs:1,retentionSeconds:86400});t.after(async()=>{await service.close();await rm(root,{recursive:true,force:true});});
 const id=randomUUID();assert.equal((await service.submit('alice',id,hash,'zh',Readable.from(audio))).status,'processing');await entered.promise;
 clock+=86401*1000;await removed.promise;await service.close();assert.equal(removes,1);
 const status=await service.get('alice',id);assert.equal(status.status,'processing');assert.equal(status.retentionExpired,true);
 assert.equal(submits,1);assert.ok(queries>=1);assert.equal(new Set(ids).size,1);
 await service.sweep();assert.equal(removes,1);
});
test('TOS upload requires owner-only bucket ACL and no granting policy before any object bytes',async()=>{
 const ownerAcl={Owner:{ID:'owner'},Grants:[{Grantee:{Type:'CanonicalUser',ID:'owner'},Permission:'FULL_CONTROL'}]};
 let acl=ownerAcl,policy={Statement:[]};const uploads=[];
 class TosClient{getBucketAcl=async()=>({data:acl});getBucketPolicy=async()=>({data:policy});uploadFile=async input=>{uploads.push(input);};}
 const store=createTosAudioStore({bucket:'muse-audio',region:'cn-beijing',endpoint:'tos-cn-beijing.volces.com',prefix:'asr/',accessKeyId:'local-test',secretAccessKey:'local-test',signedUrlTtlSeconds:3600,timeoutMs:1000},{TosClient,CancelToken:{source:()=>({token:{}})}});
 acl={...ownerAcl,Grants:[...ownerAcl.Grants,{Grantee:{Type:'Group',Canned:'AllUsers'},Permission:'READ'}]};
 await assert.rejects(store.assertPrivateBeforeUpload(),/not proven private/);assert.equal(uploads.length,0);
 acl=ownerAcl;policy={Statement:[{Effect:'Allow',Principal:'*',Action:'tos:GetObject'}]};
 await assert.rejects(store.assertPrivateBeforeUpload(),/not proven private/);assert.equal(uploads.length,0);
 policy={Statement:[]};await store.assertPrivateBeforeUpload();await store.upload('fixture.mp3',store.key('task'));
 assert.equal(uploads.length,1);assert.equal(uploads[0].acl,'private');
});
test('private TOS staging rejects anonymous access before sending a provider request',async()=>{
 const calls=[];class TosClient{constructor(){}getPreSignedUrl(){return 'https://signed.invalid/audio';}}
 const store=createTosAudioStore({bucket:'muse-audio',region:'cn-beijing',endpoint:'tos-cn-beijing.volces.com',prefix:'asr/',accessKeyId:'local-test',secretAccessKey:'local-test',signedUrlTtlSeconds:3600,timeoutMs:1000},{TosClient,CancelToken:{}},async url=>{calls.push(url);return new Response('',{status:200});});
 await assert.rejects(store.assertPrivateAndReadable(store.key('test'),'https://signed.invalid/audio'),/not proven private/);
 assert.equal(calls.length,1);
});
test('provider recording-file headers and result parsing use the provisioned v3 resource',async()=>{
 const credential={appId:'app',accessToken:'token',timeoutMs:5000};let request;
 const fetcher=async(url,init)=>{request={url,init};return new Response(JSON.stringify({result:{utterances:[{start_time:100,end_time:700,text:' 你好 '}]}}),{headers:{'X-Api-Status-Code':'20000000'}});};
 await submitAsr(credential,{id:randomUUID(),url:'https://signed.invalid/audio',language:'zh'},fetcher);
 assert.match(request.url,/\/api\/v3\/auc\/bigmodel\/submit$/);assert.equal(request.init.headers['X-Api-Resource-Id'],'volc.bigasr.auc');
 const result=await queryAsr(credential,randomUUID(),fetcher);assert.deepEqual(result.segments,[{start:0.1,end:0.7,text:'你好'}]);
});
test('gateway ASR endpoint uses the Muse cookie, origin, and account isolation',async t=>{
 const env=await setup();t.after(env.close);const store=await openStore(join(env.root,'accounts.json'));
 await store.create('alice','pw');await store.create('bob','pw');const origin='https://muse.test';
 const server=createAccountServer({store,runtime:{ensure:async()=>{throw Error('must not proxy ASR');}},publicOrigin:origin,asr:env.service});
 const base=await new Promise(resolve=>server.listen(0,'127.0.0.1',()=>resolve(`http://127.0.0.1:${server.address().port}`)));
 t.after(()=>new Promise(resolve=>server.close(resolve)));
 const login=async name=>(await fetch(base+'/login',{method:'POST',headers:{origin},body:new URLSearchParams({username:name,password:'pw'}),redirect:'manual'})).headers.get('set-cookie').split(';')[0];
 const alice=await login('alice'),bob=await login('bob'),id=randomUUID();
 const path='/api/asr/jobs';const headers={cookie:alice,origin,'content-type':'audio/mpeg','idempotency-key':id,'x-audio-sha256':hash,'x-audio-language':'zh'};
 assert.equal((await fetch(base+path,{method:'POST',headers:{...headers,origin:'https://evil.test'},body:audio,redirect:'manual'})).status,403);
 const created=await fetch(base+path,{method:'POST',headers,body:audio});assert.equal(created.status,202);
 const wav=await fetch(base+path,{method:'POST',headers:{...headers,cookie:bob,'content-type':'audio/wav','idempotency-key':randomUUID()},body:audio});assert.equal(wav.status,202);
 const unsupported=await fetch(base+path,{method:'POST',headers:{...headers,'content-type':'video/mp4','idempotency-key':randomUUID()},body:audio});assert.equal(unsupported.status,415);
 assert.equal((await fetch(base+path+'/'+id,{headers:{cookie:bob}})).status,404);
 await env.service.idle();
 const result=await (await fetch(base+path+'/'+id,{headers:{cookie:alice}})).json();assert.equal(result.status,'complete');
 assert.doesNotMatch(JSON.stringify(result),/signed.invalid|temporary\/|token/);
});
test('unconfigured gateway answers 503 instead of proxying or claiming cloud availability',async t=>{
 const root=await mkdtemp(join(tmpdir(),'muse-asr-off-'));t.after(()=>rm(root,{recursive:true,force:true}));const store=await openStore(join(root,'accounts.json'));await store.create('alice','pw');
 const origin='https://muse.test',server=createAccountServer({store,runtime:{ensure:async()=>{throw Error('must not proxy');}},publicOrigin:origin});
 const base=await new Promise(resolve=>server.listen(0,'127.0.0.1',()=>resolve(`http://127.0.0.1:${server.address().port}`)));t.after(()=>new Promise(resolve=>server.close(resolve)));
 const cookie=(await fetch(base+'/login',{method:'POST',headers:{origin},body:new URLSearchParams({username:'alice',password:'pw'}),redirect:'manual'})).headers.get('set-cookie').split(';')[0];
 const response=await fetch(base+'/api/asr/jobs',{method:'POST',headers:{origin,cookie,'content-type':'audio/mpeg'},body:audio});
 assert.equal(response.status,503);assert.match((await response.json()).error,/not configured/);
});
test('production gateway serves the configured KB machine endpoint before browser login',async t=>{
 const root=await mkdtemp(join(tmpdir(),'muse-prod-kb-'));t.after(()=>rm(root,{recursive:true,force:true}));const store=await openStore(join(root,'accounts.json'));
 const server=createAccountServer({store,runtime:{ensure:async()=>{throw Error('must not proxy KB');}},environment:'production',publicOrigin:'https://muse.test',kb:{vaultRoot:root,secret:'x'.repeat(32)}});
 const base=await new Promise(resolve=>server.listen(0,'127.0.0.1',()=>resolve(`http://127.0.0.1:${server.address().port}`)));t.after(()=>new Promise(resolve=>server.close(resolve)));
 assert.equal((await fetch(base+'/api/kb/mcp')).status,401);
});

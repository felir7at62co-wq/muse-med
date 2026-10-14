import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {openStore} from './store.mjs';
import {createAccountServer} from './gateway.mjs';
import {resolveAsrConfig} from './asr-service.mjs';

const config={providerKind:'flash',appId:'synthetic',accessToken:'synthetic',root:join(tmpdir(),'synthetic-asr-root'),ffprobePath:'ffprobe',timeoutMs:1000,maxAudioBytes:1024,maxDurationSeconds:600,maxDailySeconds:72000,maxDailyJobs:100,maxActiveJobs:1,retentionSeconds:86400,sweepIntervalSeconds:60};
test('ASR request frequency is a validated deployment setting independent of provider QPS',()=>{
 assert.equal(resolveAsrConfig(config).requestRatePerMinute,60);
 assert.equal(resolveAsrConfig({...config,requestRatePerMinute:600}).requestRatePerMinute,600);
 for(const requestRatePerMinute of [0,-1,1.5,'600',NaN,Infinity])assert.throws(()=>resolveAsrConfig({...config,requestRatePerMinute}),/configuration/);
});

for(const configured of [undefined,65])test('ASR '+(configured??'legacy')+' requests use the configured per-account/IP window',async t=>{
 const root=await mkdtemp(join(tmpdir(),'muse-asr-admission-'));let server,reads=0;
 t.after(async()=>{if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}await rm(root,{recursive:true,force:true});});
 const store=await openStore(join(root,'accounts.json'));await store.create('fixture-editor','fixture-pass');
 const asr={get:async()=>{reads++;throw Object.assign(Error('not found'),{status:404});}},origin='https://muse.test';
 server=createAccountServer({store,asr,workspaceMode:'desktop',publicOrigin:origin,...configured===undefined?{}:{asrRequestRatePerMinute:configured}});
 const base=await new Promise(resolve=>server.listen(0,'127.0.0.1',()=>resolve('http://127.0.0.1:'+server.address().port)));
 const login=await fetch(base+'/login',{method:'POST',headers:{origin},body:new URLSearchParams({username:'fixture-editor',password:'fixture-pass'}),redirect:'manual'}),cookie=login.headers.get('set-cookie').split(';')[0];
 const limit=configured??60;
 for(let index=0;index<limit;index++)assert.equal((await fetch(base+'/api/asr/jobs/'+randomUUID(),{headers:{cookie}})).status,404);
 const blocked=await fetch(base+'/api/asr/jobs/'+randomUUID(),{headers:{cookie}});assert.equal(blocked.status,429);assert.equal(blocked.headers.get('retry-after'),'60');assert.equal((await blocked.json()).error_code,'request_rate');assert.equal(reads,limit);
});

test('invalid ASR request frequency rejects gateway construction before listeners are attached',async t=>{
 const root=await mkdtemp(join(tmpdir(),'muse-asr-rate-config-'));t.after(()=>rm(root,{recursive:true,force:true}));const store=await openStore(join(root,'accounts.json'));
 for(const asrRequestRatePerMinute of [0,-1,1.5,'600',NaN,Infinity])assert.throws(()=>createAccountServer({store,asrRequestRatePerMinute}),/ASR request rate/);
 assert.equal(store.listenerCount('change'),0);
});

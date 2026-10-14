import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,readdir,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fork} from 'node:child_process';
import {once,EventEmitter} from 'node:events';
import {createHash,randomUUID} from 'node:crypto';
import http from 'node:http';
import {installGatewayShutdown} from './gateway.mjs';

const deadline=()=>AbortSignal.timeout(15000);
function childMessages(child){
 const waiting=new Map(),received=new Map();
 child.on('message',message=>{const waiter=waiting.get(message.kind);if(waiter){waiting.delete(message.kind);waiter.resolve(message);}else received.set(message.kind,message);});
 return kind=>{if(received.has(kind)){const message=received.get(kind);received.delete(kind);return Promise.resolve(message);}const promise=Promise.withResolvers();waiting.set(kind,promise);return promise.promise;};
}

for(const mode of ['response','timeout'])test('real SIGTERM and repeated SIGINT retain an owned Flash '+mode+' before closing the gateway', {skip:process.platform==='win32'?'POSIX signals are not available on Windows':false,timeout:30000},async t=>{
 const root=await mkdtemp(join(tmpdir(),'muse-asr-shutdown-')),file=join(root,'fixture.mjs');let child;
 t.after(async()=>{if(child&&child.exitCode===null&&child.signalCode===null){const exited=once(child,'exit');child.kill('SIGKILL');await exited;}await rm(root,{recursive:true,force:true});});
 const imports=Object.fromEntries(['gateway','asr-service','store'].map(name=>[name,new URL('./'+name+'.mjs',import.meta.url).href]));
 await writeFile(file,`import {createAccountServer,installGatewayShutdown} from ${JSON.stringify(imports.gateway)};
import {createAsrService} from ${JSON.stringify(imports['asr-service'])};
import {openStore} from ${JSON.stringify(imports.store)};
import {recognizeFlashAsr} from ${JSON.stringify(new URL('./asr-provider.mjs',import.meta.url).href)};
import http from 'node:http';
import {join} from 'node:path';
const root=process.argv[2],release=Promise.withResolvers();
let calls=0;const mode=${JSON.stringify(mode)};
const supplier=mode==='timeout'?http.createServer(()=>process.send({kind:'entered',calls})):undefined;
if(supplier)await new Promise(resolve=>supplier.listen(0,'127.0.0.1',resolve));
const service=createAsrService({root:join(root,'ledger'),providerKind:'flash',provider:{recognize:async input=>{calls++;if(supplier)return await recognizeFlashAsr({appId:'synthetic',accessToken:'synthetic',timeoutMs:1000},input,(_url,init)=>fetch('http://127.0.0.1:'+supplier.address().port,init));process.send({kind:'entered',calls});await release.promise;return {status:'complete',segments:[{start:0,end:1,text:'original result retained'}]};}},maxConcurrentJobs:1,maxQueuedJobs:2,probe:async()=>10,maxAudioBytes:1024,maxDurationSeconds:7200,maxDailySeconds:72000,maxDailyJobs:100,maxActiveJobs:1,retentionSeconds:86400});
await service.ready();
const store=await openStore(join(root,'accounts.json'));
await store.create('fixture-editor','fixture-pass');
const server=createAccountServer({store,asr:service,workspaceMode:'desktop',publicOrigin:'https://muse.test'});
const shutdown=installGatewayShutdown({accountServer:server,asr:service,modelRelay:supplier});
process.on('message',message=>{if(message==='release')release.resolve();});
let notified=false;
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>{process.send({kind:'draining'});if(notified)return;notified=true;void shutdown.close().then(()=>{process.send({kind:'closed',calls});process.disconnect();},()=>{process.exitCode=1;process.disconnect();});});
server.listen(0,'127.0.0.1',()=>process.send({kind:'listening',port:server.address().port}));
`);
 child=fork(file,[root],{stdio:['ignore','pipe','pipe','ipc'],env:{...process.env,MUSE_ASR_CONFIG:'',MUSE_MODEL_CONFIG:'',MUSE_ENVIRONMENT:'production'}});
 let stderr='';child.stderr.on('data',chunk=>stderr+=chunk);const next=childMessages(child),exit=once(child,'exit');
 const {port}=await next('listening'),base='http://127.0.0.1:'+port,origin='https://muse.test';
 const login=await fetch(base+'/login',{method:'POST',headers:{origin},body:new URLSearchParams({username:'fixture-editor',password:'fixture-pass'}),redirect:'manual',signal:deadline()});assert.equal(login.status,303);
 const cookie=login.headers.get('set-cookie').split(';')[0],bytes=Buffer.from('audio'),hash=createHash('sha256').update(bytes).digest('hex'),id=randomUUID();
 const upload=key=>fetch(base+'/api/asr/jobs',{method:'POST',headers:{origin,cookie,'idempotency-key':key,'x-audio-sha256':hash,'x-audio-language':'zh','content-type':'audio/mpeg'},body:bytes,signal:deadline()});
 assert.equal((await upload(id)).status,202);await next('entered');child.kill('SIGTERM');await next('draining');child.kill('SIGINT');await next('draining');
 const refused=await upload(randomUUID());assert.equal(refused.status,503);assert.equal((await refused.json()).error_code,'server_draining');
 const active=await(await fetch(base+'/api/asr/jobs/'+id,{headers:{cookie},signal:deadline()})).json();assert.equal(active.recovery.next_action,'wait');assert.equal(child.exitCode,null);
 if(mode==='response')child.send('release');const closed=await next('closed');assert.equal(closed.calls,1);const [code,signal]=await exit;assert.equal(signal,null);assert.equal(code,0,stderr);
 const jobs=await readdir(join(root,'ledger','jobs')),saved=JSON.parse(await readFile(join(root,'ledger','jobs',jobs[0]),'utf8'));
 if(mode==='response'){assert.equal(saved.status,'complete');assert.equal(saved.segments[0].text,'original result retained');assert.equal((await readdir(join(root,'ledger','audio'))).length,0);}else{assert.equal(saved.status,'uncertain');assert.equal(saved.providerFailure.reason,'timeout');assert.equal(saved.providerFailure.operation,'flash');}assert.equal(jobs.length,1);
});

test('shutdown failure still closes sockets and listeners and reports one owned completion',async()=>{
 const server=http.createServer((_req,res)=>res.end('fixture'));server.stopAdmission=()=>{};
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const signals=new EventEmitter();let calls=0,poolClosed=0,sweepStopped=0;
 const controller=installGatewayShutdown({accountServer:server,signals,asr:{close:async()=>{calls++;throw Error('private internal failure');}},modelKeyPool:{close:()=>poolClosed++},stopSweep:()=>sweepStopped++});
 const first=controller.close(),second=controller.close();assert.equal(first,second);await assert.rejects(first,/internal failure/);assert.equal(server.listening,false);assert.equal(calls,1);assert.equal(poolClosed,1);assert.equal(sweepStopped,1);assert.equal(signals.listenerCount('SIGTERM'),0);assert.equal(signals.listenerCount('SIGINT'),0);
});

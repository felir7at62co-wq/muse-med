import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import fs from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
import {dirname,join} from 'node:path';
import {tmpdir} from 'node:os';
import {Readable} from 'node:stream';

test('admission and completion do not reread every historical receipt',async t=>{
 const root=await fs.mkdtemp(join(tmpdir(),'muse-asr-ledger-scale-'));
 const originalRead=fs.readFile;let collecting=false,receiptReads=0;
 fs.readFile=async function(file,...args){
  if(collecting&&typeof file==='string'&&dirname(file)===join(root,'jobs')&&file.endsWith('.json'))receiptReads++;
  return await originalRead.call(this,file,...args);
 };
 syncBuiltinESMExports();
 let initial,service;
 t.after(async()=>{
  collecting=false;
  try{await initial?.close();await service?.close();}finally{fs.readFile=originalRead;syncBuiltinESMExports();await fs.rm(root,{recursive:true,force:true});}
 });
 const {createAsrService}=await import('./asr-service.mjs');
 const bytes=Buffer.from('synthetic audio'),hash=createHash('sha256').update(bytes).digest('hex');
 const settings={root,providerKind:'flash',maxAudioBytes:1024,maxDurationSeconds:7200,maxDailySeconds:100000,
  maxDailyJobs:1000,maxActiveJobs:1,retentionSeconds:86400,maxConcurrentJobs:1,maxQueuedJobs:10,
  probe:async()=>10,provider:{recognize:async()=>({status:'silent'})}};
 initial=createAsrService(settings);await initial.ready();
 await initial.submit('seed',randomUUID(),hash,'zh',Readable.from(bytes));await initial.idle();await initial.close();initial=undefined;
 const seedFiles=await fs.readdir(join(root,'jobs'));
 const seed=JSON.parse(await fs.readFile(join(root,'jobs',seedFiles[0]),'utf8'));
 for(let i=0;i<160;i++){
  const id=randomUUID(),account='historic-'+i,key=createHash('sha256').update(account+'\0'+id).digest('hex');
  await fs.writeFile(join(root,'jobs',key+'.json'),JSON.stringify({...seed,id,account}));
 }
 service=createAsrService(settings);await service.ready();
 collecting=true;
 const id=randomUUID();await service.submit('new-account',id,hash,'zh',Readable.from(bytes));await service.idle();
 const result=await service.get('new-account',id);collecting=false;
 assert.equal(result.status,'silent');
 assert.ok(receiptReads<30,`admission and completion read ${receiptReads} historical receipt files`);
});

test('failed durable reservation neither consumes quota nor starts a provider',async t=>{
 const root=await fs.mkdtemp(join(tmpdir(),'muse-asr-ledger-write-'));
 const originalRename=fs.rename;let failNext=false,calls=0,service;
 fs.rename=async function(from,to){
  if(failNext&&typeof to==='string'&&dirname(to)===join(root,'jobs')&&to.endsWith('.json')){
   failNext=false;throw Object.assign(Error('synthetic ledger failure'),{code:'EIO'});
  }
  return await originalRename.call(this,from,to);
 };
 syncBuiltinESMExports();
 t.after(async()=>{try{await service?.close();}finally{fs.rename=originalRename;syncBuiltinESMExports();await fs.rm(root,{recursive:true,force:true});}});
 const {createAsrService}=await import('./asr-service.mjs');
 const bytes=Buffer.from('synthetic audio'),hash=createHash('sha256').update(bytes).digest('hex');
 service=createAsrService({root,providerKind:'flash',maxAudioBytes:1024,maxDurationSeconds:7200,maxDailySeconds:1000,
  maxDailyJobs:1,maxActiveJobs:1,retentionSeconds:86400,maxConcurrentJobs:1,maxQueuedJobs:10,
  probe:async()=>10,provider:{recognize:async()=>{calls++;return {status:'silent'};}}});
 await service.ready();failNext=true;
 await assert.rejects(service.submit('alice',randomUUID(),hash,'zh',Readable.from(bytes)),{code:'EIO'});
 assert.equal(calls,0);
 const job=await service.submit('alice',randomUUID(),hash,'zh',Readable.from(bytes));
 await service.idle();assert.equal((await service.get('alice',job.id)).status,'silent');assert.equal(calls,1);
 await assert.rejects(service.submit('alice',randomUUID(),hash,'zh',Readable.from(bytes)),{status:429,code:'daily_quota'});
 assert.equal(calls,1);
});

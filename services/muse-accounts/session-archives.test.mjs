/** Immutable archives use only task-owned synthetic transcripts and private temporary roots. */
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {mkdtemp,readFile,readdir,realpath,rm,stat,symlink,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import test from 'node:test';
import {ArchiveError,openSessionArchives} from './session-archives.mjs';

const alice='aaaaaaaaaaaaaaaa',bob='bbbbbbbbbbbbbbbb',device='00000000-0000-4000-8000-000000000001';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const event=seq=>({type:'fixture/message',seq,time:1000+seq,data:{text:`Synthetic ${seq}`}});
const body=(sessionId='chat',count=1,parentDigest=null)=>({version:1,parentDigest,header:{version:3,id:sessionId,createdAt:1000,isSeeded:false},inheritedEventCount:0,events:Array.from({length:count},(_,seq)=>event(seq)),attachments:[]});
const bytes=value=>Buffer.from(JSON.stringify(value));
const rejects=(operation,status,code)=>assert.rejects(operation,error=>error instanceof ArchiveError&&error.status===status&&error.code===code&&!/Synthetic|password|secret/.test(error.message));
async function fixture(t,options={}){
 const temporary=await realpath(tmpdir()),root=await mkdtemp(join(temporary,'muse-archives-')),directory=join(root,'archives'),clock={time:1800000000000};
 let store=await openSessionArchives(directory,{now:()=>clock.time,...options});
 t.after(async()=>{await store.flush();assert.ok(resolve(root).startsWith(resolve(temporary)));await rm(root,{recursive:true,force:true});});
 return {root,directory,clock,get store(){return store;},async restart(){await store.flush();store=await openSessionArchives(directory,{now:()=>clock.time,...options});return store;}};
}
async function put(store,value,account=alice,targetDevice=device){const raw=bytes(value),digest=hash(raw);return store.putRevision(account,targetDevice,value.header.id,digest,raw);}

test('prefix revisions preserve exact events, immutable receipts and restart continuity',async t=>{
 const f=await fixture(t),firstBody=body(),first=await put(f.store,firstBody);f.clock.time+=5000;
 const secondBody=body('chat',3,first.digest),second=await put(f.store,secondBody);
 assert.equal(first.eventCount,1);assert.equal(second.eventCount,3);assert.equal(second.parentDigest,first.digest);
 assert.deepEqual(await put(f.store,firstBody),first);
 const current=await f.store.latest(alice,device,'chat');assert.deepEqual(current,{receipt:second,archive:secondBody});
 current.archive.events[0].data.text='caller mutation';assert.deepEqual((await f.store.latest(alice,device,'chat')).archive,secondBody);
 await f.restart();assert.deepEqual(await f.store.latest(alice,device,'chat'),{receipt:second,archive:secondBody});
 const third=await put(f.store,body('chat',4,second.digest));assert.equal(third.eventCount,4);
 const sessionPath=join(f.directory,alice,'devices',device,hash(Buffer.from('chat')));
 assert.equal((await readdir(sessionPath)).filter(name=>/^[a-f0-9]{64}\.json$/.test(name)).length,3);
 if(process.platform!=='win32'){assert.equal((await stat(sessionPath)).mode&0o777,0o700);assert.equal((await stat(join(sessionPath,first.digest+'.json'))).mode&0o777,0o600);}
});

test('historical revision reads verify an exact prefix and revision pages remain immutable across appends',async t=>{
 const f=await fixture(t),firstBody=body(),first=await put(f.store,firstBody),secondBody=body('chat',3,first.digest),second=await put(f.store,secondBody);
 const selected=await f.store.revision(alice,device,'chat',first.digest);
 assert.deepEqual(selected.archive,firstBody);assert.deepEqual(selected.receipt,first);assert.equal(selected.contentDigest,hash(bytes(selected.archive)));assert.deepEqual(selected.children,[]);
 const page=await f.store.revisions(alice,device,'chat',{limit:1});assert.deepEqual(page.items,[second]);assert.equal(page.nextCursor,second.digest);
 const tail=await f.store.revisions(alice,device,'chat',{limit:1,cursor:page.nextCursor});assert.deepEqual(tail,{items:[first],nextCursor:null});
 await rejects(f.store.revision(bob,device,'chat',first.digest),404,'archive_not_found');
 await rejects(f.store.revisions(alice,device,'chat',{cursor:'0'.repeat(64)}),400,'invalid_archive');
 await f.restart();assert.deepEqual((await f.store.revision(alice,device,'chat',first.digest)).archive,firstBody);
});

test('compact browsing stays below reply limits for a valid large attachment manifest',async t=>{
 const f=await fixture(t),archive=body();
 for(let index=0;index<300;index++){
  const data=Buffer.from('attachment '+index),sha256=hash(data);await f.store.putAttachment(alice,sha256,data);
  archive.attachments.push({sha256,sizeBytes:data.length,mediaType:'application/'+ 'a'.repeat(110)});
 }
 const receipt=await put(f.store,archive);assert.ok(bytes(receipt).length>65536);
 const list=await f.store.list(alice,{summary:true}),revisions=await f.store.revisions(alice,device,'chat',{summary:true});
 for(const page of [list,revisions]){assert.equal(page.items[0].attachmentCount,300);assert.equal(page.items[0].attachments,undefined);assert.ok(bytes(page).length<2048);}
});

test('historical child evidence belongs to the same account and device and preserves descriptor data',async t=>{
 const f=await fixture(t),parent=await put(f.store,body('parent'));
 const child=body('child');child.header.origin='subagent';child.header.parentSession='parent';child.header.createdAt=2000;
 child.events=[{type:'subagent/descriptor',seq:0,time:2000,data:{version:3,provider:'spawn',mode:'one-shot'}}];await put(f.store,child);
 const other=structuredClone(child);other.header.id='other-device-child';await put(f.store,other,alice,randomUUID());
 const value=await f.store.revision(alice,device,'parent',parent.digest);
 assert.deepEqual(value.children,[{childId:'child',childCreatedAt:2000,descriptorCount:1,descriptor:child.events[0].data}]);
});

test('overlapping writes from the same parent commit one successor and reject the stale branch',async t=>{
 const f=await fixture(t),first=await put(f.store,body()),a=body('chat',2,first.digest),b=body('chat',3,first.digest);
 const results=await Promise.allSettled([put(f.store,a),put(f.store,b)]);
 assert.equal(results.filter(item=>item.status==='fulfilled').length,1);
 const failed=results.find(item=>item.status==='rejected');assert.equal(failed.reason.code,'archive_conflict');assert.equal(failed.reason.status,409);
 const latest=await f.store.latest(alice,device,'chat');assert.equal(latest.receipt.digest,results.find(item=>item.status==='fulfilled').value.digest);
 await f.restart();assert.equal((await f.store.latest(alice,device,'chat')).receipt.digest,latest.receipt.digest);
});

test('exact request digest, changed prefixes, changed headers and stale parents are rejected',async t=>{
 const f=await fixture(t),first=await put(f.store,body());
 await rejects(f.store.putRevision(alice,device,'chat','0'.repeat(64),bytes(body())),400,'invalid_archive');
 for(const mutate of [value=>value.events[0].data.text='changed',value=>value.header.createdAt++,value=>value.inheritedEventCount=1,value=>value.events=[],value=>value.parentDigest=null]){
  const value=body('chat',2,first.digest);mutate(value);const expected=value.inheritedEventCount===1?400:409;await rejects(put(f.store,value),expected,expected===400?'invalid_archive':'archive_conflict');
 }
 const spaced=Buffer.from(JSON.stringify(body('other'),null,2)),receipt=await f.store.putRevision(alice,device,'other',hash(spaced),spaced);assert.equal(receipt.digest,hash(spaced));
});

test('strict metadata refuses credentials, malformed events and traversal without retaining supplied content',async t=>{
 const f=await fixture(t);
 for(const mutate of [value=>value.header.cookie='secret-cookie',value=>value.header.api_key='secret-key',value=>value.accountId=bob,value=>value.events[0].seq=1,value=>value.events[0].time=-1,value=>value.events[0].credentials='secret',value=>value.events[0].ignorable=false,value=>value.events[0].sourceEventSeqs=[0],value=>value.header.id='other',value=>value.inheritedEventCount=2]){
  const value=body();mutate(value);const raw=bytes(value);await rejects(f.store.putRevision(alice,device,'chat',hash(raw),raw),400,'invalid_archive');
 }
 for(const args of [['../outside',device,'chat'],[alice,'../outside','chat'],[alice,device,'../outside']])await rejects(f.store.latest(...args),400,'invalid_archive');
 assert.deepEqual(await f.store.list(alice),{items:[],nextCursor:null});
});

test('accounts, devices and case-distinct session IDs remain separate on every filesystem',async t=>{
 const f=await fixture(t),otherDevice=randomUUID();await put(f.store,body('Chat'));await put(f.store,body('chat',2));await put(f.store,body('Chat',3),bob);await put(f.store,body('Chat',4),alice,otherDevice);
 assert.equal((await f.store.latest(alice,device,'Chat')).receipt.eventCount,1);assert.equal((await f.store.latest(alice,device,'chat')).receipt.eventCount,2);
 assert.equal((await f.store.latest(bob,device,'Chat')).receipt.eventCount,3);assert.equal((await f.store.latest(alice,otherDevice,'Chat')).receipt.eventCount,4);
 await rejects(f.store.latest(bob,device,'chat'),404,'archive_not_found');assert.equal((await f.store.list(bob)).items.length,1);
});

test('attachments require exact SHA and size, are immutable and private across accounts and restarts',async t=>{
 const f=await fixture(t),data=Buffer.from('synthetic fixture bytes'),digest=hash(data),archive=body();archive.attachments=[{sha256:digest,sizeBytes:data.length,mediaType:'text/plain'}];
 await rejects(put(f.store,archive),409,'archive_conflict');
 assert.deepEqual(await f.store.putAttachment(alice,digest,data),{version:1,sha256:digest,sizeBytes:data.length});
 assert.deepEqual(await f.store.putAttachment(alice,digest,data),{version:1,sha256:digest,sizeBytes:data.length});
 await rejects(f.store.putAttachment(alice,digest,Buffer.from('changed')),400,'invalid_archive');await rejects(f.store.getAttachment(bob,digest),404,'archive_not_found');
 const changed=structuredClone(archive);changed.attachments[0].sizeBytes++;await rejects(put(f.store,changed),409,'archive_conflict');
 const receipt=await put(f.store,archive);await f.restart();assert.deepEqual(await f.store.getAttachment(alice,digest),data);assert.deepEqual((await f.store.latest(alice,device,'chat')).receipt,receipt);
 const omitted=body('chat',2,receipt.digest);await rejects(put(f.store,omitted),409,'archive_conflict');
});

test('byte, event, attachment and revision limits fail explicitly without partial publication',async t=>{
 const f=await fixture(t,{maxRevisionBytes:2048,maxAttachmentBytes:4,maxEvents:2,maxAttachmentsPerRevision:1,maxRevisionsPerSession:2});
 await rejects(put(f.store,body('chat',3)),413,'archive_too_large');
 const tooLong=body();tooLong.events[0].data.text='x'.repeat(3000);await rejects(put(f.store,tooLong),413,'archive_too_large');
 const data=Buffer.from('12345');await rejects(f.store.putAttachment(alice,hash(data),data),413,'archive_too_large');
 const first=await put(f.store,body()),second=await put(f.store,body('chat',2,first.digest));const third=body('chat',2,second.digest);third.attachments=[];await rejects(put(f.store,third),413,'archive_too_large');
 const many=body('other');many.attachments=[{sha256:'a'.repeat(64),sizeBytes:0,mediaType:'text/plain'},{sha256:'b'.repeat(64),sizeBytes:0,mediaType:'text/plain'}];await rejects(put(f.store,many),413,'archive_too_large');
 assert.equal((await f.store.latest(alice,device,'chat')).receipt.digest,second.digest);
});

test('stable pagination returns latest receipts without transcript content',async t=>{
 const f=await fixture(t);for(const name of ['a','b','c'])await put(f.store,body(name));
 const first=await f.store.list(alice,{limit:2});assert.deepEqual(first.items.map(item=>item.sessionId),['a','b']);assert.ok(first.nextCursor);assert.equal(JSON.stringify(first).includes('Synthetic'),false);
 const second=await f.store.list(alice,{limit:2,cursor:first.nextCursor});assert.deepEqual(second.items.map(item=>item.sessionId),['c']);assert.equal(second.nextCursor,null);
 await rejects(f.store.list(alice,{limit:101}),400,'invalid_archive');await rejects(f.store.list(alice,{cursor:'bad'}),400,'invalid_archive');
});

test('restart rejects unsupported persisted schema and modified committed prefixes',async t=>{
 const f=await fixture(t),receipt=await put(f.store,body()),path=join(f.directory,alice,'devices',device,hash(Buffer.from('chat')),receipt.digest+'.json');
 const original=JSON.parse(await readFile(path,'utf8'));await writeFile(path,JSON.stringify({...original,version:2}),{mode:0o600});await f.restart();await rejects(f.store.latest(alice,device,'chat'),503,'archive_unavailable');
 original.manifest.eventsDelta[0].data.text='Changed fixture';await writeFile(path,JSON.stringify(original),{mode:0o600});await f.restart();await rejects(f.store.latest(alice,device,'chat'),503,'archive_unavailable');
});

test('private schema manifest survives restart and refuses unknown versions before serving archives',async t=>{
 const f=await fixture(t),path=join(f.directory,'schema.json');assert.deepEqual(JSON.parse(await readFile(path,'utf8')),{version:1,kind:'muse-session-archives'});
 await writeFile(path,JSON.stringify({version:2,kind:'muse-session-archives'}),{mode:0o600});await rejects(f.restart(),503,'archive_unavailable');
});

test('symlinked account directories cannot read or publish outside the private root',async t=>{
 const f=await fixture(t);await put(f.store,body(),bob);const target=join(f.directory,bob);await symlink(target,join(f.directory,alice),process.platform==='win32'?'junction':'dir');
 await rejects(f.store.latest(alice,device,'chat'),503,'archive_unavailable');await rejects(put(f.store,body('new')),503,'archive_unavailable');
 assert.deepEqual((await f.store.list(bob)).items.map(item=>item.sessionId),['chat']);
});

test('I/O failure is visible and a later operation can proceed after storage is repaired',async t=>{
 const f=await fixture(t),path=join(f.directory,alice);await writeFile(path,'blocked account directory');await rejects(put(f.store,body()),503,'archive_unavailable');
 await rm(path);assert.equal((await put(f.store,body())).eventCount,1);await f.store.flush();
});

test('malformed UTF-8 and JSON are refused before any archive publication',async t=>{
 const f=await fixture(t);
 for(const raw of [Buffer.from('{'),Buffer.from([0xc3,0x28])])await rejects(f.store.putRevision(alice,device,'chat',hash(raw),raw),400,'invalid_archive');
 assert.deepEqual(await f.store.list(alice),{items:[],nextCursor:null});
});

test('older sessions leave the validation memo and are checked again on their next read',async t=>{
 const f=await fixture(t),first=await put(f.store,body('first'));await put(f.store,body('second'));await put(f.store,body('third'));
 const path=join(f.directory,alice,'devices',device,hash(Buffer.from('first')),first.digest+'.json');const stored=JSON.parse(await readFile(path,'utf8'));await writeFile(path,JSON.stringify({...stored,version:2}),{mode:0o600});
 await rejects(f.store.latest(alice,device,'first'),503,'archive_unavailable');
 assert.equal((await f.store.latest(alice,device,'second')).receipt.sessionId,'second');
});

test('later revisions store only new events and new attachment descriptors while restoring the complete prefix',async t=>{
 const f=await fixture(t),a=Buffer.from('attachment A'),b=Buffer.from('attachment B'),attachmentA={sha256:hash(a),sizeBytes:a.length,mediaType:'text/plain'},attachmentB={sha256:hash(b),sizeBytes:b.length,mediaType:'text/plain'};
 await f.store.putAttachment(alice,attachmentA.sha256,a);await f.store.putAttachment(alice,attachmentB.sha256,b);
 const one=body();one.events[0].data.text='synthetic-long-prefix-'.repeat(2048);one.attachments=[attachmentA];const first=await put(f.store,one);
 const two=structuredClone(one);two.parentDigest=first.digest;two.events.push(event(1));two.attachments=[attachmentB,attachmentA];const second=await put(f.store,two);
 const path=join(f.directory,alice,'devices',device,hash(Buffer.from('chat'))),firstFile=await readFile(join(path,first.digest+'.json')),secondFile=await readFile(join(path,second.digest+'.json')),manifest=JSON.parse(secondFile).manifest;
 assert.deepEqual(manifest.eventsDelta,[event(1)]);assert.deepEqual(manifest.attachmentsDelta,[attachmentB]);assert.deepEqual(manifest.attachmentOrder,[attachmentB.sha256,attachmentA.sha256]);
 assert.ok(secondFile.length<4096);assert.ok(firstFile.length>40000);assert.equal(secondFile.includes(Buffer.from('synthetic-long-prefix-')),false);
 await f.restart();assert.deepEqual((await f.store.latest(alice,device,'chat')).archive,two);assert.deepEqual(await put(f.store,one),first);
});

test('account storage quota counts persisted bytes, survives restart and does not count an idempotent upload twice',async t=>{
 const f=await fixture(t,{maxAccountBytes:1024}),a=Buffer.alloc(700,1),b=Buffer.alloc(700,2);await f.store.putAttachment(alice,hash(a),a);
 await rejects(f.store.putAttachment(alice,hash(b),b),413,'archive_quota_exceeded');await f.store.putAttachment(alice,hash(a),a);
 await f.restart();await rejects(f.store.putAttachment(alice,hash(b),b),413,'archive_quota_exceeded');await rejects(f.store.getAttachment(alice,hash(b)),404,'archive_not_found');
 await f.store.putAttachment(bob,hash(b),b);assert.deepEqual(await f.store.getAttachment(bob,hash(b)),b);
});

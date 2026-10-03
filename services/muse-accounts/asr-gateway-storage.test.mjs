/** Private signed downloads exercise the real HTTP route and task-owned files without supplier requests. */
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {createServer} from 'node:http';
import {mkdtemp,mkdir,readFile,realpath,rm,stat,symlink,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import test from 'node:test';
import {createGatewayAudioStore} from './asr-gateway-storage.mjs';

const baseURL='https://fixture.example/api/asr/audio/',secret='synthetic-private-signing-secret-32-bytes',bytes=Buffer.from('synthetic audio 0123456789');
async function fixture(t,overrides={}){
 const prefix=join(await realpath(tmpdir()),'muse-asr-store-'),root=await mkdtemp(prefix),clock={value:1_790_000_000_000},pending=new Set();
 const source=join(root,'input.mp3');await writeFile(source,bytes);
 let server,store;
 const fetcher=(url,options)=>{const parsed=new URL(url);return fetch('http://127.0.0.1:'+server.address().port+parsed.pathname+parsed.search,options);};
 const options={root:join(root,'objects'),baseURL,secret,signedUrlTtlSeconds:5,timeoutMs:1000,fetcher,now:()=>clock.value,...overrides};
 store=createGatewayAudioStore(options);
 server=createServer((req,res)=>{const task=store.handle(req,res).then(handled=>{if(!handled){res.writeHead(404);res.end();}}).finally(()=>pending.delete(task));pending.add(task);});
 t.after(async()=>{
  await new Promise(resolveClose=>{server.close(resolveClose);server.closeAllConnections();});await Promise.allSettled([...pending]);
  assert.ok(resolve(root).startsWith(resolve(prefix)),'Cleanup must stay in the task-owned temporary directory');await rm(root,{recursive:true,force:true});
 });
 server.listen(0,'127.0.0.1');await once(server,'listening');await store.ready();
 const key=store.key(randomUUID(),'mp3');
 return {root,clock,source,key,store,request:fetcher,restart:async()=>{store=createGatewayAudioStore(options);await store.ready();return store;}};
}

test('unsigned requests are forbidden while signed GET and HEAD expose only the private audio object',{timeout:5000},async t=>{
 const f=await fixture(t);await f.store.assertPrivateBeforeUpload();await f.store.upload(f.source,f.key);
 const url=await f.store.signedReadUrl(f.key);await f.store.assertPrivateAndReadable(f.key,url);
 const anonymous=await f.request(baseURL+f.key);assert.equal(anonymous.status,403);await anonymous.body.cancel();
 const response=await f.request(url);assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');assert.equal(response.headers.get('content-type'),'audio/mpeg');
 assert.deepEqual(Buffer.from(await response.arrayBuffer()),bytes);
 const head=await f.request(url,{method:'HEAD'});assert.equal(head.status,200);assert.equal(Number(head.headers.get('content-length')),bytes.length);assert.equal((await head.arrayBuffer()).byteLength,0);
 const wrongMethod=await f.request(url,{method:'POST'});assert.equal(wrongMethod.status,405);assert.equal(wrongMethod.headers.get('allow'),'GET, HEAD');await wrongMethod.body.cancel();
 if(process.platform!=='win32'){assert.equal((await stat(join(f.root,'objects'))).mode&0o777,0o700);assert.equal((await stat(join(f.root,'objects',f.key))).mode&0o777,0o600);}
});

test('single byte ranges and suffix ranges return matching content and invalid ranges return 416',{timeout:5000},async t=>{
 const f=await fixture(t);await f.store.upload(f.source,f.key);const url=await f.store.signedReadUrl(f.key);
 for(const [range,start,end] of [['bytes=2-5',2,5],['bytes=20-',20,bytes.length-1],['bytes=-3',bytes.length-3,bytes.length-1]]){
  const response=await f.request(url,{headers:{range}});assert.equal(response.status,206);assert.equal(response.headers.get('content-range'),`bytes ${start}-${end}/${bytes.length}`);assert.deepEqual(Buffer.from(await response.arrayBuffer()),bytes.subarray(start,end+1));
 }
 for(const range of ['bytes=999-','bytes=5-2','bytes=-0','bytes=0-1,3-4','items=0-1']){
  const response=await f.request(url,{headers:{range}});assert.equal(response.status,416);assert.equal(response.headers.get('content-range'),'bytes */'+bytes.length);await response.body.cancel();
 }
});

test('expired signatures, modified signatures, extra parameters and traversal cannot read audio',{timeout:5000},async t=>{
 const f=await fixture(t);await f.store.upload(f.source,f.key);const url=await f.store.signedReadUrl(f.key);
 const invalid=new URL(url);invalid.searchParams.set('signature','0'.repeat(64));
 const signature=await f.request(invalid);assert.equal(signature.status,403);await signature.body.cancel();
 const extra=new URL(url);extra.searchParams.append('expires',extra.searchParams.get('expires'));const duplicated=await f.request(extra);assert.equal(duplicated.status,403);await duplicated.body.cancel();
 const traversal=await f.request(baseURL+'%2F..%2Foutside');assert.equal(traversal.status,403);await traversal.body.cancel();
 f.clock.value+=5000;const expired=await f.request(url);assert.equal(expired.status,403);await expired.body.cancel();
});

test('immutable uploads reject replacement and old signatures cannot read a re-created object',{timeout:5000},async t=>{
 const f=await fixture(t);await Promise.all([f.store.upload(f.source,f.key),f.store.upload(f.source,f.key)]);
 const originalURL=await f.store.signedReadUrl(f.key),replacement=join(f.root,'replacement.mp3');await writeFile(replacement,'other audio');
 await assert.rejects(f.store.upload(replacement,f.key),/immutable/i);assert.deepEqual(await readFile(join(f.root,'objects',f.key)),bytes);
 await f.store.remove(f.key);await f.store.remove(f.key);const missing=await f.request(originalURL);assert.equal(missing.status,404);await missing.body.cancel();
 await f.store.upload(replacement,f.key);const stale=await f.request(originalURL);assert.equal(stale.status,403);await stale.body.cancel();
 const current=await f.request(await f.store.signedReadUrl(f.key));assert.equal(await current.text(),'other audio');
});

test('reparse points, directories and changed file size cannot be downloaded',{timeout:5000},async t=>{
 const f=await fixture(t);await f.store.upload(f.source,f.key);const url=await f.store.signedReadUrl(f.key),object=join(f.root,'objects',f.key),outside=join(f.root,'outside');await mkdir(outside);
 await rm(object);await symlink(outside,object,process.platform==='win32'?'junction':'dir');
 const linked=await f.request(url);assert.equal(linked.status,404);await linked.body.cancel();await rm(object);await mkdir(object);
 const directory=await f.request(url);assert.equal(directory.status,404);await directory.body.cancel();await rm(object,{recursive:true});await writeFile(object,'changed');
 const changed=await f.request(url);assert.equal(changed.status,404);await changed.body.cancel();
});

test('invalid deployment settings and invalid object IDs fail without revealing supplied values',()=>{
 const options={root:resolve(tmpdir(),'unused-private-audio-'+randomUUID()),baseURL,secret,signedUrlTtlSeconds:5,timeoutMs:1000};
 for(const altered of [{root:'relative'},{baseURL:'http://fixture.example/api/asr/audio/'},{baseURL:baseURL+'?secret=private'},{secret:'short-private-value'},{signedUrlTtlSeconds:0},{signedUrlTtlSeconds:604801},{timeoutMs:0}]){
  assert.throws(()=>createGatewayAudioStore({...options,...altered}),error=>/Invalid gateway audio storage configuration/.test(error.message)&&!error.message.includes('private-value'));
 }
 const store=createGatewayAudioStore(options);assert.throws(()=>store.key('../private','mp3'),/Invalid audio object/i);assert.throws(()=>store.key(randomUUID(),'aac'),/Invalid audio object/i);
});

test('restart reads the durable object metadata and preserves previously issued signatures',{timeout:5000},async t=>{
 const f=await fixture(t);await f.store.upload(f.source,f.key);const url=await f.store.signedReadUrl(f.key);
 const recovered=await f.restart();await recovered.assertPrivateAndReadable(f.key,url);
 const response=await f.request(url);assert.deepEqual(Buffer.from(await response.arrayBuffer()),bytes);
});

test('cleanup waits for the same object upload and leaves no published audio or metadata',{timeout:5000},async t=>{
 const f=await fixture(t);await Promise.all([f.store.upload(f.source,f.key),f.store.remove(f.key)]);
 await assert.rejects(f.store.signedReadUrl(f.key),/unavailable/i);
 await assert.rejects(readFile(join(f.root,'objects',f.key)),{code:'ENOENT'});
 await assert.rejects(readFile(join(f.root,'objects',f.key+'.json')),{code:'ENOENT'});
});

test('download verification hides transport and cancelled-body diagnostics',{timeout:5000},async t=>{
 const f=await fixture(t,{fetcher:async()=>new Response(new ReadableStream({cancel(){throw Error('upstream-private-value');}}),{status:403})});
 await assert.rejects(f.store.assertPrivateBeforeUpload(),error=>error.message==='Gateway audio download verification failed');
});

test('standard task audio stays readable beyond one hour with a declared daily signature lifetime',{timeout:5000},async t=>{
 const f=await fixture(t,{signedUrlTtlSeconds:86400});await f.store.upload(f.source,f.key);const url=await f.store.signedReadUrl(f.key);
 f.clock.value+=7200*1000;const response=await f.request(url);assert.equal(response.status,200);assert.deepEqual(Buffer.from(await response.arrayBuffer()),bytes);
 f.clock.value+=79200*1000;const expired=await f.request(url);assert.equal(expired.status,403);await expired.body.cancel();
});

test('an upload repairs missing metadata after interrupted object publication without replacing audio',{timeout:5000},async t=>{
 const f=await fixture(t);await f.store.upload(f.source,f.key);await rm(join(f.root,'objects',f.key+'.json'));
 const recovered=await f.restart();await recovered.upload(f.source,f.key);const response=await f.request(await recovered.signedReadUrl(f.key));assert.equal(response.status,200);assert.deepEqual(Buffer.from(await response.arrayBuffer()),bytes);
});

/** Real HTTP authentication, provider-response accounting and account-private archive recovery. */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir as systemTmpdir} from 'node:os';
import {realpathSync as realpathOfTmpdir} from 'node:fs';
// Private-directory checks compare real paths; the system temp directory can be reached through a link (macOS /var).
const tmpdir=()=>realpathOfTmpdir(systemTmpdir());
import {join} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {openStore} from './store.mjs';
import {createAccountServer} from './gateway.mjs';
import {openUsageLedger} from './usage-ledger.mjs';
import {openSessionArchives} from './session-archives.mjs';
import {accountToken,createModelRelay} from './model-relay.mjs';
import {createAccountDataAdmission} from './account-data-http.mjs';
import {observeModelResponseBytes} from './model-request-metadata.mjs';

const origin='https://muse.fixture.test',now=()=>Date.UTC(2026,10,12),sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const listen=server=>new Promise(resolve=>server.listen(0,'127.0.0.1',()=>resolve(`http://127.0.0.1:${server.address().port}`)));
async function fixture(t,options={}){
 const root=await mkdtemp(join(tmpdir(),'muse-account-data-')),servers=[];let providerCalls=0;
 t.after(async()=>{for(const server of servers){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}await rm(root,{recursive:true,force:true});});
 const store=await openStore(join(root,'accounts.json')),alice=await store.create('alice','fixture-password'),bob=await store.create('bob','fixture-password'),admin=await store.create('admin','fixture-password',{admin:true});
 const usageLedger=await openUsageLedger(join(root,'usage'),{now}),sessionArchives=await openSessionArchives(join(root,'archives'),{maxRevisionBytes:4096,maxAttachmentBytes:32,now});
 const provider=http.createServer(async(req,res)=>{for await(const chunk of req){void chunk;}providerCalls++;res.setHeader('content-type','application/json');res.end(JSON.stringify({id:'fixture-response',model:'writer',choices:[{message:{content:'PRIVATE_TRANSCRIPT_NOT_LEDGER_METADATA'},finish_reason:'stop'}],usage:{prompt_tokens:12,completion_tokens:4,total_tokens:16}}));});
 servers.push(provider);const providerUrl=await listen(provider),modelConfig={private:()=>({model:'writer',name:'Fixture',apiKey:'PRIVATE_FIXTURE_PROVIDER_KEY',baseURL:providerUrl+'/v1',maxTokens:100,reasoningEfforts:false})};
 const forward=async({config,body,res,metadata,signal})=>{
  const serialized=JSON.stringify(body);metadata.forwarded({model:body.model,bytes:Buffer.byteLength(serialized),stream:body.stream,secret:config.apiKey});
  const upstream=await fetch(providerUrl+'/v1/chat/completions',{method:'POST',signal,body:serialized});metadata.upstream(upstream.status);
  const source=Readable.fromWeb(upstream.body);source.once('end',()=>metadata.eof());res.writeHead(200,{'content-type':'application/json'});await pipeline(observeModelResponseBytes(source,metadata),res);
 };
 const server=createAccountServer({store,usageLedger,sessionArchives,modelConfig,modelForward:forward,publicOrigin:origin,now,...options});servers.unshift(server);const base=await listen(server);
 const request=(path,opts={})=>fetch(base+path,{redirect:'manual',...opts});
 const cookies={};for(const username of ['alice','bob','admin']){const response=await request('/login',{method:'POST',headers:{origin},body:new URLSearchParams({username,password:'fixture-password'})});assert.equal(response.status,303);cookies[username]=response.headers.get('set-cookie').split(';')[0];}
 const call=(path,who='alice',opts={})=>request(path,{...opts,headers:{cookie:cookies[who],...opts.method&&opts.method!=='GET'?{origin}:{},...opts.headers}});
 return {root,store,alice,bob,admin,usageLedger,sessionArchives,modelConfig,forward,servers,server,request,call,cookies,providerCalls:()=>providerCalls};
}
function archive(sessionId,events=[],extra={}){return {version:1,parentDigest:null,header:{version:3,id:sessionId,createdAt:now(),isSeeded:false},inheritedEventCount:0,events,attachments:[],...extra};}
const event=seq=>({type:'fixture/event',seq,time:now(),data:{text:'private fixture conversation'}});

test('identity and administrator metadata reuse verified account roles; unauthenticated APIs never redirect',async t=>{
 const f=await fixture(t);
 for(const path of ['/api/muse/identity','/api/muse/usage','/api/muse/session-archives','/api/admin/usage','/api/admin/accounts']){const response=await f.request(path);assert.equal(response.status,401);assert.deepEqual(await response.json(),{error:{code:'account_session_expired'}});}
 const identity=await(await f.call('/api/muse/identity')).json();assert.equal(identity.accountId,f.alice.id);assert.equal(identity.username,'alice');
 const token=f.cookies.alice.split('=')[1],bearer=await(await f.request('/api/muse/identity',{headers:{authorization:'Bearer '+token}})).json();assert.equal(bearer.accountId,f.alice.id);
 assert.equal((await f.call('/api/admin/accounts')).status,403);assert.equal((await f.call('/api/admin/usage')).status,403);
 const accounts=await(await f.call('/api/admin/accounts','admin')).json();assert.equal(accounts.items.length,3);assert.doesNotMatch(JSON.stringify(accounts),/fixture-password|salt|hash|cookie/);
 assert.equal((await f.call('/api/muse/usage?accountId='+f.bob.id)).status,400);
});

test('studio forwarding uses the verified account, private worker header and existing gateway Origin checks',async t=>{
 const selected=[],seen=[],token='a'.repeat(64);
 const worker=http.createServer((req,res)=>{seen.push(req.headers);assert.equal(req.headers['x-muse-studio-worker'],token);assert.equal(req.headers.cookie,undefined);assert.equal(req.headers.authorization,undefined);req.resume();res.setHeader('content-type','application/json');res.end(JSON.stringify({ok:true}));});
 const target=new URL(await listen(worker));t.after(()=>new Promise(resolve=>{worker.closeAllConnections();worker.close(resolve);}));
 const runtime={limits:{maxRequestBytes:4096,requestTimeoutMs:2000},async acquire(id){selected.push(id);return {target,token,release(){}};}};
 const f=await fixture(t,{studioRuntime:runtime});
 assert.equal((await f.request('/studio/')).status,401);
 assert.equal((await f.call('/studio')).status,303);
 const own=await f.call('/studio/api/v1/dramas','alice',{headers:{'x-account-id':'forged','x-muse-studio-worker':'forged'}});assert.equal(own.status,200);await own.text();
 const other=await f.call('/studio/api/v1/images','bob',{method:'POST',headers:{'content-type':'application/json','x-muse-operation-id':'fixture-operation'},body:'{}'});assert.equal(other.status,200);await other.text();
 const bearer=await f.request('/studio/api/v1/dramas',{headers:{authorization:'Bearer '+f.cookies.alice.split('=')[1]}});assert.equal(bearer.status,200);await bearer.text();
 assert.deepEqual(selected,[f.alice.id,f.bob.id,f.alice.id]);assert.equal(seen[1]['x-muse-operation-id'],'fixture-operation');
 assert.equal((await f.call('/studio/api/v1/images','alice',{method:'POST',headers:{origin:'https://other.fixture'},body:'{}'})).status,403);assert.equal(selected.length,3);
 const without=await fixture(t);assert.equal((await without.call('/studio/')).status,404);
});

test('native studio usage is private to its account and administrators must select an existing account',async t=>{
 const selected=[],f=await fixture(t,{studioUsage:{async query(accountId,options){selected.push({accountId,options});return {version:2,scope:'studio-all',accountId,status:'no-database',billingVerified:false};}}});
 assert.equal((await f.request('/api/admin/studio-usage')).status,401);
 assert.equal((await f.call('/api/admin/studio-usage?accountId='+f.bob.id)).status,403);
 assert.equal((await f.call('/api/admin/studio-usage','admin')).status,400);
 assert.equal((await f.call('/api/admin/studio-usage?accountId=0000000000000000','admin')).status,404);
 assert.equal((await f.call('/api/muse/studio-usage?accountId='+f.bob.id)).status,400);
 const own=await(await f.call('/api/muse/studio-usage?from=2026-11-01&to=2026-11-12&limit=2')).json();assert.equal(own.accountId,f.alice.id);
 const other=await(await f.call('/api/admin/studio-usage?accountId='+f.bob.id,'admin')).json();assert.equal(other.accountId,f.bob.id);assert.equal(other.scope,'studio-all');
 assert.deepEqual(selected,[{accountId:f.alice.id,options:{from:'2026-11-01',to:'2026-11-12',limit:2}},{accountId:f.bob.id,options:{}}]);
 assert.equal((await f.call('/api/muse/studio-usage?limit=1&limit=2')).status,400);assert.equal(selected.length,2);
});

test('logout during a studio metadata read refuses delivery and missing studio configuration stays explicit',async t=>{
 let enter,release;const entered=new Promise(resolve=>{enter=resolve;}),gate=new Promise(resolve=>{release=resolve;});
 const f=await fixture(t,{studioUsage:{async query(){enter();await gate;return {sentinel:'must_not_deliver_private_metadata'};}}});
 const pending=f.call('/api/muse/studio-usage');await entered;await f.call('/logout','alice',{method:'POST'});release();
 const rejected=await pending;assert.equal(rejected.status,401);assert.doesNotMatch(await rejected.text(),/must_not_deliver/);
 const absent=await fixture(t);const response=await absent.call('/api/muse/studio-usage');assert.equal(response.status,503);assert.equal((await response.json()).error.code,'studio_usage_not_configured');
});

test('account data pages load only same-origin assets while login keeps its script-free policy',async t=>{
 const f=await fixture(t),account=await f.call('/account'),admin=await f.call('/admin','admin');
 assert.match(await account.text(),/data-muse-account-data/);assert.match(account.headers.get('content-security-policy'),/script-src 'self'; connect-src 'self';/);
 assert.match(await admin.text(),/data-admin=["']true["']/);assert.match(admin.headers.get('content-security-policy'),/style-src 'self' 'unsafe-inline'/);
 const administratorOwnPage=await(await f.call('/account','admin')).text();assert.match(administratorOwnPage,/data-admin=["']false["']/);
 for(const [path,type]of [['/account-data-client.js','text/javascript'],['/account-data.css','text/css']]){const asset=await f.call(path);assert.equal(asset.status,200);assert.match(asset.headers.get('content-type'),new RegExp(type));assert.ok((await asset.text()).length>0);}
 assert.doesNotMatch((await f.request('/login')).headers.get('content-security-policy'),/script-src|connect-src/);
 assert.equal((await f.request('/account-data-client.js')).status,303);
});

test('both real relay transports persist actual supplier usage under authenticated identity only',async t=>{
 const f=await fixture(t),body=JSON.stringify({model:'muse-shared',messages:[{role:'user',content:'PRIVATE_PROMPT_NOT_LEDGER_METADATA'}],stream:false,accountId:f.bob.id});
 const desktop=await f.call('/api/desktop-models/muse-shared/chat/completions','alice',{method:'POST',headers:{'content-type':'application/json','x-account-id':f.bob.id},body});assert.equal(desktop.status,200);await desktop.text();
 const secret='fixture-relay-secret-'.repeat(3),relay=createModelRelay({config:f.modelConfig,secret,accounts:f.store,usageLedger:f.usageLedger,forward:f.forward,metadataSink:()=>{}});f.servers.push(relay);const url=await listen(relay);
 const response=await fetch(url+'/v1/chat/completions',{method:'POST',headers:{authorization:'Bearer '+accountToken(secret,f.bob.id),'content-type':'application/json'},body});assert.equal(response.status,200);await response.text();await f.usageLedger.flush();
 const own=await(await f.call('/api/muse/usage')).json();assert.equal(own.summary.requests,1);assert.equal(own.summary.totalTokens,16);assert.equal(own.items[0].channel,'desktop-relay');assert.equal(own.items[0].accountId,undefined);
 const other=await(await f.call('/api/muse/usage','bob')).json();assert.equal(other.summary.requests,1);assert.equal(other.items[0].channel,'cloud-relay');
 const all=await(await f.call('/api/admin/usage','admin')).json();assert.equal(all.summary.requests,2);assert.equal(all.summary.totalTokens,32);assert.equal(new Set(all.items.map(item=>item.accountId)).size,2);
 assert.equal(f.providerCalls(),2);assert.doesNotMatch(JSON.stringify(all),/PRIVATE_|fixture-relay-secret|fixture-password/);assert.deepEqual(all.coverage,{transport:'relay-only',direct:'unobserved'});
});

test('unavailable reservation storage prevents a paid dispatch and exposes a 503',async t=>{
 const f=await fixture(t,{usageLedger:{begin:async()=>{throw new Error('fixture storage failure');}}});
 const response=await f.call('/api/desktop-models/muse-shared/chat/completions','alice',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({model:'muse-shared',messages:[]})});
 assert.equal(response.status,503);assert.equal(f.providerCalls(),0);assert.match(await response.text(),/未调用模型/);
});

test('archive upload, digest reconciliation, prefix CAS, pagination and attachment download remain account-private',async t=>{
 const f=await fixture(t),deviceId=randomUUID(),sessionId=randomUUID(),prefix=`/api/muse/session-archives/${deviceId}/${sessionId}`,bytes=Buffer.from('fixture attachment'),hash=sha(bytes);
 const attachment=await f.call('/api/muse/session-archives/attachments/'+hash,'alice',{method:'PUT',headers:{'content-type':'application/octet-stream'},body:bytes});assert.equal(attachment.status,201);
 const body=JSON.stringify(archive(sessionId,[event(0)],{attachments:[{sha256:hash,sizeBytes:bytes.length,mediaType:'text/plain'}]})),digest=sha(body);
 const put=()=>f.call(prefix+'/revisions/'+digest,'alice',{method:'PUT',headers:{'content-type':'application/json'},body});
 const first=await put();assert.equal(first.status,201);const receipt=await first.json();assert.equal(receipt.eventCount,1);assert.deepEqual(await(await put()).json(),receipt);
 const latest=await(await f.call(prefix)).json();assert.deepEqual(latest.archive,JSON.parse(body));assert.equal(latest.receipt.digest,digest);
 const next=JSON.stringify(archive(sessionId,[event(0),event(1)],{parentDigest:digest,attachments:JSON.parse(body).attachments}));
 assert.equal((await f.call(prefix+'/revisions/'+sha(next),'alice',{method:'PUT',headers:{'content-type':'application/json'},body:next})).status,201);
 const stale=JSON.stringify(archive(sessionId,[event(0),event(1),event(2)],{parentDigest:digest}));assert.equal((await f.call(prefix+'/revisions/'+sha(stale),'alice',{method:'PUT',headers:{'content-type':'application/json'},body:stale})).status,409);
 assert.equal((await f.call(prefix,'bob')).status,404);assert.equal((await f.call('/api/muse/session-archives/attachments/'+hash,'bob')).status,404);
 const downloaded=await f.call('/api/muse/session-archives/attachments/'+hash);assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()),bytes);
 const listed=await(await f.call('/api/muse/session-archives?limit=1')).json();assert.equal(listed.items.length,1);assert.equal(listed.items[0].eventCount,2);assert.equal(listed.items[0].events,undefined);
 const summary=await(await f.call('/api/muse/session-archives?summary=1')).json();assert.equal(summary.items[0].attachmentCount,1);assert.equal(summary.items[0].attachments,undefined);
 const revisions=await(await f.call(prefix+'/revisions?summary=1&limit=1')).json();assert.equal(revisions.items[0].eventCount,2);assert.ok(revisions.nextCursor);
 const selected=await(await f.call(prefix+'/revisions/'+digest)).json();assert.deepEqual(selected.archive,JSON.parse(body));assert.equal(selected.contentDigest,sha(JSON.stringify(selected.archive)));
 assert.equal((await f.call(prefix+'/revisions/'+digest,'bob')).status,404);
 assert.equal((await f.request(prefix+'/revisions/'+digest)).status,401);
 assert.equal((await f.call('/api/muse/session-archives?summary=all')).status,400);
});

test('archive failures reject CSRF, credentials in metadata, wrong hashes, oversized bodies and unsupported media types',async t=>{
 const f=await fixture(t),deviceId=randomUUID(),sessionId=randomUUID(),prefix=`/api/muse/session-archives/${deviceId}/${sessionId}/revisions/`,value=archive(sessionId,[event(0)]),body=JSON.stringify(value),digest=sha(body);
 assert.equal((await f.call(prefix+digest,'alice',{method:'PUT',headers:{origin:'https://other.fixture','content-type':'application/json'},body})).status,403);
 assert.equal((await f.call(prefix+digest,'alice',{method:'PUT',headers:{'content-type':'text/plain'},body})).status,415);
 assert.equal((await f.call(prefix+'f'.repeat(64),'alice',{method:'PUT',headers:{'content-type':'application/json'},body})).status,400);
 const secret=JSON.stringify({...value,header:{...value.header,cookie:'PRIVATE_COOKIE'}});assert.equal((await f.call(prefix+sha(secret),'alice',{method:'PUT',headers:{'content-type':'application/json'},body:secret})).status,400);
 const large='x'.repeat(4097);assert.equal((await f.call(prefix+sha(large),'alice',{method:'PUT',headers:{'content-type':'application/json'},body:large})).status,413);
 const largeAttachment=Buffer.alloc(33);assert.equal((await f.call('/api/muse/session-archives/attachments/'+sha(largeAttachment),'alice',{method:'PUT',headers:{'content-type':'application/octet-stream'},body:largeAttachment})).status,413);
 assert.deepEqual(await(await f.call('/api/muse/session-archives')).json(),{items:[],nextCursor:null});
});

test('buffered upload admission is independent per account, globally bounded and released exactly once',()=>{
 const admission=createAccountDataAdmission({maxUploadsPerAccount:1,maxUploadsTotal:2}),alice=admission.acquire('alice');
 assert.throws(()=>admission.acquire('alice'),{code:'archive_busy'});const bob=admission.acquire('bob');assert.throws(()=>admission.acquire('carol'),{code:'archive_busy'});
 alice();alice();const carol=admission.acquire('carol');bob();carol();assert.doesNotThrow(()=>admission.acquire('alice')());
});

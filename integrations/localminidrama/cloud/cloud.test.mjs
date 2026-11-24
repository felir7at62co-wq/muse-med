/** Real SQLite workers with existing Muse identities and keyless local model fixtures. */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer,request} from 'node:http';
import {createRequire} from 'node:module';
import {existsSync} from 'node:fs';
import {mkdtemp,mkdir,writeFile,readFile,rm,readdir,cp,symlink,rename} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve,join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createStudioRuntime,studioChildEnvironment} from './runtime.mjs';
import {loadStudioConfig,resolveStudioConfig} from './config.mjs';
import {studioRoute} from './proxy.mjs';
import {validateLocalMedia,workerPath,localGenerationReferences} from './security.mjs';
import {openStore} from '../../../services/muse-accounts/store.mjs';
import {createMemorySessionStore} from '../../../services/muse-accounts/session-store.mjs';

const source=resolve(process.env.LOCALMINIDRAMA_SOURCE||'.local/localminidrama'),backendRoot=join(source,'backend-node'),installed=existsSync(join(backendRoot,'node_modules/better-sqlite3'));
let chromium;
if(existsSync(resolve('apps/web/package.json'))){try{const browser=createRequire(resolve('apps/web/package.json'))('playwright').chromium;if(existsSync(browser.executablePath()))chromium=browser;}catch(error){if(error.code!=='MODULE_NOT_FOUND')throw error;}}
const origin='https://muse.fixture.test';
const defaults={maxActiveInstances:3,maxConcurrentStarts:2,maxRequestsPerAccount:3,maxRequestsTotal:6,maxOutboundRequests:4,maxRequestBytes:65536,maxTenantBytes:16*1024*1024,startupTimeoutMs:10000,requestTimeoutMs:10000,idleTimeoutMs:1000,idleSweepMs:25,shutdownGraceMs:10000};
const listen=server=>new Promise(resolve=>server.listen(0,'127.0.0.1',()=>resolve('http://127.0.0.1:'+server.address().port)));
async function close(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
const until=async(read,accept)=>{const deadline=performance.now()+10000;while(performance.now()<deadline){const value=await read();if(accept(value))return value;await new Promise(resolve=>setTimeout(resolve,20));}throw new Error('Fixture state did not settle');};
async function fixture(t,{limits={},clock=Date.now,outboundOrigins=[],trustedLocalOrigins=outboundOrigins,backend=backendRoot}={}){
 const home=await mkdtemp(join(tmpdir(),'muse-cloud-studio-')),dist=join(home,'web');await mkdir(dist);await writeFile(join(dist,'index.html'),'<!doctype html><title>Muse studio fixture</title>');
 const config={version:1,nodeExecutable:process.execPath,backendRoot:backend,webDistRoot:dist,tenantRoot:join(home,'tenants'),outboundOrigins,trustedLocalOrigins,limits:{...defaults,...limits}},configFile=join(home,'studio.json');await writeFile(configFile,JSON.stringify(config),{mode:0o600});const runtime=await createStudioRuntime(await loadStudioConfig(configFile),{publicOrigin:origin,now:clock});
 const store=await openStore(join(home,'accounts.json')),sessions=createMemorySessionStore(),accounts={},tokens={};for(const name of ['alice','bob','carol']){accounts[name]=await store.create(name,'fixture-password');tokens[name]=await sessions.issue({id:accounts[name].id,revision:accounts[name].revision,expiry:Date.now()+60000});}
 const current=req=>{const token=req.headers.cookie?.match(/(?:^|;\s*)__Host-muse=([^;]+)/)?.[1],login=sessions.get(token),account=login&&store.get(login.id);return account&&!account.disabled&&account.revision===login.revision?{...login,token,account}:null;};
 const server=createServer(async(req,res)=>{const session=current(req);if(!session){res.writeHead(401);res.end();return;}if(!await studioRoute(req,res,{runtime,session,isAuthorized:()=>current(req)?.token===session.token,publicOrigin:origin})){res.writeHead(404);res.end();}}),base=await listen(server);
 const call=(path,who='alice',options={})=>fetch(base+path,{redirect:'manual',...options,headers:{cookie:'__Host-muse='+tokens[who],...options.method&&options.method!=='GET'?{origin}:{},...options.headers}});
 const api=async(path,method='GET',body,who='alice',operationId)=>{const response=await call('/studio/api/v1'+path,who,{method,headers:{...body===undefined?{}:{'content-type':'application/json'},...operationId===undefined?{}:{'x-muse-operation-id':operationId}},...body===undefined?{}:{body:JSON.stringify(body)}});const data=await response.json();assert.ok(response.status<400,JSON.stringify(data));return data.data;};
 t.after(async()=>{await close(server);await runtime.close();await rm(home,{recursive:true,force:true});});
 const authorize=async(projectId,providerOrigin,services=['image'])=>{
  const current=await api('/muse/budget/projects/'+projectId);
  await api('/muse/budget/projects/'+projectId,'PUT',{database_id:current.database_id,operation_id:randomUUID(),expected_revision:current.revision,currency:'CNY',limit_minor:10000,allow_estimates:true,allow_task_envelopes:false});
  for(const service of services){const id='cloud-fixture-'+service;await api('/muse/budget/catalog/'+id,'PUT',{database_id:current.database_id,id,operation_id:randomUUID(),expected_revision:0,operator_accepted:true,service,provider:'openai',model:'fixture-'+service,origin:providerOrigin,currency:'CNY',reserve_minor:100,source:'operator-entered',effective_at:'2026-01-01T00:00:00.000Z',expires_at:'2099-01-01T00:00:00.000Z',estimate_kind:'per-dispatch-estimate'});}
 };
 return {home,dist,config,runtime,store,sessions,accounts,tokens,server,base,call,api,authorize};
}

test('configuration is optional, private, complete and cannot mix shared source with tenant files',async t=>{
 const home=await mkdtemp(join(tmpdir(),'muse-studio-config-'));t.after(()=>rm(home,{recursive:true,force:true}));assert.equal(await loadStudioConfig(undefined),undefined);
 const value={version:1,nodeExecutable:process.execPath,backendRoot:join(home,'backend'),webDistRoot:join(home,'web'),tenantRoot:join(home,'tenants'),outboundOrigins:[],trustedLocalOrigins:[],limits:defaults};
 assert.deepEqual(resolveStudioConfig(value),value);assert.throws(()=>resolveStudioConfig({...value,tenantRoot:join(value.backendRoot,'..notes')}));
 assert.throws(()=>resolveStudioConfig({...value,limits:{...defaults,maxRequestBytes:undefined}}));assert.throws(()=>resolveStudioConfig({...value,limits:{...defaults,maxRequestsPerAccount:100}}));
 await assert.rejects(loadStudioConfig('relative.json'));
 if(process.platform!=='win32'){const file=join(home,'config.json');await writeFile(file,JSON.stringify(value),{mode:0o644});await assert.rejects(loadStudioConfig(file),/private/);}
 const env=studioChildEnvironment({PATH:'fixture-path',SystemRoot:'fixture-system',MUSE_COOKIE:'private',API_KEY:'private',NODE_OPTIONS:'private',HTTP_PROXY:'private'});assert.deepEqual(env,{NODE_ENV:'production',TZ:'UTC',PATH:'fixture-path',SystemRoot:'fixture-system'});
});

test('cloud routes reject helper, tenant selection and local file escapes while preserving user prose',()=>{
 for(const path of ['/api/v1/agent/chat','/API/V1/AGENT/history','/api/v1/cloud/export','/api/v1/dramas?accountId=bob','/static/%2e%2e/tenant.json','//other/'])assert.throws(()=>workerPath(path));
 assert.equal(workerPath('/api/v1/dramas?keyword=hello'),'/api/v1/dramas?keyword=hello');
 for(const name of ['budget','libtv','libtv-cli','migration','edit','audio','postproduction','packages','revisions','admission','production-plans','studio'])assert.equal(workerPath('/api/v1/muse/'+name+'/fixture'),'/api/v1/muse/'+name+'/fixture');
 assert.throws(()=>workerPath('/api/v1/muse/production-plans-other/fixture'));
 assert.throws(()=>workerPath('/api/v1/muse/studio-other/fixture'));
 for(const path of ['../bob/private.png','/etc/passwd','C:\\private.png','file:///private.png','%2e%2e/bob.png'])assert.throws(()=>validateLocalMedia({local_path:path}));
 assert.doesNotThrow(()=>validateLocalMedia({prompt:'../a is dialogue, not a media path',reference_images:['/studio/static/one.png','https://supplier.fixture/two.png']}));
 const body={image_url:origin+'/studio/static/one.png',reference_image_urls:['https://supplier.fixture/two.png',origin+'/studio/static/two.png']};localGenerationReferences(body,'/api/v1/videos',origin);assert.deepEqual(body,{image_url:'/static/one.png',reference_image_urls:['https://supplier.fixture/two.png','/static/two.png']});
 const adopted={image_url:origin+'/studio/static/one.png'};localGenerationReferences(adopted,'/api/v1/storyboards/1',origin);assert.equal(adopted.image_url,origin+'/studio/static/one.png');
});

test('two real SQLite workers isolate colliding IDs, uploads, static files, model configs and history',{skip:!installed,timeout:45000},async t=>{
 const require=createRequire(join(backendRoot,'package.json')),png=await require('sharp')({create:{width:16,height:16,channels:3,background:'#456789'}}).png().toBuffer();
 let calls=0,redirectCalls=0;const denied=createServer((req,res)=>{redirectCalls++;res.end('must never be contacted');}),deniedUrl=await listen(denied);t.after(()=>close(denied));
 const provider=createServer(async(req,res)=>{for await(const chunk of req){void chunk;}calls++;if(req.url.includes('/redirect/')){res.writeHead(302,{location:deniedUrl+'/metadata'});res.end();return;}res.setHeader('content-type','application/json');res.end(JSON.stringify(req.url.includes('chat/completions')?{choices:[{message:{content:'fixture text'}}]}:{data:[{b64_json:png.toString('base64')}]}));});const url=await listen(provider);t.after(()=>close(provider));
 const f=await fixture(t,{outboundOrigins:[url]});
 const a=await f.api('/dramas','POST',{title:'Alice private project',accountId:f.accounts.bob.id}),b=await f.api('/dramas','POST',{title:'Bob private project'},'bob');assert.equal(a.id,b.id);
 const aList=await f.api('/dramas'),bList=await f.api('/dramas','GET',undefined,'bob');assert.match(JSON.stringify(aList),/Alice private/);assert.doesNotMatch(JSON.stringify(aList),/Bob private/);assert.match(JSON.stringify(bList),/Bob private/);
 const forged=await f.call('/studio/api/v1/dramas','alice',{headers:{'x-account-id':f.accounts.bob.id,'x-original-url':'/api/v1/agent/history','x-muse-studio-worker':'forged'}});assert.match(JSON.stringify(await forged.json()),/Alice private/);
 assert.equal((await f.call('/studio/api/v1/dramas?accountId='+f.accounts.bob.id)).status,400);
 const form=new FormData();form.set('drama_id',String(a.id));form.set('file',new Blob([png],{type:'image/png'}),'reference.png');
 const uploaded=await(await f.call('/studio/api/v1/upload/image','alice',{method:'POST',body:form})).json(),path=uploaded.data.local_path;assert.ok(path);assert.match(uploaded.data.url,/^\/studio\/static\//);
 assert.deepEqual(Buffer.from(await(await f.call('/studio/static/'+path)).arrayBuffer()),png);assert.equal((await f.call('/studio/static/'+path,'bob')).status,404);
 assert.equal((await f.call('/studio/api/v1/assets','alice',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({drama_id:a.id,name:'escape',type:'image',local_path:'../'+f.accounts.bob.id+'/drama.db'})})).status,400);
 const lease=await f.runtime.acquire(f.accounts.bob.id);try{assert.equal((await fetch(new URL('/api/v1/dramas',lease.target),{headers:{cookie:'__Host-muse='+f.tokens.bob,authorization:'Bearer '+f.tokens.bob}})).status,403);}finally{lease.release();}
 for(const endpoint of ['/studio/api/v1/agent/history','/studio/API/V1/AGENT/chat','/studio/mastra/status'])assert.equal((await f.call(endpoint)).status,404);
 assert.equal((await f.call('/studio/api/v1/dramas','alice',{method:'POST',headers:{origin:'https://other.fixture','content-type':'application/json'},body:'{}'})).status,403);
 for(const base_url of ['http://169.254.169.254/latest/meta-data','https://127.0.0.1:1234','https://unapproved.fixture'])assert.equal((await f.call('/studio/api/v1/ai-configs','alice',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({service_type:'image',provider:'openai',base_url,api_key:'fixture-only',model:['bad']})})).status,400);
 await f.api('/ai-configs','POST',{service_type:'image',name:'Alice model',provider:'openai',base_url:url+'/v1',api_key:'fixture-only',model:['fixture-image'],is_default:true});
 assert.deepEqual(await f.api('/ai-configs','GET',undefined,'bob'),[]);
 const imageBody={drama_id:a.id,model:'fixture-image',provider:'openai',prompt:'Alice generated image'};
 await f.authorize(a.id,url,['image','text']);
 const unconfirmed=await f.call('/studio/api/v1/images','alice',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(imageBody)});assert.equal(unconfirmed.status,428);assert.equal((await unconfirmed.json()).error.code,'operation_id_required');assert.equal(calls,0);
 const image=await f.api('/images','POST',imageBody,'alice','isolation-image-fixture');
 const done=await until(()=>f.api('/images/'+image.id),row=>row.status==='completed'||row.status==='failed');assert.equal(done.status,'completed');assert.equal(calls,1);assert.equal((await f.api('/images','GET',undefined,'bob')).items.length,0);
 const textTest={drama_id:a.id,service_type:'text',provider:'openai',base_url:url+'/v1',api_key:'fixture-only',model:['fixture-text']};assert.equal((await f.call('/studio/api/v1/ai-configs/test','alice',{method:'POST',headers:{'content-type':'application/json','x-muse-operation-id':'cloud-text-test-fixture'},body:JSON.stringify(textTest)})).status,200);
 const redirected=await f.call('/studio/api/v1/ai-configs/test','alice',{method:'POST',headers:{'content-type':'application/json','x-muse-operation-id':'cloud-text-redirect-fixture'},body:JSON.stringify({...textTest,base_url:url+'/redirect/v1'})});assert.ok(redirected.status>=400);assert.equal(redirectCalls,0);
 assert.ok((await readdir(join(f.home,'tenants',f.accounts.alice.id))).includes('drama.db'));assert.ok((await readdir(join(f.home,'tenants',f.accounts.bob.id))).includes('drama.db'));
});

test('an embedded browser renders account-proxied media and sends its local reference inline',{skip:!installed||!chromium,timeout:45000},async t=>{
 const require=createRequire(join(backendRoot,'package.json')),png=await require('sharp')({create:{width:16,height:16,channels:3,background:'#345678'}}).png().toBuffer(),bodies=[];
 const provider=createServer(async(req,res)=>{const chunks=[];for await(const chunk of req)chunks.push(chunk);bodies.push(JSON.parse(Buffer.concat(chunks)));res.setHeader('content-type','application/json');res.end(JSON.stringify({data:[{b64_json:png.toString('base64')}]}));}),providerUrl=await listen(provider);t.after(()=>close(provider));
 const f=await fixture(t,{outboundOrigins:[providerUrl]});
 await writeFile(join(f.dist,'index.html'),`<!doctype html><title>Embedded media fixture</title><input type="file"><img alt="Uploaded reference"><script>
 document.querySelector('input').onchange=async event=>{const body=new FormData();body.set('file',event.target.files[0]);const response=await fetch('/studio/api/v1/upload/image',{method:'POST',body});window.upload=await response.json();document.querySelector('img').src=window.upload.data.url;};
 </script>`);
 const project=await f.api('/dramas','POST',{title:'Embedded reference'});
 await f.api('/ai-configs','POST',{service_type:'image',name:'Inline image',provider:'openai',base_url:providerUrl+'/v1',api_key:'fixture-only',model:['fixture-image'],is_default:true});
 await f.authorize(project.id,providerUrl);
 const paths=[],privateProxy=createServer((req,res)=>{paths.push(req.url);const outgoing=request(new URL(req.url,f.base),{method:req.method,headers:{...req.headers,cookie:'__Host-muse='+f.tokens.alice,origin}},incoming=>{res.writeHead(incoming.statusCode,incoming.headers);incoming.pipe(res);});outgoing.on('error',()=>{res.destroy();});req.pipe(outgoing);}),privateUrl=await listen(privateProxy);t.after(()=>close(privateProxy));
 const shell=createServer((req,res)=>{res.setHeader('content-type','text/html');res.end('<!doctype html><iframe src="'+privateUrl+'/studio/"></iframe>');}),shellUrl=await listen(shell);t.after(()=>close(shell));
 const browser=await chromium.launch({headless:true});t.after(()=>browser.close());const page=await browser.newPage(),failures=[];page.on('requestfailed',req=>failures.push(req.url()));
 await page.goto(shellUrl);const input=page.frameLocator('iframe').locator('input');await input.setInputFiles({name:'reference.png',mimeType:'image/png',buffer:png});
 const frame=page.frames().find(frame=>frame.url()===privateUrl+'/studio/');assert.ok(frame);
 await frame.waitForFunction(()=>document.querySelector('img').naturalWidth===16);
 const media=await frame.locator('img').getAttribute('src');assert.match(media,/^\/studio\/static\//);assert.ok(paths.includes(media));assert.equal((await fetch(f.base+media)).status,401);
 const result=await frame.evaluate(async dramaId=>{const response=await fetch('/studio/api/v1/images',{method:'POST',headers:{'content-type':'application/json','x-muse-operation-id':'embedded-image-fixture'},body:JSON.stringify({drama_id:dramaId,provider:'openai',model:'fixture-image',prompt:'inline reference fixture',reference_images:[window.upload.data.url]})});return response.json();},project.id);
 assert.equal(result.success,true);const done=await until(()=>f.api('/images/'+result.data.id),row=>row.status==='completed'||row.status==='failed');assert.equal(done.status,'completed');assert.equal(bodies.length,1);assert.deepEqual(bodies[0].image,['data:image/png;base64,'+png.toString('base64')]);assert.deepEqual(failures,[]);
});

test('busy background generation survives idle inspection and rejects a bounded shutdown without killing its worker',{skip:!installed,timeout:45000},async t=>{
 const require=createRequire(join(backendRoot,'package.json')),png=await require('sharp')({create:{width:16,height:16,channels:3,background:'#567890'}}).png().toBuffer();
 let entered,release;const started=new Promise(resolve=>{entered=resolve;}),held=new Promise(resolve=>{release=resolve;});
 let calls=0;const provider=createServer(async(req,res)=>{for await(const chunk of req){void chunk;}calls++;if(calls===1){entered();await held;}res.setHeader('content-type','application/json');res.end(JSON.stringify(req.url.includes('chat/completions')?{choices:[{message:{content:'fixture text'}}]}:{data:[{b64_json:png.toString('base64')}]}));}),url=await listen(provider);t.after(()=>close(provider));t.after(()=>release());
 let clock=0;const f=await fixture(t,{outboundOrigins:[url],clock:()=>clock,limits:{maxOutboundRequests:1,shutdownGraceMs:100,idleSweepMs:10}});
 const project=await f.api('/dramas','POST',{title:'Held generation'});await f.api('/ai-configs','POST',{service_type:'image',name:'Held image',provider:'openai',base_url:url+'/v1',api_key:'fixture-only',model:['fixture-image'],is_default:true});
 await f.authorize(project.id,url,['image','text']);
 const previous=await f.runtime.acquire(f.accounts.alice.id);previous.release();const image=await f.api('/images','POST',{drama_id:project.id,provider:'openai',model:'fixture-image',prompt:'held fixture'},'alice','held-image-fixture');await started;
 const excess=await f.api('/images','POST',{drama_id:project.id,provider:'openai',model:'fixture-image',prompt:'must not dispatch'},'alice','excess-image-fixture'),refused=await until(()=>f.api('/images/'+excess.id),row=>row.status==='completed'||row.status==='failed');assert.equal(refused.status,'failed');assert.equal(calls,1);
 const text=await f.call('/studio/api/v1/ai-configs/test','alice',{method:'POST',headers:{'content-type':'application/json','x-muse-operation-id':'busy-text-outbound-fixture'},body:JSON.stringify({drama_id:project.id,service_type:'text',provider:'openai',base_url:url+'/v1',api_key:'fixture-only',model:['fixture-text']})});assert.ok(text.status>=400);assert.equal(calls,1);const monetary=await f.api('/muse/budget/projects/'+project.id+'/entries');assert.equal(monetary.items.filter(row=>row.profile.service==='text').length,1);
 clock=2000;await f.runtime.sweep();const current=await f.runtime.acquire(f.accounts.alice.id);assert.equal(current.token,previous.token);current.release();
 await assert.rejects(f.runtime.close(),{code:'studio_busy'});
 release();const Database=require('better-sqlite3'),reader=new Database(join(f.home,'tenants',f.accounts.alice.id,'drama.db'),{readonly:true}),statement=reader.prepare('SELECT status FROM image_generations WHERE id=?');
 try{const status=await until(()=>statement.get(image.id),row=>row.status==='completed'||row.status==='failed');assert.equal(status.status,'completed');}finally{reader.close();}await f.runtime.close();
});

test('a live worker ownership lock prevents a second manager from opening the same account database',{skip:!installed,timeout:45000},async t=>{
 const f=await fixture(t),lease=await f.runtime.acquire(f.accounts.alice.id),other=await createStudioRuntime(f.config,{publicOrigin:origin,onError:()=>{}});
 try{await assert.rejects(other.acquire(f.accounts.alice.id),{code:'studio_worker_busy'});assert.equal((await fetch(new URL('/health',lease.target),{headers:{'x-muse-studio-worker':lease.token}})).status,200);}
 finally{lease.release();await other.close();}
});

test('a disconnected native operation remains busy until its original handler settles',{skip:!installed,timeout:45000},async t=>{
 const home=await mkdtemp(join(tmpdir(),'muse-native-busy-')),backend=join(home,'backend');await mkdir(backend);t.after(()=>rm(home,{recursive:true,force:true}));
 let enter,finish;const started=new Promise(resolve=>{enter=resolve;}),held=new Promise(resolve=>{finish=resolve;});
 const provider=createServer(async(req,res)=>{enter();await held;res.end('original completed result');}),url=await listen(provider);t.after(()=>close(provider));t.after(()=>finish());
 await cp(join(backendRoot,'src'),join(backend,'src'),{recursive:true});await cp(join(backendRoot,'migrations'),join(backend,'migrations'),{recursive:true});await cp(join(backendRoot,'package.json'),join(backend,'package.json'));
 await symlink(join(backendRoot,'node_modules'),join(backend,'node_modules'),process.platform==='win32'?'junction':'dir');
 await cp(new URL('../extensions/muse-admission.cjs',import.meta.url),join(backend,'src/services/museAdmission.js'));
 await writeFile(join(backend,'src/services/museAdmissionCatalog.json'),JSON.stringify([{pattern:'^/generation/story$',kind:'text',label:'Fixture text'}]));
 await rename(join(backend,'src/app.js'),join(backend,'src/app.native.js'));
 await writeFile(join(backend,'src/app.js'),`const native=require('./app.native'),express=require('express');module.exports.createApp=()=>{const result=native.createApp(),app=express(),r=express.Router(),cfg=require('./config').loadConfig();app.use(express.json());require('./services/museAdmission').register(r,result.db,cfg);r.post('/generation/story',async(req,res)=>{const reply=await fetch(${JSON.stringify(url)});res.json({success:true,data:{story:await reply.text()}})});app.use('/api/v1',r);app.use(result.app);return {...result,app};};`);
 let clock=0;const f=await fixture(t,{backend,outboundOrigins:[url],clock:()=>clock,limits:{idleSweepMs:10,shutdownGraceMs:100}}),lease=await f.runtime.acquire(f.accounts.alice.id);lease.release();
 const project=await f.api('/dramas','POST',{title:'Disconnected native fixture'});await f.authorize(project.id,url,[]);
 const client=request(new URL('/studio/api/v1/generation/story',f.base),{method:'POST',headers:{cookie:'__Host-muse='+f.tokens.alice,origin,'content-type':'application/json','x-muse-operation-id':'native-held-fixture'}},res=>res.resume());client.on('error',()=>{});client.end(JSON.stringify({drama_id:project.id}));await started;client.destroy();
 const Database=createRequire(join(backendRoot,'package.json'))('better-sqlite3'),reader=new Database(join(f.home,'tenants',f.accounts.alice.id,'drama.db'),{readonly:true});
 try{await until(()=>reader.prepare('SELECT state FROM muse_native_operations WHERE operation_id=?').get('native-held-fixture'),row=>row.state==='unknown');clock=2000;await f.runtime.sweep();const current=await f.runtime.acquire(f.accounts.alice.id);assert.equal(current.token,lease.token);current.release();await assert.rejects(f.runtime.close(),{code:'studio_busy'});finish();await until(()=>reader.prepare('SELECT state FROM muse_native_operations WHERE operation_id=?').get('native-held-fixture'),row=>row.state==='completed');await f.runtime.close();}finally{finish();reader.close();}
});

test('instance/request quota, idle restart persistence and per-account disk admission stay explicit',{skip:!installed,timeout:45000},async t=>{
 let clock=0;const f=await fixture(t,{clock:()=>clock,limits:{maxActiveInstances:2,maxConcurrentStarts:1,maxRequestsPerAccount:2,maxRequestsTotal:3}});
 const first=await f.runtime.acquire(f.accounts.alice.id),second=await f.runtime.acquire(f.accounts.alice.id);assert.equal(first.token,second.token);await assert.rejects(f.runtime.acquire(f.accounts.alice.id),{code:'studio_request_capacity'});first.release();second.release();
 await f.api('/dramas','POST',{title:'survives idle restart'});const old=await f.runtime.acquire(f.accounts.alice.id);old.release();
 const bob=await f.runtime.acquire(f.accounts.bob.id);bob.release();await assert.rejects(f.runtime.acquire(f.accounts.carol.id),{code:'studio_capacity'});
 clock=2000;await f.runtime.sweep();const configFile=join(f.home,'tenants',f.accounts.alice.id,'configs/config.yaml'),saved=JSON.parse(await readFile(configFile,'utf8'));saved.storage.base_url=origin+'/studio/static';await writeFile(configFile,JSON.stringify(saved));
 const fresh=await f.runtime.acquire(f.accounts.alice.id);assert.notEqual(fresh.token,old.token);fresh.release();assert.match(JSON.stringify(await f.api('/dramas')),/survives idle restart/);assert.equal(JSON.parse(await readFile(configFile,'utf8')).storage.base_url,'/studio/static');
 await writeFile(join(f.home,'tenants',f.accounts.alice.id,'quota-fixture'),Buffer.alloc(f.config.limits.maxTenantBytes));
 const denied=await f.call('/studio/api/v1/dramas','alice',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({title:'must not commit'})});assert.equal(denied.status,413);assert.equal((await denied.json()).error.code,'studio_quota_exceeded');
 assert.doesNotMatch(JSON.stringify(await f.api('/dramas')),/must not commit/);assert.ok(await f.api('/dramas','POST',{title:'Bob quota independent'},'bob'));
});

import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,writeFile,chmod,symlink,rm} from 'node:fs/promises';
import http from 'node:http';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {createFeishuLogin,loadFeishuLoginConfig} from './feishu-login.mjs';
import {createMemorySessionStore} from './session-store.mjs';
import {openStore} from './store.mjs';

const origin='https://muse.test';
const config={appId:'cli_fixture',appSecret:'fixture-server-secret-only',appType:'custom',redirectUri:origin+'/auth/feishu/callback'};
const profile={open_id:'ou_writer',union_id:'on_writer',name:'编剧',tenant_key:'tenant_other_company',avatar_url:'https://example.test/avatar.png'};
const response=value=>new Response(JSON.stringify(value),{headers:{'content-type':'application/json'}});
const sha=value=>createHash('sha256').update(value).digest('base64url');

async function fixture(t,options={}){
 const publicOrigin=options.publicOrigin??origin;
 let time=Date.now(),currentProfile=profile;const now=()=>time,sessionStore=createMemorySessionStore({now}),calls=[],resolved=[],recorded=[],diagnostics=[],records=new Map(),identityAccounts=new Map();
 const admin=options.admin??{id:'1234567890abcdef',username:'ylk',admin:true,disabled:false,revision:1,lastLoginAt:null};records.set(admin.id,admin);
 const store=options.store??{get:id=>records.get(id),async resolveFeishuIdentity(value,bind={}){
  resolved.push({value,bind});
  await options.beforeResolve?.();
  if(bind.validateBinding&&!bind.validateBinding())throw Object.assign(Error('binding expired'),{code:'ACCOUNT_REVISION_CHANGED'});
  const key=JSON.stringify([value.appId,value.tenantKey??null,value.openId]),existing=identityAccounts.get(key);
  if(bind.bindAccountId&&existing&&existing!==bind.bindAccountId)throw Object.assign(Error('Do not expose this raw error'),{code:'FEISHU_IDENTITY_CONFLICT'});
  const id=existing??bind.bindAccountId??'abcdef1234567890';let account=records.get(id);
  if(account?.disabled)throw Object.assign(Error('disabled'),{code:'ACCOUNT_DISABLED'});
  if(bind.bindRevision!==undefined&&account.revision!==bind.bindRevision)throw Object.assign(Error('revision'),{code:'ACCOUNT_REVISION_CHANGED'});
  if(!account){account={id,username:'feishu_fixture',admin:false,disabled:false,revision:1,lastLoginAt:null};records.set(id,account);}
  identityAccounts.set(key,id);return account;
 },async recordLogin(id,login){
  await options.beforeRecordLogin?.();
  const account=records.get(id);
  if(!account||account.disabled||account.revision!==login.expectedRevision||!login.validateLogin())throw Object.assign(Error('login expired'),{code:'ACCOUNT_REVISION_CHANGED'});
  recorded.push({id,...login});records.set(id,{...account,lastLoginAt:login.at});return records.get(id);
 }};
 const adminToken=await sessionStore.issue({id:admin.id,revision:1,expiry:time+600000});
 const session=req=>{const token=(req.headers.cookie??'').split(';').map(x=>x.trim()).find(x=>x.startsWith('__Host-muse='))?.slice(12),value=sessionStore.get(token),account=value&&store.get(value.id);return value&&account&&!account.disabled&&account.revision===value.revision?{token,...value,account}:null;};
 const reply=(res,status,body='',headers={})=>{res.writeHead(status,{'cache-control':'no-store','referrer-policy':'no-referrer',...headers});res.end(body);};
 const fetchImpl=async(url,request)=>{calls.push({url,request});if(options.fetchImpl)return options.fetchImpl(url,request,calls);return url.endsWith('/token')?response({code:0,access_token:'fixture-access-token',token_type:'Bearer',expires_in:7200}):response({code:0,data:currentProfile});};
 const feature=createFeishuLogin({config:{...config,...options.config},publicOrigin,environment:options.environment,store,session,sessionStore,sessionTtlMs:600000,cookieName:'__Host-muse',originOK:(req,required=false)=>req.headers.origin?req.headers.origin===publicOrigin:!required&&req.headers['sec-fetch-site']!=='cross-site',rate:options.rate??(()=>true),form:async req=>{let text='';for await(const chunk of req)text+=chunk;return new URLSearchParams(text);},reply,page:(_title,body)=>body,returnPath:id=>id==='valid-attempt'?'/desktop-login?attempt=valid-attempt':'/',desktopConsent:options.desktopConsent,now,fetchImpl,allowAccount:options.allowAccount,onFailure:options.onFailure??(diagnostic=>diagnostics.push(diagnostic))});
 const server=http.createServer(async(req,res)=>{try{if(!await feature.handle(req,res,new URL(req.url,publicOrigin).pathname))reply(res,404);}catch(error){reply(res,500,error.message);}});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(async()=>{await feature.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
 const request=(path,{cookie,method='GET',body,requestOrigin=publicOrigin,headers={},signal}={})=>fetch('http://127.0.0.1:'+server.address().port+path,{method,redirect:'manual',headers:{origin:requestOrigin,...cookie?{cookie}:{},...headers},body:body&&new URLSearchParams(body),signal});
 async function start({bind=false,desktopLogin}={}){
  const result=await request(bind?'/auth/feishu/bind':'/auth/feishu/start'+(desktopLogin?'?desktop_login='+encodeURIComponent(desktopLogin):''),bind?{method:'POST',cookie:'__Host-muse='+adminToken,body:{}}:{});
  assert.equal(result.status,303);const authorize=new URL(result.headers.get('location'));
  return {state:authorize.searchParams.get('state'),authorize,cookie:result.headers.get('set-cookie').split(';')[0],headers:result.headers};
 }
 const callback=(a,code='fixture-code',extra={})=>request('/auth/feishu/callback?state='+a.state+'&code='+code,{cookie:a.cookie,...extra});
 return {request,start,callback,calls,resolved,recorded,diagnostics,store,records,admin,adminToken,sessionStore,feature,setProfile:value=>currentProfile=value,setTime:value=>time=value,now};
}

test('private configuration validates the callback, Feishu app type and bounded policy',async t=>{
 assert.equal(await loadFeishuLoginConfig(undefined),undefined);
 const directory=await mkdtemp(join(tmpdir(),'muse-feishu-config-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 const file=join(directory,'feishu.json');await writeFile(file,JSON.stringify(config),{mode:0o600});
 const loaded=await loadFeishuLoginConfig(file,{publicOrigin:origin});assert.equal(loaded.appType,'custom');assert.equal(loaded.requestTimeoutMs,15000);assert.equal(loaded.tokenEndpointVersion,'v3');
 await writeFile(file,JSON.stringify({...config,appType:'store'}));assert.equal((await loadFeishuLoginConfig(file,{publicOrigin:origin})).appType,'store');
 await assert.rejects(loadFeishuLoginConfig('relative.json',{publicOrigin:origin}),/absolute/);
 for(const change of [{redirectUri:'https://evil.test/auth/feishu/callback'},{redirectUri:origin+'/auth/feishu/callback?x=1'},{appType:'unknown'},{requestTimeoutMs:0},{unknown:'ignored?'},{appSecret:'short'}]){
  await writeFile(file,JSON.stringify({...config,...change}));await assert.rejects(loadFeishuLoginConfig(file,{publicOrigin:origin}),/Feishu/);
 }
 for(const tokenEndpointVersion of ['v3','v2']){await writeFile(file,JSON.stringify({...config,tokenEndpointVersion}));assert.equal((await loadFeishuLoginConfig(file,{publicOrigin:origin})).tokenEndpointVersion,tokenEndpointVersion);}
 for(const tokenEndpointVersion of ['v1','https://example.test/token',null,2,{},['v3']]){await writeFile(file,JSON.stringify({...config,tokenEndpointVersion}));await assert.rejects(loadFeishuLoginConfig(file,{publicOrigin:origin}),/token endpoint version/);}
 assert.throws(()=>createFeishuLogin({config:{...config,tokenEndpointVersion:'v4'},publicOrigin:origin}),/token endpoint version/);
 await writeFile(file,'{"appSecret":"secret-fragment');await assert.rejects(loadFeishuLoginConfig(file,{publicOrigin:origin}),error=>!error.message.includes('secret-fragment'));
 if(process.platform!=='win32'){
  await writeFile(file,JSON.stringify(config));await chmod(file,0o644);await assert.rejects(loadFeishuLoginConfig(file,{publicOrigin:origin}),/owner-only/);await chmod(file,0o600);
  const link=join(directory,'link.json');await symlink(file,link);await assert.rejects(loadFeishuLoginConfig(link,{publicOrigin:origin}));
 }
});

test('disabled integration claims no routes',async()=>{
 const feature=createFeishuLogin({});assert.equal(feature.enabled,false);assert.equal(await feature.handle({},{}),false);await feature.close();
});

test('HTTP callbacks are limited to explicit development loopback and retain secure cookies',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'muse-feishu-loopback-'));t.after(()=>rm(directory,{recursive:true,force:true}));const file=join(directory,'feishu.json');
 for(const publicOrigin of ['http://localhost:19488','http://127.0.0.1:19488']){
  const local={...config,redirectUri:publicOrigin+'/auth/feishu/callback'};await writeFile(file,JSON.stringify(local),{mode:0o600});
  assert.equal((await loadFeishuLoginConfig(file,{publicOrigin,environment:'development'})).redirectUri,local.redirectUri);
  await assert.rejects(loadFeishuLoginConfig(file,{publicOrigin}),/callback/);await assert.rejects(loadFeishuLoginConfig(file,{publicOrigin,environment:'production'}),/callback/);
 }
 for(const publicOrigin of ['http://muse.test','http://localhost.example.test:19488','http://127.0.0.2:19488','http://localhost.:19488','http://[::1]:19488','http://user@localhost:19488']){
  await writeFile(file,JSON.stringify({...config,redirectUri:new URL(publicOrigin).origin+'/auth/feishu/callback'}));await assert.rejects(loadFeishuLoginConfig(file,{publicOrigin,environment:'development'}),/callback/);
 }
 await writeFile(file,JSON.stringify({...config,redirectUri:'http://localhost:19488/auth/feishu/callback?next=1'}));await assert.rejects(loadFeishuLoginConfig(file,{publicOrigin:'http://localhost:19488',environment:'development'}),/callback/);
 assert.throws(()=>createFeishuLogin({config,publicOrigin:origin,environment:'test'}),/environment/);
 const f=await fixture(t,{publicOrigin:'http://localhost:19488',environment:'development',config:{redirectUri:'http://localhost:19488/auth/feishu/callback'}}),result=await f.request('/auth/feishu/start');assert.equal(result.status,303);assert.match(result.headers.get('set-cookie'),/; Secure; HttpOnly; SameSite=Lax;/);assert.equal(new URL(result.headers.get('location')).searchParams.get('redirect_uri'),'http://localhost:19488/auth/feishu/callback');
});

test('custom app sign-in uses v3 and PKCE and preserves the Desktop continuation',async t=>{
 const f=await fixture(t),a=await f.start({desktopLogin:'valid-attempt'});
 assert.equal(f.feature.appType,'custom');
 assert.equal(a.authorize.origin,'https://accounts.feishu.cn');assert.equal(a.authorize.pathname,'/open-apis/authen/v1/authorize');
 assert.equal(a.authorize.searchParams.get('client_id'),config.appId);assert.equal(a.authorize.searchParams.get('code_challenge_method'),'S256');
 assert.equal(a.authorize.searchParams.get('redirect_uri'),config.redirectUri);assert.equal(a.authorize.searchParams.has('scope'),false);
 assert.ok(!a.authorize.href.includes(config.appSecret));assert.match(a.headers.get('set-cookie'),/Secure; HttpOnly; SameSite=Lax/);
 const result=await f.callback(a);assert.equal(result.status,200);const landing=await result.text();assert.match(landing,/<meta http-equiv="refresh" content="0;url=\/desktop-login\?attempt=valid-attempt">/);assert.match(landing,/<a href="\/desktop-login\?attempt=valid-attempt">/);assert.equal(result.headers.get('location'),null);
 assert.equal(f.calls.length,2);assert.equal(f.calls[0].url,'https://accounts.feishu.cn/oauth/v3/token');
 const body=JSON.parse(f.calls[0].request.body);assert.equal(f.calls[0].request.headers['content-type'],'application/json; charset=utf-8');assert.equal(body.grant_type,'authorization_code');assert.equal(body.client_secret,config.appSecret);
 assert.equal(sha(body.code_verifier),a.authorize.searchParams.get('code_challenge'));assert.equal(f.calls[0].request.redirect,'error');
 assert.equal(f.calls[1].request.headers.authorization,'Bearer fixture-access-token');assert.equal(f.resolved[0].value.tenantKey,'tenant_other_company');
 assert.deepEqual(f.resolved[0].bind,{});assert.equal(f.store.get('abcdef1234567890').admin,false);
 const cookies=result.headers.getSetCookie();assert.equal(cookies.length,2);assert.ok(cookies.every(x=>!x.includes('fixture-access-token')));assert.match(cookies[1],/SameSite=Strict/);
 assert.equal(result.headers.get('cache-control'),'no-store');assert.equal((await f.callback(a)).status,410);assert.equal(f.calls.length,2);
});

test('an explicit v2 selection retains JSON, PKCE and one-use authorization codes',async t=>{
 const f=await fixture(t,{config:{tokenEndpointVersion:'v2'}}),a=await f.start({bind:true}),result=await f.callback(a,'v2-binding-code');
 assert.equal(result.status,200);assert.equal(f.calls.length,2);assert.equal(f.calls[0].url,'https://open.feishu.cn/open-apis/authen/v2/oauth/token');
 const request=f.calls[0].request,body=JSON.parse(request.body);assert.equal(request.headers['content-type'],'application/json; charset=utf-8');assert.equal(request.redirect,'error');
 assert.equal(body.code,'v2-binding-code');assert.equal(body.client_id,config.appId);assert.equal(body.redirect_uri,config.redirectUri);assert.equal(sha(body.code_verifier),a.authorize.searchParams.get('code_challenge'));assert.equal(a.authorize.searchParams.get('code_challenge_method'),'S256');
 assert.equal((await f.callback(a,'v2-binding-code')).status,410);assert.equal(f.calls.length,2);assert.equal(f.resolved[0].bind.bindAccountId,f.admin.id);
});

test('PKCE provider rejection never falls back or repeats the selected token endpoint',async t=>{
 for(const tokenEndpointVersion of [undefined,'v2']){
  const f=await fixture(t,{config:tokenEndpointVersion===undefined?{}:{tokenEndpointVersion},fetchImpl:async()=>new Response(JSON.stringify({code:20049,error_description:'fixture-sensitive-pkce-error'}),{status:400})}),a=await f.start();
  const result=await f.callback(a,'pkce-rejected-code');assert.equal(result.status,502);assert.equal(f.calls.length,1);assert.equal(f.resolved.length,0);
  assert.equal(f.calls[0].url,tokenEndpointVersion==='v2'?'https://open.feishu.cn/open-apis/authen/v2/oauth/token':'https://accounts.feishu.cn/oauth/v3/token');assert.equal(f.diagnostics[0].providerCode,20049);
  assert.equal((await f.callback(a,'pkce-rejected-code')).status,410);assert.equal(f.calls.length,1);assert.ok(!(await result.text()).includes('fixture-sensitive-pkce-error'));
 }
});

test('verified personal profiles with absent or null optional fields work and sensitive profile fields are discarded',async t=>{
 for(const optional of [{},{tenant_key:null,union_id:null,avatar_url:null}]){
  const f=await fixture(t);f.setProfile({open_id:'ou_personal',name:'个人用户',email:'not-an-identity@example.test',mobile:'not-collected',...optional});
  assert.equal((await f.callback(await f.start())).status,200);
  assert.deepEqual(f.resolved[0].value,{appId:config.appId,openId:'ou_personal',name:'个人用户'});
 }
});

test('explicit binding retains the original administrator and checks the original session on a cross-site callback',async t=>{
 const f=await fixture(t),a=await f.start({bind:true});
 assert.equal(a.authorize.searchParams.get('prompt'),'consent');
 const result=await f.callback(a,'bind-code',{requestOrigin:'https://accounts.feishu.cn'});assert.equal(result.status,200);assert.match(await result.text(),/href="\/account\?feishu=bound"/);
 assert.equal(f.resolved[0].bind.bindAccountId,f.admin.id);assert.equal(f.resolved[0].bind.bindRevision,1);assert.equal(typeof f.resolved[0].bind.validateBinding,'function');assert.equal(f.store.get(f.admin.id).admin,true);
 assert.equal((await f.request('/auth/feishu/bind',{method:'POST',cookie:'__Host-muse='+f.adminToken,requestOrigin:'https://evil.test',body:{}})).status,403);
 assert.equal((await f.request('/auth/feishu/bind',{method:'POST',body:{}})).headers.get('location'),'/login');
});

test('a missing or different browser nonce and duplicate callback state never reach Feishu',async t=>{
 const f=await fixture(t),a=await f.start();
 assert.equal((await f.callback(a,'one',{cookie:undefined})).status,410);
 assert.equal((await f.callback(a,'one',{cookie:'__Host-muse-feishu='+'x'.repeat(43)})).status,410);
 assert.equal((await f.request('/auth/feishu/callback?state='+a.state+'&state='+a.state+'&code=one',{cookie:a.cookie})).status,410);
 assert.equal((await f.callback(a,'one',{cookie:a.cookie+'; '+a.cookie})).status,410);
 assert.equal(f.calls.length,0);assert.equal((await f.callback(a)).status,200);
});

test('parallel callbacks and a second attempt reusing an authorization code exchange it only once',async t=>{
 const f=await fixture(t),a=await f.start();
 const results=await Promise.all([f.callback(a,'same-code'),f.callback(a,'same-code')]);assert.deepEqual(results.map(x=>x.status).sort(),[200,410]);
 const b=await f.start();assert.equal((await f.callback(b,'same-code')).status,410);assert.equal(f.calls.length,2);
});

test('cancelled, expired and malformed authorization attempts do not mint sessions',async t=>{
 const f=await fixture(t),cancelled=await f.start();
 const result=await f.request('/auth/feishu/callback?state='+cancelled.state+'&error=access_denied',{cookie:cancelled.cookie});
 assert.equal(result.status,400);assert.match(result.headers.get('set-cookie'),/Max-Age=0/);assert.equal((await f.callback(cancelled)).status,410);
 const invalid=await f.start();assert.equal((await f.request('/auth/feishu/callback?state='+invalid.state+'&code=a&code=b',{cookie:invalid.cookie})).status,400);
 const expired=await f.start();f.setTime(f.now()+300000);assert.equal((await f.callback(expired)).status,410);assert.equal(f.calls.length,0);assert.equal(f.sessionStore.size(),1);
});

test('binding cannot continue after logout or a password revision change',async t=>{
 const loggedOut=await fixture(t),a=await loggedOut.start({bind:true});await loggedOut.sessionStore.revoke(loggedOut.adminToken);
 assert.equal((await loggedOut.callback(a)).status,403);assert.equal(loggedOut.calls.length,0);
 const changed=await fixture(t),b=await changed.start({bind:true});changed.records.set(changed.admin.id,{...changed.admin,revision:2});
 assert.equal((await changed.callback(b)).status,403);assert.equal(changed.calls.length,0);
});

test('binding is rechecked after upstream verification and during session issuance',async t=>{
 let f;f=await fixture(t,{fetchImpl:async url=>{
  if(url.endsWith('/token'))return response({code:0,access_token:'fixture-access-token',token_type:'Bearer'});
  await f.sessionStore.revoke(f.adminToken);return response({code:0,data:profile});
 }});
 assert.equal((await f.callback(await f.start({bind:true}))).status,403);assert.equal(f.resolved.length,0);
 const g=await fixture(t),issue=g.sessionStore.issue;g.sessionStore.issue=async value=>{const credential=await issue(value);g.records.set(g.admin.id,{...g.admin,disabled:true});return credential;};
 assert.equal((await g.callback(await g.start({bind:true}))).status,403);assert.equal(g.sessionStore.size(),1);
});

test('binding queued behind a store mutation checks the original session at transaction admission',async t=>{
 let entered,release;const ready=new Promise(resolve=>entered=resolve),held=new Promise(resolve=>release=resolve);
 const f=await fixture(t,{beforeResolve:async()=>{entered();await held;}}),pending=f.callback(await f.start({bind:true}));
 await ready;await f.sessionStore.revoke(f.adminToken);release();assert.equal((await pending).status,403);assert.equal(f.sessionStore.size(),0);
});

test('failed session issuance does not record a successful login and failed recording revokes the new session',async t=>{
 const failed=await fixture(t);failed.sessionStore.issue=async()=>{throw Error('synthetic issuance failure');};
 assert.equal((await failed.callback(await failed.start())).status,502);assert.equal(failed.recorded.length,0);assert.equal(failed.store.get('abcdef1234567890').lastLoginAt,null);assert.equal(failed.sessionStore.size(),1);
 const recording=await fixture(t);recording.store.recordLogin=async()=>{throw Error('synthetic recording failure');};
 assert.equal((await recording.callback(await recording.start())).status,502);assert.equal(recording.store.get('abcdef1234567890').lastLoginAt,null);assert.equal(recording.sessionStore.size(),1);
 const success=await fixture(t);assert.equal((await success.callback(await success.start())).status,200);assert.equal(success.recorded.length,1);assert.equal(success.recorded[0].feishuIdentity.openId,profile.open_id);
});

test('a binding whose login record waits in the store queue rechecks logout before marking success',async t=>{
 let entered,release;const ready=new Promise(resolve=>entered=resolve),held=new Promise(resolve=>release=resolve);
 const f=await fixture(t,{beforeRecordLogin:async()=>{entered();await held;}}),pending=f.callback(await f.start({bind:true}));
 await ready;await f.sessionStore.revoke(f.adminToken);release();assert.equal((await pending).status,403);assert.equal(f.recorded.length,0);assert.equal(f.store.get(f.admin.id).lastLoginAt,null);assert.equal(f.sessionStore.size(),0);
});

test('upstream errors are fixed safe messages and authorization codes are never retried or downgraded',async t=>{
 for(const outcome of [new Response('raw private error',{status:400}),response({code:20010,error_description:'raw private error'}),response({code:0,access_token:'raw private error'}),new Response('invalid JSON')]){
  const f=await fixture(t,{fetchImpl:async()=>outcome}),result=await f.callback(await f.start());
  assert.equal(result.status,502);assert.ok(!(await result.text()).includes('raw private error'));assert.equal(f.calls.length,1);assert.equal(f.resolved.length,0);
 }
});

test('failure diagnostics report only fixed stages, reasons, timings and numeric provider metadata',async t=>{
 const sensitive='fixture-sensitive-diagnostic-value',success=response({code:0,access_token:sensitive,token_type:'Bearer'});
 const cases=[
  {stage:'token_exchange',reason:'http_error',httpStatus:400,providerCode:20004,fetchImpl:async()=>new Response(JSON.stringify({code:20004,error_description:sensitive,access_token:sensitive}),{status:400})},
  {stage:'user_info',reason:'provider_rejected',httpStatus:200,providerCode:99991663,fetchImpl:async url=>url.endsWith('/token')?success.clone():response({code:99991663,msg:sensitive,data:{name:sensitive}})},
  {stage:'token_exchange',reason:'network',fetchImpl:async()=>{throw Object.assign(Error(sensitive),{cause:{message:sensitive,url:'https://example.test/'+sensitive}});}},
  {stage:'token_exchange',reason:'timeout',fetchImpl:async()=>{throw new DOMException(sensitive,'TimeoutError');}},
  {stage:'profile_validate',reason:'profile_invalid',profile:{...profile,open_id:sensitive+' invalid'}},
  {stage:'identity_store',reason:'store_failure',mutate:f=>{f.store.resolveFeishuIdentity=async()=>{throw Error(sensitive);};}},
  {stage:'session_issue',reason:'session_failure',mutate:f=>{f.sessionStore.issue=async()=>{throw Error(sensitive);};}},
  {stage:'login_record',reason:'store_failure',mutate:f=>{f.store.recordLogin=async()=>{throw Error(sensitive);};}},
 ];
 for(const {stage,reason,httpStatus,providerCode,fetchImpl,profile:invalidProfile,mutate} of cases){
  const f=await fixture(t,{fetchImpl});if(invalidProfile)f.setProfile(invalidProfile);mutate?.(f);
  const a=await f.start(),result=await f.callback(a,sensitive);
  assert.equal(result.status,502);assert.equal(f.diagnostics.length,1);
  const diagnostic=f.diagnostics[0],expected={stage,reason,...httpStatus===undefined?{}:{httpStatus},...providerCode===undefined?{}:{providerCode}};
  assert.deepEqual(diagnostic,{...expected,elapsedMs:diagnostic.elapsedMs});assert.ok(Number.isSafeInteger(diagnostic.elapsedMs)&&diagnostic.elapsedMs>=0);
  const output=JSON.stringify(diagnostic)+' '+await result.text();
  for(const value of [sensitive,config.appSecret,a.state,a.cookie,a.authorize.href,'fixture-access-token'])assert.ok(!output.includes(value));
  assert.equal(f.sessionStore.size(),1);
 }
});

test('a throwing failure sink cannot suppress the response or revocation of an issued session',async t=>{
 const diagnostics=[],f=await fixture(t,{onFailure:async diagnostic=>{diagnostics.push(diagnostic);throw Error('fixture-sensitive-sink-error');}});
 f.store.recordLogin=async()=>{throw Error('fixture-sensitive-record-error');};
 const a=await f.start(),result=await f.callback(a);
 assert.equal(result.status,502);assert.equal(f.sessionStore.size(),1);assert.equal(f.recorded.length,0);
 assert.equal(diagnostics.length,1);assert.equal(diagnostics[0].stage,'login_record');assert.equal(diagnostics[0].reason,'store_failure');
 assert.ok(!JSON.stringify(diagnostics).includes('fixture-sensitive'));assert.ok(!(await result.text()).includes('fixture-sensitive'));
 assert.equal((await f.callback(a)).status,410);
});

test('failed Desktop approval records its fixed stage and revokes the issued session',async t=>{
 const desktopConsent={consumeFeishuConsent:()=>({}),feishuConsentCurrent:()=>true,approveFeishuConsent:()=>false},f=await fixture(t,{desktopConsent});
 const started=await f.request('/auth/feishu/start',{method:'POST',body:{}}),authorize=new URL(started.headers.get('location'));
 const result=await f.callback({state:authorize.searchParams.get('state'),cookie:started.headers.get('set-cookie').split(';')[0]});
 assert.equal(result.status,403);assert.equal(f.sessionStore.size(),1);assert.equal(f.diagnostics.length,1);
 assert.equal(f.diagnostics[0].stage,'desktop_approval');assert.equal(f.diagnostics[0].reason,'account_unavailable');
});

test('verified binding through the durable store retains the original administrator and records the login',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'muse-feishu-real-store-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 const file=join(directory,'accounts.json'),store=await openStore(file),admin=await store.create('ylk','synthetic-password',{admin:true});
 const f=await fixture(t,{store,admin}),a=await f.start({bind:true}),result=await f.callback(a,'durable-bind-code');
 assert.equal(result.status,200);assert.equal(f.diagnostics.length,0);assert.match(await result.text(),/\/account\?feishu=bound/);
 const reopened=await openStore(file),accounts=reopened.list();assert.equal(accounts.length,1);
 assert.equal(accounts[0].id,admin.id);assert.equal(accounts[0].admin,true);assert.equal(accounts[0].revision,admin.revision);assert.equal(accounts[0].passwordLogin,true);
 assert.equal(accounts[0].feishuIdentities.length,1);assert.equal(accounts[0].feishuIdentities[0].openId,profile.open_id);assert.equal(accounts[0].lastLoginAt,new Date(f.now()).toISOString());
 assert.ok(f.sessionStore.get(f.adminToken));
});

test('invalid profile identifiers and oversized provider responses are rejected before account mutation',async t=>{
 const invalid=await fixture(t);invalid.setProfile({...profile,open_id:'not an identity'});assert.equal((await invalid.callback(await invalid.start())).status,502);assert.equal(invalid.resolved.length,0);
 const huge=await fixture(t,{fetchImpl:async()=>new Response('x'.repeat(65537))});assert.equal((await huge.callback(await huge.start())).status,502);assert.equal(huge.resolved.length,0);
});

test('an unavailable account or a conflicting bind cannot be turned into another account login',async t=>{
 const f=await fixture(t);assert.equal((await f.callback(await f.start())).status,200);
 const conflict=await f.callback(await f.start({bind:true}),'second-code');assert.equal(conflict.status,409);assert.ok(!(await conflict.text()).includes('raw error'));assert.equal(f.store.get(f.admin.id).admin,true);
 const g=await fixture(t,{allowAccount:()=>false});assert.equal((await g.callback(await g.start())).status,403);assert.equal(g.sessionStore.size(),1);
});

test('bounded attempts, admission rate and method restrictions fail without upstream calls',async t=>{
 const f=await fixture(t,{config:{maxAttempts:1}});await f.start();assert.equal((await f.request('/auth/feishu/start')).status,503);
 assert.equal((await f.request('/auth/feishu/start',{method:'PUT'})).status,405);assert.equal((await f.request('/auth/feishu/bind')).status,405);
 assert.equal((await f.request('/auth/feishu/start',{requestOrigin:'https://evil.test'})).status,403);assert.equal(f.calls.length,0);
 const rate=await fixture(t,{rate:()=>false});assert.equal((await rate.request('/auth/feishu/start')).status,429);
});

test('shutdown aborts pending verification and cannot create a late account or session',async t=>{
 let entered;const ready=new Promise(resolve=>entered=resolve);
 const f=await fixture(t,{fetchImpl:async(_url,request)=>{entered();return new Promise((_resolve,reject)=>request.signal.addEventListener('abort',()=>reject(Error('aborted')),{once:true}));}}),a=await f.start(),pending=f.callback(a);
 await ready;await f.feature.close();assert.equal((await pending).status,502);assert.equal(f.resolved.length,0);assert.equal(f.sessionStore.size(),1);assert.equal((await f.request('/auth/feishu/start')).status,503);
});

test('a disconnected callback aborts its provider request without creating an account or session',async t=>{
 let entered,aborted;const ready=new Promise(resolve=>entered=resolve),stopped=new Promise(resolve=>aborted=resolve),cancel=new AbortController();
 const f=await fixture(t,{fetchImpl:async(_url,request)=>{entered();return new Promise((_resolve,reject)=>request.signal.addEventListener('abort',()=>{aborted();reject(Error('aborted'));},{once:true}));}});
 const pending=f.callback(await f.start(),'disconnect-code',{signal:cancel.signal}).catch(error=>error);await ready;cancel.abort();
 assert.equal((await pending).name,'AbortError');await stopped;await f.feature.close();assert.equal(f.resolved.length,0);assert.equal(f.sessionStore.size(),1);
});

/** Real gateway routes with isolated accounts and synthetic official OAuth responses. */
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {createAccountServer,installGatewayShutdown} from './gateway.mjs';
import {createMemorySessionStore} from './session-store.mjs';
import {openStore} from './store.mjs';

const origin='https://muse.test';
const config={appId:'cli_gateway_fixture',appSecret:'synthetic-server-only-secret',appType:'custom',redirectUri:origin+'/auth/feishu/callback'};
const organizationProfile={name:'企业编剧',open_id:'ou_member',union_id:'on_member',tenant_key:'fixture_enterprise'};
const json=value=>new Response(JSON.stringify(value),{headers:{'content-type':'application/json'}});
const cookieFrom=(response,name='__Host-muse')=>response.headers.getSetCookie().find(value=>value.startsWith(name+'='))?.split(';')[0];

async function fixture(t,{enabled=true,appType='custom',tokenEndpointVersion,environment='production',publicOrigin=origin,fetchImpl}={}){
 const root=await mkdtemp(join(tmpdir(),'muse-feishu-gateway-')),store=await openStore(join(root,'accounts.json'));
 const administrator=await store.create('ylk','fixture-password',{admin:true}),sessionStore=createMemorySessionStore();
 let time=Date.now();const now=()=>time,calls=[],codes=new Map(),tokens=new Map();
 const supplier=async(url,request)=>{
  calls.push({url,request});
  if(fetchImpl)return fetchImpl(url,request);
  if(url===(tokenEndpointVersion==='v2'?'https://open.feishu.cn/open-apis/authen/v2/oauth/token':'https://accounts.feishu.cn/oauth/v3/token')){
   assert.equal(request.method,'POST');assert.equal(request.headers['content-type'],'application/json; charset=utf-8');const code=JSON.parse(request.body).code,profile=codes.get(code);assert.ok(profile,'The test registered this authorization code');
   codes.delete(code);const accessToken='synthetic-access-token-'+tokens.size;tokens.set(accessToken,profile);return json({code:0,access_token:accessToken,token_type:'Bearer',expires_in:7200});
  }
  assert.equal(url,'https://open.feishu.cn/open-apis/authen/v1/user_info');assert.equal(request.method,'GET');
  const profile=tokens.get(request.headers.authorization.slice('Bearer '.length));assert.ok(profile);return json({code:0,data:profile});
 };
 const server=createAccountServer({store,workspaceMode:'desktop',publicOrigin,sessionStore,now,devOnlyAdmin:false,environment,feishuLoginOptions:enabled?{config:{...config,appType,tokenEndpointVersion,redirectUri:publicOrigin+'/auth/feishu/callback'},fetchImpl:supplier}:{}});
 const shutdown=installGatewayShutdown({accountServer:server,signals:new EventEmitter()});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const base='http://127.0.0.1:'+server.address().port;
 t.after(async()=>{await shutdown.close();await rm(root,{recursive:true,force:true});});
 const request=(path,{method='GET',cookie,body,headers={},requestOrigin=publicOrigin}={})=>fetch(base+path,{method,redirect:'manual',headers:{...requestOrigin===undefined?{}:{origin:requestOrigin},...cookie?{cookie}:{},...headers},body});
 async function passwordLogin(username='ylk'){
  const result=await request('/login',{method:'POST',body:new URLSearchParams({username,password:'fixture-password'})});assert.equal(result.status,303);return cookieFrom(result);
 }
 async function start({bind=false,cookie,desktopLogin}={}){
  const path=bind?'/auth/feishu/bind':'/auth/feishu/start'+(desktopLogin?'?desktop_login='+encodeURIComponent(desktopLogin):'');
  const result=await request(path,{cookie,method:bind?'POST':'GET',body:bind?new URLSearchParams():undefined});assert.equal(result.status,303);
  return {state:new URL(result.headers.get('location')).searchParams.get('state'),cookie:cookieFrom(result,'__Host-muse-feishu')};
 }
 async function finish(attempt,profile=organizationProfile,{automatic=false}={}){
  const code='fixture-code-'+codes.size+'-'+calls.length;codes.set(code,profile);
  const result=await request('/auth/feishu/callback?state='+attempt.state+'&code='+code,{cookie:attempt.cookie,requestOrigin:'https://accounts.feishu.cn'});
  assert.equal(result.status,200);assert.equal(result.headers.get('referrer-policy'),'no-referrer');
  const markup=await result.text();if(automatic)assert.match(markup,/登录成功/);else assert.match(markup,/<meta http-equiv="refresh"/);assert.ok(!markup.includes('synthetic-access-token'));
  return {cookie:cookieFrom(result),markup,result};
 }
 async function identity(cookie){const result=await request('/api/muse.account',{cookie});assert.equal(result.status,200);return result.json();}
 return {root,store,administrator,sessionStore,request,passwordLogin,start,finish,identity,calls,codes,server,shutdown,setTime:value=>time=value,now};
}

test('an unconfigured gateway keeps password login and omits Feishu actions',async t=>{
 const f=await fixture(t,{enabled:false}),entry=await f.request('/login');assert.equal(entry.status,200);const entryMarkup=await entry.text();assert.ok(!entryMarkup.includes('使用飞书登录'));assert.match(entryMarkup,/name="username"/);assert.match(entryMarkup,/name="password"/);assert.match(entryMarkup,/免费注册个人工作间/);
 const cookie=await f.passwordLogin(),account=await f.request('/account',{cookie});assert.equal(account.status,200);const markup=await account.text();
 assert.match(markup,/飞书登录暂未启用/);assert.ok(!markup.includes('action="/auth/feishu/bind"'));
 const absent=await f.request('/auth/feishu/start');assert.equal(absent.status,303);assert.equal(absent.headers.get('location'),'/login');assert.equal(f.calls.length,0);
 const start=await f.request('/api/desktop-login/start',{method:'POST',body:new URLSearchParams({provider:'feishu'})}),attempt=await start.json();assert.equal(attempt.authorizeUrl,origin+'/desktop-login?attempt='+attempt.id);
});

test('a Feishu-enabled gateway retains the original approval URL for clients that do not request Feishu entry',async t=>{
 const f=await fixture(t);
 for(const fields of [{},{provider:'other'}]){
  const result=await f.request('/api/desktop-login/start',{method:'POST',body:new URLSearchParams(fields)}),attempt=await result.json();assert.equal(result.status,200);assert.equal(attempt.authorizeUrl,origin+'/desktop-login?attempt='+attempt.id);
  const entry=await f.request(new URL(attempt.authorizeUrl).pathname+new URL(attempt.authorizeUrl).search);assert.equal(entry.status,200);const markup=await entry.text();assert.match(markup,/action="\/auth\/feishu\/start" method="post"/);assert.ok(markup.includes(attempt.code));assert.ok(!markup.includes(attempt.secret));
 }
 assert.equal(f.calls.length,0);
});

test('a gateway explicitly selecting v2 binds the existing administrator through the fixed endpoint',async t=>{
 const f=await fixture(t,{tokenEndpointVersion:'v2'}),cookie=await f.passwordLogin(),attempt=await f.start({bind:true,cookie}),bound=await f.finish(attempt);
 const identity=await f.identity(bound.cookie);assert.equal(identity.username,'ylk');assert.equal(identity.admin,true);assert.equal(f.store.list().length,1);assert.equal(f.store.get(f.administrator.id).feishuIdentities.length,1);
 assert.equal(f.calls.length,2);assert.equal(f.calls[0].url,'https://open.feishu.cn/open-apis/authen/v2/oauth/token');
 assert.equal(f.calls.some(call=>call.url==='https://accounts.feishu.cn/oauth/v3/token'),false);
});

test('only enabled Feishu form pages allow the fixed official account origin in form-action',async t=>{
 const formAction=response=>response.headers.get('content-security-policy').split(';').map(value=>value.trim()).find(value=>value.startsWith('form-action '));
 for(const enabled of [false,true]){
  const f=await fixture(t,{enabled}),cookie=await f.passwordLogin();
  const account=await f.request('/account',{cookie});assert.equal(account.status,200);assert.equal(formAction(account),enabled?"form-action 'self' https://accounts.feishu.cn":"form-action 'self'");
  const start=await f.request('/api/desktop-login/start',{method:'POST',body:new URLSearchParams()}),attempt=await start.json();
  const entry=await f.request('/desktop-login?attempt='+attempt.id+'&redirect_uri=https%3A%2F%2Fevil.test%2Fcallback');assert.equal(entry.status,200);assert.equal(formAction(entry),enabled?"form-action 'self' https://accounts.feishu.cn":"form-action 'self'");
  assert.ok(!entry.headers.get('content-security-policy').includes('evil.test'));assert.ok(!entry.headers.get('content-security-policy').includes('*'));
  const signedIn=await f.request('/desktop-login?attempt='+attempt.id,{cookie});assert.equal(formAction(signedIn),"form-action 'self'");
  const login=await f.request('/login');assert.equal(formAction(login),"form-action 'self'");
  const admin=await f.request('/admin',{cookie});assert.equal(formAction(admin),"form-action 'self'");
  assert.equal(f.calls.length,0);
 }
});

test('explicit Feishu binding preserves ylk account identity, administrator role and password',async t=>{
 const f=await fixture(t),original=await f.passwordLogin(),entry=await f.request('/account',{cookie:original});assert.match(await entry.text(),/action="\/auth\/feishu\/bind"/);
 const bound=await f.finish(await f.start({bind:true,cookie:original}),{...organizationProfile,name:'本人飞书'}),account=await f.identity(bound.cookie);
 assert.equal(account.accountId,f.administrator.id);assert.equal(account.username,'ylk');assert.equal(account.admin,true);assert.equal(f.store.list().length,1);
 assert.equal(f.store.get(f.administrator.id).feishuIdentities[0].name,'本人飞书');assert.ok(await f.store.authenticate('ylk','fixture-password'));
 const repeat=await f.finish(await f.start(),organizationProfile);assert.equal((await f.identity(repeat.cookie)).accountId,f.administrator.id);assert.equal((await f.identity(original)).admin,true);
 assert.equal((await f.request('/admin',{cookie:repeat.cookie})).status,200);assert.equal(f.store.list().length,1);
});

test('custom app members create ordinary accounts once and Feishu application-scope refusals do not create accounts',async t=>{
 const f=await fixture(t),first=await f.finish(await f.start()),member=await f.identity(first.cookie);assert.equal(member.admin,false);assert.notEqual(member.accountId,f.administrator.id);
 const repeat=await f.finish(await f.start());assert.equal((await f.identity(repeat.cookie)).accountId,member.accountId);assert.equal(f.store.list().length,2);assert.equal((await f.request('/admin',{cookie:first.cookie})).status,403);
 const denied=await fixture(t,{fetchImpl:async()=>json({code:20010,error:'invalid_grant',error_description:'synthetic application unavailable'})}),attempt=await denied.start();
 const result=await denied.request('/auth/feishu/callback?state='+attempt.state+'&code=unavailable',{cookie:attempt.cookie});assert.equal(result.status,502);assert.equal(denied.store.list().length,1);assert.equal(denied.sessionStore.size(),0);assert.equal(denied.calls.length,1);
});

test('Store App compatibility keeps external and personal identities ordinary and repeat login deduplicated',async t=>{
 const f=await fixture(t,{appType:'store'}),external=await f.finish(await f.start(),{...organizationProfile,name:'ylk'}),first=await f.identity(external.cookie);
 assert.notEqual(first.accountId,f.administrator.id);assert.equal(first.admin,false);assert.equal(f.store.list().length,2);assert.equal((await f.request('/admin',{cookie:external.cookie})).status,403);
 const repeat=await f.finish(await f.start(),{...organizationProfile,name:'改名后的编剧'});assert.equal((await f.identity(repeat.cookie)).accountId,first.accountId);assert.equal(f.store.list().length,2);
 assert.equal(f.store.get(first.accountId).feishuIdentities[0].name,'改名后的编剧');
 const personal=await f.finish(await f.start(),{name:'个人编剧',open_id:'ou_personal'}),personalIdentity=await f.identity(personal.cookie);
 assert.equal(personalIdentity.admin,false);assert.notEqual(personalIdentity.accountId,first.accountId);assert.equal(f.store.get(personalIdentity.accountId).feishuIdentities[0].tenantKey,null);
 const nullable=await f.finish(await f.start(),{name:'个人编剧',open_id:'ou_personal',tenant_key:null,union_id:null,avatar_url:null});assert.equal((await f.identity(nullable.cookie)).accountId,personalIdentity.accountId);assert.equal(f.store.list().length,3);
 const otherTenant=await f.finish(await f.start(),{...organizationProfile,tenant_key:'another_enterprise'});
 assert.notEqual((await f.identity(otherTenant.cookie)).accountId,first.accountId);assert.equal(f.store.list().length,4);assert.equal(f.store.list().filter(a=>a.admin).length,1);
});

test('a signed-in account starting login is not implicitly linked to the verified Feishu identity',async t=>{
 const f=await fixture(t),administrator=await f.passwordLogin(),signedIn=await f.finish(await f.start({cookie:administrator}));
 assert.equal((await f.identity(signedIn.cookie)).admin,false);assert.notEqual((await f.identity(signedIn.cookie)).accountId,f.administrator.id);
 assert.deepEqual(f.store.get(f.administrator.id).feishuIdentities,[]);assert.equal((await f.identity(administrator)).admin,true);
});

test('Desktop opens official Feishu authorization directly and waits for device confirmation before redemption',async t=>{
 const f=await fixture(t),start=await f.request('/api/desktop-login/start',{method:'POST',body:new URLSearchParams({provider:'feishu'})}),attempt=await start.json();assert.equal(start.status,200);
 assert.equal(attempt.authorizeUrl,origin+'/auth/feishu/start?desktop_login='+attempt.id);assert.ok(!attempt.authorizeUrl.includes(attempt.secret));
 const entry=await f.request(new URL(attempt.authorizeUrl).pathname+new URL(attempt.authorizeUrl).search);assert.equal(entry.status,303);assert.equal(await entry.text(),'');
 const authorize=new URL(entry.headers.get('location'));assert.equal(authorize.origin,'https://accounts.feishu.cn');assert.equal(authorize.searchParams.get('redirect_uri'),origin+'/auth/feishu/callback');assert.equal(authorize.searchParams.get('code_challenge_method'),'S256');assert.match(authorize.searchParams.get('code_challenge'),/^[A-Za-z0-9_-]{43}$/);
 const browser=await f.finish({state:authorize.searchParams.get('state'),cookie:cookieFrom(entry,'__Host-muse-feishu')});assert.ok(browser.markup.includes('url=/desktop-login?attempt='+attempt.id));assert.ok(!browser.markup.includes(attempt.secret));assert.match(browser.markup,/<title>MUSE<\/title>/);
 const before=await f.request('/api/desktop-login/check',{method:'POST',body:new URLSearchParams({id:attempt.id,secret:attempt.secret})});assert.equal((await before.json()).state,'pending');
 const confirmation=await f.request('/desktop-login?attempt='+attempt.id,{cookie:browser.cookie}),markup=await confirmation.text();assert.match(markup,/<title>MUSE<\/title>/);assert.match(markup,/<h1>MUSE<\/h1>/);assert.ok(markup.includes(attempt.code));assert.match(markup,/确认登录此设备/);assert.ok(!markup.includes(attempt.secret));
 assert.equal((await (await f.request('/api/desktop-login/check',{method:'POST',body:new URLSearchParams({id:attempt.id,secret:attempt.secret})})).json()).state,'pending');
 const approval=await f.request('/desktop-login',{method:'POST',cookie:browser.cookie,body:new URLSearchParams({attempt:attempt.id,decision:'approve'})});assert.equal(approval.status,200);const success=await approval.text();assert.match(success,/<title>MUSE<\/title>/);assert.match(success,/<h1>登录成功<\/h1>/);
 const redeemed=await f.request('/api/desktop-login/check',{method:'POST',body:new URLSearchParams({id:attempt.id,secret:attempt.secret})});assert.equal((await redeemed.json()).state,'signed-in');
 const desktop=cookieFrom(redeemed);assert.ok(desktop);assert.notEqual(desktop,browser.cookie);assert.equal((await f.identity(desktop)).accountId,(await f.identity(browser.cookie)).accountId);
 const unsafe=await f.finish(await f.start({desktopLogin:'https://evil.test/'}),{...organizationProfile,open_id:'ou_another'});assert.match(unsafe.markup,/content="0;url=\/"/);assert.ok(!unsafe.markup.includes('evil.test'));
});

test('a forwarded Desktop OAuth URL cannot approve a pending device without the browser confirmation POST',async t=>{
 const f=await fixture(t),start=await f.request('/api/desktop-login/start',{method:'POST',body:new URLSearchParams({provider:'feishu'})}),attempt=await start.json(),oauth=await f.start({desktopLogin:attempt.id}),browser=await f.finish(oauth);
 const check=()=>f.request('/api/desktop-login/check',{method:'POST',body:new URLSearchParams({id:attempt.id,secret:attempt.secret})});
 assert.equal((await (await check()).json()).state,'pending');
 assert.equal((await f.request('/desktop-login?attempt='+attempt.id+'&decision=approve',{cookie:browser.cookie})).status,200);
 assert.equal((await (await check()).json()).state,'pending');
 const body=new URLSearchParams({attempt:attempt.id,decision:'approve'});
 assert.equal((await f.request('/desktop-login',{method:'POST',cookie:browser.cookie,requestOrigin:'https://evil.test',body})).status,403);
 assert.equal((await f.request('/desktop-login',{method:'POST',cookie:browser.cookie,headers:{origin:''},body})).status,403);
 assert.equal((await f.request('/desktop-login',{method:'POST',body})).status,303);assert.equal((await (await check()).json()).state,'pending');
 const code='fixture-replayed-callback';f.codes.set(code,organizationProfile);const replay=await f.request('/auth/feishu/callback?state='+oauth.state+'&code='+code,{cookie:oauth.cookie});assert.equal(replay.status,410);assert.equal(f.calls.length,2);assert.equal((await (await check()).json()).state,'pending');
});

async function desktopConsent(f){
 const response=await f.request('/api/desktop-login/start',{method:'POST',body:new URLSearchParams()}),attempt=await response.json();assert.equal(response.status,200);
 const entry=await f.request('/desktop-login?attempt='+attempt.id),markup=await entry.text(),intent=markup.match(/name="desktop_intent" value="([A-Za-z0-9_-]{43})"/)[1],cookie=cookieFrom(entry,'__Host-muse-desktop-consent');
 assert.ok(cookie);assert.match(entry.headers.get('set-cookie'),/Secure; HttpOnly; SameSite=Strict/);assert.ok(markup.includes(attempt.code));assert.ok(!markup.includes(attempt.secret));
 const body=new URLSearchParams({desktop_login:attempt.id,desktop_intent:intent});
 return {attempt,body,cookie,markup};
}

async function authorizeConsent(f,consent){
 const result=await f.request('/auth/feishu/start',{method:'POST',cookie:consent.cookie,body:consent.body});assert.equal(result.status,303);
 return {state:new URL(result.headers.get('location')).searchParams.get('state'),cookie:cookieFrom(result,'__Host-muse-feishu')};
}

test('Feishu is the only rendered login action and one explicit device consent completes Desktop login without another confirmation',async t=>{
 const f=await fixture(t),entry=await f.request('/login'),markup=await entry.text();
 assert.match(markup,/使用飞书登录/);assert.ok(!markup.includes('name="username"'));assert.ok(!markup.includes('name="password"'));assert.ok(!markup.includes('免费注册个人工作间'));assert.ok(!markup.includes('先登录后绑定'));assert.ok(!markup.includes('<details>'));
 const register=await f.request('/register'),registerMarkup=await register.text();assert.equal(register.status,200);assert.match(registerMarkup,/使用飞书登录/);assert.ok(!registerMarkup.includes('name="username"'));assert.ok(!registerMarkup.includes('name="password"'));assert.ok(!registerMarkup.includes('注册并进入'));
 const consent=await desktopConsent(f),oauth=await authorizeConsent(f,consent),browser=await f.finish(oauth,organizationProfile,{automatic:true});
 assert.ok(!consent.markup.includes('name="username"'));assert.ok(!consent.markup.includes('name="password"'));assert.ok(!consent.markup.includes('免费注册个人工作间'));
 assert.ok(!browser.markup.includes('meta http-equiv="refresh"'));assert.ok(!browser.markup.includes('确认登录此设备'));
 const check=()=>f.request('/api/desktop-login/check',{method:'POST',body:new URLSearchParams({id:consent.attempt.id,secret:consent.attempt.secret})});
 const [first,second]=await Promise.all([check(),check()]);assert.deepEqual([first.status,second.status].sort(),[200,410]);
 const redeemed=first.status===200?first:second;assert.deepEqual(await redeemed.json(),{state:'signed-in'});assert.notEqual(cookieFrom(redeemed),browser.cookie);assert.equal((await f.identity(cookieFrom(redeemed))).accountId,(await f.identity(browser.cookie)).accountId);
 assert.equal((await f.request('/auth/feishu/start',{method:'POST',cookie:consent.cookie,body:consent.body})).status,410);assert.equal(f.calls.length,2);
});

test('device consent rejects missing or foreign browser evidence, duplicate fields, and cross-origin POST without provider calls',async t=>{
 const f=await fixture(t),consent=await desktopConsent(f),other=await desktopConsent(f);
 for(const options of [
  {body:consent.body},
  {body:consent.body,cookie:other.cookie},
  {body:consent.body,cookie:consent.cookie+'; '+consent.cookie},
  {body:new URLSearchParams({desktop_login:other.attempt.id,desktop_intent:consent.body.get('desktop_intent')}),cookie:consent.cookie},
  {body:new URLSearchParams([...consent.body,['desktop_login',consent.attempt.id]]),cookie:consent.cookie},
  {body:new URLSearchParams([...consent.body,['desktop_intent',consent.body.get('desktop_intent')]]),cookie:consent.cookie}
 ])assert.equal((await f.request('/auth/feishu/start',{method:'POST',...options})).status,410);
 assert.equal((await f.request('/auth/feishu/start',{method:'POST',body:consent.body,cookie:consent.cookie,requestOrigin:'https://evil.test'})).status,403);
 assert.equal((await f.request('/auth/feishu/start',{method:'POST',body:consent.body,cookie:consent.cookie,headers:{origin:''}})).status,403);
 assert.equal(f.calls.length,0);await f.finish(await authorizeConsent(f,consent),organizationProfile,{automatic:true});
});

test('cancelled, expired or superseded device consent cannot be approved by a later OAuth callback',async t=>{
 for(const reason of ['cancelled','expired','superseded']){
  const f=await fixture(t),consent=await desktopConsent(f),oauth=await authorizeConsent(f,consent);
  if(reason==='cancelled')await f.request('/api/desktop-login/cancel',{method:'POST',body:new URLSearchParams({id:consent.attempt.id,secret:consent.attempt.secret})});
  else if(reason==='expired')f.setTime(consent.attempt.expiresAt);
  else await f.request('/desktop-login?attempt='+consent.attempt.id);
  f.codes.set('late-callback',organizationProfile);
  const result=await f.request('/auth/feishu/callback?state='+oauth.state+'&code=late-callback',{cookie:oauth.cookie});assert.ok([403,410].includes(result.status));assert.equal(cookieFrom(result),undefined);assert.equal(f.calls.length,0);assert.equal(f.sessionStore.size(),0);assert.equal(f.store.list().length,1);
 }
});

test('cancellation while a session is being issued revokes that session and cannot approve the device',async t=>{
 const f=await fixture(t),consent=await desktopConsent(f),oauth=await authorizeConsent(f,consent);f.codes.set('issuance-cancel',organizationProfile);
 let entered,release;const ready=new Promise(resolve=>entered=resolve),resume=new Promise(resolve=>release=resolve),issue=f.sessionStore.issue;
 f.sessionStore.issue=async value=>{const credential=await issue(value);entered();await resume;return credential;};
 const callback=f.request('/auth/feishu/callback?state='+oauth.state+'&code=issuance-cancel',{cookie:oauth.cookie});await ready;
 await f.request('/api/desktop-login/cancel',{method:'POST',body:new URLSearchParams({id:consent.attempt.id,secret:consent.attempt.secret})});release();
 const result=await callback;assert.equal(result.status,403);assert.equal(cookieFrom(result),undefined);assert.equal(f.sessionStore.size(),0);assert.equal(f.store.list().find(account=>account.id!==f.administrator.id).lastLoginAt,null);
});

test('a device cancelled or refreshed during token exchange cannot start the user-info request',async t=>{
 for(const action of ['cancel','refresh']){
  let entered,release;const ready=new Promise(resolve=>entered=resolve),resume=new Promise(resolve=>release=resolve);
  const f=await fixture(t,{fetchImpl:async()=>{entered();await resume;return json({code:0,access_token:'synthetic-pending-token',token_type:'Bearer'});}}),consent=await desktopConsent(f),oauth=await authorizeConsent(f,consent);t.after(release);
  const callback=f.request('/auth/feishu/callback?state='+oauth.state+'&code=pending-token',{cookie:oauth.cookie});await ready;
  if(action==='cancel')await f.request('/api/desktop-login/cancel',{method:'POST',body:new URLSearchParams({id:consent.attempt.id,secret:consent.attempt.secret})});
  else await f.request('/desktop-login?attempt='+consent.attempt.id);
  release();assert.equal((await callback).status,403);assert.equal(f.calls.length,1);assert.equal(f.store.list().length,1);assert.equal(f.sessionStore.size(),0);
 }
});

test('parallel device authorization consumes one browser intent and explicit loopback development keeps secure sessions',async t=>{
 const f=await fixture(t,{environment:'development',publicOrigin:'http://localhost:19488'}),consent=await desktopConsent(f);
 const post=()=>f.request('/auth/feishu/start',{method:'POST',cookie:consent.cookie,body:consent.body}),responses=await Promise.all([post(),post()]);assert.deepEqual(responses.map(result=>result.status).sort(),[303,410]);
 const result=responses.find(value=>value.status===303),authorize=new URL(result.headers.get('location'));assert.equal(authorize.searchParams.get('redirect_uri'),'http://localhost:19488/auth/feishu/callback');
 const browser=await f.finish({state:authorize.searchParams.get('state'),cookie:cookieFrom(result,'__Host-muse-feishu')},organizationProfile,{automatic:true});assert.match(browser.result.headers.getSetCookie().find(value=>value.startsWith('__Host-muse=')),/; Secure; HttpOnly; SameSite=Strict;/);
 const redeemed=await f.request('/api/desktop-login/check',{method:'POST',body:new URLSearchParams({id:consent.attempt.id,secret:consent.attempt.secret})});assert.equal((await redeemed.json()).state,'signed-in');assert.match(redeemed.headers.get('set-cookie'),/; Secure; HttpOnly; SameSite=Strict;/);
});

test('activity writes only the authenticated account and administrator statistics use task events',async t=>{
 const f=await fixture(t),administrator=await f.passwordLogin(),writer=await f.finish(await f.start()),user=await f.identity(writer.cookie);
 assert.equal(f.store.get(user.accountId).lastActivityAt,null);assert.equal(f.store.get(f.administrator.id).lastActivityAt,null);
 const result=await f.request('/api/muse.activity',{method:'POST',cookie:writer.cookie,headers:{'content-type':'application/json'},body:JSON.stringify({activity:'task-start'})});
 assert.equal(result.status,204);assert.equal(result.headers.get('cache-control'),'no-store');assert.equal(f.store.get(user.accountId).lastActivityAt,new Date(f.now()).toISOString());assert.equal(f.store.get(f.administrator.id).lastActivityAt,null);
 const admin=await f.request('/admin',{cookie:administrator}),markup=await admin.text();assert.equal(admin.status,200);assert.match(markup,/企业编剧/);assert.match(markup,/fixture_enterprise/);
 const section=markup.match(/<section aria-label="使用概览">[\s\S]*?<\/section>/)[0];assert.deepEqual([...section.matchAll(/<strong>(\d+)<\/strong>/g)].map(match=>Number(match[1])),[2,2,0,1,0,0,1,1,1]);
 assert.equal((await f.request('/admin',{cookie:writer.cookie})).status,403);assert.equal((await f.request('/admin')).status,303);
});

test('activity rejects missing authentication, unsafe origins, unsupported methods, bodies and foreign account fields',async t=>{
 const f=await fixture(t),cookie=await f.passwordLogin(),valid=JSON.stringify({activity:'task-start'}),post={method:'POST',cookie,headers:{'content-type':'application/json'},body:valid};
 const unauthorized=await f.request('/api/muse.activity',{...post,cookie:undefined});assert.equal(unauthorized.status,401);assert.equal((await unauthorized.json()).error_code,'account_session_expired');
 assert.equal((await f.request('/api/muse.activity',{cookie})).status,405);
 assert.equal((await f.request('/api/muse.activity',{...post,requestOrigin:'https://evil.test'})).status,403);
 assert.equal((await f.request('/api/muse.activity',{...post,requestOrigin:undefined,headers:{'content-type':'application/json',origin:''}})).status,403);
 assert.equal((await f.request('/api/muse.activity',{...post,headers:{'content-type':'application/x-www-form-urlencoded'}})).status,415);
 for(const body of ['not JSON','null','[]','{}','{"activity":"heartbeat"}','{"activity":"task-start","accountId":"someone-else"}','{"activity":"task-start","at":"2030-01-01T00:00:00.000Z"}'])assert.equal((await f.request('/api/muse.activity',{...post,body})).status,400);
 assert.equal((await f.request('/api/muse.activity',{...post,body:' '.repeat(1025)})).status,413);assert.equal(f.store.get(f.administrator.id).lastActivityAt,null);
 const token=cookie.slice('__Host-muse='.length);await f.sessionStore.revoke(token);assert.equal((await f.request('/api/muse.activity',post)).status,401);
});

test('gateway shutdown owns an in-flight OAuth request and prevents late account creation',async t=>{
 let entered,aborted;const ready=new Promise(resolve=>entered=resolve),stopped=new Promise(resolve=>aborted=resolve);
 const f=await fixture(t,{fetchImpl:async(_url,request)=>{entered();return new Promise((_resolve,reject)=>request.signal.addEventListener('abort',()=>{aborted();reject(Error('synthetic abort'));},{once:true}));}}),attempt=await f.start();
 const pending=f.request('/auth/feishu/callback?state='+attempt.state+'&code=shutdown-code',{cookie:attempt.cookie}).catch(error=>error);
 await ready;const first=f.shutdown.close();assert.equal(first,f.shutdown.close());await first;await stopped;const result=await pending;
 assert.ok(result instanceof Error||result.status===502);assert.equal(f.store.list().length,1);assert.equal(f.sessionStore.size(),0);assert.equal(f.calls.length,1);assert.equal(f.server.listening,false);
});

test('a callback that cannot issue or record a session leaves recent-login timestamps unchanged',async t=>{
 for(const failure of ['issue','record']){
  const f=await fixture(t),attempt=await f.start();f.codes.set('failed-session',organizationProfile);
  if(failure==='issue')f.sessionStore.issue=async()=>{throw Error('synthetic issuance failure');};
  else f.store.recordLogin=async()=>{throw Error('synthetic recording failure');};
  const result=await f.request('/auth/feishu/callback?state='+attempt.state+'&code=failed-session',{cookie:attempt.cookie});assert.equal(result.status,502);assert.equal(cookieFrom(result),undefined);
  const created=f.store.list().find(account=>account.id!==f.administrator.id);assert.ok(created);assert.equal(created.lastLoginAt,null);assert.equal(created.feishuIdentities[0].lastLoginAt,null);assert.equal(f.sessionStore.size(),0);
 }
});


test('password sign-in records success only after session issuance and conceals unusable password forms',async t=>{
 const f=await fixture(t),originalIssue=f.sessionStore.issue;
 f.sessionStore.issue=async()=>{throw Error('isolated persistence failure');};
 const failed=await f.request('/login',{method:'POST',body:new URLSearchParams({username:'ylk',password:'fixture-password'})});
 assert.equal(failed.status,503);assert.equal(f.store.get(f.administrator.id).lastLoginAt,null);assert.equal(cookieFrom(failed),undefined);
 f.sessionStore.issue=originalIssue;
 const original=await f.passwordLogin();assert.ok(f.store.get(f.administrator.id).lastLoginAt);
 const form=await f.request('/account',{cookie:original});assert.match(await form.text(),/action="\/account\/password"/);
 const member=await f.finish(await f.start(),{name:'企业成员',open_id:'ou_password_free',tenant_key:'our_enterprise'});
 const accountPage=await f.request('/account',{cookie:member.cookie}),markup=await accountPage.text();
 assert.ok(!markup.includes('action="/account/password"'));assert.match(markup,/无需 Muse 密码/);assert.match(markup,/仅限本企业应用可用范围内的成员/);
});

test('activity admission rate is bounded deployment configuration',()=>{
 for(const activityRequestRatePerMinute of [0,-1,1.5,10001,NaN])assert.throws(()=>createAccountServer({activityRequestRatePerMinute}),/Invalid activity request rate/);
});

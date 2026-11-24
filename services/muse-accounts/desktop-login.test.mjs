import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {createHash,generateKeyPairSync,sign} from 'node:crypto';
import {openStore} from './store.mjs';
import {createAccountServer} from './gateway.mjs';
import {createDesktopLogin} from './desktop-login.mjs';

function device(deviceName='Company laptop'){
 const {publicKey,privateKey}=generateKeyPairSync('ed25519'),issuerId=createHash('sha256').update(publicKey.export({type:'spki',format:'der'})).digest('hex');
 return {issuer:{issuerId,publicKey:publicKey.export({type:'spki',format:'pem'}),deviceName},privateKey,
  proof:a=>sign(null,Buffer.from('muse-fee-issuer-enroll-v1\n'+a.id+'\n'+a.secret),privateKey).toString('base64url')};
}

async function fixture(t,options={}){
 const dir=await mkdtemp(join(tmpdir(),'muse-browser-login-'));
 t.after(()=>rm(dir,{recursive:true,force:true}));
 const store=await openStore(join(dir,'accounts.json')),user=await store.create('writer','password');
 const origin='https://muse.test',server=createAccountServer({store,publicOrigin:origin,productionFees:options.desktopLoginOptions?.feeIssuers,...options});
 t.after(async()=>{server.closeAllConnections();await new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()));});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const base='http://127.0.0.1:'+server.address().port;
 const request=(path,{body,cookie,origin:requestOrigin=origin,method=body?'POST':'GET'}={})=>fetch(base+path,{method,redirect:'manual',headers:{origin:requestOrigin,...cookie?{cookie}:{}},body:body&&new URLSearchParams(body)});
 const start=async(fields={})=>{const response=await request('/api/desktop-login/start',{body:fields});assert.equal(response.status,200);return response.json();};
 const login=async fields=>{const response=await request('/login',{body:{username:'writer',password:'password',...fields}});assert.equal(response.status,303);return {cookie:response.headers.get('set-cookie').split(';')[0],response};};
 const approve=(a,cookie,decision='approve',fields={})=>request('/desktop-login',{cookie,body:{attempt:a.id,decision,...fields}});
 const check=(a,secret=a.secret,fields={})=>request('/api/desktop-login/check',{body:{id:a.id,secret,...fields}});
 return {store,user,start,login,approve,check,request};
}

test('browser login retains the Desktop continuation and issues an independent one-use local session',async t=>{
 const f=await fixture(t),a=await f.start();
 assert.equal(new URL(a.authorizeUrl).pathname,'/desktop-login');assert.ok(!a.authorizeUrl.includes(a.secret));
 const entry=await f.request('/desktop-login?attempt='+a.id),entryHtml=await entry.text();
 assert.match(entryHtml,/name="desktop_login"/);assert.ok(entryHtml.includes('/register?desktop_login='+a.id));assert.ok(!entryHtml.includes(a.secret));
 const {cookie,response}=await f.login({desktop_login:a.id});assert.equal(response.headers.get('location'),'/desktop-login?attempt='+a.id);
 const confirmation=await f.request(response.headers.get('location'),{cookie}),confirmationHtml=await confirmation.text();
 assert.ok(confirmationHtml.includes(a.code));assert.match(confirmationHtml,/writer/);assert.equal(confirmation.headers.get('cache-control'),'no-store');
 assert.equal((await (await f.check(a)).json()).state,'pending');
 assert.equal((await f.approve(a,cookie)).status,200);
 const issued=await f.check(a),localCookie=issued.headers.get('set-cookie').split(';')[0];
 assert.notEqual(localCookie,cookie);assert.deepEqual(await issued.json(),{state:'signed-in'});
 assert.equal((await f.check(a)).status,410);
 const identity=await f.request('/api/muse.account',{cookie:localCookie});assert.equal((await identity.json()).username,'writer');
 await f.request('/logout',{cookie,body:{}});
 assert.equal((await f.request('/api/muse.account',{cookie:localCookie})).status,200);
 await f.request('/logout',{cookie:localCookie,body:{}});
 assert.equal((await f.request('/api/muse.account',{cookie:localCookie})).status,303);
});

test('public enrollment capability preserves ordinary login without revealing account or key data',async t=>{
 const plain=await fixture(t),disabled=await plain.request('/api/desktop-login/capabilities');assert.equal(disabled.status,200);assert.deepEqual(await disabled.json(),{feeIssuerEnrollment:false});
 assert.equal((await plain.request('/api/desktop-login/capabilities',{body:{}})).status,405);
 assert.equal((await plain.request('/api/desktop-login/capabilities',{origin:'https://evil.test'})).status,403);
 const enabled=await fixture(t,{productionFees:{enroll:async()=>{throw Error('Capability must not enroll');}}}),response=await enabled.request('/api/desktop-login/capabilities');
 assert.equal(response.status,200);assert.deepEqual(await response.json(),{feeIssuerEnrollment:true});assert.equal(response.headers.get('cache-control'),'no-store');
});

test('approval requires the web session, same origin and the exact private redemption secret',async t=>{
 const f=await fixture(t),a=await f.start(),{cookie}=await f.login();
 assert.equal((await f.approve(a,undefined)).status,303);
 assert.equal((await f.request('/desktop-login',{cookie,origin:'https://evil.test',body:{attempt:a.id,decision:'approve'}})).status,403);
 assert.equal((await f.check(a,'x'.repeat(43))).status,410);
 assert.equal((await (await f.check(a)).json()).state,'pending');
 await f.approve(a,cookie);
 assert.equal((await f.request('/api/desktop-login/check',{origin:'https://evil.test',body:{id:a.id,secret:a.secret}})).status,403);
 assert.equal((await f.check(a)).status,200);
});

test('deny, local cancellation, expiry and account revision changes cannot become a local login',async t=>{
 let time=Date.now();const f=await fixture(t,{now:()=>time}),{cookie}=await f.login();
 const denied=await f.start();await f.approve(denied,cookie,'deny');assert.equal((await (await f.check(denied)).json()).state,'cancelled');
 const cancelled=await f.start();await f.request('/api/desktop-login/cancel',{body:{id:cancelled.id,secret:cancelled.secret}});assert.equal((await f.approve(cancelled,cookie)).status,410);assert.equal((await f.check(cancelled)).status,410);
 const expired=await f.start();time=expired.expiresAt;assert.equal((await f.check(expired)).status,410);
 const changed=await f.start();await f.approve(changed,cookie);await f.store.resetPassword(f.user.id,'replacement');assert.equal((await f.check(changed)).status,410);
});

test('concurrent redemption mints only one session and a web logout revokes unredeemed approval',async t=>{
 const f=await fixture(t),{cookie}=await f.login(),a=await f.start();await f.approve(a,cookie);
 const responses=await Promise.all([f.check(a),f.check(a)]);assert.deepEqual(responses.map(r=>r.status).sort(),[200,410]);
 const abandoned=await f.start();await f.approve(abandoned,cookie);await f.request('/logout',{cookie,body:{}});assert.equal((await f.check(abandoned)).status,410);
});

test('only active known attempts can redirect login and failed passwords preserve the continuation',async t=>{
 const f=await fixture(t),a=await f.start();
 const failed=await f.request('/login',{body:{username:'writer',password:'wrong',desktop_login:a.id}});assert.equal(failed.status,401);assert.ok((await failed.text()).includes('desktop_login='+a.id));
 const {response}=await f.login({desktop_login:'https://evil.test/'});assert.equal(response.headers.get('location'),'/');
 const invalid=await f.request('/login?desktop_login='+encodeURIComponent('https://evil.test/'));assert.ok(!(await invalid.text()).includes('name="desktop_login"'));
 const unknown=await f.request('/api/desktop-login/unknown',{body:{}});assert.equal(unknown.status,404);
});

test('a fee device needs explicit browser consent and its bound private-key proof before one enrollment',async t=>{
 const enrolled=[],d=device('<script>company laptop</script>'),f=await fixture(t,{desktopLoginOptions:{feeIssuers:{enroll:async(account,issuer)=>enrolled.push({account,issuer})}}}),a=await f.start({feeIssuer:JSON.stringify(d.issuer)}),{cookie}=await f.login();
 const confirmation=await f.request('/desktop-login?attempt='+a.id,{cookie}),content=await confirmation.text();
 assert.ok(content.includes(d.issuer.issuerId.match(/.{4}/g).join(' ')));assert.ok(content.includes('&lt;script&gt;company laptop&lt;/script&gt;'));
 assert.match(content,/name="fee_issuer_consent" value="approve" required/);assert.match(content,/每次付费仍需单独确认/);assert.ok(!content.includes(d.issuer.publicKey));assert.ok(!content.includes(a.secret));
 assert.equal((await f.approve(a,cookie)).status,400);assert.equal((await (await f.check(a)).json()).state,'pending');assert.equal(enrolled.length,0);
 assert.equal((await f.approve(a,cookie,'approve',{fee_issuer_consent:'approve'})).status,200);
 assert.equal((await f.check(a)).status,403);assert.equal((await f.check(a,a.secret,{enrollmentProof:device().proof(a)})).status,403);assert.equal(enrolled.length,0);
 const foreign=await f.start({feeIssuer:JSON.stringify(d.issuer)});
 assert.equal((await f.check(a,a.secret,{enrollmentProof:d.proof(foreign)})).status,403);
 const issued=await f.check(a,a.secret,{enrollmentProof:d.proof(a),feeIssuer:JSON.stringify(device().issuer)});
 assert.equal(issued.status,200);assert.deepEqual(await issued.json(),{state:'signed-in'});assert.ok(issued.headers.get('set-cookie'));
 assert.equal(enrolled.length,1);assert.equal(enrolled[0].account.id,f.user.id);assert.equal(enrolled[0].account.revision,1);assert.deepEqual(enrolled[0].issuer,d.issuer);
 assert.equal((await f.check(a,a.secret,{enrollmentProof:d.proof(a)})).status,410);
});

test('fee enrollment fails closed without authority or with malformed, substituted or non-Ed25519 public keys',async t=>{
 const d=device(),f=await fixture(t);
 const unavailable=await f.request('/api/desktop-login/start',{body:{feeIssuer:JSON.stringify(d.issuer)}});assert.equal(unavailable.status,503);assert.deepEqual(await unavailable.json(),{state:'fee-issuer-unavailable'});
 const ordinary=await f.start(),{cookie}=await f.login();await f.approve(ordinary,cookie);assert.equal((await f.check(ordinary)).status,200);
 const enabled=await fixture(t,{desktopLoginOptions:{feeIssuers:{enroll:async()=>{throw Error('Must not enroll malformed data');}}}}),rsa=generateKeyPairSync('rsa',{modulusLength:2048});
 const invalid=[{},null,{...d.issuer,issuerId:'a'.repeat(64)},{...d.issuer,publicKey:d.privateKey.export({type:'pkcs8',format:'pem'})},{...d.issuer,deviceName:'bad\nname'},{...d.issuer,publicKey:rsa.publicKey.export({type:'spki',format:'pem'})},{...d.issuer,approved:true}];
 for(const value of invalid){const reply=await enabled.request('/api/desktop-login/start',{body:{feeIssuer:JSON.stringify(value)}});assert.equal(reply.status,400);assert.deepEqual(await reply.json(),{state:'invalid-fee-issuer'});}
 const duplicate=await enabled.request('/api/desktop-login/start',{body:new URLSearchParams([['feeIssuer',JSON.stringify(d.issuer)],['feeIssuer',JSON.stringify(d.issuer)]])});assert.equal(duplicate.status,400);
});

test('concurrent signed redemption enrolls one device and account revocation during persistence issues no session',async t=>{
 let release,entered;const blocked=new Promise(resolve=>{release=resolve;}),began=new Promise(resolve=>{entered=resolve;});let calls=0;
 const d=device(),f=await fixture(t,{desktopLoginOptions:{feeIssuers:{enroll:async()=>{calls++;entered();await blocked;}}}}),{cookie}=await f.login(),a=await f.start({feeIssuer:JSON.stringify(d.issuer)});
 await f.approve(a,cookie,'approve',{fee_issuer_consent:'approve'});
 const first=f.check(a,a.secret,{enrollmentProof:d.proof(a)});await began;
 assert.equal((await f.check(a,a.secret,{enrollmentProof:d.proof(a)})).status,410);assert.equal(calls,1);
 await f.store.resetPassword(f.user.id,'replacement');release();const response=await first;assert.equal(response.status,410);assert.equal(response.headers.get('set-cookie'),null);
});

test('failed fee enrollment has a fixed unknown result and cannot mint or repeat a Desktop credential',async t=>{
 let calls=0;const d=device(),f=await fixture(t,{desktopLoginOptions:{feeIssuers:{enroll:async()=>{calls++;throw Error('PRIVATE PERSISTENCE DIAGNOSTIC');}}}}),a=await f.start({feeIssuer:JSON.stringify(d.issuer)}),{cookie}=await f.login();
 await f.approve(a,cookie,'approve',{fee_issuer_consent:'approve'});const response=await f.check(a,a.secret,{enrollmentProof:d.proof(a)});
 assert.equal(response.status,503);assert.deepEqual(await response.json(),{state:'fee-issuer-enrollment-unconfirmed'});assert.equal(response.headers.get('set-cookie'),null);
 assert.equal((await f.check(a,a.secret,{enrollmentProof:d.proof(a)})).status,410);assert.equal(calls,1);
});

test('Feishu consent forwards the frozen fingerprint and requires a browser checkbox before device approval',async()=>{
 const d=device();let shown,enrolled=0;
 const login=createDesktopLogin({publicOrigin:'https://muse.test',store:{},sessionStore:{},sessionTtlMs:600000,cookieName:'__Host-muse',session:()=>null,originOK:()=>true,rate:()=>true,form:async req=>new URLSearchParams(req.body),reply:(res,status,body)=>{res.status=status;res.body=body;},html:(res,status,body)=>{res.status=status;res.body=body;},page:(_title,body)=>body,loginPage:(_register,_id,consent)=>{shown=consent;return 'Sign in';},escape:value=>value,feeIssuers:{enroll:()=>{enrolled++;}},feishuEnabled:true});
 const response=()=>({headers:{},setHeader(name,value){this.headers[name]=value;}}),start=response();
 await login.handle({method:'POST',headers:{},body:new URLSearchParams({feeIssuer:JSON.stringify(d.issuer)})},start,'/api/desktop-login/start');const a=JSON.parse(start.body),landing=response();
 await login.handle({method:'GET',headers:{},url:'/desktop-login?attempt='+a.id},landing,'/desktop-login');
 assert.deepEqual(shown.feeIssuer,{issuerId:d.issuer.issuerId,deviceName:d.issuer.deviceName,fingerprint:d.issuer.issuerId.match(/.{4}/g).join(' ')});
 const request={headers:{cookie:landing.headers['set-cookie'].split(';')[0]}},fields=new URLSearchParams({desktop_login:a.id,desktop_intent:shown.intent});
 assert.equal(login.consumeFeishuConsent(request,fields),undefined);
 fields.set('fee_issuer_consent','approve');const consent=login.consumeFeishuConsent(request,fields);assert.ok(consent);assert.equal(enrolled,0);
 assert.equal(login.approveFeishuConsent(consent,{token:'browser-session',account:{revision:1}}),true);assert.equal(login.feishuConsentCurrent(consent),false);assert.equal(enrolled,0);
});

import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {openStore} from './store.mjs';
import {createAccountServer} from './gateway.mjs';

async function fixture(t,options={}){
 const dir=await mkdtemp(join(tmpdir(),'muse-browser-login-'));
 t.after(()=>rm(dir,{recursive:true,force:true}));
 const store=await openStore(join(dir,'accounts.json')),user=await store.create('writer','password');
 const origin='https://muse.test',server=createAccountServer({store,publicOrigin:origin,...options});
 t.after(async()=>{server.closeAllConnections();await new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()));});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const base='http://127.0.0.1:'+server.address().port;
 const request=(path,{body,cookie,origin:requestOrigin=origin,method=body?'POST':'GET'}={})=>fetch(base+path,{method,redirect:'manual',headers:{origin:requestOrigin,...cookie?{cookie}:{}},body:body&&new URLSearchParams(body)});
 const start=async()=>{const response=await request('/api/desktop-login/start',{body:{}});assert.equal(response.status,200);return response.json();};
 const login=async fields=>{const response=await request('/login',{body:{username:'writer',password:'password',...fields}});assert.equal(response.status,303);return {cookie:response.headers.get('set-cookie').split(';')[0],response};};
 const approve=(a,cookie,decision='approve')=>request('/desktop-login',{cookie,body:{attempt:a.id,decision}});
 const check=(a,secret=a.secret)=>request('/api/desktop-login/check',{body:{id:a.id,secret}});
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

/** Real login consent and account HTTP sessions protect fee metadata and issuer enrollment. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash,generateKeyPairSync,sign} from 'node:crypto';
import {openStore} from './store.mjs';
import {createAccountServer} from './gateway.mjs';
import {openProductionFees} from './production-fees.mjs';
const origin='https://muse.test';
async function fixture(t,{enabled=true,limit=120}={}){
 const home=await mkdtemp(join(tmpdir(),'muse-fee-http-'));let server,fees;
 t.after(async()=>{if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}fees?.close();await rm(home,{recursive:true,force:true,maxRetries:5,retryDelay:50});});
 const store=await openStore(join(home,'accounts.json')),alice=await store.create('writer','password'),bob=await store.create('other','password');
 if(enabled)fees=await openProductionFees({accounts:store,publicOrigin:origin,config:{version:1,databaseFile:join(home,'fees.sqlite'),challengeTtlMs:60000,maxPendingPerAccount:4,maxIssuersPerAccount:4,busyTimeoutMs:5000}});
 server=createAccountServer({store,productionFees:fees,productionFeeReadRatePerMinute:limit,publicOrigin:origin,workspaceMode:'desktop'});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base='http://127.0.0.1:'+server.address().port;
 const call=(path,{cookie,body,method=body?'POST':'GET',requestOrigin=origin}={})=>fetch(base+path,{method,redirect:'manual',headers:{origin:requestOrigin,...cookie?{cookie}:{}},body:body?new URLSearchParams(body):undefined});
 const login=async username=>{const response=await call('/login',{body:{username,password:'password'}});assert.equal(response.status,303);return response.headers.get('set-cookie').split(';')[0];};
 return {store,alice,bob,fees,call,login};
}
test('only explicit login consent and private-key possession enroll a device; public reads cannot approve a fee',async t=>{
 const f=await fixture(t),pair=generateKeyPairSync('ed25519'),publicKey=pair.publicKey.export({type:'spki',format:'pem'}),issuerId=createHash('sha256').update(pair.publicKey.export({type:'spki',format:'der'})).digest('hex');
 const cookie=await f.login('writer'),bobCookie=await f.login('other'),issuerPath='/api/muse/production-fees/issuers/'+issuerId;
 assert.equal((await f.call(issuerPath)).status,401);assert.deepEqual(await(await f.call(issuerPath,{cookie})).json(),{ready:false,issuer_id:issuerId});
 const start=await f.call('/api/desktop-login/start',{body:{feeIssuer:JSON.stringify({issuerId,publicKey,deviceName:'Company device'})}});assert.equal(start.status,200);const attempt=await start.json();
 const page=await(await f.call('/desktop-login?attempt='+attempt.id,{cookie})).text();assert.ok(page.includes('fee_issuer_consent'));assert.ok(page.includes('Company device'));assert.ok(!page.includes(attempt.secret));
 assert.equal((await f.call('/desktop-login',{cookie,body:{attempt:attempt.id,decision:'approve'}})).status,400);
 assert.equal((await f.call('/desktop-login',{cookie,body:{attempt:attempt.id,decision:'approve',fee_issuer_consent:'approve'}})).status,200);
 const signature=sign(null,Buffer.from('muse-fee-issuer-enroll-v1\n'+attempt.id+'\n'+attempt.secret),pair.privateKey).toString('base64url');
 assert.equal((await f.call('/api/desktop-login/check',{body:{id:attempt.id,secret:attempt.secret,enrollmentProof:signature}})).status,200);
 assert.equal((await(await f.call(issuerPath,{cookie})).json()).ready,true);assert.equal((await(await f.call(issuerPath,{cookie:bobCookie})).json()).ready,false);
 const input={provider:'jubian',issuer_id:issuerId,project_id:1,storyboard_id:2,database_id:'11111111-1111-4111-8111-111111111111',revision_id:'original',operation_id:'one-original-operation',request_sha256:'a'.repeat(64),quote_sha256:'b'.repeat(64),provider_connection_revision:'c'.repeat(64),currency:'CNY',amount_minor:200};
 const challenge=f.fees.createChallenge(f.alice.id,input),path='/api/muse/production-fees/challenges/'+challenge.id;
 const response=await f.call(path,{cookie});assert.deepEqual(await response.json(),challenge);assert.equal(response.headers.get('cache-control'),'no-store');
 assert.equal((await f.call(path,{cookie:bobCookie})).status,404);
 assert.equal((await f.call(path,{cookie,body:{decision:'approved'}})).status,405);
 assert.equal((await f.call(issuerPath,{cookie,body:{publicKey}})).status,405);
 assert.equal((await f.call(path,{cookie,requestOrigin:'https://foreign.test'})).status,403);
});
test('missing fee configuration and invalid limits fail explicitly without an enrollment write',async t=>{
 const f=await fixture(t,{enabled:false}),cookie=await f.login('writer');
 assert.equal((await f.call('/api/muse/production-fees/issuers/'+'f'.repeat(64),{cookie})).status,503);
 assert.throws(()=>createAccountServer({store:f.store,productionFeeReadRatePerMinute:0}),/fee metadata rate/);
});

import assert from 'node:assert/strict';
import {readFile,mkdtemp,rm,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {scheduleSessionExpiry} from './session-expiry.mjs';
import {createMemorySessionStore,DEFAULT_SESSION_TTL_MS,openSessionStore,resolveSessionFile,resolveSessionTtlMs} from './session-store.mjs';

async function fixture(t){const root=await mkdtemp(join(tmpdir(),'muse-sessions-'));t.after(()=>rm(root,{recursive:true,force:true}));return {root,file:join(root,'sessions.json')};}

test('durable session tokens are hashed at rest and survive reopening',async t=>{
 const {file}=await fixture(t),accountId='0123456789abcdef',expiry=Date.now()+60000;
 const first=await openSessionStore(file);const token=await first.issue({id:accountId,revision:3,expiry});
 const stored=await readFile(file,'utf8');assert.ok(!stored.includes(token));assert.match(stored,/"tokenHash":"[a-f0-9]{64}"/);
 if(process.platform!=='win32')assert.equal((await stat(file)).mode&0o077,0);
 const reopened=await openSessionStore(file);assert.deepEqual(reopened.get(token),{id:accountId,revision:3,expiry});
});

test('expired sessions are neither restored nor retained',async t=>{
 const {file}=await fixture(t);let clock=1000;const first=await openSessionStore(file,{now:()=>clock});const token=await first.issue({id:'0123456789abcdef',revision:1,expiry:2000});
 clock=2000;const reopened=await openSessionStore(file,{now:()=>clock});assert.equal(reopened.get(token),undefined);assert.equal(reopened.size(),0);assert.deepEqual(JSON.parse(await readFile(file,'utf8')).sessions,[]);
});

test('logout and account revocation remain effective after reopening',async t=>{
 const {file}=await fixture(t),sessions=await openSessionStore(file),expiry=Date.now()+60000;
 const loggedOut=await sessions.issue({id:'0123456789abcdef',revision:1,expiry});
 const reset=await sessions.issue({id:'0123456789abcdef',revision:1,expiry});
 const other=await sessions.issue({id:'fedcba9876543210',revision:1,expiry});
 assert.equal(await sessions.revoke(loggedOut),true);assert.equal(await sessions.revokeAccount('0123456789abcdef'),1);
 const reopened=await openSessionStore(file);assert.equal(reopened.get(loggedOut),undefined);assert.equal(reopened.get(reset),undefined);assert.deepEqual(reopened.get(other),{id:'fedcba9876543210',revision:1,expiry});
});

test('logout blocks in-memory lookup before its durable mutation completes',async()=>{
 const sessions=createMemorySessionStore(),expiry=Date.now()+60000,token=await sessions.issue({id:'0123456789abcdef',revision:1,expiry});
 const pending=sessions.revoke(token);assert.equal(sessions.get(token),undefined);assert.equal(await pending,true);
});

test('session deployment defaults stay bounded and old gateway configuration remains valid',async()=>{
 assert.equal(resolveSessionTtlMs({}),DEFAULT_SESSION_TTL_MS);assert.equal(DEFAULT_SESSION_TTL_MS,30*24*60*60*1000);
 assert.equal(resolveSessionTtlMs({MUSE_SESSION_TTL_MS:'86400000'}),86400000);
 for(const value of ['', '0','59999','7776000001','forever'])assert.throws(()=>resolveSessionTtlMs({MUSE_SESSION_TTL_MS:value}),/MUSE_SESSION_TTL_MS/);
 const accountFile=join(tmpdir(),'muse-private','accounts.json');assert.equal(resolveSessionFile(accountFile,undefined),join(tmpdir(),'muse-private','sessions.json'));
 assert.throws(()=>resolveSessionFile(accountFile,'sessions.json'),/absolute/);
});

test('long session expiry is scheduled in bounded timeout segments',()=>{
 let clock=0,expired=0,cleared;const scheduled=[];
 const setTimer=(callback,delay)=>{const timer={callback,delay,unref(){}};scheduled.push(timer);return timer;};
 const cancel=scheduleSessionExpiry(3000000000,()=>{expired++;},{now:()=>clock,setTimer,clearTimer:timer=>{cleared=timer;}});
 assert.equal(scheduled[0].delay,2147483647);clock=2147483647;scheduled[0].callback();assert.equal(scheduled[1].delay,852516353);assert.equal(expired,0);
 clock=3000000000;scheduled[1].callback();assert.equal(expired,1);cancel();assert.equal(cleared,scheduled[1]);
});

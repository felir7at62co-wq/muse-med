/** Real signatures and durable SQLite exercise fee identity without a supplier request. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,createHash,sign} from 'node:crypto';
import {chmod,mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir as systemTmpdir} from 'node:os';
import {realpathSync as realpathOfTmpdir} from 'node:fs';
// Private-directory checks compare real paths; the system temp directory can be reached through a link (macOS /var).
const tmpdir=()=>realpathOfTmpdir(systemTmpdir());
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {openProductionFees,productionAuthority,resolveProductionFeeConfig} from './production-fees.mjs';
const alice='a'.repeat(16),bob='b'.repeat(16),h=value=>createHash('sha256').update(value).digest('hex');
const subject={provider:'jubian',project_id:3,database_id:'11111111-1111-4111-8111-111111111111',storyboard_id:9,revision_id:'saved-revision',operation_id:'original-fee-operation',request_sha256:'c'.repeat(64),quote_sha256:'d'.repeat(64),provider_connection_revision:'e'.repeat(64),currency:'CNY',amount_minor:200};
function device(){const pair=generateKeyPairSync('ed25519'),publicKey=pair.publicKey.export({type:'spki',format:'pem'}),issuerId=h(pair.publicKey.export({type:'spki',format:'der'}));return {...pair,publicKey,issuerId,deviceName:'Muse test device'};}
function proof(key,c){return {challenge_id:c.id,issuer_id:key.issuerId,decision:'approved',signature:sign(null,Buffer.from('muse-production-fee-v1\n'+c.id+'\n'+c.nonce+'\n'+c.payload_sha256+'\napproved'),key.privateKey).toString('base64url')};}
async function fixture(t,extra={}){
 const home=await mkdtemp(join(tmpdir(),'muse-fee-authority-'));const owners=[];let fees;t.after(async()=>{for(const owner of owners)owner.close();await rm(home,{recursive:true,force:true,maxRetries:5,retryDelay:50});});
 let time=10000;const rows=new Map([[alice,{id:alice,revision:1,disabled:false}],[bob,{id:bob,revision:1,disabled:false}]]),accounts={get:id=>rows.get(id)},config={version:1,databaseFile:join(home,'fees.sqlite'),challengeTtlMs:60000,maxPendingPerAccount:4,busyTimeoutMs:5000,maxIssuersPerAccount:2,...extra};
 const open=async()=>{const owner=await openProductionFees({config,accounts,publicOrigin:'https://muse.example.test',now:()=>time});owners.push(owner);return owner;};fees=await open();
 return {home,fees,config,accounts,rows,open,advance:ms=>time+=ms};
}
test('a login-enrolled Ed25519 issuer signs only the exact current account, input and price',async t=>{
 const f=await fixture(t),key=device();assert.deepEqual(f.fees.issuerState(alice,key.issuerId),{ready:false,issuer_id:key.issuerId});
 assert.throws(()=>f.fees.createChallenge(alice,{...subject,issuer_id:key.issuerId}),{code:'production_fee_enrollment_required'});
 f.fees.enroll(f.rows.get(alice),key);const c=f.fees.createChallenge(alice,{...subject,issuer_id:key.issuerId,review:{model:'model-a',duration:5}}),p=proof(key,c);
 assert.equal(c.payload_sha256,h(c.payload));assert.equal(JSON.parse(c.payload).audience,'https://muse.example.test');
 assert.equal(f.fees.verify(alice,p,subject).grant_id,c.id);
 for(const change of [{project_id:4},{storyboard_id:4},{revision_id:'other'},{amount_minor:201},{quote_sha256:'b'.repeat(64)},{provider_connection_revision:'f'.repeat(64)}])assert.throws(()=>f.fees.verify(alice,p,{...subject,...change}),{code:'production_fee_grant_changed'});
 assert.throws(()=>f.fees.verify(bob,p,subject),{code:'production_fee_challenge_missing'});
 assert.throws(()=>f.fees.verify(alice,{...p,approved:true},subject),{code:'production_fee_invalid_proof'});
 assert.throws(()=>f.fees.verify(alice,{...p,signature:proof(device(),c).signature},subject),{code:'production_fee_invalid_proof'});
 assert.equal(f.fees.createChallenge(alice,{...subject,issuer_id:key.issuerId}).id,c.id);
});
test('expiry, revocation and account changes invalidate the grant while old records remain intact',async t=>{
 const f=await fixture(t),key=device();f.fees.enroll(f.rows.get(alice),key);const c=f.fees.createChallenge(alice,{...subject,issuer_id:key.issuerId}),p=proof(key,c);
 f.fees.close();const restored=await f.open();assert.deepEqual(restored.challenge(alice,c.id),c);
 f.rows.get(alice).disabled=true;assert.throws(()=>restored.verify(alice,p,subject),{code:'production_fee_account_forbidden'});f.rows.get(alice).disabled=false;
 f.rows.get(alice).revision=2;assert.throws(()=>restored.verify(alice,p,subject),{code:'production_fee_enrollment_required'});
 restored.enroll(f.rows.get(alice),key);assert.throws(()=>restored.verify(alice,p,subject),{code:'production_fee_grant_changed'});
 f.advance(60000);assert.throws(()=>restored.challenge(alice,c.id),{code:'production_fee_challenge_expired'});
 const db=new DatabaseSync(f.config.databaseFile);try{assert.equal(db.prepare('SELECT COUNT(*) AS count FROM muse_fee_challenges').get().count,1);}finally{db.close();}
});
test('each account consents to a device separately and bounds never fabricate approval',async t=>{
 const f=await fixture(t,{maxPendingPerAccount:1,maxIssuersPerAccount:1}),key=device();
 f.fees.enroll(f.rows.get(alice),key);assert.equal(f.fees.issuerState(bob,key.issuerId).ready,false);f.fees.enroll(f.rows.get(bob),key);assert.equal(f.fees.issuerState(bob,key.issuerId).ready,true);
 assert.throws(()=>f.fees.enroll(f.rows.get(alice),device()),{code:'production_fee_issuer_limit'});
 f.fees.createChallenge(alice,{...subject,issuer_id:key.issuerId});assert.throws(()=>f.fees.createChallenge(alice,{...subject,operation_id:'another-operation',issuer_id:key.issuerId}),{code:'production_fee_challenge_limit'});
 assert.throws(()=>resolveProductionFeeConfig({...f.config,challengeTtlMs:0}),{code:'production_fee_invalid_configuration'});
 assert.throws(()=>f.fees.createChallenge(alice,{...subject,currency:'LTV',issuer_id:key.issuerId}),{code:'production_fee_invalid_request'});
});
test('private authority callbacks refuse a missing issuer service and preserve company actor ownership',()=>{
 const calls=[],company={request:(actor,value)=>{calls.push({actor,value});return {allowed:false};}};
 assert.equal(productionAuthority({}),undefined);const service=productionAuthority({company});
 assert.deepEqual(service.request(alice,{type:'capabilities'}),{nativeApprovalAvailable:false,companyAdmissionAvailable:true});
 assert.throws(()=>service.request(alice,{type:'challenge'}),{code:'production_fee_unavailable'});
 service.request(alice,{...subject,type:'quote'});assert.equal(calls[0].actor,alice);
});
test('an unrelated database is refused without changing its journal mode or rows',async t=>{
 const home=await mkdtemp(join(tmpdir(),'muse-fee-unrelated-'));t.after(()=>rm(home,{recursive:true,force:true,maxRetries:5,retryDelay:50}));
 const file=join(home,'data.sqlite'),db=new DatabaseSync(file);db.exec('CREATE TABLE projects(id INTEGER);INSERT INTO projects VALUES(7)');db.close();
 await chmod(file,0o600);
 const config={version:1,databaseFile:file,challengeTtlMs:60000,maxPendingPerAccount:4,busyTimeoutMs:5000,maxIssuersPerAccount:2};
 await assert.rejects(openProductionFees({config,accounts:{get(){}},publicOrigin:'https://muse.example.test'}),{code:'production_fee_unrelated_database'});
 const read=new DatabaseSync(file);try{assert.equal(read.prepare('PRAGMA journal_mode').get().journal_mode,'delete');assert.equal(read.prepare('SELECT id FROM projects').get().id,7);}finally{read.close();}
});

/** Real login-enrolled keys and durable challenges authorize no supplier request. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,generateKeyPairSync,sign} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir as systemTmpdir} from 'node:os';
import {realpathSync as realpathOfTmpdir} from 'node:fs';
// Private-directory checks compare real paths; the system temp directory can be reached through a link (macOS /var).
const tmpdir=()=>realpathOfTmpdir(systemTmpdir());
import {join,resolve,sep} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {openProductionFees} from './production-fees.mjs';
import {nativeJubianFrozen,nativeJubianObservationFrozen,nativeJubianBudgetFrozen} from './native-jubian-approvals.mjs';

const alice='a'.repeat(16),bob='b'.repeat(16),hash=value=>createHash('sha256').update(value).digest('hex');
const context={accountId:alice,sessionId:'f'.repeat(64),deviceId:null};
const canonical={provider:'jubian',company_id:'company',provider_origin:'https://web.jubianai.net',script_id:6613,
 operation_id:'native-original-001',method:'storyboard_native_submit',request_sha256:'a'.repeat(64),quote_sha256:'b'.repeat(64),
 provider_connection_revision:'c'.repeat(64),currency:'CNY',amount_minor:0,resources:[{kind:'card',id:4}],policy_revision:1,
 account_id:alice,login_session_id:context.sessionId,device_id:null};
function device(){
 const keys=generateKeyPairSync('ed25519');
 return {...keys,publicKey:keys.publicKey.export({type:'spki',format:'pem'}),issuerId:hash(keys.publicKey.export({type:'spki',format:'der'})),deviceName:'Native test Host'};
}
function proof(key,challenge,prefix='muse-native-jubian-fee-v2'){
 const message=prefix+'\n'+challenge.id+'\n'+challenge.nonce+'\n'+challenge.payload_sha256+'\napproved';
 return {challenge_id:challenge.id,issuer_id:key.issuerId,decision:'approved',signature:sign(null,Buffer.from(message),key.privateKey).toString('base64url')};
}
async function fixture(t,limits={}){
 const root=await mkdtemp(join(tmpdir(),'muse-native-approval-')),owners=[];
 t.after(async()=>{
  for(const owner of owners)owner.close();
  const target=resolve(root),parent=resolve(tmpdir());
  assert.ok(target.startsWith(parent+sep)&&target!==parent);
  await rm(target,{recursive:true,force:true,maxRetries:5,retryDelay:50});
 });
 const rows=new Map([[alice,{id:alice,revision:1,disabled:false}],[bob,{id:bob,revision:1,disabled:false}]]);
 let time=10000;
 const config={version:1,databaseFile:join(root,'fees.sqlite'),challengeTtlMs:60000,maxPendingPerAccount:8,busyTimeoutMs:5000,maxIssuersPerAccount:3,...limits};
 const open=async()=>{
  const value=await openProductionFees({config,accounts:{get:id=>rows.get(id)},publicOrigin:'https://muse.example.test',now:()=>time});
  owners.push(value);return value;
 };
 const fees=await open(),key=device();fees.enroll(rows.get(alice),key);
 return {fees,key,rows,config,open,advance:ms=>{time+=ms;}};
}

test('native actions use the login-enrolled issuer and cover an exact zero-price paid quote',async t=>{
 const f=await fixture(t),challenge=f.fees.createNativeJubianChallenge(alice,canonical,f.key.issuerId,{model:'model-a'});
 const value=JSON.parse(challenge.payload);
 assert.equal(value.version,2);assert.equal(value.action,'native-jubian');assert.equal(value.amount_minor,0);
 assert.equal(value.audience,'https://muse.example.test');assert.equal(challenge.payload_sha256,hash(challenge.payload));
 assert.deepEqual(f.fees.nativeJubianChallenge(context,challenge.id),challenge);
 assert.deepEqual(f.fees.verifyNativeJubian(context,proof(f.key,challenge),canonical),
  {grant_id:challenge.id,issuer_id:f.key.issuerId,expires_at:challenge.expires_at});
 assert.equal(f.fees.createNativeJubianChallenge(alice,canonical,f.key.issuerId).id,challenge.id);
 assert.throws(()=>f.fees.verifyNativeJubian(context,proof(f.key,challenge,'muse-production-fee-v1'),canonical),{code:'production_fee_invalid_proof'});
});

test('changing a resource, quote, token fingerprint, policy, operation or actor invalidates the exact grant',async t=>{
 const f=await fixture(t),challenge=f.fees.createNativeJubianChallenge(alice,canonical,f.key.issuerId),approved=proof(f.key,challenge);
 for(const edit of [{script_id:6614},{amount_minor:1},{policy_revision:2},{operation_id:'another-operation'},
  {resources:[{kind:'asset',id:4}]},{provider_connection_revision:'d'.repeat(64)},{quote_sha256:'d'.repeat(64)},
  {request_sha256:'d'.repeat(64)},{company_id:'another-company'},{method:'video_upscale'}]){
  assert.throws(()=>f.fees.verifyNativeJubian(context,approved,{...canonical,...edit}),{code:'native_jubian_grant_changed'});
 }
 for(const edit of [{sessionId:'e'.repeat(64)},{deviceId:'another-device'}]){
  assert.throws(()=>f.fees.nativeJubianChallenge({...context,...edit},challenge.id),{code:'native_jubian_grant_changed'});
 }
 assert.throws(()=>f.fees.nativeJubianChallenge({...context,accountId:bob},challenge.id),{code:'production_fee_challenge_missing'});
});

test('old and native actions remain separate and original rows survive a restart',async t=>{
 const f=await fixture(t);
 const legacy={provider:'jubian',project_id:3,database_id:'11111111-1111-4111-8111-111111111111',storyboard_id:9,
  revision_id:'revision',operation_id:'old-operation',request_sha256:'c'.repeat(64),quote_sha256:'d'.repeat(64),
  provider_connection_revision:'e'.repeat(64),currency:'CNY',amount_minor:200};
 const old=f.fees.createChallenge(alice,{...legacy,issuer_id:f.key.issuerId});
 const native=f.fees.createNativeJubianChallenge(alice,canonical,f.key.issuerId);
 assert.throws(()=>f.fees.challenge(alice,native.id),{code:'production_fee_challenge_missing'});
 assert.throws(()=>f.fees.nativeJubianChallenge(context,old.id),{code:'native_jubian_grant_changed'});
 assert.throws(()=>f.fees.verify(alice,proof(f.key,native),legacy),{code:'production_fee_grant_changed'});
 f.fees.close();const restored=await f.open();
 assert.deepEqual(restored.challenge(alice,old.id),old);assert.deepEqual(restored.nativeJubianChallenge(context,native.id),native);
 assert.equal(restored.verifyNativeJubian(context,proof(f.key,native),canonical).grant_id,native.id);
 const db=new DatabaseSync(f.config.databaseFile);
 try{assert.equal(db.prepare('SELECT COUNT(*) AS count FROM muse_fee_challenges').get().count,2);
  assert.equal(db.prepare('SELECT version FROM muse_fee_schema').get().version,1);}finally{db.close();}
});

test('model booleans, proof extras, forged signatures and malformed canonical values are refused',async t=>{
 const f=await fixture(t),challenge=f.fees.createNativeJubianChallenge(alice,canonical,f.key.issuerId),approved=proof(f.key,challenge);
 assert.throws(()=>f.fees.verifyNativeJubian(context,{...approved,approved:true},canonical),{code:'production_fee_invalid_proof'});
 assert.throws(()=>f.fees.verifyNativeJubian(context,{decision:'approved'},canonical),{code:'production_fee_invalid_proof'});
 assert.throws(()=>f.fees.verifyNativeJubian(context,{...approved,signature:proof(device(),challenge).signature},canonical),{code:'production_fee_invalid_proof'});
 for(const edit of [{token:'secret'},{resources:[{kind:'card',id:4},{kind:'card',id:4}]},{currency:'credits'},
  {amount_minor:-1},{provider_origin:'http://supplier.invalid'},{login_session_id:'untrusted'},
  {resources:[{kind:'card',id:4,body:{}}]}]){
  assert.throws(()=>nativeJubianFrozen({...canonical,...edit}),{code:'native_jubian_invalid_challenge'});
 }
 assert.throws(()=>f.fees.createNativeJubianChallenge(bob,canonical,f.key.issuerId),{code:'production_fee_enrollment_required'});
});

test('expiry, revocation and account revision changes stop approval without replacing history',async t=>{
 const f=await fixture(t),challenge=f.fees.createNativeJubianChallenge(alice,canonical,f.key.issuerId),approved=proof(f.key,challenge);
 f.rows.get(alice).disabled=true;
 assert.throws(()=>f.fees.verifyNativeJubian(context,approved,canonical),{code:'production_fee_account_forbidden'});
 f.rows.get(alice).disabled=false;f.rows.get(alice).revision=2;
 assert.throws(()=>f.fees.verifyNativeJubian(context,approved,canonical),{code:'production_fee_enrollment_required'});
 f.fees.enroll(f.rows.get(alice),f.key);
 assert.throws(()=>f.fees.verifyNativeJubian(context,approved,canonical),{code:'native_jubian_grant_changed'});
 f.advance(60000);
 assert.throws(()=>f.fees.nativeJubianChallenge(context,challenge.id),{code:'production_fee_challenge_expired'});
});

test('pending bounds apply to the shared enrolled account rather than fabricating permission',async t=>{
 const f=await fixture(t,{maxPendingPerAccount:1});
 f.fees.createNativeJubianChallenge(alice,canonical,f.key.issuerId);
 assert.throws(()=>f.fees.createNativeJubianChallenge(alice,{...canonical,operation_id:'new-operation'},f.key.issuerId),{code:'production_fee_challenge_limit'});
});

test('postproduction can bind its actual source task rather than inventing a storyboard',async t=>{
 const f=await fixture(t),post={...canonical,operation_id:'upscale-source-task',method:'video_upscale',resources:[{kind:'task',id:57}]};
 const challenge=f.fees.createNativeJubianChallenge(alice,post,f.key.issuerId);
 assert.equal(f.fees.verifyNativeJubian(context,proof(f.key,challenge),post).grant_id,challenge.id);
 assert.throws(()=>f.fees.verifyNativeJubian(context,proof(f.key,challenge),{...post,resources:[{kind:'card',id:57}]}),{code:'native_jubian_grant_changed'});
});

test('a terminal observation has its own exact action and cannot use a spending signature',async t=>{
 const f=await fixture(t),observed={...canonical,admission_id:'11111111-1111-4111-8111-111111111111',
  attempt_id:'actual-attempt',state:'completed',observation_sha256:'d'.repeat(64),operation_actor_id:alice,current_policy_revision:2};
 const challenge=f.fees.createNativeJubianObservationChallenge(alice,observed,f.key.issuerId),approved=proof(f.key,challenge,'muse-native-jubian-observation-v1');
 assert.equal(JSON.parse(challenge.payload).action,'native-jubian-observation');
 assert.deepEqual(f.fees.nativeJubianObservation(context,challenge.id),challenge);
 assert.equal(f.fees.verifyNativeJubianObservation(context,approved,observed).grant_id,challenge.id);
 assert.throws(()=>f.fees.challenge(alice,challenge.id),{code:'production_fee_challenge_missing'});
 assert.throws(()=>f.fees.nativeJubianChallenge(context,challenge.id),{code:'native_jubian_grant_changed'});
 assert.throws(()=>f.fees.verifyNativeJubianObservation(context,proof(f.key,challenge),observed),{code:'production_fee_invalid_proof'});
 const fee=f.fees.createNativeJubianChallenge(alice,canonical,f.key.issuerId);
 assert.throws(()=>f.fees.nativeJubianObservation(context,fee.id),{code:'native_jubian_grant_changed'});
 assert.throws(()=>f.fees.verifyNativeJubianObservation(context,proof(f.key,fee),observed),{code:'native_jubian_grant_changed'});
 for(const edit of [{state:'failed'},{observation_sha256:'e'.repeat(64)},{attempt_id:'different-attempt'},
  {admission_id:'22222222-2222-4222-8222-222222222222'},{operation_actor_id:bob},{current_policy_revision:3}]){
  assert.throws(()=>f.fees.verifyNativeJubianObservation(context,approved,{...observed,...edit}),{code:'native_jubian_grant_changed'});
 }
});

test('observation validation preserves the original policy and rejects missing or extraneous fields',()=>{
 const observed={...canonical,admission_id:'11111111-1111-4111-8111-111111111111',
  attempt_id:'actual-attempt',state:'completed',observation_sha256:'d'.repeat(64),operation_actor_id:alice,current_policy_revision:2};
 const parsed=nativeJubianObservationFrozen(observed);
 assert.equal(parsed.policy_revision,1);assert.equal(parsed.current_policy_revision,2);
 for(const edit of [{approved:true},{state:'unknown'},{observation_sha256:'unverified'},
  {operation_actor_id:null},{current_policy_revision:0},{admission_id:'caller-invented'}]){
  assert.throws(()=>nativeJubianObservationFrozen({...observed,...edit}),{code:'native_jubian_invalid_challenge'});
 }
});

test('allowance signatures cover old/new CNY limits and never act as generation or observation grants',async t=>{
 const f=await fixture(t),budget={provider:'jubian',account_id:alice,login_session_id:context.sessionId,device_id:null,
  company_id:'company',change_id:'raise-project-original',target:{kind:'project',provider_origin:'https://web.jubianai.net',script_id:6613},
  currency:'CNY',previous_limit_minor:100,new_limit_minor:200,target_revision:0,base_policy_revision:1};
 const challenge=f.fees.createNativeJubianBudgetChallenge(alice,budget,f.key.issuerId),approved=proof(f.key,challenge,'muse-native-jubian-budget-v1');
 assert.equal(JSON.parse(challenge.payload).action,'native-jubian-budget');
 assert.deepEqual(f.fees.nativeJubianBudget(context,challenge.id),challenge);
 assert.equal(f.fees.verifyNativeJubianBudget(context,approved,budget).grant_id,challenge.id);
 assert.throws(()=>f.fees.challenge(alice,challenge.id),{code:'production_fee_challenge_missing'});
 assert.throws(()=>f.fees.nativeJubianChallenge(context,challenge.id),{code:'native_jubian_grant_changed'});
 assert.throws(()=>f.fees.nativeJubianObservation(context,challenge.id),{code:'native_jubian_grant_changed'});
 assert.throws(()=>f.fees.verifyNativeJubianBudget(context,proof(f.key,challenge),budget),{code:'production_fee_invalid_proof'});
 for(const edit of [{target:{kind:'company'}},{new_limit_minor:201},{previous_limit_minor:99},
  {target_revision:1},{base_policy_revision:2},{change_id:'different-change'}]){
  assert.throws(()=>f.fees.verifyNativeJubianBudget(context,approved,{...budget,...edit}),{code:'native_jubian_grant_changed'});
 }
 for(const edit of [{currency:'credits'},{target_revision:-1},{new_limit_minor:-1},{approved:true}]){
  assert.throws(()=>nativeJubianBudgetFrozen({...budget,...edit}),{code:'native_jubian_invalid_challenge'});
 }
 const fee=f.fees.createNativeJubianChallenge(alice,canonical,f.key.issuerId);
 assert.throws(()=>f.fees.verifyNativeJubianBudget(context,proof(f.key,fee),budget),{code:'native_jubian_grant_changed'});
});

test('a new image can bind an explicit logical draft without pretending it is a supplier asset ID',async t=>{
 const f=await fixture(t),image={...canonical,method:'image_generate',resources:[{kind:'draft_asset',id:'0'.repeat(64)}]};
 const challenge=f.fees.createNativeJubianChallenge(alice,image,f.key.issuerId);
 assert.equal(f.fees.verifyNativeJubian(context,proof(f.key,challenge),image).grant_id,challenge.id);
 assert.throws(()=>f.fees.verifyNativeJubian(context,proof(f.key,challenge),{...image,resources:[{kind:'draft_asset',id:'1'.repeat(64)}]}),{code:'native_jubian_grant_changed'});
 for(const edit of [{method:'video_upscale'},{resources:[{kind:'draft_asset',id:0}]},
  {resources:[{kind:'asset',id:'0'.repeat(64)}]},{resources:[{kind:'draft_asset',id:'invented-asset'}]},
  {resources:[{kind:'draft_asset',id:'0'.repeat(64)},{kind:'asset',id:4}]}]){
  assert.throws(()=>nativeJubianFrozen({...image,...edit}),{code:'native_jubian_invalid_challenge'});
 }
});

test('audio import observations sign their exact object or draft identity and cannot authorize generation',async t=>{
 const f=await fixture(t);
 for(const [method,kind]of [['audio_reference_upload','storage_object'],['audio_asset_register','draft_asset']]){
  const free={...canonical,operation_id:'free-'+method,method,amount_minor:0,resources:[{kind,id:'0'.repeat(64)}]},
   observed={...free,admission_id:'11111111-1111-4111-8111-111111111111',attempt_id:'original-'+method,
    state:'completed',observation_sha256:hash(method),operation_actor_id:alice,current_policy_revision:1};
  const challenge=f.fees.createNativeJubianObservationChallenge(alice,observed,f.key.issuerId),
   signature=proof(f.key,challenge,'muse-native-jubian-observation-v1');
  assert.equal(f.fees.verifyNativeJubianObservation(context,signature,observed).grant_id,challenge.id);
  assert.throws(()=>f.fees.verifyNativeJubianObservation(context,signature,{...observed,resources:[{kind,id:'1'.repeat(64)}]}),
   {code:'native_jubian_grant_changed'});
  assert.throws(()=>f.fees.verifyNativeJubianObservation(context,signature,{...observed,request_sha256:'2'.repeat(64)}),
   {code:'native_jubian_grant_changed'});
  assert.throws(()=>nativeJubianFrozen({...free,amount_minor:1}),{code:'native_jubian_invalid_challenge'});
  assert.throws(()=>nativeJubianFrozen({...free,method:'video_upscale'}),{code:'native_jubian_invalid_challenge'});
  assert.throws(()=>nativeJubianFrozen({...free,resources:[{kind:'asset',id:7}]}),{code:'native_jubian_invalid_challenge'});
  const fee=f.fees.createNativeJubianChallenge(alice,free,f.key.issuerId);
  assert.throws(()=>f.fees.verifyNativeJubianObservation(context,proof(f.key,fee),observed),{code:'native_jubian_grant_changed'});
 }
});

test('an audio fee signature binds the audio method, exact quote and new voice identity independently of image and observation proofs',async t=>{
 const f=await fixture(t),audio={...canonical,operation_id:'native-voice-001',method:'audio_generate',amount_minor:100,
  resources:[{kind:'draft_asset',id:'4'.repeat(64)}]},challenge=f.fees.createNativeJubianChallenge(alice,audio,f.key.issuerId),approved=proof(f.key,challenge);
 assert.equal(f.fees.verifyNativeJubian(context,approved,audio).grant_id,challenge.id);
 for(const edit of [{method:'image_generate'},{amount_minor:0},{quote_sha256:'9'.repeat(64)},
  {resources:[{kind:'draft_asset',id:'5'.repeat(64)}]},{resources:[{kind:'asset',id:84}]}]){
  assert.throws(()=>f.fees.verifyNativeJubian(context,approved,{...audio,...edit}),{code:'native_jubian_grant_changed'});
 }
 for(const resources of [[{kind:'draft_asset',id:4}],[{kind:'draft_asset',id:'not-a-hash'}],
  [{kind:'draft_asset',id:'4'.repeat(64)},{kind:'asset',id:84}]]){
  assert.throws(()=>nativeJubianFrozen({...audio,resources}),{code:'native_jubian_invalid_challenge'});
 }
 const observed={...audio,admission_id:'11111111-1111-4111-8111-111111111111',attempt_id:'voice-original',
  state:'completed',observation_sha256:'d'.repeat(64),operation_actor_id:alice,current_policy_revision:1};
 const result=f.fees.createNativeJubianObservationChallenge(alice,observed,f.key.issuerId);
 assert.equal(f.fees.verifyNativeJubianObservation(context,proof(f.key,result,'muse-native-jubian-observation-v1'),observed).grant_id,result.id);
 assert.throws(()=>f.fees.verifyNativeJubianObservation(context,approved,observed),{code:'native_jubian_grant_changed'});
});

const sourceScope={version:1,provider:'jubian',purpose:'source_scope',account_id:alice,login_session_id:context.sessionId,device_id:null,
 source_actor_id:alice,company_id:'company',provider_origin:'https://web.jubianai.net',provider_connection_revision:'c'.repeat(64),
 namespace:'company-source',source_policy_revision:1,base_policy_revision:1,operation_id:'word-original-operation',method:'manuscript_submit',
 source:{kind:'word_pair',manuscript:{sha256:'1'.repeat(64),bytes:1200,name_sha256:'2'.repeat(64)},
  original:{sha256:'3'.repeat(64),bytes:800,name_sha256:'4'.repeat(64)},declarations_sha256:'5'.repeat(64),catalogue_sha256:'6'.repeat(64)},
 plan_sha256:'7'.repeat(64),effect:null,observation:null};
const sourceEffect={...sourceScope,purpose:'source_effect',effect:{effect_key:'8'.repeat(64),kind:'upload_manuscript',
 request_sha256:'9'.repeat(64),destination:{object_key:'prod/sys-material-video/2026/11/17/'+'a'.repeat(32)+'.docx',sha256:'1'.repeat(64),bytes:1200}}};
const sourceObserved={...sourceEffect,purpose:'source_observation',observation:{receipt:{kind:'upload',role:'manuscript',
 ...sourceEffect.effect.destination}}};

test('Word rights and managed source assertions use separate signed actions and preserve their nested canonical version',async t=>{
 const f=await fixture(t),consent=f.fees.createNativeJubianSourceConsentChallenge(alice,sourceScope,f.key.issuerId),
  managed=f.fees.createNativeJubianSourceManagedChallenge(alice,sourceScope,f.key.issuerId);
 const payload=JSON.parse(consent.payload);
 assert.equal(payload.version,2);assert.equal(payload.canonical.version,1);
 assert.equal(payload.action,'native-jubian-source-consent');assert.deepEqual(payload.canonical,sourceScope);
 const rights=proof(f.key,consent,'muse-native-jubian-source-consent-v1'),attestation=proof(f.key,managed,'muse-native-jubian-source-managed-v1');
 assert.equal(f.fees.verifyNativeJubianSourceConsent(context,rights,sourceScope).grant_id,consent.id);
 assert.equal(f.fees.verifyNativeJubianSourceManaged(context,attestation,sourceScope).grant_id,managed.id);
 assert.throws(()=>f.fees.verifyNativeJubianSourceManaged(context,rights,sourceScope),{code:'native_jubian_grant_changed'});
 assert.throws(()=>f.fees.verifyNativeJubianSourceConsent(context,attestation,sourceScope),{code:'native_jubian_grant_changed'});
 assert.throws(()=>f.fees.nativeJubianChallenge(context,consent.id),{code:'native_jubian_grant_changed'});
 assert.throws(()=>f.fees.challenge(alice,managed.id),{code:'production_fee_challenge_missing'});
 assert.throws(()=>f.fees.verifyNativeJubianSourceManaged(context,proof(f.key,managed),sourceScope),{code:'production_fee_invalid_proof'});
 assert.throws(()=>f.fees.createNativeJubianSourceConsentChallenge(alice,sourceEffect,f.key.issuerId));
});

test('a source assertion binds original files, declarations, namespace and current identity without a fake project ID',async t=>{
 const f=await fixture(t),challenge=f.fees.createNativeJubianSourceConsentChallenge(alice,sourceScope,f.key.issuerId),
  approved=proof(f.key,challenge,'muse-native-jubian-source-consent-v1');
 for(const edit of [{namespace:'another-company-namespace'},{source_policy_revision:2},{base_policy_revision:2},{operation_id:'word-another-operation'},
  {plan_sha256:'0'.repeat(64)},{source:{...sourceScope.source,declarations_sha256:'0'.repeat(64)}},
  {source:{...sourceScope.source,manuscript:{...sourceScope.source.manuscript,bytes:1201}}},
  {provider_connection_revision:'0'.repeat(64)},{source_actor_id:bob}]){
  assert.throws(()=>f.fees.verifyNativeJubianSourceConsent(context,approved,{...sourceScope,...edit}),{code:'native_jubian_grant_changed'});
 }
 assert.throws(()=>f.fees.createNativeJubianSourceManagedChallenge(alice,{...sourceScope,script_id:1},f.key.issuerId));
 assert.throws(()=>f.fees.nativeJubianSourceConsent({...context,sessionId:'e'.repeat(64)},challenge.id),{code:'native_jubian_grant_changed'});
 assert.throws(()=>f.fees.verifyNativeJubianSourceConsent(context,{...approved,user_approved:true},sourceScope),{code:'production_fee_invalid_proof'});
 assert.throws(()=>f.fees.verifyNativeJubianSourceConsent(context,{...approved,
  signature:proof(device(),challenge,'muse-native-jubian-source-consent-v1').signature},sourceScope),{code:'production_fee_invalid_proof'});
});

test('source effect and readback assertions cannot replace one another or change an uploaded object',async t=>{
 const f=await fixture(t),effect=f.fees.createNativeJubianSourceManagedChallenge(alice,sourceEffect,f.key.issuerId),
  observed=f.fees.createNativeJubianSourceManagedChallenge(alice,sourceObserved,f.key.issuerId),
  effectProof=proof(f.key,effect,'muse-native-jubian-source-managed-v1'),readbackProof=proof(f.key,observed,'muse-native-jubian-source-managed-v1');
 assert.equal(f.fees.verifyNativeJubianSourceManaged(context,effectProof,sourceEffect).grant_id,effect.id);
 assert.equal(f.fees.verifyNativeJubianSourceManaged(context,readbackProof,sourceObserved).grant_id,observed.id);
 assert.throws(()=>f.fees.verifyNativeJubianSourceManaged(context,effectProof,sourceObserved),{code:'native_jubian_grant_changed'});
 assert.throws(()=>f.fees.verifyNativeJubianSourceManaged(context,readbackProof,sourceEffect),{code:'native_jubian_grant_changed'});
 assert.throws(()=>f.fees.verifyNativeJubianSourceManaged(context,effectProof,{...sourceEffect,
  effect:{...sourceEffect.effect,request_sha256:'0'.repeat(64)}}),{code:'native_jubian_grant_changed'});
 for(const edit of [{observation:{receipt:{...sourceObserved.observation.receipt,bytes:1201}}},
  {observation:{receipt:{...sourceObserved.observation.receipt,role:'original'}}},
  {effect:{...sourceEffect.effect,destination:{...sourceEffect.effect.destination,object_key:'foreign.docx'}}}]){
  assert.throws(()=>f.fees.createNativeJubianSourceManagedChallenge(alice,{...sourceObserved,...edit},f.key.issuerId));
 }
});

test('source challenges survive restart while manual project creation never accepts Word rights',async t=>{
 const f=await fixture(t),manual={...sourceScope,method:'manual_project_create',source:{kind:'existing_manuscript',manuscript_id:45}},
  challenge=f.fees.createNativeJubianSourceManagedChallenge(alice,manual,f.key.issuerId),
  approved=proof(f.key,challenge,'muse-native-jubian-source-managed-v1');
 assert.throws(()=>f.fees.createNativeJubianSourceConsentChallenge(alice,manual,f.key.issuerId));
 f.fees.close();const restored=await f.open();
 assert.deepEqual(restored.nativeJubianSourceManaged(context,challenge.id),challenge);
 assert.equal(restored.verifyNativeJubianSourceManaged(context,approved,manual).grant_id,challenge.id);
 const db=new DatabaseSync(f.config.databaseFile);
 try{assert.equal(db.prepare('SELECT version FROM muse_fee_schema').get().version,1);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM muse_fee_challenges').get().count,1);}finally{db.close();}
});

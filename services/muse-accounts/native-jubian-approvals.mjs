/** Exact native-Jubian challenges share login-enrolled issuers while retaining a separate signed action. */
import {createHash,randomBytes,randomUUID,verify as verifySignature} from 'node:crypto';
import {nativeJubianSourceCanonical} from './native-jubian-sources.mjs';

const fail=(code,status=409)=>Object.assign(Error(code),{code,status});
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const hash=value=>createHash('sha256').update(value).digest('hex');
const sha=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const positive=value=>Number.isSafeInteger(value)&&value>0;
const short=value=>typeof value==='string'&&value.length>0&&value.length<=256&&!/[\x00-\x1f\x7f]/.test(value);
const fields=['provider','company_id','provider_origin','script_id','operation_id','method','request_sha256','quote_sha256',
 'provider_connection_revision','currency','amount_minor','resources','policy_revision','account_id','login_session_id','device_id'];
const observationFields=['admission_id','attempt_id','state','observation_sha256','operation_actor_id','current_policy_revision'];
const budgetFields=['provider','account_id','login_session_id','device_id','company_id','change_id','target','currency',
 'previous_limit_minor','new_limit_minor','target_revision','base_policy_revision'];

/** Validate canonical company admission fields supplied by the trusted admission owner.
 * @param {object} value Canonical quote with authenticated identity, without a token or arbitrary request body.
 * @returns {object} Ordered, complete values covered by the device signature.
 */
export function nativeJubianFrozen(value){
 if(!object(value)||Object.keys(value).length!==fields.length||fields.some(key=>!Object.hasOwn(value,key))
  ||value.provider!=='jubian'||!short(value.company_id)||!positive(value.script_id)||!short(value.operation_id)||!short(value.method)
  ||!sha(value.request_sha256)||!sha(value.quote_sha256)||!sha(value.provider_connection_revision)
  ||value.currency!=='CNY'||!Number.isSafeInteger(value.amount_minor)||value.amount_minor<0
  ||!positive(value.policy_revision)||!/^([a-f0-9]{16})$/.test(value.account_id)||!sha(value.login_session_id)
  ||value.device_id!==null&&!short(value.device_id)||!Array.isArray(value.resources)||value.resources.length===0||value.resources.length>1000)
  throw fail('native_jubian_invalid_challenge',400);
 let origin;try{origin=new URL(value.provider_origin);}catch(error){throw fail('native_jubian_invalid_challenge',400);}
 if(origin.origin!==value.provider_origin||origin.username||origin.password||origin.protocol!=='https:'
  &&!(origin.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(origin.hostname)))throw fail('native_jubian_invalid_challenge',400);
 const resources=value.resources.map(item=>{
  if(!object(item)||Object.keys(item).length!==2)throw fail('native_jubian_invalid_challenge',400);
  if(item.kind==='draft_asset'){
   if(!['image_generate','audio_generate','audio_asset_register'].includes(value.method)||value.resources.length!==1||!sha(item.id))throw fail('native_jubian_invalid_challenge',400);
  }else if(item.kind==='storage_object'){
   if(value.method!=='audio_reference_upload'||value.resources.length!==1||!sha(item.id))throw fail('native_jubian_invalid_challenge',400);
  }else if(!['card','asset','episode','project','task'].includes(item.kind)||!positive(item.id))throw fail('native_jubian_invalid_challenge',400);
  return {kind:item.kind,id:item.id};
 });
 if(new Set(resources.map(item=>item.kind+':'+item.id)).size!==resources.length)throw fail('native_jubian_invalid_challenge',400);
 if(value.method==='audio_reference_upload'&&(value.amount_minor!==0||resources.length!==1||resources[0].kind!=='storage_object')
  ||value.method==='audio_asset_register'&&(value.amount_minor!==0||resources.length!==1||resources[0].kind!=='draft_asset'))throw fail('native_jubian_invalid_challenge',400);
 return Object.fromEntries(fields.map(key=>[key,key==='resources'?resources:value[key]]));
}

/** Validate a Host observation of one original dispatched operation; it grants no new generation.
 * @param {object} value Canonical stored operation, exact terminal observation and current authenticated observer.
 * @returns {object} Detached immutable values for an observation-only signature.
 */
export function nativeJubianObservationFrozen(value){
 if(!object(value)||Object.keys(value).length!==fields.length+observationFields.length
  ||Object.keys(value).some(key=>!fields.includes(key)&&!observationFields.includes(key))
  ||typeof value.admission_id!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(value.admission_id)
  ||!short(value.attempt_id)||!['completed','failed'].includes(value.state)||!sha(value.observation_sha256)
  ||typeof value.operation_actor_id!=='string'||!/^[a-f0-9]{16}$/u.test(value.operation_actor_id)||!positive(value.current_policy_revision))
  throw fail('native_jubian_invalid_challenge',400);
 const base=nativeJubianFrozen(Object.fromEntries(fields.map(key=>[key,value[key]])));
 return {...base,...Object.fromEntries(observationFields.map(key=>[key,value[key]]))};
}

/** Validate one proposed allowance change separately from paid generation and terminal observations.
 * @param {object} value Current member/policy-checked target, old/new CNY limits and exact target revision.
 * @returns {object} Ordered allowance fields; this signature never grants a generation request.
 */
export function nativeJubianBudgetFrozen(value){
 if(!object(value)||Object.keys(value).length!==budgetFields.length||budgetFields.some(key=>!Object.hasOwn(value,key))
  ||value.provider!=='jubian'||value.currency!=='CNY'||typeof value.account_id!=='string'||!/^[a-f0-9]{16}$/u.test(value.account_id)
  ||!sha(value.login_session_id)||value.device_id!==null&&!short(value.device_id)||!short(value.company_id)||!short(value.change_id)
  ||![value.previous_limit_minor,value.new_limit_minor,value.target_revision].every(item=>Number.isSafeInteger(item)&&item>=0)
  ||!positive(value.base_policy_revision)||!object(value.target))throw fail('native_jubian_invalid_challenge',400);
 const source=value.target;let target;
 if(source.kind==='company'&&Object.keys(source).length===1)target={kind:'company'};
 else if(source.kind==='member'&&Object.keys(source).length===2&&typeof source.account_id==='string'&&/^[a-f0-9]{16}$/u.test(source.account_id))
  target={kind:'member',account_id:source.account_id};
 else if(source.kind==='project'&&Object.keys(source).length===3&&positive(source.script_id)){
  let origin;try{origin=new URL(source.provider_origin);}catch(_error){throw fail('native_jubian_invalid_challenge',400);}
  if(origin.protocol!=='https:'||origin.username||origin.password||origin.origin!==source.provider_origin)throw fail('native_jubian_invalid_challenge',400);
  target={kind:'project',provider_origin:source.provider_origin,script_id:source.script_id};
 }else throw fail('native_jubian_invalid_challenge',400);
 return Object.fromEntries(budgetFields.map(key=>[key,key==='target'?target:value[key]]));
}

/** Install native-only challenge methods over the existing private issuer and challenge tables.
 * @param {object} dependencies Initialized SQLite owner, deployment limits, current-account/issuer readers and public origin.
 * @returns {object} New-action issue, read and signature-validation methods; budget consumption belongs to the admission transaction.
 */
export function createNativeJubianApprovals({db,config,current,issuer,readChallenge,publicChallenge,publicOrigin,now}){
 const modes={
  fee:{action:'native-jubian',prefix:'muse-native-jubian-fee-v2',keys:fields,parse:nativeJubianFrozen},
  observation:{action:'native-jubian-observation',prefix:'muse-native-jubian-observation-v1',keys:[...fields,...observationFields],parse:nativeJubianObservationFrozen},
  budget:{action:'native-jubian-budget',prefix:'muse-native-jubian-budget-v1',keys:budgetFields,parse:nativeJubianBudgetFrozen},
  sourceConsent:{action:'native-jubian-source-consent',prefix:'muse-native-jubian-source-consent-v1',nested:true,parse:value=>{
   const frozen=nativeJubianSourceCanonical(value);
   if(frozen.purpose!=='source_scope'||frozen.source.kind!=='word_pair')throw fail('native_jubian_invalid_challenge',400);
   return frozen;
  }},
  sourceManaged:{action:'native-jubian-source-managed',prefix:'muse-native-jubian-source-managed-v1',nested:true,parse:nativeJubianSourceCanonical},
 };
 function read(context,id,mode='fee'){
  const {action,keys,parse,nested}=modes[mode];
  const account=current(context.accountId),row=readChallenge(context.accountId,id);
  let payload;try{payload=JSON.parse(row.payload);}catch(error){throw fail('native_jubian_invalid_challenge',409);}
  if(!object(payload)||payload.version!==2||payload.action!==action||payload.audience!==publicOrigin
   ||payload.account_revision!==account.revision||payload.account_id!==context.accountId
   ||payload.login_session_id!==context.sessionId||payload.device_id!==context.deviceId
   ||payload.issuer_id!==row.issuer_id||payload.expires_at!==row.expires_at||row.payload_sha256!==hash(row.payload))
   throw fail('native_jubian_grant_changed',409);
  const frozen=parse(nested?payload.canonical:Object.fromEntries(keys.map(key=>[key,payload[key]])));
  if(frozen.account_id!==context.accountId||frozen.login_session_id!==context.sessionId||frozen.device_id!==context.deviceId)
   throw fail('native_jubian_grant_changed',409);
  if(row.frozen_sha256!==hash(JSON.stringify({action,...frozen})))throw fail('native_jubian_invalid_challenge',409);
  return {row,payload,frozen};
 }
 function issue(actor,canonical,issuerId,review={},mode='fee'){
  const {action,parse,nested}=modes[mode];
  const account=current(actor),key=issuer(actor,issuerId),frozen=parse(canonical);
  if(frozen.account_id!==actor||!object(review)||JSON.stringify(review).length>4096
   ||Object.values(review).some(value=>!['string','number'].includes(typeof value)))throw fail('native_jubian_invalid_challenge',400);
  const frozenHash=hash(JSON.stringify({action,...frozen})),time=now();
  db.exec('BEGIN IMMEDIATE');
  try{
   const prior=db.prepare('SELECT * FROM muse_fee_challenges WHERE account_id=? AND issuer_id=? AND frozen_sha256=? AND expires_at>? ORDER BY created_at DESC LIMIT 1').get(actor,key.issuer_id,frozenHash,time);
   if(prior){db.exec('COMMIT');return publicChallenge(prior);}
   if(db.prepare('SELECT COUNT(*) AS count FROM muse_fee_challenges WHERE account_id=? AND expires_at>?').get(actor,time).count>=config.maxPendingPerAccount)throw fail('production_fee_challenge_limit',429);
   const id=randomUUID(),nonce=randomBytes(32).toString('base64url'),expires=time+config.challengeTtlMs;
   const authorization=nested?{account_id:frozen.account_id,login_session_id:frozen.login_session_id,device_id:frozen.device_id,canonical:frozen}:frozen;
   const payload=JSON.stringify({version:2,action,audience:publicOrigin,account_revision:account.revision,
    issuer_id:key.issuer_id,...authorization,expires_at:expires,review}),payloadHash=hash(payload);
   db.prepare('INSERT INTO muse_fee_challenges VALUES(?,?,?,?,?,?,?,?,?)').run(id,actor,key.issuer_id,nonce,payload,payloadHash,frozenHash,expires,time);
   const result=publicChallenge(db.prepare('SELECT * FROM muse_fee_challenges WHERE id=?').get(id));db.exec('COMMIT');return result;
  }catch(error){db.exec('ROLLBACK');throw error;}
 }
 function verify(context,proof,expected,mode='fee'){
  const {prefix,parse}=modes[mode];
  if(!object(proof)||Object.keys(proof).length!==4||!Object.keys(proof).every(key=>['challenge_id','issuer_id','signature','decision'].includes(key))
   ||proof.decision!=='approved'||!sha(proof.issuer_id)||typeof proof.signature!=='string'||!/^[A-Za-z0-9_-]{86}$/.test(proof.signature))
   throw fail('production_fee_invalid_proof',403);
  const value=read(context,proof.challenge_id,mode),key=issuer(context.accountId,proof.issuer_id);
  if(value.row.issuer_id!==proof.issuer_id||JSON.stringify(value.frozen)!==JSON.stringify(parse(expected)))
   throw fail('native_jubian_grant_changed',409);
  const message=prefix+'\n'+value.row.id+'\n'+value.row.nonce+'\n'+value.row.payload_sha256+'\napproved';
  if(!verifySignature(null,Buffer.from(message),key.public_key,Buffer.from(proof.signature,'base64url')))
   throw fail('production_fee_invalid_proof',403);
  return {grant_id:value.row.id,issuer_id:key.issuer_id,expires_at:value.row.expires_at};
 }
 return {
  /** Freeze one admission-owner quote; a model-supplied boolean cannot issue or approve it.
   * @param {string} actor Authenticated account supplied by the HTTP owner.
   * @param {object} canonical Current membership/policy-checked quote from native admission.
   * @param {string} issuerId Login-enrolled public issuer fingerprint.
   * @param {object} review Optional bounded display hints, excluded from authorization decisions.
   * @returns {object} Unapproved public challenge for a real Host question.
   */
  createNativeJubianChallenge(actor,canonical,issuerId,review={}){
   return issue(actor,canonical,issuerId,review);
  },
  /** Read only a native-action challenge bound to this live login.
   * @param {object} context Server-authenticated account and login reference, with nullable trusted device identity.
   * @param {string} id Exact public challenge ID.
   * @returns {object} Unapproved challenge; legacy actions and other logins are refused.
   */
  nativeJubianChallenge(context,id){return publicChallenge(read(context,id).row);},
  /** Verify a genuine enrolled-device answer without consuming its one-shot budget grant.
   * @param {object} context Server-authenticated account and current login reference.
   * @param {object} proof Private approval signature produced only after a native Host question.
   * @param {object} expected Current admission-owner canonical fields, including zero-price paid operations.
   * @returns {object} Verified grant and enrolled issuer for atomic admission and audit.
   */
  verifyNativeJubian(context,proof,expected){
   return verify(context,proof,expected);
  },
  /** Freeze a stored-operation observation for a registered Host, without another spending authorization.
   * @param {string} actor Authenticated observer account, already checked by admission.
   * @param {object} canonical Exact stored operation and terminal observation returned by admission.
   * @param {string} issuerId Login-enrolled Host key; a browser cannot use a fee proof as this signature.
   * @returns {object} Observation-only challenge, not a supplier receipt or generation grant.
   */
  createNativeJubianObservationChallenge(actor,canonical,issuerId){return issue(actor,canonical,issuerId,{},'observation');},
  /** Read an observation-only challenge for this authenticated login.
   * @param {object} context Current authenticated observer and login reference.
   * @param {string} id Original observation challenge ID.
   * @returns {object} Exact original observation challenge; fee challenges are rejected.
   */
  nativeJubianObservation(context,id){return publicChallenge(read(context,id,'observation').row);},
  /** Verify a managed Host's exact observation; this does not independently verify the supplier.
   * @param {object} context Current authenticated observer and login reference.
   * @param {object} proof Observation-specific enrolled-device signature, never a model boolean.
   * @param {object} expected Canonical stored operation, terminal state and response digest from admission.
   * @returns {object} One observation identity for the admission transaction's immutable audit.
   */
  verifyNativeJubianObservation(context,proof,expected){return verify(context,proof,expected,'observation');},
  /** Freeze a real member-approved allowance proposal, without authorizing a generation fee.
   * @param {string} actor Authenticated current account supplied by admission.
   * @param {object} canonical Exact old/new allowance, target and CAS revision from admission.
   * @param {string} issuerId Login-enrolled Host key that must ask the real user.
   * @returns {object} Unapproved allowance-only challenge.
   */
  createNativeJubianBudgetChallenge(actor,canonical,issuerId){return issue(actor,canonical,issuerId,{},'budget');},
  /** Read an allowance-only challenge for the current login.
   * @param {object} context Authenticated account and login reference.
   * @param {string} id Original allowance challenge identity.
   * @returns {object} Original allowance challenge, excluding fee and observation actions.
   */
  nativeJubianBudget(context,id){return publicChallenge(read(context,id,'budget').row);},
  /** Verify the exact user's allowance decision without dispatching or reserving generation.
   * @param {object} context Authenticated account and login reference.
   * @param {object} proof Allowance-specific signature after a genuine native user question.
   * @param {object} expected Current target allowance and CAS revision from admission.
   * @returns {object} One-use allowance decision for atomic update and audit.
   */
  verifyNativeJubianBudget(context,proof,expected){return verify(context,proof,expected,'budget');},
  /** Freeze a Word source's exact rights declaration for a genuine user decision, independently of generation fees.
   * @param {string} actor Authenticated account that owns this source operation.
   * @param {object} canonical Source-owner scope with both file hashes and declaration/catalogue digests.
   * @param {string} issuerId Login-enrolled Host key that must ask the real user.
   * @returns {object} Unapproved rights-only challenge containing no Word text or credentials.
   */
  createNativeJubianSourceConsentChallenge(actor,canonical,issuerId){return issue(actor,canonical,issuerId,{},'sourceConsent');},
  /** Read the original source-rights question for this login.
   * @param {object} context Authenticated account, login and device identity.
   * @param {string} id Original rights challenge identity.
   * @returns {object} Rights-only public challenge; other actions and logins are refused.
   */
  nativeJubianSourceConsent(context,id){return publicChallenge(read(context,id,'sourceConsent').row);},
  /** Verify the user's exact rights decision without authorizing uploads or paid generation.
   * @param {object} context Authenticated source actor and current login identity.
   * @param {object} proof Enrolled Host signature produced after the real user answered the rights question.
   * @param {object} expected Current source-owner canonical scope.
   * @returns {object} One-use source consent grant consumed by the source transaction.
   */
  verifyNativeJubianSourceConsent(context,proof,expected){return verify(context,proof,expected,'sourceConsent');},
  /** Freeze a managed Host assertion for one source scope, write intent or readback.
   * @param {string} actor Authenticated current actor, already checked by the source owner.
   * @param {object} canonical Exact source-purpose fields from the source owner; no arbitrary supplier body.
   * @param {string} issuerId Login-enrolled managed Host key.
   * @returns {object} Managed assertion challenge, independent of human rights and spending decisions.
   */
  createNativeJubianSourceManagedChallenge(actor,canonical,issuerId){return issue(actor,canonical,issuerId,{},'sourceManaged');},
  /** Read an original managed source assertion for the current login.
   * @param {object} context Authenticated account, login and device identity.
   * @param {string} id Original source assertion identity.
   * @returns {object} Managed assertion challenge for its exact purpose and operation.
   */
  nativeJubianSourceManaged(context,id){return publicChallenge(read(context,id,'sourceManaged').row);},
  /** Verify a managed source assertion; it is not an independent supplier receipt.
   * @param {object} context Authenticated observer and current login identity.
   * @param {object} proof Purpose-specific enrolled Host signature.
   * @param {object} expected Current source-owner scope, effect or actual-readback canonical fields.
   * @returns {object} One-use managed assertion for atomic source admission and audit.
   */
  verifyNativeJubianSourceManaged(context,proof,expected){return verify(context,proof,expected,'sourceManaged');},
 };
}

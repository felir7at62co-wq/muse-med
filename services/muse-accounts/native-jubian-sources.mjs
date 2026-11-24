/** Company source admission stores only hashes, provider identities and managed receipts; Word bytes and Tokens remain on Hosts. */
import {createHash,randomUUID} from 'node:crypto';
import {nativeJubianMember} from './native-jubian-members.mjs';

/** Source and company-project directory tables retained by private admission migrations. */
export const NATIVE_JUBIAN_SOURCE_TABLES=['native_jubian_source_operations','native_jubian_source_effects','native_jubian_source_grants','native_jubian_company_projects'];
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const positive=value=>Number.isSafeInteger(value)&&value>0;
const hash=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const identifier=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(value);
const fail=(code,status=409)=>Object.assign(Error('native_jubian_source_'+code),{code:'native_jubian_source_'+code,status});
const strict=(value,keys)=>{if(!object(value)||Object.keys(value).some(key=>!keys.includes(key)))throw fail('invalid_request',400);};
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const origin=value=>{let parsed;try{parsed=new URL(value);}catch(_error){throw fail('invalid_origin',400);}if(parsed.protocol!=='https:'||parsed.origin!==value||parsed.username||parsed.password)throw fail('invalid_origin',400);return parsed.origin;};
const keyPattern=/^prod\/sys-material-video\/\d{4}\/\d{2}\/\d{2}\/[a-f0-9]{32}\.docx$/;
const scopeFields=['company_id','provider_origin','provider_connection_revision','operation_id','method','source','plan_sha256'];
const roles=new Set(['owner','admin','editor']);

/** Validate optional source policy. Absence leaves all new source writes disabled without removing registered projects.
 * @param {object|undefined} value Operator-owned company source limits and origin allowlists.
 * @returns {object|undefined} Detached explicit policy, or disabled when absent.
 */
export function resolveNativeJubianSourcesConfig(value){
 if(value===undefined)return;
 strict(value,['version','revision','companies']);if(value.version!==1||!positive(value.revision)||!Array.isArray(value.companies))throw fail('invalid_configuration',500);
 const companies=value.companies.map(row=>{
  strict(row,['companyId','namespace','allowedOrigins','roles','maxPendingSources','maxPendingSourcesPerMember','maxActiveEffects','maxActiveEffectsPerMember','newProjectMaxParallel']);
  if(!identifier(row.companyId)||!identifier(row.namespace)||!Array.isArray(row.allowedOrigins)||!row.allowedOrigins.length||!Array.isArray(row.roles)||!row.roles.length
   ||row.roles.some(role=>!roles.has(role))||new Set(row.roles).size!==row.roles.length
   ||['maxPendingSources','maxPendingSourcesPerMember','maxActiveEffects','maxActiveEffectsPerMember','newProjectMaxParallel'].some(key=>!positive(row[key])))throw fail('invalid_configuration',500);
  const origins=row.allowedOrigins.map(origin);if(new Set(origins).size!==origins.length)throw fail('invalid_configuration',500);
  return {...row,allowedOrigins:origins,roles:[...row.roles]};
 });
 if(new Set(companies.map(row=>row.companyId)).size!==companies.length)throw fail('invalid_configuration',500);
 return {version:1,revision:value.revision,companies};
}

/** Install source-only tables inside the caller's schema migration transaction without modifying production or budget rows.
 * @param {object} db Existing private central SQLite connection with a migration transaction open.
 */
export function installNativeJubianSourcesSchema(db){
 db.exec(`CREATE TABLE IF NOT EXISTS native_jubian_source_operations(source_id TEXT PRIMARY KEY,company_id TEXT NOT NULL,provider_origin TEXT NOT NULL,namespace TEXT NOT NULL,operation_id TEXT NOT NULL,actor_id TEXT NOT NULL,descriptor_json TEXT NOT NULL,identity_sha256 TEXT NOT NULL,logical_key TEXT NOT NULL,source_policy_revision INTEGER NOT NULL,new_project_max_parallel INTEGER NOT NULL,state TEXT NOT NULL CHECK(state IN('open','completed','cancelled')),created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,UNIQUE(company_id,operation_id));
CREATE UNIQUE INDEX IF NOT EXISTS native_jubian_source_logical_owner ON native_jubian_source_operations(company_id,provider_origin,namespace,logical_key) WHERE state!='cancelled';
CREATE TABLE IF NOT EXISTS native_jubian_source_effects(effect_id TEXT PRIMARY KEY,source_id TEXT NOT NULL REFERENCES native_jubian_source_operations(source_id),effect_key TEXT NOT NULL UNIQUE,kind TEXT NOT NULL,request_sha256 TEXT NOT NULL,destination_json TEXT,phase TEXT NOT NULL CHECK(phase IN('reserved','unknown','confirmed','cancelled')),receipt_json TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,UNIQUE(source_id,kind));
CREATE TABLE IF NOT EXISTS native_jubian_source_grants(grant_id TEXT PRIMARY KEY,source_id TEXT NOT NULL REFERENCES native_jubian_source_operations(source_id),effect_key TEXT,purpose TEXT NOT NULL,canonical_sha256 TEXT NOT NULL,issuer_id TEXT NOT NULL,expires_at INTEGER NOT NULL,created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS native_jubian_company_projects(company_id TEXT NOT NULL,provider_origin TEXT NOT NULL,script_id INTEGER NOT NULL CHECK(script_id>0),manuscript_id INTEGER NOT NULL CHECK(manuscript_id>0),source_id TEXT NOT NULL REFERENCES native_jubian_source_operations(source_id),effect_id TEXT NOT NULL UNIQUE REFERENCES native_jubian_source_effects(effect_id),creator_id TEXT NOT NULL,observation_sha256 TEXT NOT NULL,max_parallel INTEGER NOT NULL CHECK(max_parallel>0),created_at INTEGER NOT NULL,PRIMARY KEY(company_id,provider_origin,script_id));`);
 for(const table of ['native_jubian_source_grants','native_jubian_company_projects'])for(const action of ['UPDATE','DELETE'])db.exec(`CREATE TRIGGER IF NOT EXISTS ${table}_${action.toLowerCase()} BEFORE ${action} ON ${table} BEGIN SELECT RAISE(ABORT,'native_jubian_source_immutable');END;`);
}

function source(value){
 if(!object(value))throw fail('invalid_source',400);
 if(value.kind==='existing_manuscript'){
  strict(value,['kind','manuscript_id']);if(!positive(value.manuscript_id))throw fail('invalid_source',400);return {kind:value.kind,manuscript_id:value.manuscript_id};
 }
 strict(value,['kind','manuscript','original','declarations_sha256','catalogue_sha256']);
 if(value.kind!=='word_pair'||!hash(value.declarations_sha256)||!hash(value.catalogue_sha256))throw fail('invalid_source',400);
 const file=value=>{strict(value,['sha256','bytes','name_sha256']);if(!hash(value.sha256)||!positive(value.bytes)||!hash(value.name_sha256))throw fail('invalid_source_file',400);return {sha256:value.sha256,bytes:value.bytes,name_sha256:value.name_sha256};};
 return {kind:'word_pair',manuscript:file(value.manuscript),original:file(value.original),declarations_sha256:value.declarations_sha256,catalogue_sha256:value.catalogue_sha256};
}
function descriptor(value){
 if(!identifier(value.company_id)||!identifier(value.operation_id)||!hash(value.provider_connection_revision)||!hash(value.plan_sha256))throw fail('invalid_request',400);
 const normalized=source(value.source);
 if(value.method!==(normalized.kind==='word_pair'?'manuscript_submit':'manual_project_create'))throw fail('invalid_source_method',400);
 return {company_id:value.company_id,provider_origin:origin(value.provider_origin),provider_connection_revision:value.provider_connection_revision,
  operation_id:value.operation_id,method:value.method,source:normalized,plan_sha256:value.plan_sha256};
}

/** Validate and detach the complete source value signed by an enrolled managed Host; source IDs and supplier credentials are excluded.
 * @param {object} value Untrusted canonical source JSON from a challenge, proof or persisted request.
 * @returns {object} Ordered normalized fields with purpose-specific effect and observation identities.
 */
export function nativeJubianSourceCanonical(value){
 strict(value,['version','provider','purpose','account_id','login_session_id','device_id','source_actor_id',...scopeFields,'namespace','source_policy_revision','base_policy_revision','effect','observation']);
 if(value.version!==1||value.provider!=='jubian'||!['source_scope','source_effect','source_observation'].includes(value.purpose)
  ||typeof value.account_id!=='string'||!/^[a-f0-9]{16}$/.test(value.account_id)
  ||typeof value.source_actor_id!=='string'||!/^[a-f0-9]{16}$/.test(value.source_actor_id)
  ||!hash(value.login_session_id)||value.device_id!==null&&!hash(value.device_id)||!identifier(value.namespace)
  ||!positive(value.source_policy_revision)||!positive(value.base_policy_revision))throw fail('invalid_canonical',400);
 const input=descriptor(value);let effect=null,observation=null;
 if(value.purpose==='source_scope'){
  if(value.effect!==null||value.observation!==null)throw fail('invalid_canonical',400);
 }else{
  strict(value.effect,['effect_key','kind','request_sha256','destination']);
  const entry=value.effect,word=input.source.kind==='word_pair';
  if(!hash(entry.effect_key)||!hash(entry.request_sha256)||!['upload_manuscript','upload_original','submit_manuscript','create_project'].includes(entry.kind)
   ||word&&entry.kind==='create_project'||!word&&entry.kind!=='create_project')throw fail('invalid_canonical',400);
  let destination=null;
  if(entry.kind.startsWith('upload_')){
   strict(entry.destination,['object_key','sha256','bytes']);const file=input.source[entry.kind==='upload_manuscript'?'manuscript':'original'];
   if(!keyPattern.test(entry.destination.object_key)||entry.destination.sha256!==file.sha256||entry.destination.bytes!==file.bytes)throw fail('invalid_canonical',400);
   destination={object_key:entry.destination.object_key,sha256:file.sha256,bytes:file.bytes};
  }else if(entry.destination!==null)throw fail('invalid_canonical',400);
  effect={effect_key:entry.effect_key,kind:entry.kind,request_sha256:entry.request_sha256,destination};
  if(value.purpose==='source_effect'){
   if(value.observation!==null)throw fail('invalid_canonical',400);
  }else{
   strict(value.observation,['receipt']);const result=value.observation.receipt;
   if(entry.kind.startsWith('upload_')){
    strict(result,['kind','role','object_key','sha256','bytes']);const role=entry.kind==='upload_manuscript'?'manuscript':'original';
    if(result.kind!=='upload'||result.role!==role||result.object_key!==destination.object_key||result.sha256!==destination.sha256||result.bytes!==destination.bytes)throw fail('invalid_canonical',400);
    observation={receipt:{kind:'upload',role,object_key:destination.object_key,sha256:destination.sha256,bytes:destination.bytes}};
   }else if(entry.kind==='submit_manuscript'){
    strict(result,['kind','manuscript_id','matched_plan_sha256','readback_sha256']);
    if(result.kind!=='manuscript'||!positive(result.manuscript_id)||result.matched_plan_sha256!==input.plan_sha256||!hash(result.readback_sha256))throw fail('invalid_canonical',400);
    observation={receipt:{kind:'manuscript',manuscript_id:result.manuscript_id,matched_plan_sha256:result.matched_plan_sha256,readback_sha256:result.readback_sha256}};
   }else{
    strict(result,['kind','script_id','manuscript_id','matched_request_sha256','readback_sha256']);
    if(result.kind!=='project'||!positive(result.script_id)||result.manuscript_id!==input.source.manuscript_id||result.matched_request_sha256!==entry.request_sha256||!hash(result.readback_sha256))throw fail('invalid_canonical',400);
    observation={receipt:{kind:'project',script_id:result.script_id,manuscript_id:result.manuscript_id,matched_request_sha256:result.matched_request_sha256,readback_sha256:result.readback_sha256}};
   }
  }
 }
 return {version:1,provider:'jubian',purpose:value.purpose,account_id:value.account_id,login_session_id:value.login_session_id,device_id:value.device_id,
  source_actor_id:value.source_actor_id,...input,namespace:value.namespace,source_policy_revision:value.source_policy_revision,base_policy_revision:value.base_policy_revision,effect,observation};
}

/** Create source operations over the central owner's transaction; no method performs HTTP, file upload or generation.
 * @param {object} options Private SQLite, live accounts/policy, optional source policy and purpose-specific native verifiers.
 * @returns {object} Source request processor and read-only runtime project-directory lookup.
 */
export function createNativeJubianSources({db,config,accounts,readPolicy,nativeApprovals,now,audit}){
 const setting=companyId=>config?.companies.find(row=>row.companyId===companyId);
 const saved=(companyId,operationId)=>db.prepare('SELECT * FROM native_jubian_source_operations WHERE company_id=? AND operation_id=?').get(companyId,operationId);
 const effects=row=>db.prepare('SELECT * FROM native_jubian_source_effects WHERE source_id=? ORDER BY kind').all(row.source_id);
 function choose(context,companyId,row,write=false){
  const account=accounts.get(context.accountId);if(!account||account.disabled)throw fail('account_forbidden',403);
  const policy=readPolicy(),company=policy.companies.find(item=>item.id===companyId),member=nativeJubianMember(company,context.accountId,accounts);
  if(!member?.active)throw fail('member_forbidden',403);
  if(row&&row.actor_id!==context.accountId&&!['owner','admin'].includes(member.role))throw fail('operation_forbidden',403);
  const current=setting(companyId);
  if(write&&(!current||!current.roles.includes(member.role)))throw fail('scope_unavailable',503);
  if(write&&row&&(row.actor_id!==context.accountId||row.namespace!==current.namespace||!current.allowedOrigins.includes(row.provider_origin)))throw fail('write_forbidden',403);
  return {policy,company,member,current};
 }
 function canonical(context,row,selected,purpose,effect=null,observation=null){
  const input=JSON.parse(row.descriptor_json);
  return nativeJubianSourceCanonical({version:1,provider:'jubian',purpose,account_id:context.accountId,login_session_id:context.sessionId,device_id:context.deviceId,
   source_actor_id:row.actor_id,...input,namespace:row.namespace,source_policy_revision:purpose==='source_observation'?row.source_policy_revision:config.revision,
   base_policy_revision:selected.policy.revision,effect,observation});
 }
 function verify(context,proof,value,consent=false){
  const method=consent?'verifySourceConsent':'verifySourceManaged';if(typeof nativeApprovals?.[method]!=='function')throw fail(consent?'consent_unavailable':'managed_proof_unavailable',503);
  const grant=nativeApprovals[method](context,proof,value);
  if(!object(grant)||typeof grant.grant_id!=='string'||!grant.grant_id.length||grant.grant_id.length>256||!hash(grant.issuer_id)||!positive(grant.expires_at)||grant.expires_at<=now())throw fail('invalid_grant',403);
  return grant;
 }
 function consume(row,effectKey,purpose,grant,value){
  if(db.prepare('SELECT 1 FROM native_jubian_admission_grants WHERE grant_id=?').get(grant.grant_id)
   ||db.prepare('SELECT 1 FROM native_jubian_admission_budget_changes WHERE grant_id=?').get(grant.grant_id))throw fail('grant_consumed',403);
  const old=db.prepare('SELECT * FROM native_jubian_source_grants WHERE grant_id=?').get(grant.grant_id),canonicalSha=digest(value);
  if(old){if(old.source_id!==row.source_id||old.effect_key!==effectKey||old.purpose!==purpose||old.canonical_sha256!==canonicalSha)throw fail('grant_consumed',403);return;}
  db.prepare('INSERT INTO native_jubian_source_grants VALUES(?,?,?,?,?,?,?,?)').run(grant.grant_id,row.source_id,effectKey,purpose,canonicalSha,grant.issuer_id,grant.expires_at,now());
 }
 function scopeResult(row,replayed=false){return {allowed:true,source_admission_id:row.source_id,operation_id:row.operation_id,state:row.state,replayed,
  descriptor:JSON.parse(row.descriptor_json),effects:effects(row).map(effect=>({effect_id:effect.effect_id,effect_key:effect.effect_key,kind:effect.kind,state:effect.phase,
   request_sha256:effect.request_sha256,receipt:effect.receipt_json===null?null:JSON.parse(effect.receipt_json)}))};}
 function effectValue(row,kind,request,destination){
  const descriptor=JSON.parse(row.descriptor_json),word=descriptor.source.kind==='word_pair';
  if(!hash(request)||!['upload_manuscript','upload_original','submit_manuscript','create_project'].includes(kind)
   ||word&&kind==='create_project'||!word&&kind!=='create_project')throw fail('invalid_effect',400);
  let target=null;
  if(kind.startsWith('upload_')){
   strict(destination,['object_key','sha256','bytes']);const role=kind==='upload_manuscript'?'manuscript':'original',file=descriptor.source[role];
   if(!keyPattern.test(destination.object_key)||destination.sha256!==file.sha256||destination.bytes!==file.bytes)throw fail('upload_identity_conflict');
   if(effects(row).some(effect=>effect.kind!==kind&&effect.kind.startsWith('upload_')
    &&JSON.parse(effect.destination_json).object_key===destination.object_key))throw fail('upload_destination_conflict');
   target={object_key:destination.object_key,sha256:file.sha256,bytes:file.bytes};
  }else if(destination!==null)throw fail('invalid_effect',400);
  return {effect_key:digest([row.source_id,kind]),kind,request_sha256:request,destination:target};
 }
 function effectResult(row,effect,extra={}){return {allowed:true,source_admission_id:row.source_id,effect_id:effect.effect_id,effect_key:effect.effect_key,
  kind:effect.kind,state:effect.phase,request_sha256:effect.request_sha256,dispatch_allowed:false,replayed:false,...extra};}
 function receipt(row,effect,value){
  const input=JSON.parse(row.descriptor_json);
  if(!object(value))throw fail('invalid_observation',400);
  if(effect.kind.startsWith('upload_')){
   strict(value,['kind','role','object_key','sha256','bytes']);const target=JSON.parse(effect.destination_json),role=effect.kind==='upload_manuscript'?'manuscript':'original';
   if(value.kind!=='upload'||value.role!==role||value.object_key!==target.object_key||value.sha256!==target.sha256||value.bytes!==target.bytes)throw fail('observation_conflict');
   return {kind:'upload',role,object_key:target.object_key,sha256:target.sha256,bytes:target.bytes};
  }
  if(effect.kind==='submit_manuscript'){
   strict(value,['kind','manuscript_id','matched_plan_sha256','readback_sha256']);
   if(value.kind!=='manuscript'||!positive(value.manuscript_id)||value.matched_plan_sha256!==input.plan_sha256||!hash(value.readback_sha256))throw fail('observation_conflict');
   return {kind:'manuscript',manuscript_id:value.manuscript_id,matched_plan_sha256:value.matched_plan_sha256,readback_sha256:value.readback_sha256};
  }
  strict(value,['kind','script_id','manuscript_id','matched_request_sha256','readback_sha256']);
  if(value.kind!=='project'||!positive(value.script_id)||value.manuscript_id!==input.source.manuscript_id||value.matched_request_sha256!==effect.request_sha256||!hash(value.readback_sha256))throw fail('observation_conflict');
  return {kind:'project',script_id:value.script_id,manuscript_id:value.manuscript_id,matched_request_sha256:value.matched_request_sha256,readback_sha256:value.readback_sha256};
 }
 function writeAudit(context,event,row,detail={},issuer=null){audit(context,'source-'+event,{company_id:row.company_id,admission_id:row.source_id,operation_id:row.operation_id,policy_revision:readPolicy().revision},detail,issuer);}
 function scope(context,value){
  strict(value,['type',...scopeFields,...value.type==='source_reserve'?['consent_proof','managed_proof']:[]]);
  const input=descriptor(value),previous=saved(input.company_id,input.operation_id),selected=choose(context,input.company_id,previous,!previous);
  if(previous){if(previous.identity_sha256!==digest(input))throw fail('operation_conflict');return scopeResult(previous,true);}
  if(!selected.current.allowedOrigins.includes(input.provider_origin))throw fail('origin_forbidden',403);
  const logical=input.source.kind==='word_pair'?digest(['word_pair',input.source.manuscript.sha256,input.source.original.sha256])
   :digest(['manuscript',input.source.manuscript_id,0]);
  if(db.prepare("SELECT 1 FROM native_jubian_source_operations WHERE company_id=? AND provider_origin=? AND namespace=? AND logical_key=? AND state!='cancelled'")
   .get(input.company_id,input.provider_origin,selected.current.namespace,logical))throw fail('duplicate_source');
  const row={source_id:randomUUID(),company_id:input.company_id,provider_origin:input.provider_origin,namespace:selected.current.namespace,
   operation_id:input.operation_id,actor_id:context.accountId,descriptor_json:JSON.stringify(input),identity_sha256:digest(input),logical_key:logical,
   source_policy_revision:config.revision,new_project_max_parallel:selected.current.newProjectMaxParallel,state:'open',created_at:now(),updated_at:now()};
  const expected=canonical(context,row,selected,'source_scope');
  if(value.type==='source_quote')return {allowed:true,state:'quoted',canonical:expected,managed_proof_available:typeof nativeApprovals?.verifySourceManaged==='function',
   consent_required:input.source.kind==='word_pair',consent_available:typeof nativeApprovals?.verifySourceConsent==='function'};
  const pending=where=>db.prepare("SELECT COUNT(*) AS count FROM native_jubian_source_operations WHERE company_id=? AND state='open'"+where);
  if(pending('').get(input.company_id).count>=selected.current.maxPendingSources||pending(' AND actor_id=?').get(input.company_id,context.accountId).count>=selected.current.maxPendingSourcesPerMember)throw fail('capacity',429);
  const managed=verify(context,value.managed_proof,expected),consent=input.source.kind==='word_pair'?verify(context,value.consent_proof,expected,true):null;
  db.prepare('INSERT INTO native_jubian_source_operations VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(...Object.values(row));
  consume(row,null,'managed_scope',managed,expected);if(consent)consume(row,null,'consent',consent,expected);
  writeAudit(context,'reserved',row,{method:input.method,logical_key:logical},managed.issuer_id);return scopeResult(row);
 }
 function request(context,value){
  if(['source_quote','source_reserve'].includes(value?.type))return scope(context,value);
  const common=['type','company_id','operation_id'];
  if(!identifier(value?.company_id)||!identifier(value?.operation_id))throw fail('invalid_request',400);
  const row=saved(value.company_id,value.operation_id);if(!row)throw fail('operation_missing',404);
  const type=value.type,read=['source_status','source_effect_observation_quote','source_effect_observe'].includes(type),selected=choose(context,row.company_id,row,!read&&type!=='source_cancel');
  if(type==='source_status'){strict(value,common);return scopeResult(row,true);}
  if(type==='source_cancel'){
   strict(value,common);if(row.state==='cancelled')return scopeResult(row,true);
   if(effects(row).some(effect=>!['reserved','cancelled'].includes(effect.phase)))throw fail('effect_may_have_started');
   db.prepare("UPDATE native_jubian_source_effects SET phase='cancelled',updated_at=? WHERE source_id=? AND phase='reserved'").run(now(),row.source_id);
   db.prepare("UPDATE native_jubian_source_operations SET state='cancelled',updated_at=? WHERE source_id=?").run(now(),row.source_id);
   writeAudit(context,'cancelled',row);return scopeResult({...row,state:'cancelled'});
  }
  if(row.state==='cancelled')throw fail('cancelled');
  const observation=['source_effect_observation_quote','source_effect_observe'].includes(type);
  strict(value,[...common,'kind','request_sha256','destination',...observation?['receipt','managed_proof']:['managed_proof']]);
  const target=effectValue(row,value.kind,value.request_sha256,value.destination),prior=db.prepare('SELECT * FROM native_jubian_source_effects WHERE effect_key=?').get(target.effect_key);
  if(prior&&(prior.request_sha256!==target.request_sha256||prior.destination_json!==JSON.stringify(target.destination)))throw fail('effect_conflict');
  if(observation){
   if(!prior||!['unknown','confirmed'].includes(prior.phase))throw fail('effect_not_dispatched');
   const proofReceipt=receipt(row,prior,value.receipt),expected=canonical(context,row,selected,'source_observation',target,{receipt:proofReceipt});
   if(prior.phase==='confirmed'){
    if(prior.receipt_json!==JSON.stringify(proofReceipt))throw fail('observation_conflict');return effectResult(row,prior,{replayed:true,receipt:proofReceipt});
   }
   if(type==='source_effect_observation_quote')return {allowed:true,state:'unknown',canonical:expected,managed_proof_available:typeof nativeApprovals?.verifySourceManaged==='function'};
   const grant=verify(context,value.managed_proof,expected);consume(row,target.effect_key,'managed_observation',grant,expected);
   if(proofReceipt.kind==='project'){
    if(selected.company.projects.some(project=>project.providerOrigin===row.provider_origin&&project.scriptId===proofReceipt.script_id))throw fail('project_registry_conflict');
    const existing=db.prepare('SELECT * FROM native_jubian_company_projects WHERE company_id=? AND provider_origin=? AND script_id=?').get(row.company_id,row.provider_origin,proofReceipt.script_id);
    if(existing&&(existing.effect_id!==prior.effect_id||existing.manuscript_id!==proofReceipt.manuscript_id))throw fail('project_registry_conflict');
    if(!existing)db.prepare('INSERT INTO native_jubian_company_projects VALUES(?,?,?,?,?,?,?,?,?,?)').run(row.company_id,row.provider_origin,proofReceipt.script_id,
     proofReceipt.manuscript_id,row.source_id,prior.effect_id,row.actor_id,digest(expected),row.new_project_max_parallel,now());
   }
   db.prepare("UPDATE native_jubian_source_effects SET phase='confirmed',receipt_json=?,updated_at=? WHERE effect_id=?").run(JSON.stringify(proofReceipt),now(),prior.effect_id);
   if(!value.kind.startsWith('upload_'))db.prepare("UPDATE native_jubian_source_operations SET state='completed',updated_at=? WHERE source_id=?").run(now(),row.source_id);
   writeAudit(context,'observed',row,{effect_key:target.effect_key,kind:value.kind,receipt_sha256:digest(proofReceipt)},grant.issuer_id);
   return effectResult(row,{...prior,phase:'confirmed'},{receipt:proofReceipt});
  }
  if(!['source_effect_quote','source_effect_reserve','source_effect_dispatch'].includes(type))throw fail('invalid_request',400);
  if(value.kind==='submit_manuscript'&&!['upload_manuscript','upload_original'].every(kind=>effects(row).some(effect=>effect.kind===kind&&effect.phase==='confirmed')))throw fail('uploads_unverified');
  const expected=canonical(context,row,selected,'source_effect',target);
  if(type==='source_effect_quote')return {allowed:true,state:prior?.phase??'new',canonical:expected,managed_proof_available:typeof nativeApprovals?.verifySourceManaged==='function'};
  if(type==='source_effect_reserve'){
   if(prior)return effectResult(row,prior,{allowed:false,replayed:true});
   const active=db.prepare("SELECT COUNT(*) AS count FROM native_jubian_source_effects e JOIN native_jubian_source_operations s USING(source_id) WHERE s.company_id=? AND e.phase IN('reserved','unknown')").get(row.company_id).count;
   const memberActive=db.prepare("SELECT COUNT(*) AS count FROM native_jubian_source_effects e JOIN native_jubian_source_operations s USING(source_id) WHERE s.company_id=? AND s.actor_id=? AND e.phase IN('reserved','unknown')").get(row.company_id,context.accountId).count;
   if(active>=selected.current.maxActiveEffects||memberActive>=selected.current.maxActiveEffectsPerMember)throw fail('effect_capacity',429);
   const grant=verify(context,value.managed_proof,expected),effect={effect_id:randomUUID(),source_id:row.source_id,effect_key:target.effect_key,kind:value.kind,
    request_sha256:target.request_sha256,destination_json:JSON.stringify(target.destination),phase:'reserved',receipt_json:null,created_at:now(),updated_at:now()};
   db.prepare('INSERT INTO native_jubian_source_effects VALUES(?,?,?,?,?,?,?,?,?,?)').run(...Object.values(effect));consume(row,target.effect_key,'managed_effect',grant,expected);
   writeAudit(context,'effect-reserved',row,{effect_key:target.effect_key,kind:value.kind},grant.issuer_id);return effectResult(row,effect);
  }
  if(!prior)throw fail('effect_missing',404);
  if(prior.phase!=='reserved')return effectResult(row,prior,{allowed:false,replayed:true});
  const grant=verify(context,value.managed_proof,expected);consume(row,target.effect_key,'managed_effect',grant,expected);
  db.prepare("UPDATE native_jubian_source_effects SET phase='unknown',updated_at=? WHERE effect_id=? AND phase='reserved'").run(now(),prior.effect_id);
  writeAudit(context,'dispatch-permitted',row,{effect_key:target.effect_key,kind:value.kind},grant.issuer_id);
  return effectResult(row,{...prior,phase:'unknown'},{dispatch_allowed:true});
 }
 const projects=companyId=>db.prepare('SELECT provider_origin,script_id,max_parallel FROM native_jubian_company_projects WHERE company_id=?').all(companyId)
  .map(row=>({providerOrigin:row.provider_origin,scriptId:row.script_id,active:true,limitMinor:0,maxParallel:row.max_parallel}));
 const project=(companyId,providerOrigin,scriptId)=>{
  const row=db.prepare('SELECT max_parallel FROM native_jubian_company_projects WHERE company_id=? AND provider_origin=? AND script_id=?').get(companyId,providerOrigin,scriptId);
  return row===undefined?undefined:{providerOrigin,scriptId,active:true,limitMinor:0,maxParallel:row.max_parallel};
 };
 return {request,projects,project};
}

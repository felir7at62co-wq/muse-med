/** Private company admission for original-token Jubian Hosts; no supplier credentials or production content is stored here. */
import {createHash,randomUUID} from 'node:crypto';
import {lstat,mkdir,open,realpath} from 'node:fs/promises';
import {dirname,isAbsolute,resolve} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {NATIVE_JUBIAN_SOURCE_TABLES,resolveNativeJubianSourcesConfig,installNativeJubianSourcesSchema,createNativeJubianSources} from './native-jubian-sources.mjs';
import {resolveNativeJubianMemberDirectory,nativeJubianMember} from './native-jubian-members.mjs';
import {NATIVE_JUBIAN_QUEUE_TABLES,resolveNativeJubianSchedulerConfig,installNativeJubianSchedulerSchema,createNativeJubianScheduler} from './native-jubian-scheduler.mjs';

const SCHEMA_VERSION=4;
const PREFIX='native_jubian_admission_';
const ORIGINAL_TABLES=['meta','policies','operations','resources','grants','audit'].map(name=>PREFIX+name);
const VERSION_TWO_TABLES=[...ORIGINAL_TABLES,'native_jubian_admission_budget_overrides','native_jubian_admission_budget_changes'];
const VERSION_THREE_TABLES=[...VERSION_TWO_TABLES,...NATIVE_JUBIAN_SOURCE_TABLES];
const TABLES=[...VERSION_THREE_TABLES,...NATIVE_JUBIAN_QUEUE_TABLES];
const FREE_METHODS=new Set(['project_rename','episode_save','episode_create','asset_rename','asset_material_register','asset_material_adopt','asset_reference_upload','storyboard_save','audio_reference_upload','audio_asset_register']);
const PAID_METHODS=new Set(['image_generate','audio_generate','storyboard_generate','storyboard_native_submit','erase_subtitle','video_upscale','video_task_retry']);
const COMMON=['company_id','provider_origin','script_id','operation_id','method','provider_connection_revision','request_sha256','quote_sha256','currency','amount_minor','resources','policy_revision'];
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const id=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(value);
const account=value=>typeof value==='string'&&/^[a-f0-9]{16}$/.test(value);
const hash=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const integer=value=>Number.isSafeInteger(value)&&value>=0;
const positive=value=>Number.isSafeInteger(value)&&value>0;
const fail=(code,status=409)=>Object.assign(Error(code),{code:'native_jubian_admission_'+code,status});
const strict=(value,keys)=>{if(!object(value)||Object.keys(value).some(key=>!keys.includes(key)))throw fail('invalid_request',400);};
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
// Current policy authorizes a dispatch without changing the original supplier request identity.
const businessDigest=value=>digest({...value,policy_revision:null});
const lexical=(a,b)=>a<b?-1:a>b?1:0;
// Preserve content-addressed resources even when SQLite INTEGER affinity sees an all-digit hash.
const hashResource=resource=>resource.kind==='draft_asset'||resource.kind==='storage_object';
const storedResourceId=resource=>hashResource(resource)?'sha256:'+resource.id:resource.id;
function origin(value){
 if(typeof value!=='string')throw fail('invalid_origin',400);
 let url;try{url=new URL(value);}catch(_error){throw fail('invalid_origin',400);}
 if(url.protocol!=='https:'||url.username||url.password||url.origin!==value)throw fail('invalid_origin',400);
 return url.origin;
}
function allowance(value){if(!integer(value.limitMinor)||!positive(value.maxParallel))throw fail('invalid_policy',500);return {limitMinor:value.limitMinor,maxParallel:value.maxParallel};}
function policy(value){
 strict(value,['revision','companies']);
 if(!positive(value.revision)||!Array.isArray(value.companies)||!value.companies.length)throw fail('invalid_policy',500);
 const companies=value.companies.map(company=>{
  strict(company,['id','limitMinor','maxParallel','members','projects','memberDirectory','budgetMode']);
  if(!id(company.id)||!Array.isArray(company.members)||!company.members.length||!Array.isArray(company.projects))throw fail('invalid_policy',500);
  if(company.budgetMode!==undefined&&!['company','provider'].includes(company.budgetMode))throw fail('invalid_policy',500);
  const members=company.members.map(member=>{
   strict(member,['accountId','role','active','limitMinor','maxParallel']);
   if(!account(member.accountId)||!['owner','admin','editor','viewer'].includes(member.role)||typeof member.active!=='boolean')throw fail('invalid_policy',500);
   return {accountId:member.accountId,role:member.role,active:member.active,...allowance(member)};
  });
  const projects=company.projects.map(project=>{
   strict(project,['providerOrigin','scriptId','active','limitMinor','maxParallel']);
   if(!positive(project.scriptId)||typeof project.active!=='boolean')throw fail('invalid_policy',500);
   return {providerOrigin:origin(project.providerOrigin),scriptId:project.scriptId,active:project.active,...allowance(project)};
  });
  if(new Set(members.map(member=>member.accountId)).size!==members.length
   ||new Set(projects.map(project=>project.providerOrigin+':'+project.scriptId)).size!==projects.length
   ||!members.some(member=>member.active&&member.role==='owner'))throw fail('invalid_policy',500);
  const memberDirectory=resolveNativeJubianMemberDirectory(company.memberDirectory);
  return {id:company.id,...allowance(company),...company.budgetMode===undefined?{}:{budgetMode:company.budgetMode},
   members:members.sort((a,b)=>lexical(a.accountId,b.accountId)),
   ...memberDirectory===undefined?{}:{memberDirectory},
   projects:projects.sort((a,b)=>lexical(a.providerOrigin,b.providerOrigin)||a.scriptId-b.scriptId)};
 });
 if(new Set(companies.map(company=>company.id)).size!==companies.length)throw fail('invalid_policy',500);
 return {revision:value.revision,companies:companies.sort((a,b)=>lexical(a.id,b.id))};
}

/** Validate deployment limits and a trusted remote-project allowance policy without opening any tenant database.
 * @param {object} value Operator configuration; projects refer only to supplier origin and real script IDs.
 * @returns {object} Detached normalized configuration. No project, prompt, asset or media mirror is created.
 */
export function resolveNativeJubianAdmissionConfig(value){
 strict(value,['version','databaseFile','busyTimeoutMs','maxBatchItems','policy','sources','scheduler']);
 if(value.version!==1||typeof value.databaseFile!=='string'||!isAbsolute(value.databaseFile)||value.databaseFile.includes('\0')
  ||!positive(value.busyTimeoutMs)||value.busyTimeoutMs>60000||!positive(value.maxBatchItems))throw fail('invalid_configuration',500);
 const sources=resolveNativeJubianSourcesConfig(value.sources),scheduler=resolveNativeJubianSchedulerConfig(value.scheduler),normalizedPolicy=policy(value.policy);
 if(sources?.companies.some(source=>!normalizedPolicy.companies.some(company=>company.id===source.companyId)))throw fail('source_company_missing',500);
 return {version:1,databaseFile:resolve(value.databaseFile),busyTimeoutMs:value.busyTimeoutMs,maxBatchItems:value.maxBatchItems,policy:normalizedPolicy,
  ...sources===undefined?{}:{sources},...scheduler===undefined?{}:{scheduler}};
}

function actor(value){
 strict(value,['accountId','sessionId','deviceId']);
 if(!account(value.accountId)||!hash(value.sessionId)||value.deviceId!==null&&!hash(value.deviceId))throw fail('trusted_context_required',403);
 return {accountId:value.accountId,sessionId:value.sessionId,deviceId:value.deviceId};
}
function input(value,type){
 const extras={quote:[],reserve:['attempt_id','approval_proof','queue_id'],status:[],dispatch:['admission_id','attempt_id','approval_proof'],
  cancel:['admission_id','attempt_id','reason'],settle:['admission_id','attempt_id','state','observation_sha256','observation_proof'],
  observation_quote:['admission_id','attempt_id','state','observation_sha256']}[type];
 if(!Array.isArray(extras)||value?.type!==undefined&&value.type!==type)throw fail('invalid_request',400);
 strict(value,['type',...COMMON,...extras]);
 if(!id(value.company_id)||!positive(value.script_id)||!id(value.operation_id)||!hash(value.request_sha256)||!hash(value.quote_sha256)
  ||!hash(value.provider_connection_revision)||value.currency!=='CNY'||!integer(value.amount_minor)||!positive(value.policy_revision)
  ||!FREE_METHODS.has(value.method)&&!PAID_METHODS.has(value.method)||!Array.isArray(value.resources)||!value.resources.length)throw fail('invalid_request',400);
 if(FREE_METHODS.has(value.method)&&value.amount_minor!==0)throw fail('free_method_amount_must_be_zero',400);
 const resources=value.resources.map(resource=>{
  strict(resource,['kind','id']);
  if(resource.kind==='draft_asset'){
   if(!['image_generate','audio_generate','audio_asset_register'].includes(value.method)||!hash(resource.id)||value.resources.length!==1)throw fail('invalid_resource',400);
  }else if(resource.kind==='storage_object'){
   if(value.method!=='audio_reference_upload'||!hash(resource.id)||value.resources.length!==1)throw fail('invalid_resource',400);
  }else if(!['project','episode','asset','card','task'].includes(resource.kind)||!positive(resource.id)
   ||resource.kind==='project'&&resource.id!==value.script_id)throw fail('invalid_resource',400);
  return {kind:resource.kind,id:resource.id};
 }).sort((a,b)=>lexical(a.kind,b.kind)||(hashResource(a)?lexical(a.id,b.id):a.id-b.id));
 if(new Set(resources.map(resource=>resource.kind+':'+resource.id)).size!==resources.length)throw fail('invalid_resource',400);
 if(value.method==='asset_reference_upload'&&(resources.length!==1||resources[0].kind!=='asset'))throw fail('invalid_resource',400);
 if(value.method==='audio_reference_upload'&&(resources.length!==1||resources[0].kind!=='storage_object')
  ||value.method==='audio_asset_register'&&(resources.length!==1||resources[0].kind!=='draft_asset'))throw fail('invalid_resource',400);
 if(['reserve','dispatch','cancel','settle','observation_quote'].includes(type)&&!id(value.attempt_id))throw fail('attempt_required',400);
 if(['dispatch','cancel','settle','observation_quote'].includes(type)&&!id(value.admission_id))throw fail('admission_required',400);
 if(type==='cancel'&&value.reason!=='not_dispatched')throw fail('non_dispatch_evidence_required',400);
 if(type==='observation_quote'&&(!['completed','failed'].includes(value.state)||!hash(value.observation_sha256))
  ||type==='settle'&&(!['unknown','completed','failed'].includes(value.state)
   ||value.state!=='unknown'&&!hash(value.observation_sha256)
   ||value.observation_sha256!==undefined&&!hash(value.observation_sha256)))throw fail('invalid_observation',400);
 const descriptor={company_id:value.company_id,provider_origin:origin(value.provider_origin),script_id:value.script_id,
  operation_id:value.operation_id,method:value.method,provider_connection_revision:value.provider_connection_revision,
  request_sha256:value.request_sha256,quote_sha256:value.quote_sha256,currency:'CNY',amount_minor:value.amount_minor,resources,policy_revision:value.policy_revision};
 return {...descriptor,type,attempt_id:value.attempt_id,admission_id:value.admission_id,approval_proof:value.approval_proof,
  reason:value.reason,state:value.state,observation_sha256:value.observation_sha256,observation_proof:value.observation_proof,queue_id:value.queue_id,descriptor};
}

async function privateDatabase(file){
 const parent=dirname(file);await mkdir(parent,{recursive:true,mode:0o700});
 const directory=await lstat(parent),actual=await realpath(parent);
 if(!directory.isDirectory()||directory.isSymbolicLink()||(process.platform==='win32'?actual.toLowerCase()!==parent.toLowerCase():actual!==parent)
  ||process.platform!=='win32'&&(directory.mode&0o077)!==0)throw fail('private_storage_required',500);
 try{const handle=await open(file,'wx',0o600);await handle.close();}catch(error){if(error.code!=='EEXIST')throw error;}
 const info=await lstat(file);
 if(!info.isFile()||info.isSymbolicLink()||process.platform!=='win32'&&(info.mode&0o077)!==0)throw fail('private_storage_required',500);
 const db=new DatabaseSync(file);
 return db;
}

/** Open an independent transactional allowance and write-exclusion ledger; supplier Tokens remain on each Host.
 * @param {object} options Configuration, live account lookup, optional synchronous native-proof verifier and clock.
 * @returns {Promise<object>} Atomic write admission, signed observations, native-authorized budget CAS and private policy installation.
 */
export async function openNativeJubianAdmission({config:raw,accounts,nativeApprovals,now=Date.now}){
 const config=resolveNativeJubianAdmissionConfig(raw);
 if(typeof accounts?.get!=='function'||typeof now!=='function')throw fail('accounts_required',500);
 const db=await privateDatabase(config.databaseFile);let closed=false,activeTransaction=false,policySnapshot;
 function transaction(run){
  if(closed)throw fail('closing',503);db.exec('BEGIN IMMEDIATE');activeTransaction=true;policySnapshot=undefined;
  try{const value=run();db.exec('COMMIT');return value;}catch(error){db.exec('ROLLBACK');throw error;}
  finally{activeTransaction=false;policySnapshot=undefined;}
 }
 try{
  db.exec('PRAGMA busy_timeout='+config.busyTimeoutMs);
  const tables=db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
  if(tables.length){
   if(tables.some(row=>!TABLES.includes(row.name)))throw fail('unrelated_database',500);
   if(!tables.some(row=>row.name===PREFIX+'meta'))throw fail('unsupported_schema',500);
   const versions=db.prepare('SELECT version FROM native_jubian_admission_meta').all();
   if(versions.length!==1||![1,2,3,SCHEMA_VERSION].includes(versions[0].version)
    ||tables.length!==({1:ORIGINAL_TABLES.length,2:VERSION_TWO_TABLES.length,3:VERSION_THREE_TABLES.length,4:TABLES.length})[versions[0].version])throw fail('unsupported_schema',500);
  }
  db.exec('PRAGMA journal_mode=WAL;PRAGMA synchronous=FULL;PRAGMA foreign_keys=ON;');
  transaction(()=>{
   db.exec(`CREATE TABLE IF NOT EXISTS native_jubian_admission_meta(version INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS native_jubian_admission_policies(revision INTEGER PRIMARY KEY,sha256 TEXT NOT NULL,policy_json TEXT NOT NULL,created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS native_jubian_admission_operations(admission_id TEXT PRIMARY KEY,company_id TEXT NOT NULL,provider_origin TEXT NOT NULL,script_id INTEGER NOT NULL,operation_id TEXT NOT NULL,actor_id TEXT NOT NULL,attempt_id TEXT NOT NULL,method TEXT NOT NULL,request_sha256 TEXT NOT NULL,identity_sha256 TEXT NOT NULL,descriptor_json TEXT NOT NULL,amount_minor INTEGER NOT NULL CHECK(amount_minor>=0),policy_revision INTEGER NOT NULL,phase TEXT NOT NULL CHECK(phase IN('reserved','unknown','cancelled','completed','failed')),created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,UNIQUE(company_id,operation_id));
CREATE TABLE IF NOT EXISTS native_jubian_admission_resources(admission_id TEXT NOT NULL REFERENCES native_jubian_admission_operations(admission_id),company_id TEXT NOT NULL,provider_origin TEXT NOT NULL,script_id INTEGER NOT NULL,resource_kind TEXT NOT NULL,resource_id INTEGER NOT NULL,released_at INTEGER,PRIMARY KEY(admission_id,resource_kind,resource_id));
CREATE UNIQUE INDEX IF NOT EXISTS native_jubian_admission_resource_active ON native_jubian_admission_resources(company_id,provider_origin,script_id,resource_kind,resource_id) WHERE released_at IS NULL;
CREATE TABLE IF NOT EXISTS native_jubian_admission_grants(grant_id TEXT PRIMARY KEY,admission_id TEXT NOT NULL REFERENCES native_jubian_admission_operations(admission_id),issuer_id TEXT NOT NULL,canonical_sha256 TEXT NOT NULL,expires_at INTEGER NOT NULL,created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS native_jubian_admission_audit(sequence INTEGER PRIMARY KEY AUTOINCREMENT,company_id TEXT,admission_id TEXT,operation_id TEXT,event TEXT NOT NULL,actor_id TEXT NOT NULL,session_id TEXT,device_id TEXT,issuer_id TEXT,policy_revision INTEGER,detail_json TEXT NOT NULL,created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS native_jubian_admission_budget_overrides(company_id TEXT NOT NULL,target_key TEXT NOT NULL,target_json TEXT NOT NULL,limit_minor INTEGER NOT NULL CHECK(limit_minor>=0),revision INTEGER NOT NULL CHECK(revision>0),updated_at INTEGER NOT NULL,PRIMARY KEY(company_id,target_key));
CREATE TABLE IF NOT EXISTS native_jubian_admission_budget_changes(company_id TEXT NOT NULL,change_id TEXT NOT NULL,actor_id TEXT NOT NULL,target_key TEXT NOT NULL,canonical_json TEXT NOT NULL,revision INTEGER NOT NULL,grant_id TEXT NOT NULL UNIQUE,issuer_id TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(company_id,change_id));
CREATE INDEX IF NOT EXISTS native_jubian_admission_company ON native_jubian_admission_operations(company_id);
CREATE INDEX IF NOT EXISTS native_jubian_admission_member ON native_jubian_admission_operations(company_id,actor_id);
CREATE INDEX IF NOT EXISTS native_jubian_admission_project ON native_jubian_admission_operations(company_id,provider_origin,script_id);`);
   for(const name of ['policies','grants','audit','budget_changes'])for(const action of ['UPDATE','DELETE'])db.exec(`CREATE TRIGGER IF NOT EXISTS ${PREFIX}${name}_${action.toLowerCase()} BEFORE ${action} ON ${PREFIX}${name} BEGIN SELECT RAISE(ABORT,'native_jubian_admission_immutable');END;`);
   installNativeJubianSourcesSchema(db);
   installNativeJubianSchedulerSchema(db);
   if(!db.prepare('SELECT 1 FROM native_jubian_admission_meta').get())db.prepare('INSERT INTO native_jubian_admission_meta VALUES(?)').run(SCHEMA_VERSION);
   else db.prepare('UPDATE native_jubian_admission_meta SET version=? WHERE version IN(1,2,3)').run(SCHEMA_VERSION);
  });
 }catch(error){db.close();throw error;}
 const readPolicy=()=>{
  if(activeTransaction&&policySnapshot!==undefined)return policySnapshot.value;
  const row=db.prepare('SELECT policy_json FROM native_jubian_admission_policies ORDER BY revision DESC LIMIT 1').get(),value=row===undefined?null:JSON.parse(row.policy_json);
  if(activeTransaction)policySnapshot={value};return value;
 };
 function audit(context,event,item=null,detail={},issuer=null){
  db.prepare('INSERT INTO native_jubian_admission_audit(company_id,admission_id,operation_id,event,actor_id,session_id,device_id,issuer_id,policy_revision,detail_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
   .run(item?.company_id??null,item?.admission_id??null,item?.operation_id??null,event,context.accountId,context.sessionId,context.deviceId,issuer,item?.policy_revision??null,JSON.stringify(detail),now());
 }
 function install(value){
  const next=policy(value),current=readPolicy();
  if(current!==null&&next.revision<current.revision)throw fail('policy_revision_stale',409);
  if(current?.revision===next.revision){if(digest(current)!==digest(next))throw fail('policy_revision_conflict',409);return {policy_revision:next.revision,replayed:true};}
  db.prepare('INSERT INTO native_jubian_admission_policies VALUES(?,?,?,?)').run(next.revision,digest(next),JSON.stringify(next),now());
  policySnapshot=undefined;
  audit({accountId:'system:configuration',sessionId:null,deviceId:null},'policy-installed',{policy_revision:next.revision},{sha256:digest(next)});
  return {policy_revision:next.revision,replayed:false};
 }
 try{transaction(()=>install(config.policy));}catch(error){db.close();throw error;}
 const sources=createNativeJubianSources({db,config:config.sources,accounts,readPolicy,nativeApprovals,now,audit});
 const projectFor=(company,providerOrigin,scriptId)=>company.projects.find(project=>project.providerOrigin===providerOrigin&&project.scriptId===scriptId)
  ??sources.project(company.id,providerOrigin,scriptId);
 const projectsFor=company=>[...company.projects,...sources.projects(company.id).filter(project=>!company.projects.some(base=>base.providerOrigin===project.providerOrigin&&base.scriptId===project.scriptId))];
 function targetKey(target){return target.kind==='company'?'company':target.kind==='member'?'member:'+target.account_id:'project:'+target.provider_origin+':'+target.script_id;}
 function runtime(company,target,base){
  const saved=db.prepare('SELECT limit_minor,revision FROM native_jubian_admission_budget_overrides WHERE company_id=? AND target_key=?').get(company.id,targetKey(target));
  return {limitMinor:saved===undefined?base:target.kind==='company'?Math.min(saved.limit_minor,company.limitMinor):saved.limit_minor,
   revision:saved?.revision??0};
 }
 function selection(context,item,write=true,historical=false){
  const live=accounts.get(context.accountId);
  if(!live||live.disabled)throw fail('account_forbidden',403);
  const current=readPolicy(),company=current.companies.find(value=>value.id===item.company_id),member=nativeJubianMember(company,context.accountId,accounts);
  if(!company||!member?.active||write&&member.role==='viewer')throw fail('member_forbidden',403);
  const project=projectFor(company,item.provider_origin,item.script_id);
  if(!project?.active&&!historical)throw fail('project_forbidden',403);
  return {current,company,member,project};
 }
 const existing=item=>db.prepare('SELECT * FROM native_jubian_admission_operations WHERE company_id=? AND operation_id=?').get(item.company_id,item.operation_id);
 function matching(row,item){if(row.identity_sha256!==businessDigest(item.descriptor))throw fail('operation_conflict');}
 function canonical(context,item){return {provider:'jubian',account_id:context.accountId,login_session_id:context.sessionId,device_id:context.deviceId,...item.descriptor};}
 function totals(where,parameters,excluded=[]){
  const clause=excluded.length?' AND admission_id NOT IN('+excluded.map(()=>'?').join(',')+')':'';
  return db.prepare(`SELECT COALESCE(SUM(CASE WHEN phase='cancelled' THEN 0 ELSE amount_minor END),0) AS used_minor,COALESCE(SUM(CASE WHEN phase IN('reserved','unknown') THEN amount_minor ELSE 0 END),0) AS held_minor,COALESCE(SUM(CASE WHEN phase IN('reserved','unknown') THEN 1 ELSE 0 END),0) AS active FROM native_jubian_admission_operations WHERE ${where}${clause}`).get(...parameters,...excluded);
 }
 function scopes(context,item,chosen,excluded){
  const definitions=[['company',chosen.company,{kind:'company'},'company_id=?',[item.company_id]],
   ['member',chosen.member,{kind:'member',account_id:context.accountId},'company_id=? AND actor_id=?',[item.company_id,context.accountId]],
   ['project',chosen.project,{kind:'project',provider_origin:item.provider_origin,script_id:item.script_id},'company_id=? AND provider_origin=? AND script_id=?',[item.company_id,item.provider_origin,item.script_id]]];
  return Object.fromEntries(definitions.map(([name,limit,target,where,parameters])=>{
   const used=totals(where,parameters,excluded),current=runtime(chosen.company,target,limit.limitMinor);
   return [name,{limit_minor:chosen.company.budgetMode==='provider'?null:current.limitMinor,
    target_revision:current.revision,max_parallel:limit.maxParallel,...used,
    available_minor:chosen.company.budgetMode==='provider'?null:Math.max(0,current.limitMinor-used.used_minor)}];
  }));
 }
 function resourceBusy(item,planned=[],excluded=[]){
  const clause=excluded.length?' AND admission_id NOT IN('+excluded.map(()=>'?').join(',')+')':'';
  const held=db.prepare('SELECT resource_kind AS kind,resource_id AS id FROM native_jubian_admission_resources WHERE company_id=? AND provider_origin=? AND script_id=? AND released_at IS NULL'+clause).all(item.company_id,item.provider_origin,item.script_id,...excluded);
  const prior=planned.filter(value=>value.company_id===item.company_id&&value.provider_origin===item.provider_origin&&value.script_id===item.script_id)
   .flatMap(value=>value.resources.map(resource=>({kind:resource.kind,id:storedResourceId(resource)})));
  return [...held,...prior].some(a=>item.resources.some(b=>a.kind==='project'||b.kind==='project'||a.kind===b.kind&&a.id===storedResourceId(b)));
 }
 function quote(context,item,chosen,planned=[],excluded=[]){
  if(item.policy_revision!==chosen.current.revision)throw fail('policy_revision_changed');
  const limits=scopes(context,item,chosen,excluded);
  for(const [name,value]of Object.entries(limits)){
   const prior=planned.filter(other=>other.company_id===item.company_id
    &&(name!=='member'||other.queue_actor_id===undefined||other.queue_actor_id===context.accountId)
    &&(name!=='project'||other.provider_origin===item.provider_origin&&other.script_id===item.script_id));
   const amount=prior.reduce((total,other)=>total+other.amount_minor,0);
   value.used_minor+=amount;value.held_minor+=amount;value.active+=prior.length;
   value.available_minor=value.limit_minor===null?null:Math.max(0,value.limit_minor-value.used_minor);
  }
  const providerBudget=chosen.company.budgetMode==='provider';
  const available=providerBudget?null:Math.min(...Object.values(limits).map(value=>value.available_minor));
  return {allowed:true,policy_revision:chosen.current.revision,budget_mode:providerBudget?'provider':'company',
   within_limit:providerBudget||item.amount_minor<=available,
   capacity_ready:Object.values(limits).every(value=>value.active<value.max_parallel),resource_ready:!resourceBusy(item,planned,excluded),
   available_minor:available,scopes:limits,canonical:canonical(context,item),native_approval_required:PAID_METHODS.has(item.method),
   native_approval_available:typeof nativeApprovals?.verify==='function'};
 }
 function queueItems(values){
  if(!Array.isArray(values)||!values.length||values.length>config.maxBatchItems)throw fail('batch_limit',400);
  const parsed=values.map(value=>{strict(value,COMMON);return input(value,'quote').descriptor;});
  if(new Set(parsed.map(value=>value.company_id)).size!==1||new Set(parsed.map(value=>value.operation_id)).size!==parsed.length)throw fail('batch_identity_conflict');
  return parsed;
 }
 const scheduler=createNativeJubianScheduler({db,config:config.scheduler,now,audit,select:selection,parse:queueItems,
  hasCompanyCapacity(companyId,offeredItems){
   const company=readPolicy().companies.find(company=>company.id===companyId);
   return company!==undefined&&totals('company_id=?',[companyId]).active+offeredItems<company.maxParallel;
  },
  ready(context,items,held){
   const planned=[...held];
   for(const descriptor of items){
    const item={descriptor,...descriptor},chosen=selection(context,item);
    if(item.policy_revision!==chosen.current.revision)return {ready:false,reason:'policy_revision_changed'};
    const available=quote(context,item,chosen,planned);
    if(!available.within_limit)return {ready:false,reason:'budget_exceeded'};
    if(!available.capacity_ready)return {ready:false,reason:'capacity_exceeded'};
    if(!available.resource_ready)return {ready:false,reason:'resource_busy'};
    planned.push({...descriptor,queue_actor_id:context.accountId});
   }
   return {ready:true,reason:null};
  }});
 function queueRequest(caller,value){
  if(value.type==='queue_join'){
   strict(value,['type','company_id','queue_key','items']);
   if(!id(value.company_id)||!id(value.queue_key))throw fail('invalid_queue_request',400);
   const values=queueItems(value.items);
   if(values.some(item=>item.company_id!==value.company_id))throw fail('batch_identity_conflict');
   for(const item of values)if(existing(item))throw fail('queue_operation_already_reserved');
   return scheduler.join(caller,value.company_id,value.queue_key,values);
  }
  strict(value,['type','company_id','queue_id']);
  if(!id(value.company_id)||!id(value.queue_id))throw fail('invalid_queue_request',400);
  if(!['queue_status','queue_cancel'].includes(value.type))throw fail('invalid_queue_request',400);
  return scheduler[value.type==='queue_status'?'status':'cancel'](caller,value.company_id,value.queue_id);
 }
 function verifiedGrant(grant,expected){
  if(!object(grant)||typeof grant.grant_id!=='string'||!grant.grant_id.length||grant.grant_id.length>256||!hash(grant.issuer_id)
   ||!positive(grant.expires_at)||grant.expires_at<=now())throw fail('native_grant_invalid',403);
  return {grant,canonical:expected};
 }
 function verify(context,item){
  if(FREE_METHODS.has(item.method))return null;
  if(typeof nativeApprovals?.verify!=='function')throw fail('native_approval_unavailable',503);
  const expected=canonical(context,item);
  return verifiedGrant(nativeApprovals.verify(context,item.approval_proof,expected),expected);
 }
 function observationCanonical(context,row,item,revision){
  return {...canonical(context,{descriptor:JSON.parse(row.descriptor_json)}),operation_actor_id:row.actor_id,
   admission_id:row.admission_id,attempt_id:row.attempt_id,current_policy_revision:revision,state:item.state,
   observation_sha256:item.observation_sha256};
 }
 function observed(row,item){
  if(row.phase!==item.state)throw fail('terminal_conflict');
  const previous=db.prepare('SELECT detail_json FROM native_jubian_admission_audit WHERE admission_id=? AND event=? ORDER BY sequence LIMIT 1')
   .get(row.admission_id,'observed-'+row.phase);
  if(previous===undefined||JSON.parse(previous.detail_json).observation_sha256!==item.observation_sha256)throw fail('observation_conflict');
 }
 function consume(row,verified){
  if(verified===null)return;
  const {grant,canonical:expected}=verified,prior=db.prepare('SELECT * FROM native_jubian_admission_grants WHERE grant_id=?').get(grant.grant_id);
  if(db.prepare('SELECT 1 FROM native_jubian_admission_budget_changes WHERE grant_id=?').get(grant.grant_id))throw fail('native_grant_consumed',403);
  if(db.prepare('SELECT 1 FROM native_jubian_source_grants WHERE grant_id=?').get(grant.grant_id))throw fail('native_grant_consumed',403);
  if(prior){if(prior.admission_id!==row.admission_id||prior.canonical_sha256!==digest(expected))throw fail('native_grant_consumed',403);return;}
  db.prepare('INSERT INTO native_jubian_admission_grants VALUES(?,?,?,?,?,?)').run(grant.grant_id,row.admission_id,grant.issuer_id,digest(expected),grant.expires_at,now());
 }
 function receipt(row,extra={}){return {allowed:true,admission_id:row.admission_id,attempt_id:row.attempt_id,operation_id:row.operation_id,
  request_sha256:row.request_sha256,company_id:row.company_id,provider_origin:row.provider_origin,script_id:row.script_id,
  state:row.phase,amount_minor:row.amount_minor,policy_revision:row.policy_revision,dispatch_allowed:false,descriptor:JSON.parse(row.descriptor_json),...extra};}
 function reserve(context,item,chosen,planned=[]){
  const remaining=quote(context,item,chosen,planned);
  if(!remaining.within_limit)throw fail('budget_exceeded');
  if(!remaining.capacity_ready)throw fail('capacity_exceeded',429);
  if(!remaining.resource_ready)throw fail('resource_busy');
  const verified=verify(context,item),time=now(),row={admission_id:randomUUID(),company_id:item.company_id,provider_origin:item.provider_origin,
   script_id:item.script_id,operation_id:item.operation_id,actor_id:context.accountId,attempt_id:item.attempt_id,method:item.method,
   request_sha256:item.request_sha256,identity_sha256:businessDigest(item.descriptor),descriptor_json:JSON.stringify(item.descriptor),amount_minor:item.amount_minor,
   policy_revision:item.policy_revision,phase:'reserved',created_at:time,updated_at:time};
  db.prepare('INSERT INTO native_jubian_admission_operations VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
   .run(...Object.values(row));
  for(const resource of item.resources)db.prepare('INSERT INTO native_jubian_admission_resources VALUES(?,?,?,?,?,?,NULL)')
   .run(row.admission_id,item.company_id,item.provider_origin,item.script_id,resource.kind,storedResourceId(resource));
  consume(row,verified);audit(context,'reserved',row,{method:item.method,amount_minor:item.amount_minor,request_sha256:item.request_sha256},verified?.grant.issuer_id??null);
  return receipt(row,{replayed:false});
 }
 function release(row,phase){
  db.prepare('UPDATE native_jubian_admission_operations SET phase=?,updated_at=? WHERE admission_id=?').run(phase,now(),row.admission_id);
  db.prepare('UPDATE native_jubian_admission_resources SET released_at=? WHERE admission_id=? AND released_at IS NULL').run(now(),row.admission_id);
  return {...row,phase};
 }
 function process(context,item){
  const row=existing(item),recover=!!row&&['status','cancel','settle','observation_quote'].includes(item.type);
  const chosen=selection(context,item,!['quote','status','cancel','settle','observation_quote'].includes(item.type),recover);
  if(row)matching(row,item);
  if(item.type==='quote'){
   if(row&&row.actor_id!==context.accountId)throw fail('operation_forbidden',403);
   return quote(context,item,chosen,[],row?.phase==='reserved'?[row.admission_id]:[]);
  }
  if(item.type==='status')return row?receipt(row,{replayed:true,current_policy_revision:chosen.current.revision}):{allowed:true,state:'missing',dispatch_allowed:false};
  if(row&&row.actor_id!==context.accountId&&!['owner','admin'].includes(chosen.member.role))throw fail('operation_forbidden',403);
  if(item.type==='reserve'){
   if(row){if(row.attempt_id!==item.attempt_id)throw fail('attempt_conflict');return receipt(row,{allowed:false,replayed:true});}
   return reserve(context,item,chosen);
  }
  if(!row||row.admission_id!==item.admission_id||row.attempt_id!==item.attempt_id)throw fail('attempt_required');
  if(item.type==='observation_quote'){
   if(row.phase==='reserved'||row.phase==='cancelled')throw fail('dispatch_not_started');
   if(row.phase!=='unknown')observed(row,item);
   return {allowed:true,state:row.phase,replayed:row.phase!=='unknown',
    observation_approval_available:typeof nativeApprovals?.verifyObservation==='function',
    canonical:observationCanonical(context,row,item,chosen.current.revision)};
  }
  if(item.type==='cancel'){
   if(row.phase==='cancelled')return receipt(row,{replayed:true});
   if(row.phase!=='reserved')throw fail('dispatch_may_have_started');
   const next=release(row,'cancelled');audit(context,'cancelled',next,{reason:'not_dispatched',released_minor:row.amount_minor});return receipt(next,{replayed:false});
  }
  if(item.type==='dispatch'){
   if(row.phase!=='reserved')return receipt(row,{allowed:false,replayed:true});
   if(row.actor_id!==context.accountId)throw fail('operation_forbidden',403);
   if(item.policy_revision!==chosen.current.revision)throw fail('policy_revision_changed');
   const availability=quote(context,item,chosen,[],[row.admission_id]);
   if(!availability.within_limit)throw fail('budget_exceeded');
   if(!availability.capacity_ready)throw fail('capacity_exceeded',429);
   if(!availability.resource_ready)throw fail('resource_busy');
   const verified=verify(context,item);consume(row,verified);
   db.prepare("UPDATE native_jubian_admission_operations SET phase='unknown',updated_at=? WHERE admission_id=? AND phase='reserved'").run(now(),row.admission_id);
   audit(context,'dispatch-permitted',row,{request_sha256:item.request_sha256},verified?.grant.issuer_id??null);
   return receipt({...row,phase:'unknown'},{dispatch_allowed:true,replayed:false});
  }
  if(item.type==='settle'){
   if(row.phase==='reserved'||row.phase==='cancelled')throw fail('dispatch_not_started');
   if(['completed','failed'].includes(row.phase)){
    observed(row,item);return receipt(row,{replayed:true});
   }
   let observation=null;
   if(item.state!=='unknown'){
    if(typeof nativeApprovals?.verifyObservation!=='function')throw fail('observation_approval_unavailable',503);
    const expected=observationCanonical(context,row,item,chosen.current.revision);
    observation=verifiedGrant(nativeApprovals.verifyObservation(context,item.observation_proof,expected),expected);
    consume(row,observation);
   }
   const next=item.state==='unknown'?row:release(row,item.state);
   audit(context,'observed-'+item.state,next,{observation_sha256:item.observation_sha256??null,
    grant_id:observation?.grant.grant_id??null,canonical_sha256:observation===null?null:digest(observation.canonical)},observation?.grant.issuer_id??null);
   return receipt(next,{replayed:false});
  }
  throw fail('invalid_request',400);
 }
 function budget(context,value){
  const update=value.type==='budget_update';
  strict(value,['type','company_id','change_id','target','new_limit_minor',...update?['expected_revision','base_policy_revision','budget_proof']:[]]);
  if(!id(value.company_id)||!id(value.change_id)||!integer(value.new_limit_minor)||!object(value.target)
   ||!['company','member','project'].includes(value.target.kind))throw fail('invalid_budget_request',400);
  const kind=value.target.kind;
  strict(value.target,kind==='company'?['kind']:kind==='member'?['kind','account_id']:['kind','provider_origin','script_id']);
  if(kind==='member'&&!account(value.target.account_id)||kind==='project'&&!positive(value.target.script_id))throw fail('invalid_budget_target',400);
  if(update&&(!integer(value.expected_revision)||!positive(value.base_policy_revision)))throw fail('invalid_budget_revision',400);
  const target=kind==='company'?{kind}:kind==='member'?{kind,account_id:value.target.account_id}
   :{kind,provider_origin:origin(value.target.provider_origin),script_id:value.target.script_id};
  const current=readPolicy(),company=current.companies.find(row=>row.id===value.company_id),member=nativeJubianMember(company,context.accountId,accounts),live=accounts.get(context.accountId);
  if(!live||live.disabled)throw fail('account_forbidden',403);
  if(!member?.active)throw fail('member_forbidden',403);
  const admin=['owner','admin'].includes(member.role),key=targetKey(target);
  const saved=db.prepare('SELECT * FROM native_jubian_admission_budget_changes WHERE company_id=? AND change_id=?').get(company.id,value.change_id);
  if(saved){
   const canonical=JSON.parse(saved.canonical_json);
   if(saved.actor_id!==context.accountId&&!admin)throw fail('budget_change_forbidden',403);
   if(saved.target_key!==key||canonical.new_limit_minor!==value.new_limit_minor
    ||update&&(canonical.target_revision!==value.expected_revision||canonical.base_policy_revision!==value.base_policy_revision))throw fail('budget_change_conflict');
   return {allowed:true,state:'applied',replayed:true,canonical,target_revision:saved.revision};
  }
  if(company.budgetMode==='provider')throw fail('provider_budget_managed');
  if(member.role==='viewer'||kind==='company'&&!admin||kind==='member'&&target.account_id!==context.accountId&&!admin)throw fail('budget_target_forbidden',403);
  const targetMember=kind==='member'?nativeJubianMember(company,target.account_id,accounts):null;
  const project=kind==='project'?projectFor(company,target.provider_origin,target.script_id):null;
  if(kind==='member'&&!targetMember||kind==='project'&&!project?.active)throw fail('budget_target_forbidden',403);
  const companyRuntime=runtime(company,{kind:'company'},company.limitMinor),companyUsage=totals('company_id=?',[company.id]);
  const scope=kind==='company'?{base:company.limitMinor,usage:companyUsage}:kind==='member'
   ?{base:targetMember.limitMinor,usage:totals('company_id=? AND actor_id=?',[company.id,target.account_id])}
   :{base:project.limitMinor,usage:totals('company_id=? AND provider_origin=? AND script_id=?',[company.id,target.provider_origin,target.script_id])};
  const prior=runtime(company,target,scope.base),available=Math.max(0,companyRuntime.limitMinor-companyUsage.used_minor);
  if(value.new_limit_minor<scope.usage.used_minor)throw fail('budget_below_usage');
  if(kind==='company'&&value.new_limit_minor>company.limitMinor
   ||kind!=='company'&&value.new_limit_minor>prior.limitMinor
    &&(value.new_limit_minor>companyRuntime.limitMinor||value.new_limit_minor-scope.usage.used_minor>available))throw fail('budget_increase_exceeds_company');
  const canonical={provider:'jubian',account_id:context.accountId,login_session_id:context.sessionId,device_id:context.deviceId,
   company_id:company.id,change_id:value.change_id,currency:'CNY',target,previous_limit_minor:prior.limitMinor,
   new_limit_minor:value.new_limit_minor,target_revision:prior.revision,base_policy_revision:current.revision};
  if(!update)return {allowed:true,state:'quoted',replayed:false,canonical,target_revision:prior.revision,
   company_available_minor:available,minimum_limit_minor:scope.usage.used_minor,budget_approval_available:typeof nativeApprovals?.verifyBudget==='function'};
  if(value.expected_revision!==prior.revision||value.base_policy_revision!==current.revision)throw fail('budget_revision_conflict');
  if(typeof nativeApprovals?.verifyBudget!=='function')throw fail('budget_approval_unavailable',503);
  const verified=verifiedGrant(nativeApprovals.verifyBudget(context,value.budget_proof,canonical),canonical),grant=verified.grant;
  if(db.prepare('SELECT 1 FROM native_jubian_admission_grants WHERE grant_id=?').get(grant.grant_id)
   ||db.prepare('SELECT 1 FROM native_jubian_admission_budget_changes WHERE grant_id=?').get(grant.grant_id)
   ||db.prepare('SELECT 1 FROM native_jubian_source_grants WHERE grant_id=?').get(grant.grant_id))throw fail('native_grant_consumed',403);
  const revision=prior.revision+1;if(!positive(revision))throw fail('budget_revision_exhausted');
  const time=now(),updated=db.prepare('INSERT INTO native_jubian_admission_budget_overrides VALUES(?,?,?,?,?,?) ON CONFLICT(company_id,target_key) DO UPDATE SET target_json=excluded.target_json,limit_minor=excluded.limit_minor,revision=excluded.revision,updated_at=excluded.updated_at WHERE native_jubian_admission_budget_overrides.revision=?')
   .run(company.id,key,JSON.stringify(target),value.new_limit_minor,revision,time,prior.revision);
  if(updated.changes!==1)throw fail('budget_revision_conflict');
  db.prepare('INSERT INTO native_jubian_admission_budget_changes VALUES(?,?,?,?,?,?,?,?,?)')
   .run(company.id,value.change_id,context.accountId,key,JSON.stringify(canonical),revision,grant.grant_id,grant.issuer_id,time);
  audit(context,'budget-updated',{company_id:company.id,policy_revision:current.revision},{change_id:value.change_id,target,
   previous_limit_minor:prior.limitMinor,new_limit_minor:value.new_limit_minor,target_revision:revision,grant_id:grant.grant_id},grant.issuer_id);
  return {allowed:true,state:'applied',replayed:false,canonical,target_revision:revision};
 }
 function run(context,value){
  const caller=actor(context);
  if(typeof value?.type==='string'&&value.type.startsWith('queue_'))return transaction(()=>queueRequest(caller,value));
  if(typeof value?.type==='string'&&value.type.startsWith('source_'))return transaction(()=>sources.request(caller,value));
  if(['budget_quote','budget_update'].includes(value?.type))return transaction(()=>budget(caller,value));
  if(value?.type==='policy'){
   strict(value,['type','company_id']);if(!id(value.company_id))throw fail('invalid_request',400);
   return transaction(()=>{
    const live=accounts.get(caller.accountId);if(!live||live.disabled)throw fail('account_forbidden',403);
    const current=readPolicy(),company=current.companies.find(company=>company.id===value.company_id),member=nativeJubianMember(company,caller.accountId,accounts);
    if(!member?.active)throw fail('member_forbidden',403);
    const companyUsage=totals('company_id=?',[company.id]),memberUsage=totals('company_id=? AND actor_id=?',[company.id,caller.accountId]);
    const companyRuntime=runtime(company,{kind:'company'},company.limitMinor),memberRuntime=runtime(company,{kind:'member',account_id:caller.accountId},member.limitMinor);
    const providerBudget=company.budgetMode==='provider';
    return {company_id:company.id,policy_revision:current.revision,currency:'CNY',role:member.role,
     budget_mode:providerBudget?'provider':'company',
     company_limit_minor:providerBudget?null:companyRuntime.limitMinor,
     company_base_limit_minor:providerBudget?null:company.limitMinor,company_target_revision:companyRuntime.revision,
     member_limit_minor:providerBudget?null:memberRuntime.limitMinor,member_target_revision:memberRuntime.revision,
     company_used_minor:companyUsage.used_minor,company_held_minor:companyUsage.held_minor,company_active:companyUsage.active,
     company_available_minor:providerBudget?null:Math.max(0,companyRuntime.limitMinor-companyUsage.used_minor),company_max_parallel:company.maxParallel,
     member_used_minor:memberUsage.used_minor,member_held_minor:memberUsage.held_minor,member_active:memberUsage.active,
     member_available_minor:providerBudget?null:Math.max(0,memberRuntime.limitMinor-memberUsage.used_minor),member_max_parallel:member.maxParallel,
     projects:projectsFor(company).map(project=>{
      const usage=totals('company_id=? AND provider_origin=? AND script_id=?',[company.id,project.providerOrigin,project.scriptId]),
       current=runtime(company,{kind:'project',provider_origin:project.providerOrigin,script_id:project.scriptId},project.limitMinor);
      return {provider_origin:project.providerOrigin,script_id:project.scriptId,active:project.active,
       limit_minor:providerBudget?null:current.limitMinor,target_revision:current.revision,
       max_parallel:project.maxParallel,used_minor:usage.used_minor,held_minor:usage.held_minor,
       active_count:usage.active,available_minor:providerBudget?null:Math.max(0,current.limitMinor-usage.used_minor)};
     })};
   });
  }
  const batch=['quote_batch','reserve_batch'].includes(value?.type);
  let items;
  if(batch){strict(value,['type','items',...value.type==='reserve_batch'?['queue_id']:[]]);if(!Array.isArray(value.items)||!value.items.length||value.items.length>config.maxBatchItems)throw fail('batch_limit',400);
   const type=value.type==='quote_batch'?'quote':'reserve';items=value.items.map(value=>input(value,type));
   if(new Set(items.map(item=>item.company_id)).size!==1||new Set(items.map(item=>item.operation_id)).size!==items.length)throw fail('batch_identity_conflict');
  }else items=[input(value,value?.type)];
  try{return transaction(()=>{
   if(!batch){
    const item=items[0],turn=item.type==='reserve'&&!existing(item)&&scheduler.enabled?scheduler.claim(caller,value.queue_id,[item.descriptor]):undefined;
    const result=process(caller,item);scheduler.consume(caller,turn);return result;
   }
   const chosen=items.map(item=>selection(caller,item,value.type==='reserve_batch'));
   const prior=items.map(item=>existing(item));prior.forEach((row,index)=>{if(row)matching(row,items[index]);});
   if(value.type==='reserve_batch'&&prior.some(Boolean)){
    if(!prior.every(Boolean))throw fail('batch_partial_replay');
    return {allowed:false,replayed:true,items:prior.map((row,index)=>{
     if(row.actor_id!==caller.accountId||row.attempt_id!==items[index].attempt_id)throw fail('operation_forbidden',403);
     return receipt(row,{allowed:false,replayed:true});})};
   }
   if(value.type==='quote_batch'){
    if(prior.some(row=>row&&row.actor_id!==caller.accountId))throw fail('operation_forbidden',403);
    const excluded=prior.filter(row=>row?.phase==='reserved').map(row=>row.admission_id);
    const planned=[],quotes=items.map((item,index)=>{const result=quote(caller,item,chosen[index],planned,excluded);planned.push(item);return result;});
    return {allowed:true,policy_revision:chosen[0].current.revision,
     budget_mode:chosen[0].company.budgetMode==='provider'?'provider':'company',within_limit:quotes.every(item=>item.within_limit),
     capacity_ready:quotes.every(item=>item.capacity_ready),resource_ready:quotes.every(item=>item.resource_ready),items:quotes};
   }
   const turn=scheduler.enabled?scheduler.claim(caller,value.queue_id,items.map(item=>item.descriptor)):undefined;
   const result={allowed:true,replayed:false,items:items.map((item,index)=>reserve(caller,item,chosen[index]))};
   scheduler.consume(caller,turn);return result;
  });}catch(error){
   const code=typeof error.code==='string'&&/^(?:native_jubian_admission_|production_fee_|native_jubian_)[a-z0-9_]{1,100}$/.test(error.code)?error.code:'native_jubian_admission_transaction_failed';
   transaction(()=>audit(caller,'rejected',items[0],{code,operation_ids:items.map(item=>item.operation_id)}));
   throw error;
  }
 }
 return {
  /** Whether new reservations require a durable fair turn in this deployment. */
  queueEnabled:scheduler.enabled,
  /** Read effective quotas or apply signed budget, reservation and observation transactions using transport-authenticated identity. */
  request:run,
  /** Install only trusted operator policy; this method must never be forwarded from a model or public HTTP body. */
  installPolicy(value){return transaction(()=>install(value));},
  /** Stop accepting requests after transport work has drained; repeated close calls are harmless. */
  close(){if(closed)return;closed=true;db.close();},
 };
}

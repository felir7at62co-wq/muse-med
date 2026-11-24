/** Login-consented device issuers and exact, expiring production fee challenges. */
import {createHash,createPublicKey,randomBytes,randomUUID,verify as verifySignature} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {mkdir,lstat,open,readFile,realpath} from 'node:fs/promises';
import {dirname,isAbsolute,resolve} from 'node:path';
import {createNativeJubianApprovals} from './native-jubian-approvals.mjs';

const fail=(code,status=409)=>Object.assign(Error(code),{code,status});
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const hash=value=>createHash('sha256').update(value).digest('hex');
const sha=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const accountId=value=>typeof value==='string'&&/^[a-f0-9]{16}$/.test(value);
const positive=value=>Number.isSafeInteger(value)&&value>0;
const operation=value=>typeof value==='string'&&/^[A-Za-z0-9_.:-]{8,256}$/.test(value);
const challengeId=value=>typeof value==='string'&&/^[a-f0-9-]{36}$/.test(value);
const frozenKeys=['provider','project_id','database_id','storyboard_id','revision_id','operation_id','request_sha256','quote_sha256','provider_connection_revision','currency','amount_minor'];
function expected(value){
 if(!object(value)||value.provider!=='jubian'||!positive(value.project_id)||!positive(value.storyboard_id)
  ||typeof value.database_id!=='string'||!/^[a-f0-9-]{36}$/.test(value.database_id)
  ||typeof value.revision_id!=='string'||!value.revision_id||value.revision_id.length>128||!operation(value.operation_id)
  ||!sha(value.request_sha256)||!sha(value.quote_sha256)||!sha(value.provider_connection_revision)
  ||value.currency!=='CNY'||!positive(value.amount_minor))throw fail('production_fee_invalid_request',400);
 return Object.fromEntries(frozenKeys.map(key=>[key,value[key]]));
}
function issuerKey(value){
 if(!object(value)||!sha(value.issuerId)||typeof value.publicKey!=='string'||value.publicKey.length>2048
  ||!/^-----BEGIN PUBLIC KEY-----\r?\n[A-Za-z0-9+/=\r\n]+-----END PUBLIC KEY-----\r?\n?$/.test(value.publicKey)
  ||typeof value.deviceName!=='string'||!value.deviceName.trim()||value.deviceName.length>80||/[\x00-\x1f\x7f]/.test(value.deviceName))throw fail('production_fee_invalid_issuer',400);
 let key;try{key=createPublicKey(value.publicKey);}catch(error){throw fail('production_fee_invalid_issuer',400);}
 if(key.asymmetricKeyType!=='ed25519'||hash(key.export({type:'spki',format:'der'}))!==value.issuerId)throw fail('production_fee_invalid_issuer',400);
 return {issuerId:value.issuerId,publicKey:key.export({type:'spki',format:'pem'}),deviceName:value.deviceName};
}

/** Validate the administrator's dedicated fee store and bounded challenge policy.
 * @param {object} value Private deployment configuration.
 * @returns {object} Complete configuration without inferred spending allowances.
 */
export function resolveProductionFeeConfig(value){
 const keys=['version','databaseFile','challengeTtlMs','maxPendingPerAccount','busyTimeoutMs','maxIssuersPerAccount'];
 if(!object(value)||Object.keys(value).some(key=>!keys.includes(key))||value.version!==1
  ||typeof value.databaseFile!=='string'||!isAbsolute(value.databaseFile)||value.databaseFile.includes('\0')
  ||!positive(value.challengeTtlMs)||value.challengeTtlMs<1000||value.challengeTtlMs>900000
  ||!positive(value.maxPendingPerAccount)||value.maxPendingPerAccount>1000
  ||!positive(value.busyTimeoutMs)||value.busyTimeoutMs>60000
  ||!positive(value.maxIssuersPerAccount)||value.maxIssuersPerAccount>1000)throw fail('production_fee_invalid_configuration',500);
 return {...value,databaseFile:resolve(value.databaseFile)};
}

/** Open a dedicated issuer/challenge store; no project, media, account or historical ledger is migrated.
 * @param {object} options Private config, current account reader, exact gateway origin and optional clock.
 * @returns {Promise<object>} Issuer enrollment for the login consent owner and synchronous grant validation.
 */
export async function openProductionFees({config:input,accounts,publicOrigin,now=Date.now}){
 const config=resolveProductionFeeConfig(input),url=new URL(publicOrigin);
 if(url.origin!==publicOrigin||url.username||url.password||!['https:','http:'].includes(url.protocol)
  ||url.protocol==='http:'&&!['127.0.0.1','localhost','[::1]'].includes(url.hostname)||typeof accounts?.get!=='function')throw fail('production_fee_invalid_configuration',500);
 const parent=dirname(config.databaseFile);await mkdir(parent,{recursive:true,mode:0o700});
 const directory=await lstat(parent),actual=await realpath(parent);
 if(!directory.isDirectory()||directory.isSymbolicLink()||(process.platform==='win32'?actual.toLowerCase()!==parent.toLowerCase():actual!==parent)
  ||process.platform!=='win32'&&(directory.mode&0o077)!==0)throw fail('production_fee_private_storage_required',500);
 try{const file=await open(config.databaseFile,'wx',0o600);await file.close();}catch(error){if(error.code!=='EEXIST')throw error;}
 const info=await lstat(config.databaseFile);
 if(!info.isFile()||info.isSymbolicLink()||process.platform!=='win32'&&(info.mode&0o077)!==0)throw fail('production_fee_private_storage_required',500);
 const db=new DatabaseSync(config.databaseFile);let closed=false;
 try{
  db.exec('PRAGMA busy_timeout='+config.busyTimeoutMs);
  const names=db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map(row=>row.name);
  if(names.length&&(names.length!==3||names.some(name=>!['muse_fee_schema','muse_fee_issuers','muse_fee_challenges'].includes(name))))throw fail('production_fee_unrelated_database',500);
  if(names.length){const rows=db.prepare('SELECT version FROM muse_fee_schema').all();if(rows.length!==1||rows[0].version!==1)throw fail('production_fee_unsupported_schema',500);}
  db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
  db.exec('BEGIN IMMEDIATE');
  try{
   db.exec(`CREATE TABLE IF NOT EXISTS muse_fee_schema(version INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS muse_fee_issuers(issuer_id TEXT NOT NULL,account_id TEXT NOT NULL,account_revision INTEGER NOT NULL,public_key TEXT NOT NULL,device_name TEXT NOT NULL,enrolled_at INTEGER NOT NULL,PRIMARY KEY(account_id,issuer_id));
    CREATE TABLE IF NOT EXISTS muse_fee_challenges(id TEXT PRIMARY KEY,account_id TEXT NOT NULL,issuer_id TEXT NOT NULL,nonce TEXT NOT NULL,payload TEXT NOT NULL,payload_sha256 TEXT NOT NULL,frozen_sha256 TEXT NOT NULL,expires_at INTEGER NOT NULL,created_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS muse_fee_challenge_owner ON muse_fee_challenges(account_id,expires_at);`);
   if(!names.length)db.prepare('INSERT INTO muse_fee_schema VALUES(1)').run();
   db.exec('COMMIT');
  }catch(error){db.exec('ROLLBACK');throw error;}
 }catch(error){db.close();throw error;}
 function current(id){if(closed)throw fail('production_fee_unavailable',503);const account=accounts.get(id);if(!accountId(id)||!account||account.disabled||!positive(account.revision))throw fail('production_fee_account_forbidden',403);return account;}
 function issuer(actor,id){const account=current(actor),row=db.prepare('SELECT * FROM muse_fee_issuers WHERE issuer_id=? AND account_id=?').get(id,actor);if(!row||row.account_id!==actor||row.account_revision!==account.revision)throw fail('production_fee_enrollment_required',428);return row;}
 function publicChallenge(row){return {version:1,id:row.id,issuer_id:row.issuer_id,nonce:row.nonce,payload:row.payload,payload_sha256:row.payload_sha256,expires_at:row.expires_at};}
 function readChallenge(actor,id){current(actor);if(!challengeId(id))throw fail('production_fee_challenge_missing',404);const row=db.prepare('SELECT * FROM muse_fee_challenges WHERE id=? AND account_id=?').get(id,actor);if(!row)throw fail('production_fee_challenge_missing',404);issuer(actor,row.issuer_id);if(row.expires_at<=now())throw fail('production_fee_challenge_expired',428);return row;}
 const native=createNativeJubianApprovals({db,config,current,issuer,readChallenge,publicChallenge,publicOrigin,now});
 return {...native,
  /** Register a public key only after the separate browser-consent owner has verified proof of possession.
   * @param {object} account Browser-approved, current Muse account.
   * @param {object} value Frozen public issuer from that same login attempt.
   * @returns {object} Nonsecret enrolled issuer identity.
   */
  enroll(account,value){
   const active=current(account.id),key=issuerKey(value);if(active.revision!==account.revision)throw fail('production_fee_account_changed',409);
   db.exec('BEGIN IMMEDIATE');try{
    const old=db.prepare('SELECT * FROM muse_fee_issuers WHERE issuer_id=? AND account_id=?').get(key.issuerId,active.id);
    if(old&&(old.account_id!==active.id||old.public_key!==key.publicKey))throw fail('production_fee_issuer_conflict');
    if(!old&&db.prepare('SELECT COUNT(*) AS count FROM muse_fee_issuers WHERE account_id=? AND account_revision=?').get(active.id,active.revision).count>=config.maxIssuersPerAccount)throw fail('production_fee_issuer_limit',429);
    db.prepare('INSERT INTO muse_fee_issuers VALUES(?,?,?,?,?,?) ON CONFLICT(account_id,issuer_id) DO UPDATE SET account_revision=excluded.account_revision,device_name=excluded.device_name,enrolled_at=excluded.enrolled_at').run(key.issuerId,active.id,active.revision,key.publicKey,key.deviceName,now());
    db.exec('COMMIT');return {ready:true,issuer_id:key.issuerId};
   }catch(error){db.exec('ROLLBACK');throw error;}
  },
  /** Read current issuer readiness; no key, cookie or challenge secret is returned.
   * @param {string} actor Current authenticated account.
   * @param {string} id Requested public issuer fingerprint.
   * @returns {object} Readiness for that account only.
   */
  issuerState(actor,id){current(actor);if(!sha(id))throw fail('production_fee_invalid_issuer',400);try{issuer(actor,id);return {ready:true,issuer_id:id};}catch(error){if(error.code!=='production_fee_enrollment_required')throw error;return {ready:false,issuer_id:id};}},
  /** Freeze a quote challenge from the verified tenant service, never from a public HTTP amount.
   * @param {string} actor Parent-verified account.
   * @param {object} value Exact provider operation plus issuer and bounded display metadata.
   * @returns {object} Public challenge; only the enrolled device can sign an approval.
   */
  createChallenge(actor,value){
   const account=current(actor),key=issuer(actor,value.issuer_id),frozen=expected(value);
   const review=value.review??{};if(!object(review)||JSON.stringify(review).length>4096||Object.values(review).some(item=>!['string','number'].includes(typeof item)))throw fail('production_fee_invalid_request',400);
   const frozenHash=hash(JSON.stringify(frozen)),time=now();
   db.exec('BEGIN IMMEDIATE');try{
    const prior=db.prepare('SELECT * FROM muse_fee_challenges WHERE account_id=? AND issuer_id=? AND frozen_sha256=? AND expires_at>? ORDER BY created_at DESC LIMIT 1').get(actor,key.issuer_id,frozenHash,time);
    if(prior){db.exec('COMMIT');return publicChallenge(prior);}
    if(db.prepare('SELECT COUNT(*) AS count FROM muse_fee_challenges WHERE account_id=? AND expires_at>?').get(actor,time).count>=config.maxPendingPerAccount)throw fail('production_fee_challenge_limit',429);
    const id=randomUUID(),nonce=randomBytes(32).toString('base64url'),expires=time+config.challengeTtlMs;
    const payload=JSON.stringify({version:1,action:'jubian-video',audience:publicOrigin,account_id:actor,account_revision:account.revision,issuer_id:key.issuer_id,...frozen,expires_at:expires,review}),payloadHash=hash(payload);
    db.prepare('INSERT INTO muse_fee_challenges VALUES(?,?,?,?,?,?,?,?,?)').run(id,actor,key.issuer_id,nonce,payload,payloadHash,frozenHash,expires,time);
    const result=publicChallenge(db.prepare('SELECT * FROM muse_fee_challenges WHERE id=?').get(id));db.exec('COMMIT');return result;
   }catch(error){db.exec('ROLLBACK');throw error;}
  },
  /** Read one challenge from the signed-in account; the Host re-reads here before asking and signing.
   * @param {string} actor Authenticated account.
   * @param {string} id Exact challenge ID.
   * @returns {object} Original server challenge.
   */
  challenge(actor,id){const row=readChallenge(actor,id),payload=JSON.parse(row.payload);if(payload.version!==1||payload.action!=='jubian-video')throw fail('production_fee_challenge_missing',404);return publicChallenge(row);},
  /** Verify a native device signature and all frozen fields without consuming a budget allowance.
   * @param {string} actor Parent-authenticated account.
   * @param {object} proof Device signature, issuer and challenge ID; no model approval boolean is accepted.
   * @param {object} value Current exact operation and price; the company transaction owns one-shot grant consumption.
   * @returns {object} Verified grant ID and expiry for atomic company admission.
   */
  verify(actor,proof,value){
   if(!object(proof)||Object.keys(proof).some(key=>!['challenge_id','issuer_id','signature','decision'].includes(key))||proof.decision!=='approved'||!sha(proof.issuer_id)||typeof proof.signature!=='string'||!/^[A-Za-z0-9_-]{86}$/.test(proof.signature))throw fail('production_fee_invalid_proof',403);
   const row=readChallenge(actor,proof.challenge_id),key=issuer(actor,proof.issuer_id),payload=JSON.parse(row.payload),account=current(actor);
   if(payload.version!==1||payload.action!=='jubian-video'||row.issuer_id!==proof.issuer_id||payload.account_revision!==account.revision||row.payload_sha256!==hash(row.payload)||row.frozen_sha256!==hash(JSON.stringify(expected(value))))throw fail('production_fee_grant_changed',409);
   const message='muse-production-fee-v1\n'+row.id+'\n'+row.nonce+'\n'+row.payload_sha256+'\napproved';
   if(!verifySignature(null,Buffer.from(message),key.public_key,Buffer.from(proof.signature,'base64url')))throw fail('production_fee_invalid_proof',403);
   return {grant_id:row.id,issuer_id:key.issuer_id,expires_at:row.expires_at};
  },
  /** Stop admission only after every worker has drained its private callbacks. */
  close(){if(closed)return;closed=true;db.close();},
 };
}

/** Load an optional private fee authority configuration; absence disables native paid approval.
 * @param {string|undefined} file Absolute administrator-owned JSON file.
 * @param {object} options Current accounts, gateway origin and optional clock.
 * @returns {Promise<object|undefined>} Fee authority when explicitly configured.
 */
export async function loadProductionFees(file,options){
 if(file===undefined)return;
 if(typeof file!=='string'||!isAbsolute(file))throw fail('production_fee_private_configuration_required',500);
 const info=await lstat(file);if(!info.isFile()||info.isSymbolicLink()||info.size>65536||process.platform!=='win32'&&(info.mode&0o077)!==0)throw fail('production_fee_private_configuration_required',500);
 return openProductionFees({...options,config:JSON.parse(await readFile(file,'utf8'))});
}

/** Bind private worker requests to the issuer authority and transactional company admission.
 * @param {object} options Separately owned company ledger and optional fee authority.
 * @returns {object|undefined} Parent-only callback adapter; no browser-supplied actor is accepted.
 */
export function productionAuthority({company,fees}){
 if(!company)return;
 return {request(actor,input){
  if(input?.type==='capabilities')return {nativeApprovalAvailable:!!fees,companyAdmissionAvailable:true};
  if(['challenge','verifyGrant'].includes(input?.type)){
   if(!fees)throw fail('production_fee_unavailable',503);
   return input.type==='challenge'?fees.createChallenge(actor,input):fees.verify(actor,input.approval_proof,input);
  }
  return company.request(actor,input);
 }};
}

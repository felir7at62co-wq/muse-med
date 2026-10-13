import {createHash,randomBytes} from 'node:crypto';
import {chmod,mkdir,readFile,rename,rm,writeFile} from 'node:fs/promises';
import {dirname,isAbsolute,join} from 'node:path';
import {validId} from './store.mjs';

/** Bounded login lifetime used when the deployment does not provide an override. */
export const DEFAULT_SESSION_TTL_MS=30*24*60*60*1000;
const MAX_CONFIGURED_SESSION_TTL_MS=90*24*60*60*1000;
const MIN_CONFIGURED_SESSION_TTL_MS=60*1000;
const MAX_SESSIONS=10000;
const tokenHash=token=>createHash('sha256').update(token).digest('hex');

function validRecord(record){
 return record&&typeof record==='object'&&!Array.isArray(record)
  &&Object.keys(record).sort().join(',')==='expiry,id,revision,tokenHash'
  &&/^[a-f0-9]{64}$/.test(record.tokenHash)&&validId(record.id)
  &&Number.isSafeInteger(record.revision)&&record.revision>0
  &&Number.isSafeInteger(record.expiry)&&record.expiry>0;
}

function createSessionStore({records=[],save=async()=>{},now=Date.now,maxSessions=MAX_SESSIONS}={}){
 if(!Number.isSafeInteger(maxSessions)||maxSessions<1)throw Error('Invalid session capacity');
 let current=new Map(records.map(record=>[record.tokenHash,record])),queue=Promise.resolve(),latest=queue;const revoked=new Set();
 function transaction(mutate){
  const run=queue.then(async()=>{const next=new Map(current),change=mutate(next);if(!change.changed)return change.value;await save([...next.values()]);current=next;return change.value;});
  latest=run;
  // The failed mutation rejects its caller; only the serialization queue recovers for a later retry.
  queue=run.catch(error=>{void error;});return run;
 }
 return {
  get(token){if(typeof token!=='string')return;const hash=tokenHash(token);if(revoked.has(hash))return;const record=current.get(hash);return record?.expiry>now()?{id:record.id,revision:record.revision,expiry:record.expiry}:undefined;},
  issue(session){if(!validId(session?.id)||!Number.isSafeInteger(session.revision)||session.revision<1||!Number.isSafeInteger(session.expiry)||session.expiry<=now())throw Error('Invalid session');return transaction(records=>{
   for(const [hash,record] of records)if(record.expiry<=now())records.delete(hash);
   while(records.size>=maxSessions)records.delete(records.keys().next().value);
   const token=randomBytes(32).toString('base64url'),hash=tokenHash(token);records.set(hash,{tokenHash:hash,id:session.id,revision:session.revision,expiry:session.expiry});return {changed:true,value:token};
  });},
  revoke(token){if(typeof token!=='string')return Promise.resolve(false);const hash=tokenHash(token);if(!current.has(hash))return Promise.resolve(false);revoked.add(hash);const pending=transaction(records=>{const changed=records.delete(hash);return {changed,value:changed};});pending.then(()=>revoked.delete(hash),error=>{void error;});return pending;},
  revokeAccount(id){return transaction(records=>{let removed=0;for(const [hash,record] of records)if(record.id===id){records.delete(hash);removed++;}return {changed:removed>0,value:removed};});},
  flush(){return latest;},
  size(){return current.size;},
 };
}

/** Create an in-memory session store for embedded gateway callers.
 * @param {object} options Clock and capacity overrides.
 * @returns {object} Session lookup and mutation operations.
 */
export function createMemorySessionStore(options={}){return createSessionStore(options);}

/** Open an atomically written private session store.
 * @param {string} file Absolute durable JSON path outside the release tree.
 * @param {object} options Clock and capacity overrides.
 * @returns {Promise<object>} Session lookup and mutation operations.
 */
export async function openSessionStore(file,{now=Date.now,maxSessions=MAX_SESSIONS}={}){
 if(!isAbsolute(file))throw Error('Session store path must be absolute');
 await mkdir(dirname(file),{recursive:true,mode:0o700});let records=[],pruned=false,exists=false;
 try{
  const data=JSON.parse(await readFile(file,'utf8'));exists=true;
  if(data.version!==1||!Array.isArray(data.sessions)||data.sessions.length>maxSessions)throw Error('Invalid session store');
  const hashes=new Set();
  for(const record of data.sessions){
   if(!validRecord(record)||hashes.has(record.tokenHash))throw Error('Invalid session record');
   hashes.add(record.tokenHash);if(record.expiry>now())records.push(record);else pruned=true;
  }
  await chmod(file,0o600);
 }catch(error){if(error.code!=='ENOENT')throw error;}
 const save=async sessions=>{const temp=file+'.'+randomBytes(8).toString('hex')+'.tmp';try{await writeFile(temp,JSON.stringify({version:1,sessions}),{mode:0o600});await chmod(temp,0o600);await rename(temp,file);}catch(error){await Promise.allSettled([rm(temp,{force:true})]);throw error;}};
 if(exists&&pruned)await save(records);
 return createSessionStore({records,save,now,maxSessions});
}

/** Resolve the private session file next to the account file unless explicitly configured.
 * @param {string} accountFile Absolute account-store path.
 * @param {string|undefined} configured Explicit session-store path.
 * @returns {string} Absolute session-store path.
 */
export function resolveSessionFile(accountFile,configured){
 if(!isAbsolute(accountFile))throw Error('Account store path must be absolute');
 if(configured!==undefined&&!isAbsolute(configured))throw Error('MUSE_SESSIONS_FILE must be absolute');
 return configured??join(dirname(accountFile),'sessions.json');
}

/** Read the bounded login lifetime from the gateway environment.
 * @param {object} environment Gateway environment.
 * @returns {number} Session lifetime in milliseconds.
 */
export function resolveSessionTtlMs(environment=process.env){
 const value=environment.MUSE_SESSION_TTL_MS;
 if(value===undefined)return DEFAULT_SESSION_TTL_MS;
 if(!/^[1-9][0-9]*$/.test(value))throw Error('MUSE_SESSION_TTL_MS must be an integer between 60000 and 7776000000');
 const ttl=Number(value);
 if(!Number.isSafeInteger(ttl)||ttl<MIN_CONFIGURED_SESSION_TTL_MS||ttl>MAX_CONFIGURED_SESSION_TTL_MS)throw Error('MUSE_SESSION_TTL_MS must be an integer between 60000 and 7776000000');
 return ttl;
}

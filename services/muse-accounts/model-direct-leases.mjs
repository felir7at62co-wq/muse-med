/** Durable, session-owned admission for Desktop requests sent directly to Zhipu. */
import {createHash,createHmac,randomUUID} from 'node:crypto';
import {mkdir,readFile,writeFile,rename,rm} from 'node:fs/promises';
import {dirname,isAbsolute} from 'node:path';
import {completionEndpoint} from './model-relay.mjs';

const digest=value=>createHash('sha256').update(value).digest('hex');
const uuid=value=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const fail=(status,message)=>Object.assign(Error(message),{status});

/** Resolve operator-owned token lifetime, request deadline, check interval and release grace.
 * @param {object} env Deployment settings.
 * @returns {object} Validated millisecond durations.
 */
export function resolveDirectLeasePolicy(env={}){
 const fields=[['tokenMs','MUSE_ZHIPU_DIRECT_TOKEN_MS',60000,1000,300000],['requestMs','MUSE_ZHIPU_DIRECT_REQUEST_MS',1800000,10000,7200000],['checkMs','MUSE_ZHIPU_DIRECT_CHECK_MS',30000,1000,60000],['graceMs','MUSE_ZHIPU_DIRECT_GRACE_MS',15000,1000,300000]];
 const policy=Object.fromEntries(fields.map(([name,key,fallback,min,max])=>{
  const value=env[key]===undefined?fallback:Number(env[key]);
  if(!Number.isSafeInteger(value)||value<min||value>max)throw Error('Invalid '+key);
  return [name,value];
 }));
 if(policy.tokenMs>policy.requestMs||policy.checkMs>=policy.requestMs)throw Error('Invalid direct model lease timing');
 return policy;
}

function token(key,now,expiry){
 const parts=key.split('.');if(parts.length!==2||!parts.every(Boolean))throw fail(503,'Direct model credential is invalid');
 const header=Buffer.from(JSON.stringify({alg:'HS256',sign_type:'SIGN'})).toString('base64url');
 const payload=Buffer.from(JSON.stringify({api_key:parts[0],exp:expiry,timestamp:now})).toString('base64url');
 const signed=header+'.'+payload;
 return signed+'.'+createHmac('sha256',parts[1]).update(signed).digest('base64url');
}

/** Restore reservations before opening ingress; no keys or supplier tokens are persisted.
 * @param {object} options Shared key pool, current catalog, private file and validated policy.
 * @returns {Promise<object>} Lease acquisition, owner checks, release and synchronous timer teardown.
 */
export async function openDirectModelLeases({pool,globalModels,file,policy=resolveDirectLeasePolicy(),now=Date.now}){
 if(file!==undefined&&!isAbsolute(file))throw Error('Direct model lease file must be absolute');
 const records=new Map(),holds=new Map(),timers=new Map();let tail=Promise.resolve(),closed=false,broken=false;
 if(file){
  await mkdir(dirname(file),{recursive:true,mode:0o700});
  let data;try{data=JSON.parse(await readFile(file,'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
  if(data!==undefined){
   if(data.version!==1||!Array.isArray(data.leases))throw Error('Invalid direct model lease store');
   for(const row of data.leases){
    if(!row||Object.keys(row).sort().join(',')!=='deadline,id,keyHash,owner,releaseAt'||!uuid(row.id)||!['keyHash','owner'].every(key=>/^[a-f0-9]{64}$/.test(row[key]))||![row.deadline,row.releaseAt].every(value=>Number.isSafeInteger(value)&&value>0)||row.releaseAt-now()>7500000||records.has(row.id))throw Error('Invalid direct model reservation');
    if(row.releaseAt>now()){records.set(row.id,row);}
   }
  }
 }
 async function save(){
  if(!file)return;
  const temporary=file+'.'+randomUUID()+'.tmp';
  try{await writeFile(temporary,JSON.stringify({version:1,leases:[...records.values()]})+'\n',{flag:'wx',mode:0o600});await rename(temporary,file);}
  finally{await rm(temporary,{force:true});}
 }
 function transaction(run){
  const pending=tail.then(()=>{if(closed||broken)throw fail(503,'Direct model admission unavailable');return run();});
  tail=pending.catch(()=>{});return pending;
 }
 function arm(row){
  clearTimeout(timers.get(row.id));
  const timer=setTimeout(()=>{void transaction(async()=>{
   records.delete(row.id);try{await save();}catch(error){broken=true;throw error;}
   timers.delete(row.id);holds.get(row.id)?.();holds.delete(row.id);
  }).catch(()=>{console.error('[muse-model-leases] Reservation cleanup unavailable');});},Math.max(1,row.releaseAt-now()));timer.unref();timers.set(row.id,timer);
 }
 for(const row of records.values()){holds.set(row.id,pool.restore(row.keyHash));arm(row);}
 function owned(session,id){
  const row=records.get(id);
  if(!row||row.owner!==digest(session.token)||row.releaseAt<=now())throw fail(404,'Direct model reservation unavailable');
  return row;
 }
 return {
  policy,
  async acquire(session,model,signal){
   if(closed||broken)throw fail(503,'Direct model admission unavailable');
   const initial=globalModels.resolve('zhipu-official',model);if(!initial?.apiKey)throw fail(400,'Model unavailable');
   const slot=await pool.acquire(signal);
   let retained=false;
   try{return await transaction(async()=>{
    signal?.throwIfAborted();
    const config=globalModels.resolve('zhipu-official',model);
    if(!config?.apiKey||!globalModels.credentialPool('zhipu-official').includes(slot.key))throw fail(503,'Model configuration changed');
    if(session.expiry<=now())throw fail(401,'Muse session expired');
    const baseURL=completionEndpoint(config.baseURL).href.replace(/\/chat\/completions$/,'');
    const started=now(),deadline=started+policy.requestMs;
    const apiKey=token(slot.key,started,Math.min(deadline,started+policy.tokenMs,session.expiry));
    const row={id:randomUUID(),owner:digest(session.token),keyHash:digest(slot.key),deadline,releaseAt:deadline+policy.graceMs};
    records.set(row.id,row);holds.set(row.id,slot.release);retained=true;
    try{await save();}catch(error){broken=true;throw error;}
    arm(row);signal?.throwIfAborted();
    return {id:row.id,baseURL,apiKey,deadline,requestMs:policy.requestMs,checkMs:policy.checkMs};
   });}finally{if(!retained)slot.release();}
  },
  check(session,id){const row=owned(session,id);if(row.deadline<=now())throw fail(410,'Direct model request deadline passed');return {deadline:row.deadline};},
  release(session,id){return transaction(async()=>{
   const row=owned(session,id),releaseAt=Math.min(row.releaseAt,now()+policy.graceMs);
   records.set(id,{...row,releaseAt});try{await save();}catch(error){broken=true;throw error;}
   arm(records.get(id));return {released:true};
  });},
  close(){closed=true;for(const timer of timers.values())clearTimeout(timer);timers.clear();return tail;},
 };
}

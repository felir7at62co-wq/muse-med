/** Durable fair turns for connected company Hosts; a turn grants neither money nor supplier dispatch. */
import {createHash,randomUUID} from 'node:crypto';

export const NATIVE_JUBIAN_QUEUE_TABLES=['native_jubian_admission_queue','native_jubian_admission_queue_cursors'];
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const positive=value=>Number.isSafeInteger(value)&&value>0;
const fail=(code,status=409)=>Object.assign(Error(code),{code:'native_jubian_admission_'+code,status});
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const identity=values=>digest(values.map(value=>({...value,policy_revision:null})));

/** Validate explicitly enabled scheduler limits before opening company storage.
 * @param {object|undefined} value Optional deployment limits; absence keeps existing immediate admission.
 * @returns {object|undefined} Detached queue and offer bounds.
 */
export function resolveNativeJubianSchedulerConfig(value){
 if(value===undefined)return undefined;
 if(!object(value)||Object.keys(value).length!==4||!Object.keys(value).every(key=>['maxQueuedPerCompany','maxQueuedPerMember','offerTtlMs','queuedTicketRetentionMs'].includes(key))
  ||!positive(value.maxQueuedPerCompany)||!positive(value.maxQueuedPerMember)||value.maxQueuedPerMember>value.maxQueuedPerCompany
  ||!positive(value.offerTtlMs)||value.offerTtlMs>3600000||!positive(value.queuedTicketRetentionMs)
  ||value.queuedTicketRetentionMs<value.offerTtlMs)throw fail('invalid_scheduler_configuration',500);
 return {maxQueuedPerCompany:value.maxQueuedPerCompany,maxQueuedPerMember:value.maxQueuedPerMember,
  offerTtlMs:value.offerTtlMs,queuedTicketRetentionMs:value.queuedTicketRetentionMs};
}

/** Add private scheduler metadata without rewriting any admission, source or budget row.
 * @param {object} db Owning SQLite connection inside its schema transaction.
 */
export function installNativeJubianSchedulerSchema(db){
 db.exec(`CREATE TABLE IF NOT EXISTS native_jubian_admission_queue(queue_id TEXT PRIMARY KEY,company_id TEXT NOT NULL,actor_id TEXT NOT NULL,queue_key TEXT NOT NULL,identity_sha256 TEXT NOT NULL,items_json TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN('queued','offered','consumed','cancelled')),offer_until INTEGER,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,heartbeat_at INTEGER NOT NULL,UNIQUE(company_id,actor_id,queue_key));
CREATE INDEX IF NOT EXISTS native_jubian_admission_queue_pending ON native_jubian_admission_queue(company_id,state,created_at);
CREATE TABLE IF NOT EXISTS native_jubian_admission_queue_cursors(company_id TEXT PRIMARY KEY,last_actor_id TEXT NOT NULL);`);
}

/** Schedule atomic request groups fairly among company members using the admission owner's transaction.
 * @param {object} options Private SQLite owner, normalized limits, live ACL and availability readers, metadata parser and audit writer.
 * @returns {object} Queue lifecycle and a claim consumed in the same transaction as actual reservations.
 */
export function createNativeJubianScheduler({db,config,select,ready,hasCompanyCapacity,parse,audit,now}){
 const items=row=>parse(JSON.parse(row.items_json));
 const rows=company=>db.prepare("SELECT * FROM native_jubian_admission_queue WHERE company_id=? AND state IN('queued','offered') ORDER BY created_at,queue_id").all(company);
 const context=row=>({accountId:row.actor_id,sessionId:null,deviceId:null});
 function policyCheck(row){
  const values=items(row);
  try{for(const value of values)select(context(row),value);}
  catch(error){
   if(['account_forbidden','member_forbidden','project_forbidden'].some(code=>error.code==='native_jubian_admission_'+code))return false;
   throw error;
  }
  return true;
 }
 function change(row,state,until=null){
  db.prepare('UPDATE native_jubian_admission_queue SET state=?,offer_until=?,updated_at=? WHERE queue_id=?').run(state,until,now(),row.queue_id);
  return {...row,state,offer_until:until};
 }
 function planned(row){return items(row).map(item=>({...item,queue_actor_id:row.actor_id}));}
 function refresh(company){
  if(!config)throw fail('scheduler_not_configured',503);
  let pending=rows(company);
  const admitted=new Set(db.prepare(`SELECT DISTINCT q.queue_id FROM native_jubian_admission_queue q
JOIN json_each(q.items_json) item
JOIN native_jubian_admission_operations operation ON operation.company_id=q.company_id AND operation.operation_id=json_extract(item.value,'$.operation_id')
WHERE q.company_id=? AND q.state IN('queued','offered')`).all(company).map(row=>row.queue_id));
  for(const row of pending){
   if(admitted.has(row.queue_id)||!policyCheck(row)||now()-row.heartbeat_at>=config.queuedTicketRetentionMs){
    const reason=admitted.has(row.queue_id)?'operation-already-reserved':now()-row.heartbeat_at>=config.queuedTicketRetentionMs?'host-disconnected':'access-revoked';
    change(row,'cancelled');audit(context(row),'queue-cancelled',{company_id:company},{queue_id:row.queue_id,reason});
   }else if(row.state==='offered'&&row.offer_until<=now())change(row,'queued');
  }
  pending=rows(company);const held=[];
  for(const row of pending.filter(row=>row.state==='offered')){
   const check=ready(context(row),items(row),held);
   if(!check.ready)change(row,'queued');else held.push(...planned(row));
  }
  const queued=rows(company).filter(row=>row.state==='queued');
  const actors=[...new Set(queued.map(row=>row.actor_id))].sort();
  let last=db.prepare('SELECT last_actor_id FROM native_jubian_admission_queue_cursors WHERE company_id=?').get(company)?.last_actor_id;
  while(actors.length&&hasCompanyCapacity(company,held.length)){
   const ordered=last===undefined?actors:[...actors.filter(value=>value>last),...actors.filter(value=>value<=last)];
   let offered=false;
   for(const account of ordered){
    const candidate=queued.find(row=>row.actor_id===account&&row.state==='queued'&&ready(context(row),items(row),held).ready);
    if(!candidate)continue;
    const until=now()+config.offerTtlMs;if(!Number.isSafeInteger(until))throw fail('scheduler_clock_invalid',500);
    change(candidate,'offered',until);candidate.state='offered';candidate.offer_until=until;held.push(...planned(candidate));
    db.prepare('INSERT INTO native_jubian_admission_queue_cursors VALUES(?,?) ON CONFLICT(company_id) DO UPDATE SET last_actor_id=excluded.last_actor_id').run(company,account);
    audit(context(candidate),'queue-offered',{company_id:company},{queue_id:candidate.queue_id,offer_until:until});
    last=account;offered=true;break;
   }
   if(!offered)break;
  }
 }
 function readOwned(caller,company,id){
  if(!config)throw fail('scheduler_not_configured',503);
  const row=db.prepare('SELECT * FROM native_jubian_admission_queue WHERE queue_id=? AND company_id=? AND actor_id=?').get(id,company,caller.accountId);
  if(!row)throw fail('queue_missing',404);
  for(const value of items(row))select(caller,value);
  return row;
 }
 function receipt(row){
  const values=items(row),check=ready(context(row),values,rows(row.company_id).filter(other=>other.state==='offered'&&other.queue_id!==row.queue_id).flatMap(planned));
  return {queue_id:row.queue_id,state:row.state,turn_expires_at:row.offer_until,
   reason:row.state==='queued'?check.reason:null,operation_ids:values.map(value=>value.operation_id)};
 }
 return {
  enabled:config!==undefined,
  join(caller,company,key,values){
   if(!config)throw fail('scheduler_not_configured',503);
   for(const value of values)select(caller,value);
   refresh(company);
   let row=db.prepare('SELECT * FROM native_jubian_admission_queue WHERE company_id=? AND actor_id=? AND queue_key=?').get(company,caller.accountId,key);
   const hash=identity(values);
   if(row){
    if(row.identity_sha256!==hash)throw fail('queue_identity_conflict');
    if(row.state==='cancelled'){
     const pending=rows(company);
     if(pending.length>=config.maxQueuedPerCompany||pending.filter(value=>value.actor_id===caller.accountId).length>=config.maxQueuedPerMember)throw fail('queue_full',429);
     change(row,'queued');audit(caller,'queue-resumed',{company_id:company},{queue_id:row.queue_id});
    }
    if(row.state!=='consumed')db.prepare('UPDATE native_jubian_admission_queue SET items_json=?,updated_at=?,heartbeat_at=? WHERE queue_id=?').run(JSON.stringify(values),now(),now(),row.queue_id);
   }else{
    const pending=rows(company);
    if(pending.length>=config.maxQueuedPerCompany||pending.filter(value=>value.actor_id===caller.accountId).length>=config.maxQueuedPerMember)throw fail('queue_full',429);
    const time=now();row={queue_id:randomUUID(),company_id:company,actor_id:caller.accountId,queue_key:key,identity_sha256:hash,
     items_json:JSON.stringify(values),state:'queued',offer_until:null,created_at:time,updated_at:time,heartbeat_at:time};
    db.prepare('INSERT INTO native_jubian_admission_queue VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(...Object.values(row));
    audit(caller,'queue-joined',{company_id:company},{queue_id:row.queue_id,operation_ids:values.map(value=>value.operation_id)});
   }
   refresh(company);return receipt(readOwned(caller,company,row.queue_id));
  },
  status(caller,company,id){
   const row=readOwned(caller,company,id);
   if(['queued','offered'].includes(row.state)&&now()-row.heartbeat_at<config.queuedTicketRetentionMs)
    db.prepare('UPDATE native_jubian_admission_queue SET heartbeat_at=? WHERE queue_id=?').run(now(),id);
   refresh(company);return receipt(readOwned(caller,company,id));
  },
  cancel(caller,company,id){
   const row=readOwned(caller,company,id);
   if(row.state==='consumed')throw fail('queue_already_reserved');
   if(row.state!=='cancelled'){change(row,'cancelled');audit(caller,'queue-cancelled',{company_id:company},{queue_id:id,reason:'host-cancelled'});}
   refresh(company);return receipt(readOwned(caller,company,id));
  },
  claim(caller,id,values){
   if(!config){if(id!==undefined)throw fail('scheduler_not_configured',503);return undefined;}
   if(typeof id!=='string')throw fail('queue_turn_required');
   const company=values[0].company_id;refresh(company);const row=readOwned(caller,company,id);
   if(row.identity_sha256!==identity(values))throw fail('queue_identity_conflict');
   if(row.state!=='offered'||row.offer_until<=now())throw fail('queue_turn_not_ready',429);
   return row;
  },
  consume(caller,row){
   if(!row)return;
   change(row,'consumed');audit(caller,'queue-consumed',{company_id:row.company_id},{queue_id:row.queue_id});
  },
 };
}

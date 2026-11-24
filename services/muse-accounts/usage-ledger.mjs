/** Private, immutable request reservations and provider-reported token usage. */
import {randomUUID} from 'node:crypto';
import {mkdir,open,link,readFile,readdir,rm,lstat,realpath} from 'node:fs/promises';
import {isAbsolute,join,dirname,resolve} from 'node:path';
import {validId} from './store.mjs';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DAY=/^\d{4}-\d{2}-\d{2}$/;
const COUNT_KEYS=['prompt_tokens','completion_tokens','total_tokens','input_tokens','output_tokens','prompt_cache_hit_tokens','prompt_cache_miss_tokens','reasoning_tokens'];
const DETAILS={prompt_tokens_details:['cached_tokens','audio_tokens'],completion_tokens_details:['reasoning_tokens','audio_tokens','accepted_prediction_tokens','rejected_prediction_tokens'],input_tokens_details:['cached_tokens','audio_tokens'],output_tokens_details:['reasoning_tokens','audio_tokens']};
const count=value=>Number.isSafeInteger(value)&&value>=0;
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const safeId=value=>typeof value==='string'&&/^[a-z0-9][a-z0-9._:/@+-]{0,255}$/i.test(value)?value:null;
const canonical=value=>JSON.stringify(value);
const same=(a,b)=>canonical(a)===canonical(b);

/** Expected ledger failure with a fixed public error code. */
export class UsageLedgerError extends Error{
 constructor(code,status=503){super(code);this.code=code;this.status=status;}
}
function invalid(){throw new UsageLedgerError('invalid_usage_query',400);}
async function readJson(file){try{return JSON.parse(await readFile(file,'utf8'));}catch(error){if(error.code==='ENOENT')return null;throw error;}}
async function syncDirectory(dir){if(process.platform==='win32')return;const handle=await open(dir,'r');try{await handle.sync();}finally{await handle.close();}}
async function publish(file,value){
 await mkdir(dirname(file),{recursive:true,mode:0o700});const temp=file+'.'+randomUUID()+'.tmp';
 try{
  const handle=await open(temp,'wx',0o600);try{await handle.writeFile(canonical(value)+'\n');await handle.sync();}finally{await handle.close();}
  try{await link(temp,file);}catch(error){if(error.code!=='EEXIST')throw error;const previous=await readJson(file);if(!same(previous,value))throw new UsageLedgerError('usage_record_conflict',409);}
  await syncDirectory(dirname(file));
 }finally{await rm(temp,{force:true});}
}
function usageFields(value){
 if(!object(value))return null;const result={};
 for(const key of COUNT_KEYS)if(count(value[key]))result[key]=value[key];
 for(const [key,names]of Object.entries(DETAILS))if(object(value[key])){const details={};for(const name of names)if(count(value[key][name]))details[name]=value[key][name];if(Object.keys(details).length)result[key]=details;}
 return Object.keys(result).length?result:null;
}
function day(value){if(typeof value!=='string'||!DAY.test(value)||!Number.isFinite(Date.parse(value))||new Date(value).toISOString().slice(0,10)!==value)invalid();return value;}
function queryOptions(options,now,maxQueryDays){
 const to=options.to===undefined?new Date(now()).toISOString().slice(0,10):day(options.to);
 const from=options.from===undefined?new Date(Date.parse(to)-(Math.min(30,maxQueryDays)-1)*86400000).toISOString().slice(0,10):day(options.from);
 if(from>to||(Date.parse(to)-Date.parse(from))/86400000>=maxQueryDays)invalid();
 const limit=options.limit===undefined?50:Number(options.limit);if(!Number.isSafeInteger(limit)||limit<1||limit>100)invalid();
 if(options.accountId!==undefined&&!validId(options.accountId))invalid();
 let cursor=null;
 if(options.cursor!==undefined){try{cursor=JSON.parse(Buffer.from(options.cursor,'base64url').toString('utf8'));}catch(error){void error;invalid();}
  if(!Array.isArray(cursor)||cursor.length!==3||typeof cursor[0]!=='string'||!validId(cursor[1])||!UUID.test(cursor[2]))invalid();}
 return {from,to,limit,cursor,accountId:options.accountId};
}
function key(record){return [record.startedAt,record.accountId,record.requestId];}
function compare(a,b){return canonical(a).localeCompare(canonical(b));}
function sumReported(items,names){let total=null;for(const item of items){let value;for(const name of names)if(count(item.usage?.[name])){value=item.usage[name];break;}if(value!==undefined){const next=(total??0)+value;if(!Number.isSafeInteger(next))return null;total=next;}}return total;}

/** Open a single gateway's durable usage root; HTTP retries remain separate reservations.
 * @param {string} root Absolute private directory outside the release tree.
 * @param {object} options Clock, maximum query days and default-visible failure reporter.
 * @returns {Promise<object>} Reservation, settlement, query and flush operations.
 */
export async function openUsageLedger(root,{now=Date.now,maxQueryDays=366,onError=()=>console.error('[muse-usage] Persistence failed; requests remain unconfirmed. Inspect the usage ledger before retrying.')}={}){
 if(!isAbsolute(root)||!Number.isSafeInteger(maxQueryDays)||maxQueryDays<1||maxQueryDays>3660)throw new Error('Invalid usage ledger configuration');
 root=resolve(root);await mkdir(root,{recursive:true,mode:0o700});const info=await lstat(root),actual=await realpath(root);
 if(!info.isDirectory()||info.isSymbolicLink()||(process.platform==='win32'?actual.toLowerCase()!==root.toLowerCase():actual!==root)||(process.platform!=='win32'&&(info.mode&0o077)!==0))throw new Error('Usage ledger root must be private');
 const manifest=join(root,'schema.json'),expected={version:1};await publish(manifest,expected);const active=new Set(),waiters=new Set();let failure=false,tail=Promise.resolve();
 const failed=error=>{failure=true;try{onError();}catch(reportError){void reportError;console.error('[muse-usage] Persistence failure reporting failed; inspect the usage ledger.');}return error instanceof UsageLedgerError?error:new UsageLedgerError('usage_unavailable');};
 function write(fn){const run=tail.then(fn);tail=run.catch(error=>{void error;});return run.catch(error=>{throw failed(error);});}
 const folder=ticket=>join(root,ticket.startedAt.slice(0,10),ticket.accountId,ticket.requestId);
 return {
  async begin({accountId,requestId,clientRequestId=null,channel,route=null}){
   if(!validId(accountId)||!UUID.test(requestId)||clientRequestId!==null&&!UUID.test(clientRequestId)||!['cloud-relay','desktop-relay'].includes(channel)||route!==null&&!/^[a-z][a-z0-9-]{0,63}$/.test(route))throw new UsageLedgerError('invalid_usage_reservation',400);
   // Correlation and route fields are stored only after provider-secret scrubbing at settlement.
   const ticket={version:1,accountId,requestId,clientRequestId:null,channel,route:null,startedAt:new Date(now()).toISOString()};
   active.add(requestId);
   try{await write(async()=>{await publish(join(folder(ticket),'request.json'),ticket);await syncDirectory(dirname(folder(ticket)));await syncDirectory(dirname(dirname(folder(ticket))));await syncDirectory(root);});return ticket;}
   catch(error){active.delete(requestId);for(const wake of waiters)wake();waiters.clear();throw error;}
  },
  async finish(ticket,metadata){
   if(!validId(ticket?.accountId)||!UUID.test(ticket?.requestId)||metadata?.server_request_id!==ticket.requestId)throw new UsageLedgerError('invalid_usage_reservation',400);
   const usage=usageFields(metadata.usage),errorKind=['request_rejected','upstream_http','invalid_content_type','transport','cancelled'].includes(metadata.error_kind)?metadata.error_kind:null;
   const result={version:1,requestId:ticket.requestId,finishedAt:new Date(now()).toISOString(),
    clientRequestId:typeof metadata.client_request_id==='string'&&UUID.test(metadata.client_request_id)?metadata.client_request_id:null,
    route:typeof metadata.route==='string'&&/^[a-z][a-z0-9-]{0,63}$/.test(metadata.route)?metadata.route:null,
    state:errorKind?'failed':metadata.client_status===200&&(metadata.done||metadata.eof)?'completed':'unknown',
    usage,usageStatus:usage===null?'unreported':metadata.done||metadata.eof?'reported':'partial',
    requestedModel:safeId(metadata.requested_model),forwardedModel:safeId(metadata.forwarded_model),responseModel:safeId(metadata.response_model),
    providerResponseId:safeId(metadata.response_id),upstreamStatus:metadata.upstream_status??null,clientStatus:metadata.client_status??null,errorKind,
    observationTruncated:metadata.observation_truncated===true};
   try{await write(async()=>{const file=join(folder(ticket),'result.json'),previous=await readJson(file);if(previous){if(!same({...previous,finishedAt:null},{...result,finishedAt:null}))throw new UsageLedgerError('usage_record_conflict',409);return;}
     if(!same(await readJson(join(folder(ticket),'request.json')),ticket))throw new UsageLedgerError('usage_reservation_missing');await publish(file,result);});}
   finally{active.delete(ticket.requestId);for(const wake of waiters)wake();waiters.clear();}
  },
  async query(options={}){
   const q=queryOptions(options,now,maxQueryDays);const items=[];
   try{
    const days=(await readdir(root,{withFileTypes:true})).filter(entry=>entry.isDirectory()&&DAY.test(entry.name)&&entry.name>=q.from&&entry.name<=q.to);
    for(const entry of days){const dateRoot=join(root,entry.name);const accounts=q.accountId?[q.accountId]:(await readdir(dateRoot,{withFileTypes:true})).filter(row=>row.isDirectory()&&validId(row.name)).map(row=>row.name);
     for(const accountId of accounts){let requests;try{requests=await readdir(join(dateRoot,accountId),{withFileTypes:true});}catch(error){if(error.code==='ENOENT')continue;throw error;}
      for(const request of requests){if(!request.isDirectory()||!UUID.test(request.name))continue;const dir=join(dateRoot,accountId,request.name),start=await readJson(join(dir,'request.json'));
       if(start===null){const names=await readdir(dir);if(names.every(name=>/^request\.json\.[a-f0-9-]+\.tmp$/.test(name)))continue;throw new UsageLedgerError('usage_corrupt');}
       if(!start||start.version!==1||start.accountId!==accountId||start.requestId!==request.name||start.startedAt.slice(0,10)!==entry.name)throw new UsageLedgerError('usage_corrupt');
       const result=await readJson(join(dir,'result.json'));if(result&&(result.version!==1||result.requestId!==start.requestId))throw new UsageLedgerError('usage_corrupt');
       items.push({...start,...result??{state:active.has(start.requestId)?'pending':'unknown',finishedAt:null,usage:null,usageStatus:'unreported'}});
      }
     }
    }
   }catch(error){throw failed(error);}
   items.sort((a,b)=>compare(key(b),key(a)));
   const summary={requests:items.length,completedRequests:items.filter(item=>item.state==='completed').length,failedRequests:items.filter(item=>item.state==='failed').length,
    pendingRequests:items.filter(item=>item.state==='pending').length,unknownRequests:items.filter(item=>item.state==='unknown').length,
    reportedUsageRequests:items.filter(item=>item.usageStatus==='reported').length,partialUsageRequests:items.filter(item=>item.usageStatus==='partial').length,unreportedUsageRequests:items.filter(item=>item.usage===null).length,
    inputTokens:sumReported(items,['input_tokens','prompt_tokens']),outputTokens:sumReported(items,['output_tokens','completion_tokens']),totalTokens:sumReported(items,['total_tokens'])};
   const remaining=q.cursor?items.filter(item=>compare(key(item),q.cursor)<0):items,page=remaining.slice(0,q.limit);
   return {version:1,coverage:{transport:'relay-only',direct:'unobserved'},from:q.from,to:q.to,summary,items:page,
    nextCursor:remaining.length>page.length?Buffer.from(canonical(key(page.at(-1)))).toString('base64url'):null,health:{state:failure?'degraded':'ok'}};
  },
  async flush(){await tail;while(active.size)await new Promise(resolve=>waiters.add(resolve));await tail;if(failure)throw new UsageLedgerError('usage_unavailable');},
 };
}

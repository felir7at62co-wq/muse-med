/** Private account token records and owner-scoped usage projections. */
import {appendFile,mkdir,readFile,writeFile,chmod} from 'node:fs/promises';
import {dirname,isAbsolute} from 'node:path';
import {validId} from './store.mjs';
import {accountGroups} from './account-groups.mjs';

const fields=['inputTokens','outputTokens','totalTokens','cachedInputTokens','reasoningTokens'];
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const modelName=/^[a-z0-9][a-z0-9._:/@+-]{0,199}$/i;
const count=value=>Number.isSafeInteger(value)&&value>=0;
const instant=value=>typeof value==='string'&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString()===value;


function tokens(usage){
 const input=usage?.input_tokens??usage?.prompt_tokens,output=usage?.output_tokens??usage?.completion_tokens;
 const total=usage?.total_tokens??(count(input)&&count(output)&&count(input+output)?input+output:null);
 const cached=usage?.input_tokens_details?.cached_tokens??usage?.prompt_tokens_details?.cached_tokens??usage?.prompt_cache_hit_tokens;
 const reasoning=usage?.output_tokens_details?.reasoning_tokens??usage?.completion_tokens_details?.reasoning_tokens??usage?.reasoning_tokens;
 return Object.fromEntries(fields.map((field,index)=>[field,count([input,output,total,cached,reasoning][index])?[input,output,total,cached,reasoning][index]:null]));
}

function validEntry(entry){
 return entry&&Object.keys(entry).sort().join(',')===['accountId','id','at','provider','model','status','source',...fields].sort().join(',')&&validId(entry.accountId)&&uuid.test(entry.id)&&instant(entry.at)
  &&typeof entry.provider==='string'&&/^[a-z][a-z0-9-]{0,63}$/.test(entry.provider)
  &&typeof entry.model==='string'&&modelName.test(entry.model)&&(entry.status===null||Number.isInteger(entry.status)&&entry.status>=100&&entry.status<=599)
  &&['gateway-relay','desktop-direct'].includes(entry.source)&&fields.every(field=>entry[field]===null||count(entry[field]));
}

const totals=()=>({requests:0,reportedRequests:0,inputTokens:0,outputTokens:0,totalTokens:0,cachedInputTokens:0,reasoningTokens:0});
function add(target,entry){
 target.requests++;
 if(fields.some(field=>entry[field]!==null))target.reportedRequests++;
 for(const field of fields)if(entry[field]!==null){const sum=target[field]+entry[field];if(!Number.isSafeInteger(sum))throw Error('Usage total exceeds safe integer range');target[field]=sum;}
}

/** Resolve bounded history pagination and Beijing calendar periods.
 * @param {URLSearchParams} query Account details URL parameters.
 * @returns {object} Validated period, offset and limit; unknown parameters do not select another account.
 */
export function accountDetailsQuery(query){
 const period=query.get('period')??'30d',offset=Number(query.get('offset')??0),limit=Number(query.get('limit')??50);
 if(!['all','today','7d','30d'].includes(period)||!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(limit)||limit<1||limit>100)throw Object.assign(Error('Invalid usage query'),{status:400});
 return {period,offset,limit};
}

function createLedger({startedAt,entries=[],save=async()=>{},now=Date.now}){
 const records=new Map(entries.map(entry=>[entry.accountId+'\0'+entry.id,entry]));let queue=Promise.resolve(),writeFailure;
 function record(entry){
  if(!validEntry(entry))return Promise.reject(Error('Invalid account usage record'));
  const key=entry.accountId+'\0'+entry.id,run=queue.then(async()=>{
   const previous=records.get(key);
   if(previous){if(JSON.stringify({...previous,at:null})!==JSON.stringify({...entry,at:null}))throw Object.assign(Error('Usage request ID conflict'),{status:409});return;}
   if(writeFailure)throw writeFailure;
   try{await save(entry);}catch(error){writeFailure=error;throw error;}records.set(key,structuredClone(entry));
  });
  queue=run.catch(error=>{void error;});return run;
 }
 return {
  /** Commit one gateway-observed response without retaining response content. */
  capture(accountId,metadata){
   if(!validId(accountId)||!metadata.requested_model||!metadata.route)return Promise.resolve();
   return record({accountId,id:metadata.server_request_id,at:new Date(now()).toISOString(),provider:metadata.route,model:metadata.requested_model,
    status:metadata.client_status??502,source:'gateway-relay',...tokens(metadata.usage)});
  },
  async flush(){await queue;if(writeFailure)throw writeFailure;},
  async details(account,query={period:'30d',offset:0,limit:50},{tracking='gateway-relay'}={}){
   await queue;if(writeFailure)throw writeFailure;
   const current=now(),day=86400000,today=Math.floor((current+8*3600000)/day)*day-8*3600000;
   const from=query.period==='all'?Date.parse(startedAt):today-({'today':0,'7d':6,'30d':29}[query.period])*day;
   const rows=[...records.values()].filter(entry=>entry.accountId===account.id&&Date.parse(entry.at)>=from&&Date.parse(entry.at)<=current).sort((a,b)=>b.at.localeCompare(a.at)||b.id.localeCompare(a.id));
   const summary=totals(),models=new Map(),days=new Map();
   for(const entry of rows){
    add(summary,entry);
    const key=entry.provider+'\0'+entry.model,model=models.get(key)??{provider:entry.provider,model:entry.model,...totals()};add(model,entry);models.set(key,model);
    const date=new Date(Date.parse(entry.at)+8*3600000).toISOString().slice(0,10),daily=days.get(date)??{date,...totals()};add(daily,entry);days.set(date,daily);
   }
   return {account:{id:account.id,username:account.username,createdAt:account.createdAt,lastLoginAt:account.lastLoginAt,lastActivityAt:account.lastActivityAt,
    feishuIdentities:(account.feishuIdentities??[]).map(({name,tenantKey,boundAt,lastLoginAt,organization})=>({name,tenantKey,boundAt,lastLoginAt,...organization===undefined?{}:{organization:structuredClone(organization)}}))},groups:accountGroups(account.groups??[]),
    usage:{since:new Date(Math.max(from,Date.parse(startedAt))).toISOString(),updatedAt:new Date(current).toISOString(),tracking,summary,byModel:[...models.values()].sort((a,b)=>b.totalTokens-a.totalTokens||a.provider.localeCompare(b.provider)||a.model.localeCompare(b.model)),
     byDay:[...days.values()].sort((a,b)=>b.date.localeCompare(a.date)),recent:rows.slice(query.offset,query.offset+query.limit).map(({accountId,...entry})=>entry),
     pagination:{offset:query.offset,limit:query.limit,total:rows.length,hasMore:query.offset+query.limit<rows.length}}};
  },
 };
}

/** Create isolated in-memory usage storage for embedded gateways.
 * @param {object} options Clock used for server-owned timestamps.
 * @returns {object} Capture, read and flush operations.
 */
export function createMemoryUsageLedger({now=Date.now}={}){return createLedger({startedAt:new Date(now()).toISOString(),now});}

/** Open append-only private usage storage; malformed records stop startup.
 * @param {string} file Absolute durable JSONL path; its first line records the start of measurement.
 * @param {object} options Clock used for server-owned timestamps.
 * @returns {Promise<object>} Account-scoped capture, read and flush operations.
 */
export async function openUsageLedger(file,{now=Date.now}={}){
 if(!isAbsolute(file))throw Error('Usage ledger path must be absolute');
 await mkdir(dirname(file),{recursive:true,mode:0o700});let header,entries=[];
 try{
  const lines=(await readFile(file,'utf8')).split('\n');if(lines.pop()!=='')throw Error('Incomplete usage ledger');
  header=JSON.parse(lines.shift());if(header.version!==1||!instant(header.startedAt)||Object.keys(header).sort().join(',')!=='startedAt,version')throw Error('Invalid usage ledger header');
  entries=lines.map(line=>JSON.parse(line));const keys=new Set();
  for(const entry of entries){const key=entry.accountId+'\0'+entry.id;if(!validEntry(entry)||keys.has(key))throw Error('Invalid or duplicate usage ledger record');keys.add(key);}
 }catch(error){
  if(error.code!=='ENOENT')throw error;
  header={version:1,startedAt:new Date(now()).toISOString()};await writeFile(file,JSON.stringify(header)+'\n',{mode:0o600,flag:'wx'});
 }
 await chmod(file,0o600);
 return createLedger({startedAt:header.startedAt,entries,now,save:entry=>appendFile(file,JSON.stringify(entry)+'\n',{mode:0o600})});
}

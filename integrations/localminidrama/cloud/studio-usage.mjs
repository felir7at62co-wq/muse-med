/** Read account-owned production metadata without starting a studio worker. */
import {lstat,realpath,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createRequire} from 'node:module';
import {resolveStudioConfig} from './config.mjs';
import {studioUsageSources} from './studio-usage-sources.mjs';

const accountPattern=/^[a-f0-9]{16}$/;
const dayPattern=/^\d{4}-\d{2}-\d{2}$/;
const states=['authorized','reserved','accepted','completed','failed','unknown','operator-confirmed','awaiting-review'];
const sources=['native','tts','fal','libtv','libtv-cli'];
const usageKeys=['prompt_tokens','completion_tokens','total_tokens','input_tokens','output_tokens','cached_tokens','reasoning_tokens','input_audio_tokens','output_audio_tokens'];
const metrics={input:['input_tokens','prompt_tokens'],output:['output_tokens','completion_tokens'],total:['total_tokens']};
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const count=value=>Number.isSafeInteger(value)&&value>=0;
const samePath=(a,b)=>process.platform==='win32'?a.toLowerCase()===b.toLowerCase():a===b;

/** Fixed errors contain no tenant paths, SQL diagnostics or private database values. */
export class StudioUsageError extends Error{
 constructor(code,status=503){super(code);this.name='StudioUsageError';this.code=code;this.status=status;}
}
const invalid=()=>{throw new StudioUsageError('studio_usage_invalid_query',400);};
const corrupt=()=>{throw new StudioUsageError('studio_usage_corrupt');};
function day(value){if(typeof value!=='string'||!dayPattern.test(value)||!Number.isFinite(Date.parse(value))||new Date(value).toISOString().slice(0,10)!==value)invalid();return value;}
function queryOptions(accountId,value,now){
 if(typeof accountId!=='string'||!accountPattern.test(accountId)||!object(value)||Object.keys(value).some(key=>!['from','to','limit','cursor'].includes(key)))invalid();
 const to=day(value.to===undefined?new Date(now()).toISOString().slice(0,10):value.to);
 const from=day(value.from===undefined?new Date(Date.parse(to)-29*86400000).toISOString().slice(0,10):value.from);
 if(from>to||(Date.parse(to)-Date.parse(from))/86400000>=366)invalid();
 const limit=value.limit===undefined?50:Number(value.limit);if(!Number.isSafeInteger(limit)||limit<1||limit>100)invalid();
 let before=null;
 if(value.cursor!==undefined){
  if(typeof value.cursor!=='string'||value.cursor.length>1024||!/^[A-Za-z0-9_-]+$/.test(value.cursor))invalid();
  let cursor;try{cursor=JSON.parse(Buffer.from(value.cursor,'base64url').toString('utf8'));}catch(error){void error;invalid();}
  if(!Array.isArray(cursor)||cursor.length!==8||cursor[0]!==2||cursor[1]!==accountId||cursor[2]!==from||cursor[3]!==to||typeof cursor[4]!=='string'||!Number.isFinite(Date.parse(cursor[4]))||!sources.includes(cursor[5])||!Number.isSafeInteger(cursor[6])||cursor[6]<1||typeof cursor[7]!=='string'||!cursor[7]||cursor[7].length>128)invalid();before=cursor.slice(4);
 }
 return {from,to,start:from+'T00:00:00.000Z',end:new Date(Date.parse(to)+86400000).toISOString(),limit,before};
}
async function entry(path,{directory=false,privateDirectory=false,maxBytes}={}){
 const info=await lstat(path);
 if(info.isSymbolicLink()||(directory?!info.isDirectory():!info.isFile()||info.nlink!==1)||!samePath(await realpath(path),path)||privateDirectory&&process.platform!=='win32'&&(info.mode&0o077)!==0||maxBytes!==undefined&&info.size>maxBytes)corrupt();
 return info;
}
async function tenantDatabase(config,accountId){
 try{await entry(config.tenantRoot,{directory:true,privateDirectory:true});}catch(error){if(error.code==='ENOENT')return null;throw error;}
 const dir=join(config.tenantRoot,accountId);
 try{await entry(dir,{directory:true,privateDirectory:true});}catch(error){if(error.code==='ENOENT')return null;throw error;}
 const descriptor=join(dir,'tenant.json');await entry(descriptor,{maxBytes:1024});
 let owner;try{owner=JSON.parse(await readFile(descriptor,'utf8'));}catch(error){if(error instanceof SyntaxError)corrupt();throw error;}
 if(!object(owner)||owner.version!==1||owner.accountId!==accountId||Object.keys(owner).length!==2)corrupt();
 const file=join(dir,'drama.db');let info;
 try{info=await entry(file);}catch(error){if(error.code==='ENOENT')return null;throw error;}
 for(const suffix of ['-wal','-shm','-journal'])try{await entry(file+suffix);}catch(error){if(error.code!=='ENOENT')throw error;}
 return {file,info};
}
function emptySummary(){return {operations:0,states:Object.fromEntries(states.map(key=>[key,0])),sources:Object.fromEntries(sources.map(key=>[key,0])),reportedUsageOperations:0,unreportedUsageOperations:0,usageErrorOperations:0,supplierReports:0,inputTokens:null,outputTokens:null,totalTokens:null,
 tokenCoverage:Object.fromEntries(Object.keys(metrics).map(key=>[key,{reportedReports:0,unreportedReports:0,overflow:false}])),resources:{images:0,videos:0,audios:0,tasks:0},budgetTotals:[]};}
function emptyReply(accountId,q,status){return {version:2,scope:'studio-all',accountId,from:q.from,to:q.to,status,billingVerified:false,coveredSources:[],summary:emptySummary(),items:[],nextCursor:null,health:{state:'ok',invalidUsageReports:0}};}
function parseUsage(raw){
 if(typeof raw!=='string'||Buffer.byteLength(raw)>4096)return {usage:null,invalid:true};
 let value;try{value=JSON.parse(raw);}catch(error){void error;return {usage:null,invalid:true};}
 if(!object(value))return {usage:null,invalid:true};
 const usage={};let invalid=false,reported=false;
 for(const key of usageKeys){const valueAtKey=value[key];usage[key]=count(valueAtKey)?valueAtKey:null;reported||=usage[key]!==null;if(valueAtKey!==null&&valueAtKey!==undefined&&usage[key]===null)invalid=true;}
 return {usage:reported?usage:null,invalid:invalid||!reported};
}
function addUsage(target,usage){
 for(const [key,aliases]of Object.entries(metrics)){
  const coverage=target.tokenCoverage[key],value=aliases.map(name=>usage?.[name]).find(count),field=key+'Tokens';
  if(value===undefined){coverage.unreportedReports++;continue;}
  coverage.reportedReports++;
  if(coverage.overflow)continue;
  const sum=(target[field]??0)+value;
  if(!Number.isSafeInteger(sum)){coverage.overflow=true;target[field]=null;}else target[field]=sum;
 }
}
function resourceCounts(){return {images:0,videos:0,audios:0,tasks:0};}
const resourceFields={image:'images',video:'videos',audio:'audios',task:'tasks'};
function rowMetadata(row){
 if(typeof row.operation_id!=='string'||row.operation_id.length>128||!sources.includes(row.source)||typeof row.kind!=='string'||!/^[a-z][a-z0-9_-]{0,31}$/.test(row.kind)||typeof row.raw_state!=='string'||!/^[a-z][a-z0-9_-]{0,63}$/.test(row.raw_state)||!states.includes(row.state)||typeof row.created_at!=='string'||!Number.isFinite(Date.parse(row.created_at))||typeof row.updated_at!=='string'||!Number.isFinite(Date.parse(row.updated_at))||row.http_status!==null&&(!Number.isInteger(row.http_status)||row.http_status<100||row.http_status>599))corrupt();
 return {operationId:row.operation_id,source:row.source,kind:row.kind,state:row.state,recordedState:row.raw_state,createdAt:row.created_at,updatedAt:row.updated_at,httpStatus:row.http_status,errorCode:row.error_code===null?null:typeof row.error_code==='string'&&/^[a-z][a-z0-9_]{0,127}$/.test(row.error_code)?row.error_code:'production_operation_error',usageStatus:'unreported',supplierReports:0,inputTokens:null,outputTokens:null,totalTokens:null,resources:resourceCounts(),budgetTotals:[]};
}
function addBudget(totals,row){
 if(typeof row.currency!=='string'||!/^[A-Z]{3}$/.test(row.currency)||!count(row.reserved_minor)||row.settled_minor!==null&&!count(row.settled_minor))corrupt();
 let total=totals.find(value=>value.currency===row.currency);
 if(!total){total={currency:row.currency,entries:0,unsettledEntries:0,settledEntries:0,reservedMinor:0,heldMinor:0,settledMinor:null,overflow:false,overflows:{reservedMinor:false,heldMinor:false,settledMinor:false}};totals.push(total);}
 total.entries++;total.unsettledEntries+=row.settled_minor===null?1:0;total.settledEntries+=row.settled_minor===null?0:1;
 for(const [field,value]of [['reservedMinor',row.reserved_minor],['heldMinor',row.settled_minor===null?row.reserved_minor:0],...row.settled_minor===null?[]:[['settledMinor',row.settled_minor]]]){
  if(total.overflows[field])continue;
  const sum=(total[field]??0)+value;if(!count(sum)){total[field]=null;total.overflow=true;total.overflows[field]=true;}else total[field]=sum;
 }
}
function readSnapshot(db,accountId,q){
 const saved=studioUsageSources(db,code=>{throw new StudioUsageError(code);});
 if(saved.operationsSql===null)return emptyReply(accountId,q,'not-instrumented');
 const response=emptyReply(accountId,q,'recorded'),summary=response.summary;
 response.coveredSources=saved.coveredSources;
 const where='o.created_at>=? AND o.created_at<?',params=[q.start,q.end],relation=`WITH operations AS (${saved.operationsSql}),resources AS (${saved.resourcesSql})`;
 for(const row of db.prepare(`${relation} SELECT o.source,o.state,COUNT(*) AS count FROM operations o WHERE ${where} GROUP BY o.source,o.state`).iterate(...params)){
  if(!sources.includes(row.source)||!states.includes(row.state)||!count(row.count))corrupt();summary.states[row.state]+=row.count;summary.sources[row.source]+=row.count;summary.operations+=row.count;
 }
 const usageErrors=new Set(),reported=new Set();
 if(saved.native){
 const savedFailures=db.prepare(`SELECT o.operation_id FROM muse_native_operations o WHERE ${where} AND o.error_code='supplier_usage_not_saved'`);
 for(const row of savedFailures.iterate(...params))usageErrors.add(row.operation_id);
 for(const row of db.prepare(`SELECT u.operation_id,u.usage_json FROM muse_native_supplier_usage u JOIN muse_native_operations o ON o.operation_id=u.operation_id WHERE ${where}`).iterate(...params)){
  summary.supplierReports++;const result=parseUsage(row.usage_json);addUsage(summary,result.usage);if(result.usage)reported.add(row.operation_id);
  if(result.invalid){response.health.invalidUsageReports++;usageErrors.add(row.operation_id);}
 }}
 summary.reportedUsageOperations=reported.size;summary.unreportedUsageOperations=summary.operations-reported.size;summary.usageErrorOperations=usageErrors.size;
 for(const row of db.prepare(`${relation} SELECT r.kind,COUNT(DISTINCT r.resource_id) AS count FROM resources r JOIN operations o ON o.source=r.source AND o.operation_id=r.operation_id WHERE ${where} GROUP BY r.kind`).iterate(...params)){
  if(!Object.hasOwn(resourceFields,row.kind)||!count(row.count))corrupt();summary.resources[resourceFields[row.kind]]=row.count;
 }
 const selected=db.prepare(`${relation} SELECT o.* FROM operations o WHERE ${where}${q.before===null?'':' AND (o.created_at,o.source,o.sequence,o.operation_id)<(?,?,?,?)'} ORDER BY o.created_at DESC,o.source DESC,o.sequence DESC,o.operation_id DESC LIMIT ?`).all(...params,...q.before===null?[]:q.before,q.limit+1);
 const usageStatement=saved.native?db.prepare('SELECT usage_json FROM muse_native_supplier_usage WHERE operation_id=? ORDER BY call_id'):null;
 const resourcesStatement=db.prepare(`WITH resources AS (${saved.resourcesSql}) SELECT kind,COUNT(DISTINCT resource_id) AS count FROM resources WHERE source=? AND operation_id=? GROUP BY kind`);
 const budgetSql=saved.budget?"SELECT json_extract(profile_json,'$.currency') AS currency,reserved_minor,settled_minor FROM muse_budget_entries WHERE source=? AND COALESCE(CASE WHEN source='native' THEN parent_operation_id END,operation_id)=?":null;
 const budgetStatement=budgetSql?db.prepare(budgetSql):null;
 for(const row of selected.slice(0,q.limit)){
  const item=rowMetadata(row),totals=emptySummary();
  if(row.source==='native'&&usageStatement)for(const report of usageStatement.iterate(row.operation_id)){const parsed=parseUsage(report.usage_json);item.supplierReports++;addUsage(totals,parsed.usage);}
  for(const key of Object.keys(metrics))item[key+'Tokens']=totals[key+'Tokens'];
  item.usageStatus=row.source==='native'&&usageErrors.has(row.operation_id)?'error':row.source==='native'&&reported.has(row.operation_id)?'reported':'unreported';
  for(const resource of resourcesStatement.iterate(row.source,row.operation_id)){if(!Object.hasOwn(resourceFields,resource.kind)||!count(resource.count))corrupt();item.resources[resourceFields[resource.kind]]=resource.count;}
  if(budgetStatement)for(const entry of budgetStatement.iterate(row.source,row.operation_id))addBudget(item.budgetTotals,entry);
  response.items.push(item);
 }
 if(saved.budget)for(const row of db.prepare(`${relation} SELECT json_extract(b.profile_json,'$.currency') AS currency,b.reserved_minor,b.settled_minor FROM muse_budget_entries b JOIN operations o ON o.source=b.source AND o.operation_id=COALESCE(CASE WHEN b.source='native' THEN b.parent_operation_id END,b.operation_id) WHERE ${where}`).iterate(...params))addBudget(summary.budgetTotals,row);
 if(selected.length>q.limit){const last=selected[q.limit-1];response.nextCursor=Buffer.from(JSON.stringify([2,accountId,q.from,q.to,last.created_at,last.source,last.sequence,last.operation_id])).toString('base64url');}
 if(summary.usageErrorOperations||Object.values(summary.tokenCoverage).some(value=>value.overflow)||summary.budgetTotals.some(value=>value.overflow))response.health.state='degraded';
 return response;
}

/** Create a read-only metadata reader; account selection and role checks belong to the authenticated gateway.
 * @param {object} input Complete, validated administrator-authored studio configuration.
 * @param {object} options Instance-local clock for default UTC query dates.
 * @returns {object} An asynchronous query that opens and closes only the selected account database.
 */
export function createStudioUsageReader(input,{now=Date.now}={}){
 const config=resolveStudioConfig(input),require=createRequire(join(config.backendRoot,'package.json'));let Database;
 return {
  /** Read saved production states, linked resources, budget amounts and reported token fields across installed sources.
   * @param {string} accountId Verified stable Muse account ID; never a path or browser-selected identity.
   * @param {object} options Inclusive UTC dates, bounded page length and account/date-bound cursor.
   * @returns {Promise<object>} Metadata only; missing reports stay null and billing is never inferred.
   */
  async query(accountId,options={}){
   const q=queryOptions(accountId,options,now);let db;
   try{
    const selected=await tenantDatabase(config,accountId);if(!selected)return emptyReply(accountId,q,'no-database');
    Database??=require('better-sqlite3');db=new Database(selected.file,{readonly:true,fileMustExist:true,timeout:0});
    db.pragma('query_only = ON');db.pragma('trusted_schema = OFF');
    const current=await lstat(selected.file);if(current.dev!==selected.info.dev||current.ino!==selected.info.ino||!current.isFile()||current.isSymbolicLink()||current.nlink!==1)corrupt();
    return db.transaction(()=>readSnapshot(db,accountId,q))();
   }catch(error){if(error instanceof StudioUsageError)throw error;throw new StudioUsageError(error instanceof SyntaxError?'studio_usage_corrupt':'studio_usage_unavailable');}
   finally{try{db?.close();}catch(error){void error;throw new StudioUsageError('studio_usage_unavailable');}}
  },
 };
}

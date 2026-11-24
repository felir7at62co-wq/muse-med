/** Authoritative account-owned gateway model requests and supplier token reports, independent of accounts and Bot logs. */
import {randomUUID} from 'node:crypto';
import {mkdir,lstat,open} from 'node:fs/promises';
import {dirname,isAbsolute} from 'node:path';
import {createModelUsageObserver} from './model-usage-stream.mjs';

const SCHEMA_VERSION=1,dayMs=86400000,cstMs=28800000;
const fields=['inputTokens','outputTokens','totalTokens','cacheReadTokens','cacheWriteTokens','reasoningTokens'];
const columns=['input_tokens','output_tokens','total_tokens','cache_read_tokens','cache_write_tokens','reasoning_tokens'];
const dateAt=time=>new Date(time+cstMs).toISOString().slice(0,10);
function day(value){if(typeof value!=='string'||!/^\d{4}-\d\d-\d\d$/.test(value)||!Number.isFinite(Date.parse(value))||new Date(value).toISOString().slice(0,10)!==value)throw Error('Invalid model usage date');return Date.parse(value)-cstMs;}
function bounded(value,name){if(typeof value!=='string'||!value.length||value.length>200||/[\x00-\x1f\x7f]/.test(value))throw Error('Invalid model usage '+name);return value;}

/** Resolve an inclusive Beijing-calendar range and optional account/provider/model filters.
 * @param {object} input Administrator query fields; omitted dates cover the last thirty calendar days.
 * @param {number} now Current epoch milliseconds.
 * @returns {object} Validated filters and exclusive epoch end.
 */
export function modelUsageQuery(input={},now=Date.now()){
 const from=input.from??dateAt(now-29*dayMs),to=input.to??dateAt(now),start=day(from),end=day(to)+dayMs;
 if(end<=start||end-start>366*dayMs)throw Error('Model usage range must contain 1 to 366 days');
 const result={from,to,start,end};
 for(const key of ['accountId','provider','model'])if(input[key]!==undefined&&input[key]!=='')result[key]=bounded(input[key],key);
 return result;
}

/** Open one private, single-writer SQLite ledger; existing request history is never rebuilt or dropped.
 * @param {string} file Absolute path outside releases and user-visible mounts.
 * @param {object} options Injectable clock and safe failure callback; metrics failures do not fail model replies.
 * @returns {Promise<object>} Request lifecycle operations, read-only summaries, health and close.
 * @throws {Error} Invalid private storage, unreadable data, or a newer schema version.
 */
export async function openModelUsage(file,{now=Date.now,onError=()=>console.error('[muse-model-usage] Metering write failed')}={}){
 if(!isAbsolute(file))throw Error('Model usage file must be absolute');
 const parent=dirname(file);await mkdir(parent,{recursive:true,mode:0o700});
 const directory=await lstat(parent);if(!directory.isDirectory()||directory.isSymbolicLink()||process.platform!=='win32'&&(directory.mode&0o077)!==0)throw Error('Model usage directory must be private');
 try{const handle=await open(file,'wx',0o600);await handle.close();}catch(error){if(error.code!=='EEXIST')throw error;}
 const metadata=await lstat(file);if(!metadata.isFile()||metadata.isSymbolicLink()||process.platform!=='win32'&&(metadata.mode&0o077)!==0)throw Error('Model usage file must be private');
 const {DatabaseSync}=await import('node:sqlite');
 const db=new DatabaseSync(file);let closing=false,closed=false,closePromise,writeFailures=0,lastWriteFailureAt=null;
 const active=new Set(),idleWaiters=new Set();
 try{
  db.exec('PRAGMA busy_timeout=100; PRAGMA foreign_keys=ON;');
  const version=db.prepare('PRAGMA user_version').get().user_version;
  if(version>SCHEMA_VERSION)throw Error('Model usage schema is newer than this gateway');
  if(version===0){
   db.exec(`BEGIN IMMEDIATE;
    CREATE TABLE requests(id TEXT PRIMARY KEY,account_id TEXT NOT NULL,provider TEXT NOT NULL,model TEXT NOT NULL,entry TEXT NOT NULL,
     started_at INTEGER NOT NULL,finished_at INTEGER,outcome TEXT NOT NULL,usage_state TEXT NOT NULL,http_status INTEGER,
     input_tokens INTEGER,output_tokens INTEGER,total_tokens INTEGER,cache_read_tokens INTEGER,cache_write_tokens INTEGER,reasoning_tokens INTEGER);
    CREATE INDEX requests_time ON requests(started_at);
    CREATE INDEX requests_account_time ON requests(account_id,started_at);
    CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);`);
   try{db.prepare('INSERT INTO metadata VALUES(?,?)').run('recordingSince',String(now()));db.exec('PRAGMA user_version=1;COMMIT;');}
   catch(error){db.exec('ROLLBACK');throw error;}
  }
  db.exec('PRAGMA journal_mode=WAL;');
  // No active request can survive ownership transfer to a new gateway process.
  db.prepare("UPDATE requests SET outcome='interrupted',usage_state=CASE WHEN input_tokens IS NULL AND output_tokens IS NULL AND total_tokens IS NULL THEN 'unknown' ELSE 'partial' END,finished_at=? WHERE outcome='active'").run(now());
 }catch(error){db.close();throw error;}
 const since=Number(db.prepare("SELECT value FROM metadata WHERE key='recordingSince'").get()?.value);
 if(!Number.isSafeInteger(since)){db.close();throw Error('Model usage metadata is invalid');}
 const insert=db.prepare("INSERT INTO requests(id,account_id,provider,model,entry,started_at,outcome,usage_state) VALUES(?,?,?,?,?,?,'active','unknown')");
 const finish=db.prepare(`UPDATE requests SET finished_at=?,outcome=?,usage_state=?,http_status=?,${columns.map(name=>name+'=?').join(',')} WHERE id=? AND outcome='active'`);
 const safe=operation=>{try{return operation();}catch(error){writeFailures++;lastWriteFailureAt=now();try{onError();}catch(callbackError){/* Diagnostic callbacks must not alter a model response. */}return null;}};
 const metricSql=`COUNT(*) AS requests,SUM(outcome='completed') AS completed,SUM(outcome='failed') AS failed,SUM(outcome='interrupted') AS interrupted,SUM(outcome='active') AS active,
  SUM(usage_state='reported') AS reported,SUM(usage_state='partial') AS partial,SUM(usage_state='unknown') AS unknown,${columns.map(name=>`SUM(${name}) AS ${name},COUNT(${name}) AS ${name}_reports`).join(',')}`;
 const project=row=>{
  const result={...row};for(let index=0;index<fields.length;index++){const field=fields[index],column=columns[index];result[field]=row[column];result[field+'Reports']=row[column+'_reports'];delete result[column];delete result[column+'_reports'];}
  for(const key of ['completed','failed','interrupted','active','reported','partial','unknown'])result[key]??=0;
  return result;
 };
 return {
  begin({accountId,provider,model,entry}){
   bounded(accountId,'account ID');bounded(provider,'provider');bounded(model,'model');
   if(!['desktop','legacy'].includes(entry))throw Error('Invalid model usage entry');
   const id=randomUUID();return safe(()=>{if(closing||closed)throw Error('Model usage ledger closed');insert.run(id,accountId,provider,model,entry,now());active.add(id);return id;});
  },
  finish(id,{outcome,sample=null,complete=false,httpStatus=null}){
   if(!id)return;
   if(!['completed','failed','interrupted'].includes(outcome))throw Error('Invalid model usage outcome');
   const values=fields.map(field=>Number.isSafeInteger(sample?.[field])&&sample[field]>=0?sample[field]:null);
   const state=values.some(value=>value!==null)?outcome==='completed'&&complete?'reported':'partial':'unknown';
   safe(()=>finish.run(now(),outcome,state,Number.isSafeInteger(httpStatus)?httpStatus:null,...values,id));
   active.delete(id);if(!active.size){for(const resolve of idleWaiters)resolve();idleWaiters.clear();}
  },
  summary(input={}){
   const query=modelUsageQuery(input,now()),conditions=['started_at>=?','started_at<?'],args=[query.start,query.end];
   for(const [key,column] of [['accountId','account_id'],['provider','provider'],['model','model']])if(query[key]){conditions.push(column+'=?');args.push(query[key]);}
   const where=' FROM requests WHERE '+conditions.join(' AND ');
   const group=(select,key)=>db.prepare('SELECT '+select+','+metricSql+where+' GROUP BY '+key+' ORDER BY requests DESC LIMIT 1001').all(...args).map(project);
   const users=group('account_id AS accountId','account_id'),models=group('provider,model','provider,model');
   const days=group("strftime('%Y-%m-%d',started_at/1000,'unixepoch','+8 hours') AS date",'date').sort((a,b)=>a.date.localeCompare(b.date));
   return {filters:{from:query.from,to:query.to,...query.accountId?{accountId:query.accountId}:{},...query.provider?{provider:query.provider}:{},...query.model?{model:query.model}:{}},
    timezone:'Asia/Shanghai',recordingSince:new Date(since).toISOString(),totals:project(db.prepare('SELECT '+metricSql+where).get(...args)),
    users:users.slice(0,1000),models:models.slice(0,1000),days,limited:users.length>1000||models.length>1000,
    health:{writeFailures,lastWriteFailureAt:lastWriteFailureAt===null?null:new Date(lastWriteFailureAt).toISOString()},cost:null,
    coverage:'server-relay-only'};
  },
  close(){if(closePromise)return closePromise;closing=true;closePromise=(async()=>{if(active.size)await new Promise(resolve=>idleWaiters.add(resolve));closed=true;db.close();})();return closePromise;},
 };
}

/** Meter one validated relay dispatch by its authenticated account, recording unknown tokens on incomplete delivery.
 * @param {object} options Shared ledger, authenticated metadata, forwarding implementation and existing request options.
 * @returns {Promise<void>} The original forwarding result, without hiding transport failures.
 */
export async function forwardMeteredModel({ledger,accountId,provider,model,entry,forward,request}){
 if(!ledger)return forward(request);
 const id=ledger.begin({accountId,provider,model,entry}),usage=createModelUsageObserver({stream:!!request.body.stream});
 let outcome='completed';
 try{await forward({...request,usage});if(request.res.statusCode>=400)outcome='failed';}
 catch(error){outcome=request.signal?.aborted?'interrupted':'failed';throw error;}
 finally{const report=usage.snapshot();ledger.finish(id,{outcome,sample:report.sample,complete:report.complete,httpStatus:report.status??request.res.statusCode});}
}

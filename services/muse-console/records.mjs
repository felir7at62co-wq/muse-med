/** Read-only queries over the exported model-request metadata. All times are epoch milliseconds. */
import {DatabaseSync} from 'node:sqlite';
import {dayStart} from './export.mjs';

const FAILED="(outcome='failed' OR http_status>=400)";

/**
 * Open the export database for reading.
 * @param {string} path Export database written by `export.mjs`.
 * @returns {DatabaseSync} Read-only handle that waits briefly while the exporter writes.
 */
export function openRecords(path){
 const db=new DatabaseSync(path,{readOnly:true});
 db.exec('PRAGMA busy_timeout=3000');
 return db;
}

function where({from,to,accountIds,provider,model,status}){
 const clauses=['started_at>=?','started_at<?'],params=[from,to];
 if(accountIds){
  if(!accountIds.length)return {sql:'0',params:[]};
  clauses.push(`account_id IN (${accountIds.map(()=>'?').join(',')})`);params.push(...accountIds);
 }
 if(provider){clauses.push('provider=?');params.push(provider);}
 if(model){clauses.push('model=?');params.push(model);}
 if(status==='failed')clauses.push(FAILED);
 else if(status==='active')clauses.push("outcome='active'");
 else if(status==='interrupted')clauses.push("outcome='interrupted'");
 else if(status==='completed')clauses.push(`outcome='completed' AND NOT ${FAILED}`);
 return {sql:clauses.join(' AND '),params};
}

function dailyWhere({from,to,accountIds,provider,model}){
 const clauses=['day_start>=?','day_start<?'],params=[dayStart(from),to];
 if(accountIds){
  if(!accountIds.length)return {sql:'0',params:[]};
  clauses.push(`account_id IN (${accountIds.map(()=>'?').join(',')})`);params.push(...accountIds);
 }
 if(provider){clauses.push('provider=?');params.push(provider);}
 if(model){clauses.push('model=?');params.push(model);}
 return {sql:clauses.join(' AND '),params};
}

function priced(groups,prices){
 let known=0,unpriced=0;
 for(const group of groups){const value=prices.cost(group);if(value===null)unpriced+=group.requests;else known+=value;}
 return {yuan:known,unpricedRequests:unpriced};
}

/**
 * Totals for whole Asia/Shanghai days, read from the per-day table the exporter maintains.
 * @param {DatabaseSync} db Export database.
 * @param {object} prices Price lookup from `prices.mjs`.
 * @param {{from:number,to:number,accountIds?:string[]|null,provider?:string,model?:string}} range Range widened to the start of `from`'s day, and optional restrictions.
 * @returns {{requests:number,people:number,failed:number,active:number,cost:{yuan:number,unpricedRequests:number}}} Totals.
 */
export function summary(db,prices,range){
 const {sql,params}=dailyWhere(range);
 const totals=db.prepare(`SELECT sum(requests) requests,count(DISTINCT account_id) people,sum(failed) failed,sum(active) active FROM daily WHERE ${sql}`).get(...params);
 const groups=db.prepare(`SELECT provider,model,sum(requests) requests,sum(input_tokens) input_tokens,sum(cache_read_tokens) cache_read_tokens,sum(output_tokens) output_tokens FROM daily WHERE ${sql} GROUP BY provider,model`).all(...params);
 return {requests:Number(totals.requests??0),people:Number(totals.people??0),failed:Number(totals.failed??0),active:Number(totals.active??0),cost:priced(groups,prices)};
}

/**
 * One page of requests, newest first.
 * @param {DatabaseSync} db Export database.
 * @param {object} prices Price lookup.
 * @param {{from:number,to:number,accountIds?:string[]|null,provider?:string,model?:string,status?:string,before?:{startedAt:number,id:string}|null,limit?:number}} filters Filters and keyset cursor.
 * @returns {{rows:object[],next:{startedAt:number,id:string}|null}} Rows with an estimated cost each, and the cursor for the next page.
 */
export function list(db,prices,filters){
 const limit=Math.min(Math.max(filters.limit??100,1),10_000);
 const {sql,params}=where(filters);
 let cursor='';
 if(filters.before){cursor=' AND (started_at<? OR (started_at=? AND id<?))';params.push(filters.before.startedAt,filters.before.startedAt,filters.before.id);}
 const rows=db.prepare(`SELECT * FROM requests WHERE ${sql}${cursor} ORDER BY started_at DESC,id DESC LIMIT ${limit+1}`).all(...params);
 const page=rows.slice(0,limit).map(row=>({...row,failed:row.outcome==='failed'||Number(row.http_status)>=400,cost:prices.cost({...row})}));
 const last=page.at(-1);
 return {rows:page,next:rows.length>limit&&last?{startedAt:last.started_at,id:last.id}:null};
}

/**
 * Spend and volume per account for whole Asia/Shanghai days.
 * @param {DatabaseSync} db Export database.
 * @param {object} prices Price lookup.
 * @param {{from:number,to:number,accountIds?:string[]|null}} range Range widened to the start of `from`'s day.
 * @returns {Map<string,{requests:number,failed:number,yuan:number,unpricedRequests:number}>} Per-account totals.
 */
export function byAccount(db,prices,range){
 const {sql,params}=dailyWhere(range);
 const result=new Map();
 for(const group of db.prepare(`SELECT account_id,provider,model,sum(requests) requests,sum(failed) failed,sum(input_tokens) input_tokens,sum(cache_read_tokens) cache_read_tokens,sum(output_tokens) output_tokens FROM daily WHERE ${sql} GROUP BY account_id,provider,model`).all(...params)){
  const entry=result.get(group.account_id)??{requests:0,failed:0,yuan:0,unpricedRequests:0};
  const value=prices.cost(group);
  entry.requests+=Number(group.requests);entry.failed+=Number(group.failed??0);
  if(value===null)entry.unpricedRequests+=Number(group.requests);else entry.yuan+=value;
  result.set(group.account_id,entry);
 }
 return result;
}

/**
 * Volume, failure rate and latency per route.
 * @param {DatabaseSync} db Export database.
 * @param {{from:number,to:number}} range Time range.
 * @returns {Array<{provider:string,requests:number,people:number,failed:number,averageMs:number|null}>} One row per route, busiest first.
 */
export function byProvider(db,range){
 const {sql,params}=where(range);
 return db.prepare(`SELECT provider,count(*) requests,count(DISTINCT account_id) people,sum(${FAILED}) failed,avg(CASE WHEN finished_at IS NOT NULL THEN finished_at-started_at END) average_ms FROM requests WHERE ${sql} GROUP BY provider ORDER BY requests DESC`).all(...params)
  .map(row=>({provider:row.provider,requests:Number(row.requests),people:Number(row.people),failed:Number(row.failed??0),averageMs:row.average_ms===null?null:Math.round(Number(row.average_ms))}));
}

/**
 * Distinct providers and models seen on the range's days, for filter menus.
 * @param {DatabaseSync} db Export database.
 * @param {{from:number,to:number}} range Time range.
 * @returns {{providers:string[],models:string[]}} Sorted values.
 */
export function choices(db,range){
 const rows=db.prepare('SELECT DISTINCT provider,model FROM daily WHERE day_start>=? AND day_start<?').all(dayStart(range.from),range.to);
 return {providers:[...new Set(rows.map(row=>row.provider))].sort(),models:[...new Set(rows.map(row=>row.model))].sort()};
}

/**
 * When the exporter last ran.
 * @param {DatabaseSync} db Export database.
 * @returns {number|null} Epoch milliseconds, or null before the first export.
 */
export function exportedAt(db){
 const value=db.prepare("SELECT value FROM meta WHERE key='requests.exported_at'").get()?.value;
 return value===undefined?null:Number(value);
}

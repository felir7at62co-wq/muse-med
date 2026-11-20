/**
 * Copies gateway model-request metadata into the console's own read-only database.
 *
 * Runs as the gateway service user from a timer. The source holds no prompts, replies or keys; this copy keeps the
 * same metadata columns only. Rows are re-read for a trailing window because the gateway updates a row when its
 * request finishes. The target uses a rollback journal so a reader without write access can open it.
 *
 * Usage: node export.mjs --source <gateway requests.sqlite> --target <console export.sqlite> [--window-minutes 30] [--retention-days 120]
 */
import {DatabaseSync} from 'node:sqlite';
import {isAbsolute} from 'node:path';
import {pathToFileURL} from 'node:url';
import {realpathSync} from 'node:fs';

export const COLUMNS=['id','account_id','provider','model','entry','started_at','finished_at','outcome','usage_state','http_status',
 'input_tokens','output_tokens','total_tokens','cache_read_tokens','cache_write_tokens','reasoning_tokens'];

const BATCH=20000;

/**
 * Create or open the console export database with its schema.
 * @param {string} path Target database path.
 * @returns {DatabaseSync} Open database in rollback-journal mode.
 */
export function openExport(path){
 const db=new DatabaseSync(path);
 db.exec(`PRAGMA journal_mode=DELETE;
  CREATE TABLE IF NOT EXISTS requests(id TEXT PRIMARY KEY,account_id TEXT NOT NULL,provider TEXT NOT NULL,model TEXT NOT NULL,entry TEXT NOT NULL,
   started_at INTEGER NOT NULL,finished_at INTEGER,outcome TEXT NOT NULL,usage_state TEXT NOT NULL,http_status INTEGER,
   input_tokens INTEGER,output_tokens INTEGER,total_tokens INTEGER,cache_read_tokens INTEGER,cache_write_tokens INTEGER,reasoning_tokens INTEGER);
  CREATE INDEX IF NOT EXISTS requests_time ON requests(started_at);
  CREATE INDEX IF NOT EXISTS requests_account_time ON requests(account_id,started_at);
  CREATE TABLE IF NOT EXISTS daily(day_start INTEGER NOT NULL,account_id TEXT NOT NULL,provider TEXT NOT NULL,model TEXT NOT NULL,
   requests INTEGER NOT NULL,failed INTEGER NOT NULL,active INTEGER NOT NULL,input_tokens INTEGER NOT NULL,cache_read_tokens INTEGER NOT NULL,output_tokens INTEGER NOT NULL,
   PRIMARY KEY(day_start,account_id,provider,model));
  CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);`);
 return db;
}

const DAY=86_400_000,SHANGHAI=8*3_600_000;

/**
 * Start of the Asia/Shanghai calendar day containing a time.
 * @param {number} ms Epoch milliseconds.
 * @returns {number} Epoch milliseconds of that day's midnight in Asia/Shanghai.
 */
export const dayStart=ms=>Math.floor((ms+SHANGHAI)/DAY)*DAY-SHANGHAI;

/**
 * Recompute per-day, per-account, per-model totals from `requests` for every day starting at or after `from`.
 * @param {DatabaseSync} db Export database.
 * @param {number} from Any time inside the first day to rebuild.
 * @returns {void}
 */
export function rebuildDaily(db,from){
 const start=dayStart(from);
 db.exec('BEGIN');
 try{
  db.prepare('DELETE FROM daily WHERE day_start>=?').run(start);
  db.prepare(`INSERT INTO daily(day_start,account_id,provider,model,requests,failed,active,input_tokens,cache_read_tokens,output_tokens)
   SELECT ((started_at+${SHANGHAI})/${DAY})*${DAY}-${SHANGHAI},account_id,provider,model,count(*),
    sum(outcome='failed' OR coalesce(http_status,0)>=400),sum(outcome='active'),coalesce(sum(input_tokens),0),coalesce(sum(cache_read_tokens),0),coalesce(sum(output_tokens),0)
   FROM requests WHERE started_at>=? GROUP BY 1,2,3,4`).run(start);
  db.exec('COMMIT');
 }catch(error){db.exec('ROLLBACK');throw error;}
}

/**
 * Copy new and recently changed request rows from the gateway database.
 * @param {DatabaseSync} source Gateway database opened read-only.
 * @param {DatabaseSync} target Console export database.
 * @param {{windowMs:number,retentionMs:number,now:number}} options Re-read window, retention and current time.
 * @returns {{copied:number,syncedUntil:number,removed:number}} Rows written, newest start time seen and rows dropped by retention.
 */
export function exportRequests(source,target,{windowMs,retentionMs,now}){
 const read=key=>target.prepare('SELECT value FROM meta WHERE key=?').get(key)?.value;
 const previous=Number(read('requests.synced_until')??0);
 const from=Math.max(0,previous-windowMs,now-retentionMs);
 const select=source.prepare(`SELECT ${COLUMNS.join(',')} FROM requests WHERE (started_at>? OR (started_at=? AND id>?)) ORDER BY started_at,id LIMIT ${BATCH}`);
 const upsert=target.prepare(`INSERT INTO requests(${COLUMNS.join(',')}) VALUES(${COLUMNS.map(()=>'?').join(',')})
  ON CONFLICT(id) DO UPDATE SET ${COLUMNS.filter(column=>column!=='id').map(column=>column+'=excluded.'+column).join(',')}`);
 let cursor={started_at:from-1,id:''},copied=0,syncedUntil=previous;
 for(;;){
  const rows=select.all(cursor.started_at,cursor.started_at,cursor.id);
  if(!rows.length)break;
  target.exec('BEGIN');
  try{
   for(const row of rows)upsert.run(...COLUMNS.map(column=>row[column]??null));
   target.exec('COMMIT');
  }catch(error){target.exec('ROLLBACK');throw error;}
  copied+=rows.length;
  const last=rows.at(-1);cursor={started_at:last.started_at,id:last.id};
  syncedUntil=Math.max(syncedUntil,last.started_at);
  if(rows.length<BATCH)break;
 }
 const removed=Number(target.prepare('DELETE FROM requests WHERE started_at<?').run(now-retentionMs).changes);
 target.prepare('DELETE FROM daily WHERE day_start<?').run(dayStart(now-retentionMs));
 rebuildDaily(target,from);
 const meta=target.prepare('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');
 meta.run('requests.synced_until',String(syncedUntil));
 meta.run('requests.exported_at',String(now));
 return {copied,syncedUntil,removed};
}

function parse(argv){
 const options={windowMinutes:30,retentionDays:120};
 for(let i=0;i<argv.length;i+=2){
  const [flag,value]=[argv[i],argv[i+1]];
  if(flag==='--source')options.source=value;
  else if(flag==='--target')options.target=value;
  else if(flag==='--window-minutes')options.windowMinutes=Number(value);
  else if(flag==='--retention-days')options.retentionDays=Number(value);
  else throw Error('usage');
 }
 if(!isAbsolute(options.source??'')||!isAbsolute(options.target??''))throw Error('usage');
 if(!Number.isInteger(options.windowMinutes)||options.windowMinutes<1||options.windowMinutes>1440)throw Error('usage');
 if(!Number.isInteger(options.retentionDays)||options.retentionDays<1||options.retentionDays>730)throw Error('usage');
 return options;
}

async function main(){
 const options=parse(process.argv.slice(2));
 const source=new DatabaseSync(options.source,{readOnly:true});
 const target=openExport(options.target);
 try{
  const result=exportRequests(source,target,{windowMs:options.windowMinutes*60_000,retentionMs:options.retentionDays*86_400_000,now:Date.now()});
  console.log(JSON.stringify({ok:true,...result}));
 }finally{source.close();target.close();}
}

// Compare real paths: deployments start the file through the `current` release symlink.
if(process.argv[1]&&import.meta.url===pathToFileURL(realpathSync(process.argv[1])).href)
 main().catch(error=>{console.error(JSON.stringify({ok:false,code:error?.message==='usage'?'usage':'export_failed'}));process.exitCode=1;});

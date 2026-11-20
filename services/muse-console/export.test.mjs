import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {openExport,exportRequests,COLUMNS} from './export.mjs';

function gatewayDb(path){
 const db=new DatabaseSync(path);
 db.exec(`CREATE TABLE requests(id TEXT PRIMARY KEY,account_id TEXT NOT NULL,provider TEXT NOT NULL,model TEXT NOT NULL,entry TEXT NOT NULL,
  started_at INTEGER NOT NULL,finished_at INTEGER,outcome TEXT NOT NULL,usage_state TEXT NOT NULL,http_status INTEGER,
  input_tokens INTEGER,output_tokens INTEGER,total_tokens INTEGER,cache_read_tokens INTEGER,cache_write_tokens INTEGER,reasoning_tokens INTEGER)`);
 return db;
}
const insert=(db,row)=>db.prepare(`INSERT INTO requests(${COLUMNS.join(',')}) VALUES(${COLUMNS.map(()=>'?').join(',')})`).run(...COLUMNS.map(column=>row[column]??null));
const row=(id,startedAt,extra={})=>({id,account_id:'a1',provider:'deepseek-official',model:'deepseek-v4.1-flash-261017',entry:'desktop',started_at:startedAt,outcome:'active',usage_state:'unknown',...extra});

test('copies new rows, refreshes rows that finished inside the window and drops expired rows',()=>{
 const dir=mkdtempSync(join(tmpdir(),'muse-console-export-'));
 try{
  const source=gatewayDb(join(dir,'source.sqlite')),target=openExport(join(dir,'export.sqlite'));
  const now=10_000_000_000;
  insert(source,row('old',now-200*86_400_000,{outcome:'completed'}));
  insert(source,row('r1',now-60_000));
  insert(source,row('r2',now-30_000,{outcome:'completed',input_tokens:100}));
  const first=exportRequests(source,target,{windowMs:1_800_000,retentionMs:120*86_400_000,now});
  assert.equal(first.copied,2);
  assert.equal(target.prepare('SELECT count(*) n FROM requests').get().n,2);
  source.prepare("UPDATE requests SET outcome='completed',finished_at=?,output_tokens=7 WHERE id='r1'").run(now-50_000);
  insert(source,row('r3',now-10_000));
  const second=exportRequests(source,target,{windowMs:1_800_000,retentionMs:120*86_400_000,now:now+1000});
  assert.equal(second.copied,3);
  const r1=target.prepare("SELECT outcome,output_tokens FROM requests WHERE id='r1'").get();
  assert.deepEqual({...r1},{outcome:'completed',output_tokens:7});
  assert.equal(target.prepare('SELECT count(*) n FROM requests').get().n,3);
  assert.equal(target.prepare("SELECT value FROM meta WHERE key='requests.synced_until'").get().value,String(now-10_000));
  const daily=target.prepare('SELECT sum(requests) requests,sum(active) active,sum(output_tokens) output FROM daily').get();
  assert.deepEqual({...daily},{requests:3,active:1,output:7});
  source.close();target.close();
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('pages through more rows than one batch without skipping equal start times',()=>{
 const dir=mkdtempSync(join(tmpdir(),'muse-console-export-'));
 try{
  const source=gatewayDb(join(dir,'source.sqlite')),target=openExport(join(dir,'export.sqlite'));
  const now=10_000_000_000;
  source.exec('BEGIN');
  for(let i=0;i<20_050;i++)insert(source,row('id'+String(i).padStart(6,'0'),now-5_000));
  source.exec('COMMIT');
  const result=exportRequests(source,target,{windowMs:1_800_000,retentionMs:86_400_000,now});
  assert.equal(result.copied,20_050);
  assert.equal(target.prepare('SELECT count(*) n FROM requests').get().n,20_050);
  source.close();target.close();
 }finally{rmSync(dir,{recursive:true,force:true});}
});

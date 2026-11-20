import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openExport,rebuildDaily,COLUMNS} from './export.mjs';
import {openRecords,summary,list,byAccount,byModel,byProvider,dailySeries,choices} from './records.mjs';
import {createPrices} from './prices.mjs';

const prices=createPrices({version:'t1',currency:'CNY',rows:[
 {provider:'deepseek-official',model:'*',inputMissPerMillion:1,inputHitPerMillion:0.02,outputPerMillion:4},
]});

function fixture(){
 const dir=mkdtempSync(join(tmpdir(),'muse-console-records-'));
 const path=join(dir,'export.sqlite'),db=openExport(path);
 const add=row=>db.prepare(`INSERT INTO requests(${COLUMNS.join(',')}) VALUES(${COLUMNS.map(()=>'?').join(',')})`).run(...COLUMNS.map(column=>row[column]??null));
 const base={provider:'deepseek-official',model:'m1',entry:'desktop',usage_state:'reported'};
 add({...base,id:'a',account_id:'u1',started_at:1000,finished_at:3000,outcome:'completed',http_status:200,input_tokens:1_000_000,cache_read_tokens:900_000,output_tokens:10_000});
 add({...base,id:'b',account_id:'u2',started_at:2000,finished_at:2500,outcome:'failed',http_status:402,input_tokens:0,output_tokens:0});
 add({...base,id:'c',account_id:'u1',started_at:3000,outcome:'active'});
 add({...base,id:'d',account_id:'u3',provider:'yunying',model:'gpt-6.1-sol',started_at:4000,finished_at:9000,outcome:'completed',http_status:200,input_tokens:500,output_tokens:50});
 rebuildDaily(db,0);
 db.close();
 return {dir,db:openRecords(path)};
}

test('prices estimate miss, hit and output tokens and leave unknown models unpriced',()=>{
 assert.equal(prices.cost({provider:'deepseek-official',model:'x',input_tokens:1_000_000,cache_read_tokens:900_000,output_tokens:10_000}),0.1+0.018+0.04);
 assert.equal(prices.cost({provider:'yunying',model:'gpt-6.1-sol',input_tokens:1}),null);
 assert.throws(()=>createPrices({version:'v',currency:'USD',rows:[]}),/currency/);
});

test('summary counts people, failures and active requests and separates unpriced volume',()=>{
 const {dir,db}=fixture();
 try{
  const totals=summary(db,prices,{from:0,to:10_000});
  assert.equal(totals.requests,4);assert.equal(totals.people,3);assert.equal(totals.failed,1);assert.equal(totals.active,1);
  assert.equal(totals.cost.unpricedRequests,1);
  assert.ok(Math.abs(totals.cost.yuan-0.158)<1e-9);
  assert.equal(summary(db,prices,{from:0,to:10_000,accountIds:[]}).requests,0);
 }finally{db.close();rmSync(dir,{recursive:true,force:true});}
});

test('list pages newest first and filters by status and account',()=>{
 const {dir,db}=fixture();
 try{
  const first=list(db,prices,{from:0,to:10_000,limit:2});
  assert.deepEqual(first.rows.map(row=>row.id),['d','c']);
  const second=list(db,prices,{from:0,to:10_000,limit:2,before:first.next});
  assert.deepEqual(second.rows.map(row=>row.id),['b','a']);
  assert.equal(second.next,null);
  assert.deepEqual(list(db,prices,{from:0,to:10_000,status:'failed'}).rows.map(row=>row.id),['b']);
  assert.deepEqual(list(db,prices,{from:0,to:10_000,accountIds:['u1'],status:'completed'}).rows.map(row=>row.id),['a']);
 }finally{db.close();rmSync(dir,{recursive:true,force:true});}
});

test('per-model spend and a daily series that includes empty days',()=>{
 const {dir,db}=fixture();
 try{
  const models=byModel(db,prices,{from:0,to:10_000});
  assert.deepEqual(models.map(item=>[item.model,item.requests,item.unpricedRequests]).sort(),[['gpt-6.1-sol',1,1],['m1',3,0]]);
  const series=dailySeries(db,prices,{from:0,to:2*86_400_000});
  assert.equal(series.length,3);assert.equal(series[0].requests,4);assert.equal(series[1].requests,0);
 }finally{db.close();rmSync(dir,{recursive:true,force:true});}
});

test('per-account spend, per-route health and filter choices',()=>{
 const {dir,db}=fixture();
 try{
  const accounts=byAccount(db,prices,{from:0,to:10_000});
  assert.equal(accounts.get('u1').requests,2);
  assert.equal(accounts.get('u3').unpricedRequests,1);
  const routes=byProvider(db,{from:0,to:10_000});
  assert.deepEqual(routes.map(route=>[route.provider,route.requests,route.failed]),[['deepseek-official',3,1],['yunying',1,0]]);
  assert.equal(routes[1].averageMs,5000);
  assert.deepEqual(choices(db,{from:0,to:10_000}),{providers:['deepseek-official','yunying'],models:['gpt-6.1-sol','m1']});
 }finally{db.close();rmSync(dir,{recursive:true,force:true});}
});

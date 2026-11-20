import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {openExport,rebuildDaily,COLUMNS} from './export.mjs';
import {openRecords} from './records.mjs';
import {createPrices} from './prices.mjs';
import {createConsole} from './server.mjs';
import {createGatewayReader,cookieValue} from './gateway.mjs';

const prices=createPrices({version:'t1',currency:'CNY',rows:[{provider:'deepseek-official',model:'*',inputMissPerMillion:1,inputHitPerMillion:0.02,outputPerMillion:4}]});
const organization={administrator:true,organization:{departments:[{id:'d1',name:'制作部 / 一组'}]},coordination:{tasks:[{id:'t1',ownerAccountId:'u1',deviceId:'dev1',prompt:'SECRET PROMPT',state:'delivered',createdAt:'2026-11-21T00:00:00Z',updatedAt:'2026-11-21T00:01:00Z',ownerName:'甲',deviceName:'甲的电脑',mainBotName:'主Bot'}]},
 members:[{id:'u1',name:'甲',username:'a',departmentPaths:[[{id:'d0',name:'制作部'},{id:'d1',name:'一组'}]],devices:[{id:'dev1',name:'甲的电脑',platform:'macOS',role:'local',botStatus:'running',mainBot:{name:'主Bot'},activeTasks:1,reportedAt:'2026-11-21T00:01:00Z'}]},
  {id:'u2',name:'<乙>',username:'b',departmentPaths:null,devices:[]}]};

async function serve(viewer,{states=async()=>[{id:'gw',name:'网关',state:'running',since:'Fri',restarts:0,version:'r29'}]}={}){
 const dir=mkdtempSync(join(tmpdir(),'muse-console-server-'));
 const path=join(dir,'export.sqlite'),db=openExport(path);
 const add=row=>db.prepare(`INSERT INTO requests(${COLUMNS.join(',')}) VALUES(${COLUMNS.map(()=>'?').join(',')})`).run(...COLUMNS.map(column=>row[column]??null));
 const now=Date.now();
 add({id:'r1',account_id:'u1',provider:'deepseek-official',model:'m1',entry:'desktop',started_at:now-1000,finished_at:now-500,outcome:'completed',usage_state:'reported',http_status:200,input_tokens:1000,cache_read_tokens:900,output_tokens:10});
 add({id:'r2',account_id:'u2',provider:'=cmd',model:'m1',entry:'desktop',started_at:now-900,outcome:'failed',usage_state:'reported',http_status:402});
 rebuildDaily(db,now-86_400_000);
 db.close();
 const records=openRecords(path);
 const handler=createConsole({config:{basePath:'/console',loginPath:'/account',services:[]},prices,gateway:{viewer:async()=>viewer},records:()=>records,states});
 const server=createServer(handler);
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const origin='http://127.0.0.1:'+server.address().port;
 return {origin,close:async()=>{await new Promise(resolve=>server.close(resolve));records.close();rmSync(dir,{recursive:true,force:true});}};
}

test('anonymous viewers are asked to sign in and members are refused',async()=>{
 for(const [viewer,status] of [[{state:'anonymous'},401],[{state:'member',account:{id:'u2',name:'乙'}},403]]){
  const app=await serve(viewer);
  try{const response=await fetch(app.origin+'/console');assert.equal(response.status,status);assert.match(response.headers.get('content-security-policy'),/default-src 'none'/);}
  finally{await app.close();}
 }
});

test('administrators land on records, see escaped names and links to the existing site pages',async()=>{
 const app=await serve({state:'admin',account:{id:'u1',name:'甲'},organization});
 try{
  const root=await fetch(app.origin+'/console',{redirect:'manual'});
  assert.equal(root.status,302);assert.equal(root.headers.get('location'),'/console/records');
  const records=await (await fetch(app.origin+'/console/records?range=today&status=failed')).text();
  assert.match(records,/&lt;乙&gt;/);assert.doesNotMatch(records,/<乙>/);assert.match(records,/失败 402/);assert.match(records,/制作部 \/ 一组/);
  for(const href of ['/workbench','/admin','/admin/usage','/feedback','/console/services'])assert.match(records,new RegExp('href="'+href.replace(/\//g,'\\/')+'"'));
  const services=await (await fetch(app.origin+'/console/services')).text();
  assert.match(services,/网关/);assert.match(services,/运行中/);
  assert.equal((await fetch(app.origin+'/console/nope')).status,404);
  assert.equal((await fetch(app.origin+'/console',{method:'POST'})).status,405);
 }finally{await app.close();}
});

test('CSV export neutralizes spreadsheet formulas and filters by department',async()=>{
 const app=await serve({state:'admin',account:{id:'u1',name:'甲'},organization});
 try{
  const csv=await (await fetch(app.origin+'/console/records.csv?range=today')).text();
  assert.match(csv,/'=cmd/);
  const department=await (await fetch(app.origin+'/console/records.csv?range=today&department=d1')).text();
  assert.equal(department.trim().split('\n').length,2);
 }finally{await app.close();}
});

test('gateway reader maps profile and organization answers to viewer states',async()=>{
 assert.equal(cookieValue('a=1; __Host-muse=tok_1','__Host-muse'),'tok_1');
 assert.equal(cookieValue('__Host-muse=bad value','__Host-muse'),null);
 const calls=[];
 const answer=(status,body)=>new Response(body===undefined?null:JSON.stringify(body),{status});
 const make=routes=>createGatewayReader({origin:'http://127.0.0.1:1',cookieName:'__Host-muse',fetch:async url=>{calls.push(url);return routes[new URL(url).pathname]();}});
 const profile={account:{id:'u1',username:'a',feishuIdentities:[{name:'甲'}]}};
 assert.deepEqual(await make({}).viewer(undefined),{state:'anonymous'});
 assert.equal((await make({'/api/muse/profile':()=>answer(401)}).viewer('__Host-muse=x')).state,'anonymous');
 assert.equal((await make({'/api/muse/profile':()=>answer(200,profile),'/api/workbench':()=>answer(403)}).viewer('__Host-muse=x')).state,'member');
 const admin=make({'/api/muse/profile':()=>answer(200,profile),'/api/workbench':()=>answer(200,{administrator:true,members:[]})});
 const first=await admin.viewer('__Host-muse=y');
 assert.equal(first.state,'admin');assert.equal(first.account.name,'甲');
 const before=calls.length;await admin.viewer('__Host-muse=y');assert.equal(calls.length,before);
 await assert.rejects(make({'/api/muse/profile':()=>answer(500)}).viewer('__Host-muse=z'),/gateway_profile_unavailable/);
});

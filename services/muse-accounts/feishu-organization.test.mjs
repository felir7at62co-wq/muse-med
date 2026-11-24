import test from 'node:test';
import assert from 'node:assert/strict';
import {createFeishuOrgSync,readFeishuOrganization} from './feishu-organization.mjs';

const config={appType:'custom',appId:'cli_fixture',appSecret:'fixture-app-secret-value'},tenantKey='tenant_fixture';
const person=(id,openId)=>({id,feishuIdentities:[{appId:config.appId,tenantKey,openId}]});
const store=accounts=>({list:()=>structuredClone(accounts)});
const departments={od_writer:{open_department_id:'od_writer',name:'编剧组',parent_department_id:'0'},0:{open_department_id:'0',name:'公司'}};

/** Feishu contact fixture: `users` maps an open ID to the user fields returned, or to a Feishu error code. */
function feishu(users){
 const calls=[];
 const fetchImpl=async url=>{
  const target=new URL(url);calls.push(target.pathname);
  if(target.pathname.endsWith('/tenant_access_token/internal'))return Response.json({code:0,tenant_access_token:'fixture-token'});
  const [kind,key]=target.pathname.split('/').slice(-2);
  if(kind==='departments')return Response.json({code:0,data:{department:departments[key]}});
  const user=users[key];
  return Response.json(typeof user==='number'?{code:user,msg:'refused'}:{code:0,data:{user:{open_id:key,...user}}});
 };
 return {fetchImpl,calls};
}

test('job title and manager name are kept per account, and a shared manager is read once',async()=>{
 const {fetchImpl,calls}=feishu({
  ou_a:{department_ids:['od_writer'],job_title:' 主编剧 ',leader_user_id:'ou_lead'},
  ou_b:{department_ids:['od_writer'],job_title:'编剧',leader_user_id:'ou_lead'},
  ou_lead:{name:'制片人'},
 });
 const sync=createFeishuOrgSync({config,expectedTenantKey:tenantKey,store:store([person('a','ou_a'),person('b','ou_b')]),fetchImpl,concurrency:1});
 const result=await sync.refresh();
 assert.equal(result.status,'ready');
 assert.deepEqual(result.accounts.a,{status:'ready',departmentIds:['od_writer'],jobTitle:'主编剧',managerName:'制片人'});
 assert.deepEqual(result.accounts.b,{status:'ready',departmentIds:['od_writer'],jobTitle:'编剧',managerName:'制片人'});
 assert.equal(calls.filter(path=>path.endsWith('/users/ou_lead')).length,1);
 await sync.close();
});

test('fields Feishu does not return, or a refused manager lookup, leave only the departments',async()=>{
 const {fetchImpl}=feishu({
  ou_a:{department_ids:['od_writer']},
  ou_b:{department_ids:['od_writer'],job_title:'',leader_user_id:'ou_hidden'},
  ou_hidden:99991672,
 });
 const sync=createFeishuOrgSync({config,expectedTenantKey:tenantKey,store:store([person('a','ou_a'),person('b','ou_b')]),fetchImpl});
 const result=await sync.refresh();
 assert.equal(result.status,'ready');
 assert.deepEqual(result.accounts.a,{status:'ready',departmentIds:['od_writer']});
 assert.deepEqual(result.accounts.b,{status:'ready',departmentIds:['od_writer']});
 assert.deepEqual(result.departments.map(department=>department.id).sort(),['0','od_writer']);
 await sync.close();
});

const userOpenId='ou_writer',accessToken='private-feishu-user-token',syncedNow=()=>Date.parse('2026-11-17T00:00:00.000Z');
const entry={department_id:'od-writing',department_name:{name:'编剧组'},department_path:{department_ids:['0','od-studio','od-writing'],department_path_name:{name:'工作室/内容中心/编剧组'}}};
const body=user=>({code:0,data:{user:{open_id:userOpenId,...user}}});
const read=value=>readFeishuOrganization({accessToken,openId:userOpenId,now:syncedNow,fetchImpl:async()=>Response.json(value)});

test('only current-user department names and full hierarchy survive the provider response',async()=>{
 let call;
 const result=await readFeishuOrganization({accessToken,openId:userOpenId,now:syncedNow,fetchImpl:async(url,options)=>{
  call={url:new URL(url),options};return Response.json(body({department_path:[entry],email:'private@example.test',mobile:'private-phone'}));
 }});
 assert.equal(call.url.origin,'https://open.feishu.cn');assert.equal(call.url.pathname,'/open-apis/contact/v3/users/'+userOpenId);
 assert.equal(call.url.searchParams.get('user_id_type'),'open_id');assert.equal(call.url.searchParams.get('department_id_type'),'open_department_id');
 assert.equal(call.options.headers.authorization,'Bearer '+accessToken);assert.equal(call.options.redirect,'error');
 assert.deepEqual(result,{status:'available',syncedAt:'2026-11-17T00:00:00.000Z',departments:[{id:'od-writing',name:'编剧组',path:'工作室/内容中心/编剧组',pathIds:['0','od-studio','od-writing']}]});
 assert.doesNotMatch(JSON.stringify(result),/private-feishu|private@|private-phone|open_id/);
});

test('empty membership differs from missing organization permissions',async()=>{
 assert.equal((await read(body({department_path:[]}))).status,'available');
 assert.equal((await read(body({}))).status,'permission-required');
 for(const code of [99991672,99991679,99991668,99991663,99991664])assert.equal((await read({code,msg:accessToken})).status,'permission-required');
 for(const status of [401,403]){
  const value=await readFeishuOrganization({accessToken,openId:userOpenId,now:syncedNow,fetchImpl:async()=>new Response(accessToken,{status})});
  assert.equal(value.status,'permission-required');assert.doesNotMatch(JSON.stringify(value),/private-feishu/);
 }
});

test('malformed, oversized and mismatched directory responses cannot become membership',async()=>{
 for(const value of [null,{code:1},body({open_id:'ou_other',department_path:[entry]}),body({department_path:{}}),
  body({department_path:[entry,entry]}),body({department_path:[{...entry,department_id:'invalid/id'}]}),
  body({department_path:[{...entry,department_name:{name:'\u0000'}}]}),
  body({department_path:[{...entry,department_path:{department_ids:['invalid/id'],department_path_name:{name:'path'}}}]}),
  body({department_path:Array.from({length:257},()=>entry)})]){
  const result=await read(value);assert.notEqual(result.status,'available');assert.deepEqual(result.departments,[]);
 }
 for(const response of [new Response('{'),new Response('x'.repeat(65537)),new Response(null,{status:500})]){
  assert.equal((await readFeishuOrganization({accessToken,openId:userOpenId,now:syncedNow,fetchImpl:async()=>response})).status,'unavailable');
 }
 const cancelled=new AbortController();cancelled.abort();
 const result=await readFeishuOrganization({accessToken,openId:userOpenId,now:syncedNow,signal:cancelled.signal,fetchImpl:async()=>{throw Error(accessToken);}});
 assert.equal(result.status,'unavailable');assert.doesNotMatch(JSON.stringify(result),/private-feishu/);
});

test('permission and service refusals await unread-body cleanup without exposing cleanup failures',async()=>{
 for(const status of [401,403,500]){
  let cancelled=0,release,started;
  const cleanup=new Promise(resolve=>release=resolve),entered=new Promise(resolve=>started=resolve);
  const stream=new ReadableStream({cancel(){cancelled++;started();return cleanup;}});
  let settled=false;
  const operation=readFeishuOrganization({accessToken,openId:userOpenId,now:syncedNow,fetchImpl:async()=>new Response(stream,{status})}).then(value=>{settled=true;return value;});
  await entered;assert.equal(settled,false);release();
  const result=await operation;assert.equal(cancelled,1);assert.equal(result.status,status===500?'unavailable':'permission-required');
 }
 const stream=new ReadableStream({cancel(){throw Error(accessToken);}});
 const result=await readFeishuOrganization({accessToken,openId:userOpenId,now:syncedNow,fetchImpl:async()=>new Response(stream,{status:403})});
 assert.equal(result.status,'permission-required');assert.doesNotMatch(JSON.stringify(result),/private-feishu/);
});

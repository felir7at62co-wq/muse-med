import test from 'node:test';
import assert from 'node:assert/strict';
import {createFeishuOrgSync} from './feishu-organization.mjs';

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

/** Groups, Feishu departments and token history persist and stay owner-scoped through the real HTTP gateway. */
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomUUID} from 'node:crypto';
import {mkdtemp,readFile,readdir,rm,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {once} from 'node:events';
import {openUsageLedger} from './usage-ledger.mjs';
import {accountGroups} from './account-groups.mjs';
import {accountProfile} from './account-profile.mjs';
import {openStore} from './store.mjs';
import {createAccountServer} from './gateway.mjs';
import {renderAccountDetails} from './account-pages.mjs';
import {createModelRelay,accountToken} from './model-relay.mjs';

const origin='https://muse.test';
const escape=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
async function files(root){
 const entries=await readdir(root,{withFileTypes:true,recursive:true});
 return Promise.all(entries.filter(entry=>entry.isFile()).map(entry=>readFile(join(entry.parentPath,entry.name),'utf8')));
}
async function fixture(t){
 const root=await mkdtemp(join(tmpdir(),'muse-account-details-'));t.after(()=>rm(root,{recursive:true,force:true}));
 let clock=Date.parse('2026-11-16T15:59:59.000Z');const now=()=>clock,store=await openStore(join(root,'accounts.json'));
 const owner=await store.create('writer','pw'),other=await store.create('another','pw'),admin=await store.create('administrator','pw',{admin:true}),ledger=await openUsageLedger(join(root,'usage'),{now});
 /** Settle one relay request the way the desktop relay does, with supplier usage or null. */
 const record=async(accountId,usage,{route='zhipu-official',model='glm-5'}={})=>{
  const ticket=await ledger.begin({accountId,requestId:randomUUID(),channel:'desktop-relay',route});
  await ledger.finish(ticket,{server_request_id:ticket.requestId,route,requested_model:model,client_status:200,upstream_status:200,eof:true,usage});return ticket;
 };
 return {root,store,owner,other,admin,ledger,record,now,setTime:value=>clock=Date.parse(value)};
}
async function listen(t,options){
 const server=createAccountServer({...options,publicOrigin:origin});
 server.listen(0,'127.0.0.1');await once(server,'listening');
 t.after(async()=>{server.closeAllConnections();await new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()));await options.usageLedger.flush();});
 const base='http://127.0.0.1:'+server.address().port;
 const login=async username=>{const response=await fetch(base+'/login',{method:'POST',headers:{origin},body:new URLSearchParams({username,password:'pw'}),redirect:'manual'});assert.equal(response.status,303);return response.headers.get('set-cookie').split(';')[0];};
 return {base,login};
}

test('group assignments are durable, copied, bounded and independent of sign-in authority',async t=>{
 const f=await fixture(t);let changes=0;f.store.on('change',()=>changes++);
 const updated=await f.store.setGroups(f.owner.id,[{name:' 编剧一组 ',description:'长剧创作'}]);
 assert.match(updated.groups[0].id,/^group-[0-9a-f]{16}$/);assert.equal(updated.groups[0].name,'编剧一组');assert.equal(updated.revision,1);assert.equal(changes,0);
 updated.groups[0].description='caller mutation';assert.equal(f.store.get(f.owner.id).groups[0].description,'长剧创作');
 assert.deepEqual((await openStore(join(f.root,'accounts.json'))).get(f.owner.id).groups,f.store.get(f.owner.id).groups);
 assert.equal(accountGroups([{name:'编剧一组',description:''}])[0].id,updated.groups[0].id);
 for(const value of [[{name:'',description:''}],[{name:'x\n',description:''}],[{name:'x',description:'\u0000'}],[{name:'x',description:'',id:'forged'}],Array.from({length:21},(_,i)=>({name:'group'+i,description:''})),[{name:'Ａ',description:''},{name:'A',description:''}]])await assert.rejects(f.store.setGroups(f.owner.id,value));
 await assert.rejects(f.store.setGroups(f.owner.id,[],{validateAssignment:()=>false}),/authorization changed/);
 assert.equal(f.store.get(f.owner.id).groups.length,1);
});

test('usage survives reopen and separates accounts, missing counters, cache and reasoning details',async t=>{
 const f=await fixture(t);
 await f.record(f.owner.id,{prompt_tokens:100,completion_tokens:40,total_tokens:140,prompt_tokens_details:{cached_tokens:30},completion_tokens_details:{reasoning_tokens:10}});
 await f.record(f.owner.id,null);await f.record(f.other.id,{total_tokens:9999});
 await f.record(f.owner.id,{prompt_tokens:20,completion_tokens:8,prompt_cache_hit_tokens:12,completion_tokens_details:{reasoning_tokens:3}},{route:'deepseek-official',model:'deepseek-chat'});
 await f.ledger.flush();
 const value=await(await openUsageLedger(join(f.root,'usage'),{now:f.now})).query({accountId:f.owner.id});
 assert.equal(value.summary.requests,3);assert.equal(value.summary.reportedUsageRequests,2);assert.equal(value.summary.unreportedUsageRequests,1);
 // Totals add only supplied counters; cached input and reasoning output stay inside their request and are not added again.
 assert.equal(value.summary.inputTokens,120);assert.equal(value.summary.outputTokens,48);assert.equal(value.summary.totalTokens,140);
 assert.equal(value.items.every(item=>item.accountId===f.owner.id),true);assert.equal(value.items.filter(item=>item.usage===null).length,1);
 const deepseek=value.items.find(item=>item.route==='deepseek-official');
 assert.equal(deepseek.requestedModel,'deepseek-chat');assert.equal(deepseek.usage.prompt_cache_hit_tokens,12);assert.equal(deepseek.usage.completion_tokens_details.reasoning_tokens,3);
 assert.equal(value.items.find(item=>item.usage?.total_tokens===140).usage.prompt_tokens_details.cached_tokens,30);
 assert.doesNotMatch((await files(join(f.root,'usage'))).join('\n'),/password|apiKey|cookie|messages|prompt_text/);
});

test('UTC calendar days and cursor pagination select the same account measurements without inventing history',async t=>{
 const f=await fixture(t);await f.record(f.owner.id,{total_tokens:1});f.setTime('2026-11-16T16:00:00.000Z');await f.record(f.owner.id,{total_tokens:2});
 // The second request starts the next Beijing day but the same UTC day, which the personal usage query uses.
 assert.equal((await f.ledger.query({accountId:f.owner.id,from:'2026-11-16',to:'2026-11-16'})).summary.requests,2);
 assert.equal((await f.ledger.query({accountId:f.owner.id,from:'2026-11-17',to:'2026-11-17'})).summary.totalTokens,null);
 const first=await f.ledger.query({accountId:f.owner.id,limit:1}),next=await f.ledger.query({accountId:f.owner.id,limit:1,cursor:first.nextCursor});
 assert.equal(first.summary.requests,2);assert.equal(first.items.length,1);assert.equal(typeof first.nextCursor,'string');
 assert.equal(next.items.length,1);assert.equal(next.nextCursor,null);assert.notEqual(first.items[0].requestId,next.items[0].requestId);
 for(const value of [{limit:0},{limit:101},{limit:'NaN'},{from:'2026-11-17',to:'2026-11-16'},{from:'bad'},{cursor:'invalid'}])await assert.rejects(f.ledger.query({accountId:f.owner.id,...value}),{code:'invalid_usage_query'});
});

test('malformed persisted records fail explicitly',async t=>{
 const f=await fixture(t),ticket=await f.record(f.owner.id,{prompt_tokens:0.5,completion_tokens:-1,total_tokens:'9'});
 const stored=(await f.ledger.query({accountId:f.owner.id})).items[0];assert.equal(stored.usage,null);assert.equal(stored.usageStatus,'unreported');
 const request=join(f.root,'usage',ticket.startedAt.slice(0,10),f.owner.id,ticket.requestId,'request.json');
 await writeFile(request,JSON.stringify({...ticket,accountId:f.other.id}));
 await assert.rejects((await openUsageLedger(join(f.root,'usage'),{now:f.now,onError:()=>{}})).query({accountId:f.owner.id}),{code:'usage_corrupt'});
 await writeFile(request,'{"version":1');
 await assert.rejects((await openUsageLedger(join(f.root,'usage'),{now:f.now,onError:()=>{}})).query({accountId:f.owner.id}),{code:'usage_unavailable'});
});

test('real gateway scopes profile and usage to the login and requires administrator group writes',async t=>{
 const f=await fixture(t);await f.record(f.owner.id,{prompt_tokens:100,completion_tokens:40,total_tokens:140});
 const http=await listen(t,{store:f.store,usageLedger:f.ledger,now:f.now,workspaceMode:'desktop'}),owner=await http.login('writer'),other=await http.login('another'),admin=await http.login('administrator');
 const call=(path,cookie,options={})=>fetch(http.base+path,{headers:{cookie,origin,...options.headers},...options,redirect:'manual'});
 for(const path of ['/api/muse/usage','/api/muse/profile'])assert.equal((await fetch(http.base+path,{redirect:'manual'})).status,401);
 assert.equal((await call('/api/muse/usage?accountId='+f.other.id,owner)).status,400);
 const mine=await(await call('/api/muse/usage',owner)).json();assert.equal(mine.summary.totalTokens,140);assert.equal(mine.items[0].accountId,undefined);
 const theirs=await(await call('/api/muse/usage',other)).json();assert.equal(theirs.summary.requests,0);
 assert.equal((await call('/api/muse/usage?limit=0',owner)).status,400);
 assert.equal((await call('/api/muse/usage',owner,{method:'POST'})).status,405);
 const fields=new URLSearchParams({id:f.owner.id,groupName:'编剧一组',groupDescription:'负责长剧'});
 assert.equal((await call('/admin/groups',owner,{method:'POST',body:fields})).status,403);
 assert.equal((await call('/admin/groups',admin,{method:'POST',body:fields})).status,303);
 const profile=await(await call('/api/muse/profile',owner)).json();assert.equal(profile.account.id,f.owner.id);assert.equal(profile.groups[0].name,'编剧一组');
 const accountPage=await call('/account',owner);assert.equal(accountPage.status,200);const markup=await accountPage.text();
 assert.match(markup,/我的分组/);assert.match(markup,/负责长剧/);assert.match(markup,/data-muse-account-data/);assert.doesNotMatch(markup,/飞书部门/);
 assert.equal((await call('/admin/groups?id='+f.owner.id,admin)).status,200);
 await f.store.setDisabled(f.owner.id,true);assert.equal((await call('/api/muse/profile',owner)).status,401);
});

test('administrator group form accepts twenty full-length assignments',async t=>{
 const f=await fixture(t),http=await listen(t,{store:f.store,usageLedger:f.ledger,now:f.now,workspaceMode:'desktop'}),admin=await http.login('administrator');
 const fields=new URLSearchParams({id:f.owner.id});
 for(let index=0;index<20;index++){fields.append('groupName',String(index).padStart(2,'0')+'组'.repeat(78));fields.append('groupDescription','说'.repeat(500));}
 assert.ok(fields.toString().length>8192);
 const response=await fetch(http.base+'/admin/groups',{method:'POST',headers:{cookie:admin,origin},body:fields,redirect:'manual'});
 assert.equal(response.status,303);assert.equal(f.store.get(f.owner.id).groups.length,20);
});

test('desktop and cloud relay responses persist supplier usage under authenticated accounts',async t=>{
 const f=await fixture(t),modelConfig={private:()=>({model:'supplier-model',apiKey:'private-synthetic-key',baseURL:'https://supplier.test/v1',maxTokens:100})};
 const forward=async({body,res,metadata})=>{
  metadata.forwarded({model:body.model,bytes:10,stream:false,secret:'private-synthetic-key'});
  const response=JSON.stringify({model:body.model,choices:[{message:{content:'private synthetic answer'}}],usage:{prompt_tokens:20,completion_tokens:5,total_tokens:25}});
  metadata.upstream(200);metadata.bytes(Buffer.from(response));metadata.eof();metadata.completeBytes();res.writeHead(200,{'content-type':'application/json'});res.end(response);
 };
 const desktop=await listen(t,{store:f.store,usageLedger:f.ledger,now:f.now,modelConfig,modelForward:forward}),cookie=await desktop.login('writer');
 const options={method:'POST',headers:{cookie,origin,'content-type':'application/json'},body:JSON.stringify({model:'muse-shared',messages:[{role:'user',content:'private synthetic request'}]})};
 const response=await fetch(desktop.base+'/api/desktop-models/muse-shared/chat/completions',options);assert.equal(response.status,200);await response.text();
 const secret='synthetic-relay-authentication-secret',relay=createModelRelay({config:modelConfig,secret,accounts:f.store,forward,usageLedger:f.ledger,metadataSink:()=>{}});relay.listen(0,'127.0.0.1');await once(relay,'listening');
 t.after(async()=>{relay.closeAllConnections();await new Promise((resolve,reject)=>relay.close(error=>error?reject(error):resolve()));await f.ledger.flush();});
 const cloud=await fetch('http://127.0.0.1:'+relay.address().port+'/v1/chat/completions',{...options,headers:{'content-type':'application/json',authorization:'Bearer '+accountToken(secret,f.other.id)}});assert.equal(cloud.status,200);await cloud.text();
 await f.ledger.flush();
 const own=await f.ledger.query({accountId:f.owner.id}),theirs=await f.ledger.query({accountId:f.other.id});
 assert.equal(own.summary.totalTokens,25);assert.equal(own.items[0].channel,'desktop-relay');assert.equal(theirs.summary.totalTokens,25);assert.equal(theirs.items[0].channel,'cloud-relay');
 assert.doesNotMatch((await files(join(f.root,'usage'))).join('\n'),/private synthetic|private-synthetic-key|synthetic-relay-authentication-secret|messages|choices/);
});

test('verified Feishu organization records remain isolated, sanitized and durable',async t=>{
 const f=await fixture(t),organization={status:'available',syncedAt:new Date(f.now()).toISOString(),departments:[{id:'od_department',name:'创作组',path:'公司/内容中心/创作组',pathIds:['od_company','od_content','od_department']}],accessToken:'must-not-save'};
 const account=await f.store.resolveFeishuIdentity({appId:'cli_fixture',openId:'ou_fixture',tenantKey:'tenant_fixture',name:'编剧',organization});
 const reopened=await openStore(join(f.root,'accounts.json')),identity=reopened.get(account.id).feishuIdentities[0];
 assert.equal(identity.organization.departments[0].path,'公司/内容中心/创作组');assert.equal(identity.organization.accessToken,undefined);
 assert.doesNotMatch(await readFile(join(f.root,'accounts.json'),'utf8'),/must-not-save/);
 const profile=accountProfile(reopened.get(account.id));assert.deepEqual(profile.account.feishuIdentities[0].organization,identity.organization);
 assert.deepEqual(profile.organization,{status:'available',updatedAt:organization.syncedAt,departments:identity.organization.departments});
 assert.doesNotMatch(JSON.stringify(profile),/appId|openId|must-not-save/);
 await assert.rejects(f.store.resolveFeishuIdentity({appId:'cli_other',openId:'ou_other',name:'编剧',organization:{...organization,status:'permission-required'}}),/Invalid Feishu/);
 await assert.rejects(f.store.resolveFeishuIdentity({appId:'cli_other',openId:'ou_other',name:'编剧',organization:{...organization,departments:[{...organization.departments[0],pathIds:['bad\nID']}]}}),/Invalid Feishu/);
 // A sign-in without a department record replaces the cached one instead of keeping stale membership.
 const refreshed=await f.store.resolveFeishuIdentity({appId:'cli_fixture',openId:'ou_fixture',tenantKey:'tenant_fixture',name:'编剧'});
 assert.equal(refreshed.id,account.id);assert.equal('organization' in refreshed.feishuIdentities[0],false);
});

test('existing version 2 account records without department data load and persist unchanged',async t=>{
 const root=await mkdtemp(join(tmpdir(),'muse-account-v2-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const file=join(root,'accounts.json'),row={id:'0123456789abcdef',username:'feishu_0123456789abcdef',key:'feishu_0123456789abcdef',admin:false,disabled:false,createdAt:'2026-11-01T00:00:00.000Z',revision:1,passwordLogin:false,
  feishuIdentities:[{appId:'cli_fixture',tenantKey:'tenant_fixture',openId:'ou_fixture',name:'编剧',boundAt:'2026-11-01T00:00:00.000Z',lastLoginAt:'2026-11-02T00:00:00.000Z'}],groups:[{id:accountGroups([{name:'编剧一组',description:''}])[0].id,name:'编剧一组',description:''}]};
 await writeFile(file,JSON.stringify({version:2,accounts:[row]}),{mode:0o600});
 const store=await openStore(file);assert.equal('organization' in store.get(row.id).feishuIdentities[0],false);
 await store.recordActivity(row.id,{at:'2026-11-03T00:00:00.000Z'});
 const saved=JSON.parse(await readFile(file,'utf8'));assert.equal(saved.version,2);assert.deepEqual(saved.accounts[0],{...row,lastActivityAt:'2026-11-03T00:00:00.000Z'});
});

test('account details escape group and department text and keep missing departments explicit',()=>{
 const at='2026-11-17T02:00:00.000Z',organization={status:'available',syncedAt:at,departments:[{id:'od_department',name:'<b>组</b>',path:'<i>公司</i>/创作组',pathIds:['od_department']}]};
 const account=(identities,groups=[])=>({id:'0123456789abcdef',username:'writer',createdAt:at,lastLoginAt:null,lastActivityAt:null,groups,feishuIdentities:identities.map(value=>({appId:'cli_fixture',openId:'ou_fixture',tenantKey:null,name:'编剧',boundAt:at,lastLoginAt:null,...value}))});
 const html=renderAccountDetails({profile:accountProfile(account([{organization}],[{name:'<script>group</script>',description:'<img src=x>'}])),escape});
 assert.match(html,/&lt;script&gt;group/);assert.match(html,/&lt;img src=x&gt;/);assert.match(html,/&lt;i&gt;公司&lt;\/i&gt;\/创作组/);assert.doesNotMatch(html,/<script|<img|<i>|<b>/);
 const snapshot={status:'ready',updatedAt:at,departments:[{id:'0',name:'公司',parentId:null},{id:'od_writer',name:'创作组',parentId:'0'}],accounts:{'0123456789abcdef':{status:'ready',departmentIds:['od_writer'],jobTitle:'<主编剧>',managerName:'制片&人'}}};
 const synced=renderAccountDetails({profile:accountProfile(account([{}]),{organizationSnapshot:snapshot}),escape});
 assert.match(synced,/公司 \/ 创作组/);assert.match(synced,/职位：&lt;主编剧&gt;/);assert.match(synced,/上级：制片&amp;人/);assert.match(synced,/暂未分配分组/);
 assert.match(renderAccountDetails({profile:accountProfile(account([{organization:{status:'permission-required',syncedAt:at,departments:[]}}])),escape}),/尚未开放飞书部门权限/);
 assert.match(renderAccountDetails({profile:accountProfile(account([{organization:{status:'unavailable',syncedAt:at,departments:[]}}])),escape}),/本次未能同步飞书部门/);
 assert.match(renderAccountDetails({profile:accountProfile(account([{}]),{organizationSnapshot:{...snapshot,status:'unavailable'}}),escape}),/部门信息尚未同步/);
 assert.doesNotMatch(renderAccountDetails({profile:accountProfile(account([])),escape}),/飞书部门/);
});

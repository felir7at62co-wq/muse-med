/** Account details persist measurements and enforce ownership through the real HTTP gateway. */
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomUUID} from 'node:crypto';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {once} from 'node:events';
import {openUsageLedger,accountDetailsQuery} from './account-details.mjs';
import {accountGroups} from './account-groups.mjs';
import {openStore} from './store.mjs';
import {createAccountServer} from './gateway.mjs';
import {renderAccountDetails} from './account-pages.mjs';
import {createModelRelay,accountToken} from './model-relay.mjs';

const origin='https://muse.test';
const query={period:'all',offset:0,limit:50};
const historic=(overrides={})=>({id:randomUUID(),provider:'zhipu-official',model:'glm-5',status:null,source:'desktop-direct',inputTokens:100,outputTokens:40,totalTokens:140,cachedInputTokens:30,reasoningTokens:10,...overrides});
const relayed=(overrides={})=>({server_request_id:randomUUID(),route:'zhipu-official',requested_model:'glm-5',client_status:200,usage:{prompt_tokens:100,completion_tokens:40,total_tokens:140,prompt_tokens_details:{cached_tokens:30},completion_tokens_details:{reasoning_tokens:10}},...overrides});
/** Recorded desktop-direct history stays readable after Desktop direct access and its self-reports were removed. */
async function historicLedger(f,rows){
 const file=join(f.root,'historic-usage.jsonl');
 await writeFile(file,[{version:1,startedAt:new Date(f.now()).toISOString()},...rows.map(([accountId,row,at=new Date(f.now()).toISOString()])=>({accountId,at,...row}))].map(value=>JSON.stringify(value)).join('\n')+'\n',{mode:0o600});
 return await openUsageLedger(file,{now:f.now});
}
async function fixture(t){
 const root=await mkdtemp(join(tmpdir(),'muse-account-details-'));t.after(()=>rm(root,{recursive:true,force:true}));
 let clock=Date.parse('2026-11-16T15:59:59.000Z');const now=()=>clock,file=join(root,'model-usage.jsonl'),store=await openStore(join(root,'accounts.json'));
 const owner=await store.create('writer','pw'),other=await store.create('another','pw'),admin=await store.create('administrator','pw',{admin:true}),ledger=await openUsageLedger(file,{now});
 return {root,file,store,owner,other,admin,ledger,now,setTime:value=>clock=Date.parse(value)};
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
 const ledger=await historicLedger(f,[[f.owner.id,historic()],[f.owner.id,historic({inputTokens:null,outputTokens:null,totalTokens:null,cachedInputTokens:null,reasoningTokens:null})],[f.other.id,historic({totalTokens:9999})]]);
 await ledger.capture(f.owner.id,{server_request_id:randomUUID(),route:'deepseek-official',requested_model:'deepseek-chat',client_status:200,usage:{prompt_tokens:20,completion_tokens:8,prompt_cache_hit_tokens:12,completion_tokens_details:{reasoning_tokens:3}}});
 await ledger.flush();
 const details=await(await openUsageLedger(join(f.root,'historic-usage.jsonl'),{now:f.now})).details(f.store.get(f.owner.id),query);
 assert.deepEqual(details.usage.summary,{requests:3,reportedRequests:2,inputTokens:120,outputTokens:48,totalTokens:168,cachedInputTokens:42,reasoningTokens:13});
 assert.equal(details.usage.byModel.length,2);assert.equal(details.usage.recent.some(row=>row.accountId!==undefined),false);
 assert.equal(details.usage.recent.filter(row=>row.totalTokens===null).length,1);assert.equal(details.usage.recent.find(row=>row.provider==='deepseek-official').source,'gateway-relay');
 assert.equal(details.usage.recent.filter(row=>row.source==='desktop-direct').length,2);
 assert.equal(details.account.id,f.owner.id);assert.doesNotMatch(await readFile(join(f.root,'historic-usage.jsonl'),'utf8'),/password|apiKey|cookie|messages|prompt_text/);
 assert.equal('report' in ledger,false);
});
test('Beijing day ranges and pagination select the same account measurements without inventing history',async t=>{
 const f=await fixture(t);await f.ledger.capture(f.owner.id,relayed());f.setTime('2026-11-16T16:00:00.000Z');await f.ledger.capture(f.owner.id,relayed());
 const today=await f.ledger.details(f.owner,{period:'today',offset:0,limit:1});
 assert.equal(today.usage.summary.requests,1);assert.equal(today.usage.byDay[0].date,'2026-11-17');assert.equal(today.usage.since,'2026-11-16T16:00:00.000Z');
 const first=await f.ledger.details(f.owner,{...query,limit:1}),next=await f.ledger.details(f.owner,{...query,offset:1,limit:1});
 assert.deepEqual(first.usage.pagination,{offset:0,limit:1,total:2,hasMore:true});assert.deepEqual(next.usage.pagination,{offset:1,limit:1,total:2,hasMore:false});assert.notEqual(first.usage.recent[0].id,next.usage.recent[0].id);
 for(const value of ['period=bad','offset=-1','offset=NaN','limit=0','limit=101'])assert.throws(()=>accountDetailsQuery(new URLSearchParams(value)));
});
test('malformed persisted counters fail explicitly',async t=>{
 const f=await fixture(t);
 const path=join(f.root,'corrupt.jsonl');await writeFile(path,JSON.stringify({version:1,startedAt:new Date(f.now()).toISOString()})+'\n'+JSON.stringify({accountId:f.owner.id,...historic(),at:new Date(f.now()).toISOString(),totalTokens:-1})+'\n');
 await assert.rejects(openUsageLedger(path),/Invalid/);
 for(const row of [historic({totalTokens:0.5}),historic({model:'bad\nmodel'}),historic({cookie:'secret'}),historic({status:'success'}),historic({id:'not-uuid'}),historic({source:'desktop-report'})]){
  await writeFile(path,JSON.stringify({version:1,startedAt:new Date(f.now()).toISOString()})+'\n'+JSON.stringify({accountId:f.owner.id,at:new Date(f.now()).toISOString(),...row})+'\n');
  await assert.rejects(openUsageLedger(path),/Invalid/);
 }
 await writeFile(path,'{"version":1');await assert.rejects(openUsageLedger(path),/Incomplete/);
});
test('real gateway scopes details to the login and requires administrator group writes',async t=>{
 const f=await fixture(t);await f.ledger.capture(f.owner.id,relayed());
 const http=await listen(t,{store:f.store,usageLedger:f.ledger,now:f.now,workspaceMode:'desktop'}),owner=await http.login('writer'),other=await http.login('another'),admin=await http.login('administrator');
 const call=(path,cookie,options={})=>fetch(http.base+path,{headers:{cookie,origin,...options.headers},...options,redirect:'manual'});
 assert.equal((await fetch(http.base+'/api/muse.account/details',{redirect:'manual'})).status,401);
 const mine=await(await call('/api/muse.account/details?period=all&accountId='+f.other.id,owner)).json();assert.equal(mine.account.id,f.owner.id);assert.equal(mine.usage.summary.totalTokens,140);
 const theirs=await(await call('/api/muse.account/details?period=all',other)).json();assert.equal(theirs.usage.summary.requests,0);
 assert.equal((await call('/api/muse.account/details?offset=-1',owner)).status,400);
 assert.equal((await call('/api/muse.account/details',owner,{method:'POST'})).status,405);
 const fields=new URLSearchParams({id:f.owner.id,groupName:'编剧一组',groupDescription:'负责长剧'});
 assert.equal((await call('/admin/groups',owner,{method:'POST',body:fields})).status,403);
 assert.equal((await call('/admin/groups',admin,{method:'POST',body:fields})).status,303);
 const updated=await(await call('/api/muse.account/details?period=all',owner)).json();assert.equal(updated.groups[0].name,'编剧一组');
 const accountPage=await call('/account?period=all',owner);assert.equal(accountPage.status,200);const markup=await accountPage.text();assert.match(markup,/我的分组|逐次请求/);assert.match(markup,/140/);assert.match(markup,/负责长剧/);
 assert.equal((await call('/admin/groups?id='+f.owner.id,admin)).status,200);
 await f.store.setDisabled(f.owner.id,true);assert.equal((await call('/api/muse.account/details',owner)).status,401);
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
 const secret='synthetic-relay-authentication-secret',relay=createModelRelay({config:modelConfig,secret,accounts:f.store,forward,usageLedger:f.ledger});relay.listen(0,'127.0.0.1');await once(relay,'listening');
 t.after(async()=>{relay.closeAllConnections();await new Promise((resolve,reject)=>relay.close(error=>error?reject(error):resolve()));await f.ledger.flush();});
 const cloud=await fetch('http://127.0.0.1:'+relay.address().port+'/v1/chat/completions',{...options,headers:{'content-type':'application/json',authorization:'Bearer '+accountToken(secret,f.other.id)}});assert.equal(cloud.status,200);await cloud.text();
 await f.ledger.flush();
 assert.equal((await f.ledger.details(f.owner,query)).usage.summary.totalTokens,25);assert.equal((await f.ledger.details(f.other,query)).usage.summary.totalTokens,25);
 const saved=await readFile(f.file,'utf8');assert.doesNotMatch(saved,/private synthetic|private-synthetic-key|synthetic-relay-authentication-secret|messages|choices/);
});

test('verified Feishu organization records remain isolated, sanitized and durable',async t=>{
 const f=await fixture(t),organization={status:'available',syncedAt:new Date(f.now()).toISOString(),departments:[{id:'od_department',name:'创作组',path:'公司/内容中心/创作组',pathIds:['od_company','od_content','od_department']}],accessToken:'must-not-save'};
 const account=await f.store.resolveFeishuIdentity({appId:'cli_fixture',openId:'ou_fixture',tenantKey:'tenant_fixture',name:'编剧',organization});
 const reopened=await openStore(join(f.root,'accounts.json')),identity=reopened.get(account.id).feishuIdentities[0];
 assert.equal(identity.organization.departments[0].path,'公司/内容中心/创作组');assert.equal(identity.organization.accessToken,undefined);
 const details=await f.ledger.details(reopened.get(account.id),query);assert.deepEqual(details.account.feishuIdentities[0].organization,identity.organization);
 assert.doesNotMatch(JSON.stringify(details),/appId|openId|must-not-save/);
 await assert.rejects(f.store.resolveFeishuIdentity({appId:'cli_other',openId:'ou_other',name:'编剧',organization:{...organization,status:'permission-required'}}),/Invalid Feishu/);
 await assert.rejects(f.store.resolveFeishuIdentity({appId:'cli_other',openId:'ou_other',name:'编剧',organization:{...organization,departments:[{...organization.departments[0],pathIds:['bad\nID']}]}}),/Invalid Feishu/);
});

test('account details escape user and supplier text and keep unknown counters visible',async t=>{
 const f=await fixture(t);await f.ledger.capture(f.owner.id,relayed({usage:null}));
 const details=await f.ledger.details(f.owner,query);details.groups=[{id:'group-fixture',name:'<script>group</script>',description:'<img src=x>'}];
 const escape=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const html=renderAccountDetails({details,query,escape});assert.match(html,/&lt;script&gt;group/);assert.match(html,/未提供/);assert.doesNotMatch(html,/<script|<img/);
});

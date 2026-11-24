/** Isolated DOM checks for authenticated metadata, missing usage, filtering and stale-response containment. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { JSDOM } from 'jsdom'
import { renderAccountData } from './account-data-page.mjs'
import { mountAccountData } from './account-data-client.js'

const accountId='aaaaaaaaaaaaaaaa'
const usage={version:1,coverage:{transport:'relay-only',direct:'unobserved'},from:'2026-10-14',to:'2026-11-12',summary:{
 requests:2,completedRequests:1,failedRequests:0,pendingRequests:0,unknownRequests:1,reportedUsageRequests:1,partialUsageRequests:0,unreportedUsageRequests:1,
 inputTokens:12,outputTokens:null,totalTokens:null},items:[
 {version:1,accountId,requestId:'fixture-request',channel:'desktop-relay',startedAt:'2026-11-12T00:00:00.000Z',state:'completed',usage:{input_tokens:12},usageStatus:'reported',responseModel:'writer'},
 {version:1,accountId,requestId:'unknown-request',channel:'desktop-relay',startedAt:'2026-11-12T00:01:00.000Z',state:'unknown',usage:null,usageStatus:'unreported'},
 ],nextCursor:'next-page',health:{state:'ok'}}
const archives={items:[{version:1,deviceId:'11111111-1111-4111-8111-111111111111',sessionId:'my-session',digest:'b'.repeat(64),
 storedAt:'2026-11-12T02:03:04.000Z',eventCount:3,attachments:[{sha256:'c'.repeat(64),sizeBytes:12,mediaType:'image/png'}]}],nextCursor:null}
const budget=(entries,settledEntries,reservedMinor,heldMinor,settledMinor)=>({currency:'CNY',entries,unsettledEntries:entries-settledEntries,settledEntries,reservedMinor,heldMinor,settledMinor,overflow:false,overflows:{reservedMinor:false,heldMinor:false,settledMinor:false}})
const studio={version:2,scope:'studio-all',accountId,from:'2026-10-14',to:'2026-11-12',status:'recorded',billingVerified:false,coveredSources:['native','tts'],
 summary:{operations:2,states:{authorized:0,reserved:0,accepted:0,completed:1,failed:0,unknown:1,'operator-confirmed':0,'awaiting-review':0},sources:{native:2,tts:0,fal:0,libtv:0,'libtv-cli':0},reportedUsageOperations:1,unreportedUsageOperations:1,usageErrorOperations:0,supplierReports:1,inputTokens:25,outputTokens:null,totalTokens:null,
  tokenCoverage:{input:{reportedReports:1,unreportedReports:0,overflow:false},output:{reportedReports:0,unreportedReports:1,overflow:false},total:{reportedReports:0,unreportedReports:1,overflow:false}},resources:{images:1,videos:0,audios:0,tasks:1},budgetTotals:[budget(2,1,240,120,80)]},
 items:[{operationId:'native-private-operation',source:'native',kind:'image',state:'completed',recordedState:'completed',createdAt:'2026-11-12T03:00:00.000Z',updatedAt:'2026-11-12T03:00:01.000Z',httpStatus:201,errorCode:null,usageStatus:'reported',supplierReports:1,inputTokens:25,outputTokens:null,totalTokens:null,resources:{images:1,videos:0,audios:0,tasks:1},budgetTotals:[budget(1,1,120,0,80)]}],nextCursor:'native-next-page',health:{state:'ok',invalidUsageReports:0}}
function studioResponse(path,value=studio){const query=new URL(path,'https://muse.fixture.test').searchParams;return Response.json({...value,from:query.get('from')??value.from,to:query.get('to')??value.to,accountId:query.get('accountId')??value.accountId});}

function fixture(t,admin=false,respond=path=>path.startsWith('/api/admin/accounts')?Response.json({version:1,items:[{id:accountId,username:'writer'}]})
 :path.includes('studio-usage')?studioResponse(path):path.includes('session-archives')?Response.json(archives):Response.json(usage)){
 const dom=new JSDOM(renderAccountData({admin,escape:value=>value}),{url:'https://muse.fixture.test/account'}),requests=[]
 t.after(()=>dom.window.close())
 const root=dom.window.document.querySelector('[data-muse-account-data]')
 const dispose=mountAccountData(root,{fetcher:async(path,options)=>{requests.push({path,options});return await respond(path,options)},now:()=>new Date('2026-11-12T10:00:00Z')})
 t.after(dispose)
 function until(predicate){
  if(predicate())return Promise.resolve()
  return new Promise((resolve,reject)=>{
   const observer=new dom.window.MutationObserver(()=>{if(predicate()){clearTimeout(timer);observer.disconnect();resolve()}})
   const timer=setTimeout(()=>{observer.disconnect();reject(Error('Account data DOM did not reach the expected state'))},5000)
   observer.observe(root,{subtree:true,childList:true,attributes:true,characterData:true})
  })
 }
 const submit=()=>root.querySelector('form').dispatchEvent(new dom.window.Event('submit',{bubbles:true,cancelable:true}))
 return {dom,root,requests,dispose,until,submit}
}
const rows=(root,selector)=>[...root.querySelectorAll(selector+' tr')].map(row=>[...row.querySelectorAll('td')].map(cell=>cell.textContent))

test('personal usage distinguishes missing tokens and shows only the caller archive index',async t=>{
 const f=fixture(t)
 await f.until(()=>f.root.querySelector('[data-archives-items] tr')&&f.root.querySelector('[data-usage-items] tr')&&f.root.querySelector('[data-studio-items] tr'))
 assert.equal(f.requests.length,3)
 assert.ok(f.requests.every(({path,options})=>path.startsWith('/api/muse/')&&!path.includes('accountId')&&options.credentials==='same-origin'&&options.cache==='no-store'))
 assert.deepEqual(rows(f.root,'[data-usage-items]')[1].slice(2,7),['结果未知','未回报','未回报','未回报','未回报'])
 assert.match(f.root.querySelector('[data-usage-health]').textContent,/未回报 1 次.*结果未知 1 次/)
 assert.equal(f.root.querySelector('[data-usage-health]').hidden,false)
 assert.match(f.root.querySelector('[data-archives-items]').textContent,/3.*1 个 · 12 字节 · image\/png/)
 assert.equal(f.root.querySelector('[data-archives-items] a'),null)
 const view={headings:[...f.root.querySelectorAll('h2')].map(node=>node.textContent),
  summary:[...f.root.querySelectorAll('[data-usage-summary] div')].map(node=>[node.querySelector('dt').textContent,node.querySelector('dd').textContent]),
  requests:rows(f.root,'[data-usage-items]'),archives:rows(f.root,'[data-archives-items]'),
  studioSummary:[...f.root.querySelectorAll('[data-studio-summary] div')].map(node=>[node.querySelector('dt').textContent,node.querySelector('dd').textContent]),studio:rows(f.root,'[data-studio-items]'),
  notices:[...f.root.querySelectorAll('[role="status"]')].map(node=>node.textContent)}
 assert.deepEqual(view,JSON.parse(readFileSync(new URL('./expected/account-data.zh.json',import.meta.url),'utf8')))
})

test('administrator queries account and UTC date filters without loading anyone’s archive',async t=>{
 const f=fixture(t,true)
 await f.until(()=>f.root.querySelector('select').options.length===2&&f.root.querySelector('[data-usage-items] tr'))
 assert.equal(f.root.querySelector('[data-archives-items]'),null)
 assert.ok(!f.requests.some(({path})=>path.includes('session-archives')))
 const form=f.root.querySelector('form');form.elements.namedItem('accountId').value=accountId;form.elements.namedItem('from').value='2026-11-01'
 f.submit();await f.until(()=>f.requests.some(({path})=>path.includes('accountId=')))
 const url=new URL(f.requests.filter(({path})=>path.startsWith('/api/admin/usage')).at(-1).path,'https://muse.fixture.test')
 assert.equal(url.pathname,'/api/admin/usage');assert.equal(url.searchParams.get('accountId'),accountId)
 assert.equal(url.searchParams.get('from'),'2026-11-01');assert.equal(url.searchParams.get('to'),'2026-11-12')
 await f.until(()=>!f.root.querySelector('button[type="submit"]').disabled)
 form.elements.namedItem('from').value='2026-11-05'
 f.root.querySelector('[data-usage-next]').click();await f.until(()=>f.requests.some(({path})=>path.includes('cursor=next-page')))
 assert.equal(new URL(f.requests.at(-1).path,'https://muse.fixture.test').searchParams.get('accountId'),accountId)
 assert.equal(new URL(f.requests.at(-1).path,'https://muse.fixture.test').searchParams.get('from'),'2026-11-01')
})

test('malformed or unavailable statistics remain unavailable rather than becoming zero usage',async t=>{
 let ready=false
 const f=fixture(t,false,path=>path.includes('session-archives')?Response.json({items:[],nextCursor:null}):ready?Response.json(usage):Response.json({...usage,summary:{requests:0}}))
 await f.until(()=>f.root.querySelector('[data-usage-notice]').textContent.startsWith('无法更新'))
 assert.equal(f.root.querySelector('[data-usage-summary]').children.length,0)
 ready=true;f.submit();await f.until(()=>f.root.querySelector('[data-usage-items] tr'))
 ready=false;f.submit();await f.until(()=>f.root.querySelector('[data-usage-notice]').textContent.startsWith('无法更新'))
 assert.equal(f.root.querySelectorAll('[data-usage-items] tr').length,2)
})

test('escaped account labels cannot create markup and failed account loading has its own retry notice',async t=>{
 let failed=true
 const f=fixture(t,true,path=>path.startsWith('/api/admin/accounts')?failed?new Response(null,{status:503}):Response.json({version:1,items:[{id:accountId,username:'<img src=x onerror=alert(1)>'}]}):Response.json(usage))
 await f.until(()=>f.root.querySelector('[data-accounts-notice]').textContent.includes('暂时不可用')&&f.root.querySelector('[data-usage-notice]').textContent.includes('用量已更新'))
 assert.match(f.root.querySelector('[data-usage-notice]').textContent,/用量已更新/)
 failed=false;f.root.querySelector('[data-accounts-refresh]').click();await f.until(()=>f.root.querySelector('select').options.length===2)
 assert.equal(f.root.querySelector('select').options[1].textContent,'<img src=x onerror=alert(1)>')
 assert.equal(f.root.querySelector('img'),null)
})

test('expired login clears private metadata and ignores an archive reply already in flight',async t=>{
 const pending=Promise.withResolvers();let expired=false
 const f=fixture(t,false,path=>path.includes('session-archives')?pending.promise:expired?new Response(null,{status:401}):Response.json(usage))
 await f.until(()=>f.root.querySelector('[data-usage-items] tr'))
 expired=true;f.submit();await f.until(()=>f.root.querySelector('[data-usage-notice]').textContent.includes('登录已失效'))
 assert.equal(f.root.querySelector('[data-usage-summary]').children.length,0)
 pending.resolve(Response.json(archives));await pending.promise;await Promise.resolve();await Promise.resolve()
 assert.equal(f.root.querySelector('[data-archives-items]').children.length,0)
 assert.ok([...f.root.querySelectorAll('button')].every(button=>button.disabled))
})

test('disposing a page prevents delayed metadata from appearing in a later account page',async t=>{
 const pending=Promise.withResolvers()
 const f=fixture(t,false,()=>pending.promise),before=f.root.textContent
 f.dispose();pending.resolve(Response.json(usage));await pending.promise;await Promise.resolve();await Promise.resolve()
 assert.equal(f.root.textContent,before)
 assert.ok(f.requests.every(({options})=>options.signal.aborted))
})

test('studio usage keeps supplier nulls, coverage, native states and resource counts separate from relay totals',async t=>{
 const f=fixture(t);await f.until(()=>f.root.querySelector('[data-studio-items] tr'));
 assert.equal(f.root.querySelector('[data-usage-summary] dd').textContent,'2');assert.match(f.root.querySelector('[data-studio-summary]').textContent,/已回报输入 token25/);assert.doesNotMatch(f.root.querySelector('[data-studio-summary]').textContent,/37/);
 assert.deepEqual(rows(f.root,'[data-studio-items]')[0].slice(3,6),['25','未回报','未回报']);assert.match(f.root.querySelector('[data-studio-coverage]').textContent,/输出字段：0 次回报、1 次缺失.*不推算缺失总 token/);
 assert.match(f.root.querySelector('[data-studio-state-summary]').textContent,/结果未知 1.*图片 1 · 视频 0 · 音频 0 · 任务 1（不是成功成片数）/);assert.match(f.root.querySelector('[data-studio-usage]').textContent,/不与上方中转用量相加/);
 assert.equal(f.root.querySelector('[data-studio-sources]').textContent,'渠道记录：原生生成 2 · 独立配音 0 · 视频后期 0（尚未接入） · LibTV API 0（尚未接入） · LibTV CLI 0（尚未接入）');
 assert.equal(f.root.querySelector('[data-studio-budget]').textContent,'CNY：预占 2.40，待核销 1.20，已核销 0.80。金额来自预算账本；预占不是已扣费用，核销不是已验证的供应商账单。');
})

test('admin requires a selected account and late Alice replies cannot appear after selecting Bob',async t=>{
 const bob='bbbbbbbbbbbbbbbb',aliceNative=Promise.withResolvers(),bobNative=Promise.withResolvers(),aliceRelay=Promise.withResolvers();
 const f=fixture(t,true,path=>{const url=new URL(path,'https://muse.fixture.test');if(url.pathname==='/api/admin/accounts')return Response.json({version:1,items:[{id:accountId,username:'Alice'},{id:bob,username:'Bob'}]});if(url.pathname==='/api/admin/studio-usage')return url.searchParams.get('accountId')===accountId?aliceNative.promise:bobNative.promise;if(url.searchParams.get('accountId')===accountId)return aliceRelay.promise;return Response.json(usage)});
 await f.until(()=>f.root.querySelector('select').options.length===3);assert.equal(f.requests.filter(({path})=>path.includes('studio-usage')).length,0);assert.match(f.root.querySelector('[data-studio-notice]').textContent,/请选择具体账号/);
 const select=f.root.querySelector('select');select.value=accountId;select.dispatchEvent(new f.dom.window.Event('change',{bubbles:true}));f.submit();await f.until(()=>f.requests.some(({path})=>path.includes('studio-usage')&&path.includes(accountId)));
 select.value=bob;select.dispatchEvent(new f.dom.window.Event('change',{bubbles:true}));assert.equal(f.root.querySelector('[data-studio-items]').children.length,0);assert.equal(f.root.querySelector('[data-studio-summary]').children.length,0);assert.equal(f.root.querySelector('[data-usage-items]').children.length,0);
 const bobPath=f.requests.findLast(({path})=>path.includes('studio-usage')&&path.includes(bob)).path;bobNative.resolve(studioResponse(bobPath,{...studio,items:[{...studio.items[0],operationId:'bob-native-operation'}]}));await f.until(()=>f.root.querySelector('[data-studio-items]').textContent.includes('bob-native-operation'));
 const alicePath=f.requests.find(({path})=>path.includes('studio-usage')&&path.includes(accountId)).path;aliceNative.resolve(studioResponse(alicePath,{...studio,items:[{...studio.items[0],operationId:'alice-private-operation'}]}));aliceRelay.resolve(Response.json(usage));await Promise.all([aliceNative.promise,aliceRelay.promise]);await Promise.resolve();await Promise.resolve();
 assert.doesNotMatch(f.root.textContent,/alice-private-operation/);assert.match(f.root.querySelector('[data-studio-items]').textContent,/bob-native-operation/);assert.equal(f.root.querySelector('[data-usage-items]').children.length,0);
 assert.ok(f.requests.filter(({path})=>path.includes('studio-usage')&&path.includes(accountId)).every(({options})=>options.signal.aborted));
})

test('studio pagination retains its own accepted UTC query and date edits clear all old results',async t=>{
 const f=fixture(t);await f.until(()=>!f.root.querySelector('[data-studio-next]').hidden&&f.root.querySelector('[data-usage-items] tr'));
 const form=f.root.querySelector('form');form.elements.namedItem('from').value='2026-11-01';f.root.querySelector('[data-studio-next]').click();await f.until(()=>f.requests.some(({path})=>path.includes('cursor=native-next-page')));let url=new URL(f.requests.findLast(({path})=>path.includes('studio-usage')).path,'https://muse.fixture.test');assert.equal(url.searchParams.get('from'),'2026-10-14');assert.ok(!url.searchParams.has('accountId'));
 await f.until(()=>!f.root.querySelector('[data-studio-next]').disabled);form.elements.namedItem('from').dispatchEvent(new f.dom.window.Event('change',{bubbles:true}));assert.equal(f.root.querySelector('[data-studio-items]').children.length,0);assert.equal(f.root.querySelector('[data-usage-items]').children.length,0);assert.equal(f.root.querySelector('[data-studio-next]').hidden,true);
 f.root.querySelector('[data-studio-refresh]').click();await f.until(()=>f.root.querySelector('[data-studio-items] tr'));url=new URL(f.requests.findLast(({path})=>path.includes('studio-usage')).path,'https://muse.fixture.test');assert.equal(url.searchParams.get('from'),'2026-11-01');assert.ok(!url.searchParams.has('cursor'));
})

test('unconfigured, missing, old and unreadable studio databases never become a zero-history assertion',async t=>{
 const zero=value=>Object.fromEntries(Object.keys(value).map(key=>[key,0])),coverage={reportedReports:0,unreportedReports:0,overflow:false};
 const empty={...studio.summary,operations:0,states:zero(studio.summary.states),sources:zero(studio.summary.sources),reportedUsageOperations:0,unreportedUsageOperations:0,supplierReports:0,inputTokens:null,tokenCoverage:{input:coverage,output:coverage,total:coverage},resources:zero(studio.summary.resources),budgetTotals:[]};
 let mode='no-database';const f=fixture(t,false,path=>{if(!path.includes('studio-usage'))return path.includes('session-archives')?Response.json(archives):Response.json(usage);if(mode==='unconfigured')return Response.json({error:{code:'studio_usage_not_configured'}},{status:503});if(mode==='error')return new Response(null,{status:503});return studioResponse(path,{...studio,status:mode,coveredSources:[],summary:empty,items:[],nextCursor:null})});
 const blank=()=>['[data-studio-coverage]','[data-studio-state-summary]','[data-studio-sources]','[data-studio-budget]'].every(selector=>f.root.querySelector(selector).textContent==='');
 await f.until(()=>f.root.querySelector('[data-studio-notice]').textContent.includes('尚无制作平台数据库'));assert.equal(f.root.querySelector('[data-studio-summary]').children.length,0);assert.ok(blank());
 for(const[value,text]of [['not-instrumented','尚未接入'],['unconfigured','尚未配置'],['error','读取失败']]){mode=value;f.root.querySelector('[data-studio-refresh]').click();await f.until(()=>f.root.querySelector('[data-studio-notice]').textContent.includes(text));assert.equal(f.root.querySelector('[data-studio-summary]').children.length,0);assert.equal(f.root.querySelector('[data-studio-items]').children.length,0);assert.ok(blank())}
})

test('studio replies expose only metadata and refuse unsafe token totals',async t=>{
 let invalid=false;const f=fixture(t,false,path=>path.includes('studio-usage')?studioResponse(path,{...studio,summary:{...studio.summary,inputTokens:invalid?Number.MAX_SAFE_INTEGER+1:25},prompt:'HIDDEN_PROMPT',config:{api_key:'HIDDEN_KEY'},receipt:'HIDDEN_RECEIPT',items:[{...studio.items[0],operationId:'<img src=x onerror=alert(1)>',prompt:'HIDDEN_ROW_PROMPT'}]}):path.includes('session-archives')?Response.json(archives):Response.json(usage));
 await f.until(()=>f.root.querySelector('[data-studio-items] tr'));assert.equal(f.root.querySelector('img'),null);assert.doesNotMatch(f.root.textContent,/HIDDEN_/);assert.match(f.root.querySelector('[data-studio-items]').textContent,/<img src=x/);
 invalid=true;f.root.querySelector('[data-studio-refresh]').click();await f.until(()=>f.root.querySelector('[data-studio-notice]').textContent.includes('读取失败'));assert.equal(f.root.querySelector('[data-studio-summary]').children.length,0);
})

test('a mismatched admin account reply is rejected instead of drawing another account’s metadata',async t=>{
 const bob='bbbbbbbbbbbbbbbb';const f=fixture(t,true,path=>path.startsWith('/api/admin/accounts')?Response.json({version:1,items:[{id:bob,username:'Bob'}]}):path.includes('studio-usage')?Response.json({...studio,items:[{...studio.items[0],operationId:'alice-mismatched-operation'}]}):Response.json(usage));await f.until(()=>f.root.querySelector('select').options.length===2);const select=f.root.querySelector('select');select.value=bob;select.dispatchEvent(new f.dom.window.Event('change',{bubbles:true}));await f.until(()=>f.root.querySelector('[data-studio-notice]').textContent.includes('读取失败'));assert.doesNotMatch(f.root.textContent,/alice-mismatched-operation/);assert.equal(f.root.querySelector('[data-studio-summary]').children.length,0);
})

test('a supplier-reported zero stays zero and degraded native coverage never invents a total',async t=>{
 const summary={...studio.summary,inputTokens:0,outputTokens:0,totalTokens:null,usageErrorOperations:1,tokenCoverage:{input:{reportedReports:1,unreportedReports:0,overflow:false},output:{reportedReports:1,unreportedReports:0,overflow:false},total:{reportedReports:0,unreportedReports:1,overflow:true}}};
 const f=fixture(t,false,path=>path.includes('studio-usage')?studioResponse(path,{...studio,summary,health:{state:'degraded',invalidUsageReports:1},items:[{...studio.items[0],inputTokens:0,outputTokens:0,totalTokens:null,usageStatus:'error'}]}):path.includes('session-archives')?Response.json(archives):Response.json(usage));await f.until(()=>f.root.querySelector('[data-studio-items] tr'));assert.deepEqual(rows(f.root,'[data-studio-items]')[0].slice(3,6),['0','0','未回报']);assert.equal(f.root.querySelector('[data-studio-health]').hidden,false);assert.match(f.root.querySelector('[data-studio-health]').textContent,/1 份供应商回报无效.*1 个操作.*合计溢出/);assert.match(f.root.querySelector('[data-studio-coverage]').textContent,/总计字段：0 次回报、1 次缺失（合计溢出/);
})

test('native login expiry clears every private section and cannot repopulate late relay or archive replies',async t=>{
 const relay=Promise.withResolvers(),archive=Promise.withResolvers();const f=fixture(t,false,path=>path.includes('studio-usage')?new Response(null,{status:401}):path.includes('session-archives')?archive.promise:relay.promise);
 await f.until(()=>f.root.querySelector('[data-studio-notice]').textContent.includes('重新登录'));relay.resolve(Response.json(usage));archive.resolve(Response.json(archives));await Promise.all([relay.promise,archive.promise]);await Promise.resolve();await Promise.resolve();for(const selector of ['[data-usage-items]','[data-studio-items]','[data-archives-items]'])assert.equal(f.root.querySelector(selector).children.length,0);assert.ok([...f.root.querySelectorAll('button')].every(button=>button.disabled));
})

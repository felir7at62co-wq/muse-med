import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {companyCliDigest} from './company-cli-executor.mjs';
import {createLibTvSubtitleProvider,parseLibTvSubtitleProgress} from './company-libtv-subtitles.mjs';

const url='https://libtv-res.liblib.art/source.mp4';
const model='volcano-subtitle-eraser';
const schema={modelKey:model,modality:'video',schema:{modelKey:model,modelVendor:'volcano',properties:{},config:{generateTypes:{text:119,image:119}},rules:[{tooltip:'Only Chinese and English subtitles'},{check:'videoFormat',allow:['mp4','flv','ts','avi','mov','mkv','wmv']},{check:'videoMaxResolution',max:2048},{check:'videoMinDuration',min:3}]}};
const response=value=>new Response(JSON.stringify(value),{status:200,headers:{'content-type':'application/json'}});

async function setup(t,overrides={}){
 const root=await mkdtemp(join(tmpdir(),'muse-libtv-subtitles-'));
 t.after(()=>rm(root,{recursive:true,force:true}));
 await writeFile(join(root,'credentials.json'),JSON.stringify({usertoken:'fixture-private-token',webid:'fixture-private-webid',useruuid:'user-1'}));
 const binding={companyId:'company-1',projectId:'project-1',connectionId:'connection-1',connectionRevision:2,canvasUuid:'canvas-1',credentialsDir:root,owner:{user_uuid:'user-1',account_id:'account-1',team_id:null}};
 const node={nodeKey:'source-1',data:{type:'video',url:[url],resourceMeta:{items:[{kind:'video',width:1920,height:1080,durationSec:5}]},taskInfo:{status:2}}};
 const source={projectUuid:'canvas-1',nodeId:'source-1',outputNodeId:'new-output-1',nodeSha256:companyCliDigest(node),node};
 const calls=[];let clock=100000;
 const provider=createLibTvSubtitleProvider({now:()=>clock,fetchImpl:async(endpoint,options)=>{
  calls.push({endpoint,options,body:JSON.parse(options.body)});
  if(overrides.fetch)return overrides.fetch(endpoint,options);
  if(endpoint.endsWith('/calculator'))return response({code:0,data:{power:2,originalPrice:2},trace_id:`trace-${calls.length}`});
  if(endpoint.endsWith('/create'))return response({code:0,data:{taskId:'task-1'}});
  return response({code:0,data:{progresses:[{taskId:'task-1',status:2,power:2,taskResult:JSON.stringify({videos:[{previewPath:'https://libtv-res.liblib.art/output.mp4',resourceId:'resource-1'}]})}]}});
 },...overrides.options});
 const read=async(method,body)=>{assert.equal(method,'model_schema');assert.deepEqual(body,{model_key:model});return structuredClone(schema);};
 return {provider,binding,source,calls,read,setClock:value=>{clock=value;}};
}

test('subtitle request uses a new output identity, exact official fields and measured duration',async t=>{
 const f=await setup(t);f.source.measuredMedia={width:1920,height:1080,durationSec:5.123};
 const original=structuredClone(f.source),prepared=await f.provider.prepare(f);
 assert.deepEqual(f.source,original);
 assert.equal(prepared.method,'libtv_api_erase_subtitles');
 assert.equal(prepared.nodeSha256,f.source.nodeSha256);
 assert.deepEqual(prepared.request.params,{model,mode:'Subtitle',videoList:[url],videoListV2:[{url,width:1920,height:1080,duration:5.12}]});
 assert.deepEqual(prepared.request.metadata,{node_id:'new-output-1',project_id:'canvas-1'});
 assert.equal(prepared.request.taskType,'video');assert.equal(prepared.request.provider,'volcano');
 assert.equal(f.calls.length,0);
});

test('positive quotes bind source, output, connection and settings but ignore time and random IDs',async t=>{
 const f=await setup(t),first=await f.provider.prepare(f),second=await f.provider.prepare(f);
 assert.notEqual(first.request.requestId,second.request.requestId);
 assert.equal(first.requestSha256,second.requestSha256);
 const a=await f.provider.quote({...f,prepared:first});f.setClock(100001);
 const b=await f.provider.quote({...f,prepared:second});assert.equal(a.quoteIdentity,b.quoteIdentity);
 assert.notEqual(a.responseHash,b.responseHash);assert.equal(a.priceMinor,200);
 assert.equal(a.protocol,'muse-company-libtv-api-quote-v1');assert.equal(a.locked,false);
 assert.ok(!JSON.stringify({first,a}).includes('fixture-private'));
 const source=structuredClone(f.source);source.outputNodeId='another-output';
 const third=await f.provider.prepare({...f,source});assert.notEqual(first.requestSha256,third.requestSha256);
 for(const call of f.calls){assert.equal(call.endpoint,'https://api.liblib.tv/api/task/generation/power/calculator');assert.equal(call.options.redirect,'error');assert.equal(call.options.headers.token,'fixture-private-token');}
});

test('the verified complete zero-price response remains explicit and requires a genuine quote',async t=>{
 const f=await setup(t,{fetch:endpoint=>response(endpoint.endsWith('/calculator')?{code:0,data:{power:0,originalPrice:0,taskWeight:0,type:0,discountRatio:1}}:{code:0,data:{taskId:'zero-task'}})}),prepared=await f.provider.prepare(f);
 const quote=await f.provider.quote({...f,prepared});assert.equal(quote.zeroQuote,true);assert.equal(quote.priceMinor,0);assert.deepEqual(quote.response,{power:0,originalPrice:0,taskWeight:0,type:0,discountRatio:1});
 await assert.rejects(f.provider.create({...f,prepared,quote:{priceMinor:0}}),{code:'company_libtv_subtitles_fresh_quote_required'});assert.equal(f.calls.length,1);
 const ack=await f.provider.create({...f,prepared,quote});assert.equal(ack.taskId,'zero-task');assert.equal(f.calls.length,2);
});

test('missing or mismatched zero-price fields remain unknown pricing',async t=>{
 for(const data of [{power:0},{power:0,originalPrice:0,taskWeight:0,type:0},{power:0,originalPrice:0,taskWeight:1,type:0,discountRatio:1},{power:0,originalPrice:'0',taskWeight:0,type:0,discountRatio:1}]){
  const f=await setup(t,{fetch:()=>response({code:0,data})}),prepared=await f.provider.prepare(f);
  await assert.rejects(f.provider.quote({...f,prepared}),{code:'company_libtv_subtitles_price_unknown'});assert.equal(f.calls.length,1);
 }
});

test('a changed zero quote becomes a different positive-price approval',async t=>{
 let power=0;
 const f=await setup(t,{fetch:()=>response({code:0,data:{power,originalPrice:power,taskWeight:power,type:0,discountRatio:1}})}),prepared=await f.provider.prepare(f),zero=await f.provider.quote({...f,prepared});
 power=2;const paid=await f.provider.quote({...f,prepared});assert.equal(paid.zeroQuote,false);assert.equal(paid.priceMinor,200);assert.notEqual(paid.quoteIdentity,zero.quoteIdentity);
});

test('submission requires a fresh genuine quote and dispatches once',async t=>{
 const f=await setup(t),prepared=await f.provider.prepare(f),quote=await f.provider.quote({...f,prepared});
 await assert.rejects(f.provider.create({...f,prepared,quote:structuredClone(quote)}),{code:'company_libtv_subtitles_fresh_quote_required'});
 const ack=await f.provider.create({...f,prepared,quote});assert.deepEqual(ack,{taskId:'task-1',provider:'libtv-api',model,requestSha256:prepared.requestSha256,outputNodeId:'new-output-1'});
 await assert.rejects(f.provider.create({...f,prepared,quote}),{code:'company_libtv_subtitles_already_submitted'});
 assert.equal(f.calls.filter(call=>call.endpoint.endsWith('/create')).length,1);
 const result=await f.provider.progress({...f,taskId:ack.taskId});assert.equal(result.state,'completed');assert.equal(result.chargedMinor,200);assert.deepEqual(result.outputs,[{kind:'video',url:'https://libtv-res.liblib.art/output.mp4',resourceId:'resource-1'}]);
});

test('expired or changed quotes and mutated prepared inputs cannot submit',async t=>{
 const f=await setup(t),prepared=await f.provider.prepare(f),quote=await f.provider.quote({...f,prepared});
 f.setClock(160000);await assert.rejects(f.provider.create({...f,prepared,quote}),{code:'company_libtv_subtitles_fresh_quote_required'});
 f.setClock(100000);quote.priceMinor=1;await assert.rejects(f.provider.create({...f,prepared,quote}),{code:'company_libtv_subtitles_fresh_quote_required'});
 prepared.request.model='other-model';await assert.rejects(f.provider.quote({...f,prepared}),{code:'company_libtv_subtitles_prepared_changed'});
 assert.equal(f.calls.length,1);
});

test('changed connection or credentials cannot cross accounts',async t=>{
 const f=await setup(t),prepared=await f.provider.prepare(f);
 await assert.rejects(f.provider.quote({...f,prepared,binding:{...f.binding,connectionRevision:3}}),{code:'company_libtv_subtitles_prepared_changed'});
 await writeFile(join(f.binding.credentialsDir,'credentials.json'),JSON.stringify({usertoken:'private',webid:'webid',useruuid:'other-user'}));
 await assert.rejects(f.provider.quote({...f,prepared}),{code:'company_libtv_subtitles_credentials_unavailable'});
 assert.equal(f.calls.length,0);
});

test('source changes, unsupported media and mismatched model schema reject before quote',async t=>{
 const f=await setup(t);
 for(const change of [source=>source.node.data.url[0]='https://evil.invalid/input.mp4',source=>source.outputNodeId=source.nodeId,source=>source.node.data.resourceMeta.items[0].durationSec=2.9,source=>source.node.data.resourceMeta.items[0].width=4096,source=>source.node.data.taskInfo.status=1]){
  const source=structuredClone(f.source);change(source);source.nodeSha256=companyCliDigest(source.node);
  await assert.rejects(f.provider.prepare({...f,source}),error=>error.code.startsWith('company_libtv_subtitles_'));
 }
 await assert.rejects(f.provider.prepare({...f,read:async()=>({...schema,schema:{...schema.schema,modelVendor:'other'}})}),{code:'company_libtv_subtitles_model_changed'});
 assert.equal(f.calls.length,0);
});

test('uncertain create response stays unknown and cannot be retried',async t=>{
 let count=0;
 const f=await setup(t,{fetch:endpoint=>{if(endpoint.endsWith('/calculator'))return response({code:0,data:{power:2}});count++;throw new Error('socket error with fixture-private-token and private path');}});
 const prepared=await f.provider.prepare(f),quote=await f.provider.quote({...f,prepared});
 await assert.rejects(f.provider.create({...f,prepared,quote}),error=>error.code==='company_libtv_subtitles_submission_unknown'&&!error.message.includes('fixture-private'));
 await assert.rejects(f.provider.create({...f,prepared,quote}),{code:'company_libtv_subtitles_already_submitted'});assert.equal(count,1);
});

test('malformed, rejected and oversized quotations expose no raw supplier message',async t=>{
 for(const mock of [()=>response({code:9,msg:'fixture-private-token',data:{power:2}}),()=>new Response('not-json'),()=>new Response('x'.repeat(2000)),()=>new Response('',{status:302,headers:{location:'https://evil.invalid'}})]){
  const f=await setup(t,{fetch:mock,options:{maxResponseBytes:1000}}),prepared=await f.provider.prepare(f);
  await assert.rejects(f.provider.quote({...f,prepared}),error=>error.code.startsWith('company_libtv_subtitles_')&&!error.message.includes('fixture-private'));assert.equal(f.calls.length,1);
 }
});

test('progress validates original task identity and all official terminal states',()=>{
 const raw=(status,other={})=>({code:0,data:{progresses:[{taskId:'task-1',status,...other}]}});
 for(const status of [0,1])assert.equal(parseLibTvSubtitleProgress(raw(status),'task-1').state,'running');
 for(const status of [3,4,5])assert.equal(parseLibTvSubtitleProgress(raw(status,{failedReason:'private-token'}),'task-1').state,'failed');
 assert.equal(parseLibTvSubtitleProgress(raw(999),'task-1').state,'unknown');
 assert.throws(()=>parseLibTvSubtitleProgress(raw(1),'wrong-task'),{code:'company_libtv_subtitles_task_mismatch'});
 assert.throws(()=>parseLibTvSubtitleProgress(raw(2,{taskResult:'{}'}),'task-1'),{code:'company_libtv_subtitles_invalid_result'});
 assert.throws(()=>parseLibTvSubtitleProgress(raw(2,{taskResult:{videos:[{previewPath:'http://127.0.0.1/private'}]}}),'task-1'),{code:'company_libtv_subtitles_invalid_media'});
});

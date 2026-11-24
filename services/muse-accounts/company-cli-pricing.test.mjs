import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {companyCliDigest} from './company-cli-executor.mjs';
import {createCompanyCliPricing} from './company-cli-pricing.mjs';

const endpoint='https://api.liblib.tv/api/task/generation/power/calculator';
const secret='private-fixture-token-never-return';
const now=Date.UTC(2026,10,14,4,30);
const owner={user_uuid:'fixture-owner',account_id:'fixture-account',team_id:null};
function metadataFor(model){
 const topaz=model==='topaz-video-upscaler';
 return {modelKey:model,modelName:model,modality:'video',schema:{modelKey:model,modelVendor:topaz?'topazlabs':'volcano',active:true,
  properties:{resolution:{default:'1080p',enum:['720p','1080p','2K','4K']},fps:{default:30,min:1,max:120,...topaz?{visibleWhen:{specifiedModel:{ne:'prob-4'}}}:{}},...topaz?{specifiedModel:{default:'prob-4',enum:['prob-4','apo-8']},slowmo:{default:'1',enum:['1','2','3','5']}}:{}},
  config:{settings:topaz?['resolution','specifiedModel','fps','slowmo']:['resolution','fps']}}};
}
function prepare(binding,model='volcano-video-upscaler',nodeId='source-a'){
 const node={nodeKey:nodeId,data:{type:'video',url:['https://libtv-res.liblib.art/fixture.mp4'],taskInfo:{status:2,loading:false},resourceMeta:{items:[{kind:'video',width:1280,height:720,durationSec:5}]}}};
 const spec={kind:'video_hd',project_uuid:binding.canvasUuid,node_id:nodeId,model_name:model};
 const snapshot={project:{nodes:[{id:nodeId}],edges:[]},nodes:[node]},metadata={models:[{modelKey:model,modelName:model}]};
 const plan={protocol:'libtv-cli-advanced-input-v1',command_kind:'video_hd',spec,snapshot,snapshot_sha256:companyCliDigest(snapshot),node,node_sha256:companyCliDigest(node),metadata,metadata_sha256:companyCliDigest(metadata),budget_model:'advanced:video_hd',service:'agent-task',quantity:1};
 const {kind,...body}=spec,command={method:kind,body};
 return {...command,paid:true,service:'agent-task',model:'advanced:video_hd',quantity:1,inputCapture:plan,requestSha256:companyCliDigest({command,companyId:binding.companyId,projectId:binding.projectId,connectionId:binding.connectionId,connectionRevision:binding.connectionRevision,owner:binding.owner,inputCapture:plan,uploadSha:null})};
}
async function fixture(t,{model='volcano-video-upscaler',fetchImpl}={}){
 const dir=await mkdtemp(join(tmpdir(),'muse-hd-price-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 await writeFile(join(dir,'credentials.json'),JSON.stringify({usertoken:secret,webid:'fixture-web-id',useruuid:owner.user_uuid}),{mode:0o600});
 const binding={companyId:'company-a',projectId:'project-a',connectionId:'connection-a',connectionRevision:1,canvasUuid:'canvas-a',owner,credentialsDir:dir};
 const calls=[],reads=[],metadata=metadataFor(model),prepared=prepare(binding,model);
 const pricing=createCompanyCliPricing({now:()=>now,fetchImpl:fetchImpl??(async(url,options)=>{calls.push({url,options});return Response.json({code:0,data:{power:model==='topaz-video-upscaler'?20:2,originalPrice:model==='topaz-video-upscaler'?20:2},trace_id:'trace-'+calls.length});})});
 const read=async(method,body)=>{reads.push({method,body});return metadata;};
 return {binding,prepared,metadata,calls,reads,read,pricing};
}

test('HD pricing uses the exact CLI defaults and only the separate calculator endpoint',async t=>{
 for(const model of ['volcano-video-upscaler','topaz-video-upscaler'])await t.test(model,async child=>{
  const state=await fixture(child,{model}),quote=await state.pricing.resolve(state);
  assert.equal(state.calls.length,1);assert.deepEqual(state.reads,[{method:'model_schema',body:{model_key:model}}]);
  const {url,options}=state.calls[0],request=JSON.parse(options.body);
  assert.equal(url,endpoint);assert.equal(options.method,'POST');assert.equal(options.redirect,'error');assert.equal(options.headers.token,secret);assert.ok(options.signal instanceof AbortSignal);
  assert.equal(request.taskType,'video');assert.equal(request.metadata.node_id,'source-a');assert.equal(request.metadata.project_id,'canvas-a');
  assert.deepEqual(request.params.videoListV2,[{url:'https://libtv-res.liblib.art/fixture.mp4',width:1280,height:720,duration:5}]);
  assert.equal(request.params.resolution,'1080p');assert.equal(request.params.fps,model==='volcano-video-upscaler'?30:undefined);
  assert.equal(quote.priceMinor,model==='volcano-video-upscaler'?200:2000);assert.equal(quote.currency,'LTV');assert.equal(quote.locked,false);
  assert.equal(quote.billingModel,'advanced:video_hd');assert.equal(quote.model,model);assert.equal(quote.requestSha256,state.prepared.requestSha256);
  assert.equal(quote.nodeSha256,state.prepared.inputCapture.node_sha256);assert.equal(quote.quotedAt,new Date(now).toISOString());assert.equal(quote.expiresAt,new Date(now+60000).toISOString());
  assert.equal(JSON.stringify(quote).includes(secret),false);assert.equal(quote.requestHash,companyCliDigest(request));
 });
});

test('new trace IDs preserve authorization identity while source, price and schema changes invalidate it',async t=>{
 const state=await fixture(t),a=await state.pricing.resolve(state),b=await state.pricing.resolve(state);
 assert.notEqual(a.requestHash,b.requestHash);assert.notEqual(a.responseHash,b.responseHash);assert.equal(a.quoteIdentity,b.quoteIdentity);
 const other=await state.pricing.resolve({...state,prepared:prepare(state.binding,'volcano-video-upscaler','source-b')});assert.notEqual(a.quoteIdentity,other.quoteIdentity);
 state.metadata.schema.properties.fps.default=24;
 const changed=await state.pricing.resolve(state);assert.notEqual(changed.quoteIdentity,a.quoteIdentity);assert.equal(changed.request.params.fps,24);
 const costly=createCompanyCliPricing({now:()=>now,fetchImpl:async()=>Response.json({code:0,data:{power:3,originalPrice:3}})});
 assert.notEqual((await costly.resolve(state)).quoteIdentity,changed.quoteIdentity);
});

test('unsupported command fields, changed node and connection inputs fail before any HTTP request',async t=>{
 const state=await fixture(t);
 await assert.rejects(state.pricing.resolve({...state,prepared:{...state.prepared,method:'video_final'}}),{code:'company_cli_quote_unsupported_operation'});
 await assert.rejects(state.pricing.resolve({...state,prepared:{...state.prepared,body:{...state.prepared.body,params:{fps:'60'}}}}),{code:'company_cli_unknown_argument'});
 const different=structuredClone(state.prepared);different.inputCapture.node.nodeKey='other';
 await assert.rejects(state.pricing.resolve({...state,prepared:different}),{code:'company_cli_advanced_inputs_changed'});
 await assert.rejects(state.pricing.resolve({...state,binding:{...state.binding,connectionRevision:2}}),{code:'company_cli_quote_inputs_changed'});
 assert.equal(state.calls.length,0);
});

test('model schema drift cannot silently add parameters or change the selected supplier',async t=>{
 for(const change of [metadata=>metadata.schema.config.settings.push('surprise'),metadata=>metadata.schema.properties.fps.originalField='cost',metadata=>metadata.schema.properties.fps.visibleWhen={resolution:{eq:'1080p'}},metadata=>metadata.schema.modelVendor='another-supplier',metadata=>metadata.schema.properties.resolution.default='8K'])await t.test(String(change),async child=>{
  const state=await fixture(child);change(state.metadata);
  await assert.rejects(state.pricing.resolve(state),{code:'company_cli_quote_unsupported_settings'});assert.equal(state.calls.length,0);
 });
});

test('source media must be a single completed, measured video in the reviewed node',async t=>{
 for(const change of [node=>node.data.url.push('https://libtv-res.liblib.art/second.mp4'),node=>node.data.resourceMeta.items[0].durationSec=0,node=>node.data.taskInfo.status=1,node=>node.data.url=['http://libtv-res.liblib.art/fixture.mp4']])await t.test(String(change),async child=>{
  const state=await fixture(child),input=state.prepared.inputCapture;change(input.node);
  input.node_sha256=companyCliDigest(input.node);input.snapshot_sha256=companyCliDigest(input.snapshot);
  state.prepared.requestSha256=companyCliDigest({command:{method:state.prepared.method,body:state.prepared.body},companyId:state.binding.companyId,projectId:state.binding.projectId,connectionId:state.binding.connectionId,connectionRevision:state.binding.connectionRevision,owner:state.binding.owner,inputCapture:input,uploadSha:null});
  await assert.rejects(state.pricing.resolve(state),{code:'company_cli_quote_unsupported_source'});assert.equal(state.calls.length,0);
 });
});

test('supplier failures and invalid amounts never become a zero or invented quote',async t=>{
 const cases=[
  {response:()=>new Response('hidden error '+secret,{status:503}),code:'company_cli_quote_http_error'},
  {response:()=>Response.json({code:10001,msg:secret}),code:'company_cli_quote_rejected'},
  {response:()=>new Response('not json '+secret),code:'company_cli_quote_invalid_response'},
  ...[0,-1,1.001,'2',Number.MAX_SAFE_INTEGER].map(power=>({response:()=>Response.json({code:0,data:{power}}),code:'company_cli_quote_invalid_price'})),
  {response:()=>{throw new Error(secret);},code:'company_cli_quote_unavailable'},
 ];
 for(const row of cases)await t.test(row.code,async child=>{
  const state=await fixture(child,{fetchImpl:row.response});
  await assert.rejects(state.pricing.resolve(state),error=>error.code===row.code&&!String(error).includes(secret));
 });
});

test('credential ownership and response size are checked without leaking unrecognized fields',async t=>{
 const state=await fixture(t,{fetchImpl:async()=>Response.json({code:0,data:{power:2,originalPrice:2,token:secret},password:secret,trace_id:secret})});
 const quote=await state.pricing.resolve(state);assert.equal(JSON.stringify(quote).includes(secret),false);assert.deepEqual(quote.response,{code:0,data:{power:2,originalPrice:2}});
 await writeFile(join(state.binding.credentialsDir,'credentials.json'),JSON.stringify({usertoken:secret,webid:'web',useruuid:'another-owner'}));
 await assert.rejects(state.pricing.resolve(state),{code:'company_cli_quote_credentials_unavailable'});
 await writeFile(join(state.binding.credentialsDir,'credentials.json'),JSON.stringify({usertoken:secret,webid:'web',useruuid:owner.user_uuid}));
 const limited=createCompanyCliPricing({maxResponseBytes:50,fetchImpl:async()=>new Response('x'.repeat(100))});
 await assert.rejects(limited.resolve(state),{code:'company_cli_quote_response_limit'});
});

test('cancelling an in-flight quote settles the caller and cannot dispatch a retry',async t=>{
 let enteredResolve;const entered=new Promise(resolve=>{enteredResolve=resolve;});let requests=0;
 const state=await fixture(t,{fetchImpl:async(url,{signal})=>{requests++;enteredResolve();return new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(new Error('aborted')),{once:true}));}});
 const controller=new AbortController(),operation=state.pricing.resolve({...state,signal:controller.signal});
 await entered;controller.abort();await assert.rejects(operation,{code:'company_cli_quote_cancelled'});assert.equal(requests,1);
});

test('quote deadlines abort the HTTP request and preserve fractional credit precision',async t=>{
 const state=await fixture(t);
 const fractional=createCompanyCliPricing({now:()=>now,fetchImpl:async()=>Response.json({code:0,data:{power:2.55}})});
 assert.equal((await fractional.resolve(state)).priceMinor,255);
 let enteredResolve;const entered=new Promise(resolve=>{enteredResolve=resolve;});
 const stalled=createCompanyCliPricing({timeoutMs:100,fetchImpl:async(url,{signal})=>{enteredResolve();return new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(new Error('aborted')),{once:true}));}});
 t.mock.timers.enable({apis:['setTimeout']});
 const operation=stalled.resolve(state);await entered;t.mock.timers.tick(100);
 await assert.rejects(operation,{code:'company_cli_quote_timeout'});
});

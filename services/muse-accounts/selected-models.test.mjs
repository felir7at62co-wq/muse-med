import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {selectedModelProviders,prepareSelectedModels,YUNYING_MODEL_IDS} from './selected-models.mjs';
import {openGlobalModels,validateGlobalModelDocument} from './global-models.mjs';
import {desktopModelCatalog} from './desktop-models.mjs';
import {openStore} from './store.mjs';
import {createAccountServer} from './gateway.mjs';
import {completionEndpoint} from './model-relay.mjs';

const cloudKey='synthetic-yunying-server-key',officialKey='synthetic-deepseek-server-key',zhipuKey='synthetic-zhipu-server-key';
function original(){return {version:2,revision:4,metadataRevision:9,providers:{legacy:{
 displayName:'旧目录',baseURL:'https://wy6688.token6688.com/v1',api:'openai-completions',apiKeyEnv:'LEGACY_KEY',
 models:[{id:'gpt-6-sol'},{id:'glm-5.3-flash'}],
 }},credentials:{LEGACY_KEY:cloudKey,OTHER_KEY:'synthetic-unrelated-key',MUSE_ZHIPU_API_KEY:zhipuKey}};}

test('selected directory contains two DeepSeek, seven Yunying and two Zhipu model without changing its source',()=>{
 const source=original(),before=structuredClone(source),prepared=prepareSelectedModels(source,{deepseekKey:officialKey});
 assert.deepEqual(source,before);assert.equal(prepared.revision,5);assert.equal(prepared.metadataRevision,10);
 assert.deepEqual(Object.keys(prepared.providers),['deepseek-official','yunying','zhipu-official']);
 assert.deepEqual(prepared.providers['deepseek-official'].models.map(model=>model.id),['deepseek-flash','deepseek-v4-pro']);
 assert.deepEqual(prepared.providers.yunying.models.map(model=>model.id),YUNYING_MODEL_IDS);
 assert.deepEqual(prepared.providers['zhipu-official'].models.map(model=>model.id),['glm-5.3-flashx','glm-5.3-flash']);
 assert.equal(prepared.providers['deepseek-official'].baseURL,'https://api.deepseek.com/v1');
 assert.equal(prepared.providers.yunying.baseURL,'https://wy6688.token6688.com/v1');
 assert.equal(prepared.providers['zhipu-official'].baseURL,'https://open.bigmodel.cn/api/paas/v4');
 assert.equal(completionEndpoint(prepared.providers['zhipu-official'].baseURL).href,'https://open.bigmodel.cn/api/paas/v4/chat/completions');
 assert.equal(prepared.providers['zhipu-official'].apiKeyEnv,'MUSE_ZHIPU_API_KEY');
 assert.equal(prepared.credentials.LEGACY_KEY,cloudKey);assert.equal(prepared.credentials.OTHER_KEY,before.credentials.OTHER_KEY);
 assert.equal(prepared.credentials.MUSE_DEEPSEEK_API_KEY,officialKey);assert.equal(prepared.credentials.MUSE_YUNYING_API_KEY,cloudKey);
 assert.equal(prepared.credentials.MUSE_ZHIPU_API_KEY,zhipuKey);
 assert.doesNotMatch(JSON.stringify(prepared.providers),/synthetic-/);
});

test('official capacity and each selected model budget are explicit public metadata',()=>{
 const providers=selectedModelProviders('https://wy6688.token6688.com/v1/');
 const official=providers['deepseek-official'].models;
 assert.ok(official.every(model=>model.contextWindow===1048576&&model.maxTokens===393216&&model.defaultReasoningEffort==='low'));
 assert.ok(official.every(model=>model.reasoningEfforts.off===null));
 assert.deepEqual(official[0].input,['text','image']);assert.deepEqual(official[1].input,['text']);
 for(const model of providers.yunying.models){
  assert.equal(model.contextWindow,model.id.startsWith('gpt-')?1050000:model.id.startsWith('claude-')?1000000:1048576);
  assert.equal(model.maxTokens,model.id.startsWith('gemini-')?65536:128000);
  if(model.id.startsWith('gpt-'))assert.deepEqual(model.reasoningEfforts,{low:'low'});
  else assert.equal(model.reasoningEfforts,false);
  assert.deepEqual(model.input,model.id.startsWith('claude-')||model.id==='glm-5.3-flash'?['text','image']:['text']);
 }
 assert.equal(providers.yunying.models.at(-1).name,'GLM-5.3-Flash');
 assert.equal(providers.yunying.models.at(-1).reasoningEfforts,false);
 const flashx=providers['zhipu-official'].models[0];
 assert.deepEqual(flashx,{id:'glm-5.3-flashx',name:'GLM-5.3-FlashX',contextWindow:1048576,maxTokens:128000,
  input:['text','image'],reasoningEfforts:{low:'low',high:'high',max:'max'},defaultReasoningEffort:'max'});
 assert.deepEqual(providers['zhipu-official'].models[1],{...flashx,id:'glm-5.3-flash',name:'GLM-5.3-Flash'});
 providers.yunying.models.pop();assert.equal(selectedModelProviders('https://wy6688.token6688.com').yunying.models.length,7);
});

test('preparation refuses absent or ambiguous settings instead of inventing a supplier endpoint or key',()=>{
 assert.throws(()=>prepareSelectedModels(original()),/credentials/);
 assert.throws(()=>prepareSelectedModels(original(),{deepseekKey:'private key\n'}),/credentials/);
 assert.throws(()=>prepareSelectedModels(original(),{deepseekKey:officialKey,zhipuKey:cloudKey}),/separate from Yunying/);
 const missingZhipu=original();delete missingZhipu.credentials.MUSE_ZHIPU_API_KEY;
 assert.throws(()=>prepareSelectedModels(missingZhipu,{deepseekKey:officialKey}),/credentials/);
 const missing=original();missing.providers={};
 assert.throws(()=>prepareSelectedModels(missing,{deepseekKey:officialKey}),/API root/);
 const ambiguous=original();ambiguous.providers.other={...ambiguous.providers.legacy,baseURL:'https://wy6688.token6688.com/other/v1',apiKeyEnv:'OTHER_KEY'};
 assert.throws(()=>prepareSelectedModels(ambiguous,{deepseekKey:officialKey}),/API root/);
 assert.throws(()=>prepareSelectedModels(ambiguous,{deepseekKey:officialKey,yunyingBaseURL:'https://wy6688.token6688.com/chosen/v1'}),/credentials/);
 const explicit=prepareSelectedModels(ambiguous,{deepseekKey:officialKey,yunyingBaseURL:'https://wy6688.token6688.com/chosen/v1',yunyingKey:cloudKey});
 assert.equal(explicit.providers.yunying.baseURL,'https://wy6688.token6688.com/chosen/v1');
 assert.throws(()=>prepareSelectedModels(original(),{deepseekKey:officialKey,yunyingBaseURL:'http://localhost'}),/HTTPS/);
});

test('matching model IDs from another supplier cannot inherit or receive Yunying credentials',()=>{
 const source=original();source.providers.other={...source.providers.legacy,baseURL:'https://another-supplier.example/v1',apiKeyEnv:'OTHER_KEY',models:[{id:'glm-5.3-flash'}]};
 const prepared=prepareSelectedModels(source,{deepseekKey:officialKey});assert.equal(prepared.credentials.MUSE_YUNYING_API_KEY,cloudKey);
 assert.throws(()=>prepareSelectedModels(source,{deepseekKey:officialKey,yunyingBaseURL:'https://another-supplier.example/v1'}),/verified supplier origin/);
 const otherOnly={...source,providers:{other:source.providers.other}};
 assert.throws(()=>prepareSelectedModels(otherOnly,{deepseekKey:officialKey}),/API root/);
 assert.throws(()=>prepareSelectedModels(otherOnly,{deepseekKey:officialKey,yunyingBaseURL:'https://wy6688.token6688.com/v1'}),/credentials/);
});

test('global document parsing rejects malformed headers and incompatible providers',async t=>{
 const root=await mkdtemp(join(tmpdir(),'muse-selected-invalid-'));t.after(()=>rm(root,{recursive:true,force:true}));
 for(const invalid of [null,{...original(),version:3},{...original(),revision:-1},{...original(),metadataRevision:1.2},
  {...original(),credentials:[]},{...original(),providers:[]},
  {...original(),providers:{test:{...original().providers.legacy,models:[{id:'m',contextWindow:100,maxTokens:101}]}}},
 ]){
  assert.throws(()=>validateGlobalModelDocument(invalid));
  const file=join(root,'models');await writeFile(file,JSON.stringify(invalid),{mode:0o600});
  await assert.rejects(openGlobalModels(file));assert.deepEqual(JSON.parse(await readFile(file,'utf8')),invalid);
 }
 assert.throws(()=>prepareSelectedModels({...original(),revision:Number.MAX_SAFE_INTEGER},{deepseekKey:officialKey}),/incremented/);
 assert.throws(()=>prepareSelectedModels({...original(),metadataRevision:Number.MAX_SAFE_INTEGER},{deepseekKey:officialKey}),/incremented/);
});

test('fresh account catalog routes every selected model with only server credentials and preserves tool continuations',async t=>{
 const root=await mkdtemp(join(tmpdir(),'muse-selected-account-'));let server;
 t.after(async()=>{if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}await rm(root,{recursive:true,force:true});});
 const prepared=prepareSelectedModels(original(),{deepseekKey:officialKey}),file=join(root,'models');
 await writeFile(file,JSON.stringify(prepared),{mode:0o600});const globalModels=await openGlobalModels(file);
 const safe=desktopModelCatalog(globalModels);
 assert.equal(safe.providers.flatMap(provider=>provider.models).length,11);
 assert.doesNotMatch(JSON.stringify(safe),/synthetic-|API_KEY|wy6688\.token6688\.com|api\.deepseek|open\.bigmodel/);
 const store=await openStore(join(root,'accounts'));await store.create('editor','pw');
 const origin='https://muse.test',calls=[];
 server=createAccountServer({workspaceMode:'desktop',store,globalModels,publicOrigin:origin,modelForward:async({config,body,res})=>{
  calls.push({config,body});res.writeHead(200,{'content-type':'text/event-stream'});res.end('data: [DONE]\n\n');
 }});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base='http://127.0.0.1:'+server.address().port;
 const login=await fetch(base+'/login',{method:'POST',headers:{origin},body:'username=editor&password=pw',redirect:'manual'});
 const cookie=login.headers.get('set-cookie').split(';')[0],token=cookie.slice(cookie.indexOf('=')+1);
 const response=await fetch(base+'/api/desktop-models/providers',{headers:{cookie}});assert.deepEqual(await response.json(),safe);
 for(const provider of safe.providers)for(const model of provider.models){
  const tools=[{type:'function',function:{name:'echo',parameters:{type:'object',properties:{}}}}];
  const history=[{role:'assistant',content:null,reasoning_content:'saved-thinking',tool_calls:[{id:'tool-one',type:'function',function:{name:'echo',arguments:'{}'}}]},
   {role:'tool',tool_call_id:'tool-one',content:'ok'}];
  const reply=await fetch(base+'/api/desktop-models/'+provider.id+'/chat/completions',{method:'POST',
   headers:{origin,authorization:'Bearer '+token,'content-type':'application/json'},
   body:JSON.stringify({model:model.id,messages:history,tools,stream:true,max_tokens:32768})});
  assert.equal(reply.status,200);assert.equal(await reply.text(),'data: [DONE]\n\n');
  const actual=calls.at(-1);assert.equal(actual.config.apiKey,provider.id==='deepseek-official'?officialKey:provider.id==='zhipu-official'?zhipuKey:cloudKey);
  if(provider.id==='zhipu-official')assert.equal(actual.config.baseURL,'https://open.bigmodel.cn/api/paas/v4');
  assert.equal(actual.body.max_tokens,32768);assert.deepEqual(actual.body.messages,history);assert.deepEqual(actual.body.tools,tools);
  assert.equal(actual.body.reasoning_effort,model.defaultReasoningEffort);
  if(provider.id==='zhipu-official')assert.deepEqual(actual.body.thinking,{type:'enabled',clear_thinking:false});
 }
 assert.equal(calls.length,11);
 for(const [route,model,budget,effort] of [['deepseek-official','deepseek-flash',393216,'low'],['yunying','gpt-6-sol',128000,'low'],
  ['zhipu-official','glm-5.3-flashx',128000,'max'],['zhipu-official','glm-5.3-flash',128000,'max']]){
  const reply=await fetch(base+'/api/desktop-models/'+route+'/chat/completions',{method:'POST',headers:{origin,cookie,'content-type':'application/json'},
   body:JSON.stringify({model,messages:[],stream:true})});
  assert.equal(reply.status,200);await reply.text();assert.equal(calls.at(-1).body.max_tokens,budget);assert.equal(calls.at(-1).body.reasoning_effort,effort);
 }
 assert.equal(calls.length,15);
 const off=await fetch(base+'/api/desktop-models/deepseek-official/chat/completions',{method:'POST',headers:{origin,cookie,'content-type':'application/json'},
  body:JSON.stringify({model:'deepseek-flash',messages:[],stream:true,thinking:{type:'disabled'},max_tokens:100})});
 assert.equal(off.status,200);await off.text();assert.deepEqual(calls.at(-1).body.thinking,{type:'disabled'});
 assert.equal(calls.at(-1).body.reasoning_effort,undefined);assert.equal(calls.at(-1).body.max_tokens,100);
 for(const [route,model] of [['yunying','glm-5.3-flashx'],['zhipu-official','gemini-3.1-pro'],
  ['deepseek-official','glm-5.3-flashx'],['zhipu-official','deepseek-flash'],['zhipu-official','unknown-model'],['yunying','deepseek-flash']]){
  const rejected=await fetch(base+'/api/desktop-models/'+route+'/chat/completions',{method:'POST',headers:{origin,cookie,'content-type':'application/json'},
   body:JSON.stringify({model,messages:[]})});assert.equal(rejected.status,400);
 }
 assert.equal(calls.length,16);
 await fetch(base+'/logout',{method:'POST',headers:{origin,cookie},redirect:'manual'});
 assert.equal((await fetch(base+'/api/desktop-models/providers',{headers:{cookie}})).status,401);
});

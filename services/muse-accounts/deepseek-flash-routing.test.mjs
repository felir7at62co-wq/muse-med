import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {EventEmitter,once} from 'node:events';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import https from 'node:https';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PassThrough,Readable} from 'node:stream';
import {openDeepSeekFlashRouting} from './deepseek-flash-routing.mjs';
import {accountToken,createModelRelay} from './model-relay.mjs';
import {desktopModelCatalog} from './desktop-models.mjs';
import {openGlobalModels} from './global-models.mjs';
import {createAccountServer} from './gateway.mjs';
import {openStore} from './store.mjs';

const route='deepseek-flash-auto',model='deepseek-v4.1-flash',bailianModel='deepseek-v4.1-flash-1017';
const accountId='0123456789abcdef',secondAccount='fedcba9876543210';
const secret='synthetic-workspace-secret';
const origin='https://gw.jubianai.net',bailianRoot='https://test-workspace.cn-beijing.maas.aliyuncs.com';
const seed={
 jubian:{provider:'jubian-flash-upstream',model},bailian:{provider:'alibaba-bailian',model:bailianModel},
 hide:[{provider:'volcengine-ark',model:'deepseek-v4-1-flash-261017'}],
};

function sessionFor(want,{account=accountId,otherAccount}={}){
 const sessions=Array.from({length:32},(_,index)=>createHash('sha256').update('muse-session-'+index).digest('hex'));
 const selectsBailian=(id,key)=>Number.parseInt(createHash('sha256').update(id).update('\0').update(key).digest('hex')[0],16)%2===1;
 return sessions.find(key=>selectsBailian(account,key)===(want==='bailian')
  &&(otherAccount===undefined||selectsBailian(otherAccount,key)!==selectsBailian(account,key)));
}

async function fixture(t){
 const directory=await mkdtemp(join(tmpdir(),'muse-flash-route-'));
 let flashRouting;
 t.after(async()=>{try{await flashRouting?.flush();}finally{await rm(directory,{recursive:true,force:true});}});
 const configFile=join(directory,'route.json'),affinityFile=join(directory,'affinity.json'),nativeFile=join(directory,'native.json');
 const provider=(baseURL,apiKeyEnv,models)=>({displayName:apiKeyEnv,baseURL,api:'openai-completions',apiKeyEnv,models});
 const entry=(id,contextWindow,input)=>({id,contextWindow,input,maxTokens:contextWindow/10,
  reasoningEfforts:{off:null,high:'high',max:'max'},defaultReasoningEffort:'high'});
 const document={version:2,revision:9,metadataRevision:17,
  providers:{
   [seed.jubian.provider]:provider(origin+'/v1','JUBIAN_KEY',[entry(model,1200000,['text','image'])]),
   [seed.bailian.provider]:provider(bailianRoot+'/compatible-mode/v1','BAILIAN_KEY',[entry(bailianModel,900000,['text'])]),
   'volcengine-ark':provider('https://ark.example/v1','ARK_KEY',[entry(seed.hide[0].model,900000,['text']),entry('ark-unrelated',100000,['text'])]),
   'jubian-pro':provider(origin+'/v1','JUBIAN_KEY',[entry('deepseek-v4-pro',1000000,['text'])]),
  },
  credentials:{JUBIAN_KEY:'jubian-key-example',BAILIAN_KEY:'bailian-key-example',ARK_KEY:'ark-key-example'},
 };
 await Promise.all([writeFile(configFile,JSON.stringify(seed)),writeFile(nativeFile,JSON.stringify(document))]);
 const globalModels=await openGlobalModels(nativeFile);
 const options={configFile,affinityFile,globalModels};
 flashRouting=await openDeepSeekFlashRouting(options);
 return {globalModels,flashRouting,affinityFile,document,options};
}

async function relay(t,{flashRouting,globalModels}){
 const accounts=new EventEmitter();
 accounts.get=id=>[accountId,secondAccount].includes(id)?{id}:undefined;
 const records=[],events=new EventEmitter(),usage=[];
 const modelUsage={begin(input){usage.push({input});return usage.length;},finish(id,report){usage[id-1].report=report;}};
 const server=createModelRelay({flashRouting,globalModels,accounts,secret,modelUsage,metadataSink:record=>{records.push(record);events.emit('record');}});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
 const base='http://127.0.0.1:'+server.address().port;
 return {records,usage,async waitForRecords(count){
  while(records.length<count)await once(events,'record',{signal:t.signal});
 },async catalog(){
  const response=await fetch(base+'/v1/muse-config',{headers:{authorization:'Bearer '+accountToken(secret,accountId)}});
  assert.equal(response.status,200);return response.json();
 },async post(options={}){
  const {account=accountId,key,provider=route,body={}}=options;
  return fetch(base+'/v1/'+provider+'/chat/completions',{method:'POST',
   headers:{authorization:'Bearer '+accountToken(secret,account),'content-type':'application/json',
    ...key===undefined?{}:{'x-muse-model-session':key}},
   body:JSON.stringify({model,messages:[{role:'user',content:'fixture'}],...body}),
  });
 }};
}

function mockUpstream(t,answer){
 const calls=[];
 t.mock.method(https,'request',(url,options,receive)=>{
  const request=new PassThrough();
  request.setTimeout=()=>request;
  request.end=payload=>{
   const supplier=url.origin===origin?'jubian':'bailian';
   const call={supplier,url,headers:options.headers,body:JSON.parse(payload)};
   calls.push(call);
   const result=answer(call);
   queueMicrotask(()=>{
    if(result.error){
     if(result.connected)request.emit('socket',Object.assign(new EventEmitter(),{connecting:false}));
     request.emit('error',Object.assign(Error('Fixture connection failed'),{code:result.error}));
     return;
    }
    const chunks=result.chunks??[Buffer.from(result.status===200?'data: [DONE]\n\n':'{"error":{"message":"fixture"}}')];
    const response=Readable.from(chunks);
    response.statusCode=result.status;
    response.headers={'content-type':result.contentType??'text/event-stream'};
    receive(response);
   });
   return request;
  };
  return request;
 });
 return calls;
}

test('the Flash entry is opt-in and publishes one credential-free model with shared capabilities',{timeout:10000},async t=>{
 const {globalModels,flashRouting,options}=await fixture(t);
 assert.equal(await openDeepSeekFlashRouting({}),undefined);
 const disabled=desktopModelCatalog(globalModels,undefined,undefined,'all');
 assert.ok(disabled.providers.some(provider=>provider.id===seed.jubian.provider));
 assert.ok(!disabled.providers.some(provider=>provider.id===route));
 const enabled=desktopModelCatalog(globalModels,undefined,flashRouting,'all');
 assert.deepEqual(enabled.providers.map(provider=>[provider.id,provider.models.map(item=>item.id)]),
  [['volcengine-ark',['ark-unrelated']],['jubian-pro',['deepseek-v4-pro']],[route,[model]]]);
 // The default selected catalog keeps its whitelist; the shared entry replaces the whitelisted Flash sources.
 assert.deepEqual(desktopModelCatalog(globalModels,undefined,flashRouting).providers.map(provider=>[provider.id,provider.models.map(item=>item.id)]),
  [[route,[model]]]);
 assert.deepEqual(enabled.providers.at(-1).models[0],{id:model,name:'DeepSeek V4.1 Flash',contextWindow:900000,
  maxTokens:90000,input:['text'],reasoningEfforts:{off:null,high:'high'},defaultReasoningEffort:'high'});
 assert.doesNotMatch(JSON.stringify(enabled),/gw\.jubian|aliyuncs|key-example|apiKey/);
 await writeFile(options.configFile,JSON.stringify({...seed,hide:[{provider:'jubian-pro',model:'deepseek-v4-pro'}]}));
 await assert.rejects(openDeepSeekFlashRouting(options),/Flash alias hide references/);
 await writeFile(options.configFile,JSON.stringify(seed));
 assert.equal(globalModels.resolve('volcengine-ark',seed.hide[0].model).model,seed.hide[0].model);
 await assert.rejects(openDeepSeekFlashRouting({...options,globalModels:{...globalModels,resolve:(provider,id)=>{
  const config=globalModels.resolve(provider,id);return provider===seed.bailian.provider?{...config,baseURL:'https://untrusted.example/v1'}:config;
 }}}),/verified origins/);
});

test('two sessions take distinct lines, retain affinity and send only their supplier dialect',{timeout:10000},async t=>{
 const config=await fixture(t),{post,records,waitForRecords,catalog}=await relay(t,config);
 assert.deepEqual(Object.keys((await catalog()).providers),[route]);
 const calls=mockUpstream(t,()=>({status:200}));
 const key=sessionFor('jubian',{otherAccount:secondAccount}),different=sessionFor('bailian');
 for(const options of [{key},{key},{key:different},{key,account:secondAccount}]){
  const response=await post({...options,body:{stream:true,max_tokens:200000,thinking:{type:'enabled'},reasoning_effort:'high'}});
  assert.equal(await response.text(),'data: [DONE]\n\n');
 }
 assert.deepEqual(calls.map(call=>call.supplier),['jubian','jubian','bailian','bailian']);
 assert.deepEqual(calls[0].body,{model,messages:[{role:'user',content:'fixture'}],stream:true,max_tokens:90000,
  thinking:{type:'enabled'},reasoning_effort:'high'});
 assert.deepEqual(calls[2].body,{model:bailianModel,messages:[{role:'user',content:'fixture'}],stream:true,max_tokens:90000,
  enable_thinking:true});
 assert.equal(calls[0].headers.authorization,'Bearer jubian-key-example');
 assert.equal(calls[2].headers.authorization,'Bearer bailian-key-example');
 assert.ok(calls.every(call=>!('x-muse-model-session' in call.headers)));
 await waitForRecords(4);
 assert.deepEqual(records.map(record=>[record.route,record.model_supplier]),calls.map(call=>[route,call.supplier]));
 assert.doesNotMatch(JSON.stringify(records),new RegExp(key+'|'+different+'|key-example'));
 const oldOptions={body:{stream:true,thinking:{type:'disabled'}}};
 for(const header of [undefined,'invalid'])await (await post({...oldOptions,key:header})).text();
 assert.equal(calls[4].supplier,calls[5].supplier);
});

test('a pre-response quota refusal closes its upstream before switching and remembers the alternate across restart',{timeout:10000},async t=>{
 const config=await fixture(t),first=await relay(t,config);
 const calls=mockUpstream(t,call=>({status:call.supplier==='jubian'?429:200}));
 const key=sessionFor('jubian');
 assert.equal(await (await first.post({key,body:{stream:true}})).text(),'data: [DONE]\n\n');
 await config.flashRouting.flush();
 const onDisk=await readFile(config.affinityFile,'utf8');
 assert.doesNotMatch(onDisk,new RegExp(accountId+'|'+key));
 assert.equal(JSON.parse(onDisk).entries[0][1],'bailian');
 const flashRouting=await openDeepSeekFlashRouting(config.options);
 await first.waitForRecords(1);
 const restarted=await relay(t,{...config,flashRouting});
 assert.equal(await (await restarted.post({key,body:{stream:true}})).text(),'data: [DONE]\n\n');
 assert.deepEqual(calls.map(call=>call.supplier),['jubian','bailian','bailian']);
 assert.deepEqual(first.records[0].supplier_attempts,
  [{supplier:'jubian',upstream_status:429,failover:'upstream_http'},{supplier:'bailian',upstream_status:200}]);
 assert.equal(first.records[0].error_kind,null);
 // Usage metering records the shared entry and the accepted attempt, not the refused one.
 assert.deepEqual(first.usage,[{input:{accountId,provider:route,model,entry:'legacy'},report:{outcome:'completed',sample:null,complete:true,httpStatus:200}}]);
});

test('a transient HTTP 500 falls back once and two refusals keep the original affinity',{timeout:10000},async t=>{
 const config=await fixture(t),{post,waitForRecords,records}=await relay(t,config);
 let bothFail=true;
 const calls=mockUpstream(t,call=>({status:call.supplier==='jubian'?500:bothFail?503:200}));
 const key=sessionFor('jubian');
 const unavailable=await post({key,body:{stream:true}});
 assert.equal(unavailable.status,502);await unavailable.text();
 assert.deepEqual(calls.map(call=>call.supplier),['jubian','bailian']);
 bothFail=false;
 assert.equal(await (await post({key,body:{stream:true}})).text(),'data: [DONE]\n\n');
 assert.deepEqual(calls.map(call=>call.supplier),['jubian','bailian','jubian','bailian']);
 await waitForRecords(2);
 assert.deepEqual(records[0].supplier_attempts,
  [{supplier:'jubian',upstream_status:500,failover:'upstream_http'},{supplier:'bailian',upstream_status:503}]);
 assert.equal(records[0].error_kind,'upstream_http');
});

test('only failed connections before dispatch move a session to the other supplier',{timeout:10000},async t=>{
 const config=await fixture(t),{post,records,waitForRecords}=await relay(t,config);
 let connected=false;
 const calls=mockUpstream(t,call=>call.supplier==='jubian'?{error:'ECONNRESET',connected}:{status:200});
 const key=sessionFor('jubian');
 connected=true;
 const failed=await post({key,body:{stream:true}});
 assert.equal(failed.status,502);await failed.text();
 assert.deepEqual(calls.map(call=>call.supplier),['jubian']);
 connected=false;
 assert.equal(await (await post({key,body:{stream:true}})).text(),'data: [DONE]\n\n');
 assert.deepEqual(calls.map(call=>call.supplier),['jubian','jubian','bailian']);
 await waitForRecords(2);
 assert.deepEqual(records[1].supplier_attempts,
  [{supplier:'jubian',upstream_status:null,failover:'connect'},{supplier:'bailian',upstream_status:200}]);
});

test('request errors, malformed successes and a stream truncated after data never replay',{timeout:10000},async t=>{
 const config=await fixture(t),{post}=await relay(t,config);
 let answer={status:400};
 const calls=mockUpstream(t,()=>answer);
 const key=sessionFor('jubian'),body={stream:true};
 for(const status of [400,401,403]){answer={status};const refused=await post({key,body});assert.equal(refused.status,status);await refused.text();}
 answer={status:200,contentType:'application/json'};
 const malformed=await post({key,body});assert.equal(malformed.status,502);await malformed.text();
 answer={status:200,chunks:(async function*(){
  yield Buffer.from('data: {"choices":[{"delta":{"content":"first"}}]}\n\n');
  await new Promise(resolve=>setImmediate(resolve));
  throw Object.assign(Error('Fixture interrupted the stream'),{code:'ECONNRESET'});
 })()};
 await assert.rejects(async()=>{await (await post({key,body})).text();});
 assert.deepEqual(calls.map(call=>call.supplier),Array(5).fill('jubian'));
});

test('without MUSE_DEEPSEEK_FLASH_ROUTING the Flash entry is absent and deepseek-official keeps its single configured supplier',{timeout:10000},async t=>{
 const directory=await mkdtemp(join(tmpdir(),'muse-flash-off-'));
 t.after(()=>rm(directory,{recursive:true,force:true}));
 const nativeFile=join(directory,'native.json'),affinityFile=join(directory,'affinity.json');
 const entry=(id,contextWindow)=>({id,contextWindow,maxTokens:contextWindow/10,input:['text'],reasoningEfforts:{off:null,high:'high'}});
 await writeFile(nativeFile,JSON.stringify({version:2,revision:1,metadataRevision:1,providers:{
  'deepseek-official':{displayName:'DeepSeek',baseURL:origin+'/v1',api:'openai-completions',apiKeyEnv:'JUBIAN_KEY',models:[entry(model,1000000)]},
  [seed.bailian.provider]:{displayName:'Bailian',baseURL:bailianRoot+'/compatible-mode/v1',api:'openai-completions',apiKeyEnv:'BAILIAN_KEY',models:[entry(bailianModel,900000)]},
 },credentials:{JUBIAN_KEY:'jubian-key-example',BAILIAN_KEY:'bailian-key-example'}}));
 const globalModels=await openGlobalModels(nativeFile);
 assert.equal(await openDeepSeekFlashRouting({affinityFile,globalModels}),undefined);
 for(const configFile of ['','route.json',null])
  await assert.rejects(openDeepSeekFlashRouting({configFile,affinityFile,globalModels}),/MUSE_DEEPSEEK_FLASH_ROUTING must be the absolute path/);
 const notJson=join(directory,'route.json');await writeFile(notJson,'{"jubian":');
 await assert.rejects(openDeepSeekFlashRouting({configFile:notJson,affinityFile,globalModels}),/not JSON/);
 await assert.rejects(readFile(affinityFile),{code:'ENOENT'});
 assert.deepEqual(desktopModelCatalog(globalModels).providers.map(provider=>[provider.id,provider.models.map(item=>item.id)]),
  [['deepseek-official',[model]],[seed.bailian.provider,[bailianModel]]]);
 const {post,records,waitForRecords,catalog}=await relay(t,{globalModels});
 assert.equal((await catalog()).providers[route],undefined);
 let status=429;
 const calls=mockUpstream(t,()=>({status}));
 const absent=await post({key:sessionFor('jubian')});assert.equal(absent.status,400);await absent.text();
 // A supplier refusal reaches the client unchanged: Jubian routes its own suppliers and the gateway never fails over.
 const refused=await post({provider:'deepseek-official',key:sessionFor('bailian'),body:{stream:true,thinking:{type:'enabled'}}});
 assert.equal(refused.status,429);await refused.text();
 status=200;
 assert.equal(await (await post({provider:'deepseek-official',body:{stream:true}})).text(),'data: [DONE]\n\n');
 assert.deepEqual(calls.map(call=>[call.supplier,call.body.model,call.headers.authorization]),
  [['jubian',model,'Bearer jubian-key-example'],['jubian',model,'Bearer jubian-key-example']]);
 assert.deepEqual(calls[0].body.thinking,{type:'enabled'});assert.equal(calls[0].body.enable_thinking,undefined);
 await waitForRecords(3);
 assert.ok(records.every(record=>!('model_supplier' in record)&&!('supplier_attempts' in record)));
 assert.deepEqual(records.map(record=>[record.route,record.upstream_status,record.client_status]),
  [[route,null,400],['deepseek-official',429,429],['deepseek-official',200,200]]);
});

test('Desktop sign-in lists the shared entry and meters the accepted supplier attempt',{timeout:10000},async t=>{
 const config=await fixture(t),directory=await mkdtemp(join(tmpdir(),'muse-flash-desktop-'));let server;
 t.after(async()=>{if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}await rm(directory,{recursive:true,force:true});});
 const store=await openStore(join(directory,'accounts.json')),account=await store.create('editor','pw');
 const usage=[],publicOrigin='https://muse.test';
 server=createAccountServer({store,globalModels:config.globalModels,flashRouting:config.flashRouting,publicOrigin,
  modelUsage:{begin(input){usage.push({input});return usage.length;},finish(id,report){usage[id-1].report=report;}}});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base='http://127.0.0.1:'+server.address().port;
 const login=await fetch(base+'/login',{method:'POST',redirect:'manual',headers:{origin:publicOrigin},body:'username=editor&password=pw'});
 const cookie=login.headers.get('set-cookie').split(';')[0];
 assert.deepEqual((await (await fetch(base+'/api/desktop-models/providers',{headers:{cookie}})).json()).providers.map(provider=>provider.id),[route]);
 const calls=mockUpstream(t,call=>({status:call.supplier==='jubian'?503:200}));
 const response=await fetch(base+'/api/desktop-models/'+route+'/chat/completions',{method:'POST',
  headers:{cookie,origin:publicOrigin,'content-type':'application/json','x-muse-model-session':sessionFor('jubian',{account:account.id})},
  body:JSON.stringify({model,messages:[{role:'user',content:'fixture'}],stream:true})});
 assert.equal(await response.text(),'data: [DONE]\n\n');
 assert.deepEqual(calls.map(call=>[call.supplier,call.body.model]),[['jubian',model],['bailian',bailianModel]]);
 while(!usage[0]?.report)await new Promise(resolve=>setImmediate(resolve));
 assert.deepEqual(usage,[{input:{accountId:account.id,provider:route,model,entry:'desktop'},report:{outcome:'completed',sample:null,complete:true,httpStatus:200}}]);
});

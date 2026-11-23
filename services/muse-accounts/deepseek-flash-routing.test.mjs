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
 const records=[],events=new EventEmitter();
 const server=createModelRelay({flashRouting,globalModels,accounts,secret,metadataSink:record=>{records.push(record);events.emit('record');}});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
 const base='http://127.0.0.1:'+server.address().port;
 return {records,async waitForRecords(count){
  while(records.length<count)await once(events,'record',{signal:t.signal});
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
 const disabled=desktopModelCatalog(globalModels);
 assert.ok(disabled.providers.some(provider=>provider.id===seed.jubian.provider));
 assert.ok(!disabled.providers.some(provider=>provider.id===route));
 const enabled=desktopModelCatalog(globalModels,undefined,flashRouting);
 assert.deepEqual(enabled.providers.map(provider=>[provider.id,provider.models.map(item=>item.id)]),
  [['volcengine-ark',['ark-unrelated']],['jubian-pro',['deepseek-v4-pro']],[route,[model]]]);
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
 const config=await fixture(t),{post,records,waitForRecords}=await relay(t,config);
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

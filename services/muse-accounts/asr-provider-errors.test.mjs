import {test} from 'node:test';
import assert from 'node:assert/strict';
import {inspect} from 'node:util';
import * as provider from './asr-provider.mjs';

const config={appId:'fixture-app',accessToken:'fixture-secret-token',timeoutMs:1000};
const input={id:'fixture-task',url:'https://signed.invalid/fixture-secret-url',language:'zh'};
const operations={
 submit:fetcher=>provider.submitAsr(config,input,fetcher),
 query:fetcher=>provider.queryAsr(config,input.id,fetcher),
 flash:fetcher=>provider.recognizeFlashAsr(config,input,fetcher),
};
const successBody={result:{utterances:[{start_time:0,end_time:1000,text:'fixture spoken words'}]}};

async function rejected(promise){
 try{await promise;}catch(error){return error;}
 assert.fail('Expected an ASR provider error');
}

function assertSafeError(error,expected){
 assert.equal(error.code,expected.code);
 assert.equal(typeof provider.AsrProviderError,'function');
 assert.ok(error instanceof provider.AsrProviderError);
 assert.equal(error.operation,expected.operation);
 assert.equal(error.httpStatus,expected.httpStatus);
 assert.equal(error.providerCode,expected.providerCode);
 assert.deepEqual(Object.getOwnPropertyNames(error).sort(),['message','code','operation',...expected.httpStatus===undefined?[]:['httpStatus'],...expected.providerCode===undefined?[]:['providerCode']].sort());
 assert.equal(error.stack,undefined);
 assert.equal(error.cause,undefined);
 for(const representation of [String(error),JSON.stringify(error),inspect(error)]){
  assert.doesNotMatch(representation,/fixture-secret|secret-response|secret-network|secret-json|secret-local-path/);
 }
 if(expected.operation==='submit')assert.match(error.message,/outcome unknown; retain the task ID and query it/);
 if(expected.operation==='flash')assert.match(error.message,/automatic resubmission is disabled/);
 if(expected.operation==='query')assert.match(error.message,/failed|unknown|invalid JSON/);
}

for(const [operation,invoke] of Object.entries(operations)){
 test(`${operation} retains safe supplier rejection codes without retrying a paid request`,async()=>{
  let calls=0;
  const error=await rejected(invoke(async()=>{calls++;return new Response('secret-response fixture-secret-token',{status:429,headers:{'X-Api-Status-Code':'45000001','X-Api-Message':'secret-response'}});}));
  assertSafeError(error,{operation,code:'provider_rejected',httpStatus:429,providerCode:'45000001'});
  assert.equal(calls,1);
 });

 test(`${operation} distinguishes an HTTP server failure from a supplier rejection`,async()=>{
  const error=await rejected(invoke(async()=>new Response('secret-response',{status:500,headers:{'X-Api-Status-Code':'55000001'}})));
  assertSafeError(error,{operation,code:'provider_unavailable',httpStatus:500,providerCode:'55000001'});
 });

 test(`${operation} discards raw network errors and makes one request`,async()=>{
  let calls=0;
  const error=await rejected(invoke(async()=>{calls++;throw Object.assign(Error('secret-network fixture-secret-token'),{cause:'secret-response',path:'secret-local-path'});}));
  assertSafeError(error,{operation,code:'provider_unavailable'});
  assert.equal(calls,1);
 });

 test(`${operation} omits missing or nonnumeric supplier codes`,async()=>{
  for(const code of [undefined,'1234','12345678901','45000secret-response','45000001,45000002']){
   const error=await rejected(invoke(async()=>new Response('secret-response',{status:429,headers:code===undefined?{}:{'X-Api-Status-Code':code}})));
   assertSafeError(error,{operation,code:'provider_rejected',httpStatus:429});
  }
 });

 test(`${operation} preserves a supplier rejection sent with HTTP success`,async()=>{
  const error=await rejected(invoke(async()=>new Response('secret-response',{headers:{'X-Api-Status-Code':'45000001'}})));
  assertSafeError(error,{operation,code:'provider_rejected',httpStatus:200,providerCode:'45000001'});
 });

 test(`${operation} excludes whitespace from supplier diagnostics`,async()=>{
  for(const code of ['45000001\n','45000001\r',' 45000001','45000001 ']){
   const error=await rejected(invoke(async()=>({status:429,ok:false,headers:new Map([['X-Api-Status-Code',code]])})));
   assertSafeError(error,{operation,code:'provider_rejected',httpStatus:429});
  }
 });

 test(`${operation} treats a missing supplier status as an unavailable result`,async()=>{
  const error=await rejected(invoke(async()=>new Response('secret-response')));
  assertSafeError(error,{operation,code:'provider_unavailable',httpStatus:200});
 });
}

for(const operation of ['query','flash']){
 test(`${operation} retains safe status fields when the success body is invalid JSON`,async()=>{
  const error=await rejected(operations[operation](async()=>new Response('secret-json fixture-secret-token',{headers:{'X-Api-Status-Code':'20000000'}})));
  assertSafeError(error,{operation,code:'provider_unavailable',httpStatus:200,providerCode:'20000000'});
 });

 test(`${operation} hides an invalid transcript body in a safe provider error`,async()=>{
  const body={result:{utterances:[{start_time:1000,end_time:0,text:'secret-response fixture-secret-token'}]}};
  const error=await rejected(operations[operation](async()=>new Response(JSON.stringify(body),{headers:{'X-Api-Status-Code':'20000000'}})));
  assertSafeError(error,{operation,code:'provider_unavailable',httpStatus:200,providerCode:'20000000'});
 });
}

test('query retries the same request ID after an unavailable response',async()=>{
 const ids=[];
 const fetcher=async(_url,init)=>{ids.push(init.headers['X-Api-Request-Id']);return ids.length===1?new Response('secret-response',{status:500}):new Response(JSON.stringify(successBody),{headers:{'X-Api-Status-Code':'20000000'}});};
 const error=await rejected(provider.queryAsr(config,input.id,fetcher));
 assertSafeError(error,{operation:'query',code:'provider_unavailable',httpStatus:500});
 assert.deepEqual(await provider.queryAsr(config,input.id,fetcher),{status:'complete',segments:[{start:0,end:1,text:'fixture spoken words'}]});
 assert.deepEqual(ids,[input.id,input.id]);
});

test('flash local audio failures omit the local path and do not invoke the supplier',async()=>{
 let calls=0;
 const error=await rejected(provider.recognizeFlashAsr(config,{id:input.id,file:'secret-local-path\u0000'},async()=>{calls++;return new Response('{}');}));
 assertSafeError(error,{operation:'flash',code:'provider_unavailable'});
 assert.equal(calls,0);
});

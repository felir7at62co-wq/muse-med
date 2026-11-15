/** Local correlation, bounded parsing, exact bytes and private-content negative controls. */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import {EventEmitter} from 'node:events';
import {Readable} from 'node:stream';
import {createModelRequestMetadata,observeModelResponseBytes,validatedModelClientId} from './model-request-metadata.mjs';
import {modelSseBytes} from './model-sse.mjs';
import {createDesktopModels} from './desktop-models.mjs';
import {createModelRelay,accountToken} from './model-relay.mjs';

const client='317f3239-1b4d-4c7a-94d2-cbb5a93c69fe';
const deferred=()=>Promise.withResolvers();
const event=value=>'data: '+JSON.stringify(value)+'\n\n';
const frame=event({id:'chatcmpl-raw-id',model:'supplier-model',choices:[{index:0,delta:{reasoning_content:'PRIVATE_REASONING',content:'私人正文🀄'},finish_reason:'length'}],
 usage:{prompt_tokens:100,completion_tokens:20,total_tokens:120,prompt_cache_hit_tokens:70,
  prompt_tokens_details:{cached_tokens:70},completion_tokens_details:{reasoning_tokens:18},private:'PRIVATE_USAGE'}});

function fixture(options={}){
 const records=[],metadata=createModelRequestMetadata({clientId:client,route:'company-route',sink:record=>records.push(record),...options});
 metadata.request('catalog-model');metadata.forwarded({model:'wire-model',bytes:200,stream:true,secret:'PRIVATE_PROVIDER_KEY'});
 return {metadata,records};
}
async function observed(chunks,metadata){
 const source=Readable.from(chunks),out=[];
 source.once('end',()=>metadata.eof());
 for await(const chunk of observeModelResponseBytes(modelSseBytes(source),metadata))out.push(chunk);
 metadata.finish(200);return Buffer.concat(out);
}

test('client UUID validation rejects arrays, repeated values, control characters and arbitrary text',()=>{
 assert.equal(validatedModelClientId(client.toUpperCase()),client);
 for(const value of [undefined,null,42,[client],client+', '+client,'PRIVATE_COOKIE',client+'\n',client.replace('-4c7a-','-0c7a-')])assert.equal(validatedModelClientId(value),null);
 const {metadata,records}=fixture({clientId:'PRIVATE_COOKIE; Bearer PRIVATE_PROVIDER_KEY'});metadata.finish(400);
 assert.equal(records[0].client_request_id_state,'invalid');assert.equal(records[0].client_request_id,null);
 assert.doesNotMatch(JSON.stringify(records),/PRIVATE_/);
});

test('all byte splits retain raw finish reason, cache usage and exact UTF-8 SSE bytes',async()=>{
 const expected=Buffer.from('\ufeff: heartbeat\r\n\r\n'+frame+'data: [DONE]\n\n');
 for(let split=1;split<expected.length;split++){
  const {metadata,records}=fixture();
  assert.deepEqual(await observed([expected.subarray(0,split),expected.subarray(split)],metadata),expected);
  const record=records[0];assert.equal(record.response_id,'chatcmpl-raw-id');assert.equal(record.response_model,'supplier-model');
  assert.deepEqual(record.raw_finish_reasons,[{index:0,value:'length'}]);assert.equal(record.done,true);assert.equal(record.response_bytes,expected.length);
  assert.equal(record.usage.prompt_tokens,100);assert.equal(record.usage.prompt_tokens_details.cached_tokens,70);
  assert.equal(record.usage.completion_tokens_details.reasoning_tokens,18);assert.doesNotMatch(JSON.stringify(record),/PRIVATE_|私人/);
 }
});

test('single-byte CRLF and CR events retain metadata without classifying false DONE markers',async()=>{
 for(const newline of ['\n','\r\n','\r']){
  const bytes=Buffer.from(frame.replaceAll('\n',newline)+'data: [DONE]'+newline+newline),{metadata,records}=fixture();
  const out=await observed(Array.from(bytes,byte=>Buffer.from([byte])),metadata);
  assert.deepEqual(out,bytes.subarray(0,newline==='\r\n'?bytes.length-1:bytes.length));assert.equal(records[0].done,true);
 }
 const bytes=Buffer.from('data:  [DONE]\n\ndata: [DONE]\ndata: another\n\ndata: {"text":"[DONE]"}\n\n');
 const {metadata,records}=fixture();assert.deepEqual(await observed([bytes],metadata),bytes);assert.equal(records[0].done,false);assert.equal(records[0].eof,true);
});

test('oversized or malformed frames cannot change bytes and parsing resumes at the next complete event',async()=>{
 const bytes=Buffer.from('data: '+('PRIVATE_OVERSIZE'.repeat(50000))+'\n\ndata: not-json\n\n'+frame+'data: [DONE]\n\n');
 const {metadata,records}=fixture();assert.deepEqual(await observed([bytes],metadata),bytes);
 assert.equal(records[0].observation_truncated,true);assert.equal(records[0].response_id,'chatcmpl-raw-id');
 assert.ok(JSON.stringify(records).length<2000);assert.doesNotMatch(JSON.stringify(records),/PRIVATE_OVERSIZE/);
});

test('usage and identity fields are bounded and never copy errors, content, keys or cookies',async()=>{
 const {metadata,records}=fixture();
 const choices=Array.from({length:20},(_,index)=>({index,finish_reason:'vendor_reason_'+index,delta:{content:'PRIVATE_CONTENT'}}));
 const bytes=Buffer.from(event({id:'PRIVATE_PROVIDER_KEY',model:'model with PRIVATE_CONTENT',choices,
  usage:{prompt_tokens:-1,completion_tokens:'20',total_tokens:Infinity,private:'PRIVATE_USAGE',prompt_tokens_details:{cached_tokens:7,private:'PRIVATE_COOKIE'}},
  error:{message:'PRIVATE_ERROR'}})+'data: [DONE]\n\n');
 await observed([bytes],metadata);const record=records[0];
 assert.equal(record.response_id,null);assert.equal(record.response_model,null);assert.equal(record.raw_finish_reasons.length,8);
 assert.deepEqual(record.usage,{prompt_tokens_details:{cached_tokens:7}});assert.equal(record.observation_truncated,true);
 assert.doesNotMatch(JSON.stringify(record),/PRIVATE_/);
});

test('nonstream JSON requires observed EOF and ignores oversized bodies while retaining all delivered bytes',async()=>{
 for(const oversized of [false,true]){
  const {metadata,records}=fixture();metadata.forwarded({model:'wire-model',bytes:10,stream:false,secret:'PRIVATE_PROVIDER_KEY'});
  const bytes=Buffer.from(JSON.stringify({id:'json-response',model:'json-model',choices:[{index:0,finish_reason:'stop',message:{content:'PRIVATE_TEXT'.repeat(oversized?10000:1)}}],usage:{total_tokens:4}}));
  const source=Readable.from([bytes]),output=[];source.once('end',()=>metadata.eof());
  for await(const chunk of observeModelResponseBytes(source,metadata))output.push(chunk);
  metadata.finish(200);assert.deepEqual(Buffer.concat(output),bytes);assert.equal(records[0].eof,true);
  assert.equal(records[0].response_id,oversized?null:'json-response');assert.equal(records[0].observation_truncated,oversized);
  assert.doesNotMatch(JSON.stringify(records),/PRIVATE_TEXT/);
 }
});

test('transport error metadata uses allowed codes and a failed sink cannot change forwarding',async()=>{
 const {metadata,records}=fixture();metadata.failed('transport',Object.assign(Error('PRIVATE_EXCEPTION'),{code:'ECONNRESET'}));metadata.failed('request_rejected');metadata.finish(502);metadata.finish(500);
 assert.equal(records.length,1);assert.equal(records[0].error_kind,'transport');assert.equal(records[0].error_code,'ECONNRESET');assert.doesNotMatch(JSON.stringify(records),/PRIVATE_EXCEPTION/);
 const rejecting=createModelRequestMetadata({sink(){throw Error('PRIVATE_SINK');}});rejecting.forwarded({model:'wire-model',bytes:0,stream:true});
 assert.deepEqual(await observed([Buffer.from('data: [DONE]\n\n')],rejecting),Buffer.from('data: [DONE]\n\n'));
});

async function relay(t,mode,respond){
 const records=[],written=[],supplier=http.createServer(async(req,res)=>{const chunks=[];for await(const chunk of req)chunks.push(chunk);written.push(Buffer.concat(chunks));respond(res);});
 const config={baseURL:'https://supplier.test/v1',model:'wire-model',apiKey:'PRIVATE_PROVIDER_KEY',maxTokens:100,reasoningEfforts:false};
 const globalModels={resolve:(route,model)=>route==='company-route'&&model==='catalog-model'?config:undefined};
 const accounts=new EventEmitter(),account='0123456789abcdef',secret='PRIVATE_ACCOUNT_SECRET';accounts.get=()=>({id:account});
 const recorded=deferred(),sink=record=>{records.push(record);recorded.resolve(record);};
 let desktop;const pending=[];
 const server=mode==='cloud'?createModelRelay({globalModels,accounts,secret,metadataSink:sink}):http.createServer((req,res)=>{
  pending.push(desktop.handle(req,res,{id:account,token:'PRIVATE_COOKIE',expiry:Date.now()+60000},'/api/desktop-models/company-route/chat/completions'));
 });
 if(mode==='desktop')desktop=createDesktopModels({globalModels,metadataSink:sink});
 t.after(async()=>{desktop?.close();supplier.closeAllConnections();server.closeAllConnections();await Promise.allSettled(pending);
  await Promise.all([new Promise(resolve=>supplier.close(resolve)),new Promise(resolve=>server.close(resolve))]);});
 await new Promise(resolve=>supplier.listen(0,'127.0.0.1',resolve));
 t.mock.method(https,'request',(url,options,receive)=>{
  assert.equal(url.origin,'https://supplier.test');
  return http.request({...options,hostname:'127.0.0.1',port:supplier.address().port,path:'/',lookup:undefined},receive);
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const path=mode==='cloud'?'/v1/company-route/chat/completions':'/api/desktop-models/company-route/chat/completions';
 const post=(raw,id=client,signal)=>fetch('http://127.0.0.1:'+server.address().port+path,{method:'POST',signal,
  headers:{authorization:'Bearer '+accountToken(secret,account),cookie:'session=PRIVATE_COOKIE','content-type':'application/json','x-muse-client-request-id':id},body:raw});
 return {post,records,written,recorded:recorded.promise};
}

for(const mode of ['cloud','desktop'])test(mode+' ingress and actual serialized bytes correlate with one server HTTP id',async t=>{
 const bytes=Buffer.from(frame+'data: [DONE]\n\n'),f=await relay(t,mode,res=>{res.writeHead(200,{'content-type':'text/event-stream'});res.write(Buffer.concat([bytes,Buffer.from('data: PRIVATE_AFTER_DONE\n\n')]));});
 const raw=JSON.stringify({model:'catalog-model',messages:[{role:'user',content:'PRIVATE_PROMPT🀄'}],stream:true,max_tokens:200},null,2);
 const response=await f.post(raw);assert.deepEqual(Buffer.from(await response.text()),bytes);const record=await f.recorded;
 assert.equal(record.server_request_id,response.headers.get('x-muse-server-request-id'));assert.equal(validatedModelClientId(record.server_request_id),record.server_request_id);
 assert.equal(record.client_request_id,client);assert.equal(record.ingress_bytes,Buffer.byteLength(raw));assert.equal(record.ingress_complete,true);
 assert.equal(record.forward_bytes,f.written[0].length);assert.equal(record.requested_model,'catalog-model');assert.equal(record.forwarded_model,'wire-model');
 assert.equal(record.upstream_status,200);assert.equal(record.client_status,200);assert.equal(record.done,true);assert.equal(record.eof,false);assert.equal(record.error_kind,null);
 assert.equal(JSON.parse(f.written[0]).max_tokens,100);assert.equal(f.written.length,1);assert.doesNotMatch(JSON.stringify(record),/PRIVATE_|🀄|Bearer/);
 const second=await f.post(raw);await second.text();assert.notEqual(second.headers.get('x-muse-server-request-id'),record.server_request_id);
});

for(const mode of ['cloud','desktop'])test(mode+' invalid requests retain no raw id or body and provider errors remain private',async t=>{
 const f=await relay(t,mode,res=>{res.writeHead(429,{'content-type':'application/json'});res.end(JSON.stringify({error:{message:'PRIVATE_PROVIDER_KEY quota exceeded',code:'insufficient_quota'}}));});
 const invalid=await f.post('PRIVATE_INVALID_BODY','PRIVATE_INVALID_ID');assert.equal(invalid.status,400);await invalid.text();
 const bad=await f.recorded;assert.equal(bad.client_request_id,null);assert.equal(bad.client_request_id_state,'invalid');assert.equal(bad.forward_bytes,null);assert.equal(f.written.length,0);
 const response=await f.post(JSON.stringify({model:'catalog-model',messages:[],stream:true}));assert.equal(response.status,429);const text=await response.text();assert.doesNotMatch(text,/PRIVATE_PROVIDER_KEY/);
 // The body completes before the terminal request sink; await the real handler in the fixture's cleanup too.
 const record=f.records.find(item=>item.upstream_status===429);assert.ok(record);assert.equal(record.error_kind,'upstream_http');assert.equal(record.client_status,429);
 assert.doesNotMatch(JSON.stringify(f.records),/PRIVATE_|Bearer/);assert.equal(f.written.length,1);
});

test('a supplier UUID key is never recorded when reused as the valid client correlation id',async()=>{
 const {metadata,records}=fixture();metadata.forwarded({model:'wire-model',bytes:10,stream:true,secret:client});
 await observed([Buffer.from(event({id:client,model:'reflected-'+client,choices:[{index:0,finish_reason:'reason-'+client}]})+'data: [DONE]\n\n')],metadata);
 assert.equal(records[0].client_request_id,null);assert.doesNotMatch(JSON.stringify(records),new RegExp(client));
});

for(const mode of ['cloud','desktop'])test(mode+' authentication tokens reflected in allowed identity fields remain private',async t=>{
 const reflected=mode==='cloud'?accountToken('PRIVATE_ACCOUNT_SECRET','0123456789abcdef'):'PRIVATE_COOKIE';
 const f=await relay(t,mode,res=>{res.writeHead(200,{'content-type':'text/event-stream'});res.end(event({id:reflected,model:'reflected-'+reflected})+'data: [DONE]\n\n');});
 const response=await f.post(JSON.stringify({model:'catalog-model',messages:[],stream:true}));await response.text();const record=await f.recorded;
 assert.equal(record.response_id,null);assert.equal(record.response_model,null);assert.doesNotMatch(JSON.stringify(record),new RegExp(reflected.replaceAll('.','\\.')));
});

for(const mode of ['cloud','desktop'])test(mode+' ordinary upstream EOF remains successful without inventing DONE',async t=>{
 const bytes=Buffer.from(frame),f=await relay(t,mode,res=>{res.writeHead(200,{'content-type':'text/event-stream'});res.end(bytes);});
 const response=await f.post(JSON.stringify({model:'catalog-model',messages:[],stream:true}));assert.deepEqual(Buffer.from(await response.text()),bytes);
 const record=await f.recorded;assert.equal(record.done,false);assert.equal(record.eof,true);assert.equal(record.error_kind,null);
 assert.deepEqual(record.raw_finish_reasons,[{index:0,value:'length'}]);
});

for(const mode of ['cloud','desktop'])test(mode+' cancelled streaming retains partial metadata and terminates without a replay',async t=>{
 const upstreamClosed=deferred(),f=await relay(t,mode,res=>{res.once('close',upstreamClosed.resolve);res.writeHead(200,{'content-type':'text/event-stream'});res.write(frame);});
 const controller=new AbortController(),response=await f.post(JSON.stringify({model:'catalog-model',messages:[],stream:true}),client,controller.signal);
 const reader=response.body.getReader();assert.equal((await reader.read()).done,false);controller.abort();
 await assert.rejects(reader.read());await upstreamClosed.promise;const record=await f.recorded;
 assert.equal(record.done,false);assert.equal(record.eof,false);assert.equal(record.error_kind,'cancelled');assert.equal(record.client_status,200);
 assert.equal(f.written.length,1);assert.doesNotMatch(JSON.stringify(record),/PRIVATE_|私人/);
});

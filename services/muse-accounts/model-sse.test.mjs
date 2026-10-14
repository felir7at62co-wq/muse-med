import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import http from 'node:http';
import https from 'node:https';
import {Readable,Writable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {modelSseBytes} from './model-sse.mjs';
import {createModelRelay,accountToken} from './model-relay.mjs';
import {createDesktopModels} from './desktop-models.mjs';
import {createModelKeyPool} from './model-key-pool.mjs';

const deferred=()=>Promise.withResolvers();
const event=value=>'data: '+JSON.stringify(value)+'\n\n';
const text=event({choices:[{index:0,delta:{content:'你好'},finish_reason:null}]});
const finish=event({choices:[{index:0,delta:{},finish_reason:'stop'}]});
const usage=event({choices:[],usage:{prompt_tokens:10,completion_tokens:2,total_tokens:12}});
const done='data: [DONE]\n\n';

async function collect(chunks){
 const source=Readable.from(chunks),output=[];
 for await(const chunk of modelSseBytes(source))output.push(chunk);
 assert.equal(source.closed,true);
 return Buffer.concat(output);
}

test('SSE preserves UTF-8 payload and trailing usage through DONE, excluding bytes after it',async()=>{
 const expected=Buffer.from(text+finish+usage+done);
 assert.deepEqual(await collect([Buffer.concat([expected,Buffer.from('data: ignored\n\n')])]),expected);
});

test('fragmented SSE recognizes LF, CRLF and CR delimiters and optional data-field spacing',async()=>{
 for(const newline of ['\n','\r\n','\r'])for(const spacing of [' ','']){
  const prefix='\ufeff: heartbeat'+newline+newline+text.replaceAll('\n',newline);
  const terminal='data:'+spacing+'[DONE]'+newline+newline,expected=Buffer.from(prefix+terminal);
  for(let split=1;split<expected.length;split++){
   const chunks=[expected.subarray(0,split),expected.subarray(split)];
   // A CR is independently complete; an LF not received yet is optional SSE whitespace.
   const length=newline==='\r\n'&&split===expected.length-1?expected.length-1:expected.length;
   assert.deepEqual(await collect(chunks),expected.subarray(0,length));
  }
  const bytes=Array.from(expected,byte=>Buffer.from([byte]));
  assert.deepEqual(await collect(bytes),expected.subarray(0,newline==='\r\n'?expected.length-1:expected.length));
 }
});

test('false markers, multi-line data and incomplete events remain unchanged until EOF',async()=>{
 const fixture=Buffer.from(': data: [DONE]\n\nevent: [DONE]\n\nid: [DONE]\n\n'
  +'data: {"text":"[DONE]"}\n\ndata: [DONE] trailing\n\ndata:  [DONE]\n\n'
  +'data: [DONE]\ndata: another line\n\ndata:\ndata: [DONE]\n\n'
  +'Data: [DONE]\n\ndata: '+('x'.repeat(1024*1024))+'\n\n'
  +'data: [DONE]\n');
 assert.deepEqual(await collect([fixture]),fixture);
});

test('tool-call finishes and independently finishing choices retain later arguments and usage',async()=>{
 const fixture=Buffer.from(event({choices:[{index:0,delta:{tool_calls:[{index:0,id:'call',type:'function',function:{name:'lookup',arguments:'{"q":'}}]},finish_reason:null}]})
  +event({choices:[{index:0,delta:{tool_calls:[{index:0,function:{arguments:'"hello"}'}}]},finish_reason:'tool_calls'},{index:1,delta:{content:'second'},finish_reason:null}]})
  +event({choices:[{index:1,delta:{content:' choice'},finish_reason:'stop'}]})+usage+done);
 assert.deepEqual(await collect(Array.from(fixture,byte=>Buffer.from([byte]))),fixture);
});

test('SSE iterator awaits asynchronous upstream destruction before delivering DONE',async()=>{
 const destroying=deferred(),release=deferred();let requested=false;
 const source=new Readable({read(){if(!requested){requested=true;this.push(Buffer.from(done));}},
  destroy(error,callback){destroying.resolve();release.promise.then(()=>callback(error));}});
 const iterator=modelSseBytes(source);let delivered=false;
 const pending=iterator.next().then(value=>{delivered=true;return value;});
 await destroying.promise;assert.equal(delivered,false);assert.equal(source.closed,false);
 release.resolve();assert.deepEqual((await pending).value,Buffer.from(done));assert.equal(source.closed,true);
 assert.equal((await iterator.next()).done,true);
});

test('SSE relay respects writable backpressure and cancellation closes the owned input',async()=>{
 let produced=0;const blocked=deferred(),release=deferred();
 const source=Readable.from((function*(){for(let index=0;index<100;index++){produced++;yield Buffer.alloc(1024,120);}})(),{objectMode:false,highWaterMark:1});
 const sink=new Writable({highWaterMark:1,write(_chunk,_encoding,callback){blocked.resolve();release.promise.then(()=>callback());}});
 const pumping=pipeline(modelSseBytes(source),sink);
 await blocked.promise;assert.ok(produced<=3,'input must not run ahead of a blocked writable');
 release.resolve();await pumping;assert.equal(source.closed,true);
 const held=new Readable({read(){this.push(Buffer.from(text));}}),iterator=modelSseBytes(held);
 await iterator.next();await iterator.return();assert.equal(held.closed,true);
});

async function relayFixture(t,mode,respond){
 const supplier=http.createServer((req,res)=>{req.resume();respond(res);});
 const requests=[],responses=[],pending=[],releases=[];let calls=0;
 const queued=deferred(),keys=['synthetic-key'],config={model:'fixture-model',baseURL:'https://supplier.test/v1',apiKey:keys[0],maxTokens:100};
 const pool=createModelKeyPool({keys:()=>keys,concurrency:1,maxQueued:2,waitMs:30000});
 const shared={...pool,async acquire(signal){
  if(++calls===2)queued.resolve();
  const lease=await pool.acquire(signal);
  return {key:lease.key,release(){releases.push(requests.every(request=>request.closed)&&responses.every(response=>response.closed));lease.release();}};
 }};
 const globalModels={resolve:()=>config,credentialPool:()=>keys};
 const id='0123456789abcdef',secret='synthetic-secret',accounts=new EventEmitter();accounts.get=()=>({id});
 let desktop;
 const relay=mode==='desktop'?http.createServer((req,res)=>{
  const handling=desktop.handle(req,res,{id,token:'synthetic-session',expiry:Date.now()+60000},'/api/desktop-models/zhipu-official/chat/completions');
  pending.push(handling);
 }):createModelRelay({accounts,secret,globalModels,keyPool:shared});
 if(mode==='desktop')desktop=createDesktopModels({globalModels,keyPool:shared});
 t.after(async()=>{
  desktop?.close();pool.close();supplier.closeAllConnections();relay.closeAllConnections();
  await Promise.allSettled(pending);
  await Promise.all([new Promise(resolve=>supplier.close(resolve)),new Promise(resolve=>relay.close(resolve))]);
 });
 await new Promise(resolve=>supplier.listen(0,'127.0.0.1',resolve));
 // The real forwarding path remains in use; only external HTTPS is redirected to loopback.
 t.mock.method(https,'request',(url,options,receive)=>{
  assert.equal(url.origin,'https://supplier.test');
  const request=http.request({...options,hostname:'127.0.0.1',port:supplier.address().port,path:'/',lookup:undefined},response=>{
   responses.push(response);receive(response);
  });requests.push(request);return request;
 });
 await new Promise(resolve=>relay.listen(0,'127.0.0.1',resolve));
 const post=(body={},signal)=>{
  const task=fetch('http://127.0.0.1:'+relay.address().port+'/v1/zhipu-official/chat/completions',{
   method:'POST',signal,headers:{authorization:'Bearer '+accountToken(secret,id),'content-type':'application/json'},
   body:JSON.stringify({model:config.model,messages:[],stream:true,...body}),
  });pending.push(task);return task;
 };
 return {post,pool,queued:queued.promise,requests,responses,releases,pending};
}

for(const mode of ['cloud','desktop'])test(mode+' DONE without HTTP EOF closes upstream and admits the next queued request',{timeout:10000},async t=>{
 const first=deferred(),firstClosed=deferred();let calls=0;
 const fixture=await relayFixture(t,mode,res=>{
  calls++;res.writeHead(200,{'content-type':'text/event-stream'});
  if(calls===1){res.once('close',firstClosed.resolve);res.write(text+finish);first.resolve(res);}
  else res.end(text+done);
 });
 const one=await fixture.post(),reading=one.text();fixture.pending.push(reading);
 assert.match(one.headers.get('server-timing'),/^gateway-queue;dur=\d+\.\d, upstream-headers;dur=\d+\.\d$/);
 assert.doesNotMatch(one.headers.get('server-timing'),/synthetic|fixture|supplier|Bearer|你好/);
 const second=fixture.post();await fixture.queued;
 assert.equal(calls,1);
 (await first.promise).write(usage+done+'data: ignored\n\n');
 assert.equal(await reading,text+finish+usage+done);
 await firstClosed.promise;
 assert.equal(await (await second).text(),text+done);
 assert.equal(calls,2);assert.equal(fixture.responses[0].closed,true);
 const free=await fixture.pool.acquire();free.release();
 assert.deepEqual(fixture.releases,[true,true]);
});

test('client cancellation closes a stalled upstream and releases the slot without replay',{timeout:10000},async t=>{
 const closed=deferred();let calls=0;
 const fixture=await relayFixture(t,'desktop',res=>{
  calls++;res.writeHead(200,{'content-type':'text/event-stream'});res.write(text);
  if(calls===1)res.once('close',closed.resolve);else res.end(done);
 });
 const controller=new AbortController(),response=await fixture.post({},controller.signal);
 const reading=response.text();fixture.pending.push(reading);const rejected=assert.rejects(reading);
 const second=fixture.post();await fixture.queued;controller.abort();await rejected;await closed.promise;
 assert.equal(await (await second).text(),text+done);assert.equal(calls,2);
 const free=await fixture.pool.acquire();free.release();assert.deepEqual(fixture.releases,[true,true]);
});

test('nonstream JSON containing a DONE-looking string waits for and retains its complete body',{timeout:10000},async t=>{
 const first=deferred();
 const fixture=await relayFixture(t,'cloud',res=>{res.writeHead(200,{'content-type':'application/json'});res.write('{"text":"data: [DONE]\\n\\n');first.resolve(res);});
 const response=await fixture.post({stream:false}),reading=response.text();fixture.pending.push(reading);
 assert.equal(response.headers.get('content-type'),'application/json');
 (await first.promise).end(' retained"}');
 assert.equal(await reading,'{"text":"data: [DONE]\\n\\n retained"}');
});

test('upstream failure after headers rejects forwarding and closes its request',{timeout:10000},async t=>{
 const upstream=deferred();
 const fixture=await relayFixture(t,'cloud',res=>{res.writeHead(200,{'content-type':'text/event-stream'});res.write(text);upstream.resolve(res);});
 const response=await fixture.post(),reader=response.body.getReader();
 assert.equal(new TextDecoder().decode((await reader.read()).value),text);
 const reading=reader.read();fixture.pending.push(reading);const rejected=assert.rejects(reading);
 (await upstream.promise).destroy();await rejected;
 const free=await fixture.pool.acquire();free.release();assert.equal(fixture.requests[0].closed,true);
});

test('a non-SSE streaming response closes its unfinished body and returns a safe failure',{timeout:10000},async t=>{
 const closed=deferred();
 const fixture=await relayFixture(t,'desktop',res=>{
  res.once('close',closed.resolve);res.writeHead(200,{'content-type':'application/json'});res.write('{"private":"synthetic-key"}');
 });
 const response=await fixture.post();assert.equal(response.status,502);
 assert.doesNotMatch(await response.text(),/synthetic-key/);await closed.promise;
 const free=await fixture.pool.acquire();free.release();assert.deepEqual(fixture.releases,[true]);
});

test('provider refusals retain safe classification and retry-after without logging private bytes',{timeout:10000},async t=>{
 const logs=[];t.mock.method(console,'error',(...values)=>logs.push(values.join(' ')));
 const fixture=await relayFixture(t,'desktop',res=>{
  res.writeHead(429,{'content-type':'application/json','retry-after':'2'});
  res.end('{"error":{"code":"insufficient_quota","message":"synthetic-key private payload"}}');
 });
 const response=await fixture.post();assert.equal(response.status,429);assert.equal(response.headers.get('retry-after'),'2');
 assert.equal((await response.json()).error.code,'insufficient_quota');assert.doesNotMatch(logs.join('\n'),/synthetic-key|private payload/);
 const free=await fixture.pool.acquire();free.release();assert.deepEqual(fixture.releases,[true]);
});

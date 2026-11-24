import test from 'node:test';
import assert from 'node:assert/strict';
import {PassThrough} from 'node:stream';
import {EventEmitter} from 'node:events';
import {createWebSearch,resolveWebSearchPolicy} from './web-search.mjs';

function deferred(){let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};}
function response(stream,reading){return {status:200,headers:new Headers({'content-type':'application/json'}),body:{getReader(){const reader=stream.getReader();reading.resolve();return reader;},cancel:reason=>stream.cancel(reason)}};}
async function bounded(promise){let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Shutdown retained a pending search body')),1000);})]);}finally{clearTimeout(timer);}}
function request(service){const req=new PassThrough();req.method='POST';req.headers={'content-type':'application/json'};const res=new EventEmitter();res.writeHead=status=>{res.statusCode=status;};res.end=value=>{res.body=JSON.parse(value);res.writableEnded=true;};const task=service.handle(req,res,{id:'user',token:'token',expiry:Date.now()+60000});req.end(JSON.stringify({query:'a'}));return {req,res,task};}

test('closing cancels a body reader even when its underlying cancel promise never settles',async()=>{
 const reading=deferred();let cancellations=0;
 const stream=new ReadableStream({cancel(){cancellations++;return new Promise(()=>{});}});
 const service=createWebSearch({globalModels:{searchCredential:()=>({credentialClass:'deepseekOfficial',baseURL:'https://api.deepseek.com',apiKey:'fixture'})},fetcher:async()=>response(stream,reading)});
 const active=request(service);await reading.promise;await bounded(service.close());await active.task;
 assert.equal(cancellations,1);assert.equal(stream.locked,false);assert.equal(active.res.statusCode,503);assert.equal(active.res.body.error_code,'web_search_unavailable');
 await bounded(service.close());
});

test('revocation and deadline cancellation settle body reads without returning partial results',async()=>{
 for(const mode of ['revoke','timeout']){
  const reading=deferred();let cancellations=0;
  const service=createWebSearch({policy:resolveWebSearchPolicy({MUSE_WEB_SEARCH_TIMEOUT_MS:mode==='timeout'?20:1000}),globalModels:{searchCredential:()=>({credentialClass:'deepseekOfficial',baseURL:'https://api.deepseek.com',apiKey:'fixture'})},fetcher:async()=>response(new ReadableStream({cancel(){cancellations++;return new Promise(()=>{});}}),reading)});
  const active=request(service);await reading.promise;if(mode==='revoke')service.revoke('token');await bounded(active.task);
  assert.equal(active.res.statusCode,mode==='revoke'?401:504);assert.equal(cancellations,1);await bounded(service.close());
 }
});

test('invalid-response cancellation cannot keep the request or shutdown pending',async()=>{
 let cancellations=0;
 const service=createWebSearch({globalModels:{searchCredential:()=>({credentialClass:'deepseekOfficial',baseURL:'https://api.deepseek.com',apiKey:'fixture'})},fetcher:async()=>new Response(new ReadableStream({cancel(){cancellations++;return new Promise(()=>{});}}),{status:503,headers:{'content-type':'application/json'}})});
 const active=request(service);await bounded(active.task);await bounded(service.close());assert.equal(active.res.statusCode,502);assert.equal(cancellations,1);
});

test('closing rejects a pending fetch and cancels any response that arrives afterwards',async()=>{
 const entered=deferred(),reply=deferred(),cancelled=deferred();let signal;
 const service=createWebSearch({globalModels:{searchCredential:()=>({credentialClass:'deepseekOfficial',baseURL:'https://api.deepseek.com',apiKey:'fixture'})},fetcher:(_url,options)=>{signal=options.signal;entered.resolve();return reply.promise;}});
 const active=request(service);await entered.promise;await bounded(service.close());await active.task;
 assert.equal(signal.aborted,true);assert.equal(active.res.statusCode,503);
 reply.resolve(new Response(new ReadableStream({cancel(){cancelled.resolve();}}),{headers:{'content-type':'application/json'}}));await bounded(cancelled.promise);
});

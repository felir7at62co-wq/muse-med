import {test} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {probeModel,probeTask} from './verify-models-live.mjs';
import {stream} from '../../packages/llm/llm-pi-ai/node_modules/@earendil-works/pi-ai/dist/api/openai-completions.js';

test('catalog probe CLI requires opt-in and resolves the installed client runtime',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'muse-model-probe-'));t.after(()=>rm(dir,{recursive:true,force:true}));const file=join(dir,'models.json');
 await writeFile(file,JSON.stringify({providers:{studio:{baseURL:'https://provider.example/v1',apiKeyEnv:'MISSING_KEY',models:[{id:'writer',reasoningEfforts:false}]}},credentials:{unrelated:'private-secret'}}));
 const script=fileURLToPath(new URL('./verify-models-live.mjs',import.meta.url)),exec=promisify(execFile);
 const dry=await exec(process.execPath,[script,file],{timeout:10000});assert.equal(JSON.parse(dry.stdout).requires,'--run');assert.equal(JSON.parse(dry.stdout).toolChoice,'auto');assert.doesNotMatch(dry.stdout,/private-secret/);
 const forced=await exec(process.execPath,[script,file,'--tool-choice=forced'],{timeout:10000});assert.equal(JSON.parse(forced.stdout).toolChoice,'forced');
 await assert.rejects(exec(process.execPath,[script,file,'--tool-choice=invalid'],{timeout:10000}),error=>{assert.equal(error.code,1);assert.match(error.stderr,/probe_setup_failed/);return true;});
 await assert.rejects(exec(process.execPath,[script,file,'--run'],{timeout:10000}),error=>{assert.equal(error.code,1);assert.match(error.stdout,/missing_credential/);assert.doesNotMatch(error.stdout,/private-secret|probe_setup_failed/);return true;});
});

test('catalog probes retain family-specific thinking and preserve real pi-ai tool history',async t=>{
 const requests=[];let requestIndex=0;
 const server=http.createServer(async(req,res)=>{
  const chunks=[];for await(const chunk of req)chunks.push(chunk);requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
  const first=requestIndex++%2===0;
  const events=first?[
   {choices:[{index:0,delta:{reasoning_content:'saved private reasoning'},finish_reason:null}]},
   {choices:[{index:0,delta:{tool_calls:[{index:0,id:'probe-call',type:'function',function:{name:'muse_echo',arguments:'{"text":"MUSE_MODEL_OK"}'}}]},finish_reason:null}]},
   {choices:[{index:0,delta:{},finish_reason:'tool_calls'}]},
  ]:[{choices:[{index:0,delta:{content:'MUSE_MODEL_OK'},finish_reason:null}]},{choices:[{index:0,delta:{},finish_reason:'stop'}],usage:{prompt_tokens:4,completion_tokens:2,total_tokens:6,balance:'private-balance',cost:'private-cost'}}];
  res.writeHead(200,{'content-type':'text/event-stream'});res.end(events.map(event=>'data: '+JSON.stringify(event)+'\n\n').join('')+'data: [DONE]\n\n');
 });
 t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const publicSettings={baseURL:'https://provider.example/v1'};
 for(const [route,id] of [['yunying','glm-5.3-flash'],['zhipu-official','glm-5.3-flashx'],['zhipu-official','glm-5.3-flash'],
  ...['gemini-3.8-flash','claude-sonnet-5-5','grok-4.7','qwen3.8-max','MiniMax-m3','doubao-seed-2-pro','kimi-k3'].map(id=>['yunying',id])]){
  const model=probeModel(route,publicSettings,{id,contextWindow:200000,maxTokens:8192,reasoningEfforts:false});model.baseUrl='http://127.0.0.1:'+server.address().port+'/v1';
  const outcomes=[];assert.equal(await probeTask({route,key:'synthetic-key',model},stream,value=>outcomes.push(value)),true);
  const [first,second]=requests.slice(-2);assert.equal(first.max_tokens,32768);assert.equal(second.max_tokens,32768);assert.equal(second.messages.find(message=>message.role==='assistant').reasoning_content,'saved private reasoning');
  assert.equal(Object.hasOwn(first,'tool_choice'),false);assert.equal(Object.hasOwn(second,'tool_choice'),false);
  if(id.startsWith('glm-5.3-')){assert.deepEqual(first.thinking,{type:'enabled',clear_thinking:false});assert.equal(first.reasoning_effort,'low');}
  else{assert.equal(first.thinking,undefined);assert.equal(first.reasoning_effort,undefined);}
  assert.doesNotMatch(JSON.stringify(outcomes),/synthetic-key|private reasoning|private-balance|private-cost/);assert.deepEqual(outcomes[1].tokens,{input:4,output:2,cacheRead:0,cacheWrite:0,totalTokens:6});
 }
 const forced=probeModel('studio',publicSettings,{id:'writer',reasoningEfforts:false});forced.baseUrl='http://127.0.0.1:'+server.address().port+'/v1';
 assert.equal(await probeTask({route:'studio',key:'synthetic-key',model:forced,toolChoice:'forced'},stream,()=>{}),true);
 assert.deepEqual(requests.at(-2).tool_choice,{type:'function',function:{name:'muse_echo'}});assert.equal(requests.at(-1).tool_choice,'none');
});

test('catalog probe failures expose a fixed classification and skip an invalid continuation',async t=>{
 let requests=0;
 const server=http.createServer((req,res)=>{requests++;req.resume();res.writeHead(429,{'content-type':'application/json'});res.end(JSON.stringify({error:{code:'insufficient_quota',message:'synthetic-private-key private balance'}}));});
 t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const model=probeModel('studio',{baseURL:'https://provider.example/v1'},{id:'writer',reasoningEfforts:false});model.baseUrl='http://127.0.0.1:'+server.address().port+'/v1';const outcomes=[];
 assert.equal(await probeTask({route:'studio',key:'synthetic-private-key',model},stream,value=>outcomes.push(value)),false);assert.equal(requests,1);assert.equal(outcomes[0].status,429);assert.equal(outcomes[0].code,'insufficient_quota');assert.doesNotMatch(JSON.stringify(outcomes),/synthetic-private-key|private balance/);
 assert.equal(outcomes[0].tokens,null);assert.equal(outcomes[1].code,'missing_tool_call');
});

test('stream failures and rejected tool arguments expose fixed outcomes without provider text',async t=>{
 let attempt=0;
 const server=http.createServer((req,res)=>{
  req.resume();const choices=attempt++===0?{delta:{},finish_reason:'content_filter'}:
   {delta:{tool_calls:[{index:0,id:'probe-call',type:'function',function:{name:'muse_echo',arguments:'{"text":"private diagnostic"}'}}]},finish_reason:'tool_calls'};
  res.writeHead(200,{'content-type':'text/event-stream'});res.end('data: '+JSON.stringify({choices:[{index:0,...choices}]})+'\n\ndata: [DONE]\n\n');
 });
 t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const model=probeModel('studio',{baseURL:'https://provider.example/v1'},{id:'writer',reasoningEfforts:false});model.baseUrl='http://127.0.0.1:'+server.address().port+'/v1';
 const outcomes=[];const task={route:'studio',key:'synthetic-private-key',model};
 assert.equal(await probeTask(task,stream,value=>outcomes.push(value)),false);assert.equal(outcomes[0].code,'content_filter');
 assert.equal(await probeTask(task,stream,value=>outcomes.push(value)),false);assert.equal(outcomes.at(-1).code,'unexpected_tool_arguments');
 assert.doesNotMatch(JSON.stringify(outcomes),/synthetic-private-key|private diagnostic/);assert.equal(attempt,2);
});

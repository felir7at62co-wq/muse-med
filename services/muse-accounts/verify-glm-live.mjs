/** Bounded, opt-in provider smoke using existing server credentials without printing them. */
import {readFile} from 'node:fs/promises';
import {completionEndpoint} from './model-relay.mjs';

const file=process.argv[2]||'/var/lib/muse/accounts/global-model.json.native';
const directory=JSON.parse(await readFile(file,'utf8'));
const provider=directory.providers?.yunying;
const model=provider?.models?.find(model=>model.id==='glm-5.3-flash');
const key=directory.credentials?.[provider?.apiKeyEnv];
if(!model||!key)throw Error('Configured GLM-5.3 Flash route is unavailable');
const endpoint=completionEndpoint(provider.baseURL);
const common={model:model.id,max_tokens:32768,reasoning_effort:'low',thinking:{type:'enabled',clear_thinking:false}};

function tokenUsage(usage){
 if(!usage||typeof usage!=='object')return undefined;
 return Object.fromEntries(['prompt_tokens','completion_tokens','total_tokens'].filter(key=>Number.isSafeInteger(usage[key])&&usage[key]>=0).map(key=>[key,usage[key]]));
}

async function request(label,body){
 const response=await fetch(endpoint,{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+key},body:JSON.stringify({...common,...body}),signal:AbortSignal.timeout(180000)});
 const source=await response.text();
 if(!response.ok){let code;try{const parsed=JSON.parse(source);code=parsed.error?.code??parsed.code;}catch(error){/* Malformed refusals remain unclassified. */}console.log(JSON.stringify({label,status:response.status,code:['insufficient_quota','rate_limit_exceeded','invalid_request_error','context_length_exceeded'].includes(code)?code:'unclassified',accepted:false}));throw Error('Provider smoke request was rejected');}
 if(!body.stream){
  const data=JSON.parse(source),choice=data.choices?.[0];
  if(!choice?.message||choice.finish_reason!=='stop')throw Error('Incomplete non-stream completion');
  console.log(JSON.stringify({label,status:response.status,finish:choice.finish_reason,usage:tokenUsage(data.usage),answerValid:choice.message.content?.trim()==='MUSE_GLM_OK'}));
  if(choice.message.content?.trim()!=='MUSE_GLM_OK')throw Error('Unexpected non-stream answer');
  return choice.message;
 }
 if(!response.headers.get('content-type')?.includes('text/event-stream'))throw Error('Streaming response was not SSE');
 const message={role:'assistant',content:'',reasoning_content:'',tool_calls:[]};let finish,usage,done=false;
 for(const frame of source.split(/\r?\n\r?\n/)){
  const data=frame.split(/\r?\n/).filter(line=>line.startsWith('data:')).map(line=>line.slice(5).trim()).join('\n');
  if(!data)continue;if(data==='[DONE]'){done=true;continue;}
  const event=JSON.parse(data);if(event.error)throw Error('Provider returned an in-band stream failure');
  if(event.usage)usage=event.usage;
  const choice=event.choices?.[0];if(!choice)continue;
  if(choice.finish_reason)finish=choice.finish_reason;
  const delta=choice.delta??{};
  if(typeof delta.content==='string')message.content+=delta.content;
  if(typeof delta.reasoning_content==='string')message.reasoning_content+=delta.reasoning_content;
  for(const fragment of delta.tool_calls??[]){
   const i=fragment.index??0,call=message.tool_calls[i]??={id:'',type:'function',function:{name:'',arguments:''}};
   if(fragment.id)call.id=fragment.id;
   if(fragment.function?.name)call.function.name+=fragment.function.name;
   if(fragment.function?.arguments)call.function.arguments+=fragment.function.arguments;
  }
 }
 if(!done||!finish)throw Error('SSE closed without a complete terminal event');
 console.log(JSON.stringify({label,status:response.status,finish,done,usage:tokenUsage(usage),textChars:message.content.length,reasoningChars:message.reasoning_content.length,toolCalls:message.tool_calls.length}));
 return {message,finish};
}

await request('short-answer',{messages:[{role:'user',content:'Reply with exactly MUSE_GLM_OK. No other text.'}],stream:false});
const messages=[{role:'user',content:'Call muse_echo with text MUSE_TOOL_OK, then reply with exactly the returned text. Do not add any other text.'}];
const tools=[{type:'function',function:{name:'muse_echo',description:'Echo the supplied text',parameters:{type:'object',properties:{text:{type:'string'}},required:['text'],additionalProperties:false}}}];
const first=await request('tool-call',{messages,tools,tool_choice:{type:'function',function:{name:'muse_echo'}},stream:true,stream_options:{include_usage:true}});
const call=first.message.tool_calls[0];
if(first.finish!=='tool_calls'||first.message.tool_calls.length!==1||!call?.id||call.function.name!=='muse_echo'||JSON.parse(call.function.arguments).text!=='MUSE_TOOL_OK')throw Error('Tool call was incomplete or invalid');
const second=await request('tool-continuation',{messages:[...messages,first.message,{role:'tool',tool_call_id:call.id,content:'MUSE_TOOL_OK'}],tools,tool_choice:'none',stream:true,stream_options:{include_usage:true}});
if(second.finish!=='stop'||second.message.content.trim()!=='MUSE_TOOL_OK'||second.message.tool_calls.length)throw Error('Tool continuation was incomplete');
console.log(JSON.stringify({verified:true,model:model.id,requestedMaxTokens:32768,reasoningEffort:'low',preservedReasoning:true,requests:3}));

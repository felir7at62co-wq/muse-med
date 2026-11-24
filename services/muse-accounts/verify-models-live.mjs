/** Opt-in catalog probes use Muse's pi-ai serializer and never print private diagnostics. */
import {readFile,access} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {completionEndpoint} from './model-relay.mjs';
import {modelFailure} from './model-errors.mjs';

const marker='MUSE_MODEL_OK';
const tools=[{name:'muse_echo',description:'Return the supplied text.',parameters:{type:'object',properties:{text:{type:'string'}},required:['text'],additionalProperties:false}}];
const initial=[{role:'system',content:'Use the supplied tool and return only its result.',toolsAdded:tools},
 {role:'user',content:[{type:'text',text:'Call muse_echo with text MUSE_MODEL_OK. Then reply with exactly the returned text and nothing else.'}],timestamp:0}];

function streamFailure(message){
 if(typeof message!=='string')return 'unclassified';
 if(message.includes('Provider finish_reason: content_filter'))return 'content_filter';
 if(message.includes('Provider finish_reason: network_error'))return 'provider_network_error';
 const code=modelFailure(400,JSON.stringify({error:{message}})).error.code;
 return code==='invalid_request_error'?'unclassified':code;
}

/** Build the same Chat Completions model compatibility used by Muse account models.
 * @param {string} route Directory provider ID.
 * @param {object} provider Directory provider settings.
 * @param {object} entry Directory model settings.
 * @returns {object} pi-ai model; this probe requests 32,768 tokens without changing the directory.
 */
export function probeModel(route,provider,entry){
 const glm=/^glm-5\.3(?:-|$)/i.test(entry.id.split('/').at(-1));
 const endpoint=completionEndpoint(provider.baseURL);endpoint.pathname=endpoint.pathname.replace(/\/chat\/completions$/,'');
 const efforts=glm?{low:'low'}:entry.reasoningEfforts;
 return {id:entry.id,name:entry.name||entry.id,api:'openai-completions',provider:'muse-cloud-'+route,baseUrl:endpoint.href.replace(/\/$/,''),
  reasoning:!!efforts&&efforts!==false,input:entry.input??['text'],contextWindow:entry.contextWindow??128000,maxTokens:32768,
  cost:{input:0,output:0,cacheRead:0,cacheWrite:0},
  ...(efforts&&efforts!==false?{thinkingLevelMap:Object.fromEntries(['off','minimal','low','medium','high','xhigh','max'].map(level=>[level,efforts[level]??null]))}:{}),
  compat:{supportsStore:false,supportsDeveloperRole:false,maxTokensField:'max_tokens',supportsReasoningEffort:!!efforts&&efforts!==false,
   ...(glm?{thinkingFormat:'deepseek',requiresReasoningContentOnAssistantMessages:true}:{})}};
}

/** Project token counts and fixed outcomes from a single model's two bounded requests.
 * @param {object} task Public route/model identity, private key, pi-ai model, and optional forced tool choice.
 * @param {Function} stream pi-ai's OpenAI Chat Completions stream function.
 * @param {Function} report Receives only safe outcome objects.
 * @returns {Promise<boolean>} Whether a complete tool call and marker continuation passed.
 */
export async function probeTask(task,stream,report){
 const glm=/^glm-5\.3(?:-|$)/i.test(task.model.id.split('/').at(-1));
 async function request(stage,messages,toolChoice){
  const signal=AbortSignal.timeout(45000);let status=null,failure;
  const options={apiKey:task.key,maxTokens:32768,maxRetries:0,timeoutMs:45000,signal,toolChoice,
   ...(glm?{reasoningEffort:'low'}:{}),
   onPayload:payload=>{if(glm){payload.thinking={type:'enabled',clear_thinking:false};payload.reasoning_effort='low';}return payload;},
   fetch:async(input,init)=>{
    const response=await fetch(input,init);status=response.status;
    if(response.ok)return response;
    const chunks=[];let bytes=0;
    for await(const chunk of response.body??[]){bytes+=chunk.length;if(bytes>65536){chunks.length=0;break;}chunks.push(Buffer.from(chunk));}
    const safe=modelFailure(response.status,Buffer.concat(chunks).toString('utf8'));failure=safe.error.code;
    return new Response(JSON.stringify(safe),{status:response.status,headers:{'content-type':'application/json'}});
   }};
  try{
   const events=stream(task.model,{messages},options);for await(const event of events){/* The final message owns the provider replay metadata. */}
   const result=await events.result(),finish=['stop','length','toolUse','error','aborted'].includes(result.stopReason)?result.stopReason:'unclassified';
   const text=result.content.filter(block=>block.type==='text').map(block=>block.text).join('');
   const counts=Object.fromEntries(['input','output','cacheRead','cacheWrite','totalTokens'].filter(key=>Number.isSafeInteger(result.usage?.[key])&&result.usage[key]>=0).map(key=>[key,result.usage[key]]));
   const code=signal.aborted?'timeout':failure??(['error','aborted'].includes(finish)?streamFailure(result.errorMessage):undefined);
   report({route:task.route,model:task.model.id,stage,status,finish,marker:text.trim()===marker,
    tokens:Object.values(counts).some(value=>value>0)?counts:null,...code?{code}:{}});
   return {result,finish};
  }catch(error){report({route:task.route,model:task.model.id,stage,status,finish:'error',marker:false,code:signal.aborted?'timeout':failure??'transport_failure'});return undefined;}
 }
 const forced=task.toolChoice==='forced';
 const first=await request('tool-call',initial,forced?{type:'function',function:{name:'muse_echo'}}:undefined);
 const calls=first?.result.content.filter(block=>block.type==='toolCall')??[],call=calls[0];
 const invalid=first?.finish!=='toolUse'?'missing_tool_call':calls.length!==1?'tool_call_count':!call?.id?'missing_tool_call_id':call.name!=='muse_echo'?'unexpected_tool_name':call.arguments?.text!==marker?'unexpected_tool_arguments':undefined;
 if(invalid){report({route:task.route,model:task.model.id,stage:'tool-validation',code:invalid,toolCalls:calls.length});return false;}
 const second=await request('tool-continuation',[...initial,first.result,{role:'toolResult',toolCallId:call.id,toolName:call.name,
  content:[{type:'text',text:marker}],isError:false,timestamp:0}],forced?'none':undefined);
 return second?.finish==='stop'&&second.result.content.filter(block=>block.type==='text').map(block=>block.text).join('').trim()===marker;
}

async function piStream(){
 const require=createRequire(import.meta.url);let manifest;
 try{manifest=require.resolve('@deepseek-ai/dsh-llm-pi-ai/package.json');}catch(error){
  if(error.code!=='MODULE_NOT_FOUND')throw error;
  manifest=fileURLToPath(new URL('../../packages/llm/llm-pi-ai/package.json',import.meta.url));await access(manifest);
 }
 for(const root of createRequire(manifest).resolve.paths('@earendil-works/pi-ai')??[]){
  const file=join(root,'@earendil-works/pi-ai/dist/api/openai-completions.js');
  try{await access(file);}catch(error){continue;}
  return (await import(pathToFileURL(file).href)).stream;
 }
 throw Error('Installed Muse pi-ai runtime is unavailable');
}

async function main(){
 const args=process.argv.slice(2),run=args.includes('--run'),file=args.find(arg=>!arg.startsWith('--'))??'/var/lib/muse/accounts/global-model.json.native';
 const filters=args.filter(arg=>arg.startsWith('--model=')).map(arg=>arg.slice(8));
 const excluded=args.filter(arg=>arg.startsWith('--exclude-model=')).map(arg=>arg.slice(16));
 const toolChoice=args.find(arg=>arg.startsWith('--tool-choice='))?.slice(14)??'auto';
 if(!['auto','forced'].includes(toolChoice))throw Error('Invalid tool choice');
 const directory=JSON.parse(await readFile(file,'utf8'));
 const tasks=Object.entries(directory.providers??{}).flatMap(([route,provider])=>provider.models.filter(entry=>(!filters.length||filters.includes(entry.id))&&!excluded.includes(entry.id)).map(entry=>({
  route,model:probeModel(route,provider,entry),key:directory.credentials?.[provider.apiKeyEnv],toolChoice,
 })));
 if(!tasks.length)throw Error('No configured models matched');
 if(!run){console.log(JSON.stringify({ready:true,models:tasks.map(task=>({route:task.route,model:task.model.id})),requestedMaxTokens:32768,timeoutMs:45000,concurrency:2,requestsPerModel:2,toolChoice,requires:'--run'}));return;}
 const stream=await piStream();let next=0,passed=0;
 const report=value=>console.log(JSON.stringify(value));
 async function worker(){while(next<tasks.length){const task=tasks[next++];if(typeof task.key!=='string'||!task.key){report({route:task.route,model:task.model.id,stage:'tool-call',status:null,finish:'error',marker:false,code:'missing_credential'});continue;}
  const verified=await probeTask(task,stream,report);if(verified)passed++;report({route:task.route,model:task.model.id,verified});}}
 await Promise.all([worker(),worker()]);report({models:tasks.length,passed,failed:tasks.length-passed,requestedMaxTokens:32768});
 if(passed!==tasks.length)process.exitCode=1;
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main().catch(error=>{console.error(JSON.stringify({verified:false,code:'probe_setup_failed'}));process.exitCode=1;});

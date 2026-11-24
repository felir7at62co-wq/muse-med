/** Fixed LibTV API protocol for non-destructive, separately approved subtitle erasure. */
import {randomUUID} from 'node:crypto';
import {constants} from 'node:fs';
import {open,lstat} from 'node:fs/promises';
import {isAbsolute,join} from 'node:path';
import {companyCliDigest} from './company-cli-executor.mjs';

const origin='https://api.liblib.tv';
const endpoints={quote:`${origin}/api/task/generation/power/calculator`,create:`${origin}/api/task/generation/create`,progress:`${origin}/api/task/generation/progress`};
const model='volcano-subtitle-eraser';
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const positive=value=>Number.isSafeInteger(value)&&value>0;
const identifier=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,128}$/u.test(value);
const fail=(code,status=502)=>Object.assign(new Error(code),{code,status});
const clone=value=>structuredClone(value);

function amount(value,allowZero=false){
 if(typeof value!=='number'||!Number.isFinite(value)||value<0||(!allowZero&&value===0)||Number(value.toFixed(2))!==value||!Number.isSafeInteger(Math.round(value*100)))throw fail(value===0?'company_libtv_subtitles_price_unknown':'company_libtv_subtitles_invalid_price',428);
 return Math.round(value*100);
}

function mediaUrl(value){
 if(typeof value!=='string'||value.length>8192)throw fail('company_libtv_subtitles_invalid_media',428);
 let url;try{url=new URL(value);}catch{throw fail('company_libtv_subtitles_invalid_media',428);}
 if(url.protocol!=='https:'||url.username||url.password||url.hash||!['libtv-res.liblib.art','libtv-res.liblib.cloud'].includes(url.hostname)||url.port)throw fail('company_libtv_subtitles_invalid_media',428);
 return value;
}

function publicBinding(binding){
 if(!object(binding)||!['companyId','projectId','connectionId','canvasUuid'].every(key=>identifier(binding[key]))||!positive(binding.connectionRevision)||typeof binding.credentialsDir!=='string'||!isAbsolute(binding.credentialsDir)||!object(binding.owner)||!identifier(binding.owner.user_uuid)||!identifier(binding.owner.account_id)||binding.owner.team_id!==null&&!identifier(binding.owner.team_id)||Object.keys(binding.owner).some(key=>!['user_uuid','account_id','team_id'].includes(key)))throw fail('company_libtv_subtitles_invalid_binding',500);
 return {companyId:binding.companyId,projectId:binding.projectId,connectionId:binding.connectionId,connectionRevision:binding.connectionRevision,canvasUuid:binding.canvasUuid,owner:clone(binding.owner)};
}

function sourceRequest(source,binding,metadata){
 if(!object(source)||source.projectUuid!==binding.canvasUuid||!identifier(source.nodeId)||!identifier(source.outputNodeId)||source.outputNodeId===source.nodeId||typeof source.nodeSha256!=='string'||!/^[a-f0-9]{64}$/u.test(source.nodeSha256)||!object(source.node)||source.node.nodeKey!==source.nodeId||companyCliDigest(source.node)!==source.nodeSha256)throw fail('company_libtv_subtitles_source_changed',409);
 const data=source.node.data,media=data?.resourceMeta?.items;
 if(!object(data)||data.type!=='video'||!Array.isArray(data.url)||data.url.length!==1||!Array.isArray(media)||media.length!==1||!object(media[0])||media[0].kind!=='video'||!positive(media[0].width)||!positive(media[0].height)||Math.max(media[0].width,media[0].height)>2048||typeof media[0].durationSec!=='number'||!Number.isFinite(media[0].durationSec)||media[0].durationSec<3||data.taskInfo?.loading===true||data.taskInfo?.status!==undefined&&data.taskInfo.status!==2)throw fail('company_libtv_subtitles_unsupported_source',428);
 const measured=source.measuredMedia??media[0];
 if(!object(measured)||!positive(measured.width)||!positive(measured.height)||Math.max(measured.width,measured.height)>2048||typeof measured.durationSec!=='number'||!Number.isFinite(measured.durationSec)||measured.durationSec<3)throw fail('company_libtv_subtitles_unsupported_source',428);
 const url=mediaUrl(data.url[0]),extension=new URL(url).pathname.split('.').pop().toLowerCase();
 if(!['mp4','flv','ts','avi','mov','mkv','wmv'].includes(extension))throw fail('company_libtv_subtitles_unsupported_source',428);
 const schema=metadata?.schema;
 if(!object(metadata)||metadata.modelKey!==model||metadata.modality!=='video'||!object(schema)||schema.modelKey!==model||schema.modelVendor!=='volcano'||schema.active===false||!object(schema.properties)||Object.keys(schema.properties).length!==0||schema.config?.generateTypes?.text!==119||schema.config?.generateTypes?.image!==119||!Array.isArray(schema.rules)||!schema.rules.every(object))throw fail('company_libtv_subtitles_model_changed',428);
 const checks=schema.rules.filter(rule=>rule.check!==undefined),formats=checks.find(rule=>rule.check==='videoFormat');
 if(checks.length!==3||checks.some(rule=>!['videoFormat','videoMaxResolution','videoMinDuration'].includes(rule.check))||checks.find(rule=>rule.check==='videoMaxResolution')?.max!==2048||checks.find(rule=>rule.check==='videoMinDuration')?.min!==3||!Array.isArray(formats?.allow)||!formats.allow.includes(extension))throw fail('company_libtv_subtitles_model_changed',428);
 const request={params:{model,mode:'Subtitle',videoList:[url],videoListV2:[{url,width:measured.width,height:measured.height,duration:Number(measured.durationSec.toFixed(2))}]},metadata:{node_id:source.outputNodeId,project_id:binding.canvasUuid},provider:'volcano',model,taskType:'video',requestId:randomUUID()};
 if(binding.owner.team_id!==null){const teamId=Number(binding.owner.team_id);if(!positive(teamId)||String(teamId)!==binding.owner.team_id)throw fail('company_libtv_subtitles_invalid_binding',500);request.teamId=teamId;}
 return request;
}

async function credentials(binding){
 let file;
 try{
  const path=join(binding.credentialsDir,'credentials.json'),stat=await lstat(path);
  if(!stat.isFile()||stat.isSymbolicLink())throw fail('company_libtv_subtitles_credentials_unavailable',503);
  file=await open(path,constants.O_RDONLY|(constants.O_NOFOLLOW??0));
  const current=await file.stat();if(!current.isFile()||current.size<2||current.size>65536)throw fail('company_libtv_subtitles_credentials_unavailable',503);
  const value=JSON.parse(await file.readFile('utf8'));
  if(!object(value)||typeof value.usertoken!=='string'||!value.usertoken||value.usertoken.length>16384||/[\r\n]/u.test(value.usertoken)||typeof value.webid!=='string'||!value.webid||value.webid.length>1024||/[\r\n]/u.test(value.webid)||value.useruuid!==binding.owner.user_uuid)throw fail('company_libtv_subtitles_credentials_unavailable',503);
  return {token:value.usertoken,webid:value.webid};
 }catch{throw fail('company_libtv_subtitles_credentials_unavailable',503);}
 finally{if(file)await file.close();}
}

async function boundedBody(response,limit){
 if(!response.body||typeof response.body.getReader!=='function')throw fail('company_libtv_subtitles_invalid_response');
 const declared=response.headers.get('content-length');
 if(declared!==null&&(!/^\d+$/u.test(declared)||Number(declared)>limit)){await response.body.cancel();throw fail('company_libtv_subtitles_response_limit');}
 const reader=response.body.getReader(),parts=[];let size=0;
 try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>limit){await reader.cancel();throw fail('company_libtv_subtitles_response_limit');}parts.push(Buffer.from(value));}}
 finally{reader.releaseLock();}
 let raw;try{raw=JSON.parse(Buffer.concat(parts,size).toString('utf8'));}catch{throw fail('company_libtv_subtitles_invalid_response');}
 return raw;
}

/**
 * Parse the official single-task progress response without exposing supplier error strings.
 * @param {object} raw The bounded JSON response from the fixed progress endpoint.
 * @param {string} taskId The previously persisted provider acknowledgement.
 * @returns {object} A matching task status, optional settled charge, and immutable media URLs.
 */
export function parseLibTvSubtitleProgress(raw,taskId){
 if(!identifier(taskId)||!object(raw)||raw.code!==0||!Array.isArray(raw.data?.progresses)||raw.data.progresses.length!==1)throw fail('company_libtv_subtitles_invalid_progress');
 const item=raw.data.progresses[0];
 if(!object(item)||item.taskId!==taskId||!Number.isInteger(item.status))throw fail('company_libtv_subtitles_task_mismatch');
 const result={taskId,status:item.status,state:'unknown',outputs:[]};
 if(item.power!==undefined)result.chargedMinor=amount(item.power,true);
 if([0,1].includes(item.status)){result.state='running';return result;}
 if([3,4,5].includes(item.status)){result.state='failed';result.error_code=item.status===5?'company_libtv_subtitles_task_cancelled':item.status===4?'company_libtv_subtitles_task_timed_out':'company_libtv_subtitles_task_failed';return result;}
 if(item.status!==2)return result;
 let body=item.taskResult;
 if(typeof body==='string'){try{body=JSON.parse(body);}catch{throw fail('company_libtv_subtitles_invalid_result');}}
 if(!object(body)||!Array.isArray(body.videos)||body.videos.length!==1||!object(body.videos[0]))throw fail('company_libtv_subtitles_invalid_result');
 const video=body.videos[0],url=mediaUrl(video.videoUrl??video.previewPath);
 const output={kind:'video',url};if(identifier(video.resourceId))output.resourceId=video.resourceId;
 result.state='completed';result.outputs=[output];return result;
}

/**
 * Create a private LibTV API adapter. It never submits automatically or retries a submission.
 * @param {object} options Optional transport, clock, quote lifetime, timeout and response bounds.
 * @returns {object} prepare/quote/create/progress methods; create requires this instance's fresh quote. Only the fixed erasure model's complete numeric zero-price response is accepted. The caller owns user approval, durable acknowledgement, project locking and source revalidation.
 */
export function createLibTvSubtitleProvider({fetchImpl=globalThis.fetch,now=Date.now,ttlMs=60000,timeoutMs=10000,maxResponseBytes=1048576}={}){
 if(typeof fetchImpl!=='function'||typeof now!=='function'||!positive(ttlMs)||ttlMs>300000||!positive(timeoutMs)||timeoutMs>60000||!positive(maxResponseBytes)||maxResponseBytes>4194304)throw fail('company_libtv_subtitles_invalid_configuration',500);
 const preparedValues=new WeakMap(),quotes=new WeakMap(),dispatched=new WeakSet();
 const time=()=>{const value=now();if(!Number.isSafeInteger(value)||value<0||value+ttlMs>8640000000000000)throw fail('company_libtv_subtitles_invalid_clock',500);return value;};
 function check(prepared,binding){
  const saved=object(prepared)&&preparedValues.get(prepared),current=publicBinding(binding);
  if(!saved||companyCliDigest(prepared)!==saved.digest||companyCliDigest(current)!==saved.bindingDigest)throw fail('company_libtv_subtitles_prepared_changed',409);
  return saved;
 }
 async function post(kind,body,binding,signal){
  const auth=await credentials(binding),controller=new AbortController(),abort=()=>controller.abort();
  if(signal?.aborted)throw fail('company_libtv_subtitles_cancelled',499);
  signal?.addEventListener('abort',abort,{once:true});const timer=setTimeout(abort,timeoutMs);timer.unref?.();
  try{
   const response=await fetchImpl(endpoints[kind],{method:'POST',redirect:'error',headers:{token:auth.token,webid:auth.webid,'x-language':'zh','Content-Type':'application/json',Accept:'application/json',Origin:'https://www.liblib.tv'},body:JSON.stringify(body),signal:controller.signal});
   if(!response.ok){await response.body?.cancel();throw fail(kind==='create'?'company_libtv_subtitles_submission_unknown':'company_libtv_subtitles_http_error');}
   return await boundedBody(response,maxResponseBytes);
  }catch(error){
   if(kind==='create')throw fail('company_libtv_subtitles_submission_unknown');
   if(controller.signal.aborted)throw fail(signal?.aborted?'company_libtv_subtitles_cancelled':'company_libtv_subtitles_timeout',signal?.aborted?499:504);
   if(typeof error?.code==='string'&&error.code.startsWith('company_libtv_subtitles_'))throw error;
   throw fail('company_libtv_subtitles_unavailable',503);
  }finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);}
 }
 async function prepare({binding,source,read}){
  const owner=publicBinding(binding);if(typeof read!=='function')throw fail('company_libtv_subtitles_invalid_configuration',500);
  let metadata;try{metadata=await read('model_schema',{model_key:model});}catch{throw fail('company_libtv_subtitles_metadata_unavailable',503);}
  const request=sourceRequest(source,binding,metadata),{requestId,...semanticRequest}=request;
  const nodeSha256=source.nodeSha256,modelSchemaSha256=companyCliDigest(metadata),requestSha256=companyCliDigest({binding:owner,nodeSha256,modelSchemaSha256,request:semanticRequest});
  const prepared={protocol:'muse-company-libtv-subtitles-input-v1',method:'libtv_api_erase_subtitles',paid:true,provider:'libtv-api',service:'postproduction',model,quantity:1,requestSha256,nodeSha256,modelSchemaSha256,projectUuid:source.projectUuid,nodeId:source.nodeId,outputNodeId:source.outputNodeId,request};
  preparedValues.set(prepared,{digest:companyCliDigest(prepared),bindingDigest:companyCliDigest(owner),owner});return prepared;
 }
 async function quote({prepared,binding,signal}){
  const saved=check(prepared,binding),raw=await post('quote',prepared.request,binding,signal);
  if(!object(raw)||raw.code!==0||!object(raw.data))throw fail('company_libtv_subtitles_quote_rejected',428);
  const zeroQuote=raw.data.power===0&&raw.data.originalPrice===0&&raw.data.taskWeight===0&&raw.data.type===0&&raw.data.discountRatio===1;
  const priceMinor=amount(raw.data.power,zeroQuote),response={power:raw.data.power};
  if(raw.data.originalPrice!==undefined){amount(raw.data.originalPrice,true);response.originalPrice=raw.data.originalPrice;}
  if(zeroQuote)Object.assign(response,{taskWeight:0,type:0,discountRatio:1});
  const {requestId,...request}=prepared.request,quotedAt=time(),expiresAt=quotedAt+ttlMs;
  const identity={requestSha256:prepared.requestSha256,nodeSha256:prepared.nodeSha256,modelSchemaSha256:prepared.modelSchemaSha256,...saved.owner,request,currency:'LTV',priceMinor,zeroQuote,response};
  const value={protocol:'muse-company-libtv-api-quote-v1',provider:'libtv-api',service:'postproduction',model,quantity:1,currency:'LTV',priceMinor,unitMinor:priceMinor,reservedMinor:priceMinor,zeroQuote,source:endpoints.quote,quotedAt:new Date(quotedAt).toISOString(),expiresAt:new Date(expiresAt).toISOString(),requestSha256:prepared.requestSha256,nodeSha256:prepared.nodeSha256,connectionId:binding.connectionId,connectionRevision:binding.connectionRevision,owner:clone(binding.owner),quoteIdentity:companyCliDigest(identity),requestHash:companyCliDigest(prepared.request),responseHash:companyCliDigest(raw),response,locked:false};
  quotes.set(value,{prepared,digest:companyCliDigest(value),expiresAt});return value;
 }
 async function create({prepared,binding,quote:price,signal}){
  check(prepared,binding);const saved=object(price)&&quotes.get(price);
  if(!saved||saved.prepared!==prepared||saved.digest!==companyCliDigest(price)||saved.expiresAt<=time())throw fail('company_libtv_subtitles_fresh_quote_required',428);
  if(dispatched.has(prepared))throw fail('company_libtv_subtitles_already_submitted',409);
  dispatched.add(prepared);
  const raw=await post('create',prepared.request,binding,signal),data=raw?.data;
  if(!object(raw)||raw.code!==0||!object(data))throw fail('company_libtv_subtitles_submission_unknown');
  const taskId=data.taskId??data.task_id;
  if(!identifier(taskId)||data.taskId!==undefined&&data.task_id!==undefined&&data.taskId!==data.task_id)throw fail('company_libtv_subtitles_submission_unknown');
  return {taskId,provider:'libtv-api',model,requestSha256:prepared.requestSha256,outputNodeId:prepared.outputNodeId};
 }
 async function progress({taskId,binding,signal}){
  publicBinding(binding);if(!identifier(taskId))throw fail('company_libtv_subtitles_invalid_task',400);
  const request={taskIds:[taskId]};if(binding.owner.team_id!==null){const id=Number(binding.owner.team_id);if(!positive(id)||String(id)!==binding.owner.team_id)throw fail('company_libtv_subtitles_invalid_binding',500);request.teamId=id;}
  return parseLibTvSubtitleProgress(await post('progress',request,binding,signal),taskId);
 }
 return {prepare,quote,create,progress};
}

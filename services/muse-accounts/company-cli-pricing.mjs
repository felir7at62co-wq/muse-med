/** Read-only LibTV HD quotations for server-verified company CLI inputs. */
import {randomUUID,createHash} from 'node:crypto';
import {constants} from 'node:fs';
import {open,lstat} from 'node:fs/promises';
import {join,isAbsolute} from 'node:path';
import {companyCliDigest,validateCompanyAdvancedPlan} from './company-cli-executor.mjs';

const endpoint='https://api.liblib.tv/api/task/generation/power/calculator';
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const fail=(code,status=502)=>Object.assign(new Error(code),{code,status});
const positive=value=>Number.isSafeInteger(value)&&value>0;
const models={
 'topaz-video-upscaler':{vendor:'topazlabs',fields:['resolution','specifiedModel','fps','slowmo']},
 'volcano-video-upscaler':{vendor:'volcano',fields:['resolution','fps']},
};
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');

function minor(value){
 if(typeof value!=='number'||!Number.isFinite(value)||value<=0||Number(value.toFixed(2))!==value)throw fail('company_cli_quote_invalid_price');
 const result=Math.round(value*100);
 if(!positive(result))throw fail('company_cli_quote_invalid_price');
 return result;
}

function settingDefault(key,property){
 if(!object(property)||property.originalField!==undefined&&property.originalField!==key||property.default===undefined)throw fail('company_cli_quote_unsupported_settings',428);
 const value=property.default;
 if(Array.isArray(property.enum)&&!property.enum.some(item=>(object(item)?item.value:item)===value))throw fail('company_cli_quote_unsupported_settings',428);
 if(key==='fps'){
  if(!positive(value)||value>120||typeof property.min==='number'&&value<property.min||typeof property.max==='number'&&value>property.max)throw fail('company_cli_quote_unsupported_settings',428);
 }else if(key==='resolution'){
  if(!['720p','1080p','2k','2K','4k','4K'].includes(value))throw fail('company_cli_quote_unsupported_settings',428);
 }else if(key==='specifiedModel'){
  if(!['apo-8','prob-4'].includes(value))throw fail('company_cli_quote_unsupported_settings',428);
 }else if(key==='slowmo'&&!['1','2','3','5'].includes(value))throw fail('company_cli_quote_unsupported_settings',428);
 return value;
}

function visible(property,values){
 if(property.visibleWhen===undefined)return true;
 const condition=property.visibleWhen;
 if(!object(condition)||Object.keys(condition).length!==1||!object(condition.specifiedModel)||Object.keys(condition.specifiedModel).length!==1||!Object.hasOwn(condition.specifiedModel,'ne')||condition.specifiedModel.ne!=='prob-4')throw fail('company_cli_quote_unsupported_settings',428);
 return values.specifiedModel!=='prob-4';
}

function sourceInput(prepared,binding){
 if(!object(prepared)||prepared.method!=='video_hd'||prepared.paid!==true||prepared.quantity!==1||prepared.service!=='agent-task'||prepared.model!=='advanced:video_hd')throw fail('company_cli_quote_unsupported_operation',428);
 const command={method:prepared.method,body:prepared.body},plan=prepared.inputCapture;
 validateCompanyAdvancedPlan(command,plan);
 if(!object(binding)||typeof binding.credentialsDir!=='string'||!isAbsolute(binding.credentialsDir)||!object(binding.owner)||Object.keys(binding.owner).some(key=>!['user_uuid','account_id','team_id'].includes(key))||typeof binding.owner.user_uuid!=='string'||!binding.owner.user_uuid||typeof binding.owner.account_id!=='string'||!binding.owner.account_id||binding.owner.team_id!==null&&typeof binding.owner.team_id!=='string'||!['companyId','projectId','connectionId'].every(key=>typeof binding[key]==='string'&&binding[key])||!positive(binding.connectionRevision)||binding.canvasUuid!==prepared.body.project_uuid)throw fail('company_cli_quote_invalid_binding',500);
 const requestSha256=companyCliDigest({command,companyId:binding.companyId,projectId:binding.projectId,connectionId:binding.connectionId,connectionRevision:binding.connectionRevision,owner:binding.owner,inputCapture:plan,uploadSha:null});
 if(requestSha256!==prepared.requestSha256)throw fail('company_cli_quote_inputs_changed',409);
 const selected=plan.metadata.models.find(model=>model.modelName===prepared.body.model_name);
 if(!Object.hasOwn(models,selected.modelKey))throw fail('company_cli_quote_unsupported_model',428);
 const model=models[selected.modelKey];
 const node=plan.node,data=node.data,urls=data.url,media=data.resourceMeta?.items;
 if(node.nodeKey!==prepared.body.node_id||!Array.isArray(urls)||urls.length!==1||typeof urls[0]!=='string'||urls[0].length>8192||!Array.isArray(media)||media.length!==1||media[0].kind!=='video'||!positive(media[0].width)||!positive(media[0].height)||typeof media[0].durationSec!=='number'||!Number.isFinite(media[0].durationSec)||media[0].durationSec<=0||data.taskInfo?.loading===true||data.taskInfo?.status!==undefined&&data.taskInfo.status!==2)throw fail('company_cli_quote_unsupported_source',428);
 let url;try{url=new URL(urls[0]);}catch{throw fail('company_cli_quote_unsupported_source',428);}
 if(url.protocol!=='https:'||url.username||url.password||url.hash)throw fail('company_cli_quote_unsupported_source',428);
 return {plan,selected,model,media:media[0],url:urls[0]};
}

function requestFor(prepared,binding,input,metadata){
 const schema=metadata?.schema;
 if(!object(metadata)||metadata.modelKey!==input.selected.modelKey||metadata.modality!=='video'||!object(schema)||schema.modelKey!==input.selected.modelKey||schema.modelVendor!==input.model.vendor||schema.active!==true||!object(schema.properties)||!Array.isArray(schema.config?.settings)||schema.config.settings.length!==input.model.fields.length||new Set(schema.config.settings).size!==input.model.fields.length||schema.config.settings.some(key=>!input.model.fields.includes(key)))throw fail('company_cli_quote_unsupported_settings',428);
 const defaults={};for(const key of schema.config.settings)defaults[key]=settingDefault(key,schema.properties[key]);
 const params={model:metadata.modelKey};for(const key of schema.config.settings){if(schema.properties[key].visibleWhen!==undefined&&(key!=='fps'||metadata.modelKey!=='topaz-video-upscaler'))throw fail('company_cli_quote_unsupported_settings',428);if(visible(schema.properties[key],defaults))params[key]=defaults[key];}
 params.videoList=[input.url];
 params.videoListV2=[{url:input.url,width:input.media.width,height:input.media.height,duration:Number(input.media.durationSec.toFixed(2))}];
 if(params.videoListV2[0].duration<=0)throw fail('company_cli_quote_unsupported_source',428);
 const request={params,metadata:{node_id:prepared.body.node_id,project_id:binding.canvasUuid},provider:input.model.vendor,model:metadata.modelKey,taskType:'video',requestId:randomUUID()};
 if(binding.owner.team_id!==null){const teamId=Number(binding.owner.team_id);if(!positive(teamId)||String(teamId)!==binding.owner.team_id)throw fail('company_cli_quote_invalid_binding',500);request.teamId=teamId;}
 return request;
}

async function credentialsFor(binding){
 const path=join(binding.credentialsDir,'credentials.json');let file;
 try{
  const stat=await lstat(path);if(!stat.isFile()||stat.isSymbolicLink())throw fail('company_cli_quote_credentials_unavailable',503);
  file=await open(path,constants.O_RDONLY|(constants.O_NOFOLLOW??0));
  const current=await file.stat();if(!current.isFile()||current.size<2||current.size>65536)throw fail('company_cli_quote_credentials_unavailable',503);
  const data=JSON.parse(await file.readFile('utf8'));
  if(!object(data)||typeof data.usertoken!=='string'||!data.usertoken||data.usertoken.length>16384||/[\r\n]/u.test(data.usertoken)||typeof data.webid!=='string'||!data.webid||data.webid.length>1024||/[\r\n]/u.test(data.webid)||data.useruuid!==binding.owner.user_uuid)throw fail('company_cli_quote_credentials_unavailable',503);
  return {token:data.usertoken,webid:data.webid};
 }catch{throw fail('company_cli_quote_credentials_unavailable',503);}
 finally{if(file)await file.close();}
}

async function responseBytes(response,limit){
 if(!response.body||typeof response.body.getReader!=='function')throw fail('company_cli_quote_invalid_response');
 const declared=response.headers.get('content-length');if(declared!==null&&(!/^\d+$/u.test(declared)||Number(declared)>limit)){await response.body.cancel();throw fail('company_cli_quote_response_limit');}
 const reader=response.body.getReader(),chunks=[];let size=0;
 try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>limit){await reader.cancel();throw fail('company_cli_quote_response_limit');}chunks.push(Buffer.from(value));}}
 finally{reader.releaseLock();}
 return Buffer.concat(chunks,size);
}

/**
 * Create a private, bounded quotation reader. It never dispatches generation or retries requests.
 * @param {object} options Optional fetch, clock and bounded timeout, response size and quote lifetime.
 * @returns {object} resolve({prepared,binding,read,signal?}) returns a quotation with no credential headers. read resolves a fresh CLI model record; absent signal leaves cancellation to the timeout. Quotations expire and do not lock supplier prices.
 */
export function createCompanyCliPricing({fetchImpl=globalThis.fetch,now=Date.now,ttlMs=60000,timeoutMs=10000,maxResponseBytes=65536}={}){
 if(typeof fetchImpl!=='function'||typeof now!=='function'||!positive(ttlMs)||ttlMs>300000||!positive(timeoutMs)||timeoutMs>60000||!positive(maxResponseBytes)||maxResponseBytes>1048576)throw fail('company_cli_quote_invalid_configuration',500);
 async function resolve({prepared,binding,read,signal}){
  const input=sourceInput(prepared,binding);if(typeof read!=='function')throw fail('company_cli_quote_invalid_configuration',500);
  let metadata;try{metadata=await read('model_schema',{model_key:input.selected.modelKey});}catch{throw fail('company_cli_quote_metadata_unavailable',503);}
  const request=requestFor(prepared,binding,input,metadata),credentials=await credentialsFor(binding),controller=new AbortController();
  const abort=()=>controller.abort();if(signal?.aborted)throw fail('company_cli_quote_cancelled',499);signal?.addEventListener('abort',abort,{once:true});
  const timer=setTimeout(abort,timeoutMs);timer.unref?.();let response,bytes;
  try{
   response=await fetchImpl(endpoint,{method:'POST',redirect:'error',headers:{token:credentials.token,webid:credentials.webid,'x-language':'zh','Content-Type':'application/json',Accept:'application/json',Origin:'https://www.liblib.tv'},body:JSON.stringify(request),signal:controller.signal});
   if(!response.ok){await response.body?.cancel();throw fail('company_cli_quote_http_error');}
   bytes=await responseBytes(response,maxResponseBytes);
  }catch(error){if(controller.signal.aborted)throw fail(signal?.aborted?'company_cli_quote_cancelled':'company_cli_quote_timeout',signal?.aborted?499:504);if(typeof error?.code==='string'&&error.code.startsWith('company_cli_quote_'))throw error;throw fail('company_cli_quote_unavailable',503);}
  finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);}
  let raw;try{raw=JSON.parse(bytes.toString('utf8'));}catch{throw fail('company_cli_quote_invalid_response');}
  if(!object(raw)||raw.code!==0||!object(raw.data))throw fail('company_cli_quote_rejected');
  const priceMinor=minor(raw.data.power),data={power:raw.data.power};
  if(raw.data.originalPrice!==undefined){minor(raw.data.originalPrice);data.originalPrice=raw.data.originalPrice;}
  const publicResponse={code:0,data};
  if(typeof raw.trace_id==='string'&&/^[\w-]{1,128}$/u.test(raw.trace_id)&&!raw.trace_id.includes(credentials.token))publicResponse.trace_id=raw.trace_id;
  const {requestId,...semanticRequest}=request;
  const owner=structuredClone(binding.owner),modelSchemaSha256=companyCliDigest(metadata),planSha256=companyCliDigest(input.plan),nodeSha256=input.plan.node_sha256;
  const identity={requestSha256:prepared.requestSha256,nodeSha256,planSha256,modelSchemaSha256,connectionId:binding.connectionId,connectionRevision:binding.connectionRevision,owner,request:semanticRequest,currency:'LTV',priceMinor,originalPriceMinor:data.originalPrice===undefined?null:minor(data.originalPrice)};
  const quotedAtMs=now();if(!Number.isSafeInteger(quotedAtMs)||quotedAtMs<0||!Number.isSafeInteger(quotedAtMs+ttlMs)||quotedAtMs+ttlMs>8640000000000000)throw fail('company_cli_quote_invalid_clock',500);
  return {protocol:'muse-company-cli-hd-quote-v1',source:endpoint,service:'agent-task',model:request.model,billingModel:prepared.model,quantity:1,currency:'LTV',priceMinor,unitMinor:priceMinor,reservedMinor:priceMinor,requestSha256:prepared.requestSha256,nodeSha256,planSha256,modelSchemaSha256,connectionId:binding.connectionId,connectionRevision:binding.connectionRevision,owner,quotedAt:new Date(quotedAtMs).toISOString(),expiresAt:new Date(quotedAtMs+ttlMs).toISOString(),request,response:publicResponse,requestHash:companyCliDigest(request),responseHash:sha(bytes),quoteIdentity:companyCliDigest(identity),locked:false};
 }
 return {resolve};
}

/** Bounded request correlation and response metadata; request/response contents are never logged. */
import {randomUUID} from 'node:crypto';
import {StringDecoder} from 'node:string_decoder';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RESPONSE_ID=/^[a-z0-9][a-z0-9._:-]{0,255}$/i;
const MODEL=/^[a-z0-9][a-z0-9._:/@+-]{0,199}$/i;
const FINISH=/^[a-z][a-z0-9_-]{0,63}$/i;
// Security bounds apply to observation only; oversize payloads still pass through unchanged.
const MAX_EVENT_CHARS=65536,MAX_FINISHES=8;
const NUMBERS=['prompt_tokens','completion_tokens','total_tokens','input_tokens','output_tokens',
 'prompt_cache_hit_tokens','prompt_cache_miss_tokens','reasoning_tokens'];
const DETAILS={prompt_tokens_details:['cached_tokens','audio_tokens'],
 completion_tokens_details:['reasoning_tokens','audio_tokens','accepted_prediction_tokens','rejected_prediction_tokens'],
 input_tokens_details:['cached_tokens','audio_tokens'],output_tokens_details:['reasoning_tokens','audio_tokens']};
const ERROR_CODES=new Set(['ABORT_ERR','ECONNRESET','ECONNREFUSED','ETIMEDOUT','EPIPE','EAI_AGAIN','ENOTFOUND',
 'ERR_STREAM_PREMATURE_CLOSE','ERR_STREAM_DESTROYED','ERR_SOCKET_CLOSED']);
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const count=value=>Number.isSafeInteger(value)&&value>=0;
const status=value=>Number.isInteger(value)&&value>=100&&value<=599?value:null;
const defaultSink=record=>console.info('[muse-model-metadata]',JSON.stringify(record));

/** Validate a client UUID without retaining an invalid header value.
 * @param {unknown} value One HTTP header value; arrays and combined repeated headers are rejected.
 * @returns {string|null} Canonical UUID, or null.
 */
export function validatedModelClientId(value){return typeof value==='string'&&UUID.test(value)?value.toLowerCase():null;}

function metadataParser({stream,accept,done,truncated}){
 const decoder=new StringDecoder('utf8');
 let line='',lineTooLong=false,eventTooLong=false,eventLength=0,data=[],first=true,skipLF=false,jsonText='',jsonTooLong=false;
 function endLine(){
  if(first){line=line.replace(/^\ufeff/,'');first=false;}
  if(!lineTooLong&&line===''){
   if(!eventTooLong&&data.length){
    const value=data.join('\n');
    if(data.length===1&&value==='[DONE]')done();
    else{try{accept(JSON.parse(value));}catch(error){if(!(error instanceof SyntaxError))throw error;}}
   }
   eventTooLong=false;eventLength=0;data=[];
  }else if(lineTooLong){eventTooLong=true;truncated();}
  else if(line==='data'||line.startsWith('data:')){
   const value=line==='data'?'':line.slice(5).replace(/^ /,'');eventLength+=value.length+1;
   if(eventLength>MAX_EVENT_CHARS){eventTooLong=true;data=[];truncated();}
   else if(!eventTooLong)data.push(value);
  }
  line='';lineTooLong=false;
 }
 function part(text){
  if(!stream){
   if(!jsonTooLong){if(jsonText.length+text.length<=MAX_EVENT_CHARS)jsonText+=text;else{jsonTooLong=true;jsonText='';truncated();}}
   return;
  }
  for(let index=0;index<text.length;index++){
   const character=text[index];
   if(skipLF){skipLF=false;if(character==='\n')continue;}
   if(character==='\r'||character==='\n'){skipLF=character==='\r';endLine();}
   else if(!lineTooLong){if(line.length<MAX_EVENT_CHARS)line+=character;else{line='';lineTooLong=true;truncated();}}
  }
 }
 return {push(chunk){
  const bytes=typeof chunk==='string'?Buffer.from(chunk):chunk;
  for(let offset=0;offset<bytes.length;offset+=4096)part(decoder.write(bytes.subarray(offset,offset+4096)));
 },complete(eof){
  part(decoder.end());
  if(!stream&&eof&&!jsonTooLong){try{accept(JSON.parse(jsonText));}catch(error){if(!(error instanceof SyntaxError))throw error;}}
  line='';data=[];jsonText='';
 }};
}

/** Create one metadata record for an actual incoming model HTTP request.
 * @param {object} options Client header, public route, private sensitive tokens and optional synchronous metadata sink.
 * @returns {object} Observation operations; all records are built from a fixed allowlist.
 */
export function createModelRequestMetadata({clientId,route=null,sink=defaultSink,sensitiveTokens=[]}={}){
 const id=validatedModelClientId(clientId),secrets=new Set(sensitiveTokens.filter(token=>typeof token==='string'&&token.length>0));
 const record={event:'model_request_metadata',version:1,server_request_id:randomUUID(),client_request_id:id,
  client_request_id_state:clientId===undefined?'absent':id===null?'invalid':'valid',route:typeof route==='string'&&/^[a-z][a-z0-9-]{0,63}$/.test(route)?route:null,
  ingress_bytes:0,ingress_complete:false,forward_bytes:null,requested_model:null,forwarded_model:null,
  upstream_status:null,client_status:null,response_bytes:0,response_id:null,response_model:null,
  response_identity_changed:false,raw_finish_reasons:[],usage:null,done:false,eof:false,error_kind:null,error_code:null,
  observation_truncated:false};
 let parser,finished=false;
 const containsSecret=value=>typeof value==='string'&&[...secrets].some(secret=>value.includes(secret));
 const safe=(value,pattern)=>typeof value==='string'&&pattern.test(value)&&!containsSecret(value)?value:null;
 function scrub(value){
  if(typeof value==='string')return containsSecret(value)?null:value;
  if(Array.isArray(value))return value.map(scrub);
  if(object(value))return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,scrub(item)]));
  return value;
 }
 function accept(value){
  if(!object(value))return;
  for(const [source,target]of [['id','response_id'],['model','response_model']]){
   const current=safe(value[source],source==='id'?RESPONSE_ID:MODEL);if(current===null)continue;
   if(record[target]!==null&&record[target]!==current)record.response_identity_changed=true;
   record[target]=current;
  }
  if(Array.isArray(value.choices))for(const choice of value.choices){
   if(!object(choice))continue;
   const reason=safe(choice.finish_reason,FINISH);if(reason===null)continue;
   const index=count(choice.index)&&choice.index<=255?choice.index:null;
   if(record.raw_finish_reasons.some(item=>item.index===index&&item.value===reason))continue;
   if(record.raw_finish_reasons.length<MAX_FINISHES)record.raw_finish_reasons.push({index,value:reason});else record.observation_truncated=true;
  }
  if(object(value.usage)){
   const usage=record.usage??{};
   for(const key of NUMBERS)if(count(value.usage[key]))usage[key]=value.usage[key];
   for(const [key,names]of Object.entries(DETAILS))if(object(value.usage[key])){
    const details=usage[key]??{};for(const name of names)if(count(value.usage[key][name]))details[name]=value.usage[key][name];
    if(Object.keys(details).length)usage[key]=details;
   }
   if(Object.keys(usage).length)record.usage=usage;
  }
 }
 return {serverRequestId:record.server_request_id,
  ingress(bytes,complete=false){if(count(bytes))record.ingress_bytes=bytes;if(complete)record.ingress_complete=true;},
  request(model){record.requested_model=safe(model,MODEL);},
  forwarded({model,bytes,stream,secret}){
   if(typeof secret==='string'&&secret.length)secrets.add(secret);
   record.requested_model=safe(record.requested_model,MODEL);record.forwarded_model=safe(model,MODEL);
   record.forward_bytes=count(bytes)?bytes:null;
   parser=metadataParser({stream:Boolean(stream),accept,done:()=>{record.done=true;},truncated:()=>{record.observation_truncated=true;}});
  },
  upstream(code){record.upstream_status=status(code);},
  client(code){record.client_status=status(code);},
  bytes(chunk){
   record.response_bytes+=typeof chunk==='string'?Buffer.byteLength(chunk):chunk.byteLength;
   try{parser?.push(chunk);}catch(error){record.observation_truncated=true;parser=undefined;}
  },
  eof(){record.eof=true;},
  completeBytes(){try{parser?.complete(record.eof);}catch(error){record.observation_truncated=true;}parser=undefined;},
  failed(kind,error){
   if(['request_rejected','upstream_http','invalid_content_type','transport','cancelled'].includes(kind)
    &&(record.error_kind===null||kind!=='request_rejected'))record.error_kind=kind;
   const code=object(error)?error.code:undefined;if(ERROR_CODES.has(code))record.error_code=code;
  },
  finish(code){
   if(finished)return;finished=true;if(status(code)!==null)record.client_status=code;
   // Diagnostic failures must never change the response, cancellation, lease or retry behavior.
   if(containsSecret(record.client_request_id)){record.client_request_id=null;record.client_request_id_state='redacted';}
   try{sink(scrub(record));}catch(error){/* A failed diagnostic sink has no request authority. */}
   secrets.clear();parser=undefined;
  },
 };
}

/** Observe forwarded chunks without replacing, concatenating or decoding their delivered bytes.
 * @param {AsyncIterable<Buffer>} source Existing forwarding iterator, including its cancellation ownership.
 * @param {object} metadata Bounded observation operations.
 * @returns {AsyncGenerator<Buffer>} Identical chunks under the same downstream backpressure.
 */
export async function* observeModelResponseBytes(source,metadata){
 try{for await(const chunk of source){metadata.bytes(chunk);yield chunk;}}
 finally{metadata.completeBytes();}
}

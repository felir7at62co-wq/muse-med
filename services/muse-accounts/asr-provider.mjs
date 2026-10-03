/** Volcengine recording-file v3 adapter. Credentials remain on the gateway. */
import {readFile} from 'node:fs/promises';
const endpoint='https://openspeech.bytedance.com/api/v3/auc/bigmodel';
const resource='volc.bigasr.auc';
const failureMessages={
 submit:{response:'ASR submit outcome unknown; retain the task ID and query it'},
 query:{response:'ASR query returned an unknown status; retain this task ID',transport:'ASR query failed; retry this task ID',http:'ASR query failed; retry this task ID',json:'ASR query returned invalid JSON',result:'ASR query failed; retry this task ID'},
 flash:{response:'ASR flash outcome unknown; automatic resubmission is disabled',json:'ASR flash response is invalid; automatic resubmission is disabled',result:'ASR flash response is invalid; automatic resubmission is disabled'},
};

/**
 * Safe provider diagnostics. A rejection records a response, never a known charge outcome.
 * Only operation, code, message, validated HTTP status, and numeric supplier code are retained.
 */
export class AsrProviderError extends Error{
 /**
  * @param {'submit'|'query'|'flash'} operation Provider operation that failed.
  * @param {'transport'|'http'|'response'|'json'|'result'|'audio'} reason Failure category selecting a fixed message.
  * @param {Response} [response] Supplier response supplying only status fields.
  */
 constructor(operation,reason,response){
  super(failureMessages[operation][reason]??failureMessages[operation].response);
  // Stack frames contain gateway paths; durable diagnostics retain only the allowed fields.
  delete this.stack;
  this.operation=operation;
  if(Number.isInteger(response?.status)&&response.status>=100&&response.status<=599)this.httpStatus=response.status;
  const providerCode=response?.headers.get('X-Api-Status-Code');
  if(typeof providerCode==='string'&&/^\d{5,10}$/.test(providerCode))this.providerCode=providerCode;
  this.code=['response','http'].includes(reason)&&!(this.httpStatus>=500)&&(this.httpStatus>=400||this.providerCode!==undefined)?'provider_rejected':'provider_unavailable';
 }
}

function headers(config,id){return {'content-type':'application/json','X-Api-App-Key':config.appId,'X-Api-Access-Key':config.accessToken,'X-Api-Resource-Id':config.resourceId??resource,'X-Api-Request-Id':id};}

/** Submit one paid request. Every failure retains an unknown charge outcome and must be reconciled by query. */
export async function submitAsr(config,{id,url,language,format='mp3'},fetcher=fetch){
 let response;
 try{response=await fetcher(endpoint+'/submit',{method:'POST',headers:{...headers(config,id),'X-Api-Sequence':'-1'},body:JSON.stringify({user:{uid:'muse-audio-transcribe'},audio:{format,url,rate:16000,channel:1},request:{model_name:'bigmodel',enable_itn:true,enable_punc:true,show_utterances:true,...language==='auto'?{enable_auto_lang:true}:{language}}}),signal:AbortSignal.timeout(config.timeoutMs)});}
 catch(error){throw new AsrProviderError('submit','transport');}
 const code=response.headers.get('X-Api-Status-Code');
 if(response.ok&&['20000000','20000001','20000002'].includes(code))return;
 throw new AsrProviderError('submit','response',response);
}

/** Query an existing task, including after an uncertain submit. */
export async function queryAsr(config,id,fetcher=fetch){
 let response;
 try{response=await fetcher(endpoint+'/query',{method:'POST',headers:headers(config,id),body:'{}',signal:AbortSignal.timeout(config.timeoutMs)});}
 catch(error){throw new AsrProviderError('query','transport');}
 const code=response.headers.get('X-Api-Status-Code');
 if(!response.ok)throw new AsrProviderError('query','http',response);
 if(['20000001','20000002'].includes(code))return {status:'processing'};
 if(code==='20000003')return {status:'silent'};
 if(code!=='20000000')throw new AsrProviderError('query','response',response);
 let body;try{body=await response.json();}catch(error){throw new AsrProviderError('query','json',response);}
 try{return normalizeResult(body);}catch(error){throw new AsrProviderError('query','result',response);}
}

function normalizeResult(body){
 const utterances=body?.result?.utterances;
 if(!Array.isArray(utterances)||!utterances.length)throw Error('ASR result has no timed utterances');
 const segments=[];
 for(const row of utterances){const start=row?.start_time,end=row?.end_time,text=row?.text;
  if(!Number.isFinite(start)||start<0||!Number.isFinite(end)||end<=start||typeof text!=='string'||segments.length&&start<segments.at(-1).start*1000)throw Error('ASR utterance has invalid time or text');
  if(text.trim()){
   const segment={start:start/1000,end:end/1000,text:text.trim()};
   if(row.words!==undefined){
    if(!Array.isArray(row.words))throw Error('ASR words are invalid');
    segment.words=[];
    for(const word of row.words){
     if(typeof word?.text!=='string')throw Error('ASR word has invalid text');
     if(!word.text.trim()||word.start_time===word.end_time&&/^[\p{P}\p{S}\s]+$/u.test(word.text))continue;
     if(!Number.isFinite(word.start_time)||!Number.isFinite(word.end_time)||word.start_time<start||word.end_time>end||word.end_time<=word.start_time||segment.words.length&&word.start_time<segment.words.at(-1).start*1000)throw Error('ASR word has invalid time');
     segment.words.push({start:word.start_time/1000,end:word.end_time/1000,text:word.text.trim()});
    }
   }
   segments.push(segment);
  }
 }
 if(!segments.length)throw Error('ASR result has no spoken utterances');
 return {status:'complete',segments};
}

/** Make one flash request. Every failure retains an unknown charge outcome without a supported query or automatic retry. */
export async function recognizeFlashAsr(config,{id,url,file},fetcher=fetch){
 let audio;
 try{audio=file?{data:(await readFile(file)).toString('base64')}:{url};}
 catch(error){throw new AsrProviderError('flash','audio');}
 let response;
 try{response=await fetcher(endpoint+'/recognize/flash',{method:'POST',headers:{...headers(config,id),'X-Api-Resource-Id':'volc.bigasr.auc_turbo','X-Api-Sequence':'-1'},body:JSON.stringify({user:{uid:'muse-audio-transcribe'},audio,request:{model_name:'bigmodel',enable_itn:true,enable_punc:true,show_utterances:true}}),signal:AbortSignal.timeout(config.timeoutMs)});}
 catch(error){throw new AsrProviderError('flash','transport');}
 const code=response.headers.get('X-Api-Status-Code');
 if(!response.ok)throw new AsrProviderError('flash','http',response);
 if(code==='20000003')return {status:'silent'};
 if(code!=='20000000')throw new AsrProviderError('flash','response',response);
 let body;try{body=await response.json();}catch(error){throw new AsrProviderError('flash','json',response);}
 try{return normalizeResult(body);}catch(error){throw new AsrProviderError('flash','result',response);}
}

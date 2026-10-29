/** Volcengine recording-file v3 adapter. Credentials remain on the gateway. */
import {readFile} from 'node:fs/promises';
const endpoint='https://openspeech.bytedance.com/api/v3/auc/bigmodel';
const resource='volc.bigasr.auc';
const failureMessages={
 submit:{response:'ASR submit outcome unknown; retain the task ID and query it'},
 query:{response:'ASR query returned an unknown status; retain this task ID',transport:'ASR query failed; retry this task ID',http:'ASR query failed; retry this task ID',json:'ASR query returned invalid JSON',result:'ASR query failed; retry this task ID'},
 flash:{response:'ASR flash outcome unknown; automatic resubmission is disabled',json:'ASR flash response is invalid; automatic resubmission is disabled',result:'ASR flash response is invalid; automatic resubmission is disabled'},
};
/** Supplier codes observed denying every operation (submit, query and flash) for one credential set.
 * A denied credential cannot be repaired by retrying, resubmitting or switching resource ID, so these
 * stay distinguishable from an ordinary per-request rejection. Only observed codes are listed; an
 * unobserved 4xxxxxxx code keeps the ordinary rejection classification. */
const accountChannelCodes=new Set(['45000030']);
/** Guidance for a credential-level denial: no retry, resubmit or resource change resolves it. */
function accountChannelMessage(operation){
 return operation==='submit'?'ASR account channel blocked the submission; no charge outcome was returned and resubmission cannot succeed until the speech service is restored'
  :operation==='flash'?'ASR account channel blocked this request; automatic resubmission is disabled until the speech service is restored'
  :'ASR account channel blocked this query; the original task is retained and retrying cannot resolve the denial';
}

/**
 * Safe provider diagnostics. A rejection records a response, never a known charge outcome.
 * Only operation, reason, code, message, validated HTTP status, and numeric supplier code are retained.
 */
export class AsrProviderError extends Error{
 /**
  * @param {'submit'|'query'|'flash'} operation Provider operation that failed.
  * @param {'timeout'|'transport'|'http'|'response'|'json'|'result'|'audio'} reason Failure category selecting a fixed message.
  * @param {Response} [response] Supplier response supplying only status fields.
  */
 constructor(operation,reason,response){
  // Read the supplier status before choosing the message: an account denial gets its own guidance.
  const httpStatus=Number.isInteger(response?.status)&&response.status>=100&&response.status<=599?response.status:undefined;
  const rawCode=response?.headers.get('X-Api-Status-Code');
  const providerCode=typeof rawCode==='string'&&/^\d{5,10}$/.test(rawCode)?rawCode:undefined;
  const rejected=['response','http'].includes(reason)&&!(httpStatus>=500)&&(httpStatus>=400||providerCode!==undefined);
  // A known account/channel denial outranks the ordinary rejection: retrying cannot resolve it.
  const blocked=rejected&&accountChannelCodes.has(providerCode);
  super(blocked?accountChannelMessage(operation):failureMessages[operation][reason]??failureMessages[operation].response);
  // Stack frames contain gateway paths; durable diagnostics retain only the allowed fields.
  delete this.stack;
  this.operation=operation;this.reason=reason;
  if(httpStatus!==undefined)this.httpStatus=httpStatus;
  if(providerCode!==undefined)this.providerCode=providerCode;
  this.code=blocked?'account_channel_blocked':rejected?'provider_rejected':'provider_unavailable';
 }
}

function headers(config,id){return {'content-type':'application/json','X-Api-App-Key':config.appId,'X-Api-Access-Key':config.accessToken,'X-Api-Resource-Id':config.resourceId??resource,'X-Api-Request-Id':id};}

/** Submit one paid request. Every failure retains an unknown charge outcome and must be reconciled by query. */
export async function submitAsr(config,{id,url,language,format='mp3',purpose,durationSeconds},fetcher=fetch){
 const speakers=purpose==='screenplay'&&config.speakerDiarization?{enable_speaker_info:true,ssd_version:config.speakerDiarizationVersion,...config.speakerDiarizationVersion==='200'?{ssd_mode:durationSeconds>=config.speakerLongAudioSeconds?1:0}:{}}:{};
 let response;
 try{response=await fetcher(endpoint+'/submit',{method:'POST',headers:{...headers(config,id),'X-Api-Sequence':'-1'},body:JSON.stringify({user:{uid:'muse-audio-transcribe'},audio:{format,url,rate:16000,channel:1,...language==='zh'?{language:'zh-CN'}:{}},request:{model_name:'bigmodel',enable_itn:true,enable_punc:true,enable_ddc:false,show_utterances:true,...speakers,...language==='auto'?{enable_auto_lang:true}:{}}}),signal:AbortSignal.timeout(config.timeoutMs)});}
 catch(error){throw new AsrProviderError('submit',error?.name==='TimeoutError'?'timeout':'transport');}
 const code=response.headers.get('X-Api-Status-Code');
 if(response.ok&&['20000000','20000001','20000002'].includes(code))return;
 throw new AsrProviderError('submit','response',response);
}

/** Query an existing task, including after an uncertain submit. */
export async function queryAsr(config,id,fetcher=fetch){
 let response;
 try{response=await fetcher(endpoint+'/query',{method:'POST',headers:headers(config,id),body:'{}',signal:AbortSignal.timeout(config.timeoutMs)});}
 catch(error){throw new AsrProviderError('query',error?.name==='TimeoutError'?'timeout':'transport');}
 const code=response.headers.get('X-Api-Status-Code');
 if(!response.ok)throw new AsrProviderError('query','http',response);
 if(['20000001','20000002'].includes(code))return {status:'processing',queued:code==='20000002'};
 if(code==='20000003')return {status:'silent'};
 if(['45000006','45000092','55001010'].includes(code))return {status:'failed',providerCode:code};
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
   const identities=[row.speaker_id,row.additions?.speaker_id,row.additions?.speaker].filter(value=>value!==undefined);
   const speaker=identities[0];
   if(speaker!==undefined){
    if(identities.some(value=>typeof value!=='string'||!value.trim()||value!==speaker))throw Error('ASR speaker identity is invalid');
    segment.speaker_id=speaker;
   }
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
 try{response=await fetcher(endpoint+'/recognize/flash',{method:'POST',headers:{...headers(config,id),'X-Api-Resource-Id':'volc.bigasr.auc_turbo','X-Api-Sequence':'-1'},body:JSON.stringify({user:{uid:'muse-audio-transcribe'},audio,request:{model_name:'bigmodel',enable_itn:true,enable_punc:true,enable_ddc:false,show_utterances:true}}),signal:AbortSignal.timeout(config.timeoutMs)});}
 catch(error){throw new AsrProviderError('flash',error?.name==='TimeoutError'?'timeout':'transport');}
 const code=response.headers.get('X-Api-Status-Code');
 if(!response.ok)throw new AsrProviderError('flash','http',response);
 if(code==='20000003')return {status:'silent'};
 if(code!=='20000000')throw new AsrProviderError('flash','response',response);
 let body;try{body=await response.json();}catch(error){throw new AsrProviderError('flash','json',response);}
 try{return normalizeResult(body);}catch(error){throw new AsrProviderError('flash','result',response);}
}

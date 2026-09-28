/** Volcengine recording-file 1.0 adapter. Credentials remain on the gateway. */
const endpoint='https://openspeech.bytedance.com/api/v3/auc/bigmodel';
const resource='volc.bigasr.auc';

function headers(config,id){return {'content-type':'application/json','X-Api-App-Key':config.appId,'X-Api-Access-Key':config.accessToken,'X-Api-Resource-Id':resource,'X-Api-Request-Id':id};}

/** Submit one paid request. Any uncertain outcome must be reconciled by query. */
export async function submitAsr(config,{id,url,language},fetcher=fetch){
 let response;
 try{response=await fetcher(endpoint+'/submit',{method:'POST',headers:{...headers(config,id),'X-Api-Sequence':'-1'},body:JSON.stringify({user:{uid:'muse-audio-transcribe'},audio:{format:'mp3',url,rate:16000,channel:1},request:{model_name:'bigmodel',enable_itn:true,enable_punc:true,show_utterances:true,...language==='auto'?{enable_auto_lang:true}:{language}}}),signal:AbortSignal.timeout(config.timeoutMs)});}
 catch{throw Error('ASR submit outcome unknown; retain the task ID and query it');}
 const code=response.headers.get('X-Api-Status-Code');
 if(response.ok&&['20000000','20000001','20000002'].includes(code))return;
 throw Error('ASR submit outcome unknown; retain the task ID and query it');
}

/** Query an existing task, including after an uncertain submit. */
export async function queryAsr(config,id,fetcher=fetch){
 let response;
 try{response=await fetcher(endpoint+'/query',{method:'POST',headers:headers(config,id),body:'{}',signal:AbortSignal.timeout(config.timeoutMs)});}
 catch{throw Error('ASR query failed; retry this task ID');}
 const code=response.headers.get('X-Api-Status-Code');
 if(!response.ok)throw Error('ASR query failed; retry this task ID');
 if(['20000001','20000002'].includes(code))return {status:'processing'};
 if(code==='20000003')return {status:'silent'};
 if(code!=='20000000')throw Error('ASR query returned an unknown status; retain this task ID');
 let body;try{body=await response.json();}catch{throw Error('ASR query returned invalid JSON');}
 const utterances=body?.result?.utterances;
 if(!Array.isArray(utterances)||!utterances.length)throw Error('ASR result has no timed utterances');
 const segments=[];
 for(const row of utterances){const start=row?.start_time,end=row?.end_time,text=row?.text;
  if(!Number.isFinite(start)||start<0||!Number.isFinite(end)||end<=start||typeof text!=='string'||segments.length&&start<segments.at(-1).start*1000)throw Error('ASR utterance has invalid time or text');
  if(text.trim())segments.push({start:start/1000,end:end/1000,text:text.trim()});
 }
 if(!segments.length)throw Error('ASR result has no spoken utterances');
 return {status:'complete',segments};
}

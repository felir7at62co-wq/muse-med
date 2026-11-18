/** Fixed fal queue and CDN operations; credentials are never forwarded to media URLs or returned to callers. */
const fail=code=>Object.assign(new Error(code),{code,status:502});
const models={upscale:'fal-ai/seedvr/upscale/video',erase_subtitles:'bria/video/erase/prompt'};
const roots={upscale:'fal-ai/seedvr',erase_subtitles:'bria/video'};
function address(value){let url;try{url=new URL(value);}catch(error){throw fail('fal_invalid_url');}
 if(url.protocol!=='https:'||url.username||url.password||url.hash)throw fail('fal_invalid_url');return url;}
function media(value,hosts){const url=address(value);if(!hosts.includes(url.hostname))throw Object.assign(fail('fal_media_host_refused'),{origin:url.origin});return url.href;}
function transportFailure(error,code,url){return error?.code==='studio_outbound_rejected'
 ?Object.assign(fail('postproduction_outbound_not_allowed'),{origin:new URL(url).origin}):fail(code);}
function queueUrl(value,kind,id,status){const url=address(value),path='/'+roots[kind]+'/requests/'+encodeURIComponent(id)+(status?'/status':'');
 if(url.origin!=='https://queue.fal.run'||url.pathname!==path||url.search)throw fail('fal_queue_identity_refused');return url.href;}
async function body(response,maximum){if(!response.ok){await response.body?.cancel();throw fail('fal_http_failure');}
 if(!response.body)throw fail('fal_empty_response');const reader=response.body.getReader(),chunks=[];let bytes=0;
 try{for(;;){const part=await reader.read();if(part.done)break;bytes+=part.value.byteLength;if(bytes>maximum)throw fail('fal_response_limit');chunks.push(part.value);}}
 finally{await reader.cancel();reader.releaseLock();}return Buffer.concat(chunks,bytes);}
async function download(url,limits){let response;try{response=await fetch(media(url,limits.output_hosts),{redirect:'error',signal:AbortSignal.timeout(limits.http_timeout_ms)});}
 catch(error){throw transportFailure(error,'fal_download_unconfirmed',url);}return await body(response,limits.max_output_bytes);}
function create(key,limits){
 if(typeof key!=='string'||!key.trim()||/[\r\n]/.test(key))throw Object.assign(Error('postproduction_not_configured'),{code:'postproduction_not_configured',status:503});
 const request=async(url,method,input,authorized=true)=>{
  let response;try{response=await fetch(url,{method,redirect:'error',signal:AbortSignal.timeout(limits.http_timeout_ms),
   headers:{...authorized?{Authorization:'Key '+key}:{},...input===undefined?{}:{'Content-Type':'application/json'}},...input===undefined?{}:{body:JSON.stringify(input)}});}
  catch(error){throw transportFailure(error,'fal_transport_unconfirmed',url);}
  const bytes=await body(response,limits.json_bytes);try{return JSON.parse(bytes.toString('utf8'));}catch(error){throw fail('fal_invalid_json');}
 };
 return {
  upload:async(bytes,filename,contentType='video/mp4')=>{
   if(bytes.length>limits.max_input_bytes)throw fail('postproduction_input_limit');
   const issued=await request('https://rest.fal.ai/storage/auth/token?storage_type=fal-cdn-v3','POST',{});
   if(issued.token_type!=='Bearer'||typeof issued.token!=='string'||!issued.token||issued.token.length>4096||/[\r\n]/.test(issued.token))throw fail('fal_upload_token_invalid');
   const upload='https://v3.fal.media/files/upload';let response;
   try{response=await fetch(upload,{method:'POST',redirect:'error',signal:AbortSignal.timeout(limits.http_timeout_ms),
    headers:{'Content-Type':contentType,Authorization:'Bearer '+issued.token,'X-Fal-File-Name':filename},body:bytes});}
   catch(error){throw transportFailure(error,'fal_upload_unconfirmed',upload);}
   const uploaded=await body(response,limits.json_bytes);let result;
   try{result=JSON.parse(uploaded.toString('utf8'));}catch(error){throw fail('fal_invalid_json');}
   return media(result.access_url,limits.output_hosts);
  },
  submit:async(kind,input)=>{
   const result=await request('https://queue.fal.run/'+models[kind],'POST',input);
   if(typeof result.request_id!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(result.request_id))throw fail('fal_request_identity_missing');
   return {request_id:result.request_id,status_url:queueUrl(result.status_url,kind,result.request_id,true),response_url:queueUrl(result.response_url,kind,result.request_id,false)};
  },
  status:async(kind,row)=>{
   const result=await request(queueUrl(row.status_url,kind,row.request_id,true),'GET');
   if(!['IN_QUEUE','IN_PROGRESS','COMPLETED'].includes(result.status))throw fail('fal_unknown_status');return result.status;
  },
  result:async(kind,row)=>{
   const result=await request(queueUrl(row.response_url,kind,row.request_id,false),'GET');
   return {url:media(result.video?.url,limits.output_hosts),seed:Number.isSafeInteger(result.seed)?result.seed:null};
  },
  download:async url=>await download(url,limits),
 };
}
module.exports={create,models,download};

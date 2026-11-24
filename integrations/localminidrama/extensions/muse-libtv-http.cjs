/** Documented LibTV Agent-IM HTTP operations; media requests never carry the access key. */
const fail=(code,status=502)=>Object.assign(Error(code),{code,status});
function limits(cfg){
 const c={json_bytes:2097152,max_upload_bytes:33554432,max_media_bytes:268435456,http_timeout_ms:120000,media_timeout_ms:180000,max_message_chars:60000,max_messages:500,max_references:10,
  api_origins:['https://im.liblib.tv'],media_origins:['https://libtv-res.liblib.art'],trusted_local_origins:[],...cfg.muse_libtv};
 for(const key of ['json_bytes','max_upload_bytes','max_media_bytes','http_timeout_ms','media_timeout_ms','max_message_chars','max_messages','max_references'])if(!Number.isSafeInteger(c[key])||c[key]<1)throw fail('libtv_invalid_limits',503);
 if(c.json_bytes>8388608||c.max_upload_bytes>67108864||c.max_media_bytes>536870912||c.http_timeout_ms>900000||c.media_timeout_ms>3600000||c.max_message_chars>200000||c.max_messages>5000||c.max_references>50)throw fail('libtv_invalid_limits',503);
 for(const key of ['api_origins','media_origins','trusted_local_origins'])if(!Array.isArray(c[key])||c[key].some(s=>{try{const u=new URL(s);return u.origin!==s||u.username||u.password||u.protocol!=='https:'&&!c.trusted_local_origins.includes(s)}catch(error){return true}}))throw fail('libtv_invalid_origins',503);
 return c;
}
function url(value,allowed,c){let u;try{u=new URL(value)}catch(error){throw fail('libtv_invalid_url',400)}
 if(u.href.length>8192||u.username||u.password||u.hash||!allowed.includes(u.origin)||u.protocol!=='https:'&&!c.trusted_local_origins.includes(u.origin))throw fail('libtv_origin_refused',400);return u;
}
async function bytes(response,maximum){
 if(!response.ok){await response.body?.cancel();throw fail('libtv_http_rejected',response.status===401||response.status===403?401:502)}
 if(!response.body)throw fail('libtv_empty_response');const reader=response.body.getReader(),parts=[];let total=0;
 try{for(;;){const part=await reader.read();if(part.done)break;total+=part.value.byteLength;if(total>maximum)throw fail('libtv_response_limit');parts.push(part.value)}}
 finally{await reader.cancel();reader.releaseLock()}return Buffer.concat(parts,total);
}
function identity(value){if(typeof value!=='string'||!value||value.length>128||/[\u0000-\u0020/\\?#]/u.test(value))throw fail('libtv_invalid_remote_identity');return value}
function create(config,c){
 const origin=url(config.base_url,c.api_origins,c);if(origin.pathname!=='/'||origin.search)throw fail('libtv_api_origin_required',400);
 if(typeof config.api_key!=='string'||!config.api_key.trim()||/[\r\n]/.test(config.api_key))throw fail('libtv_not_configured',503);
 async function request(path,method,input){
  const endpoint=new URL(path,origin);if(endpoint.origin!==origin.origin)throw fail('libtv_origin_refused',400);
  const form=input instanceof FormData;let response;
  try{response=await fetch(endpoint,{method,redirect:'error',signal:AbortSignal.timeout(c.http_timeout_ms),headers:{Authorization:'Bearer '+config.api_key,...input!==undefined&&!form?{'Content-Type':'application/json'}:{}},...input===undefined?{}:{body:form?input:JSON.stringify(input)}})}
  catch(error){throw fail(error.code==='studio_outbound_rejected'?'libtv_outbound_not_allowed':'libtv_transport_unconfirmed')}
  const raw=await bytes(response,c.json_bytes);let parsed;try{parsed=JSON.parse(raw.toString('utf8'))}catch(error){throw fail('libtv_invalid_json')}
  if(!parsed||typeof parsed.data!=='object'||parsed.data===null||Array.isArray(parsed.data))throw fail('libtv_invalid_response');return parsed.data;
 }
 return {
  bind:async(session)=>{const v=await request('/openapi/session','POST',session===undefined?{}:{sessionId:identity(session)}),sessionId=identity(v.sessionId);if(session!==undefined&&sessionId!==session)throw fail('libtv_session_changed');return {session_id:sessionId,project_id:identity(v.projectUuid)}},
  send:async(session,message)=>{const v=await request('/openapi/session','POST',{sessionId:identity(session),message});if(identity(v.sessionId)!==session)throw fail('libtv_session_changed');return {session_id:session,project_id:identity(v.projectUuid)}},
  observe:async(session,seq=0)=>{const v=await request('/openapi/session/'+encodeURIComponent(identity(session))+(seq>0?'?afterSeq='+seq:''),'GET');if(!Array.isArray(v.messages)||v.messages.length>c.max_messages)throw fail('libtv_invalid_messages');return v.messages},
  upload:async(data,name,mime)=>{if(data.length>c.max_upload_bytes||!/^image\/|^video\//.test(mime))throw fail('libtv_upload_refused',400);const form=new FormData();form.set('accessKey',config.api_key);form.set('file',new Blob([data],{type:mime}),name);const result=await request('/openapi/upload','POST',form);return url(result.url,c.media_origins,c).href},
 };
}
async function download(value,c){const target=url(value,c.media_origins,c);let response;
 try{response=await fetch(target,{redirect:'error',signal:AbortSignal.timeout(c.media_timeout_ms)})}catch(error){throw fail(error.code==='studio_outbound_rejected'?'libtv_outbound_not_allowed':'libtv_download_unconfirmed')}
 return await bytes(response,c.max_media_bytes);
}
module.exports={limits,url,identity,create,download,fail};

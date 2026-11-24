/** Account-authenticated web search; official credentials remain server-owned. */
import {scheduleSessionExpiry} from './session-expiry.mjs';

const ENDPOINT='https://api.deepseek.com/v1/tools/search';
const CLIENT_RESPONSE_BYTES=1048576;
const plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
class WebSearchError extends Error{constructor(status,code){super(code);this.status=status;this.code=code;}}
const failure=(status,code)=>new WebSearchError(status,code);

/** Resolve bounded per-account admission and transport limits from deployment settings.
 * @param {object} env Deployment environment without any credential lookup.
 * @returns {object} Validated search policy.
 */
export function resolveWebSearchPolicy(env=process.env){
 const number=(name,fallback,min,max)=>{const raw=env[name],value=raw===undefined?fallback:Number(raw);if(!Number.isSafeInteger(value)||value<min||value>max)throw Error('Invalid Muse web search policy: '+name);return value;};
 const enabled=env.MUSE_WEB_SEARCH_ENABLED;if(enabled!==undefined&&!['true','false'].includes(enabled))throw Error('Invalid Muse web search policy: MUSE_WEB_SEARCH_ENABLED');
 return {enabled:enabled!=='false',timeoutMs:number('MUSE_WEB_SEARCH_TIMEOUT_MS',30000,1,60000),
  requestRatePerMinute:number('MUSE_WEB_SEARCH_REQUESTS_PER_MINUTE',30,1,10000),
  maxConcurrentPerUser:number('MUSE_WEB_SEARCH_MAX_CONCURRENT_PER_USER',4,1,100),
  maxTrackedUsers:number('MUSE_WEB_SEARCH_MAX_TRACKED_USERS',10000,1,100000),
  maxRequestBytes:number('MUSE_WEB_SEARCH_MAX_REQUEST_BYTES',8192,256,65536),
  maxResponseBytes:number('MUSE_WEB_SEARCH_MAX_RESPONSE_BYTES',1048576,256,4194304),
  maxResults:number('MUSE_WEB_SEARCH_MAX_RESULTS',50,1,50)};
}

/** Resolve only a configured official DeepSeek credential, never an Ark namesake.
 * @param {object} globalModels Existing private model directory service.
 * @returns {string|undefined} Server-only credential, or absence of a trusted official route.
 */
export function resolveOfficialSearchKey(globalModels){
 const config=globalModels?.searchCredential?.();if(config?.credentialClass!=='deepseekOfficial')return undefined;
 let url;try{url=new URL(config.baseURL);}catch{return undefined;}
 if(url.protocol!=='https:'||url.hostname!=='api.deepseek.com'||url.port||url.username||url.password||url.search||url.hash||!['/','/v1','/v1/'].includes(url.pathname))return undefined;
 return typeof config.apiKey==='string'&&config.apiKey.length>0&&config.apiKey.length<=4096&&!/[^\x21-\x7e]/.test(config.apiKey)?config.apiKey:undefined;
}

function readInput(req,limit,signal){
 return new Promise((resolve,reject)=>{
  const chunks=[];let bytes=0;
  const cleanup=()=>{req.off('data',data);req.off('end',end);req.off('error',error);signal.removeEventListener('abort',abort);};
  const error=()=>{cleanup();reject(failure(400,'web_search_invalid_request'));};
  const abort=()=>{cleanup();req.resume();reject(failure(504,'web_search_timeout'));};
  const data=chunk=>{bytes+=chunk.length;if(bytes>limit){cleanup();req.resume();reject(failure(413,'web_search_request_too_large'));return;}chunks.push(chunk);};
  const end=()=>{cleanup();try{resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));}catch{reject(failure(400,'web_search_invalid_request'));}};
  if(signal.aborted){abort();return;}req.on('data',data);req.once('end',end);req.once('error',error);signal.addEventListener('abort',abort,{once:true});
 });
}

function cancelBody(body,reason){
 try{if(body)void Promise.resolve(body.cancel(reason)).catch(error=>{void error;});}catch(error){void error;}
}

function fetchResponse(task,signal){
 return new Promise((resolve,reject)=>{
  let finished=false;
  const cleanup=()=>signal.removeEventListener('abort',abort);
  const abort=()=>{if(finished)return;finished=true;cleanup();reject(signal.reason??failure(504,'web_search_timeout'));};
  Promise.resolve(task).then(response=>{if(finished){cancelBody(response.body);return;}finished=true;cleanup();resolve(response);},error=>{if(finished)return;finished=true;cleanup();reject(error);});
  if(signal.aborted)abort();else signal.addEventListener('abort',abort,{once:true});
 });
}

async function readResponse(response,limit,signal){
 const length=response.headers.get('content-length');
 if(length!==null&&Number(length)>limit){cancelBody(response.body);throw failure(502,'web_search_invalid_response');}
 if(!response.body)throw failure(502,'web_search_invalid_response');
 const reader=response.body.getReader(),chunks=[];let size=0;
 const abort=()=>cancelBody(reader,signal.reason);
 signal.addEventListener('abort',abort,{once:true});
 try{
  if(signal.aborted)abort();
  while(true){const {done,value}=await reader.read();signal.throwIfAborted();if(done)break;size+=value.byteLength;if(size>limit){cancelBody(reader);throw failure(502,'web_search_invalid_response');}chunks.push(Buffer.from(value));}
 }finally{signal.removeEventListener('abort',abort);reader.releaseLock();}
 try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw failure(502,'web_search_invalid_response');}
}

function normalizedResults(value,count,key){
 if(!plain(value)||!Array.isArray(value.results))throw failure(502,'web_search_invalid_response');
 const safe=(text,max)=>typeof text==='string'&&!text.includes(key)&&!text.includes(encodeURIComponent(key))?text.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g,'').slice(0,max):undefined;
 const results=[];
 for(const row of value.results){
  if(!plain(row))continue;const address=safe(row.url,4096);let url;
  try{url=new URL(address);}catch{continue;}
  if(!['http:','https:'].includes(url.protocol)||url.username||url.password)continue;
  const result={url:url.href};
  for(const [name,max] of [['title',512],['snippet',2048],['summary',8192]]){const text=safe(row[name],max);if(text!==undefined)result[name]=text;}
  const date=safe(row.date,80);if(date!==undefined&&Number.isFinite(Date.parse(date)))result.date=date;
  results.push(result);if(results.length===count)break;
 }
 return {results};
}

/** Own search admission, cancellation and bounded official requests for valid Muse sessions.
 * @param {object} options Private model directory, validated policy, transport and session verifier.
 * @returns {object} Authenticated route handler plus token revocation and awaited shutdown.
 */
export function createWebSearch({globalModels,policy=resolveWebSearchPolicy(),fetcher=fetch,now=Date.now,validSession=()=>true}={}){
 const expected=resolveWebSearchPolicy({
  MUSE_WEB_SEARCH_ENABLED:String(policy.enabled),MUSE_WEB_SEARCH_TIMEOUT_MS:policy.timeoutMs,
  MUSE_WEB_SEARCH_REQUESTS_PER_MINUTE:policy.requestRatePerMinute,MUSE_WEB_SEARCH_MAX_CONCURRENT_PER_USER:policy.maxConcurrentPerUser,
  MUSE_WEB_SEARCH_MAX_TRACKED_USERS:policy.maxTrackedUsers,MUSE_WEB_SEARCH_MAX_REQUEST_BYTES:policy.maxRequestBytes,
  MUSE_WEB_SEARCH_MAX_RESPONSE_BYTES:policy.maxResponseBytes,MUSE_WEB_SEARCH_MAX_RESULTS:policy.maxResults,
 });
 const users=new Map(),active=new Map(),pending=new Set();let closed=false;
 function answer(res,status,value){if(res.destroyed||res.writableEnded)return;res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff',...status===429?{'retry-after':'60'}:{}});res.end(JSON.stringify(value));}
 const deny=(res,status,code)=>answer(res,status,{error:'Muse web search request failed',error_code:code});
 function revoke(token){for(const entry of active.get(token)??[]){entry.revoked=true;entry.controller.abort();}}
 async function run(req,res,session){
  if(!session||!validSession(session)||session.expiry<=now()){deny(res,401,'account_session_expired');return;}
  if(req.method!=='POST'){deny(res,405,'web_search_method_not_allowed');return;}
  if(closed||!expected.enabled){deny(res,503,'web_search_unavailable');return;}
  if(!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type']??'')){deny(res,400,'web_search_invalid_request');return;}
  const clock=now();let user=users.get(session.id);
  if(!user){for(const [id,state]of users)if(state.active===0&&clock-state.start>=60000)users.delete(id);if(users.size>=expected.maxTrackedUsers){deny(res,429,'web_search_rate_limited');return;}user={start:clock,count:0,active:0};users.set(session.id,user);}
  if(clock-user.start>=60000){user.start=clock;user.count=0;}
  if(user.count>=expected.requestRatePerMinute||user.active>=expected.maxConcurrentPerUser){deny(res,429,'web_search_rate_limited');return;}
  user.count++;user.active++;
  const controller=new AbortController(),entry={controller,revoked:false};let timedOut=false;
  const onClose=()=>controller.abort(),timeout=setTimeout(()=>{timedOut=true;controller.abort();},expected.timeoutMs);timeout.unref?.();
  const cancelExpiry=scheduleSessionExpiry(session.expiry,()=>revoke(session.token),{now});
  let entries=active.get(session.token);if(!entries){entries=new Set();active.set(session.token,entries);}entries.add(entry);
  req.once('aborted',onClose);res.once('close',onClose);
  try{
   const input=await readInput(req,expected.maxRequestBytes,controller.signal);
   if(!plain(input)||Object.keys(input).some(name=>!['query','maxResults'].includes(name))||typeof input.query!=='string'||!input.query.trim()||Array.from(input.query).length>128)throw failure(400,'web_search_invalid_request');
   const count=input.maxResults===undefined?Math.min(10,expected.maxResults):input.maxResults;
   if(!Number.isSafeInteger(count)||count<1||count>expected.maxResults)throw failure(400,'web_search_invalid_request');
   const key=resolveOfficialSearchKey(globalModels);if(!key)throw failure(503,'web_search_unavailable');
   if(!validSession(session))throw failure(401,'account_session_expired');
   const response=await fetchResponse(fetcher(ENDPOINT,{method:'POST',redirect:'error',credentials:'omit',headers:{'content-type':'application/json',authorization:'Bearer '+key},body:JSON.stringify({query:input.query,count}),signal:controller.signal}),controller.signal);
   if(response.status!==200){cancelBody(response.body);throw failure(response.status===429?429:502,response.status===429?'web_search_rate_limited':'web_search_upstream_failed');}
   if(!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type')??'')){cancelBody(response.body);throw failure(502,'web_search_invalid_response');}
   const result=normalizedResults(await readResponse(response,expected.maxResponseBytes,controller.signal),count,key);
   if(Buffer.byteLength(JSON.stringify(result))>CLIENT_RESPONSE_BYTES)throw failure(502,'web_search_invalid_response');
   controller.signal.throwIfAborted();if(!validSession(session))throw failure(401,'account_session_expired');
   answer(res,200,result);
  }catch(error){
   if(entry.revoked||!validSession(session))deny(res,401,'account_session_expired');
   else if(closed)deny(res,503,'web_search_unavailable');
   else if(timedOut)deny(res,504,'web_search_timeout');
   else deny(res,error instanceof WebSearchError?error.status:502,error instanceof WebSearchError?error.code:'web_search_upstream_failed');
  }finally{
   clearTimeout(timeout);cancelExpiry();req.off('aborted',onClose);res.off('close',onClose);user.active--;entries.delete(entry);if(!entries.size)active.delete(session.token);
  }
 }
 return {handle(req,res,session){const task=run(req,res,session);pending.add(task);void task.then(()=>pending.delete(task),()=>pending.delete(task));return task;},revoke,
  async close(){closed=true;for(const entries of active.values())for(const entry of entries)entry.controller.abort();await Promise.allSettled(pending);users.clear();}};
}

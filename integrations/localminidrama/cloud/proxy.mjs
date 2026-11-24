/** Same-origin streaming production studio access selected only by a verified Muse login. */
import http from 'node:http';
import {Transform} from 'node:stream';
import {workerPath,StudioError} from './security.mjs';

const requestHeaders=new Set(['accept','accept-language','accept-encoding','content-type','content-length','content-encoding','range','if-range','if-none-match','if-modified-since','cache-control','user-agent','x-muse-operation-id']);
const hopHeaders=new Set(['connection','keep-alive','proxy-authenticate','proxy-authorization','te','trailer','transfer-encoding','upgrade','set-cookie','x-muse-studio-worker','x-powered-by']);
const answer=(res,status,code)=>{if(res.headersSent){res.destroy();return;}res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff',...status===429||status===503?{'retry-after':'1'}:{}});res.end(JSON.stringify({error:{code}}));};
function responseHeaders(headers,target){
 const dropped=new Set([...hopHeaders,...String(headers.connection??'').toLowerCase().split(',').map(value=>value.trim())]),result={};
 for(const [key,value]of Object.entries(headers))if(!dropped.has(key)&&!key.startsWith('x-muse-')&&value!==undefined)result[key]=value;
 for(const key of ['location','content-location'])if(typeof result[key]==='string'){const url=new URL(result[key],target);if(url.origin===target.origin)result[key]='/studio'+url.pathname+url.search+url.hash;}
 result['cache-control']='private, no-store';result['x-content-type-options']='nosniff';return result;
}

/** Serve /studio routes after the account gateway's existing authentication and Origin checks.
 * @param {import('node:http').IncomingMessage} req Account-authenticated request.
 * @param {import('node:http').ServerResponse} res Response carrier.
 * @param {object} options Runtime, verified account session, current authorization and configured Origin.
 * @returns {Promise<boolean>} Whether this module owns the route; settles after stream teardown.
 */
export async function studioRoute(req,res,{runtime,session,isAuthorized,publicOrigin,signal}){
 const path=req.url?.split('?')[0];if(path!=='/studio'&&!path?.startsWith('/studio/'))return false;
 if(!runtime){answer(res,404,'studio_not_configured');return true;}
 let lease;
 try{
  if(!session||!isAuthorized()||signal?.aborted){answer(res,401,'account_session_expired');return true;}
  const suffix=req.url.slice('/studio'.length),stripped=workerPath(suffix.startsWith('?')?'/'+suffix:suffix||'/');
  if(/^\/api\/v1\/muse\/libtv-postproduction\/internal(?:\/|$)/i.test(decodeURIComponent(stripped.split('?')[0])))throw new StudioError('studio_internal_route_refused',403);
  const write=!['GET','HEAD','OPTIONS'].includes(req.method)||/^\/api\/v1\/storyboards\/episode\/[^/]+\/generate(?:\?|$)/i.test(stripped);
  if(write&&req.headers.origin!==publicOrigin&&!(req.method==='GET'&&req.headers['sec-fetch-site']==='same-origin')){answer(res,403,'studio_origin_rejected');return true;}
  if(path==='/studio'){
   if(!['GET','HEAD'].includes(req.method))throw new StudioError('studio_invalid_path',400);
   res.writeHead(303,{location:'/studio/'+(req.url.includes('?')?'?'+req.url.split('?').slice(1).join('?'):''),'cache-control':'no-store'});res.end();return true;
  }
  const length=req.headers['content-length'];if(length!==undefined&&!/^\d+$/.test(length))throw new StudioError('studio_invalid_request',400);
  const requestBytes=write?(length===undefined?runtime.limits.maxRequestBytes:Number(length)):0;
  if(!Number.isSafeInteger(requestBytes)||requestBytes>runtime.limits.maxRequestBytes)throw new StudioError('studio_request_too_large',413);
  lease=await runtime.acquire(session.id,{write,requestBytes});if(req.aborted||req.destroyed||res.destroyed)return true;if(!isAuthorized()||signal?.aborted)throw new StudioError('account_session_expired',401);
  const headers={};for(const [key,value]of Object.entries(req.headers))if(requestHeaders.has(key)&&value!==undefined)headers[key]=value;
  headers.host=lease.target.host;headers.origin=publicOrigin;headers['x-muse-studio-worker']=lease.token;
  await new Promise(resolve=>{
   let upstream,response,settled=false,bytes=0;
   const meter=new Transform({transform(chunk,encoding,callback){bytes+=chunk.length;if(bytes>runtime.limits.maxRequestBytes)callback(new StudioError('studio_request_too_large',413));else callback(null,chunk);}});
   const visible=new Transform({transform(chunk,encoding,callback){if(!isAuthorized()||signal?.aborted)callback(new StudioError('account_session_expired',401));else callback(null,chunk);}});
   const stopped=stream=>{if(!stream||stream.closed)return Promise.resolve();return new Promise(resolve=>{stream.once('close',resolve);stream.destroy();});};
   const finish=()=>{if(settled)return;settled=true;clearTimeout(timeout);req.off('aborted',abort);res.off('close',abort);res.off('finish',finish);signal?.removeEventListener('abort',revoked);req.unpipe(meter);response?.unpipe(visible);visible.unpipe(res);if(!req.destroyed)req.resume();void Promise.all([stopped(meter),stopped(visible),stopped(response),stopped(upstream)]).then(()=>resolve());};
   const abort=()=>{if(!res.writableFinished)res.destroy();finish();};
   const failed=error=>{if(settled)return;answer(res,error instanceof StudioError?error.status:502,error instanceof StudioError?error.code:'studio_upstream_unavailable');finish();};
   const revoked=()=>failed(new StudioError('account_session_expired',401));
   const timeout=setTimeout(()=>failed(new StudioError('studio_request_timeout',504)),runtime.limits.requestTimeoutMs);
   req.once('aborted',abort);res.once('close',abort);res.once('finish',finish);meter.once('error',failed);visible.once('error',failed);signal?.addEventListener('abort',revoked,{once:true});
   if(signal?.aborted){revoked();return;}
   upstream=http.request({hostname:'127.0.0.1',port:lease.target.port,path:stripped,method:req.method,headers},out=>{
    response=out;try{if(!isAuthorized()){out.resume();failed(new StudioError('account_session_expired',401));return;}
     res.writeHead(out.statusCode,responseHeaders(out.headers,lease.target));out.once('error',failed);out.pipe(visible).pipe(res);
    }catch(error){out.resume();failed(error);}
   });
   upstream.once('error',failed);req.pipe(meter).pipe(upstream);
  });
 }catch(error){answer(res,error instanceof StudioError?error.status:503,error instanceof StudioError?error.code:'studio_unavailable');}
 finally{lease?.release();}
 return true;
}

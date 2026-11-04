import http from 'node:http';
import {Transform} from 'node:stream';
import {readFile,lstat} from 'node:fs/promises';
import {isAbsolute} from 'node:path';

/** Create a bounded streaming gateway to the separate loopback market profile.
 * @param {object} config Validated endpoint policy and private secret path.
 * @returns {Promise<object>} Route handler and owned-connection teardown.
 */
export async function createMarketProxy(config){
 const url=new URL(config.upstream);
 if(url.protocol!=='http:'||url.hostname!=='127.0.0.1'||url.username||url.password||url.pathname!=='/'||url.search||url.hash||!isAbsolute(config.secretFile)
  ||!Number.isSafeInteger(config.archiveBytes)||config.archiveBytes<1024||config.archiveBytes>64*1024*1024
  ||!Number.isSafeInteger(config.requestTimeoutMs)||config.requestTimeoutMs<1000||config.requestTimeoutMs>300000)throw Error('Invalid market proxy policy');
 const metadata=await lstat(config.secretFile);
 if(!metadata.isFile()||metadata.isSymbolicLink()||process.platform!=='win32'&&(metadata.mode&0o077)!==0)throw Error('Market gateway secret must be private');
 const secret=(await readFile(config.secretFile,'utf8')).trim();if(!/^[A-Za-z0-9_-]{32,256}$/.test(secret))throw Error('Invalid market gateway secret');
 const connections=new Set();let closed=false;
 const handle=async(req,res,actor,prepared)=>{
  if(closed){res.writeHead(503);res.end();return;}
  await new Promise(resolve=>{
   const headers={authorization:'Bearer '+secret,...actor?{'x-muse-market-actor':Buffer.from(JSON.stringify({id:actor.id,username:actor.username,admin:actor.admin})).toString('base64url')}:{}};
   for(const key of ['content-type','content-length','x-market-publisher','idempotency-key'])if(typeof req.headers[key]==='string')headers[key]=req.headers[key];
   if(prepared)headers['content-length']=String(prepared.byteLength);
   let upstream,finished=false,bytes=0;const maximum=req.url.split('?')[0].endsWith('/uploads')?config.archiveBytes:16384;
   const request=http.request(new URL(req.url,url),{method:req.method,headers},response=>{
    upstream=response;
    const output={'cache-control':'no-store','x-content-type-options':'nosniff'};
    for(const key of ['content-type','content-length','content-disposition','x-content-sha256'])if(response.headers[key]!==undefined)output[key]=response.headers[key];
    res.writeHead(response.statusCode,output);response.on('error',()=>res.destroy());response.pipe(res);
   });
   const cleanup=()=>{if(finished)return;finished=true;clearTimeout(timer);connections.delete(cancel);body.destroy();request.destroy();upstream?.destroy();resolve();};
   const fail=status=>{if(!res.headersSent){res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify({error:status===413?'request-too-large':'market-unavailable'}));}else res.destroy();cleanup();};
   const cancel=()=>fail(503);
   const body=new Transform({transform(chunk,encoding,callback){bytes+=chunk.length;callback(bytes>maximum?Object.assign(Error('request-too-large'),{status:413}):null,chunk);}});
   const timer=setTimeout(cancel,config.requestTimeoutMs);timer.unref();connections.add(cancel);
   request.on('error',()=>fail(503));body.on('error',error=>{req.unpipe(body);req.resume();fail(error.status||503);});
   req.on('aborted',cleanup);res.once('close',cleanup);res.once('finish',cleanup);
   if(prepared)request.end(prepared);else req.pipe(body).pipe(request);
  });
 };
 return {handle,close:async()=>{closed=true;for(const cancel of [...connections])cancel();}};
}

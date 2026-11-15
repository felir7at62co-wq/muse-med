/** Bounded account-gateway transport to the private loopback Skill catalog. */
import http from 'node:http';
import {Transform} from 'node:stream';
import {readFile,lstat} from 'node:fs/promises';
import {isAbsolute} from 'node:path';

/** Whether a raw request target is an unambiguous market origin-form path.
 * @param {unknown} target Raw HTTP request target, before URL normalization.
 * @returns {boolean} Whether the configured catalog can receive this path unchanged.
 */
export function validMarketRequestTarget(target){
 return typeof target==='string'&&target.startsWith('/api/market/v1/')&&!/[\\#\s\u0000-\u001f\u007f]/u.test(target);
}

function positive(value,maximum){return Number.isSafeInteger(value)&&value>0&&value<=maximum;}
function length(value){return typeof value==='string'&&/^\d+$/u.test(value)&&Number.isSafeInteger(Number(value))?Number(value):undefined;}
function closed(stream){return stream.closed?Promise.resolve():new Promise(resolve=>stream.once('close',resolve));}

/** Create a transport whose complete request, response and lifetime limits are explicit.
 * @param {object} config Loopback endpoint, private secret file, byte budgets, timeout and gateway rate.
 * @returns {Promise<object>} Policy, request handler and idempotent quiescent close operation.
 */
export async function createMarketProxy(config){
 const keys=['upstream','secretFile','archiveBytes','jsonRequestBytes','jsonResponseBytes','requestTimeoutMs','requestRatePerMinute'];
 if(!config||typeof config!=='object'||Array.isArray(config)||Object.keys(config).sort().join(',')!==keys.sort().join(','))throw Error('Invalid market proxy policy');
 let endpoint;
 try{endpoint=new URL(config.upstream);}catch{throw Error('Invalid market proxy policy');}
 if(endpoint.protocol!=='http:'||endpoint.hostname!=='127.0.0.1'||endpoint.username||endpoint.password||endpoint.pathname!=='/'||endpoint.search||endpoint.hash
  ||typeof config.secretFile!=='string'||!isAbsolute(config.secretFile)
  ||!positive(config.archiveBytes,64*1024*1024)||!positive(config.jsonRequestBytes,64*1024*1024)||!positive(config.jsonResponseBytes,64*1024*1024)
  ||!positive(config.requestTimeoutMs,300000)||!positive(config.requestRatePerMinute,10000))throw Error('Invalid market proxy policy');
 const metadata=await lstat(config.secretFile);
 if(!metadata.isFile()||metadata.isSymbolicLink()||metadata.size>1024||process.platform!=='win32'&&(metadata.mode&0o077)!==0)throw Error('Market gateway secret must be private');
 const secret=(await readFile(config.secretFile,'utf8')).trim();
 if(!/^[A-Za-z0-9_-]{32,256}$/u.test(secret))throw Error('Invalid market gateway secret');
 const policy=Object.freeze({...config}),operations=new Set();let stopped=false,completion;
 function answer(res,status,error){
  if(res.destroyed)return;
  if(res.headersSent){res.destroy();return;}
  for(const name of ['content-length','content-disposition','x-content-sha256'])res.removeHeader(name);
  res.writeHead(status,{'content-type':'application/json','cache-control':'no-store','connection':'close','x-content-type-options':'nosniff'});
  res.end(JSON.stringify({error}));
 }
 async function handle(req,res,actor,prepared,deadline=performance.now()+policy.requestTimeoutMs){
  if(stopped){req.resume();answer(res,503,'market-unavailable');return;}
  const target=req.url;
  if(!validMarketRequestTarget(target)){req.resume();answer(res,400,'invalid-request');return;}
  const remaining=deadline-performance.now();
  if(remaining<=0){req.resume();answer(res,504,'market-timeout');return;}
  const pathname=target.split('?')[0],requestLimit=pathname.endsWith('/uploads')?policy.archiveBytes:policy.jsonRequestBytes;
  const responseLimit=pathname.endsWith('/download')?policy.archiveBytes:policy.jsonResponseBytes;
  const advertised=req.headers['content-length']===undefined?undefined:length(req.headers['content-length']);
  if(req.headers['content-length']!==undefined&&advertised===undefined){req.resume();answer(res,400,'invalid-request');return;}
  if((advertised??0)>requestLimit||(prepared?.byteLength??0)>requestLimit){req.resume();answer(res,413,'request-too-large');return;}
  const headers={authorization:'Bearer '+secret};
  if(actor!==null&&actor!==undefined)headers['x-muse-market-actor']=Buffer.from(JSON.stringify({id:actor.id,username:actor.username,admin:actor.admin})).toString('base64url');
  for(const key of ['content-type','content-length','x-market-publisher','idempotency-key'])if(typeof req.headers[key]==='string')headers[key]=req.headers[key];
  if(prepared!==undefined)headers['content-length']=String(prepared.byteLength);
  let resolveDone;
  const done=new Promise(resolve=>{resolveDone=resolve;});
  let request,upstream,responseClosed,timer,settled=false,requestBytes=0,responseBytes=0;
  const body=new Transform({transform(chunk,encoding,callback){requestBytes+=chunk.length;callback(requestBytes>requestLimit?Object.assign(Error('request-too-large'),{status:413}):null,chunk);}});
  const output=new Transform({transform(chunk,encoding,callback){responseBytes+=chunk.length;callback(responseBytes>responseLimit?Error('response-too-large'):null,chunk);}});
  const bodyClosed=closed(body),outputClosed=closed(output);
  const operation={done,cancel:()=>fail(503,'market-unavailable')};operations.add(operation);
  function cleanup(){
   if(settled)return;settled=true;clearTimeout(timer);
   req.unpipe(body);req.off('aborted',aborted);req.off('error',aborted);
   res.off('finish',cleanup);res.off('close',aborted);req.resume();
   body.destroy();output.destroy();upstream?.destroy();request?.destroy();
   void Promise.all([bodyClosed,outputClosed,...request?[closed(request)]:[],...responseClosed?[responseClosed]:[]]).then(()=>{
    operations.delete(operation);resolveDone();
   });
  }
  function fail(status,error){if(settled)return;answer(res,status,error);cleanup();}
  function aborted(){cleanup();}
  body.on('error',error=>fail(error.status??503,error.status===413?'request-too-large':'market-unavailable'));
  output.on('error',()=>fail(502,'response-too-large'));
  req.once('aborted',aborted);req.once('error',aborted);res.once('finish',cleanup);res.once('close',aborted);
  try{
   request=http.request({hostname:endpoint.hostname,port:endpoint.port||80,path:target,method:req.method,headers,agent:false},response=>{
    if(settled){response.destroy();return;}
    upstream=response;responseClosed=closed(response);
    response.on('error',()=>fail(502,'market-unavailable'));
    response.once('aborted',()=>fail(502,'market-unavailable'));
    const advertised=response.headers['content-length']===undefined?undefined:length(response.headers['content-length']);
    if(response.headers['content-length']!==undefined&&advertised===undefined
     ||(advertised??0)>responseLimit||response.headers['content-encoding']&&response.headers['content-encoding']!=='identity'){
     fail(502,'response-too-large');return;
    }
    res.statusCode=response.statusCode;
    res.setHeader('cache-control','no-store');res.setHeader('x-content-type-options','nosniff');
    for(const key of ['content-type','content-length','content-disposition','x-content-sha256'])if(typeof response.headers[key]==='string')res.setHeader(key,response.headers[key]);
    response.pipe(output).pipe(res);
   });
   request.on('error',()=>fail(503,'market-unavailable'));
   timer=setTimeout(()=>fail(504,'market-timeout'),remaining);timer.unref();
   if(prepared!==undefined)request.end(prepared);else req.pipe(body).pipe(request);
  }catch{fail(503,'market-unavailable');}
  await done;
 }
 function close(){
  if(completion)return completion;
  stopped=true;const pending=[...operations];for(const operation of pending)operation.cancel();
  completion=Promise.all(pending.map(operation=>operation.done)).then(()=>undefined);return completion;
 }
 return {policy,handle,close};
}

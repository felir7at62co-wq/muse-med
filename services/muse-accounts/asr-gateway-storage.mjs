/** Private audio objects served through expiring signatures for standard cloud transcription. */
import {constants,createWriteStream} from 'node:fs';
import {link,lstat,mkdir,open,realpath,rm} from 'node:fs/promises';
import {createHash,createHmac,randomUUID,timingSafeEqual} from 'node:crypto';
import {isAbsolute,join,resolve} from 'node:path';
import {pipeline} from 'node:stream/promises';
import {Transform} from 'node:stream';

const route='/api/asr/audio/';
const objectId=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(?:mp3|wav)$/u;
const digestId=/^[0-9a-f]{64}$/u;
const unavailable=()=>Object.assign(Error('Gateway audio object is unavailable'),{code:'ENOENT'});

function objectKey(value){if(typeof value!=='string'||!objectId.test(value))throw Error('Invalid audio object ID');return value;}
async function regularFile(path,requirePrivate=true){
 const entry=await lstat(path);if(!entry.isFile()||entry.isSymbolicLink())throw unavailable();
 const file=await open(path,constants.O_RDONLY|(constants.O_NOFOLLOW??0));
 try{const info=await file.stat();if(!info.isFile()||requirePrivate&&process.platform!=='win32'&&(info.mode&0o077)!==0)throw unavailable();return {file,info};}
 catch(error){await file.close();throw error;}
}
function byteRange(header,size){
 if(header===undefined)return {start:0,end:size-1,partial:false};
 const match=/^bytes=(\d*)-(\d*)$/u.exec(header);if(!match||!match[1]&&!match[2])return null;
 const first=match[1]?Number(match[1]):undefined,last=match[2]?Number(match[2]):undefined;
 if(first!==undefined&&!Number.isSafeInteger(first)||last!==undefined&&!Number.isSafeInteger(last))return null;
 const start=first===undefined?Math.max(0,size-last):first,end=first===undefined?size-1:Math.min(last??size-1,size-1);
 if(start>=size||start>end||first===undefined&&last===0)return null;
 return {start,end,partial:true};
}

/**
 * Create a gateway storage adapter without exposing its signing key or loading account credentials.
 * @param options Absolute private root, public HTTPS baseURL at /api/asr/audio/, server-only secret of at least 32 UTF-8 bytes, signedUrlTtlSeconds from 1 to 604800, positive timeoutMs, optional fetcher and millisecond clock.
 * @returns Existing ASR storage operations, ready() for filesystem startup checks, and handle(req,res) returning whether the anonymous audio route handled the request.
 */
export function createGatewayAudioStore(options){
 const {root,secret,signedUrlTtlSeconds,timeoutMs,fetcher=fetch,now=Date.now}=options;
 let base;try{base=new URL(options.baseURL);}catch(error){throw Error('Invalid gateway audio storage configuration');}
 if(typeof root!=='string'||!isAbsolute(root)||base.protocol!=='https:'||base.username||base.password||base.search||base.hash||base.pathname!==route||typeof secret!=='string'||Buffer.byteLength(secret)<32||!Number.isSafeInteger(signedUrlTtlSeconds)||signedUrlTtlSeconds<1||signedUrlTtlSeconds>604800||!Number.isSafeInteger(timeoutMs)||timeoutMs<=0||typeof fetcher!=='function'||typeof now!=='function')throw Error('Invalid gateway audio storage configuration');
 const directory=resolve(root),signingKey=Buffer.from(secret),tails=new Map();let initialization;
 const path=key=>join(directory,objectKey(key)),metadataPath=key=>path(key)+'.json';
 const signature=(key,expires,digest)=>createHmac('sha256',signingKey).update(key+'\n'+expires+'\n'+digest).digest();
 async function ready(){
  initialization??=(async()=>{
   await mkdir(directory,{recursive:true,mode:0o700});const entry=await lstat(directory),actual=await realpath(directory);
   const same=process.platform==='win32'?actual.toLowerCase()===directory.toLowerCase():actual===directory;
   if(!entry.isDirectory()||entry.isSymbolicLink()||!same||process.platform!=='win32'&&(entry.mode&0o077)!==0)throw Error('Gateway audio storage directory is not private');
  })();
  try{await initialization;}catch(error){throw Error('Gateway audio storage directory is not private');}
 }
 async function metadata(key){
  const {file,info}=await regularFile(metadataPath(key));
  try{
   if(info.size>1024)throw unavailable();const data=JSON.parse(await file.readFile('utf8'));
   if(!data||!digestId.test(data.sha256)||!Number.isSafeInteger(data.bytes)||data.bytes<=0)throw unavailable();return data;
  }finally{await file.close();}
 }
 async function serialized(key,operation){
  objectKey(key);const previous=tails.get(key)??Promise.resolve();
  const work=previous.then(operation),released=work.then(()=>{},error=>{void error;});tails.set(key,released);
  try{return await work;}finally{if(tails.get(key)===released)tails.delete(key);}
 }
 async function storedDigest(key){
  const {file,info}=await regularFile(path(key)),hash=createHash('sha256');
  try{for await(const chunk of file.createReadStream({autoClose:false}))hash.update(chunk);return {sha256:hash.digest('hex'),bytes:info.size};}
  finally{await file.close();}
 }
 async function probe(url,method='HEAD'){
  let response;try{response=await fetcher(url,{method,redirect:'error',signal:AbortSignal.timeout(timeoutMs)});}catch(error){throw Error('Gateway audio download verification failed');}
  try{await response.body?.cancel();}catch(error){throw Error('Gateway audio download verification failed');}
  return response;
 }
 function reply(res,status,headers={}){res.writeHead(status,{'cache-control':'no-store','x-content-type-options':'nosniff',...headers});res.end();}
 return {
  /** Validate the private directory before the gateway begins accepting requests. */
  ready,
  /** Return a filename containing only a canonical UUID and a supported audio format. */
  key(id,format='mp3'){return objectKey(id+'.'+format);},
  /** Confirm the public route rejects an unsigned request before staging an object. */
  async assertPrivateBeforeUpload(){await ready();const response=await probe(new URL(randomUUID()+'.mp3',base));if(response.status!==403)throw Error('Gateway audio route is not private');},
  /** Copy to private temporary files and publish an immutable object without replacing an existing key. */
  async upload(source,key){
   await ready();return await serialized(key,async()=>{
    const staged=join(directory,'.'+key+'.'+randomUUID()+'.tmp'),stagedMetadata=staged+'.json';let input;
    try{
     input=(await regularFile(source,false)).file;let bytes=0;const hash=createHash('sha256');
     const measure=new Transform({transform(chunk,_encoding,callback){bytes+=chunk.length;hash.update(chunk);callback(null,chunk);}});
     await pipeline(input.createReadStream({autoClose:false}),measure,createWriteStream(staged,{flags:'wx',mode:0o600}));
     if(!bytes)throw Error('Gateway audio object is empty');const data={sha256:hash.digest('hex'),bytes};
     const output=await open(staged,constants.O_RDWR|(constants.O_NOFOLLOW??0));try{await output.sync();}finally{await output.close();}
     try{await link(staged,path(key));}
     catch(error){
      if(error.code!=='EEXIST')throw error;
      let existing;try{existing=await metadata(key);}catch(error){if(error.code!=='ENOENT')throw error;existing=await storedDigest(key);}
      if(existing.sha256!==data.sha256||existing.bytes!==data.bytes)throw Error('Gateway audio object is immutable');
     }
     await rm(staged,{force:true});
     const meta=await open(stagedMetadata,'wx',0o600);try{await meta.writeFile(JSON.stringify(data)+'\n');await meta.sync();}finally{await meta.close();}
     try{await link(stagedMetadata,metadataPath(key));}
     catch(error){if(error.code!=='EEXIST')throw error;const existing=await metadata(key);if(existing.sha256!==data.sha256||existing.bytes!==data.bytes)throw Error('Gateway audio object is immutable');}
    }catch(error){if(error.message==='Gateway audio object is immutable')throw error;throw Error('Gateway audio upload failed');}
    finally{if(input)await input.close();await rm(staged,{force:true});await rm(stagedMetadata,{force:true});}
   });
  },
  /** Sign one object; removing and republishing it with another digest invalidates earlier URLs. */
  async signedReadUrl(key){
   await ready();objectKey(key);let data;
   try{data=await metadata(key);const {file,info}=await regularFile(path(key));try{if(info.size!==data.bytes)throw unavailable();}finally{await file.close();}}
   catch(error){throw unavailable();}
   const expires=Math.floor(now()/1000)+signedUrlTtlSeconds,url=new URL(key,base);url.searchParams.set('expires',String(expires));url.searchParams.set('digest',data.sha256);url.searchParams.set('signature',signature(key,expires,data.sha256).toString('hex'));return url.href;
  },
  /** Verify unsigned denial and a signed HEAD response without downloading or retaining audio. */
  async assertPrivateAndReadable(key,url){
   await ready();objectKey(key);const expected=new URL(key,base);let candidate;try{candidate=new URL(url);}catch(error){throw Error('Gateway audio download verification failed');}
   if(candidate.origin!==expected.origin||candidate.pathname!==expected.pathname)throw Error('Gateway audio download verification failed');
   const anonymous=await probe(expected);if(anonymous.status!==403)throw Error('Gateway audio route is not private');
   const signed=await probe(candidate),data=await metadata(key);if(signed.status!==200||Number(signed.headers.get('content-length'))!==data.bytes)throw Error('Signed gateway audio object is not readable');
  },
  /** Remove only this UUID's audio and digest metadata; repeated cleanup is harmless. */
  async remove(key){await ready();return await serialized(key,async()=>{await rm(path(key),{force:true});await rm(metadataPath(key),{force:true});});},
  /** Serve only signed audio GET/HEAD requests before account authentication; return false for other routes. */
  async handle(req,res){
   if(typeof req.url!=='string'||!req.url.split('?')[0].startsWith(route))return false;
   if(!['GET','HEAD'].includes(req.method)){reply(res,405,{allow:'GET, HEAD'});return true;}
   let url,key,expires,digest,supplied;
   try{
    url=new URL(req.url,base);key=url.pathname.slice(route.length);objectKey(key);
    if(!url.pathname.startsWith(route)||[...url.searchParams.keys()].some(name=>!['expires','digest','signature'].includes(name))||['expires','digest','signature'].some(name=>url.searchParams.getAll(name).length!==1))throw unavailable();
    const expiry=url.searchParams.get('expires');if(!/^\d{1,12}$/u.test(expiry))throw unavailable();expires=Number(expiry);digest=url.searchParams.get('digest');supplied=url.searchParams.get('signature');
    const current=Math.floor(now()/1000);if(!Number.isSafeInteger(expires)||expires<=current||expires-current>signedUrlTtlSeconds||!digestId.test(digest)||!digestId.test(supplied)||!timingSafeEqual(signature(key,expires,digest),Buffer.from(supplied,'hex')))throw unavailable();
   }catch(error){reply(res,403);return true;}
   let file;
   try{
    await ready();const data=await metadata(key);if(data.sha256!==digest){reply(res,403);return true;}
    const opened=await regularFile(path(key));file=opened.file;if(opened.info.size!==data.bytes)throw unavailable();
    const range=byteRange(req.method==='GET'?req.headers.range:undefined,data.bytes);if(!range){reply(res,416,{'content-range':'bytes */'+data.bytes});return true;}
    const headers={'cache-control':'no-store','x-content-type-options':'nosniff','accept-ranges':'bytes','content-type':key.endsWith('.mp3')?'audio/mpeg':'audio/wav','content-disposition':'inline; filename="'+key+'"','content-length':String(range.end-range.start+1),...range.partial?{'content-range':`bytes ${range.start}-${range.end}/${data.bytes}`}:{}};
    res.writeHead(range.partial?206:200,headers);
    if(req.method==='HEAD')res.end();
    else await pipeline(file.createReadStream({start:range.start,end:range.end,autoClose:false}),res);
   }catch(error){
    // Disconnected readers and unavailable files expose no filesystem diagnostics or signed URLs.
    if(!res.headersSent)reply(res,404);else res.destroy();
   }finally{if(file)await file.close();}
   return true;
  },
 };
}

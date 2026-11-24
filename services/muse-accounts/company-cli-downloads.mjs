/** Private files for authenticated company CLI downloads; public records contain no filesystem paths. */
import {createHash,randomUUID} from 'node:crypto';
import {constants} from 'node:fs';
import {mkdir,lstat,realpath,open,rename,rm} from 'node:fs/promises';
import {join,resolve,relative,isAbsolute,basename,extname} from 'node:path';

const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const positive=value=>Number.isSafeInteger(value)&&value>0;
const identifier=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,128}$/u.test(value);
const sha=value=>typeof value==='string'&&/^[a-f0-9]{64}$/u.test(value);
const digest=value=>createHash('sha256').update(value).digest('hex');
const fail=(code,status=409)=>Object.assign(new Error(code),{code,status});
const extensions={image:new Set(['.png','.jpg','.jpeg','.webp','.gif','.avif']),video:new Set(['.mp4','.webm','.mov','.m4v']),audio:new Set(['.mp3','.wav','.ogg','.m4a','.aac','.flac'])};
const unchanged=(a,b)=>a.dev===b.dev&&a.ino===b.ino&&a.size===b.size&&a.mtimeMs===b.mtimeMs;
function contained(parent,path){const rel=relative(parent,path);return !!rel&&!rel.startsWith('..')&&!isAbsolute(rel);}
function publicError(error,fallback){return typeof error?.code==='string'&&error.code.startsWith('company_cli_download_')?error:fail(fallback,503);}

/**
 * Create a private download file owner. It runs no CLI or network request.
 * @param {object} options Absolute root, file-size ceiling, chunk size and JSON response ceiling. All values are server configuration.
 * @returns {object} allocate reserves a unique job directory; capture publishes one checked media file; readChunk reads immutable bytes; discard removes only that job's private directory.
 */
export function createCompanyCliDownloads({root,maxBytes,chunkBytes,maxResponseBytes}){
 if(typeof root!=='string'||!isAbsolute(root)||!positive(maxBytes)||maxBytes>1073741824||!positive(chunkBytes)||chunkBytes>Math.min(maxBytes,1048576)||Math.ceil(maxBytes/chunkBytes)>65536||!positive(maxResponseBytes)||maxResponseBytes>67108864||4*Math.ceil(chunkBytes/3)+4096>maxResponseBytes)throw fail('company_cli_download_invalid_configuration',500);
 async function rootPath(){
  await mkdir(root,{recursive:true,mode:0o700});const stat=await lstat(root);
  if(!stat.isDirectory()||stat.isSymbolicLink())throw fail('company_cli_download_unsafe_directory',500);
  return realpath(root);
 }
 async function jobPath(jobId,existing=true){
  if(!identifier(jobId))throw fail('company_cli_download_invalid_identifier',400);
  const parent=await rootPath(),directory=join(parent,jobId);
  if(!contained(parent,directory))throw fail('company_cli_download_unsafe_directory',500);
  if(existing){const stat=await lstat(directory);if(!stat.isDirectory()||stat.isSymbolicLink()||await realpath(directory)!==resolve(directory))throw fail('company_cli_download_unsafe_directory',409);}
  return directory;
 }
 async function allocate(jobId){
  try{const directory=await jobPath(jobId,false);await mkdir(directory,{mode:0o700});return directory;}
  catch(error){if(error.code==='EEXIST')throw fail('company_cli_download_directory_exists',409);throw publicError(error,'company_cli_download_unavailable');}
 }
 async function openChecked(path,expectedBytes,writable=false){
  const info=await lstat(path);
  if(!info.isFile()||info.isSymbolicLink()||info.nlink!==1||!positive(info.size)||info.size>maxBytes||expectedBytes!==undefined&&info.size!==expectedBytes)throw fail('company_cli_download_integrity_error');
  const handle=await open(path,(writable?constants.O_RDWR:constants.O_RDONLY)|(constants.O_NOFOLLOW??0));
  try{const current=await handle.stat();if(!current.isFile()||current.nlink!==1||!unchanged(info,current))throw fail('company_cli_download_integrity_error');return {handle,stat:current};}
  catch(error){await handle.close();throw error;}
 }
 async function capture(jobId,{records,kind,maxBytes:requestedMaxBytes}){
  const ceiling=requestedMaxBytes===undefined?maxBytes:requestedMaxBytes;
  if(!positive(ceiling)||ceiling>maxBytes||!Object.hasOwn(extensions,kind)||!Array.isArray(records)||records.length!==1||!object(records[0])||typeof records[0].local_file!=='string')throw fail('company_cli_download_unsupported_output',400);
  let handle;
  try{
   const directory=await jobPath(jobId),file=records[0].local_file,rel=relative(directory,file);
   if(!isAbsolute(file)||!contained(directory,file)||rel!==basename(rel))throw fail('company_cli_download_unsafe_path');
   const extension=extname(file).toLowerCase();if(!extensions[kind].has(extension))throw fail('company_cli_download_unsupported_output',400);
   if(await realpath(file)!==resolve(file))throw fail('company_cli_download_unsafe_path');
   const opened=await openChecked(file,undefined,true);handle=opened.handle;
   if(opened.stat.size>ceiling)throw fail('company_cli_download_size_limit',413);
   const whole=createHash('sha256'),chunks=[],buffer=Buffer.alloc(chunkBytes);let position=0;
   while(position<opened.stat.size){
    const length=Math.min(chunkBytes,opened.stat.size-position);let offset=0;
    while(offset<length){const result=await handle.read(buffer,offset,length-offset,position+offset);if(!result.bytesRead)throw fail('company_cli_download_integrity_error');offset+=result.bytesRead;}
    const bytes=buffer.subarray(0,length);whole.update(bytes);chunks.push(digest(bytes));position+=length;
   }
   if(!unchanged(opened.stat,await handle.stat()))throw fail('company_cli_download_integrity_error');
   await handle.sync();await handle.close();handle=undefined;
   const sha256=whole.digest('hex'),fileId=randomUUID(),sidecarBytes=Buffer.from(JSON.stringify({bytes:position,sha256,chunkBytes,chunks}));
   if(!unchanged(opened.stat,await lstat(file)))throw fail('company_cli_download_integrity_error');
   await rename(file,join(directory,fileId+'.bin'));
   const sidecar=await open(join(directory,fileId+'.json'),'wx',0o600);
   try{await sidecar.writeFile(sidecarBytes);await sidecar.sync();}finally{await sidecar.close();}
   return [{fileId,name:'1-'+sha256.slice(0,12)+extension,bytes:position,sha256,chunkBytes,chunkCount:chunks.length,chunkManifestSha256:digest(sidecarBytes)}];
  }catch(error){throw publicError(error,'company_cli_download_unavailable');}
  finally{if(handle)await handle.close();}
 }
 async function readChunk(jobId,file,index){
  if(!object(file)||!identifier(file.fileId)||!positive(file.bytes)||file.bytes>maxBytes||!sha(file.sha256)||!positive(file.chunkBytes)||4*Math.ceil(file.chunkBytes/3)+4096>maxResponseBytes||!positive(file.chunkCount)||file.chunkCount!==Math.ceil(file.bytes/file.chunkBytes)||!sha(file.chunkManifestSha256)||!Number.isSafeInteger(index)||index<0||index>=file.chunkCount)throw fail('company_cli_download_invalid_chunk',400);
  let handle,sidecar;
  try{
   const directory=await jobPath(jobId),manifestPath=join(directory,file.fileId+'.json'),manifestInfo=await lstat(manifestPath);
   const manifestLimit=4096+file.chunkCount*68;
   if(!manifestInfo.isFile()||manifestInfo.isSymbolicLink()||manifestInfo.nlink!==1||manifestInfo.size>manifestLimit)throw fail('company_cli_download_integrity_error');
   sidecar=await open(manifestPath,constants.O_RDONLY|(constants.O_NOFOLLOW??0));const bytes=Buffer.alloc(manifestInfo.size);let sidecarRead=0;
   while(sidecarRead<bytes.length){const result=await sidecar.read(bytes,sidecarRead,bytes.length-sidecarRead,sidecarRead);if(!result.bytesRead)throw fail('company_cli_download_integrity_error');sidecarRead+=result.bytesRead;}
   if(!unchanged(manifestInfo,await sidecar.stat())||digest(bytes)!==file.chunkManifestSha256)throw fail('company_cli_download_integrity_error');
   let stored;try{stored=JSON.parse(bytes.toString('utf8'));}catch{throw fail('company_cli_download_integrity_error');}
   if(!object(stored)||stored.bytes!==file.bytes||stored.sha256!==file.sha256||stored.chunkBytes!==file.chunkBytes||!Array.isArray(stored.chunks)||stored.chunks.length!==file.chunkCount||stored.chunks.some(item=>!sha(item)))throw fail('company_cli_download_integrity_error');
   const opened=await openChecked(join(directory,file.fileId+'.bin'),file.bytes);handle=opened.handle;
   const length=Math.min(file.chunkBytes,file.bytes-index*file.chunkBytes),data=Buffer.alloc(length);let offset=0;
   while(offset<length){const result=await handle.read(data,offset,length-offset,index*file.chunkBytes+offset);if(!result.bytesRead)throw fail('company_cli_download_integrity_error');offset+=result.bytesRead;}
   const sha256=digest(data);if(sha256!==stored.chunks[index]||!unchanged(opened.stat,await handle.stat()))throw fail('company_cli_download_integrity_error');
   return {fileId:file.fileId,index,bytes:length,sha256,data_base64:data.toString('base64')};
  }catch(error){throw publicError(error,'company_cli_download_unavailable');}
  finally{if(sidecar)await sidecar.close();if(handle)await handle.close();}
 }
 async function discard(jobId){
  try{const directory=await jobPath(jobId);await rm(directory,{recursive:true,force:true});}
  catch(error){if(error.code!=='ENOENT')throw publicError(error,'company_cli_download_cleanup_failed');}
 }
 return {allocate,capture,readChunk,discard};
}

/** Bounded immutable archive blobs remain independent of live project files. */
const fs=require('node:fs'),fsp=require('node:fs/promises'),path=require('node:path'),{createHash,randomUUID}=require('node:crypto');
const {fail}=require('./museProjectArchiveContent');
function root(cfg){if(typeof cfg.storage?.local_path!=='string')throw fail('project_archive_storage_unavailable',503);return fs.realpathSync(cfg.storage.local_path);}
function safe(cfg,relative){
 if(typeof relative!=='string'||!relative||relative.includes('\\')||relative.includes('\0')||relative.startsWith('/')||relative.split('/').some(value=>!value||value==='.'||value==='..'))throw fail('project_archive_invalid_path',400);
 const base=root(cfg),target=path.resolve(base,relative);if(!target.startsWith(base+path.sep))throw fail('project_archive_invalid_path',400);
 let current=base;for(const name of relative.split('/')){current=path.join(current,name);if(!fs.existsSync(current))continue;const stat=fs.lstatSync(current);if(stat.isSymbolicLink())throw fail('project_archive_link_refused',400);}
 return target;
}
function blobPath(sha){if(typeof sha!=='string'||!/^[a-f0-9]{64}$/.test(sha))throw fail('project_archive_invalid_hash',400);return '.muse-project-archives/blobs/'+sha;}
async function measure(file,limit,signal){const hash=createHash('sha256');let bytes=0;const stream=fs.createReadStream(file,{highWaterMark:262144,signal});for await(const chunk of stream){bytes+=chunk.length;if(bytes>limit){stream.destroy();throw fail('project_archive_file_limit',413);}hash.update(chunk);}return {sha256:hash.digest('hex'),bytes};}
async function capture(cfg,relative,limits,signal){
 const source=safe(cfg,relative),before=await fsp.stat(source);if(!before.isFile()||before.size>limits.max_file_bytes)throw fail('project_archive_file_limit',413);
 const folder=safe(cfg,'.muse-project-archives/blobs');await fsp.mkdir(folder,{recursive:true,mode:0o700});safe(cfg,'.muse-project-archives/blobs');
 const temporary=path.join(folder,'.partial-'+randomUUID());
 try{
  const immutable=/^(?:muse-studio\/(?:media|assets)\/[a-f0-9]{64}\.[a-z0-9]+|libtv-api\/(?:raw|media)\/[a-f0-9]{64}\.mp4)$/.test(relative);
  if(immutable){const measured=await measure(source,limits.max_file_bytes,signal),target=safe(cfg,blobPath(measured.sha256));try{await fsp.link(source,target);}catch(error){if(error.code!=='EEXIST')throw error;await verify(cfg,measured,limits,signal);}return {path:relative,...measured,storage:'immutable-hardlink'};}
  await fsp.copyFile(source,temporary,fs.constants.COPYFILE_EXCL|fs.constants.COPYFILE_FICLONE);
  const measured=await measure(temporary,limits.max_file_bytes,signal),after=await fsp.stat(source);
  if(before.size!==after.size||before.mtimeMs!==after.mtimeMs||before.ino!==after.ino||measured.bytes!==before.size)throw fail('project_archive_source_changed');
  const destination=safe(cfg,blobPath(measured.sha256));
  try{await fsp.link(temporary,destination);}catch(error){if(error.code!=='EEXIST')throw error;const existing=await measure(destination,limits.max_file_bytes,signal);if(existing.sha256!==measured.sha256||existing.bytes!==measured.bytes)throw fail('project_archive_blob_changed');}
  return {path:relative,...measured,storage:'reflink-or-copy'};
 }finally{try{await fsp.unlink(temporary);}catch(error){if(error.code!=='ENOENT')throw error;}}
}
async function verify(cfg,file,limits,signal){const actual=await measure(safe(cfg,blobPath(file.sha256)),limits.max_file_bytes,signal);if(actual.sha256!==file.sha256||actual.bytes!==file.bytes)throw fail('project_archive_blob_changed');return actual;}
async function copyRestored(cfg,file,relative,limits,signal){await verify(cfg,file,limits,signal);const destination=safe(cfg,relative);await fsp.mkdir(path.dirname(destination),{recursive:true,mode:0o700});safe(cfg,relative);try{await fsp.copyFile(safe(cfg,blobPath(file.sha256)),destination,fs.constants.COPYFILE_EXCL|fs.constants.COPYFILE_FICLONE);}catch(error){if(error.code!=='EEXIST')throw error;const previous=await measure(destination,limits.max_file_bytes,signal);if(previous.sha256!==file.sha256)throw fail('project_archive_restore_path_changed');}return relative;}
async function saveDocument(cfg,bytes,sha,limits){if(bytes.length>limits.max_document_bytes)throw fail('project_archive_document_limit',413);if(createHash('sha256').update(bytes).digest('hex')!==sha)throw fail('project_archive_document_hash',400);const target=safe(cfg,blobPath(sha));await fsp.mkdir(path.dirname(target),{recursive:true,mode:0o700});safe(cfg,blobPath(sha));const temporary=target+'.partial-'+randomUUID();try{await fsp.writeFile(temporary,bytes,{flag:'wx',mode:0o600});try{await fsp.link(temporary,target);}catch(error){if(error.code!=='EEXIST')throw error;await verify(cfg,{sha256:sha,bytes:bytes.length},limits);}}finally{try{await fsp.unlink(temporary);}catch(error){if(error.code!=='ENOENT')throw error;}}return blobPath(sha);}
async function chunk(cfg,file,index,limits){if(!Number.isSafeInteger(index)||index<0||index>=Math.ceil(file.bytes/limits.chunk_bytes))throw fail('project_archive_chunk_invalid',400);const handle=await fsp.open(safe(cfg,blobPath(file.sha256)),'r');try{const data=Buffer.alloc(Math.min(limits.chunk_bytes,file.bytes-index*limits.chunk_bytes)),result=await handle.read(data,0,data.length,index*limits.chunk_bytes);if(result.bytesRead!==data.length)throw fail('project_archive_blob_changed');return {sha256:file.sha256,totalBytes:file.bytes,index,totalChunks:Math.ceil(file.bytes/limits.chunk_bytes),chunkSha256:createHash('sha256').update(data).digest('hex'),dataBase64:data.toString('base64')};}finally{await handle.close();}}
module.exports={root,safe,blobPath,capture,verify,copyRestored,saveDocument,chunk};

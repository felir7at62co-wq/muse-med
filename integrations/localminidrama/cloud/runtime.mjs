/** One private SQLite/media worker per verified Muse account. */
import {spawn} from 'node:child_process';
import {randomBytes,randomUUID} from 'node:crypto';
import {mkdir,lstat,realpath,readdir,readFile,writeFile,open,rename} from 'node:fs/promises';
import {resolve,join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {resolveStudioConfig} from './config.mjs';
import {StudioError} from './security.mjs';

const accountPattern=/^[a-f0-9]{16}$/;
const worker=fileURLToPath(new URL('./tenant-worker.mjs',import.meta.url));
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function privateDirectory(path){
 await mkdir(path,{recursive:true,mode:0o700});const entry=await lstat(path),actual=await realpath(path);
 if(!entry.isDirectory()||entry.isSymbolicLink()||(process.platform==='win32'?actual.toLowerCase()!==path.toLowerCase():actual!==path)||(process.platform!=='win32'&&(entry.mode&0o077)!==0))throw new StudioError('studio_storage_unavailable');
}
async function publishJson(path,value){
 const temp=path+'.'+randomUUID()+'.tmp',file=await open(temp,'wx',0o600);
 try{await file.writeFile(JSON.stringify(value,null,2)+'\n');await file.sync();}finally{await file.close();}
 await rename(temp,path);
}
async function bytesUnder(root){
 let size=0;
 for(const entry of await readdir(root,{withFileTypes:true})){const path=join(root,entry.name),info=await lstat(path);if(info.isSymbolicLink()||!info.isFile()&&!info.isDirectory())throw new StudioError('studio_storage_unavailable');if(info.isDirectory())size+=await bytesUnder(path);else size+=info.size;if(!Number.isSafeInteger(size))throw new StudioError('studio_quota_exceeded',413);}
 return size;
}
/** Select only OS execution/locale variables; gateway credentials and Node loaders are excluded.
 * @param {object} source Parent environment.
 * @returns {object} Worker-only environment.
 */
export function studioChildEnvironment(source=process.env){const env={NODE_ENV:'production',TZ:'UTC'};for(const key of ['PATH','Path','SystemRoot','SYSTEMROOT','WINDIR','COMSPEC','PATHEXT','LANG','LC_ALL'])if(source[key]!==undefined)env[key]=source[key];return env;}

/** Start a configured runtime without opening any existing tenant data until that account requests it.
 * @param {object} input Complete administrator-authored studio configuration.
 * @param {object} options Public gateway Origin, clock and default-visible failure reporter.
 * @returns {Promise<object>} Account-scoped request leases, idle inspection and graceful shutdown.
 */
export async function createStudioRuntime(input,{publicOrigin,now=Date.now,onError=()=>console.error('[muse-studio] Worker unavailable; saved tenant data was retained. Inspect the studio service before retrying.')}={}){
 const config=resolveStudioConfig(input),limits=config.limits,origin=new URL(publicOrigin);
 if(!['https:','http:'].includes(origin.protocol)||origin.username||origin.password||origin.pathname!=='/'||origin.search||origin.hash||origin.protocol==='http:'&&!['127.0.0.1','localhost','[::1]'].includes(origin.hostname))throw new Error('Invalid Muse studio public Origin');
 const yaml=createRequire(join(config.backendRoot,'package.json'))('js-yaml');
 await privateDirectory(config.tenantRoot);const schema=join(config.tenantRoot,'schema.json');
 try{const previous=JSON.parse(await readFile(schema,'utf8'));if(JSON.stringify(previous)!==JSON.stringify({version:1,kind:'muse-studio-tenants'}))throw new Error('Unsupported Muse studio tenant schema');}
 catch(error){if(error.code!=='ENOENT')throw error;await publishJson(schema,{version:1,kind:'muse-studio-tenants'});}
 const entries=new Map();let starting=0,totalRequests=0,closing=false,sweepPromise;
 const fail=()=>{try{onError();}catch(error){void error;console.error('[muse-studio] Worker failure reporting failed.');}};
 function rpc(entry,type){
  if(entry.dead||!entry.child?.connected)return Promise.reject(new StudioError('studio_unavailable'));
  const id=randomUUID();return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{entry.pending.delete(id);reject(new StudioError('studio_unavailable'));},limits.startupTimeoutMs);entry.pending.set(id,{resolve:value=>{clearTimeout(timer);resolve(value);},reject:error=>{clearTimeout(timer);reject(error);}});entry.child.send({type,id},error=>{if(error){entry.pending.get(id)?.reject(new StudioError('studio_unavailable'));entry.pending.delete(id);}});});
 }
 async function inspect(entry){const value=await rpc(entry,'inspect');if(!['requests','background','tasks'].every(key=>Number.isSafeInteger(value[key])&&value[key]>=0))throw new StudioError('studio_unavailable');return value;}
 const busy=value=>value.requests>0||value.background>0||value.tasks>0;
 async function stop(entry){
  if(entry.dead)return true;if(entry.stopping){await entry.exited;return true;}if(entry.leases)return false;const status=await inspect(entry);if(busy(status)||entry.leases)return false;if(entry.dead)return true;if(entry.stopping){await entry.exited;return true;}
  entry.stopping=true;entry.child.send({type:'stop'});await entry.exited;return true;
 }
 async function launch(entry){
  try{
   await privateDirectory(entry.dir);const descriptor=join(entry.dir,'tenant.json');let old;
   try{old=JSON.parse(await readFile(descriptor,'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
   if(old&&(old.version!==1||old.accountId!==entry.accountId||Object.keys(old).length!==2))throw new StudioError('studio_storage_unavailable');
   if(!old)await publishJson(descriptor,{version:1,accountId:entry.accountId});
   const configs=join(entry.dir,'configs'),storage=join(entry.dir,'storage');await privateDirectory(configs);await privateDirectory(storage);
   const configFile=join(configs,'config.yaml');
   try{const current=yaml.load(await readFile(configFile,'utf8'));if(current.database?.type!=='sqlite'||current.database?.path!==join(entry.dir,'drama.db')||current.storage?.type!=='local'||current.storage?.local_path!==storage||current.server?.host!=='127.0.0.1'||current.server?.insecure_tls!==false)throw new StudioError('studio_storage_unavailable');current.storage.base_url='/studio/static';current.server.cors_origins=[origin.origin];await publishJson(configFile,current);}
   catch(error){if(error.code!=='ENOENT')throw error;await publishJson(configFile,{app:{name:'Muse',version:'1'},server:{host:'127.0.0.1',port:0,insecure_tls:false,cors_origins:[origin.origin]},database:{type:'sqlite',path:join(entry.dir,'drama.db')},storage:{type:'local',local_path:storage,base_url:'/studio/static'},video:{generation_timeout_minutes:Math.max(1,Math.ceil(limits.requestTimeoutMs/60000))},vendor_lock:{enabled:false},image_proxy:{enabled:false,upload_url:''}});}
   let resolveReady,rejectReady;const ready=new Promise((resolve,reject)=>{resolveReady=resolve;rejectReady=reject;});
   entry.child=spawn(config.nodeExecutable,[worker],{cwd:entry.dir,env:studioChildEnvironment(),stdio:['ignore','ignore','ignore','ipc'],windowsHide:true});
   entry.exited=new Promise(resolve=>entry.child.once('close',()=>{entry.dead=true;for(const waiter of entry.pending.values())waiter.reject(new StudioError('studio_unavailable'));entry.pending.clear();if(entries.get(entry.accountId)===entry)entries.delete(entry.accountId);rejectReady(new StudioError('studio_unavailable'));if(!entry.stopping)fail();resolve();}));
   entry.child.once('error',()=>{rejectReady(new StudioError('studio_unavailable'));});
   entry.child.on('message',message=>{
    if(message?.type==='ready'&&Number.isSafeInteger(message.port)&&message.port>0&&message.port<=65535){entry.target=new URL('http://127.0.0.1:'+message.port);resolveReady();}
    if(message?.type==='failed'&&message.code==='studio_worker_busy')rejectReady(new StudioError('studio_worker_busy',409));
    if(message?.type==='state'&&typeof message.id==='string'){entry.pending.get(message.id)?.resolve(message);entry.pending.delete(message.id);}
   });
   entry.child.send({type:'start',backendRoot:config.backendRoot,webDistRoot:config.webDistRoot,token:entry.token,limits,publicOrigin:origin.origin,outboundOrigins:config.outboundOrigins,trustedLocalOrigins:config.trustedLocalOrigins});
   const timer=setTimeout(()=>rejectReady(new StudioError('studio_start_timeout')),limits.startupTimeoutMs);
   try{await ready;}catch(error){entry.stopping=true;entry.child.kill();await entry.exited;throw error;}finally{clearTimeout(timer);}
   return entry;
  }catch(error){if(entries.get(entry.accountId)===entry)entries.delete(entry.accountId);fail();throw error instanceof StudioError?error:new StudioError('studio_unavailable');}
  finally{starting--;}
 }
 async function sweep(){
  if(sweepPromise)return sweepPromise;
  sweepPromise=(async()=>{if(!limits.idleTimeoutMs)return;for(const entry of entries.values()){if(entry.dead||entry.stopping||entry.leases||now()-entry.lastUsed<limits.idleTimeoutMs)continue;try{await entry.ready;if(!entry.leases&&now()-entry.lastUsed>=limits.idleTimeoutMs)await stop(entry);}catch(error){fail();}}})().finally(()=>{sweepPromise=undefined;});return sweepPromise;
 }
 async function ensure(accountId){
  if(!accountPattern.test(accountId))throw new StudioError('studio_invalid_account',400);if(closing)throw new StudioError('studio_closing');
  let entry=entries.get(accountId);if(entry){await entry.ready;if(entry.stopping||entry.dead)throw new StudioError('studio_unavailable');return entry;}
  if(entries.size>=limits.maxActiveInstances)await sweep();
  if(entries.size>=limits.maxActiveInstances)throw new StudioError('studio_capacity',503);if(starting>=limits.maxConcurrentStarts)throw new StudioError('studio_start_capacity',503);
  entry={accountId,dir:join(config.tenantRoot,accountId),token:randomBytes(32).toString('hex'),leases:0,reserved:0,lastUsed:now(),pending:new Map(),dead:false,stopping:false};entries.set(accountId,entry);starting++;entry.ready=launch(entry);await entry.ready;return entry;
 }
 let draining;
 async function drain(){if(draining)return draining;draining=(async()=>{for(const entry of [...entries.values()]){await entry.ready;await stop(entry);}if(!entries.size)clearInterval(interval);})().finally(()=>{draining=undefined;});return draining;}
 const interval=setInterval(()=>{void (closing?drain():sweep()).catch(()=>fail());},limits.idleSweepMs);interval.unref();
 return {
  limits:Object.freeze({...limits}),
  /** Hold one caller's worker until its proxy stream closes; writes reserve known incoming bytes. */
  async acquire(accountId,{write=false,requestBytes=0}={}){
   if(!Number.isSafeInteger(requestBytes)||requestBytes<0||requestBytes>limits.maxRequestBytes)throw new StudioError('studio_request_too_large',413);
   const entry=await ensure(accountId);if(closing||entry.stopping)throw new StudioError('studio_closing');
   if(totalRequests>=limits.maxRequestsTotal||entry.leases>=limits.maxRequestsPerAccount)throw new StudioError('studio_request_capacity',429);
   entry.leases++;totalRequests++;entry.reserved+=write?requestBytes:0;entry.lastUsed=now();let released=false;
   const release=()=>{if(released)return;released=true;entry.leases--;totalRequests--;entry.reserved-=write?requestBytes:0;entry.lastUsed=now();};
   try{if(write&&await bytesUnder(entry.dir)+entry.reserved>limits.maxTenantBytes)throw new StudioError('studio_quota_exceeded',413);}
   catch(error){release();throw error;}
   return {target:entry.target,token:entry.token,release};
  },
  sweep,
  /** Stop admission, drain accepted HTTP/background jobs and retain busy workers if the grace period expires. */
  async close(){
   closing=true;const deadline=performance.now()+limits.shutdownGraceMs;
   while(entries.size){await drain();if(!entries.size)return;if(performance.now()>=deadline)throw new StudioError('studio_busy',409);await pause(Math.min(limits.idleSweepMs,Math.max(1,deadline-performance.now())));}clearInterval(interval);
  },
 };
}

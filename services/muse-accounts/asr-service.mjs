/** Durable, account-scoped cloud transcription jobs for the MUSE gateway. */
import {createHash,randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {createWriteStream} from 'node:fs';
import {mkdir,open,readFile,readdir,rename,rm,stat,writeFile} from 'node:fs/promises';
import {isAbsolute,join} from 'node:path';
import {pipeline} from 'node:stream/promises';
import {Transform} from 'node:stream';
import {resolveAsrResources,resourceForJob} from './asr-resources.mjs';
import {AsrProviderError} from './asr-provider.mjs';

function fail(status,message,code,retryAfter){return Object.assign(Error(message),{status,...code?{code}:{},...retryAfter?{retryAfter}:{}});}
const validKey=value=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const digest=value=>createHash('sha256').update(value).digest('hex');

/** Resolve and validate private gateway configuration before creating workers or storage clients. */
export function resolveAsrConfig(input){
 const config={providerKind:'standard',maxQueuedJobs:20,maxPendingUploadsPerAccount:4,...input,...resolveAsrResources(input,true)};
 const positive=['timeoutMs','maxAudioBytes','maxDurationSeconds','maxDailySeconds','maxDailyJobs','maxActiveJobs','retentionSeconds','sweepIntervalSeconds','maxConcurrentJobs','maxQueuedJobs','maxPendingUploadsPerAccount'];
 if(!['standard','flash'].includes(config.providerKind)||typeof config.ffprobePath!=='string'||!config.ffprobePath.trim()||typeof config.root!=='string'||!isAbsolute(config.root)||!positive.every(key=>Number.isSafeInteger(config[key])&&config[key]>0)||config.timeoutMs<1000||config.maxActiveJobs!==1||config.sweepIntervalSeconds<60||config.sweepIntervalSeconds>config.retentionSeconds||config.retentionSeconds<config.maxDurationSeconds+3600||config.maxDurationSeconds>(config.providerKind==='flash'?7200:18000)||config.providerKind==='flash'&&config.maxAudioBytes>100_000_000)throw Error('Invalid MUSE ASR server configuration');
 const usesStorage=config.providerKind==='standard'||['accessKeyId','secretAccessKey','bucket','region','endpoint','prefix','signedUrlTtlSeconds'].some(key=>config[key]!==undefined);
 if(usesStorage&&(!['accessKeyId','secretAccessKey','bucket','region','endpoint','prefix'].every(key=>typeof config[key]==='string'&&config[key].trim())||!Number.isSafeInteger(config.signedUrlTtlSeconds)||config.signedUrlTtlSeconds<config.maxDurationSeconds+3600||config.signedUrlTtlSeconds>604800||config.retentionSeconds>config.signedUrlTtlSeconds))throw Error('Invalid MUSE ASR storage configuration');
 return config;
}

/** Probe the staged audio on the gateway, so quota cannot rely on a client-supplied duration. */
export async function probeAudio(file,ffprobe='ffprobe'){
 const output=await new Promise((resolve,reject)=>{
  const child=spawn(ffprobe,['-v','error','-select_streams','a:0','-show_entries','format=duration,format_name:stream=codec_name,sample_rate,channels','-of','json',file],{windowsHide:true});let text='';
  const timer=setTimeout(()=>{child.kill();reject(fail(422,'Audio probe timed out'));},30_000);
  child.stdout.on('data',chunk=>{text+=chunk;if(text.length>8192){child.kill();reject(fail(422,'Invalid audio metadata'));}});
  child.on('error',()=>{clearTimeout(timer);reject(fail(503,'Audio probe is unavailable'));});
  child.on('close',code=>{clearTimeout(timer);code===0?resolve(text):reject(fail(422,'Cannot decode audio'));});
 });
 let result;try{result=JSON.parse(output);}catch{throw fail(422,'Invalid audio metadata');}
 return parseAudioMetadata(result);
}

/** Validate ffprobe metadata and return the verified duration and container for provider submission. */
export function parseAudioMetadata(result){
 const duration=Number(result?.format?.duration),stream=result?.streams?.[0],container=result?.format?.format_name;
 const format=container==='mp3'&&stream?.codec_name==='mp3'?'mp3':container==='wav'&&stream?.codec_name==='pcm_s16le'&&Number(stream.sample_rate)===16000&&stream.channels===1?'wav':null;
 if(!format||!Number.isFinite(duration)||duration<=0)throw fail(422,'Expected MP3 or 16 kHz mono PCM16 WAV audio');
 return {duration,format};
}

/**
 * Create one gateway-local job ledger. Run one account gateway process per ledger root.
 * The caller injects private storage and provider operations; no secrets enter receipts.
 */
export function createAsrService(options){
 const {root,storage,providerKind='standard',maxQueuedJobs=20,maxPendingUploadsPerAccount=4,probe=probeAudio,now=Date.now,maxAudioBytes,maxDurationSeconds,maxDailySeconds,maxDailyJobs,maxActiveJobs,retentionSeconds}=options;
 const pool=resolveAsrResources(options),{maxConcurrentJobs}=pool;
 const resources=new Map(pool.resources.map(row=>[row.poolId,row])),groups=new Map(pool.quotaGroups.map(row=>[row.id,row]));
 if(!root||providerKind==='standard'&&!storage||![maxAudioBytes,maxDurationSeconds,maxDailySeconds,maxDailyJobs,maxActiveJobs,retentionSeconds,maxConcurrentJobs,maxQueuedJobs,maxPendingUploadsPerAccount].every(n=>Number.isSafeInteger(n)&&n>0)||maxActiveJobs!==1)throw Error('Invalid ASR gateway configuration');
 if(!['standard','flash'].includes(providerKind)||providerKind==='flash'&&(maxDurationSeconds>7200||maxAudioBytes>100_000_000||pool.resources.some(row=>typeof row.provider?.recognize!=='function')))throw Error('Invalid ASR provider configuration');
 if(pool.resources.some(row=>!row.provider))throw Error('Invalid ASR resource provider configuration');
 const jobs=join(root,'jobs'),audio=join(root,'audio'),active=new Map(),waiting=[],workers=new Map();
 const accountTails=new Map();let reservationTail=Promise.resolve(),lastAccount;
 let workerFailure;
 const jobKey=job=>job.account+'\0'+job.id;
 const busy=key=>workers.has(key)||waiting.some(job=>jobKey(job)===key);

 const audioPath=(account,key)=>join(audio,digest(account+'\0'+key)+'.mp3');
 const path=(account,key)=>join(jobs,digest(account+'\0'+key)+'.json');
 const publicJob=job=>({id:job.id,status:job.status==='queued'?'processing':job.status,...job.status==='queued'&&waiting.some(entry=>jobKey(entry)===jobKey(job))?{queued:true}:{},...job.status==='complete'?{segments:job.segments}:{},...job.retentionExpired?{retentionExpired:true}:{},...job.failureCode&&['uncertain','failed'].includes(job.status)?{error_code:job.failureCode}:{}});
 const resourceOf=job=>resourceForJob(job,resources,pool.defaultPoolId);
 async function read(account,key){try{return JSON.parse(await readFile(path(account,key),'utf8'));}catch(error){if(error.code==='ENOENT')return null;throw error;}}
 async function save(account,key,job){const target=path(account,key),staged=target+'.'+randomUUID()+'.tmp';await writeFile(staged,JSON.stringify(job)+'\n',{mode:0o600});await rename(staged,target);}
 async function entries(){const result=[];for(const name of await readdir(jobs)){if(name.endsWith('.json'))result.push(JSON.parse(await readFile(join(jobs,name),'utf8')));}return result;}
 async function reserve(job,existing){
  const prior=reservationTail;
  const pending=(async()=>{
   await prior;if(workerFailure)throw fail(503,'ASR job storage is unavailable');
   const all=await entries(),today=new Date(now()).toISOString().slice(0,10);
   const billed=all.filter(entry=>entry.day===today&&!(entry.id===job.id&&entry.account===job.account)&&entry.status!=='failed');
   const accountJobs=billed.filter(entry=>entry.account===job.account);
   if(accountJobs.length>=maxDailyJobs||accountJobs.reduce((sum,entry)=>sum+entry.duration,0)+job.duration>maxDailySeconds)throw fail(429,'Daily cloud transcription limit reached','daily_quota');
   const candidates=existing?[resourceOf(existing)]:[...resources.values()];
   const eligible=candidates.filter(resource=>{
    const group=groups.get(resource.quotaGroup),groupJobs=billed.filter(entry=>resourceOf(entry).quotaGroup===group.id);
    return (group.maxDailyJobs===undefined||groupJobs.length<group.maxDailyJobs)&&(group.maxDailySeconds===undefined||groupJobs.reduce((sum,entry)=>sum+entry.duration,0)+job.duration<=group.maxDailySeconds);
   });
   if(!eligible.length)throw fail(429,'Daily cloud transcription limit reached','daily_quota');
   const load=resource=>all.filter(entry=>['queued','preparing','submitting','processing'].includes(entry.status)&&resourceOf(entry).appId===resource.appId).length/resource.maxConcurrentJobs;
   eligible.sort((a,b)=>(providerKind==='flash'?Number(available(b))-Number(available(a)):0)||load(a)-load(b));const resource=eligible[0];
   const canRun=available(resource)&&!waiting.some(entry=>entry.account===job.account);
   if(providerKind==='flash'&&!canRun&&waiting.length>=maxQueuedJobs)throw fail(429,'Cloud transcription queue is full','queue_full',2);
   Object.assign(job,{poolId:resource.poolId,appId:resource.appId,quotaGroup:resource.quotaGroup});
   job.day=today;
   if(providerKind==='flash'){job.objectStagedAt=now();job.status='queued';}
   await save(job.account,job.id,job);
   // Queue publication shares the quota reservation lock, so competing uploads cannot overfill it.
   if(providerKind==='flash'){waiting.push(job);dispatch();}
   return resource;
  })();
  // A rejected reservation releases the shared billing lock without hiding its caller's error.
  reservationTail=pending.then(()=>{},()=>{});return await pending;
 }
 async function stage(req,file,expectedHash){const hash=createHash('sha256');let size=0;
  const limit=new Transform({transform(chunk,_encoding,callback){size+=chunk.length;if(size>maxAudioBytes){callback(fail(413,'Audio exceeds the gateway limit'));return;}hash.update(chunk);callback(null,chunk);}});
  try{await pipeline(req,limit,createWriteStream(file,{flags:'wx',mode:0o600}));}catch(error){await rm(file,{force:true});throw error;}
  if(size===0||hash.digest('hex')!==expectedHash){await rm(file,{force:true});throw fail(422,'Audio is empty or its digest changed');}
 }
 async function cleanup(job,account,key){try{if(job.providerKind==='flash')await rm(audioPath(account,key),{force:true});else await storage.remove(storage.key(job.taskId,job.audioFormat));job.cleanupPending=false;await save(account,key,job);}catch{job.cleanupPending=true;await save(account,key,job);}}
 async function expire(job){
  if(active.has(jobKey(job))||busy(jobKey(job)))return;
  const expired=Number.isFinite(job.objectStagedAt)&&now()-job.objectStagedAt>=retentionSeconds*1000;
  if(job.cleanupPending||expired&&!job.retentionExpired&&!['complete','silent','failed'].includes(job.status)){
   if(expired)job.retentionExpired=true;
   await cleanup(job,job.account,job.id);
  }
 }
 async function poll(job,account,key){let result;
  try{result=await resourceOf(job).provider.query(job.taskId);}catch(error){job.status='uncertain';recordProviderFailure(job,error);await save(account,key,job);return publicJob(job);}
  if(result.status==='processing'){job.status='processing';await save(account,key,job);return publicJob(job);}
  if(result.status==='silent'){job.status='silent';await save(account,key,job);await cleanup(job,account,key);return publicJob(job);}
  if(result.status!=='complete'||!Array.isArray(result.segments)||!result.segments.length)throw Error('Invalid ASR provider result');
  job.status='complete';job.segments=result.segments;delete job.failureCode;delete job.providerFailure;await save(account,key,job);await cleanup(job,account,key);return publicJob(job);
 }
 function recordProviderFailure(job,error){
  job.failureCode=error instanceof AsrProviderError?error.code:'provider_unavailable';
  job.providerFailure={code:job.failureCode};
  if(error instanceof AsrProviderError){
   job.providerFailure.operation=error.operation;
   if(error.httpStatus!==undefined)job.providerFailure.httpStatus=error.httpStatus;
   if(error.providerCode!==undefined)job.providerFailure.providerCode=error.providerCode;
  }
 }
 async function runFlash(job){
  try{
   if(now()-job.objectStagedAt>=retentionSeconds*1000){job.status='failed';job.retentionExpired=true;await save(job.account,job.id,job);await cleanup(job,job.account,job.id);return;}
   const file=audioPath(job.account,job.id);await stat(file);
   job.status='submitting';await save(job.account,job.id,job);
   const result=await resourceOf(job).provider.recognize({id:job.taskId,file,language:job.language});
   if(result.status!=='silent'&&(result.status!=='complete'||!Array.isArray(result.segments)||!result.segments.length))throw Error('Invalid ASR provider result');
   job.status=result.status;if(result.status==='complete')job.segments=result.segments;
   await save(job.account,job.id,job);await cleanup(job,job.account,job.id);
  }catch(error){
   // Once submitting is durable, only the original response can resolve a flash charge.
   job.status=job.status==='queued'?'failed':'uncertain';recordProviderFailure(job,error);await save(job.account,job.id,job);
  }
 }
 function available(resource){
  if(workers.size>=maxConcurrentJobs)return false;
  let count=0,appCount=0,groupCount=0;
  for(const item of workers.values()){
   if(item.resource.poolId===resource.poolId)count++;
   if(item.resource.appId===resource.appId)appCount++;
   if(item.resource.quotaGroup===resource.quotaGroup)groupCount++;
  }
  return count<resource.maxConcurrentJobs&&appCount<resource.maxConcurrentJobs&&groupCount<groups.get(resource.quotaGroup).maxConcurrentJobs;
 }
 function dispatch(){
  if(workerFailure)return;
  while(waiting.length&&workers.size<maxConcurrentJobs){
   const accounts=[...new Set(waiting.map(job=>job.account))],last=accounts.indexOf(lastAccount);
   if(last>=0)accounts.push(...accounts.splice(0,last+1));
   let index=-1;
   for(const account of accounts){const candidate=waiting.findIndex(job=>job.account===account);if(available(resourceOf(waiting[candidate]))){index=candidate;break;}}
   if(index<0)return;
   const [job]=waiting.splice(index,1),key=jobKey(job),resource=resourceOf(job);lastAccount=job.account;
   const promise=runFlash(job).catch(error=>{workerFailure=error;}).finally(()=>{workers.delete(key);dispatch();});
   workers.set(key,{promise,resource});
  }
 }
 const initialized=(async()=>{
  await mkdir(jobs,{recursive:true,mode:0o700});await mkdir(audio,{recursive:true,mode:0o700});
  const persisted=await entries();
  const legacyJobs=persisted.filter(job=>job.poolId===undefined&&job.appId===undefined&&job.quotaGroup===undefined);
  const legacyResource=resources.get(pool.defaultPoolId);
  if(legacyJobs.length&&(!pool.legacyAppId||pool.legacyAppId!==legacyResource.appId))throw Error('Legacy ASR application must match the retained default resource');
  for(const job of persisted)resourceOf(job);
  for(const job of legacyJobs){Object.assign(job,{poolId:legacyResource.poolId,appId:legacyResource.appId,quotaGroup:legacyResource.quotaGroup});await save(job.account,job.id,job);}
  for(const job of persisted){
   if(job.providerKind==='flash'){
    if(typeof resourceOf(job).provider.recognize!=='function')throw Error('Flash receipt recovery requires a flash provider');
    if(job.status==='submitting'||job.status==='processing'){job.status='uncertain';await save(job.account,job.id,job);}
    else if(job.status==='queued')waiting.push(job);
   }
  }
  waiting.sort((a,b)=>a.objectStagedAt-b.objectStagedAt);dispatch();
 })();
 // ready() and requests report initialization errors; suppress an unobserved startup rejection.
 initialized.catch(error=>{void error;});
 return {
  /** Recover unsubmitted work before accepting gateway traffic. */
  async ready(){await initialized;},
  /** Await all accepted flash work and report any durable-ledger write failure. */
  async idle(){await initialized;while(active.size||workers.size)await Promise.all([...active.values()].map(item=>item.promise).concat([...workers.values()].map(item=>item.promise)));if(workerFailure)throw workerFailure;},
  /** Upload verified audio and make at most one billable submit per account/key. */
  async submit(account,key,expectedHash,language,req){
   await initialized;if(workerFailure)throw fail(503,'ASR job storage is unavailable');
   if(!validKey(key)||!(/^[0-9a-f]{64}$/i).test(expectedHash)||!['zh','auto'].includes(language))throw fail(400,'Invalid ASR request fields');
   const activeKey=account+'\0'+key;
   if(active.has(activeKey)){
    const running=active.get(activeKey);req.resume();
    if(running.hash!==expectedHash||running.language!==language)throw fail(409,'Idempotency key already belongs to different audio');
    return await running.promise;
   }
   if(providerKind==='flash'){
    const existing=await read(account,key);
    if(active.has(activeKey)){
     const running=active.get(activeKey);req.resume();
     if(running.hash!==expectedHash||running.language!==language)throw fail(409,'Idempotency key already belongs to different audio');
     return await running.promise;
    }
    if(existing&&!['preparing','failed'].includes(existing.status)){
     req.resume();if(existing.hash!==expectedHash||existing.language!==language)throw fail(409,'Idempotency key already belongs to different audio');return publicJob(existing);
    }
    if(busy(activeKey)) {req.resume();throw fail(429,'Too many active cloud transcription jobs','upload_busy',2);}
    const occupied=new Set([...active.keys(),...workers.keys(),...waiting.map(jobKey)]).size;
    if(occupied>=maxConcurrentJobs+maxQueuedJobs){req.resume();throw fail(429,'Cloud transcription queue is full','queue_full',2);}
   }
   const pendingLimit=providerKind==='flash'?maxPendingUploadsPerAccount:maxActiveJobs;
   if([...active.values()].filter(item=>item.account===account).length>=pendingLimit){req.resume();throw fail(429,'Too many active cloud transcription jobs','upload_busy',2);}
   const previous=accountTails.get(account)??Promise.resolve();
   const id=key,file=audioPath(account,key);let retainAudio=false,ownsAudio=false;
   const pending=(async()=>{try{
    if(providerKind==='flash')await previous;
    const existing=await read(account,key);
    if(existing){if(existing.hash!==expectedHash||existing.language!==language)throw fail(409,'Idempotency key already belongs to different audio');
     if(!['preparing','failed'].includes(existing.status)){req.resume();return publicJob(existing);}}
    await mkdir(jobs,{recursive:true,mode:0o700});await mkdir(audio,{recursive:true,mode:0o700});
    ownsAudio=true;await rm(file,{force:true});
    await stage(req,file,expectedHash);const probed=await probe(file),duration=typeof probed==='number'?probed:probed.duration,audioFormat=typeof probed==='number'?'mp3':probed.format;
    if(duration>maxDurationSeconds)throw fail(413,'Audio exceeds the transcription duration limit');
    const taskHash=digest(account+'\0'+key),taskId=`${taskHash.slice(0,8)}-${taskHash.slice(8,12)}-4${taskHash.slice(13,16)}-8${taskHash.slice(17,20)}-${taskHash.slice(20,32)}`;
    const job={id,taskId,account,hash:expectedHash,language,duration,audioFormat,day:new Date(now()).toISOString().slice(0,10),providerKind,status:'preparing'};
    const resource=await reserve(job,existing);
    if(providerKind==='flash'){
     retainAudio=true;return publicJob({...job,status:workers.has(jobKey(job))?'processing':'queued'});
    }
    let step='storage-preflight';
    try{
     const object=storage.key(taskId,audioFormat);await storage.assertPrivateBeforeUpload();step='upload';job.objectStagedAt=now();await save(account,key,job);await storage.upload(file,object);step='storage-verification';const url=await storage.signedReadUrl(object);await storage.assertPrivateAndReadable(object,url);
     job.status='submitting';await save(account,key,job);
     try{await resource.provider.submit({id:taskId,url,language,format:audioFormat});job.status='processing';await save(account,key,job);}catch(error){job.status='uncertain';recordProviderFailure(job,error);await save(account,key,job);}
     return publicJob(job);
    }catch(error){if(job.status==='preparing'){job.status='failed';job.failureStage=step;await save(account,key,job);await cleanup(job,account,key);}throw error;}
   }finally{if(ownsAudio&&!retainAudio)await rm(file,{force:true});}
   })();active.set(activeKey,{account,hash:expectedHash,language,promise:pending});
   const tail=pending.then(()=>{},()=>{});accountTails.set(account,tail);
   try{return await pending;}finally{active.delete(activeKey);if(accountTails.get(account)===tail)accountTails.delete(account);}
  },
  /** Read only a job owned by this account; query a charged task without resubmission. */
  async get(account,key){await initialized;if(!validKey(key))throw fail(400,'Invalid ASR job ID');const job=await read(account,key);if(!job)throw fail(404,'ASR job not found');
   if(active.has(account+'\0'+key)||busy(account+'\0'+key))return publicJob(job);
   if(job.providerKind!=='flash'&&['processing','submitting','uncertain'].includes(job.status))await poll(job,account,key);
   const current=await read(account,key);await expire(current);
   return publicJob(current);
  },
  /** Remove expired temporary objects while retaining receipts and original task IDs. */
  async sweep(){
   await initialized;
   for(const name of await readdir(jobs).catch(error=>error.code==='ENOENT'?[]:Promise.reject(error))){
    if(!name.endsWith('.json'))continue;
    const job=JSON.parse(await readFile(join(jobs,name),'utf8'));
    await expire(job);
   }
  },
 };
}

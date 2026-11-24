/** Durable, single-writer feedback analysis and archive maintenance for the account gateway. */
import {mkdir,readFile,writeFile,rename,unlink} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash,randomBytes} from 'node:crypto';
import {openFeedbackDaily} from './feedback-daily.mjs';

const actor={id:'feedback-automation',username:'自动巡检',admin:true};
const failure='自动分析暂时失败，请稍后重试。';
const states=new Set(['pending','running','done','failed']);
const reviews=new Set(['pending','accepted','ignored']);
const error=(message,status=400)=>Object.assign(Error(message),{status});
const iso=time=>new Date(time).toISOString();
const localDay=time=>iso(time+8*60*60*1000).slice(0,10);
const terminal=item=>item.status==='resolved'||item.status==='closed';
const hash=item=>createHash('sha256').update(JSON.stringify([1,item.title,item.body,item.category,item.attachments])).digest('hex');
const dto=job=>job?structuredClone({state:job.state,review:job.review,revision:job.revision,...job.result?{result:job.result}:{},...job.error?{error:job.error}:{},...job.analyzedAt?{analyzedAt:job.analyzedAt}:{},...job.reviewedAt?{reviewedAt:job.reviewedAt,reviewedBy:job.reviewedBy}:{}}):null;
const date=value=>typeof value==='string'&&Number.isFinite(Date.parse(value));
const plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const validResult=value=>plain(value)&&['bug','experience','suggestion','question','invalid'].includes(value.category)&&['high','normal','low'].includes(value.priority)&&['low','medium','high'].includes(value.confidence)&&typeof value.summary==='string'&&typeof value.suggestedReply==='string'&&['possibleCauses','evidence','missingInfo'].every(key=>Array.isArray(value[key])&&value[key].every(item=>typeof item==='string'))&&(value.duplicateOf===null||typeof value.duplicateOf==='string'&&/^[a-f0-9]{32}$/.test(value.duplicateOf));

function candidates(item,items){
 const terms=value=>new Set((value.toLowerCase().match(/[a-z0-9]+|[\u3400-\u9fff]/gu)??[]));
 const source=terms(item.title+' '+item.body.slice(0,2000));
 return items.filter(other=>other.id!==item.id).map(other=>{
  const words=terms(other.title+' '+other.body.slice(0,2000));let common=0;for(const word of words)if(source.has(word))common++;
  return {other,score:common/Math.max(1,source.size+words.size-common)};
 }).filter(row=>row.score>0).sort((a,b)=>b.score-a.score||a.other.id.localeCompare(b.other.id)).slice(0,10).map(({other})=>({id:other.id,title:other.title,body:other.body.slice(0,2000),category:other.category}));
}

function settings(input,available){
 const result={enabled:available,intervalMinutes:10,archiveAfterDays:90,...input};
 if(typeof result.enabled!=='boolean'||!Number.isInteger(result.intervalMinutes)||result.intervalMinutes<1||result.intervalMinutes>1440||!Number.isInteger(result.archiveAfterDays)||result.archiveAfterDays<1||result.archiveAfterDays>3650)throw error('自动巡检配置无效');
 if(result.enabled&&!available)throw error('请先配置自动分析模型',503);
 return {enabled:result.enabled,intervalMinutes:result.intervalMinutes,archiveAfterDays:result.archiveAfterDays};
}

function decode(value,available){
 if(!plain(value)||value.version!==1||!plain(value.jobs)||!plain(value.settings)||typeof value.settings.enabled!=='boolean')throw Error('Invalid feedback automation state');
 settings({...value.settings,enabled:false},available);
 for(const key of ['nextRunAt','lastArchiveAt'])if(value[key]!==null&&!date(value[key]))throw Error('Invalid feedback automation timestamp');
 if(value.lastRun!==null&&(!plain(value.lastRun)||!date(value.lastRun.at)||!['analyzed','failed','archived'].every(key=>Number.isSafeInteger(value.lastRun[key])&&value.lastRun[key]>=0)))throw Error('Invalid feedback automation run');
 if(value.digest!==null&&(!plain(value.digest)||!date(value.digest.at)||!['pending','failed','needsReview','duplicates','archived','active','attachmentBytes','analyzed'].every(key=>Number.isSafeInteger(value.digest[key])&&value.digest[key]>=0)))throw Error('Invalid feedback automation digest');
 for(const [id,job]of Object.entries(value.jobs)){
  if(!/^[a-f0-9]{32}$/.test(id)||!plain(job)||!states.has(job.state)||!reviews.has(job.review)||!Number.isSafeInteger(job.revision)||job.revision<1||!Number.isSafeInteger(job.attempts)||job.attempts<0||typeof job.hash!=='string'||!/^[a-f0-9]{64}$/.test(job.hash)||!Number.isSafeInteger(job.nextAttemptAt)||job.nextAttemptAt<0||job.analyzedAt!==undefined&&!date(job.analyzedAt)||job.reviewedAt!==undefined&&(!date(job.reviewedAt)||typeof job.reviewedBy!=='string')||job.result!==undefined&&!validResult(job.result)||job.state==='done'&&(!validResult(job.result)||!date(job.analyzedAt))||job.error!==undefined&&job.error!==failure)throw Error('Invalid feedback automation job');
 }
 return value;
}

/**
 * Open the gateway-owned automation ledger; call start after the HTTP server is ready.
 * @param {object} options - Private root, feedback store, abortable analyzer, clock and limits.
 * @returns {Promise<object>} Lifecycle, settings, manual run and administrator review operations.
 */
export async function openFeedbackAutomation({root,feedback,analyze,now=Date.now,config={}}){
 const available=typeof analyze==='function';
 const limits={batchSize:20,maxAttempts:3,retryBaseMs:60000,analysisTimeoutMs:60000,...config};
 for(const [name,maximum]of [['batchSize',100],['maxAttempts',10],['retryBaseMs',86400000],['analysisTimeoutMs',600000]])if(!Number.isSafeInteger(limits[name])||limits[name]<1||limits[name]>maximum)throw error('自动巡检执行限制无效');
 await mkdir(root,{recursive:true,mode:0o700});
 const file=join(root,'state.json');
 let state;
 try{state=decode(JSON.parse(await readFile(file,'utf8')),available);}catch(cause){if(cause.code!=='ENOENT')throw cause;state={version:1,settings:settings(config,available),jobs:{},lastRun:null,lastArchiveAt:null,digest:null,nextRunAt:null};}
 const packages=await openFeedbackDaily({root:join(root,'packages'),feedback,now});
 let queue=Promise.resolve(),runPromise=null,controller=null,timer=null,started=false,closing=false,closePromise,retrySuppressedUntil=0;
 const serial=fn=>{const work=queue.then(fn);queue=work.catch(error=>{
  // The caller receives this rejection; later ledger operations remain runnable.
 });return work;};
 const save=async change=>{
  const next=structuredClone(state);change(next);
  const temp=join(root,'.state-'+randomBytes(8).toString('hex')+'.tmp');
  try{await writeFile(temp,JSON.stringify(next),{flag:'wx',mode:0o600});await rename(temp,file);}finally{await unlink(temp).catch(cause=>{if(cause.code!=='ENOENT')throw cause;});}
  state=next;
 };
 const requireOpen=()=>{if(closing)throw error('自动巡检已停止',503);};
 const effectiveSettings=()=>({...state.settings,enabled:state.settings.enabled&&available});
 const summary=items=>{
  const result={pending:0,failed:0,needsReview:0,duplicates:0,archived:0,active:0,attachmentBytes:0};
  for(const item of items){
   result[item.archivedAt?'archived':'active']++;
   result.attachmentBytes+=(item.attachments??[]).reduce((sum,attachment)=>sum+attachment.size,0);
   const job=state.jobs[item.id];
   if(!item.archivedAt&&!terminal(item)&&(!job||job.hash!==hash(item)||job.state==='pending'||job.state==='running'))result.pending++;
   if(job?.state==='failed')result.failed++;
   if(job?.state==='done'&&job.review==='pending')result.needsReview++;
   if(job?.state==='done'&&job.result?.duplicateOf)result.duplicates++;
  }
  return result;
 };
 const dailyTarget=(hour,minute,time=now())=>Date.parse(localDay(time)+`T${String(hour).padStart(2,'0')}:${String(minute).padStart(2,'0')}:00+08:00`);
 const due=(last,hour,minute,time=now())=>time>=dailyTarget(hour,minute,time)&&(!last||localDay(Date.parse(last))<localDay(time));
 function nextWake(){
  if(!started||closing||!effectiveSettings().enabled||runPromise)return null;
  const time=now(),targets=[state.nextRunAt?Date.parse(state.nextRunAt):time];
  for(const job of Object.values(state.jobs))if(job.eligible!==false&&(job.state==='failed'||job.state==='pending')&&job.attempts<limits.maxAttempts)targets.push(Math.max(job.nextAttemptAt,retrySuppressedUntil));
  const packageDay=packages.checkedDate();
  for(const [last,hour,minute]of [[state.lastArchiveAt,3,30],[state.digest?.at,9,0],[packageDay?packageDay+'T01:00:00Z':null,9,0]]){
   const today=dailyTarget(hour,minute,time);
   targets.push(due(last,hour,minute,time)?time:today>time?today:today+86400000);
  }
  return Math.max(time+1,Math.min(...targets),retrySuppressedUntil);
 }
 function schedule(){
  if(timer)clearTimeout(timer);timer=null;
  const target=nextWake();if(target===null)return;
  timer=setTimeout(()=>{timer=null;void run(false).catch(()=>{schedule();});},Math.max(1,target-now()));timer.unref();
 }
 async function callAnalyzer(input,signal){
  const timeout=new AbortController(),abort=()=>timeout.abort();signal.addEventListener('abort',abort,{once:true});
  if(signal.aborted)abort();
  const deadline=setTimeout(()=>timeout.abort(),limits.analysisTimeoutMs);deadline.unref();
  try{if(timeout.signal.aborted)throw error(failure,503);const result=await analyze(input,{signal:timeout.signal});if(timeout.signal.aborted)throw error(failure,503);return result;}
  finally{clearTimeout(deadline);signal.removeEventListener('abort',abort);}
 }
 async function execute(signal){
  const counts={at:iso(now()),analyzed:0,failed:0,archived:0};
  let items=await feedback.snapshot();
  await serial(async()=>{
   if(closing)return;
   await save(next=>{
    for(const item of items){
     if(item.archivedAt||terminal(item)){if(next.jobs[item.id])next.jobs[item.id].eligible=false;continue;}
     const current=next.jobs[item.id],inputHash=hash(item);
     if(!current||current.hash!==inputHash)next.jobs[item.id]={hash:inputHash,state:'pending',review:'pending',revision:(current?.revision??0)+1,attempts:0,nextAttemptAt:0,eligible:true};
     else current.eligible=true;
    }
    next.nextRunAt=iso(now()+next.settings.intervalMinutes*60000);
   });
  });
  const pending=items.filter(item=>!item.archivedAt&&!terminal(item)).filter(item=>{const job=state.jobs[item.id];return job&&(job.state==='pending'||job.state==='failed')&&job.attempts<limits.maxAttempts&&job.nextAttemptAt<=now();}).slice(0,limits.batchSize);
  for(const item of pending){
   if(signal.aborted||closing)break;
   const inputHash=hash(item);
   await serial(async()=>{if(!closing)await save(next=>{const job=next.jobs[item.id];job.state='running';job.attempts++;job.revision++;});});
   if(signal.aborted||closing)break;
   try{
    const result=await callAnalyzer({id:item.id,title:item.title,body:item.body,category:item.category,attachments:item.attachments,duplicates:candidates(item,items)},signal);
    if(signal.aborted||closing)break;
    await serial(async()=>{
     if(closing)return;
     const current=(await feedback.snapshot()).find(row=>row.id===item.id);
     if(!current||hash(current)!==inputHash)return;
     await save(next=>{const job=next.jobs[item.id];job.state='done';job.review='pending';job.result=result;job.analyzedAt=iso(now());job.revision++;delete job.error;});counts.analyzed++;
    });
   }catch(cause){
    if(signal.aborted||closing)break;
    await serial(async()=>{if(!closing)await save(next=>{const job=next.jobs[item.id];job.state='failed';job.error=failure;job.nextAttemptAt=now()+limits.retryBaseMs*2**(job.attempts-1);job.revision++;});});counts.failed++;
   }
  }
  if(signal.aborted||closing)return;
  if(due(state.lastArchiveAt,3,30)){
   items=await feedback.snapshot();
   for(const item of items){
    if(signal.aborted||closing)break;
    if(item.archivedAt||!terminal(item)||Date.parse(item.updatedAt)>now()-state.settings.archiveAfterDays*86400000)continue;
    try{await feedback.setArchived(actor,item.id,{revision:item.revision,archived:true},iso(now()));counts.archived++;}catch(cause){if(cause.status!==409)counts.failed++;}
   }
   await serial(async()=>{if(!closing)await save(next=>{next.lastArchiveAt=iso(now());});});
  }
  if(signal.aborted||closing)return;
  items=await feedback.snapshot();
  if(now()>=dailyTarget(9,0)){
   const analyzed=state.jobs;
   counts.archived+=await packages.prepare(localDay(now()),items,item=>{
    const job=analyzed[item.id];
    return job?.state==='done'&&job.review!=='ignored'&&job.hash===hash(item)?job.result:null;
   },signal);
  }
  if(signal.aborted||closing)return;
  items=await feedback.snapshot();
  await serial(async()=>{
   if(closing)return;
   const since=state.digest?Date.parse(state.digest.at):now()-86400000;
   const analyzed=Object.values(state.jobs).filter(job=>job.analyzedAt&&Date.parse(job.analyzedAt)>since).length;
   const digest=due(state.digest?.at,9,0)?{at:iso(now()),...summary(items),analyzed}:null;
   await save(next=>{next.lastRun=counts;if(digest)next.digest=digest;for(const item of items)if(next.jobs[item.id])next.jobs[item.id].eligible=!item.archivedAt&&!terminal(item);});
  });
 }
 async function run(force=true){
  return serial(async()=>{
   requireOpen();if(!available)throw error('请先配置自动分析模型',503);
   if(runPromise)return {started:false};
   if(!force&&!effectiveSettings().enabled)return {started:false};
   controller=new AbortController();
   const signal=controller.signal;
   runPromise=Promise.resolve().then(()=>execute(signal)).catch(async cause=>{
    retrySuppressedUntil=now()+state.settings.intervalMinutes*60000;
    if(!closing)await serial(()=>save(next=>{next.lastRun={at:iso(now()),analyzed:0,failed:1,archived:0};next.nextRunAt=iso(now()+next.settings.intervalMinutes*60000);}));
   }).finally(()=>{runPromise=null;controller=null;schedule();});
   void runPromise.catch(error=>{console.error('MUSE feedback automation state could not be saved');});
   return {started:true};
  });
 }
 // Interrupted calls do not consume the completed-attempt retry allowance.
 await serial(async()=>{if(Object.values(state.jobs).some(job=>job.state==='running'))await save(next=>{for(const job of Object.values(next.jobs))if(job.state==='running'){job.state='pending';job.attempts=Math.max(0,job.attempts-1);job.revision++;}});});
 return {
  async status(){await queue;const wake=nextWake();return {settings:{...effectiveSettings(),archiveTime:'03:30',digestTime:'09:00'},available,running:!!runPromise,lastRun:structuredClone(state.lastRun),nextRunAt:wake===null?null:iso(wake),lastArchiveAt:state.lastArchiveAt,summary:summary(await feedback.snapshot()),digest:structuredClone(state.digest)};},
  configure(input){return serial(async()=>{requireOpen();if(!plain(input)||Object.keys(input).some(key=>!['enabled','intervalMinutes','archiveAfterDays'].includes(key)))throw error('自动巡检配置无效');const resolved=settings({...state.settings,...input},available);await save(next=>{next.settings=resolved;next.nextRunAt=resolved.enabled?iso(now()+resolved.intervalMinutes*60000):null;});schedule();return {...resolved,archiveTime:'03:30',digestTime:'09:00'};});},
  run,
  async retryFailed(){
   await serial(async()=>{requireOpen();if(!available)throw error('请先配置自动分析模型',503);const eligible=new Set((await feedback.snapshot()).filter(item=>!item.archivedAt&&!terminal(item)).map(item=>item.id));await save(next=>{for(const [id,job]of Object.entries(next.jobs))if(job.state==='failed'&&eligible.has(id)){job.state='pending';job.review='pending';job.attempts=0;job.nextAttemptAt=0;job.revision++;delete job.error;}});});
   return run();
  },
  async review(id,input){const reviewed=await serial(async()=>{
   requireOpen();const job=state.jobs[id];if(!job)throw error('分析记录不存在',404);if(input?.revision!==job.revision)throw error('分析记录已变化，请刷新重试',409);
   if(!['accept','ignore','retry'].includes(input.action))throw error('分析处理操作无效');
   if(input.action==='retry'){
    if(!available)throw error('请先配置自动分析模型',503);
    const item=(await feedback.snapshot()).find(row=>row.id===id);
    if(!item||item.archivedAt||terminal(item))throw error('已结案或已归档的意见无需重新排查',409);
   }
   if(input.action!=='retry'&&job.state!=='done')throw error('请等待分析完成',409);
   if(job.state==='running')throw error('分析正在运行，请稍后重试',409);
   const by=input.by??'管理员';if(typeof by!=='string'||!by.trim()||by.length>120)throw error('处理人无效');
   await save(next=>{const target=next.jobs[id];target.revision++;target.reviewedAt=iso(now());target.reviewedBy=by;if(input.action==='retry'){target.state='pending';target.review='pending';target.attempts=0;target.nextAttemptAt=0;delete target.result;delete target.error;delete target.analyzedAt;}else target.review=input.action==='accept'?'accepted':'ignored';});
   return dto(state.jobs[id]);
  });if(input.action==='retry')await run();return reviewed;},
  async triage(id){await queue;return dto(state.jobs[id]);},
  packages:{
   list:()=>packages.list(),
   download:(day,actor)=>{requireOpen();return packages.download(day,actor);},
   confirm:(day,actor,value)=>{requireOpen();return packages.confirm(day,actor,value);},
  },
  async start(){requireOpen();if(started)return;started=true;if(effectiveSettings().enabled)await run(false);schedule();},
  async idle(){await queue;if(runPromise)await runPromise;await queue;},
  close(){if(closePromise)return closePromise;closing=true;started=false;if(timer)clearTimeout(timer);timer=null;controller?.abort();closePromise=(async()=>{await queue;if(runPromise)await runPromise;await queue;await packages.idle();})();return closePromise;},
 };
}

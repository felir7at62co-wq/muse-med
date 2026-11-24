/** Durable source revisions and administrator decisions; approval proposes work without executing it. */
import {mkdir,lstat,open} from 'node:fs/promises';
import {dirname,isAbsolute} from 'node:path';
import {randomUUID} from 'node:crypto';
import {resolveProductionConfig} from './production-source.mjs';

const failure=(status,message)=>Object.assign(Error(message),{status});
const authenticate=session=>{if(!session?.account||session.id!==session.account.id||session.account.disabled)throw failure(401,'Sign in required');return session.account;};
const administrative=session=>{const account=authenticate(session);if(account.admin!==true)throw failure(403,'Administrator access required');return account;};
const parse=value=>value?JSON.parse(value):null;

/** Open the sole production-board ledger beside other private account service data.
 * @param {object} options Private file, source mapping, read-only source, idempotent dispatcher, task and original-proposal lookups, and trusted device ownership resolver.
 * @returns {Promise<object>} Read, sync, administrator decision, authorized attachment download and close methods.
 */
export async function openProductionBoard({file,config:input,source,proposeTask,taskById,lookupTask,deviceOwner,now=Date.now}){
 const config=resolveProductionConfig(input);
 if(!isAbsolute(file)||!source?.read||!source?.download||typeof proposeTask!=='function'||typeof taskById!=='function'||typeof lookupTask!=='function'||typeof deviceOwner!=='function')throw Error('Invalid production board dependencies');
 await mkdir(dirname(file),{recursive:true,mode:0o700});const parent=await lstat(dirname(file));
 if(!parent.isDirectory()||parent.isSymbolicLink()||process.platform!=='win32'&&(parent.mode&0o077)!==0)throw Error('Production directory must be private');
 try{const handle=await open(file,'wx',0o600);await handle.close();}catch(error){if(error.code!=='EEXIST')throw error;}
 const stat=await lstat(file);if(!stat.isFile()||stat.isSymbolicLink()||process.platform!=='win32'&&(stat.mode&0o077)!==0)throw Error('Production database must be private');
 const {DatabaseSync}=await import('node:sqlite');const db=new DatabaseSync(file);
 try{
  const version=db.prepare('PRAGMA user_version').get().user_version;if(version>1)throw Error('Production schema is newer than this gateway');
  if(version===0)db.exec(`BEGIN IMMEDIATE;
   CREATE TABLE source_rows(key TEXT PRIMARY KEY,revision TEXT NOT NULL,value TEXT NOT NULL,present INTEGER NOT NULL);
   CREATE TABLE approvals(key TEXT PRIMARY KEY,revision TEXT NOT NULL,id TEXT NOT NULL,state TEXT NOT NULL,value TEXT NOT NULL);
   CREATE TABLE decision_history(id TEXT PRIMARY KEY,value TEXT NOT NULL);
   CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);
   PRAGMA user_version=1;COMMIT;`);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=100;');
 }catch(error){db.close();throw error;}
 let closing=false,activeSync,decisionQueue=Promise.resolve(),closingPromise;
 const getRow=key=>db.prepare('SELECT * FROM source_rows WHERE key=?').get(key);
 const getApproval=key=>{const row=db.prepare('SELECT * FROM approvals WHERE key=?').get(key);return row?{...parse(row.value),state:row.state,revision:row.revision}:null;};
 const saveApproval=(key,approval)=>{const value=JSON.stringify(approval);db.exec('BEGIN IMMEDIATE');try{db.prepare('INSERT INTO decision_history VALUES(?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value').run(approval.id,value);db.prepare('INSERT INTO approvals VALUES(?,?,?,?,?) ON CONFLICT(key) DO UPDATE SET revision=excluded.revision,id=excluded.id,state=excluded.state,value=excluded.value').run(key,approval.revision,approval.id,approval.state,value);db.exec('COMMIT');}catch(error){db.exec('ROLLBACK');throw error;}};
 const metadata=(key,value)=>db.prepare('INSERT INTO metadata VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key,JSON.stringify(value));
 let syncState=parse(db.prepare("SELECT value FROM metadata WHERE key='sync'").get()?.value)??{status:'pending',lastSuccessAt:null,error:null};
 function assertOpen(){if(closing)throw failure(503,'Production board is stopping');}
 async function sync(){
  assertOpen();if(activeSync)return activeSync;
  activeSync=(async()=>{
   try{
    const rows=await source.read();
    if(!Array.isArray(rows)||rows.length>config.maxRows||new Set(rows.map(r=>r.key)).size!==rows.length)throw Error('Invalid production snapshot');
    for(const row of rows)if(typeof row.key!=='string'||!/^[a-f0-9]{64}$/.test(row.revision)||!Array.isArray(row.scripts))throw Error('Invalid production row');
    db.exec('BEGIN IMMEDIATE');
    try{db.exec('UPDATE source_rows SET present=0');const put=db.prepare('INSERT INTO source_rows VALUES(?,?,?,1) ON CONFLICT(key) DO UPDATE SET revision=excluded.revision,value=excluded.value,present=1');for(const row of rows)put.run(row.key,row.revision,JSON.stringify(row));syncState={status:'ready',lastSuccessAt:new Date(now()).toISOString(),error:null};metadata('sync',syncState);db.exec('COMMIT');}
    catch(error){db.exec('ROLLBACK');throw error;}
   }catch(error){syncState={...syncState,status:'error',error:'无法同步飞书制作表，请核对应用权限和网络'};metadata('sync',syncState);throw failure(502,syncState.error);}
   return {...syncState};
  })().finally(()=>{activeSync=undefined;});return activeSync;
 }
 function read(session){
  const account=authenticate(session);assertOpen();
  const rows=db.prepare('SELECT * FROM source_rows WHERE present=1 OR key IN (SELECT key FROM approvals) ORDER BY key').all().flatMap(stored=>{
   const approval=getApproval(stored.key);
   if(!account.admin&&(!approval?.ownerAccountId||approval.ownerAccountId!==account.id))return [];
   const row=parse(stored.value),task=approval?.taskId?taskById(approval.taskId):null;
   return [{...row,sourceRemoved:stored.present!==1,sourceChanged:!!approval&&approval.revision!==row.revision,
    eligible:stored.present===1&&row.eligible,approval,
    task:task?{id:task.id,state:task.state,result:task.result??null,progress:task.progress??[],updatedAt:task.updatedAt??task.updated_at??null}:null}];
  });
  return {sync:{...syncState,intervalMs:config.intervalMs},scopeGroup:config.group,administrator:account.admin===true,
   counts:{total:rows.length,ready:rows.filter(r=>r.eligible&&!r.approval).length,approved:rows.filter(r=>r.approval&&r.approval.state!=='rejected').length,rejected:rows.filter(r=>r.approval?.state==='rejected').length},rows};
 }
 function decide(session,input){
  const account=administrative(session);assertOpen();
  if(!input||typeof input.key!=='string'||typeof input.revision!=='string'||!['approve','reject'].includes(input.decision)||typeof (input.details??'')!=='string'||(input.details??'').length>4000)throw failure(400,'Invalid production decision');
  const operation=decisionQueue.then(async()=>{
   const original=getApproval(input.key);
   if(original&&(original.state==='dispatching'||original.state==='dispatch_unknown')){
    if(original.revision!==input.revision||original.decision!==input.decision||original.deviceId!==(input.deviceId??null)||original.details!==(input.details??''))throw failure(409,'已有审批记录，请先核对原任务，不能重复派发');
    let receipt;try{receipt=await lookupTask({accountId:original.by,requestId:'production:'+original.id});}catch(error){throw failure(502,'原派发结果暂时无法核对，请稍后使用原审批重试');}
    if(receipt){if(typeof receipt.id!=='string')throw failure(502,'原派发回执无效');original.taskId=receipt.id;original.state='offered';saveApproval(input.key,original);return original;}
   }
   await sync();const stored=getRow(input.key),row=stored&&parse(stored.value);
   if(!stored||!stored.present)throw failure(404,'Production record no longer available');
   if(stored.revision!==input.revision)throw failure(409,'制作表或剧本已更新，请刷新后重新确认');
   let prior=getApproval(input.key);
   if(prior?.state==='rejected'&&(prior.revision!==input.revision||input.decision==='approve'))prior=null;
   if(prior){
    if(prior.revision!==input.revision||prior.decision!==input.decision||prior.deviceId!==(input.deviceId??null)||prior.details!==(input.details??''))throw failure(409,'已有审批记录，请先核对原任务，不能重复派发');
    if(prior.state!=='dispatching'&&prior.state!=='dispatch_unknown')return prior;
   }
   if(input.decision==='approve'&&!row.eligible)throw failure(409,'剧目尚不符合启动条件');
   const ownerAccountId=input.decision==='approve'?(prior?prior.ownerAccountId:deviceOwner(input.deviceId)):null;
   if(input.decision==='approve'&&(typeof ownerAccountId!=='string'||!ownerAccountId))throw failure(409,'请选择已注册的执行 Bot');
   const approval=prior??{id:randomUUID(),revision:input.revision,decision:input.decision,state:input.decision==='reject'?'rejected':'dispatching',by:account.id,at:new Date(now()).toISOString(),deviceId:input.deviceId??null,ownerAccountId,details:input.details??'',taskId:null};
   saveApproval(input.key,approval);if(input.decision==='reject')return approval;
   try{
    const task=await proposeTask({requestId:'production:'+approval.id,deviceId:approval.deviceId,accountId:approval.by,
     prompt:`制作项目：${row.title}\n来源：${row.tableName} / ${config.group}\n原始记录：${row.sourceUrl}\n管理员已批准按本次剧本创建项目并准备全剧资产。先核对已下载的剧本与当前用户自己的制作平台账号及已有项目；复用已有项目/生成收据，遇到未确认的收费请求结果先查询，避免重复提交。按项目、资产、视频、剪辑、交付实际进度上报证据；本次批准不包含自动视频生成、剪辑发布或对外发送。\n管理员补充：${approval.details||'无'}\n本地用户接受后执行，具体制作细节由本地用户决定。`,
     productionSource:{key:row.key,revision:row.revision,scripts:row.scripts}});
    if(!task||typeof task.id!=='string')throw Error('Task receipt unavailable');
    approval.state='offered';approval.taskId=task.id;saveApproval(input.key,approval);return approval;
   }catch(error){approval.state='dispatch_unknown';saveApproval(input.key,approval);throw failure(502,'派发结果待核对，请使用原审批重试，不要重复创建项目');}
  });
  decisionQueue=operation.then(()=>undefined,()=>undefined);return operation;
 }
 async function download(session,input){
  const account=authenticate(session);assertOpen();const row=input&&getRow(input.key),approval=input&&getApproval(input.key);
  if(!row||!row.present||row.revision!==input.revision)throw failure(409,'Script revision has changed');
  if(!account.admin&&(!approval||approval.ownerAccountId!==account.id||approval.revision!==input.revision||approval.decision!=='approve'))throw failure(403,'Script access denied');
  const file=parse(row.value).scripts.find(f=>f.token===input.fileToken);if(!file)throw failure(404,'Script attachment unavailable');
  return source.download(file);
 }
 return {read,sync,decide,download,close(){if(closingPromise)return closingPromise;closing=true;source.close?.();closingPromise=(async()=>{await Promise.allSettled([activeSync,decisionQueue]);db.close();})();return closingPromise;}};
}

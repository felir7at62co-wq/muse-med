/** Account- and live-device-bound Bot coordination. Proposals never execute without local owner acceptance. */
import {mkdirSync,lstatSync,openSync,closeSync} from 'node:fs';
import {dirname,isAbsolute} from 'node:path';
import {openCloudLedger} from './bot-cloud-ledger.js';

const failure=(status,message)=>Object.assign(Error(message),{status});
const text=(value,name,max=256)=>{if(typeof value!=='string'||!value.trim()||value.length>max||/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value))throw failure(400,'Invalid '+name);return value.trim();};
const iso=value=>value===null||value===undefined?null:new Date(value).toISOString();
const stages=new Set(['project','assets','video','editing','delivery']);

/** Validate source identifiers supplied by the trusted production approval service, never by a model or ordinary proposal JSON.
 * @param {object|undefined} input Approval-owned source version and attachments.
 * @returns {object|undefined} Bounded canonical identifiers; no URL or user-controlled download destination.
 */
export function botProductionSource(input){
 if(input===undefined)return;
 if(!input||typeof input!=='object'||!Array.isArray(input.scripts)||input.scripts.length<1||input.scripts.length>10)throw failure(400,'Invalid production source');
 let total=0;const tokens=new Set();
 const scripts=input.scripts.map(script=>{
  const token=text(script?.token,'script token'),name=text(script?.name,'script name',200);
  if(/[\\/]/.test(name)||name==='.'||name==='..'||!Number.isSafeInteger(script.size)||script.size<1||script.size>64*1024*1024||tokens.has(token))throw failure(400,'Invalid production script');
  total+=script.size;tokens.add(token);return {token,name,size:script.size};
 });
 if(total>256*1024*1024)throw failure(400,'Production input is too large');
 return {key:text(input.key,'production key'),revision:text(input.revision,'production revision'),scripts};
}

function progressValue(input){
 if(!input||!stages.has(input.stage)||!['running','blocked','reported'].includes(input.status))throw failure(400,'Invalid progress stage');
 const summary=text(input.summary,'progress summary',4000),artifacts=input.artifacts??[];
 if(!Array.isArray(artifacts)||artifacts.length>10)throw failure(400,'Invalid progress artifacts');
 return {stage:input.stage,status:input.status,summary,artifacts:artifacts.map(artifact=>{
  const name=text(artifact?.name,'artifact name',200);
  if(typeof artifact.url==='string'){const value=text(artifact.url,'artifact URL',4096),url=new URL(value);if(!['https:','http:'].includes(url.protocol)||url.username||url.password)throw failure(400,'Invalid artifact URL');return {name,url:value};}
  return {name,path:text(artifact?.path,'artifact path',4096)};
 })};
}

/** Open formal coordination storage and bind it to existing account and desktop authority.
 * @param {object} options Absolute private file, existing account store, same-token online device check, online-device projection, clock and report freshness milliseconds.
 * @returns {object} HTTP handling, read-only snapshots and trusted production dispatch operations.
 */
export function createBotCoordination({file,store,authorizeDevice,onlineDevices,now=Date.now,statusTtlMs=30000}){
 if(!isAbsolute(file)||typeof store?.get!=='function'||typeof authorizeDevice!=='function'||typeof onlineDevices!=='function'||!Number.isSafeInteger(statusTtlMs)||statusTtlMs<1000||statusTtlMs>300000)throw Error('Invalid Bot coordination configuration');
 mkdirSync(dirname(file),{recursive:true,mode:0o700});
 const dir=lstatSync(dirname(file));if(!dir.isDirectory()||dir.isSymbolicLink()||process.platform!=='win32'&&(dir.mode&0o077))throw Error('Bot coordination directory must be private');
 try{closeSync(openSync(file,'wx',0o600));}catch(error){if(error.code!=='EEXIST')throw error;}
 const metadata=lstatSync(file);if(!metadata.isFile()||metadata.isSymbolicLink()||process.platform!=='win32'&&(metadata.mode&0o077))throw Error('Bot coordination file must be private');
 const ledger=openCloudLedger(file,now);
 ledger.recoverNotifications();
 function account(session){const current=session&&store.get(session.id);if(!current||current.disabled||session.account?.id!==current.id)throw failure(401,'Sign in required');return current;}
 function administrator(session){const current=account(session);if(!current.admin)throw failure(403,'Administrator access required');return current;}
 function owned(session,deviceId,live=true){
  const current=account(session);text(deviceId,'device id');
  if(!store.desktopDevices(current.id).some(device=>device.id===deviceId))throw failure(404,'Device not found');
  if(live&&!authorizeDevice({session,deviceId}))throw failure(403,'The authenticated local desktop connection is required');
  return current;
 }
 function deviceOwner(deviceId){const device=ledger.device(deviceId);return device&&store.get(device.owner_id)?device.owner_id:null;}
 function readyDeviceOwner(deviceId){const owner=deviceOwner(deviceId),row=owner&&ledger.device(deviceId);return owner&&!store.get(owner).disabled&&row.main_bot_id&&row.session_id&&Number.isFinite(row.reported_at)&&now()-row.reported_at>=0&&now()-row.reported_at<statusTtlMs&&onlineDevices(owner).some(device=>device.id===deviceId)?owner:null;}
 function taskRow(id){return ledger.task(text(id,'task id'));}
 function rawTask(row){return row?{...row,productionSource:row.production_source?JSON.parse(row.production_source):undefined,progress:ledger.progress(row.id)}:null;}
 function safeTask(row){const ownerAccountId=deviceOwner(row.device_id);return {id:row.id,ownerAccountId,deviceId:row.device_id,issuerId:row.issuer_id,prompt:row.prompt,state:row.state,createdAt:iso(row.created_at),updatedAt:iso(row.updated_at),sessionId:row.session_id??null,result:row.result??null,progress:ledger.progress(row.id),verification:'reported',hasProductionSource:!!row.production_source};}
 function canRead(session,row){const current=account(session);if(!row||!current.admin&&deviceOwner(row.device_id)!==current.id)throw failure(404,'Task not found');return current;}
 function dispatchTask({requestId,deviceId,prompt,accountId,productionSource}){
  const issuer=store.get(accountId);if(!issuer||issuer.disabled||!issuer.admin)throw failure(403,'Administrator issuer required');
  if(!ledger.taskByRequest(requestId)&&!readyDeviceOwner(deviceId))throw failure(409,'An online registered Main Bot with a fresh status is required');
  return safeTask(ledger.propose({requestId,deviceId,issuerId:issuer.id,prompt,productionSource:botProductionSource(productionSource)}));
 }
 function findProposal({accountId,requestId}){
  const issuer=store.get(accountId);if(!issuer||issuer.disabled||!issuer.admin)throw failure(403,'Administrator issuer required');
  const row=ledger.taskByRequest(requestId);return row?.issuer_id===issuer.id?safeTask(row):null;
 }
 function snapshot(session,{scope=account(session).admin?'organization':'self'}={}){
  const current=account(session);if(!['organization','self'].includes(scope))throw failure(400,'Invalid Bot scope');if(scope==='organization'&&!current.admin)throw failure(403,'Administrator access required');
  const members=store.list().filter(member=>scope==='organization'||member.id===current.id).map(member=>({accountId:member.id,cloudMemberId:'account:'+member.id,name:[...new Set((member.feishuIdentities??[]).map(identity=>identity.name).filter(Boolean))].join(' / ')||member.username,mainBot:null,status:'unreported'}));
  const visible=new Set(members.map(member=>member.accountId)),devices=[];
  for(const member of members){
   if(store.get(member.accountId)?.disabled)continue;
   for(const online of onlineDevices(member.accountId)){
    const candidate=ledger.device(online.id),saved=candidate?.owner_id===member.accountId?candidate:null,fresh=!!saved&&Number.isFinite(saved.reported_at)&&now()-saved.reported_at>=0&&now()-saved.reported_at<statusTtlMs;
    devices.push({id:online.id,ownerAccountId:member.accountId,name:online.name,mainBot:saved?.main_bot_id&&saved?.session_id?{id:saved.main_bot_id,sessionId:saved.session_id,name:saved.bot_name}:null,botStatus:fresh?saved.bot_status:'unreported',reportedAt:iso(saved?.reported_at),statusFresh:fresh,online:true});
   }
  }
  return {members,devices,tasks:ledger.tasks().filter(task=>visible.has(deviceOwner(task.device_id))).map(safeTask)};
 }
 async function json(req){const decoder=new TextDecoder('utf8',{fatal:true});let body='',size=0;for await(const chunk of req){size+=chunk.length;if(size>65536)throw failure(413,'Bot request too large');body+=decoder.decode(chunk,{stream:true});}body+=decoder.decode();let result;try{result=JSON.parse(body);}catch(error){throw failure(400,'Invalid Bot JSON');}if(!result||typeof result!=='object'||Array.isArray(result))throw failure(400,'Invalid Bot body');return result;}
 async function handle(req,res,session,path){
  if(!path.startsWith('/api/bot-team/'))return false;
  const answer=(status,value)=>{res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});res.end(JSON.stringify(value));};
  try{
   account(session);const url=new URL(req.url,'http://localhost'),body=req.method==='POST'?await json(req):{};let value;
   if(req.method==='GET'&&path==='/api/bot-team/snapshot')value=snapshot(session,{scope:url.searchParams.get('scope')??undefined});
   else if(req.method==='GET'&&path==='/api/bot-team/task'){const row=taskRow(url.searchParams.get('id'));canRead(session,row);value=safeTask(row);}
   else if(req.method==='POST'&&path==='/api/bot-team/proposals'){
    const issuer=administrator(session);if(body.productionSource!==undefined)throw failure(400,'Production source requires the approval service');value=dispatchTask({requestId:body.requestId,deviceId:body.deviceId,prompt:body.prompt,accountId:issuer.id});
   }else if(req.method==='POST'&&path==='/api/bot-team/decision'){
    owned(session,body.deviceId,false);value=safeTask(ledger.decide(body.deviceId,body.taskId,body.accept,body.details??''));
   }else{
    const deviceId=req.method==='GET'?url.searchParams.get('deviceId'):body.deviceId,current=owned(session,deviceId);
    if(req.method==='POST'&&['/api/bot-team/register','/api/bot-team/status'].includes(path)){
     const desktop=store.desktopDevices(current.id).find(device=>device.id===deviceId);
     value=ledger.reportDevice({id:deviceId,ownerId:current.id,name:desktop.name,mainBotId:body.mainBotId,sessionId:body.sessionId,botName:body.botName,status:body.status,epoch:body.epoch,version:body.statusVersion,register:path.endsWith('/register')});
    }else if(req.method==='GET'&&path==='/api/bot-team/inbox')value=ledger.tasksFor(deviceId).map(rawTask);
    else if(req.method==='POST'&&path==='/api/bot-team/notifications/claim'){administrator(session);value=rawTask(ledger.claimNotification(current.id));}
    else if(req.method==='POST'&&path==='/api/bot-team/notifications/receipt'){
     administrator(session);const task=taskRow(body.taskId);if(!task||task.issuer_id!==current.id)throw failure(404,'Task result not found');value=rawTask(ledger.settleNotification(body.taskId,body.state));
    }
    else if(req.method==='POST'&&path==='/api/bot-team/claim'){if(!ledger.device(deviceId)?.main_bot_id)throw failure(409,'Register the actual Main Bot first');value=rawTask(ledger.claim(deviceId,{singleActive:true}));}
    else if(req.method==='POST'&&path==='/api/bot-team/receipt'){
     if(body.state==='delivered'&&body.value!==ledger.device(deviceId)?.session_id)throw failure(400,'Receipt must reference the registered Main Bot Session');
     value=rawTask(ledger.settle(deviceId,body.taskId,body.claimId,body.state,body.value));
    }else if(req.method==='POST'&&path==='/api/bot-team/progress'){
     const task=taskRow(body.taskId);if(!task||task.session_id!==ledger.device(deviceId)?.session_id)throw failure(404,'Task is not in the registered Session');
     ledger.reportProgress(deviceId,body.taskId,body.claimId,body.reportId,progressValue(body.progress));value=ledger.progress(body.taskId);
    }else throw failure(404,'Bot endpoint not found');
   }
   answer(200,{ok:true,value});
  }catch(error){answer(error.status??400,{ok:false,error:error.status?error.message:'Bot operation rejected'});}
  return true;
 }
 return {handle,snapshot,dispatchTask,findProposal,deviceOwner,readyDeviceOwner,task:id=>{const row=taskRow(id);return row?safeTask(row):null;},listTasks:({deviceId,accountId}={})=>ledger.tasks().filter(task=>(!deviceId||task.device_id===deviceId)&&(!accountId||deviceOwner(task.device_id)===accountId)).map(safeTask),close:()=>ledger.close()};
}

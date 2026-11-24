/** Durable daily packages, resumable download completion and weekly logical archives. */
import {createWriteStream} from 'node:fs';
import {mkdir,readFile,readdir,rename,stat,unlink,writeFile} from 'node:fs/promises';
import {createHmac,randomBytes,timingSafeEqual} from 'node:crypto';
import {join} from 'node:path';
import {pipeline} from 'node:stream/promises';
import {buildFeedbackPackage} from './feedback-package.mjs';

const dayPattern=/^\d{4}-\d{2}-\d{2}$/;
const idPattern=/^[a-f0-9]{32}$/;
const statusError=(message,status)=>Object.assign(Error(message),{status});
const validTimestamp=value=>typeof value==='string'&&Number.isFinite(Date.parse(value));
const validDay=value=>typeof value==='string'&&dayPattern.test(value)&&validTimestamp(value+'T00:00:00Z')&&new Date(value+'T00:00:00Z').toISOString().slice(0,10)===value;
const priority={high:0,normal:1,low:2};
const score=item=>priority[item.analysis?.priority]??3;
const order=(a,b)=>score(a)-score(b)||a.record.createdAt.localeCompare(b.record.createdAt)||a.record.id.localeCompare(b.record.id);

function group(rows){
 const byId=new Map(rows.map(row=>[row.record.id,row]));
 const parents=new Map(rows.map(row=>[row.record.id,row.record.id]));
 const root=id=>{
  while(parents.get(id)!==id){const parent=parents.get(id);parents.set(id,parents.get(parent));id=parent;}
  return id;
 };
 const link=(left,right)=>{const a=root(left),b=root(right);if(a!==b)parents.set(a,b);};
 const exact=new Map();
 for(const {record,analysis} of rows){
  const key=JSON.stringify([record.title.trim(),record.body.trim()]);
  if(exact.has(key))link(record.id,exact.get(key));else exact.set(key,record.id);
  if(byId.has(analysis?.duplicateOf))link(record.id,analysis.duplicateOf);
 }
 const groups=new Map();
 for(const row of rows){
  const key=root(row.record.id);
  if(!groups.has(key))groups.set(key,[]);
  groups.get(key).push(row);
 }
 return [...groups.values()].map(items=>({items:items.sort(order)})).sort((a,b)=>order(a.items[0],b.items[0]));
}

function decode(state){
 if(state?.version!==1||!Array.isArray(state.entries)||state.checkedDate!==null&&!validDay(state.checkedDate))throw Error('Invalid feedback package ledger');
 const dates=new Set(),ids=new Set();
 for(const entry of state.entries){
  if(!validDay(entry?.date)||dates.has(entry.date)||!state.checkedDate||entry.date>state.checkedDate||!validTimestamp(entry.createdAt)||!Array.isArray(entry.items)||entry.items.length<1||entry.items.length>5000||!Number.isSafeInteger(entry.groups)||entry.groups<1||entry.groups>entry.items.length||typeof entry.planned!=='boolean'||entry.downloadedAt!==null&&(!entry.planned||!validTimestamp(entry.downloadedAt)))throw Error('Invalid feedback package entry');
  if(entry.completedAt!=null&&(!entry.downloadedAt||!validTimestamp(entry.completedAt))||entry.archivedAt!=null&&(!entry.completedAt||!validTimestamp(entry.archivedAt)))throw Error('Invalid feedback package completion');
  if(entry.memberArchivedAt!=null&&(!entry.archivedAt||!validTimestamp(entry.memberArchivedAt)))throw Error('Invalid feedback package member archive');
  dates.add(entry.date);
  for(const item of entry.items){
   if(!idPattern.test(item?.id??'')||ids.has(item.id)||!Number.isSafeInteger(item.revision)||item.revision<1||item.revision>=Number.MAX_SAFE_INTEGER)throw Error('Invalid feedback package record');
   ids.add(item.id);
  }
 }
 return {...state,entries:state.entries.map(entry=>({...entry,completedAt:entry.completedAt??null,archivedAt:entry.archivedAt??null,memberArchivedAt:entry.memberArchivedAt??null}))};
}

const describe=entry=>({date:entry.date,count:entry.items.length,groups:entry.groups,createdAt:entry.createdAt,downloadedAt:entry.completedAt?entry.downloadedAt:null,archivedAt:entry.archivedAt});
const remove=path=>unlink(path).catch(error=>{if(error.code!=='ENOENT')throw error;});
const weekStart=day=>{
 const date=new Date(day+'T00:00:00Z');
 date.setUTCDate(date.getUTCDate()-(date.getUTCDay()+6)%7);
 return date.toISOString().slice(0,10);
};

/** Open the private ledger and resume planned or downloaded package status updates.
 * Download intent precedes feedback resolution; completion is public only after resolution returns.
 * Archived packages synchronize resolved members once, preserving later manual restorations.
 * @param {object} options Storage directory, idempotent feedback store and millisecond clock.
 * @returns {Promise<object>} Package operations; prepare returns the newly archived member count.
 */
export async function openFeedbackDaily({root,feedback,now}){
 await mkdir(root,{recursive:true,mode:0o700});
 const file=join(root,'packages.json'),key=randomBytes(32);
 const archivePath=day=>join(root,day+'.zip');
 let state;
 try{state=decode(JSON.parse(await readFile(file,'utf8')));}
 catch(error){if(error.code!=='ENOENT')throw error;state={version:1,checkedDate:null,entries:[]};}
 for(const entry of await readdir(root,{withFileTypes:true})){
  if(entry.isFile()&&/^\.(?:ledger|zip)-[a-f0-9]{16}\.tmp$/.test(entry.name))await remove(join(root,entry.name));
 }
 let queue=Promise.resolve();
 const serial=operation=>{
  const work=queue.then(operation);
  queue=work.catch(error=>{void error;});
  return work;
 };
 async function save(next){
  const temporary=join(root,'.ledger-'+randomBytes(8).toString('hex')+'.tmp');
  try{await writeFile(temporary,JSON.stringify(next),{flag:'wx',mode:0o600});await rename(temporary,file);}
  finally{await remove(temporary);}
  state=next;
 }
 async function replace(entry){await save({...state,entries:state.entries.map(current=>current.date===entry.date?entry:current)});}
 async function publish(entry){
  await feedback.planPackage({date:entry.date,items:entry.items,at:entry.createdAt});
  const planned={...entry,planned:true};
  await replace(planned);
  return planned;
 }
 async function complete(entry){
  await feedback.resolvePackage({date:entry.date,items:entry.items,at:entry.downloadedAt});
  const completed={...entry,completedAt:new Date(now()).toISOString()};
  await replace(completed);
  return completed;
 }
 async function archive(entry){
  const at=new Date(now()).toISOString();
  const result=await feedback.archivePackage({date:entry.date,items:entry.items,at});
  await replace({...entry,archivedAt:entry.archivedAt??at,memberArchivedAt:at});
  return result.updated.length;
 }
 async function resume(){
  let archived=0;
  for(const pending of state.entries){
   let entry=pending.planned?pending:await publish(pending);
   if(entry.downloadedAt&&!entry.completedAt)entry=await complete(entry);
   if(entry.archivedAt&&!entry.memberArchivedAt)archived+=await archive(entry);
  }
  return archived;
 }
 async function archiveCompleted(day){
  const monday=weekStart(day);let archived=0;
  for(const entry of state.entries)if(entry.completedAt&&!entry.archivedAt&&entry.date<monday)archived+=await archive(entry);
  return archived;
 }
 const find=day=>{
  const entry=state.entries.find(item=>item.date===day&&item.planned);
  if(!entry)throw statusError('该日期没有可下载的意见包',404);
  return entry;
 };
 const sign=(id,day,expires)=>createHmac('sha256',key).update(JSON.stringify([id,day,expires])).digest('hex');
 const receipt=(id,day)=>{const expires=now()+60*60000;return `${expires}.${sign(id,day,expires)}`;};
 function verify(value,id,day){
  const match=typeof value==='string'&&/^(\d{1,15})\.([a-f0-9]{64})$/.exec(value);
  if(!match||Number(match[1])<=now()||!timingSafeEqual(Buffer.from(match[2],'hex'),Buffer.from(sign(id,day,Number(match[1])),'hex')))throw statusError('下载确认已失效，请重新下载',409);
 }
 await resume();
 return {
  checkedDate:()=>state.checkedDate,
  prepare:(day,records,analysisFor,signal)=>serial(async()=>{
   if(!validDay(day))throw statusError('意见包日期无效',400);
   let archived=await resume();
   archived+=await archiveCompleted(day);
   if(signal.aborted||state.checkedDate&&day<=state.checkedDate)return archived;
   const packaged=new Set(state.entries.flatMap(entry=>entry.items.map(item=>item.id)));
   const rows=records.filter(item=>!item.archivedAt&&!['resolved','closed'].includes(item.status)&&!packaged.has(item.id)).map(record=>({record,analysis:analysisFor(record)}));
   if(!rows.length){await save({...state,checkedDate:day});return archived;}
   const groups=group(rows),createdAt=new Date(now()).toISOString();
   const entry={date:day,createdAt,items:rows.map(({record})=>({id:record.id,revision:record.revision})),groups:groups.length,planned:false,downloadedAt:null,completedAt:null,archivedAt:null,memberArchivedAt:null};
   const temporary=join(root,'.zip-'+randomBytes(8).toString('hex')+'.tmp');
   const contents=buildFeedbackPackage({date:day,groups,signal},(id,index)=>feedback.attachment({admin:true},id,index));
   try{
    await pipeline(contents,createWriteStream(temporary,{flags:'wx',mode:0o600}),{signal});
    signal.throwIfAborted();
    await rename(temporary,archivePath(day));
    await save({...state,checkedDate:day,entries:[entry,...state.entries]});
   }finally{await remove(temporary);}
   await publish(entry);
   return archived;
  }),
  async list(){return {items:state.entries.filter(entry=>entry.planned).map(describe)};},
  async download(day,actor){
   const entry=find(day),path=archivePath(entry.date),metadata=await stat(path);
   if(!metadata.isFile())throw Error('Invalid feedback package archive');
   return {path,size:metadata.size,receipt:entry.completedAt?null:receipt(actor.id,day)};
  },
  confirm:(day,actor,value)=>serial(async()=>{
   const entry=find(day);
   if(entry.completedAt)return describe(entry);
   if(entry.downloadedAt)return describe(await complete(entry));
   verify(value,actor.id,day);
   const confirmed={...entry,downloadedAt:new Date(now()).toISOString()};
   await replace(confirmed);
   return describe(await complete(confirmed));
  }),
  async idle(){await queue;},
 };
}

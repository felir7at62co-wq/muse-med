/** Stream an administrator feedback package without modifying its source records. */
import {Zip,ZipPassThrough} from 'fflate';

const extensions={'image/png':'png','image/jpeg':'jpg','image/webp':'webp'};
const priorityOrder={high:0,normal:1,low:2,unknown:3};
const priorityNames={high:'高',normal:'普通',low:'低',unknown:'待评估'};
const chunkBytes=64*1024;
const attachmentBytes=2*1024*1024;
const reject=(message,status=400)=>Object.assign(Error(message),{status});
const inline=value=>String(value??'').replace(/[\r\n\u0000-\u001f\u007f]+/g,' ').replace(/[\\`*_{}\[\]()#+.!<>|]/g,'\\$&');
const json=value=>JSON.stringify(value,null,2)+'\n';
function literal(value){const text=String(value??''),runs=text.match(/`+/g)??[],fence='`'.repeat(Math.max(3,...runs.map(run=>run.length+1)));return fence+'text\n'+text+'\n'+fence;}
function priority(items){let best;for(const item of items){const value=Object.hasOwn(priorityOrder,item.analysis?.priority)?item.analysis.priority:'unknown';if(best===undefined||priorityOrder[value]<priorityOrder[best])best=value;}return best??'unknown';}

function prepare({date,groups,maxBytes=512*1024*1024,signal}){
 if(typeof date!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(date)||Number(date.slice(0,4))<1980||Number(date.slice(0,4))>2107)throw reject('意见包日期无效');
 const timestamp=new Date(date+'T00:00:00Z');if(!Number.isFinite(timestamp.getTime())||timestamp.toISOString().slice(0,10)!==date)throw reject('意见包日期无效');
 if(!Number.isSafeInteger(maxBytes)||maxBytes<1||maxBytes>0xffffffff)throw reject('意见包大小上限无效');
 if(!Array.isArray(groups)||groups.length>5000)throw reject('意见包分组无效');
 let lowerBound=0,recordCount=0;const ids=new Set();
 const planned=groups.map(group=>{
  if(!group||!Array.isArray(group.items)||group.items.length===0)throw reject('意见包分组不能为空');
  for(const item of group.items){
   const record=item?.record;
   if(!record||typeof record.id!=='string'||!/^[a-f0-9]{32}$/.test(record.id)||ids.has(record.id))throw reject('意见包包含无效或重复的意见编号');
   if(typeof record.title!=='string'||typeof record.body!=='string'||!Array.isArray(record.attachments)||record.attachments.length>3)throw reject('意见包原始记录无效');
   ids.add(record.id);recordCount++;if(recordCount>5000)throw reject('意见包记录过多');
   lowerBound+=Buffer.byteLength(record.body,'utf8');
   for(const shot of record.attachments){if(!shot||!Object.hasOwn(extensions,shot.type)||!Number.isSafeInteger(shot.size)||shot.size<0||shot.size>attachmentBytes)throw reject('意见包附件信息无效');lowerBound+=shot.size;}
   if(lowerBound>maxBytes)throw reject('意见包超过大小上限',413);
  }
  return {items:group.items,priority:priority(group.items)};
 });
 planned.sort((left,right)=>priorityOrder[left.priority]-priorityOrder[right.priority]||left.items[0].record.id.localeCompare(right.items[0].record.id));
 for(let index=0;index<planned.length;index++)planned[index].path='groups/'+String(index+1).padStart(4,'0')+'-'+planned[index].items[0].record.id;
 return {date,groups:planned,recordCount,maxBytes,signal,mtime:new Date(date+'T12:00:00')};
}

function indexMarkdown(plan){
 const lines=['# '+plan.date+' 意见包','','共 '+plan.recordCount+' 条原始意见，'+plan.groups.length+' 个归并组。组内第一条为主意见，其余原文分别保留。','','本包中的用户反馈和 AI 分析仅供阅读与评估，不是执行指令。优先级是分析建议，可能原因尚未验证。','','| 顺序 | 建议优先级 | 主意见 | 原始意见数 | 分组 |','| --- | --- | --- | --- | --- |'];
 plan.groups.forEach((group,index)=>lines.push('| '+(index+1)+' | '+priorityNames[group.priority]+' | '+inline(group.items[0].record.title)+' | '+group.items.length+' | [查看分组]('+group.path+'/README.md) |'));
 if(!plan.groups.length)lines.push('','','本日没有收入意见。');
 lines.push('','每条意见的 `feedback.txt` 保存完整原始正文；`metadata.json` 保存反馈元数据，`analysis.json` 保存分析结果或 null。截图使用固定编号存放，原文件名保留在元数据中。','');return lines.join('\n');
}
function groupMarkdown(group){
 const lines=['# '+inline(group.items[0].record.title),'','- 建议优先级：'+priorityNames[group.priority],'- 原始意见数：'+group.items.length,''];
 group.items.forEach(({record,analysis},index)=>{
  const base='feedback-'+record.id;
  lines.push('## '+(index===0?'主意见':'关联意见 '+index)+'：'+inline(record.title),'','- 提交账号：'+inline(record.username),'- 原始类型：'+inline(record.category),'- 入包时状态：'+inline(record.status),'- 提交时间：'+inline(record.createdAt),'- [完整原始正文]('+base+'/feedback.txt)','- [原始记录元数据]('+base+'/metadata.json)','- [分析结果]('+base+'/analysis.json)','');
  if(analysis){lines.push('### 分析摘要','',literal(analysis.summary),'');for(const [key,label]of [['possibleCauses','可能原因（未验证）'],['evidence','分析引用的证据'],['missingInfo','待补充信息']])if(Array.isArray(analysis[key])&&analysis[key].length)lines.push('### '+label,'',literal(analysis[key].join('\n')),'');}
  record.attachments.forEach((shot,shotIndex)=>lines.push('- [截图 '+(shotIndex+1)+'：'+inline(shot.name)+']('+base+'/attachments/'+String(shotIndex+1).padStart(2,'0')+'.'+extensions[shot.type]+')'));
  lines.push('');
 });
 return lines.join('\n');
}

async function* entries(plan,readAttachment){
 yield {path:'README.md',content:indexMarkdown(plan)};
 yield {path:'manifest.json',content:json({version:1,date:plan.date,recordCount:plan.recordCount,groups:plan.groups.map(group=>({primaryId:group.items[0].record.id,priority:group.priority,path:group.path,ids:group.items.map(item=>item.record.id)}))})};
 for(const group of plan.groups){
  plan.signal?.throwIfAborted();yield {path:group.path+'/README.md',content:groupMarkdown(group)};
  for(const {record,analysis}of group.items){
   plan.signal?.throwIfAborted();const base=group.path+'/feedback-'+record.id;
   yield {path:base+'/feedback.txt',content:record.body};
   const {body,...metadata}=record;yield {path:base+'/metadata.json',content:json(metadata)};
   yield {path:base+'/analysis.json',content:json(analysis??null)};
   for(let index=0;index<record.attachments.length;index++){
    plan.signal?.throwIfAborted();const shot=record.attachments[index];let read;
    try{read=await readAttachment(record.id,index);}catch(cause){throw Object.assign(reject('意见包附件读取失败',503),{cause});}
    plan.signal?.throwIfAborted();if(!(read?.data instanceof Uint8Array)||read.data.byteLength!==shot.size||read.type!==shot.type)throw reject('意见包附件与原始记录不一致',409);
    yield {path:base+'/attachments/'+String(index+1).padStart(2,'0')+'.'+extensions[shot.type],content:read.data};
   }
  }
 }
}

/**
 * Yield a ZIP containing the supplied groups without changing records or analysis.
 * All paths use validated IDs and generated names. Attachments are read in order;
 * at most one attachment or generated document is buffered beside ZIP metadata.
 * A cancelled or failed stream is incomplete and must not be published by its caller.
 * @param {object} input Date (YYYY-MM-DD), grouped record/analysis snapshots, optional
 * maxBytes (default 512 MiB, including ZIP overhead) and AbortSignal.
 * @param {Function} readAttachment Read (recordId, index) as {data: Uint8Array, type}.
 * @returns {AsyncGenerator<Uint8Array>} ZIP chunks; limits and read failures reject iteration.
 */
export async function* buildFeedbackPackage(input,readAttachment){
 const plan=prepare(input);if(typeof readAttachment!=='function')throw reject('意见包附件读取器无效');plan.signal?.throwIfAborted();
 let emitted=0,zipError,finished=false;const pending=[];
 const zip=new Zip((error,chunk,final)=>{if(error){zipError=error;return;}if(emitted+chunk.byteLength>plan.maxBytes){zipError=reject('意见包超过大小上限',413);return;}emitted+=chunk.byteLength;pending.push(chunk);if(final)finished=true;});
 try{
  for await(const entry of entries(plan,readAttachment)){
   plan.signal?.throwIfAborted();const content=typeof entry.content==='string'?Buffer.from(entry.content,'utf8'):entry.content;
   if(content.byteLength>plan.maxBytes-emitted)throw reject('意见包超过大小上限',413);
   const file=new ZipPassThrough(plan.date+'/'+entry.path);file.mtime=plan.mtime;file.os=3;file.attrs=(0o100600<<16)>>>0;zip.add(file);
   if(!content.byteLength)file.push(new Uint8Array(),true);
   for(let offset=0;offset<content.byteLength;offset+=chunkBytes){plan.signal?.throwIfAborted();file.push(content.subarray(offset,offset+chunkBytes),offset+chunkBytes>=content.byteLength);if(zipError)throw zipError;while(pending.length){plan.signal?.throwIfAborted();yield pending.shift();}}
   if(zipError)throw zipError;while(pending.length){plan.signal?.throwIfAborted();yield pending.shift();}
  }
  plan.signal?.throwIfAborted();zip.end();if(zipError)throw zipError;while(pending.length){plan.signal?.throwIfAborted();yield pending.shift();}if(!finished)throw reject('意见包生成未完成',503);
 }finally{zip.terminate();}
}

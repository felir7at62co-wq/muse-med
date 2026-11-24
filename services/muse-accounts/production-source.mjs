/** Read-only Feishu production source; application credentials never enter board snapshots. */
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';

const failure=(status,message)=>Object.assign(Error(message),{status});
const id=(value,prefix)=>typeof value==='string'&&new RegExp('^'+prefix+'[A-Za-z0-9_-]{1,128}$').test(value);
const text=value=>typeof value==='string'?value:Array.isArray(value)?value.map(item=>typeof item==='string'?item:item?.text??item?.name??'').join(''):value?.text??value?.name??'';
const nonempty=value=>typeof value==='string'?!!value.trim():Array.isArray(value)?value.length>0:!!value&&typeof value==='object'&&Object.keys(value).length>0;

/** Validate explicit table and field mappings and polling limits.
 * @param {object} value Deployment-owned configuration.
 * @returns {object} Validated independent configuration.
 */
export function resolveProductionConfig(value){
 if(!value||!id(value.baseToken,'')||typeof value.baseUrl!=='string'||typeof value.group!=='string'||!value.group.trim())throw Error('Invalid production source configuration');
 const url=new URL(value.baseUrl);
 if(url.protocol!=='https:'||!url.hostname.endsWith('.feishu.cn')||url.username||url.password||url.search||url.hash||url.pathname!=='/base/'+value.baseToken)throw Error('Invalid production base URL');
 for(const [key,min,max]of [['intervalMs',30000,3600000],['requestTimeoutMs',1000,60000],['maxRows',1,10000],['maxFileBytes',1024,67108864]])if(!Number.isSafeInteger(value[key])||value[key]<min||value[key]>max)throw Error('Invalid production '+key);
 if(!Array.isArray(value.tables)||value.tables.length<1||value.tables.length>20||new Set(value.tables.map(t=>t.id)).size!==value.tables.length)throw Error('Invalid production tables');
 for(const table of value.tables){
  if(!id(table.id,'tbl')||typeof table.name!=='string'||!table.name||!table.fields)throw Error('Invalid production table');
  for(const key of ['title','group','status','script','assets','assignees'])if(!id(table.fields[key],'fld'))throw Error('Invalid production field '+key);
 }
 if(!Array.isArray(value.readyStatuses)||!value.readyStatuses.length||value.readyStatuses.some(s=>typeof s!=='string'||!s.trim()))throw Error('Invalid ready statuses');
 return structuredClone(value);
}

/** Load a deployment mapping; no authentication material is contained here.
 * @param {string} file Configuration path.
 * @returns {Promise<object>} Validated mapping.
 */
export async function loadProductionConfig(file){return resolveProductionConfig(JSON.parse(await readFile(file,'utf8')));}

/** Create a read-only source using the existing enterprise application identity.
 * @param {object} options Credentials, explicit mapping, injectable HTTP transport and clock.
 * @returns {object} Complete snapshots, bounded attachment download and cancellation.
 */
export function createFeishuProductionSource({credentials,config:input,fetchImpl=fetch,now=Date.now}){
 const config=resolveProductionConfig(input),origin='https://open.feishu.cn/open-apis',stop=new AbortController();
 if(!credentials?.appId||!credentials?.appSecret)throw Error('Production source credentials unavailable');
 let cached;
 const signal=()=>AbortSignal.any([stop.signal,AbortSignal.timeout(config.requestTimeoutMs)]);
 async function json(path,options={}){
  const response=await fetchImpl(origin+path,{...options,redirect:'error',signal:signal()});
  const bytes=await boundedBody(response,16*1024*1024);
  let result;try{result=JSON.parse(bytes.toString('utf8'));}catch(error){throw failure(502,'Feishu returned invalid JSON');}
  if(!response.ok||result.code!==0)throw failure(502,'Feishu request failed ('+String(result.code??response.status).replace(/[^0-9-]/g,'')+')');
  return result;
 }
 async function token(){
  if(cached&&cached.until>now())return cached.value;
  const result=await json('/auth/v3/tenant_access_token/internal',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({app_id:credentials.appId,app_secret:credentials.appSecret})});
  if(typeof result.tenant_access_token!=='string'||!Number.isFinite(result.expire))throw failure(502,'Feishu token unavailable');
  cached={value:result.tenant_access_token,until:now()+Math.max(0,result.expire-120)*1000};return cached.value;
 }
 async function list(path){
  const all=[],pages=new Set();let pageToken;
  do{
   const query=new URLSearchParams({page_size:'100',...(pageToken?{page_token:pageToken}:{})});
   const result=await json(path+'?'+query,{headers:{authorization:'Bearer '+await token()}}),data=result.data;
   if(!Array.isArray(data?.items))throw failure(502,'Feishu list incomplete');
   all.push(...data.items);if(all.length>config.maxRows)throw failure(502,'Production source exceeds configured row limit');
   if(!data.has_more)break;
   if(!data.page_token||pages.has(data.page_token))throw failure(502,'Feishu pagination incomplete');
   pageToken=data.page_token;pages.add(pageToken);
  }while(true);
  return all;
 }
 return {
  async read(){
   const rows=[];
   for(const table of config.tables){
    const root='/bitable/v1/apps/'+config.baseToken+'/tables/'+table.id;
    const fields=await list(root+'/fields'),names={};
    for(const [key,fieldId]of Object.entries(table.fields)){const field=fields.find(f=>f.field_id===fieldId);if(!field?.field_name)throw failure(502,'Configured production field unavailable');names[key]=field.field_name;}
    const records=await list(root+'/records');
    for(const record of records){
     if(!id(record.record_id,'rec')||!record.fields)throw failure(502,'Invalid production record');
     const value=key=>record.fields[names[key]];
     const groups=Array.isArray(value('group'))?value('group').map(text):[text(value('group'))];
     if(!groups.includes(config.group))continue;
     const attachmentItems=value('script'),validAttachment=file=>typeof file?.file_token==='string'&&/^[A-Za-z0-9_-]{1,256}$/.test(file.file_token)&&typeof file.name==='string'&&file.name.trim().length>0;
     const scriptsComplete=(attachmentItems===undefined||attachmentItems===null||Array.isArray(attachmentItems))&&(!Array.isArray(attachmentItems)||attachmentItems.every(validAttachment));
     const scripts=(Array.isArray(attachmentItems)?attachmentItems:[]).filter(validAttachment).map(file=>{
      let extra;
      if(file.url){let url,parsed;try{url=new URL(file.url);parsed=JSON.parse(url.searchParams.get('extra'));}catch(error){throw failure(502,'Invalid script permission context');}
       if(url.origin!=='https://open.feishu.cn'||url.pathname!=='/open-apis/drive/v1/medias/'+file.file_token+'/download'||parsed?.bitablePerm?.tableId!==table.id||!Number.isSafeInteger(parsed.bitablePerm.rev)||parsed.bitablePerm.rev<0)throw failure(502,'Invalid script permission context');
       extra={bitablePerm:{tableId:table.id,rev:parsed.bitablePerm.rev}};
      }
      return {token:file.file_token,name:file.name.slice(0,260),size:Number.isSafeInteger(file.size)&&file.size>=0?file.size:null,...extra?{extra}:{}};
     });
     const title=text(value('title')).trim(),sourceStatus=text(value('status')),assetsPresent=nonempty(value('assets'));
     const people=value('assignees'),assignees=(Array.isArray(people)?people:people?[people]:[]).map(person=>{
      const name=typeof person==='string'?person:typeof person?.name==='string'?person.name:'';
      const identifier=person&&typeof person==='object'?(person.id??person.open_id??person.user_id):undefined;
      return {name:name.slice(0,256),...(typeof identifier==='string'&&identifier.length<=128?{id:identifier}:{})};
     }).filter(person=>person.name||person.id).sort((a,b)=>(a.id??a.name).localeCompare(b.id??b.name));
     const boundedScripts=scripts.length<=10&&new Set(scripts.map(file=>file.token)).size===scripts.length&&scripts.reduce((total,file)=>total+(file.size??0),0)<=268435456&&scripts.every(file=>file.name.length<=200&&!/[\\/\x00-\x1f\x7f]/.test(file.name)&&file.name!=='.'&&file.name!=='..'&&file.size!==null&&file.size>0&&file.size<=config.maxFileBytes);
     const eligible=!!title&&config.readyStatuses.includes(sourceStatus)&&scriptsComplete&&scripts.length>0&&boundedScripts&&!assetsPresent;
     const reason=!title?'缺少剧名':!config.readyStatuses.includes(sourceStatus)?'来源状态未就绪':!scriptsComplete?'剧本附件信息不完整，请核对飞书记录':!scripts.length?'缺少改后或最终剧本':!boundedScripts?'剧本附件大小未核实或超出限制':assetsPresent?'已有资产，请先核对现有项目':null;
     const row={key:table.id+':'+record.record_id,tableId:table.id,tableName:table.name,recordId:record.record_id,title,sourceUrl:config.baseUrl+'?table='+table.id+'&record='+record.record_id,sourceStatus,scripts,scriptsComplete,assignees,assetsPresent,eligible,reason};
     // Table-wide permission revisions do not change the selected script or business decision.
     row.revision=createHash('sha256').update(JSON.stringify({...row,scripts:scripts.map(({extra,...file})=>file)})).digest('hex');rows.push(row);
    }
   }
   if(new Set(rows.map(r=>r.key)).size!==rows.length)throw failure(502,'Duplicate production records');
   return rows;
  },
  async download(file){
   if(!file||!/^[A-Za-z0-9_-]{1,256}$/.test(file.token))throw failure(400,'Invalid script attachment');
   if(file.size!==null&&file.size>config.maxFileBytes)throw failure(413,'Script exceeds configured size');
   const query=file.extra?'?'+new URLSearchParams({extra:JSON.stringify(file.extra)}):'';
   const response=await fetchImpl(origin+'/drive/v1/medias/'+file.token+'/download'+query,{headers:{authorization:'Bearer '+await token()},redirect:'error',signal:signal()});
   if(!response.ok){await response.body?.cancel();throw failure(502,'Script download failed ('+response.status+')');}
   const bytes=await boundedBody(response,config.maxFileBytes);
   if(file.size!==null&&bytes.length!==file.size)throw failure(502,'Script size differs from source');
   return {bytes,filename:file.name,contentType:response.headers.get('content-type')??'application/octet-stream'};
  },
  close(){stop.abort();cached=undefined;},
 };
}

/** Consume a bounded response and release its stream on success or failure. */
async function boundedBody(response,maximum){
 if(Number(response.headers.get('content-length'))>maximum){await response.body?.cancel();throw failure(413,'Source response exceeds limit');}
 const reader=response.body?.getReader();if(!reader)return Buffer.alloc(0);const chunks=[];let size=0,done=false;
 try{for(;;){const item=await reader.read();if(item.done){done=true;break;}size+=item.value.length;if(size>maximum)throw failure(413,'Source response exceeds limit');chunks.push(item.value);}return Buffer.concat(chunks);}
 finally{if(!done)await reader.cancel().catch(error=>{/* The request may already have been aborted. */});reader.releaseLock();}
}

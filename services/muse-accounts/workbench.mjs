/** Account-scoped, read-only workbench projections; device presence never implies Bot activity. */
import {desktopPrefix,validDeviceId} from './desktop-route.mjs';
import {modelUsageQuery} from './model-usage.mjs';

const tokenFields=['inputTokens','outputTokens','totalTokens'];
const fail=(status,message)=>Object.assign(Error(message),{status});
const displayName=account=>[...new Set((account.feishuIdentities??[]).map(identity=>identity.name).filter(Boolean))].join(' / ')||account.username;
const text=(value,label)=>{if(typeof value!=='string'||value.length>200||/[\x00-\x1f\x7f]/.test(value))throw fail(400,'Invalid workbench '+label);return value.trim();};

function organizationView(snapshot,accounts){
 const available=['ready','partial'].includes(snapshot?.status),nodes=new Map((available?snapshot.departments:[]).map(node=>[node.id,node]));
 function path(id){
  const result=[],seen=new Set();let next=id;
  while(next!==null&&next!==undefined&&next!==''){
   if(next==='0'&&!nodes.has(next))break;
   if(seen.has(next)||!nodes.has(next))return null;
   seen.add(next);const node=nodes.get(next);result.unshift({id:node.id,name:node.name});next=node.parentId;
  }
  return result.length?result:null;
 }
 const paths=new Map([...nodes.keys()].map(id=>[id,path(id)]).filter(([,value])=>value));
 const memberships=new Map(accounts.map(account=>{
  const membership=available&&Object.hasOwn(snapshot.accounts??{},account.id)?snapshot.accounts[account.id]:undefined;
  if(!membership||membership.status!=='ready'||!Array.isArray(membership.departmentIds))return [account.id,null];
  const ids=[...new Set(membership.departmentIds)];
  return [account.id,ids.some(id=>!paths.has(id))?null:ids.map(id=>paths.get(id))];
 }));
 return {available,paths,memberships};
}

function metrics(row){
 if(!row)return null;
 return Object.fromEntries(['requests','reported','partial','unknown',...tokenFields,...tokenFields.map(field=>field+'Reports')].map(field=>[field,row[field]??null]));
}

function totalMetrics(rows){
 const total={requests:0,reported:0,partial:0,unknown:0};
 for(const field of tokenFields){total[field]=null;total[field+'Reports']=0;}
 for(const row of rows.filter(Boolean)){
  for(const field of ['requests','reported','partial','unknown',...tokenFields.map(field=>field+'Reports')])total[field]+=row[field]??0;
  for(const field of tokenFields)if(row[field]!==null)total[field]=(total[field]??0)+row[field];
 }
 return total;
}

/** Build a workbench from trusted account, connection, organization and metering providers.
 * @param {object} options Existing account, connection, organization, metering and optional coordination/production read providers.
 * @returns {object} A read method with no account, Session, task or network mutations.
 */
export function createWorkbench({store,desktopRelay,orgSnapshot=()=>undefined,botSnapshot=()=>undefined,productionSnapshot=()=>undefined,usage,now=Date.now,cloudDeviceId}){
 if(typeof store?.list!=='function'||typeof desktopRelay?.devices!=='function'||[orgSnapshot,botSnapshot,productionSnapshot,now].some(value=>typeof value!=='function'))throw Error('Invalid workbench providers');
 if(cloudDeviceId!==undefined&&!validDeviceId(cloudDeviceId))throw Error('Invalid designated cloud device');
 return {read(session,query={}){
  if(!session?.account||session.account.disabled||session.id!==session.account.id)throw fail(401,'Sign in required');
  const administrator=session.account.admin===true,scope=query.scope??(administrator?'organization':'self');
  if(!['self','organization'].includes(scope))throw fail(400,'Invalid workbench scope');
  if(scope==='organization'&&!administrator)throw fail(403,'Administrator access required');
  const view=query.view??'team';if(!['team','production'].includes(view))throw fail(400,'Invalid workbench view');
  const q=text(query.q??'','search'),department=text(query.department??'','department');
  if(department&&scope!=='organization')throw fail(400,'Department filtering requires organization scope');
  let filters;try{filters=modelUsageQuery({from:query.from,to:query.to},now());}catch(error){throw fail(400,'Invalid workbench date range');}
  const accounts=store.list().filter(account=>scope==='organization'||account.id===session.id);
  if(!accounts.some(account=>account.id===session.id))throw fail(401,'Account no longer available');
  const snapshot=orgSnapshot(),org=organizationView(snapshot,accounts);
  if(department&&(!org.available||!org.paths.has(department)))throw fail(400,'Department information is unavailable');
  const selected=accounts.filter(account=>(!q||(displayName(account)+' '+account.username).toLocaleLowerCase().includes(q.toLocaleLowerCase()))&&(!department||org.memberships.get(account.id)?.some(path=>path.some(node=>node.id===department))));
  const team=botSnapshot(session,{scope}),registered=new Map((team?.devices??[]).map(device=>[device.ownerAccountId+'\0'+device.id,device]));
  // A browser-supplied accountId never participates in the ledger query.
  const summary=usage?.summary({...filters,...scope==='self'?{accountId:session.id}:{}});
  const usageRows=new Map((summary?.users??[]).map(row=>[row.accountId,metrics(row)]));
  const members=selected.map(account=>{
   const all=desktopRelay.devices({id:account.id}),seen=new Set();
   const devices=all.filter(device=>!account.disabled&&device.state==='online'&&validDeviceId(device.id)&&!seen.has(device.id)&&seen.add(device.id)).map(device=>{
    const bound=registered.get(account.id+'\0'+device.id),fresh=bound?.statusFresh===true;
    return {
    id:device.id,name:device.name,platform:device.platform,connectionState:'online',
    role:device.id===cloudDeviceId?'cloud':'local',viewerOwnsDevice:account.id===session.id,canOpenRemote:account.id===session.id,
    remotePath:account.id===session.id?desktopPrefix(device.id):null,
    mainBot:bound?.mainBot??null,botStatus:fresh?bound.botStatus:'unreported',reportedAt:bound?.reportedAt??null,statusFresh:fresh,
    canPropose:administrator&&fresh&&!!bound?.mainBot,
    activeTasks:(team?.tasks??[]).filter(task=>task.deviceId===device.id&&['accepted','dispatching','delivered'].includes(task.state)).length,
   };});
   const row=usageRows.get(account.id)??null;
   return {id:account.id,name:displayName(account),username:account.username,admin:account.admin===true,disabled:account.disabled===true,
    current:account.id===session.id,departmentPaths:org.memberships.get(account.id)??null,devices,
    usage:{status:!summary?'unavailable':row?'recorded':summary.limited?'unknown':'no-requests',metrics:row}};
  });
  const visibleDepartments=scope==='organization'?[...org.paths].map(([id,path])=>({id,name:path.map(node=>node.name).join(' / ')})):[];
  const selectedIds=new Set(selected.map(account=>account.id)),deviceLabels=new Map(members.flatMap(member=>member.devices.map(device=>[device.id,{device,member}])));
  const tasks=(team?.tasks??[]).filter(task=>selectedIds.has(task.ownerAccountId)).map(task=>{
   const target=deviceLabels.get(task.deviceId);
   return {id:task.id,ownerAccountId:task.ownerAccountId,deviceId:task.deviceId,prompt:task.prompt,state:task.state,createdAt:task.createdAt,updatedAt:task.updatedAt,
    sessionId:task.sessionId??null,result:task.result??null,progress:task.progress??[],verification:'reported',
    ownerName:members.find(member=>member.id===task.ownerAccountId)?.name??'账号不可用',deviceName:target?.device.name??'设备未连接',mainBotName:target?.device.mainBot?.name??null,
    canDecide:task.ownerAccountId===session.id&&task.state==='offered',remotePath:target?.device.remotePath??null};
  });
  const production=productionSnapshot(session)??null;
  return {serverTime:new Date(now()).toISOString(),scope,view,administrator,
   me:{id:session.id,name:displayName(session.account)},filters:{scope,view,q,department,from:filters.from,to:filters.to},
   links:{workbench:'/workbench',computers:'/computers',account:'/account',...administrator?{users:'/admin',usage:'/admin/usage'}:{}},
   organization:{status:org.available?snapshot.status:'unavailable',updatedAt:org.available?snapshot.updatedAt:null,departments:visibleDepartments},
   counts:{accounts:members.length,connectedAccounts:members.filter(member=>member.devices.length>0).length,onlineDevices:members.reduce((sum,member)=>sum+member.devices.length,0)},
   usage:{available:!!summary,recordingSince:summary?.recordingSince??null,coverage:summary?.coverage??null,limited:summary?.limited??false,
    writeFailures:summary?.health?.writeFailures??0,totals:summary?totalMetrics(members.map(member=>member.usage.metrics)):null},members,
   coordination:{available:!!team,tasks},production};
 }};
}

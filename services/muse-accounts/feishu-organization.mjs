/** Read-only synchronization of account departments, job titles and managers from a single enterprise Feishu application, and the signed-in user's own department paths during OAuth authorization. */
const TOKEN_URL='https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal';
const API='https://open.feishu.cn/open-apis/contact/v3';
const id=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,256}$/.test(value);
const name=value=>typeof value==='string'&&value.trim().length>0&&value.length<=200&&!/[\x00-\x1f\x7f-\x9f]/.test(value);
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const empty=()=>({status:'unavailable',updatedAt:null,departments:[],accounts:{}});
const text=(value,max)=>typeof value==='string'&&value.length>0&&value.length<=max&&!/[\x00-\x1f\x7f-\x9f]/.test(value);
const names=value=>object(value)?value.name??value.i18n_name?.zh_cn??value.i18n_name?.en_us:undefined;

/** User-consent scopes required for the signed-in user's department hierarchy. */
export const FEISHU_ORGANIZATION_SCOPES='contact:contact.base:readonly contact:user.department:readonly contact:user.department_path:readonly';

/**
 * Synchronize verified identities in one explicitly selected enterprise. Provider credentials and tokens remain in memory.
 * @param {object} options Feishu custom app credentials, verified tenant key, account store, optional fetch and clock, and concurrency limit.
 * @returns {object} Single-flight refresh, isolated snapshot accessor, and async close that cancels provider requests.
 */
export function createFeishuOrgSync({config,expectedTenantKey,store,fetchImpl=fetch,now=Date.now,concurrency=4}={}){
 if(!config||config.appType!=='custom'||!id(config.appId)||typeof config.appSecret!=='string'||config.appSecret.length<16||!id(expectedTenantKey))throw Error('Feishu organization requires custom app credentials and a verified tenant key');
 if(!store||typeof store.list!=='function'||typeof fetchImpl!=='function'||typeof now!=='function'||!Number.isSafeInteger(concurrency)||concurrency<1||concurrency>20)throw Error('Invalid Feishu organization dependencies');
 const timeout=config.requestTimeoutMs??15000;
 if(!Number.isSafeInteger(timeout)||timeout<1000||timeout>60000)throw Error('Invalid Feishu organization request timeout');
 let current=empty(),pending,closed=false,proofs=new Map();const controller=new AbortController();
 const identityKey=identity=>JSON.stringify([identity.appId,identity.tenantKey,identity.openId]);
 const eligible=account=>(account.feishuIdentities??[]).filter(identity=>identity.appId===config.appId&&identity.tenantKey===expectedTenantKey&&id(identity.openId));
 const publish=(result,nextProofs=new Map())=>{if(!closed){current=result;proofs=nextProofs;}return structuredClone(current);};
 function snapshot(){
  if(closed)return {...structuredClone(current),syncing:Boolean(pending)};
  let latest;try{latest=new Map(store.list().map(account=>[account.id,account]));}catch{current=empty();proofs.clear();return {...structuredClone(current),syncing:Boolean(pending)};}
  let invalidated=false;
  for(const accountId of Object.keys(current.accounts)){
   const account=latest.get(accountId),expected=proofs.get(accountId);
   if(!account){delete current.accounts[accountId];proofs.delete(accountId);invalidated=true;continue;}
   if(expected){
    const actual=new Set(eligible(account).map(identityKey));
    if(actual.size!==expected.size||[...expected].some(key=>!actual.has(key))){current.accounts[accountId]={status:'unknown',departmentIds:[]};proofs.delete(accountId);invalidated=true;}
   }
  }
  if(invalidated){
   if(current.status==='ready')current.status='partial';
   const byId=new Map(current.departments.map(department=>[department.id,department])),visible=new Set();
   for(const account of Object.values(current.accounts))if(account.status==='ready')for(const departmentId of account.departmentIds){
    let next=departmentId;const visited=new Set();
    while(next!==null&&!visited.has(next)){visited.add(next);const department=byId.get(next);if(!department)break;visible.add(next);next=department.parentId;}
   }
   current.departments=current.departments.filter(department=>visible.has(department.id));
  }
  return {...structuredClone(current),syncing:Boolean(pending)};
 }
 async function request(url,options={}){
  controller.signal.throwIfAborted();const signal=AbortSignal.any([controller.signal,AbortSignal.timeout(timeout)]);
  const response=await fetchImpl(url,{...options,redirect:'error',signal});signal.throwIfAborted();
  if(!response.ok||!response.body)throw Error('Feishu organization request failed');
  const chunks=[];let size=0;
  for await(const chunk of response.body){size+=chunk.length;if(size>262144)throw Error('Feishu organization response too large');chunks.push(chunk);}
  let value;try{value=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw Error('Invalid Feishu organization response');}
  if(!object(value)||value.code!==0)throw Error('Feishu organization request rejected');
  return value;
 }
 async function run(){
  const accounts=store.list();
  const rows=accounts.map(account=>({id:account.id,identities:eligible(account)}));
  const result={status:'ready',updatedAt:new Date(now()).toISOString(),departments:[],accounts:Object.fromEntries(rows.map(row=>[row.id,{status:'unknown',departmentIds:[]}]))};
  if(!rows.some(row=>row.identities.length))return publish(result);
  let access;
  try{
   const response=await request(TOKEN_URL,{method:'POST',headers:{'content-type':'application/json; charset=utf-8'},body:JSON.stringify({app_id:config.appId,app_secret:config.appSecret})});
   if(typeof response.tenant_access_token!=='string'||response.tenant_access_token.length<1||response.tenant_access_token.length>16384||/[\x00-\x20\x7f]/.test(response.tenant_access_token))throw Error('Invalid Feishu token');
   access=response.tenant_access_token;
  }catch{result.status='unavailable';return publish(result);}
  const headers={authorization:'Bearer '+access},departments=new Map();
  const loadDepartment=departmentId=>{
   if(!departments.has(departmentId))departments.set(departmentId,(async()=>{
    const url=new URL(API+'/departments/'+encodeURIComponent(departmentId));url.searchParams.set('department_id_type','open_department_id');
    const response=await request(url.href,{headers}),department=response.data?.department;
    if(!object(department))throw Error('Incomplete Feishu department');
    if(departmentId==='0'){
     if(department.open_department_id!=='0'&&department.department_id!=='0')throw Error('Invalid Feishu root department');
     const label=department.name===undefined||department.name===null||department.name===''?'企业（根部门）':department.name;
     if(!name(label))throw Error('Invalid Feishu root department');
     return {id:'0',name:label,parentId:null};
    }
    if(!name(department.name)||department.open_department_id!==departmentId||!id(department.parent_department_id))throw Error('Incomplete Feishu department');
    return {id:departmentId,name:department.name,parentId:department.parent_department_id};
   })());
   return departments.get(departmentId);
  };
  // A manager outside the application's contact range, or a refused lookup, leaves the name out without failing the account.
  const leaders=new Map();
  const loadLeader=leaderId=>{
   if(!leaders.has(leaderId))leaders.set(leaderId,(async()=>{
    const url=new URL(API+'/users/'+encodeURIComponent(leaderId));url.searchParams.set('user_id_type','open_id');
    try{const user=(await request(url.href,{headers})).data?.user;return object(user)&&name(user.name)?user.name:undefined;}catch{return undefined;}
   })());
   return leaders.get(leaderId);
  };
  async function syncRow(row){
   if(!row.identities.length)return;
   try{
    const direct=new Set();let jobTitle,leaderId;
    for(const identity of row.identities){
     const url=new URL(API+'/users/'+encodeURIComponent(identity.openId));url.searchParams.set('user_id_type','open_id');url.searchParams.set('department_id_type','open_department_id');
     const response=await request(url.href,{headers}),user=response.data?.user;
     if(!object(user)||user.open_id!==undefined&&user.open_id!==identity.openId||!Array.isArray(user.department_ids)||user.department_ids.length===0||user.department_ids.length>100||user.department_ids.some(value=>!id(value)))throw Error('Incomplete Feishu user departments');
     for(const departmentId of user.department_ids)direct.add(departmentId);
     // Fields the application may not read are absent from the response; the first identity that has one supplies it.
     if(jobTitle===undefined&&name(user.job_title))jobTitle=user.job_title.trim();
     if(leaderId===undefined&&id(user.leader_user_id))leaderId=user.leader_user_id;
    }
    const resolved=new Map();
    for(const departmentId of direct){
     let next=departmentId;const visited=new Set();
     while(next!==null){
      if(visited.has(next)||visited.size>=64)throw Error('Invalid Feishu department tree');
      visited.add(next);const department=await loadDepartment(next);resolved.set(department.id,department);next=department.parentId;
     }
    }
    const managerName=leaderId===undefined?undefined:await loadLeader(leaderId);
    row.resolved=[...resolved.values()];
    result.accounts[row.id]={status:'ready',departmentIds:[...direct],...jobTitle===undefined?{}:{jobTitle},...managerName===undefined?{}:{managerName}};
   }catch{result.status='partial';}
  }
  let index=0;
  const workers=Array.from({length:Math.min(concurrency,rows.length)},async()=>{while(index<rows.length){const row=rows[index++];await syncRow(row);}});
  await Promise.all(workers);
  // Do not expose identities removed or rebound while the provider calls were in flight.
  const latest=new Map(store.list().map(account=>[account.id,account]));
  for(const row of rows){
   const account=latest.get(row.id),keys=new Set(account?eligible(account).map(identityKey):[]);
   if(!account||keys.size!==row.identities.length||row.identities.some(identity=>!keys.has(identityKey(identity)))){delete result.accounts[row.id];delete row.resolved;result.status='partial';}
  }
  const visibleDepartments=new Map();for(const row of rows)for(const department of row.resolved??[])visibleDepartments.set(department.id,department);
  result.departments=[...visibleDepartments.values()];result.updatedAt=new Date(now()).toISOString();
  const nextProofs=new Map(rows.filter(row=>result.accounts[row.id]?.status==='ready').map(row=>[row.id,new Set(row.identities.map(identityKey))]));
  return publish(result,nextProofs);
 }
 return {getSnapshot:snapshot,refresh(){
  if(closed)return Promise.reject(Error('Feishu organization sync is closed'));
  if(!pending)pending=run().catch(()=>{current=empty();proofs.clear();return structuredClone(current);}).finally(()=>{pending=undefined;});
  return pending;
 },async close(){closed=true;current=empty();proofs.clear();controller.abort();await pending;}};
}

/**
 * Fetch the signed-in user's current membership without retaining Feishu credentials or unrelated contact fields.
 * @param {object} options Transient user token, verified open ID, bounded OAuth signal and transport.
 * @returns {Promise<object>} Department names and full path text, or an explicit permission/unavailable state.
 */
export async function readFeishuOrganization({accessToken,openId,signal,fetchImpl=fetch,now=Date.now}){
 const syncedAt=new Date(now()).toISOString();
 const result=(status,departments=[])=>({status,syncedAt,departments});
 if(!id(openId)||!text(accessToken,16384))return result('unavailable');
 let response;
 try{
  const url=new URL(API+'/users/'+encodeURIComponent(openId));
  url.searchParams.set('user_id_type','open_id');url.searchParams.set('department_id_type','open_department_id');
  response=await fetchImpl(url.href,{method:'GET',redirect:'error',signal,headers:{authorization:'Bearer '+accessToken}});
  if(response.status===401||response.status===403)return result('permission-required');
  if(!response.ok||!response.body)return result('unavailable');
  const chunks=[];let size=0;
  for await(const chunk of response.body){size+=chunk.byteLength;if(size>65536)return result('unavailable');chunks.push(chunk);}
  let value;try{value=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{return result('unavailable');}
  if(!object(value))return result('unavailable');
  if(value.code!==0)return result([99991672,99991679,99991668,99991663,99991664].includes(value.code)?'permission-required':'unavailable');
  const user=value.data?.user;
  if(!object(user))return result('unavailable');
  if(user.open_id!==openId)return result('unavailable');
  if(!Array.isArray(user.department_path))return result('permission-required');
  if(user.department_path.length>100)return result('unavailable');
  const departments=[],seen=new Set();
  for(const entry of user.department_path){
   if(!object(entry)||!id(entry.department_id)||seen.has(entry.department_id))return result('unavailable');
   const name=names(entry.department_name),path=names(entry.department_path?.department_path_name),pathIds=entry.department_path?.department_ids;
   if(!text(name,200)||!text(path,20000)||!Array.isArray(pathIds)||pathIds.length>100||!pathIds.every(id))return result('unavailable');
   seen.add(entry.department_id);departments.push({id:entry.department_id,name,path,pathIds:[...pathIds]});
  }
  return result('available',departments);
 }catch(error){
  // Department lookup does not invalidate an otherwise verified login; no provider text is retained.
  void error;return result('unavailable');
 }finally{
  if(response&&!response.bodyUsed){
   try{await response.body?.cancel();}
   catch(error){void error;/* A failed body cleanup cannot replace the fixed membership status. */}
  }
 }
}

/** Read only the signed-in Feishu user's department paths during OAuth authorization. */

/** User-consent scopes required for the department hierarchy on the account page. */
export const FEISHU_ORGANIZATION_SCOPES='contact:contact.base:readonly contact:user.department:readonly contact:user.department_path:readonly';

const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const identifier=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,256}$/.test(value);
const text=(value,max)=>typeof value==='string'&&value.length>0&&value.length<=max&&!/[\x00-\x1f\x7f-\x9f]/.test(value);
const names=value=>object(value)?value.name??value.i18n_name?.zh_cn??value.i18n_name?.en_us:undefined;

/**
 * Fetch current membership without retaining Feishu credentials or unrelated contact fields.
 * @param {object} options Transient user token, verified open ID, bounded OAuth signal and transport.
 * @returns {Promise<object>} Department names and full path text, or an explicit permission/unavailable state.
 */
export async function readFeishuOrganization({accessToken,openId,signal,fetchImpl=fetch,now=Date.now}){
 const syncedAt=new Date(now()).toISOString();
 const result=(status,departments=[])=>({status,syncedAt,departments});
 if(!identifier(openId)||!text(accessToken,16384))return result('unavailable');
 let response;
 try{
  const url=new URL('https://open.feishu.cn/open-apis/contact/v3/users/'+encodeURIComponent(openId));
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
   if(!object(entry)||!identifier(entry.department_id)||seen.has(entry.department_id))return result('unavailable');
   const name=names(entry.department_name),path=names(entry.department_path?.department_path_name),pathIds=entry.department_path?.department_ids;
   if(!text(name,200)||!text(path,20000)||!Array.isArray(pathIds)||pathIds.length>100||!pathIds.every(identifier))return result('unavailable');
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

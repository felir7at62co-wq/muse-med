/**
 * Reads identity and team data from the account gateway with the viewer's own session cookie.
 *
 * The console holds no gateway credential: whatever it shows is what the gateway already lets this viewer see.
 * An administrator is whoever the gateway answers for `/api/workbench?scope=organization`.
 */
import {createHash} from 'node:crypto';

/**
 * Extract one cookie value from a Cookie header.
 * @param {string|undefined} header Raw Cookie header.
 * @param {string} name Cookie name.
 * @returns {string|null} Cookie value, or null when absent or malformed.
 */
export function cookieValue(header,name){
 if(typeof header!=='string')return null;
 for(const part of header.split(';')){
  const index=part.indexOf('=');
  if(index>0&&part.slice(0,index).trim()===name){
   const value=part.slice(index+1).trim();
   return /^[A-Za-z0-9._~+/=-]{1,4096}$/.test(value)?value:null;
  }
 }
 return null;
}

/**
 * Create the gateway reader.
 * @param {{origin:string,cookieName:string,fetch?:typeof fetch,timeoutMs?:number,cacheMs?:number,now?:()=>number}} options Loopback gateway origin, session cookie name and test seams.
 * @returns {{viewer(cookieHeader:string|undefined):Promise<object>}} Viewer resolver.
 */
export function createGatewayReader({origin,cookieName,fetch:request=globalThis.fetch,timeoutMs=15_000,cacheMs=30_000,now=Date.now}){
 const cache=new Map();
 async function get(path,value){
  let response;
  try{response=await request(origin+path,{headers:{cookie:cookieName+'='+value,accept:'application/json'},signal:AbortSignal.timeout(timeoutMs),redirect:'manual'});}
  catch(error){throw Object.assign(Error(error?.name==='TimeoutError'?'gateway_timeout':'gateway_unreachable'),{status:502});}
  if(response.status!==200){await response.body?.cancel().catch(()=>{});return {status:response.status};}
  return {status:200,body:await response.json()};
 }
 /**
  * Resolve who is viewing and, for administrators, the organization view.
  * @param {string|undefined} cookieHeader Raw Cookie header from the browser.
  * @returns {Promise<{state:'anonymous'}|{state:'member',account:object}|{state:'admin',account:object,organization:object}>} Viewer state.
  */
 async function viewer(cookieHeader){
  const value=cookieValue(cookieHeader,cookieName);
  if(!value)return {state:'anonymous'};
  const key=createHash('sha256').update(value).digest('hex');
  const hit=cache.get(key);
  if(hit&&hit.expires>now())return hit.result;
  const profile=await get('/api/muse/profile',value);
  let result;
  if(profile.status===401||profile.status===403)result={state:'anonymous'};
  else if(profile.status!==200)throw Object.assign(Error('gateway_profile_unavailable'),{status:502});
  else{
   const identities=profile.body?.account?.feishuIdentities??[];
   const account={id:String(profile.body?.account?.id??''),name:[...new Set(identities.map(item=>item?.name).filter(Boolean))].join(' / ')||String(profile.body?.account?.username??'')};
   if(!account.id)throw Object.assign(Error('gateway_profile_invalid'),{status:502});
   // The organization view also totals usage for its date range; one day keeps that cheap (30 days takes longer than the timeout).
   const today=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai'}).format(now());
   const team=await get('/api/workbench?scope=organization&from='+today+'&to='+today,value);
   if(team.status===200&&team.body?.administrator===true)result={state:'admin',account,organization:team.body};
   else if(team.status===403||team.status===200)result={state:'member',account};
   else throw Object.assign(Error('gateway_workbench_unavailable'),{status:502});
  }
  cache.set(key,{expires:now()+cacheMs,result});
  if(cache.size>500)for(const [entry,item] of cache)if(item.expires<=now())cache.delete(entry);
  return result;
 }
 return {viewer};
}

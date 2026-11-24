/** Account-authorized, metadata-only production usage queries. */
import {StudioUsageError} from '../../integrations/localminidrama/cloud/studio-usage.mjs';
const reply=(res,status,value)=>{res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'});res.end(JSON.stringify(value));};
/**
 * Serve production usage without opening a worker or exposing its configuration and content.
 * @param {import('node:http').IncomingMessage} req Authenticated gateway request.
 * @param {import('node:http').ServerResponse} res Owned JSON response.
 * @param {object} options Verified session, current authorization, store and optional read-only usage provider.
 * @returns {Promise<boolean>} Whether this module owns the request path.
 */
export async function studioUsageRoute(req,res,{path,session,currentSession,store,reader,publicOrigin}){
 const admin=path==='/api/admin/studio-usage';if(!admin&&path!=='/api/muse/studio-usage')return false;
 const error=(status,code)=>reply(res,status,{error:{code}});
 if(!session){error(401,'account_session_expired');return true;}
 if(admin&&!session.account.admin){error(403,'administrator_required');return true;}
 if(req.method!=='GET'){res.setHeader('allow','GET');error(405,'studio_usage_method_not_allowed');return true;}
 const params=new URL(req.url,publicOrigin).searchParams,allowed=new Set(['from','to','limit','cursor',...admin?['accountId']:[]]);
 if([...params.keys()].some(key=>!allowed.has(key)||params.getAll(key).length!==1)){error(400,'studio_usage_invalid_query');return true;}
 const accountId=admin?params.get('accountId'):session.id;
 if(admin&&(typeof accountId!=='string'||!/^[a-f0-9]{16}$/.test(accountId))){error(400,'studio_usage_account_required');return true;}
 if(admin&&!store.get(accountId)){error(404,'studio_usage_account_not_found');return true;}
 if(!reader){error(503,'studio_usage_not_configured');return true;}
 const authorized=()=>{const current=currentSession();return current?.token===session.token&&current.id===session.id&&(!admin||current.account.admin);};
 if(!authorized()){error(401,'account_session_expired');return true;}
 try{
  const options={...params.has('from')?{from:params.get('from')}:{},...params.has('to')?{to:params.get('to')}:{},
   ...params.has('limit')?{limit:Number(params.get('limit'))}:{},...params.has('cursor')?{cursor:params.get('cursor')}:{}};
  const result=await reader.query(accountId,options);
  if(res.destroyed)return true;if(!authorized()){error(401,'account_session_expired');return true;}
  reply(res,200,result);
 }catch(failure){
  if(res.destroyed)return true;
  if(failure instanceof StudioUsageError)error(failure.status,failure.code);
  else{console.error('[muse-studio-usage] Usage metadata could not be read; private studio content was not returned.');error(503,'studio_usage_unavailable');}
 }
 return true;
}

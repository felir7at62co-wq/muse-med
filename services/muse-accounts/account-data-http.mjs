/** Authenticated usage queries and immutable future-session archive HTTP operations. */

const API='/api/muse/session-archives';
const replyJson=(res,status,value)=>{res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'});res.end(JSON.stringify(value));};
const fail=(code,status)=>Object.assign(new Error(code),{code,status});
const allowedErrors=new Set(['invalid_usage_query','usage_unavailable','usage_corrupt','invalid_archive','archive_conflict','archive_not_found','archive_too_large','archive_unavailable','archive_busy','archive_quota_exceeded']);

/** Limit concurrent buffered archive uploads before reading their bodies.
 * @param {object} options Per-account and shared upload admission bounds.
 * @returns {object} An acquire operation returning its idempotent release.
 */
export function createAccountDataAdmission({maxUploadsPerAccount=1,maxUploadsTotal=4}={}){
 if(!Number.isSafeInteger(maxUploadsPerAccount)||maxUploadsPerAccount<1||!Number.isSafeInteger(maxUploadsTotal)||maxUploadsTotal<maxUploadsPerAccount)throw new Error('Invalid archive admission limits');
 const active=new Map();let total=0;
 return {acquire(accountId){if(total>=maxUploadsTotal||(active.get(accountId)??0)>=maxUploadsPerAccount)throw fail('archive_busy',429);
  total++;active.set(accountId,(active.get(accountId)??0)+1);let released=false;
  return ()=>{if(released)return;released=true;total--;const remaining=active.get(accountId)-1;if(remaining)active.set(accountId,remaining);else active.delete(accountId);};
 }};
}

/** Read a bounded request without destroying the HTTP carrier before a 413 can be sent.
 * @param {import('node:http').IncomingMessage} req Owned request stream.
 * @param {number} limit Maximum raw bytes.
 * @returns {Promise<Buffer>} Complete bytes, or a fixed HTTP failure.
 */
export function readAccountBody(req,limit){
 if(Number(req.headers['content-length'])>limit){req.resume();return Promise.reject(fail('archive_too_large',413));}
 return new Promise((resolve,reject)=>{
  let size=0;const chunks=[];
  const cleanup=()=>{req.off('data',data);req.off('end',end);req.off('error',error);req.off('aborted',aborted);};
  const data=chunk=>{size+=chunk.length;if(size>limit){cleanup();req.resume();reject(fail('archive_too_large',413));}else chunks.push(chunk);};
  const end=()=>{cleanup();resolve(Buffer.concat(chunks));};
  const error=()=>{cleanup();reject(fail('archive_unavailable',503));};
  const aborted=()=>{cleanup();reject(fail('archive_unavailable',503));};
  req.on('data',data);req.once('end',end);req.once('error',error);req.once('aborted',aborted);
 });
}

/** Serve reserved account-data routes after the gateway's authentication and Origin checks.
 * @param {import('node:http').IncomingMessage} req Authenticated request.
 * @param {import('node:http').ServerResponse} res Response carrier.
 * @param {object} options Authenticated identity, stores, current authorization and public URL.
 * @returns {Promise<boolean>} Whether this module owns the requested route.
 */
export async function accountDataRoute(req,res,{path,publicOrigin,session,currentSession,usageLedger,sessionArchives,store,admission}){
 const own=path==='/api/muse/identity'||path==='/api/muse/usage'||path==='/api/admin/usage'||path==='/api/admin/accounts'||path===API||path.startsWith(API+'/');
 if(!own)return false;
 const authorized=()=>{const value=currentSession();return value?.token===session.token&&value.id===session.id?value:null;};
 let release;
 try{
  const url=new URL(req.url,publicOrigin),query=Object.fromEntries(url.searchParams);
  if(path==='/api/muse/identity'){
   if(req.method!=='GET')throw fail('method_not_allowed',405);
   replyJson(res,200,{version:1,accountId:session.id,username:session.account.username,admin:session.account.admin===true});return true;
  }
  if(path==='/api/admin/accounts'){
   if(!session.account.admin)throw fail('forbidden',403);if(req.method!=='GET')throw fail('method_not_allowed',405);
   replyJson(res,200,{version:1,items:store.list()});return true;
  }
  if(path==='/api/muse/usage'||path==='/api/admin/usage'){
   if(req.method!=='GET')throw fail('method_not_allowed',405);const admin=path==='/api/admin/usage';
   if(admin&&!session.account.admin)throw fail('forbidden',403);
   if(Object.keys(query).some(key=>!['from','to','limit','cursor',...admin?['accountId']:[]].includes(key)))throw fail('invalid_usage_query',400);
   if(!usageLedger)throw fail('usage_unavailable',503);
   const value=await usageLedger.query({...query,...admin?{}:{accountId:session.id}});
   const current=authorized();if(!current)throw fail('account_session_expired',401);if(admin&&!current.account.admin)throw fail('forbidden',403);
   if(!admin)value.items=value.items.map(({accountId,...item})=>item);
   replyJson(res,200,value);return true;
  }
  if(!sessionArchives)throw fail('archive_unavailable',503);
  if(path===API){
   if(req.method!=='GET')throw fail('method_not_allowed',405);
   if(Object.keys(query).some(key=>!['limit','cursor','summary'].includes(key))||query.summary!==undefined&&query.summary!=='1')throw fail('invalid_archive',400);
   const value=await sessionArchives.list(session.id,{...query,summary:query.summary==='1',...query.limit===undefined?{}:{limit:Number(query.limit)}});if(!authorized())throw fail('account_session_expired',401);replyJson(res,200,value);return true;
  }
  const attachment=/^\/api\/muse\/session-archives\/attachments\/([a-f0-9]{64})$/.exec(path);
  if(attachment){
   if(url.search)throw fail('invalid_archive',400);
   if(req.method==='PUT'){
    if(req.headers['content-type']?.split(';')[0].trim()!=='application/octet-stream')throw fail('unsupported_media_type',415);
    release=admission.acquire(session.id);
    const bytes=await readAccountBody(req,sessionArchives.limits.maxAttachmentBytes);if(!authorized())throw fail('account_session_expired',401);
    const value=await sessionArchives.putAttachment(session.id,attachment[1],bytes);if(!authorized())throw fail('account_session_expired',401);replyJson(res,201,value);return true;
   }
   if(req.method==='GET'){
    const bytes=await sessionArchives.getAttachment(session.id,attachment[1]);if(!authorized())throw fail('account_session_expired',401);
    res.writeHead(200,{'content-type':'application/octet-stream','content-length':bytes.length,'content-disposition':`attachment; filename="${attachment[1]}"`,'cache-control':'no-store','x-content-type-options':'nosniff'});res.end(bytes);return true;
   }
   throw fail('method_not_allowed',405);
  }
  const revision=/^\/api\/muse\/session-archives\/([a-f0-9-]{36})\/([A-Za-z0-9_-]{1,128})\/revisions\/([a-f0-9]{64})$/i.exec(path);
  if(revision){
   if(url.search)throw fail('invalid_archive',400);
   if(req.method==='GET'){
    const value=await sessionArchives.revision(session.id,revision[1],revision[2],revision[3]);if(!authorized())throw fail('account_session_expired',401);replyJson(res,200,value);return true;
   }
   if(req.method!=='PUT')throw fail('method_not_allowed',405);
   if(req.headers['content-type']?.split(';')[0].trim()!=='application/json')throw fail('unsupported_media_type',415);
   release=admission.acquire(session.id);
   const bytes=await readAccountBody(req,sessionArchives.limits.maxRevisionBytes);if(!authorized())throw fail('account_session_expired',401);
   const value=await sessionArchives.putRevision(session.id,revision[1],revision[2],revision[3],bytes);if(!authorized())throw fail('account_session_expired',401);replyJson(res,201,value);return true;
  }
  const revisions=/^\/api\/muse\/session-archives\/([a-f0-9-]{36})\/([A-Za-z0-9_-]{1,128})\/revisions$/i.exec(path);
  if(revisions){
   if(req.method!=='GET')throw fail('method_not_allowed',405);
   if(Object.keys(query).some(key=>!['limit','cursor','summary'].includes(key))||query.summary!==undefined&&query.summary!=='1')throw fail('invalid_archive',400);
   const value=await sessionArchives.revisions(session.id,revisions[1],revisions[2],{...query,summary:query.summary==='1',...query.limit===undefined?{}:{limit:Number(query.limit)}});if(!authorized())throw fail('account_session_expired',401);replyJson(res,200,value);return true;
  }
  const latest=/^\/api\/muse\/session-archives\/([a-f0-9-]{36})\/([A-Za-z0-9_-]{1,128})$/i.exec(path);
  if(latest){
   if(req.method!=='GET')throw fail('method_not_allowed',405);if(url.search)throw fail('invalid_archive',400);
   const value=await sessionArchives.latest(session.id,latest[1],latest[2]);if(!authorized())throw fail('account_session_expired',401);replyJson(res,200,value);return true;
  }
  throw fail('invalid_archive',400);
 }catch(error){
  const known=allowedErrors.has(error.code)||['method_not_allowed','forbidden','account_session_expired','unsupported_media_type'].includes(error.code);
  if(!known)console.error('[muse-account-data] Storage operation failed; no cloud acknowledgement was returned.');
  if(error.code==='archive_busy')res.setHeader('retry-after','1');
  if(!res.headersSent)replyJson(res,known?error.status:503,{error:{code:known?error.code:path.includes('usage')?'usage_unavailable':'archive_unavailable'}});
  else res.destroy();return true;
 }finally{release?.();}
}

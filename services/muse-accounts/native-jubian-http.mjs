/** Account-authenticated metadata admission for the original-token Jubian path. */
import {createHash} from 'node:crypto';
import {readAccountBody} from './account-data-http.mjs';

const PREFIX='/api/muse/native-jubian';
const types=new Set(['policy','quote','reserve','status','dispatch','cancel','settle','quote_batch','reserve_batch',
 'observation_quote','budget_quote','budget_update','queue_join','queue_status','queue_cancel','source_quote','source_reserve','source_status','source_cancel',
 'source_effect_quote','source_effect_reserve','source_effect_dispatch','source_effect_observation_quote','source_effect_observe']);
const inputFields=new Set(['type','method','company_id','provider_origin','provider_connection_revision','script_id','operation_id','request_sha256',
 'quote_sha256','currency','amount_minor','resources','policy_revision','attempt_id','approval_proof','admission_id',
 'reason','state','observation_sha256','observation_proof','items','change_id','target','new_limit_minor',
 'expected_revision','base_policy_revision','budget_proof','source','plan_sha256','consent_proof','managed_proof','kind','destination','receipt','queue_id','queue_key']);
const reviewFields=new Set(['project_title','model','platform','duration','durationSeconds','resolution','asset_count',
 'referenceCount','supplier_amount_minor']);
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const fail=(code,status)=>Object.assign(new Error(code),{code,status});
const digest=value=>createHash('sha256').update(value).digest('hex');
const identity=session=>({accountId:session.id,sessionId:digest(session.token),deviceId:null});
const fields=(value,allowed)=>object(value)&&Object.keys(value).every(key=>allowed.has(key));
function input(value){
 if(!fields(value,inputFields)||!types.has(value.type))throw fail('native_jubian_invalid_request',400);
 if(value.type==='policy'){
  if(Object.keys(value).some(key=>!['type','company_id'].includes(key)))throw fail('native_jubian_invalid_request',400);
  return value;
 }
 if(value.type.startsWith('queue_')){
  const allowed=new Set(value.type==='queue_join'?['type','company_id','queue_key','items']:['type','company_id','queue_id']);
  if(!fields(value,allowed)||value.type==='queue_join'&&(!Array.isArray(value.items)||value.items.some(row=>!fields(row,inputFields))))throw fail('native_jubian_invalid_request',400);
  return value;
 }
 if(value.type.startsWith('source_')){
  const common=['type','company_id','operation_id'];
  const allowed=new Set(['source_quote','source_reserve'].includes(value.type)?[...common,'provider_origin','provider_connection_revision',
   'method','source','plan_sha256',...value.type==='source_reserve'?['consent_proof','managed_proof']:[]]
   :['source_status','source_cancel'].includes(value.type)?common:[...common,'kind','request_sha256','destination','managed_proof',
    ...['source_effect_observation_quote','source_effect_observe'].includes(value.type)?['receipt']:[]]);
  if(!fields(value,allowed))throw fail('native_jubian_invalid_request',400);
  return value;
 }
 if(['budget_quote','budget_update'].includes(value.type)){
  const allowed=new Set(['type','company_id','change_id','target','new_limit_minor',
   ...value.type==='budget_update'?['expected_revision','base_policy_revision','budget_proof']:[]]);
  if(!fields(value,allowed)||!fields(value.target,new Set(['kind','account_id','provider_origin','script_id'])))throw fail('native_jubian_invalid_request',400);
  return value;
 }
 const batch=['quote_batch','reserve_batch'].includes(value.type),rows=batch?value.items:[value];
 if(batch&&Object.keys(value).some(key=>!['type','items',...value.type==='reserve_batch'?['queue_id']:[]].includes(key))||!batch&&value.items!==undefined)throw fail('native_jubian_invalid_request',400);
 if(!Array.isArray(rows)||rows.some(row=>!fields(row,inputFields)))throw fail('native_jubian_invalid_request',400);
 for(const row of rows){
  if(batch&&(row.type!==undefined||row.items!==undefined))throw fail('native_jubian_invalid_request',400);
  if(row.resources!==undefined&&(!Array.isArray(row.resources)||row.resources.some(resource=>!fields(resource,new Set(['kind','id'])))))throw fail('native_jubian_invalid_request',400);
 }
 return value;
}

/**
 * Own bounded request parsing and drain metadata operations before their stores close.
 * @param {object} options Optional admission and native-question authorities, and a raw request-byte limit.
 * @returns {object} Route handler and idempotent close operation; injected authorities retain their own lifetimes.
 */
export function createNativeJubianHttp({admission,fees,maxRequestBytes=262144}={}){
 if(!Number.isSafeInteger(maxRequestBytes)||maxRequestBytes<1||maxRequestBytes>2097152)throw Error('Invalid native Jubian request-byte limit');
 if(admission!==undefined&&typeof admission.request!=='function')throw Error('Native Jubian admission requires request');
 if(fees!==undefined&&['createNativeJubianChallenge','nativeJubianChallenge',
  'createNativeJubianObservationChallenge','nativeJubianObservation',
  'createNativeJubianBudgetChallenge','nativeJubianBudget'].some(method=>typeof fees[method]!=='function'))throw Error('Native Jubian approval methods are unavailable');
 const lifetime=new AbortController(),pending=new Set();let closing=false,closed;
 const json=(res,status,value,headers={})=>{if(!res.destroyed){res.writeHead(status,{'content-type':'application/json; charset=utf-8',
  'cache-control':'no-store','x-content-type-options':'nosniff',...headers});res.end(JSON.stringify(value));}};
 async function body(req){
  if(req.headers['content-type']?.split(';')[0].trim()!=='application/json')throw fail('native_jubian_json_required',415);
  const abort=()=>req.destroy();lifetime.signal.addEventListener('abort',abort,{once:true});
  try{
   lifetime.signal.throwIfAborted();let bytes;
   try{bytes=await readAccountBody(req,maxRequestBytes);}
   catch(error){
    if(lifetime.signal.aborted)throw fail('native_jubian_draining',503);
    if(error.code==='archive_too_large')throw fail('native_jubian_request_too_large',413);
    throw fail('native_jubian_unavailable',503);
   }
   try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}
   catch(_error){throw fail('native_jubian_invalid_request',400);}
  }finally{lifetime.signal.removeEventListener('abort',abort);}
 }
 async function handle(req,res,{path,session,currentSession,publicOrigin,rate}){
  const current=()=>{const next=currentSession();return next?.id===session?.id&&next?.token===session?.token
   &&next.account?.revision===session.account?.revision?next:null;};
  const authorize=()=>{if(!session?.token||!current())throw fail('account_session_expired',401);return identity(session);};
  try{
   const context=authorize(),url=new URL(req.url,publicOrigin);
   if(url.search)throw fail('native_jubian_invalid_request',400);
   if(closing)throw fail('native_jubian_draining',503);
   if(!rate())throw fail('native_jubian_rate_limited',429);
   if(!admission)throw fail('native_jubian_not_configured',503);
   if(path===PREFIX+'/capabilities'){
    if(req.method!=='GET')throw fail('native_jubian_method_not_allowed',405);
    json(res,200,{configured:true,nativeApprovalAvailable:fees!==undefined,fairQueueConfigured:admission.queueEnabled===true});return;
   }
   const challenge=/^\/api\/muse\/native-jubian\/(challenges|observations|budgets)\/([a-f0-9-]{36})$/u.exec(path);
   if(challenge){
    if(req.method!=='GET')throw fail('native_jubian_method_not_allowed',405);
    if(!fees)throw fail('native_jubian_approval_unavailable',503);
    const result=challenge[1]==='observations'?await fees.nativeJubianObservation(context,challenge[2])
     :challenge[1]==='budgets'?await fees.nativeJubianBudget(context,challenge[2])
     :await fees.nativeJubianChallenge(context,challenge[2]);
    authorize();json(res,200,result);return;
   }
   const sourceChallenge=/^\/api\/muse\/native-jubian\/sources\/(consents|managed)\/([a-f0-9-]{36})$/u.exec(path);
   if(sourceChallenge){
    if(req.method!=='GET')throw fail('native_jubian_method_not_allowed',405);
    const read=sourceChallenge[1]==='consents'?'nativeJubianSourceConsent':'nativeJubianSourceManaged';
    if(typeof fees?.[read]!=='function')throw fail('native_jubian_source_approval_unavailable',503);
    const result=await fees[read](context,sourceChallenge[2]);authorize();json(res,200,result);return;
   }
   if(['/sources/consents','/sources/managed'].some(suffix=>path===PREFIX+suffix)){
    if(req.method!=='POST')throw fail('native_jubian_method_not_allowed',405);
    const value=await body(req);authorize();if(res.destroyed)return;
    if(!fields(value,new Set(['input','issuer_id']))||typeof value.issuer_id!=='string')throw fail('native_jubian_invalid_request',400);
    const consent=path===PREFIX+'/sources/consents',create=consent?'createNativeJubianSourceConsentChallenge':'createNativeJubianSourceManagedChallenge';
    if(typeof fees?.[create]!=='function')throw fail('native_jubian_source_approval_unavailable',503);
    const proposal=input(value.input);
    if(!(consent?proposal.type==='source_quote':['source_quote','source_effect_quote','source_effect_observation_quote'].includes(proposal.type)))
     throw fail('native_jubian_invalid_request',400);
    const quote=await admission.request(context,proposal);authorize();
    if(!object(quote)||quote.allowed!==true||!object(quote.canonical)||quote.managed_proof_available!==true
     ||consent&&(quote.consent_required!==true||quote.consent_available!==true))throw fail('native_jubian_source_approval_unavailable',503);
    if(!['quoted','new','reserved','unknown'].includes(quote.state))throw fail('native_jubian_source_not_ready',409);
    const result=await fees[create](context.accountId,quote.canonical,value.issuer_id);authorize();json(res,200,result);return;
   }
   if(!['/admission','/challenges','/observations','/budgets'].some(suffix=>path===PREFIX+suffix))throw fail('native_jubian_not_found',404);
   if(req.method!=='POST')throw fail('native_jubian_method_not_allowed',405);
   const value=await body(req);authorize();if(res.destroyed)return;
   if(path===PREFIX+'/admission'){
    const result=await admission.request(context,input(value));authorize();json(res,200,result);return;
   }
   if(!fees)throw fail('native_jubian_approval_unavailable',503);
   if(path===PREFIX+'/budgets'){
    if(!fields(value,new Set(['input','issuer_id']))||typeof value.issuer_id!=='string')throw fail('native_jubian_invalid_request',400);
    const proposal=input(value.input);
    if(proposal.type!=='budget_quote')throw fail('native_jubian_invalid_request',400);
    const budget=await admission.request(context,proposal);authorize();
    if(object(budget)&&budget.state==='applied'){json(res,200,budget);return;}
    if(!object(budget)||budget.allowed!==true||!object(budget.canonical)
     ||budget.budget_approval_available!==true)throw fail('native_jubian_budget_unavailable',503);
    const result=await fees.createNativeJubianBudgetChallenge(context.accountId,budget.canonical,value.issuer_id);
    authorize();json(res,200,result);return;
   }
   if(path===PREFIX+'/observations'){
    if(!fields(value,new Set(['input','issuer_id']))||typeof value.issuer_id!=='string')throw fail('native_jubian_invalid_request',400);
    const proposal=input(value.input);
    if(proposal.type!=='observation_quote')throw fail('native_jubian_invalid_request',400);
    const observation=await admission.request(context,proposal);authorize();
    if(!object(observation)||!object(observation.canonical))throw fail('native_jubian_observation_unavailable',503);
    if(observation.observation_approval_available!==true)throw fail('native_jubian_observation_unavailable',503);
    const result=await fees.createNativeJubianObservationChallenge(context.accountId,observation.canonical,value.issuer_id);
    authorize();json(res,200,result);return;
   }
   if(!fields(value,new Set(['input','issuer_id','review']))||typeof value.issuer_id!=='string'
    ||value.review!==undefined&&!fields(value.review,reviewFields))throw fail('native_jubian_invalid_request',400);
   const proposal=input(value.input);
   if(!['quote','quote_batch'].includes(proposal.type))throw fail('native_jubian_invalid_request',400);
   const quote=await admission.request(context,proposal);authorize();
   if(!object(quote))throw fail('native_jubian_quote_unavailable',503);
   if(quote.within_limit!==true||quote.capacity_ready!==true||quote.resource_ready!==true)throw fail('native_jubian_quote_not_ready',409);
   const rows=proposal.type==='quote_batch'?quote.items:[quote];
   if(!Array.isArray(rows)||rows.some(row=>!object(row)||!object(row.canonical))
    ||proposal.type==='quote_batch'&&rows.length!==proposal.items.length)throw fail('native_jubian_quote_unavailable',503);
   const challenges=[];
   for(const row of rows){
    authorize();challenges.push(await fees.createNativeJubianChallenge(context.accountId,row.canonical,value.issuer_id,value.review));
   }
   const result=proposal.type==='quote_batch'?{items:challenges}:challenges[0];
   authorize();json(res,200,result);
  }catch(error){
   const known=typeof error.code==='string'&&/^(?:native_jubian_|production_fee_)[a-z_]+$/u.test(error.code)
    ||error.code==='account_session_expired';
   if(!known)console.error('[muse-native-jubian] Metadata admission failed; retain the original operation before recovery.');
   json(res,known?error.status??409:503,{error:{code:known?error.code:'native_jubian_unavailable'}});
  }
 }
 return {
  /** Handle this namespace after the account gateway's authentication and Origin checks. */
  route(req,res,options){
   if(options.path!==PREFIX&&!options.path.startsWith(PREFIX+'/'))return Promise.resolve(false);
   const operation=Promise.resolve().then(()=>handle(req,res,options));pending.add(operation);
   return operation.then(()=>true).finally(()=>pending.delete(operation));
  },
  /** Reject new admission, cancel buffered reads and wait before injected stores are released. */
  close(){closing=true;lifetime.abort();closed??=Promise.allSettled([...pending]).then(()=>{});return closed;},
 };
}

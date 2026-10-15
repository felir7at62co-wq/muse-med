/** Account-authenticated Desktop access to the website's current model catalog. */
import {forwardModel,resolveModelReasoning,completionEndpoint} from './model-relay.mjs';
import {createModelKeyPool,ModelKeyPoolError,resolveModelKeyPoolPolicy} from './model-key-pool.mjs';
import {scheduleSessionExpiry} from './session-expiry.mjs';

/** Project only public model metadata; upstream endpoints and keys stay on the server. */
export function desktopModelCatalog(globalModels,modelConfig){
 const meta=globalModels?.metadata();const providers=[];
 for(const [id,provider] of Object.entries(meta?.providers??{})){
  providers.push({id,name:provider.displayName||id,models:provider.models.map(model=>({
   id:model.id,name:model.name||model.id,contextWindow:model.contextWindow,maxTokens:model.maxTokens,
   input:model.input??['text'],reasoningEfforts:model.reasoningEfforts??false,
   ...model.defaultReasoningEffort===undefined?{}:{defaultReasoningEffort:model.defaultReasoningEffort},
  }))});
 }
 if(meta?.deepseek){const p=meta.deepseek;providers.push({id:'deepseek-official',name:'DeepSeek',models:p.models.map(m=>({
  id:m.id,name:m.name||m.id,contextWindow:m.contextWindow??p.defaultContextWindow,maxTokens:m.maxTokens??p.maxTokens,
  input:m.inputModalities??['text'],reasoningEfforts:p.thinking==='disabled'?false:{off:null,low:'low',high:'high',max:'max'},
 }))});}
 if(!meta&&modelConfig?.private().apiKey){const p=modelConfig.private();providers.push({id:'muse-shared',name:p.name,models:[{
  id:'muse-shared',name:p.name,contextWindow:p.contextWindow,maxTokens:p.maxTokens,input:['text'],reasoningEfforts:false,
 }]});}
 return {providers};
}

/** Own model requests by login session so logout, account revocation and expiry cancel them.
 * @param {object} options Model configuration, forwarding operation and login clock.
 * @returns {object} Request handling and stream cancellation operations.
 */
export function createDesktopModels({globalModels,modelConfig,forward=forwardModel,now=Date.now,transport='relay',keyPoolPolicy=resolveModelKeyPoolPolicy(),keyPool,directLeases}){
 if(!['relay','direct'].includes(transport))throw Error('Invalid Desktop model transport');
 const active=new Map();
 const poolKeys=()=>globalModels?.credentialPool?.('zhipu-official')??[];
 const pool=keyPool??createModelKeyPool({keys:poolKeys,...keyPoolPolicy});
 const pooled=id=>id==='zhipu-official'&&poolKeys().length>0;
 const directRequest=req=>transport==='direct'&&req.headers['x-muse-model-access']==='direct-v1'
  &&(!poolKeys().length||req.headers['x-muse-provider-routing']==='mixed-v1');
 const revoke=token=>{for(const item of active.get(token)??[])item.controller.abort();};
 return {revoke,close(){for(const token of active.keys())revoke(token);if(!keyPool)pool.close();},async handle(req,res,session,path){
  const fail=(status,message,headers={})=>{if(res.headersSent){res.destroy();return;}res.writeHead(status,{'content-type':'application/json','cache-control':'no-store',...headers});res.end(JSON.stringify({error:{message}}));};
  if(path==='/api/desktop-models/providers'&&req.method==='GET'){
   const catalog=desktopModelCatalog(globalModels,modelConfig);
   if(directRequest(req))catalog.transport='direct';
   res.writeHead(200,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(catalog));return;
  }
  if(path==='/api/desktop-models/access'&&req.method==='GET'){
   if(!directRequest(req)){fail(404,'本地模型直连未启用');return;}
   const catalog=desktopModelCatalog(globalModels,modelConfig),providers=[];
   for(const provider of catalog.providers){
    if(pooled(provider.id)){providers.push({...provider,transport:directLeases&&req.headers['x-muse-zhipu-direct']==='leased-v1'?'leased':'relay'});continue;}
    const configs=provider.models.map(model=>globalModels?.resolve(provider.id,model.id));
    const first=configs[0];
    if(!first?.apiKey||configs.some((config,index)=>!config||config.apiKey!==first.apiKey||config.baseURL!==first.baseURL||config.model!==provider.models[index].id)){
     fail(503,'模型直连配置不完整，请联系管理员');return;
    }
    let baseURL;
    try{baseURL=completionEndpoint(first.baseURL).href.replace(/\/chat\/completions$/,'');}catch{fail(503,'模型直连地址无效，请联系管理员');return;}
    providers.push({...provider,access:{baseURL,apiKey:first.apiKey}});
   }
   res.writeHead(200,{'content-type':'application/json','cache-control':'no-store','pragma':'no-cache'});
   res.end(JSON.stringify({transport:'direct',providers}));return;
  }
  const directPath='/api/desktop-models/zhipu-official/leases';
  if(path===directPath||path.startsWith(directPath+'/')){
   if(!directLeases||!directRequest(req)||req.headers['x-muse-zhipu-direct']!=='leased-v1'){fail(404,'Direct model access unavailable');return;}
   const controller=new AbortController(),abort=()=>controller.abort();req.on('aborted',abort);res.on('close',abort);
   const item={accountId:session.id,controller},items=active.get(session.token)??new Set();active.set(session.token,items);items.add(item);
   const cancelExpiry=scheduleSessionExpiry(session.expiry,abort,{now});
   try{
    let value;
    if(path===directPath&&req.method==='POST'){
     let size=0;const chunks=[];
     for await(const chunk of req){size+=chunk.length;if(size>4096){fail(413,'Invalid direct model request');return;}chunks.push(chunk);}
     let body;try{body=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{fail(400,'Invalid direct model request');return;}
     if(!body||typeof body.model!=='string'||body.model.length>200){fail(400,'Invalid direct model request');return;}
     value=await directLeases.acquire(session,body.model,controller.signal);
    }else{
     const id=path.slice(directPath.length+1);
     if(!/^[0-9a-f-]{36}$/i.test(id)){fail(404,'Direct model reservation unavailable');return;}
     if(req.method==='GET')value=directLeases.check(session,id);
     else if(req.method==='DELETE')value=await directLeases.release(session,id);
     else{fail(405,'Unsupported direct model method');return;}
    }
    if(controller.signal.aborted){fail(401,'Muse session expired or request cancelled');return;}
    res.writeHead(200,{'content-type':'application/json','cache-control':'no-store','pragma':'no-cache'});res.end(JSON.stringify(value));
   }catch(error){fail(controller.signal.aborted?401:error instanceof ModelKeyPoolError?503:error.status??503,'Direct model admission unavailable');}
   finally{cancelExpiry();req.off('aborted',abort);res.off('close',abort);items.delete(item);if(!items.size)active.delete(session.token);}
   return;
  }
  const route=/^\/api\/desktop-models\/([a-z][a-z0-9-]{0,63})\/chat\/completions$/.exec(path)?.[1];
  if(!route||req.method!=='POST'){fail(404,'模型接口不存在');return;}
  const controller=new AbortController(),item={accountId:session.id,controller};
  const items=active.get(session.token)??new Set();active.set(session.token,items);items.add(item);
  const abort=()=>controller.abort();req.on('aborted',abort);res.on('close',abort);
  const cancelExpiry=scheduleSessionExpiry(session.expiry,abort,{now});
  let lease,queueMs;
  try{
   let size=0;const chunks=[];for await(const chunk of req){size+=chunk.length;if(size>24*1024*1024){fail(413,'上下文过大');return;}chunks.push(chunk);}
   let body;try{body=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{fail(400,'请求格式错误');return;}
   if(!body||typeof body.model!=='string'||!Array.isArray(body.messages)){fail(400,'请选择 Muse 模型');return;}
   let config=globalModels?.resolve(route,body.model);
   if(!globalModels&&route==='muse-shared'&&body.model==='muse-shared')config=modelConfig?.private();
   if(!config){fail(400,'模型已撤回或不属于此供应商，请刷新模型列表');return;}
   if(!config.apiKey){fail(503,'管理员尚未配置该模型凭据');return;}
   for(const key of ['max_tokens','max_completion_tokens'])if(body[key]!==undefined&&(!Number.isSafeInteger(body[key])||body[key]<1)){fail(400,'输出上限无效');return;}
   if(controller.signal.aborted){fail(401,'Muse 登录已失效');return;}
   if(pooled(route)){
    const queuedAt=performance.now();lease=await pool.acquire(controller.signal);queueMs=performance.now()-queuedAt;controller.signal.throwIfAborted();
    const current=globalModels.resolve(route,body.model);
    if(!current?.apiKey||!poolKeys().includes(lease.key)){fail(503,'模型配置已变化，请刷新模型列表');return;}
    config={...current,apiKey:lease.key};
   }
   try{resolveModelReasoning(config,body);}catch(error){fail(400,error.message);return;}
   body.model=config.model;
   for(const key of ['max_tokens','max_completion_tokens'])if(body[key]!==undefined)body[key]=Math.min(body[key],config.maxTokens);
   if(body.max_tokens===undefined&&body.max_completion_tokens===undefined)body.max_tokens=config.maxTokens;
   if(now()>=session.expiry){controller.abort();fail(401,'Muse 登录已失效');return;}
   await forward({config,body,res,signal:controller.signal,queueMs});
  }catch(error){if(error instanceof ModelKeyPoolError&&!controller.signal.aborted)fail(503,'模型请求正在排队，请稍后重试',{'retry-after':'1'});else fail(controller.signal.aborted?401:502,controller.signal.aborted?'Muse 登录已失效或请求已取消':'模型服务暂不可用，请稍后重试');}
  finally{lease?.release();cancelExpiry();req.off('aborted',abort);res.off('close',abort);items.delete(item);if(!items.size)active.delete(session.token);}
 }};
}

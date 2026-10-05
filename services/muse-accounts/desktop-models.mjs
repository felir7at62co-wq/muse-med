/** Account-authenticated Desktop access to the website's current model catalog. */
import {forwardModel,resolveModelReasoning} from './model-relay.mjs';

/** Resolve validated per-account and shared Desktop stream limits.
 * @param {object} environment Gateway environment settings.
 * @returns {object} Per-account and per-process limits, defaulting to four and thirty-two active streams.
 */
export function resolveDesktopModelLimits(environment){
 const read=(name,fallback,max)=>{const raw=environment[name];if(raw===undefined)return fallback;
  if(typeof raw!=='string'||!/^\d+$/.test(raw)||!Number.isSafeInteger(Number(raw))||Number(raw)<1||Number(raw)>max)throw Error('Invalid '+name);
  return Number(raw);
 };
 return {desktopModelMaxActive:read('MUSE_DESKTOP_MODEL_MAX_ACTIVE',4,32),desktopModelMaxTotal:read('MUSE_DESKTOP_MODEL_MAX_TOTAL',32,1024)};
}

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

/** Own bounded streams by login session so logout, account revocation and expiry cancel them.
 * @param {object} options Relay dependencies and per-account maxActive/per-process maxTotal limits.
 * @returns {object} Request handling and stream cancellation operations.
 */
export function createDesktopModels({globalModels,modelConfig,forward=forwardModel,maxActive=4,maxTotal=32,now=Date.now}){
 if(!Number.isSafeInteger(maxActive)||maxActive<1||maxActive>32)throw Error('Invalid desktop model concurrency');
 if(!Number.isSafeInteger(maxTotal)||maxTotal<1||maxTotal>1024)throw Error('Invalid desktop model concurrency');
 const active=new Map();
 const revoke=token=>{for(const item of active.get(token)??[])item.controller.abort();};
 return {revoke,close(){for(const token of active.keys())revoke(token);},async handle(req,res,session,path){
  const fail=(status,message,headers={})=>{if(res.headersSent){res.destroy();return;}res.writeHead(status,{'content-type':'application/json','cache-control':'no-store',...headers});res.end(JSON.stringify({error:{message}}));};
  if(path==='/api/desktop-models/providers'&&req.method==='GET'){
   res.writeHead(200,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(desktopModelCatalog(globalModels,modelConfig)));return;
  }
  const route=/^\/api\/desktop-models\/([a-z][a-z0-9-]{0,63})\/chat\/completions$/.exec(path)?.[1];
  if(!route||req.method!=='POST'){fail(404,'模型接口不存在');return;}
  let count=0,total=0;for(const items of active.values()){total+=items.size;for(const item of items)if(item.accountId===session.id)count++;}
  if(count>=maxActive||total>=maxTotal){fail(429,'模型请求过多，请稍后重试',{'retry-after':'1'});return;}
  const controller=new AbortController(),item={accountId:session.id,controller};
  const items=active.get(session.token)??new Set();active.set(session.token,items);items.add(item);
  const abort=()=>controller.abort();req.on('aborted',abort);res.on('close',abort);
  const timer=setTimeout(abort,Math.min(2147483647,Math.max(1,session.expiry-now())));timer.unref();
  try{
   let size=0;const chunks=[];for await(const chunk of req){size+=chunk.length;if(size>24*1024*1024){fail(413,'上下文过大');return;}chunks.push(chunk);}
   let body;try{body=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{fail(400,'请求格式错误');return;}
   if(!body||typeof body.model!=='string'||!Array.isArray(body.messages)){fail(400,'请选择 Muse 模型');return;}
   let config=globalModels?.resolve(route,body.model);
   if(!globalModels&&route==='muse-shared'&&body.model==='muse-shared')config=modelConfig?.private();
   if(!config){fail(400,'模型已撤回或不属于此供应商，请刷新模型列表');return;}
   if(!config.apiKey){fail(503,'管理员尚未配置该模型凭据');return;}
   try{resolveModelReasoning(config,body);}catch(error){fail(400,error.message);return;}
   body.model=config.model;
   for(const key of ['max_tokens','max_completion_tokens'])if(body[key]!==undefined){if(!Number.isSafeInteger(body[key])||body[key]<1){fail(400,'输出上限无效');return;}body[key]=Math.min(body[key],config.maxTokens);}
   if(body.max_tokens===undefined&&body.max_completion_tokens===undefined)body.max_tokens=config.maxTokens;
   if(controller.signal.aborted){fail(401,'Muse 登录已失效');return;}
   await forward({config,body,res,signal:controller.signal});
  }catch{fail(controller.signal.aborted?401:502,controller.signal.aborted?'Muse 登录已失效或请求已取消':'模型服务暂不可用，请稍后重试');}
  finally{clearTimeout(timer);req.off('aborted',abort);res.off('close',abort);items.delete(item);if(!items.size)active.delete(session.token);}
 }};
}

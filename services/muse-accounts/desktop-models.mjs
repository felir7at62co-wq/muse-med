/** Account-authenticated Desktop access to the website's current model catalog. */
import {forwardModel,resolveModelReasoning} from './model-relay.mjs';
import {createModelKeyPool,ModelKeyPoolError,resolveModelKeyPoolPolicy} from './model-key-pool.mjs';
import {scheduleSessionExpiry} from './session-expiry.mjs';
import {createModelRequestMetadata} from './model-request-metadata.mjs';

/** Project only public model metadata; upstream endpoints and keys stay on the server.
 * @param {object|undefined} globalModels Current private model directory.
 * @param {object|undefined} modelConfig Legacy shared model configuration.
 * @param {object|undefined} flashRouting Optional shared DeepSeek Flash catalog projection.
 * @returns {object} Public provider and model capabilities.
 */
export function desktopModelCatalog(globalModels,modelConfig,flashRouting){
 const metadata=globalModels?.metadata();
 const meta=flashRouting?.catalog(metadata)??metadata;const providers=[];
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
 * @param {object} options Model configuration, forwarding operation, login clock and optional synchronous metadata sink.
 * @returns {object} Request handling and stream cancellation operations.
 */
export function createDesktopModels({globalModels,flashRouting,modelConfig,forward=forwardModel,now=Date.now,keyPoolPolicy=resolveModelKeyPoolPolicy(),keyPool,metadataSink,usageLedger}){
 const active=new Map();
 const poolKeys=()=>globalModels?.credentialPool?.('zhipu-official')??[];
 const pool=keyPool??createModelKeyPool({keys:poolKeys,...keyPoolPolicy});
 const pooled=id=>id==='zhipu-official'&&poolKeys().length>0;
 const revoke=token=>{for(const item of active.get(token)??[])item.controller.abort();};
 return {revoke,close(){for(const token of active.keys())revoke(token);if(!keyPool)pool.close();},async handle(req,res,session,path){
  let metadata;
  const fail=(status,message,headers={})=>{metadata?.client(status);metadata?.failed('request_rejected');if(res.headersSent){res.destroy();return;}res.writeHead(status,{'content-type':'application/json','cache-control':'no-store',...headers});res.end(JSON.stringify({error:{message}}));};
  if(path==='/api/desktop-models/providers'&&req.method==='GET'){
   const catalog=desktopModelCatalog(globalModels,modelConfig,flashRouting);
   res.writeHead(200,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(catalog));return;
  }
  const route=/^\/api\/desktop-models\/([a-z][a-z0-9-]{0,63})\/chat\/completions$/.exec(path)?.[1];
  if(!route||req.method!=='POST'){fail(404,'模型接口不存在');return;}
  metadata=createModelRequestMetadata({clientId:req.headers?.['x-muse-client-request-id'],route,sink:usageLedger?record=>{try{(metadataSink??(value=>console.info('[muse-model-metadata]',JSON.stringify(value))))(record);}finally{void usageLedger.capture(session.id,record).catch(error=>{void error;console.error('[muse-usage] Response usage could not be saved');});}}:metadataSink,sensitiveTokens:[session.token]});
  res.setHeader('x-muse-server-request-id',metadata.serverRequestId);
  const controller=new AbortController(),item={accountId:session.id,controller};
  const items=active.get(session.token)??new Set();active.set(session.token,items);items.add(item);
  const abort=()=>controller.abort();req.on('aborted',abort);res.on('close',abort);
  const cancelExpiry=scheduleSessionExpiry(session.expiry,abort,{now});
  let lease,queueMs;
  try{
   let size=0;const chunks=[];for await(const chunk of req){size+=chunk.length;metadata.ingress(size);if(size>24*1024*1024){fail(413,'上下文过大');return;}chunks.push(chunk);}
   metadata.ingress(size,true);
   let body;try{body=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{fail(400,'请求格式错误');return;}
   if(!body||typeof body.model!=='string'||!Array.isArray(body.messages)){fail(400,'请选择 Muse 模型');return;}
   const isFlash=flashRouting?.matches(route,body.model);
   const flash=isFlash?flashRouting.resolve():undefined;
   if(isFlash&&!flash){fail(503,'DeepSeek Flash 线路暂不可用，请联系管理员检查配置');return;}
   let config=flash?.config??globalModels?.resolve(route,body.model);
   if(!globalModels&&route==='muse-shared'&&body.model==='muse-shared')config=modelConfig?.private();
   if(!config){fail(400,'模型已撤回或不属于此供应商，请刷新模型列表');return;}
   metadata.request(body.model);
   if(!flash&&!config.apiKey){fail(503,'管理员尚未配置该模型凭据');return;}
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
   if(flash)await flash.forward({req,accountId:session.id,body,res,signal:controller.signal,metadata,forward});
   else await forward({config,body,res,signal:controller.signal,queueMs,metadata});
  }catch(error){metadata.failed(controller.signal.aborted?'cancelled':'transport',error);if(error instanceof ModelKeyPoolError&&!controller.signal.aborted)fail(503,'模型请求正在排队，请稍后重试',{'retry-after':'1'});else fail(controller.signal.aborted?401:502,controller.signal.aborted?'Muse 登录已失效或请求已取消':'模型服务暂不可用，请稍后重试');}
  finally{metadata.finish(res.statusCode);lease?.release();cancelExpiry();req.off('aborted',abort);res.off('close',abort);items.delete(item);if(!items.size)active.delete(session.token);}
 }};
}

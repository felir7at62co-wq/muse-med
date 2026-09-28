// Vendor credentials stay in the gateway's private data directory, never in a tenant mount.
import http from 'node:http';
import https from 'node:https';
import {lookup} from 'node:dns';
import {isIP} from 'node:net';
import {createHmac,timingSafeEqual,randomBytes} from 'node:crypto';
import {readFile,writeFile,rename,mkdir,chmod} from 'node:fs/promises';
import {dirname} from 'node:path';
import {pipeline} from 'node:stream/promises';

export function publicIPv4(address){
 if(isIP(address)!==4)return false;
 const [a,b]=address.split('.').map(Number);
 return !(a===0||a===10||a===127||a>=224||a===169&&b===254||a===172&&b>=16&&b<=31||a===192&&(b===168||b===0||b===2)||a===100&&b>=64&&b<=127||a===198&&(b===18||b===19||b===51)||a===203&&b===0);
}
export function baseAddress(value){
 let url;try{url=new URL(value);}catch{throw Error('模型地址无效');}
 if(url.protocol!=='https:'||url.port&&url.port!=='443'||url.username||url.password||url.search||url.hash)throw Error('模型地址必须是无账号、参数的 HTTPS 443 地址');
 if(url.hostname==='localhost'||url.hostname.endsWith('.localhost')||url.hostname.includes(':')||isIP(url.hostname)&&!publicIPv4(url.hostname))throw Error('模型地址必须使用公网服务');
 return url.href.replace(/\/$/,'');
}
/**
 * Stored base URL is the API root, version segment included or not, so both
 * `https://host` and `https://host/v1` must land on the same completion path.
 * Missing `/v1` used to make providers answer a 307 that this relay never follows.
 */
export function completionEndpoint(baseURL){
 const url=new URL(baseAddress(baseURL));
 const path=url.pathname.replace(/\/+$/,'').replace(/\/chat\/completions$/,'');
 url.pathname=path.endsWith('/v1')||/\/v\d+$/.test(path)?path+'/chat/completions':path+'/v1/chat/completions';
 url.search='';url.hash='';
 return url;
}
export function accountToken(secret,id){return id+'.'+createHmac('sha256',secret).update(id).digest('hex');}
export async function openModelConfig(file){
 let current={revision:0,name:'编辑部统一模型',baseURL:'',model:'',apiKey:'',contextWindow:128000,maxTokens:8192};
 try{current=JSON.parse(await readFile(file,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
 let queue=Promise.resolve();
 return {private:()=>({...current}),view:()=>{const {apiKey,...safe}=current;return {...safe,keyConfigured:!!apiKey};},
 update:input=>{const task=queue.then(async()=>{
  if(Number(input.revision)!==current.revision)throw Error('配置已变化，请刷新后重试');
  const next={revision:current.revision+1,name:String(input.name||'编辑部统一模型').trim(),baseURL:baseAddress(input.baseURL),model:String(input.model||'').trim(),apiKey:input.apiKey?String(input.apiKey).trim():current.apiKey,contextWindow:Number(input.contextWindow),maxTokens:Number(input.maxTokens)};
  if(!next.name||next.name.length>80||!next.model||next.model.length>200||/[\r\n]/.test(next.model)||!next.apiKey||next.apiKey.length>4096||/[^\x21-\x7e]/.test(next.apiKey))throw Error('请填写有效的名称、模型 ID 和 API Key');
  if(!Number.isSafeInteger(next.contextWindow)||next.contextWindow<1024||next.contextWindow>2000000||!Number.isSafeInteger(next.maxTokens)||next.maxTokens<1||next.maxTokens>next.contextWindow)throw Error('上下文和输出上限无效');
  await mkdir(dirname(file),{recursive:true,mode:0o700});const tmp=file+'.'+randomBytes(8).toString('hex')+'.tmp';await writeFile(tmp,JSON.stringify(next),{mode:0o600});await chmod(tmp,0o600);await rename(tmp,file);current=next;
 });queue=task.catch(()=>{});return task;}};
}
export function publicLookup(host,options,callback){
 lookup(host,{family:4,all:true},(error,records)=>{
  if(error||!records?.length||records.some(row=>!publicIPv4(row.address))){callback(Error('模型地址必须解析到公网 IPv4'));return;}
  // Pin the actual socket to the validated answer, including all:true consumers.
  if(options?.all)callback(null,[records[0]]);else callback(null,records[0].address,4);
 });
}
async function forwardModel({config,body,res,signal}){
 const target=completionEndpoint(config.baseURL);
 await new Promise((resolve,reject)=>{
  const upstream=https.request(target,{method:'POST',lookup:publicLookup,signal,headers:{'content-type':'application/json',authorization:'Bearer '+config.apiKey,accept:body.stream?'text/event-stream':'application/json'}},response=>{
   if(response.statusCode<200||response.statusCode>=300){
    // Provider refusals (4xx) pass through unchanged; anything else is ours to explain.
    const detail=response.statusCode>=300&&response.statusCode<400?' 供应方要求跳转到 '+(response.headers.location||'未知地址')+'，说明「API 地址」填得不完整。':'';
    console.error('[muse-model-relay]',target.href,'->',response.statusCode,response.headers.location||'');
    response.resume();res.writeHead(response.statusCode>=400&&response.statusCode<500?response.statusCode:502,{'content-type':'application/json'});res.end(JSON.stringify({error:{message:'模型供应商拒绝请求，请联系管理员检查配置或额度。'+detail}}));resolve();return;}
   res.writeHead(200,{'content-type':body.stream?'text/event-stream; charset=utf-8':'application/json','cache-control':'no-store','x-accel-buffering':'no'});
   pipeline(response,res).then(resolve,reject);
  });
  upstream.setTimeout(300000,()=>upstream.destroy(Error('Upstream idle timeout')));
  upstream.on('error',reject);upstream.end(JSON.stringify(body));
 });
}
export function createModelRelay({config,globalModels,secret,accounts,forward=forwardModel}){
 const active=new Map();
 const changed=id=>{for(const controller of active.get(id)||[])controller.abort();};accounts.on('change',changed);
 const server=http.createServer(async(req,res)=>{
  const fail=(status,message)=>{if(res.headersSent){res.destroy();return;}res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify({error:{message}}));};
  let controllers,controller;
  try{
   const token=req.headers.authorization?.replace(/^Bearer /,''),id=token?.split('.')[0];
   if(!/^[a-f0-9]{16}\.[a-f0-9]{64}$/.test(token||'')||!timingSafeEqual(Buffer.from(token),Buffer.from(accountToken(secret,id)))||!accounts.get(id)||accounts.get(id).disabled){fail(401,'工作间认证失效');return;}
   let current=config?.private()||{};
   if(req.url==='/v1/muse-config'&&req.method==='GET'){
    res.setHeader('content-type','application/json');res.setHeader('cache-control','no-store');res.end(JSON.stringify({revision:current.revision,configured:!!current.apiKey,model:'muse-shared',name:current.name,contextWindow:current.contextWindow,maxTokens:current.maxTokens,...globalModels?.metadata()}));return;
   }
   const route=req.url.match(/^\/v1\/([a-z][a-z0-9-]{0,63})\/chat\/completions$/)?.[1];
   if((req.url!=='/v1/chat/completions'&&!route)||req.method!=='POST'){fail(404,'接口不存在');return;}
   controllers=active.get(id)||new Set();active.set(id,controllers);if(controllers.size>=4){fail(429,'模型请求过多，请稍后重试');return;}
   controller=new AbortController();controllers.add(controller);req.on('aborted',()=>controller.abort());res.on('close',()=>controller.abort());
   let size=0;const chunks=[];for await(const chunk of req){size+=chunk.length;if(size>24*1024*1024){fail(413,'上下文过大');return;}chunks.push(chunk);}
   let body;try{body=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{fail(400,'请求格式错误');return;}
   if(!body||typeof body.model!=='string'||!Array.isArray(body.messages)){fail(400,'请选择管理员配置的统一模型');return;}
   if(route){current=globalModels?.resolve(route,body.model);if(!current){fail(400,'请选择管理员配置的模型');return;}
    if(body.reasoning_effort!==undefined&&(!current.reasoningEfforts||!Object.values(current.reasoningEfforts).includes(body.reasoning_effort)||typeof body.reasoning_effort!=='string')){fail(400,'该模型不支持所选思考档位');return;}
   }else if(body.model!=='muse-shared'){fail(400,'请选择管理员配置的统一模型');return;}
   else if(globalModels){current=globalModels.resolve('muse-shared',current.model);if(!current){fail(400,'统一模型已撤回，请重新选择管理员配置的模型');return;}
    if(body.reasoning_effort!==undefined&&(!current.reasoningEfforts||!Object.values(current.reasoningEfforts).includes(body.reasoning_effort)||typeof body.reasoning_effort!=='string')){fail(400,'该模型不支持所选思考档位');return;}
   }
   if(!current.apiKey){fail(503,'管理员尚未配置模型凭据');return;}
   if(!accounts.get(id)||accounts.get(id).disabled){fail(401,'账户不可用');return;}
   body.model=current.model;
   if(current.thinking==='disabled'){body.thinking={type:'disabled'};delete body.reasoning_effort;}
   for(const key of ['max_tokens','max_completion_tokens'])if(body[key]!==undefined)body[key]=Math.min(Number(body[key])||current.maxTokens,current.maxTokens);
   if(body.max_tokens===undefined&&body.max_completion_tokens===undefined)body.max_tokens=current.maxTokens;
   await forward({config:current,body,res,signal:controller.signal});
  }catch(error){console.error('[muse-model-relay]','连接失败:',error?.message||error);fail(502,'模型服务连接失败，请联系管理员检查配置。');}
  finally{if(controller)controllers?.delete(controller);}
 });server.on('close',()=>{accounts.off('change',changed);for(const controllers of active.values())for(const controller of controllers)controller.abort();});return server;
}

// Environment-local, private model directory. Only explicit projections leave this module.
import {readFile,writeFile,rename,mkdir,chmod,unlink} from 'node:fs/promises';
import {dirname} from 'node:path';
import {randomBytes} from 'node:crypto';
import {baseAddress} from './model-relay.mjs';
import {officialValue,officialMetadata} from './official-model.mjs';
const own=(o,k)=>Object.hasOwn(o,k),plain=o=>o!==null&&typeof o==='object'&&!Array.isArray(o);
const banned=new Set(['__proto__','prototype','constructor']);
const refOK=r=>typeof r==='string'&&/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(r)&&!banned.has(r);
const text=(v,max=200)=>typeof v==='string'&&v.trim().length>0&&v.length<=max&&!/[\x00-\x1f]/.test(v);
const effortIds=['off','minimal','low','medium','high','xhigh','max'];
const providerFields=['displayName','baseURL','api','apiKeyEnv','models'],modelFields=['id','name','contextWindow','maxTokens','input','reasoningEfforts','defaultReasoningEffort'];
export function restrictModelSchema(source){
 const schema=structuredClone(source),node=value=>schema.refs?schema.refs[value]:value,root=schema.refs?node(schema.uid):schema,profile=node(node(root.dict?.providers)?.inner);
 if(!profile?.dict)throw Error('Unsupported native model schema');
 profile.dict=Object.fromEntries(Object.entries(profile.dict).filter(([key])=>providerFields.includes(key)));
 const api=node(profile.dict.api);if(api?.type!=='union'||!Array.isArray(api.list))throw Error('Unsupported native API schema');api.list=api.list.filter(ref=>node(ref).type==='const'&&node(ref).value==='openai-completions');if(api.list.length!==1)throw Error('Native schema does not support Chat Completions');
 const model=node(node(profile.dict.models)?.inner);if(!model?.dict)throw Error('Unsupported native model list schema');model.dict=Object.fromEntries(Object.entries(model.dict).filter(([key])=>modelFields.includes(key)));
 const add=value=>{if(!schema.refs)return value;const id=Math.max(...Object.keys(schema.refs).map(Number))+1;schema.refs[id]=value;return id;};
 model.dict.defaultReasoningEffort=add({type:'union',list:effortIds.filter(id=>id!=='off').map(value=>add({type:'const',value}))});return schema;
}
function reject(message,code='settings/rejected'){throw Object.assign(Error(message),{code});}
function validate(providers){
 if(!plain(providers)||Object.keys(providers).length>64)reject('供应商列表无效');
 for(const [route,p]of Object.entries(providers)){
  if(route.length>64||!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(route)||banned.has(route)||['muse-config','chat'].includes(route))reject('供应商标识无效');
  if(!plain(p)||Object.keys(p).some(k=>!providerFields.includes(k)))reject('供应商包含不支持的字段');
  if(p.displayName!==undefined&&!text(p.displayName,80))reject('显示名称无效');
  if(p.api!=='openai-completions')reject('当前仅支持 OpenAI Chat Completions');
  baseAddress(p.baseURL);if(p.apiKeyEnv!==undefined&&!refOK(p.apiKeyEnv))reject('请填写有效的凭据引用');
  if(!Array.isArray(p.models)||p.models.length>256)reject('请手动填写模型列表');const ids=new Set();
  for(const m of p.models){
   if(!plain(m)||Object.keys(m).some(k=>!modelFields.includes(k))||!text(m.id)||ids.has(m.id))reject('模型 ID 或字段无效');ids.add(m.id);
   if(m.name!==undefined&&!text(m.name))reject('模型名称无效');
   for(const key of ['contextWindow','maxTokens'])if(m[key]!==undefined&&(!Number.isSafeInteger(m[key])||m[key]<1||m[key]>2000000))reject('模型容量无效');
   if((m.maxTokens??8192)>(m.contextWindow??128000))reject('输出上限超过上下文容量');
   if(m.input!==undefined&&(!Array.isArray(m.input)||!m.input.length||m.input.some(x=>!['text','image'].includes(x))))reject('模型输入类型无效');
   const e=m.reasoningEfforts;if(e!==undefined&&e!==false&&(!plain(e)||!Object.keys(e).some(k=>k!=='off')||Object.entries(e).some(([k,v])=>!effortIds.includes(k)||!(k==='off'&&v===null||text(v,64)))))reject('思考档位无效');
   if(m.defaultReasoningEffort!==undefined&&(!effortIds.includes(m.defaultReasoningEffort)||m.defaultReasoningEffort==='off'||!plain(e)||!own(e,m.defaultReasoningEffort)||!text(e[m.defaultReasoningEffort],64)))reject('默认思考档位必须是模型已声明的启用档位');
  }
 }
}
export async function openGlobalModels(file,{legacyConfig,schema={type:'object'},official}={}){
 let current={version:2,revision:0,metadataRevision:0,providers:{},credentials:{}};
 async function save(next){await mkdir(dirname(file),{recursive:true,mode:0o700});const tmp=file+'.'+randomBytes(8).toString('hex')+'.tmp';try{await writeFile(tmp,JSON.stringify(next),{mode:0o600,flag:'wx'});await chmod(tmp,0o600);await rename(tmp,file);}finally{await unlink(tmp).catch(()=>{});}current=next;}
 try{current=JSON.parse(await readFile(file,'utf8'));if(current.version!==2||!Number.isSafeInteger(current.revision)||!Number.isSafeInteger(current.metadataRevision)||!plain(current.credentials))throw Error('Invalid global model file');validate(current.providers);}catch(e){if(e.code!=='ENOENT')throw e;const old=legacyConfig?.private();if(old?.apiKey&&old.model&&old.baseURL){current.providers={'muse-shared':{displayName:old.name,baseURL:old.baseURL,api:'openai-completions',apiKeyEnv:'MUSE_LEGACY_KEY',models:[{id:old.model,name:old.name,contextWindow:old.contextWindow,maxTokens:old.maxTokens,input:['text'],reasoningEfforts:false}]}};current.credentials={MUSE_LEGACY_KEY:old.apiKey};validate(current.providers);}await save(current);}
 let queue=Promise.resolve();const serial=fn=>{const task=queue.then(fn);queue=task.catch(()=>{});return task;};
 const view=()=>({ns:'llm-pi-ai',schema:structuredClone(schema),value:{providers:structuredClone(current.providers)},user:{providers:structuredClone(current.providers)},applies:'live',secrets:[],writable:true,revision:current.revision});
 if(official)officialValue(official,current.deepseek);
 const officialView=()=>({ns:'llm-deepseek',schema:structuredClone(official.schema),value:officialValue(official,current.deepseek),user:structuredClone(current.deepseek||{}),base:structuredClone(official.defaults),applies:'live',secrets:[],writable:true,revision:current.revision});
 const credential=ref=>{if(!refOK(ref))reject('凭据引用无效','gateway/bad-request');};
 return {view,describe:()=>({writable:true,hasDocument:false,namespaces:[view(),...official?[officialView()]:[]]}),
  listProviders:()=>[...official?[{id:'deepseek-official',name:'DeepSeek'}]:[],...Object.entries(current.providers).map(([id,p])=>({id,name:p.displayName||id}))],
  listConfigurableProviders:()=>[...official?[{provider:'deepseek-official',displayName:'DeepSeek',settingsNs:'llm-deepseek',settingsPath:[]}]:[],...Object.entries(current.providers).map(([provider,p])=>({provider,displayName:p.displayName||provider,settingsNs:'llm-pi-ai',settingsPath:['providers',provider],declared:true}))],
  metadata:()=>({revision:current.metadataRevision,...official?{deepseek:officialMetadata(official,current.deepseek)}:{},providers:Object.fromEntries(Object.entries(current.providers).map(([route,p])=>[route,{displayName:p.displayName||route,models:p.models.map(m=>({...structuredClone(m),name:m.name||m.id,contextWindow:m.contextWindow??128000,maxTokens:m.maxTokens??8192,input:m.input??['text'],reasoningEfforts:m.reasoningEfforts??false}))}]))}),
  resolve:(route,id)=>{if(official&&route==='deepseek-official'){const p=officialValue(official,current.deepseek),m=p.models.find(m=>m.id===id);return m?{baseURL:p.baseURL,apiKey:current.credentials[p.apiKeyEnv],model:m.id,maxTokens:m.maxTokens??p.maxTokens,thinking:p.thinking,reasoningEfforts:p.thinking==='disabled'?false:{low:'low',high:'high',max:'max'}}:undefined;}const p=own(current.providers,route)?current.providers[route]:undefined,m=p?.models.find(m=>m.id===id);return m?{baseURL:p.baseURL,apiKey:current.credentials[p.apiKeyEnv],model:m.id,maxTokens:m.maxTokens??8192,reasoningEfforts:structuredClone(m.reasoningEfforts??false),...m.defaultReasoningEffort===undefined?{}:{defaultReasoningEffort:m.defaultReasoningEffort}}:undefined;},
  mutate:args=>serial(async()=>{
   if(args.expectedRevision!==current.revision)reject('配置已变化，请刷新后重试','settings/conflict');
   if(args.ns==='llm-deepseek'&&official){
    if(!Array.isArray(args.ops)||args.ops.length>512)reject('配置操作无效');const next=structuredClone(current);next.deepseek??={};
    for(const op of args.ops){if(!plain(op)||!['set','unset'].includes(op.op)||!Array.isArray(op.path)||op.path.length!==1||typeof op.path[0]!=='string'||banned.has(op.path[0]))reject('配置路径无效');if(op.op==='set')next.deepseek[op.path[0]]=structuredClone(op.value);else delete next.deepseek[op.path[0]];}
    try{officialValue(official,next.deepseek);}catch(error){reject(error.message);}next.revision++;next.metadataRevision++;await save(next);return officialView();
   }
   if(args.ns!=='llm-pi-ai')reject('配置命名空间无效');
   if(!Array.isArray(args.ops)||args.ops.length>512)reject('配置操作无效');const next=structuredClone(current),root={providers:next.providers};
   for(const op of args.ops){if(!plain(op)||!['set','unset'].includes(op.op)||!Array.isArray(op.path)||op.path.length<1||op.path[0]!=='providers'||op.path.some(k=>typeof k!=='string'||banned.has(k)))reject('配置路径无效');let at=root;for(const key of op.path.slice(0,-1)){if(!own(at,key)){if(op.op==='unset'){at=null;break;}at[key]={};}if(!plain(at[key])&&!Array.isArray(at[key]))reject('配置路径无效');at=at[key];}if(at){const key=op.path.at(-1);if(op.op==='set')at[key]=structuredClone(op.value);else delete at[key];}}
   next.providers=root.providers??{};validate(next.providers);if(official&&own(next.providers,'deepseek-official'))reject('内置 DeepSeek 请使用其原生设置');for(const [route,p]of Object.entries(next.providers))p.apiKeyEnv??=route.toUpperCase().replace(/-/g,'_')+'_API_KEY';next.revision++;next.metadataRevision++;await save(next);return view();
  }),
  describeCredentials:refs=>{if(!Array.isArray(refs)||refs.length>64)reject('凭据列表无效','gateway/bad-request');return Object.fromEntries(refs.map(ref=>{credential(ref);const configured=own(current.credentials,ref);return [ref,{configured,writable:true,...configured?{source:'MUSE global'}:{}}];}));},
  setCredential:(ref,value)=>serial(async()=>{credential(ref);if(typeof value!=='string'||!value.length||value.length>4096||/[^\x21-\x7e]/.test(value))reject('凭据值无效','credential/rejected');const next=structuredClone(current);next.credentials[ref]=value;next.metadataRevision++;await save(next);}),
  unsetCredential:ref=>serial(async()=>{credential(ref);const next=structuredClone(current);delete next.credentials[ref];next.metadataRevision++;await save(next);})};
}

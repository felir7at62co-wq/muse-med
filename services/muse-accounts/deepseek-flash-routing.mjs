/** Private supplier selection for the public DeepSeek Flash model. */
import {createHash,randomBytes} from 'node:crypto';
import {readFile,stat,rename,unlink,writeFile} from 'node:fs/promises';
import {isAbsolute} from 'node:path';

const route='deepseek-flash-auto';
const model='deepseek-v4.1-flash';
const modelName='DeepSeek V4.1 Flash';
const suppliers=['jubian','bailian'];
const sessionHeader='x-muse-model-session';
const modelSession=/^[0-9a-f]{64}$/;
const maxAffinityEntries=65536;
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const flashModelId=/^(?:[^/]+\/)*deepseek(?:-v4(?:[.-]1)?)?-flash(?:[.-][0-9]+)?$/i;
const sameRef=(a,b)=>a.provider===b.provider&&a.model===b.model;

function refValid(ref){
 return object(ref)&&Object.keys(ref).length===2&&typeof ref.provider==='string'
  &&/^[a-z][a-z0-9-]{0,63}$/.test(ref.provider)&&ref.provider!==route
  &&typeof ref.model==='string'&&/^[a-z0-9][a-z0-9._:/@+-]{0,199}$/i.test(ref.model);
}

function privateConfig(config){
 if(!object(config)||Object.keys(config).some(key=>!['jubian','bailian','hide'].includes(key))
  ||!suppliers.every(name=>refValid(config[name]))||config.jubian.provider===config.bailian.provider
  ||config.hide!==undefined&&(!Array.isArray(config.hide)||config.hide.length>64||!config.hide.every(ref=>refValid(ref)&&flashModelId.test(ref.model)))){
  throw Error('Invalid DeepSeek Flash routing config: expected distinct jubian and bailian model references and optional Flash alias hide references');
 }
 return config;
}

function supplierConfig(name,settings){
 if(typeof settings?.apiKey!=='string'||!settings.apiKey.length)return false;
 const url=new URL(settings.baseURL);
 if(name==='jubian')return url.origin==='https://gw.jubianai.net'&&settings.model===model;
 return (url.origin==='https://dashscope.aliyuncs.com'||/^https:\/\/[a-z0-9-]+\.[a-z0-9-]+\.maas\.aliyuncs\.com$/.test(url.origin))
  &&url.pathname.replace(/\/$/,'')==='/compatible-mode/v1'
  &&settings.model==='deepseek-v4.1-flash-1017';
}

function advertisedSource(ref,metadata){
 if(ref.provider==='deepseek-official'&&metadata.deepseek){
  const native=metadata.deepseek;
  const source=native.models.find(item=>item.id===ref.model);
  if(source)return {...source,contextWindow:source.contextWindow??native.defaultContextWindow,maxTokens:source.maxTokens??native.maxTokens,
   input:source.inputModalities??['text'],reasoningEfforts:native.thinking==='disabled'?false:{off:null,high:'high'}};
 }
 return metadata.providers?.[ref.provider]?.models.find(item=>item.id===ref.model);
}

function publicModel([jubian,bailian]){
 // The Bailian 1017 snapshot exposes a thinking toggle, so publish one shared enabled setting.
 const jEffort=jubian.reasoningEfforts?.high,bEffort=bailian.reasoningEfforts?.high;
 const reasoningEfforts=typeof jEffort==='string'&&typeof bEffort==='string'
  ?{...(jubian.reasoningEfforts.off===null&&bailian.reasoningEfforts.off===null?{off:null}:{}),high:'high'}:false;
 const defaultReasoningEffort=reasoningEfforts&&jubian.defaultReasoningEffort==='high'&&bailian.defaultReasoningEffort==='high'
  ?'high':undefined;
 return {id:model,name:modelName,contextWindow:Math.min(jubian.contextWindow,bailian.contextWindow),
  maxTokens:Math.min(jubian.maxTokens,bailian.maxTokens),input:jubian.input.filter(value=>bailian.input.includes(value)),
  reasoningEfforts,...defaultReasoningEffort?{defaultReasoningEffort}:{}};
}

function supplierBody(name,body,config){
 const {thinking,enable_thinking:unused,reasoning_effort,...rest}=body;
 // Bailian's 1017 Chat Completions uses enable_thinking, while Jubian accepts native DeepSeek fields.
 const enabled=thinking?.type==='enabled'||reasoning_effort!==undefined&&thinking?.type!=='disabled';
 const disabled=thinking?.type==='disabled';
 return {...rest,model:config.model,
  ...name==='bailian'?enabled||disabled?{enable_thinking:enabled}:{}:{
   ...(enabled||disabled?{thinking:{type:enabled?'enabled':'disabled'}}:{}),
   ...(enabled&&reasoning_effort!==undefined?{reasoning_effort:config.reasoningEfforts.high}:{}),
  }};
}

function affinityKey(accountId,header){
 const session=typeof header==='string'&&modelSession.test(header)?header:'';
 return createHash('sha256').update(accountId).update('\0').update(session).digest('hex');
}
const byHash=key=>suppliers[Number.parseInt(key[0],16)%2];

async function readAffinity(file){
 try{
  const entry=await stat(file);
  if(!entry.isFile()||entry.size>maxAffinityEntries*90||process.platform!=='win32'&&(entry.mode&0o077)!==0)throw Error('Invalid private DeepSeek Flash affinity file');
  const stored=JSON.parse(await readFile(file,'utf8'));
  if(!object(stored)||stored.version!==1||!Array.isArray(stored.entries)||stored.entries.length>maxAffinityEntries
   ||stored.entries.some(row=>!Array.isArray(row)||row.length!==2||typeof row[0]!=='string'||!modelSession.test(row[0])||!suppliers.includes(row[1])))throw Error('Invalid DeepSeek Flash affinity entries');
  const entries=new Map(stored.entries.map(([key,supplier])=>[key,{supplier}]));
  if(entries.size!==stored.entries.length)throw Error('Duplicate DeepSeek Flash affinity entries');
  return entries;
 }catch(error){if(error.code==='ENOENT')return new Map();throw error;}
}

function createAffinity(file,entries){
 let saving=Promise.resolve(),version=0,saved=0;
 async function save(){
  while(saved<version){
   const revision=version;
   const tmp=file+'.'+randomBytes(8).toString('hex')+'.tmp';
   try{
    await writeFile(tmp,JSON.stringify({version:1,entries:[...entries].map(([key,entry])=>[key,entry.supplier])}),{mode:0o600,flag:'wx'});
    await rename(tmp,file);
    saved=revision;
   }finally{
    await unlink(tmp).catch(error=>{if(error.code!=='ENOENT')throw error;});
   }
  }
 }
 function flush(){
  saving=saving.catch(error=>{void error;}).then(save);
  return saving;
 }
 return {get:key=>entries.get(key),remember(key,previous,supplier){
  if(entries.get(key)!==previous)return;
  entries.delete(key);
  entries.set(key,{supplier});
  if(entries.size>maxAffinityEntries)entries.delete(entries.keys().next().value);
  version++;
  void flush().catch(error=>{void error;console.error('[muse-model-relay] DeepSeek Flash affinity could not be saved');});
 },flush};
}

/** Open a gateway-local route backed by two private native model settings.
 * Without a config file the route is absent and `deepseek-official` keeps its configured single supplier.
 * @param {object} options Opt-in absolute config file (`MUSE_DEEPSEEK_FLASH_ROUTING`), private affinity file, and current global model directory.
 * @returns {Promise<object|undefined>} Catalog projection and forwarding operations, or undefined when disabled.
 * @throws {Error} The config path, the configured model or its private supplier settings are missing or invalid.
 */
export async function openDeepSeekFlashRouting({configFile,affinityFile,globalModels}){
 if(configFile===undefined)return;
 if(typeof configFile!=='string'||!isAbsolute(configFile))throw Error('MUSE_DEEPSEEK_FLASH_ROUTING must be the absolute path of the DeepSeek Flash routing JSON file; remove it to keep deepseek-official on its single supplier');
 if(!affinityFile||!globalModels)throw Error('DeepSeek Flash routing requires a config file, affinity file, and native model directory');
 let stored;try{stored=JSON.parse(await readFile(configFile,'utf8'));}catch(error){if(error instanceof SyntaxError)throw Error('Invalid DeepSeek Flash routing config: the file is not JSON');throw error;}
 const config=privateConfig(stored);
 const hidden=[config.jubian,config.bailian,...config.hide??[]];
 function resolve(metadata=globalModels.metadata()){
  if(Object.hasOwn(metadata.providers??{},route))return;
  const settings=suppliers.map(name=>globalModels.resolve(config[name].provider,config[name].model));
  if(!suppliers.every((name,index)=>supplierConfig(name,settings[index]))||settings[0].apiKey===settings[1].apiKey)return;
  const advertised=suppliers.map(name=>advertisedSource(config[name],metadata));
  if(advertised.some(item=>!item))return;
  const spec=publicModel(advertised);
  if(!spec.input.includes('text'))return;
  return {spec,settings};
 }
 if(!resolve())throw Error('DeepSeek Flash routing requires configured Jubian and Bailian Flash models on their own verified origins, distinct keys, and a reserved public route');
 const affinity=createAffinity(affinityFile,await readAffinity(affinityFile));
 return {
  matches:(provider,id)=>provider===route&&id===model,
  /** Publish the shared entry when both sources resolve in the private directory.
   * @param {object} metadata Private directory metadata that resolves both sources.
   * @param {object} [target] Published projection of that directory; sources and hide references leave it and the shared entry joins it.
   * @returns {object} The projected target, unchanged when the entry is unavailable.
   */
  catalog(metadata,target=metadata){
   const current=resolve(metadata);
   if(!current)return target;
   const providers=Object.fromEntries(Object.entries(target.providers??{}).flatMap(([provider,item])=>{
    const models=item.models.filter(entry=>!hidden.some(ref=>sameRef(ref,{provider,model:entry.id})));
    return models.length||!item.models.length?[[provider,{...item,models}]]:[];
   }));
   const deepseek=target.deepseek&&{...target.deepseek,
    models:target.deepseek.models.filter(entry=>!hidden.some(ref=>sameRef(ref,{provider:'deepseek-official',model:entry.id})))};
   const {deepseek:unused,...rest}=target;
   return {...rest,...deepseek?.models.length?{deepseek}:{},
    providers:{...providers,[route]:{displayName:'DeepSeek',models:[current.spec]}}};
  },
  resolve(){
   const current=resolve();
   if(!current)return;
   return {config:{...current.spec,model},async forward({req,accountId,body,res,signal,metadata,forward}){
    const key=affinityKey(accountId,req.headers?.[sessionHeader]);
    const previous=affinity.get(key),first=previous?.supplier??byHash(key);
    const second=suppliers.find(name=>name!==first);
    const attempt=(name,options)=>{
     const config=current.settings[suppliers.indexOf(name)];
     metadata?.supplier(name);
     return forward({config,body:supplierBody(name,body,config),res,signal,metadata,...options});
    };
    signal.throwIfAborted();
    const failure=await attempt(first,{allowSupplierFailover:true});
    if(!failure?.retryable||res.headersSent)return;
    signal.throwIfAborted();
    metadata?.supplierFailover(failure.retryable);
    await attempt(second,{onAccepted:()=>affinity.remember(key,previous,second)});
   }};
  },
  flush:()=>affinity.flush(),
 };
}

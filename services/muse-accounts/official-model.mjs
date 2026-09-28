// Native DeepSeek settings facade. Vendor secrets and endpoints stay in gateway.
import {baseAddress} from './model-relay.mjs';
const plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const fields=new Set(['baseURL','apiKeyEnv','protocol','models','maxTokens','defaultContextWindow','thinking','reasoningEffort']);
const modelFields=new Set(['id','name','description','contextWindow','maxTokens','inputModalities','imagePixelBudget','imageMaxBytes','systemPromptUpdate']);
export function officialValue(definition,user={}){
 if(!plain(user)||Object.keys(user).some(key=>!fields.has(key)))throw Error('不支持的 DeepSeek 配置字段');
 const value={...structuredClone(definition.defaults),...structuredClone(user)};
 if(value.protocol!=='chat-completions')throw Error('共享 DeepSeek 当前使用 Chat Completions');
 baseAddress(value.baseURL);
 if(!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(value.apiKeyEnv)||['MUSE_MODEL_PROXY_TOKEN','constructor','prototype','__proto__'].includes(value.apiKeyEnv))throw Error('凭据引用无效');
 for(const key of ['maxTokens','defaultContextWindow'])if(!Number.isSafeInteger(value[key])||value[key]<1||value[key]>2000000)throw Error('模型容量无效');
 if(value.thinking!==undefined&&!['enabled','disabled'].includes(value.thinking)||value.reasoningEffort!==undefined&&!['off','low','high','max'].includes(value.reasoningEffort))throw Error('思考档位无效');
 if(value.thinking==='disabled'&&value.reasoningEffort!==undefined&&value.reasoningEffort!=='off')throw Error('已禁用思考');
 if(!Array.isArray(value.models)||value.models.length>256)throw Error('模型列表无效');const ids=new Set();
 for(const model of value.models){
  if(!plain(model)||Object.keys(model).some(key=>!modelFields.has(key))||typeof model.id!=='string'||!model.id.trim()||model.id.length>200||/[\x00-\x1f]/.test(model.id)||ids.has(model.id))throw Error('模型 ID 或字段无效');ids.add(model.id);
  for(const key of ['name','description'])if(model[key]!==undefined&&(typeof model[key]!=='string'||!model[key].trim()||model[key].length>2000))throw Error('模型名称无效');
  for(const key of ['maxTokens','contextWindow','imageMaxBytes'])if(model[key]!==undefined&&(!Number.isSafeInteger(model[key])||model[key]<1||model[key]>200000000))throw Error('模型容量无效');
  if((model.maxTokens??value.maxTokens)>(model.contextWindow??value.defaultContextWindow))throw Error('输出上限超过上下文容量');
  if(model.inputModalities!==undefined&&(!Array.isArray(model.inputModalities)||!model.inputModalities.length||model.inputModalities.some(x=>!['text','image'].includes(x))))throw Error('输入类型无效');
  if(model.systemPromptUpdate!==undefined&&model.systemPromptUpdate!=='in-history')throw Error('模型字段无效');
  if(model.imagePixelBudget!==undefined&&model.imagePixelBudget!=='low'&&(!Number.isSafeInteger(model.imagePixelBudget)||model.imagePixelBudget<1))throw Error('图片容量无效');
 }
 definition.validate?.(value);return value;
}
export function officialMetadata(definition,user){const {baseURL,apiKeyEnv,...safe}=officialValue(definition,user);return safe;}

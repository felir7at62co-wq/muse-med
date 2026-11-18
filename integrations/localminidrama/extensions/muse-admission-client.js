/** Stable request identities and readonly reconciliation for native paid studio operations. */
import catalog from './museAdmissionCatalog.json'
import {museStudioPath} from './museStudioPath'
const secretKey=/^(?:operation_id|api[_-]?key|access[_-]?(?:key|token)|bearer[_-]?token|authorization|password|secret(?:[_-]?key)?|credentials|cookies?)$/i
const hash=async value=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',typeof value==='string'?new TextEncoder().encode(value):value))].map(value=>value.toString(16).padStart(2,'0')).join('')
function canonical(value){if(Array.isArray(value))return value.map(item=>canonical(item??null));if(value&&typeof value==='object'){const output=Object.create(null);for(const key of Object.keys(value).sort())if(!secretKey.test(key)&&value[key]!==undefined)output[key]=canonical(value[key]);return output;}return value}
function pathOf(value){const text=String(value||''),marker=text.indexOf('/api/v1/'),path=marker>=0?text.slice(marker+7):text;return decodeURIComponent(path.split('?')[0]).replace(/\/+$/,'').toLowerCase()||'/'}
export async function museAdmissionApi(path,options={}){const response=await fetch(museStudioPath('/api/v1/muse/admission'+path),{credentials:'same-origin',...options,headers:{'Content-Type':'application/json',...options.headers}});let json;try{json=await response.json()}catch(error){throw Error('提交记录响应未确认，请重试读取，不要直接重新生成。')}if(!response.ok||json.success===false)throw Object.assign(Error(json.error?.message||'提交记录操作未确认'),{operation_id:json.error?.operation_id});return json.data}
async function descriptor(path,body){let file=null;if(body instanceof FormData){const fields={};for(const[key,value]of body){if(value instanceof Blob){if(key!=='file'||file)throw Error('无法保留上传请求标识');file={sha256:await hash(await value.arrayBuffer()),sizeBytes:value.size}}else{if(Object.hasOwn(fields,key))throw Error('无法保留重复表单字段');fields[key]=value}}body=fields}return {method:'POST',path,body:body??{},file}}
const cacheKey=(databaseId,fingerprint)=>'muse-admission:'+databaseId+':'+fingerprint
export function rememberMuseAdmission(databaseId,fingerprint,id){const key=cacheKey(databaseId,fingerprint);localStorage.setItem(key,id);if(localStorage.getItem(key)!==id)throw Error('无法保存提交标识，已停止生成请求。')}
/** Match exactly the backend catalog and retain an ID before dispatch; local cache loss reconciles by server fingerprint. */
export async function prepareMuseAdmission(url,method,body){
 if(String(method||'get').toUpperCase()!=='POST')return {}
 const path=pathOf(url),route=catalog.find(item=>new RegExp(item.pattern).test(path));if(!route)return {}
 if(route.kind==='connection-test'){const service=String(body?.service_type||'').toLowerCase(),model=Array.isArray(body?.model)?body.model[0]:body?.model;if(route.configuration_only_services.includes(service)||!service&&new RegExp(route.configuration_only_model_pattern,'i').test(String(model??'')))return {}}
 const spec=await descriptor(path,body);if(route.kind==='novel'&&spec.body.ai_summarize!==true&&spec.body.ai_summarize!=='true')return {}
 const capabilities=await museAdmissionApi('/capabilities');if(!capabilities||typeof capabilities.database_id!=='string')throw Error('无法核对生成平台身份，已停止提交。')
 const fingerprint=await hash(JSON.stringify(canonical(spec))),key=cacheKey(capabilities.database_id,fingerprint),stored=localStorage.getItem(key)
 const existing=await museAdmissionApi('/lookup?request_sha256='+fingerprint),id=existing.item?.operation_id||stored||crypto.randomUUID()
 rememberMuseAdmission(capabilities.database_id,fingerprint,id)
 return {'x-muse-operation-id':id}
}
/** Grant another version only through an explicit action against the preceding terminal operation. */
export async function permitMuseAdmissionVersion(databaseId,item){const key='muse-admission-permit:'+databaseId+':'+item.operation_id;let id=localStorage.getItem(key);if(!id){id=crypto.randomUUID();localStorage.setItem(key,id);if(localStorage.getItem(key)!==id)throw Error('无法保存新版本许可，已停止操作。')}const granted=await museAdmissionApi('/'+encodeURIComponent(item.operation_id)+'/next-version',{method:'POST',body:JSON.stringify({operation_id:id})});rememberMuseAdmission(databaseId,item.request_sha256,granted.operation_id);return granted}

/** Budget project context and owner actions; supplier credentials never enter budget requests. */
import catalog from './museAdmissionCatalog.json'
import {museStudioPath} from './museStudioPath'
let currentProject=0
export function setMuseBudgetProject(value){currentProject=Number.isSafeInteger(value)&&value>0?value:0}
export function museBudgetConnectionIsPaid(value){const route=catalog.find(item=>item.kind==='connection-test'),service=String(value?.service_type||'').toLowerCase(),model=Array.isArray(value?.model)?value.model[0]:value?.model;return !route.configuration_only_services.includes(service)&&!(!service&&new RegExp(route.configuration_only_model_pattern,'i').test(String(model??'')))}
export function withMuseBudgetProject(config){
 if(!currentProject||String(config.method||'get').toUpperCase()!=='POST')return config
 const text=String(config.url||''),marker=text.indexOf('/api/v1/'),path=(marker>=0?text.slice(marker+7):text).split('?')[0]
 if(!catalog.some(row=>new RegExp(row.pattern).test(path)))return config
 if(config.data instanceof FormData){if(!['drama_id','project_id','budget_project_id'].some(key=>config.data.has(key)))config.data.set('budget_project_id',String(currentProject))}
 else if(config.data===undefined||config.data===null||typeof config.data==='object'&&!Array.isArray(config.data)){if(!['drama_id','project_id','budget_project_id'].some(key=>config.data?.[key]!==undefined))config.data={...config.data,budget_project_id:currentProject}}
 return config
}
const messages={budget_currency_changed:'此项目的计价单位已锁定，请刷新后使用原单位；不同币种不自动换算',budget_credit_provider_required:'LibTV 积分只可用于 libtv-cli；其他服务需单独的货币预算',budget_limit_required:'请先保存本项目预算上限',budget_price_unknown:'当前实际模型没有有效价格；先填写本账户的预占估价与来源',budget_price_ambiguous:'同一模型存在多份有效价格，请让其中一份过期后再提交',budget_estimate_not_authorized:'本项目尚未接受估价风险，请在预算中明确选择',budget_task_envelope_not_authorized:'整任务费用不可验证，当前严格预算拒绝提交；须明确接受任务预占风险',budget_limit_exceeded:'余额不足，未发起新的付费提交',budget_revision_conflict:'内容已变化，请刷新后重新核对',budget_outcome_unknown:'原任务结果未知，预占继续保留，不能核销或按零释放',budget_limit_below_commitments:'预算不能低于已核销费用与全部未结预占之和',budget_invoice_confirmation_required:'请明确填写最终账单金额与核对依据',budget_price_configuration_locked:'价格由部署管理员管理，当前账号不能修改',budget_operation_requires_reconciliation:'这笔预占已存在，请查询原任务，不要重新派发',budget_invalid_price:'请填写有效的模型、金额、生效与过期时间'}
export async function museBudgetApi(path,options={}){
 const response=await fetch(museStudioPath('/api/v1/muse/budget'+path),{credentials:'same-origin',...options,headers:{'Content-Type':'application/json',...options.headers}})
 let value;try{value=await response.json()}catch(error){throw Error('预算响应无法确认，请只刷新查询，不要重复提交付费请求')}
 if(!response.ok||value.success===false)throw Object.assign(Error(messages[value.error?.code]||'预算操作未确认，请刷新账目核对'),{code:value.error?.code,status:response.status})
 return value.data
}
export function moneyMinor(text){const match=/^(\d+)(?:\.(\d{1,2}))?$/.exec(String(text).trim());if(!match)throw Error('金额须为非负数，最多两位小数');const value=Number(match[1])*100+Number((match[2]||'').padEnd(2,'0'));if(!Number.isSafeInteger(value))throw Error('金额超出支持范围');return value}
export function moneyText(value){return value===null||value===undefined?'未设置/未知':(value/100).toFixed(2)}
export function budgetCurrencyLabel(currency){return currency==='LTV'?'LibTV 积分':currency}
export function budgetPriceCurrencyAllowed(currency,provider,service){return currency!=='LTV'||provider==='libtv-cli'&&['text','image','video','agent-task'].includes(service)}

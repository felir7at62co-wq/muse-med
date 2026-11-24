<template>
  <section class="muse-budget">
    <el-alert type="warning" :closable="false" title="预算按明确接受的估价控制本地提交，不代表供应商最终账单或上游消费硬上限。未知结果持续预占，失败不自动视为退款。" />
    <el-alert v-if="notice" type="error" :closable="false" :title="notice" />
    <p v-if="loading">正在读取本项目预算与账目…</p>
    <template v-if="project">
      <p>项目 {{ project.project_id }} · {{ budgetCurrencyLabel(project.currency) }} · 上限 {{ moneyText(project.limit_minor) }} · 已人工核销 {{ moneyText(project.settled_minor) }} · 未结预占 {{ moneyText(project.reserved_minor) }} · 可用 {{ moneyText(project.available_minor) }} · 未知预占 {{ project.unknown_reservations }} 笔</p>
      <el-alert v-if="project.over_limit" type="error" :closable="false" title="最终核销已超过预算，已阻止新增提交；原账目保留，请核对供应商账单" />
      <el-form label-position="top" @submit.prevent="saveBudget">
        <el-form-item label="预算计价单位"><el-select v-model="currency" aria-label="预算计价单位" :disabled="project.revision > 0"><el-option :value="prices?.currency || 'CNY'" :label="prices?.currency || 'CNY'" /><el-option v-if="prices?.currency !== 'LTV'" value="LTV" label="LibTV 积分" /></el-select></el-form-item>
        <p v-if="currency === 'LTV'">填写 LibTV 积分数量，例如 100 表示 100 积分。仅用于 LibTV CLI，不与人民币换算，也不代表供应商余额或消费硬上限。</p>
        <el-form-item :label="currency === 'LTV' ? '本项目总预算（LibTV 积分）' : '本项目总预算（金额，非 Token；人工核销可记录已发生的超额费用）'"><el-input v-model="limitText" inputmode="decimal" /></el-form-item>
        <el-checkbox v-model="allowEstimates">我接受按模型预估金额预占；实际收费可能更高，且未结预占不会自动释放</el-checkbox>
        <el-checkbox v-model="allowTasks">我明确接受整 Agent 任务预占风险：无法限制 LibTV 等上游任务的最终消费，也不能由结果列表认定任务已结束</el-checkbox>
        <el-button native-type="submit" :disabled="busy || loading">明确保存本项目预算授权</el-button>
      </el-form>
    </template>
    <el-collapse v-if="prices">
      <el-collapse-item title="模型能力、价格来源与本账户估价设置" name="prices">
        <p>缺少有效价格时停止付费生成，不按免费处理。以下能力与价格来自明确配置，不表示供应商已验证；不同币种不自动换算。</p>
        <article v-for="price in visiblePrices" :key="price.configured_by + price.id" class="budget-row">
          <p>{{ price.service }} · {{ price.provider }} / {{ price.model }} · {{ budgetCurrencyLabel(price.currency) }} {{ moneyText(price.reserve_minor) }} / {{ price.estimate_kind === 'operator-task-envelope' ? '整个 Agent 任务预占额（并非单镜费）' : '本地一次派发估价' }} · {{ price.active ? '有效' : '未生效或已过期' }}</p>
          <small>来源 {{ price.source }} · {{ price.configured_by }} · {{ price.effective_at }} 至 {{ price.expires_at }} · {{ price.origin }}</small>
          <p>时长上限 {{ price.capabilities.maxDurationSeconds ?? '未知' }} · 参考图上限 {{ price.capabilities.maxReferenceImages ?? '未知' }} · 分辨率 {{ price.capabilities.resolutions.join('、') || '未知' }} · 多声线 {{ price.capabilities.supportsMultiVoice === null ? '未知' : price.capabilities.supportsMultiVoice ? '配置支持' : '配置不支持' }}</p>
          <el-button v-if="price.configured_by === 'studio-owner' && prices.owner_prices_allowed" :disabled="busy" @click="editPrice(price)">编辑这份估价</el-button>
        </article>
        <el-form v-if="prices.owner_prices_allowed" label-position="top" @submit.prevent="savePrice">
          <el-form-item label="可选：从本人已配置的 API 填写模型资料（不读取密钥）"><el-select v-model="selectedConfig" clearable @change="selectConfig"><el-option v-for="config in availableConfigs" :key="config.id" :value="config.id" :label="config.name + ' · ' + config.service + ' · ' + config.provider" /></el-select></el-form-item>
          <div class="budget-grid">
            <el-input v-model="editing.id" placeholder="本账户价格标识，如 seedance-video" />
            <el-select v-model="editing.service"><el-option v-for="service in services" :key="service" :value="service" :label="service" /></el-select>
            <el-input v-model="editing.provider" :disabled="currency === 'LTV'" placeholder="实际 provider，须与 API 配置完全相同" />
            <el-input v-model="editing.model" placeholder="实际 model，须与派发值完全相同" />
            <el-input v-model="editing.origin" placeholder="实际 API Origin，如 https://api.example.com" />
            <el-input v-model="reserveText" inputmode="decimal" :placeholder="currency === 'LTV' ? '每次派发/整任务的预占积分' : '每次派发/整任务的预占金额'" />
            <el-input v-model="editing.source" placeholder="公开价格页 HTTPS 地址，或 operator-entered" />
            <el-input v-model="editing.effective_at" placeholder="生效 ISO UTC 时间" />
            <el-input v-model="editing.expires_at" placeholder="过期 ISO UTC 时间" />
            <el-input v-model="inputRate" inputmode="decimal" placeholder="可选：每百万输入 Token 金额" />
            <el-input v-model="outputRate" inputmode="decimal" placeholder="可选：每百万输出 Token 金额" />
            <el-input v-model="totalRate" inputmode="decimal" placeholder="可选：每百万总 Token 金额（优先于输入输出）" />
            <el-input v-model="characterRate" inputmode="decimal" placeholder="可选：TTS 每千请求字符金额" />
            <el-input v-model="durationLimit" inputmode="decimal" placeholder="可选：已确认模型时长上限（秒）" />
            <el-input v-model="referenceLimit" inputmode="numeric" placeholder="可选：已确认参考图上限" />
            <el-input v-model="resolutions" placeholder="可选：已确认分辨率，用英文逗号分隔" />
            <el-select v-model="multiVoice"><el-option value="unknown" label="多声线能力未知" /><el-option value="yes" label="配置支持多声线" /><el-option value="no" label="配置不支持多声线" /></el-select>
          </div>
          <p>预占单位 {{ budgetCurrencyLabel(currency) }}；Agent 任务只能使用整任务风险预占，不能伪装成一张图或一条视频的固定价格。</p>
          <el-checkbox v-model="priceAccepted">这是我明确接受的本账户估价与有效期，不是供应商核验后的账单</el-checkbox>
          <el-button native-type="submit" :disabled="busy || !priceAccepted">保存本账户估价</el-button>
        </el-form>
      </el-collapse-item>
    </el-collapse>
    <div><el-button :disabled="busy || loading" @click="load()">刷新预算与账目</el-button><el-button v-if="next" :disabled="busy || loading" @click="load(next)">下一页账目</el-button></div>
    <p v-if="project && !entries.length && !loading">本项目尚无预算预占记录；此前未接入账本的历史费用不视为零。</p>
    <article v-for="entry in entries" :key="entry.entry_id" class="budget-row">
      <p>{{ entry.source }} · {{ entry.profile.provider }} / {{ entry.profile.model }} · {{ outcomes[entry.outcome] || entry.outcome }} · {{ budgetCurrencyLabel(entry.profile.currency) }} 预占 {{ moneyText(entry.reserved_minor) }} · 人工核销 {{ moneyText(entry.settled_minor) }}</p>
      <small>原操作 {{ entry.parent_operation_id || entry.operation_id }} · {{ entry.created_at }} · 价格来源 {{ entry.profile.source }}（{{ entry.profile.effective_at }} 至 {{ entry.profile.expires_at }}）</small>
      <p>按已回报用量与配置费率推算 {{ moneyText(entry.usage_estimate_minor) }}；这是估计，不是账单，不自动核销或释放预占</p>
      <p v-if="entry.invoice">核对依据 {{ entry.invoice.reference }} · {{ entry.invoice.confirmed_at }} · 人工确认，非供应商自动核验</p>
      <el-button v-if="entry.settled_minor === null && ['completed','failed','operator-confirmed'].includes(entry.outcome)" :disabled="busy" @click="openInvoice(entry)">按最终供应商账单人工核销</el-button>
      <p v-else-if="entry.settled_minor === null">结果尚未确认，预占保留；请通过原任务查询或恢复，不能按零释放或换标识重发。</p>
    </article>
    <el-dialog v-model="invoiceVisible" title="人工核销最终账单" width="min(560px, 92vw)" append-to-body :close-on-click-modal="false">
      <p>核销会改变本项目可用额度。只填写已核对的最终收费，零元也须有明确未收费依据；平台不会把人工输入标为供应商已验证。LibTV 的人工结束不保证上游停止消费。</p>
      <el-input v-model="invoiceAmount" inputmode="decimal" :placeholder="invoiceEntry?.profile.currency === 'LTV' ? '最终消耗积分' : '最终费用金额'" />
      <el-input v-model="invoiceReference" maxlength="512" placeholder="账单/订单核对依据，不填密码或密钥" />
      <el-checkbox v-model="invoiceAccepted">我已核对最终账单，明确确认此金额与依据</el-checkbox>
      <el-button :disabled="busy || !invoiceAccepted" @click="saveInvoice">明确核销并保留原预占记录</el-button>
    </el-dialog>
  </section>
</template>
<script setup>
import {computed,onBeforeUnmount,onMounted,reactive,ref,watch} from 'vue'
import {museBudgetApi,moneyMinor,moneyText,budgetCurrencyLabel,budgetPriceCurrencyAllowed} from '@/utils/museBudget'
const props=defineProps({projectId:{type:Number,required:true}})
const currency=ref('CNY')
const project=ref(null),prices=ref(null),entries=ref([]),next=ref(null),notice=ref(''),loading=ref(false),busy=ref(false),limitText=ref(''),allowEstimates=ref(false),allowTasks=ref(false)
const selectedConfig=ref(null),reserveText=ref(''),priceAccepted=ref(false),editing=reactive({id:'',service:'video',provider:'',model:'',origin:'',config_id:null,source:'operator-entered',effective_at:new Date().toISOString(),expires_at:'',expected_revision:0,rates:{},capabilities:{}})
const inputRate=ref(''),outputRate=ref(''),totalRate=ref(''),characterRate=ref(''),durationLimit=ref(''),referenceLimit=ref(''),resolutions=ref(''),multiVoice=ref('unknown')
const services=computed(()=>currency.value==='LTV'?['text','image','video','agent-task']:['text','image','video','tts','postproduction','agent-task'])
const visiblePrices=computed(()=>(prices.value?.items||[]).filter(price=>price.currency===currency.value))
const availableConfigs=computed(()=>(prices.value?.configs||[]).filter(config=>budgetPriceCurrencyAllowed(currency.value,config.provider,config.service)))
const outcomes={reserved:'已预占',accepted:'原任务已受理',completed:'原任务完成（费用未自动核验）',failed:'原任务失败（不能视为退款）',unknown:'结果未知，保留预占','operator-confirmed':'用户确认结束，非供应商终止回报'}
const invoiceVisible=ref(false),invoiceAmount=ref(''),invoiceReference=ref(''),invoiceAccepted=ref(false);let invoiceEntry=null,closed=false,generation=0,databaseIdentity=null;const controller=new AbortController()
const options=()=>({signal:controller.signal})
function resetIdentity(){project.value=null;prices.value=null;entries.value=[];next.value=null;Object.assign(editing,{id:'',service:'video',config_id:null,provider:'',model:'',origin:'',source:'operator-entered',effective_at:new Date().toISOString(),expires_at:'',expected_revision:0,rates:{},capabilities:{}});selectedConfig.value=null;reserveText.value='';priceAccepted.value=false;for(const field of [inputRate,outputRate,totalRate,characterRate,durationLimit,referenceLimit,resolutions])field.value='';multiVoice.value='unknown';invoiceVisible.value=false;invoiceEntry=null;invoiceAmount.value='';invoiceReference.value='';invoiceAccepted.value=false}
async function load(before){const current=++generation;loading.value=true;notice.value='';try{const [rows,catalog]=await Promise.all([museBudgetApi('/projects/'+props.projectId+'/entries'+(before?'?before='+encodeURIComponent(before):''),options()),museBudgetApi('/catalog',options())]);if(closed||generation!==current)return;if(rows.project.database_id!==catalog.database_id)throw Error('制作平台身份已变化，请刷新预算后重试');if(databaseIdentity&&databaseIdentity!==rows.project.database_id)resetIdentity();databaseIdentity=rows.project.database_id;project.value=rows.project;entries.value=rows.items;next.value=rows.next;prices.value=catalog;currency.value=rows.project.currency;limitText.value=rows.project.limit_minor===null?'':moneyText(rows.project.limit_minor);allowEstimates.value=rows.project.allow_estimates;allowTasks.value=rows.project.allow_task_envelopes;}catch(error){if(!closed&&generation===current){if(error.status===401||error.status===403)resetIdentity();notice.value=error.message}}finally{if(!closed&&generation===current)loading.value=false}}
async function run(work){if(busy.value||closed)return;busy.value=true;notice.value='';try{await work()}catch(error){if(!closed){if(error.status===401||error.status===403)resetIdentity();notice.value=error.message}}finally{if(!closed)busy.value=false}}
async function saveBudget(){await run(async()=>{await museBudgetApi('/projects/'+props.projectId,{...options(),method:'PUT',body:JSON.stringify({database_id:project.value.database_id,operation_id:crypto.randomUUID(),expected_revision:project.value.revision,currency:currency.value,limit_minor:moneyMinor(limitText.value),allow_estimates:allowEstimates.value,allow_task_envelopes:allowTasks.value})});await load()})}
function selectConfig(id){const selected=prices.value.configs.find(row=>row.id===id);if(!selected)return;editing.config_id=selected.id;editing.provider=selected.provider;editing.origin=selected.origin||'';editing.model=selected.models[0]||'';editing.service=services.value.includes(selected.service)?selected.service:selected.service==='muse_postproduction'?'postproduction':'text'}
function editPrice(price){Object.assign(editing,price,{expected_revision:Number(price.revision.replace('owner:',''))});reserveText.value=moneyText(price.reserve_minor);priceAccepted.value=false;selectedConfig.value=price.config_id;for(const[field,key]of [[inputRate,'input_per_million_minor'],[outputRate,'output_per_million_minor'],[totalRate,'total_per_million_minor'],[characterRate,'characters_per_thousand_minor']])field.value=price.rates[key]===null?'':moneyText(price.rates[key]);durationLimit.value=price.capabilities.maxDurationSeconds??'';referenceLimit.value=price.capabilities.maxReferenceImages??'';resolutions.value=price.capabilities.resolutions.join(',');multiVoice.value=price.capabilities.supportsMultiVoice===null?'unknown':price.capabilities.supportsMultiVoice?'yes':'no'}
async function savePrice(){await run(async()=>{if(!budgetPriceCurrencyAllowed(currency.value,editing.provider,editing.service))throw Error('LibTV 积分只可用于 libtv-cli 的文本、图片、视频或整任务估价');const rates={};for(const[field,key]of [[inputRate,'input_per_million_minor'],[outputRate,'output_per_million_minor'],[totalRate,'total_per_million_minor'],[characterRate,'characters_per_thousand_minor']])rates[key]=field.value===''?null:moneyMinor(field.value);const capabilities={maxDurationSeconds:durationLimit.value===''?null:Number(durationLimit.value),maxReferenceImages:referenceLimit.value===''?null:Number(referenceLimit.value),resolutions:resolutions.value.split(',').map(value=>value.trim()).filter(Boolean),supportsMultiVoice:multiVoice.value==='unknown'?null:multiVoice.value==='yes'};await museBudgetApi('/catalog/'+encodeURIComponent(editing.id),{...options(),method:'PUT',body:JSON.stringify({...editing,rates,capabilities,database_id:prices.value.database_id,operation_id:crypto.randomUUID(),currency:currency.value,reserve_minor:moneyMinor(reserveText.value),estimate_kind:editing.service==='agent-task'?'operator-task-envelope':'per-dispatch-estimate',operator_accepted:priceAccepted.value})});priceAccepted.value=false;await load()})}
function openInvoice(entry){invoiceEntry={...entry,database_id:project.value.database_id};invoiceAmount.value='';invoiceReference.value='';invoiceAccepted.value=false;invoiceVisible.value=true}
async function saveInvoice(){if(!invoiceEntry||!invoiceAccepted.value)return;const entry=invoiceEntry;await run(async()=>{await museBudgetApi('/entries/'+entry.entry_id+'/reconcile',{...options(),method:'POST',body:JSON.stringify({database_id:entry.database_id,operation_id:crypto.randomUUID(),expected_revision:entry.revision,amount_minor:moneyMinor(invoiceAmount.value),source:'operator-confirmed-invoice',reference:invoiceReference.value,final_invoice_confirmed:true})});invoiceVisible.value=false;await load()})}
watch(currency,()=>{selectedConfig.value=null;priceAccepted.value=false;reserveText.value='';Object.assign(editing,{id:'',service:'video',provider:currency.value==='LTV'?'libtv-cli':'',model:'',origin:currency.value==='LTV'?'https://api.liblib.tv':'',config_id:null,expected_revision:0,source:'operator-entered',effective_at:new Date().toISOString(),expires_at:'',rates:{},capabilities:{}});for(const field of [inputRate,outputRate,totalRate,characterRate,durationLimit,referenceLimit,resolutions])field.value='';multiVoice.value='unknown'})
watch(()=>props.projectId,()=>{generation++;project.value=null;prices.value=null;entries.value=[];next.value=null;invoiceVisible.value=false;void load()})
onMounted(()=>load())
onBeforeUnmount(()=>{closed=true;generation++;controller.abort()})
</script>
<style scoped>
.muse-budget{display:grid;gap:var(--el-component-size-small)}
.muse-budget :deep(.el-form){display:grid;gap:var(--el-component-size-small)}
.muse-budget :deep(.el-checkbox){height:auto;white-space:normal;align-items:flex-start}
.muse-budget :deep(.el-checkbox__label){white-space:normal;overflow-wrap:anywhere}
.budget-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,240px),1fr));gap:var(--el-component-size-small)}
.budget-row{padding:var(--el-component-size-small);border:1px solid var(--el-border-color);border-radius:var(--el-border-radius-base);overflow-wrap:anywhere}
.budget-row p{margin-block:var(--el-font-size-small)}
</style>

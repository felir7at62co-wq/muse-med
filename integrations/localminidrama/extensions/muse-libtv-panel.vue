<template>
 <section>
  <el-alert title="LibTV OpenAPI · 会话式生成" type="info" :closable="false" description="由 LibTV Agent 选择模型和生成数量。此公开协议不保证固定 Seedance 型号、片段时长、正式声线绑定或供应商最终金额。发现结果不等于整个任务已结束；原素材、请求和导入版本均保留在 Muse。" />
  <el-tabs v-model="tab">
   <el-tab-pane label="生成与任务" name="tasks">
    <div class="controls"><el-select v-model="form.project_id" :disabled="busy" aria-label="Muse 项目" placeholder="选择 Muse 项目" @change="clearReferences"><el-option v-for="p in projects" :key="p.id" :value="p.id" :label="p.title" /></el-select><el-select v-model="form.config_id" :disabled="busy" aria-label="LibTV API 配置" placeholder="LibTV API 配置" @change="clearReferences"><el-option v-for="c in configs" :key="c.id" :value="c.id" :label="c.name" /></el-select><el-select v-model="form.kind" aria-label="期望结果类型"><el-option value="video" label="视频结果"/><el-option value="image" label="图片结果"/></el-select></div>
    <section class="task" aria-label="LibTV 项目会话绑定">
     <strong>项目会话绑定</strong><p>每个 Muse 项目须明确绑定当前 API 配置下的 LibTV 会话。留空会话 ID 会读取该凭据的共享默认上下文，不代表独立新会话。</p>
     <p v-if="bindingLoading" role="status">正在读取项目会话绑定…</p>
     <p v-else-if="binding">当前绑定：会话 <code>{{binding.session_id}}</code> · LibTV 项目 <code>{{binding.remote_project_id}}</code> · {{binding.context_mode==='shared_default'?'共享默认上下文':'指定会话'}}{{bindingVerified?'':'（尚未重新核实）'}}</p>
     <p v-else>当前项目尚未确认会话绑定，不能提交新任务。</p>
     <el-input v-model="bindingSession" :disabled="busy||bindingLoading" aria-label="LibTV 会话 ID" placeholder="填入现有 LibTV 会话 ID；留空仅检查共享默认上下文"/>
     <div class="controls"><el-button :disabled="busy||bindingLoading||!form.project_id||!form.config_id" @click="inspectBinding">读取待绑定会话</el-button><el-button :disabled="busy||bindingLoading||!form.project_id||!form.config_id" @click="readBinding">刷新当前绑定</el-button></div>
     <div v-if="bindingPreview">
      <p>待绑定：会话 <code>{{bindingPreview.session_id}}</code> · LibTV 项目 <code>{{bindingPreview.remote_project_id}}</code></p>
      <el-alert v-if="bindingPreview.context_mode==='shared_default'" title="这是该凭据的共享默认上下文" type="warning" :closable="false" description="其中可能已有供应商侧历史内容。只有明确接受该上下文时才绑定；需要隔离项目时，请先在 LibTV 准备独立会话，再填写其 ID。"/>
      <el-checkbox v-model="bindingAcknowledged">我已核对返回的会话和 LibTV 项目，同意用于当前 Muse 项目</el-checkbox>
      <el-checkbox v-if="bindingPreview.context_mode==='shared_default'" v-model="sharedDefaultAcknowledged">我明确接受复用该凭据的共享默认上下文</el-checkbox>
      <el-button :disabled="busy||!bindingAcknowledged||(bindingPreview.context_mode==='shared_default'&&!sharedDefaultAcknowledged)" @click="saveBinding">确认项目会话绑定</el-button><el-button :disabled="busy" @click="clearBindingPreview">保留当前绑定</el-button>
     </div>
     <el-alert v-if="bindingError" :title="bindingError" type="error" :closable="false"/>
    </section>
    <div class="controls"><el-input-number v-model="form.storyboard_id" :min="1" controls-position="right" placeholder="可选制作包 ID"/><span>可选：指定本项目的制作包。导入只新增版本，采用需在该包历史中明确选择。</span></div>
    <el-input v-model="form.prompt" type="textarea" :rows="5" placeholder="填写交给 LibTV 的生成要求。长剧按制作包分别提交。"/>
    <div class="controls"><el-button :disabled="busy||!form.project_id" @click="readReferences">读取项目参考素材</el-button><el-select v-model="referenceId" placeholder="选择已生成并保存的素材"><el-option v-for="r in referenceOptions" :key="r.source_id" :value="r.source_id" :label="r.label"/></el-select><el-button :disabled="busy||!referenceId" @click="addReference">加入参考</el-button><span>{{ form.references.length }} 份参考图／视频</span><el-button v-if="form.references.length" @click="form.references=[]">清空参考</el-button></div>
    <section v-if="pending" class="task" aria-label="原提交恢复">
     <el-alert title="有一笔提交需要核对" type="warning" :closable="false"/>
     <p>原操作编号：<code>{{ pending.operation_id }}</code></p>
     <p>{{ pendingCheck?.state==='abandoned'?'服务器已放弃此编号，迟到的同编号请求也不会生成':pendingCheck?.task?.state==='preparation_failed'?'原任务在派发前准备失败，可接续查看记录或明确放弃编号':pendingCheck?.state==='recorded'?'已找到原任务，请接续记录查询结果；结果未知的任务不能放弃':pendingCheck?.state==='not_recorded'?'服务器暂未记录原任务；可恢复原输入，或明确放弃编号以阻止迟到请求':'请先查看原操作，不要删除编号或换编号重发' }}</p>
     <div class="controls"><el-button :disabled="busy" @click="inspectPending">查看原操作</el-button><el-button :disabled="busy" @click="restorePending">恢复原输入</el-button><el-button v-if="pendingCheck?.state==='recorded'||pendingCheck?.state==='abandoned'" :disabled="busy" @click="finishRecovery">{{pendingCheck.state==='recorded'?'接续原任务记录':'完成原编号核对'}}</el-button><el-button v-if="pendingCheck?.can_abandon" :disabled="busy" @click="abandonPending">明确放弃未派发编号</el-button></div>
    </section>
    <el-checkbox v-model="form.acknowledge_agent_mode">我理解此接口由供应商 Agent 执行，预算预占不能限制它的最终实际消费</el-checkbox>
    <div class="controls"><el-button type="primary" :disabled="busy||bindingLoading||!!bindingPreview||!bindingVerified||!binding||!form.acknowledge_agent_mode||!form.prompt||!form.config_id||!form.project_id" @click="submit">提交一次新任务</el-button><el-button :disabled="busy" @click="load">读取本地任务记录</el-button></div>
    <el-alert v-if="error" :title="error" type="error" :closable="false"/>
    <article v-for="task in tasks" :key="task.operation_id" class="task">
     <strong>{{ task.kind==='video'?'视频':'图片' }} · {{ task.state }}</strong><small>{{ task.operation_id }}</small><pre>{{ task.prompt }}</pre>
     <el-alert v-if="task.error_code" :title="task.error_code+'：原任务未确认，请核对 API 配置与供应商会话；不要换编号重新生成。'" type="warning" :closable="false"/>
     <div class="controls"><el-button :disabled="busy||!task.session_id" @click="observe(task)">继续查询原会话（不重新生成）</el-button><el-button v-if="task.session_id&&task.state!=='operator_confirmed'" :disabled="busy" @click="confirm(task)">我已核对供应商，结束本地追踪</el-button></div>
     <details><summary>会话记录 {{ task.messages.length }} 条</summary><pre v-for="m in task.messages" :key="m.id">{{ m.role }}: {{ m.content }}</pre></details>
     <div v-for="r in task.results" :key="r.id" class="result"><span>{{r.kind}} · 结果终态未经供应商确认</span><el-button :disabled="busy" @click="importMedia(task,r)">下载校验并新增原生版本（不生成）</el-button></div>
    </article>
   </el-tab-pane>
   <el-tab-pane label="API 配置" name="config">
    <el-alert type="warning" :closable="false" title="Access Key 只保存在当前 Muse 账号的制作平台中，不要填入聊天。"/>
    <el-input v-model="setting.name" placeholder="配置名称"/><el-input v-model="setting.api_key" type="password" show-password autocomplete="off" placeholder="LibTV Access Key"/><el-input model-value="https://im.liblib.tv" disabled/>
    <el-button :disabled="busy||!setting.api_key||!setting.name" @click="saveConfig">保存 API 配置</el-button>
    <p>使用前还需在项目预算中配置整任务预占金额及有效日期，并明确允许 Agent 任务估价。这里不会把 Agent 任务当作单镜固定费率。</p>
   </el-tab-pane>
  </el-tabs>
 </section>
</template>
<script setup>
import {onMounted,onBeforeUnmount,reactive,ref,watch} from 'vue'
import {ElMessage,ElMessageBox} from 'element-plus'
import request from '@/utils/request'
const tab=ref('tasks'),busy=ref(false),error=ref(''),configs=ref([]),projects=ref([]),tasks=ref([]),databaseId=ref(''),referenceId=ref(''),referenceOptions=ref([]),setting=reactive({name:'LibTV',api_key:''})
const form=reactive({project_id:null,storyboard_id:null,config_id:null,kind:'video',prompt:'',references:[],acknowledge_agent_mode:false})
const prefix='/muse/libtv',cacheKey='muse.libtv.pending-operation.v1'
const pending=ref(null),pendingCheck=ref(null)
const binding=ref(null),bindingPreview=ref(null),bindingLoading=ref(false),bindingVerified=ref(false),bindingIdentity=ref(''),bindingError=ref(''),bindingSession=ref(''),bindingAcknowledged=ref(false),sharedDefaultAcknowledged=ref(false)
let bindingEpoch=0,previewEpoch=0,alive=true
const bindingScope=()=>JSON.stringify([databaseId.value,form.project_id,form.config_id])
function bindingAddress(){if(!databaseId.value||!form.project_id||!form.config_id)throw Error('请先选择 Muse 项目和 LibTV API 配置');return '/projects/'+form.project_id+'/binding'}
function currentBindingResponse(value,scope,epoch){return alive&&scope===bindingScope()&&epoch===bindingEpoch&&value.database_id===databaseId.value&&value.project_id===form.project_id&&value.config_id===form.config_id}
function clearBindingPreview(){previewEpoch++;bindingPreview.value=null;bindingAcknowledged.value=false;sharedDefaultAcknowledged.value=false}
async function readBinding(){const epoch=++bindingEpoch,scope=bindingScope();bindingVerified.value=false;bindingIdentity.value='';clearBindingPreview();bindingError.value='';if(!databaseId.value||!form.project_id||!form.config_id){binding.value=null;bindingLoading.value=false;return}bindingLoading.value=true;try{const value=await call(bindingAddress()+'?config_id='+form.config_id);if(!currentBindingResponse(value,scope,epoch))return;binding.value=value.binding;bindingIdentity.value=scope;bindingVerified.value=true}catch(e){if(alive&&epoch===bindingEpoch)bindingError.value=e.response?.data?.error?.message||e.message||'绑定状态读取失败，请重试'}finally{if(alive&&epoch===bindingEpoch)bindingLoading.value=false}}
function clearReferences(){referenceOptions.value=[];referenceId.value='';form.references=[]}
function selectionChanged(){binding.value=null;bindingSession.value='';void readBinding()}
function inspectBinding(){return guarded(async()=>{const epoch=++bindingEpoch,scope=bindingScope();clearBindingPreview();const previewToken=previewEpoch;bindingError.value='';const value=await call(bindingAddress()+'/preview',{database_id:databaseId.value,config_id:form.config_id,...bindingSession.value.trim()?{session_id:bindingSession.value.trim()}: {}});if(!currentBindingResponse(value,scope,epoch)||previewToken!==previewEpoch)return;bindingPreview.value=value})}
function saveBinding(){return guarded(async()=>{const preview=bindingPreview.value;if(!preview||preview.database_id!==databaseId.value||preview.project_id!==form.project_id||preview.config_id!==form.config_id||!bindingAcknowledged.value||preview.context_mode==='shared_default'&&!sharedDefaultAcknowledged.value)throw Error('请先读取并明确确认当前会话上下文');const epoch=bindingEpoch,scope=bindingScope(),previewToken=previewEpoch,value=await call(bindingAddress(),{...preview,acknowledge_context:true,...preview.context_mode==='shared_default'?{acknowledge_shared_default:true}:{}});if(!currentBindingResponse(value,scope,epoch)||previewToken!==previewEpoch)return;binding.value=value.binding;bindingIdentity.value=scope;bindingVerified.value=true;clearBindingPreview();ElMessage.success('项目会话绑定已保存，未提交生成')})}
async function call(path,body){return await request({url:prefix+path,method:body===undefined?'get':'post',...body===undefined?{}:{data:body}})}
async function guarded(action){if(busy.value)return;busy.value=true;error.value='';try{await action()}catch(e){if(e!=='cancel'&&e!=='close')error.value=e.response?.data?.error?.message||e.message||'操作未确认，请查看原操作和项目预算，不要换编号重发'}finally{busy.value=false}}
function readPending(){let value;try{value=JSON.parse(localStorage.getItem(cacheKey+'.'+databaseId.value)||'null')}catch(e){throw Error('原提交编号无法读取，请保留浏览器数据并联系管理员核对')}
 if(value===null){pending.value=null;pendingCheck.value=null;return null}
 let body;try{body=JSON.parse(value.fingerprint)}catch(e){throw Error('原提交输入无法读取，请保留编号并联系管理员核对')}
 if(!/^[A-Za-z0-9_-]{8,128}$/.test(value.operation_id)||!body||body.database_id!==databaseId.value)throw Error('原提交身份不匹配，请保留编号并核对当前账号')
 if(pending.value?.operation_id!==value.operation_id||pending.value?.fingerprint!==value.fingerprint)pendingCheck.value=null
 pending.value={operation_id:value.operation_id,fingerprint:value.fingerprint,body};return pending.value
}
function clearPending(id){const current=readPending();if(!current||current.operation_id!==id)throw Error('另一窗口已修改原提交记录，请重新查看原操作');localStorage.removeItem(cacheKey+'.'+databaseId.value);pending.value=null;pendingCheck.value=null}
function showTask(task){tasks.value=[task,...tasks.value.filter(value=>value.operation_id!==task.operation_id)]}
async function checkPending(){const current=readPending();if(!current)throw Error('没有待核对的原提交');const database=databaseId.value,status=await call('/submissions/'+encodeURIComponent(current.operation_id));if(databaseId.value!==database||status.database_id!==database||status.operation_id!==current.operation_id||!['not_recorded','recorded','abandoned'].includes(status.state))throw Error('原提交身份已变化，请刷新并重新核对');pendingCheck.value=status;if(status.task)showTask(status.task);return status}
function inspectPending(){return guarded(checkPending)}
function restorePending(){return guarded(async()=>{const current=readPending();if(!current)throw Error('没有可恢复的原提交');for(const key of Object.keys(form))if(Object.hasOwn(current.body,key))form[key]=JSON.parse(JSON.stringify(current.body[key]));referenceOptions.value=[];referenceId.value='';ElMessage.success('已恢复原输入，继续使用原操作编号')})}
function finishRecovery(){return guarded(async()=>{const status=await checkPending();if(!['recorded','abandoned'].includes(status.state))throw Error('原任务尚未记录，请先明确放弃编号或恢复原输入');clearPending(status.operation_id);ElMessage.success(status.state==='recorded'?'已接续原任务记录，请查询原会话':'已完成原编号核对')})}
function abandonPending(){return guarded(async()=>{const status=await checkPending();if(!status.can_abandon)throw Error('原任务已经记录或结果未知，不能放弃编号');await ElMessageBox.confirm('仅放弃尚未派发的原编号。服务器将拒绝迟到的同编号请求；已提交或结果未知的任务不会被取消。','放弃未派发编号',{confirmButtonText:'确认放弃未派发编号',cancelButtonText:'保留原编号'});const result=await call('/submissions/'+encodeURIComponent(status.operation_id)+'/abandon',{database_id:status.database_id,acknowledge_no_paid_dispatch:true});if(result.database_id!==databaseId.value||result.operation_id!==status.operation_id||result.state!=='abandoned')throw Error('放弃结果未确认，请保留编号并重新查看原操作');clearPending(status.operation_id);ElMessage.success('已放弃未派发编号，可修改后提交新任务')})}
async function load(){const [c,p,t]=await Promise.all([call('/configs'),request.get('/dramas'),call('/tasks')]);if(databaseId.value&&databaseId.value!==c.database_id){form.project_id=null;form.config_id=null;form.storyboard_id=null;form.prompt='';form.references=[];referenceOptions.value=[];setting.api_key='';pending.value=null;pendingCheck.value=null}databaseId.value=c.database_id;configs.value=c.items;projects.value=Array.isArray(p)?p:(p.items||[]);tasks.value=t;readPending();await readBinding()}
function saveConfig(){return guarded(async()=>{await call('/configs',{...setting,database_id:databaseId.value});setting.api_key='';await load();ElMessage.success('LibTV API 配置已保存');tab.value='tasks'})}
function submit(){return guarded(async()=>{if(!bindingVerified.value||bindingIdentity.value!==bindingScope()||!binding.value||bindingLoading.value||bindingPreview.value)throw Error('请先读取并确认当前项目的 LibTV 会话绑定');const body={...JSON.parse(JSON.stringify(form)),database_id:databaseId.value,binding_sha256:binding.value.binding_sha256},fingerprint=JSON.stringify(body),key=cacheKey+'.'+databaseId.value;let saved=readPending();
 if(saved&&saved.fingerprint!==fingerprint)throw Error('还有原提交待核对，请查看原操作、恢复原输入或明确放弃未派发编号');if(!saved){saved={fingerprint,operation_id:crypto.randomUUID()};localStorage.setItem(key,JSON.stringify(saved));readPending()}
 const result=await call('/tasks',{...body,operation_id:saved.operation_id});if(result.database_id!==databaseId.value||result.operation_id!==saved.operation_id)throw Error('提交回执身份未确认，请查看原操作');clearPending(saved.operation_id);await load();ElMessage.success('任务已保存，查询会沿用原会话')})}
function observe(t){return guarded(async()=>{await call('/tasks/'+encodeURIComponent(t.operation_id)+'/observe',{});await load()})}
function readReferences(){return guarded(async()=>{referenceOptions.value=await call('/references?project_id='+form.project_id)})}
function addReference(){return guarded(async()=>{const r=await call('/references/resolve',{database_id:databaseId.value,project_id:form.project_id,source_id:referenceId.value});if(!form.references.some(v=>v.sha256===r.sha256))form.references.push(r)})}
function confirm(t){return guarded(async()=>{const {value}=await ElMessageBox.prompt('仅结束 Muse 本地追踪，不会取消供应商 Agent，也不代表退款。请填写已核对的结束依据；账单需在预算页另行核销。','确认本地任务结束',{inputPattern:/\S+/,confirmButtonText:'确认已核对',cancelButtonText:'继续观察'});await call('/tasks/'+t.operation_id+'/confirm',{database_id:t.database_id,expected_snapshot:t.snapshot,acknowledge_external_task_may_continue:true,note:value});await load()})}
function importMedia(t,r){return guarded(async()=>{const out=await call('/tasks/'+t.operation_id+'/results/'+r.id+'/import',{operation_id:'import-'+r.id,retry_download:true});ElMessage.success(out.kind==='audio'?'已保存音频素材 '+out.asset_id+'，尚未自动采用':'已新增'+out.kind+'版本 '+out.generation_id+'，尚未自动采用');await load()})}
onMounted(()=>{void guarded(load)})
watch(()=>[databaseId.value,form.project_id,form.config_id],selectionChanged)
watch(bindingSession,clearBindingPreview)
onBeforeUnmount(()=>{alive=false;bindingEpoch++})
</script>
<style scoped>
.controls{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin:12px 0}.controls .el-select{min-width:180px}.task{border:1px solid var(--el-border-color);border-radius:8px;padding:14px;margin:14px 0}.task small{display:block;overflow-wrap:anywhere}.task code{overflow-wrap:anywhere}pre{white-space:pre-wrap;overflow-wrap:anywhere;max-height:260px;overflow:auto}.result{display:flex;gap:12px;align-items:center;margin:10px 0}.el-input{margin:8px 0}
</style>

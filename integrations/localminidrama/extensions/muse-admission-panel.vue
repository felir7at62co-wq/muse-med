<template>
  <section class="muse-admission">
    <p>相同输入默认读取原提交，不会重新调用供应商。刷新页面或重新登录后仍会核对服务器记录；失败或断线不代表免费。</p>
    <div><el-button :loading="busy" @click="refresh">刷新提交记录</el-button></div>
    <p v-if="notice" role="status">{{ notice }}</p>
    <p v-if="!busy && !items.length">暂无本制作空间的生成提交记录。</p>
    <article v-for="item in items" :key="item.operation_id">
      <h3>{{ item.label }} · {{ states[item.state] || '结果待核对' }}</h3>
      <p>{{ item.path }} · {{ item.created_at }}</p>
      <p>提交标识：{{ item.operation_id }}</p>
      <p v-if="item.resources.length">原记录：{{ item.resources.map(row => row.kind + ' ' + row.resource_id).join(' · ') }}</p>
      <p>供应商费用：未回报。{{ item.state === 'unknown' ? '原请求结果未知，禁止自动创建新提交，请先核对供应商和原资源。' : '' }}</p>
      <p v-if="!item.supplier_usage">供应商 Token 用量：未回报。</p><template v-else><p>以下为供应商实际回报，可能只覆盖部分调用，不代表完整计费：</p><pre>{{ JSON.stringify(item.supplier_usage.map(call => call.usage),null,2) }}</pre></template>
      <p v-if="item.usage_health === 'error'">部分用量未能持久保存，请核对供应商原始记录；当前数值不能视为全部用量。</p>
      <div class="admission-actions"><el-button :disabled="busy" @click="inspect(item)">读取原回执</el-button><el-button v-if="item.can_create_version" :disabled="busy" @click="permit(item)">允许创建新版本</el-button></div>
      <pre v-if="selected === item.operation_id">{{ receipt }}</pre>
    </article>
  </section>
</template>
<script setup>
import {ref,onMounted} from 'vue'
import {ElMessageBox} from 'element-plus'
import {museAdmissionApi,permitMuseAdmissionVersion} from '@/utils/museAdmission'
const items=ref([]),databaseId=ref(''),busy=ref(false),notice=ref(''),selected=ref(''),receipt=ref('')
const states={authorized:'已许可，尚未提交',reserved:'正在提交',accepted:'已接收，原任务处理中',completed:'原任务完成',failed:'原任务失败（可能已计费）',unknown:'结果未知'}
async function refresh(){busy.value=true;notice.value='';try{const result=await museAdmissionApi('');if(!result||!Array.isArray(result.items)||typeof result.database_id!=='string')throw Error('invalid admission response');items.value=result.items;databaseId.value=result.database_id}catch(error){notice.value='无法更新提交记录，现有记录仍保留，请重试读取。'}finally{busy.value=false}}
async function inspect(item){busy.value=true;notice.value='';try{const result=await museAdmissionApi('/'+encodeURIComponent(item.operation_id));selected.value=item.operation_id;receipt.value=result.receipt?.body||'原提交回执尚未确认；不要修改标识重发。'}catch(error){notice.value='读取原回执失败，请重试读取。'}finally{busy.value=false}}
async function permit(item){try{await ElMessageBox.confirm('这会允许下一次相同输入使用新的提交标识，可能再次计费。原请求失败也可能已收费。继续后，请返回原生成按钮提交；此处不自动生成。','允许创建新的付费版本',{confirmButtonText:'允许新版本',cancelButtonText:'保留原记录',type:'warning'})}catch(error){return}busy.value=true;notice.value='';try{await permitMuseAdmissionVersion(databaseId.value,item);await refresh();notice.value='新版本许可已保存。请返回原生成按钮主动提交；尚未调用供应商。'}catch(error){notice.value='新版本许可未确认，请刷新并核对，不能清除记录后盲目重发。'}finally{busy.value=false}}
onMounted(()=>{void refresh()})
</script>
<style scoped>
.muse-admission { display:grid; gap:12px; }
.muse-admission p { margin:8px 0; line-height:1.65; overflow-wrap:anywhere; }
.muse-admission article { padding:14px; border:1px solid var(--el-border-color); border-radius:8px; min-width:0; }
.muse-admission h3 { margin:0; font-weight:500; }
.admission-actions { display:flex; gap:8px; flex-wrap:wrap; }
.muse-admission pre { font:inherit; white-space:pre-wrap; overflow-wrap:anywhere; overflow:auto; max-height:260px; }
@media (max-width:600px) { .admission-actions :deep(.el-button) { margin:0; } }
</style>

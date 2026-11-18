<template>
  <section class="muse-postproduction">
    <el-alert type="info" :closable="false" title="AI 视频后期使用你的 Fal 账户，可能计费。新结果只进入历史，核对画面和原音轨后再明确采用；供应商用量未回报时不按零计费。" />
    <el-alert v-if="notice" type="error" :closable="false" :title="notice" />
    <el-collapse>
      <el-collapse-item title="配置本账户的 Fal 视频后期 API" name="config">
        <p>密钥只保存于本账户后台，不进入模型工具参数。高清增强使用 SeedVR2；Bria 去烧录字幕按帧拆为不足 5 秒的片段，全部完成后按顺序拼回原片长，不截短整集或制作包。</p>
        <div class="post-form">
          <el-select v-model="editingConfigId" clearable placeholder="新建配置或更新已有配置"><el-option v-for="c in configs" :key="c.id" :value="c.id" :label="c.name" /></el-select>
          <el-input v-model="configName" placeholder="配置名称" maxlength="100" />
          <el-input v-model="apiKey" type="password" autocomplete="off" placeholder="输入 Fal API Key，不在聊天中发送" />
          <el-button :disabled="busy || !apiKey.trim()" @click="saveConfig">保存本账户配置</el-button>
        </div>
      </el-collapse-item>
    </el-collapse>
    <div class="post-form">
      <el-select v-model="sourceId" placeholder="明确选择已完成的视频版本" @change="inspectSource"><el-option v-for="s in sources" :key="s.id" :value="s.id" :label="'生成 ' + s.id + ' · 分镜 ' + s.storyboard_id + ' · ' + (s.model || s.provider)" /></el-select>
      <el-select v-model="configId" placeholder="明确选择 Fal 配置"><el-option v-for="c in configs.filter(c => c.is_active && c.key_configured)" :key="c.id" :value="c.id" :label="c.name" /></el-select>
      <el-select v-model="kind"><el-option value="upscale" label="AI 视频高清（SeedVR2，2x）" /><el-option value="erase_subtitles" label="去烧录字幕（Bria，分段回拼）" /></el-select>
    </div>
    <p v-if="!sources.length && !loading">暂无已完成且保存本地文件的视频版本。先生成并明确采用目标分镜的视频。</p>
    <div v-if="inspected" class="post-version">
      <p>源生成 {{ inspected.generation_id }} · 分镜 {{ inspected.storyboard_id }} · {{ inspected.metadata.duration_seconds }} 秒 · {{ inspected.metadata.frames }} 帧 · {{ inspected.metadata.width }}×{{ inspected.metadata.height }} · {{ inspected.adopted ? '当前已采用' : '尚未采用：先在分镜选择此版本' }}</p>
      <small>原媒体 SHA-256：{{ inspected.source_sha256 }}</small>
      <video controls preload="metadata" :src="museMediaUrl(inspected.local_path)" />
      <p v-if="kind === 'erase_subtitles'">本片将按原帧顺序处理 {{ inspected.erase_submission_count }} 个片段，每片严格不足 5 秒；将分别调用供应商并可能计费。全部片段通过校验后才拼回，恢复整条原音轨，不丢帧、不缩短。</p>
    </div>
    <el-input v-if="kind === 'erase_subtitles'" v-model="erasePrompt" placeholder="明确指出要去除的烧录字幕，如 burned-in subtitles and captions" maxlength="500" />
    <div class="post-actions">
      <el-button type="primary" :loading="busy" :disabled="!canSubmit" @click="submit(false)">提交一次或查询原请求</el-button>
      <el-button :disabled="busy || !canSubmit || unresolved" @click="submit(true)">明确新建后期版本</el-button>
      <el-button :disabled="busy || loading" @click="load">刷新配置与历史</el-button>
    </div>
    <p>操作标识在请求前保存在当前数据库身份下。断线后复用原请求；结果未知时先核对 Fal 历史，不以新标识重复计费。</p>
    <p v-if="!history.length && !loading">本项目暂无视频后期记录。</p>
    <article v-for="row in history" :key="row.operation_id" class="post-version">
      <p>{{ labels[row.state] || row.state }} · {{ row.kind === 'upscale' ? 'AI 视频高清 2x' : '去烧录字幕' }} · 源生成 {{ row.source_generation_id }} · {{ row.adopted ? '分镜当前采用' : '未采用' }}</p>
      <small>原操作 {{ row.operation_id }} · {{ row.segment_count > 1 ? row.segment_count + ' 个独立片段任务' : '供应商任务 ' + (row.request_id || '尚未确认，不能自动重发') }} · {{ row.error_code || '' }}</small>
      <p v-if="row.error_origin">服务端未允许访问 {{ row.error_origin }}，请联系平台管理员核对媒体域名后，再查询原任务。</p>
      <small>原媒体 {{ row.source_sha256 }} · 结果 {{ row.output_sha256 || '未获得已校验媒体' }}</small>
      <p v-if="row.output_metadata">{{ row.output_metadata.width }}×{{ row.output_metadata.height }} · {{ row.output_metadata.frames }} 帧 · 原音轨数据校验 {{ row.output_metadata.audio_sha256 || '源视频没有音轨' }}</p>
      <video v-if="row.state === 'completed'" controls preload="none" :src="museMediaUrl(row.local_path)" />
      <details v-if="row.segments?.length"><summary>片段顺序、队列身份与校验</summary><p v-for="segment in row.segments" :key="segment.index">片段 {{ segment.index }} · 原帧 [{{ segment.start_frame }}, {{ segment.end_frame }}) · {{ labels[segment.state] || segment.state }} · 原任务 {{ segment.request_id || '未取得任务号' }} · {{ segment.error_code || '' }}<br />媒体 SHA：{{ segment.raw_sha256 || '尚未保存' }}</p></details>
      <div class="post-actions">
        <el-button v-if="(row.request_id || row.segments?.some(segment => segment.request_id)) && row.state !== 'completed'" :disabled="busy" @click="refresh(row)">只查询原任务并校验下载</el-button>
        <el-button v-if="row.state === 'submission_incomplete'" :disabled="busy" @click="continueSubmission(row)">按原计划提交未开始片段</el-button>
        <el-button v-if="row.state === 'completed'" :disabled="busy || row.adopted" @click="adopt(row)">核对后采用此版本</el-button>
      </div>
    </article>
  </section>
</template>
<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { ElMessageBox } from 'element-plus'
import request from '@/utils/request'
import { museMediaUrl } from '@/utils/museStudioPath'
const props=defineProps({dramaId:{type:[Number,String],required:true}}),emit=defineEmits(['adopted'])
const configs=ref([]),sources=ref([]),history=ref([]),databaseId=ref(''),sourceId=ref(null),configId=ref(null),kind=ref('upscale'),inspected=ref(null)
const editingConfigId=ref(null),configName=ref('Fal 视频后期'),apiKey=ref(''),erasePrompt=ref('burned-in subtitles and captions'),notice=ref(''),busy=ref(false),loading=ref(false)
let controller=new AbortController(),revision=0
const labels={pending:'尚未提交',upload_failed:'尚未提交供应商，上传或准备失败',uploading:'上传原片中',submitting:'提交中',submission_incomplete:'原计划尚有未提交片段',unknown:'提交结果未知，禁止自动重发',queued:'已受理，排队中',processing:'供应商处理中',result_ready:'等待下载校验',verified:'该片段已完整解码',assembling:'片段齐备，等待完整拼回校验',media_unverified:'媒体未通过校验，可只核查原任务',failed:'原请求未完成',completed:'全片解码与原音轨已校验，画面仍需审查'}
const unresolved=computed(()=>history.value.some(row=>['unknown','uploading','submitting','submission_incomplete','queued','processing','result_ready','assembling','media_unverified'].includes(row.state)))
const canSubmit=computed(()=>!busy.value&&!loading.value&&databaseId.value&&configId.value&&inspected.value?.generation_id===sourceId.value&&inspected.value.adopted
 &&(kind.value!=='erase_subtitles'||inspected.value.erase_segments?.length>0&&erasePrompt.value.trim()))
const options=()=>({signal:controller.signal})
async function run(work){if(busy.value)return;busy.value=true;notice.value='';try{await work()}catch(error){if(!controller.signal.aborted)notice.value=error.message||'操作未确认，请查看原请求记录'}finally{busy.value=false}}
async function sha(bytes){return [...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(x=>x.toString(16).padStart(2,'0')).join('')}
async function operation(key,input,fresh=false){if(!databaseId.value)throw Error('视频后期数据库身份尚未确认');const name='muse-postproduction:'+databaseId.value+':'+key+':'+await sha(new TextEncoder().encode(JSON.stringify(input)));
 const previous=localStorage.getItem(name);if(previous&&!fresh)return previous;const id=crypto.randomUUID();localStorage.setItem(name,id);if(localStorage.getItem(name)!==id)throw Error('无法保留操作标识，未发起付费请求');return id}
async function load(){const current=++revision;loading.value=true;try{const [capability,selected,rows]=await Promise.all([
 request.get('/muse/postproduction/capabilities',options()),request.get('/muse/postproduction/sources',{...options(),params:{drama_id:props.dramaId}}),request.get('/muse/postproduction/tasks',{...options(),params:{drama_id:props.dramaId}})]);
 if(current!==revision)return;if(databaseId.value&&databaseId.value!==capability.database_id){sourceId.value=null;configId.value=null;inspected.value=null;apiKey.value='';}
 databaseId.value=capability.database_id;configs.value=capability.configs;sources.value=selected.items;history.value=rows.items;
 }catch(error){if(!controller.signal.aborted&&current===revision)notice.value=error.message||'无法读取视频后期状态'}finally{if(current===revision)loading.value=false}}
async function inspectSource(){inspected.value=null;const id=sourceId.value,current=++revision;if(!id)return;loading.value=true;notice.value='';try{const result=await request.get('/muse/postproduction/sources/'+id+'/inspect',options());if(current===revision&&sourceId.value===id)inspected.value=result;}
 catch(error){if(!controller.signal.aborted&&current===revision)notice.value=error.message||'原媒体未通过检查'}finally{if(current===revision)loading.value=false}}
async function saveConfig(){await run(async()=>{const result=await request.post('/muse/postproduction/config',{database_id:databaseId.value,...editingConfigId.value?{id:editingConfigId.value}:{},name:configName.value,api_key:apiKey.value},options());apiKey.value='';configs.value=result.configs;databaseId.value=result.database_id;})}
async function submit(fresh){if(!canSubmit.value)return;const input={database_id:databaseId.value,source_generation_id:inspected.value.generation_id,source_sha256:inspected.value.source_sha256,config_id:configId.value,kind:kind.value,...kind.value==='erase_subtitles'?{prompt:erasePrompt.value.trim()}:{}};
 const count=kind.value==='erase_subtitles'?inspected.value.erase_submission_count:1;try{await ElMessageBox.confirm((fresh?'明确新建付费后期版本，保留原请求。':'')+'本片将提交 '+count+' 个供应商任务，可能分别计费；原请求重试不重复提交已受理片段。确认继续？','视频后期请求');}catch(error){return}
 if(input.database_id!==databaseId.value||input.source_generation_id!==sourceId.value||input.config_id!==configId.value||input.kind!==kind.value){notice.value='选择已变化，请重新核对提交';return}
 await run(async()=>{
 const id=await operation('submit',input,fresh);await request.post('/muse/postproduction/tasks',{...input,operation_id:id},{...options(),headers:{'x-muse-operation-id':id}});await load();})}
async function refresh(row){await run(async()=>{await request.post('/muse/postproduction/tasks/'+row.operation_id+'/refresh',{},options());await load();})}
async function continueSubmission(row){const input={database_id:databaseId.value};try{await ElMessageBox.confirm('只提交原计划中未开始、或尚未提交供应商的片段，可能计费。已受理和结果未知的片段绝不重发。继续？','继续原分段计划');}catch(error){return}
 await run(async()=>{await request.post('/muse/postproduction/tasks/'+row.operation_id+'/continue',input,{...options(),headers:{'x-muse-operation-id':row.operation_id}});await load();})}
async function adopt(row){let current;try{current=await request.get('/storyboards/'+row.storyboard_id,options())}catch(error){notice.value=error.message||'无法读取分镜当前采用版本';return}
 const input={database_id:databaseId.value,sha256:row.output_sha256,expected_video_url:current.video_url||''};try{await ElMessageBox.confirm('确认已查看完整画面、字幕修复及原音轨，并将此版本设为分镜当前采用？这不会批准 Muse 最终交付。','采用视频后期版本');}catch(error){return}
 await run(async()=>{
 await request.post('/muse/postproduction/tasks/'+row.operation_id+'/adopt',{...input,operation_id:await operation('adopt-'+row.operation_id,input)},options());await load();inspected.value=null;emit('adopted');})}
onMounted(load)
watch(()=>props.dramaId,()=>{revision++;controller.abort();controller=new AbortController();configs.value=[];sources.value=[];history.value=[];databaseId.value='';sourceId.value=null;configId.value=null;inspected.value=null;apiKey.value='';void load();})
onBeforeUnmount(()=>{revision++;controller.abort();apiKey.value='';})
</script>
<style scoped>
.muse-postproduction { display:grid; gap:12px; }
.post-form,.post-actions { display:flex; flex-wrap:wrap; gap:10px; }
.post-form > * { flex:1 1 200px; min-width:0; }
.muse-postproduction p,.muse-postproduction small { overflow-wrap:anywhere; line-height:1.6; }
.post-version { border-bottom:1px solid var(--el-border-color); padding:12px 0; display:grid; gap:8px; min-width:0; }
.post-version video { width:100%; max-height:360px; background:var(--el-fill-color-dark); }
@media (pointer:coarse) { .muse-postproduction :deep(input) { font-size:16px; } }
</style>

<template>
  <div class="muse-audio-panel">
    <el-alert type="info" :closable="false" title="独立配音与视频声音参考分别管理。上传参考不代表已克隆音色；供应商用量未回报时不能按零计费。" />
    <el-tabs v-model="tab">
      <el-tab-pane label="角色声音参考" name="voices">
        <p>参考文件必须为2–30 秒的 16/24/32 位整数 PCM WAV（已有 15 秒版本保持有效），单声道或双声道。每个版本固定原始 SHA，角色和人生时期必须明确填写。</p>
        <div class="audio-form">
          <el-select v-model="characterId" placeholder="选择角色"><el-option v-for="c in characters" :key="c.id" :value="c.id" :label="c.name" /></el-select>
          <el-input v-model="voicePeriod" placeholder="明确人生时期，如童年 / 成年；不自动推断" maxlength="80" />
          <input type="file" accept=".wav,audio/wav" :disabled="busy" @change="selectVoiceFile" />
          <el-button :disabled="!characterId || !voicePeriod.trim() || !voiceFile" :loading="busy" @click="uploadVoice">上传新参考版本</el-button>
        </div>
        <div v-for="voice in voices" :key="voice.id" class="audio-version">
          <p>{{ voice.character_name }} · {{ voice.voice_period_id }} · {{ voice.duration_seconds }} 秒 · {{ voice.codec }} · {{ voice.adopted ? '此时期已采用' : '历史版本' }}</p>
          <small>原始 SHA-256：{{ voice.sha256 }}</small>
          <audio controls preload="none" :src="museMediaUrl(voice.local_path)" />
          <el-button :disabled="voice.adopted || busy" @click="adoptVoice(voice)">采用此角色时期版本</el-button>
        </div>
        <p v-if="!voices.length">尚无正式声音参考版本。</p>
        <h3>当前分镜的视频声音参考</h3>
        <p>按顺序明确选择本包的每位说话人及人生时期，顺序对应音频 1、2……。Ark Seedance 2.5 最多 10 段且合计不超过 30 秒；2.0 最多 3 段且合计不超过 15 秒。生成前按实际模型校验；不支持时请明确拆包或使用独立配音，不会自动丢弃声线。</p>
        <el-select v-model="storyboardId" placeholder="选择分镜" @change="loadHistory"><el-option v-for="sb in storyboards" :key="sb.id" :value="sb.id" :label="sb.title || '分镜 ' + sb.id" /></el-select>
        <el-select v-model="bindingVoiceIds" multiple :multiple-limit="10" clearable placeholder="按顺序选择每位角色、人生时期与原声音版本；全部移除表示清除"><el-option v-for="v in voices" :key="v.id" :value="v.id" :label="v.character_name + ' · ' + v.voice_period_id + ' · ' + v.sha256.slice(0,12)" /></el-select>
        <el-button :disabled="!storyboardId || busy" @click="bindVoice">保存明确选择</el-button>
        <p v-if="binding">已保存：{{ binding.voices.map((v,i) => '音频 ' + (i+1) + '：' + v.character_name + ' · ' + v.voice_period_id).join('、') || '无声音参考' }}</p>
        <h3>本包已提交的视频声音输入历史</h3>
        <p>仅列保存过正式参考映射的视频生成记录，不代表生成已成功或声音质量已通过验收。</p>
        <div v-for="entry in videoInputs" :key="entry.video_generation_id" class="audio-version"><p>视频生成 {{ entry.video_generation_id }} · {{ entry.created_at }}</p><small v-for="(v,i) in entry.voices" :key="v.id">音频 {{ i+1 }}：{{ v.character_name }} · {{ v.voice_period_id }} · {{ v.sha256 }}</small></div>
      </el-tab-pane>
      <el-tab-pane label="独立 TTS 配音" name="tts">
        <p>使用已配置的 OpenAI 或 MiniMax 配音接口与供应商原生音色 ID。OpenAI 最多 4096 字符，MiniMax 少于 10000 字符。新生成结果先进入历史，明确采用后才替换分镜音频。</p>
        <div class="audio-form">
          <el-select v-model="storyboardId" placeholder="选择分镜" @change="changeStoryboard"><el-option v-for="sb in storyboards" :key="sb.id" :value="sb.id" :label="sb.title || '分镜 ' + sb.id" /></el-select>
          <el-select v-model="kind" @change="changeStoryboard"><el-option label="对白配音" value="dialogue" /><el-option label="旁白配音" value="narration" /></el-select>
          <el-select v-model="configId" placeholder="明确选择 TTS 配置"><el-option v-for="c in configs" :key="c.id" :value="c.id" :label="c.name + ' · ' + c.provider" /></el-select>
          <el-select v-model="ttsModel" placeholder="明确选择该配置的 TTS 模型"><el-option v-for="model in ttsModels" :key="model" :value="model" :label="model" /></el-select>
          <el-input v-model="voiceId" placeholder="供应商原生音色 ID，上传参考不会自动克隆" maxlength="160" />
        </div>
        <el-input v-model="text" type="textarea" :rows="4" placeholder="本次配音正文" maxlength="20000" />
        <div class="audio-actions"><el-button type="primary" :loading="busy" :disabled="!storyboardId || !configId || !ttsModel || !voiceId.trim() || !text.trim()" @click="generate(false)">生成或查询同一请求</el-button><el-button :disabled="busy || history.some(row => row.state === 'unknown' || row.state === 'generating')" @click="generate(true)">明确新建配音版本</el-button><el-button :disabled="busy" @click="loadHistory">刷新原请求记录</el-button><el-button v-if="activeTtsOperation" @click="cancelWait">停止等待原配音请求</el-button></div>
        <p>网络中断后重试会复用原操作标识，不再次调用供应商。停止等待不会取消同步供应商请求，也不代表未计费；结果未知时请先核查原记录，不要新建请求。</p>
        <div v-for="row in history" :key="row.operation_id" class="audio-version">
          <p>{{ stateLabels[row.state] || row.state }} · {{ row.tts_kind === 'narration' ? '旁白' : '对白' }} · {{ row.provider }} / {{ row.model }} · {{ row.voice_id }} · {{ row.adopted ? '已采用' : '未采用' }}</p>
          <p v-if="row.cancellation?.requested">已记录停止等待；供应商未确认取消，生成结果与费用请按原操作核查</p>
          <small>操作：{{ row.operation_id }} · 原音频 SHA-256：{{ row.raw_sha256 || '尚未获得音频' }} · {{ row.error_code || '' }}</small>
          <p>{{ row.request_text ?? '旧记录没有保留原文，仅有文本 SHA；不推测或补写' }}</p>
          <el-button :disabled="busy || row.request_text == null" @click="text=row.request_text;tab='tts'">复制原文到编辑框</el-button>
          <audio v-if="row.state === 'completed'" controls preload="none" :src="museMediaUrl(row.local_path)" />
          <el-button v-if="row.state === 'completed'" :disabled="busy || row.adopted" @click="adoptTts(row)">采用此配音版本</el-button>
          <el-button v-if="row.state === 'unknown' || row.state === 'failed'" :disabled="busy" @click="recover(row)">只检查原音频文件</el-button>
        </div>
      </el-tab-pane>
    </el-tabs>
  </div>
</template>
<script setup>
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import request from '@/utils/request'
import { museMediaUrl } from '@/utils/museStudioPath'
const props = defineProps({ dramaId: { type: [Number, String], required: true }, characters: { type: Array, default: () => [] }, storyboards: { type: Array, default: () => [] }, targetId: { type: Number, default: 0 }, targetKind: { type: String, default: 'dialogue' } })
const emit = defineEmits(['adopted'])
const tab=ref('voices'),characterId=ref(null),voicePeriod=ref(''),voiceFile=ref(null),voices=ref([]),configs=ref([]),databaseId=ref(''),storyboardId=ref(null),kind=ref('dialogue'),configId=ref(null),voiceId=ref(''),ttsModel=ref(''),text=ref(''),history=ref([]),binding=ref(null),bindingVoiceIds=ref([]),videoInputs=ref([]),activeTtsOperation=ref(''),busy=ref(false)
let ttsController
const ttsModels=computed(()=>{const row=configs.value.find(item=>item.id===configId.value);return Array.isArray(row?.model)?row.model:row?.model?[row.model]:[]})
watch(configId,()=>{const row=configs.value.find(item=>item.id===configId.value);ttsModel.value=row?.default_model||ttsModels.value[0]||''})
const stateLabels={generating:'正在生成',unknown:'结果未知，禁止自动重发',failed:'原音频未通过校验',completed:'音频已校验'}
async function sha(bytes){return [...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(value=>value.toString(16).padStart(2,'0')).join('')}
async function operation(key,input,fresh=false){
 if(!databaseId.value)throw Error('声音服务身份尚未确认')
 const fingerprint=await sha(new TextEncoder().encode(JSON.stringify(input))),name='muse-audio:'+databaseId.value+':'+key+':'+fingerprint
 const previous=localStorage.getItem(name);if(previous&&!fresh)return previous
 const id=crypto.randomUUID();localStorage.setItem(name,id);if(localStorage.getItem(name)!==id)throw Error('无法保留操作标识');return id
}
async function run(work){if(busy.value)return;busy.value=true;try{await work()}catch(error){const code=error.response?.data?.error?.code;ElMessage.error(typeof code==='string'&&code.startsWith('budget_')?'请先在制作平台“项目预算与账目”确认预算与价格；核对原操作后再继续':'声音操作未确认，请检查原操作记录后重试')}finally{busy.value=false}}
async function loadVoices(){const result=await request.get('/muse/audio/voices',{params:{drama_id:props.dramaId}});voices.value=result.items;databaseId.value=result.capabilities.database_id}
let historyRevision=0
async function loadHistory(){const id=storyboardId.value,revision=++historyRevision;if(!id)return;const [result,current,inputs]=await Promise.all([request.get('/muse/audio/tts',{params:{storyboard_id:id}}),request.get('/muse/audio/video-bindings/'+id),request.get('/muse/audio/video-inputs',{params:{storyboard_id:id}})]);if(revision!==historyRevision||storyboardId.value!==id)return;history.value=result.items;binding.value=current;bindingVoiceIds.value=current.voices.map(row=>row.id);videoInputs.value=inputs.items}
function selectVoiceFile(event){voiceFile.value=event.target.files?.[0]??null}
async function uploadVoice(){await run(async()=>{const file=voiceFile.value,bytes=await file.arrayBuffer(),input={database_id:databaseId.value,character_id:characterId.value,voice_period_id:voicePeriod.value.trim(),sha256:await sha(bytes)},form=new FormData();for(const [key,value]of Object.entries(input))if(key!=='sha256')form.append(key,String(value));form.append('operation_id',await operation('voice-upload',input));form.append('file',file);await request.post('/muse/audio/voices',form,{headers:{'Content-Type':'multipart/form-data'}});await loadVoices()})}
async function adoptVoice(row){await run(async()=>{const input={voice_asset_id:row.id,previous_adoption:row.adoption_operation_id};await request.post('/muse/audio/voices/'+row.id+'/adopt',{database_id:databaseId.value,operation_id:await operation('voice-adopt',input)});await loadVoices()})}
async function bindVoice(){await run(async()=>{const selected=bindingVoiceIds.value.map(id=>{const voice=voices.value.find(row=>row.id===id);if(!voice)throw Error('所选声音版本已不可用');return voice}),input={database_id:databaseId.value,expected_operation_id:binding.value?.operation_id??null,voices:selected.map(row=>({voice_asset_id:row.id,character_id:row.character_id,voice_period_id:row.voice_period_id,sha256:row.sha256}))};await request.put('/muse/audio/video-bindings/'+storyboardId.value,{...input,operation_id:await operation('voice-bind-'+storyboardId.value,input)});await loadHistory()})}
function changeStoryboard(){history.value=[];binding.value=null;bindingVoiceIds.value=[];videoInputs.value=[];const sb=props.storyboards.find(row=>row.id===storyboardId.value);text.value=kind.value==='narration'?sb?.narration||'':sb?.dialogue||'';void loadHistory().catch(()=>ElMessage.error('无法读取配音历史，请重试'))}
async function generate(fresh){if(fresh){try{await ElMessageBox.confirm('新建版本会再次调用供应商并可能计费。确认创建新操作？','新建独立配音版本')}catch(error){return}}
 await run(async()=>{const input={storyboard_id:storyboardId.value,tts_kind:kind.value,config_id:configId.value,model:ttsModel.value,voice_id:voiceId.value.trim(),text:text.value.trim(),speed:1};const id=await operation('tts',input,fresh);activeTtsOperation.value=id;ttsController=new AbortController();try{await request.post('/muse/audio/tts',{...input,database_id:databaseId.value,operation_id:id},{signal:ttsController.signal})}finally{activeTtsOperation.value='';ttsController=undefined}await loadHistory()})}
async function cancelWait(){const id=activeTtsOperation.value,controller=ttsController;if(!id||!controller)return;controller.abort();try{const input={generation_id:id};await request.post('/muse/audio/tts/'+id+'/cancel',{database_id:databaseId.value,operation_id:await operation('cancel-wait',input)});ElMessage.info('已记录停止等待；供应商未确认取消，可能仍会计费')}catch(error){ElMessage.warning('未确认取消记录，请按原操作查询；不要另建请求')}finally{void loadHistory().catch(()=>ElMessage.warning('无法读取原配音记录，请稍后重试'))}}
onBeforeUnmount(()=>ttsController?.abort())
async function recover(row){await run(async()=>{await request.post('/muse/audio/tts/'+row.operation_id+'/recover',{database_id:databaseId.value});await loadHistory()})}
async function adoptTts(row){await run(async()=>{const input={sha256:row.raw_sha256,previous_adoption:row.adoption_operation_id};await request.post('/muse/audio/tts/'+row.operation_id+'/adopt',{...input,database_id:databaseId.value,operation_id:await operation('tts-adopt-'+row.operation_id,input)});await loadHistory();emit('adopted')})}
watch(()=>[props.targetId,props.targetKind],()=>{if(props.targetId){storyboardId.value=props.targetId;kind.value=props.targetKind;tab.value='tts';changeStoryboard()}},{immediate:true})
onMounted(()=>{void run(async()=>{await loadVoices();const result=await request.get('/muse/audio/capabilities');configs.value=result.configs;await loadHistory()})})
</script>
<style scoped>
.muse-audio-panel { display:grid; gap:12px; }
.muse-audio-panel p,.muse-audio-panel small { overflow-wrap:anywhere; line-height:1.6; }
.audio-form,.audio-actions { display:flex; flex-wrap:wrap; gap:10px; margin:12px 0; }
.audio-form > * { flex:1 1 190px; min-width:0; }
.audio-version { padding:12px 0; border-bottom:1px solid var(--el-border-color); display:grid; gap:8px; }
.audio-version audio { max-width:100%; }
.muse-audio-panel h3 { font-weight:500; font-size:15px; }
@media (pointer:coarse) { .audio-form input,.muse-audio-panel :deep(.el-input__inner),.muse-audio-panel :deep(.el-textarea__inner) { font-size:16px; } }
</style>

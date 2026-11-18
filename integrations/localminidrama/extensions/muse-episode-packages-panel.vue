<template>
  <section class="muse-packages">
    <p>每条提示词对应一个制作包，包内可有多个子镜头。整集按包顺序合成，可以继续追加和逐包修改；单包仍受所选模型的片段时长限制。</p>
    <div><el-button :loading="busy" @click="refresh()">刷新本集制作包</el-button></div>
    <p v-if="notice" role="status">{{ notice }}</p>
    <p v-if="state">本集 {{ state.items.length }} 包 · 完整实际时长：{{ state.actual_duration_seconds === null ? '未知' : state.actual_duration_seconds.toFixed(2) + ' 秒' }}<template v-if="state.unknown_duration_packages">（{{ state.unknown_duration_packages }} 包时长未知，已知部分 {{ state.known_duration_seconds.toFixed(2) }} 秒）</template>。目标时长不当成真实输出时长。</p>
    <el-collapse>
      <el-collapse-item title="手动追加制作包" name="create">
        <el-form label-position="top"><el-form-item label="包标题"><el-input v-model="draft.title" /></el-form-item><el-form-item label="创作模式"><el-select v-model="draft.creation_mode"><el-option label="经典提示词" value="classic" /><el-option label="全能片段提示词" value="universal" /></el-select></el-form-item><el-form-item label="生成提示词"><el-input v-model="draft.prompt" type="textarea" :rows="5" /></el-form-item><el-form-item label="目标时长（秒，非实际输出）"><el-input-number v-model="draft.duration" :min="1" /></el-form-item><el-button :disabled="busy || !state" @click="save(draft,'create')">保存新包（不付费生成）</el-button></el-form>
      </el-collapse-item>
      <el-collapse-item title="AI 续包，延长本集" name="append">
        <p>只生成新的包提示词，不替换旧包或生成视频；此文本模型调用可能计费。原有包或所用资产在生成期间变化时，会保留现状并拒绝落库，请核对原提交记录。</p>
        <el-form label-position="top"><el-form-item label="续写要求"><el-input v-model="appendBrief" type="textarea" :rows="4" placeholder="说明接下来发生什么、需要承接的动作和情绪；不要重复已有剧情" /></el-form-item><el-form-item label="新增包数"><el-input-number v-model="appendCount" :min="1" /></el-form-item><el-button :disabled="busy || !state || !appendBrief.trim()" @click="append">AI 生成并追加新包</el-button></el-form>
      </el-collapse-item>
    </el-collapse>
    <article v-for="(item,index) in state?.items || []" :key="item.id">
      <h3>制作包 {{ index + 1 }} · 原生卡片 {{ item.id }}</h3>
      <p>已采用视频版本：{{ item.adopted_generation_id === null ? (item.adopted_video_present ? '已选文件，版本待核对' : '尚未采用') : item.adopted_generation_id }} · 实际时长 {{ item.actual_duration === null ? '未知' : item.actual_duration.toFixed(2) + ' 秒' }} · 进行中 {{ item.pending_generations }} · 失败记录 {{ item.failed_generations }}</p>
      <div class="package-fields"><el-input v-model="item.title" aria-label="制作包标题" /><el-select v-model="item.creation_mode" aria-label="制作包创作模式"><el-option label="经典提示词" value="classic" /><el-option label="全能片段提示词" value="universal" /></el-select><el-input-number v-model="item.target_duration" :min="1" aria-label="目标时长（秒）" /></div>
      <el-input v-model="item.prompt" type="textarea" :rows="4" aria-label="制作包生成提示词" />
      <div class="package-actions"><el-button :disabled="busy" @click="save({...item,duration:item.target_duration},'update')">保存本包内容</el-button><el-button :disabled="busy || index === 0" @click="move(index,-1)">上移</el-button><el-button :disabled="busy || index === state.items.length - 1" @click="move(index,1)">下移</el-button><el-button :disabled="busy" @click="emit('edit',item.id)">打开本包原生编辑</el-button></div>
      <p>图片、视频与声音的版本采用仍在该原生卡片进行，保存包内容不会切换已采用资源。未保存内容请先保存，再刷新或重排。</p>
    </article>
  </section>
</template>
<script setup>
import {ref,onMounted} from 'vue'
import {ElMessageBox} from 'element-plus'
import request from '@/utils/request'
const props=defineProps({episodeId:{type:[Number,String],required:true},appendPackage:{type:Function,required:true}}),emit=defineEmits(['changed','edit'])
const state=ref(null),busy=ref(false),notice=ref(''),draft=ref({title:'新制作包',prompt:'',creation_mode:'classic',duration:5}),appendBrief=ref(''),appendCount=ref(1)
const savedForms=new Map(),form=item=>JSON.stringify([item.title,item.prompt,item.creation_mode,item.target_duration]),hasDirty=()=>state.value?.items.some(item=>savedForms.get(item.id)!==form(item))
async function refresh(force=false){if(!force&&hasDirty()){try{await ElMessageBox.confirm('刷新会丢弃尚未保存的制作包修改，是否继续？','刷新制作包',{confirmButtonText:'丢弃修改并刷新',cancelButtonText:'继续编辑',type:'warning'})}catch(error){return}}busy.value=true;notice.value='';try{const data=await request.get('/muse/packages/episodes/'+props.episodeId);if(!data||typeof data.database_id!=='string'||typeof data.snapshot!=='string'||!Array.isArray(data.items))throw Error('invalid package response');state.value=data;savedForms.clear();for(const item of data.items)savedForms.set(item.id,form(item))}catch(error){notice.value='无法刷新制作包，已显示的内容仍保留，请重试读取。'}finally{busy.value=false}}
async function operation(body){if(!state.value?.database_id)throw Error('package database unavailable');const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(body))),fingerprint=[...new Uint8Array(digest)].map(value=>value.toString(16).padStart(2,'0')).join(''),key='muse-package:'+state.value.database_id+':'+fingerprint,old=localStorage.getItem(key);if(old)return old;const id=crypto.randomUUID();localStorage.setItem(key,id);if(localStorage.getItem(key)!==id)throw Error('package operation not saved');return id}
async function apply(body){if(busy.value||!state.value)return;if(body.kind!=='update'&&hasDirty()){notice.value='请先保存已修改的包，再追加或重排。';return}busy.value=true;notice.value='';try{const input={...body,database_id:state.value.database_id,expected_snapshot:state.value.snapshot},operation_id=await operation(input),result=await request.post('/muse/packages/episodes/'+props.episodeId,{...input,operation_id});if(result.replayed){notice.value='已读取原保存回执，没有覆盖之后的编辑。请刷新核对当前内容。';return}if(body.kind==='update'){state.value.snapshot=result.current_snapshot;const item=state.value.items.find(item=>item.id===body.package_id);savedForms.set(item.id,form(item))}else{await refresh(true);if(body.kind==='create')draft.value={title:'新制作包 '+(state.value.items.length+1),prompt:'',creation_mode:'classic',duration:5}}emit('changed');notice.value='制作包已保存，未调用供应商生成；其他表单修改仍需单独保存。'}catch(error){notice.value='保存未确认或内容已变化。请保留原操作并刷新核对，不要修改标识盲目重发。'}finally{busy.value=false}}
async function save(item,kind){await apply({kind,package_id:kind==='update'?item.id:undefined,title:item.title,prompt:item.prompt,duration:item.duration,creation_mode:item.creation_mode})}
async function move(index,direction){const ids=state.value.items.map(item=>item.id);[ids[index],ids[index+direction]]=[ids[index+direction],ids[index]];await apply({kind:'reorder',ids})}
async function append(){if(busy.value||!state.value)return;if(hasDirty()){notice.value='请先保存已修改的包，再生成续包。';return}try{await ElMessageBox.confirm('AI 续包会调用文本模型并可能计费，只追加新包提示词，原有包和采用版本会保留。是否继续？','AI 续包',{confirmButtonText:'生成并追加',cancelButtonText:'取消',type:'warning'})}catch(error){return}const options={mode:'append',expected_package_snapshot:state.value.snapshot,expected_package_database_id:state.value.database_id,append_brief:appendBrief.value,storyboard_count:appendCount.value};busy.value=true;notice.value='';try{await props.appendPackage(options);await refresh(true);emit('changed');notice.value='已读取续包后的实际记录。若原任务未确认，请在生成提交记录核对，不能直接换标识重发。'}catch(error){notice.value='续包结果未确认，请检查原生成提交记录；旧包保持原状。'}finally{busy.value=false}}
onMounted(()=>{void refresh()})
</script>
<style scoped>
.muse-packages { display:grid; gap:14px; }
.muse-packages p { line-height:1.65; overflow-wrap:anywhere; }
.muse-packages article { padding:14px; border:1px solid var(--el-border-color); border-radius:8px; min-width:0; }
.muse-packages h3 { font-weight:500; margin-top:0; }
.package-fields,.package-actions { display:flex; gap:8px; flex-wrap:wrap; margin:10px 0; }
.package-fields :deep(.el-input) { flex:1 1 180px; }
.package-fields :deep(.el-select) { flex:1 1 160px; }
@media (pointer:coarse) { .muse-packages :deep(input),.muse-packages :deep(textarea) { font-size:16px; } }
</style>

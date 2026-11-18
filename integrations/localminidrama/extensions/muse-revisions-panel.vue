<template>
  <div class="muse-revisions">
    <p>查看本项目的内容编辑与媒体引用变更。恢复仅处理白名单内容字段；媒体版本请使用各自历史采用入口，不会重新生成。</p>
    <div class="revision-actions"><el-select v-model="selection" placeholder="选择业务对象" @change="selectEntity"><el-option v-for="item in entities" :key="item.kind + ':' + item.id" :value="item.kind + ':' + item.id" :label="kindLabels[item.kind] + ' · ' + item.name" /></el-select><el-button :loading="busy" @click="refresh">刷新当前版本</el-button></div>
    <p v-if="notice" role="status">{{ notice }}</p>
    <p v-if="history">当前内容版本：{{ frozenRevision }}。{{ history.deleted ? '对象已删除，仅可查看记录，不能在此重新创建。' : '' }}</p>
    <el-alert v-if="staleRead" type="warning" :closable="false" title="读取后内容已变化，请刷新当前版本再选择恢复，避免覆盖其他编辑。" />
    <el-collapse>
      <el-collapse-item v-for="row in history?.items || []" :key="row.id" :name="row.id" :title="'版本 ' + row.id + ' · ' + row.recorded_at + ' · ' + changeLabels[row.change_type]">
        <p v-if="row.change_type === 'baseline'">这是启用编辑记录时的当前快照，不代表接入前的历史操作。</p>
        <div class="revision-comparison">
          <section v-for="side in ['before','after']" :key="side"><h3>{{ side === 'before' ? '变更前' : '变更后' }}</h3>
            <p v-if="!row[side]">无内容快照</p>
            <dl v-else><div v-for="field in changedFields(row)" :key="field"><dt>{{ fieldLabels[field] || field }}{{ history.observed_fields.includes(field) ? '（仅审计）' : '' }}</dt><dd><pre>{{ show(row[side].values[field]) }}</pre></dd></div></dl>
            <p v-if="row[side]?.redacted_fields?.length">部分内容已脱敏；包含脱敏正文的版本不能自动恢复。</p>
            <el-button v-if="row[side]" :disabled="busy || staleRead || history.deleted || !restorable(row[side])" @click="restore(row,side)">{{ side === 'before' ? '恢复变更前内容' : '恢复此内容版本' }}</el-button>
          </section>
        </div>
      </el-collapse-item>
    </el-collapse>
    <el-button v-if="history?.next" :disabled="busy" @click="loadHistory(history.next)">更早记录</el-button>
    <section><h3>本项目生成记录（非费用账单）</h3><p>只统计本制作平台的生成记录，不代表供应商实际计费请求。Token 和费用未回报时显示未回报，不以时长或成功状态推算。</p>
      <div class="revision-usage"><div v-for="kind in ['image','video','audio']" :key="kind"><h4>{{ usageLabels[kind] }}</h4><p v-if="!usage || !usage[kind]?.available">尚无可读取的此类历史</p><template v-else><p>记录 {{ usage[kind].records }} · 完成 {{ usage[kind].completed }} · 失败 {{ usage[kind].failed }} · 进行中 {{ usage[kind].pending }} · 其他/未知 {{ usage[kind].unknown }}</p><p>Token：未回报 · 费用：未回报</p></template></div></div>
    </section>
  </div>
</template>
<script setup>
import {ref,onMounted} from 'vue'
import {ElMessage} from 'element-plus'
import request from '@/utils/request'
const props=defineProps({projectId:{type:[Number,String],required:true}}),emit=defineEmits(['restored'])
const entities=ref([]),selection=ref(''),history=ref(null),databaseId=ref(''),frozenRevision=ref(null),staleRead=ref(false),usage=ref(null),notice=ref(''),busy=ref(false)
const kindLabels={project:'项目',episode:'分集',character:'角色',scene:'场景',prop:'道具',storyboard:'分镜',frame_prompt:'帧提示词',episode_characters:'分集角色关联',storyboard_characters:'分镜角色库关联',storyboard_props:'分镜道具关联'},changeLabels={baseline:'接入快照',create:'创建',update:'内容或引用变更',delete:'删除'},usageLabels={image:'图片',video:'视频',audio:'独立配音'}
const fieldLabels={title:'标题',description:'描述',genre:'类型',style:'风格',tags:'标签',total_episodes:'总集数',episode_number:'集号',script_content:'剧本正文',duration:'时长',name:'名称',role:'角色定位',personality:'性格',appearance:'外观',voice_style:'声音设定',polished_prompt:'润色提示词',polished_prompt_single:'单图润色提示词',negative_prompt:'反向提示词',stages:'人生阶段造型',identity_anchors:'身份锚点',style_tokens:'风格词',color_palette:'配色',location:'地点',time:'时间',prompt:'提示词',type:'道具类型',storyboard_number:'镜号',layout_description:'画面布局',dialogue:'对白',narration:'旁白',action:'动作',atmosphere:'氛围',image_prompt:'图片提示词',video_prompt:'视频提示词',shot_type:'镜头类型',angle:'角度',movement:'运镜',emotion:'情绪',emotion_intensity:'情绪强度',segment_index:'段落索引',segment_title:'段落标题',angle_h:'水平角度',angle_v:'俯仰角度',angle_s:'景别',lighting_style:'灯光',depth_of_field:'景深',continuity_snapshot:'连戏状态',creation_mode:'创作模式',universal_segment_text:'全能片段描述',layout:'布局',thumbnail:'缩略图',metadata:'项目设置',episode_id:'所属分集',scene_id:'所属场景',characters:'角色引用',image_url:'图片地址',local_path:'图片本地路径',video_url:'视频地址',last_frame_image_url:'尾帧地址',last_frame_local_path:'尾帧路径',first_frame_image_id:'首帧版本',last_frame_image_id:'尾帧版本',audio_local_path:'对白配音版本',narration_audio_local_path:'旁白配音版本',extra_images:'其他图片版本',four_view_image_url:'四视图',ref_image:'参考图',storyboard_id:'所属分镜',frame_type:'帧类型',deleted_at:'删除时间'}
let generation=0
Object.assign(fieldLabels,{character_ids:'分集角色',character_library_ids:'分镜角色库引用',prop_ids:'分镜道具引用'})
const selected=()=>{const[kind,id]=selection.value.split(':');return {kind,entity_id:Number(id),project_id:Number(props.projectId)}}
const show=value=>value===undefined||value===null?'未设置':typeof value==='string'?value:JSON.stringify(value,null,2)
function changedFields(row){const before=row.before?.values||{},after=row.after?.values||{};return [...new Set([...Object.keys(before),...Object.keys(after)])].filter(key=>JSON.stringify(before[key])!==JSON.stringify(after[key]))}
function restorable(snapshot){return history.value.restorable_fields.length>0&&!snapshot.redacted_fields.some(field=>history.value.restorable_fields.includes(field))&&history.value.restorable_fields.every(field=>Object.hasOwn(snapshot.values,field))}
function validSnapshot(snapshot){return snapshot===null||snapshot&&typeof snapshot.values==='object'&&!Array.isArray(snapshot.values)&&Array.isArray(snapshot.redacted_fields)}
async function loadHistory(before){if(!selection.value)return;const current=++generation,target=selection.value;busy.value=true;notice.value='';try{const result=await request.get('/muse/revisions/history',{params:{...selected(),...before?{before}:{}}});if(current!==generation||target!==selection.value)return;
 if(!result||!Number.isSafeInteger(result.current_revision)||!Array.isArray(result.items)||!Array.isArray(result.restorable_fields)||!Array.isArray(result.observed_fields)||result.items.some(row=>!row||!Number.isSafeInteger(row.id)||!validSnapshot(row.before)||!validSnapshot(row.after)))throw Error('invalid revision response');
 if(before&&frozenRevision.value!==result.current_revision)staleRead.value=true;else if(!before){frozenRevision.value=result.current_revision;staleRead.value=false;}history.value=result;
 }catch(error){if(current===generation)notice.value='无法更新编辑记录，请重试；现有内容和记录仍保留。'}finally{if(current===generation)busy.value=false}}
function selectEntity(){history.value=null;frozenRevision.value=null;staleRead.value=false;void loadHistory()}
async function refresh(){busy.value=true;notice.value='';try{const [list,records]=await Promise.all([request.get('/muse/revisions/entities',{params:{project_id:props.projectId}}),request.get('/muse/revisions/usage',{params:{project_id:props.projectId}})]);if(!list||!Array.isArray(list.items)||typeof list.database_id!=='string'||!records||records.coverage!=='native-generation-records')throw Error('invalid revision response');entities.value=list.items;databaseId.value=list.database_id;usage.value=records;if(!selection.value)selection.value=list.items[0]?list.items[0].kind+':'+list.items[0].id:'';await loadHistory()}catch(error){notice.value='无法更新本项目记录，请重试。'}finally{busy.value=false}}
async function operation(input){if(!databaseId.value)throw Error('revision owner unavailable');const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(input))),fingerprint=[...new Uint8Array(bytes)].map(value=>value.toString(16).padStart(2,'0')).join(''),key='muse-revision:'+databaseId.value+':'+fingerprint,old=localStorage.getItem(key);if(old)return old;const id=crypto.randomUUID();localStorage.setItem(key,id);if(localStorage.getItem(key)!==id)throw Error('revision operation was not retained');return id}
async function restore(row,side){if(busy.value||staleRead.value||history.value?.deleted)return;const input={...selected(),database_id:databaseId.value,revision_id:row.id,expected_revision:frozenRevision.value,side};busy.value=true;notice.value='';try{const result=await request.post('/muse/revisions/restore',{...input,operation_id:await operation(input)});ElMessage.success(result.replayed?'原恢复操作已记录，已刷新当前版本':result.changed?'已恢复内容并新增版本记录':'内容相同，无需改写');await loadHistory();emit('restored')}catch(error){notice.value='恢复未确认，当前内容可能已变化。请刷新记录后重新核对，不要改用新操作标识重发。'}finally{busy.value=false}}
onMounted(()=>{void refresh()})
</script>
<style scoped>
.muse-revisions { display:grid; gap:12px; }
.muse-revisions p { margin:8px 0; line-height:1.65; overflow-wrap:anywhere; }
.revision-actions { display:flex; flex-wrap:wrap; gap:10px; }
.revision-actions :deep(.el-select) { flex:1 1 240px; min-width:0; }
.revision-comparison { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:16px; }
.muse-revisions h3,.muse-revisions h4 { font-weight:500; }
.revision-comparison dl { margin:0; }
.revision-comparison dt { margin-top:12px; }
.revision-comparison dd { margin:6px 0 12px; }
.revision-comparison pre { font:inherit; white-space:pre-wrap; overflow-wrap:anywhere; max-height:260px; overflow:auto; padding:8px; background:var(--el-fill-color-light); border-radius:6px; }
.revision-usage { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:12px; }
@media (max-width:720px) { .revision-comparison,.revision-usage { grid-template-columns:minmax(0,1fr); } }
@media (pointer:coarse) { .muse-revisions :deep(.el-input__inner) { font-size:16px; } }
</style>

/** Organize native storyboard cards as ordered episode production packages. */
import {existsSync,readFileSync} from 'node:fs'
import {createHash} from 'node:crypto'
import {resolve} from 'node:path'
function replace(source,before,after,file){if(source.split(before).length!==2)throw Error(`Muse packages patch does not match pinned source: ${file}`);return source.replace(before,after)}
/**
 * Plan native-card package organization and additive AI generation after admission.
 * @param root - Pinned upstream source checkout.
 * @param readSource - Latest staged compatibility replacements.
 * @returns New owned files and precise changes without writing runtime files.
 */
export function planMuseEpisodePackages(root,readSource=path=>readFileSync(path,'utf8')){
 const changes=[];for(const[owned,path]of [['muse-episode-packages.cjs','backend-node/src/services/museEpisodePackages.js'],['muse-episode-packages-panel.vue','frontweb/src/components/MuseEpisodePackagesPanel.vue']]){const target=resolve(root,path);if(existsSync(target))throw Error(`Muse packages owned file already exists: ${path}`);changes.push([target,readFileSync(new URL('../extensions/'+owned,import.meta.url),'utf8').replaceAll('\r\n','\n')]);}
 const patch=(file,fn)=>{const path=resolve(root,file);changes.push([path,fn(readSource(path).replaceAll('\r\n','\n'),file)])};
 patch('backend-node/src/routes/index.js',(source,file)=>{if(source.includes("require('../services/museEpisodePackages')"))throw Error(`Muse packages patch does not match pinned source: ${file}`);return replace(source,'  const r = express.Router();',"  const r = express.Router();\n  require('../services/museEpisodePackages').register(r, db, cfg, log);",file)});
 patch('backend-node/src/routes/drama.js',(source,file)=>replace(source,'        universal_omni_storyboard: body.universal_omni_storyboard,','        universal_omni_storyboard: body.universal_omni_storyboard,\n        mode: body.mode, expected_package_snapshot: body.expected_package_snapshot, expected_package_database_id: body.expected_package_database_id, append_brief: body.append_brief,',file));
 patch('backend-node/src/services/dramaService.js',(source,file)=>{
  source=replace(source,'const { model, style, storyboard_count, video_duration, aspect_ratio, include_narration, universal_omni_storyboard } = options || {};','const { model, style, storyboard_count, video_duration, aspect_ratio, include_narration, universal_omni_storyboard, mode, expected_package_snapshot, expected_package_database_id, append_brief } = options || {};',file);
  return replace(source,'    universal_omni_storyboard\n  );','    universal_omni_storyboard,\n    { mode, expected_package_snapshot, expected_package_database_id, append_brief }\n  );',file);
 });
 patch('backend-node/src/services/episodeStoryboardService.js',(source,file)=>{
  source=replace(source,'targetClipDurationSec = null, expectedState) {','targetClipDurationSec = null, expectedState, generationMode = \'replace\') {',file);
  source=replace(source,'      universalOmni: !!universalOmni,','      museAppend: generationMode === \'append\',\n      universalOmni: !!universalOmni,',file);
  source=replace(source,"    db.prepare('UPDATE storyboards SET deleted_at = ? WHERE episode_id = ? AND deleted_at IS NULL').run(new Date().toISOString(), Number(episodeId))",`    if (deriveOpts.museAppend) {
      const start = db.prepare('SELECT MAX(storyboard_number) AS maximum FROM storyboards WHERE episode_id=? AND deleted_at IS NULL').get(Number(episodeId)).maximum || 0
      prepared.sort((left,right) => left.storyboard_number - right.storyboard_number).forEach((item,index) => { item.storyboard_number = start + index + 1 })
    } else db.prepare('UPDATE storyboards SET deleted_at = ? WHERE episode_id = ? AND deleted_at IS NULL').run(new Date().toISOString(), Number(episodeId))`,file);
  source=replace(source,'const totalDuration = saved.reduce((sum, sb) => sum + (Number(sb.duration) || 0), 0)',"const totalDuration = db.prepare('SELECT duration FROM storyboards WHERE episode_id=? AND deleted_at IS NULL').all(episodeIdNum).reduce((sum, sb) => sum + (Number(sb.duration) || 0), 0)",file);
  source=replace(source,'duration_minutes: durationMinutes, truncated: false,','duration_minutes: durationMinutes, truncated: false, generation_mode: generationMode,',file);
  source=replace(source,'function generateStoryboard(db, log, episodeId, model, style, storyboardCount, videoDuration, aspectRatio, includeNarration, universalOmni) {','function generateStoryboard(db, log, episodeId, model, style, storyboardCount, videoDuration, aspectRatio, includeNarration, universalOmni, packageOptions = {}) {',file);
  source=replace(source,'  const expectedState = db.transaction(() => storyboardReplacementState(db, Number(episodeId))).deferred();',`  const expectedState = db.transaction(() => storyboardReplacementState(db, Number(episodeId))).deferred();
  const packageGeneration = require('./museEpisodePackages').prepareGeneration(db, cfg, episodeId, packageOptions, expectedState, storyboardCount);`,file);
  source=replace(source,'  const wantNarration = includeNarration === true',`  if (packageGeneration.mode === 'append') userPrompt += packageGeneration.instructions;

  const wantNarration = includeNarration === true`,file);
  source=replace(source,"  const task = taskService.createTask(db, log, 'storyboard_generation', String(episodeId));", "  if (packageGeneration.mode === 'append') systemPrompt += '\\n【追加制作包模式】只输出续写要求中的新包，禁止重建、重复或修改已存在的包。每条独立提示词对应一包，包内可包含子镜头；每包保持单次视频片段的时长范围，不把整集时长塞入单包。新包局部 shot_number 从1连续开始。';\n\n  const task = taskService.createTask(db, log, 'storyboard_generation', String(episodeId));",file);
  source=replace(source,'      expectedState\n    );','      expectedState,\n      packageGeneration.mode\n    );',file);
  return source+'\nmodule.exports.musePackageInputSnapshot = storyboardReplacementState;\n';
 });
 patch('frontweb/src/views/FilmCreate.vue',(source,file)=>{
  source=replace(source,'<script setup>\n',"<script setup>\nimport MuseEpisodePackagesPanel from '@/components/MuseEpisodePackagesPanel.vue'\nconst musePackagesVisible=ref(false)\nasync function museEditPackage(id) { await loadDrama(); const card=storyboards.value.find(item=>item.id===id); if(!card) { ElMessage.error('制作包已变化，请刷新当前集'); return } musePackagesVisible.value=false; await onOpenSbPromptDialog(card) }\n",file);
  source=replace(source,'        <div class="header-actions">','        <div class="header-actions">\n          <el-button :disabled="!currentEpisodeId" @click="musePackagesVisible=true">本集制作包</el-button>',file);
  source=replace(source,"{{ storyboards.length > 0 ? '重新生成分镜' : 'AI 生成分镜' }}","{{ storyboards.length > 0 ? 'AI 重建本集（替换旧包）' : 'AI 生成本集制作包' }}",file);
  source=replace(source,'            添加一个分镜','            新增或续写制作包',file);
  source=replace(source,'async function onGenerateStoryboard() {',`async function onGenerateStoryboard(options = {}) {
  const generationMode = options?.mode === 'append' ? 'append' : 'replace'
  if (generationMode === 'replace' && storyboards.value.length) {
    try { await ElMessageBox.confirm('重建会替换本集现有制作包。若要延长本集或保留旧包，请取消并使用「本集制作包」里的 AI 续包。','替换本集制作包',{confirmButtonText:'确认重建替换',cancelButtonText:'保留现有包',type:'warning'}) } catch (error) { return }
  }`,file);
  const generationFrom=source.indexOf('async function onGenerateStoryboard(options = {}) {'),generationTo=source.indexOf('async function onAddSingleStoryboard(){',generationFrom);let generation=source.slice(generationFrom,generationTo);
  generation=replace(generation,'      storyboard_count: getStoryboardCountForApi(),','      mode: generationMode, expected_package_snapshot: options.expected_package_snapshot, expected_package_database_id: options.expected_package_database_id, append_brief: options.append_brief,\n      storyboard_count: options.storyboard_count ?? getStoryboardCountForApi(),',file);
  generation=replace(generation,'      video_duration: getVideoDurationForApi(),',"      video_duration: generationMode === 'append' ? undefined : getVideoDurationForApi(),",file);
  generation=replace(generation,'    if (taskId) {',"    if (generationMode === 'append' && !taskId) throw new Error('续包提交未确认，请读取原生成提交记录，不要直接重发')\n    if (taskId) {",file);
  generation=replace(generation,"    storyboardsAPI.batchInferParams(epId, false).catch(() => {})","    if (generationMode !== 'append') storyboardsAPI.batchInferParams(epId, false).catch(() => {})",file);
  generation=replace(generation,'    const polishRes = await polishUniversalSegmentsAfterGeneration({})',"    const polishRes = generationMode === 'append' ? { polished: 0 } : await polishUniversalSegmentsAfterGeneration({})",file);
  generation=replace(generation,'      storyboardUniversalOmni.value\n        ? polishedN > 0',"      generationMode === 'append' ? '制作包已追加，旧包与采用版本已保留' : storyboardUniversalOmni.value\n        ? polishedN > 0",file);
  source=source.slice(0,generationFrom)+generation+source.slice(generationTo);
  const from=source.indexOf('async function onAddSingleStoryboard(){'),to=source.indexOf('\nasync function onDeleteSingleStoryboard(',from);if(from<0||to<0||createHash('sha256').update(source.slice(from,to)).digest('hex')!=='f7bab606db479770d46555dad1210f7d24398b5b1ba0f91dabf5a7340ca8c7c3')throw Error(`Muse packages patch does not match pinned source: ${file}`);
  source=source.slice(0,from)+"async function onAddSingleStoryboard(){ musePackagesVisible.value=true }\n"+source.slice(to);
  return replace(source,'    <!-- 图片放大预览：点击遮罩或图片关闭 -->',`    <el-dialog v-model="musePackagesVisible" title="本集制作包 · 每条提示词一个包" width="min(1100px, 94vw)" destroy-on-close :close-on-click-modal="false">
      <MuseEpisodePackagesPanel v-if="currentEpisodeId" :key="currentEpisodeId" :episode-id="currentEpisodeId" :append-package="onGenerateStoryboard" @changed="loadDrama" @edit="museEditPackage" />
    </el-dialog>

    <!-- 图片放大预览：点击遮罩或图片关闭 -->`,file);
 });
 return changes;
}

/** Add real account-owned Fal video enhancement after the audited audio and revision planners. */
import {existsSync,readFileSync} from 'node:fs'
import {resolve} from 'node:path'

function replace(source,before,after,file,count=1){if(source.split(before).length!==count+1)throw Error(`Muse postproduction patch does not match pinned source: ${file}`);return source.replaceAll(before,after)}

/**
 * Plan private configuration, durable queue tasks, verified derived video versions and the production dialog.
 * @param root - Pinned upstream checkout.
 * @param readSource - Latest staged source after `planMuseRevisions`.
 * @returns Owned files and narrowly matched upstream replacements, without touching runtime data.
 */
export function planPostproduction(root,readSource=path=>readFileSync(path,'utf8')){
 const pending=[]
 for(const[owned,file]of [['muse-postproduction-fal.cjs','backend-node/src/services/musePostproductionFal.js'],
  ['muse-postproduction-segments.cjs','backend-node/src/services/musePostproductionSegments.js'],
  ['muse-postproduction-media.cjs','backend-node/src/services/musePostproductionMedia.js'],['muse-postproduction.cjs','backend-node/src/services/musePostproduction.js'],
  ['muse-postproduction-routes.cjs','backend-node/src/routes/musePostproductionRoutes.js'],['muse-postproduction-panel.vue','frontweb/src/components/MusePostproductionPanel.vue']]){
  const path=resolve(root,file);if(existsSync(path))throw Error(`Muse postproduction owned file already exists: ${file}`)
  pending.push([path,readFileSync(new URL('../extensions/'+owned,import.meta.url),'utf8').replaceAll('\r\n','\n')])
 }
 const patch=(file,transform)=>{const path=resolve(root,file);pending.push([path,transform(readSource(path).replaceAll('\r\n','\n'),file)])}
 patch('backend-node/src/routes/index.js',(source,file)=>replace(source,'  const r = express.Router();',"  const r = express.Router();\n  require('./musePostproductionRoutes').register(r, db, cfg, log);",file))
 patch('frontweb/src/views/FilmCreate.vue',(source,file)=>{
  source=replace(source,'<script setup>\n',"<script setup>\nimport MusePostproductionPanel from '@/components/MusePostproductionPanel.vue'\nconst musePostproductionVisible=ref(false)\n",file)
  source=replace(source,'        <div class="header-actions">','        <div class="header-actions">\n          <el-button :disabled="!dramaId" @click="musePostproductionVisible=true">视频高清与去烧录字幕</el-button>',file)
  source=replace(source,'    <!-- 图片放大预览：点击遮罩或图片关闭 -->',`    <el-dialog v-model="musePostproductionVisible" title="视频高清与去烧录字幕" width="min(1060px, 94vw)" destroy-on-close :close-on-click-modal="false">
      <MusePostproductionPanel v-if="dramaId" :drama-id="dramaId" @adopted="loadDrama" />
    </el-dialog>

    <!-- 图片放大预览：点击遮罩或图片关闭 -->`,file)
  for(const[before,after]of [['>超分(首帧)','>普通放大(首帧)'],['高清放大（2x超分辨率）','普通图片放大（2x 插值，无 AI）'],['>超分\n','>普通放大\n'],
   ['超分完成，图片已更新为高清版本','普通放大完成（2x 插值），请核对图片'],["'超分辨率失败'","'普通图片放大失败'"]])source=replace(source,before,after,file)
  return source
 })
 patch('backend-node/src/routes/storyboards.js',(source,file)=>{
  source=replace(source,"baseName + '_2x' + ext","baseName + '_2x_' + require('node:crypto').randomUUID() + ext",file)
  return replace(source,"db.prepare('UPDATE storyboards SET local_path = ?, updated_at = ? WHERE id = ?').run(newRelPath, now, id);",
   "db.prepare('UPDATE storyboards SET local_path = ?, image_url = ?, updated_at = ? WHERE id = ?').run(newRelPath, '/static/' + newRelPath, now, id);",file)
 })
 patch('backend-node/src/services/videoService.js',(source,file)=>replace(source,'  return r ? rowToItem(r) : null;',
  "  return r ? { ...rowToItem(r), postproduction: require('./musePostproduction').generationSource(db, r.id) } : null;",file))
 patch('backend-node/src/routes/aiConfig.js',(source,file)=>{
  source=replace(source,"const response = require('../response');",`const response = require('../response');
function publicMusePostConfig(config) {
  if (config.service_type !== 'muse_postproduction') return config;
  const { api_key: privateKey, ...visible } = config;
  return { ...visible, key_configured: !!privateKey };
}`,file)
  source=replace(source,'response.success(res, list);','response.success(res, list.map(publicMusePostConfig));',file)
  source=replace(source,'response.success(res, config);','response.success(res, publicMusePostConfig(config));',file,2)
  return replace(source,'response.created(res, config);','response.created(res, publicMusePostConfig(config));',file)
 })
 return pending
}

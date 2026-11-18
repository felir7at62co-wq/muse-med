/** Install append-only, redacted business revisions after the production studio corrections. */
import {existsSync,readFileSync} from 'node:fs'
import {resolve} from 'node:path'
function replace(source,before,after,file){if(source.split(before).length!==2)throw Error(`Muse revisions patch does not match pinned source: ${file}`);return source.replace(before,after)}
/**
 * Plan audited content writes and a version-checked restore dialog without modifying runtime data.
 * @param root - Checkout of the pinned studio source.
 * @param readSource - Latest staged source after the audio and prefix planners.
 * @returns Owned source files and precise upstream replacements.
 */
export function planMuseRevisions(root,readSource=path=>readFileSync(path,'utf8')){
 const pending=[]
 for(const[owned,file]of [['muse-revisions.cjs','backend-node/src/services/museRevisions.js'],['muse-revisions-routes.cjs','backend-node/src/routes/museRevisionsRoutes.js'],['muse-revisions-panel.vue','frontweb/src/components/MuseRevisionsPanel.vue']]){
  const path=resolve(root,file);if(existsSync(path))throw Error(`Muse revisions owned file already exists: ${file}`);pending.push([path,readFileSync(new URL('../extensions/'+owned,import.meta.url),'utf8').replaceAll('\r\n','\n')])
 }
 const patch=(file,transform)=>{const path=resolve(root,file);pending.push([path,transform(readSource(path).replaceAll('\r\n','\n'),file)])}
 patch('backend-node/src/routes/index.js',(source,file)=>{if(source.includes("require('./museRevisionsRoutes')"))throw Error(`Muse revisions patch does not match pinned source: ${file}`);return replace(source,'  const r = express.Router();',"  const r = express.Router();\n  require('./museRevisionsRoutes').register(r, db, cfg);",file)})
 patch('frontweb/src/views/FilmCreate.vue',(source,file)=>{
  if(source.includes("import MuseRevisionsPanel"))throw Error(`Muse revisions patch does not match pinned source: ${file}`)
  source=replace(source,'<script setup>\n',"<script setup>\nimport MuseRevisionsPanel from '@/components/MuseRevisionsPanel.vue'\nconst museRevisionsVisible=ref(false)\n",file)
  source=replace(source,'        <div class="header-actions">','        <div class="header-actions">\n          <el-button :disabled="!dramaId" @click="museRevisionsVisible=true">编辑记录与恢复</el-button>',file)
  return replace(source,'    <!-- 图片放大预览：点击遮罩或图片关闭 -->',`    <el-dialog v-model="museRevisionsVisible" title="编辑记录与内容恢复" width="min(1060px, 94vw)" destroy-on-close :close-on-click-modal="false">
      <MuseRevisionsPanel v-if="dramaId" :project-id="dramaId" @restored="loadDrama" />
    </el-dialog>

    <!-- 图片放大预览：点击遮罩或图片关闭 -->`,file)
 })
 return pending
}

/** Install explicit legacy exchange import after ordinary edit CAS and video-history planners. */
import {existsSync,readFileSync} from 'node:fs'
import {resolve} from 'node:path'
function replace(source,before,after,file){if(source.split(before).length!==2)throw Error(`Muse Jubian import patch does not match pinned source: ${file}`);return source.replace(before,after)}
/**
 * Plan chunked import, source-to-native mappings and the studio migration dialog.
 * @param root - Pinned upstream checkout.
 * @param readSource - Latest staged source, including postproduction, admission, package and edit planners.
 * @returns New owned files and precise replacements without accessing project data.
 */
export function planMuseJubianImport(root,readSource=path=>readFileSync(path,'utf8')){
 const result=[];
 for(const[owned,name]of [['muse-jubian-import.cjs','backend-node/src/services/museJubianImport.js'],['muse-jubian-import-routes.cjs','backend-node/src/routes/museJubianImportRoutes.js'],['muse-jubian-import-panel.vue','frontweb/src/components/MuseJubianImportPanel.vue']]){const file=resolve(root,name);if(existsSync(file))throw Error(`Muse Jubian import owned file already exists: ${name}`);result.push([file,readFileSync(new URL('../extensions/'+owned,import.meta.url),'utf8').replaceAll('\r\n','\n')])}
 const patch=(name,fn)=>{const file=resolve(root,name);result.push([file,fn(readSource(file).replaceAll('\r\n','\n'),name)])};
 patch('backend-node/src/routes/index.js',(source,file)=>{if(source.includes("require('./museJubianImportRoutes')"))throw Error(`Muse Jubian import patch does not match pinned source: ${file}`);return replace(source,'  const r = express.Router();',"  const r = express.Router();\n  require('./museJubianImportRoutes').register(r, db, cfg);",file)});
 patch('backend-node/src/services/videoService.js',(source,file)=>replace(source,"postproduction: require('./musePostproduction').generationSource(db, r.id)","postproduction: require('./musePostproduction').generationSource(db, r.id), migration: require('./museJubianImport').generationSource(db, r.id)",file));
 patch('frontweb/src/views/FilmCreate.vue',(source,file)=>{source=replace(source,'<script setup>\n',"<script setup>\nimport MuseJubianImportPanel from '@/components/MuseJubianImportPanel.vue'\nconst museJubianImportVisible=ref(false)\n",file);source=replace(source,'        <div class="header-actions">','        <div class="header-actions">\n          <el-button @click="museJubianImportVisible=true">导入剧变迁移包</el-button>',file);return replace(source,'    <!-- 图片放大预览：点击遮罩或图片关闭 -->',`    <el-dialog v-model="museJubianImportVisible" title="导入剧变项目副本" width="min(1040px, 94vw)" destroy-on-close :close-on-click-modal="false">
      <MuseJubianImportPanel @imported="loadDrama" />
    </el-dialog>

    <!-- 图片放大预览：点击遮罩或图片关闭 -->`,file)});
 return result;
}

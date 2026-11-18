/** Durable admission for native supplier-producing studio requests. */
import {existsSync,readFileSync} from 'node:fs'
import {resolve} from 'node:path'

/** Native POST paths requiring a stable operation ID; TTS and postproduction own their reservations. */
export const museAdmissionRoutes=[
 {pattern:'^/ai-configs/test$',kind:'connection-test',label:'文本连接生成测试',configuration_only_services:['image','storyboard_image','video','tts'],configuration_only_model_pattern:'seedance|seedream|sora|kling|imagen|wanx|flux|dall.?e|agnes-(?:video|image)'},
 {pattern:'^/images$',kind:'image',label:'分镜图片'},
 {pattern:'^/videos$',kind:'video',label:'分镜视频'},
 {pattern:'^/characters/batch-generate-images$',kind:'batch',label:'批量角色图片'},
 {pattern:'^/characters/[0-9]+/(?:generate-image|generate-four-view-image)$',kind:'image',label:'角色图片'},
 {pattern:'^/characters/[0-9]+/(?:generate-prompt|extract-from-image|extract-anchors)$',kind:'text',label:'角色描述'},
 {pattern:'^/props/[0-9]+/generate$',kind:'image',label:'道具图片'},
 {pattern:'^/props/[0-9]+/(?:generate-prompt|extract-from-image)$',kind:'text',label:'道具描述'},
 {pattern:'^/scenes/generate-image$',kind:'image',label:'场景图片'},
 {pattern:'^/scenes/[0-9]+/generate-four-view-image$',kind:'image',label:'场景四视图'},
 {pattern:'^/scenes/[0-9]+/(?:generate-prompt|extract-from-image)$',kind:'text',label:'场景描述'},
 {pattern:'^/generation/(?:characters|story)$',kind:'text',label:'角色与故事生成'},
 {pattern:'^/episodes/[0-9]+/storyboards$',kind:'text',label:'分镜生成'},
 {pattern:'^/episodes/[0-9]+/props/extract$',kind:'text',label:'道具提取'},
 {pattern:'^/images/episode/[0-9]+/backgrounds/extract$',kind:'text',label:'场景提取'},
 {pattern:'^/extract-description-from-image$',kind:'text',label:'图片描述提取'},
 {pattern:'^/storyboards/[0-9]+/(?:frame-prompt|polish-prompt|universal-segment-prompt|regenerate-layout-description)$',kind:'text',label:'分镜提示词'},
 {pattern:'^/storyboards/[0-9]+/(?:universal-segment-polish-stream|classic-video-prompt-polish-stream|universal-segment-prompt-stream)$',kind:'stream',label:'分镜流式文本'},
 {pattern:'^/dramas/import-novel$',kind:'novel',label:'小说 AI 改写'},
]
function replace(source,before,after,file){if(source.split(before).length!==2)throw Error(`Muse admission patch does not match pinned source: ${file}`);return source.replace(before,after)}
/**
 * Plan shared route matching, durable reservations and database-scoped browser operation identities.
 * @param root - Pinned upstream checkout.
 * @param readSource - Latest staged source after revisions and postproduction.
 * @returns Precise replacements without modifying source or live databases.
 */
export function planMuseAdmission(root,readSource=path=>readFileSync(path,'utf8')){
 const result=[];
 for(const[owned,path]of [['muse-admission.cjs','backend-node/src/services/museAdmission.js'],['muse-admission-client.js','frontweb/src/utils/museAdmission.js'],['muse-admission-panel.vue','frontweb/src/components/MuseAdmissionPanel.vue']]){
  const file=resolve(root,path);if(existsSync(file))throw Error(`Muse admission owned file already exists: ${path}`);result.push([file,readFileSync(new URL('../extensions/'+owned,import.meta.url),'utf8').replaceAll('\r\n','\n')]);
 }
 for(const path of ['backend-node/src/services/museAdmissionCatalog.json','frontweb/src/utils/museAdmissionCatalog.json']){const file=resolve(root,path);if(existsSync(file))throw Error(`Muse admission catalog already exists: ${path}`);result.push([file,JSON.stringify(museAdmissionRoutes,null,2)+'\n']);}
 const patch=(file,fn)=>{const path=resolve(root,file);result.push([path,fn(readSource(path).replaceAll('\r\n','\n'),file)])};
 patch('backend-node/src/routes/index.js',(source,file)=>{
  if(source.includes("require('../services/museAdmission')"))throw Error(`Muse admission patch does not match pinned source: ${file}`);
  source=replace(source,'  const r = express.Router();',"  const r = express.Router();\n  const museAdmission = require('../services/museAdmission').register(r, db, cfg);",file);
  source=replace(source,"r.post('/dramas/import-novel', importUpload.single('file'), async", "r.post('/dramas/import-novel', importUpload.single('file'), museAdmission.novel, async",file);
  return replace(source,"  r.get('/storyboards/episode/:episode_id/generate', storyboards.episodeStoryboardsGenerate);", "  r.get('/storyboards/episode/:episode_id/generate', (req, res) => {\n    res.setHeader('Allow', 'POST');\n    response.error(res, 405, 'generation_requires_post', '请使用 POST /episodes/:id/storyboards 并提供稳定的 x-muse-operation-id；GET 不执行付费生成。');\n  });",file);
 });
 patch('frontweb/src/utils/request.js',(source,file)=>{
  if(source.includes('prepareMuseAdmission'))throw Error(`Muse admission patch does not match pinned source: ${file}`);
  source="import { prepareMuseAdmission } from './museAdmission'\n"+source;
  return replace(source,'request.interceptors.response.use(',"request.interceptors.request.use(async config => {\n  config.headers = { ...config.headers, ...await prepareMuseAdmission(config.url, config.method, config.data) }\n  return config\n})\n\nrequest.interceptors.response.use(",file);
 });
 patch('backend-node/src/services/aiClient.js',(source,file)=>{
  for(const signature of ['function postJSONNonStream(url, headers, body, timeoutMs = 120000) {','function postJSONWithTimeout(url, headers, body, timeoutMs = 600000) {','function postJSONStream(url, headers, body, silenceTimeoutMs = 60000, onProgress = null) {'])source=replace(source,signature,signature+"\n  const museObserveUsage = require('./museAdmission').startSupplierCall();",file);
  source=replace(source,'          const json = JSON.parse(raw);','          const json = JSON.parse(raw);\n          museObserveUsage(json);',file);
  source=replace(source,'        resolve({ statusCode: res.statusCode || 0, raw });',"        try { museObserveUsage(JSON.parse(raw)); } catch (error) { if (error.code === 'supplier_usage_not_saved') return reject(error); }\n        resolve({ statusCode: res.statusCode || 0, raw });",file);
  return replace(source,'            const evt = JSON.parse(data);','            const evt = JSON.parse(data);\n            museObserveUsage(evt);',file);
 });
 patch('frontweb/src/api/storyboards.js',(source,file)=>{
  source="import { prepareMuseAdmission } from '@/utils/museAdmission'\n"+source;
  source=replace(source,"  return fetch(museStudioPath(url), {\n    method: 'POST',\n    headers: { 'Content-Type': 'application/json', Accept: 'application/x-ndjson' },", "  return prepareMuseAdmission(url, 'POST', body).then(admissionHeaders => fetch(museStudioPath(url), {\n    method: 'POST',\n    headers: { 'Content-Type': 'application/json', Accept: 'application/x-ndjson', ...admissionHeaders },",file);
  return replace(source,"  }).then(async (res) => {","  })).then(async (res) => {",file);
 });
 patch('frontweb/src/views/FilmCreate.vue',(source,file)=>{
  if(source.includes('import MuseAdmissionPanel'))throw Error(`Muse admission patch does not match pinned source: ${file}`);
  source=replace(source,'<script setup>\n',"<script setup>\nimport MuseAdmissionPanel from '@/components/MuseAdmissionPanel.vue'\nconst museAdmissionVisible=ref(false)\n",file);
  source=replace(source,'        <div class="header-actions">','        <div class="header-actions">\n          <el-button @click="museAdmissionVisible=true">生成提交记录</el-button>',file);
  return replace(source,'    <!-- 图片放大预览：点击遮罩或图片关闭 -->',`    <el-dialog v-model="museAdmissionVisible" title="生成提交记录与结果核对" width="min(1020px, 94vw)" destroy-on-close :close-on-click-modal="false">
      <MuseAdmissionPanel />
    </el-dialog>

    <!-- 图片放大预览：点击遮罩或图片关闭 -->`,file);
 });
 return result;
}

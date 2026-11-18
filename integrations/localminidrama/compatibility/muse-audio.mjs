/** Install durable audio operations and explicit voice versions after the studio prefix corrections. */
import {createHash} from 'node:crypto'
import {existsSync,readFileSync} from 'node:fs'
import {resolve} from 'node:path'

function replace(source,before,after,file){if(source.split(before).length!==2)throw Error(`Muse audio patch does not match pinned source: ${file}`);return source.replace(before,after)}
function block(source,start,end,sha,after,file){const a=source.indexOf(start),b=source.indexOf(end,a);if(a<0||b<0||createHash('sha256').update(source.slice(a,b)).digest('hex')!==sha)throw Error(`Muse audio patch does not match pinned source: ${file}`);return source.slice(0,a)+after+source.slice(b)}

/**
 * Plan audio persistence, native-client reuse, explicit video binding and the complete production dialog.
 * @param root - Pinned upstream checkout.
 * @param readSource - Staged source after `planCloudPrefix` and the existing backend compatibility planners.
 * @returns Complete replacements without modifying the checkout or its runtime database.
 */
export function planMuseAudio(root,readSource=path=>readFileSync(path,'utf8')){
 const pending=[]
 const patch=(file,transform)=>{const path=resolve(root,file);pending.push([path,transform(readSource(path).replaceAll('\r\n','\n'),file)])}
 for(const [owned,destination]of [['muse-audio.cjs','backend-node/src/services/museAudioService.js'],['muse-voice-inputs.cjs','backend-node/src/services/museVoiceInputs.js'],['muse-audio-routes.cjs','backend-node/src/routes/museAudioRoutes.js'],['muse-audio-panel.vue','frontweb/src/components/MuseAudioPanel.vue']]){
  const path=resolve(root,destination);if(existsSync(path))throw Error(`Muse audio owned file already exists: ${destination}`)
  pending.push([path,readFileSync(new URL('../extensions/'+owned,import.meta.url),'utf8').replaceAll('\r\n','\n')])
 }
 patch('backend-node/src/services/ttsService.js',(source,file)=>{
  source=replace(source,"    console.log('==c sxy synthesizeWithOpenai', text, voiceId, ttsConfig.api_key, ttsConfig.base_url, ttsModel, finalSpeed);\n",'',file)
  source=replace(source,"  try { const cs = require('./cloudService'); cs.reportUsage('tts', ttsModel || '', '', 0); } catch (_) {}\n",'',file)
  source=replace(source,'async function synthesizeWithMinimax(text, voiceId, apiKey, groupId, model) {','async function synthesizeWithMinimax(text, voiceId, apiKey, groupId, model, baseUrl, timeoutMs = 120000) {',file)
  source=replace(source,'    stream: false,','    stream: false,\n    output_format: \'hex\',',file)
  source=replace(source,'  const url = `https://api.minimax.chat/v1/t2a_v2?GroupId=${groupId}`;',"  const url = (baseUrl || 'https://api.minimax.io').replace(/\\/+$/, '').replace(/\\/v1$/, '') + '/v1/t2a_v2';",file)
  source=replace(source,'        const data = JSON.parse(Buffer.concat(chunks).toString());',`        let data;
        try { data = JSON.parse(Buffer.concat(chunks).toString()); }
        catch (error) { reject(new Error('MiniMax TTS returned invalid JSON')); return; }`,file)
  source=replace(source,"        if (!audioHex) { reject(new Error('MiniMax TTS 未返回音频')); return; }","        if (typeof audioHex !== 'string' || !/^(?:[a-f0-9]{2})+$/i.test(audioHex)) { reject(new Error('MiniMax TTS 未返回有效音频')); return; }",file)
  source=replace(source,"    req.on('error', reject);",`    const timer = setTimeout(() => { req.destroy(); reject(new Error('MiniMax TTS request timed out')); }, timeoutMs);
    req.on('error', (error) => { clearTimeout(timer); reject(error); });
    req.on('close', () => clearTimeout(timer));`,file)
  source=replace(source,'async function synthesizeWithOpenai(text, voice, apiKey, baseUrl, model, speed) {','async function synthesizeWithOpenai(text, voice, apiKey, baseUrl, model, speed, timeoutMs = 120000) {',file)
  source=replace(source,"reject(new Error('OpenAI TTS 请求超时')); }, 120000);","reject(new Error('OpenAI TTS 请求超时')); }, timeoutMs);",file)
  return replace(source,'module.exports = { synthesize };','module.exports = { synthesize, synthesizeWithMinimax, synthesizeWithOpenai };',file)
 })
 patch('backend-node/src/routes/audio.js',(source,file)=>replace(source,'module.exports = routes;',"module.exports = require('./museAudioRoutes');",file))
 patch('backend-node/src/routes/index.js',(source,file)=>replace(source,"  const audio = audioRoutes(db, log, cfg);","  const audio = audioRoutes(db, log, cfg);\n  audio.register(r);",file))
 patch('backend-node/src/services/videoClient.js',(source,file)=>{
  source=block(source,'  // Seedance 2.0 自动注入角色音色参考',"  log.info('[视频] 路由协议'",
  '9ae8bb71ffb3415e88440871b90135bc4fd8005fd4953814489a76624f23661f',
  "  if (db) opts = require('./museAudioService').resolveVideoVoice(db, opts, protocol, require('../config').loadConfig());\n  else if (opts.voice_reference_url || opts.formal_voice_references) throw new Error('formal_voice_binding_required');\n",file)
  source=block(source,'  // Seedance 2.0 音色参考：本路径仅','  // ===== 全能模式',
   '08426702ee234dcca9f25b704bb3cab35d9c2a1bcd9ceb63ae3bbd39ca19b2f7',
   "  require('./museVoiceInputs').appendVoiceInputs(body, opts, config, finalModel);\n\n",file)
  return replace(source,'      // 关键：把 callVideoApi 里自动注入的 Seedance 2.0 音色参考音频透传下去\n      voice_reference_url: opts.voice_reference_url,',
   '      formal_voice_references: opts.formal_voice_references,\n      voice_reference_url: opts.voice_reference_url,',file)
 })
 patch('frontweb/src/views/FilmCreate.vue',(source,file)=>{
  source=replace(source,'<script setup>\n',`<script setup>
import MuseAudioPanel from '@/components/MuseAudioPanel.vue'
const museAudioVisible = ref(false), museAudioTargetId = ref(0), museAudioTargetKind = ref('dialogue')
function openMuseAudio(sb,kind='dialogue') { museAudioTargetId.value=sb?.id||0; museAudioTargetKind.value=kind; museAudioVisible.value=true }
`,file)
  source=replace(source,'        <div class="header-actions">','        <div class="header-actions">\n          <el-button :disabled="!dramaId" @click="openMuseAudio()">声音与配音</el-button>',file)
  source=replace(source,'    <!-- 图片放大预览：点击遮罩或图片关闭 -->',`    <el-dialog v-model="museAudioVisible" title="声音与配音" width="min(960px, 94vw)" destroy-on-close :close-on-click-modal="false">
      <MuseAudioPanel v-if="dramaId" :drama-id="dramaId" :characters="store.characters || []" :storyboards="store.currentEpisode?.storyboards || []" :target-id="museAudioTargetId" :target-kind="museAudioTargetKind" @adopted="loadDrama" />
    </el-dialog>

    <!-- 图片放大预览：点击遮罩或图片关闭 -->`,file)
  source=block(source,'                    <!-- Seedance 2.0 音色参考','                    <div v-if="getCharAffectedStoryboards',
   '474459ea6ddc26beb03f41256d057145bb414223197b89340f838a039c521fbc',
   '                    <el-button size="small" plain @click="openMuseAudio()">正式声音参考与人生时期</el-button>\n',file)
  for(const [name,sha,kind]of [['onTtsSbDialogue','870cc853a5763f22bc360c6eac19075b9486f060150ade561f39388826585c3b','dialogue'],['onTtsSbNarration','133732ddc32f602e9f562b83d09bb9beda00a6f125589917774e783721960314','narration']]){
   const start=source.indexOf('async function '+name+'('),end=source.indexOf('\n}',start)+2
   if(start<0||end<2||createHash('sha256').update(source.slice(start,end)).digest('hex')!==sha)throw Error(`Muse audio patch does not match pinned source: ${name}`)
   source=source.slice(0,start)+`async function ${name}(sb) { openMuseAudio(sb,'${kind}') }`+source.slice(end)
  }
  return source
 })
 return pending
}

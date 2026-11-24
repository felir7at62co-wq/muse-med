/** Install the documented LibTV Agent OpenAPI without treating it as an OpenAI model endpoint. */
import {existsSync,readFileSync} from 'node:fs'
import {resolve} from 'node:path'
const replace=(text,before,after,file)=>{if(text.split(before).length!==2)throw Error('Muse LibTV patch does not match pinned source: '+file);return text.replace(before,after)}
/**
 * Plan private settings, durable Agent tasks, result import and in-app controls.
 * @param root - Fixed upstream checkout.
 * @param readSource - Sources after audio, postproduction, budget and editing planners.
 * @returns Validated replacements; no credentials, remote projects or supplier jobs are created.
 */
export function planMuseLibTv(root,readSource=path=>readFileSync(path,'utf8')){
 const out=[];
 for(const [name,destination]of [['muse-libtv.cjs','backend-node/src/services/museLibTv.js'],['muse-libtv-http.cjs','backend-node/src/services/museLibTvHttp.js'],['muse-libtv-audio.cjs','backend-node/src/services/museLibTvAudio.js'],['muse-libtv-routes.cjs','backend-node/src/routes/museLibTvRoutes.js'],['muse-libtv-panel.vue','frontweb/src/components/MuseLibTvPanel.vue']]){
  const file=resolve(root,destination);if(existsSync(file))throw Error('Muse LibTV owned file already exists: '+destination);out.push([file,readFileSync(new URL('../extensions/'+name,import.meta.url),'utf8')]);
 }
 const patch=(file,fn)=>{const target=resolve(root,file);out.push([target,fn(readSource(target).replaceAll('\r\n','\n'),file)])};
 patch('backend-node/src/routes/index.js',(text,file)=>replace(text,'  return r;',"  require('./museLibTvRoutes').register(r,db,cfg,log);\n  return r;",file));
 for(const kind of ['video','image'])patch('backend-node/src/services/'+kind+'Service.js',(text)=>text+`\nconst museLibTvOriginalGet=module.exports.getById;\nmodule.exports.getById=function(db,id){const value=museLibTvOriginalGet(db,id);return value?{...value,libtv_source:require('./museLibTv').generationOrigin(db,'${kind}',id)}:value};\n`);
 const assetFile='backend-node/src/services/assetService.js';patch(assetFile,text=>text+`\nconst museLibTvAudioOriginalGet=module.exports.getById;\nmodule.exports.getById=function(db,id){const value=museLibTvAudioOriginalGet(db,id);return value?.type==='audio'?{...value,libtv_source:require('./museLibTv').generationOrigin(db,'audio',id)}:value};\n`);
 patch('frontweb/src/views/MediaLibrary.vue',(text,file)=>{
  text=replace(text,'        <el-radio-button value="video">视频</el-radio-button>','        <el-radio-button value="video">视频</el-radio-button>\n        <el-radio-button value="audio">音频</el-radio-button>',file);
  text=replace(text,'          <img v-else :src="itemUrl(item)" class="thumb-img" />','          <div v-else-if="item.type === \'audio\'" class="thumb-audio">音频素材</div>\n          <img v-else :src="itemUrl(item)" class="thumb-img" />',file);
  text=replace(text,'        <img v-else-if="previewItem" :src="itemUrl(previewItem)" class="preview-image" />','        <audio v-else-if="previewItem?.type === \'audio\'" :src="itemUrl(previewItem)" controls preload="metadata" aria-label="音频预览" />\n        <img v-else-if="previewItem" :src="itemUrl(previewItem)" class="preview-image" />',file);
  text=replace(text,"    type: isVideo ? 'video' : 'image',","    type: item.type === 'audio' ? 'audio' : isVideo ? 'video' : 'image',",file);
  return replace(text,'<style scoped>','<style scoped>\n.thumb-audio { display: flex; align-items: center; justify-content: center; width: 100%; height: 100%; color: var(--el-text-color-regular); }',file);
 });
 for(const name of ['FilmList','FilmCreate'])patch('frontweb/src/views/'+name+'.vue',(text,file)=>{
  text=replace(text,'<script setup>\n',"<script setup>\nimport MuseLibTvPanel from '@/components/MuseLibTvPanel.vue'\nconst museLibTvVisible=ref(false)\n",file);
  text=replace(text,'        <div class="header-actions">','        <div class="header-actions">\n          <el-button @click="museLibTvVisible=true">LibTV API</el-button>\n          <el-button @click="router.push(\'/media-library\')">媒体素材</el-button>',file);
  const anchor=name==='FilmList'?'    <!-- 图片放大预览 -->':'    <!-- 图片放大预览：点击遮罩或图片关闭 -->';
  return replace(text,anchor,'    <el-dialog v-model="museLibTvVisible" title="Muse · LibTV API" width="min(1100px, 95vw)" destroy-on-close :close-on-click-modal="false"><MuseLibTvPanel/></el-dialog>\n\n'+anchor,file);
 });
 return out;
}

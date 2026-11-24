/** Audio assets retain their media type and an accessible native playback control. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {compileFunction} from 'node:vm';

const root=resolve(process.env.LOCALMINIDRAMA_SOURCE||'.local/localminidrama');
let planned;
function sourceFor(name){
 const file=resolve(root,'frontweb/src/views/'+name+'.vue');
 if(existsSync(resolve(root,'backend-node/src/services/museLibTv.js')))return readFileSync(file,'utf8');
 if(!planned){
  planned=new Map();
  for(const planner of [planMediaAdoption,planMuseBranding,planCloudPrefix,planMuseLibTv,planStudioEntry])
   for(const[path,source]of planner(root,path=>planned.get(path)??readFileSync(path,'utf8')))planned.set(path,source);
 }
 assert.ok(planned.has(file),'The real entry planners must include '+name);
 return planned.get(file);
}
function visibleTemplate(source){return source.split('<script')[0].replace(/<!--[\s\S]*?-->/g,'');}
function visibleMediaButton(source){
 const template=visibleTemplate(source);
 return [...template.matchAll(/<el-button\b([^>]*)>([\s\S]*?)<\/el-button>/g)]
  .find(([,attributes,content])=>content.trim()==='媒体素材'&&!/\b(?:v-if|v-show|disabled)\b/.test(attributes));
}
import {planMuseLibTv} from '../compatibility/muse-libtv.mjs';
import {planMediaAdoption} from '../compatibility/media-adoption.mjs';
import {planMuseBranding} from '../compatibility/muse-branding.mjs';
import {planCloudPrefix} from '../compatibility/cloud-prefix.mjs';
import {planStudioEntry} from '../compatibility/studio-entry.mjs';

function visibleMediaMenu(source){
 const blocked=attributes=>/\b(?:v-if|v-show|disabled|:disabled)\b/.test(attributes);
 for(const[,attributes,content]of visibleTemplate(source).matchAll(/<el-dropdown\b([^>]*)>([\s\S]*?)<\/el-dropdown>/g)){
  const handler=/@command="([A-Za-z_$][\w$]*)"/.exec(attributes)?.[1];
  if(!handler||blocked(attributes))continue;
  const trigger=[...content.matchAll(/<el-button\b([^>]*)>([\s\S]*?)<\/el-button>/g)]
   .find(([,attrs,text])=>!blocked(attrs)&&text.replace(/<[^>]+>/g,'').trim()==='更多');
  const item=[...content.matchAll(/<el-dropdown-item\b([^>]*)>([\s\S]*?)<\/el-dropdown-item>/g)]
   .find(([,attrs,text])=>!blocked(attrs)&&/\bcommand="media"/.test(attrs)&&text.trim()==='媒体素材');
  if(trigger&&item)return {handler,label:item[2].trim(),trigger:'更多'};
 }
}

function runMediaCommand(source,handler){
 const script=source.match(/<script\b[^>]*>([\s\S]*?)<\/script>/)?.[1]
  ?.replace(/\/\*[\s\S]*?\*\//g,'').replace(/^\s*\/\/.*$/gm,'')??'';
 const declaration=new RegExp('^function '+handler+'\\(command\\) \\{[\\s\\S]*?^\\}','m').exec(script)?.[0];
 assert.ok(declaration,'The visible menu must resolve to a real command handler');
 const selected=[],characters={value:false},noop=()=>{};
 const action=compileFunction('return '+declaration,['router','showCharLibrary','showSceneLibrary','showPropLibrary',
  'triggerImport','museLibTvVisible','showAiConfigDialog','toggleTheme'])
  ({push:path=>selected.push(path)},characters,{value:false},{value:false},noop,{value:false},{value:false},noop);
 action('media');
 assert.deepEqual(selected,['/media-library']);
 action('characters');action('unsupported-command');
 assert.equal(characters.value,true);
 assert.deepEqual(selected,['/media-library'],'Unrelated menu commands must not open media');
 return selected[0];
}

test('the companion audio library keeps audio identity and offers a labelled player',()=>{
 const source=sourceFor('MediaLibrary');
 const start=source.indexOf('function normalizeItem('),end=source.indexOf('function itemUrl(',start);
 const normalize=compileFunction(source.slice(start,end)+'\nreturn normalizeItem;')();
 assert.equal(normalize({id:1,type:'audio',url:'/studio/static/voice.wav'}).type,'audio');
 assert.equal(normalize({id:2,type:'video',url:'/studio/static/movie.mp4'}).type,'video');
 assert.match(source,/<el-radio-button value="audio">音频<\/el-radio-button>/);
 assert.match(source,/<audio[^>]*controls[^>]*aria-label="音频预览"/);
 assert.doesNotMatch(source,/<audio[^>]*autoplay/);
});


test('the project More menu and editor media button open the audio-capable library',()=>{
 const snapshot=[];
 for(const name of ['FilmList','FilmCreate']){
  const source=sourceFor(name);
  if(name==='FilmList'){
   const menu=visibleMediaMenu(source);
   assert.ok(menu,'The project entry must expose More → media outside comments');
   snapshot.push({page:name,entry:'more-menu',trigger:menu.trigger,label:menu.label,destination:runMediaCommand(source,menu.handler)});
  }else{
   const button=visibleMediaButton(source);
   assert.ok(button,name+' must expose a media-library button outside comments');
   const expression=/@click="([^"]+)"/.exec(button[1])?.[1];
   assert.equal(expression,"router.push('/media-library')");
   const selected=[];compileFunction('return ()=>'+expression,['router'])({push:path=>selected.push(path)})();
   assert.deepEqual(selected,['/media-library']);
   snapshot.push({page:name,entry:'button',label:button[2].trim(),destination:selected[0]});
  }
  const visible=visibleTemplate(source);
  assert.doesNotMatch(visible,/\/free-create/);
 }
 assert.deepEqual(snapshot,JSON.parse(readFileSync(new URL('./expected/muse-libtv-audio-navigation.json',import.meta.url),'utf8')));
});

test('a media button inside an HTML comment does not satisfy navigation',()=>{
 assert.equal(visibleMediaButton(`<template><!-- <el-button @click="router.push('/media-library')">媒体素材</el-button> --></template>`),undefined);
});

test('commented or disabled More entries and commented handlers cannot satisfy media navigation',()=>{
 const menu='<el-dropdown @command="museProjectCommand"><el-button>更多</el-button><el-dropdown-item command="media">媒体素材</el-dropdown-item></el-dropdown>';
 assert.equal(visibleMediaMenu('<template><!--'+menu+'--></template>'),undefined);
 assert.equal(visibleMediaMenu('<template>'+menu.replace('command="media"','command="media" disabled')+'</template>'),undefined);
 const declaration="function museProjectCommand(command) {\n const actions={media:()=>router.push('/media-library'),characters:()=>{showCharLibrary.value=true}};\n actions[command]?.()\n}";
 assert.throws(()=>runMediaCommand('<script setup>/*\n'+declaration+'\n*/</script>','museProjectCommand'),/real command handler/);
 assert.throws(()=>runMediaCommand('<script setup>\n'+declaration.replace('/media-library','/wrong-library')+'\n</script>','museProjectCommand'),
  {code:'ERR_ASSERTION',actual:['/wrong-library'],expected:['/media-library']});
});

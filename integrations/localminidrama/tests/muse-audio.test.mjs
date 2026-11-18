/** Real SQLite, local HTTP TTS and real FFmpeg/FFprobe verify retained audio without paid suppliers. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash, webcrypto } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import http from 'node:http'
import { createRequire, Module } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import {createContext,runInContext} from 'node:vm'
import { planCloudPrefix } from '../compatibility/cloud-prefix.mjs'
import { planMuseAudio } from '../compatibility/muse-audio.mjs'
import { planMediaAdoption } from '../compatibility/media-adoption.mjs'
import { planMuseBranding } from '../compatibility/muse-branding.mjs'
import voiceInputs from '../extensions/muse-voice-inputs.cjs'

const root=resolve(process.env.LOCALMINIDRAMA_SOURCE||'.local/localminidrama'),filename=name=>resolve(root,name)
const ffmpeg=process.env.FFMPEG_PATH||(process.platform==='win32'?filename('backend-node/tools/ffmpeg/ffmpeg.exe'):'ffmpeg')
const ffprobe=process.env.FFPROBE_PATH||(process.platform==='win32'?resolve(process.env.LOCALAPPDATA||tmpdir(),'MuseLocalMiniDrama/studio/tools/ffmpeg/ffprobe.exe'):'ffprobe')
const available=existsSync(filename('backend-node/node_modules/better-sqlite3'))&&spawnSync(ffmpeg,['-version']).status===0&&spawnSync(ffprobe,['-version']).status===0
const originals=new Map()
function pristine(path){const name=relative(root,path).split(sep).join('/');if(!originals.has(name))originals.set(name,execFileSync('git',['-C',root,'show',`3fbcda9713ca545979dff9e75d21bed53694188f:${name}`],{encoding:'utf8',maxBuffer:3e6}).replaceAll('\r\n','\n'));return originals.get(name)}
let before,audioSources
function planned(){if(!before){before=new Map(planMediaAdoption(root,pristine));for(const planner of [planMuseBranding,planCloudPrefix])for(const [path,source]of planner(root,path=>before.get(path)??pristine(path)))before.set(path,source)}
 audioSources??=new Map(planMuseAudio(root,path=>before.get(path)??pristine(path)));return audioSources}
const hash=bytes=>createHash('sha256').update(bytes).digest('hex')
function wav(seconds=15,frequency=440){const rate=16000,frames=Math.round(rate*seconds),bytes=Buffer.alloc(44+frames*2);bytes.write('RIFF');bytes.writeUInt32LE(bytes.length-8,4);bytes.write('WAVEfmt ',8);bytes.writeUInt32LE(16,16);bytes.writeUInt16LE(1,20);bytes.writeUInt16LE(1,22);bytes.writeUInt32LE(rate,24);bytes.writeUInt32LE(rate*2,28);bytes.writeUInt16LE(2,32);bytes.writeUInt16LE(16,34);bytes.write('data',36);bytes.writeUInt32LE(frames*2,40);for(let i=0;i<frames;i++)bytes.writeInt16LE(Math.round(1000*Math.sin(i*frequency*2*Math.PI/rate)),44+i*2);return bytes}
function loadService(configs,client){const require=createRequire(filename('backend-node/package.json')),module=new Module(filename('backend-node/src/services/museAudioService.js'));
 module.require=name=>name==='./museVoiceInputs'?voiceInputs:name==='./aiConfigService'?{listConfigs:()=>configs}:name==='./ttsService'?client:name==='../utils/ffmpegPath'?{getFfmpegPath:()=>ffmpeg,getFfprobePath:()=>ffprobe}:require(name)
 module._compile(planned().get(filename('backend-node/src/services/museAudioService.js')),filename('backend-node/src/services/museAudioService.js'));return module.exports}
async function fixture(t){const require=createRequire(filename('backend-node/package.json')),Database=require('better-sqlite3'),home=mkdtempSync(join(tmpdir(),'muse-audio-')),statements=[];
 const db=new Database(join(home,'audio.sqlite'));const prepare=db.prepare.bind(db);db.prepare=(...args)=>{const statement=prepare(...args);statements.push(statement);return statement};
 t.after(()=>{db.close();rmSync(home,{recursive:true,force:true,maxRetries:5,retryDelay:100})});
 db.exec('CREATE TABLE characters(id INTEGER PRIMARY KEY,drama_id INTEGER,name TEXT,deleted_at TEXT,seedance2_voice_asset TEXT); CREATE TABLE episodes(id INTEGER PRIMARY KEY,drama_id INTEGER,deleted_at TEXT); INSERT INTO episodes VALUES(1,1,NULL); CREATE TABLE storyboards(id INTEGER PRIMARY KEY,episode_id INTEGER DEFAULT 1,dialogue TEXT,narration TEXT,characters TEXT,audio_local_path TEXT,narration_audio_local_path TEXT,updated_at TEXT,deleted_at TEXT)');
 db.prepare('INSERT INTO characters VALUES(1,1,?,NULL,NULL),(2,1,?,NULL,?)').run('少年','成年角色','{"status":"active","url":"https://unrelated.fixture.test/voice.wav"}')
 db.prepare('INSERT INTO storyboards(id,dialogue,narration,characters) VALUES(7,?,?,?)').run('fixture dialogue','fixture narration','[1,2]')
 const configs=[{id:3,is_active:true,provider:'openai',model:['tts-1'],default_model:'tts-1',api_key:'fixture-private-not-a-real-key',settings:'{}'}]
 let calls=0,respond=(_req,res)=>res.end(mp3),bodies=[]
 const server=http.createServer(async(req,res)=>{calls++;const chunks=[];for await(const bytes of req)chunks.push(bytes);bodies.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));respond(req,res)})
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)))
 configs[0].base_url=`http://127.0.0.1:${server.address().port}/v1`
 const native=new Module(filename('backend-node/src/services/ttsService.js'));native.require=require;native._compile(planned().get(filename('backend-node/src/services/ttsService.js')),filename('backend-node/src/services/ttsService.js'))
 const service=loadService(configs,native.exports),cfg={storage:{local_path:join(home,'storage')}},log={error(){},info(){}}
 return {db,service,cfg,log,configs,bodies,native:native.exports,calls:()=>calls,respond:fn=>{respond=fn},input:(id='tts-fixture')=>({operation_id:id,storyboard_id:7,config_id:3,voice_id:'alloy',text:'fixture dialogue',tts_kind:'dialogue'}),restart:()=>loadService(configs,native.exports)}
}
const mp3=available?spawnSync(ffmpeg,['-v','error','-f','lavfi','-i','sine=frequency=440:duration=1','-f','mp3','pipe:1'],{maxBuffer:2e6}).stdout:Buffer.alloc(0)

test('audio planner composes with prefix edits, removes key/zero-usage logging and rejects changed source', {skip:!available},()=>{
 const changes=planned();assert.equal(changes.size,9)
 assert.doesNotMatch(changes.get(filename('backend-node/src/services/ttsService.js')),/==c sxy|reportUsage\('tts'/)
 assert.doesNotMatch(changes.get(filename('backend-node/src/services/videoClient.js')),/voiceMap\.values\(\)\.next/)
 assert.match(changes.get(filename('backend-node/src/services/videoClient.js')),/resolveVideoVoice/)
 assert.match(changes.get(filename('frontweb/src/views/FilmCreate.vue')),/MuseAudioPanel/)
 assert.throws(()=>planMuseAudio(root,path=>changes.get(path)??before.get(path)??pristine(path)),/pinned source/)
 assert.throws(()=>planMuseAudio(root,path=>{const value=before.get(path)??pristine(path);return path.endsWith('ttsService.js')?value.replace('ttsConfig.api_key, ttsConfig.base_url','changed private logging'):value}),/pinned source/)
})

test('actual OpenAI client produces one validated generation across replays and adopts only by explicit transaction', {skip:!available},async t=>{
 const f=await fixture(t),first=await f.service.generate(f.db,f.log,f.cfg,f.input())
 assert.equal(first.request_text,'fixture dialogue');assert.equal(first.state,'completed');assert.equal(first.adopted,false);assert.equal(first.raw_sha256,hash(mp3));assert.ok(first.duration_seconds>0)
 assert.equal(f.db.prepare('SELECT audio_local_path FROM storyboards WHERE id=7').get().audio_local_path,null)
 assert.equal((await f.service.generate(f.db,f.log,f.cfg,f.input())).raw_sha256,first.raw_sha256);assert.equal(f.calls(),1)
 assert.equal(f.bodies[0].response_format,'mp3');assert.equal(f.bodies[0].voice,'alloy')
 const adopted=f.service.adoptTts(f.db,f.cfg,first.operation_id,{operation_id:'adopt-fixture',sha256:first.raw_sha256})
 assert.equal(adopted.adopted,true);assert.equal(f.db.prepare('SELECT audio_local_path FROM storyboards WHERE id=7').get().audio_local_path,first.local_path)
 await assert.rejects(f.service.generate(f.db,f.log,f.cfg,{...f.input(),text:'different'}),/operation_id_conflict/)
 assert.throws(()=>f.db.prepare('UPDATE muse_tts_generations SET raw_sha256=?').run('a'.repeat(64)),/immutable/)
})

test('the reused MiniMax client follows documented synchronous hex audio and handles malformed JSON as unknown', {skip:!available},async t=>{
 const f=await fixture(t);f.configs[0].provider='minimax';f.configs[0].model=['speech-02-hd'];f.configs[0].default_model='speech-02-hd'
 f.respond((req,res)=>{assert.equal(req.url,'/v1/t2a_v2');res.end(JSON.stringify({base_resp:{status_code:0},data:{audio:mp3.toString('hex')}}))})
 const valid=await f.service.generate(f.db,f.log,f.cfg,f.input('minimax-valid'));assert.equal(valid.state,'completed')
 assert.equal(f.bodies[0].output_format,'hex');assert.equal(f.bodies[0].voice_setting.voice_id,'alloy');assert.equal(f.bodies[0].audio_setting.format,'mp3')
 f.respond((_req,res)=>res.end('not JSON'));assert.equal((await f.service.generate(f.db,f.log,f.cfg,f.input('minimax-unknown'))).state,'unknown')
 await f.service.generate(f.db,f.log,f.cfg,f.input('minimax-unknown'));assert.equal(f.calls(),2)
 await assert.rejects(f.service.generate(f.db,f.log,f.cfg,{...f.input('too-long'),text:'x'.repeat(10000)}),/text_limit/);assert.equal(f.calls(),2)
})

test('concurrent and interrupted TTS requests never dispatch the same operation twice', {skip:!available},async t=>{
 const f=await fixture(t),entered=Promise.withResolvers(),release=Promise.withResolvers();f.respond(async(_req,res)=>{entered.resolve();await release.promise;res.end(mp3)})
 const first=f.service.generate(f.db,f.log,f.cfg,f.input());await entered.promise
 assert.equal((await f.service.generate(f.db,f.log,f.cfg,f.input())).state,'generating');assert.equal(f.calls(),1)
 release.resolve();await first
 f.respond((req)=>req.socket.destroy());const unknown=await f.service.generate(f.db,f.log,f.cfg,f.input('uncertain'))
 assert.equal(unknown.state,'unknown');assert.equal((await f.service.generate(f.db,f.log,f.cfg,f.input('uncertain'))).state,'unknown');assert.equal(f.calls(),2)
 const restarted=f.restart();assert.equal(restarted.ttsRow(f.db,'uncertain').state,'unknown')
})

test('invalid original audio and failed database adoption cannot become success or trigger regeneration', {skip:!available},async t=>{
 const f=await fixture(t);f.respond((_req,res)=>res.end('{"error":"fixture rejected"}'))
 const broken=await f.service.generate(f.db,f.log,f.cfg,f.input('invalid-audio'));assert.equal(broken.state,'failed');assert.ok(broken.raw_sha256)
 await f.service.generate(f.db,f.log,f.cfg,f.input('invalid-audio'));assert.equal(f.calls(),1)
 f.respond((_req,res)=>res.end(mp3));const valid=await f.service.generate(f.db,f.log,f.cfg,f.input('valid-audio'))
 f.db.exec("CREATE TRIGGER refuse_adoption BEFORE UPDATE OF audio_local_path ON storyboards BEGIN SELECT RAISE(ABORT,'fixture_adoption_failure'); END;")
 assert.throws(()=>f.service.adoptTts(f.db,f.cfg,valid.operation_id,{operation_id:'cannot-adopt',sha256:valid.raw_sha256}),/fixture_adoption_failure/)
 assert.equal(f.service.ttsRow(f.db,valid.operation_id).adopted,false);assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM muse_tts_selections').get().n,0)
 assert.equal(f.calls(),2)
})

test('a saved provider result can be recovered after SQLite completion failed without another provider request', {skip:!available},async t=>{
 const f=await fixture(t);f.service.schema(f.db);f.db.exec("CREATE TRIGGER reject_completed BEFORE UPDATE OF state ON muse_tts_generations WHEN NEW.state='completed' BEGIN SELECT RAISE(ABORT,'fixture_completion_failure'); END;")
 await assert.rejects(f.service.generate(f.db,f.log,f.cfg,f.input('recoverable')),/result_not_confirmed/)
 assert.equal(f.service.ttsRow(f.db,'recoverable').state,'unknown');assert.equal(f.calls(),1)
 f.db.exec('DROP TRIGGER reject_completed');assert.equal(f.service.recover(f.db,f.cfg,'recoverable').state,'completed');assert.equal(f.calls(),1)
})

test('a bounded supplier timeout remains unknown and cannot be retried as a new dispatch', {skip:!available},async t=>{
 const f=await fixture(t);f.respond(()=>{});const cfg={...f.cfg,muse_audio:{request_timeout_ms:1000}}
 assert.equal((await f.service.generate(f.db,f.log,cfg,f.input('timeout'))).state,'unknown')
 assert.equal((await f.service.generate(f.db,f.log,cfg,f.input('timeout'))).state,'unknown');assert.equal(f.calls(),1)
})

test('formal voice assets require real PCM and protocol-neutral duration, immutable SHA and exact character-period binding', {skip:!available},async t=>{
 const f=await fixture(t),bytes=wav(),input={operation_id:'voice-upload',character_id:1,voice_period_id:'童年'}
 const voice=f.service.uploadVoice(f.db,f.cfg,input,bytes)
 assert.equal(voice.sha256,hash(bytes));assert.equal(voice.duration_seconds,15);assert.equal(voice.adopted,false)
 assert.equal(f.service.uploadVoice(f.db,f.cfg,input,bytes).id,voice.id)
 assert.throws(()=>f.service.uploadVoice(f.db,f.cfg,{...input,operation_id:'short'},wav(1)),/2_to_30_second_pcm_wav/)
 assert.throws(()=>f.db.prepare('UPDATE muse_voice_assets SET sha256=?').run('a'.repeat(64)),/immutable/)
 assert.equal(f.service.adoptVoice(f.db,f.cfg,voice.id,{operation_id:'voice-adopt'}).adopted,true)
 assert.equal(f.service.resolveVideoVoice(f.db,{storyboard_id:7},'volcengine_omni',f.cfg).voice_reference_url,undefined)
 const chosen={voice_asset_id:voice.id,character_id:1,voice_period_id:'童年',sha256:voice.sha256}
 f.db.exec("INSERT INTO episodes VALUES(2,2,NULL); INSERT INTO storyboards(id,episode_id,characters) VALUES(8,2,'[1]')")
 assert.throws(()=>f.service.bindVideo(f.db,f.cfg,8,{operation_id:'wrong-project',expected_operation_id:null,voices:[chosen]}),/mismatch/)
 assert.throws(()=>f.service.bindVideo(f.db,f.cfg,7,{operation_id:'wrong-period',expected_operation_id:null,voices:[{...chosen,voice_period_id:'成年'}]}),/mismatch/)
 assert.throws(()=>f.service.bindVideo(f.db,f.cfg,7,{operation_id:'multi',expected_operation_id:null,voices:[chosen,chosen]}),/voice_character_period_is_ambiguous/)
 const bound=f.service.bindVideo(f.db,f.cfg,7,{operation_id:'bind-voice',expected_operation_id:null,voices:[chosen]})
 assert.equal(bound.voices[0].sha256,voice.sha256)
 assert.equal(f.service.resolveVideoVoice(f.db,{storyboard_id:7},'volcengine_omni',f.cfg).voice_reference_url,'/static/'+voice.local_path)
 assert.throws(()=>f.service.resolveVideoVoice(f.db,{storyboard_id:7},'openai',f.cfg),/does_not_support/)
 assert.throws(()=>f.service.bindVideo(f.db,f.cfg,7,{operation_id:'stale',expected_operation_id:null,voices:[]}),/voice_binding_changed/)
 assert.throws(()=>f.service.getVideoBinding(f.db,999),/storyboard_not_found/)
 assert.equal(f.service.listVoices(f.db,{drama_id:1}).capabilities.tts_reference_cloning,false)
})

test('owned schema rejects a future generation and the actual Vue audio UI compiles', {skip:!available},async t=>{
 const f=await fixture(t);f.service.schema(f.db);f.db.prepare('UPDATE muse_audio_schema SET version=3').run();assert.throws(()=>f.service.schema(f.db),/unsupported_audio_schema/)
 const require=createRequire(filename('frontweb/package.json')),{parse,compileScript,compileTemplate,compileStyle}=require('@vue/compiler-sfc')
 for(const [path,source]of planned()){if(!path.endsWith('.vue'))continue;const{descriptor,errors}=parse(source,{filename:path});assert.deepEqual(errors,[])
  const script=compileScript(descriptor,{id:'muse-audio-fixture'});assert.deepEqual(compileTemplate({source:descriptor.template.content,filename:path,id:'muse-audio-fixture',compilerOptions:{bindingMetadata:script.bindings}}).errors,[])
  for(const style of descriptor.styles)assert.deepEqual(compileStyle({source:style.content,filename:path,id:'muse-audio-fixture',scoped:style.scoped}).errors,[])
 }
})

test('the HTTP routes expose voice inventory, explicit CAS binding and validated TTS history', {skip:!available},async t=>{
 const f=await fixture(t),require=createRequire(filename('backend-node/package.json')),express=require('express'),app=express(),router=express.Router()
 app.use(express.json());const module=new Module('audio-routes-fixture');module.require=name=>name==='../services/museAudioService'?f.service
  :name==='../response'?require(filename('backend-node/src/response.js')):name==='./upload'?require(filename('backend-node/src/routes/upload.js')):require(name)
 module._compile(planned().get(filename('backend-node/src/routes/museAudioRoutes.js')),filename('backend-node/src/routes/museAudioRoutes.js'))
 module.exports(f.db,f.log,f.cfg).register(router);app.use('/api/v1',router)
 const server=http.createServer(app);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)))
 const base=`http://127.0.0.1:${server.address().port}/api/v1/muse/audio`,json=async(path,method,body)=>{const response=await fetch(base+path,{method,headers:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});return {status:response.status,...await response.json()}}
 const capability=await json('/capabilities?storyboard_id=7');assert.equal(capability.data.project_id,1);assert.equal(capability.data.configs[0].key_configured,true);assert.equal(capability.data.configs[0].api_key,undefined);
 const generated=await json('/tts','POST',f.input('http-tts'));assert.equal(generated.data.state,'completed');assert.equal((await json('/tts?storyboard_id=7')).data.items.length,1)
 const form=new FormData();form.set('file',new Blob([wav()],{type:'audio/wav'}),'reference.wav');form.set('character_id','1');form.set('voice_period_id','童年');form.set('operation_id','http-voice')
 const uploaded=await (await fetch(base+'/voices',{method:'POST',body:form})).json();assert.equal(uploaded.success,true)
 const voice=uploaded.data,bound=await json('/video-bindings/7','PUT',{operation_id:'http-bind',expected_operation_id:null,voices:[{voice_asset_id:voice.id,character_id:1,voice_period_id:'童年',sha256:voice.sha256}]})
 assert.equal(bound.data.voices[0].sha256,voice.sha256);assert.equal((await json('/video-bindings/7')).data.operation_id,'http-bind')
 assert.equal((await json('/video-bindings/999')).status,404)
 assert.equal((await json('/tts','POST',{storyboard_id:7})).status,400)
 assert.equal(f.calls(),1)
})

test('the actual UI persists operation identity before dispatch without storing text or crossing database ownership', {skip:!available},async()=>{
 const source=planned().get(filename('frontweb/src/components/MuseAudioPanel.vue')),start=source.indexOf('async function sha('),end=source.indexOf('async function run(',start)
 const stored=new Map(),databaseId={value:'first-database'},localStorage={getItem:key=>stored.get(key)??null,setItem:(key,value)=>stored.set(key,value)}
 const context=createContext({databaseId,localStorage,crypto:webcrypto,TextEncoder,Uint8Array})
 runInContext(source.slice(start,end),context);const request={text:'private fixture dialogue',voice_id:'fixture'};context.input=request
 const first=await runInContext("operation('tts',input)",context),again=await runInContext("operation('tts',input)",context);assert.equal(first,again)
 assert.ok(!JSON.stringify([...stored]).includes(request.text));databaseId.value='second-database';assert.notEqual(await runInContext("operation('tts',input)",context),first)
 localStorage.setItem=()=>{throw Error('fixture storage unavailable')};await assert.rejects(runInContext("operation('tts',{text:'new'})",context),/storage unavailable/)
})

test('two explicit speaker-period references reach the actual Ark builder in order and keep immutable generation history', {skip:!available},async t=>{
 const f=await fixture(t),first=f.service.uploadVoice(f.db,f.cfg,{operation_id:'multi-voice-first',character_id:1,voice_period_id:'少年'},wav(6)),second=f.service.uploadVoice(f.db,f.cfg,{operation_id:'multi-voice-second',character_id:2,voice_period_id:'成年'},wav(7,660));
 const refs=[second,first].map(row=>({voice_asset_id:row.id,character_id:row.character_id,voice_period_id:row.voice_period_id,sha256:row.sha256}));
 f.service.bindVideo(f.db,f.cfg,7,{operation_id:'multi-binding',expected_operation_id:null,voices:refs});
 const opts=f.service.resolveVideoVoice(f.db,{storyboard_id:7,video_gen_id:44,prompt:'两人保持原台词',model:'fixture-video',duration:4,image_url:'https://image.fixture.test/characters.png',storage_local_path:f.cfg.storage.local_path},'volcengine_omni',f.cfg);
 assert.deepEqual(opts.formal_voice_references.map(row=>row.character_id),[2,1]);assert.equal(opts.voice_reference_url,undefined);
 const config={api_protocol:'volcengine_omni',base_url:f.configs[0].base_url,settings:{muse_model_capabilities:{'fixture-video':{profile:'seedance-2.5'}}}};
 f.respond((_req,res)=>res.end(JSON.stringify({id:'original-video-task',status:'queued'})));
 const source=planned().get(filename('backend-node/src/services/videoClient.js')),start=source.indexOf('async function callVolcengineOmniVideoApi('),end=source.indexOf('\n/**',start);
 const context=createContext({require:name=>{assert.equal(name,'./museVoiceInputs');return voiceInputs},fetch,buildVideoUrl:()=>f.configs[0].base_url,
  getModelFromConfig:(_config,model)=>model,normalizeVolcModel:model=>model,normalizeVolcOmniDuration:(_model,duration)=>duration,
  resolveVolcOmniImageAsync:async url=>url,referenceInputError:()=>Error('too many images'),pickProxyVideoUrl:()=>null,logVideoPostRequest(){}});
 runInContext(source.slice(start,end)+'\nglobalThis.invoke=callVolcengineOmniVideoApi',context);
 assert.equal((await context.invoke(config,{info(){},warn(){}},opts)).task_id,'original-video-task');
 const sent=f.bodies[0],audio=sent.content.filter(row=>row.type==='audio_url');assert.equal(audio.length,2);
 assert.equal(hash(Buffer.from(audio[0].audio_url.url.split(',')[1],'base64')),second.sha256);assert.equal(hash(Buffer.from(audio[1].audio_url.url.split(',')[1],'base64')),first.sha256);
 assert.match(sent.content[0].text,/音频1对应角色"成年角色"/);assert.match(sent.content[0].text,/音频2对应角色"少年"/);
 await assert.rejects(context.invoke({...config,settings:{}},{info(){},warn(){}},opts),/capability_unknown/);assert.equal(f.calls(),1);
 f.service.bindVideo(f.db,f.cfg,7,{operation_id:'clear-binding',expected_operation_id:'multi-binding',voices:[]});
 const history=f.service.listVideoInputs(f.db,{storyboard_id:7}).items;assert.equal(history[0].binding_operation_id,'multi-binding');assert.deepEqual(history[0].voices.map(row=>row.sha256),[second.sha256,first.sha256]);
 assert.throws(()=>f.db.exec('DELETE FROM muse_video_voice_inputs'),/immutable/);
})

test('documented model gates refuse unknown protocols, excessive duration/count and audio-only Seedance2.0', {skip:!available},async t=>{
 const f=await fixture(t),voice=f.service.uploadVoice(f.db,f.cfg,{operation_id:'limits-voice',character_id:1,voice_period_id:'成年'},wav(15));
 const config={api_protocol:'volcengine_omni',base_url:'https://ark.cn-beijing.volces.com/api/v3'},two=[voice,{...voice,character_id:2,voice_period_id:'少年'}];
 assert.equal(voiceInputs.capability(config,'doubao-seedance-2-5-260628').max_references,10);
 assert.equal(voiceInputs.validate(two,config,'doubao-seedance-2-5-260628',true).max_total_seconds,30);
 assert.throws(()=>voiceInputs.validate(two,config,'doubao-seedance-2-0-260128',true),/total_duration/);
 assert.throws(()=>voiceInputs.validate([voice],config,'doubao-seedance-2-0-260128',false),/requires_image_or_video/);
 assert.throws(()=>voiceInputs.validate([{...voice,duration_seconds:31}],config,'doubao-seedance-2-5-260628',true),/duration_not_supported/);
 assert.throws(()=>voiceInputs.validate(Array.from({length:11},(_,i)=>({...voice,character_id:i+1,duration_seconds:2})),config,'doubao-seedance-2-5-260628',true),/count_exceeded/);
 assert.equal(voiceInputs.capability({...config,base_url:'https://unknown.fixture'},'doubao-seedance-2-5-260628').supported,false);
 assert.equal(voiceInputs.capability({...config,api_protocol:'openai'},'doubao-seedance-2-5-260628').supported,false);
})

test('cancelled waiting does not cancel or duplicate a held supplier call and a new UUID cannot bypass unknown state', {skip:!available},async t=>{
 const f=await fixture(t);let respond;const entered=new Promise(resolve=>f.respond((_req,res)=>{respond=()=>res.end(mp3);resolve()}));
 const pending=f.service.generate(f.db,f.log,f.cfg,f.input('held-audio'));await entered;
 const cancelled=f.service.cancelTts(f.db,'held-audio',{operation_id:'cancel-held'});assert.equal(cancelled.state,'generating');assert.deepEqual(cancelled.cancellation,{requested:true,provider_cancelled:false});
 await assert.rejects(f.service.generate(f.db,f.log,f.cfg,f.input('different-uuid')),/prior_operation_unresolved/);assert.equal(f.calls(),1);
 respond();assert.equal((await pending).state,'completed');assert.equal(f.service.ttsRow(f.db,'held-audio').cancellation.requested,true);assert.equal(f.calls(),1);
})

test('schema1 migrates forward without changing existing 15-second voices or retained TTS bytes', {skip:!available},async t=>{
 const f=await fixture(t),voice=f.service.uploadVoice(f.db,f.cfg,{operation_id:'legacy-voice',character_id:1,voice_period_id:'成年'},wav()),tts=await f.service.generate(f.db,f.log,f.cfg,f.input('legacy-tts'));
 f.db.exec('DROP TABLE muse_video_voice_inputs; DROP TRIGGER muse_tts_immutable_text; ALTER TABLE muse_tts_generations DROP COLUMN request_text; ALTER TABLE muse_tts_generations DROP COLUMN cancel_requested_at; UPDATE muse_audio_schema SET version=1');
 f.restart().schema(f.db);assert.equal(f.db.prepare('SELECT version FROM muse_audio_schema').get().version,2);
 assert.equal(f.service.listVoices(f.db,{drama_id:1}).items[0].sha256,voice.sha256);assert.equal(f.service.ttsRow(f.db,'legacy-tts').raw_sha256,tts.raw_sha256);assert.equal(f.service.ttsRow(f.db,'legacy-tts').request_text,null);
})

test('stopping the native UI wait aborts immediately even before the cancellation-intent POST completes', {skip:!available,timeout:5000},async()=>{
 const source=planned().get(filename('frontweb/src/components/MuseAudioPanel.vue')),start=source.indexOf('async function cancelWait('),end=source.indexOf('onBeforeUnmount(',start);
 let aborted=false,complete,enteredPost;const entered=new Promise(resolve=>{enteredPost=resolve});
 const context=createContext({activeTtsOperation:{value:'original-operation'},ttsController:{abort(){aborted=true}},databaseId:{value:'fixture-database'},
  request:{post:()=>new Promise(resolve=>{complete=resolve;enteredPost()})},operation:async()=> 'cancel-original',ElMessage:{info(){},warning(){}},loadHistory:async()=>{}});
 runInContext(source.slice(start,end),context);const waiting=runInContext('cancelWait()',context);
 assert.equal(aborted,true);await entered;complete();await waiting;
})

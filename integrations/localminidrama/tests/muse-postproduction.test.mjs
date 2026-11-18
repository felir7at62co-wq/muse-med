/** Real SQLite/media and a loopback fal protocol fixture; no supplier or paid API is contacted. */
import test from 'node:test'
import assert from 'node:assert/strict'
import {execFileSync,spawnSync} from 'node:child_process'
import {createHash} from 'node:crypto'
import {existsSync,mkdirSync,mkdtempSync,readFileSync,rmSync,writeFileSync,unlinkSync} from 'node:fs'
import http from 'node:http'
import {createRequire} from 'node:module'
import {tmpdir} from 'node:os'
import {dirname,join,relative,resolve,sep} from 'node:path'
import {compileFunction} from 'node:vm'
import {planMediaAdoption} from '../compatibility/media-adoption.mjs'
import {planMuseBranding} from '../compatibility/muse-branding.mjs'
import {planCloudPrefix} from '../compatibility/cloud-prefix.mjs'
import {planMuseAudio} from '../compatibility/muse-audio.mjs'
import {planMuseRevisions} from '../compatibility/muse-revisions.mjs'
import {planPostproduction} from '../compatibility/muse-postproduction.mjs'

const root=resolve(process.env.LOCALMINIDRAMA_SOURCE||'.local/localminidrama'),filename=name=>resolve(root,name)
const ffmpeg=process.env.FFMPEG_PATH||(process.platform==='win32'?filename('backend-node/tools/ffmpeg/ffmpeg.exe'):'ffmpeg')
const ffprobe=process.env.FFPROBE_PATH||(process.platform==='win32'?resolve(process.env.LOCALAPPDATA||tmpdir(),'MuseLocalMiniDrama/studio/tools/ffmpeg/ffprobe.exe'):'ffprobe')
const available=existsSync(filename('backend-node/node_modules/better-sqlite3'))&&spawnSync(ffmpeg,['-version']).status===0&&spawnSync(ffprobe,['-version']).status===0
const originals=new Map(),hash=bytes=>createHash('sha256').update(bytes).digest('hex')
function pristine(path){const name=relative(root,path).split(sep).join('/');if(!originals.has(name))originals.set(name,execFileSync('git',['-C',root,'show',`3fbcda9713ca545979dff9e75d21bed53694188f:${name}`],{encoding:'utf8',maxBuffer:3e6}).replaceAll('\r\n','\n'));return originals.get(name)}
let before,changes
function planned(){if(!before){before=new Map();for(const planner of[planMediaAdoption,planMuseBranding,planCloudPrefix,planMuseAudio,planMuseRevisions])for(const[path,source]of planner(root,path=>before.get(path)??pristine(path)))before.set(path,source)}
 changes??=new Map(planPostproduction(root,path=>before.get(path)??pristine(path)));return changes}
function compile(source,path,require,fetcher=fetch){const module={exports:{}},console={log(){},warn(){},error(){}};
 compileFunction(source,['require','module','exports','__filename','__dirname','console','fetch'],{filename:path})(require,module,module.exports,path,dirname(path),console,fetcher);return module.exports}
function video(path,size='64x64',duration='0.4',audio=true){const result=spawnSync(ffmpeg,['-v','error','-f','lavfi','-i','color=c=blue:s='+size+':r=10',...audio?['-f','lavfi','-i','sine=frequency=440:sample_rate=48000']:[],
 '-t',duration,'-c:v','libx264','-pix_fmt','yuv420p',...audio?['-c:a','aac','-shortest']:[],'-n',path],{windowsHide:true,maxBuffer:2e6});assert.equal(result.status,0,result.stderr?.toString());return readFileSync(path)}
async function fixture(t){
 const require=createRequire(filename('backend-node/package.json')),Database=require('better-sqlite3'),home=mkdtempSync(join(tmpdir(),'muse-postproduction-')),db=new Database(join(home,'project.sqlite')),statements=[]
 const prepare=db.prepare.bind(db);db.prepare=(...args)=>{const statement=prepare(...args);statements.push(statement);return statement}
 t.after(()=>{db.close();assert.ok(home.startsWith(resolve(tmpdir())+sep+'muse-postproduction-'));rmSync(home,{recursive:true,force:true,maxRetries:5,retryDelay:100})})
 const migrationPath=filename('backend-node/src/db/migrate.js'),migration=compile(pristine(migrationPath),migrationPath,name=>name==='./index.js'?{getDb(){throw Error('Fixture owns its database')}}:name==='../config/index.js'?{loadConfig(){throw Error('Fixture never loads user configuration')}}:require(name));migration.runMigrationsAndEnsure(db)
 db.prepare("INSERT INTO dramas(id,title) VALUES(1,'当前项目');").run();db.prepare("INSERT INTO episodes(id,drama_id,title) VALUES(11,1,'第一集')").run()
 db.prepare("INSERT INTO storyboards(id,episode_id,storyboard_number,title,video_url) VALUES(7,11,1,'原分镜','/static/video/original.mp4')").run()
 db.prepare("INSERT INTO video_generations(id,drama_id,storyboard_id,provider,model,prompt,status,local_path) VALUES(20,1,7,'fixture','original-video','原提示词和台词','completed','video/original.mp4')").run()
 const storage=join(home,'storage');mkdirSync(join(storage,'video'),{recursive:true});const original=video(join(storage,'video/original.mp4'))
 let output=video(join(home,'provider-2x.mp4'),'128x128','0.4',false),paid=0,uploaded=null,loseAck=false,loseOn=null,failUploadOn=null,evilAck=false,blockedDownload=false,requests=[],uploads=0;const files=new Map(),jobs=new Map()
 const server=http.createServer(async(req,res)=>{try{const chunks=[];for await(const chunk of req)chunks.push(chunk);const bytes=Buffer.concat(chunks),path=new URL(req.url,'http://fixture').pathname;
  requests.push({path,method:req.method,authorization:req.headers.authorization,cookie:req.headers.cookie,bytes});res.setHeader('content-type','application/json')
  if(path==='/storage/auth/token')res.end(JSON.stringify({token:'short-fixture-upload-token',token_type:'Bearer',base_url:'https://v3.fal.media'}))
  else if(path==='/files/upload'){uploads++;if(failUploadOn===uploads){failUploadOn=null;res.statusCode=503;res.end('{}');return}uploaded=bytes;const url='https://v3.fal.media/files/fixture/source-'+uploads+'.mp4';files.set(url,bytes);res.end(JSON.stringify({access_url:url}))}
  else if(req.method==='POST'&&(path==='/fal-ai/seedvr/upscale/video'||path==='/bria/video/erase/prompt')){paid++;const root=path.startsWith('/bria')?'bria/video':'fal-ai/seedvr',id='original-request-'+paid;const input=JSON.parse(bytes.toString());jobs.set(id,{source:files.get(input.video_url),kind:root});
   if(loseAck||loseOn===paid){loseAck=false;loseOn=null;res.destroy();return}res.end(JSON.stringify({request_id:id,status_url:(evilAck?'https://attacker.fixture.invalid':'https://queue.fal.run')+'/'+root+'/requests/'+id+'/status',response_url:'https://queue.fal.run/'+root+'/requests/'+id}))}
  else if(path.endsWith('/status'))res.end(JSON.stringify({status:'COMPLETED'}))
  else if(path.includes('/requests/'))res.end(JSON.stringify({video:{url:'https://v3.fal.media/files/result/'+path.split('/').at(-1)+'.mp4'}}))
  else if(path.startsWith('/files/result/')){res.setHeader('content-type','video/mp4');const id=path.split('/').at(-1).replace('.mp4','');res.end(output||jobs.get(id).source)}
  else{res.statusCode=404;res.end('{}')}
 }catch(error){res.destroy()}})
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve)}))
 const base='http://127.0.0.1:'+server.address().port
 const fetcher=(url,options)=>{const parsed=new URL(url);assert.ok(['rest.fal.ai','queue.fal.run','v3-uploads.fal.media','v3.fal.media'].includes(parsed.hostname));if(blockedDownload&&parsed.pathname.startsWith('/files/result/'))throw Object.assign(Error('fixture egress denied'),{code:'studio_outbound_rejected'});return fetch(base+parsed.pathname+parsed.search,options)}
 const mediaPath=filename('backend-node/src/services/musePostproductionMedia.js'),media=compile(planned().get(mediaPath),mediaPath,name=>name==='../utils/ffmpegPath'?{getFfmpegPath:()=>ffmpeg,getFfprobePath:()=>ffprobe}:require(name))
 const falPath=filename('backend-node/src/services/musePostproductionFal.js'),fal=compile(planned().get(falPath),falPath,require,fetcher)
 const segmentPath=filename('backend-node/src/services/musePostproductionSegments.js'),segments=compile(planned().get(segmentPath),segmentPath,name=>name==='./musePostproductionMedia'?media:name==='./musePostproductionFal'?fal:require(name));
 const ai=require(filename('backend-node/src/services/aiConfigService.js')),servicePath=filename('backend-node/src/services/musePostproduction.js')
 const create=()=>compile(planned().get(servicePath),servicePath,name=>name==='./musePostproductionMedia'?media:name==='./musePostproductionFal'?fal:name==='./musePostproductionSegments'?segments:name==='./aiConfigService'?ai:require(name))
 const service=create(),cfg={storage:{local_path:storage},muse_postproduction:{http_timeout_ms:3000,media_timeout_ms:30000}},log={info(){},error(){}}
 const databaseId=service.capabilities(db,cfg).database_id,cap=service.saveConfig(db,cfg,log,{database_id:databaseId,name:'本地契约测试',api_key:'private-fixture-key-not-real'}),configId=cap.configs[0].id
 const input=(id='original-post-operation',kind='upscale')=>({database_id:databaseId,operation_id:id,source_generation_id:20,source_sha256:hash(original),config_id:configId,kind,...kind==='erase_subtitles'?{prompt:'burned-in subtitles and captions'}:{}})
 return {db,cfg,log,service,media,home,storage,databaseId,original,requests,input,configId,paid:()=>paid,uploaded:()=>uploaded,
  output:bytes=>{output=bytes},loseOn:value=>{loseOn=value},failUploadOn:value=>{failUploadOn=value},blockDownload:value=>{blockedDownload=value},loseAck:()=>{loseAck=true},evilAck:()=>{evilAck=true},restart:create}
}

test('postproduction planner follows audited FilmCreate edits and keeps ordinary image scaling separate',{skip:!available},()=>{
 const changes=planned(),film=changes.get(filename('frontweb/src/views/FilmCreate.vue'))
 assert.match(film,/MuseAudioPanel/);assert.match(film,/MuseRevisionsPanel/);assert.match(film,/MusePostproductionPanel/)
 assert.match(film,/普通图片放大（2x 插值，无 AI）/);assert.doesNotMatch(film,/>超分/)
 assert.match(changes.get(filename('backend-node/src/routes/storyboards.js')),/randomUUID\(\)/)
 assert.throws(()=>planPostproduction(root,path=>changes.get(path)??before.get(path)??pristine(path)),/pinned source/)
 const compiler=createRequire(filename('frontweb/package.json'))('@vue/compiler-sfc'),panel=changes.get(filename('frontweb/src/components/MusePostproductionPanel.vue'))
 const parsed=compiler.parse(panel);assert.deepEqual(parsed.errors,[]);compiler.compileScript(parsed.descriptor,{id:'postproduction-fixture'})
 assert.deepEqual(compiler.compileTemplate({source:parsed.descriptor.template.content,filename:'MusePostproductionPanel.vue',id:'postproduction-fixture'}).errors,[])
})

test('real media preserves every picture frame and the exact original encoded audio before explicit adoption',{skip:!available},async t=>{
 const f=await fixture(t),first=await f.service.submit(f.db,f.cfg,f.input())
 assert.equal(first.state,'queued');assert.equal(f.paid(),1);assert.equal(hash(f.uploaded()),hash(f.original))
 assert.equal((await f.service.submit(f.db,f.cfg,f.input())).operation_id,first.operation_id);assert.equal(f.paid(),1)
 const complete=await f.service.refresh(f.db,f.cfg,first.operation_id);assert.equal(complete.state,'completed');assert.equal(complete.adopted,false)
 assert.equal(complete.output_metadata.frames,4);assert.equal(complete.output_metadata.width,128)
 assert.equal(complete.output_metadata.audio_sha256,complete.source_metadata.audio_sha256)
 assert.equal(complete.output_metadata.audio_pcm_sha256,complete.source_metadata.audio_pcm_sha256)
 assert.deepEqual(complete.output_metadata.audio_clocks,complete.source_metadata.audio_clocks)
 assert.equal(f.db.prepare('SELECT video_url FROM storyboards WHERE id=7').get().video_url,'/static/video/original.mp4')
 const adopted=f.service.adopt(f.db,f.cfg,first.operation_id,{database_id:f.databaseId,operation_id:'adopt-post-original',sha256:complete.output_sha256,expected_video_url:'/static/video/original.mp4'});assert.equal(adopted.adopted,true)
 assert.equal(f.db.prepare('SELECT local_path FROM video_generations WHERE id=?').get(complete.generation_id).local_path,complete.local_path)
 assert.equal((await f.service.refresh(f.db,f.cfg,first.operation_id)).generation_id,complete.generation_id);assert.equal(f.paid(),1)
 for(const req of f.requests){assert.equal(req.cookie,undefined);if(req.path==='/files/upload')assert.equal(req.authorization,'Bearer short-fixture-upload-token');else if(req.path.startsWith('/files/'))assert.equal(req.authorization,undefined);else assert.equal(req.authorization,'Key private-fixture-key-not-real')}
 assert.doesNotMatch(JSON.stringify(complete),/private-fixture-key/)
})

test('erase disables trimming and rejoins long clips from ordered sub-five-second frame segments',{skip:!available},async t=>{
 const f=await fixture(t);f.output(video(join(f.home,'erase-result.mp4'),'64x64','0.4',false))
 const input=f.input('original-erase-operation','erase_subtitles');assert.equal((await f.service.submit(f.db,f.cfg,input)).state,'queued')
 const submitted=f.requests.find(row=>row.path==='/bria/video/erase/prompt');assert.equal(JSON.parse(submitted.bytes.toString()).auto_trim,false)
 assert.equal((await f.service.refresh(f.db,f.cfg,input.operation_id)).state,'completed')
 const longer=video(join(f.home,'five-seconds.mp4'),'64x64','5',true);writeFileSync(join(f.storage,'video/original.mp4'),longer)
 f.output(null);const long=await f.service.submit(f.db,f.cfg,{...f.input('long-erase-operation','erase_subtitles'),source_sha256:hash(longer)});assert.equal(long.segment_count,2);assert.equal(f.paid(),3);
 const completed=await f.service.refresh(f.db,f.cfg,long.operation_id);assert.equal(completed.state,'completed');assert.equal(completed.output_metadata.frames,50);assert.equal(completed.output_metadata.audio_sha256,completed.source_metadata.audio_sha256);assert.equal(completed.source_sha256,hash(longer))
})

test('truncated results retain candidates without becoming generation versions or inheriting approval',{skip:!available},async t=>{
 const f=await fixture(t);f.output(video(join(f.home,'truncated.mp4'),'128x128','0.2',false))
 const queued=await f.service.submit(f.db,f.cfg,f.input()),checked=await f.service.refresh(f.db,f.cfg,queued.operation_id)
 assert.equal(checked.state,'media_unverified');assert.equal(checked.error_code,'postproduction_picture_clock_changed');assert.equal(checked.generation_id,null)
 assert.ok(f.db.prepare('SELECT raw_path FROM muse_postproduction_segments').get().raw_path);assert.equal(checked.quality_review,'not_reviewed')
 await f.service.refresh(f.db,f.cfg,queued.operation_id);assert.equal(f.paid(),1);assert.equal(hash(readFileSync(join(f.storage,'video/original.mp4'))),hash(f.original))
})

test('lost acknowledgements and untrusted queue URLs never trigger another paid submission after restart',{skip:!available},async t=>{
 const f=await fixture(t);f.loseAck();const first=await f.service.submit(f.db,f.cfg,f.input())
 assert.equal(first.state,'unknown');assert.equal(first.request_id,null)
 assert.equal((await f.restart().submit(f.db,f.cfg,f.input())).state,'unknown');assert.equal(f.paid(),1)
 f.evilAck();const invalid=await f.service.submit(f.db,f.cfg,f.input('untrusted-queue-ack'))
 assert.equal(invalid.state,'unknown');assert.equal(invalid.error_code,'fal_queue_identity_refused');assert.equal(f.paid(),2)
 assert.equal((await f.service.refresh(f.db,f.cfg,invalid.operation_id)).state,'unknown');assert.equal(f.paid(),2)
})

test('media changes invalidate adoption and secret configuration remains absent from public responses',{skip:!available},async t=>{
 const f=await fixture(t),queued=await f.service.submit(f.db,f.cfg,f.input()),complete=await f.service.refresh(f.db,f.cfg,queued.operation_id)
 assert.equal(complete.state,'completed');writeFileSync(join(f.storage,complete.local_path),'modified by user')
 assert.throws(()=>f.service.adopt(f.db,f.cfg,complete.operation_id,{database_id:f.databaseId,operation_id:'adopt-modified-file',sha256:complete.output_sha256,expected_video_url:'/static/video/original.mp4'}),/media_changed/)
 const cap=f.service.capabilities(f.db,f.cfg);assert.equal(cap.configs[0].key_configured,true);assert.doesNotMatch(JSON.stringify(cap),/private-fixture-key|api_key/)
 f.db.prepare('UPDATE ai_service_configs SET api_key=? WHERE id=?').run('rotated-fixture-key',f.configId)
 await assert.rejects(f.service.submit(f.db,f.cfg,{...f.input(),kind:'erase_subtitles',prompt:'different'}),/operation_conflict/)
 assert.equal(f.paid(),1)
})

test('real HTTP routes reject another database identity and expose immutable generation lineage without keys',{skip:!available},async t=>{
 const f=await fixture(t),require=createRequire(filename('backend-node/package.json')),express=require('express'),app=express(),router=express.Router()
 const routePath=filename('backend-node/src/routes/musePostproductionRoutes.js'),routes=compile(planned().get(routePath),routePath,name=>name==='../services/musePostproduction'?f.service:name==='../response'?require(filename('backend-node/src/response.js')):require(name))
 const configPath=filename('backend-node/src/routes/aiConfig.js'),configRoutes=compile(planned().get(configPath),configPath,name=>name==='../services/aiConfigService'?require(filename('backend-node/src/services/aiConfigService.js')):name==='../response'?require(filename('backend-node/src/response.js')):require(name))
 app.use(express.json());routes.register(router,f.db,f.cfg,f.log);router.get('/ai-configs',configRoutes(f.db,f.log,f.cfg).list);app.use('/api/v1',router)
 const server=http.createServer(app);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve)}))
 const base='http://127.0.0.1:'+server.address().port+'/api/v1/muse/postproduction'
 const json=async(path,method='GET',body)=>{const response=await fetch(base+path,{method,headers:{'content-type':'application/json'},...body===undefined?{}:{body:JSON.stringify(body)}});return {status:response.status,...await response.json()}}
 const capabilities=await json('/capabilities');assert.equal(capabilities.data.database_id,f.databaseId);assert.doesNotMatch(JSON.stringify(capabilities),/private-fixture-key/)
 assert.equal((await json('/tasks','POST',{...f.input(),database_id:'another-account-database'})).status,409);assert.equal(f.paid(),0)
 assert.equal((await json('/config','POST',{database_id:'another-account-database',api_key:'must-not-be-saved'})).status,409)
 assert.equal((await json('/sources/20/inspect')).data.metadata.frames,4)
 const queued=await json('/tasks','POST',f.input('http-post-original'));assert.equal(queued.data.state,'queued')
 const complete=await json('/tasks/'+queued.data.operation_id+'/refresh','POST',{});assert.equal(complete.data.state,'completed')
 const lineage=f.service.generationSource(f.db,complete.data.generation_id);assert.equal(lineage.source_generation_id,20);assert.equal(lineage.output_sha256,complete.data.output_sha256)
 assert.equal(lineage.provider_input.video_url,'https://v3.fal.media/files/fixture/source-1.mp4');assert.equal((await json('/tasks?drama_id=1')).data.items.length,1)
 assert.doesNotMatch(JSON.stringify(lineage),/private-fixture-key|credential_sha256/)
 const generic=await (await fetch('http://127.0.0.1:'+server.address().port+'/api/v1/ai-configs')).json();assert.equal(generic.data[0].service_type,'muse_postproduction');assert.doesNotMatch(JSON.stringify(generic),/private-fixture-key|"api_key"/)
 assert.equal((await json('/tasks/'+queued.data.operation_id+'/adopt','POST',{database_id:f.databaseId,operation_id:'http-post-adopt',sha256:complete.data.output_sha256,expected_video_url:'/static/video/original.mp4'})).data.adopted,true)
 assert.equal(f.paid(),1)
})

test('continues only unsubmitted long-clip segments, preserves accepted tasks and repairs a missing private checkpoint',{skip:!available},async t=>{
 const f=await fixture(t),bytes=video(join(f.home,'nine-seconds.mp4'),'64x64','9',true);writeFileSync(join(f.storage,'video/original.mp4'),bytes);f.output(null);f.failUploadOn(2)
 const input={...f.input('long-original-continue','erase_subtitles'),source_sha256:hash(bytes)},first=await f.service.submit(f.db,f.cfg,input)
 assert.equal(first.state,'submission_incomplete');assert.equal(first.segment_count,3);assert.equal(f.paid(),1)
 assert.equal(first.segments[0].request_id,'original-request-1');assert.equal(first.segments[1].state,'upload_failed');assert.equal(first.segments[2].state,'pending')
 const checkpoint=f.db.prepare('SELECT checkpoint_path FROM muse_postproduction_tasks').get().checkpoint_path;unlinkSync(join(f.storage,checkpoint))
 const continued=await f.service.continueSubmission(f.db,f.cfg,first.operation_id,{database_id:f.databaseId});assert.equal(f.paid(),3)
 assert.equal(continued.segments[0].request_id,first.segments[0].request_id);assert.equal(hash(readFileSync(join(f.storage,checkpoint))),hash(bytes))
 await f.service.continueSubmission(f.db,f.cfg,first.operation_id,{database_id:f.databaseId});assert.equal(f.paid(),3)
 const complete=await f.service.refresh(f.db,f.cfg,first.operation_id);assert.equal(complete.state,'completed');assert.equal(complete.output_metadata.frames,90)
 assert.equal(complete.output_metadata.audio_sha256,complete.source_metadata.audio_sha256)
})

test('never continues an unknown middle segment or submits the pending suffix after a process restart',{skip:!available},async t=>{
 const f=await fixture(t),bytes=video(join(f.home,'unknown-middle.mp4'),'64x64','9',true);writeFileSync(join(f.storage,'video/original.mp4'),bytes);f.output(null);f.loseOn(2)
 const first=await f.service.submit(f.db,f.cfg,{...f.input('long-unknown-middle','erase_subtitles'),source_sha256:hash(bytes)})
 assert.equal(first.state,'unknown');assert.equal(first.segments[0].state,'queued');assert.equal(first.segments[1].state,'unknown');assert.equal(first.segments[2].state,'pending')
 const replacement=f.restart();await assert.rejects(replacement.continueSubmission(f.db,f.cfg,first.operation_id,{database_id:f.databaseId}),/unknown_segment/)
 const observed=await replacement.refresh(f.db,f.cfg,first.operation_id);assert.equal(observed.state,'unknown');assert.equal(observed.generation_id,null)
 assert.equal(observed.segments[0].state,'verified');assert.equal(f.paid(),2)
})

test('reports only a refused origin and resumes the original result download after administrator correction',{skip:!available},async t=>{
 const f=await fixture(t),queued=await f.service.submit(f.db,f.cfg,f.input('egress-original-task'));f.blockDownload(true)
 const refused=await f.service.refresh(f.db,f.cfg,queued.operation_id);assert.equal(refused.state,'media_unverified')
 assert.equal(refused.error_code,'postproduction_outbound_not_allowed');assert.equal(refused.error_origin,'https://v3.fal.media');assert.equal(f.paid(),1)
 f.blockDownload(false);const complete=await f.service.refresh(f.db,f.cfg,queued.operation_id);assert.equal(complete.state,'completed');assert.equal(complete.error_origin,null);assert.equal(f.paid(),1)
})

test('ordinary image enlargement performs real local interpolation, adopts its URL and preserves the original file',{skip:!available},async t=>{
 const f=await fixture(t),sourcePath=filename('backend-node/src/routes/storyboards.js'),require=createRequire(sourcePath)
 const routes=compile(planned().get(sourcePath),sourcePath,name=>name==='../config'?{loadConfig:()=>f.cfg}:name.startsWith('../services/')?{}:require(name))
 const source='images/original.png';mkdirSync(join(f.storage,'images'));const image=spawnSync(ffmpeg,['-v','error','-f','lavfi','-i','color=c=red:s=64x64','-frames:v','1','-f','image2pipe','-vcodec','png','pipe:1'],{windowsHide:true,maxBuffer:2e6});assert.equal(image.status,0);writeFileSync(join(f.storage,source),image.stdout)
 f.db.prepare('UPDATE storyboards SET local_path=?,image_url=? WHERE id=7').run(source,'/static/'+source)
 let result;const res={status(value){this.statusCode=value;return this},json(value){result=value;return this}}
 await routes(f.db,f.log).upscale({params:{id:'7'}},res);assert.equal(result.success,true)
 const row=f.db.prepare('SELECT local_path,image_url FROM storyboards WHERE id=7').get();assert.notEqual(row.local_path,source);assert.equal(row.image_url,'/static/'+row.local_path)
 const sharp=require('sharp'),facts=await sharp(join(f.storage,row.local_path)).metadata();assert.equal(facts.width,128);assert.equal(facts.height,128)
 assert.equal(hash(readFileSync(join(f.storage,source))),hash(image.stdout));assert.equal(f.paid(),0)
})

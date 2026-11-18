/** Real FFmpeg and SQLite verify every adopted package, complete output and recoverable post-processing failures. */
import test from 'node:test'
import assert from 'node:assert/strict'
import {execFileSync,spawnSync} from 'node:child_process'
import {createRequire,Module} from 'node:module'
import {existsSync,mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync,readdirSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join,resolve,relative,dirname,sep} from 'node:path'
import {planEpisodeMerge} from '../compatibility/episode-merge.mjs'

const root=resolve(process.env.LOCALMINIDRAMA_SOURCE||'.local/localminidrama'),backend=join(root,'backend-node')
const ffmpeg=process.env.FFMPEG_PATH||(process.platform==='win32'?join(backend,'tools/ffmpeg/ffmpeg.exe'):'ffmpeg')
const ffprobe=process.env.FFPROBE_PATH||(process.platform==='win32'?resolve(process.env.LOCALAPPDATA||tmpdir(),'MuseLocalMiniDrama/studio/tools/ffmpeg/ffprobe.exe'):'ffprobe')
const installed=existsSync(join(backend,'node_modules/better-sqlite3'))&&spawnSync(ffmpeg,['-version']).status===0&&spawnSync(ffprobe,['-version']).status===0
const file=join(backend,'src/services/videoMergeService.js'),revision='3fbcda9713ca545979dff9e75d21bed53694188f'
function staged(path){assert.equal(path,file);return execFileSync('git',['-C',root,'show',`${revision}:${relative(root,path).split(sep).join('/')}`],{encoding:'utf8'})
  .replace("path.join(require('os').tmpdir(), 'drama-video-merge')","fs.mkdtempSync(path.join(require('os').tmpdir(), 'muse-lmd-merge-'))")
  .replace('if (localPaths.length > 0 && ffmpegAvailable && localPaths.length <= 100)','if (localPaths.length === scenes.length && ffmpegAvailable && localPaths.length <= 100)')
  .replace('  const finalMergedUrl = mergedRelativePath || mergedUrlFallback;',`  // A partial concatenation or a first-clip fallback is not a delivered episode.
  if (!mergedRelativePath) {
    const error = 'Episode merge failed: every selected clip must be readable and FFmpeg must produce the complete episode.';
    db.prepare('UPDATE video_merges SET status = ?, error_msg = ? WHERE id = ?').run('failed', error, mergeId);
    if (taskId) taskService.updateTaskError(db, taskId, error);
    return;
  }
  const finalMergedUrl = mergedRelativePath;`)}
function compile(source,filename,require){const module=new Module(filename);module.filename=filename;module.require=require;module._compile(source,filename);return module.exports}
function fixture(t){
 const home=mkdtempSync(join(tmpdir(),'muse-episode-merge-')),storage=join(home,'storage');mkdirSync(storage);const require=createRequire(join(backend,'package.json')),Database=require('better-sqlite3'),db=new Database(join(home,'fixture.db'))
 // Every prepared statement remains owned until this fixture's database closes.
 const statements=[],prepare=db.prepare.bind(db);db.prepare=(...args)=>{const statement=prepare(...args);statements.push(statement);return statement;}
 t.after(()=>{db.close();rmSync(home,{recursive:true,force:true})})
 compile('const console={log(){},warn(){},error(){}};\n'+readFileSync(join(backend,'src/db/migrate.js'),'utf8'),join(backend,'src/db/migrate.js'),createRequire(join(backend,'src/db/migrate.js'))).runMigrationsAndEnsure(db)
 db.prepare("INSERT INTO dramas(id,title) VALUES(1,'Merge fixture')").run();db.prepare("INSERT INTO episodes(id,drama_id,episode_number,title,status) VALUES(1,1,1,'Episode','draft')").run()
 const cfg={storage:{local_path:storage,base_url:'/studio/static'},muse_merge:{timeout_ms:30000,max_input_bytes:10485760,max_output_bytes:10485760,duration_tolerance_ms:250}},planned=new Map(planEpisodeMerge(root,staged)),cache=new Map()
 const load=filename=>{if(cache.has(filename))return cache.get(filename);const source=planned.get(filename);if(!source)return require(filename);const mod=compile(source,filename,name=>name==='../config'?{loadConfig:()=>cfg}:name==='../utils/ffmpegPath'?{getFfmpegPath:()=>ffmpeg,getFfprobePath:()=>ffprobe}:name.startsWith('.')?load(resolve(dirname(filename),name+'.js')):require(name));cache.set(filename,mod);return mod}
 const service=load(file),log={info(){},warn(){},error(){}},clip=(color,name=color,size='32x32')=>{const target=join(storage,name+'.mp4');execFileSync(ffmpeg,['-nostdin','-v','error','-f','lavfi','-i',`color=c=${color}:s=${size}:r=10`,'-frames:v','2','-c:v','libx264','-pix_fmt','yuv420p','-g','1','-bf','0','-n',target]);return '/static/'+name+'.mp4'}
 const insert=db.prepare('INSERT INTO storyboards(episode_id,storyboard_number,title,video_url,duration) VALUES(1,?,?,?,?)');const create=(urls,options={})=>{const scenes=urls.map((url,i)=>{const id=Number(insert.run(i+1,'Package '+(i+1),url,999).lastInsertRowid);return {scene_id:id,video_url:url,duration:999}});return service.create(db,log,{episode_id:1,drama_id:1,scenes,merge_options:options})}
 const run=async merge=>{await service.processVideoMerge(db,log,merge.id,'/studio/static');return service.getById(db,merge.id)}
 return {home,storage,db,cfg,service,clip,create,run,manifest:merge=>JSON.parse(db.prepare('SELECT result FROM async_tasks WHERE id=?').get(merge.task_id).result),
   temp:()=>{const walk=dir=>readdirSync(dir,{withFileTypes:true}).flatMap(entry=>entry.isDirectory()?(entry.name.startsWith('.muse-merge-')?[entry.name]:walk(join(dir,entry.name))):[]);return walk(storage)}}
}

test('the last planner validates its patched source and removes the static clip ceiling',{skip:!existsSync(file)},()=>{
 const planned=new Map(planEpisodeMerge(root,staged));assert.equal(planned.size,2);assert.ok(!planned.get(file).includes('localPaths.length <= 100'));assert.match(planned.get(file),/museEpisodeMerge/)
 assert.throws(()=>planEpisodeMerge(root,path=>staged(path).replace('const first = scenes[0]','const first = changed[0]')),/pinned staged source/)
 assert.throws(()=>planEpisodeMerge(root,path=>planned.get(path)??staged(path)),/pinned staged source/)
})

test('more than one hundred packages produce every ordered frame and their measured complete duration',{skip:!installed,timeout:60000},async t=>{
 const f=fixture(t),urls=['red','green','blue'].map(color=>f.clip(color)),count=103,merge=f.create(Array.from({length:count},(_,i)=>urls[i%3])),done=await f.run(merge)
 assert.equal(done.status,'completed',done.error_msg);assert.ok(Math.abs(done.duration-count*.2)<.25);assert.ok(done.duration<999)
 const output=join(f.storage,done.merged_url),decoded=execFileSync(ffmpeg,['-nostdin','-v','error','-xerror','-i',output,'-vf','scale=1:1','-pix_fmt','rgb24','-f','rawvideo','-'],{maxBuffer:1048576})
 assert.equal(decoded.length,count*2*3);for(let i=0;i<count;i++){const color=decoded.subarray(i*6,i*6+3);assert.equal([...color].indexOf(Math.max(...color)),i%3)}
 const receipt=f.manifest(merge);assert.equal(receipt.verification.clips.length,count);assert.equal(receipt.verification.frames,count*2);assert.equal(new Set(receipt.verification.clips.map(item=>item.storyboard_id)).size,count);assert.deepEqual(f.temp(),[])
})

test('missing packages, unreadable media and incompatible encodings never publish an episode',{skip:!installed,timeout:60000},async t=>{
 for(const mode of ['missing','corrupt','incompatible']){const f=fixture(t),a=f.clip('red','first-'+mode),b=mode==='missing'?'/static/missing.mp4':mode==='corrupt'?'/static/corrupt.mp4':f.clip('blue','wide','48x32');if(mode==='corrupt')writeFileSync(join(f.storage,'corrupt.mp4'),'not a video')
  const merge=f.create([a,b]),done=await f.run(merge);assert.equal(done.status,'failed');assert.equal(f.db.prepare('SELECT video_url FROM episodes WHERE id=1').get().video_url,null);assert.equal(f.db.prepare('SELECT status FROM async_tasks WHERE id=?').get(merge.task_id).status,'failed');assert.deepEqual(f.temp(),[])}
})

test('an omitted storyboard is refused even when all supplied clips are readable',{skip:!installed,timeout:60000},async t=>{
 const f=fixture(t),video=f.clip('red'),merge=f.create([video,video]);const scenes=JSON.parse(f.db.prepare('SELECT scenes FROM video_merges WHERE id=?').get(merge.id).scenes);f.db.prepare('UPDATE video_merges SET scenes=? WHERE id=?').run(JSON.stringify(scenes.slice(0,1)),merge.id)
 const done=await f.run(merge);assert.equal(done.status,'failed');assert.equal(done.error_msg,'merge_all_storyboards_required');assert.deepEqual(f.temp(),[])
})

test('requested dialogue or narration failures preserve the verified candidate and never report completion',{skip:!installed,timeout:60000},async t=>{
 for(const options of [{burn_dialogue_audio:true},{burn_narration_subtitles:true}]){const f=fixture(t),video=f.clip('red'),merge=f.create([video],options);f.db.prepare("UPDATE storyboards SET dialogue='retained dialogue',narration='retained narration' WHERE episode_id=1").run();const done=await f.run(merge)
  assert.equal(done.status,'failed');assert.match(done.error_msg,/audio_required/);assert.ok(existsSync(join(f.storage,done.merged_url)));assert.equal(f.db.prepare('SELECT video_url FROM episodes WHERE id=1').get().video_url,null);assert.equal(f.manifest(merge).recoverable_candidate_url,done.merged_url);assert.deepEqual(f.temp(),[])}
})

test('successful explicit audio replacement is decoded, and separate merges do not overwrite one another',{skip:!installed,timeout:60000},async t=>{
 const f=fixture(t),video=f.clip('red'),audio=join(f.storage,'dialogue.wav');execFileSync(ffmpeg,['-nostdin','-v','error','-f','lavfi','-i','sine=frequency=440:sample_rate=48000','-t','0.1','-c:a','pcm_s16le','-n',audio])
 const first=f.create([video],{burn_dialogue_audio:true});f.db.prepare("UPDATE storyboards SET dialogue='original speech',audio_local_path='dialogue.wav' WHERE episode_id=1").run();const a=await f.run(first);assert.equal(a.status,'completed',a.error_msg)
 const before=readFileSync(join(f.storage,a.merged_url));const scenes=JSON.parse(f.db.prepare('SELECT scenes FROM video_merges WHERE id=?').get(first.id).scenes),second=f.service.create(f.db,{info(){}},{episode_id:1,drama_id:1,scenes}),b=await f.run(second);assert.equal(b.status,'completed');assert.notEqual(a.merged_url,b.merged_url);assert.deepEqual(readFileSync(join(f.storage,a.merged_url)),before);assert.deepEqual(f.temp(),[])
})

test('adoption changes during assembly preserve the newer selection and reject stale episode publication',{skip:!installed,timeout:60000},async t=>{
 const f=fixture(t),a=f.clip('red'),b=f.clip('blue'),merge=f.create([a]),pending=f.run(merge)
 await new Promise(resolve=>setImmediate(resolve));f.db.prepare('UPDATE storyboards SET video_url=? WHERE episode_id=1').run(b)
 const done=await pending;assert.equal(done.status,'failed');assert.equal(done.error_msg,'merge_storyboards_changed');assert.equal(f.db.prepare('SELECT video_url FROM storyboards WHERE episode_id=1').get().video_url,b);assert.equal(f.db.prepare('SELECT video_url FROM episodes WHERE id=1').get().video_url,null);assert.deepEqual(f.temp(),[])
})

test('narration subtitles use adopted audio without a new TTS call and failed watermark processing stays failed',{skip:!installed,timeout:60000},async t=>{
 const f=fixture(t),video=f.clip('red'),audio=join(f.storage,'narration.wav');execFileSync(ffmpeg,['-nostdin','-v','error','-f','lavfi','-i','sine=frequency=440:sample_rate=48000','-t','0.1','-c:a','pcm_s16le','-n',audio])
 const merge=f.create([video],{burn_narration_subtitles:true});f.db.prepare("UPDATE storyboards SET narration='Original narrator',narration_audio_local_path='narration.wav' WHERE episode_id=1").run();const done=await f.run(merge);assert.equal(done.status,'completed',done.error_msg)
 const previous=f.db.prepare('SELECT video_url FROM episodes WHERE id=1').get().video_url,scenes=JSON.parse(f.db.prepare('SELECT scenes FROM video_merges WHERE id=?').get(merge.id).scenes),bad=f.service.create(f.db,{info(){}},{episode_id:1,drama_id:1,scenes,merge_options:{watermark_text:'Expected watermark'}})
 f.cfg.muse_merge.font_file=join(f.storage,'invalid-font.ttf');writeFileSync(f.cfg.muse_merge.font_file,'not a font')
 const failed=await f.run(bad);assert.equal(failed.status,'failed');assert.ok(failed.merged_url);assert.equal(f.db.prepare('SELECT video_url FROM episodes WHERE id=1').get().video_url,previous);assert.deepEqual(f.temp(),[])
})

test('ordinary assembly retains embedded source audio and repeated completion does not create another output',{skip:!installed,timeout:60000},async t=>{
 const f=fixture(t),input=join(f.storage,'with-audio.mp4');execFileSync(ffmpeg,['-nostdin','-v','error','-f','lavfi','-i','color=c=red:s=32x32:r=10','-f','lavfi','-i','sine=frequency=440:sample_rate=48000','-t','0.2','-c:v','libx264','-pix_fmt','yuv420p','-g','1','-bf','0','-c:a','aac','-n',input])
 const merge=f.create(['/static/with-audio.mp4','/static/with-audio.mp4']),done=await f.run(merge);assert.equal(done.status,'completed',done.error_msg)
 const output=join(f.storage,done.merged_url),audio=execFileSync(ffmpeg,['-nostdin','-v','error','-i',output,'-map','0:a:0','-f','s16le','-'],{maxBuffer:1048576});assert.ok(audio.length>1000);assert.ok(audio.some(byte=>byte!==0));const before=readFileSync(output)
 const replay=await f.run(merge);assert.equal(replay.merged_url,done.merged_url);assert.deepEqual(readFileSync(output),before);assert.deepEqual(f.temp(),[])
})

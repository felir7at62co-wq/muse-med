/** Actual native schema and FFmpeg media checks with fixture-only storage and no supplier calls. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {existsSync,mkdirSync,mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {createRequire} from 'node:module';
import {tmpdir} from 'node:os';
import {dirname,join,resolve,sep} from 'node:path';
import {compileFunction} from 'node:vm';

const root=resolve(process.env.LOCALMINIDRAMA_SOURCE||'.local/localminidrama');
const ffmpeg=process.env.FFMPEG_PATH||(process.platform==='win32'?join(root,'backend-node/tools/ffmpeg/ffmpeg.exe'):'ffmpeg');
const ffprobe=process.env.FFPROBE_PATH||(process.platform==='win32'?resolve(process.env.LOCALAPPDATA||tmpdir(),'MuseLocalMiniDrama/studio/tools/ffmpeg/ffprobe.exe'):'ffprobe');
const available=existsSync(join(root,'backend-node/node_modules/better-sqlite3'))&&spawnSync(ffmpeg,['-version'],{windowsHide:true}).status===0&&spawnSync(ffprobe,['-version'],{windowsHide:true}).status===0;
const sha=value=>createHash('sha256').update(value).digest('hex');
const canonical=value=>Array.isArray(value)?'['+value.map(canonical).join(',')+']':value!==null&&typeof value==='object'?'{'+Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>JSON.stringify(key)+':'+canonical(item)).join(',')+'}':JSON.stringify(value);
const digest=value=>sha(canonical(value));
function compile(source,filename,require){const module={exports:{}};compileFunction(source,['require','module','exports','__filename','__dirname','console'],{filename})(require,module,module.exports,filename,dirname(filename),{log(){},warn(){},error(){}});return module.exports;}
function extension(name,require){const file=new URL('../extensions/'+name,import.meta.url);return compile(readFileSync(file,'utf8'),file.pathname,require);}
function video(path,{audio=false,duration=3}={}){
 const args=['-v','error','-f','lavfi','-i','color=c=blue:s=64x64:r=10',...audio?['-f','lavfi','-i','sine=frequency=440:sample_rate=48000']:[],'-t',String(duration),'-c:v','libx264','-pix_fmt','yuv420p',...audio?['-c:a','aac','-shortest']:[],'-n',path];
 const result=spawnSync(ffmpeg,args,{windowsHide:true,maxBuffer:2000000});assert.equal(result.status,0,result.stderr?.toString());return readFileSync(path);
}

test('real native migration and CLI schema resolve HD origin and preserve exact audio and frame clock',{skip:!available},async t=>{
 const nativeRequire=createRequire(join(root,'backend-node/package.json')),Database=nativeRequire('better-sqlite3');
 const home=mkdtempSync(join(tmpdir(),'muse-libtv-native-media-')),storage=join(home,'storage');mkdirSync(storage);
 const db=new Database(join(home,'fixture.sqlite')),statements=[],prepare=db.prepare.bind(db);
 db.prepare=(...args)=>{const statement=prepare(...args);statements.push(statement);return statement;};
 t.after(()=>{db.close();assert.ok(home.startsWith(resolve(tmpdir())+sep+'muse-libtv-native-media-'));rmSync(home,{recursive:true,force:true,maxRetries:5,retryDelay:50});});
 const migrationFile=join(root,'backend-node/src/db/migrate.js'),migrationSource=readFileSync(migrationFile,'utf8');
 const migration=compile(migrationSource,migrationFile,name=>name==='./index.js'?{getDb(){throw Error('Fixture owns its database');}}:name==='../config/index.js'?{loadConfig(){throw Error('Fixture never loads user configuration');}}:nativeRequire(name));migration.runMigrationsAndEnsure(db);
 const cli=extension('muse-libtv-cli.cjs',name=>name==='./museLibTvCliMedia'?{hash:sha,fail:(code,status=409)=>Object.assign(Error(code),{code,status})}:name==='./museLibTvAudio'||name==='./museBudget'?{}:nativeRequire(name));
 cli.schema(db,{});assert.equal(db.prepare('SELECT version FROM muse_libtv_cli_schema').get().version,3);
 db.prepare("INSERT INTO dramas(id,title) VALUES(1,'Fixture')").run();db.prepare("INSERT INTO episodes(id,drama_id,title) VALUES(11,1,'Fixture episode')").run();db.prepare("INSERT INTO storyboards(id,episode_id,storyboard_number,title,video_url) VALUES(7,11,1,'Fixture shot','/static/original.mp4')").run();
 const original=video(join(storage,'original.mp4'),{audio:true}),erased=video(join(home,'provider.mp4'));
 db.prepare("INSERT INTO video_generations(id,drama_id,storyboard_id,provider,model,prompt,status,local_path,video_url) VALUES(20,1,7,'libtv_cli','advanced:video_hd','Original line','completed','original.mp4','/static/original.mp4')").run();
 const url='https://libtv-res.liblib.art/hd-result.mp4',owner={user_uuid:'fixture-user',account_id:'fixture-account',team_id:null};
 const node={nodeKey:'hd-output',nodeType:'video',data:{type:'video',url:[url],resourceMeta:{items:[{kind:'video',width:64,height:64,durationSec:3}]}}};
 const operation='original-hd-fixture',resultId='cli-result-0-'+digest({url}),hash=sha(original),at='2026-11-14T00:00:00.000Z';
 db.prepare('INSERT INTO muse_libtv_cli_operations VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(operation,'a'.repeat(64),JSON.stringify({cli_owner:owner}),digest(owner),'canvas-1','source-node',1,7,'advanced:video_hd','agent-task',1,'','[]','completed',JSON.stringify({records:[{sourceNodeKey:'source-node',nodeKey:'hd-output',ok:true}],media_outputs:[{kind:'video',nodeKey:node.nodeKey,node,nodeSha256:digest(node),url,outputIndex:0}]}),'fixture-budget',at,at);
 db.prepare('INSERT INTO muse_libtv_cli_uploads VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run('upload-1',operation,resultId,hash,'video','video/mp4',original.length,1,'{}','original.mp4','{}','verified');
 db.prepare('INSERT INTO muse_libtv_cli_imports VALUES(?,?,?,?,?,?,?,?,?,?)').run('fixture-import','b'.repeat(64),operation,'upload-1','video',20,hash,'original.mp4',JSON.stringify({result_id:resultId}),at);
 const media=extension('muse-postproduction-media.cjs',name=>name==='../utils/ffmpegPath'?{getFfmpegPath:()=>ffmpeg,getFfprobePath:()=>ffprobe}:nativeRequire(name));
 const timing=extension('muse-libtv-timing.cjs',name=>name==='./musePostproductionMedia'?media:name==='../utils/ffmpegPath'?{getFfmpegPath:()=>ffmpeg,getFfprobePath:()=>ffprobe}:nativeRequire(name));
 const parent={state:'captured',prompt:'Original line',submittedPrompt:'Original line',bindings:[{bindingId:'hero',versionId:'hero-v1'}],references:[],model:'wanx3.0',operationId:operation};
 const api=extension('muse-libtv-postproduction.cjs',name=>name==='./musePostproductionMedia'?media:name==='./museLibTvTiming'?timing:name==='./musePostproduction'?{limits:()=>({max_input_bytes:10000000,max_output_bytes:10000000,http_timeout_ms:3000,media_timeout_ms:30000,json_bytes:2000000})}:name==='./museStudio'?{generationInputs:()=>parent}:nativeRequire(name));
 const cfg={storage:{local_path:storage,base_url:'/static'}},source=api.inspect(db,cfg,20);assert.equal(source.origin.node_id,'hd-output');assert.equal(source.origin.result_url,url);assert.equal(source.origin.operation_id,operation);
 let fetches=0;const service=api.create({fetchImpl:async(received,options)=>{assert.equal(received,'https://libtv-res.liblib.art/erased.mp4');assert.equal(options.redirect,'error');fetches++;return new Response(erased);}});
 const input={database_id:source.database_id,operation_id:'fixture-erased-import',request_sha256:'c'.repeat(64),project_id:1,storyboard_id:7,source_generation_id:20,source_sha256:hash,origin:source.origin,model:'volcano-subtitle-eraser',parameters:{mode:'Subtitle'},provider_task_id:'provider-task-fixture',result_url:'https://libtv-res.liblib.art/erased.mp4',company_id:'company-1',company_operation_id:'api-erase-fixture',quote:{currency:'LTV',reserved_minor:200,identity:'quote-fixture'}};
 const imported=await service.importResult(db,cfg,input),before=source.metadata,after=imported.metadata;
 assert.equal(after.frames,before.frames);assert.equal(after.fps,before.fps);assert.equal(after.width,before.width);assert.equal(after.height,before.height);assert.equal(after.audio_sha256,before.audio_sha256);assert.equal(after.audio_pcm_sha256,before.audio_pcm_sha256);assert.deepEqual(after.audio_clocks,before.audio_clocks);
 assert.equal(sha(readFileSync(join(storage,'original.mp4'))),hash);assert.equal(db.prepare('SELECT video_url FROM storyboards WHERE id=7').get().video_url,'/static/original.mp4');assert.equal(db.prepare('SELECT count(*) AS n FROM video_generations').get().n,2);
 assert.equal((await service.importResult(db,cfg,input)).generation_id,imported.generation_id);assert.equal(fetches,1);assert.deepEqual(api.generationInputs(db,'video',{id:imported.generation_id}).bindings,parent.bindings);
});

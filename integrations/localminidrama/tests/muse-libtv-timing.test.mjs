/** Lossless final-sample correction uses real FFmpeg media without supplier requests. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readFileSync,writeFileSync,mkdtempSync,rmSync} from 'node:fs';
import {createRequire} from 'node:module';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {compileFunction} from 'node:vm';

const require=createRequire(import.meta.url),root=resolve(process.env.LOCALMINIDRAMA_SOURCE||'.local/localminidrama');
const ffmpeg=process.env.FFMPEG_PATH||(process.platform==='win32'?join(root,'backend-node/tools/ffmpeg/ffmpeg.exe'):'ffmpeg');
const ffprobe=process.env.FFPROBE_PATH||(process.platform==='win32'?resolve(process.env.LOCALAPPDATA||tmpdir(),'MuseLocalMiniDrama/studio/tools/ffmpeg/ffprobe.exe'):'ffprobe');
const available=spawnSync(ffmpeg,['-version'],{windowsHide:true}).status===0&&spawnSync(ffprobe,['-version'],{windowsHide:true}).status===0;
function load(name,dependencies){const module={exports:{}};compileFunction(readFileSync(new URL('../extensions/'+name,import.meta.url),'utf8'),['require','module','exports'])(name=>dependencies[name]??require(name),module,module.exports);return module.exports;}
const binaries={getFfmpegPath:()=>ffmpeg,getFfprobePath:()=>ffprobe},media=load('muse-postproduction-media.cjs',{'../utils/ffmpegPath':binaries}),timing=load('muse-libtv-timing.cjs',{'../utils/ffmpegPath':binaries,'./musePostproductionMedia':media});
const limits={media_timeout_ms:30000,json_bytes:2000000,max_input_bytes:10000000,max_output_bytes:10000000};
function run(args){const result=spawnSync(ffmpeg,['-v','error',...args],{windowsHide:true,encoding:'utf8',maxBuffer:2000000});assert.equal(result.status,0,result.stderr);return result.stdout;}
function fixture(t){const home=mkdtempSync(join(tmpdir(),'muse-libtv-clock-'));t.after(()=>{assert.ok(home.startsWith(resolve(tmpdir())+sep+'muse-libtv-clock-'));rmSync(home,{recursive:true,force:true,maxRetries:5,retryDelay:50});});return {home,cfg:{storage:{local_path:home}}};}
function generate(home,name,{fps=30,duration=5,size='64x64',audio=false,bframes=0}={}){run(['-f','lavfi','-i',`testsrc2=s=${size}:r=${fps}`,...audio?['-f','lavfi','-i','sine=frequency=440:sample_rate=48000']:[],'-t',String(duration),'-c:v','libx264','-bf',String(bframes),'-x264-params','b-adapt=0','-pix_fmt','yuv420p',...audio?['-c:a','aac','-shortest']:[],'-video_track_timescale','1000000','-n',join(home,name)]);}
function truncateLastSample(home,source,target,frames){run(['-i',join(home,source),'-map','0:v:0','-c:v','copy','-bsf:v',`setts=duration=if(eq(N\\,${frames-1})\\,1\\,DURATION)`,'-video_track_timescale','1000000','-use_editlist','0','-n',join(home,target)]);}
function decodedFrames(home,name){return run(['-i',join(home,name),'-map','0:v:0','-fps_mode','passthrough','-f','framemd5','-']).split('\n').filter(line=>line&&!line.startsWith('#')).map(line=>line.split(',').at(-1).trim());}

test('a correct clock uses the original file without creating an intermediate',{skip:!available},t=>{
 const {home,cfg}=fixture(t);generate(home,'source.mp4');assert.deepEqual(timing.prepare(cfg,'source.mp4','source.mp4','unused.mp4',limits),{path:'source.mp4',correction:null});
});
test('an incomplete final sample is remuxed with identical encoded and decoded frames and original audio',{skip:!available},t=>{
 const {home,cfg}=fixture(t);generate(home,'source.mp4',{audio:true});truncateLastSample(home,'source.mp4','raw.mp4',150);
 const sourceHash=media.sha(readFileSync(join(home,'source.mp4'))),rawHash=media.sha(readFileSync(join(home,'raw.mp4'))),rawFacts=media.probe(cfg,'raw.mp4',limits);
 assert.equal(rawFacts.frames,150);assert.ok(rawFacts.fps>30);assert.ok(rawFacts.duration_seconds<5);
 const result=timing.prepare(cfg,'source.mp4','raw.mp4','timing/normalized.mp4',limits),facts=media.probe(cfg,result.path,limits);
 assert.equal(result.correction.method,'libtv-final-sample-duration-remux');assert.equal(result.correction.raw_sha256,rawHash);assert.equal(facts.frames,150);assert.equal(facts.fps,30);assert.equal(facts.duration_seconds,5);assert.equal(facts.width,64);assert.equal(facts.height,64);
 assert.deepEqual(decodedFrames(home,result.path),decodedFrames(home,'raw.mp4'));
 const restored=media.restore(cfg,'source.mp4',result.path,'timing/restored.mp4','erase_subtitles',limits),sourceFacts=media.probe(cfg,'source.mp4',limits);
 assert.equal(restored.audio_sha256,sourceFacts.audio_sha256);assert.equal(restored.audio_pcm_sha256,sourceFacts.audio_pcm_sha256);assert.deepEqual(restored.audio_clocks,sourceFacts.audio_clocks);
 assert.equal(media.sha(readFileSync(join(home,'source.mp4'))),sourceHash);assert.equal(media.sha(readFileSync(join(home,'raw.mp4'))),rawHash);
 assert.equal(timing.prepare(cfg,'source.mp4','raw.mp4','timing/normalized.mp4',limits).correction.normalized_sha256,result.correction.normalized_sha256);
});
test('changed frame count, rate or dimensions cannot be repaired as a final-sample defect',{skip:!available},t=>{
 const {home,cfg}=fixture(t);generate(home,'source.mp4');
 for(const [name,options] of [['frames',{duration:4.9}],['rate',{fps:25,duration:6}],['size',{size:'128x64'}]]){
  generate(home,name+'.mp4',options);truncateLastSample(home,name+'.mp4',name+'-raw.mp4',name==='frames'?147:150);
  assert.throws(()=>timing.prepare(cfg,'source.mp4',name+'-raw.mp4',name+'-normalized.mp4',limits),{code:'libtv_postproduction_timing_unverified'});
 }
});
test('B-frame timestamps survive final-sample correction without the edit-list frame loss',{skip:!available},t=>{
 const {home,cfg}=fixture(t);generate(home,'source.mp4',{bframes:3});
 // The final stts entries encode one 33334-tick and two 33333-tick samples. Keep the sample count and change only their durations.
 const bytes=readFileSync(join(home,'source.mp4')),table=bytes.indexOf(Buffer.from('stts')),entries=bytes.readUInt32BE(table+8),last=table+12+(entries-1)*8;
 assert.ok(table>0);assert.equal(bytes.readUInt32BE(last),2);assert.equal(bytes.readUInt32BE(last-8),1);assert.equal(bytes.readUInt32BE(last-4)-bytes.readUInt32BE(last+4),1);
 bytes.writeUInt32BE(2,last-8);bytes.writeUInt32BE(1,last);bytes.writeUInt32BE(1,last+4);writeFileSync(join(home,'raw.mp4'),bytes);
 const rawFacts=media.probe(cfg,'raw.mp4',limits);assert.equal(rawFacts.frames,150);assert.ok(rawFacts.duration_seconds<5);
 const result=timing.prepare(cfg,'source.mp4','raw.mp4','timing/normalized.mp4',limits),facts=media.probe(cfg,result.path,limits);
 assert.equal(facts.frames,150);assert.equal(facts.fps,30);assert.equal(facts.duration_seconds,5);assert.deepEqual(decodedFrames(home,result.path),decodedFrames(home,'raw.mp4'));
 const hash=name=>run(['-i',join(home,name),'-map','0:v:0','-c:v','copy','-f','hash','-hash','sha256','-']).trim().slice(7);
 assert.equal(hash('raw.mp4'),result.correction.video_packet_sha256);assert.equal(hash(result.path),result.correction.video_packet_sha256);
});

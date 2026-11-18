/** Complete local episode assembly with measured source manifests and no implicit supplier calls. */
const fs = require('node:fs');
const path = require('node:path');
const {spawn} = require('node:child_process');
const {createHash,randomUUID} = require('node:crypto');
const {getFfmpegPath,getFfprobePath} = require('../utils/ffmpegPath');
const fail = code => Object.assign(new Error(code),{code});
function settings(cfg) {
  const raw=cfg.muse_merge||{},out={};
  for(const[key,initial,min,max]of [['timeout_ms',900000,1000,3600000],['max_input_bytes',2147483648,1024,Number.MAX_SAFE_INTEGER],
    ['max_output_bytes',2147483648,1024,Number.MAX_SAFE_INTEGER],['duration_tolerance_ms',250,1,5000],['max_process_bytes',2097152,1024,16777216]]) {
    const value=raw[key]??initial;if(!Number.isSafeInteger(value)||value<min||value>max)throw fail('merge_invalid_limits');out[key]=value;
  }
  if(raw.font_file!==undefined&&typeof raw.font_file!=='string')throw fail('merge_invalid_limits');
  out.font_file=raw.font_file||'';return out;
}
async function command(bin,args,job) {
  if(Date.now()>=job.deadline)throw fail('merge_deadline');
  return await new Promise((resolve,reject)=>{
    let child;try{child=spawn(bin,args,{windowsHide:true,stdio:['ignore','pipe','pipe']});}catch(error){reject(fail('merge_tool_unavailable'));return;}
    const output=[],errors=[];let bytes=0,failure;
    const stop=code=>{failure??=code;child.kill('SIGKILL');};
    const timer=setTimeout(()=>stop('merge_deadline'),job.deadline-Date.now());
    const collect=(chunks,chunk)=>{bytes+=chunk.length;if(bytes>job.policy.max_process_bytes)stop('merge_process_output_limit');else chunks.push(chunk);};
    child.stdout.on('data',chunk=>collect(output,chunk));child.stderr.on('data',chunk=>collect(errors,chunk));
    child.once('error',()=>{failure??='merge_tool_unavailable';});
    child.once('close',code=>{clearTimeout(timer);if(failure||code!==0)reject(fail(failure||'merge_media_command_failed'));
      else resolve({stdout:Buffer.concat(output).toString('utf8'),stderr:Buffer.concat(errors).toString('utf8')});});
  });
}
async function probe(file,job) {
  const result=await command(getFfprobePath(),['-v','error','-protocol_whitelist','file,pipe','-count_frames','-show_data','-show_streams','-show_format','-of','json',file],job);
  if(result.stderr.trim())throw fail('merge_source_decode_failed');
  let data;try{data=JSON.parse(result.stdout);}catch(error){throw fail('merge_invalid_probe');}
  if(!Array.isArray(data.streams)||!Number.isFinite(Number(data.format?.duration))||Number(data.format.duration)<=0)throw fail('merge_invalid_probe');
  return data;
}
function facts(data) {
  const videos=data.streams.filter(stream=>stream.codec_type==='video'),audios=data.streams.filter(stream=>stream.codec_type==='audio');
  if(videos.length!==1||audios.length>1||data.streams.some(stream=>!['video','audio'].includes(stream.codec_type)))throw fail('merge_unsupported_streams');
  const frames=Number(videos[0].nb_read_frames),duration=Number(data.format.duration);
  if(!Number.isSafeInteger(frames)||frames<1||!videos[0].width||!videos[0].height)throw fail('merge_invalid_probe');
  const fields=['codec_type','codec_name','profile','level','width','height','pix_fmt','sample_aspect_ratio','r_frame_rate','avg_frame_rate','time_base',
    'sample_fmt','sample_rate','channels','channel_layout','field_order','color_range','color_space','color_transfer','color_primaries','extradata'];
  const signature=JSON.stringify(data.streams.map(stream=>Object.fromEntries([...fields.map(key=>[key,stream[key]??null]),
    ['rotation',stream.tags?.rotate??stream.side_data_list?.find(item=>item.rotation!==undefined)?.rotation??0]])));
  return {frames,duration,signature,audio:audios.length===1,width:videos[0].width,height:videos[0].height};
}
async function digest(file,job) {
  const hash=createHash('sha256');for await(const chunk of fs.createReadStream(file)){if(Date.now()>=job.deadline)throw fail('merge_deadline');hash.update(chunk);}return hash.digest('hex');
}
function localFile(value,root,base) {
  if(typeof value!=='string'||!value.trim()||/[\r\n\0]/.test(value))throw fail('merge_local_source_required');
  let relative=value.trim();
  if(/^https?:\/\//i.test(relative)) {
    let url,publicBase;try{url=new URL(relative);publicBase=new URL(base);}catch(error){throw fail('merge_local_source_required');}
    if(url.username||url.password||url.origin!==publicBase.origin||!url.pathname.startsWith(publicBase.pathname.replace(/\/$/,'')+'/'))throw fail('merge_local_source_required');
    relative=decodeURIComponent(url.pathname.slice(publicBase.pathname.replace(/\/$/,'').length+1));
  } else if(relative.startsWith('/studio/static/'))relative=relative.slice('/studio/static/'.length);
  else if(relative.startsWith('/static/'))relative=relative.slice('/static/'.length);
  const resolved=fs.realpathSync(path.isAbsolute(relative)?relative:path.join(root,relative));
  const fromRoot=path.relative(root,resolved);
  if(!fromRoot||path.isAbsolute(fromRoot)||fromRoot==='..'||fromRoot.startsWith('..'+path.sep)||!fs.statSync(resolved).isFile())throw fail('merge_local_source_required');
  return resolved;
}
function inventory(db,episode) {
  return db.prepare('SELECT id,storyboard_number,video_url FROM storyboards WHERE episode_id=? AND deleted_at IS NULL ORDER BY storyboard_number,id').all(episode);
}
function sourceFile(db,scene,root,base) {
  try{return localFile(scene.video_url,root,base);}catch(error){
    const row=db.prepare("SELECT local_path FROM video_generations WHERE storyboard_id=? AND video_url=? AND status='completed' AND local_path IS NOT NULL AND deleted_at IS NULL ORDER BY id DESC LIMIT 1").get(scene.scene_id,scene.video_url);
    if(!row)throw error;return localFile(row.local_path,root,base);
  }
}
function quote(file) {return "'"+file.replace(/\\/g,'/').replace(/'/g,"'\\''")+"'";}
async function decode(file,job) {
  await command(getFfmpegPath(),['-nostdin','-v','error','-xerror','-err_detect','explode','-protocol_whitelist','file,pipe','-i',file,'-map','0:v:0','-map','0:a?','-f','null','-'],job);
}
async function validate(file,expected,job,wantAudio=false) {
  const current=facts(await probe(file,job));
  if(current.frames!==expected.frames||Math.abs(current.duration-expected.duration)>job.policy.duration_tolerance_ms/1000
    ||current.width!==expected.width||current.height!==expected.height||wantAudio&&!current.audio)throw fail('merge_incomplete_output');
  await decode(file,job);if(fs.statSync(file).size>job.policy.max_output_bytes)throw fail('merge_output_limit');return current;
}
function timestamp(seconds) {const ms=Math.round(seconds*1000),hours=Math.floor(ms/3600000),minutes=Math.floor(ms/60000)%60;
  return String(hours).padStart(2,'0')+':'+String(minutes).padStart(2,'0')+':'+String(Math.floor(ms/1000)%60).padStart(2,'0')+','+String(ms%1000).padStart(3,'0');}
function filterPath(file) {return file.replace(/\\/g,'/').replace(/:/g,'\\:').replace(/'/g,"\\'");}
async function postprocess(db,raw,root,scenes,options,job) {
  const dialogue=options.burn_dialogue_audio===true,narration=options.burn_narration_subtitles===true;
  const watermark=typeof options.watermark_text==='string'?options.watermark_text.trim():'';
  for(const key of ['burn_dialogue_audio','burn_narration_subtitles'])if(options[key]!==undefined&&typeof options[key]!=='boolean')throw fail('merge_invalid_options');
  if(options.watermark_text!==undefined&&typeof options.watermark_text!=='string'||watermark.length>200)throw fail('merge_invalid_options');
  if(!dialogue&&!narration&&!watermark)return raw;
  const audioSegments=[],subtitles=[];let time=0,hasDialogue=false;
  for(const [index,scene]of scenes.entries()) {
    const row=db.prepare('SELECT dialogue,narration,audio_local_path,narration_audio_local_path FROM storyboards WHERE id=? AND deleted_at IS NULL').get(scene.scene_id);
    if(!row)throw fail('merge_storyboards_changed');
    const tracks=[];
    for(const[kind,wanted,text,file]of [['dialogue',dialogue,row.dialogue,row.audio_local_path],['narration',narration,row.narration,row.narration_audio_local_path]]) {
      if(!wanted)continue;
      if(String(text||'').trim()&&!file)throw fail('merge_'+kind+'_audio_required');
      if(file){const absolute=localFile(file,root,''),audio=await probe(absolute,job);
        if(!audio.streams.some(stream=>stream.codec_type==='audio')||audio.streams.some(stream=>stream.codec_type==='video'))throw fail('merge_invalid_audio');
        if(Number(audio.format.duration)>scene.duration+job.policy.duration_tolerance_ms/1000)throw fail('merge_audio_exceeds_clip');tracks.push(absolute);if(kind==='dialogue')hasDialogue=true;}
    }
    if(narration&&String(row.narration||'').trim())subtitles.push(String(subtitles.length/4+1),timestamp(time)+' --> '+timestamp(time+scene.duration),String(row.narration).replace(/\r/g,''),'');
    time+=scene.duration;
    if(dialogue||narration){const output=path.join(job.temp,'audio-'+index+'.wav'),args=['-nostdin','-v','error','-xerror','-protocol_whitelist','file,pipe'];
      for(const track of tracks)args.push('-i',track);
      if(!tracks.length)args.push('-f','lavfi','-i','anullsrc=r=48000:cl=stereo');
      if(tracks.length>1)args.push('-filter_complex',tracks.map((_,i)=>'['+i+':a:0]').join('')+'amix=inputs='+tracks.length+':duration=longest:dropout_transition=0,apad[a]','-map','[a]');
      else args.push('-af','apad');
      args.push('-t',String(scene.duration),'-c:a','pcm_s16le','-ar','48000','-ac','2','-n',output);await command(getFfmpegPath(),args,job);audioSegments.push(output);}
  }
  if(dialogue&&!hasDialogue)throw fail('merge_dialogue_audio_required');
  if(narration&&!subtitles.length)throw fail('merge_narration_text_required');
  const filters=[];
  if(subtitles.length){const file=path.join(job.temp,'narration.srt');fs.writeFileSync(file,subtitles.join('\n')+'\n');filters.push("subtitles='"+filterPath(file)+"':charenc=UTF-8");}
  if(watermark){const file=path.join(job.temp,'watermark.txt');fs.writeFileSync(file,watermark);
    const font=job.policy.font_file||[path.join(process.env.SystemRoot||'C:/Windows','Fonts','msyh.ttc'),'/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'].find(file=>fs.existsSync(file));
    if(job.policy.font_file){let header;try{const fd=fs.openSync(font,'r');try{header=Buffer.alloc(4);if(fs.readSync(fd,header,0,4,0)!==4)throw fail('merge_font_unavailable');}finally{fs.closeSync(fd);}}catch(error){throw fail('merge_font_unavailable');}
      if(!['00010000','4f54544f','74746366','74727565'].includes(header.toString('hex')))throw fail('merge_font_unavailable');}
    filters.push("drawtext=textfile='"+filterPath(file)+"':expansion=none"+(font?":fontfile='"+filterPath(font)+"'":'')+':x=w-tw-16:y=h-th-16:fontsize=22:fontcolor=white:borderw=2');}
  const args=['-nostdin','-v','error','-xerror','-protocol_whitelist','file,pipe','-i',raw];
  if(audioSegments.length){const list=path.join(job.temp,'audio.txt');fs.writeFileSync(list,audioSegments.map(file=>'file '+quote(file)).join('\n')+'\n');args.push('-f','concat','-safe','0','-i',list,'-map','0:v:0','-map','1:a:0','-c:a','aac','-b:a','192k');}
  else args.push('-map','0:v:0','-map','0:a?','-c:a','copy');
  if(filters.length)args.push('-vf',filters.join(','),'-c:v','libx264','-preset','veryfast','-crf','23','-pix_fmt','yuv420p','-fps_mode','passthrough');
  else args.push('-c:v','copy');
  const output=path.join(job.temp,'post.mp4');args.push('-movflags','+faststart','-n',output);await command(getFfmpegPath(),args,job);return output;
}
async function processVideoMerge(db,log,mergeId,baseUrl) {
  const row=db.prepare('SELECT * FROM video_merges WHERE id=? AND deleted_at IS NULL').get(mergeId);
  if(!row||row.status==='completed'||row.status==='processing')return;
  const job={temp:null};const task=require('./taskService');let candidate=null,manifest=[],expected,episode;
  const claim=db.prepare("UPDATE video_merges SET status='processing',error_msg=NULL WHERE id=? AND status IN('pending','failed') AND deleted_at IS NULL").run(mergeId);if(claim.changes!==1)return;
  if(row.task_id)task.updateTaskStatus(db,row.task_id,'processing',0,'Validating all episode packages');
  try{
    const cfg=require('../config').loadConfig(),policy=settings(cfg),root=fs.realpathSync(path.resolve(cfg.storage?.local_path||'./data/storage'));
    job.policy=policy;job.deadline=Date.now()+policy.timeout_ms;
    const scenes=JSON.parse(row.scenes||'[]'),options=JSON.parse(row.merge_options||'{}'),shots=inventory(db,row.episode_id);
    if(!options||typeof options!=='object'||Array.isArray(options))throw fail('merge_invalid_options');
    if(!Array.isArray(scenes)||!scenes.length||scenes.length!==shots.length||scenes.some((scene,i)=>Number(scene.scene_id)!==shots[i].id||!shots[i].video_url))throw fail('merge_all_storyboards_required');
    const originalInventory=JSON.stringify(shots);episode=db.prepare('SELECT video_url FROM episodes WHERE id=? AND deleted_at IS NULL').get(row.episode_id);
    if(!episode)throw fail('merge_episode_missing');
    const sub=require('./storageLayout').getProjectStorageSubdir(db,row.drama_id),directory=path.join(root,...(sub?[sub]:[]),'videos','merged');fs.mkdirSync(directory,{recursive:true});
    job.temp=fs.mkdtempSync(path.join(directory,'.muse-merge-'));
    const paths=[],cached=new Map();let inputBytes=0;
    for(const scene of scenes){const file=sourceFile(db,scene,root,baseUrl),adopted=sourceFile(db,{scene_id:scene.scene_id,video_url:shots[paths.length].video_url},root,baseUrl);
      if(file!==adopted)throw fail('merge_adopted_video_changed');
      inputBytes+=fs.statSync(file).size;if(!Number.isSafeInteger(inputBytes)||inputBytes>policy.max_input_bytes)throw fail('merge_input_limit');
      let item=cached.get(file);if(!item){item={...facts(await probe(file,job)),sha256:await digest(file,job)};cached.set(file,item);}
      if(expected&&item.signature!==expected.signature)throw fail('merge_incompatible_clips');
      expected??={...item,frames:0,duration:0};expected.frames+=item.frames;expected.duration+=item.duration;
      paths.push(file);manifest.push({storyboard_id:scene.scene_id,local_path:path.relative(root,file).replace(/\\/g,'/'),sha256:item.sha256,frames:item.frames,duration:item.duration});}
    const list=path.join(job.temp,'clips.txt'),raw=path.join(job.temp,'candidate.mp4');fs.writeFileSync(list,paths.map(file=>'file '+quote(file)).join('\n')+'\n');
    const concat=['-nostdin','-v','error','-xerror','-protocol_whitelist','file,pipe','-f','concat','-safe','0','-i',list,'-map','0:v:0','-map','0:a?','-c:v','copy'];
    if(expected.audio)concat.push('-af','aresample=async=1:first_pts=0','-c:a','aac','-ar','48000','-ac','2','-b:a','192k');
    concat.push('-movflags','+faststart','-n',raw);await command(getFfmpegPath(),concat,job);
    await validate(raw,expected,job,expected.audio);
    const rawTarget=path.join(directory,'merged-'+mergeId+'-'+randomUUID()+'.mp4');await fs.promises.link(raw,rawTarget);candidate=path.relative(root,rawTarget).replace(/\\/g,'/');
    const output=await postprocess(db,rawTarget,root,scenes.map((scene,i)=>({...scene,duration:manifest[i].duration})),options,job);
    const measured=await validate(output,expected,job,expected.audio||options.burn_dialogue_audio||options.burn_narration_subtitles);
    let final=candidate;if(output!==rawTarget){const target=path.join(directory,'merged-'+mergeId+'-post-'+randomUUID()+'.mp4');await fs.promises.link(output,target);final=path.relative(root,target).replace(/\\/g,'/');}
    for(const[file,item]of cached)if(await digest(file,job)!==item.sha256)throw fail('merge_source_changed');
    const verification={version:1,clips:manifest,frames:measured.frames,duration_seconds:measured.duration,sha256:await digest(path.join(root,final),job),candidate_url:candidate};
    db.transaction(()=>{if(JSON.stringify(inventory(db,row.episode_id))!==originalInventory||db.prepare('SELECT video_url FROM episodes WHERE id=? AND deleted_at IS NULL').get(row.episode_id)?.video_url!==episode.video_url)throw fail('merge_storyboards_changed');
      const now=new Date().toISOString(),saved=db.prepare("UPDATE video_merges SET status='completed',merged_url=?,duration=?,completed_at=?,error_msg=NULL WHERE id=? AND status='processing' AND deleted_at IS NULL").run(final,measured.duration,now,mergeId);if(saved.changes!==1)throw fail('merge_record_changed');
      db.prepare("UPDATE episodes SET video_url=?,status='completed',updated_at=? WHERE id=?").run(final,now,row.episode_id);
      if(row.task_id)task.updateTaskResult(db,row.task_id,{merge_id:mergeId,video_url:final,duration:measured.duration,verification});})();
  }catch(error){const code=/^merge_[a-z_]+$/.test(error.code||'')?error.code:'merge_failed';
    db.prepare("UPDATE video_merges SET status='failed',error_msg=?,merged_url=?,completed_at=NULL WHERE id=? AND deleted_at IS NULL").run(code,candidate,mergeId);
    if(row.task_id){task.updateTaskError(db,row.task_id,code);db.prepare('UPDATE async_tasks SET result=? WHERE id=?').run(JSON.stringify({merge_id:mergeId,state:'failed',error_code:code,recoverable_candidate_url:candidate,sources:manifest}),row.task_id);}
    if(episode)db.prepare("UPDATE episodes SET status=? WHERE id=? AND video_url IS ? AND status='processing'").run(episode.video_url?'completed':'failed',row.episode_id,episode.video_url);
    log.warn('Episode merge failed',{merge_id:mergeId,code});
  }finally{if(job.temp)await fs.promises.rm(job.temp,{recursive:true,force:true});}
}
module.exports={processVideoMerge,settings};

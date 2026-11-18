/** Exact source bytes, complete media decode and original-audio restoration for immutable derived video versions. */
const fs=require('node:fs'),path=require('node:path'),{createHash,randomUUID}=require('node:crypto'),{spawnSync}=require('node:child_process');
const fail=code=>Object.assign(Error(code),{code,status:422});
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
function root(cfg){if(typeof cfg.storage?.local_path!=='string'||!cfg.storage.local_path)throw fail('postproduction_storage_unavailable');return path.resolve(cfg.storage.local_path);}
function file(cfg,relative){if(typeof relative!=='string'||!relative||relative.includes('\0'))throw fail('postproduction_invalid_path');
 const parent=fs.realpathSync(root(cfg)),target=path.resolve(parent,relative);if(!target.startsWith(parent+path.sep))throw fail('postproduction_invalid_path');
 if(fs.existsSync(target)&&!fs.realpathSync(target).startsWith(parent+path.sep))throw fail('postproduction_invalid_path');return target;}
function read(cfg,relative,maximum){const target=file(cfg,relative),stat=fs.statSync(target);if(!stat.isFile()||stat.size<=0||stat.size>maximum)throw fail('postproduction_media_limit');return fs.readFileSync(target);}
function save(cfg,relative,bytes){const target=file(cfg,relative);fs.mkdirSync(path.dirname(target),{recursive:true});
 const parent=fs.realpathSync(path.dirname(target));if(!parent.startsWith(fs.realpathSync(root(cfg))+path.sep))throw fail('postproduction_invalid_path');
 const temporary=target+'.partial-'+randomUUID();
 try{const fd=fs.openSync(temporary,'wx',0o600);try{fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
  try{fs.linkSync(temporary,target);}catch(error){if(error.code!=='EEXIST'||sha(fs.readFileSync(target))!==sha(bytes))throw error;}
 }finally{try{fs.unlinkSync(temporary);}catch(error){if(error.code!=='ENOENT')throw error;}}return target;}
function command(kind,args,limits){const binaries=require('../utils/ffmpegPath'),binary=kind==='probe'?binaries.getFfprobePath():binaries.getFfmpegPath();
 const result=spawnSync(binary,args,{encoding:'utf8',timeout:limits.media_timeout_ms,maxBuffer:limits.json_bytes,windowsHide:true});
 if(result.error||result.status!==0||result.signal)throw fail('postproduction_'+kind+'_failed');return result.stdout;}
function probe(cfg,relative,limits,decode=true){const target=file(cfg,relative);let result;
 try{result=JSON.parse(command('probe',['-v','error','-count_frames','-show_streams','-show_format','-of','json',target],limits));}
 catch(error){throw fail('postproduction_probe_failed');}
 const videos=result.streams?.filter(stream=>stream.codec_type==='video')||[],audio=result.streams?.filter(stream=>stream.codec_type==='audio')||[];
 const video=videos[0],duration=Number(video?.duration??result.format?.duration),frames=Number(video?.nb_read_frames),fraction=String(video?.avg_frame_rate).split('/').map(Number),fps=fraction[0]/fraction[1];
 if(videos.length!==1||!Number.isFinite(duration)||duration<=0||!Number.isSafeInteger(frames)||frames<=0||!Number.isFinite(fps)||fps<=0||!video.width||!video.height)throw fail('postproduction_invalid_video');
 if(decode)command('decode',['-v','error','-xerror','-err_detect','explode','-i',target,'-map','0:v','-map','0:a?','-f','null','-'],limits);
 const audioHash=audio.length?command('decode',['-v','error','-i',target,'-map','0:a','-c','copy','-f','hash','-hash','sha256','-'],limits).trim():null;
 const pcmHash=audio.length?command('decode',['-v','error','-i',target,'-map','0:a','-c:a','pcm_s32le','-f','hash','-hash','sha256','-'],limits).trim():null;
 const clocks=audio.map(stream=>{const rate=Number(stream.sample_rate),start=Number(stream.start_time);
  if(!Number.isFinite(rate)||rate<=0||!Number.isSafeInteger(stream.channels)||stream.channels<1)throw fail('postproduction_audio_metadata_unverified');
  return {sample_rate:rate,channels:stream.channels,start_seconds:stream.start_time!==undefined&&Number.isFinite(start)?start:null};});
 return {duration_seconds:duration,frames,fps,width:video.width,height:video.height,video_codec:video.codec_name,audio_streams:audio.length,audio_sha256:audioHash,audio_pcm_sha256:pcmHash,
  audio_clocks:clocks,complete_decode:true};}
function restore(cfg,source,raw,output,kind,limits){const before=probe(cfg,source,limits),candidate=probe(cfg,raw,limits),tolerance=1/before.fps+0.00001;
 if(candidate.frames!==before.frames||Math.abs(candidate.fps-before.fps)>0.00001||Math.abs(candidate.duration_seconds-before.duration_seconds)>tolerance)throw fail('postproduction_picture_clock_changed');
 if(kind==='upscale'&&(candidate.width!==before.width*2||candidate.height!==before.height*2))throw fail('postproduction_upscale_dimensions_changed');
 if(kind==='erase_subtitles'&&(candidate.width!==before.width||candidate.height!==before.height))throw fail('postproduction_erase_dimensions_changed');
 const destination=file(cfg,output),temporary=destination+'.partial-'+randomUUID()+'.mp4';fs.mkdirSync(path.dirname(destination),{recursive:true});
 try{
  command('mux',['-v','error','-xerror','-i',file(cfg,raw),'-i',file(cfg,source),'-map','0:v:0',...before.audio_streams?['-map','1:a']:[],
   '-c','copy','-map_metadata','-1','-n',temporary],limits);
  const bytes=fs.readFileSync(temporary);if(bytes.length>limits.max_output_bytes)throw fail('postproduction_media_limit');
  save(cfg,output,bytes);
 }finally{try{fs.unlinkSync(temporary);}catch(error){if(error.code!=='ENOENT')throw error;}}
 const actual=probe(cfg,output,limits);
 if(actual.frames!==before.frames||Math.abs(actual.fps-before.fps)>0.00001||Math.abs(actual.duration_seconds-before.duration_seconds)>tolerance
  ||actual.width!==candidate.width||actual.height!==candidate.height)throw fail('postproduction_picture_clock_changed');
 if(actual.audio_sha256!==before.audio_sha256||actual.audio_pcm_sha256!==before.audio_pcm_sha256||actual.audio_streams!==before.audio_streams
  ||actual.audio_clocks.some((stream,index)=>stream.sample_rate!==before.audio_clocks[index].sample_rate||stream.channels!==before.audio_clocks[index].channels
   ||stream.start_seconds===null||before.audio_clocks[index].start_seconds===null||Math.abs(stream.start_seconds-before.audio_clocks[index].start_seconds)>1/stream.sample_rate))throw fail('postproduction_original_audio_changed');
 return actual;
}
function segments(facts,limits){const count=Math.floor(limits.erase_segment_seconds*facts.fps);
 if(count<1||count/facts.fps>=5)throw fail('postproduction_invalid_segment_duration');
 const rows=[];for(let start=0;start<facts.frames;start+=count)rows.push({index:rows.length+1,start_frame:start,end_frame:Math.min(start+count,facts.frames)});
 if(rows.length>limits.max_segments)throw fail('postproduction_segment_limit');return rows;}
function cut(cfg,source,part,destination,limits){const target=file(cfg,destination),temporary=target+'.partial-'+randomUUID()+'.mp4';fs.mkdirSync(path.dirname(target),{recursive:true});
 try{
  command('cut',['-v','error','-xerror','-i',file(cfg,source),'-vf',`trim=start_frame=${part.start_frame}:end_frame=${part.end_frame},setpts=PTS-STARTPTS`,
   '-an','-fps_mode','passthrough','-c:v','libx264','-crf',String(limits.video_crf),'-preset',limits.video_preset,'-pix_fmt','yuv420p','-n',temporary],limits);
  const bytes=fs.readFileSync(temporary);if(bytes.length>limits.max_input_bytes)throw fail('postproduction_media_limit');save(cfg,destination,bytes);
 }finally{try{fs.unlinkSync(temporary);}catch(error){if(error.code!=='ENOENT')throw error;}}
 return probe(cfg,destination,limits);
}
function verifyPart(cfg,raw,part,original,kind,limits){const facts=probe(cfg,raw,limits),expected=part.end_frame-part.start_frame;
 if(facts.frames!==expected||Math.abs(facts.fps-original.fps)>0.00001||Math.abs(facts.duration_seconds-expected/original.fps)>1/original.fps+0.00001)throw fail('postproduction_picture_clock_changed');
 const factor=kind==='upscale'?2:1;if(facts.width!==original.width*factor||facts.height!==original.height*factor)throw fail('postproduction_dimensions_changed');return facts;}
function concat(cfg,paths,destination,limits){
 if(!paths.length)throw fail('postproduction_missing_segments');const inputs=paths.map(relative=>file(cfg,relative));
 const target=file(cfg,destination),temporary=target+'.partial-'+randomUUID()+'.mp4';fs.mkdirSync(path.dirname(target),{recursive:true});
 try{
  const filters=inputs.map((_path,index)=>`[${index}:v:0]setpts=PTS-STARTPTS[v${index}]`).join(';')+';'
   +inputs.map((_path,index)=>`[v${index}]`).join('')+`concat=n=${inputs.length}:v=1:a=0[out]`;
  command('concat',['-v','error','-xerror',...inputs.flatMap(path=>['-i',path]),'-filter_complex',filters,'-map','[out]',
   '-an','-fps_mode','passthrough','-c:v','libx264','-crf',String(limits.video_crf),'-preset',limits.video_preset,'-pix_fmt','yuv420p','-n',temporary],limits);
  const bytes=fs.readFileSync(temporary);if(bytes.length>limits.max_output_bytes)throw fail('postproduction_media_limit');save(cfg,destination,bytes);
 }finally{try{fs.unlinkSync(temporary);}catch(error){if(error.code!=='ENOENT')throw error;}}
 return probe(cfg,destination,limits);
}
function joinSegments(cfg,rows,prefix,limits){let paths=rows.map(row=>row.raw_path),round=0;
 while(paths.length>1){const next=[];for(let start=0;start<paths.length;start+=limits.concat_batch_size){const group=paths.slice(start,start+limits.concat_batch_size);
  if(group.length===1){next.push(group[0]);continue;}const destination=prefix+`/joined-${round}-${Math.floor(start/limits.concat_batch_size)}.mp4`;concat(cfg,group,destination,limits);next.push(destination);}
  paths=next;round++;}return paths[0];}
module.exports={sha,root,file,read,save,probe,restore,segments,cut,verifyPart,joinSegments};

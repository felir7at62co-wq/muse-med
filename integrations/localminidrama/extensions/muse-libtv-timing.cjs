/** Preserve every encoded frame when LibTV omits the final sample's display duration. */
const fs=require('node:fs'),path=require('node:path'),{randomUUID}=require('node:crypto'),{spawnSync}=require('node:child_process');
const media=require('./musePostproductionMedia');
const epsilon=0.00001;
const fail=()=>Object.assign(Error('libtv_postproduction_timing_unverified'),{code:'libtv_postproduction_timing_unverified',status:422});
function command(kind,args,limits){
 const binaries=require('../utils/ffmpegPath'),result=spawnSync(kind==='probe'?binaries.getFfprobePath():binaries.getFfmpegPath(),args,{encoding:'utf8',timeout:limits.media_timeout_ms,maxBuffer:limits.json_bytes,windowsHide:true});
 if(result.error||result.status!==0||result.signal)throw fail();return result.stdout;
}
function fraction(value){const parts=String(value).split('/').map(Number);return parts.length===2&&parts[1]>0?parts[0]/parts[1]:NaN;}
function clock(cfg,relative,limits){
 let result;try{result=JSON.parse(command('probe',['-v','error','-select_streams','v:0','-show_frames','-show_packets','-show_streams','-show_entries','stream=r_frame_rate:frame=best_effort_timestamp_time:packet=pts_time,dts_time,duration_time','-of','json',media.file(cfg,relative)],limits));}catch(error){throw fail();}
 const rows=result.packets_and_frames;
 if(!Array.isArray(rows)||result.streams?.length!==1)throw fail();
 return {rate:result.streams[0].r_frame_rate,frames:rows.filter(row=>row.type==='frame').map(row=>Number(row.best_effort_timestamp_time)),packets:rows.filter(row=>row.type==='packet').map(row=>({pts:Number(row.pts_time),dts:Number(row.dts_time),duration:Number(row.duration_time)}))};
}
function onGrid(times,frames,fps){return times.length===frames&&times.every((time,index)=>Number.isFinite(time)&&Math.abs(time-index/fps)<=epsilon);}
function videoHash(cfg,relative,limits){const value=command('hash',['-v','error','-i',media.file(cfg,relative),'-map','0:v:0','-c:v','copy','-f','hash','-hash','sha256','-'],limits).trim();if(!/^SHA256=[a-f0-9]{64}$/.test(value))throw fail();return value.slice(7);}
/** Return the untouched file or a lossless remux after proving that only its last sample duration is incomplete. */
function prepare(cfg,source,raw,destination,limits){
 const before=media.probe(cfg,source,limits),candidate=media.probe(cfg,raw,limits);
 if(candidate.frames===before.frames&&Math.abs(candidate.fps-before.fps)<=epsilon&&Math.abs(candidate.duration_seconds-before.duration_seconds)<=epsilon)return {path:raw,correction:null};
 if(candidate.frames!==before.frames||candidate.width!==before.width||candidate.height!==before.height||Math.abs(before.duration_seconds-before.frames/before.fps)>epsilon)throw fail();
 const period=1/before.fps,deficit=before.duration_seconds-candidate.duration_seconds;
 if(!(deficit>epsilon&&deficit<=period+epsilon))throw fail();
 const originalClock=clock(cfg,source,limits),rawClock=clock(cfg,raw,limits);
 if(Math.abs(fraction(originalClock.rate)-before.fps)>epsilon||Math.abs(fraction(rawClock.rate)-before.fps)>epsilon||!onGrid(originalClock.frames,before.frames,before.fps)||!onGrid(rawClock.frames,before.frames,before.fps)||rawClock.packets.length!==before.frames)throw fail();
 const packetTimes=rawClock.packets.map(packet=>packet.pts).sort((a,b)=>a-b);
 if(!onGrid(packetTimes,before.frames,before.fps)||rawClock.packets.some((packet,index)=>!Number.isFinite(packet.dts)||(index>0&&packet.dts<=rawClock.packets[index-1].dts)))throw fail();
 const short=rawClock.packets.filter(packet=>!Number.isFinite(packet.duration)||Math.abs(packet.duration-period)>epsilon);
 if(short.length!==1||short[0].pts!==packetTimes.at(-1)||!(short[0].duration>0&&short[0].duration<period-epsilon)||Math.abs(short[0].duration+deficit-period)>epsilon)throw fail();
 const rawHash=videoHash(cfg,raw,limits),target=media.file(cfg,destination),temporary=target+'.partial-'+randomUUID()+'.mp4';fs.mkdirSync(path.dirname(target),{recursive:true});
 try{
  command('remux',['-v','error','-xerror','-i',media.file(cfg,raw),'-map','0:v:0','-c:v','copy','-r',originalClock.rate,'-map_metadata','-1','-n',temporary],limits);
  const relative=path.relative(media.root(cfg),temporary),after=media.probe(cfg,relative,limits),afterClock=clock(cfg,relative,limits),afterHash=videoHash(cfg,relative,limits);
  if(after.frames!==before.frames||Math.abs(after.fps-before.fps)>epsilon||Math.abs(after.duration_seconds-before.duration_seconds)>epsilon||after.width!==before.width||after.height!==before.height||!onGrid(afterClock.frames,before.frames,before.fps)||afterHash!==rawHash)throw fail();
  const bytes=fs.readFileSync(temporary);if(bytes.length>limits.max_output_bytes)throw fail();media.save(cfg,destination,bytes);
  return {path:destination,correction:{method:'libtv-final-sample-duration-remux',raw_sha256:media.sha(media.read(cfg,raw,limits.max_output_bytes)),normalized_sha256:media.sha(bytes),video_packet_sha256:rawHash,raw_metadata:candidate,normalized_metadata:after,original_last_sample_duration_seconds:short[0].duration}};
 }finally{try{fs.unlinkSync(temporary);}catch(error){if(error.code!=='ENOENT')throw error;}}
}
module.exports={prepare};

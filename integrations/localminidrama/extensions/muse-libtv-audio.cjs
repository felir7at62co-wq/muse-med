/** Verified standalone LibTV audio assets; imported media never fabricates a TTS model or speaker. */
const {spawnSync}=require('node:child_process'),fs=require('node:fs');
const media=require('./musePostproductionMedia');
const fail=(code,status=422)=>Object.assign(Error(code),{code,status});
const formats={'audio/wav':'wav','audio/mpeg':'mp3','audio/flac':'flac','audio/ogg':'ogg','audio/mp4':'mov'};
function mime(bytes){
 if(bytes.length>=12&&bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WAVE')return 'audio/wav';
 if(bytes.length>=4&&bytes.toString('ascii',0,4)==='fLaC')return 'audio/flac';
 if(bytes.length>=4&&bytes.toString('ascii',0,4)==='OggS')return 'audio/ogg';
 if(bytes.length>=3&&(bytes.toString('ascii',0,3)==='ID3'||bytes[0]===255&&(bytes[1]&224)===224))return 'audio/mpeg';
 if(bytes.length>=12&&bytes.toString('ascii',4,8)==='ftyp')return 'audio/mp4';
 throw fail('libtv_audio_type_unverified');
}
function facts(cfg,relative,type,cap){
 if(!Object.hasOwn(formats,type))throw fail('libtv_audio_type_unverified');
 const file=media.file(cfg,relative),stat=fs.statSync(file);
 if(!stat.isFile()||stat.size<1||stat.size>cap.max_media_bytes)throw fail('libtv_audio_limit');
 const fd=fs.openSync(file,'r'),header=Buffer.alloc(16);try{fs.readSync(fd,header,0,header.length,0);}finally{fs.closeSync(fd);}
 if(mime(header)!==type)throw fail('libtv_audio_type_changed');
 const binaries=require('../utils/ffmpegPath'),input=['-protocol_whitelist','file,pipe','-format_whitelist',formats[type],'-f',formats[type],...type==='audio/mp4'?['-enable_drefs','0']:[]];
 const run=(binary,args)=>{const out=spawnSync(binary,args,{encoding:'utf8',windowsHide:true,timeout:cap.media_timeout_ms,maxBuffer:cap.json_bytes});if(out.error||out.signal||out.status!==0)throw fail('libtv_audio_decode_failed');return out.stdout;};
 let parsed;try{parsed=JSON.parse(run(binaries.getFfprobePath(),['-v','error',...input,'-show_streams','-show_format','-of','json',file]));}catch(error){throw fail('libtv_audio_probe_failed');}
 const tracks=parsed.streams,duration=Number(parsed.format?.duration),track=tracks?.[0];
 if(!Array.isArray(tracks)||tracks.length!==1||track.codec_type!=='audio'||typeof track.codec_name!=='string'||!track.codec_name||!Number.isFinite(duration)||duration<=0
  ||!Number.isSafeInteger(Number(track.sample_rate))||Number(track.sample_rate)<1||!Number.isSafeInteger(track.channels)||track.channels<1)throw fail('libtv_audio_clock_unverified');
 run(binaries.getFfmpegPath(),['-v','error','-xerror','-err_detect','explode',...input,'-i',file,'-map','0:a:0','-f','null','-']);
 return {native_kind:'audio',mime_type:type,duration_seconds:duration,codec:track.codec_name,sample_rate:Number(track.sample_rate),channels:track.channels,complete_decode:true};
}
function insertAsset(db,cfg,{project_id,name,category,local_path,size_bytes,media:facts}){
 if(!db.prepare('SELECT 1 FROM dramas WHERE id=? AND deleted_at IS NULL').get(project_id))throw fail('libtv_audio_project_not_found',404);
 const columns=new Set(db.prepare('PRAGMA table_info(assets)').all().map(row=>row.name));
 for(const column of ['drama_id','name','type','category','url','local_path','file_size','mime_type','duration','created_at','updated_at'])if(!columns.has(column))throw fail('libtv_audio_asset_schema_changed',503);
 const at=new Date().toISOString(),url=String(cfg.storage.base_url||'/static').replace(/\/$/,'')+'/'+local_path;
 return Number(db.prepare('INSERT INTO assets(drama_id,name,type,category,url,local_path,file_size,mime_type,duration,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
  .run(project_id,name,'audio',category,url,local_path,size_bytes,facts.mime_type,facts.duration_seconds,at,at).lastInsertRowid);
}
module.exports={mime,facts,insertAsset};

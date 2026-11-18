/** Durable independent TTS generations and explicit character-period video voice references. */
const {createHash,randomUUID}=require('node:crypto');
const fs=require('node:fs');
const path=require('node:path');
const {spawnSync}=require('node:child_process');
const active=new WeakMap();
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const canonical=value=>JSON.stringify(value);
const fail=(code,status=400)=>Object.assign(new Error(code),{code,status});
const positive=value=>Number.isSafeInteger(Number(value))&&Number(value)>0;
function operation(value){if(typeof value!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(value))throw fail('operation_id_required');return value;}
function period(value){if(typeof value!=='string'||!value.trim()||value.length>80||/[\0\r\n]/.test(value))throw fail('voice_period_required');return value.trim();}
function schema(db){
 db.exec('CREATE TABLE IF NOT EXISTS muse_audio_schema (version INTEGER NOT NULL,database_id TEXT NOT NULL)');
 const versions=db.prepare('SELECT version FROM muse_audio_schema').all();
 if(versions.length>1||versions[0]&&![1,2].includes(versions[0].version))throw fail('unsupported_audio_schema',503);
 if(versions[0]?.version===1)db.transaction(()=>{db.exec('ALTER TABLE muse_tts_generations ADD COLUMN cancel_requested_at TEXT; ALTER TABLE muse_tts_generations ADD COLUMN request_text TEXT; CREATE TRIGGER muse_tts_immutable_text BEFORE UPDATE OF request_text ON muse_tts_generations WHEN OLD.request_text IS NOT NULL AND NEW.request_text IS NOT OLD.request_text BEGIN SELECT RAISE(ABORT,\'tts_text_immutable\'); END; CREATE TABLE muse_video_voice_inputs (video_generation_id INTEGER PRIMARY KEY,storyboard_id INTEGER NOT NULL,binding_operation_id TEXT NOT NULL,voices_json TEXT NOT NULL,created_at TEXT NOT NULL); CREATE TRIGGER muse_video_voice_inputs_immutable_update BEFORE UPDATE ON muse_video_voice_inputs BEGIN SELECT RAISE(ABORT,\'voice_inputs_immutable\'); END; CREATE TRIGGER muse_video_voice_inputs_immutable_delete BEFORE DELETE ON muse_video_voice_inputs BEGIN SELECT RAISE(ABORT,\'voice_inputs_immutable\'); END;');db.prepare('UPDATE muse_audio_schema SET version=2').run();}).immediate();
 if(versions.length){if(!active.has(db)){db.prepare("UPDATE muse_tts_generations SET state='unknown',error_code='process_interrupted' WHERE state='generating'").run();active.set(db,new Set());}return;}
 db.transaction(()=>{db.exec(`
 CREATE TABLE muse_voice_assets (id INTEGER PRIMARY KEY AUTOINCREMENT,drama_id INTEGER NOT NULL,character_id INTEGER NOT NULL,voice_period_id TEXT NOT NULL,sha256 TEXT NOT NULL,local_path TEXT NOT NULL,duration_seconds REAL NOT NULL,codec TEXT NOT NULL,sample_rate INTEGER NOT NULL,channels INTEGER NOT NULL,created_at TEXT NOT NULL,UNIQUE(character_id,voice_period_id,sha256));
 CREATE TABLE muse_voice_selections (character_id INTEGER NOT NULL,voice_period_id TEXT NOT NULL,voice_asset_id INTEGER NOT NULL,adoption_operation_id TEXT NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(character_id,voice_period_id));
 CREATE TABLE muse_video_voice_bindings (storyboard_id INTEGER PRIMARY KEY,operation_id TEXT NOT NULL,voices_json TEXT NOT NULL,updated_at TEXT NOT NULL);
 CREATE TABLE muse_tts_generations (operation_id TEXT PRIMARY KEY,request_sha256 TEXT NOT NULL,storyboard_id INTEGER NOT NULL,tts_kind TEXT NOT NULL,config_id INTEGER NOT NULL,provider TEXT NOT NULL,base_url TEXT NOT NULL,model TEXT NOT NULL,voice_id TEXT NOT NULL,speed REAL NOT NULL,text_sha256 TEXT NOT NULL,state TEXT NOT NULL,local_path TEXT NOT NULL,raw_sha256 TEXT,duration_seconds REAL,error_code TEXT,created_at TEXT NOT NULL,completed_at TEXT,cancel_requested_at TEXT,request_text TEXT);
 CREATE TRIGGER muse_tts_immutable_text BEFORE UPDATE OF request_text ON muse_tts_generations WHEN OLD.request_text IS NOT NULL AND NEW.request_text IS NOT OLD.request_text BEGIN SELECT RAISE(ABORT,'tts_text_immutable'); END;
 CREATE TABLE muse_video_voice_inputs (video_generation_id INTEGER PRIMARY KEY,storyboard_id INTEGER NOT NULL,binding_operation_id TEXT NOT NULL,voices_json TEXT NOT NULL,created_at TEXT NOT NULL);
 CREATE TRIGGER muse_video_voice_inputs_immutable_update BEFORE UPDATE ON muse_video_voice_inputs BEGIN SELECT RAISE(ABORT,'voice_inputs_immutable'); END;
 CREATE TRIGGER muse_video_voice_inputs_immutable_delete BEFORE DELETE ON muse_video_voice_inputs BEGIN SELECT RAISE(ABORT,'voice_inputs_immutable'); END;
 CREATE TABLE muse_tts_selections (storyboard_id INTEGER NOT NULL,tts_kind TEXT NOT NULL,operation_id TEXT NOT NULL,adoption_operation_id TEXT NOT NULL,PRIMARY KEY(storyboard_id,tts_kind));
 CREATE TABLE muse_audio_mutations (operation_id TEXT PRIMARY KEY,kind TEXT NOT NULL,request_sha256 TEXT NOT NULL,reply_json TEXT NOT NULL);
 CREATE TRIGGER muse_voice_immutable_update BEFORE UPDATE ON muse_voice_assets BEGIN SELECT RAISE(ABORT,'voice_asset_immutable'); END;
 CREATE TRIGGER muse_voice_immutable_delete BEFORE DELETE ON muse_voice_assets BEGIN SELECT RAISE(ABORT,'voice_asset_immutable'); END;
 CREATE TRIGGER muse_tts_immutable_sha BEFORE UPDATE OF raw_sha256 ON muse_tts_generations WHEN OLD.raw_sha256 IS NOT NULL AND NEW.raw_sha256 IS NOT OLD.raw_sha256 BEGIN SELECT RAISE(ABORT,'tts_audio_sha_immutable'); END;`);
 db.prepare('INSERT INTO muse_audio_schema(version,database_id) VALUES(2,?)').run(randomUUID());}).immediate();active.set(db,new Set());
}
function requireDatabase(db,input){if(input.database_id!==undefined&&input.database_id!==db.prepare('SELECT database_id FROM muse_audio_schema').get().database_id)throw fail('audio_database_changed',409);}
function rootOf(cfg){const configured=cfg.storage?.local_path;if(typeof configured!=='string'||!configured)throw fail('audio_storage_unavailable',503);return path.resolve(configured);}
function fileAt(root,relative){const file=path.resolve(root,relative);if(!file.startsWith(root+path.sep))throw fail('invalid_audio_path');return file;}
function probe(file,cfg,voice=false){
 const binaries=require('../utils/ffmpegPath');
 const timeout=cfg.muse_audio?.probe_timeout_ms??30000;
 if(!Number.isSafeInteger(timeout)||timeout<1000||timeout>300000)throw fail('invalid_audio_probe_timeout',503);
 const result=spawnSync(binaries.getFfprobePath(),['-v','error','-show_entries','format=format_name,duration:stream=codec_type,codec_name,sample_rate,channels','-of','json',file],{encoding:'utf8',timeout,windowsHide:true});
 let info;try{info=JSON.parse(result.stdout||'{}');}catch(error){throw fail('audio_probe_failed',422);}
 const tracks=info.streams?.filter(stream=>stream.codec_type==='audio')??[],duration=Number(info.format?.duration);
 if(result.status!==0||tracks.length!==1||info.streams.length!==1||!Number.isFinite(duration)||duration<=0)throw fail('audio_probe_failed',422);
 const track=tracks[0];
 if(voice&&(!String(info.format.format_name).split(',').includes('wav')||!/^pcm_(?:s16le|s24le|s32le)$/.test(track.codec_name)
  ||duration<2||duration>30||![1,2].includes(Number(track.channels))))throw fail('voice_requires_2_to_30_second_pcm_wav',422);
 const decoded=spawnSync(binaries.getFfmpegPath(),['-v','error','-xerror','-i',file,'-map','0:a:0','-f','null','-'],{encoding:'utf8',timeout,windowsHide:true});
 if(decoded.status!==0)throw fail('audio_decode_failed',422);
 return {duration_seconds:duration,codec:track.codec_name,sample_rate:Number(track.sample_rate),channels:Number(track.channels)};
}
function saveBytes(root,relative,bytes){const file=fileAt(root,relative);fs.mkdirSync(path.dirname(file),{recursive:true});
 try{const fd=fs.openSync(file,'wx',0o600);try{fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}
 catch(error){if(error.code!=='EEXIST'||digest(fs.readFileSync(file))!==digest(bytes))throw error;}return file;}
function character(db,id){if(!positive(id))throw fail('character_id_required');const row=db.prepare('SELECT id,drama_id FROM characters WHERE id=? AND deleted_at IS NULL').get(Number(id));if(!row)throw fail('character_not_found',404);return row;}
function storyboard(db,id){if(!positive(id))throw fail('storyboard_id_required');const row=db.prepare('SELECT * FROM storyboards WHERE id=? AND deleted_at IS NULL').get(Number(id));if(!row)throw fail('storyboard_not_found',404);
 const episode=db.prepare('SELECT drama_id FROM episodes WHERE id=? AND deleted_at IS NULL').get(row.episode_id);if(!episode)throw fail('storyboard_episode_not_found',404);return {...row,muse_drama_id:episode.drama_id};}
function mutate(db,id,kind,input,apply){id=operation(id);const hash=digest(canonical(input));return db.transaction(()=>{
 const before=db.prepare('SELECT * FROM muse_audio_mutations WHERE operation_id=?').get(id);
 if(before){if(before.kind!==kind||before.request_sha256!==hash)throw fail('operation_id_conflict',409);return JSON.parse(before.reply_json);}
 const reply=apply();db.prepare('INSERT INTO muse_audio_mutations VALUES (?,?,?,?)').run(id,kind,hash,canonical(reply));return reply;
 }).immediate();}
function voiceRow(db,id){if(!positive(id))throw fail('voice_asset_id_required');const row=db.prepare('SELECT * FROM muse_voice_assets WHERE id=?').get(Number(id));if(!row)throw fail('voice_asset_not_found',404);
 const selection=db.prepare('SELECT voice_asset_id,adoption_operation_id FROM muse_voice_selections WHERE character_id=? AND voice_period_id=?').get(row.character_id,row.voice_period_id);
 const owner=db.prepare('SELECT name FROM characters WHERE id=?').get(row.character_id);
 return {...row,character_name:owner?.name??'',url:'/static/'+row.local_path,adopted:selection?.voice_asset_id===row.id,adoption_operation_id:selection?.adoption_operation_id??null};}
function verifyVoice(db,id,cfg){const row=voiceRow(db,id);if(digest(fs.readFileSync(fileAt(rootOf(cfg),row.local_path)))!==row.sha256)throw fail('voice_asset_integrity_failed',409);probe(fileAt(rootOf(cfg),row.local_path),cfg,true);return row;}
function uploadVoice(db,cfg,input,bytes){schema(db);requireDatabase(db,input);const owner=character(db,input.character_id),life=period(input.voice_period_id),id=operation(input.operation_id);
 if(!Buffer.isBuffer(bytes)||bytes.length>16*1024*1024)throw fail('invalid_voice_upload',413);
 const sha256=digest(bytes),relative=`audio/muse/voices/${sha256}.wav`,file=saveBytes(rootOf(cfg),relative,bytes),media=probe(file,cfg,true);
 const reply=mutate(db,id,'voice_upload',{character_id:owner.id,voice_period_id:life,sha256},()=>{
  db.prepare('INSERT OR IGNORE INTO muse_voice_assets(drama_id,character_id,voice_period_id,sha256,local_path,duration_seconds,codec,sample_rate,channels,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
   .run(owner.drama_id,owner.id,life,sha256,relative,media.duration_seconds,media.codec,media.sample_rate,media.channels,new Date().toISOString());
  return {voice_asset_id:db.prepare('SELECT id FROM muse_voice_assets WHERE character_id=? AND voice_period_id=? AND sha256=?').get(owner.id,life,sha256).id};});
 return voiceRow(db,reply.voice_asset_id);
}
function listVoices(db,input){schema(db);let rows=db.prepare('SELECT * FROM muse_voice_assets ORDER BY id DESC').all();
 if(input.drama_id!==undefined){if(!positive(input.drama_id))throw fail('invalid_drama_id');rows=rows.filter(row=>row.drama_id===Number(input.drama_id));}
 if(input.character_id!==undefined)rows=rows.filter(row=>row.character_id===character(db,input.character_id).id);
 if(input.voice_period_id!==undefined)rows=rows.filter(row=>row.voice_period_id===period(input.voice_period_id));
 return {items:rows.map(row=>voiceRow(db,row.id)),capabilities:{database_id:db.prepare('SELECT database_id FROM muse_audio_schema').get().database_id,independent_tts:true,tts_reference_cloning:false,tts_usage:'unreported',voice_upload:{min_seconds:2,max_seconds:30,codecs:['pcm_s16le','pcm_s24le','pcm_s32le'],channels:[1,2]},video_voice_reference:{protocols:['volcengine_omni'],model_specific:true,profiles:['seedance-2.0','seedance-2.5'],unsupported_action:'split_package_or_independent_tts'}}};}
function adoptVoice(db,cfg,id,input){schema(db);requireDatabase(db,input);const row=verifyVoice(db,id,cfg);mutate(db,input.operation_id,'voice_adopt',{voice_asset_id:row.id,sha256:row.sha256},()=>{
 db.prepare('INSERT INTO muse_voice_selections(character_id,voice_period_id,voice_asset_id,adoption_operation_id,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(character_id,voice_period_id) DO UPDATE SET voice_asset_id=excluded.voice_asset_id,adoption_operation_id=excluded.adoption_operation_id,updated_at=excluded.updated_at').run(row.character_id,row.voice_period_id,row.id,input.operation_id,new Date().toISOString());return {voice_asset_id:row.id};});return voiceRow(db,row.id);}
function getVideoBinding(db,id){schema(db);storyboard(db,id);const row=db.prepare('SELECT * FROM muse_video_voice_bindings WHERE storyboard_id=?').get(Number(id));
 return {storyboard_id:Number(id),operation_id:row?.operation_id??null,voices:row?JSON.parse(row.voices_json).map(voice=>voiceRow(db,voice.voice_asset_id)):[]};}
function bindVideo(db,cfg,id,input){schema(db);requireDatabase(db,input);const sb=storyboard(db,id),voices=input.voices;if(!Array.isArray(voices)||voices.length>10)throw fail('video_voice_binding_limit_exceeded');
 if(input.expected_operation_id!==null&&typeof input.expected_operation_id!=='string')throw fail('expected_voice_binding_required');
 let characters;try{characters=typeof sb.characters==='string'?JSON.parse(sb.characters):sb.characters;}catch(error){throw fail('invalid_storyboard_characters',409);}
 const ids=Array.isArray(characters)?characters.map(item=>Number(item?.id??item)):[];
 const identities=new Set();
 const resolved=voices.map(item=>{if(!item||typeof item!=='object'||typeof item.sha256!=='string'||!/^[a-f0-9]{64}$/.test(item.sha256))throw fail('invalid_voice_binding');const voice=verifyVoice(db,item.voice_asset_id,cfg);if(voice.drama_id!==sb.muse_drama_id||voice.character_id!==Number(item.character_id)||voice.voice_period_id!==period(item.voice_period_id)
  ||voice.sha256!==item.sha256||!ids.includes(voice.character_id))throw fail('voice_character_period_mismatch',409);const identity=JSON.stringify([voice.character_id,voice.voice_period_id]);if(identities.has(identity))throw fail('voice_character_period_is_ambiguous',409);identities.add(identity);return {voice_asset_id:voice.id,character_id:voice.character_id,voice_period_id:voice.voice_period_id,sha256:voice.sha256};});
 mutate(db,input.operation_id,'video_voice_bind',{storyboard_id:sb.id,expected_operation_id:input.expected_operation_id,voices:resolved},()=>{
  const before=db.prepare('SELECT operation_id FROM muse_video_voice_bindings WHERE storyboard_id=?').get(sb.id);if((before?.operation_id??null)!==input.expected_operation_id)throw fail('voice_binding_changed',409);
  db.prepare('INSERT INTO muse_video_voice_bindings VALUES(?,?,?,?) ON CONFLICT(storyboard_id) DO UPDATE SET operation_id=excluded.operation_id,voices_json=excluded.voices_json,updated_at=excluded.updated_at').run(sb.id,input.operation_id,canonical(resolved),new Date().toISOString());return {storyboard_id:sb.id};});return getVideoBinding(db,sb.id);}
function resolveVideoVoice(db,opts,protocol,cfg){if(!opts.storyboard_id&&!opts.voice_reference_url&&!opts.formal_voice_references)return opts;schema(db);if(!opts.storyboard_id)throw fail('formal_voice_binding_required');
 const binding=getVideoBinding(db,opts.storyboard_id);if(!binding.voices.length){if(opts.voice_reference_url||opts.formal_voice_references)throw fail('formal_voice_binding_required');return opts;}
 if(protocol!=='volcengine_omni')throw fail('video_protocol_does_not_support_formal_voice_split_package_or_use_tts');
 const voices=binding.voices.map(row=>{const {adopted,adoption_operation_id,...voice}=verifyVoice(db,row.id,cfg);return voice;});
 if(opts.voice_reference_url&&(voices.length!==1||opts.voice_reference_url!=='/static/'+voices[0].local_path))throw fail('formal_voice_binding_conflict',409);
 if(opts.video_gen_id!==undefined){if(!positive(opts.video_gen_id))throw fail('video_generation_id_required');const snapshot=canonical(voices),before=db.prepare('SELECT * FROM muse_video_voice_inputs WHERE video_generation_id=?').get(opts.video_gen_id);
  if(before&&(before.storyboard_id!==Number(opts.storyboard_id)||before.binding_operation_id!==binding.operation_id||before.voices_json!==snapshot))throw fail('original_video_voice_inputs_changed',409);
  if(!before)db.prepare('INSERT INTO muse_video_voice_inputs VALUES(?,?,?,?,?)').run(opts.video_gen_id,Number(opts.storyboard_id),binding.operation_id,snapshot,new Date().toISOString());}
 return {...opts,formal_voice_references:voices,voice_reference_url:voices.length===1?'/static/'+voices[0].local_path:undefined};}
function listVideoInputs(db,input){schema(db);storyboard(db,input.storyboard_id);return {items:db.prepare('SELECT * FROM muse_video_voice_inputs WHERE storyboard_id=? ORDER BY video_generation_id DESC').all(Number(input.storyboard_id)).map(row=>({...row,voices:JSON.parse(row.voices_json),voices_json:undefined}))};}
function ttsRow(db,id){const row=db.prepare('SELECT * FROM muse_tts_generations WHERE operation_id=?').get(operation(id));if(!row)throw fail('tts_generation_not_found',404);
 const selected=db.prepare('SELECT operation_id,adoption_operation_id FROM muse_tts_selections WHERE storyboard_id=? AND tts_kind=?').get(row.storyboard_id,row.tts_kind);
 return {...row,cancellation:{requested:row.cancel_requested_at!==null,provider_cancelled:false},audio_origin:'independent_tts',usage_status:'unreported',state:row.state==='generating'&&!active.get(db)?.has(id)?'unknown':row.state,url:row.state==='completed'?'/static/'+row.local_path:null,adopted:selected?.operation_id===id,adoption_operation_id:selected?.adoption_operation_id??null};}
function configFor(db,input){if(!positive(input.config_id)||typeof input.voice_id!=='string'||!input.voice_id.trim()||input.voice_id.length>160)throw fail('explicit_tts_config_and_voice_required');
 const config=require('./aiConfigService').listConfigs(db,'tts').find(item=>item.id===Number(input.config_id)&&item.is_active);
 if(!config||!['openai','minimax'].includes(config.provider))throw fail('tts_provider_not_supported');
 if(typeof config.api_key!=='string'||!config.api_key.trim())throw fail('tts_config_not_configured',409);
 const choices=Array.isArray(config.model)?config.model:[config.model];
 if(input.model!==undefined&&(typeof input.model!=='string'||!choices.includes(input.model)))throw fail('tts_model_not_configured',409);
 const model=input.model??(config.default_model||choices[0]);if(typeof model!=='string'||!model)throw fail('tts_model_required');
 let base;try{base=new URL(config.base_url||(config.provider==='openai'?'https://api.openai.com/v1':'https://api.minimax.io'));}catch(error){throw fail('invalid_tts_base_url');}
 if(!['http:','https:'].includes(base.protocol)||base.username||base.password||base.search||base.hash)throw fail('invalid_tts_base_url');
 let settings={};if(config.settings){try{settings=typeof config.settings==='string'?JSON.parse(config.settings):config.settings;}catch(error){throw fail('invalid_tts_settings');}}
 return {...config,model,base_url:base.href.replace(/\/$/,''),normalized_settings:settings};}
async function generate(db,log,cfg,input){schema(db);requireDatabase(db,input);const id=operation(input.operation_id),sb=storyboard(db,input.storyboard_id),config=configFor(db,input);
 const kind=input.tts_kind===undefined?'dialogue':input.tts_kind;if(!['dialogue','narration'].includes(kind))throw fail('invalid_tts_kind');
 if(input.text!==undefined&&typeof input.text!=='string')throw fail('invalid_tts_input');const text=String(input.text??sb[kind==='narration'?'narration':'dialogue']??'').trim(),speed=input.speed??1;
 if(!text||text.length>20000||!Number.isFinite(speed)||speed<0.25||speed>4)throw fail('invalid_tts_input');
 if(config.provider==='openai'&&text.length>4096||config.provider==='minimax'&&text.length>=10000)throw fail('tts_text_limit_exceeded');
 if(config.provider==='minimax'&&speed!==1)throw fail('minimax_speed_not_supported_by_adapter');
 const timeout=cfg.muse_audio?.request_timeout_ms??120000;if(!Number.isSafeInteger(timeout)||timeout<1000||timeout>900000)throw fail('invalid_tts_request_timeout',503);
 const spec={storyboard_id:sb.id,tts_kind:kind,config_id:config.id,provider:config.provider,base_url:config.base_url,model:config.model,voice_id:input.voice_id.trim(),speed,text_sha256:digest(text)};
 const hash=digest(canonical(spec)),previous=db.prepare('SELECT request_sha256 FROM muse_tts_generations WHERE operation_id=?').get(id);
 if(previous){if(previous.request_sha256!==hash)throw fail('operation_id_conflict',409);return ttsRow(db,id);}
 const relative=`audio/muse/tts/${id}.mp3`;
 const inserted=db.transaction(()=>{
 const same=db.prepare('SELECT request_sha256 FROM muse_tts_generations WHERE operation_id=?').get(id);if(same){if(same.request_sha256!==hash)throw fail('operation_id_conflict',409);return false;}
 const unresolved=db.prepare("SELECT operation_id FROM muse_tts_generations WHERE request_sha256=? AND state IN ('generating','unknown') LIMIT 1").get(hash);
 if(unresolved)throw fail('tts_prior_operation_unresolved_read_history',409);
 db.prepare('INSERT INTO muse_tts_generations(operation_id,request_sha256,storyboard_id,tts_kind,config_id,provider,base_url,model,voice_id,speed,text_sha256,state,local_path,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
  .run(id,hash,sb.id,kind,config.id,config.provider,config.base_url,config.model,spec.voice_id,speed,spec.text_sha256,'generating',relative,new Date().toISOString());
 db.prepare('UPDATE muse_tts_generations SET request_text=? WHERE operation_id=?').run(text,id);
 return true;}).immediate();
 if(!inserted)return ttsRow(db,id);
 let operations=active.get(db);if(!operations){operations=new Set();active.set(db,operations);}operations.add(id);
 try{
  const client=require('./ttsService');let bytes;
  try{bytes=config.provider==='minimax'?await client.synthesizeWithMinimax(text,spec.voice_id,config.api_key,'',config.model,config.base_url,timeout)
   :await client.synthesizeWithOpenai(text,spec.voice_id,config.api_key,config.base_url,config.model,speed,timeout);}
  catch(error){db.prepare('UPDATE muse_tts_generations SET state=?,error_code=? WHERE operation_id=?').run('unknown','provider_outcome_unknown',id);return ttsRow(db,id);}
  if(!Buffer.isBuffer(bytes)||bytes.length===0){db.prepare('UPDATE muse_tts_generations SET state=?,error_code=? WHERE operation_id=?').run('failed','invalid_tts_audio',id);return ttsRow(db,id);}
  saveBytes(rootOf(cfg),relative,bytes);const sha=digest(bytes);
  db.prepare('UPDATE muse_tts_generations SET raw_sha256=?,state=? WHERE operation_id=?').run(sha,'unknown',id);
  let media;try{media=probe(fileAt(rootOf(cfg),relative),cfg);}catch(error){db.prepare('UPDATE muse_tts_generations SET state=?,error_code=? WHERE operation_id=?').run('failed',error.code??'audio_probe_failed',id);return ttsRow(db,id);}
  db.prepare('UPDATE muse_tts_generations SET state=?,duration_seconds=?,completed_at=?,error_code=NULL WHERE operation_id=?').run('completed',media.duration_seconds,new Date().toISOString(),id);
  return ttsRow(db,id);
 }catch(error){log.error('Muse TTS persistence or validation failed',{operation_id:id});throw fail('tts_result_not_confirmed',503);}
 finally{operations.delete(id);}
}
function recover(db,cfg,id,input={}){schema(db);requireDatabase(db,input);const row=ttsRow(db,id);if(row.state==='generating')throw fail('tts_still_generating',409);if(row.state==='completed')return row;
 const file=fileAt(rootOf(cfg),row.local_path);if(!fs.existsSync(file))throw fail('tts_original_result_unavailable',409);const sha=digest(fs.readFileSync(file));
 if(row.raw_sha256&&row.raw_sha256!==sha)throw fail('tts_audio_integrity_failed',409);const media=probe(file,cfg);
 db.prepare('UPDATE muse_tts_generations SET state=?,raw_sha256=?,duration_seconds=?,completed_at=?,error_code=NULL WHERE operation_id=?').run('completed',sha,media.duration_seconds,new Date().toISOString(),id);return ttsRow(db,id);}
function adoptTts(db,cfg,id,input){schema(db);requireDatabase(db,input);const row=ttsRow(db,id);if(row.state!=='completed'||row.raw_sha256!==input.sha256)throw fail('completed_tts_sha_required',409);
 if(digest(fs.readFileSync(fileAt(rootOf(cfg),row.local_path)))!==row.raw_sha256)throw fail('tts_audio_integrity_failed',409);probe(fileAt(rootOf(cfg),row.local_path),cfg);
 mutate(db,input.operation_id,'tts_adopt',{generation_id:id,sha256:row.raw_sha256},()=>{const column=row.tts_kind==='narration'?'narration_audio_local_path':'audio_local_path';
  const result=db.prepare(`UPDATE storyboards SET ${column}=?,updated_at=? WHERE id=? AND deleted_at IS NULL`).run(row.local_path,new Date().toISOString(),row.storyboard_id);if(result.changes!==1)throw fail('tts_adoption_not_confirmed',409);
  db.prepare('INSERT INTO muse_tts_selections VALUES(?,?,?,?) ON CONFLICT(storyboard_id,tts_kind) DO UPDATE SET operation_id=excluded.operation_id,adoption_operation_id=excluded.adoption_operation_id').run(row.storyboard_id,row.tts_kind,id,input.operation_id);return {generation_id:id};});return ttsRow(db,id);}
function cancelTts(db,id,input){schema(db);requireDatabase(db,input);const row=ttsRow(db,id);mutate(db,input.operation_id,'tts_cancel_wait',{generation_id:row.operation_id},()=>{
 db.prepare('UPDATE muse_tts_generations SET cancel_requested_at=COALESCE(cancel_requested_at,?) WHERE operation_id=?').run(new Date().toISOString(),row.operation_id);return {generation_id:row.operation_id};});return ttsRow(db,id);}
function capabilities(db,input={}){schema(db);const choices=require('./aiConfigService').listConfigs(db,'tts').filter(row=>row.is_active&&['openai','minimax'].includes(row.provider)).map(row=>({id:row.id,name:row.name||row.provider,provider:row.provider,key_configured:typeof row.api_key==='string'&&!!row.api_key.trim(),model:row.model,default_model:row.default_model||null}));
 const result={database_id:db.prepare('SELECT database_id FROM muse_audio_schema').get().database_id,independent_tts:true,tts_reference_cloning:false,usage_status:'unreported',configs:choices};
 if(input.storyboard_id!==undefined)result.project_id=storyboard(db,input.storyboard_id).muse_drama_id;
 if(input.config_id!==undefined){if(!positive(input.config_id)||typeof input.model!=='string')throw fail('explicit_video_model_required');const config=require('./aiConfigService').listConfigs(db,'video').find(row=>row.id===Number(input.config_id)&&row.is_active);if(!config)throw fail('video_config_not_found',404);const models=Array.isArray(config.model)?config.model:[config.model];if(!models.includes(input.model))throw fail('video_model_not_configured',409);result.video_voice_reference=require('./museVoiceInputs').capability(config,input.model);}
 return result;}
module.exports={schema,uploadVoice,listVoices,adoptVoice,getVideoBinding,bindVideo,resolveVideoVoice,listVideoInputs,generate,recover,adoptTts,cancelTts,capabilities,ttsRow,
 listTts(db,input){schema(db);storyboard(db,input.storyboard_id);return {items:db.prepare('SELECT operation_id FROM muse_tts_generations WHERE storyboard_id=? ORDER BY created_at DESC').all(Number(input.storyboard_id)).map(row=>ttsRow(db,row.operation_id))};}};

/** Documented Ark reference limits and explicit, ordered speaker mappings. No supplier request is made here. */
const fs=require('node:fs');
const path=require('node:path');
const {createHash}=require('node:crypto');
const source='https://docs.volcengine.com/docs/ark/create-video-generation-task-api?lang=zh&redirect=1';
const fail=code=>Object.assign(new Error(code),{code,status:422});
function settings(config){try{return typeof config.settings==='string'?JSON.parse(config.settings):config.settings||{};}catch(error){throw fail('invalid_voice_model_settings');}}
function capability(config,model){
 const protocol=String(config.api_protocol||config.provider||'').toLowerCase();
 if(protocol!=='volcengine_omni')return {supported:false,source:'unsupported_protocol'};
 const declared=settings(config).muse_model_capabilities?.[model]?.profile;
 let official=false;try{official=new URL(config.base_url).origin==='https://ark.cn-beijing.volces.com';}catch(error){/* An unknown endpoint cannot establish an official model. */}
 const profile=declared==='seedance-2.5'||official&&/^doubao-seedance-2[._-]5-\d{6}$/i.test(model)?'seedance-2.5'
  :declared==='seedance-2.0'||official&&/^doubao-seedance-2[._-]0(?:-fast)?-\d{6}$/i.test(model)?'seedance-2.0':null;
 if(!profile)return {supported:false,source:'unknown_model'};
 return {supported:true,profile,max_references:profile==='seedance-2.5'?10:3,min_seconds:2,
  max_seconds:profile==='seedance-2.5'?30:15,max_total_seconds:profile==='seedance-2.5'?30:15,
  max_file_bytes:15*1024*1024,max_request_bytes:64*1024*1024,requires_visual:profile==='seedance-2.0',
  source:declared?'configured_profile':source};
}
function validate(references,config,model,hasVisual){
 const limits=capability(config,model);
 if(!limits.supported)throw fail('formal_voice_model_capability_unknown_split_package_or_use_tts');
 if(!Array.isArray(references)||references.length<1||references.length>limits.max_references)throw fail('formal_voice_reference_count_exceeded_split_package');
 if(limits.requires_visual&&!hasVisual)throw fail('formal_voice_model_requires_image_or_video');
 const identities=new Set();let total=0;
 for(const row of references){
  if(!Number.isSafeInteger(row.character_id)||row.character_id<1||typeof row.voice_period_id!=='string'
   ||!row.voice_period_id||typeof row.sha256!=='string'||!/^[a-f0-9]{64}$/.test(row.sha256))throw fail('formal_voice_reference_identity_required');
  const identity=JSON.stringify([row.character_id,row.voice_period_id]);
  if(identities.has(identity))throw fail('formal_voice_character_period_is_ambiguous');identities.add(identity);
  if(!Number.isFinite(row.duration_seconds)||row.duration_seconds<limits.min_seconds||row.duration_seconds>limits.max_seconds)throw fail('formal_voice_duration_not_supported_split_package');
  total+=row.duration_seconds;
 }
 if(total>limits.max_total_seconds)throw fail('formal_voice_total_duration_exceeded_split_package_or_use_tts');
 return limits;
}
function appendVoiceInputs(body,opts,config,model){
 const references=opts.formal_voice_references||[];
 if(!references.length){if(opts.voice_reference_url)throw fail('formal_voice_binding_required');return;}
 const limits=validate(references,config,model,body.content.some(part=>part.type==='image_url'||part.type==='video_url'));
 if(typeof opts.storage_local_path!=='string'||!opts.storage_local_path)throw fail('formal_voice_local_media_required');
 const root=fs.realpathSync(opts.storage_local_path),mapping=[];
 references.forEach((row,index)=>{
  const relative=row.local_path;
  if(typeof relative!=='string'||path.isAbsolute(relative))throw fail('formal_voice_local_media_required');
  const file=fs.realpathSync(path.resolve(root,relative));
  if(!file.startsWith(root+path.sep)||fs.statSync(file).size>limits.max_file_bytes)throw fail('formal_voice_media_outside_storage_or_too_large');
  const bytes=fs.readFileSync(file);
  if(createHash('sha256').update(bytes).digest('hex')!==row.sha256)throw fail('voice_asset_integrity_failed');
  body.content.push({type:'audio_url',audio_url:{url:'data:audio/wav;base64,'+bytes.toString('base64')},role:'reference_audio'});
  mapping.push(`音频${index+1}对应角色${JSON.stringify(row.character_name)}（角色ID ${row.character_id}，人生时期 ${JSON.stringify(row.voice_period_id)}），仅作为该说话人的声音参考`);
 });
 const text=body.content.find(part=>part.type==='text');
 if(!text||typeof text.text!=='string')throw fail('formal_voice_prompt_required');
 text.text+='\n\n正式说话人映射（按音频上传顺序）：\n'+mapping.join('\n');
 if(Buffer.byteLength(JSON.stringify(body))>limits.max_request_bytes)throw fail('formal_voice_request_too_large');
}
module.exports={capability,validate,appendVoiceInputs};

/** Resume only known-unsubmitted segments; original queue identities and verified media are never regenerated. */
const media=require('./musePostproductionMedia'),fal=require('./musePostproductionFal');
const fail=(code,status=409)=>Object.assign(Error(code),{code,status});
function create(db,cfg,owner){
 const parts=id=>db.prepare('SELECT * FROM muse_postproduction_segments WHERE task_operation_id=? ORDER BY segment_index').all(id);
 const part=(id,index)=>db.prepare('SELECT * FROM muse_postproduction_segments WHERE task_operation_id=? AND segment_index=?').get(id,index);
 const original=row=>{
  const policy=owner.policy(row),bytes=media.read(cfg,row.source_path,policy.max_input_bytes);
  if(media.sha(bytes)!==row.source_sha256)throw fail('postproduction_original_source_changed');
  let saved;try{saved=media.read(cfg,row.checkpoint_path,policy.max_input_bytes);}catch(error){if(error.code!=='ENOENT')throw error;media.save(cfg,row.checkpoint_path,bytes);saved=bytes;}
  if(media.sha(saved)!==row.source_sha256)throw fail('postproduction_original_source_changed');
  return policy;
 };
 const update=(id,index,state,error=null)=>db.prepare('UPDATE muse_postproduction_segments SET state=?,error_code=?,error_origin=? WHERE task_operation_id=? AND segment_index=?')
  .run(state,error?owner.safeError(error):null,error?owner.safeOrigin(error):null,id,index);
 const input=(row,current,policy)=>{
  if(current.input_path){const bytes=media.read(cfg,current.input_path,policy.max_input_bytes);if(media.sha(bytes)!==current.input_sha256)throw fail('postproduction_segment_input_changed');return {path:current.input_path,bytes,sha256:current.input_sha256};}
  let path=row.checkpoint_path;
  if(parts(row.operation_id).length>1){path='video/muse/postproduction/'+row.operation_id+'/segment-'+current.segment_index+'-input.mp4';
   media.cut(cfg,row.checkpoint_path,current,path,policy);}
  const facts=media.probe(cfg,path,policy),source=JSON.parse(row.source_metadata_json);
  if(facts.frames!==current.end_frame-current.start_frame||Math.abs(facts.fps-source.fps)>0.00001
   ||row.kind==='erase_subtitles'&&facts.duration_seconds>=5)throw fail('postproduction_segment_clock_changed');
  const bytes=media.read(cfg,path,policy.max_input_bytes),sha256=media.sha(bytes);
  db.prepare('UPDATE muse_postproduction_segments SET input_path=?,input_sha256=? WHERE task_operation_id=? AND segment_index=?').run(path,sha256,row.operation_id,current.segment_index);
  return {path,bytes,sha256};
 };
 const dispatch=async id=>{
  const row=owner.task(id);if(row.state==='completed'||owner.active.has(id))return owner.read(id);
  if(parts(id).some(value=>value.state==='unknown'))throw fail('postproduction_unknown_segment_requires_reconciliation');
  if(!parts(id).some(value=>['pending','upload_failed'].includes(value.state)))return owner.read(id);
  const policy=original(row),provider=owner.config(row.config_id,row.credential_sha256),client=fal.create(provider.api_key,policy),parameters=JSON.parse(row.parameters_json);
  owner.active.add(id);
  try{
   for(const current of parts(id)){
    if(!['pending','upload_failed'].includes(current.state))continue;
    let stage='prepare';
    try{
     original(row);const selected=input(row,current,policy),extension=/\.(mp4|mov|webm|mkv)$/i.exec(selected.path)?.[1]?.toLowerCase()||'mp4';
     const types={mp4:'video/mp4',mov:'video/quicktime',webm:'video/webm',mkv:'video/x-matroska'};
     update(id,current.segment_index,'uploading');stage='upload';
     const url=await client.upload(selected.bytes,selected.sha256+'.'+extension,types[extension]);
     db.prepare("UPDATE muse_postproduction_segments SET state='submitting',source_upload_url=?,error_code=NULL,error_origin=NULL WHERE task_operation_id=? AND segment_index=?").run(url,id,current.segment_index);stage='submit';
     const result=await client.submit(row.kind,{...parameters,video_url:url});
     db.prepare("UPDATE muse_postproduction_segments SET state='queued',request_id=?,status_url=?,response_url=?,error_code=NULL,error_origin=NULL WHERE task_operation_id=? AND segment_index=?")
      .run(result.request_id,result.status_url,result.response_url,id,current.segment_index);
    }catch(error){update(id,current.segment_index,stage==='submit'?'unknown':'upload_failed',error);break;}
   }
  }finally{owner.active.delete(id);}return owner.read(id);
 };
 const refresh=async id=>{
  const row=owner.task(id);if(row.state==='completed'||owner.active.has(id))return owner.read(id);
  const policy=original(row),source=JSON.parse(row.source_metadata_json);let client;
  const getClient=()=>{if(!client){const provider=owner.config(row.config_id,row.credential_sha256);client=fal.create(provider.api_key,policy);}return client;};
  owner.active.add(id);
  try{
   db.prepare('UPDATE muse_postproduction_tasks SET error_code=NULL,error_origin=NULL WHERE operation_id=?').run(id);
   for(let current of parts(id)){
    if(current.state==='verified'){
     if(media.sha(media.read(cfg,current.raw_path,policy.max_output_bytes))!==current.raw_sha256)update(id,current.segment_index,'media_unverified',fail('postproduction_candidate_changed'));
     continue;
    }
    if(!current.request_id)continue;
    try{
     if(!current.result_url){const state=await getClient().status(row.kind,current);if(state!=='COMPLETED'){update(id,current.segment_index,state==='IN_QUEUE'?'queued':'processing');continue;}
      const result=await getClient().result(row.kind,current);db.prepare("UPDATE muse_postproduction_segments SET state='result_ready',result_url=?,provider_seed=? WHERE task_operation_id=? AND segment_index=?")
       .run(result.url,result.seed,id,current.segment_index);current=part(id,current.segment_index);}
     let path=current.raw_path,sha256=current.raw_sha256;
     if(!path){const bytes=await fal.download(current.result_url,policy);sha256=media.sha(bytes);path='video/muse/postproduction/'+id+'/segment-'+current.segment_index+'-provider-'+sha256+'.mp4';media.save(cfg,path,bytes);
      db.prepare('UPDATE muse_postproduction_segments SET raw_path=?,raw_sha256=? WHERE task_operation_id=? AND segment_index=?').run(path,sha256,id,current.segment_index);}
     if(media.sha(media.read(cfg,path,policy.max_output_bytes))!==sha256)throw fail('postproduction_candidate_changed');
     media.verifyPart(cfg,path,current,source,row.kind,policy);update(id,current.segment_index,'verified');
    }catch(error){update(id,current.segment_index,'media_unverified',error);}
   }
   const completed=parts(id);if(completed.some(current=>current.state!=='verified'))return owner.read(id);
   original(row);let joined=row.raw_path,rawSha=row.raw_sha256;
   if(!joined){joined=media.joinSegments(cfg,completed,'video/muse/postproduction/'+id,policy);rawSha=media.sha(media.read(cfg,joined,policy.max_output_bytes));
    db.prepare('UPDATE muse_postproduction_tasks SET raw_path=?,raw_sha256=? WHERE operation_id=?').run(joined,rawSha,id);}
   if(media.sha(media.read(cfg,joined,policy.max_output_bytes))!==rawSha)throw fail('postproduction_joined_candidate_changed');
   const path='video/muse/postproduction/'+id+'/original-audio-'+rawSha+'.mp4',facts=media.restore(cfg,row.checkpoint_path,joined,path,row.kind,policy);
   const outputSha=media.sha(media.read(cfg,path,policy.max_output_bytes));original(row);owner.complete(row,path,outputSha,facts,completed);
  }catch(error){db.prepare("UPDATE muse_postproduction_tasks SET state='media_unverified',error_code=?,error_origin=? WHERE operation_id=? AND state!='completed'").run(owner.safeError(error),owner.safeOrigin(error),id);}
  finally{owner.active.delete(id);}return owner.read(id);
 };
 return {dispatch,refresh};
}
module.exports={create};

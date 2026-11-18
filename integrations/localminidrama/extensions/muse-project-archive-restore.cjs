/** Restore verified content into new native IDs; old projects, files and receipts remain untouched. */
const {randomUUID}=require('node:crypto');
const content=require('./museProjectArchiveContent'),files=require('./museProjectArchiveFiles');
const {fail,digest,exists}=content;
const sequence=['episodes','characters','scenes','props','character_libraries','scene_libraries','prop_libraries','storyboards','frame_prompts','image_generations','video_generations','assets','video_merges','episode_characters','storyboard_characters','storyboard_props','muse_studio_asset_versions','muse_studio_prompt_revisions','muse_studio_package_heads'];
const references={drama_id:'dramas',project_id:'dramas',episode_id:'episodes',storyboard_id:'storyboards',package_id:'storyboards',scene_id:'scenes',character_id:'characters',prop_id:'props',image_gen_id:'image_generations',video_gen_id:'video_generations',first_frame_image_id:'image_generations',last_frame_image_id:'image_generations'};
async function restore(db,cfg,input,limits,readManifest){
 if(!input||typeof input.operation_id!=='string'||!/^[A-Za-z0-9_-]{8,128}$/.test(input.operation_id)||typeof input.title!=='string'||!input.title.trim()||input.title.length>200)throw fail('project_archive_invalid_restore',400);
 const source=readManifest(db,input.source_project_id,input.revision),requestHash=digest({source_manifest_id:source.manifest_id,title:input.title}),previous=()=>{const row=db.prepare('SELECT * FROM muse_project_archive_operations WHERE operation_id=?').get(input.operation_id);if(!row)return null;if(row.request_sha256!==requestHash)throw fail('project_archive_operation_changed');return {...JSON.parse(row.receipt_json),replayed:true};};
 const old=previous();if(old)return old;const manifest=JSON.parse(source.manifest_json),signal=AbortSignal.timeout(limits.checkpoint_timeout_ms),paths=new Map();if(Buffer.byteLength(source.manifest_json)>limits.max_manifest_bytes||manifest.files.length>limits.max_files)throw fail('project_archive_restore_limit',413);
 for(const file of manifest.files){const extension=/\.[a-z0-9]{1,8}$/i.exec(file.path)?.[0]??'.bin',target='muse-project-restores/'+digest(input.operation_id)+'/'+file.sha256+extension;await files.copyRestored(cfg,file,target,limits,signal);paths.set(file.path,target);}
 return db.transaction(()=>{
  const prior=previous();if(prior)return prior;
  const maps=Object.fromEntries(['dramas',...sequence].map(table=>[table,new Map()]));
  const map=(table,value)=>{if(value===null||value===undefined||value===0)return value;const mapped=maps[table]?.get(value);if(mapped===undefined)throw fail('project_archive_foreign_reference');return mapped;};
  const url=value=>{const path=content.localPath(value);if(!path)return value;const next=paths.get(path);if(!next)throw fail('project_archive_media_unavailable');return /^(?:https?:\/\/|\/(?:studio\/)?static\/)/i.test(value)?String(cfg.storage.base_url??'/static').replace(/\/$/,'')+'/'+next:next;};
  function rewrite(value,key='',row={},kind='video'){
   if(Array.isArray(value))return value.map(item=>rewrite(item,key,row,kind));
   if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([name,item])=>[name,rewrite(item,name,value,kind)]));
   if(typeof value==='string'){
    if(/^[\[{]/.test(value.trim())){try{return JSON.stringify(rewrite(JSON.parse(value),'',row,kind));}catch(error){if(error.code)throw error;}}
    if(/^(?:url|.*local_?path|mediaUrl|image_url|video_url|audio_url|thumbnail|ref_image|reference_images|reference_image_urls|first_frame_url|last_frame_url|composed_image|extra_images|four_view_image_url)$/i.test(key))return url(value);
    if((key==='versionId'||key==='version_id')&&maps.muse_studio_asset_versions.has(value))return maps.muse_studio_asset_versions.get(value);
    if((key==='revisionId'||key==='revision_id')&&maps.muse_studio_prompt_revisions.has(value))return maps.muse_studio_prompt_revisions.get(value);
    return value;
   }
   if(Number.isSafeInteger(value)){
    if(references[key])return map(references[key],value);
    if(['projectId','dramaId'].includes(key))return map('dramas',value);
    if(['packageId','storyboardId'].includes(key))return map('storyboards',value);
    if(key==='assetId'){const table={character:'characters',scene:'scenes',prop:'props',storyboard:'storyboards'}[row.assetKind??row.asset_kind];return table?map(table,value):value;}
    if(['generationId','generation_id','sourceGenerationId','source_generation_id','parentGenerationId'].includes(key))return map((row.assetKind||row.asset_kind?'image':kind)+'_generations',value);
   }
   return value;
  }
  function insert(table,row){if(!exists(db,table))throw fail('project_archive_restore_schema_unavailable',503);const columns=new Set(db.prepare('PRAGMA table_info('+table+')').all().map(c=>c.name)),entries=Object.entries(row).filter(([key])=>columns.has(key));const result=db.prepare('INSERT INTO '+table+'('+entries.map(([key])=>key).join(',')+') VALUES('+entries.map(()=>'?').join(',')+')').run(...entries.map(([,value])=>value));return Number(result.lastInsertRowid);}
  const original=manifest.content.tables.dramas?.[0];if(!original||original.id!==input.source_project_id)throw fail('project_archive_manifest_invalid');
  const {id:oldProject,...projectFields}=original,now=new Date().toISOString();const projectId=insert('dramas',{...projectFields,title:input.title,deleted_at:null,created_at:now,updated_at:now,metadata:JSON.stringify({museArchive:{source_project_id:oldProject,source_manifest_id:source.manifest_id,restored_at:now}})});maps.dramas.set(oldProject,projectId);
  // UUID maps are known before references to immutable asset and prompt revisions are copied.
  for(const table of ['muse_studio_asset_versions','muse_studio_prompt_revisions'])for(const row of manifest.content.tables[table]??[])maps[table].set(row.version_id??row.revision_id,randomUUID());
  const postponed=[];
  for(const table of sequence)for(const originalRow of manifest.content.tables[table]??[]){
   const row={...originalRow},oldId=row.id;delete row.id;
   if(['character_libraries','scene_libraries','prop_libraries'].includes(table))row.drama_id=oldProject;
   for(const column of ['first_frame_image_id','last_frame_image_id'])if(row[column]){postponed.push({table,oldId,column,value:row[column]});row[column]=null;}
   if(table==='storyboard_characters')row.character_id=map('character_libraries',row.character_id);
   if(table==='muse_studio_asset_versions'){row.version_id=maps[table].get(row.version_id);row.asset_id=map({character:'characters',scene:'scenes',prop:'props',storyboard:'storyboards'}[row.asset_kind],row.asset_id);if(row.generation_id)row.generation_id=map('image_generations',row.generation_id);}
   if(table==='muse_studio_prompt_revisions')row.revision_id=maps[table].get(row.revision_id);
   if(table==='muse_studio_package_heads')row.revision_id=maps.muse_studio_prompt_revisions.get(row.revision_id);
   if(row.source_id&&['character_libraries','scene_libraries','prop_libraries'].includes(table)){const target={character:'characters',scene:'scenes',prop:'props'}[row.source_type];row.source_id=target&&maps[target].has(Number(row.source_id))?String(map(target,Number(row.source_id))):null;}
   for(const[key,value]of Object.entries(row)){
    if(table==='storyboard_characters'&&key==='character_id'||table==='muse_studio_asset_versions'&&['generation_id','asset_id'].includes(key))continue;
    if(['task_id','provider_task_id'].includes(key)){row[key]=null;continue;}
    row[key]=rewrite(value,key,row,table==='image_generations'?'image':'video');
   }
   if(['image_generations','video_generations','video_merges'].includes(table)&&['pending','processing','queued','running','generating'].includes(row.status)){row.status='failed';row.error_msg='Archived task restored without resubmission';}
   const inserted=insert(table,row);if(oldId!==undefined)maps[table].set(oldId,inserted);
  }
  for(const item of postponed)db.prepare('UPDATE '+item.table+' SET '+item.column+'=? WHERE id=?').run(map('image_generations',item.value),map(item.table,item.oldId));
  for(const item of manifest.content.generation_inputs){const generationId=map(item.kind+'_generations',item.generation_id),rewritten=rewrite(item.inputs,'',{},item.kind),archiveSource={source_project_id:input.source_project_id,source_manifest_id:source.manifest_id,source_generation_id:item.generation_id,source_database_id:manifest.database_id};db.prepare('INSERT INTO muse_project_archive_origins VALUES(?,?,?,?)').run(item.kind,generationId,JSON.stringify(archiveSource),JSON.stringify({...rewritten,source:'project-archive',archiveSource}));}
  for(const table of ['muse_business_revisions','muse_project_archive_history'])for(const row of manifest.content.tables[table]??[])db.prepare('INSERT INTO muse_project_archive_history VALUES(?,?,?,?,?)').run(randomUUID(),projectId,source.manifest_id,table,JSON.stringify(row));
  for(const row of manifest.content.tables.muse_project_archive_documents??[])insert('muse_project_archive_documents',{...row,document_id:randomUUID(),project_id:projectId,operation_id:input.operation_id+'-'+row.document_id,local_path:paths.get(row.local_path),created_at:now});
  const result={project_id:projectId,title:input.title,source_project_id:input.source_project_id,source_manifest_id:source.manifest_id,namespace:digest(input.operation_id),restored_counts:Object.fromEntries(sequence.map(table=>[table,(manifest.content.tables[table]??[]).length])),paid_requests:0,replayed:false};db.prepare('INSERT INTO muse_project_archive_operations VALUES(?,?,?)').run(input.operation_id,requestHash,JSON.stringify(result));return result;
 }).immediate();
}
module.exports={restore};

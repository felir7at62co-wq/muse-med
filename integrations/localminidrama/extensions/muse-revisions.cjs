/** Append-only, redacted project-content revisions; restores exclude media adoption and generation state. */
const {createHash,randomUUID}=require('node:crypto');
const owners=new WeakMap();
const failure=(code,status=400)=>Object.assign(new Error(code),{code,status});
const positive=value=>Number.isSafeInteger(Number(value))&&Number(value)>0;
const kinds={
 project:{table:'dramas',project:'{row}.id',name:'title',fields:['title','description','genre','style','tags','total_episodes'],observed:['thumbnail','metadata'],deleted:true},
 episode:{table:'episodes',project:'{row}.drama_id',name:'title',fields:['episode_number','title','script_content','description','duration'],observed:['video_url','thumbnail'],deleted:true},
 character:{table:'characters',project:'{row}.drama_id',name:'name',fields:['name','role','description','personality','appearance','voice_style','polished_prompt','negative_prompt','stages','identity_anchors','style_tokens','color_palette'],observed:['image_url','local_path','extra_images','four_view_image_url','ref_image'],deleted:true},
 scene:{table:'scenes',project:'{row}.drama_id',name:'location',fields:['location','time','prompt','polished_prompt','polished_prompt_single','negative_prompt'],observed:['episode_id','image_url','local_path','extra_images','ref_image'],deleted:true},
 prop:{table:'props',project:'{row}.drama_id',name:'name',fields:['name','type','description','prompt','negative_prompt'],observed:['episode_id','image_url','local_path','extra_images','ref_image'],deleted:true},
 storyboard:{table:'storyboards',project:'(SELECT drama_id FROM episodes WHERE id={row}.episode_id)',name:'title',fields:['storyboard_number','title','description','layout_description','location','time','duration','dialogue','narration','action','atmosphere','image_prompt','video_prompt','shot_type','angle','movement','emotion','emotion_intensity','segment_index','segment_title','angle_h','angle_v','angle_s','lighting_style','depth_of_field','polished_prompt','continuity_snapshot','creation_mode','universal_segment_text'],observed:['episode_id','scene_id','characters','image_url','local_path','video_url','last_frame_image_url','last_frame_local_path','first_frame_image_id','last_frame_image_id','audio_local_path','narration_audio_local_path'],deleted:true},
 frame_prompt:{table:'frame_prompts',project:'(SELECT e.drama_id FROM storyboards s JOIN episodes e ON e.id=s.episode_id WHERE s.id={row}.storyboard_id)',name:'frame_type',fields:['prompt','description','layout'],observed:['storyboard_id','frame_type'],deleted:false},
 episode_characters:{table:'episodes',project:'{row}.drama_id',name:'title',fields:[],observed:['character_ids'],deleted:true,relation:{table:'episode_characters',parent:'episode_id',target:'character_id',field:'character_ids'}},
 storyboard_characters:{table:'storyboards',project:'(SELECT drama_id FROM episodes WHERE id={row}.episode_id)',name:'title',fields:[],observed:['character_library_ids'],deleted:true,relation:{table:'storyboard_characters',parent:'storyboard_id',target:'character_id',field:'character_library_ids'}},
 storyboard_props:{table:'storyboards',project:'(SELECT drama_id FROM episodes WHERE id={row}.episode_id)',name:'title',fields:[],observed:['prop_ids'],deleted:true,relation:{table:'storyboard_props',parent:'storyboard_id',target:'prop_id',field:'prop_ids'}},
};
const secretKey=/^(?:api[_-]?key|access[_-]?key|access[_-]?token|bearer[_-]?token|token|password|authorization|secret(?:[_-]?key)?|credentials|cookies?|session[_-]?cookie)$/i;
const signatureKey=/token|signature|credential|secret|api[_-]?key|password|authorization/i;
function redact(value){
 if(Array.isArray(value)){let changed=false;const result=value.map(item=>{const next=redact(item);changed||=next.changed;return next.value;});return {value:result,changed};}
 if(value&&typeof value==='object'){let changed=false;const result=Object.create(null);for(const[key,item]of Object.entries(value)){if(secretKey.test(key)){result[key]='[已脱敏]';changed=true;}else{const next=redact(item);result[key]=next.value;changed||=next.changed;}}return {value:result,changed};}
 if(typeof value!=='string')return {value,changed:false};
 if(/^[\[{]/.test(value.trim())){try{const parsed=JSON.parse(value),next=redact(parsed);if(next.changed)return {value:JSON.stringify(next.value),changed:true};}catch(error){void error;}}
 let text=value;
 text=text.replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{20,})\b/g,'[已脱敏]')
  .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+/gi,'Bearer [已脱敏]')
  .replace(/\b((?:api[_-]?key|access[_-]?token|password|authorization|secret)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}\]]+)/gi,'$1[已脱敏]');
 if(/^https?:\/\//i.test(text)){try{const url=new URL(text);let changed=Boolean(url.username||url.password);url.username='';url.password='';for(const key of [...url.searchParams.keys()])if(signatureKey.test(key)){url.searchParams.set(key,'[已脱敏]');changed=true;}if(changed)text=url.href;}catch(error){void error;}}
 return {value:text,changed:text!==value};
}
function packed(source,maxBytes){const original=JSON.parse(source),values={},redacted_fields=[];for(const[key,value]of Object.entries(original)){const next=redact(value);values[key]=next.value;if(next.changed)redacted_fields.push(key);}
 const result=JSON.stringify({values,redacted_fields});if(Buffer.byteLength(result)>maxBytes)throw failure('revision_snapshot_too_large',413);return result;}
const sqlProject=(descriptor,row)=>descriptor.project.replaceAll('{row}',row);
const columns=descriptor=>[...new Set([...descriptor.fields,...descriptor.observed,...descriptor.deleted?['deleted_at']:[]])];
function sqlLinks(relation,parent,remove,add){const values=`SELECT ${relation.target} AS link FROM ${relation.table} WHERE ${relation.parent}=${parent}${remove?` AND rowid IS NOT ${remove}`:''}${add?` UNION ALL SELECT ${add} AS link`:''}`;return `json((SELECT json_group_array(link) FROM (${values} ORDER BY link)))`;}
const sqlValue=(descriptor,column,row,links)=>descriptor.relation?.field===column?links??sqlLinks(descriptor.relation,`${row}.id`):`${row}.${column}`;
const sqlSnapshot=(descriptor,row,links)=>`muse_revision_pack(json_object(${columns(descriptor).map(column=>`'${column}',${sqlValue(descriptor,column,row,links)}`).join(',')}))`;
function schema(db,cfg={}){
 const maxBytes=cfg.muse_revisions?.max_snapshot_bytes??2097152;if(!Number.isSafeInteger(maxBytes)||maxBytes<1024||maxBytes>16777216)throw failure('invalid_revision_snapshot_limit',503);
 let owner=owners.get(db);if(!owner){owner={maxBytes};owners.set(db,owner);db.function('muse_revision_pack',{deterministic:true},source=>packed(source,owner.maxBytes));}owner.maxBytes=maxBytes;
 db.exec('CREATE TABLE IF NOT EXISTS muse_revision_schema(version INTEGER NOT NULL,database_id TEXT NOT NULL)');
 const versions=db.prepare('SELECT * FROM muse_revision_schema').all();if(versions.length>1||versions[0]&&versions[0].version!==1)throw failure('unsupported_revision_schema',503);if(versions.length)return;
 db.transaction(()=>{
  db.exec(`CREATE TABLE muse_business_revisions(id INTEGER PRIMARY KEY AUTOINCREMENT,project_id INTEGER NOT NULL CHECK(project_id>0),kind TEXT NOT NULL,entity_id INTEGER NOT NULL,change_type TEXT NOT NULL,before_json TEXT,after_json TEXT,recorded_at TEXT NOT NULL);
   CREATE INDEX muse_business_revisions_subject ON muse_business_revisions(project_id,kind,entity_id,id);
   CREATE TABLE muse_revision_operations(operation_id TEXT PRIMARY KEY,request_sha256 TEXT NOT NULL,reply_json TEXT NOT NULL);
   CREATE TRIGGER muse_business_revision_immutable_update BEFORE UPDATE ON muse_business_revisions BEGIN SELECT RAISE(ABORT,'business_revision_immutable'); END;
   CREATE TRIGGER muse_business_revision_immutable_delete BEFORE DELETE ON muse_business_revisions BEGIN SELECT RAISE(ABORT,'business_revision_immutable'); END;`);
  for(const[kind,descriptor]of Object.entries(kinds)){
   const known=new Set(db.prepare(`PRAGMA table_info(${descriptor.table})`).all().map(row=>row.name));
   if(['id',...columns(descriptor).filter(column=>column!==descriptor.relation?.field)].some(column=>!known.has(column)))throw failure('revision_business_schema_changed',503);
   if(descriptor.relation){
    const relation=descriptor.relation,relationColumns=new Set(db.prepare(`PRAGMA table_info(${relation.table})`).all().map(row=>row.name));if(!relationColumns.has(relation.parent)||!relationColumns.has(relation.target))throw failure('revision_relation_schema_changed',503);
    const parent=`NEW.${relation.parent}`,project=`(SELECT ${sqlProject(descriptor,'subject')} FROM ${descriptor.table} AS subject WHERE subject.id=${parent})`,snap=(parentId,remove,add)=>`(SELECT ${sqlSnapshot(descriptor,'subject',sqlLinks(relation,parentId,remove,add))} FROM ${descriptor.table} AS subject WHERE subject.id=${parentId})`;
    db.exec(`CREATE TRIGGER muse_revision_${kind}_owner BEFORE UPDATE ON ${relation.table} WHEN OLD.${relation.parent} IS NOT NEW.${relation.parent} BEGIN SELECT RAISE(ABORT,'revision_relation_owner_immutable'); END;
     CREATE TRIGGER muse_revision_${kind}_insert AFTER INSERT ON ${relation.table} BEGIN INSERT INTO muse_business_revisions(project_id,kind,entity_id,change_type,before_json,after_json,recorded_at) VALUES(${project},'${kind}',${parent},'update',${snap(parent,'NEW.rowid')},${snap(parent)},strftime('%Y-%m-%dT%H:%M:%fZ','now')); END;
     CREATE TRIGGER muse_revision_${kind}_update AFTER UPDATE ON ${relation.table} WHEN OLD.${relation.target} IS NOT NEW.${relation.target} BEGIN INSERT INTO muse_business_revisions(project_id,kind,entity_id,change_type,before_json,after_json,recorded_at) VALUES(${project},'${kind}',${parent},'update',${snap(parent,'NEW.rowid',`OLD.${relation.target}`)},${snap(parent)},strftime('%Y-%m-%dT%H:%M:%fZ','now')); END;
     CREATE TRIGGER muse_revision_${kind}_delete BEFORE DELETE ON ${relation.table} BEGIN INSERT INTO muse_business_revisions(project_id,kind,entity_id,change_type,before_json,after_json,recorded_at) VALUES(COALESCE((SELECT ${sqlProject(descriptor,'subject')} FROM ${descriptor.table} AS subject WHERE subject.id=OLD.${relation.parent}),(SELECT project_id FROM muse_business_revisions WHERE kind='${kind}' AND entity_id=OLD.${relation.parent} ORDER BY id DESC LIMIT 1)),'${kind}',OLD.${relation.parent},'update',${snap(`OLD.${relation.parent}`)},${snap(`OLD.${relation.parent}`,'OLD.rowid')},strftime('%Y-%m-%dT%H:%M:%fZ','now')); END;`);
    db.exec(`INSERT INTO muse_business_revisions(project_id,kind,entity_id,change_type,before_json,after_json,recorded_at) SELECT ${sqlProject(descriptor,'current')},'${kind}',current.id,'baseline',NULL,${sqlSnapshot(descriptor,'current')},strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM ${descriptor.table} AS current`);
    continue;
   }
   const oldProject=sqlProject(descriptor,'OLD'),newProject=sqlProject(descriptor,'NEW'),before=sqlSnapshot(descriptor,'OLD'),after=sqlSnapshot(descriptor,'NEW');
   db.exec(`CREATE TRIGGER muse_revision_${kind}_owner BEFORE UPDATE ON ${descriptor.table} WHEN (${oldProject}) IS NOT (${newProject}) BEGIN SELECT RAISE(ABORT,'revision_project_ownership_immutable'); END;
    CREATE TRIGGER muse_revision_${kind}_insert AFTER INSERT ON ${descriptor.table} BEGIN INSERT INTO muse_business_revisions(project_id,kind,entity_id,change_type,before_json,after_json,recorded_at) VALUES(${newProject},'${kind}',NEW.id,'create',NULL,${after},strftime('%Y-%m-%dT%H:%M:%fZ','now')); END;
    CREATE TRIGGER muse_revision_${kind}_update AFTER UPDATE ON ${descriptor.table} WHEN ${columns(descriptor).map(column=>`OLD.${column} IS NOT NEW.${column}`).join(' OR ')} BEGIN INSERT INTO muse_business_revisions(project_id,kind,entity_id,change_type,before_json,after_json,recorded_at) VALUES(${newProject},'${kind}',NEW.id,'update',${before},${after},strftime('%Y-%m-%dT%H:%M:%fZ','now')); END;`);
   db.exec(`CREATE TRIGGER muse_revision_${kind}_delete AFTER DELETE ON ${descriptor.table} BEGIN INSERT INTO muse_business_revisions(project_id,kind,entity_id,change_type,before_json,after_json,recorded_at) VALUES(COALESCE(${oldProject},(SELECT project_id FROM muse_business_revisions WHERE kind='${kind}' AND entity_id=OLD.id ORDER BY id DESC LIMIT 1)),'${kind}',OLD.id,'delete',${before},NULL,strftime('%Y-%m-%dT%H:%M:%fZ','now')); END;`);
   db.exec(`INSERT INTO muse_business_revisions(project_id,kind,entity_id,change_type,before_json,after_json,recorded_at) SELECT ${sqlProject(descriptor,'current')},'${kind}',current.id,'baseline',NULL,${sqlSnapshot(descriptor,'current')},strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM ${descriptor.table} AS current`);
  }
  db.prepare('INSERT INTO muse_revision_schema VALUES(1,?)').run(randomUUID());
 }).immediate();
}
function descriptor(kind){const result=Object.hasOwn(kinds,kind)&&kinds[kind];if(!result)throw failure('unsupported_revision_kind');return result;}
function project(db,id){if(!positive(id))throw failure('project_id_required');const row=db.prepare('SELECT id FROM dramas WHERE id=? AND deleted_at IS NULL').get(Number(id));if(!row)throw failure('revision_project_not_found',404);return row.id;}
function entity(db,kind,id,projectId,allowDeleted=false,allowMissing=false){const d=descriptor(kind);if(!positive(id))throw failure('entity_id_required');const row=db.prepare(`SELECT id,${sqlProject(d,'current')} AS project_id,${d.deleted?'':'NULL AS deleted_at,'}${columns(d).map(column=>`${sqlValue(d,column,'current')} AS ${column}`).join(',')} FROM ${d.table} AS current WHERE id=?`).get(Number(id));
 if(!row&&allowMissing)return null;if(!row||row.project_id!==projectId||!allowDeleted&&row.deleted_at!==null)throw failure('revision_entity_not_found',404);return row;}
function head(db,projectId,kind,id){return db.prepare('SELECT MAX(id) AS id FROM muse_business_revisions WHERE project_id=? AND kind=? AND entity_id=?').get(projectId,kind,Number(id)).id;}
function snapshot(row){return row===null?null:JSON.parse(row);}
function listEntities(db,cfg,input){schema(db,cfg);const id=project(db,input.project_id),items=[];
 for(const[kind,d]of Object.entries(kinds)){const rows=db.prepare(`SELECT id,${d.name} AS name FROM ${d.table} AS current WHERE (${sqlProject(d,'current')})=? ${d.deleted?'AND deleted_at IS NULL':''} ORDER BY id`).all(id);for(const row of rows)items.push({kind,id:row.id,name:row.name||kind+' '+row.id,deleted:false});
  const archived=db.prepare('SELECT r.* FROM muse_business_revisions r WHERE r.project_id=? AND r.kind=? AND r.id=(SELECT MAX(h.id) FROM muse_business_revisions h WHERE h.project_id=r.project_id AND h.kind=r.kind AND h.entity_id=r.entity_id)').all(id,kind);
  for(const row of archived)if(!rows.some(current=>current.id===row.entity_id)){const value=snapshot(row.after_json??row.before_json);items.push({kind,id:row.entity_id,name:'[已删除] '+(value?.values[d.name]||kind+' '+row.entity_id),deleted:true});}}
 return {project_id:id,database_id:db.prepare('SELECT database_id FROM muse_revision_schema').get().database_id,items};}
function history(db,cfg,input){schema(db,cfg);const projectId=project(db,input.project_id),d=descriptor(input.kind),row=entity(db,input.kind,input.entity_id,projectId,true,true),id=Number(input.entity_id),currentRevision=head(db,projectId,input.kind,id),limit=input.limit===undefined?25:Number(input.limit);
 if(currentRevision===null)throw failure('revision_entity_not_found',404);
 if(!Number.isSafeInteger(limit)||limit<1||limit>100||input.before!==undefined&&!positive(input.before))throw failure('invalid_revision_pagination');
 const entries=db.prepare(`SELECT * FROM muse_business_revisions WHERE project_id=? AND kind=? AND entity_id=? ${input.before===undefined?'':'AND id<?'} ORDER BY id DESC LIMIT ?`).all(...[projectId,input.kind,id,...input.before===undefined?[]:[Number(input.before)],limit+1]);
 return {project_id:projectId,kind:input.kind,entity_id:id,current_revision:currentRevision,deleted:!row||row.deleted_at!==null,restorable_fields:d.fields,observed_fields:[...d.observed,...d.deleted?['deleted_at']:[]],
  items:entries.slice(0,limit).map(item=>({id:item.id,change_type:item.change_type,recorded_at:item.recorded_at,before:snapshot(item.before_json),after:snapshot(item.after_json)})),next:entries.length>limit?entries[limit-1].id:null};}
function restore(db,cfg,input){schema(db,cfg);if(input.database_id!==db.prepare('SELECT database_id FROM muse_revision_schema').get().database_id)throw failure('revision_database_changed',409);const projectId=project(db,input.project_id),d=descriptor(input.kind);if(typeof input.operation_id!=='string'||!/^[A-Za-z0-9_-]{8,128}$/.test(input.operation_id)||!positive(input.revision_id)||!positive(input.expected_revision)||!['before','after'].includes(input.side))throw failure('invalid_revision_restore');
 if(d.relation)throw failure('revision_relation_read_only',409);
 const spec={project_id:projectId,kind:input.kind,entity_id:Number(input.entity_id),revision_id:Number(input.revision_id),expected_revision:Number(input.expected_revision),side:input.side},hash=createHash('sha256').update(JSON.stringify(spec)).digest('hex');
 return db.transaction(()=>{
  const prior=db.prepare('SELECT * FROM muse_revision_operations WHERE operation_id=?').get(input.operation_id);if(prior){if(prior.request_sha256!==hash)throw failure('revision_operation_conflict',409);return {...JSON.parse(prior.reply_json),replayed:true,current_revision:head(db,projectId,input.kind,input.entity_id)};}
  const current=entity(db,input.kind,input.entity_id,projectId);if(head(db,projectId,input.kind,current.id)!==Number(input.expected_revision))throw failure('revision_changed',409);
  const version=db.prepare('SELECT * FROM muse_business_revisions WHERE id=? AND project_id=? AND kind=? AND entity_id=?').get(Number(input.revision_id),projectId,input.kind,current.id);if(!version)throw failure('revision_not_found',404);
  const target=snapshot(input.side==='before'?version.before_json:version.after_json);if(!target)throw failure('revision_side_unavailable');
  if(target.redacted_fields.some(field=>d.fields.includes(field)))throw failure('redacted_content_cannot_be_restored',409);
  if(d.fields.some(field=>!Object.hasOwn(target.values,field)))throw failure('revision_fields_changed',409);
  const result=db.prepare(`UPDATE ${d.table} SET ${d.fields.map(field=>field+'=?').join(',')}${d.deleted?',updated_at=?':''} WHERE id=?`).run(...d.fields.map(field=>target.values[field]),...d.deleted?[new Date().toISOString()]:[],current.id);if(result.changes!==1)throw failure('revision_restore_not_confirmed',409);
  const currentRevision=head(db,projectId,input.kind,current.id),reply={operation_id:input.operation_id,project_id:projectId,kind:input.kind,entity_id:current.id,source_revision:version.id,current_revision:currentRevision,changed:currentRevision!==Number(input.expected_revision),media_adoption_changed:false,paid_generation_dispatched:false};
  db.prepare('INSERT INTO muse_revision_operations VALUES(?,?,?)').run(input.operation_id,hash,JSON.stringify(reply));return reply;
 }).immediate();}
function usage(db,cfg,input){schema(db,cfg);const id=project(db,input.project_id),result={project_id:id,coverage:'native-generation-records',billing_verified:false};
 for(const [kind,table]of [['image','image_generations'],['video','video_generations'],['audio','muse_tts_generations']]){
  if(!db.prepare('SELECT name FROM sqlite_master WHERE type=? AND name=?').get('table',table)){result[kind]={available:false,usage_status:'unreported',input_tokens:null,output_tokens:null,total_tokens:null,cost:null};continue;}
  const rows=kind==='audio'?db.prepare('SELECT g.state AS status FROM muse_tts_generations g JOIN storyboards s ON s.id=g.storyboard_id JOIN episodes e ON e.id=s.episode_id WHERE e.drama_id=?').all(id):db.prepare(`SELECT status FROM ${table} WHERE drama_id=?`).all(id);
  result[kind]={available:true,records:rows.length,completed:rows.filter(row=>row.status==='completed').length,failed:rows.filter(row=>row.status==='failed').length,pending:rows.filter(row=>['generating','processing','pending'].includes(row.status)).length,unknown:rows.filter(row=>!['completed','failed','generating','processing','pending'].includes(row.status)).length,usage_status:'unreported',input_tokens:null,output_tokens:null,total_tokens:null,cost:null};
 }
 return result;
}
module.exports={schema,listEntities,history,restore,usage};

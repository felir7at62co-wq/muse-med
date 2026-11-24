/** Verified CLI images adopted by keyed native assets, with atomic comparison and retained prior versions. */
const {createHash,randomUUID}=require('node:crypto');
const media=require('./museLibTvCliMedia');
const tables={character:'characters',scene:'scenes',prop:'props'};
const fail=(code,message,status=409)=>Object.assign(new Error(message),{code,status});
const canonical=value=>Array.isArray(value)?'['+value.map(canonical).join(',')+']':value&&typeof value==='object'?'{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+canonical(value[key])).join(',')+'}':JSON.stringify(value);
const digest=value=>createHash('sha256').update(canonical(value)).digest('hex');
const identifier=value=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value);
const operation=value=>typeof value==='string'&&/^[A-Za-z0-9_:-]{8,128}$/.test(value);

function schema(db){
 db.exec('CREATE TABLE IF NOT EXISTS muse_production_adoption_schema(version INTEGER NOT NULL,database_id TEXT NOT NULL)');
 const rows=db.prepare('SELECT * FROM muse_production_adoption_schema').all();
 if(rows.length>1||rows[0]&&rows[0].version!==1)throw fail('adoption_schema_unsupported','Unsupported asset adoption storage version',503);
 if(!rows.length)db.transaction(()=>{
  db.exec(`CREATE TABLE muse_production_adoptions(operation_id TEXT PRIMARY KEY,request_sha256 TEXT NOT NULL,namespace TEXT NOT NULL,kind TEXT NOT NULL,external_key TEXT NOT NULL,asset_id INTEGER NOT NULL,generation_id INTEGER NOT NULL,source_sha256 TEXT NOT NULL,previous_json TEXT NOT NULL,source_json TEXT NOT NULL,receipt_json TEXT NOT NULL,created_at TEXT NOT NULL);
CREATE TRIGGER muse_production_adoptions_immutable BEFORE UPDATE ON muse_production_adoptions BEGIN SELECT RAISE(ABORT,'adoption_receipt_immutable'); END;
CREATE TRIGGER muse_production_adoptions_retained BEFORE DELETE ON muse_production_adoptions BEGIN SELECT RAISE(ABORT,'adoption_receipt_retained'); END;`);
  db.prepare('INSERT INTO muse_production_adoption_schema VALUES(1,?)').run(randomUUID());
 }).immediate();
 return db.prepare('SELECT database_id FROM muse_production_adoption_schema').get().database_id;
}

function read(db,cfg,input){
 if(!identifier(input.namespace)||!identifier(input.key)||!Object.hasOwn(tables,input.kind)||!Number.isSafeInteger(input.generation_id)||input.generation_id<1)throw fail('adoption_input_invalid','Use a mapped namespace, asset kind, key and exact generation ID',400);
 const required=['muse_production_plans','muse_production_plan_entities','muse_libtv_cli_imports','muse_libtv_cli_operations','muse_libtv_cli_uploads'];
 for(const table of required)if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table))throw fail('adoption_source_missing','Import the plan and verified CLI image before adopting it',404);
 const plan=db.prepare('SELECT * FROM muse_production_plans WHERE namespace=?').get(input.namespace);
 const mapping=db.prepare('SELECT * FROM muse_production_plan_entities WHERE namespace=? AND kind=? AND external_key=?').get(input.namespace,input.kind,input.key);
 if(!plan||!mapping)throw fail('adoption_target_missing','The declared asset has no imported native mapping',404);
 const project=db.prepare('SELECT id FROM dramas WHERE id=? AND deleted_at IS NULL').get(plan.project_id);
 const target=db.prepare('SELECT * FROM '+tables[input.kind]+' WHERE id=? AND deleted_at IS NULL').get(mapping.native_id);
 if(!project||!target||target.drama_id!==plan.project_id)throw fail('adoption_target_changed','The mapped asset is missing, archived or belongs to another project');
 let library=null,libraryMapping=null;
 if(input.kind==='character'){
  libraryMapping=db.prepare("SELECT * FROM muse_production_plan_entities WHERE namespace=? AND kind='character_library' AND external_key=?").get(input.namespace,input.key);
  library=libraryMapping?db.prepare('SELECT * FROM character_libraries WHERE id=? AND deleted_at IS NULL').get(libraryMapping.native_id):null;
  if(!library||library.drama_id!==plan.project_id||library.source_type!=='character'||library.source_id!==String(target.id))throw fail('adoption_target_changed','The mapped character reference library is missing or belongs to another source');
 }
 const generation=db.prepare('SELECT * FROM image_generations WHERE id=? AND deleted_at IS NULL').get(input.generation_id);
 const imported=db.prepare("SELECT * FROM muse_libtv_cli_imports WHERE kind='image' AND generation_id=?").get(input.generation_id);
 if(!generation||!imported||generation.drama_id!==plan.project_id||generation.status!=='completed')throw fail('adoption_image_unavailable','Use a completed verified CLI image from this native project');
 const source=db.prepare('SELECT * FROM muse_libtv_cli_operations WHERE operation_id=?').get(imported.source_operation_id);
 const upload=db.prepare('SELECT * FROM muse_libtv_cli_uploads WHERE upload_id=?').get(imported.upload_id);
 if(!source||source.state!=='completed'||source.project_id!==plan.project_id||!upload||upload.state!=='verified'||upload.kind!=='image'||upload.sha256!==imported.sha256||upload.local_path!==imported.local_path||generation.local_path!==imported.local_path)throw fail('adoption_image_unverified','The original CLI image receipt is no longer consistent');
 const maximum=cfg.muse_libtv_cli?.max_media_bytes??268435456;
 const file=media.fileHash(cfg,imported.local_path,maximum);
 if(file.sha256!==imported.sha256||file.size_bytes!==upload.total_bytes)throw fail('adoption_image_changed','The verified image bytes changed; retain the original result and inspect it',422);
 const imageUrl=String(cfg.storage.base_url||'/static').replace(/\/$/,'')+'/'+imported.local_path;
 if(generation.image_url!==imageUrl)throw fail('adoption_image_changed','The imported image URL no longer names the verified file',422);
 return {plan,mapping,target,library,libraryMapping,generation,imported,source,upload,imageUrl,
  targetSha256:digest({mapping,target,libraryMapping,library}),sourceSha256:digest({generation,imported,source,upload})};
}

function preview(db,cfg,input){
 const database_id=schema(db),value=read(db,cfg,input);
 return {status:'ready',database_id,namespace:input.namespace,kind:input.kind,key:input.key,
  project_id:value.plan.project_id,asset_id:value.target.id,generation_id:input.generation_id,
  target_sha256:value.targetSha256,source_sha256:value.sourceSha256,
  media_sha256:value.imported.sha256,image_url:value.imageUrl,local_path:value.imported.local_path,paid_requests:0};
}

function apply(db,cfg,input){
 const databaseId=schema(db);
 if(!operation(input.operation_id))throw fail('adoption_operation_invalid','Use a stable adoption operation ID',400);
 const fingerprint=digest(input);
 return db.transaction(()=>{
  const old=db.prepare('SELECT * FROM muse_production_adoptions WHERE operation_id=?').get(input.operation_id);
  if(old){if(old.request_sha256!==fingerprint)throw fail('adoption_operation_changed','This adoption operation already owns different inputs');return {...JSON.parse(old.receipt_json),replayed:true};}
  if(input.database_id!==databaseId)throw fail('adoption_database_changed','The native adoption database changed');
  const value=read(db,cfg,input);
  if(input.expected_target_sha256!==value.targetSha256||input.expected_source_sha256!==value.sourceSha256)throw fail('adoption_snapshot_changed','Read the current asset and original image before adopting another version');
  const at=new Date().toISOString();
  db.prepare('UPDATE '+tables[input.kind]+' SET image_url=?,local_path=?,updated_at=? WHERE id=?').run(value.imageUrl,value.imported.local_path,at,value.target.id);
  if(value.library)db.prepare('UPDATE character_libraries SET image_url=?,local_path=?,updated_at=? WHERE id=?').run(value.imageUrl,value.imported.local_path,at,value.library.id);
  const receipt={status:'adopted',operation_id:input.operation_id,database_id:databaseId,namespace:input.namespace,kind:input.kind,key:input.key,
   project_id:value.plan.project_id,asset_id:value.target.id,generation_id:input.generation_id,source_operation_id:value.source.operation_id,
   sha256:value.imported.sha256,image_url:value.imageUrl,local_path:value.imported.local_path,character_library_id:value.library?.id??null,previous:{image_url:value.target.image_url,local_path:value.target.local_path},replayed:false,paid_requests:0};
  db.prepare('INSERT INTO muse_production_adoptions VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(input.operation_id,fingerprint,input.namespace,input.kind,input.key,value.target.id,input.generation_id,value.imported.sha256,canonical({...value.target,related_library:value.library}),canonical({generation:value.generation,imported:value.imported,source:value.source,upload:value.upload}),JSON.stringify(receipt),at);
  return receipt;
 }).immediate();
}

function get(db,input){
 schema(db);
 if(!operation(input.operation_id))throw fail('adoption_operation_invalid','Use the original adoption operation ID',400);
 const row=db.prepare('SELECT receipt_json FROM muse_production_adoptions WHERE operation_id=?').get(input.operation_id);
 return row?{...JSON.parse(row.receipt_json),replayed:true}:{status:'missing',operation_id:input.operation_id,paid_requests:0};
}

module.exports={schema,preview,apply,get};

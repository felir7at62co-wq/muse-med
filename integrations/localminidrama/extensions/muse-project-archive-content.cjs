/** Project-owned content selection excludes account settings, credentials and spending authority. */
const {createHash}=require('node:crypto');
const fail=(code,status=409)=>Object.assign(Error(code),{code,status});
const descriptors=[
 ['dramas','id=?','id'],['episodes','drama_id=?','drama_id'],['characters','drama_id=?','drama_id'],['scenes','drama_id=?','drama_id'],['props','drama_id=?','drama_id'],
 ['storyboards','episode_id IN (SELECT id FROM episodes WHERE drama_id=?)','(SELECT drama_id FROM episodes WHERE id={row}.episode_id)'],
 ['frame_prompts','storyboard_id IN (SELECT s.id FROM storyboards s JOIN episodes e ON e.id=s.episode_id WHERE e.drama_id=?)','(SELECT e.drama_id FROM storyboards s JOIN episodes e ON e.id=s.episode_id WHERE s.id={row}.storyboard_id)'],
 ['episode_characters','episode_id IN (SELECT id FROM episodes WHERE drama_id=?)','(SELECT drama_id FROM episodes WHERE id={row}.episode_id)'],
 ['storyboard_characters','storyboard_id IN (SELECT s.id FROM storyboards s JOIN episodes e ON e.id=s.episode_id WHERE e.drama_id=?)','(SELECT e.drama_id FROM storyboards s JOIN episodes e ON e.id=s.episode_id WHERE s.id={row}.storyboard_id)'],
 ['storyboard_props','storyboard_id IN (SELECT s.id FROM storyboards s JOIN episodes e ON e.id=s.episode_id WHERE e.drama_id=?)','(SELECT e.drama_id FROM storyboards s JOIN episodes e ON e.id=s.episode_id WHERE s.id={row}.storyboard_id)'],
 ['character_libraries','drama_id=?','drama_id'],['scene_libraries','drama_id=?','drama_id'],['prop_libraries','drama_id=?','drama_id'],
 ['image_generations','drama_id=?','drama_id'],['video_generations','drama_id=?','drama_id'],['assets','drama_id=?','drama_id'],['video_merges','drama_id=?','drama_id'],
 ['muse_business_revisions','project_id=?','project_id'],['muse_studio_asset_versions','project_id=?','project_id'],['muse_studio_prompt_revisions','project_id=?','project_id'],
 ['muse_studio_package_heads','package_id IN (SELECT s.id FROM storyboards s JOIN episodes e ON e.id=s.episode_id WHERE e.drama_id=?)','(SELECT e.drama_id FROM storyboards s JOIN episodes e ON e.id=s.episode_id WHERE s.id={row}.package_id)'],
 ['muse_studio_media_versions',"(CASE WHEN kind='image' THEN (SELECT drama_id FROM image_generations WHERE id=generation_id) ELSE (SELECT drama_id FROM video_generations WHERE id=generation_id) END)=?","CASE WHEN {row}.kind='image' THEN (SELECT drama_id FROM image_generations WHERE id={row}.generation_id) ELSE (SELECT drama_id FROM video_generations WHERE id={row}.generation_id) END"],
 ['muse_project_archive_documents','project_id=?','project_id'],
 ['muse_project_archive_history','project_id=?','project_id'],
];
const secret=/^(?:api[_-]?key|access[_-]?key|access[_-]?token|bearer[_-]?token|token|password|authorization|secret|credentials|cookies?|session[_-]?cookie|approvalToken|approvalNonce)$/i;
function clean(value){
 if(Array.isArray(value))return value.map(clean);
 if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([key])=>!secret.test(key)).map(([key,item])=>[key,clean(item)]));
 if(typeof value!=='string')return value;
 if(/^[\[{]/.test(value.trim())){try{return JSON.stringify(clean(JSON.parse(value)))}catch(error){void error;}}
 if(/^https?:\/\//i.test(value)){try{const url=new URL(value);url.username='';url.password='';for(const key of [...url.searchParams.keys()])if(/token|signature|credential|secret|key|authorization/i.test(key))url.searchParams.delete(key);return url.href;}catch(error){void error;}}
 return value.replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{20,})\b/g,'[redacted]').replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+/gi,'Bearer [redacted]');
}
function digest(value){return createHash('sha256').update(typeof value==='string'||Buffer.isBuffer(value)?value:JSON.stringify(value)).digest('hex');}
function exists(db,table){return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);}
function project(db,id){if(!Number.isSafeInteger(id)||id<1)throw fail('project_archive_project_required',400);const row=db.prepare('SELECT * FROM dramas WHERE id=?').get(id);if(!row)throw fail('project_archive_project_not_found',404);return row;}
function select(db,cfg,id,limits){
 project(db,id);const tables={};let count=0;
 for(const [table,where]of descriptors){if(!exists(db,table))continue;const rows=db.prepare('SELECT * FROM '+table+' WHERE '+where+' ORDER BY rowid LIMIT ?').all(id,limits.max_rows+1);count+=rows.length;if(count>limits.max_rows)throw fail('project_archive_row_limit',413);tables[table]=rows.map(clean);}
 // A storyboard may explicitly reference a tenant-global character image. Only those exact rows are included.
 if(exists(db,'character_libraries')&&exists(db,'storyboard_characters')){
  const ids=new Set(tables.character_libraries.map(row=>row.id));
  for(const row of db.prepare('SELECT DISTINCT c.* FROM character_libraries c JOIN storyboard_characters l ON l.character_id=c.id JOIN storyboards s ON s.id=l.storyboard_id JOIN episodes e ON e.id=s.episode_id WHERE e.drama_id=?').all(id)){
   if(row.drama_id!==null&&row.drama_id!==id)throw fail('project_archive_foreign_reference');
   if(!ids.has(row.id)){tables.character_libraries.push(clean(row));ids.add(row.id);if(++count>limits.max_rows)throw fail('project_archive_row_limit',413);}
  }
 }
 const generation_inputs=[];
 if(exists(db,'muse_studio_schema'))for(const kind of ['image','video'])for(const row of tables[kind+'_generations']??[]){
  generation_inputs.push({kind,generation_id:row.id,inputs:clean(require('./museStudio').generationInputs(db,cfg,kind,row))});
 }
 return {tables,generation_inputs};
}
function localPath(value){
 if(typeof value!=='string'||!value)return null;
 let text=value;
 if(/^https?:\/\//i.test(text)){try{const url=new URL(text);if(!url.pathname.startsWith('/studio/static/')&&!url.pathname.startsWith('/static/'))return null;text=url.pathname;}catch(error){return null;}}
 text=text.replace(/^\/(?:studio\/)?static\//,'');
 if(text===value&&(/^[A-Za-z][A-Za-z\d+.-]*:/.test(text)||text.startsWith('/')||!text.includes('/')&&!/\.[a-z0-9]{1,8}$/i.test(text)))return null;
 try{text=decodeURIComponent(text);}catch(error){throw fail('project_archive_invalid_media_path',400);}
 if(text.includes('\\')||text.includes('\0')||text.split('/').some(part=>!part||part==='.'||part==='..'))throw fail('project_archive_invalid_media_path',400);
 return text;
}
function mediaPaths(content){const result=new Set();function visit(value,key=''){
 if(typeof value==='string'){
  if(/^[\[{]/.test(value.trim())){try{visit(JSON.parse(value));return;}catch(error){void error;}}
  if(/^(?:url|.*local_?path|mediaUrl|image_url|video_url|audio_url|thumbnail|ref_image|reference_images|reference_image_urls|first_frame_url|last_frame_url|composed_image|extra_images|four_view_image_url)$/i.test(key)){const relative=localPath(value);if(relative)result.add(relative);}
 }else if(Array.isArray(value))for(const item of value)visit(item,key);else if(value&&typeof value==='object')for(const[name,item]of Object.entries(value))visit(item,name);
 }visit(content);return [...result].sort((a,b)=>Number(b.startsWith('muse-studio/'))-Number(a.startsWith('muse-studio/'))||a.localeCompare(b));}
module.exports={descriptors,clean,digest,exists,project,select,localPath,mediaPaths,fail};

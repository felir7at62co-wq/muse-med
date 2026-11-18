/** Project archives exercise actual SQLite transactions and isolated file storage without model calls. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,mkdtempSync,mkdirSync,writeFileSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {createRequire} from 'node:module';
import {compileFunction} from 'node:vm';
import {createHash} from 'node:crypto';
const nativeRequire=createRequire(import.meta.url),sha=value=>createHash('sha256').update(value).digest('hex');
const migration=resolve(process.env.LOCALMINIDRAMA_SOURCE||'.local/localminidrama','backend-node/migrations/01_init.sql'),fixtureOptions={skip:!existsSync(migration)};
function fixture(t){
 const home=mkdtempSync(join(tmpdir(),'muse-project-archive-')),db=new DatabaseSync(':memory:');db.transaction=fn=>{const transaction=(...args)=>{db.exec('BEGIN');try{const value=fn(...args);db.exec('COMMIT');return value;}catch(error){db.exec('ROLLBACK');throw error;}};transaction.immediate=transaction;transaction.deferred=transaction;return transaction;};
 db.exec(readFileSync(migration,'utf8'));
 db.exec("INSERT INTO dramas(id,title,metadata) VALUES(1,'Private production','{\"api_key\":\"not-exported\",\"outline\":\"keep\"}'),(2,'Other private project',NULL);INSERT INTO episodes(id,drama_id,title,script_content) VALUES(10,1,'Episode 1','Natural language script'),(20,2,'Other episode','Must not export');INSERT INTO characters(id,drama_id,name,local_path) VALUES(11,1,'Hero','images/hero.png');INSERT INTO scenes(id,drama_id,episode_id,location) VALUES(12,1,10,'Office');INSERT INTO props(id,drama_id,name) VALUES(13,1,'Cup');INSERT INTO storyboards(id,episode_id,scene_id,title,video_prompt,video_url) VALUES(14,10,12,'Shot','Bound prompt','/static/videos/original.mp4');INSERT INTO image_generations(id,drama_id,storyboard_id,character_id,prompt,status,local_path) VALUES(15,1,14,11,'First image prompt','completed','images/hero.png');INSERT INTO video_generations(id,drama_id,storyboard_id,scene_id,prompt,status,local_path,video_url) VALUES(16,1,14,12,'First video prompt','completed','videos/original.mp4','/static/videos/original.mp4');INSERT INTO episode_characters VALUES(10,11);INSERT INTO storyboard_props VALUES(14,13);");
 db.exec(`CREATE TABLE muse_studio_schema(version INTEGER);INSERT INTO muse_studio_schema VALUES(2);
 CREATE TABLE muse_studio_asset_versions(version_id TEXT PRIMARY KEY,project_id INTEGER,asset_kind TEXT,asset_id INTEGER,generation_id INTEGER,display_name TEXT,sha256 TEXT,media_type TEXT,local_path TEXT,total_bytes INTEGER,created_at TEXT);
 CREATE TABLE muse_studio_prompt_revisions(revision_id TEXT PRIMARY KEY,project_id INTEGER,package_id INTEGER,image_prompt TEXT,video_prompt TEXT,image_bindings_json TEXT,video_bindings_json TEXT,created_at TEXT);
 CREATE TABLE muse_studio_package_heads(package_id INTEGER PRIMARY KEY,revision_id TEXT);
 INSERT INTO muse_studio_asset_versions VALUES('asset-version',1,'character',11,15,'Hero','image-hash','image/png','images/hero.png',11,'today');
 INSERT INTO muse_studio_prompt_revisions VALUES('prompt-version',1,14,'Image @asset(hero)','Video @asset(hero)','[{"versionId":"asset-version","assetKind":"character","assetId":11,"generationId":15}]','[{"versionId":"asset-version","assetKind":"character","assetId":11,"generationId":15}]','today');
 INSERT INTO muse_studio_package_heads VALUES(14,'prompt-version');`);
 mkdirSync(join(home,'images'));mkdirSync(join(home,'videos'));writeFileSync(join(home,'images/hero.png'),Buffer.from('image bytes'));writeFileSync(join(home,'videos/original.mp4'),Buffer.from('video bytes'));
 const modules=new Map(),names={museProjectArchive:'muse-project-archive.cjs',museProjectArchiveContent:'muse-project-archive-content.cjs',museProjectArchiveFiles:'muse-project-archive-files.cjs',museProjectArchiveRestore:'muse-project-archive-restore.cjs'};
 const studio={generationInputs:(_db,_cfg,kind,row)=>({state:'captured',source:'native',prompt:row.prompt,bindings:[{versionId:'asset-version',assetKind:'character',assetId:11,generationId:15}],revisionId:'prompt-version',postproduction:kind==='video'?{parentGenerationId:16}:null})};
 function load(name){if(modules.has(name))return modules.get(name).exports;const module={exports:{}};modules.set(name,module);compileFunction(readFileSync(new URL('../extensions/'+names[name],import.meta.url),'utf8'),['require','module','exports'])(value=>value==='./museStudio'?studio:value.startsWith('./museProject')?load(value.slice(2)):nativeRequire(value),module,module.exports);return module.exports;}
 const cfg={storage:{local_path:home,base_url:'/static'},muse_project_archive:{debounce_ms:100,retry_ms:1000}},api=load('museProjectArchive'),service=api.service(db,cfg);
 t.after(async()=>{await service.close();db.close();assert.ok(home.startsWith(resolve(tmpdir())+sep+'muse-project-archive-'));rmSync(home,{recursive:true,force:true,maxRetries:5,retryDelay:50});});return {home,db,cfg,api,service,load};
}
test('checkpoint preserves one project, every media version and immutable source files',fixtureOptions,async t=>{
 const f=fixture(t),first=await f.service.checkpoint(1),row=f.db.prepare('SELECT * FROM muse_project_archive_manifests WHERE project_id=1').get(),manifest=JSON.parse(row.manifest_json);
 assert.equal(first.status,'saved');assert.equal(first.counts.video_generations,1);assert.equal(manifest.files.length,2);assert.equal(manifest.content.tables.episodes[0].script_content,'Natural language script');assert.doesNotMatch(row.manifest_json,/Other private|Must not export|not-exported/);assert.match(row.manifest_json,/outline/);
 assert.equal((await f.service.verify(1,1)).status,'verified');assert.equal((await f.service.checkpoint(1)).revision,1);
 assert.throws(()=>f.db.prepare("UPDATE muse_project_archive_manifests SET manifest_json='{}'").run(),/immutable/);
 f.db.prepare('UPDATE video_generations SET prompt=? WHERE id=16').run('Changed prompt');assert.equal((await f.service.checkpoint(1)).revision,2);assert.equal(JSON.parse(row.manifest_json).content.tables.video_generations[0].prompt,'First video prompt');assert.equal(readFileSync(join(f.home,'videos/original.mp4'),'utf8'),'video bytes');
});
test('original documents and media export chunks retain exact hashes',fixtureOptions,async t=>{
 const f=fixture(t),bytes=Buffer.from('Original Word document bytes'),input={operation_id:'archive-document-one',name:'Script.docx',mime_type:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',sha256:sha(bytes),data_base64:bytes.toString('base64')};
 const saved=await f.service.document(1,input);assert.equal((await f.service.document(1,input)).replayed,true);assert.equal(saved.total_bytes,bytes.length);const checkpoint=await f.service.checkpoint(1),chunk=await f.service.chunk(1,checkpoint.revision,input.sha256,0);assert.equal(sha(Buffer.from(chunk.dataBase64,'base64')),input.sha256);assert.equal(chunk.chunkSha256,input.sha256);
 const metadata=f.service.manifestChunk(1,checkpoint.revision,0);assert.equal(sha(Buffer.from(metadata.dataBase64,'base64')),metadata.chunkSha256);await assert.rejects(f.service.chunk(2,1,input.sha256,0),{code:'project_archive_manifest_not_found'});
});
test('restore creates new IDs and retains original project, history and media',fixtureOptions,async t=>{
 const f=fixture(t),saved=await f.service.checkpoint(1),restored=await f.service.restore({source_project_id:1,revision:saved.revision,title:'Restored production',operation_id:'archive-restore-one'});
 assert.notEqual(restored.project_id,1);assert.equal(f.db.prepare('SELECT title FROM dramas WHERE id=1').get().title,'Private production');assert.equal(f.db.prepare('SELECT count(*) AS n FROM dramas').get().n,3);assert.equal(f.db.prepare('SELECT count(*) AS n FROM video_generations').get().n,2);
 const video=f.db.prepare('SELECT * FROM video_generations WHERE drama_id=?').get(restored.project_id);assert.notEqual(video.id,16);assert.match(video.local_path,/^muse-project-restores\//);assert.equal(readFileSync(join(f.home,video.local_path),'utf8'),'video bytes');assert.equal(f.api.generationInputs(f.db,'video',video).archiveSource.source_generation_id,16);
 const binding=f.api.generationInputs(f.db,'video',video).bindings[0],image=f.db.prepare('SELECT id FROM image_generations WHERE drama_id=?').get(restored.project_id),asset=f.db.prepare('SELECT * FROM muse_studio_asset_versions WHERE project_id=?').get(restored.project_id);assert.equal(binding.generationId,image.id);assert.equal(binding.versionId,asset.version_id);assert.notEqual(binding.versionId,'asset-version');assert.notEqual(f.api.generationInputs(f.db,'video',video).revisionId,'prompt-version');
 const replay=await f.service.restore({source_project_id:1,revision:saved.revision,title:'Restored production',operation_id:'archive-restore-one'});assert.equal(replay.project_id,restored.project_id);assert.equal(replay.replayed,true);assert.equal(f.db.prepare('SELECT count(*) AS n FROM dramas').get().n,3);
 writeFileSync(join(f.home,video.local_path),'new live bytes');assert.equal(readFileSync(join(f.home,'videos/original.mp4'),'utf8'),'video bytes');await f.service.verify(1,1);
});
test('a retained archive remains complete after an old live media file is removed',fixtureOptions,async t=>{
 const f=fixture(t);await f.service.checkpoint(1);rmSync(join(f.home,'images/hero.png'));f.db.prepare('UPDATE characters SET name=? WHERE id=11').run('Renamed hero');const saved=await f.service.checkpoint(1);assert.equal(saved.status,'saved');assert.equal(saved.revision,2);await f.service.verify(1,2);
});
test('automatic checkpoints and idle flushing retain dirty state across service restarts',fixtureOptions,async t=>{
 const f=fixture(t);f.service.start();const deadline=Date.now()+5000;
 while(f.service.listProjects().items.find(row=>row.project_id===1).status!=='saved'){if(Date.now()>deadline)throw Error('Checkpoint did not complete');await new Promise(resolve=>setTimeout(resolve,10));}
 await f.service.close();f.db.prepare('UPDATE characters SET appearance=? WHERE id=11').run('New appearance');
 const modules=new Map(),names={museProjectArchive:'muse-project-archive.cjs',museProjectArchiveContent:'muse-project-archive-content.cjs',museProjectArchiveFiles:'muse-project-archive-files.cjs',museProjectArchiveRestore:'muse-project-archive-restore.cjs'};
 function load(name){if(modules.has(name))return modules.get(name).exports;const module={exports:{}};modules.set(name,module);compileFunction(readFileSync(new URL('../extensions/'+names[name],import.meta.url),'utf8'),['require','module','exports'])(value=>value==='./museStudio'?{generationInputs:()=>({})}:value.startsWith('./museProject')?load(value.slice(2)):nativeRequire(value),module,module.exports);return module.exports;}
 const restarted=load('museProjectArchive').service(f.db,f.cfg);t.after(()=>restarted.close());while(!await restarted.beforeStop()){if(Date.now()>deadline)throw Error('Idle checkpoint did not finish');}assert.equal(restarted.listProjects().items.find(row=>row.project_id===1).status,'saved');assert.ok(restarted.list(1).total>=2);
});
test('missing media remains dirty with a visible failure and resumes after repair',fixtureOptions,async t=>{
 const f=fixture(t);rmSync(join(f.home,'images/hero.png'));await assert.rejects(f.service.checkpoint(1));const failed=f.service.listProjects().items.find(row=>row.project_id===1);assert.equal(failed.status,'failed');assert.ok(failed.error_code);assert.equal(f.service.list(1).total,0);
 writeFileSync(join(f.home,'images/hero.png'),'image bytes');assert.equal((await f.service.checkpoint(1)).status,'saved');assert.equal(f.service.listProjects().items.find(row=>row.project_id===1).status,'saved');assert.equal(f.service.activeCount(),0);
});
test('path escape, changed archive blob and invalid limits fail closed',fixtureOptions,async t=>{
 const f=fixture(t);f.db.prepare('UPDATE characters SET local_path=? WHERE id=11').run('../outside.png');await assert.rejects(f.service.checkpoint(1),{code:'project_archive_invalid_media_path'});f.db.prepare('UPDATE characters SET local_path=? WHERE id=11').run('images/hero.png');await f.service.checkpoint(1);const manifest=JSON.parse(f.db.prepare('SELECT manifest_json FROM muse_project_archive_manifests').get().manifest_json),file=manifest.files[0];writeFileSync(join(f.home,'.muse-project-archives/blobs',file.sha256),'changed');await assert.rejects(f.service.verify(1,1),{code:'project_archive_blob_changed'});assert.throws(()=>f.api.limits({muse_project_archive:{max_rows:0}}),{code:'project_archive_invalid_limits'});
});

/** Real SQLite, decoded image bytes and tenant HTTP routes keep historical generation inputs independent of current assets. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire,Module} from 'node:module';
import {readFileSync,existsSync,mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {join,resolve,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {createServer} from 'node:http';
import {randomUUID} from 'node:crypto';
import {planMuseStudio} from '../compatibility/muse-studio.mjs';
import {planMuseStudioNative} from '../compatibility/muse-studio-native.mjs';
import {localGenerationReferences} from '../cloud/security.mjs';
const backend=resolve(process.env.LOCALMINIDRAMA_SOURCE||'.local/localminidrama','backend-node'),require=createRequire(join(backend,'package.json')),available=existsSync(join(backend,'node_modules/better-sqlite3/package.json')),retained=[];
let patched=false;
async function fixture(t,{legacy=false}={}){
 const home=mkdtempSync(join(tmpdir(),'muse-studio-')),storage=join(home,'storage');mkdirSync(storage);const Database=require('better-sqlite3');
 if(!patched){const {cppdb}=require('better-sqlite3/lib/util'),probe=new Database(':memory:'),native=Object.getPrototypeOf(probe[cppdb]),prepare=native.prepare;native.prepare=function(...args){const result=prepare.apply(this,args);retained.push(this,result,args[1]);return result};retained.push(probe);probe.close();patched=true;}
 const db=new Database(join(home,'tenant.db'));retained.push(db);const servers=[];t.after(async()=>{for(const server of servers){server.closeAllConnections();await new Promise(resolve=>server.close(resolve))}db.close();assert.equal(dirname(resolve(home)),resolve(tmpdir()));rmSync(home,{recursive:true,force:true,maxRetries:5,retryDelay:50})});
 const migration=new Module(join(backend,'src/db/migrate.js'));migration.filename=join(backend,'src/db/migrate.js');migration.require=name=>name==='./index.js'?{getDb(){throw Error('private fixture owns database')}}:name==='../config/index.js'?{loadConfig(){throw Error('fixture never reads config')}}:require(name);migration._compile('const console={log(){},warn(){},error(){}};'+readFileSync(migration.filename,'utf8'),migration.filename);migration.exports.runMigrationsAndEnsure(db);
 db.exec("INSERT INTO dramas(id,title) VALUES(1,'Studio'),(2,'Foreign');INSERT INTO episodes(id,drama_id,episode_number) VALUES(1,1,1),(2,2,1);INSERT INTO storyboards(id,episode_id,storyboard_number,image_prompt,video_prompt) VALUES(1,1,1,'old image','old video'),(2,2,1,'foreign','foreign');INSERT INTO characters(id,drama_id,name,image_url,local_path) VALUES(1,1,'Hero','/studio/static/hero.png','hero.png'),(2,2,'Foreign','/studio/static/foreign.png','foreign.png')");
 const sharp=require('sharp'),red=await sharp({create:{width:8,height:8,channels:3,background:'red'}}).png().toBuffer(),blue=await sharp({create:{width:8,height:8,channels:3,background:'blue'}}).png().toBuffer();writeFileSync(join(storage,'hero.png'),red);writeFileSync(join(storage,'foreign.png'),blue);
 const cfg={storage:{local_path:storage,base_url:'/studio/static'}},loaded=new Map(),owned={museStudioInputs:'muse-studio-inputs.cjs',museStudioNative:'muse-studio-native.cjs',museStudio:'muse-studio.cjs',museStudioRoutes:'muse-studio-routes.cjs',museEditCas:'muse-edit-cas.cjs',musePostproductionMedia:'muse-postproduction-media.cjs',storyboardService:null,imageService:null,videoService:null};
 const nativeSources=existsSync(join(backend,'src/services/museStudioNative.js'))?null:new Map(planMuseStudioNative(dirname(backend))),adapter={images:[],videos:[],textCalls:0},imageAdapter={getDefaultImageConfig:()=>({provider:'fixture',model:'fixture-image'}),getStoryboardReferenceLimits:()=>({total:10,maxCharacters:10,maxObjects:10}),canAddStoryboardObjectRef:()=>true,canAddStoryboardCharacterRef:()=>true,refListHasCanonical:(refs,value)=>refs.includes(value),async callImageApi(db,log,options){adapter.images.push(options);return {error:'fixture_after_captured_image_dispatch'}}},videoAdapter={getDefaultVideoConfig:()=>({provider:'fixture',model:'fixture-video'}),normalizeAspectRatioForApi:value=>value,async callVideoApi(db,log,options){adapter.videos.push(options);return {error:'fixture_after_captured_video_dispatch'}}};
 function load(name){if(loaded.has(name))return loaded.get(name);const file=join(backend,'src',name.endsWith('Routes')?'routes':'services',name+'.js'),module=new Module(file);module.filename=file;module.require=key=>{const clean=key.replace(/^\.\.\/services\//,'').replace(/^\.\//,'');return clean==='imageClient'?imageAdapter:clean==='videoClient'?videoAdapter:clean==='aiClient'?{async generateText(){adapter.textCalls++;return 'unexpected implicit polish'}}:Object.hasOwn(owned,clean)?load(clean):key==='../config'||key==='../config/index.js'?{loadConfig:()=>cfg}:createRequire(file)(key)};module._compile(owned[name]===null?nativeSources?.get(file)??readFileSync(file,'utf8'):readFileSync(new URL('../extensions/'+owned[name],import.meta.url),'utf8'),file);loaded.set(name,module.exports);return module.exports;}
 if(legacy)db.exec("INSERT INTO video_generations(id,drama_id,storyboard_id,prompt,model,status) VALUES(10,1,1,'actual old prompt','old model','completed')");
 const inputs=load('museStudioInputs'),studio=load('museStudio'),databaseId=inputs.schema(db,cfg),edit=load('museEditCas');
 const snapshot=(operationId='snapshot-hero')=>inputs.assetVersion(db,cfg,{operationId,projectId:1,assetKind:'character',assetId:1,expectedAsset:edit.snapshot(db,cfg,'character',1)});
 const revision=(version,operationId='save-first-prompt',extra={})=>inputs.saveRevision(db,cfg,1,{operationId,databaseId,expectedSnapshotSha256:inputs.current(db,cfg,1).snapshotSha256,imagePrompt:'image @asset(hero)',videoPrompt:'video @asset(hero)',imageBindings:[{bindingId:'hero',assetKind:'character',assetId:1,versionId:version.versionId}],videoBindings:[{bindingId:'hero',assetKind:'character',assetId:1,versionId:version.versionId}],...extra});
 const runNative=(body,work,path='/videos')=>new Promise((resolve,reject)=>{inputs.middleware(db,cfg)({path,body,get:()=> 'native-original-operation'}, {status(){return this},json(value){reject(Object.assign(Error(value.error.code),value.error))}},()=>{try{resolve(work(body))}catch(error){reject(error)}})});
 async function http(){const express=require('express'),app=express(),router=express.Router();app.use(express.json());load('museStudioRoutes').register(router,db,cfg);app.use('/api/v1',router);const server=createServer(app);servers.push(server);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));return async(path,body)=>{const response=await fetch('http://127.0.0.1:'+server.address().port+'/api/v1/muse/studio'+path,{method:body===undefined?'GET':'POST',headers:{'content-type':'application/json'},...body===undefined?{}:{body:JSON.stringify(body)}});return {status:response.status,value:await response.json()}}}
 return {home,storage,db,cfg,inputs,studio,databaseId,edit,red,blue,snapshot,revision,runNative,http,load,adapter};
}

test('a pending bound version retains authored inputs without claiming an actual adapter dispatch',{skip:!available},async t=>{
 const f=await fixture(t),version=await f.snapshot(),saved=f.revision(version),body={drama_id:1,storyboard_id:1,muse_studio_database_id:f.databaseId,muse_prompt_revision_id:saved.current.revisionId};
 await f.runNative(body,value=>f.db.prepare("INSERT INTO video_generations(id,drama_id,storyboard_id,prompt,model,reference_image_urls,status) VALUES(1,1,1,?,'original-model',?,'processing')").run(value.prompt,JSON.stringify(value.reference_image_urls)));
 writeFileSync(join(f.storage,'hero.png'),f.blue);f.db.prepare("UPDATE characters SET name='New hero',image_url='/studio/static/foreign.png',local_path='foreign.png' WHERE id=1").run();f.db.prepare("UPDATE storyboards SET video_prompt='edited later' WHERE id=1").run();f.db.prepare("UPDATE video_generations SET prompt='mutated historical row' WHERE id=1").run();
 const historical=f.studio.packageTrace(f.db,f.cfg,1).videos.items[0];assert.equal(historical.inputs.prompt,'video @asset(hero)');assert.equal(historical.inputs.state,'partial');assert.equal(historical.inputs.submittedPrompt,null);assert.equal(historical.inputs.bindings[0].displayName,'Hero');assert.equal(historical.inputs.bindings[0].sha256,f.inputs.hash(f.red));assert.equal(f.inputs.chunk(f.db,f.cfg,version.versionId,0).dataBase64,f.red.toString('base64'));assert.equal(f.inputs.current(f.db,f.cfg,1).revisionId,null);assert.ok(!JSON.stringify(historical).includes(f.storage));
});

test('actual native image adapter honors frozen bindings after cloud-prefix normalization and skips implicit paid polishing',{skip:!available},async t=>{
 const f=await fixture(t),version=await f.snapshot(),saved=f.revision(version),prepared=f.inputs.prepare(f.db,f.cfg,1,{databaseId:f.databaseId,revisionId:saved.current.revisionId,kind:'image'}),body={drama_id:1,storyboard_id:1,muse_studio_database_id:f.databaseId,muse_prompt_revision_id:saved.current.revisionId,reference_images:prepared.referenceImageUrls};
 localGenerationReferences(body,'/api/v1/images','https://muse.fixture.test');assert.ok(body.reference_images[0].startsWith('/static/'));
 await f.runNative(body,value=>f.db.prepare("INSERT INTO image_generations(id,drama_id,storyboard_id,prompt,model,reference_images,status) VALUES(41,1,1,?,'fixture-image',?,'pending')").run(value.prompt,JSON.stringify(value.reference_images)),'/images');
 f.db.exec("UPDATE storyboards SET characters='[1]' WHERE id=1;UPDATE characters SET name='Wrong current name',local_path='foreign.png',image_url='/studio/static/foreign.png' WHERE id=1;INSERT INTO ai_service_configs(service_type,provider,name,api_key) VALUES('text','fixture','must not polish','')");const errors=[],log={info(){},warn(){},error(...args){errors.push(args)}};await f.load('imageService').processImageGeneration(f.db,log,41);
 assert.equal(f.adapter.images.length,1,JSON.stringify(errors));assert.equal(f.adapter.textCalls,0);const actual=f.adapter.images[0];assert.equal(actual.prompt,prepared.prompt);assert.ok(!actual.prompt.includes('@asset('));assert.equal(actual.reference_image_urls.length,1);assert.deepEqual(readFileSync(join(f.storage,actual.reference_image_urls[0])),f.red);assert.ok(!actual.system_prompt.includes('Wrong current name'));const history=f.studio.packageTrace(f.db,f.cfg,1).images.items[0];assert.equal(history.inputs.state,'captured');assert.equal(history.inputs.prompt,'image @asset(hero)');assert.equal(history.inputs.submittedPrompt,actual.prompt);assert.equal(history.inputs.bindings[0].displayName,'Hero');assert.equal(history.inputs.references[0].sha256,version.sha256);assert.ok(!JSON.stringify(history).includes(f.storage));
 let called=0;await assert.rejects(f.runNative({...body,frame_type:'quad_grid'},()=>called++,'/images'),{code:'studio_binding_mode_unsupported'});await assert.rejects(f.runNative({...body,reference_images:['https://foreign.invalid'+prepared.referenceImageUrls[0]]},()=>called++,'/images'),{code:'studio_reference_set_changed'});assert.equal(called,0);
});

test('legacy native image dispatch records its final polished prompt and exact resolved image instead of the creation row',{skip:!available},async t=>{
 const f=await fixture(t);f.db.exec("UPDATE storyboards SET polished_prompt='REAL DISPATCH POLISHED CONTENT',characters='[1]' WHERE id=1;INSERT INTO image_generations(id,drama_id,storyboard_id,prompt,model,status) VALUES(42,1,1,'CREATION ONLY','fixture-image','pending')");const errors=[],log={info(){},warn(){},error(...args){errors.push(args)}};await f.load('imageService').processImageGeneration(f.db,log,42);assert.equal(f.adapter.images.length,1,JSON.stringify(errors));const actual=f.adapter.images[0];assert.ok(actual.prompt.includes('REAL DISPATCH POLISHED CONTENT'));assert.notEqual(actual.prompt,'CREATION ONLY');assert.equal(actual.reference_image_urls.length,1);const history=f.studio.packageTrace(f.db,f.cfg,1).images.items[0];assert.equal(history.inputs.submittedPrompt,actual.prompt);assert.equal(history.inputs.prompt,actual.prompt);assert.equal(history.inputs.references[0].sha256,f.inputs.hash(f.red));writeFileSync(join(f.storage,'hero.png'),f.blue);assert.deepEqual(readFileSync(join(f.storage,actual.reference_image_urls[0])),f.red);assert.equal(f.studio.packageTrace(f.db,f.cfg,1).images.items[0].inputs.submittedPrompt,actual.prompt);assert.equal(f.adapter.textCalls,0);
});

test('actual native video adapter receives the revision prompt and locally readable immutable references',{skip:!available},async t=>{
 const f=await fixture(t),version=await f.snapshot(),saved=f.revision(version),prepared=f.inputs.prepare(f.db,f.cfg,1,{databaseId:f.databaseId,revisionId:saved.current.revisionId,kind:'video'}),body={drama_id:1,storyboard_id:1,muse_studio_database_id:f.databaseId,muse_prompt_revision_id:saved.current.revisionId,reference_image_urls:prepared.referenceImageUrls};localGenerationReferences(body,'/api/v1/videos','https://muse.fixture.test');await f.runNative(body,value=>f.db.prepare("INSERT INTO video_generations(id,drama_id,storyboard_id,prompt,model,reference_image_urls,status,duration) VALUES(43,1,1,?,'fixture-video',?,'processing',2)").run(value.prompt,JSON.stringify(value.reference_image_urls)));const errors=[],log={info(){},warn(){},error(...args){errors.push(args)}};await f.load('videoService').processVideoGeneration(f.db,log,43);assert.equal(f.adapter.videos.length,1,JSON.stringify(errors));assert.equal(f.adapter.videos[0].prompt,prepared.prompt);assert.deepEqual(readFileSync(join(f.storage,f.adapter.videos[0].reference_urls[0])),f.red);const history=f.studio.packageTrace(f.db,f.cfg,1).videos.items[0];assert.equal(history.inputs.prompt,'video @asset(hero)');assert.equal(history.inputs.submittedPrompt,prepared.prompt);assert.equal(history.inputs.state,'captured');assert.equal(history.inputs.supplierVerified,false);
});

test('prompt saves use database/CAS guards and immutable receipts without overwriting a later edit',{skip:!available},async t=>{
 const f=await fixture(t),version=await f.snapshot(),before=f.inputs.current(f.db,f.cfg,1),request={operationId:'stable-save-operation',databaseId:f.databaseId,expectedSnapshotSha256:before.snapshotSha256,imagePrompt:'image @asset(hero)',videoPrompt:'video @asset(hero)',imageBindings:[{bindingId:'hero',assetKind:'character',assetId:1,versionId:version.versionId}],videoBindings:[{bindingId:'hero',assetKind:'character',assetId:1,versionId:version.versionId}]};
 assert.throws(()=>f.inputs.saveRevision(f.db,f.cfg,1,{...request,databaseId:randomUUID()}),{code:'studio_database_changed'});const saved=f.inputs.saveRevision(f.db,f.cfg,1,request);f.db.prepare("UPDATE storyboards SET video_prompt='manual newer' WHERE id=1").run();assert.deepEqual(f.inputs.saveRevision(f.db,f.cfg,1,request),saved);assert.equal(f.db.prepare('SELECT video_prompt FROM storyboards WHERE id=1').get().video_prompt,'manual newer');assert.throws(()=>f.inputs.saveRevision(f.db,f.cfg,1,{...request,operationId:'different-save-operation'}),{code:'studio_snapshot_changed'});assert.throws(()=>f.inputs.saveRevision(f.db,f.cfg,1,{...request,videoPrompt:'changed'}),{code:'studio_operation_changed'});assert.deepEqual(f.inputs.getOperation(f.db,f.cfg,request.operationId),{state:'recorded',result:saved});assert.throws(()=>f.db.prepare('DELETE FROM muse_studio_prompt_revisions').run(),/immutable/);
});

test('foreign versions, missing mentions, damaged snapshots and input drift refuse before native dispatch',{skip:!available},async t=>{
 const f=await fixture(t),version=await f.snapshot();assert.throws(()=>f.revision(version,'bad-mention-save',{videoPrompt:'missing token'}),{code:'studio_prompt_tokens_changed'});assert.throws(()=>f.revision(version,'bad-asset-save',{videoBindings:[{bindingId:'hero',assetKind:'character',assetId:2,versionId:version.versionId}]}),{code:'studio_binding_invalid'});const saved=f.revision(version),base={drama_id:1,storyboard_id:1,muse_studio_database_id:f.databaseId,muse_prompt_revision_id:saved.current.revisionId};let dispatched=0;await assert.rejects(f.runNative({...base,prompt:'other'},()=>dispatched++),{code:'studio_prompt_tokens_changed'});await assert.rejects(f.runNative({...base,reference_image_urls:[]},()=>dispatched++),{code:'studio_reference_set_changed'});assert.equal(dispatched,0);
 const path=f.db.prepare('SELECT local_path FROM muse_studio_asset_versions').get().local_path;writeFileSync(join(f.storage,path),f.blue);assert.throws(()=>f.inputs.prepare(f.db,f.cfg,1,{databaseId:f.databaseId,revisionId:saved.current.revisionId,kind:'video'}),{code:'studio_media_changed'});assert.throws(()=>f.inputs.chunk(f.db,f.cfg,version.versionId,0),{code:'studio_media_changed'});
});

test('legacy history remains partial and never borrows current assets or current prompts',{skip:!available},async t=>{
 const f=await fixture(t,{legacy:true});f.db.prepare("UPDATE storyboards SET video_prompt='current fake prompt' WHERE id=1").run();const old=f.studio.packageTrace(f.db,f.cfg,1).videos.items[0];assert.equal(old.inputs.prompt,'actual old prompt');assert.equal(old.inputs.state,'partial');assert.deepEqual(old.inputs.bindings,[]);assert.equal(old.inputs.source,'legacy-record');assert.equal(old.mediaSnapshot.state,'legacy-unverified');
});

test('retired postproduction history reads its stored snapshot without loading the retired provider module',{skip:!available},async t=>{
 const f=await fixture(t,{legacy:true});
 f.db.exec('CREATE TABLE muse_libtv_postproduction_imports(operation_id TEXT PRIMARY KEY,generation_id INTEGER,project_id INTEGER,storyboard_id INTEGER,inputs_json TEXT)');
 assert.equal(f.studio.packageTrace(f.db,f.cfg,1).videos.items[0].inputs.prompt,'actual old prompt');
 const captured={state:'captured',source:'libtv-api-capture',prompt:'Exact retained input',submittedPrompt:'Exact retained input',bindings:[],references:[],model:'retained model',operationId:'retained-operation',requestSha256:'a'.repeat(64),revisionId:null,supplierVerified:false,postproduction:{kind:'erase_subtitles',sourceState:'matched',parentGenerationId:9}};
 f.db.prepare('INSERT INTO muse_libtv_postproduction_imports VALUES(?,?,?,?,?)').run('retained-operation',10,1,1,JSON.stringify(captured));
 const before=JSON.stringify(f.db.prepare('SELECT * FROM muse_libtv_postproduction_imports').all());
 assert.deepEqual(f.studio.packageTrace(f.db,f.cfg,1).videos.items[0].inputs,{...captured,parentGenerationId:null,changeReason:null});
 assert.equal(JSON.stringify(f.db.prepare('SELECT * FROM muse_libtv_postproduction_imports').all()),before);
 f.db.prepare('UPDATE muse_libtv_postproduction_imports SET project_id=2').run();
 assert.equal(f.studio.packageTrace(f.db,f.cfg,1).videos.items[0].inputs.prompt,'actual old prompt');
});

test('root deployment reads old mounted media without rewriting frozen bindings or accepting escaped paths',{skip:!available},async t=>{
 const f=await fixture(t),version=await f.snapshot(),saved=f.revision(version);
 const frozen=f.db.prepare('SELECT * FROM muse_studio_prompt_revisions').all();
 f.db.prepare("UPDATE characters SET local_path='/studio/static/hero.png' WHERE id=1").run();
 f.cfg.storage.base_url='/static';
 assert.equal(f.inputs.mediaUrl({local_path:'/studio/static/hero.png'},'image',f.cfg),'/static/hero.png');
 assert.equal(f.inputs.mediaUrl({video_url:'/studio/static/movies/clip.mp4'},'video',f.cfg),'/static/movies/clip.mp4');
 const prepared=f.inputs.prepare(f.db,f.cfg,1,{databaseId:f.databaseId,revisionId:saved.current.revisionId,kind:'video'});
 assert.equal(prepared.bindings[0].mediaUrl,'/static/'+f.db.prepare('SELECT local_path FROM muse_studio_asset_versions').get().local_path);
 assert.deepEqual(f.inputs.chunk(f.db,f.cfg,version.versionId,0).dataBase64,f.red.toString('base64'));
 assert.equal(f.inputs.current(f.db,f.cfg,1).videoBindings[0].mediaUrl,version.mediaUrl);
 assert.deepEqual(f.db.prepare('SELECT * FROM muse_studio_prompt_revisions').all(),frozen);
 assert.equal(f.inputs.localPath('https://provider.example/static/hero.png'),null);
 for(const bad of ['/studio/static/../outside.png','/studio/static/%2e%2e/outside.png','/studio/static/C:/outside.png','/studio/static//outside.png'])assert.throws(()=>f.inputs.localPath(bad),{code:'studio_media_unavailable'});
});

test('reused output paths never invent which historical prompt version was adopted',{skip:!available},async t=>{
 const f=await fixture(t);f.db.exec("INSERT INTO video_generations(id,drama_id,storyboard_id,prompt,status,local_path,video_url) VALUES(30,1,1,'first distinct prompt','completed','shared.mp4','/studio/static/shared.mp4'),(31,1,1,'second distinct prompt','completed','shared.mp4','/studio/static/shared.mp4');UPDATE storyboards SET video_url='/studio/static/shared.mp4' WHERE id=1");const rows=f.studio.packageTrace(f.db,f.cfg,1).videos.items;assert.equal(rows.filter(row=>row.adopted).length,0);assert.deepEqual(rows.map(row=>row.inputs.prompt),['second distinct prompt','first distinct prompt']);
});

test('completed output bytes remain immutable and adoption refuses a changed original file',{skip:!available},async t=>{
 const f=await fixture(t);f.db.prepare("INSERT INTO image_generations(id,drama_id,storyboard_id,prompt,model,status,local_path,image_url) VALUES(8,1,1,'original output','model','completed','hero.png','/studio/static/hero.png')").run();const first=f.studio.packageTrace(f.db,f.cfg,1).images.items[0];assert.equal(first.mediaSnapshot.state,'captured');assert.equal(first.mediaSnapshot.sha256,f.inputs.hash(f.red));writeFileSync(join(f.storage,'hero.png'),f.blue);const later=f.studio.packageTrace(f.db,f.cfg,1).images.items[0];assert.equal(later.mediaUrl,first.mediaUrl);assert.equal(later.mediaSnapshot.sha256,first.mediaSnapshot.sha256);const archived=JSON.parse(f.db.prepare('SELECT snapshot_json FROM muse_studio_media_versions WHERE generation_id=8').get().snapshot_json);assert.deepEqual(readFileSync(join(f.storage,archived.localPath)),f.red);
 assert.throws(()=>f.studio.adopt(f.db,f.cfg,1,{operationId:'adopt-damaged-original',databaseId:f.databaseId,expectedSnapshotSha256:f.inputs.current(f.db,f.cfg,1).snapshotSha256,kind:'image',generationId:8}),{code:'studio_media_changed'});
});

test('an exact storyboard image becomes a frozen keyframe binding and preparation renders ordered ordinary labels',{skip:!available},async t=>{
 const f=await fixture(t);f.db.prepare("INSERT INTO image_generations(id,drama_id,storyboard_id,prompt,status,local_path,image_url) VALUES(9,1,1,'keyframe','completed','hero.png','/studio/static/hero.png')").run();const version=await f.inputs.assetVersion(f.db,f.cfg,{operationId:'snapshot-exact-keyframe',projectId:1,assetKind:'storyboard',assetId:1,generationId:9,expectedAsset:f.edit.snapshot(f.db,f.cfg,'storyboard',1)});assert.equal(version.assetKind,'storyboard');assert.equal(version.generationId,9);assert.equal(version.sha256,f.inputs.hash(f.red));const binding={bindingId:'keyframe',assetKind:'storyboard',assetId:1,versionId:version.versionId},saved=f.inputs.saveRevision(f.db,f.cfg,1,{operationId:'save-keyframe-reference',databaseId:f.databaseId,expectedSnapshotSha256:f.inputs.current(f.db,f.cfg,1).snapshotSha256,imagePrompt:'image @asset(keyframe)',videoPrompt:'video @asset(keyframe)',imageBindings:[binding],videoBindings:[binding]}),prepared=f.inputs.prepare(f.db,f.cfg,1,{databaseId:f.databaseId,revisionId:saved.current.revisionId,kind:'video'});assert.equal(prepared.authoredPrompt,'video @asset(keyframe)');assert.equal(prepared.prompt,'video 参考图1（storyboard）');assert.equal(prepared.bindings[0].referenceToken,'@asset(keyframe)');assert.deepEqual(prepared.referenceSha256s,[version.sha256]);assert.ok(!prepared.prompt.includes('@asset('));await assert.rejects(f.inputs.assetVersion(f.db,f.cfg,{operationId:'foreign-keyframe-reference',projectId:2,assetKind:'storyboard',assetId:2,generationId:9,expectedAsset:f.edit.snapshot(f.db,f.cfg,'storyboard',2)}),{code:'studio_generation_unavailable'});
});


async function advancedTraceFixture(t){
 const f=await fixture(t),hero=await f.snapshot();
 f.db.exec("INSERT INTO characters(id,drama_id,name,image_url,local_path) VALUES(3,1,'Companion','/studio/static/foreign.png','foreign.png')");
 const companion=await f.inputs.assetVersion(f.db,f.cfg,{operationId:'snapshot-companion',projectId:1,assetKind:'character',assetId:3,expectedAsset:f.edit.snapshot(f.db,f.cfg,'character',3)});
 const bindings=[{bindingId:'hero',assetKind:'character',assetId:1,versionId:hero.versionId},{bindingId:'companion',assetKind:'character',assetId:3,versionId:companion.versionId}];
 const saved=f.inputs.saveRevision(f.db,f.cfg,1,{operationId:'save-two-source-bindings',databaseId:f.databaseId,expectedSnapshotSha256:f.inputs.current(f.db,f.cfg,1).snapshotSha256,imagePrompt:'image @asset(hero)',videoPrompt:'Original @asset(hero) with @asset(companion)',imageBindings:[bindings[0]],videoBindings:bindings});
 const prepared=f.inputs.prepare(f.db,f.cfg,1,{databaseId:f.databaseId,revisionId:saved.current.revisionId,kind:'video'});
 const sourceUrl='https://media.example.test/original.mp4',hdUrl='https://media.example.test/hd.mp4',canvas='ad6b4ad840fb40beb64b476d1988a72f',owner='a'.repeat(64);
 const sourceNode={nodeKey:'original-node',status:2,data:{type:'video',url:[sourceUrl],params:{prompt:prepared.prompt}}};
 f.db.exec('CREATE TABLE muse_libtv_cli_operations(operation_id TEXT PRIMARY KEY,prompt TEXT,model TEXT,request_sha256 TEXT,project_id INTEGER,project_uuid TEXT,owner_sha256 TEXT,node_id TEXT,service TEXT,state TEXT,result_json TEXT);CREATE TABLE muse_libtv_cli_inputs(operation_id TEXT PRIMARY KEY,capture_json TEXT);CREATE TABLE muse_libtv_cli_imports(kind TEXT,generation_id INTEGER,source_operation_id TEXT,receipt_json TEXT)');
 function operation(id,{capture,result,model='Wan 3.0',projectId=1,projectUuid=canvas,ownerHash=owner,service='video'}={}){
  f.db.prepare('INSERT INTO muse_libtv_cli_operations VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(id,model==='Wan 3.0'?prepared.prompt:'',model,f.inputs.digest({id}),projectId,projectUuid,ownerHash,capture.node.nodeKey,service,'completed',JSON.stringify(result));
  f.db.prepare('INSERT INTO muse_libtv_cli_inputs VALUES(?,?)').run(id,JSON.stringify(capture));
 }
 function imported(id,generationId,url,index=0){
  f.db.prepare("INSERT INTO video_generations(id,drama_id,storyboard_id,prompt,model,status) VALUES(?,1,1,'row prompt must not replace source','row model','completed')").run(generationId);
  f.db.prepare('INSERT INTO muse_libtv_cli_imports VALUES(?,?,?,?)').run('video',generationId,id,JSON.stringify({result_id:'cli-result-'+index+'-'+f.inputs.digest({url})}));
 }
 const sourceCapture={protocol:'libtv-cli-input-v1',node:sourceNode,references:{nodes:[]}};
 operation('original-cli-video',{capture:sourceCapture,result:sourceNode});imported('original-cli-video',51,sourceUrl);
 f.db.prepare('INSERT INTO muse_studio_cli_inputs VALUES(?,?)').run('original-cli-video',JSON.stringify({...prepared,operationId:'original-cli-video'}));
 const capture={protocol:'libtv-cli-advanced-input-v1',command_kind:'video_hd',spec:{kind:'video_hd',project_uuid:canvas,node_id:'original-node',model_name:'Topazlabs'},node:{...sourceNode,data:{...sourceNode.data,params:{prompt:'edited after generation'}}}};
 const hdNode={nodeKey:'hd-node',status:2,url:[hdUrl]};
 operation('derived-cli-hd',{capture,result:{records:[hdNode],media_outputs:[{nodeKey:hdNode.nodeKey,kind:'video',url:hdUrl,node:hdNode,nodeSha256:f.inputs.digest(hdNode),outputIndex:0}]},model:'advanced:video_hd',service:'agent-task'});imported('derived-cli-hd',52,hdUrl);
 const history=()=>JSON.stringify(['muse_libtv_cli_operations','muse_libtv_cli_inputs','muse_libtv_cli_imports','muse_studio_cli_inputs','muse_studio_generation_inputs'].map(table=>f.db.prepare('SELECT * FROM '+table).all()));
 return {...f,hero,companion,prepared,sourceNode,sourceCapture,sourceUrl,hdNode,hdUrl,canvas,owner,operation,imported,history};
}

test('HD history inherits the exact original prompt and two asset bindings without rewriting either history',{skip:!available},async t=>{
 const f=await advancedTraceFixture(t),before=f.history();
 f.db.exec("UPDATE storyboards SET video_prompt='current unrelated prompt' WHERE id=1;UPDATE characters SET name='changed current asset',image_url='/studio/static/foreign.png',local_path='foreign.png' WHERE id=1");
 const all=f.studio.packageTrace(f.db,f.cfg,1).videos.items,hd=all.find(row=>row.generationId===52).inputs,original=all.find(row=>row.generationId===51).inputs;
 assert.equal(hd.state,'captured');assert.equal(hd.source,'cli-advanced-capture');assert.equal(hd.model,'advanced:video_hd');assert.equal(hd.operationId,'derived-cli-hd');
 assert.equal(hd.prompt,'Original @asset(hero) with @asset(companion)');assert.equal(hd.submittedPrompt,f.prepared.prompt);assert.deepEqual(hd.bindings.map(row=>row.versionId),[f.hero.versionId,f.companion.versionId]);assert.deepEqual(hd.references.map(row=>row.sha256),[f.hero.sha256,f.companion.sha256]);
 assert.deepEqual(hd.postproduction,{kind:'video_hd',parameters:{kind:'video_hd',project_uuid:f.canvas,node_id:'original-node',model_name:'Topazlabs'},sourceState:'matched',sourceOperationId:'original-cli-video',parentGenerationId:51,sourceNodeId:'original-node',sourceUrl:f.sourceUrl,sourceModel:'Wan 3.0',parent:null});
 assert.equal(original.source,'cli-capture');assert.equal(original.model,'Wan 3.0');assert.equal(f.history(),before);assert.ok(!JSON.stringify(hd).includes('changed current asset'));
});

test('advanced source matching rejects ambiguous operations and never borrows a current prompt or asset',{skip:!available},async t=>{
 const f=await advancedTraceFixture(t);
 f.operation('different-cli-original',{capture:f.sourceCapture,result:f.sourceNode});
 const before=f.history(),hd=f.studio.packageTrace(f.db,f.cfg,1).videos.items.find(row=>row.generationId===52).inputs;
 assert.equal(hd.state,'partial');assert.equal(hd.postproduction.sourceState,'ambiguous_source_result');assert.equal(hd.postproduction.sourceOperationId,null);assert.equal(hd.prompt,null);assert.equal(hd.submittedPrompt,null);assert.deepEqual(hd.bindings,[]);assert.equal(f.history(),before);
});

test('source matching excludes other projects, canvas identities and CLI owners and keeps missing imports partial',{skip:!available},async t=>{
 const f=await advancedTraceFixture(t);
 for(const [id,scope]of [['foreign-project',{projectId:2}],['foreign-canvas',{projectUuid:'b'.repeat(32)}],['foreign-owner',{ownerHash:'b'.repeat(64)}]])f.operation(id,{capture:f.sourceCapture,result:f.sourceNode,...scope});
 let hd=f.studio.packageTrace(f.db,f.cfg,1).videos.items.find(row=>row.generationId===52).inputs;
 assert.equal(hd.state,'captured');assert.equal(hd.postproduction.sourceOperationId,'original-cli-video');
 const missingUrl='https://media.example.test/unimported.mp4',missingNode={nodeKey:'unimported-source',data:{type:'video',url:[missingUrl]}};
 f.operation('unimported-original',{capture:{protocol:'libtv-cli-input-v1',node:missingNode},result:missingNode});
 f.operation('unimported-derivative',{capture:{protocol:'libtv-cli-advanced-input-v1',command_kind:'video_hd',spec:{kind:'video_hd'},node:missingNode},result:{nodeKey:'unimported-output',url:['https://media.example.test/output.mp4']},model:'advanced:video_hd',service:'agent-task'});f.imported('unimported-derivative',59,'https://media.example.test/output.mp4');
 hd=f.studio.packageTrace(f.db,f.cfg,1).videos.items.find(row=>row.generationId===59).inputs;
 assert.equal(hd.state,'partial');assert.equal(hd.postproduction.sourceState,'source_import_unmatched');assert.equal(hd.postproduction.parentGenerationId,null);
});

test('postproduction follows exact nested video outputs and reports a cyclic source as partial',{skip:!available},async t=>{
 const f=await advancedTraceFixture(t),finalUrl='https://media.example.test/final.mp4';
 f.operation('derived-cli-final',{capture:{protocol:'libtv-cli-advanced-input-v1',command_kind:'video_final',spec:{kind:'video_final',project_uuid:f.canvas,node_id:'hd-node'},node:f.hdNode},result:{nodeKey:'final-node',url:[finalUrl]},model:'advanced:video_final',service:'agent-task'});f.imported('derived-cli-final',53,finalUrl);
 const final=f.studio.packageTrace(f.db,f.cfg,1).videos.items.find(row=>row.generationId===53).inputs;
 assert.equal(final.state,'captured');assert.equal(final.postproduction.parentGenerationId,52);assert.equal(final.postproduction.parent.sourceOperationId,'original-cli-video');assert.equal(final.bindings.length,2);
 const cycleUrl='https://media.example.test/cycle.mp4';
 f.operation('cycle-cli-first',{capture:{protocol:'libtv-cli-advanced-input-v1',command_kind:'video_hd',spec:{kind:'video_hd'},node:{nodeKey:'cycle-b',url:[cycleUrl]}},result:{nodeKey:'cycle-a',url:[cycleUrl]},model:'advanced:video_hd',service:'agent-task'});f.imported('cycle-cli-first',54,cycleUrl);
 f.operation('cycle-cli-second',{capture:{protocol:'libtv-cli-advanced-input-v1',command_kind:'video_hd',spec:{kind:'video_hd'},node:{nodeKey:'cycle-a',url:[cycleUrl]}},result:{nodeKey:'cycle-b',url:[cycleUrl]},model:'advanced:video_hd',service:'agent-task'});f.imported('cycle-cli-second',55,cycleUrl);
 const cycle=f.studio.packageTrace(f.db,f.cfg,1).videos.items.find(row=>row.generationId===55).inputs;assert.equal(cycle.state,'partial');assert.equal(cycle.postproduction.sourceState,'source_chain_cycle');assert.deepEqual(cycle.bindings,[]);
});

test('HTTP endpoints return exact operation results, bounded verified chunks and package-scoped pagination',{skip:!available},async t=>{
 const f=await fixture(t),api=await f.http(),version=await f.snapshot(),caps=(await api('/capabilities')).value.data;assert.equal(caps.chunkBytes,524288);assert.equal(caps.boundPromptVersion,1);const body=(await api('/assets/versions/'+version.versionId+'/chunks?index=0')).value.data;assert.equal(body.chunkSha256,version.sha256);assert.equal(body.totalChunks,1);assert.equal((await api('/assets/versions/'+version.versionId+'/chunks?index=1')).status,400);assert.deepEqual((await api('/operations/unknown-operation')).value.data,{state:'missing',result:null});
 f.db.exec("INSERT INTO video_generations(id,drama_id,storyboard_id,prompt,status) VALUES(20,1,1,'one','completed'),(21,1,1,'two','completed')");const page=(await api('/packages/1?limit=1')).value.data;assert.equal(page.videos.items[0].generationId,21);assert.ok(page.videos.nextCursor);assert.equal((await api('/packages/1?limit=1&videoCursor='+encodeURIComponent(page.videos.nextCursor))).value.data.videos.items[0].generationId,20);assert.equal((await api('/packages/2?videoCursor='+encodeURIComponent(page.videos.nextCursor))).status,400);
});

test('planner installs evidence before admission and refuses repeated patches',{skip:!available},t=>{
 const uninstalled=mkdtempSync(join(tmpdir(),'muse-studio-planner-'));t.after(()=>rmSync(uninstalled,{recursive:true,force:true}));
 const original=new Map([[resolve(uninstalled,'backend-node/src/routes/index.js'),'function setupRouter(){\n  const r = express.Router();\n  return r;\n}']]);const planned=planMuseStudio(uninstalled,path=>original.get(path));assert.equal(planned.length,4);assert.match(planned.find(([path])=>path.replaceAll('\\','/').endsWith('routes/index.js'))[1],/museStudioRoutes/);assert.ok(planned.every(([path])=>!path.includes('LibTv')));
 const staged=new Map(planned);assert.throws(()=>planMuseStudio(uninstalled,path=>staged.get(path)??original.get(path)),/differs|requires/);
});

test('dispatch and lineage upgrades preserve original revisions and leave their missing parent unknown',{skip:!available},async t=>{
 const f=await fixture(t),version=await f.snapshot(),saved=f.revision(version),columns='revision_id,project_id,package_id,image_prompt,video_prompt,image_bindings_json,video_bindings_json,created_at';
 const before=f.db.prepare('SELECT '+columns+' FROM muse_studio_prompt_revisions').all();
 f.db.exec('ALTER TABLE muse_studio_prompt_revisions DROP COLUMN parent_generation_id;ALTER TABLE muse_studio_prompt_revisions DROP COLUMN change_reason;DROP TABLE muse_studio_native_dispatches;UPDATE muse_studio_schema SET version=1');
 assert.equal(f.inputs.schema(f.db,f.cfg),f.databaseId);assert.equal(f.db.prepare('SELECT version FROM muse_studio_schema').get().version,3);
 assert.equal(f.inputs.current(f.db,f.cfg,1).revisionId,saved.current.revisionId);assert.equal(f.inputs.current(f.db,f.cfg,1).parentGenerationId,null);assert.equal(f.inputs.current(f.db,f.cfg,1).changeReason,null);
 assert.deepEqual(f.db.prepare('SELECT '+columns+' FROM muse_studio_prompt_revisions').all(),before);assert.equal(f.inputs.chunk(f.db,f.cfg,version.versionId,0).sha256,version.sha256);
 f.db.prepare('UPDATE muse_studio_schema SET version=4').run();assert.throws(()=>f.inputs.schema(f.db,f.cfg),{code:'studio_unsupported_schema'});
});

test('repair revisions bind one exact same-package video and preserve original inputs, receipts and trace',{skip:!available},async t=>{
 const f=await fixture(t),version=await f.snapshot(),original=f.revision(version);
 f.db.exec("INSERT INTO storyboards(id,episode_id,storyboard_number) VALUES(3,1,2);INSERT INTO video_generations(id,drama_id,storyboard_id,prompt,status) VALUES(71,1,1,'original attempted prompt','failed'),(72,2,2,'foreign','completed'),(73,1,3,'other package','completed'),(74,1,1,'archived','completed');UPDATE video_generations SET deleted_at='2026-01-01' WHERE id=74");
 const originals=f.db.prepare('SELECT * FROM video_generations ORDER BY id').all(),revisionBefore=f.db.prepare('SELECT * FROM muse_studio_prompt_revisions').all(),body={operationId:'repair-derived-revision',databaseId:f.databaseId,expectedSnapshotSha256:f.inputs.current(f.db,f.cfg,1).snapshotSha256,imagePrompt:'',videoPrompt:'Repaired @asset(hero)',imageBindings:[],videoBindings:[{bindingId:'hero',assetKind:'character',assetId:1,versionId:version.versionId}]};
 for(const invalid of [{parentGenerationId:71},{changeReason:'Fix pose'},{parentGenerationId:71,changeReason:' '},{parentGenerationId:72,changeReason:'Foreign'},{parentGenerationId:73,changeReason:'Other package'},{parentGenerationId:74,changeReason:'Archived'}])assert.throws(()=>f.inputs.saveRevision(f.db,f.cfg,1,{...body,...invalid}),error=>['studio_lineage_invalid','studio_lineage_parent_unavailable'].includes(error.code));
 assert.deepEqual(f.db.prepare('SELECT * FROM muse_studio_prompt_revisions').all(),revisionBefore);
 const input={...body,parentGenerationId:71,changeReason:'Repair the source-backed pose'},saved=f.inputs.saveRevision(f.db,f.cfg,1,input);
 assert.equal(saved.current.parentGenerationId,71);assert.equal(saved.current.changeReason,input.changeReason);assert.notEqual(saved.current.revisionId,original.current.revisionId);
 assert.deepEqual(f.inputs.saveRevision(f.db,f.cfg,1,input),saved);assert.throws(()=>f.inputs.saveRevision(f.db,f.cfg,1,{...input,changeReason:'Different reason'}),{code:'studio_operation_changed'});
 assert.throws(()=>f.inputs.saveRevision(f.db,f.cfg,1,{...input,operationId:'stale-repair-attempt'}),{code:'studio_snapshot_changed'});
 const prepared=f.inputs.prepare(f.db,f.cfg,1,{databaseId:f.databaseId,revisionId:saved.current.revisionId,kind:'video'});assert.equal(prepared.parentGenerationId,71);assert.equal(prepared.changeReason,input.changeReason);
 await f.runNative({drama_id:1,storyboard_id:1,muse_studio_database_id:f.databaseId,muse_prompt_revision_id:saved.current.revisionId},value=>f.db.prepare("INSERT INTO video_generations(id,drama_id,storyboard_id,prompt,status) VALUES(75,1,1,?,'processing')").run(value.prompt));
 f.revision(version,'newer-unrelated-revision',{videoPrompt:'Later @asset(hero)'});
 const derived=f.studio.packageTrace(f.db,f.cfg,1).videos.items.find(row=>row.generationId===75);assert.equal(derived.inputs.parentGenerationId,71);assert.equal(derived.inputs.changeReason,input.changeReason);assert.equal(derived.inputs.prompt,'Repaired @asset(hero)');
 assert.deepEqual(f.db.prepare('SELECT * FROM video_generations WHERE id<75 ORDER BY id').all(),originals);assert.deepEqual(f.db.prepare('SELECT * FROM muse_studio_prompt_revisions WHERE revision_id=?').get(original.current.revisionId),revisionBefore[0]);
 const archive=new Module(join(backend,'src/services/museProjectArchiveContent.js'));archive.filename=join(backend,'src/services/museProjectArchiveContent.js');archive.require=name=>name==='./museStudio'?f.studio:require(name);archive._compile(readFileSync(new URL('../extensions/muse-project-archive-content.cjs',import.meta.url),'utf8'),archive.filename);
 const archived=archive.exports.select(f.db,f.cfg,1,{max_rows:10000}).tables.muse_studio_prompt_revisions.find(row=>row.revision_id===saved.current.revisionId);assert.equal(archived.parent_generation_id,71);assert.equal(archived.change_reason,input.changeReason);
});

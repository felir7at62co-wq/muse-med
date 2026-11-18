/** Standalone generation disabling preserves data management without contacting a supplier. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {existsSync,readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {resolve,relative,sep} from 'node:path';
import {compileFunction} from 'node:vm';
import {museAdmissionRoutes} from '../compatibility/muse-admission.mjs';
import {planMuseGeneration} from '../compatibility/muse-generation.mjs';

const root=resolve(process.env.LOCALMINIDRAMA_SOURCE||'.local/localminidrama');
const source=readFileSync(new URL('../extensions/muse-generation.cjs',import.meta.url),'utf8');
const module={exports:{}};
compileFunction(source,['require','module','exports','process'])(name=>{assert.equal(name,'./museAdmissionCatalog.json');return museAdmissionRoutes;},module,module.exports,{env:{}});
const generation=module.exports;
const request=(path,body={})=>({method:'POST',path,body});
const stagedModules={museAdmission:'muse-admission',museAudioService:'muse-audio',musePostproduction:'muse-postproduction',museBudget:'muse-budget'};
const pristine=path=>{
 const module=Object.entries(stagedModules).find(([name])=>path===resolve(root,'backend-node/src/services',name+'.js'));
 return module?readFileSync(new URL('../extensions/'+module[1]+'.cjs',import.meta.url),'utf8')
  :execFileSync('git',['-C',root,'show','3fbcda9713ca545979dff9e75d21bed53694188f:'+relative(root,path).split(sep).join('/')],{encoding:'utf8',maxBuffer:3e6});
};

test('an explicit disabled backend and the standalone environment refuse generation',()=>{
 assert.equal(generation.enabled({}),true);
 assert.equal(generation.enabled({muse_generation:{enabled:false}},{}),false);
 assert.equal(generation.enabled({muse_generation:{enabled:true}},{MUSE_STANDALONE_NO_AI:'1'}),false);
 assert.throws(()=>generation.enabled({muse_generation:{enabled:'false'}},{}),/boolean/);
 assert.throws(()=>generation.enabled({},{MUSE_STANDALONE_NO_AI:'yes'}),/0 or 1/);
 assert.throws(()=>generation.assertEnabled({muse_generation:{enabled:false}}),{code:'generation_backend_not_configured',status:503});
});

test('all configured supplier operations are rejected before any route handler',()=>{
 const paths=['/images','/videos','/characters/batch-generate-images','/characters/1/generate-image',
  '/characters/1/generate-four-view-image','/characters/1/generate-prompt','/characters/1/extract-from-image',
  '/characters/1/extract-anchors','/props/1/generate','/props/1/generate-prompt','/props/1/extract-from-image',
  '/scenes/generate-image','/scenes/1/generate-four-view-image','/scenes/1/generate-prompt','/scenes/1/extract-from-image',
  '/generation/characters','/generation/story','/episodes/1/storyboards','/episodes/1/props/extract',
  '/images/episode/1/backgrounds/extract','/extract-description-from-image','/storyboards/1/frame-prompt',
  '/storyboards/1/polish-prompt','/storyboards/1/universal-segment-prompt','/storyboards/1/regenerate-layout-description',
  '/storyboards/1/universal-segment-polish-stream','/storyboards/1/classic-video-prompt-polish-stream',
  '/storyboards/1/universal-segment-prompt-stream','/ai-configs/test','/ai-configs/jimeng2-list-assets',
  '/characters/1/sd2-certify','/characters/1/sd2-voice-upload','/images/episode/1/batch','/images/scene/1',
  '/videos/image/1','/videos/episode/1/batch','/videos/1/resume-poll','/images/1/resume-download',
  '/audio/extract','/audio/extract/batch','/agent/chat','/agent/approve','/muse/audio/tts','/muse/audio/tts/1/recover',
  '/muse/postproduction/tasks','/muse/postproduction/tasks/1/continue','/muse/postproduction/tasks/1/refresh',
  '/muse/jubian/submit','/storyboards/batch-infer-params','/storyboards/1/upscale'];
 let middleware,continued=0,reply;
 generation.register({get(){},use(value){middleware=value;}},{muse_generation:{enabled:false}});
 const response={status(code){reply={code};return this;},json(body){reply.body=body;return this;}};
 for(const path of paths){reply=null;middleware(request(path),response,()=>continued++);assert.equal(reply.code,503,path);assert.equal(reply.body.error.code,'generation_backend_not_configured',path);}
 assert.equal(continued,0);
 assert.equal(generation.blocks(request('/dramas/import-novel',{ai_summarize:true})),true);
 reply=null;middleware(request('/dramas/import-novel',{ai_summarize:'true'}),response,()=>continued++);
 assert.equal(reply.code,503);assert.equal(continued,0);
 assert.equal(generation.blocks({method:'GET',path:'/muse/jubian/catalog'}),true);
 assert.equal(generation.blocks({method:'GET',path:'/storyboards/episode/1/generate'}),true);
});

test('project, asset, revision, history and import operations remain available',()=>{
 for(const path of ['/dramas','/assets','/storyboards','/upload/image','/images/upload','/characters/1/upload-image',
  '/assets/import/image/1','/assets/import/video/1','/muse/studio/packages/1/revisions',
  '/muse/studio/assets/versions','/muse/revisions/restore','/episodes/1/finalize'])assert.equal(generation.blocks(request(path)),false,path);
 assert.equal(generation.blocks(request('/dramas/import-novel',{ai_summarize:false})),false);
 for(const path of ['/dramas/1','/images/1','/videos/1','/tasks/task-1','/muse/studio/packages/1',
  '/muse/audio/tts/1','/muse/postproduction/tasks/1'])assert.equal(generation.blocks({method:'GET',path}),false,path);
 let next=0;
 generation.register({get(){},use(fn){fn(request('/videos'),{},()=>next++);}},{muse_generation:{enabled:true}});
 assert.equal(next,1);
});

test('the pinned application suppresses startup recovery and guards direct supplier clients',{skip:!existsSync(resolve(root,'.git'))},()=>{
 const entries=new Map(planMuseGeneration(root,pristine));
 const app=entries.get(resolve(root,'backend-node/src/app.js'));
 assert.match(app,/if \(generationEnabled\) taskService.failOrphanedAsyncTasksOnStartup/);
 assert.match(app,/if \(generationEnabled\) applyVendorLock/);
 assert.match(app,/if \(generationEnabled\) resumeProcessingVideoGenerations/);
 assert.match(app,/generationBackend: generationEnabled \? 'configured' : 'unconfigured'/);
 assert.match(entries.get(resolve(root,'backend-node/src/server.js')),/museGeneration'\).enabled\(config\)\) \{\s+const \{ initAgent \}/);
 for(const file of ['aiClient.js','imageClient.js','videoClient.js'])assert.match(entries.get(resolve(root,'backend-node/src/services',file)),/museGeneration'\).assertEnabled/);
 const router=entries.get(resolve(root,'backend-node/src/routes/index.js'));
 assert.ok(router.indexOf("museGeneration').register")<router.indexOf("r.post('/dramas'"));
 assert.match(router,/importUpload.single\('file'\), museGeneration,/);
 assert.throws(()=>planMuseGeneration(root,path=>entries.get(path)??pristine(path)),/pinned source|already exists/);
});

test('opening retained generation history leaves in-flight states and timestamps intact',{skip:!existsSync(resolve(root,'backend-node/node_modules/better-sqlite3/package.json'))},()=>{
 const require=createRequire(resolve(root,'backend-node/package.json')),Database=require('better-sqlite3');
 const entries=new Map(planMuseGeneration(root,pristine));
 const cases=[
  {name:'museAdmission',ddl:"CREATE TABLE muse_admission_schema(version INTEGER,database_id TEXT);INSERT INTO muse_admission_schema VALUES(1,'history');CREATE TABLE muse_native_operations(state TEXT,error_code TEXT,updated_at TEXT);INSERT INTO muse_native_operations VALUES('reserved',NULL,'retained');",query:'SELECT * FROM muse_native_operations'},
  {name:'museAudioService',ddl:"CREATE TABLE muse_audio_schema(version INTEGER,database_id TEXT);INSERT INTO muse_audio_schema VALUES(2,'history');CREATE TABLE muse_tts_generations(state TEXT,error_code TEXT);INSERT INTO muse_tts_generations VALUES('generating',NULL);",query:'SELECT * FROM muse_tts_generations'},
  {name:'musePostproduction',ddl:"CREATE TABLE muse_postproduction_schema(version INTEGER,database_id TEXT);INSERT INTO muse_postproduction_schema VALUES(1,'history');CREATE TABLE muse_postproduction_segments(state TEXT,error_code TEXT);INSERT INTO muse_postproduction_segments VALUES('submitting',NULL),('uploading',NULL);",query:'SELECT * FROM muse_postproduction_segments'},
  {name:'museBudget',ddl:"CREATE TABLE muse_budget_schema(version INTEGER,database_id TEXT);INSERT INTO muse_budget_schema VALUES(2,'history');CREATE TABLE muse_budget_entries(outcome TEXT,revision INTEGER,updated_at TEXT,settled_minor INTEGER,source TEXT,profile_json TEXT);INSERT INTO muse_budget_entries VALUES('reserved',7,'retained',NULL,'native','{\"currency\":\"CNY\",\"provider\":\"old-provider\"}');",query:'SELECT * FROM muse_budget_entries'},
 ];
 for(const fixture of cases)for(const active of [false,true]){
  const db=new Database(':memory:'),statements=[];
  const prepare=db.prepare.bind(db);db.prepare=sql=>{const statement=prepare(sql);statements.push(statement);return statement;};
  try{
   db.exec(fixture.ddl);const before=db.prepare(fixture.query).all();
   const owner={exports:{}},value=entries.get(resolve(root,'backend-node/src/services',fixture.name+'.js'));
   compileFunction(value,['require','module','exports'])(name=>name==='./museGeneration'?{enabled:()=>active,backgroundEnabled:()=>active}:name==='./museAdmissionCatalog.json'?museAdmissionRoutes:name.startsWith('./')?{}:require(name),owner,owner.exports);
   owner.exports.schema(db,{muse_generation:{enabled:active}});
   const after=db.prepare(fixture.query).all();
   if(active)assert.notDeepEqual(after,before,fixture.name);else assert.deepEqual(after,before,fixture.name);
  }finally{db.close();}
 }
});

test('reading admission and budget history cannot reconcile retained rows in disabled mode',{skip:!existsSync(resolve(root,'.git'))},()=>{
 const require=createRequire(import.meta.url),entries=new Map(planMuseGeneration(root,pristine));
 for(const[name,method]of [['museAdmission','refreshed'],['museBudget','refresh']]){
  const owner={exports:{}},value=entries.get(resolve(root,'backend-node/src/services',name+'.js'));
  compileFunction(value+'\nmodule.exports.readRetained='+method+';',['require','module','exports'])(name=>name==='./museGeneration'?{enabled:()=>false,backgroundEnabled:()=>false}:name==='./museAdmissionCatalog.json'?museAdmissionRoutes:require(name),owner,owner.exports);
  const row={state:'accepted',outcome:'accepted',revision:7};
  const db={prepare(){assert.fail('A history read must not query or update recovery state');}};
  assert.equal(name==='museAdmission'?owner.exports.readRetained(db,row):owner.exports.readRetained(db,{muse_generation:{enabled:false}},row),row);
 }
});

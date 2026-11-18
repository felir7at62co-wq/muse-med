/** Deployed postproduction budget guards with real SQLite and zero-network media/provider fixtures. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,writeFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,relative,resolve} from 'node:path';
import {createRequire} from 'node:module';
import {compileFunction} from 'node:vm';
import {createHash} from 'node:crypto';
import {planMuseBudget} from '../compatibility/muse-budget.mjs';

const require=createRequire(import.meta.url),sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const source=name=>readFileSync(new URL('../extensions/'+name,import.meta.url),'utf8');
function finalSources(){
 if(process.env.MUSE_POSTPRODUCTION_BUDGET_FIXTURE)return JSON.parse(readFileSync(process.env.MUSE_POSTPRODUCTION_BUDGET_FIXTURE,'utf8'));
 const root=mkdtempSync(join(tmpdir(),'muse-post-budget-plan-'));
 // Unrelated planner edits use only their anchors; postproduction and budget use their complete owned source.
 const other={
  'backend-node/src/routes/index.js':"  const museAdmission = require('../services/museAdmission').register(r, db, cfg);",
  'backend-node/src/services/imageClient.js':'  const model = getModelFromConfig(config, preferredModel);',
  'backend-node/src/services/videoClient.js':'  const model = normalizeVolcModel(getModelFromConfig(config, preferredModel), config);',
  'backend-node/src/services/aiClient.js':Array(3).fill("require('./museAdmission').startSupplierCall();").join('\n')+'\n'+Array(2).fill('  const model = getModelFromConfig(config, effectivePreferredModel);').join('\n')+'\n  const model = getModelFromConfig(config, preferredModel);',
  'backend-node/src/services/aiConfigService.js':"async function testConnection(opts) {\n  const response = await fetch(url, {\n  const data = await response.json().catch(() => null);",
  'backend-node/src/routes/aiConfig.js':"function testConnection(log) {\n    testConnection: testConnection(log),\n        api_protocol: body.api_protocol,\n      });\n      log.error('AI config test connection failed', { error: err.message });",
  'backend-node/src/services/museAudioService.js':" db.prepare('INSERT INTO muse_tts_generations(",
  'backend-node/src/services/musePostproduction.js':source('muse-postproduction.cjs'),
  'frontweb/src/utils/request.js':'request.interceptors.request.use(async config => {\n  config.headers = { ...config.headers, ...await prepareMuseAdmission(config.url, config.method, config.data) }',
  'frontweb/src/views/FilmCreate.vue':'<script setup>\n</script>\n        <div class="header-actions">\n    <!-- 图片放大预览：点击遮罩或图片关闭 -->',
  'frontweb/src/components/AIConfigContent.vue':'  <div class="ai-config-content">\n<script setup>\n  testVisible.value = true\n    const verification = await aiAPI.testConnection({',
 };
 try{
  const changed=new Map(planMuseBudget(root,file=>{const value=other[relative(root,file).replaceAll('\\','/')];assert.equal(typeof value,'string',file);return value;}));
  return {postproduction:changed.get(resolve(root,'backend-node/src/services/musePostproduction.js')),budget:source('muse-budget.cjs'),segments:source('muse-postproduction-segments.cjs')};
 }finally{rmSync(root,{recursive:true,force:true});}
}
function compile(text,overrides){const module={exports:{}};compileFunction(text,['require','module','exports'])(name=>Object.hasOwn(overrides,name)?overrides[name]:require(name),module,module.exports);return module.exports;}
function fixture(t,{currency='LTV',failUpload=false}={}){
 const sources=finalSources(),db=new DatabaseSync(':memory:');
 let depth=0,sequence=0;
 db.transaction=callback=>{const run=(...args)=>{const nested=depth>0,name='fixture_'+sequence++;db.exec(nested?'SAVEPOINT '+name:'BEGIN IMMEDIATE');depth++;try{const result=callback(...args);db.exec(nested?'RELEASE '+name:'COMMIT');return result;}catch(error){db.exec(nested?'ROLLBACK TO '+name:'ROLLBACK');if(nested)db.exec('RELEASE '+name);throw error;}finally{depth--;}};run.immediate=run;return run;};
 t.after(()=>db.close());
 db.exec("CREATE TABLE dramas(id INTEGER PRIMARY KEY,deleted_at TEXT);INSERT INTO dramas VALUES(1,NULL);CREATE TABLE episodes(id INTEGER PRIMARY KEY,drama_id INTEGER,deleted_at TEXT);INSERT INTO episodes VALUES(1,1,NULL);CREATE TABLE storyboards(id INTEGER PRIMARY KEY,episode_id INTEGER,video_url TEXT,deleted_at TEXT);INSERT INTO storyboards VALUES(1,1,'/static/video/original.mp4',NULL);CREATE TABLE video_generations(id INTEGER PRIMARY KEY,drama_id INTEGER,storyboard_id INTEGER,status TEXT,local_path TEXT,prompt TEXT,deleted_at TEXT);INSERT INTO video_generations VALUES(1,1,1,'completed','video/original.mp4','original prompt',NULL);");
 const budget=compile(sources.budget,{}),original=Buffer.from('unchanged original video'),facts={frames:60,fps:10,width:64,height:64,duration_seconds:6},calls={upload:0,submit:0};
 const media={sha,read:()=>original,probe:(_cfg,path)=>({...facts,frames:path.includes('segment-1')?40:path.includes('segment-2')?20:60,duration_seconds:path.includes('segment-1')?4:path.includes('segment-2')?2:6}),segments:()=>[{index:1,start_frame:0,end_frame:40},{index:2,start_frame:40,end_frame:60}],save(){},cut(){}};
 const provider={id:1,is_active:true,provider:'fal',service_type:'muse_postproduction',api_key:'fake-local-key',base_url:'https://queue.fal.run'};
 const fal={models:{upscale:'fal-ai/seedvr/upscale/video',erase_subtitles:'bria/video/erase/prompt'},create:()=>({upload:async()=>{calls.upload++;if(failUpload)throw Object.assign(new Error('local upload refusal'),{code:'fixture_upload_refused'});return 'https://v3.fal.media/fixture.mp4';},submit:async()=>{calls.submit++;return {request_id:'request-'+calls.submit,status_url:'https://queue.fal.run/fixture/status',response_url:'https://queue.fal.run/fixture'};}})};
 const segments=compile(sources.segments,{'./musePostproductionMedia':media,'./musePostproductionFal':fal});
 const service=compile(sources.postproduction,{'./musePostproductionMedia':media,'./musePostproductionFal':fal,'./musePostproductionSegments':segments,'./museBudget':budget,'./aiConfigService':{getConfig:()=>provider,listConfigs:()=>[provider]}});
 const cfg={muse_budget:{currency,prices:currency==='CNY'?[{id:'fal-erasure',service:'postproduction',provider:'fal',model:fal.models.erase_subtitles,origin:'https://queue.fal.run',currency:'CNY',reserve_minor:100,source:'operator-entered',effective_at:'2020-01-01T00:00:00.000Z',expires_at:'2099-01-01T00:00:00.000Z',estimate_kind:'per-dispatch-estimate'}]:[]}};
 if(currency==='LTV'){
  // Historical ledgers can be read, but the current API cannot create a retired budget.
  budget.schema(db,cfg);
  db.prepare('INSERT INTO muse_project_budgets (project_id,currency,limit_minor,allow_estimates,allow_task_envelopes,revision,updated_at) VALUES(?,?,?,?,?,?,?)')
   .run(1,currency,10000,1,1,1,'2026-01-01T00:00:00.000Z');
 }else{
  budget.updateProject(db,cfg,1,{operation_id:'fixture-budget-limit',expected_revision:0,currency,limit_minor:10000,allow_estimates:true,allow_task_envelopes:true});
 }
 const database=service.capabilities(db,cfg).database_id,input={database_id:database,operation_id:'original-erasure-task',source_generation_id:1,source_sha256:sha(original),config_id:1,kind:'erase_subtitles',prompt:'burned in subtitles'};
 const legacy=()=>{
  const raw=compile(source('muse-postproduction.cjs'),{'./musePostproductionMedia':media,'./musePostproductionFal':fal,'./musePostproductionSegments':segments,'./aiConfigService':{getConfig:()=>provider,listConfigs:()=>[provider]}});
  return raw.submit(db,cfg,input);
 };
 return {db,budget,service,cfg,input,calls,legacy,setUploadFailure:value=>{failUpload=value;}};
}

if(process.argv[2]==='--write-fixture')writeFileSync(process.argv[3],JSON.stringify(finalSources()));
else{
 test('deployed Fal submission rejects LTV before upload and preserves the native ledger',async t=>{
  const f=fixture(t),before=f.budget.readProject(f.db,f.cfg,1);
  await assert.rejects(f.service.submit(f.db,f.cfg,f.input),{code:'budget_provider_retired',status:410});
  assert.deepEqual(f.calls,{upload:0,submit:0});assert.deepEqual(f.budget.readProject(f.db,f.cfg,1),before);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM muse_postproduction_tasks').get().n,0);
 });
 test('legacy Fal tasks remain readable but cannot resume against LTV or an absent original allowance',async t=>{
  for(const currency of ['LTV','CNY']){
   const f=fixture(t,{currency,failUpload:true});await f.legacy();f.setUploadFailure(false);const before=f.service.readTask(f.db,f.input.operation_id),calls={...f.calls};
   await assert.rejects(f.service.continueSubmission(f.db,f.cfg,f.input.operation_id,{database_id:f.input.database_id}),{code:currency==='LTV'?'budget_credit_provider_required':'budget_reservation_not_found'});
   assert.deepEqual(f.service.readTask(f.db,f.input.operation_id),before);assert.deepEqual(f.calls,calls);
   assert.equal(f.db.prepare('SELECT count(*) AS n FROM muse_budget_entries').get().n,0);
  }
 });
 test('valid original CNY reservations resume and replay without a second budget reservation',async t=>{
  const f=fixture(t,{currency:'CNY',failUpload:true});await f.service.submit(f.db,f.cfg,f.input);f.budget.outcome(f.db,f.cfg,'fal',f.input.operation_id,'unknown');
  const before=f.budget.readProject(f.db,f.cfg,1);assert.equal(before.reserved_minor,200);
  const original=f.db.prepare('SELECT * FROM muse_postproduction_tasks').get();assert.throws(()=>f.budget.requireFalReservation(f.db,f.cfg,{operation_id:f.input.operation_id,project_id:1,request_sha256:original.request_sha256,config_id:1,model:original.model,quantity:3}),{code:'budget_operation_conflict'});
  f.cfg.muse_budget.prices[0].reserve_minor=300;
  f.setUploadFailure(false);const completed=await f.service.continueSubmission(f.db,f.cfg,f.input.operation_id,{database_id:f.input.database_id});assert.equal(completed.state,'queued');assert.equal(f.calls.submit,2);
  await f.service.continueSubmission(f.db,f.cfg,f.input.operation_id,{database_id:f.input.database_id});assert.equal(f.calls.submit,2);
  assert.deepEqual(f.budget.readProject(f.db,f.cfg,1),before);assert.equal(f.db.prepare('SELECT count(*) AS n FROM muse_budget_entries').get().n,1);
 });
 test('changed or settled Fal reservations cannot finance continuation',async t=>{
  const f=fixture(t,{currency:'CNY',failUpload:true});await f.service.submit(f.db,f.cfg,f.input);f.setUploadFailure(false);
  const row=f.db.prepare('SELECT entry_id FROM muse_budget_entries').get();f.budget.outcome(f.db,f.cfg,'fal',f.input.operation_id,'completed');
  f.budget.reconcile(f.db,f.cfg,row.entry_id,{operation_id:'settled-fal-invoice',expected_revision:2,amount_minor:0,source:'operator-confirmed-invoice',reference:'local fixture',final_invoice_confirmed:true});
  await assert.rejects(f.service.continueSubmission(f.db,f.cfg,f.input.operation_id,{database_id:f.input.database_id}),{code:'budget_operation_requires_reconciliation'});assert.equal(f.calls.submit,0);
 });
}

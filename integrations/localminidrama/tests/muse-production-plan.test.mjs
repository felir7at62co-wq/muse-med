/** Actual native SQLite transactions retain keyed plans, history and original import receipts. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire,Module} from 'node:module';
import {existsSync,readFileSync,mkdtempSync,rmSync,mkdirSync,writeFileSync} from 'node:fs';
import {resolve,join,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {planMuseProductionPlan} from '../compatibility/muse-production-plan.mjs';

const root=resolve(process.env.LOCALMINIDRAMA_SOURCE||'.local/localminidrama'),backend=join(root,'backend-node');
const require=createRequire(join(backend,'package.json')),available=existsSync(join(backend,'node_modules/better-sqlite3'));
const fixturePlan=JSON.parse(readFileSync(new URL('./fixtures/production-plan.json',import.meta.url),'utf8'));
const retained=[];
function fixture(t){
 const home=mkdtempSync(join(tmpdir(),'muse-plan-')),Database=require('better-sqlite3'),connections=[];
 const connect=()=>{const db=new Database(join(home,'tenant.db')),prepare=db.prepare.bind(db);db.prepare=(...args)=>{const statement=prepare(...args);retained.push(statement);return statement};connections.push(db);retained.push(db);return db};
 const db=connect();db.exec(readFileSync(join(backend,'migrations/01_init.sql'),'utf8'));db.exec("CREATE TABLE IF NOT EXISTS storyboard_characters(id INTEGER PRIMARY KEY AUTOINCREMENT,storyboard_id INTEGER NOT NULL,character_id INTEGER NOT NULL,created_at TEXT NOT NULL DEFAULT '')");
 const module=new Module(join(backend,'src/services/museProductionPlan.js'));module.filename=join(backend,'src/services/museProductionPlan.js');module.require=name=>name==='./museProductionPlan.schema.json'?JSON.parse(readFileSync(new URL('../extensions/muse-production-plan.schema.json',import.meta.url),'utf8')):require(name);module._compile(readFileSync(new URL('../extensions/muse-production-plan.cjs',import.meta.url),'utf8'),module.filename);const service=module.exports;
 t.after(()=>{for(const connection of connections)if(connection.open)connection.close();assert.equal(dirname(resolve(home)),resolve(tmpdir()));rmSync(home,{recursive:true,force:true,maxRetries:5,retryDelay:50})});
 const plan=structuredClone(fixturePlan),cfg={},namespace='rain-town-production';
 const preview=(value=plan,extra={})=>service.preview(db,cfg,{namespace,plan:value,...extra});
 const apply=(id='import-rain-town-one',value=plan,extra={})=>{const before=preview(value,extra);return service.apply(db,cfg,{...before,namespace,plan:value,operation_id:id,source:{kind:'muse',session_id:'original-session'},...extra})};
 return {db,connect,service,plan,cfg,namespace,preview,apply};
}

test('one transaction maps ordered packages and exact dialogue; repeat and reopen reuse all native IDs',{skip:!available},t=>{
 const f=fixture(t);f.plan.episodes[0].number=3;const before=f.preview(),request={...before,namespace:f.namespace,plan:f.plan,operation_id:'import-rain-town-one',source:{kind:'muse',session_id:'original-session'}};
 const result=f.service.apply(f.db,f.cfg,request);assert.equal(result.status,'imported');assert.equal(result.episodes[0].packages.length,2);assert.equal(result.paid_requests,0);
 assert.equal(f.db.prepare('SELECT total_episodes FROM dramas WHERE id=?').get(result.project_id).total_episodes,3);
 const card=f.db.prepare('SELECT * FROM storyboards WHERE id=?').get(result.episodes[0].packages[0].id);assert.equal(card.dialogue,'林: 你回来了。');assert.equal(card.video_prompt,f.plan.episodes[0].packages[0].videoPrompt);assert.deepEqual(JSON.parse(card.characters),[result.characters[0].id]);
 assert.equal(f.db.prepare('SELECT prop_id FROM storyboard_props WHERE storyboard_id=?').get(card.id).prop_id,result.props[0].id);
 const library=f.db.prepare('SELECT * FROM character_libraries WHERE drama_id=?').get(result.project_id);assert.equal(library.source_type,'character');assert.equal(library.source_id,String(result.characters[0].id));assert.equal(f.db.prepare('SELECT character_id FROM storyboard_characters WHERE storyboard_id=?').get(card.id).character_id,library.id);
 assert.deepEqual(f.service.apply(f.db,f.cfg,request),{...result,replayed:true});
 const reopened=f.connect();assert.deepEqual(f.service.getImport(reopened,f.cfg,request.operation_id),{...result,replayed:true});assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM dramas').get().n,1);
 assert.throws(()=>f.service.apply(f.db,f.cfg,{...request,namespace:'different-production'}),{code:'plan_operation_changed'});
});

test('a revised plan keeps prior generation history, native IDs and unrelated asset fields',{skip:!available},t=>{
 const f=fixture(t),first=f.apply();const character=first.characters[0].id,card=first.episodes[0].packages[0].id;
 f.db.prepare('UPDATE characters SET image_url=?,local_path=? WHERE id=?').run('/static/original.png','original.png',character);
 f.db.prepare("INSERT INTO image_generations(drama_id,storyboard_id,status,prompt,image_url) VALUES(?,?,'completed','original prompt','/static/original.png')").run(first.project_id,card);
 const next=structuredClone(f.plan);next.characters[0].description='成年画师';next.episodes[0].packages[0].videoPrompt='保留原图，转向街角';
 next.characters.push({...next.characters[0],key:'other',name:'另一位画师'});next.episodes[0].packages[0].characterKeys=['other'];next.episodes[0].packages[0].dialogue[0].characterKey='other';
 const updated=f.apply('import-rain-town-two',next);assert.equal(updated.project_id,first.project_id);assert.equal(updated.revision,2);assert.deepEqual(updated.episodes,first.episodes);
 const saved=f.db.prepare('SELECT * FROM characters WHERE id=?').get(character);assert.equal(saved.image_url,'/static/original.png');assert.equal(saved.local_path,'original.png');assert.equal(saved.description,'成年画师');assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM image_generations').get().n,1);
 assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM muse_production_plan_imports').get().n,2);
 const library=f.db.prepare('SELECT * FROM character_libraries WHERE drama_id=? AND source_id=?').get(first.project_id,String(updated.characters[1].id));assert.equal(f.db.prepare('SELECT character_id FROM storyboard_characters WHERE storyboard_id=?').get(card).character_id,library.id);assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM storyboard_characters WHERE storyboard_id=?').get(card).n,1);
});

test('changed target snapshots and missing mapped rows refuse before any partial revision',{skip:!available},t=>{
 const f=fixture(t),first=f.apply(),before=f.preview(),card=first.episodes[0].packages[0].id;
 f.db.prepare('UPDATE storyboards SET video_prompt=? WHERE id=?').run('operator edit',card);
 const outcome=f.service.apply(f.db,f.cfg,{...before,namespace:f.namespace,plan:f.plan,operation_id:'stale-plan-operation',source:{kind:'muse',session_id:'session'}});assert.equal(outcome.status,'conflict');assert.equal(f.db.prepare('SELECT video_prompt FROM storyboards WHERE id=?').get(card).video_prompt,'operator edit');assert.equal(f.db.prepare('SELECT revision FROM muse_production_plans').get().revision,1);
 f.db.prepare('UPDATE characters SET deleted_at=? WHERE id=?').run('2026-11-13',first.characters[0].id);
 assert.throws(()=>f.apply('missing-plan-asset'),{code:'plan_target_missing'});assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM characters').get().n,1);
});

test('write failure rolls back the whole import and the original operation can complete once',{skip:!available},t=>{
 const f=fixture(t);f.db.exec("CREATE TRIGGER reject_plan_package BEFORE INSERT ON storyboards BEGIN SELECT RAISE(ABORT,'fixture interruption'); END;");
 assert.throws(()=>f.apply(),/fixture interruption/);for(const table of ['dramas','episodes','characters','scenes','props','storyboards','muse_production_plan_imports'])assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM '+table).get().n,0);
 f.db.exec('DROP TRIGGER reject_plan_package');const result=f.apply();assert.equal(result.revision,1);assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM dramas').get().n,1);
 assert.throws(()=>f.db.prepare('DELETE FROM muse_production_plan_imports').run(),/plan_receipt_retained/);
 assert.throws(()=>f.db.prepare("UPDATE muse_production_plan_imports SET source_json='{}'").run(),/plan_receipt_immutable/);
});

test('an explicitly selected existing project retains unrelated rows and refuses unmapped episode collisions',{skip:!available},t=>{
 const f=fixture(t);f.db.exec("INSERT INTO dramas(id,title,thumbnail) VALUES(99,'existing','keep.png'); INSERT INTO episodes(drama_id,episode_number,title) VALUES(99,99,'keep episode');");
 const result=f.apply('attach-existing-plan',f.plan,{target_project_id:99});assert.equal(result.project_id,99);assert.equal(f.db.prepare('SELECT thumbnail FROM dramas WHERE id=99').get().thumbnail,'keep.png');assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM episodes').get().n,2);
 assert.equal(f.db.prepare('SELECT total_episodes FROM dramas WHERE id=99').get().total_episodes,99);
 const other=structuredClone(f.plan);other.episodes[0].number=2;
 assert.throws(()=>f.service.preview(f.db,f.cfg,{namespace:'other-plan',plan:other,target_project_id:99}),{code:'plan_target_owned'});
 f.db.exec("INSERT INTO dramas(id,title) VALUES(100,'unmapped'); INSERT INTO episodes(drama_id,episode_number) VALUES(100,1)");
 assert.throws(()=>f.service.preview(f.db,f.cfg,{namespace:'unmapped-plan',plan:f.plan,target_project_id:100}),{code:'plan_episode_conflict'});
 const omit=structuredClone(f.plan);omit.episodes[0].packages.pop();assert.throws(()=>f.preview(omit),{code:'plan_omitted_keys'});
 const last=result.episodes[0].packages[1].id;f.db.prepare('UPDATE storyboards SET deleted_at=? WHERE id=?').run('2026-11-13',last);
 const next=f.apply('after-explicit-archive',omit);assert.equal(next.episodes[0].packages.length,1);assert.equal(f.db.prepare('SELECT id FROM storyboards WHERE id=?').get(last).id,last);
});

test('strict parser rejects unknown fields, duplicate identities, unresolved references and silent dialogue',{skip:!available},t=>{
 const f=fixture(t);for(const edit of [plan=>{plan.api_key='forbidden'},plan=>{plan.characters.push({...plan.characters[0]})},plan=>{plan.episodes[0].packages[0].propKeys=['missing']},plan=>{plan.episodes[0].packages[0].audio.mode='silent'},plan=>{plan.episodes[0].packages[1].order=9}]){const bad=structuredClone(f.plan);edit(bad);assert.throws(()=>f.service.parse(bad,{}),{code:'plan_invalid'})}assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM dramas').get().n,0);
});

test('only the immutable completed captured CLI result can authorize a derived plan',{skip:!available},t=>{
 const f=fixture(t);f.db.exec("CREATE TABLE muse_libtv_cli_operations(operation_id TEXT PRIMARY KEY,state TEXT,result_json TEXT,request_sha256 TEXT); CREATE TABLE muse_libtv_cli_inputs(operation_id TEXT PRIMARY KEY,capture_json TEXT);");
 const id='original-script-operation',raw={nodeKey:'original',data:{text:'真实剧本原文'}};f.db.prepare('INSERT INTO muse_libtv_cli_operations VALUES(?,?,?,?)').run(id,'unknown',JSON.stringify(raw),'a'.repeat(64));f.db.prepare('INSERT INTO muse_libtv_cli_inputs VALUES(?,?)').run(id,JSON.stringify({protocol:'libtv-cli-input-v1',node_type:'script'}));
 assert.throws(()=>f.service.readCli(f.db,f.cfg,id),{code:'plan_source_unfinished'});f.db.prepare("UPDATE muse_libtv_cli_operations SET state='completed'").run();const source=f.service.readCli(f.db,f.cfg,id);assert.deepEqual(source.result,raw);
 const before=f.preview(),request={...before,namespace:f.namespace,plan:f.plan,operation_id:'cli-derived-plan-one',source:{kind:'cli',...source.source_cli}};
 assert.throws(()=>f.service.apply(f.db,f.cfg,{...request,source:{...request.source,result_sha256:'f'.repeat(64)}}),{code:'plan_source_changed'});assert.equal(f.service.apply(f.db,f.cfg,request).status,'imported');
});

test('routes preserve plan diagnostics and delegate adoption receipts to their own database owner',{skip:!available},t=>{
 const f=fixture(t),handlers=new Map(),calls=[];
 const adoption={preview:(_db,_cfg,input)=>{calls.push(input);return {database_id:'adoption-database',target_sha256:'target',source_sha256:'source'}},apply:()=>{throw Object.assign(Error('Target changed'),{code:'adoption_snapshot_changed'})},get:(_db,input)=>({operation_id:input.operation_id,replayed:true})};
 const module=new Module(join(backend,'src/routes/museProductionPlanRoutes.js'));module.filename=join(backend,'src/routes/museProductionPlanRoutes.js');module.require=name=>name.endsWith('museProductionPlan')?f.service:adoption;module._compile(readFileSync(new URL('../extensions/muse-production-plan-routes.cjs',import.meta.url),'utf8'),module.filename);
 module.exports.register({get:(path,fn)=>handlers.set('GET '+path,fn),post:(path,fn)=>handlers.set('POST '+path,fn)},f.db,f.cfg);
 const invoke=(path,body={},params={})=>{let reply,status=200;handlers.get(path)({body,params},{json:value=>{reply=value},status:value=>{status=value;return {json:value=>{reply=value}}}});assert.equal(status,200);return reply.data};
 assert.equal(invoke('POST /muse/production-plans/preview',{namespace:f.namespace,plan:{}}).status,'refused');
 const selected={namespace:f.namespace,kind:'prop',key:'umbrella',generation_id:7};assert.equal(invoke('POST /muse/production-plans/adopt-preview',selected).database_id,'adoption-database');assert.deepEqual(calls,[selected]);
 assert.equal(invoke('POST /muse/production-plans/adopt-apply',selected).status,'conflict');assert.equal(invoke('GET /muse/production-plans/adoptions/:id',{}, {id:'original-adoption'}).operation_id,'original-adoption');
});

test('the companion planner includes owned plan and adoption files without changing its input checkout',t=>{
 const root=mkdtempSync(join(tmpdir(),'muse-plan-planner-')),route=join(root,'backend-node/src/routes/index.js');
 t.after(()=>{assert.equal(dirname(resolve(root)),resolve(tmpdir()));rmSync(root,{recursive:true,force:true})});
 mkdirSync(dirname(route),{recursive:true});const original='function routes(){\n  const r = express.Router();\n  return r;\n}\n';writeFileSync(route,original);
 const planned=planMuseProductionPlan(root),names=planned.map(([file])=>file.replaceAll('\\','/'));
 assert.equal(planned.length,5);assert.ok(names.some(file=>file.endsWith('services/museProductionPlan.schema.json')));assert.ok(names.some(file=>file.endsWith('services/museProductionAdoption.js')));assert.match(planned.find(([file])=>file===route)[1],/museProductionPlanRoutes/);assert.equal(readFileSync(route,'utf8'),original);
 const collision=join(root,'backend-node/src/services/museProductionPlan.js');mkdirSync(dirname(collision),{recursive:true});writeFileSync(collision,'owned');assert.throws(()=>planMuseProductionPlan(root),/already exists/);
});

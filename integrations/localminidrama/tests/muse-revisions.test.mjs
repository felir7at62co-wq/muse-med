/** Real SQLite triggers audit native HTTP and tool edits without configuration secrets or paid-state restoration. */
import test from 'node:test'
import assert from 'node:assert/strict'
import {createHash,randomUUID,webcrypto} from 'node:crypto'
import {existsSync,mkdtempSync,readFileSync,rmSync} from 'node:fs'
import http from 'node:http'
import {createRequire} from 'node:module'
import {tmpdir} from 'node:os'
import {dirname,join,relative,resolve,sep} from 'node:path'
import {compileFunction,createContext,runInContext} from 'node:vm'
import {planCloudPrefix} from '../compatibility/cloud-prefix.mjs'
import {planMediaAdoption} from '../compatibility/media-adoption.mjs'
import {planMuseAudio} from '../compatibility/muse-audio.mjs'
import {planMuseBranding} from '../compatibility/muse-branding.mjs'
import {planMuseRevisions} from '../compatibility/muse-revisions.mjs'
import {createPinnedSourceReader} from './pinned-source.mjs'

const root=resolve(process.env.LOCALMINIDRAMA_SOURCE||'.local/localminidrama'),filename=name=>resolve(root,name)
const available=existsSync(filename('backend-node/node_modules/better-sqlite3'))
const pristine=createPinnedSourceReader(root),plannerRoot=join(tmpdir(),'muse-revisions-plan-'+randomUUID())
function plan(planner,read){return planner(plannerRoot,path=>read(filename(relative(plannerRoot,path)))).map(([path,source])=>[filename(relative(plannerRoot,path)),source])}
let before,changes
function planned(){if(!changes){const staged=new Map(plan(planMediaAdoption,pristine));for(const planner of[planMuseBranding,planCloudPrefix,planMuseAudio])for(const[path,source]of plan(planner,path=>staged.get(path)??pristine(path)))staged.set(path,source);const revised=new Map(plan(planMuseRevisions,path=>staged.get(path)??pristine(path)));before=staged;changes=revised}return changes}
function compile(source,path,require,console={log(){},warn(){},error(){}}){const module={exports:{}};compileFunction(source,['require','module','exports','__filename','__dirname','console'],{filename:path})(require,module,module.exports,path,dirname(path),console);return module.exports}
async function fixture(t){const require=createRequire(filename('backend-node/package.json')),Database=require('better-sqlite3'),home=mkdtempSync(join(tmpdir(),'muse-revisions-')),db=new Database(join(home,'project.sqlite')),statements=[];
 const prepare=db.prepare.bind(db);db.prepare=(...args)=>{const statement=prepare(...args);statements.push(statement);return statement};t.after(()=>{db.close();assert.ok(home.startsWith(resolve(tmpdir())+sep+'muse-revisions-'));rmSync(home,{recursive:true,force:true,maxRetries:5,retryDelay:100})});
 const migratePath=filename('backend-node/src/db/migrate.js'),migration=compile(pristine(migratePath),migratePath,name=>name==='./index.js'?{getDb(){throw Error('Fixture owns its database')}}:name==='../config/index.js'?{loadConfig(){throw Error('Fixture never reads configuration credentials')}}:require(name));migration.runMigrationsAndEnsure(db);
 db.prepare('INSERT INTO dramas(id,title,metadata) VALUES(1,?,?),(2,?,NULL)').run('原项目','{"api_key":"metadata-private-fixture","aspect_ratio":"16:9"}','另一个项目');
 db.prepare('INSERT INTO episodes(id,drama_id,title,script_content) VALUES(11,1,?,?),(22,2,?,?)').run('第一集','原剧本','另一集','其他项目');
 db.prepare('INSERT INTO characters(id,drama_id,name,appearance) VALUES(1,1,?,?),(2,2,?,?)').run('阿宁','原外观','别人','另一外观');
 db.prepare('INSERT INTO scenes(id,drama_id,location,prompt) VALUES(1,1,?,?)').run('厨房','原场景');
 db.prepare('INSERT INTO props(id,drama_id,name,prompt) VALUES(1,1,?,?)').run('餐盘','原道具');
 db.prepare('INSERT INTO storyboards(id,episode_id,title,dialogue,duration,video_url,audio_local_path,status) VALUES(7,11,?,?,?,?,?,?)').run('镜头一','原对白',4,'/static/original.mp4','audio/original.mp3','completed');
 db.prepare('INSERT INTO frame_prompts(id,storyboard_id,frame_type,prompt) VALUES(1,7,?,?)').run('first','原首帧提示词');
 db.prepare('INSERT INTO ai_service_configs(service_type,provider,name,api_key) VALUES(?,?,?,?)').run('text','fixture','private-config','never-audit-config-secret');
 const cfg={storage:{local_path:join(home,'storage')}};
 const servicePath=filename('backend-node/src/services/museRevisions.js'),service=compile(planned().get(servicePath),servicePath,require);service.schema(db,cfg);
 const log={info(){},error(){},warn(){}};
 const cache=new Map();function load(path){if(cache.has(path))return cache.get(path);const req=createRequire(path),source=planned().get(path)??before.get(path)??pristine(path),module={exports:{}};cache.set(path,module.exports);
  compileFunction(source,['require','module','exports','__filename','__dirname'],{filename:path})(name=>{
   if(name==='../config'||name==='../config/index.js')return {loadConfig:()=>cfg};
   if(!name.startsWith('.'))return req(name);const candidate=resolve(dirname(path),name)+(name.endsWith('.js')?'':'.js');return load(before.has(candidate)||planned().has(candidate)?candidate:req.resolve(name));
  },module,module.exports,path,dirname(path));cache.set(path,module.exports);return module.exports;}
 return {db,service,cfg,log,require,home,load,subject:{project_id:1,kind:'storyboard',entity_id:7,database_id:db.prepare('SELECT database_id FROM muse_revision_schema').get().database_id},history(input={}){return service.history(db,cfg,{project_id:1,kind:'storyboard',entity_id:7,...input})}};
}

test('planner preserves staged voice/prefix UI and rejects repeated or changed source', {skip:!available},()=>{
 const edits=planned();assert.equal(edits.size,5);const film=edits.get(filename('frontweb/src/views/FilmCreate.vue'));
 assert.match(film,/MuseAudioPanel/);assert.match(film,/MuseRevisionsPanel/);assert.match(film,/声音与配音/);assert.match(film,/编辑记录与恢复/);
 assert.throws(()=>plan(planMuseRevisions,path=>edits.get(path)??before.get(path)??pristine(path)),/pinned source/);
 assert.throws(()=>plan(planMuseRevisions,path=>{const value=before.get(path)??pristine(path);return path===filename('backend-node/src/routes/index.js')?value.replace('const r = express.Router();','const r = changed();'):value}),/pinned source/);
})

test('native tool SQL edits produce immutable snapshots with stable project ownership', {skip:!available},async t=>{
 const f=await fixture(t),initial=f.history();assert.equal(initial.items[0].change_type,'baseline');assert.equal(initial.items[0].before,null);
 f.db.prepare('UPDATE storyboards SET dialogue=? WHERE id=7').run('工具编辑对白');const edited=f.history();
 assert.equal(edited.items[0].before.values.dialogue,'原对白');assert.equal(edited.items[0].after.values.dialogue,'工具编辑对白');assert.ok(edited.current_revision>initial.current_revision);
 assert.throws(()=>f.db.prepare('UPDATE muse_business_revisions SET after_json=? WHERE id=?').run('{}',edited.current_revision),/immutable/);
 assert.throws(()=>f.db.prepare('DELETE FROM muse_business_revisions WHERE id=?').run(edited.current_revision),/immutable/);
 assert.throws(()=>f.db.prepare('UPDATE characters SET drama_id=2 WHERE id=1').run(),/ownership_immutable/);
 assert.throws(()=>f.service.history(f.db,f.cfg,{project_id:2,kind:'storyboard',entity_id:7}),/not_found/);
 const count=f.db.prepare('SELECT COUNT(*) AS n FROM muse_business_revisions').get().n;f.db.prepare('UPDATE storyboards SET status=? WHERE id=7').run('processing');assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM muse_business_revisions').get().n,count);
})

test('restore compares the frozen revision, excludes media and paid states and replays without overwriting later edits', {skip:!available},async t=>{
 const f=await fixture(t),initial=f.history(),source=initial.items[0].id;
 f.db.prepare('UPDATE storyboards SET dialogue=?,video_url=?,audio_local_path=?,status=? WHERE id=7').run('新对白','/static/new.mp4','audio/new.mp3','processing');
 const current=f.history(),input={...f.subject,revision_id:source,expected_revision:current.current_revision,side:'after',operation_id:'restore-original'};
 const missingDatabase={...input};delete missingDatabase.database_id;assert.throws(()=>f.service.restore(f.db,f.cfg,missingDatabase),{code:'revision_database_changed'});assert.throws(()=>f.service.restore(f.db,f.cfg,{...input,database_id:'another-tenant-database'}),{code:'revision_database_changed'});assert.equal(f.db.prepare('SELECT dialogue FROM storyboards WHERE id=7').get().dialogue,'新对白');
 assert.throws(()=>f.service.restore(f.db,f.cfg,{...input,expected_revision:initial.current_revision}),/revision_changed/);
 const restored=f.service.restore(f.db,f.cfg,input),row=f.db.prepare('SELECT * FROM storyboards WHERE id=7').get();assert.equal(row.dialogue,'原对白');assert.equal(row.video_url,'/static/new.mp4');assert.equal(row.audio_local_path,'audio/new.mp3');assert.equal(row.status,'processing');assert.equal(restored.media_adoption_changed,false);assert.equal(restored.paid_generation_dispatched,false);
 f.db.prepare('UPDATE storyboards SET dialogue=? WHERE id=7').run('恢复之后的编辑');assert.equal(f.service.restore(f.db,f.cfg,input).replayed,true);assert.equal(f.db.prepare('SELECT dialogue FROM storyboards WHERE id=7').get().dialogue,'恢复之后的编辑');
 assert.throws(()=>f.service.restore(f.db,f.cfg,{...input,side:'before'}),/operation_conflict/);
 const actual={restored_dialogue:row.dialogue,retained_video:row.video_url,retained_audio:row.audio_local_path,retained_generation_state:row.status,media_adoption_changed:restored.media_adoption_changed,paid_generation_dispatched:restored.paid_generation_dispatched,replayed_without_overwrite:true};
 assert.deepEqual(actual,JSON.parse(readFileSync(new URL('./expected/muse-revisions.json',import.meta.url),'utf8')));
})

test('redaction never persists common credentials and prevents restoring masked content', {skip:!available},async t=>{
 const f=await fixture(t),secret='sk-'+'fixture-redaction-canary-'.repeat(2);f.db.prepare('UPDATE storyboards SET dialogue=? WHERE id=7').run('Bearer '+secret+' password="phrase with spaces"');
 const version=f.history().items[0],journal=f.db.prepare('SELECT before_json,after_json FROM muse_business_revisions').all();assert.ok(!JSON.stringify(journal).includes(secret));assert.ok(!JSON.stringify(journal).includes('phrase with spaces'));assert.ok(!JSON.stringify(journal).includes('metadata-private-fixture'));assert.ok(!JSON.stringify(journal).includes('never-audit-config-secret'));
 assert.ok(version.after.redacted_fields.includes('dialogue'));assert.throws(()=>f.service.restore(f.db,f.cfg,{...f.subject,operation_id:'restore-masked',revision_id:version.id,expected_revision:version.id,side:'after'}),/redacted_content/);
 assert.ok(f.db.prepare('SELECT dialogue FROM storyboards WHERE id=7').get().dialogue.includes(secret));
})

test('audit persistence failure atomically stops the business edit and never creates a partial restore', {skip:!available},async t=>{
 const f=await fixture(t),initial=f.history();f.db.exec("CREATE TRIGGER refuse_revision BEFORE INSERT ON muse_business_revisions BEGIN SELECT RAISE(ABORT,'fixture_revision_failure'); END;");
 assert.throws(()=>f.db.prepare('UPDATE storyboards SET dialogue=? WHERE id=7').run('must not commit'),/fixture_revision_failure/);
 assert.equal(f.db.prepare('SELECT dialogue FROM storyboards WHERE id=7').get().dialogue,'原对白');assert.equal(f.history().current_revision,initial.current_revision);
 f.db.exec('DROP TRIGGER refuse_revision');f.service.schema(f.db,{muse_revisions:{max_snapshot_bytes:1024}});
 assert.throws(()=>f.db.prepare('UPDATE storyboards SET dialogue=? WHERE id=7').run('x'.repeat(3000)),/snapshot_too_large/);assert.equal(f.history().items[0].after.values.dialogue,'原对白');
})

test('soft and physical deletion retain an audit index but cannot be recreated by content restore', {skip:!available},async t=>{
 const f=await fixture(t),before=f.history();f.db.prepare('UPDATE storyboards SET deleted_at=? WHERE id=7').run('2026-11-12T00:00:00Z');assert.equal(f.history().deleted,true);
 assert.ok(f.service.listEntities(f.db,f.cfg,{project_id:1}).items.some(item=>item.kind==='storyboard'&&item.id===7&&item.deleted));
 assert.throws(()=>f.service.restore(f.db,f.cfg,{...f.subject,operation_id:'restore-deleted',revision_id:before.current_revision,expected_revision:f.history().current_revision,side:'after'}),/not_found/);
 f.db.prepare('DELETE FROM storyboards WHERE id=7').run();assert.equal(f.history().items[0].change_type,'delete');assert.equal(f.history().items[0].after,null);
})

test('native generation records never manufacture token totals, charge estimates or missing-table zeros', {skip:!available},async t=>{
 const f=await fixture(t);f.db.prepare('INSERT INTO image_generations(drama_id,status,prompt) VALUES(1,?,?)').run('completed','fixture');f.db.prepare('INSERT INTO video_generations(drama_id,status,prompt) VALUES(1,?,?)').run('failed','fixture');
 const usage=f.service.usage(f.db,f.cfg,{project_id:1});assert.equal(usage.coverage,'native-generation-records');assert.equal(usage.billing_verified,false);assert.equal(usage.image.records,1);assert.equal(usage.video.failed,1);assert.equal(usage.audio.available,false);
 for(const kind of ['image','video','audio'])for(const field of ['input_tokens','output_tokens','total_tokens','cost'])assert.equal(usage[kind][field],null);
})

test('association-only edits keep exact before and after references and cannot bypass media adoption', {skip:!available},async t=>{
 const f=await fixture(t),subject={project_id:1,kind:'storyboard_props',entity_id:7,database_id:f.subject.database_id};
 f.db.prepare('INSERT INTO storyboard_props(storyboard_id,prop_id) VALUES(7,1)').run();let history=f.service.history(f.db,f.cfg,subject);
 assert.deepEqual(history.items[0].before.values.prop_ids,[]);assert.deepEqual(history.items[0].after.values.prop_ids,[1]);assert.deepEqual(history.restorable_fields,[]);
 f.db.prepare('DELETE FROM storyboard_props WHERE storyboard_id=7').run();history=f.service.history(f.db,f.cfg,subject);assert.deepEqual(history.items[0].before.values.prop_ids,[1]);assert.deepEqual(history.items[0].after.values.prop_ids,[]);
 assert.throws(()=>f.service.restore(f.db,f.cfg,{...subject,operation_id:'restore-reference',revision_id:history.current_revision,expected_revision:history.current_revision,side:'before'}),/relation_read_only/);
 f.db.prepare('INSERT INTO episode_characters(episode_id,character_id) VALUES(11,1)').run();assert.deepEqual(f.service.history(f.db,f.cfg,{project_id:1,kind:'episode_characters',entity_id:11}).items[0].after.values.character_ids,[1]);
 f.db.prepare('INSERT INTO storyboard_characters(storyboard_id,character_id) VALUES(7,4),(7,4)').run();const characterSubject={project_id:1,kind:'storyboard_characters',entity_id:7};history=f.service.history(f.db,f.cfg,characterSubject);assert.deepEqual(history.items[0].before.values.character_library_ids,[4]);assert.deepEqual(history.items[0].after.values.character_library_ids,[4,4]);
 f.db.prepare('UPDATE storyboard_characters SET character_id=5 WHERE id=(SELECT MAX(id) FROM storyboard_characters)').run();history=f.service.history(f.db,f.cfg,characterSubject);assert.deepEqual(history.items[0].before.values.character_library_ids,[4,4]);assert.deepEqual(history.items[0].after.values.character_library_ids,[4,5]);
 assert.throws(()=>f.db.prepare('UPDATE storyboard_characters SET storyboard_id=8').run(),/owner_immutable/);
 assert.throws(()=>f.service.history(f.db,f.cfg,{...subject,project_id:2}),/not_found/);
})

test('actual HTTP and native storyboard handlers are audited and a foreign restore is refused', {skip:!available},async t=>{
 const f=await fixture(t),express=f.require('express'),router=express.Router(),app=express();app.use(express.json());
 const routePath=filename('backend-node/src/routes/museRevisionsRoutes.js'),routes=compile(planned().get(routePath),routePath,name=>name==='../services/museRevisions'?f.service:name==='../response'?f.require(filename('backend-node/src/response.js')):f.require(name));routes.register(router,f.db,f.cfg);
 const nativePath=filename('backend-node/src/routes/storyboards.js'),native=compile(pristine(nativePath),nativePath,name=>name==='../services/storyboardService'?f.load(filename('backend-node/src/services/storyboardService.js')):name==='../response'?f.require(filename('backend-node/src/response.js')):name.startsWith('.')?{}:f.require(name));router.put('/storyboards/:id',native(f.db,f.log).update);app.use('/api/v1',router);
 const server=http.createServer(app);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));const url=`http://127.0.0.1:${server.address().port}/api/v1`;
 const edited=await (await fetch(url+'/storyboards/7',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({dialogue:'HTTP真实编辑',prop_ids:[1]})})).json();assert.equal(edited.success,true);assert.equal(f.history().items[0].after.values.dialogue,'HTTP真实编辑');assert.deepEqual(f.service.history(f.db,f.cfg,{project_id:1,kind:'storyboard_props',entity_id:7}).items[0].after.values.prop_ids,[1]);
 const history=await (await fetch(url+'/muse/revisions/history?project_id=1&kind=storyboard&entity_id=7')).json();assert.equal(history.success,true);assert.equal(history.data.items[0].after.values.dialogue,'HTTP真实编辑');
 const refused=await fetch(url+'/muse/revisions/restore',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...f.subject,project_id:2,operation_id:'foreign-http-restore',revision_id:history.data.current_revision,expected_revision:history.data.current_revision,side:'after'})});assert.equal(refused.status,404);
})

test('owned revision schema rejects future versions', {skip:!available},async t=>{
 const f=await fixture(t);f.db.prepare('UPDATE muse_revision_schema SET version=2').run();assert.throws(()=>f.service.schema(f.db,f.cfg),/unsupported_revision_schema/);
})

const frontRequire=createRequire(filename('frontweb/package.json'))
let compilerAvailable=false;try{frontRequire.resolve('@vue/compiler-sfc');compilerAvailable=true}catch(error){if(error.code!=='MODULE_NOT_FOUND')throw error}
test('actual revision dialog and staged FilmCreate compile', {skip:!available||!compilerAvailable},()=>{
 const{parse,compileScript,compileTemplate,compileStyle}=frontRequire('@vue/compiler-sfc');
 for(const[path,source]of planned()){if(!path.endsWith('.vue'))continue;const{descriptor,errors}=parse(source,{filename:path});assert.deepEqual(errors,[]);const script=compileScript(descriptor,{id:'muse-revisions-fixture'});assert.deepEqual(compileTemplate({source:descriptor.template.content,filename:path,id:'muse-revisions-fixture',compilerOptions:{bindingMetadata:script.bindings}}).errors,[]);for(const style of descriptor.styles)assert.deepEqual(compileStyle({source:style.content,filename:path,id:'muse-revisions-fixture',scoped:style.scoped}).errors,[]);}
})

test('the UI retains original restore identity and freezes the revision before later-page reads', {skip:!available},async()=>{
 const source=planned().get(filename('frontweb/src/components/MuseRevisionsPanel.vue')),start=source.indexOf('async function operation('),end=source.indexOf('async function restore(',start),stored=new Map(),databaseId={value:'project-database'},localStorage={getItem:key=>stored.get(key)??null,setItem:(key,value)=>stored.set(key,value)},context=createContext({crypto:webcrypto,TextEncoder,Uint8Array,databaseId,localStorage});runInContext(source.slice(start,end),context);context.input={revision_id:1,expected_revision:2,side:'after'};
 const first=await runInContext('operation(input)',context);assert.equal(first,await runInContext('operation(input)',context));databaseId.value='another-database';assert.notEqual(await runInContext('operation(input)',context),first);
 const frozenRevision={value:null},staleRead={value:false},responses=[2,3].map(head=>({current_revision:head,restorable_fields:['dialogue'],observed_fields:[],items:[{id:head,before:null,after:{values:{dialogue:'fixture'},redacted_fields:[]}}]}));
 const historyContext=createContext({selection:{value:'storyboard:7'},history:{value:null},frozenRevision,staleRead,busy:{value:false},notice:{value:''},generation:0,selected:()=>({project_id:1,kind:'storyboard',entity_id:7}),request:{get:async()=>responses.shift()}});
 runInContext(source.slice(source.indexOf('function validSnapshot('),source.indexOf('function selectEntity(')),historyContext);
 await runInContext('loadHistory()',historyContext);assert.equal(frozenRevision.value,2);await runInContext('loadHistory(1)',historyContext);assert.equal(frozenRevision.value,2);assert.equal(staleRead.value,true);
})

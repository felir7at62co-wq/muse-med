/** Native asset adoption uses real SQLite, verified CLI imports and immutable media bytes; no provider is called. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire,Module} from 'node:module';
import {createHash} from 'node:crypto';
import {existsSync,readFileSync} from 'node:fs';
import {mkdtemp,mkdir,rm,writeFile} from 'node:fs/promises';
import {join,resolve,dirname,basename} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {museAdmissionRoutes} from '../compatibility/muse-admission.mjs';

const backend=resolve(process.env.LOCALMINIDRAMA_SOURCE||'.local/localminidrama','backend-node');
const available=existsSync(join(backend,'node_modules/better-sqlite3/package.json'));
const require=createRequire(join(backend,'package.json'));
const sha=value=>createHash('sha256').update(value).digest('hex');
// Retain addon handles until worker teardown; Node 24 can collect a closed statement after its environment cleanup hook.
const native=[];

async function fixture(t){
 const home=await mkdtemp(join(tmpdir(),'muse-production-adoption-'));
 const Database=require('better-sqlite3'),db=new Database(join(home,'tenant.db')),prepare=db.prepare.bind(db);
 native.push(db);db.prepare=(...args)=>{const statement=prepare(...args);native.push(statement);return statement;};
 t.after(async()=>{db.close();assert.equal(dirname(resolve(home)),resolve(tmpdir()));assert.ok(basename(home).startsWith('muse-production-adoption-'));await rm(home,{recursive:true,force:true,maxRetries:5,retryDelay:50});});
 const storage=join(home,'storage');await mkdir(storage);
 db.exec(readFileSync(join(backend,'migrations/01_init.sql'),'utf8'));
 db.exec(`INSERT INTO dramas(id,title) VALUES(1,'Current project'),(2,'Other project');
 INSERT INTO characters(id,drama_id,name,image_url,local_path) VALUES(1,1,'Hero','/static/old.png','old.png');
 INSERT INTO character_libraries(id,drama_id,name,source_type,source_id) VALUES(1,1,'Hero','character','1');
 INSERT INTO scenes(id,drama_id,location) VALUES(1,1,'Room');
 INSERT INTO props(id,drama_id,name) VALUES(1,1,'Book');
 CREATE TABLE muse_production_plans(namespace TEXT PRIMARY KEY,project_id INTEGER NOT NULL);
 CREATE TABLE muse_production_plan_entities(namespace TEXT,kind TEXT,external_key TEXT,native_id INTEGER,parent_key TEXT);
 INSERT INTO muse_production_plans VALUES('demo',1);
 INSERT INTO muse_production_plan_entities VALUES('demo','character','hero',1,NULL),('demo','character_library','hero',1,NULL),('demo','scene','room',1,NULL),('demo','prop','book',1,NULL);`);
 const cfg={storage:{local_path:storage,base_url:'/studio/static'}},loaded=new Map();
 const files={museProductionAdoption:'muse-production-adoption.cjs',museLibTvCli:'muse-libtv-cli.cjs',museLibTvCliMedia:'muse-libtv-cli-media.cjs',museLibTvAudio:'muse-libtv-audio.cjs',musePostproductionMedia:'muse-postproduction-media.cjs',museBudget:'muse-budget.cjs',museAdmission:'muse-admission.cjs'};
 function load(name){
  if(loaded.has(name))return loaded.get(name);
  const path=join(backend,'src/services',name+'.js'),module=new Module(path);module.filename=path;
  module.require=key=>key==='./museAdmissionCatalog.json'?museAdmissionRoutes:key.startsWith('./')&&files[key.slice(2)]?load(key.slice(2)):require(key);
  module._compile(readFileSync(fileURLToPath(new URL('../extensions/'+files[name],import.meta.url)),'utf8'),path);
  loaded.set(name,module.exports);return module.exports;
 }
 const cli=load('museLibTvCli'),adopt=load('museProductionAdoption'),databaseId=cli.schema(db,cfg),requestHash=sha('fixed original request');
 db.prepare('INSERT INTO muse_libtv_cli_operations VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run('source-cli-image',requestHash,'{}',sha('owner'),'canvas','node',1,null,'fixture-image','image',1,'Hero', '[]','completed','{}','fixture-budget','2026-01-01','2026-01-01');
 const bytes=await require('sharp')({create:{width:16,height:16,channels:3,background:'#aaccee'}}).png().toBuffer();
 cli.chunk(db,cfg,'source-cli-image',{database_id:databaseId,request_sha256:requestHash,sha256:sha(bytes),kind:'image',media_type:'image/png',total_bytes:bytes.length,total_chunks:1,index:0,chunk_sha256:sha(bytes),data_base64:bytes.toString('base64')});
 const imported=await cli.importResult(db,cfg,'source-cli-image',{database_id:databaseId,request_sha256:requestHash,operation_id:'import-cli-image',sha256:sha(bytes),kind:'image'});
 const input={namespace:'demo',kind:'character',key:'hero',generation_id:imported.generation_id};
 const preview=()=>adopt.preview(db,cfg,input);
 const request=()=>{const p=preview();return {...input,operation_id:'adopt-hero-image',database_id:p.database_id,expected_target_sha256:p.target_sha256,expected_source_sha256:p.source_sha256};};
 return {db,cfg,storage,bytes,imported,input,adopt,preview,request};
}

test('character, scene and prop adoption retain verified original history and previous media',{skip:!available},async t=>{
 const f=await fixture(t);
 for(const [kind,key,table]of [['character','hero','characters'],['scene','room','scenes'],['prop','book','props']]){
  const input={...f.input,kind,key},p=f.adopt.preview(f.db,f.cfg,input);
  const receipt=f.adopt.apply(f.db,f.cfg,{...input,operation_id:'adopt-'+key+'-image',database_id:p.database_id,expected_target_sha256:p.target_sha256,expected_source_sha256:p.source_sha256});
  assert.equal(receipt.status,'adopted');assert.equal(receipt.sha256,sha(f.bytes));assert.equal(receipt.source_operation_id,'source-cli-image');assert.equal(receipt.paid_requests,0);
  assert.equal(f.db.prepare('SELECT image_url FROM '+table+' WHERE id=1').get().image_url,receipt.image_url);
  if(kind==='character')assert.equal(f.db.prepare('SELECT image_url FROM character_libraries WHERE id=1').get().image_url,receipt.image_url);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM image_generations').get().n,1);
 }
 const row=f.db.prepare("SELECT * FROM muse_production_adoptions WHERE operation_id='adopt-hero-image'").get();
 assert.equal(JSON.parse(row.previous_json).image_url,'/static/old.png');assert.equal(JSON.parse(row.source_json).imported.sha256,sha(f.bytes));
 assert.throws(()=>f.db.exec("UPDATE muse_production_adoptions SET source_json='{}'"),/adoption_receipt_immutable/);
 assert.throws(()=>f.db.exec('DELETE FROM muse_production_adoptions'),/adoption_receipt_retained/);
});

test('replaying one adoption never overwrites a later selection or accepts changed inputs',{skip:!available},async t=>{
 const f=await fixture(t),request=f.request(),first=f.adopt.apply(f.db,f.cfg,request);
 f.db.prepare("UPDATE characters SET image_url='/static/later.png' WHERE id=1").run();
 assert.deepEqual(f.adopt.apply(f.db,f.cfg,request),{...first,replayed:true});
 assert.equal(f.db.prepare('SELECT image_url FROM characters WHERE id=1').get().image_url,'/static/later.png');
 assert.throws(()=>f.adopt.apply(f.db,f.cfg,{...request,key:'someone-else'}),{code:'adoption_operation_changed'});
 assert.deepEqual(f.adopt.get(f.db,{operation_id:request.operation_id}),{...first,replayed:true});
});

test('concurrent asset edits and source changes refuse adoption without changing media',{skip:!available},async t=>{
 const f=await fixture(t),request=f.request();
 f.db.prepare("UPDATE characters SET appearance='new look' WHERE id=1").run();
 assert.throws(()=>f.adopt.apply(f.db,f.cfg,request),{code:'adoption_snapshot_changed'});
 const current=f.request();f.db.prepare("UPDATE image_generations SET prompt='changed prompt' WHERE id=?").run(f.imported.generation_id);
 assert.throws(()=>f.adopt.apply(f.db,f.cfg,current),{code:'adoption_snapshot_changed'});
 assert.equal(f.db.prepare('SELECT image_url FROM characters WHERE id=1').get().image_url,'/static/old.png');
 assert.equal(f.db.prepare('SELECT COUNT(*) n FROM muse_production_adoptions').get().n,0);
});

test('concurrent character-library edits and foreign reference mappings refuse before changing the asset',{skip:!available},async t=>{
 const f=await fixture(t),request=f.request();
 f.db.prepare("UPDATE character_libraries SET image_url='/static/library-edited.png' WHERE id=1").run();
 assert.throws(()=>f.adopt.apply(f.db,f.cfg,request),{code:'adoption_snapshot_changed'});
 f.db.prepare("UPDATE character_libraries SET source_id='2' WHERE id=1").run();
 assert.throws(f.preview,{code:'adoption_target_changed'});
 assert.equal(f.db.prepare('SELECT image_url FROM characters WHERE id=1').get().image_url,'/static/old.png');
});

test('foreign projects, archived targets, altered bytes and another database cannot be adopted',{skip:!available},async t=>{
 const f=await fixture(t),request=f.request();
 assert.throws(()=>f.adopt.apply(f.db,f.cfg,{...request,database_id:'other'}),{code:'adoption_database_changed'});
 f.db.prepare('UPDATE image_generations SET drama_id=2 WHERE id=?').run(f.imported.generation_id);
 assert.throws(f.preview,{code:'adoption_image_unavailable'});f.db.prepare('UPDATE image_generations SET drama_id=1 WHERE id=?').run(f.imported.generation_id);
 f.db.prepare("UPDATE characters SET deleted_at='archived' WHERE id=1").run();assert.throws(f.preview,{code:'adoption_target_changed'});f.db.prepare('UPDATE characters SET deleted_at=NULL WHERE id=1').run();
 await writeFile(join(f.storage,f.imported.local_path),Buffer.from('altered bytes'));assert.throws(f.preview,{code:'adoption_image_changed'});
});

test('receipt persistence failure rolls back adopted media and keeps the prior asset',{skip:!available},async t=>{
 const f=await fixture(t),request=f.request();
 f.db.exec("CREATE TRIGGER refuse_adoption BEFORE INSERT ON muse_production_adoptions BEGIN SELECT RAISE(ABORT,'fixture receipt failure'); END;");
 assert.throws(()=>f.adopt.apply(f.db,f.cfg,request),/fixture receipt failure/);
 assert.equal(f.db.prepare('SELECT image_url FROM characters WHERE id=1').get().image_url,'/static/old.png');
 assert.equal(f.db.prepare('SELECT COUNT(*) n FROM image_generations').get().n,1);
});

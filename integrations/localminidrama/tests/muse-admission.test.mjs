/** Native paid-request admission with real SQLite, HTTP disconnects and browser operation caches. */
import test from 'node:test'
import assert from 'node:assert/strict'
import {execFileSync} from 'node:child_process'
import {webcrypto} from 'node:crypto'
import {cpSync,existsSync,mkdirSync,mkdtempSync,readFileSync,rmSync,symlinkSync,writeFileSync} from 'node:fs'
import http from 'node:http'
import {createRequire} from 'node:module'
import {tmpdir} from 'node:os'
import {dirname,join,relative,resolve,sep} from 'node:path'
import {compileFunction,createContext,runInContext} from 'node:vm'
import {pathToFileURL} from 'node:url'
import {planMediaAdoption} from '../compatibility/media-adoption.mjs'
import {planMuseBranding} from '../compatibility/muse-branding.mjs'
import {planCloudPrefix} from '../compatibility/cloud-prefix.mjs'
import {planMuseAudio} from '../compatibility/muse-audio.mjs'
import {planMuseRevisions} from '../compatibility/muse-revisions.mjs'
import {planPostproduction} from '../compatibility/muse-postproduction.mjs'
import {planMuseAdmission,museAdmissionRoutes} from '../compatibility/muse-admission.mjs'

const root=resolve(process.env.LOCALMINIDRAMA_SOURCE||'.local/localminidrama'),filename=name=>resolve(root,name),available=existsSync(filename('backend-node/node_modules/better-sqlite3')),originals=new Map()
function pristine(path){const name=relative(root,path).split(sep).join('/');if(!originals.has(name))originals.set(name,execFileSync('git',['-C',root,'show',`3fbcda9713ca545979dff9e75d21bed53694188f:${name}`],{encoding:'utf8',maxBuffer:3e6}).replaceAll('\r\n','\n'));return originals.get(name)}
let before,changes
function planned(){if(!before){before=new Map(planMediaAdoption(root,pristine));for(const planner of [planMuseBranding,planCloudPrefix,planMuseAudio,planMuseRevisions,planPostproduction])for(const[path,source]of planner(root,path=>before.get(path)??pristine(path)))before.set(path,source)}changes??=new Map(planMuseAdmission(root,path=>before.get(path)??pristine(path)));return changes}
function compile(source,path,require){const module={exports:{}};compileFunction(source,['require','module','exports','__filename','__dirname','console'],{filename:path})(require,module,module.exports,path,dirname(path),{log(){},error(){},warn(){}});return module.exports}
async function fixture(t,cfg={}){
 const require=createRequire(filename('backend-node/package.json')),Database=require('better-sqlite3'),home=mkdtempSync(join(tmpdir(),'muse-admission-')),db=new Database(join(home,'data.sqlite')),statements=[],prepare=db.prepare.bind(db);db.prepare=(...args)=>{const statement=prepare(...args);statements.push(statement);return statement};
 t.after(()=>{db.close();assert.ok(home.startsWith(resolve(tmpdir())+sep+'muse-admission-'));rmSync(home,{recursive:true,force:true,maxRetries:5,retryDelay:100})});
 const migrationPath=filename('backend-node/src/db/migrate.js'),migration=compile(pristine(migrationPath),migrationPath,name=>name==='./index.js'?{getDb(){throw Error('Fixture owns its database')}}:name==='../config/index.js'?{loadConfig(){throw Error('Fixture never reads secrets')}}:require(name));migration.runMigrationsAndEnsure(db);
 db.prepare('INSERT INTO dramas(id,title) VALUES(1,?)').run('fixture');db.prepare('INSERT INTO episodes(id,drama_id,title) VALUES(11,1,?)').run('fixture');db.prepare('INSERT INTO storyboards(id,episode_id,title) VALUES(7,11,?)').run('fixture');
 const source=planned().get(filename('backend-node/src/services/museAdmission.js')),service=compile(source,filename('backend-node/src/services/museAdmission.js'),name=>name==='./museAdmissionCatalog.json'?museAdmissionRoutes:require(name)),express=require('express'),router=express.Router(),app=express();app.use(express.json());const hooks=service.register(router,db,cfg);app.use('/api/v1',router);
 const server=http.createServer(app);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections()}));const url=`http://127.0.0.1:${server.address().port}`;
 const post=(path,body={},id='fixture-operation-1')=>fetch(url+'/api/v1'+path,{method:'POST',headers:{'Content-Type':'application/json','x-muse-operation-id':id},body:JSON.stringify(body)});
 const read=async path=>(await (await fetch(url+'/api/v1/muse/admission'+path)).json()).data;
 return {db,service,cfg,router,hooks,require,url,post,read,source,home};
}

test('the composed planner preserves media, audio and revisions and rejects changed or repeated anchors',{skip:!available},()=>{
 const edits=planned();assert.equal(edits.size,10);const film=edits.get(filename('frontweb/src/views/FilmCreate.vue'));assert.match(film,/MuseRevisionsPanel/);assert.match(film,/MuseAudioPanel/);assert.match(film,/MuseAdmissionPanel/);
 assert.throws(()=>planMuseAdmission(root,path=>edits.get(path)??before.get(path)??pristine(path)),/pinned source/);
 assert.throws(()=>planMuseAdmission(root,path=>{const source=before.get(path)??pristine(path);return path===filename('frontweb/src/api/storyboards.js')?source.replace('  }).then(async (res) => {','changed()'):source}),/pinned source/);
})

test('catalog normalization covers native paid paths while leaving local edits and durable TTS/fal separate',{skip:!available},async t=>{
 const f=await fixture(t);for(const path of ['/images','/VIDEOS/','/characters/%31/generate-image','/props/1/generate-prompt','/scenes/generate-image','/generation/story','/episodes/11/storyboards','/storyboards/7/classic-video-prompt-polish-stream'])assert.ok(f.service.match(path,{}));
 for(const path of ['/storyboards/7/rebuild-video-prompt','/storyboards/batch-infer-params','/storyboards/7/link-tail-frame','/videos/2/resume-poll','/images/2/resume-download','/muse/audio/tts','/muse/postproduction/tasks'])assert.equal(f.service.match(path,{}),undefined);
 assert.equal(f.service.match('/dramas/import-novel',{ai_summarize:false}),null);assert.ok(f.service.match('/dramas/import-novel',{ai_summarize:'true'}));
})

test('an explicitly locked video admission cannot bypass the Jubian provider',{skip:!available},async t=>{
 const f=await fixture(t,{muse_jubian:{video_only:true}});let calls=0;f.router.post('/videos',(req,res)=>{calls++;res.json({success:true})});
 const response=await f.post('/videos',{drama_id:1,storyboard_id:7,prompt:'retained draft'}),body=await response.json();
 assert.equal(response.status,409);assert.equal(body.error.code,'jubian_video_required');assert.equal(calls,0);
 assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM muse_native_operations').get().count,0);
})

test('the legacy paid GET is refused and a missing POST operation ID never reaches a handler',{skip:!available},async t=>{
 const f=await fixture(t),source=planned().get(filename('backend-node/src/routes/index.js')),start=source.indexOf("  r.get('/storyboards/episode/:episode_id/generate',"),end=source.indexOf('\n  });',start)+6;assert.ok(start>=0&&end>start);
 compileFunction(source.slice(start,end),['r','response'],{filename:'legacy-get-refusal'})(f.router,f.require(filename('backend-node/src/response.js')));
 let calls=0;f.router.post('/images',(req,res)=>{calls++;res.json({success:true})});const legacy=await fetch(f.url+'/api/v1/storyboards/episode/11/generate');assert.equal(legacy.status,405);assert.equal(legacy.headers.get('allow'),'POST');assert.equal((await legacy.json()).error.code,'generation_requires_post');
 const missing=await fetch(f.url+'/api/v1/images',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});assert.equal(missing.status,428);assert.equal(calls,0);
})

test('multipart novel AI summarizes only a content-hashed stable upload and leaves rule import free',{skip:!available},async t=>{
 const f=await fixture(t),multer=f.require('multer');let calls=0;f.router.post('/dramas/import-novel',multer({storage:multer.memoryStorage()}).single('file'),f.hooks.novel,(req,res)=>{calls++;res.json({success:true,data:{chapters:[{script:'generated chapter'}]}})});
 async function upload(id,ai=true,text='private novel input'){const body=new FormData();body.append('file',new Blob([text],{type:'text/plain'}),'novel.txt');body.append('ai_summarize',String(ai));return fetch(f.url+'/api/v1/dramas/import-novel',{method:'POST',headers:id?{'x-muse-operation-id':id}:{},body})}
 const first=await upload('novel-operation-1'),receipt=await first.json();assert.equal(first.status,200);assert.deepEqual(await(await upload('novel-operation-1')).json(),receipt);assert.equal(calls,1);assert.equal((await upload('novel-operation-1',true,'changed input')).status,409);assert.equal((await upload(undefined,false)).status,200);assert.equal(calls,2);assert.ok(!JSON.stringify(f.db.prepare('SELECT * FROM muse_native_operations').all()).includes('private novel input'));
})

test('batch native inserts are captured before dispatch and async descendants retain resource ownership',{skip:!available},async t=>{
 const f=await fixture(t);let finish;const finished=new Promise(resolve=>finish=resolve);f.router.post('/characters/batch-generate-images',(req,res)=>{f.db.prepare("INSERT INTO async_tasks(id,type,status) VALUES('batch-task','fixture','pending')").run();setImmediate(()=>{f.db.prepare("INSERT INTO image_generations(drama_id,status,task_id) VALUES(1,'pending','batch-task')").run();finish()});res.json({success:true,data:{count:1}})});
 await(await f.post('/characters/batch-generate-images',{character_ids:[1]})).json();await finished;const result=await f.read('/fixture-operation-1');assert.equal(result.state,'accepted');assert.equal(result.resources.length,2);assert.equal(result.can_create_version,false);
})

test('native video route reserves before dispatch and replays original pointers across fresh UUIDs and terminals',{skip:!available},async t=>{
 const f=await fixture(t,{muse_jubian:{video_only:false}}),path=filename('backend-node/src/routes/videos.js'),taskPath=filename('backend-node/src/services/taskService.js'),taskService=compile(pristine(taskPath),taskPath,f.require);let calls=0;let finish;const done=new Promise(resolve=>finish=resolve);
 const native=compile(pristine(path),path,name=>name==='../response'?f.require(filename('backend-node/src/response.js')):name==='../services/taskService'?taskService:name==='../services/videoClient'?{normalizeAspectRatioForApi:value=>value,resolveVideoReferenceInputs:value=>value,resolveVideoSelection:()=>({provider:'fixture',model:'fixture'})}:name==='../services/videoService'?{getById:(_,id)=>f.db.prepare('SELECT id,task_id,status FROM video_generations WHERE id=?').get(id),processVideoGeneration:async(_,log,id)=>{calls++;assert.equal(f.db.prepare('SELECT state FROM muse_native_operations ORDER BY rowid DESC LIMIT 1').get().state,'accepted');f.db.prepare("UPDATE video_generations SET status='completed' WHERE id=?").run(id);const task=f.db.prepare('SELECT task_id FROM video_generations WHERE id=?').get(id).task_id;taskService.updateTaskResult(f.db,task,{});finish()}}:f.require(name));
 f.router.post('/videos',native(f.db,{info(){},error(){}}).create);const first=await f.post('/videos',{drama_id:1,storyboard_id:7,prompt:'private request text'}),body=await first.json();assert.equal(first.status,201);assert.ok(body.data.id);await done;
 const replay=await f.post('/videos',{prompt:'private request text',storyboard_id:7,drama_id:1});assert.deepEqual(await replay.json(),body);assert.equal(calls,1);
 const conflict=await f.post('/videos',{drama_id:1,storyboard_id:7,prompt:'private request text'},'after-login-new-uuid');const conflictBody=await conflict.json();assert.equal(conflict.status,409);assert.equal(conflictBody.error.operation_id,'fixture-operation-1');
 const state=await f.read('/fixture-operation-1');assert.equal(state.state,'completed');assert.equal(state.resources.length,2);assert.equal(state.supplier_usage,null);assert.equal(state.billing_verified,false);assert.ok(!state.receipt.body.includes('private request text'));
 const permission=f.service.nextVersion(f.db,f.cfg,'fixture-operation-1','explicit-version-2');assert.equal(permission.state,'authorized');assert.equal(f.service.nextVersion(f.db,f.cfg,'fixture-operation-1','explicit-version-2').operation_id,'explicit-version-2');
 const second=await f.post('/videos',{drama_id:1,storyboard_id:7,prompt:'private request text'},'explicit-version-2');assert.equal(second.status,201);await second.json();assert.equal((await f.read('/explicit-version-2')).state,'completed');assert.equal(calls,2);
})

test('unknown outcomes block a new UUID and version permission even after cache loss',{skip:!available},async t=>{
 const f=await fixture(t);let calls=0;f.router.post('/images',(req,res)=>{calls++;res.status(400).json({success:false,error:{message:'private upstream key=should-not-persist'}})});
 assert.equal((await f.post('/images',{prompt:'do not store request'})).status,400);assert.equal((await f.read('/fixture-operation-1')).state,'unknown');
 let message;for(const id of ['fixture-operation-1','new-login-operation']){const response=await f.post('/images',{prompt:'do not store request'},id);assert.equal(response.status,409);message=(await response.json()).error.message}assert.equal(calls,1);
 assert.throws(()=>f.service.nextVersion(f.db,f.cfg,'fixture-operation-1','blind-new-version'),/reconciliation/);
 const row=f.db.prepare('SELECT * FROM muse_native_operations').get();assert.equal(row.receipt,null);assert.ok(!JSON.stringify(row).includes('do not store request'));assert.ok(!JSON.stringify(row).includes('private upstream'));
 const state=await f.read('/fixture-operation-1');assert.deepEqual({state:state.state,request_replayed:calls>1,new_uuid_rejected:true,new_version_permitted:state.can_create_version,supplier_usage:state.supplier_usage,usage_status:state.usage_status,billing_verified:state.billing_verified,message},JSON.parse(readFileSync(new URL('./expected/muse-admission.json',import.meta.url),'utf8')));
})

test('database reservations fail before paid handlers and an unsaved result never reports success',{skip:!available},async t=>{
 const f=await fixture(t);let calls=0;f.router.post('/generation/story',(req,res)=>{calls++;res.json({success:true,data:{episodes:['generated result']}})});
 f.db.exec("CREATE TRIGGER stop_admission BEFORE INSERT ON muse_native_operations BEGIN SELECT RAISE(ABORT,'fixture_reservation_failure'); END;");assert.equal((await f.post('/generation/story',{})).status,503);assert.equal(calls,0);f.db.exec('DROP TRIGGER stop_admission');
 f.db.exec("CREATE TRIGGER stop_receipt BEFORE UPDATE OF receipt ON muse_native_operations BEGIN SELECT RAISE(ABORT,'fixture_receipt_failure'); END;");const response=await f.post('/generation/story',{});assert.equal((await response.json()).success,false);assert.equal(calls,1);assert.equal((await f.read('/fixture-operation-1')).state,'unknown');assert.equal((await f.post('/generation/story',{})).status,409);assert.equal(calls,1);
})

test('lost HTTP acknowledgement stays busy and later original completion is reconciled without redispatch',{skip:!available},async t=>{
 const f=await fixture(t);let calls=0,started,finish;const pending=new Promise(resolve=>started=resolve),complete=new Promise(resolve=>finish=resolve);f.router.post('/generation/story',async(req,res)=>{calls++;started();await complete;res.json({success:true,data:{episodes:['original completed result']}})});
 const parsed=new URL(f.url);const request=http.request({hostname:parsed.hostname,port:parsed.port,path:'/api/v1/generation/story',method:'POST',headers:{'Content-Type':'application/json','x-muse-operation-id':'fixture-operation-1'}},()=>{});request.on('error',()=>{});request.end('{}');await pending;request.destroy();
 await new Promise(resolve=>setImmediate(resolve));assert.equal(f.service.getActiveOperationCount(f.db),1);assert.equal((await f.post('/generation/story',{},'new-uuid-after-disconnect')).status,409);finish();
 let state;for(let n=0;n<30;n++){state=await f.read('/fixture-operation-1');if(state.state==='completed')break;await new Promise(resolve=>setImmediate(resolve))}assert.equal(state.state,'completed');assert.equal(f.service.getActiveOperationCount(f.db),0);assert.equal(calls,1);assert.ok(state.receipt.body.includes('original completed result'));
})

test('stream terminal output is released only after a durable receipt and failed persistence suppresses done',{skip:!available},async t=>{
 const f=await fixture(t);let calls=0;f.router.post('/storyboards/7/universal-segment-prompt-stream',(req,res)=>{calls++;res.type('application/x-ndjson');res.write(JSON.stringify({type:'delta',text:'generated delta'})+'\n');res.write(JSON.stringify({type:'done',universal_segment_text:'generated final'})+'\n');res.end()});
 const path='/storyboards/7/universal-segment-prompt-stream',response=await f.post(path,{}),text=await response.text();assert.match(text,/"type":"done"/);assert.equal((await f.read('/fixture-operation-1')).state,'completed');assert.equal(await(await f.post(path,{})).text(),text);assert.equal(calls,1);
 f.db.exec("CREATE TRIGGER stop_stream_receipt BEFORE UPDATE OF receipt ON muse_native_operations BEGIN SELECT RAISE(ABORT,'fixture_stream_commit_failure'); END;");const failed=await(await f.post(path,{new_input:true},'stream-new-operation')).text();assert.doesNotMatch(failed,/"type":"done"/);assert.match(failed,/"type":"error"/);assert.equal((await f.read('/stream-new-operation')).state,'unknown');
})

test('receipt limits are explicit and whole outputs are never truncated into successful receipts',{skip:!available},async t=>{
 const f=await fixture(t,{muse_admission:{max_receipt_bytes:1024}});f.router.post('/generation/story',(req,res)=>res.json({success:true,data:{story:'x'.repeat(1200)}}));const response=await f.post('/generation/story',{});assert.equal((await response.json()).success,false);assert.equal((await f.read('/fixture-operation-1')).state,'unknown');assert.equal(f.db.prepare('SELECT receipt FROM muse_native_operations').get().receipt,null);
 assert.throws(()=>f.service.schema(f.db,{muse_admission:{max_receipt_bytes:3}}),/receipt_limit/);
})

test('fresh process initialization marks an unfinished reservation unknown and excludes keys from fingerprints',{skip:!available},async t=>{
 const f=await fixture(t);const reservation=f.service.reserve(f.db,f.cfg,'interrupted-original','/images',{prompt:'same',api_key:'first-key'});assert.equal(reservation.dispatch,true);assert.equal(f.service.requestHash('/images',{api_key:'second-key',prompt:'same',operation_id:'different-id'}),reservation.row.request_sha256);
 const fresh=compile(f.source,filename('backend-node/src/services/museAdmission.js'),name=>name==='./museAdmissionCatalog.json'?museAdmissionRoutes:f.require(name));fresh.schema(f.db,f.cfg);assert.equal(fresh.info(f.db,f.db.prepare('SELECT * FROM muse_native_operations').get()).state,'unknown');assert.throws(()=>fresh.reserve(f.db,f.cfg,'new-process-uuid','/images',{prompt:'same'}),/reconciliation/);
 f.db.prepare('UPDATE muse_admission_schema SET version=2').run();const future=compile(f.source,filename('backend-node/src/services/museAdmission.js'),name=>name==='./museAdmissionCatalog.json'?museAdmissionRoutes:f.require(name));assert.throws(()=>future.schema(f.db,f.cfg),/unsupported_admission_schema/);
})

test('actual browser helper recovers the prior server operation after cache loss and cannot submit with failed storage',{skip:!available},async t=>{
 const f=await fixture(t);f.router.post('/images',(req,res)=>res.json({success:true,data:{id:12,status:'completed'}}));await(await f.post('/images',{prompt:'private stable input'})).json();
 const source=planned().get(filename('frontweb/src/utils/museAdmission.js')).replace(/^import .*\n/gm,'').replaceAll('export async function','async function').replaceAll('export function','function'),storage=new Map(),localStorage={getItem:key=>storage.get(key)??null,setItem:(key,value)=>storage.set(key,value)},context=createContext({catalog:museAdmissionRoutes,museStudioPath:value=>value,crypto:webcrypto,TextEncoder,Uint8Array,FormData,Blob,localStorage,fetch:(path,options)=>fetch(f.url+path,options)});runInContext(source,context);context.body={prompt:'private stable input'};
 const first=await runInContext("prepareMuseAdmission('/images','POST',body)",context);assert.equal(first['x-muse-operation-id'],'fixture-operation-1');storage.clear();const recovered=await runInContext("prepareMuseAdmission('/studio/api/v1/images','POST',body)",context);assert.equal(recovered['x-muse-operation-id'],'fixture-operation-1');assert.ok(!JSON.stringify([...storage]).includes('private stable input'));
 storage.clear();localStorage.setItem=()=>{throw Error('fixture storage unavailable')};await assert.rejects(runInContext("prepareMuseAdmission('/images','POST',body)",context),/storage unavailable/);
})

test('real JSON and SSE suppliers retain reported usage once per call without inferred totals or secret payloads',{skip:!available},async t=>{
 const f=await fixture(t);const supplier=http.createServer((req,res)=>{if(req.url==='/stream'){res.writeHead(200,{'Content-Type':'text/event-stream'});for(const item of [{choices:[{delta:{content:'text'}}],usage:{prompt_tokens:3,total_tokens:5}},{choices:[],usage:{prompt_tokens:12,completion_tokens:4,total_tokens:16}},{choices:[]}])res.write('data: '+JSON.stringify(item)+'\n\n');res.end('data: [DONE]\n\n')}else res.end(JSON.stringify({choices:[{message:{content:'generated answer'}}],usage:{prompt_tokens:7,completion_tokens:0},api_key:'provider-private-fixture'}))});await new Promise(resolve=>supplier.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>supplier.close(resolve)));const supplierUrl=`http://127.0.0.1:${supplier.address().port}`;
 const path=filename('backend-node/src/services/aiClient.js'),source=planned().get(path)+"\nmodule.exports.fixture={postJSONNonStream,postJSONWithTimeout,postJSONStream};\n",client=compile(source,path,name=>name==='./museAdmission'?f.service:name.startsWith('.')?{}:f.require(name)).fixture;
 f.router.post('/generation/story',async(req,res)=>{const result=await client.postJSONNonStream(supplierUrl+'/json',{},{});res.json({success:true,data:{story:result.body}})});
 f.router.post('/storyboards/7/universal-segment-prompt-stream',async(req,res)=>{const result=await client.postJSONStream(supplierUrl+'/stream',{},{});res.type('application/x-ndjson');res.write(JSON.stringify({type:'done',universal_segment_text:result.body})+'\n');res.end()});
 await(await f.post('/generation/story',{})).json();let state=await f.read('/fixture-operation-1');assert.equal(state.supplier_usage.length,1);assert.equal(state.supplier_usage[0].usage.prompt_tokens,7);assert.equal(state.supplier_usage[0].usage.completion_tokens,0);assert.equal(state.supplier_usage[0].usage.total_tokens,null);assert.ok(!JSON.stringify(state).includes('provider-private-fixture'));
 await(await f.post('/storyboards/7/universal-segment-prompt-stream',{},'stream-usage-operation')).text();state=await f.read('/stream-usage-operation');assert.equal(state.supplier_usage.length,1);assert.equal(state.supplier_usage[0].usage.total_tokens,16);assert.equal(state.supplier_usage[0].usage.prompt_tokens,12);assert.equal(state.supplier_usage[0].usage.output_tokens,null);
 f.db.exec("CREATE TRIGGER stop_usage BEFORE INSERT ON muse_native_supplier_usage BEGIN SELECT RAISE(ABORT,'fixture_usage_failure'); END;");await(await f.post('/generation/story',{another:true},'usage-persistence-failure')).json();state=await f.read('/usage-persistence-failure');assert.equal(state.supplier_usage,null);assert.equal(state.usage_health,'error');assert.equal(state.usage_status,'unreported');
})

test('resource usage attaches to the original video operation without ALS and replaces poll snapshots safely',{skip:!available},async t=>{
 const f=await fixture(t,{muse_jubian:{video_only:false}});f.service.reserve(f.db,f.cfg,'video-resource-original','/videos',{});f.db.prepare('INSERT INTO muse_native_operation_resources VALUES(?,?,?)').run('video-resource-original','video','42');
 f.service.reserve(f.db,f.cfg,'later-pointer-only','/videos',{another:true});f.db.prepare('INSERT INTO muse_native_operation_resources VALUES(?,?,?)').run('later-pointer-only','video','42');
 assert.equal(f.service.recordResourceUsage(f.db,'video',42,{usage:{completion_tokens:12,total_tokens:12}},'provider-original-task'),true);assert.equal(f.service.recordResourceUsage(f.db,'video',42,{usage:{completion_tokens:16,total_tokens:16}},'provider-original-task'),true);let rows=f.db.prepare('SELECT usage_json,operation_id FROM muse_native_supplier_usage').all();assert.equal(rows.length,1);assert.equal(rows[0].operation_id,'video-resource-original');assert.equal(JSON.parse(rows[0].usage_json).total_tokens,16);assert.equal(JSON.parse(rows[0].usage_json).input_tokens,null);
 assert.equal(f.service.recordResourceUsage(f.db,'video',42,{usage:{completion_tokens:0,total_tokens:0}},'provider-original-task'),true);assert.equal(f.service.recordResourceUsage(f.db,'video',42,{usage:{completion_tokens:0.5,total_tokens:Number.MAX_SAFE_INTEGER+1}},'provider-original-task'),false);assert.equal(f.service.recordResourceUsage(f.db,'video',42,{},'provider-original-task'),false);assert.equal(JSON.parse(f.db.prepare('SELECT usage_json FROM muse_native_supplier_usage').get().usage_json).total_tokens,0);
 f.db.exec("CREATE TRIGGER stop_resource_usage BEFORE INSERT ON muse_native_supplier_usage BEGIN SELECT RAISE(ABORT,'fixture resource usage failure'); END;");assert.equal(f.service.recordResourceUsage(f.db,'video',42,{usage:{total_tokens:17}},'provider-original-task'),false);const row=f.db.prepare('SELECT * FROM muse_native_operations WHERE operation_id=?').get('video-resource-original');assert.equal(f.service.info(f.db,row).usage_health,'error');assert.equal(f.service.info(f.db,row).supplier_usage[0].usage.total_tokens,0);
})

test('real Vue dialog, staged FilmCreate and browser stream helper compile',{skip:!available},()=>{
 const require=createRequire(filename('frontweb/package.json')),{parse,compileScript,compileTemplate,compileStyle}=require('@vue/compiler-sfc');for(const[path,source]of planned()){
  if(path.endsWith('.vue')){const{descriptor,errors}=parse(source,{filename:path});assert.deepEqual(errors,[]);const script=compileScript(descriptor,{id:'muse-admission'});assert.deepEqual(compileTemplate({source:descriptor.template.content,filename:path,id:'muse-admission',compilerOptions:{bindingMetadata:script.bindings}}).errors,[]);for(const style of descriptor.styles)assert.deepEqual(compileStyle({source:style.content,filename:path,id:'muse-admission',scoped:style.scoped}).errors,[]);}
  else if(path.endsWith('api/storyboards.js'))compileFunction(source.replace(/^import .*\n/gm,'').replaceAll('export const','const'),[],{filename:path});
 }
})

test('the complete audio, revisions, postproduction and admission UI builds at the studio prefix without publishing',{skip:!available},async t=>{
 const require=createRequire(filename('frontweb/package.json')),{build}=await import(pathToFileURL(join(dirname(require.resolve('vite/package.json')),'dist/node/index.js')).href),{default:vue}=await import(pathToFileURL(join(dirname(require.resolve('@vitejs/plugin-vue')),'index.mjs')).href),home=mkdtempSync(join(tmpdir(),'muse-admission-build-'));
 t.after(()=>{assert.ok(home.startsWith(resolve(tmpdir())+sep+'muse-admission-build-'));rmSync(home,{recursive:true,force:true,maxRetries:5,retryDelay:100})});
 cpSync(filename('frontweb/src'),join(home,'src'),{recursive:true});cpSync(filename('frontweb/public'),join(home,'public'),{recursive:true});symlinkSync(filename('frontweb/node_modules'),join(home,'node_modules'),process.platform==='win32'?'junction':'dir');writeFileSync(join(home,'package.json'),'{"type":"module"}\n');
 const changes=planned();for(const[path,source]of new Map([...before,...changes])){const name=relative(filename('frontweb'),path);if(name.startsWith('..'))continue;const target=join(home,name);mkdirSync(dirname(target),{recursive:true});writeFileSync(target,source)}
 await build({root:home,base:'/studio/',configFile:false,logLevel:'silent',plugins:[vue()],resolve:{alias:{'@':join(home,'src')}},build:{outDir:join(home,'dist')}});const html=readFileSync(join(home,'dist/index.html'),'utf8');assert.match(html,/src="\/studio\/assets\//);assert.match(html,/Muse · 制作平台/);
})

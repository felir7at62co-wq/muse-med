/** Host-reported CLI reservations and real decoded media imports using synthetic owners and no CLI/provider execution. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire,Module} from 'node:module';
import {createServer} from 'node:http';
import {createHash,randomUUID} from 'node:crypto';
import {existsSync,readFileSync} from 'node:fs';
import {mkdtemp,mkdir,rm,readFile,writeFile,readdir} from 'node:fs/promises';
import {join,resolve,dirname,basename} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {planMuseLibTvCli} from '../compatibility/muse-libtv-cli.mjs';
import {museAdmissionRoutes} from '../compatibility/muse-admission.mjs';

const backend=resolve(process.env.LOCALMINIDRAMA_SOURCE||'.local/localminidrama','backend-node'),available=existsSync(join(backend,'node_modules/better-sqlite3/package.json'));
const require=createRequire(join(backend,'package.json')),extension=name=>fileURLToPath(new URL('../extensions/'+name,import.meta.url)),sha=value=>createHash('sha256').update(value).digest('hex'),native=[];
const ffmpeg=process.env.FFMPEG_PATH||(process.platform==='win32'?join(backend,'tools/ffmpeg/ffmpeg.exe'):'ffmpeg'),ffprobe=process.env.FFPROBE_PATH||(process.platform==='win32'?resolve(process.env.LOCALAPPDATA||tmpdir(),'MuseLocalMiniDrama/studio/tools/ffmpeg/ffprobe.exe'):'ffprobe');
const mediaAvailable=available&&spawnSync(ffmpeg,['-version'],{windowsHide:true}).status===0&&spawnSync(ffprobe,['-version'],{windowsHide:true}).status===0;
// Synthetic 440 Hz mono tone encoded with libmp3lame; the deployed runtime only needs its MP3 decoder.
const mp3Tone=Buffer.from("/+MoxAAb8M5sGVkAAACo5bluW5blu+/8PxuHH8dhyHIch/IcjEbf9y2ds7d+f5DbLIBCoJlpmy6b8JusmmSXrh2XzDsOQ/kYpMPzr09PTh+oEDiwxwTficENQJn8Tgg6oEz+kEOX92IAGD+kEOnLh8EAxp/5cHwfD4IAgGEvMYAgEYDggFgF3zWv//MBgJME/+MoxBMe+dpkAZ2YAAHwKCBguEHd7x//8w3FQwOCs4uOYy3IKsXwOMTIAw8dCoFm9jbmGYCgYMgeJgcJhYkDZoAUCv/h+oXOhgEUkILB8Q5Isn//xWpDhzhliZHNHNKRFiLf//5iXS6ZF4vIl01UDX/4lCQdKlQcKHuNhsNRsPxyvb40lxW7MB//+vb3K2Cp/+MoxBojEYqyWZuQAJSAlNX//3XUHNppAUGQEqqXhVzr/8iQhQZAoDmE4ALAcEFiIekPYfr+XCKGhcLhoYFwgRuOSTSZATJP/ZBBkEGQQYmTJZMpLLqSy78EChwECjlnRKs6JfwwUnCk4VOgqVOhor/KThS5Fw0NCUaGhKNOiWpMQU1FMy4xMDCqqqqqqqqq/+MoxBAAAANIAcAAAKqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq","base64");
const listen=server=>new Promise(resolve=>server.listen(0,'127.0.0.1',()=>resolve('http://127.0.0.1:'+server.address().port)));
const canonical=value=>Array.isArray(value)?'['+value.map(canonical).join(',')+']':value&&typeof value==='object'?'{'+Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([key,child])=>JSON.stringify(key)+':'+canonical(child)).join(',')+'}':JSON.stringify(value),digest=value=>sha(canonical(value));
function capture(input,{type=input.service==='agent-task'?'audio':input.service,count=input.service==='agent-task'?2:Number(input.quantity)}={}){const node={nodeKey:input.node_id,type,data:{type:type==='storyboard'?'script':type,params:{model:input.model,count,prompt:input.prompt??''}}},model={modelKey:input.model,modelName:'Exact fixture model',schema:{properties:{count:[count]}}},references={edges:[],nodes:[]},value={protocol:'libtv-cli-input-v1',node_type:type,generation_count:count,node,node_sha256:digest(node),model,model_schema_sha256:digest(model),references,references_sha256:digest(references)};return {...input,model_schema_sha256:value.model_schema_sha256,node_snapshot_sha256:value.node_sha256,input_capture:value};}
function profile(service='image'){return {id:'cli-fixture-'+service,service,provider:'libtv-cli',model:'fixture-node-model',origin:'https://api.liblib.tv',currency:'CNY',reserve_minor:20,estimate_kind:service==='agent-task'?'operator-task-envelope':'per-dispatch-estimate',source:'operator-entered',effective_at:'2020-01-01T00:00:00.000Z',expires_at:'2099-01-01T00:00:00.000Z'};}
async function fixture(t,{config={}}={}){
 const home=await mkdtemp(join(tmpdir(),'muse-libtv-cli-')),storage=join(home,'storage'),connections=[],servers=[];await mkdir(storage);
 t.after(async()=>{for(const server of servers){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}for(const db of connections)if(db.open)db.close();assert.equal(dirname(resolve(home)),resolve(tmpdir()));assert.ok(basename(home).startsWith('muse-libtv-cli-'));await rm(home,{recursive:true,force:true,maxRetries:5,retryDelay:50});});
 const Database=require('better-sqlite3'),file=join(home,'tenant.db');const connect=()=>{const db=new Database(file),prepare=db.prepare.bind(db);db.prepare=(...args)=>{const statement=prepare(...args);native.push(statement);return statement;};connections.push(db);native.push(db);return db;},db=connect();db.exec(readFileSync(join(backend,'migrations/01_init.sql'),'utf8'));if(!db.prepare('PRAGMA table_info(storyboards)').all().some(value=>value.name==='image_url'))db.exec('ALTER TABLE storyboards ADD COLUMN image_url TEXT');db.exec("INSERT INTO dramas(id,title) VALUES(1,'CLI fixture'),(2,'Other fixture');INSERT INTO episodes(id,drama_id,episode_number) VALUES(1,1,1),(2,2,1);INSERT INTO storyboards(id,episode_id,storyboard_number) VALUES(1,1,1),(2,2,1)");
 const cfg={storage:{local_path:storage,base_url:'/studio/static'},muse_libtv_cli:{chunk_bytes:1024,...config},muse_budget:{currency:'CNY',prices:[profile('image'),profile('video'),profile('text'),profile('agent-task')]}},loaded=new Map();
 function load(name,fileName){if(loaded.has(name))return loaded.get(name);const path=join(backend,'src/services',name+'.js'),module=new Module(path);module.filename=path;module.require=key=>key==='./museAdmissionCatalog.json'?museAdmissionRoutes:key==='./museAdmission'?load('museAdmission','muse-admission.cjs'):key==='./museBudget'||key==='../services/museBudget'?load('museBudget','muse-budget.cjs'):key==='./musePostproductionMedia'?load('musePostproductionMedia','muse-postproduction-media.cjs'):key==='./museLibTvAudio'?load('museLibTvAudio','muse-libtv-audio.cjs'):key==='./museLibTvCliMedia'?load('museLibTvCliMedia','muse-libtv-cli-media.cjs'):key==='../services/museLibTvCli'?load('museLibTvCli','muse-libtv-cli.cjs'):key==='../utils/ffmpegPath'?{getFfmpegPath:()=>ffmpeg,getFfprobePath:()=>ffprobe}:require(key);module._compile(readFileSync(extension(fileName),'utf8'),path);loaded.set(name,module.exports);return module.exports;}
 const service=load('museLibTvCli','muse-libtv-cli.cjs'),budget=load('museBudget','muse-budget.cjs'),databaseId=service.schema(db,cfg);budget.updateProject(db,cfg,1,{operation_id:'authorize-cli-project',expected_revision:0,currency:'CNY',limit_minor:100,allow_estimates:true,allow_task_envelopes:false});
 const input=capture({database_id:databaseId,operation_id:'cli-fixture-operation',project_id:1,storyboard_id:1,request_sha256:sha('fixed synthetic request'),cli_owner:{user_uuid:'fixture-cli-user',account_id:'fixture-cli-account',team_id:null},project_uuid:'fixture-remote-project',node_id:'fixture-remote-node',model:'fixture-node-model',service:'image',quantity:2,prompt:'Synthetic CLI generation',reference_sha256s:[]});
 const status=(state,result={})=>service.status(db,cfg,input.operation_id,{database_id:databaseId,request_sha256:input.request_sha256,state,result});
 const photo=await require('sharp')({create:{width:64,height:64,channels:3,background:'#345678'}}).png().toBuffer();
 function upload(bytes,{kind='image',mediaType='image/png',digest=sha(bytes),resultId,operation=input.operation_id,requestHash=input.request_sha256}={}){let result;const count=Math.ceil(bytes.length/cfg.muse_libtv_cli.chunk_bytes);for(let index=count-1;index>=0;index--){const part=bytes.subarray(index*cfg.muse_libtv_cli.chunk_bytes,Math.min(bytes.length,(index+1)*cfg.muse_libtv_cli.chunk_bytes));result=service.chunk(db,cfg,operation,{database_id:databaseId,request_sha256:requestHash,sha256:digest,kind,media_type:mediaType,total_bytes:bytes.length,total_chunks:count,index,chunk_sha256:sha(part),data_base64:part.toString('base64'),...resultId===undefined?{}:{result_id:resultId}});}return result;}
 const importMedia=(bytes,{kind='image',resultId,operationId=randomUUID(),storyboardId=1,digest=sha(bytes)}={})=>service.importResult(db,cfg,input.operation_id,{database_id:databaseId,request_sha256:input.request_sha256,operation_id:operationId,sha256:digest,kind,storyboard_id:storyboardId,...resultId===undefined?{}:{result_id:resultId}});
 async function http(){const express=require('express'),app=express(),router=express.Router();app.use(express.json({limit:'10mb'}));load('museAdmission','muse-admission.cjs').register(router,db,cfg);load('museBudgetRoutes','muse-budget-routes.cjs').register(router,db,cfg);load('museLibTvCliRoutes','muse-libtv-cli-routes.cjs').register(router,db,cfg);app.use('/api/v1',router);const server=createServer(app);servers.push(server);const origin=await listen(server);return async(path,body)=>{const response=await fetch(origin+'/api/v1'+(path.startsWith('/muse/')?path:'/muse/libtv-cli'+path),{method:body===undefined?'GET':'POST',headers:{'content-type':'application/json'},...body===undefined?{}:{body:JSON.stringify(body)}});return {status:response.status,value:await response.json()};};}
 return {home,storage,db,cfg,service,budget,input,databaseId,status,photo,upload,importMedia,connect,http,loaded,load};
}

test('a CLI reservation snapshots exact owner/node/model/count, reserves once and blocks unresolved node reuse',{skip:!available},async t=>{
 const f=await fixture(t),first=f.service.reserve(f.db,f.cfg,f.input);assert.equal(first.dispatch_allowed,true);assert.equal(first.operation.quantity,2);assert.equal(first.operation.model_schema_sha256,f.input.model_schema_sha256);assert.equal(first.operation.node_snapshot_sha256,f.input.node_snapshot_sha256);assert.throws(()=>f.service.reserve(f.db,f.cfg,{...f.input,node_snapshot_sha256:'bad'}),{code:'libtv_cli_invalid_metadata_sha'});assert.equal(first.operation.budget.reserved_minor,40);assert.equal(first.operation.budget.billing_verified,false);assert.equal(f.service.reserve(f.db,f.cfg,f.input).dispatch_allowed,false);assert.equal(f.budget.readProject(f.db,f.cfg,1).reserved_minor,40);
 assert.throws(()=>f.service.reserve(f.db,f.cfg,{...f.input,operation_id:'different-cli-operation',request_sha256:sha('different prompt')}),{code:'libtv_cli_original_node_unresolved'});assert.throws(()=>f.service.reserve(f.db,f.cfg,{...f.input,cli_owner:{...f.input.cli_owner,account_id:'another-cli-login'}}),{code:'libtv_cli_operation_changed'});assert.throws(()=>f.service.reserve(f.db,f.cfg,{...f.input,database_id:'another-database'}),{code:'libtv_cli_database_changed'});
});

test('HTTP CLI receipts retain 69 LibTV credits, replay once and reject exceeding 100 credits',{skip:!available},async t=>{
 const f=await fixture(t),call=await f.http();
 for(const [service,amount] of [['image',900],['video',5000],['agent-task',100]])f.cfg.muse_budget.prices.push({...profile(service),id:'credit-'+service,model:'credit-'+service,currency:'LTV',reserve_minor:amount});
 f.budget.updateProject(f.db,f.cfg,2,{operation_id:'authorize-credit-project',expected_revision:0,currency:'LTV',limit_minor:10000,allow_estimates:true,allow_task_envelopes:true});
 const jobs=['image','image','video','agent-task'].map((service,index)=>capture({...f.input,project_id:2,storyboard_id:2,operation_id:'credit-operation-'+index,request_sha256:sha('credit-operation-'+index),node_id:'credit-node-'+index,model:'credit-'+service,service,quantity:1},{type:service==='agent-task'?'audio':service,count:1}));
 for(const job of jobs){const reply=await call('/operations/reserve',job);assert.equal(reply.status,200);assert.equal(reply.value.data.dispatch_allowed,true);assert.equal(reply.value.data.operation.budget.currency,'LTV');assert.equal(reply.value.data.operation.input_capture.state,'captured');}
 const replay=await call('/operations/reserve',jobs[0]);assert.equal(replay.status,200);assert.equal(replay.value.data.dispatch_allowed,false);
 const totals=await call('/muse/budget/projects/2');assert.equal(totals.value.data.currency,'LTV');assert.equal(totals.value.data.reserved_minor,6900);assert.equal(totals.value.data.available_minor,3100);assert.equal(f.budget.readProject(f.db,f.cfg,1).reserved_minor,0);
 const tooMuch=capture({...jobs[2],operation_id:'credit-over-limit',request_sha256:sha('credit-over-limit'),node_id:'credit-over-limit-node'}),denied=await call('/operations/reserve',tooMuch);assert.equal(denied.status,402);assert.equal(denied.value.error.code,'budget_limit_exceeded');
 assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM muse_libtv_cli_operations').get().count,4);assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM muse_budget_entries').get().count,4);assert.equal(f.budget.readProject(f.db,f.cfg,2).reserved_minor,6900);
 const original=await call('/operations/'+jobs[0].operation_id);assert.deepEqual(original.value.data.input_capture.value,jobs[0].input_capture);assert.equal(original.value.data.budget.currency,'LTV');assert.equal(original.value.data.budget.reserved_minor,900);
 await call('/operations/'+jobs[0].operation_id+'/status',{database_id:f.databaseId,request_sha256:jobs[0].request_sha256,state:'completed',result:{synthetic:true}});const first=f.budget.ledger(f.db,f.cfg,2).items.find(item=>item.operation_id===jobs[0].operation_id);const settled=f.budget.reconcile(f.db,f.cfg,first.entry_id,{operation_id:'credit-first-invoice',expected_revision:first.revision,amount_minor:900,source:'operator-confirmed-invoice',reference:'Synthetic nine-credit receipt',final_invoice_confirmed:true});assert.equal(settled.entry.profile.currency,'LTV');assert.equal(settled.project.settled_minor,900);assert.equal(settled.project.reserved_minor,6000);assert.equal(settled.project.available_minor,3100);
});

test('an authorized per-run ceiling rolls back both reservations after a quote-to-reserve price increase',{skip:!available},async t=>{
 const f=await fixture(t),cap=40;
 const spec={project_id:f.input.project_id,service:f.input.service,provider:'libtv-cli',model:f.input.model,origin:'https://api.liblib.tv',quantity:f.input.quantity};
 assert.equal(f.budget.quote(f.db,f.cfg,spec).reserved_minor,cap);
 const price=f.cfg.muse_budget.prices.find(item=>item.service===f.input.service&&item.model===f.input.model);assert.ok(price);price.reserve_minor=30;
 assert.equal(f.service.capabilities(f.db,f.cfg).reservation_limit_version,1);
 assert.throws(()=>f.service.reserve(f.db,f.cfg,{...f.input,max_reserved_minor:cap}),{code:'libtv_cli_reservation_limit_changed'});
 assert.equal(f.budget.readProject(f.db,f.cfg,1).reserved_minor,0);
 for(const table of ['muse_budget_entries','muse_libtv_cli_operations','muse_libtv_cli_inputs'])assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM '+table).get().n,0);
 for(const value of [0,-1,true,'40',Number.MAX_SAFE_INTEGER+1])assert.throws(()=>f.service.reserve(f.db,f.cfg,{...f.input,max_reserved_minor:value}),{code:'libtv_cli_invalid_reservation_limit'});
 price.reserve_minor=20;
 const accepted=f.service.reserve(f.db,f.cfg,{...f.input,max_reserved_minor:cap});assert.equal(accepted.dispatch_allowed,true);assert.equal(accepted.operation.max_reserved_minor,cap);
 assert.throws(()=>f.service.reserve(f.db,f.cfg,{...f.input,max_reserved_minor:cap+1}),{code:'libtv_cli_operation_changed'});
});

test('advanced CLI envelopes preserve exact canvas inputs and block overlapping unresolved commands',{skip:!available},async t=>{
 const f=await fixture(t),kind='video_hd',node={nodeKey:f.input.node_id,data:{type:'video',url:['https://fixture.invalid/original.mp4']}},other={nodeKey:'other-node',data:{type:'image'}},metadata={models:[{modelKey:'hd-model',modelName:'HD model'}]},snapshot={project:{nodes:[{id:node.nodeKey},{id:other.nodeKey}],edges:[]},nodes:[node,other]},spec={kind,project_uuid:f.input.project_uuid,node_id:node.nodeKey,model_name:'HD model'},inputCapture={protocol:'libtv-cli-advanced-input-v1',command_kind:kind,spec,snapshot,snapshot_sha256:digest(snapshot),node,node_sha256:digest(node),metadata,metadata_sha256:digest(metadata),budget_model:'advanced:'+kind,service:'agent-task',quantity:1};
 const input={...f.input,operation_id:'advanced-envelope-original',model:'advanced:'+kind,service:'agent-task',quantity:1,prompt:'',input_capture:inputCapture,node_snapshot_sha256:digest(node),model_schema_sha256:digest(metadata)};
 f.cfg.muse_budget.prices.push({...profile('agent-task'),id:'advanced-hd-profile',model:input.model});
 assert.equal(f.service.capabilities(f.db,f.cfg).advanced_capture_version,1);
 assert.throws(()=>f.service.reserve(f.db,f.cfg,input),{code:'budget_task_envelope_not_authorized'});
 f.budget.updateProject(f.db,f.cfg,1,{operation_id:'accept-advanced-envelope',expected_revision:1,currency:'CNY',limit_minor:100,allow_estimates:true,allow_task_envelopes:true});
 const invalid=structuredClone(input);invalid.input_capture.snapshot.nodes[0].data.url=['https://fixture.invalid/changed.mp4'];assert.throws(()=>f.service.reserve(f.db,f.cfg,invalid),{code:'libtv_cli_advanced_sha_changed'});
 const result=f.service.reserve(f.db,f.cfg,input);assert.equal(result.dispatch_allowed,true);assert.deepEqual(result.operation.input_capture.value,inputCapture);assert.equal(f.service.reserve(f.db,f.cfg,input).dispatch_allowed,false);
 const overlapping=capture({...f.input,operation_id:'overlapping-child-operation',node_id:other.nodeKey,request_sha256:sha('overlapping child')});assert.throws(()=>f.service.reserve(f.db,f.cfg,overlapping),{code:'libtv_cli_original_node_unresolved'});
 f.db.close();const reopened=f.connect();f.service.schema(reopened,f.cfg);assert.deepEqual(f.service.get(reopened,f.cfg,input.operation_id).input_capture.value,inputCapture);assert.equal(f.service.get(reopened,f.cfg,input.operation_id).state,'unknown');
});

test('unknown CLI runs retain reservations across a real reopen and cannot be reset or charged by replay',{skip:!available},async t=>{
 const f=await fixture(t);f.service.reserve(f.db,f.cfg,f.input);f.status('unknown',{reason:'fixture acknowledgement lost'});f.db.close();const reopened=f.connect();f.service.schema(reopened,f.cfg);f.budget.schema(reopened,f.cfg);const replay=f.service.reserve(reopened,f.cfg,f.input);assert.equal(replay.dispatch_allowed,false);assert.equal(replay.operation.state,'unknown');assert.equal(f.budget.readProject(reopened,f.cfg,1).reserved_minor,40);assert.equal(f.budget.ledger(reopened,f.cfg,1).items[0].source,'libtv-cli');assert.equal(f.budget.ledger(reopened,f.cfg,1).items[0].outcome,'unknown');
 assert.throws(()=>f.service.status(reopened,f.cfg,f.input.operation_id,{database_id:f.databaseId,request_sha256:sha('changed run'),state:'completed',result:{}}),{code:'libtv_cli_request_changed'});
});

test('operator review releases only unknown admission, retains its immutable history and spending hold, and permits an independent later run',{skip:!available},async t=>{
 const f=await fixture(t);f.service.reserve(f.db,f.cfg,f.input);assert.equal(f.service.capabilities(f.db,f.cfg).review_version,1);
 const request={database_id:f.databaseId,request_sha256:f.input.request_sha256,result_sha256:digest({}),cli_owner:f.input.cli_owner,review_id:'operator-reviewed-once',note:'Checked original supplier and stopped its local command.',acknowledge_no_running_task:true,acknowledge_unverified_outcome:true,acknowledge_budget_hold_retained:true};
 assert.throws(()=>f.service.review(f.db,f.cfg,f.input.operation_id,request),{code:'libtv_cli_review_not_unknown'});
 f.status('unknown');assert.throws(()=>f.service.review(f.db,f.cfg,f.input.operation_id,{...request,result_sha256:'a'.repeat(64)}),{code:'libtv_cli_review_stale'});
 assert.throws(()=>f.service.review(f.db,f.cfg,f.input.operation_id,{...request,acknowledge_unverified_outcome:false}),{code:'libtv_cli_review_acknowledgement_required'});
 assert.throws(()=>f.service.review(f.db,f.cfg,f.input.operation_id,{...request,cli_owner:{...request.cli_owner,account_id:'wrong-owner'}}),{code:'libtv_cli_owner_changed'});
 const before=f.budget.readProject(f.db,f.cfg,1),reviewed=f.service.review(f.db,f.cfg,f.input.operation_id,request);
 assert.equal(reviewed.state,'unknown');assert.equal(reviewed.review.admission_released,true);assert.equal(reviewed.review.budget_hold_retained,true);assert.equal(reviewed.review.supplier_outcome,'unverified');assert.deepEqual(f.budget.readProject(f.db,f.cfg,1),before);
 assert.deepEqual(f.service.review(f.db,f.cfg,f.input.operation_id,request),reviewed);assert.throws(()=>f.service.review(f.db,f.cfg,f.input.operation_id,{...request,note:'changed'}),{code:'libtv_cli_review_changed'});
 assert.throws(()=>f.db.prepare('UPDATE muse_libtv_cli_reviews SET note=?').run('changed'),/libtv_cli_review_immutable/);assert.throws(()=>f.db.prepare('DELETE FROM muse_libtv_cli_reviews').run(),/libtv_cli_review_retained/);
 const later=capture({...f.input,operation_id:'independent-later-run',request_sha256:sha('independent request')});assert.equal(f.service.reserve(f.db,f.cfg,later).dispatch_allowed,true);assert.equal(f.budget.readProject(f.db,f.cfg,1).reserved_minor,80);
 assert.throws(()=>f.service.status(f.db,f.cfg,f.input.operation_id,{database_id:f.databaseId,request_sha256:f.input.request_sha256,state:'completed',result:{late:true}}),{code:'libtv_cli_reviewed_status_refused'});assert.equal(f.service.get(f.db,f.cfg,f.input.operation_id).state,'unknown');assert.equal(f.budget.readProject(f.db,f.cfg,1).reserved_minor,80);
 f.db.close();const reopened=f.connect();f.service.schema(reopened,f.cfg);assert.equal(reopened.prepare('SELECT version FROM muse_libtv_cli_schema').get().version,3);assert.deepEqual(f.service.get(reopened,f.cfg,f.input.operation_id).review,reviewed.review);
});

test('an already settled unknown operation can release admission without inventing a remaining monetary hold',{skip:!available},async t=>{
 const f=await fixture(t);f.service.reserve(f.db,f.cfg,f.input);f.status('unknown');f.budget.outcome(f.db,f.cfg,'libtv-cli',f.input.operation_id,'operator-confirmed');
 const entry=f.budget.ledger(f.db,f.cfg,1).items[0];f.budget.reconcile(f.db,f.cfg,entry.entry_id,{operation_id:'settled-before-review',expected_revision:entry.revision,amount_minor:35,reference:'verified operator invoice',source:'operator-confirmed-invoice',final_invoice_confirmed:true});
 const before=f.budget.readProject(f.db,f.cfg,1),reviewed=f.service.review(f.db,f.cfg,f.input.operation_id,{database_id:f.databaseId,request_sha256:f.input.request_sha256,result_sha256:digest({}),cli_owner:f.input.cli_owner,review_id:'settled-operation-review',note:'Checked original task after invoice reconciliation.',acknowledge_no_running_task:true,acknowledge_unverified_outcome:true,acknowledge_budget_hold_retained:true});
 assert.equal(reviewed.state,'unknown');assert.equal(reviewed.review.admission_released,true);assert.equal(reviewed.review.budget_unchanged,true);assert.equal(reviewed.review.budget_hold_retained,false);assert.deepEqual(f.budget.readProject(f.db,f.cfg,1),before);assert.equal(before.settled_minor,35);assert.equal(before.reserved_minor,0);
});

test('new CLI reservations require complete actual input captures and retain them across reopen',{skip:!available},async t=>{
 const f=await fixture(t),call=await f.http(),missing={...f.input};delete missing.input_capture;assert.equal((await call('/operations/reserve',missing)).value.error.code,'libtv_cli_input_capture_required');assert.equal((await call('/operations/reserve',{...f.input,prompt:'a different claimed prompt'})).value.error.code,'libtv_cli_input_capture_required');assert.equal((await call('/operations/reserve',{...f.input,input_capture:{...f.input.input_capture,node_sha256:'a'.repeat(64)}})).value.error.code,'libtv_cli_input_sha_changed');assert.equal(f.budget.readProject(f.db,f.cfg,1).reserved_minor,0);
 const accepted=f.service.reserve(f.db,f.cfg,f.input);assert.equal(accepted.operation.input_capture.state,'captured');assert.deepEqual(accepted.operation.input_capture.value,f.input.input_capture);assert.throws(()=>f.db.prepare('UPDATE muse_libtv_cli_inputs SET capture_json=?').run('{}'),/libtv_cli_capture_immutable/);assert.throws(()=>f.db.prepare('DELETE FROM muse_libtv_cli_inputs').run(),/libtv_cli_capture_retained/);f.db.close();const reopened=f.connect();f.service.schema(reopened,f.cfg);assert.deepEqual(f.service.get(reopened,f.cfg,f.input.operation_id).input_capture,accepted.operation.input_capture);
});

test('CLI display names retain their discovered stable model keys and exact schema',{skip:!available},async t=>{
 const f=await fixture(t),input=structuredClone(f.input),value=input.input_capture;
 value.node.data.params.model='Fixture image fast';value.node_sha256=digest(value.node);input.node_snapshot_sha256=value.node_sha256;
 value.model.modelName=input.model;value.model_schema_sha256=digest(value.model);input.model_schema_sha256=value.model_schema_sha256;
 value.model_execution_name='Fixture image fast';value.model_discovery={nodeType:'image',matches:[{modelKey:input.model,modelName:value.model_execution_name}]};value.model_discovery_sha256=digest(value.model_discovery);
 const saved=f.service.reserve(f.db,f.cfg,input);assert.equal(f.service.capabilities(f.db,f.cfg).model_discovery_version,1);
 assert.equal(saved.operation.model,input.model);assert.equal(saved.operation.input_capture.value.node.data.params.model,'Fixture image fast');assert.deepEqual(saved.operation.input_capture.value.model,value.model);assert.deepEqual(saved.operation.input_capture.value.model_discovery,value.model_discovery);
 assert.equal(f.service.reserve(f.db,f.cfg,input).dispatch_allowed,false);assert.equal(f.budget.readProject(f.db,f.cfg,1).reserved_minor,40);
});

test('video nodes may store the stable key while their CLI creation uses the discovered display name',{skip:!available},async t=>{
 const f=await fixture(t),input=capture({...f.input,service:'video'}),value=input.input_capture;
 value.model_execution_name='Fixture video fast';value.model_discovery={matches:[{modelKey:input.model,modelName:value.model_execution_name}]};value.model_discovery_sha256=digest(value.model_discovery);
 const saved=f.service.reserve(f.db,f.cfg,input);assert.equal(saved.operation.input_capture.value.node.data.params.model,input.model);assert.equal(saved.operation.input_capture.value.model_execution_name,'Fixture video fast');assert.equal(saved.operation.input_capture.value.node_sha256,value.node_sha256);
});

test('CLI model discovery refuses changed hashes, ambiguous names and unrelated model keys before reservation',{skip:!available},async t=>{
 const f=await fixture(t),input=structuredClone(f.input),value=input.input_capture;
 value.node.data.params.model='Fixture image fast';value.node_sha256=digest(value.node);input.node_snapshot_sha256=value.node_sha256;
 value.model_execution_name='Fixture image fast';value.model_discovery={matches:[{modelKey:input.model,modelName:value.model_execution_name}]};value.model_discovery_sha256=digest(value.model_discovery);
 const invalid=[
  changed=>{delete changed.model_discovery;},
  changed=>{changed.model_discovery_sha256='f'.repeat(64);},
  changed=>{changed.model_execution_name='Another name';},
  changed=>{changed.model_discovery.matches[0].modelKey='other-key';changed.model_discovery_sha256=digest(changed.model_discovery);},
  changed=>{changed.model_discovery.matches.push({...changed.model_discovery.matches[0]});changed.model_discovery_sha256=digest(changed.model_discovery);},
  changed=>{changed.model_discovery.matches.push({...changed.model_discovery.matches[0],modelKey:'other-key'});changed.model_discovery_sha256=digest(changed.model_discovery);},
  changed=>{changed.model_discovery.models=changed.model_discovery.matches;changed.model_discovery_sha256=digest(changed.model_discovery);},
 ];
 for(const mutate of invalid){const candidate=structuredClone(input);mutate(candidate.input_capture);assert.throws(()=>f.service.reserve(f.db,f.cfg,candidate),{code:'libtv_cli_input_capture_required'});assert.equal(f.budget.readProject(f.db,f.cfg,1).reserved_minor,0);}
 assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM muse_libtv_cli_operations').get().n,0);
});

test('audio models without count preserve an unknown output count inside one authorized task',{skip:!available},async t=>{
 const f=await fixture(t),input=capture({...f.input,service:'agent-task',quantity:1},{type:'audio',count:1}),value=input.input_capture;
 delete value.node.data.params.count;delete value.model.schema.properties.count;value.generation_count=null;value.count_source='implicit-task';value.node_sha256=digest(value.node);value.model_schema_sha256=digest(value.model);input.node_snapshot_sha256=value.node_sha256;input.model_schema_sha256=value.model_schema_sha256;
 assert.throws(()=>f.service.reserve(f.db,f.cfg,input),{code:'budget_task_envelope_not_authorized'});
 f.budget.updateProject(f.db,f.cfg,1,{operation_id:'authorize-implicit-audio',expected_revision:1,currency:'CNY',limit_minor:100,allow_estimates:true,allow_task_envelopes:true});
 const saved=f.service.reserve(f.db,f.cfg,input);assert.equal(f.service.capabilities(f.db,f.cfg).audio_task_capture_version,1);assert.equal(saved.operation.quantity,1);assert.equal(saved.operation.input_capture.value.generation_count,null);assert.equal(saved.operation.input_capture.value.count_source,'implicit-task');assert.equal(Object.hasOwn(saved.operation.input_capture.value.node.data.params,'count'),false);
 const second={...structuredClone(input),operation_id:'audio-cli-default-count',node_id:'audio-second-node',request_sha256:sha('audio-cli-default-count')};second.input_capture.node.nodeKey=second.node_id;second.input_capture.node.data.params.count=1;second.input_capture.node_sha256=digest(second.input_capture.node);second.node_snapshot_sha256=second.input_capture.node_sha256;const recorded=f.service.reserve(f.db,f.cfg,second);assert.equal(recorded.operation.input_capture.value.generation_count,null);assert.equal(recorded.operation.input_capture.value.node.data.params.count,1);
});

test('implicit audio count cannot replace declared counts or apply to image generation',{skip:!available},async t=>{
 const f=await fixture(t),input=capture({...f.input,service:'agent-task',quantity:1},{type:'audio',count:1}),value=input.input_capture;
 delete value.node.data.params.count;delete value.model.schema.properties.count;value.generation_count=null;value.count_source='implicit-task';
 const invalid=[
  changed=>{delete changed.count_source;},
  changed=>{changed.generation_count=1;},
  changed=>{changed.node.data.params.count=2;},
  changed=>{changed.model.schema.properties.count=[1];},
  changed=>{changed.node_type='image';changed.node.data.type='image';},
 ];
 for(const mutate of invalid){const candidate=structuredClone(input);mutate(candidate.input_capture);candidate.input_capture.node_sha256=digest(candidate.input_capture.node);candidate.input_capture.model_schema_sha256=digest(candidate.input_capture.model);candidate.node_snapshot_sha256=candidate.input_capture.node_sha256;candidate.model_schema_sha256=candidate.input_capture.model_schema_sha256;assert.throws(()=>f.service.reserve(f.db,f.cfg,candidate),{code:'libtv_cli_input_capture_required'});assert.equal(f.budget.readProject(f.db,f.cfg,1).reserved_minor,0);}
});

test('original reference snapshots reject changed identities and follow the exact imported native version',{skip:!available},async t=>{
 const f=await fixture(t),input=capture(f.input),source={nodeKey:'reference-a',data:{type:'image',url:['https://fixture.invalid/reference.png']}},references={edges:[{source:source.nodeKey,target:input.node_id}],nodes:[{node_id:source.nodeKey,node_sha256:digest(source),node:source,media_sha256:null}]};input.input_capture.references=references;input.input_capture.references_sha256=digest(references);const changed=structuredClone(input);changed.input_capture.references.nodes[0].node_id='another-reference';changed.input_capture.references_sha256=digest(changed.input_capture.references);assert.throws(()=>f.service.reserve(f.db,f.cfg,changed),{code:'libtv_cli_reference_capture_changed'});assert.equal(f.budget.readProject(f.db,f.cfg,1).reserved_minor,0);f.service.reserve(f.db,f.cfg,input);f.upload(f.photo);const imported=await f.importMedia(f.photo);assert.deepEqual(f.service.generationOrigin(f.db,'image',imported.generation_id).input_capture.value.references,references);
});

test('script and storyboard preserve text results while audio requires an explicit whole-task budget',{skip:!available},async t=>{
 for(const type of ['script','storyboard','audio']){const f=await fixture(t),audio=type==='audio',input=capture({...f.input,service:audio?'agent-task':'text',quantity:audio?1:2},{type,count:2});if(audio){assert.throws(()=>f.service.reserve(f.db,f.cfg,input),{code:'budget_task_envelope_not_authorized'});assert.equal(f.budget.readProject(f.db,f.cfg,1).reserved_minor,0);f.budget.updateProject(f.db,f.cfg,1,{operation_id:'authorize-audio-envelope',expected_revision:1,currency:'CNY',limit_minor:100,allow_estimates:true,allow_task_envelopes:true});}
 const saved=f.service.reserve(f.db,f.cfg,input);assert.equal(saved.operation.quantity,audio?1:2);assert.equal(saved.operation.input_capture.value.generation_count,2);assert.equal(saved.operation.input_capture.value.node_type,type);const result=audio?{nodeKey:input.node_id,status:2,url:['https://fixture.invalid/original.wav']}:{nodeKey:input.node_id,status:2,data:{rows:[{plotDescription:'original structured text'}]}};f.service.status(f.db,f.cfg,input.operation_id,{database_id:f.databaseId,request_sha256:input.request_sha256,state:'completed',result});assert.deepEqual(f.service.get(f.db,f.cfg,input.operation_id).result,result);assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM image_generations').get().n,0);assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM video_generations').get().n,0);}
});

test('official nodeType keeps storyboard presentation and refuses conflicting type metadata',{skip:!available},async t=>{
 const f=await fixture(t),input=capture({...f.input,service:'text',quantity:2},{type:'storyboard',count:2}),value=input.input_capture;
 delete value.node.type;value.node.nodeType='storyboard';value.node_sha256=digest(value.node);input.node_snapshot_sha256=value.node_sha256;
 const conflict=structuredClone(input);conflict.input_capture.node.type='script';conflict.input_capture.node_sha256=digest(conflict.input_capture.node);conflict.node_snapshot_sha256=conflict.input_capture.node_sha256;
 assert.throws(()=>f.service.reserve(f.db,f.cfg,conflict),{code:'libtv_cli_input_type_changed'});assert.equal(f.budget.readProject(f.db,f.cfg,1).reserved_minor,0);
 assert.equal(f.service.reserve(f.db,f.cfg,input).operation.input_capture.value.node_type,'storyboard');
});

test('version one receipts migrate monotonically without invented capture facts or rewritten input bytes',{skip:!available},async t=>{
 const f=await fixture(t);f.service.reserve(f.db,f.cfg,f.input);f.upload(f.photo);const imported=await f.importMedia(f.photo);const old=f.db.prepare('SELECT spec_json,request_sha256,created_at FROM muse_libtv_cli_operations').get(),originalId=f.databaseId;f.db.exec('DROP TABLE muse_libtv_cli_inputs;DROP TABLE muse_libtv_cli_reviews;UPDATE muse_libtv_cli_schema SET version=1');assert.equal(f.service.generationOrigin(f.db,'image',imported.generation_id).input_capture.state,'legacy-unavailable');f.db.close();const reopened=f.connect();assert.equal(f.service.schema(reopened,f.cfg),originalId);assert.equal(reopened.prepare('SELECT version FROM muse_libtv_cli_schema').get().version,3);assert.deepEqual(reopened.prepare('SELECT spec_json,request_sha256,created_at FROM muse_libtv_cli_operations').get(),old);const legacy={...f.input};delete legacy.input_capture;assert.equal(f.service.reserve(reopened,f.cfg,legacy).dispatch_allowed,false);assert.equal(f.service.get(reopened,f.cfg,legacy.operation_id).input_capture.state,'legacy-unavailable');assert.equal(f.service.generationOrigin(reopened,'image',imported.generation_id).sha256,sha(f.photo));assert.equal(f.budget.readProject(reopened,f.cfg,1).reserved_minor,40);assert.throws(()=>f.service.reserve(reopened,f.cfg,f.input),{code:'libtv_cli_input_capture_changed'});
});

test('structured terminal reports are immutable, secret-free and remain distinct from a verified supplier invoice',{skip:!available},async t=>{
 const f=await fixture(t);f.service.reserve(f.db,f.cfg,f.input);assert.throws(()=>f.status('completed',{headers:{Authorization:'fake-must-not-persist'}}),{code:'libtv_cli_secret_metadata_refused'});assert.throws(()=>f.status('completed',{nested:{refresh_token:'synthetic-not-persisted'}}),{code:'libtv_cli_secret_metadata_refused'});assert.equal(f.service.get(f.db,f.cfg,f.input.operation_id).state,'reserved');const terminal=f.status('completed',{generation_id:'fixture-generation',status:'completed',result_count:2});assert.equal(terminal.state,'completed');assert.equal(terminal.supplier_terminal_verified,false);assert.equal(terminal.budget.settled_minor,null);assert.deepEqual(f.status('completed',{generation_id:'fixture-generation',status:'completed',result_count:2}),terminal);assert.throws(()=>f.status('failed',{status:'failed'}),{code:'libtv_cli_terminal_status_conflict'});assert.equal(f.budget.readProject(f.db,f.cfg,1).reserved_minor,40);assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM muse_libtv_cli_status_events').get().n,1);
});

test('real HTTP rejects an unpriced run and stale database writes before a CLI operation exists',{skip:!available},async t=>{
 const f=await fixture(t),call=await f.http(),caps=await call('/capabilities');assert.equal(caps.status,200);assert.equal(caps.value.data.chunk_bytes,1024);assert.equal(caps.value.data.provider_credentials_accepted,false);const rejected=await call('/operations/reserve',capture({...f.input,model:'not-priced'}));assert.equal(rejected.status,428);assert.equal(rejected.value.error.code,'budget_price_unknown');assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM muse_libtv_cli_operations').get().n,0);assert.equal(f.budget.readProject(f.db,f.cfg,1).reserved_minor,0);assert.equal((await call('/operations/reserve',{...f.input,database_id:'stale'})).status,409);assert.equal((await call('/operations/reserve',f.input)).value.data.dispatch_allowed,true);const denied=await call('/operations/'+f.input.operation_id+'/status',{database_id:'stale',request_sha256:f.input.request_sha256,state:'completed',result:{}});assert.equal(denied.status,409);assert.equal(f.service.get(f.db,f.cfg,f.input.operation_id).state,'reserved');
});

test('actual HTTP budget preflight uses its own database UUID and rejects the distinct CLI capability UUID without reserving',{skip:!available},async t=>{
 const f=await fixture(t),call=await f.http(),cli=(await call('/capabilities')).value.data,budget=(await call('/muse/budget/catalog')).value.data;assert.notEqual(cli.database_id,budget.database_id);const body={database_id:budget.database_id,project_id:1,service:'image',provider:'libtv-cli',model:'fixture-node-model',origin:'https://api.liblib.tv',quantity:2};const accepted=await call('/muse/budget/quote',body);assert.equal(accepted.status,200);assert.equal(accepted.value.data.within_limit,true);assert.equal(accepted.value.data.reserved_minor,40);const denied=await call('/muse/budget/quote',{...body,database_id:cli.database_id});assert.equal(denied.status,409);assert.equal(denied.value.error.code,'budget_database_changed');assert.equal(f.budget.readProject(f.db,f.cfg,1).reserved_minor,0);assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM muse_libtv_cli_operations').get().n,0);
});

test('actual HTTP over-budget quote remains free and paid reserve refuses before dispatch permission',{skip:!available},async t=>{
 const f=await fixture(t),call=await f.http(),catalog=(await call('/muse/budget/catalog')).value.data;const estimate=await call('/muse/budget/quote',{database_id:catalog.database_id,project_id:1,service:'image',provider:'libtv-cli',model:'fixture-node-model',origin:'https://api.liblib.tv',quantity:6});assert.equal(estimate.status,200);assert.equal(estimate.value.data.within_limit,false);assert.equal(estimate.value.data.reserved_minor,120);const rejected=await call('/operations/reserve',capture({...f.input,quantity:6}));assert.equal(rejected.status,402);assert.equal(rejected.value.error.code,'budget_limit_exceeded');assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM muse_libtv_cli_operations').get().n,0);assert.equal(f.budget.readProject(f.db,f.cfg,1).reserved_minor,0);
});

test('CLI audio imports preserve verified bytes in project assets without inventing TTS or speaker metadata',{skip:!mediaAvailable},async t=>{
 const f=await fixture(t),file=join(f.home,'generated.wav');
 assert.equal(spawnSync(ffmpeg,['-v','error','-f','lavfi','-i','sine=frequency=440:duration=0.4','-c:a','pcm_s16le','-y',file],{windowsHide:true}).status,0);
 const bytes=await readFile(file);Object.assign(f.input,capture({...f.input,service:'agent-task',quantity:1},{type:'audio',count:1}));
 f.budget.updateProject(f.db,f.cfg,1,{operation_id:'authorize-audio-envelope',expected_revision:1,currency:'CNY',limit_minor:100,allow_estimates:true,allow_task_envelopes:true});
 f.service.reserve(f.db,f.cfg,f.input);f.status('completed',{nodeKey:f.input.node_id,status:2,url:['https://fixture.invalid/audio.wav']});
 assert.ok(f.service.capabilities(f.db,f.cfg).native_import_kinds.includes('audio'));
 f.upload(bytes,{kind:'audio',mediaType:'audio/wav',resultId:'audio-original'});
 const input={kind:'audio',resultId:'audio-original',operationId:'import-audio-original'},out=await f.importMedia(bytes,input);
 assert.equal(out.sha256,sha(bytes));assert.equal(out.kind,'audio');assert.equal(out.adopted,false);assert.equal(out.generation_id,undefined);
 const asset=f.db.prepare('SELECT * FROM assets WHERE id=?').get(out.asset_id);
 assert.equal(asset.drama_id,1);assert.equal(asset.type,'audio');assert.equal(asset.mime_type,'audio/wav');assert.ok(asset.duration>0);assert.equal(asset.image_gen_id,null);assert.equal(asset.video_gen_id,null);
 assert.equal(sha(await readFile(join(f.storage,asset.local_path))),out.sha256);
 assert.equal(f.service.generationOrigin(f.db,'audio',out.asset_id).media.complete_decode,true);
 assert.equal((await f.importMedia(bytes,input)).asset_id,out.asset_id);assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM assets').get().n,1);
 f.upload(Buffer.from('RIFF0000WAVEinvalid'),{kind:'audio',mediaType:'audio/wav',resultId:'audio-invalid'});
 await assert.rejects(f.importMedia(Buffer.from('RIFF0000WAVEinvalid'),{kind:'audio',resultId:'audio-invalid'}),{code:'libtv_audio_probe_failed'});
 assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM assets').get().n,1);
});

test('standalone audio verification supports declared formats and refuses video-only MP4 as audio',{skip:!mediaAvailable},async t=>{
 const f=await fixture(t),audio=f.load('museLibTvAudio','muse-libtv-audio.cjs'),cap=f.service.limits(f.cfg);
 for(const [extension,mime]of [['wav','audio/wav'],['mp3','audio/mpeg'],['flac','audio/flac'],['ogg','audio/ogg'],['m4a','audio/mp4']]){
  const file=join(f.storage,'format.'+extension);
  if(extension==='mp3')await writeFile(file,mp3Tone);
  else{const made=spawnSync(ffmpeg,['-v','error','-f','lavfi','-i','sine=frequency=440:duration=0.4','-y',file],{windowsHide:true,encoding:'utf8'});assert.equal(made.status,0,extension+': '+made.stderr);}
  assert.equal(audio.mime(await readFile(file)),mime);assert.equal(audio.facts(f.cfg,'format.'+extension,mime,cap).complete_decode,true);
 }
 const video=join(f.storage,'video-only.mp4');assert.equal(spawnSync(ffmpeg,['-v','error','-f','lavfi','-i','color=c=blue:s=32x32:r=25:d=0.4','-an','-y',video],{windowsHide:true}).status,0);
 assert.throws(()=>audio.facts(f.cfg,'video-only.mp4','audio/mp4',cap),{code:'libtv_audio_clock_unverified'});
 assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM assets').get().n,0);
});

test('playlist containers, forged MP4 signatures and incomplete image decodes never become native versions',{skip:!mediaAvailable},async t=>{
 const f=await fixture(t);f.service.reserve(f.db,f.cfg,f.input);const playlist=Buffer.from('#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXTINF:1,\nfile:///synthetic-outside-storage.ts\n#EXT-X-ENDLIST\n');f.upload(playlist,{kind:'video',mediaType:'video/mp4',resultId:'playlist'});await assert.rejects(f.importMedia(playlist,{kind:'video',resultId:'playlist'}),{code:'libtv_cli_media_type_changed'});const forged=Buffer.concat([Buffer.from([0,0,0,24]),Buffer.from('ftypisom'),playlist]);f.upload(forged,{kind:'video',mediaType:'video/mp4',resultId:'forged'});await assert.rejects(f.importMedia(forged,{kind:'video',resultId:'forged'}),{code:'libtv_cli_media_probe_failed'});const incomplete=f.photo.subarray(0,40);f.upload(incomplete,{resultId:'incomplete'});await assert.rejects(f.importMedia(incomplete,{resultId:'incomplete'}),{code:'libtv_cli_image_unverified'});f.upload(f.photo,{mediaType:'image/jpeg',resultId:'wrong-mime'});await assert.rejects(f.importMedia(f.photo,{resultId:'wrong-mime'}),{code:'libtv_cli_media_type_changed'});assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM image_generations').get().n,0);assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM video_generations').get().n,0);assert.equal(f.budget.readProject(f.db,f.cfg,1).reserved_minor,40);assert.equal(f.service.activeCount(f.db),0);
});

test('out-of-order chunks import a fully decoded image as a new version while the original run and hold remain unknown',{skip:!available},async t=>{
 const f=await fixture(t);f.service.reserve(f.db,f.cfg,f.input);f.status('unknown');const pixels=Buffer.from(Array.from({length:96*96*3},(_,i)=>(i*37+Math.floor(i/23))%256)),bytes=await require('sharp')(pixels,{raw:{width:96,height:96,channels:3}}).png().toBuffer(),uploaded=f.upload(bytes);assert.ok(uploaded.total_chunks>1);assert.equal(uploaded.received_chunks.length,uploaded.total_chunks);const imported=await f.importMedia(bytes,{operationId:'cli-image-import-one'});assert.equal(imported.sha256,sha(bytes));assert.equal(imported.adopted,false);assert.equal(imported.kind,'image');assert.deepEqual(await readFile(join(f.storage,imported.local_path)),bytes);const source=f.service.generationOrigin(f.db,'image',imported.generation_id);assert.equal(source.media.complete_decode,true);assert.equal(source.request.cli_owner.account_id,'fixture-cli-account');assert.equal(source.request.model_schema_sha256,f.input.model_schema_sha256);assert.equal(source.request.node_snapshot_sha256,f.input.node_snapshot_sha256);assert.equal(source.supplier_model_verified,false);assert.equal(f.service.get(f.db,f.cfg,f.input.operation_id).state,'unknown');assert.equal(f.budget.readProject(f.db,f.cfg,1).reserved_minor,40);assert.equal(f.db.prepare('SELECT image_url FROM storyboards WHERE id=1').get().image_url,null);assert.equal((await f.importMedia(bytes,{operationId:'cli-image-import-replay'})).replayed,true);assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM image_generations').get().n,1);
});

test('unverified reference claims, corrupt final hashes, wrong targets and altered chunks never create native versions',{skip:!available},async t=>{
 const f=await fixture(t),reference=sha(f.photo);assert.throws(()=>f.service.reserve(f.db,f.cfg,{...f.input,reference_sha256s:[reference]}),{code:'libtv_cli_unverified_reference_sha'});f.service.reserve(f.db,f.cfg,f.input);const changed=Buffer.concat([f.photo,Buffer.from('synthetic appended bytes')]),wrong='f'.repeat(64);f.upload(changed,{digest:wrong});await assert.rejects(f.importMedia(changed,{digest:wrong}),{code:'libtv_cli_complete_sha_changed'});const mediaDir=join(f.storage,'libtv-cli/media');assert.equal((await readdir(mediaDir)).some(name=>name.includes('.partial-')),false);assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM image_generations').get().n,0);
 const chunk={database_id:f.databaseId,request_sha256:f.input.request_sha256,sha256:sha(changed),kind:'image',media_type:'image/png',total_bytes:changed.length,total_chunks:Math.ceil(changed.length/1024),index:0,chunk_sha256:sha(changed.subarray(0,1024)),data_base64:changed.subarray(0,1024).toString('base64')};assert.throws(()=>f.service.chunk(f.db,f.cfg,f.input.operation_id,{...chunk,chunk_sha256:'0'.repeat(64)}),{code:'libtv_cli_chunk_sha_changed'});f.upload(changed);await assert.rejects(f.importMedia(changed,{storyboardId:2}),{code:'libtv_cli_target_changed'});assert.equal(f.budget.readProject(f.db,f.cfg,1).reserved_minor,40);
});

test('a complete video retains decoded frame count and original audio and is independent of a colliding image ID',{skip:!mediaAvailable},async t=>{
 const f=await fixture(t);f.service.reserve(f.db,f.cfg,f.input);f.status('completed',{generation_id:'fixture-mixed-node',status:'completed'});f.upload(f.photo);const image=await f.importMedia(f.photo,{operationId:'mixed-cli-image-import'});const videoFile=join(f.home,'video.mp4'),made=spawnSync(ffmpeg,['-v','error','-f','lavfi','-i','color=c=blue:s=32x32:r=25:d=0.4','-f','lavfi','-i','sine=frequency=440:duration=0.4','-c:v','libx264','-c:a','aac','-shortest','-y',videoFile],{windowsHide:true});assert.equal(made.status,0);const bytes=await readFile(videoFile);assert.ok(f.upload(bytes,{kind:'video',mediaType:'video/mp4'}).total_chunks>1);const video=await f.importMedia(bytes,{kind:'video',operationId:'mixed-cli-video-import'});assert.equal(video.generation_id,image.generation_id);const source=f.service.generationOrigin(f.db,'video',video.generation_id);assert.equal(source.media.native_kind,'video');assert.equal(source.media.frames,10);assert.ok(source.media.audio_sha256);assert.equal(source.sha256,sha(bytes));assert.equal(f.service.generationOrigin(f.db,'image',image.generation_id).media.native_kind,'image');assert.equal(f.db.prepare('SELECT video_url FROM storyboards WHERE id=1').get().video_url,null);assert.equal(f.budget.readProject(f.db,f.cfg,1).reserved_minor,40);
});

test('only one concurrent import commits and distinct result identities may preserve identical media bytes',{skip:!available},async t=>{
 const f=await fixture(t);f.service.reserve(f.db,f.cfg,f.input);f.upload(f.photo,{resultId:'first-real-output'});const first=f.importMedia(f.photo,{resultId:'first-real-output',operationId:'concurrent-cli-first'}),second=f.importMedia(f.photo,{resultId:'first-real-output',operationId:'concurrent-cli-second'});const results=await Promise.allSettled([first,second]);assert.equal(results.filter(value=>value.status==='fulfilled').length,1);assert.equal(results.find(value=>value.status==='rejected').reason.code,'libtv_cli_import_busy');f.upload(f.photo,{resultId:'second-real-output'});await assert.rejects(f.importMedia(f.photo),{code:'libtv_cli_result_identity_required'});await f.importMedia(f.photo,{resultId:'second-real-output',operationId:'distinct-cli-result'});assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM image_generations').get().n,2);assert.equal(f.budget.readProject(f.db,f.cfg,1).reserved_minor,40);
});

test('schema versions and configured media quotas reject explicitly without changing old receipts',{skip:!available},async t=>{
 const f=await fixture(t,{config:{max_results:1}});f.service.reserve(f.db,f.cfg,f.input);f.upload(f.photo,{resultId:'one'});assert.throws(()=>f.upload(f.photo,{resultId:'two'}),{code:'libtv_cli_operation_media_quota'});assert.equal(f.service.get(f.db,f.cfg,f.input.operation_id).budget.reserved_minor,40);f.db.prepare('UPDATE muse_libtv_cli_schema SET version=4').run();assert.throws(()=>f.service.schema(f.db,f.cfg),{code:'libtv_cli_unsupported_schema'});
});

test('the CLI planner registers only owned routes and keeps both native lineage wrappers explicit',async t=>{
 const root=await mkdtemp(join(tmpdir(),'muse-cli-plan-'));t.after(async()=>{assert.equal(dirname(resolve(root)),resolve(tmpdir()));await rm(root,{recursive:true,force:true});});const read=path=>path.replaceAll('\\','/').endsWith('routes/index.js')?'function setup(){\n  return r;\n}':'module.exports={getById(){return null}};';const result=planMuseLibTvCli(root,read);assert.equal(result.length,7);for(const[file,source]of result)if(file.endsWith('.js'))assert.doesNotThrow(()=>new Function(source));assert.match(result.find(([file])=>file.endsWith('imageService.js'))[1],/generationOrigin\(db,'image',id\)/);assert.throws(()=>planMuseLibTvCli(root,path=>path.replaceAll('\\','/').endsWith('routes/index.js')?'return router;':read(path)),/does not match/);const mapped=new Map(result);assert.throws(()=>planMuseLibTvCli(root,path=>mapped.get(path)??read(path)),/already installed/);
});

/** Real SQLite import records with bounded in-memory media and supplier download fixtures. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {compileFunction} from 'node:vm';
const require=createRequire(import.meta.url),hash=value=>createHash('sha256').update(value).digest('hex');
const digest=value=>hash(JSON.stringify(value));
function fixture(t){
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());db.transaction=fn=>{const run=(...args)=>{db.exec('BEGIN');try{const value=fn(...args);db.exec('COMMIT');return value;}catch(error){db.exec('ROLLBACK');throw error;}};run.immediate=run;return run;};
 db.exec(`CREATE TABLE dramas(id INTEGER PRIMARY KEY,deleted_at TEXT);INSERT INTO dramas VALUES(1,NULL);
 CREATE TABLE episodes(id INTEGER PRIMARY KEY,drama_id INTEGER,deleted_at TEXT);INSERT INTO episodes VALUES(1,1,NULL);
 CREATE TABLE storyboards(id INTEGER PRIMARY KEY,episode_id INTEGER,video_url TEXT,deleted_at TEXT);INSERT INTO storyboards VALUES(1,1,'/static/original.mp4',NULL);
 CREATE TABLE video_generations(id INTEGER PRIMARY KEY,drama_id INTEGER,storyboard_id INTEGER,provider TEXT,model TEXT,prompt TEXT,local_path TEXT,video_url TEXT,duration REAL,status TEXT,created_at TEXT,updated_at TEXT,completed_at TEXT,deleted_at TEXT);
 INSERT INTO video_generations VALUES(1,1,1,'libtv_cli','wanx3.0','original prompt','original.mp4','/static/original.mp4',5,'completed','before','before','before',NULL);
 CREATE TABLE muse_libtv_cli_operations(operation_id TEXT,project_uuid TEXT,spec_json TEXT,result_json TEXT,state TEXT);
 CREATE TABLE muse_libtv_cli_uploads(upload_id TEXT,result_id TEXT,sha256 TEXT,state TEXT);
 CREATE TABLE muse_libtv_cli_imports(source_operation_id TEXT,upload_id TEXT,generation_id INTEGER,kind TEXT,receipt_json TEXT);`);
 const canonical=value=>Array.isArray(value)?'['+value.map(canonical).join(',')+']':value!==null&&typeof value==='object'?'{'+Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>JSON.stringify(key)+':'+canonical(item)).join(',')+'}':JSON.stringify(value),sha=value=>hash(canonical(value));
 const original=Buffer.from('original-video'),output=Buffer.from('0000ftyperased-video'),owner={user_uuid:'fixture-user',account_id:'fixture-account',team_id:null},url='https://libtv-res.liblib.art/source.mp4',node={nodeKey:'hd-result',nodeType:'video',data:{url:[url]}};
 db.prepare('INSERT INTO muse_libtv_cli_operations VALUES(?,?,?,?,?)').run('original-paid-operation','canvas',JSON.stringify({cli_owner:owner,node_id:'input-node'}),JSON.stringify({media_outputs:[{kind:'video',nodeKey:'hd-result',node,nodeSha256:sha(node),url,outputIndex:0}]}),'completed');
 db.prepare('INSERT INTO muse_libtv_cli_uploads VALUES(?,?,?,?)').run('original-upload','cli-result-0-'+sha({url}),hash(original),'verified');
 db.prepare('INSERT INTO muse_libtv_cli_imports VALUES(?,?,?,?,?)').run('original-paid-operation','original-upload',1,'video','{}');
 const files=new Map([['original.mp4',original]]),facts={frames:150,fps:30,width:1280,height:720,duration_seconds:5,audio_streams:1,audio_sha256:'original-audio',complete_decode:true},restoreCalls=[];
 let failRestore=false,fetches=0,release,body=output,timingCorrection=null;
 const media={read:(_cfg,path)=>{assert.ok(files.has(path));return files.get(path);},save:(_cfg,path,bytes)=>{if(files.has(path))assert.deepEqual(files.get(path),bytes);else files.set(path,bytes);},probe:()=>facts,restore:(_cfg,source,raw,destination,kind)=>{restoreCalls.push({source,raw,destination,kind});if(failRestore)throw Object.assign(Error('clock changed'),{code:'postproduction_picture_clock_changed'});files.set(destination,Buffer.concat([files.get(raw),Buffer.from('+original-audio')]));return facts;}};
 const parent={state:'captured',prompt:'original prompt',submittedPrompt:'original prompt',bindings:[{bindingId:'hero',versionId:'immutable-version'}],references:[],revisionId:'original-revision',operationId:'original-paid-operation',model:'wanx3.0'};
 const module={exports:{}};compileFunction(readFileSync(new URL('../extensions/muse-libtv-postproduction.cjs',import.meta.url),'utf8'),['require','module','exports'])(name=>name==='./musePostproductionMedia'?media:name==='./museLibTvTiming'?{prepare:(_cfg,_source,path)=>({path,correction:timingCorrection})}:name==='./musePostproduction'?{limits:()=>({max_input_bytes:1024,max_output_bytes:1024,http_timeout_ms:10000,media_timeout_ms:10000,json_bytes:10000})}:name==='./museStudio'?{generationInputs:()=>structuredClone(parent)}:require(name),module,module.exports);
 const api=module.exports,service=api.create({fetchImpl:async(_url,options)=>{fetches++;assert.equal(options.redirect,'error');if(release)await release;return new Response(body,{status:200,headers:{'Content-Type':'video/mp4'}});}}),cfg={storage:{base_url:'/static'}};
 const inspected=api.inspect(db,cfg,1),input={database_id:inspected.database_id,operation_id:'erase-import-fixture',request_sha256:'a'.repeat(64),project_id:1,storyboard_id:1,source_generation_id:1,source_sha256:hash(original),origin:inspected.origin,model:'volcano-subtitle-eraser',parameters:{mode:'Subtitle'},provider_task_id:'supplier-task',result_url:'https://libtv-res.liblib.art/erased.mp4',company_id:'company',company_operation_id:'erase-paid-fixture',quote:{currency:'LTV',reserved_minor:200,identity:'verified-quote'}};
 return {api,service,db,cfg,input,files,parent,facts,restoreCalls,fetches:()=>fetches,failRestore:()=>{failRestore=true;},delay:promise=>{release=promise;},body:value=>{body=value;},timing:value=>{timingCorrection=value;}};
}
test('source inspection uses the imported output node and rejects changed source bytes',t=>{
 const f=fixture(t);assert.equal(f.input.origin.node_id,'hd-result');assert.equal(f.input.origin.operation_id,'original-paid-operation');assert.equal(f.fetches(),0);
 f.files.set('original.mp4',Buffer.from('tampered'));assert.throws(()=>f.api.inspect(f.db,f.cfg,1),{code:'libtv_postproduction_source_origin_unavailable'});
});
test('a verified derivative preserves originals, adopted selection, asset bindings and one immutable history row',async t=>{
 const f=fixture(t),correction={method:'libtv-final-sample-duration-remux',video_packet_sha256:'d'.repeat(64),raw_sha256:hash(Buffer.from('0000ftyperased-video'))};f.timing(correction);
 const original=f.files.get('original.mp4'),result=await f.service.importResult(f.db,f.cfg,f.input);
 assert.equal(result.provider,'libtv-api');assert.equal(result.adopted,false);assert.equal(result.generation_id,2);assert.equal(f.db.prepare('SELECT video_url FROM storyboards WHERE id=1').get().video_url,'/static/original.mp4');assert.equal(f.files.get('original.mp4'),original);
 assert.equal(f.restoreCalls[0].kind,'erase_subtitles');assert.equal(f.restoreCalls[0].source,'original.mp4');
 const inputs=f.api.generationInputs(f.db,'video',{id:2});assert.deepEqual(inputs.bindings,f.parent.bindings);assert.equal(inputs.postproduction.parentGenerationId,1);assert.equal(inputs.postproduction.sourceNodeId,'hd-result');assert.equal(inputs.revisionId,'original-revision');
 assert.deepEqual(result.timing_correction,correction);assert.deepEqual(inputs.postproduction.timingCorrection,correction);assert.deepEqual(JSON.parse(f.db.prepare('SELECT record_json FROM muse_libtv_postproduction_imports').get().record_json).timing_correction,correction);
 const replay=await f.service.importResult(f.db,f.cfg,f.input);assert.equal(replay.replayed,true);assert.equal(f.fetches(),1);assert.equal(f.db.prepare('SELECT count(*) AS n FROM video_generations').get().n,2);
 assert.throws(()=>f.db.prepare("UPDATE muse_libtv_postproduction_imports SET inputs_json='{}'").run(),/immutable/);
 const next=f.api.inspect(f.db,f.cfg,2);assert.equal(next.origin.provider,'libtv-api');assert.equal(next.source_sha256,result.sha256);
});
test('conflicting, cross-project and untrusted-host imports cannot download or create a version',async t=>{
 const f=fixture(t);for(const change of [{project_id:2},{source_sha256:'b'.repeat(64)},{origin:{...f.input.origin,node_id:'other'}},{result_url:'https://attacker.invalid/media.mp4'},{quote:{currency:'LTV',reserved_minor:0,identity:'zero'}}])await assert.rejects(f.service.importResult(f.db,f.cfg,{...f.input,...change}));
 assert.equal(f.fetches(),0);assert.equal(f.db.prepare('SELECT count(*) AS n FROM video_generations').get().n,1);
 await f.service.importResult(f.db,f.cfg,f.input);await assert.rejects(f.service.importResult(f.db,f.cfg,{...f.input,provider_task_id:'different-task'}),{code:'libtv_postproduction_import_conflict'});
});
test('concurrent identical imports share one download and changed output bytes are refused on replay',async t=>{
 const f=fixture(t);let release;f.delay(new Promise(resolve=>{release=resolve;}));const first=f.service.importResult(f.db,f.cfg,f.input),second=f.service.importResult(f.db,f.cfg,f.input);release();const [a,b]=await Promise.all([first,second]);assert.equal(a.generation_id,b.generation_id);assert.equal(f.fetches(),1);
 f.files.set(a.local_path,Buffer.from('tampered result'));await assert.rejects(f.service.importResult(f.db,f.cfg,f.input),{code:'libtv_postproduction_saved_media_changed'});
});
test('failed media verification and oversized downloads retain the source without importing',async t=>{
 const f=fixture(t);f.failRestore();await assert.rejects(f.service.importResult(f.db,f.cfg,f.input),{code:'postproduction_picture_clock_changed'});assert.equal(f.db.prepare('SELECT count(*) AS n FROM video_generations').get().n,1);
 const large=fixture(t);large.body(Buffer.alloc(2048));await assert.rejects(large.service.importResult(large.db,large.cfg,large.input),{code:'libtv_postproduction_output_limit'});assert.equal(large.db.prepare('SELECT count(*) AS n FROM video_generations').get().n,1);
});

test('a playlist disguised as a vendor video is refused before media processing',async t=>{
 const f=fixture(t);f.body(Buffer.from('#EXTM3U\nhttps://attacker.invalid/private'));
 await assert.rejects(f.service.importResult(f.db,f.cfg,f.input),{code:'libtv_postproduction_output_format_changed'});
 assert.equal(f.restoreCalls.length,0);assert.equal(f.db.prepare('SELECT count(*) AS n FROM video_generations').get().n,1);
});

test('an explicitly validated zero-price import still retains the company task and quotation',async t=>{
 const f=fixture(t);f.input.quote={currency:'LTV',reserved_minor:0,zeroQuote:true,identity:'confirmed-zero-quote'};
 const result=await f.service.importResult(f.db,f.cfg,f.input),inputs=f.api.generationInputs(f.db,'video',{id:result.generation_id});
 assert.equal(inputs.postproduction.companyOperationId,f.input.company_operation_id);
 assert.deepEqual(inputs.postproduction.quote,f.input.quote);assert.equal(result.adopted,false);
});

test('invalid media process limits fail before downloading or creating a version',async t=>{
 const f=fixture(t);
 for(const overrides of [{media_timeout_ms:0},{media_timeout_ms:3600001},{json_bytes:0},{json_bytes:8*1024*1024+1}]){
  f.cfg.muse_libtv_postproduction=overrides;
  await assert.rejects(f.service.importResult(f.db,f.cfg,f.input),{code:'libtv_postproduction_invalid_limits'});
 }
 assert.equal(f.fetches(),0);assert.equal(f.db.prepare('SELECT count(*) AS n FROM video_generations').get().n,1);
});

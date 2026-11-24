/** Compare metadata-only Fal usage phases with the actual postproduction owner without calling suppliers. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire,Module} from 'node:module';
import {existsSync,readFileSync} from 'node:fs';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve,join,dirname,basename} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createStudioUsageReader} from './studio-usage.mjs';

const backendRoot=resolve(process.env.LOCALMINIDRAMA_SOURCE||'.local/localminidrama','backend-node');
const available=existsSync(join(backendRoot,'node_modules/better-sqlite3/package.json'));
const accountId='aaaaaaaaaaaaaaaa',at='2026-11-12T01:00:00.000Z';
async function fixture(t){
 const home=await mkdtemp(join(tmpdir(),'muse-usage-fal-')),connections=[];
 t.after(async()=>{for(const db of connections)if(db.open)db.close();assert.equal(dirname(resolve(home)),resolve(tmpdir()));assert.ok(basename(home).startsWith('muse-usage-fal-'));await rm(home,{recursive:true,force:true,maxRetries:5,retryDelay:20});});
 const config={version:1,nodeExecutable:process.execPath,backendRoot,webDistRoot:join(home,'web'),tenantRoot:join(home,'tenants'),outboundOrigins:[],trustedLocalOrigins:[],limits:{maxActiveInstances:1,maxConcurrentStarts:1,maxRequestsPerAccount:1,maxRequestsTotal:1,maxOutboundRequests:1,maxRequestBytes:1024,maxTenantBytes:1048576,startupTimeoutMs:1000,requestTimeoutMs:1000,idleTimeoutMs:0,idleSweepMs:1000,shutdownGraceMs:1000}};
 const directory=join(config.tenantRoot,accountId);await mkdir(directory,{recursive:true,mode:0o700});await writeFile(join(directory,'tenant.json'),JSON.stringify({version:1,accountId}),{mode:0o600});
 const require=createRequire(join(backendRoot,'package.json')),Database=require('better-sqlite3'),file=join(directory,'drama.db'),db=new Database(file);connections.push(db);
 const loaded=new Map(),owned={musePostproduction:'muse-postproduction.cjs',musePostproductionMedia:'muse-postproduction-media.cjs',musePostproductionFal:'muse-postproduction-fal.cjs'};
 function load(name){if(loaded.has(name))return loaded.get(name).exports;const path=join(backendRoot,'src/services',name+'.js'),module=new Module(path);module.filename=path;loaded.set(name,module);module.require=id=>id.startsWith('./')&&owned[id.slice(2)]?load(id.slice(2)):createRequire(path)(id);module._compile(readFileSync(fileURLToPath(new URL('../extensions/'+owned[name],import.meta.url)),'utf8'),path);return module.exports;}
 const owner=load('musePostproduction');owner.schema(db);db.exec('CREATE TABLE storyboards(id INTEGER PRIMARY KEY,video_url TEXT,deleted_at TEXT);INSERT INTO storyboards(id) VALUES(1)');
 function task(id,state,segments,error=null){
  const values={operation_id:id,state,error_code:error,source_generation_id:1,drama_id:1,storyboard_id:1,config_id:1,kind:'upscale',created_at:at,completed_at:null};
  for(const column of db.prepare('PRAGMA table_info(muse_postproduction_tasks)').all())if(column.notnull&&column.dflt_value===null&&!(column.name in values))values[column.name]=column.type==='INTEGER'?1:column.name.endsWith('_json')?'{}':'PRIVATE '+column.name;
  const fields=Object.keys(values);db.prepare('INSERT INTO muse_postproduction_tasks('+fields.join(',')+') VALUES('+fields.map(()=>'?').join(',')+')').run(...Object.values(values));
  for(const [index,segment]of segments.entries())db.prepare('INSERT INTO muse_postproduction_segments(task_operation_id,segment_index,start_frame,end_frame,state,error_code) VALUES(?,?,?,?,?,?)').run(id,index,index*10,(index+1)*10,segment.state,segment.error??null);
 }
 return {db,file,owner,task,reader:createStudioUsageReader(config)};
}

test('Fal metadata preserves owner phase precedence and the first segment error without exposing private inputs',{skip:!available},async t=>{
 const f=await fixture(t),cases=[
  {id:'fal-completed',state:'completed',segments:[{state:'unknown'}],phase:'completed',normalized:'completed'},
  {id:'fal-unknown',state:'media_unverified',error:'task_problem',segments:[{state:'pending'},{state:'unknown',error:'unknown_segment'}],phase:'unknown',normalized:'unknown'},
  {id:'fal-task-review',state:'media_unverified',error:'task_problem',segments:[{state:'pending',error:'segment_problem'}],phase:'media_unverified',normalized:'awaiting-review'},
  {id:'fal-pending',segments:[{state:'pending'},{state:'media_unverified',error:'decode_failed'}],phase:'submission_incomplete',normalized:'awaiting-review'},
  {id:'fal-upload',segments:[{state:'upload_failed',error:'upload_failed'},{state:'queued'}],phase:'submission_incomplete',normalized:'awaiting-review'},
  {id:'fal-media',segments:[{state:'queued',error:'first_segment_problem'},{state:'media_unverified',error:'later_segment_problem'}],phase:'media_unverified',normalized:'awaiting-review'},
  {id:'fal-assembling',segments:[{state:'verified'},{state:'verified'}],phase:'assembling',normalized:'accepted'},
  {id:'fal-submitting',segments:[{state:'submitting'},{state:'processing'}],phase:'submitting',normalized:'accepted'},
  {id:'fal-uploading',segments:[{state:'uploading'},{state:'queued'}],phase:'submitting',normalized:'accepted'},
  {id:'fal-processing',segments:[{state:'queued'},{state:'processing'}],phase:'processing',normalized:'accepted'},
  {id:'fal-queued',segments:[{state:'queued'}],phase:'queued',normalized:'accepted'},
 ];
 const expected=new Map();for(const row of cases){f.task(row.id,row.state??'preparing',row.segments,row.error??null);const owned=f.owner.readTask(f.db,row.id);assert.equal(owned.state,row.phase);expected.set(row.id,owned);}
 const before=await readFile(f.file),reply=await f.reader.query(accountId,{from:'2026-11-01',to:'2026-11-12',limit:100});
 assert.equal(reply.summary.operations,cases.length);assert.equal(reply.summary.states['awaiting-review'],4);assert.equal(reply.summary.totalTokens,null);assert.equal(reply.summary.resources.tasks,cases.length);
 for(const row of cases){const item=reply.items.find(item=>item.operationId===row.id);assert.equal(item.recordedState,expected.get(row.id).state);assert.equal(item.state,row.normalized);assert.equal(item.errorCode,expected.get(row.id).error_code);assert.equal(item.totalTokens,null);}
 assert.doesNotMatch(JSON.stringify(reply),/PRIVATE|source_path|credential_sha256|parameters_json/);assert.deepEqual(await readFile(f.file),before);
});

test('a Fal task without its segment records fails closed without creating missing data',{skip:!available},async t=>{
 const f=await fixture(t);f.task('fal-no-segments','preparing',[]);assert.throws(()=>f.owner.readTask(f.db,'fal-no-segments'),{code:'postproduction_segment_records_missing'});const before=await readFile(f.file);await assert.rejects(f.reader.query(accountId,{from:'2026-11-01',to:'2026-11-12'}),{code:'studio_usage_corrupt'});assert.deepEqual(await readFile(f.file),before);
});

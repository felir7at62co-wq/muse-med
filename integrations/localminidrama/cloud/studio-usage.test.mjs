/** Read actual admission SQLite metadata with isolated fixture accounts and no supplier requests. */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire,Module} from 'node:module';
import {existsSync,readFileSync} from 'node:fs';
import {mkdtemp,mkdir,writeFile,readFile,rm,link,symlink,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve,join,dirname,basename} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createStudioUsageReader} from './studio-usage.mjs';

const backendRoot=resolve(process.env.LOCALMINIDRAMA_SOURCE||'.local/localminidrama','backend-node');
const available=existsSync(join(backendRoot,'node_modules/better-sqlite3/package.json'));
const alice='aaaaaaaaaaaaaaaa',bob='bbbbbbbbbbbbbbbb',carol='cccccccccccccccc';
const window={from:'2026-11-01',to:'2026-11-12'};
const limits={maxActiveInstances:1,maxConcurrentStarts:1,maxRequestsPerAccount:1,maxRequestsTotal:1,maxOutboundRequests:1,maxRequestBytes:1024,maxTenantBytes:1048576,startupTimeoutMs:1000,requestTimeoutMs:1000,idleTimeoutMs:0,idleSweepMs:1000,shutdownGraceMs:1000};
async function removeHome(home){assert.equal(dirname(resolve(home)),resolve(tmpdir()));assert.ok(basename(home).startsWith('muse-studio-usage-'));await rm(home,{recursive:true,force:true,maxRetries:5,retryDelay:20});}
async function fixture(t){
 const home=await mkdtemp(join(tmpdir(),'muse-studio-usage-')),connections=[];t.after(async()=>{for(const db of connections)if(db.open)db.close();await removeHome(home);});
 const config={version:1,nodeExecutable:process.execPath,backendRoot,webDistRoot:join(home,'web'),tenantRoot:join(home,'tenants'),outboundOrigins:[],trustedLocalOrigins:[],limits};
 const require=createRequire(join(backendRoot,'package.json')),Database=require('better-sqlite3');
 const installedAdmission=join(backendRoot,'src/services/museAdmission.js');let service;
 if(existsSync(installedAdmission))service=require(installedAdmission);
 else{
  const filename=fileURLToPath(new URL('../extensions/muse-admission.cjs',import.meta.url)),module=new Module(filename);module.filename=filename;
  // Schema and resource usage do not inspect generation routes in an unpatched-source fixture.
  module.require=name=>name==='./museAdmissionCatalog.json'?[]:require(name);module._compile(readFileSync(filename,'utf8'),filename);service=module.exports;
 }
 async function tenant(accountId,{instrumented=true}={}){
  const directory=join(config.tenantRoot,accountId);await mkdir(directory,{recursive:true,mode:0o700});await writeFile(join(directory,'tenant.json'),JSON.stringify({version:1,accountId}),{mode:0o600});
  const path=join(directory,'drama.db'),db=new Database(path);connections.push(db);const statements=[];
  const prepare=sql=>{const statement=db.prepare(sql);statements.push(statement);return statement;};
  db.exec('CREATE TABLE async_tasks(id TEXT PRIMARY KEY,status TEXT); CREATE TABLE image_generations(id INTEGER PRIMARY KEY,status TEXT); CREATE TABLE video_generations(id INTEGER PRIMARY KEY,status TEXT); CREATE TABLE fixture_private(prompt TEXT,api_key TEXT)');
  prepare('INSERT INTO fixture_private VALUES(?,?)').run('PRIVATE PROMPT','PRIVATE SECRET');
  if(instrumented)service.schema(db);
  const operation=({id,state='completed',kind='text',at='2026-11-12T01:00:00.000Z',error=null}={})=>prepare('INSERT INTO muse_native_operations(operation_id,request_sha256,path,kind,label,state,created_at,updated_at,http_status,receipt,error_code) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(id,'private-request-digest','/private-path',kind,'PRIVATE LABEL',state,at,at,200,'PRIVATE RECEIPT',error);
  const usage=(id,call,value)=>prepare('INSERT INTO muse_native_supplier_usage VALUES(?,?,?,?)').run(id,call,typeof value==='string'?value:JSON.stringify(value),'2026-11-12T02:00:00.000Z');
  const resource=(id,kind,value)=>prepare('INSERT INTO muse_native_operation_resources VALUES(?,?,?)').run(id,kind,value);
  return {db,path,directory,prepare,operation,usage,resource,statements};
 }
 return {home,config,tenant,service,reader:createStudioUsageReader(config,{now:()=>Date.parse('2026-11-12T12:00:00Z')})};
}

test('reader construction is lazy, query selection is bounded and absence is distinct from zero usage',async t=>{
 const home=await mkdtemp(join(tmpdir(),'muse-studio-usage-empty-'));t.after(()=>removeHome(home));
 const config={version:1,nodeExecutable:process.execPath,backendRoot:join(home,'missing-backend'),webDistRoot:join(home,'web'),tenantRoot:join(home,'tenants'),outboundOrigins:[],trustedLocalOrigins:[],limits};
 const reader=createStudioUsageReader(config,{now:()=>Date.parse('2026-11-12T12:00:00Z')});
 const result=await reader.query(alice);assert.equal(result.status,'no-database');assert.equal(result.from,'2026-10-14');assert.equal(result.to,'2026-11-12');assert.equal(result.summary.inputTokens,null);assert.equal(result.summary.totalTokens,null);assert.equal(result.billingVerified,false);
 assert.equal(existsSync(config.tenantRoot),false);
 for(const [accountId,query]of [[alice,{accountId:bob}],['../'+bob,{}],[alice,{from:'2026-02-30'}],[alice,{from:'2025-01-01',to:'2026-11-12'}],[alice,{limit:'0'}],[alice,{limit:101}],[alice,{cursor:'not-a-cursor'}]])await assert.rejects(reader.query(accountId,query),{code:'studio_usage_invalid_query',status:400});
});

test('actual admission records isolate accounts, preserve unknown tokens and count each linked resource once',{skip:!available},async t=>{
 const f=await fixture(t),a=await f.tenant(alice),b=await f.tenant(bob);
 a.operation({id:'text-operation-1'});a.usage('text-operation-1','call-1',{input_tokens:3,prompt_tokens:999,output_tokens:0,completion_tokens:999});a.usage('text-operation-1','call-2',{prompt_tokens:7,completion_tokens:4,total_tokens:11});
 a.operation({id:'image-operation-2',kind:'image',state:'accepted'});a.resource('image-operation-2','image','10');a.resource('image-operation-2','task','task-10');
 a.operation({id:'failed-operation-3',kind:'video',state:'failed',error:'supplier_usage_not_saved'});a.usage('failed-operation-3','resource:video:22',{total_tokens:0});a.resource('failed-operation-3','video','22');a.resource('failed-operation-3','image','10');
 a.operation({id:'outside-window-4',at:'2026-10-12T00:00:00.000Z'});a.usage('outside-window-4','call-old',{total_tokens:10000});
 b.operation({id:'text-operation-1'});b.usage('text-operation-1','bob-call',{prompt_tokens:88,completion_tokens:22,total_tokens:110});
 const before=await readFile(a.path),result=await f.reader.query(alice,window);
 assert.equal(result.status,'recorded');assert.equal(result.scope,'studio-all');assert.deepEqual(result.summary,{operations:3,states:{authorized:0,reserved:0,accepted:1,completed:1,failed:1,unknown:0,'operator-confirmed':0,'awaiting-review':0},sources:{native:3,tts:0,fal:0,libtv:0,'libtv-cli':0},reportedUsageOperations:2,unreportedUsageOperations:1,usageErrorOperations:1,supplierReports:3,inputTokens:10,outputTokens:4,totalTokens:11,tokenCoverage:{input:{reportedReports:2,unreportedReports:1,overflow:false},output:{reportedReports:2,unreportedReports:1,overflow:false},total:{reportedReports:2,unreportedReports:1,overflow:false}},resources:{images:1,videos:1,audios:0,tasks:1},budgetTotals:[]});
 assert.deepEqual(result.health,{state:'degraded',invalidUsageReports:0});assert.equal(result.items.find(row=>row.operationId==='image-operation-2').usageStatus,'unreported');assert.equal(result.items.find(row=>row.operationId==='image-operation-2').inputTokens,null);
 assert.equal(result.items.find(row=>row.operationId==='failed-operation-3').totalTokens,0);assert.equal(result.items.find(row=>row.operationId==='failed-operation-3').usageStatus,'error');
 assert.doesNotMatch(JSON.stringify(result),/PRIVATE|private-path|private-request-digest|110|outside-window/);
 assert.deepEqual(await readFile(a.path),before);assert.equal((await f.reader.query(bob,window)).summary.totalTokens,110);
 assert.equal((await f.reader.query(carol,window)).status,'no-database');assert.equal(existsSync(join(f.config.tenantRoot,carol)),false);
 assert.deepEqual(await readdir(f.config.tenantRoot),[alice,bob]);
});

test('pagination is stable by insertion and a cursor cannot select another account or date range',{skip:!available},async t=>{
 const f=await fixture(t),a=await f.tenant(alice);await f.tenant(bob);
 for(let index=0;index<4;index++)a.operation({id:'operation-'+index});
 const first=await f.reader.query(alice,{...window,limit:2});assert.deepEqual(first.items.map(row=>row.operationId),['operation-3','operation-2']);assert.equal(first.summary.operations,4);assert.ok(first.nextCursor);
 a.operation({id:'operation-new'});
 const second=await f.reader.query(alice,{...window,limit:2,cursor:first.nextCursor});assert.deepEqual(second.items.map(row=>row.operationId),['operation-1','operation-0']);assert.equal(second.summary.operations,5);assert.equal(second.nextCursor,null);
 await assert.rejects(f.reader.query(bob,{...window,cursor:first.nextCursor}),{code:'studio_usage_invalid_query'});
 await assert.rejects(f.reader.query(alice,{...window,to:'2026-11-13',cursor:first.nextCursor}),{code:'studio_usage_invalid_query'});
});

test('all production sources share one account view without duplicating native dispatches or inventing supplier tokens',{skip:!available},async t=>{
 const f=await fixture(t),a=await f.tenant(alice),b=await f.tenant(bob),require=createRequire(join(backendRoot,'package.json')),loaded=new Map();
 const filenames={museBudget:'muse-budget.cjs',museLibTv:'muse-libtv.cjs',museLibTvHttp:'muse-libtv-http.cjs',museLibTvAudio:'muse-libtv-audio.cjs',museLibTvCli:'muse-libtv-cli.cjs',museLibTvCliMedia:'muse-libtv-cli-media.cjs',musePostproduction:'muse-postproduction.cjs',musePostproductionMedia:'muse-postproduction-media.cjs',musePostproductionFal:'muse-postproduction-fal.cjs',museAudioService:'muse-audio.cjs'};
 function service(name){
  if(loaded.has(name))return loaded.get(name).exports;
  const filename=fileURLToPath(new URL('../extensions/'+filenames[name],import.meta.url)),module=new Module(filename);module.filename=filename;loaded.set(name,module);
  module.require=id=>id.startsWith('./')&&filenames[id.slice(2)]?service(id.slice(2)):require(id);module._compile(readFileSync(filename,'utf8'),filename);return module.exports;
 }
 for(const entry of ['museBudget','museAudioService','musePostproduction','museLibTv','museLibTvCli'])service(entry).schema(a.db,{});
 function insert(table,values){
  const row={...values};for(const column of a.db.prepare('PRAGMA table_info('+table+')').all())if(column.notnull&&column.dflt_value===null&&!(column.name in row))row[column.name]=column.type==='INTEGER'?1:column.name.endsWith('_json')?'{}':'PRIVATE '+column.name;
  const fields=Object.keys(row);a.db.prepare('INSERT INTO '+table+'('+fields.join(',')+') VALUES('+fields.map(()=>'?').join(',')+')').run(...Object.values(row));
 }
 const at='2026-11-12T01:00:00.000Z';
 a.operation({id:'same-id',kind:'video'});a.usage('same-id','native-call',{total_tokens:17});a.resource('same-id','video','23');
 insert('muse_tts_generations',{operation_id:'same-id',state:'completed',created_at:at,completed_at:at});
 insert('muse_postproduction_tasks',{operation_id:'fal-operation',kind:'upscale',state:'preparing',created_at:at});
 insert('muse_postproduction_segments',{task_operation_id:'fal-operation',segment_index:0,state:'unknown',start_frame:0,end_frame:5});
 insert('muse_libtv_tasks',{operation_id:'api-operation',state:'operator_confirmed',kind:'video',created_at:at,updated_at:at});
 insert('muse_libtv_imports',{operation_id:'api-import',task_id:'api-operation',result_id:'api-result',state:'completed',generation_id:23,media_json:JSON.stringify({native_kind:'video'}),created_at:at});
 insert('muse_libtv_cli_operations',{operation_id:'cli-operation',state:'completed',service:'image',created_at:at,updated_at:at});
 insert('muse_libtv_cli_imports',{operation_id:'cli-import',source_operation_id:'cli-operation',kind:'image',generation_id:4,created_at:at});
 function reserve(source,id,{parent=null,amount=10,settled=null,currency='CNY'}={}){
  insert('muse_budget_entries',{entry_id:source+'-'+id,source,operation_id:id,parent_operation_id:parent,profile_json:JSON.stringify({currency,api_key:'PRIVATE KEY'}),spec_json:JSON.stringify({prompt:'PRIVATE PROMPT'}),reserved_minor:amount,settled_minor:settled,outcome:'reserved',created_at:at,updated_at:at});
 }
 reserve('native','dispatch-1',{parent:'same-id',amount:20});reserve('native','dispatch-2',{parent:'same-id',amount:30,settled:12});
 reserve('tts','same-id',{amount:5});reserve('fal','fal-operation',{amount:8});reserve('libtv','api-operation',{amount:100,settled:87});reserve('libtv-cli','cli-operation',{amount:7,currency:'USD'});reserve('tts','before-task-insert',{amount:9});
 b.operation({id:'bob-private-only'});b.usage('bob-private-only','call',{total_tokens:999});
 const before=await readFile(a.path),reply=await f.reader.query(alice,{...window,limit:3});
 assert.equal(reply.version,2);assert.equal(reply.scope,'studio-all');assert.deepEqual(reply.coveredSources,['native','tts','fal','libtv','libtv-cli']);
 assert.equal(reply.summary.operations,6);assert.deepEqual(reply.summary.sources,{native:1,tts:2,fal:1,libtv:1,'libtv-cli':1});assert.equal(reply.summary.totalTokens,17);assert.equal(reply.summary.unreportedUsageOperations,5);
 assert.deepEqual(reply.summary.resources,{images:1,videos:1,audios:1,tasks:4});
 assert.deepEqual(reply.summary.budgetTotals,[{currency:'CNY',entries:6,unsettledEntries:4,settledEntries:2,reservedMinor:172,heldMinor:42,settledMinor:99,overflow:false,overflows:{reservedMinor:false,heldMinor:false,settledMinor:false}},{currency:'USD',entries:1,unsettledEntries:1,settledEntries:0,reservedMinor:7,heldMinor:7,settledMinor:null,overflow:false,overflows:{reservedMinor:false,heldMinor:false,settledMinor:false}}]);
 const next=await f.reader.query(alice,{...window,limit:3,cursor:reply.nextCursor}),items=[...reply.items,...next.items];
 assert.equal(new Set(items.map(row=>row.source+':'+row.operationId)).size,6);assert.equal(next.nextCursor,null);
 assert.equal(items.find(row=>row.source==='fal').state,'unknown');assert.equal(items.find(row=>row.source==='libtv').state,'operator-confirmed');
 assert.equal(items.find(row=>row.operationId==='before-task-insert').kind,'budget-reservation');
 for(const row of items.filter(row=>row.source!=='native'))assert.equal(row.totalTokens,null);
 assert.deepEqual(await readFile(a.path),before);assert.doesNotMatch(JSON.stringify(reply)+JSON.stringify(next),/PRIVATE|api_key|PROMPT|bob-private/);
 insert('muse_tts_generations',{rowid:7,operation_id:'ties-with-orphan',state:'completed',created_at:at,completed_at:at});
 const paged=[];let cursor;
 do{const page=await f.reader.query(alice,{...window,limit:1,...cursor?{cursor}:{}});paged.push(...page.items.map(row=>row.source+':'+row.operationId));cursor=page.nextCursor;}while(cursor);
 assert.equal(new Set(paged).size,7);assert.ok(paged.includes('tts:ties-with-orphan'));assert.ok(paged.includes('tts:before-task-insert'));
 a.db.prepare("UPDATE muse_libtv_cli_operations SET state='reviewed' WHERE operation_id=?").run('cli-operation');
 const reviewed=await f.reader.query(alice,window),reviewedCli=reviewed.items.find(row=>row.source==='libtv-cli');
 assert.equal(reviewedCli.state,'unknown');assert.equal(reviewedCli.recordedState,'reviewed');assert.equal(reviewedCli.totalTokens,null);
 assert.equal(reviewed.summary.budgetTotals.find(value=>value.currency==='USD').heldMinor,7);
 assert.equal(reviewed.summary.states['operator-confirmed'],1);
 reserve('native','overflow-dispatch',{parent:'same-id',amount:Number.MAX_SAFE_INTEGER});
 const overflow=(await f.reader.query(alice,window)).summary.budgetTotals.find(value=>value.currency==='CNY');
 assert.equal(overflow.reservedMinor,null);assert.equal(overflow.heldMinor,null);assert.equal(overflow.settledMinor,99);assert.deepEqual(overflow.overflows,{reservedMinor:true,heldMinor:true,settledMinor:false});
 for(const marker of ['muse_audio_schema','muse_postproduction_schema','muse_libtv_schema','muse_libtv_cli_schema','muse_budget_schema']){
  const version=a.db.prepare('SELECT version FROM '+marker).get().version;a.db.exec('UPDATE '+marker+' SET version=99');await assert.rejects(f.reader.query(alice,window),{code:'studio_usage_unsupported_schema'});a.db.prepare('UPDATE '+marker+' SET version=?').run(version);
 }
 reserve('tts','invalid-currency',{currency:''});await assert.rejects(f.reader.query(alice,window),{code:'studio_usage_corrupt'});
});

test('repeated real video poll snapshots replace the original resource usage instead of accumulating copies',{skip:!available},async t=>{
 const f=await fixture(t),a=await f.tenant(alice);a.operation({id:'video-operation',kind:'video'});a.resource('video-operation','video','42');
 assert.equal(f.service.recordResourceUsage(a.db,'video',42,{usage:{completion_tokens:12,total_tokens:12}},'fixture-provider-task'),true);
 assert.equal(f.service.recordResourceUsage(a.db,'video',42,{usage:{completion_tokens:16,total_tokens:16}},'fixture-provider-task'),true);
 const result=await f.reader.query(alice,window);assert.equal(result.summary.supplierReports,1);assert.equal(result.summary.outputTokens,16);assert.equal(result.summary.totalTokens,16);assert.equal(result.summary.inputTokens,null);assert.equal(result.summary.resources.videos,1);
});

test('malformed and overflowed supplier reports degrade visibly without inventing totals or leaking payloads',{skip:!available},async t=>{
 const f=await fixture(t),a=await f.tenant(alice);a.operation({id:'invalid-report'});a.usage('invalid-report','bad-json','{"secret":"PRIVATE');a.usage('invalid-report','bad-types',{input_tokens:-1,prompt_tokens:1.5,total_tokens:Number.MAX_SAFE_INTEGER+1,password:'PRIVATE'});
 a.operation({id:'overflow-report'});a.usage('overflow-report','call-one',{input_tokens:Number.MAX_SAFE_INTEGER,total_tokens:0});a.usage('overflow-report','call-two',{input_tokens:1,total_tokens:0});
 const result=await f.reader.query(alice,window);assert.deepEqual(result.health,{state:'degraded',invalidUsageReports:2});assert.equal(result.summary.inputTokens,null);assert.equal(result.summary.outputTokens,null);assert.equal(result.summary.totalTokens,0);assert.deepEqual(result.summary.tokenCoverage.input,{reportedReports:2,unreportedReports:2,overflow:true});
 assert.equal(result.summary.reportedUsageOperations,1);assert.equal(result.summary.unreportedUsageOperations,1);assert.equal(result.items.find(row=>row.operationId==='invalid-report').usageStatus,'error');assert.doesNotMatch(JSON.stringify(result),/PRIVATE|password|NaN|900719925474099/);
});

test('an old database is explicitly uninstrumented; partial or future schemas fail closed',{skip:!available},async t=>{
 const f=await fixture(t),a=await f.tenant(alice,{instrumented:false});let result=await f.reader.query(alice,window);assert.equal(result.status,'not-instrumented');assert.deepEqual(result.items,[]);assert.equal(result.summary.totalTokens,null);
 a.db.exec('CREATE TABLE muse_admission_schema(version INTEGER NOT NULL,database_id TEXT NOT NULL)');await assert.rejects(f.reader.query(alice,window),{code:'studio_usage_corrupt',status:503});
 const b=await f.tenant(bob);b.db.exec('UPDATE muse_admission_schema SET version=2');await assert.rejects(f.reader.query(bob,window),{code:'studio_usage_unsupported_schema',status:503});
});

test('active WAL data is read without writes, checkpointing or starting a worker',{skip:!available},async t=>{
 const f=await fixture(t),a=await f.tenant(alice);a.db.pragma('journal_mode = WAL');a.db.pragma('wal_autocheckpoint = 0');a.operation({id:'committed-while-worker-open'});a.usage('committed-while-worker-open','call',{total_tokens:7});
 const before=await readFile(a.path),wal=await readFile(a.path+'-wal');assert.equal((await f.reader.query(alice,window)).summary.totalTokens,7);assert.deepEqual(await readFile(a.path),before);assert.deepEqual(await readFile(a.path+'-wal'),wal);
 a.operation({id:'next-live-operation'});assert.equal((await f.reader.query(alice,window)).summary.operations,2);assert.equal(existsSync(join(a.directory,'worker.owner')),false);
});

test('tenant descriptors, hardlinks and symlink selections cannot expose another account database',{skip:!available},async t=>{
 const f=await fixture(t),a=await f.tenant(alice),b=await f.tenant(bob);b.operation({id:'bob-private-operation'});b.usage('bob-private-operation','call',{total_tokens:99});
 await writeFile(join(a.directory,'tenant.json'),JSON.stringify({version:1,accountId:bob}));await assert.rejects(f.reader.query(alice,window),{code:'studio_usage_corrupt'});await writeFile(join(a.directory,'tenant.json'),JSON.stringify({version:1,accountId:alice}));
 a.db.close();await rm(a.path);await link(b.path,a.path);await assert.rejects(f.reader.query(alice,window),{code:'studio_usage_corrupt'});await rm(a.path);
 if(process.platform==='win32')await symlink(b.directory,join(f.config.tenantRoot,carol),'junction');else await symlink(b.directory,join(f.config.tenantRoot,carol),'dir');
 await assert.rejects(f.reader.query(carol,window),{code:'studio_usage_corrupt'});
});

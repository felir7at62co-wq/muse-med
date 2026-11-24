/** Real SQLite and HTTP monetary admission with synthetic projects and local supplier fixtures. */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire,Module} from 'node:module';
import {existsSync,readFileSync} from 'node:fs';
import {mkdtemp,mkdir,rm,writeFile,readFile,symlink,cp} from 'node:fs/promises';
import {resolve,join,dirname,basename,relative} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createHash,randomUUID} from 'node:crypto';
import {createServer,request as httpRequest} from 'node:http';
import {spawn} from 'node:child_process';
import {planMuseBudget} from '../compatibility/muse-budget.mjs';
import {museAdmissionRoutes} from '../compatibility/muse-admission.mjs';

const backend=resolve(process.env.LOCALMINIDRAMA_SOURCE||'.local/localminidrama','backend-node'),available=existsSync(join(backend,'node_modules/better-sqlite3/package.json'));
const extension=name=>fileURLToPath(new URL('../extensions/'+name,import.meta.url));
const hash=value=>createHash('sha256').update(value).digest('hex');
const owners=new WeakMap();
// The pinned Windows Node 24 addon requires statement wrappers to outlive asynchronous test callbacks.
const nativeStatements=[],nativeDatabases=[];
let chromium;
try{const candidate=createRequire(resolve('apps/web/package.json'))('playwright').chromium;if(existsSync(candidate.executablePath()))chromium=candidate;}catch(error){if(error.code!=='MODULE_NOT_FOUND')throw error;}
const listen=server=>new Promise(resolve=>server.listen(0,'127.0.0.1',()=>resolve('http://127.0.0.1:'+server.address().port)));
const close=async server=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));};
const profile=(service='text',extra={})=>({id:'fixture-'+service,service,provider:'fixture',model:'fixture-model',origin:'http://127.0.0.1:1',currency:'CNY',reserve_minor:60,source:'operator-entered',effective_at:'2026-01-01T00:00:00.000Z',expires_at:'2099-01-01T00:00:00.000Z',estimate_kind:service==='agent-task'?'operator-task-envelope':'per-dispatch-estimate',...extra});
function compile(file,require,overrides={}){const module=new Module(file);module.filename=file;module.require=name=>Object.hasOwn(overrides,name)?overrides[name]:require(name);module._compile(readFileSync(file,'utf8'),file);return module.exports;}
async function fixture(t,{cfg={muse_budget:{prices:[profile()]}},path}={}){
 let owner=owners.get(t);if(!owner){owner={homes:[],connections:[],servers:[],cleanups:[]};owners.set(t,owner);t.after(async()=>{for(const cleanup of owner.cleanups)await cleanup();for(const server of owner.servers)await close(server);for(const db of owner.connections)if(db.open)db.close();for(const home of owner.homes){assert.equal(dirname(resolve(home)),resolve(tmpdir()));assert.ok(basename(home).startsWith('muse-budget-test-'));await rm(home,{recursive:true,force:true,maxRetries:5,retryDelay:20});}});}
 const home=await mkdtemp(join(tmpdir(),'muse-budget-test-')),connections=owner.connections,servers=owner.servers,require=createRequire(join(backend,'package.json')),Database=require('better-sqlite3');owner.homes.push(home);
 const db=new Database(path??join(home,'tenant.db'));connections.push(db);nativeDatabases.push(db);const statements=[],original=db.prepare.bind(db);db.prepare=sql=>{const statement=original(sql);statements.push(statement);nativeStatements.push(statement);return statement;};
 db.exec(`CREATE TABLE IF NOT EXISTS dramas(id INTEGER PRIMARY KEY,deleted_at TEXT);INSERT OR IGNORE INTO dramas VALUES(1,NULL),(2,NULL);
 CREATE TABLE IF NOT EXISTS episodes(id INTEGER PRIMARY KEY,drama_id INTEGER,deleted_at TEXT);INSERT OR IGNORE INTO episodes VALUES(10,1,NULL),(20,2,NULL);
 CREATE TABLE IF NOT EXISTS storyboards(id INTEGER PRIMARY KEY,episode_id INTEGER,deleted_at TEXT);INSERT OR IGNORE INTO storyboards VALUES(100,10,NULL),(200,20,NULL);
 CREATE TABLE IF NOT EXISTS characters(id INTEGER PRIMARY KEY,drama_id INTEGER,deleted_at TEXT);CREATE TABLE IF NOT EXISTS scenes(id INTEGER PRIMARY KEY,drama_id INTEGER,deleted_at TEXT);CREATE TABLE IF NOT EXISTS props(id INTEGER PRIMARY KEY,drama_id INTEGER,deleted_at TEXT);
 CREATE TABLE IF NOT EXISTS async_tasks(id TEXT PRIMARY KEY,status TEXT);CREATE TABLE IF NOT EXISTS image_generations(id INTEGER PRIMARY KEY,status TEXT);CREATE TABLE IF NOT EXISTS video_generations(id INTEGER PRIMARY KEY,status TEXT);
 CREATE TABLE IF NOT EXISTS ai_service_configs(id INTEGER PRIMARY KEY,name TEXT,service_type TEXT,provider TEXT,base_url TEXT,model TEXT,is_active INTEGER,deleted_at TEXT,api_key TEXT);INSERT OR IGNORE INTO ai_service_configs VALUES(1,'Fixture model','text','fixture','http://127.0.0.1:1/v1','["fixture-model"]',1,NULL,'PRIVATE PROVIDER KEY');`);
 const admission=compile(extension('muse-admission.cjs'),require,{'./museAdmissionCatalog.json':museAdmissionRoutes});
 const budget=compile(extension('muse-budget.cjs'),require,{'./museAdmission':admission});
 const routes=compile(extension('muse-budget-routes.cjs'),require,{'../services/museBudget':budget});
 admission.schema(db);budget.schema(db,cfg);
 const authorize=(projectId=1,limit=100,extra={})=>budget.updateProject(db,cfg,projectId,{operation_id:randomUUID(),expected_revision:budget.readProject(db,cfg,projectId).revision,currency:'CNY',limit_minor:limit,allow_estimates:true,allow_task_envelopes:false,...extra});
 const reserve=(operationId=randomUUID(),extra={})=>budget.reserve(db,cfg,{source:'libtv',operation_id:operationId,project_id:1,request_sha256:hash(operationId),service:'text',provider:'fixture',model:'fixture-model',origin:'http://127.0.0.1:1',quantity:1,...extra});
 async function http(handler,setup){const express=require('express'),app=express(),router=express.Router();app.use(express.json());admission.register(router,db,cfg);routes.register(router,db,cfg);if(handler)router.post('/generation/story',handler);if(setup)setup(router);app.use('/api/v1',router);const server=createServer(app);servers.push(server);const base=await listen(server);const call=async(path,body,method=body===undefined?'GET':'POST',headers={})=>{const response=await fetch(base+'/api/v1'+path,{method,headers:{'content-type':'application/json',...headers},...body===undefined?{}:{body:JSON.stringify(path.startsWith('/muse/budget')?{database_id:budget.databaseId(db,cfg),...body}:body)}});const data=await response.json();return {status:response.status,data};};call.base=base;return call;}
 return {home,db,cfg,require,budget,admission,authorize,reserve,http,statements};
}

test('missing prices, explicit authorization, currencies and administrator ceilings fail before a paid reservation',{skip:!available},async t=>{
 const f=await fixture(t);assert.throws(()=>f.reserve(),{code:'budget_limit_required'});f.authorize(1,100,{allow_estimates:false});assert.throws(()=>f.reserve(),{code:'budget_estimate_not_authorized'});f.authorize();assert.throws(()=>f.reserve(randomUUID(),{model:'unknown-model'}),{code:'budget_price_unknown'});assert.equal(f.budget.readProject(f.db,f.cfg,1).reserved_minor,0);
 assert.throws(()=>f.budget.updateProject(f.db,f.cfg,1,{operation_id:randomUUID(),expected_revision:2,currency:'USD',limit_minor:100,allow_estimates:true,allow_task_envelopes:false}),{code:'budget_invalid_limit'});
 assert.throws(()=>f.budget.updateProject(f.db,{muse_budget:{max_project_limit_minor:50}},2,{operation_id:randomUUID(),expected_revision:0,currency:'CNY',limit_minor:51,allow_estimates:true,allow_task_envelopes:false}),{code:'budget_invalid_limit'});
 const reduced={muse_budget:{max_project_limit_minor:50,prices:[profile()]}};assert.equal(f.budget.readProject(f.db,reduced,1).available_minor,50);assert.throws(()=>f.budget.reserve(f.db,reduced,{source:'libtv',operation_id:'admin-cap-enforced',project_id:1,request_sha256:hash('admin-cap'),service:'text',provider:'fixture',model:'fixture-model',origin:'http://127.0.0.1:1'}),{code:'budget_limit_exceeded'});
 assert.throws(()=>f.budget.quote(f.db,{muse_budget:{currency:'USD'}},{project_id:1,service:'text',provider:'fixture',model:'fixture-model',origin:'http://127.0.0.1:1'}),{code:'budget_currency_changed'});
 assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM muse_budget_entries').get().n,0);
});

test('HTTP owner price and budget controls expose public model metadata, CAS edits and immutable price snapshots',{skip:!available},async t=>{
 const f=await fixture(t,{cfg:{}}),call=await f.http();const catalog=await call('/muse/budget/catalog');assert.equal(catalog.status,200);assert.equal(catalog.data.data.configs[0].models[0],'fixture-model');assert.doesNotMatch(JSON.stringify(catalog),/PRIVATE PROVIDER KEY|api_key/);
 const priceInput={...profile(),operation_id:randomUUID(),expected_revision:0,operator_accepted:true};assert.equal((await call('/muse/budget/catalog/fixture-text',priceInput,'PUT')).status,200);
 f.authorize(1,200);const entry=f.reserve('price-snapshot-operation');assert.equal(entry.profile.reserve_minor,60);assert.equal(entry.profile_revision,'owner:1');
 const changed={...priceInput,reserve_minor:20,operation_id:randomUUID(),expected_revision:1};assert.equal((await call('/muse/budget/catalog/fixture-text',changed,'PUT')).status,200);assert.equal((await call('/muse/budget/catalog/fixture-text',{...changed,operation_id:randomUUID()},'PUT')).status,409);
 const replay=f.reserve('price-snapshot-operation');assert.equal(replay.dispatch_allowed,false);assert.equal(replay.reserved_minor,60);assert.equal(replay.profile_revision,'owner:1');assert.equal(f.budget.readProject(f.db,f.cfg,1).reserved_minor,60);
 const expired={...changed,effective_at:'2020-01-01T00:00:00.000Z',expires_at:'2021-01-01T00:00:00.000Z',expected_revision:2,operation_id:randomUUID()};assert.equal((await call('/muse/budget/catalog/fixture-text',expired,'PUT')).status,200);assert.throws(()=>f.reserve(),{code:'budget_price_unknown'});
 assert.equal((await call('/muse/budget/catalog?accountId=other')).status,400);
});

test('a currency change never prices a new USD project with an existing CNY owner profile',{skip:!available},async t=>{
 const f=await fixture(t,{cfg:{}});f.budget.savePrice(f.db,f.cfg,{...profile(),operation_id:randomUUID(),expected_revision:0,operator_accepted:true});f.authorize(1,200);const old=f.reserve('old-cny-reservation');
 const usd={muse_budget:{currency:'USD'}};f.budget.updateProject(f.db,usd,2,{operation_id:randomUUID(),expected_revision:0,currency:'USD',limit_minor:100,allow_estimates:true,allow_task_envelopes:false});const spec={project_id:2,service:'text',provider:'fixture',model:'fixture-model',origin:'http://127.0.0.1:1',quantity:1};
 assert.equal(f.budget.catalog(f.db,usd).items[0].currency,'CNY');assert.equal(f.budget.catalog(f.db,usd).items[0].active,false);assert.throws(()=>f.budget.quote(f.db,usd,spec),{code:'budget_price_unknown'});assert.equal(f.budget.readProject(f.db,usd,2).reserved_minor,0);
 f.budget.savePrice(f.db,usd,{...profile(),currency:'USD',reserve_minor:20,operation_id:randomUUID(),expected_revision:1,operator_accepted:true});assert.equal(f.budget.quote(f.db,usd,spec).reserved_minor,20);const original=f.budget.ledger(f.db,usd,1).items.find(row=>row.entry_id===old.entry_id);assert.equal(original.profile.currency,'CNY');assert.equal(original.reserved_minor,60);assert.equal(f.budget.readProject(f.db,usd,1).currency,'CNY');
});

test('new projects select explicit LibTV credits without converting or disabling CNY prices',{skip:!available},async t=>{
 const shared={id:'same-price-id',provider:'libtv-cli',model:'same-cli-model',origin:'https://api.liblib.tv'};
 const cny=profile('image',{...shared,reserve_minor:42}),ltv=profile('image',{...shared,currency:'LTV',reserve_minor:900});
 const f=await fixture(t,{cfg:{muse_budget:{prices:[cny,ltv]}}}),call=await f.http();
 const empty=await call('/muse/budget/projects/2');assert.equal(empty.data.data.currency,'CNY');assert.equal(empty.data.data.revision,0);assert.equal(empty.data.data.limit_minor,null);
 const authorized=await call('/muse/budget/projects/2',{operation_id:randomUUID(),expected_revision:0,currency:'LTV',limit_minor:10000,allow_estimates:true,allow_task_envelopes:true},'PUT');
 assert.equal(authorized.status,200);assert.equal(authorized.data.data.currency,'LTV');assert.equal(authorized.data.data.available_minor,10000);f.authorize(1,100);
 const catalog=await call('/muse/budget/catalog');assert.equal(catalog.data.data.currency,'CNY');assert.deepEqual(catalog.data.data.items.map(item=>[item.id,item.currency,item.active]),[['same-price-id','CNY',true],['same-price-id','LTV',true]]);
 const spec={service:'image',provider:'libtv-cli',model:'same-cli-model',origin:'https://api.liblib.tv',quantity:1};
 const creditQuote=await call('/muse/budget/quote',{...spec,project_id:2}),moneyQuote=await call('/muse/budget/quote',{...spec,project_id:1});
 assert.equal(creditQuote.status,200);assert.equal(creditQuote.data.data.currency,'LTV');assert.equal(creditQuote.data.data.reserved_minor,900);assert.equal(moneyQuote.status,200);assert.equal(moneyQuote.data.data.currency,'CNY');assert.equal(moneyQuote.data.data.reserved_minor,42);
 f.budget.bindNative(f.db,f.cfg,'mixed-native-operation',hash('mixed-native-operation'),'/images/generate',{drama_id:1});const native=f.budget.nativeTransport(f.db,f.cfg,'mixed-native-operation','mixed-native-call','https://api.liblib.tv/images/generations',{model:spec.model});assert.equal(native.profile.currency,'CNY');assert.equal(native.reserved_minor,42);
 f.cfg.muse_budget.prices.push({...ltv,id:'duplicate-credit-price'});assert.equal((await call('/muse/budget/quote',{...spec,project_id:2})).data.error.code,'budget_price_ambiguous');assert.equal((await call('/muse/budget/quote',{...spec,project_id:1})).data.data.reserved_minor,42);
});

test('LibTV credits reject other providers, non-CLI services and changing an existing project unit',{skip:!available},async t=>{
 const f=await fixture(t,{cfg:{}}),call=await f.http(),credit=profile('image',{id:'credit-image',provider:'libtv-cli',currency:'LTV',origin:'https://api.liblib.tv',reserve_minor:900});
 const writePrice=price=>call('/muse/budget/catalog/'+price.id,{...price,operation_id:randomUUID(),expected_revision:0,operator_accepted:true},'PUT');
 assert.equal((await writePrice(credit)).status,200);
 for(const invalid of [{...credit,id:'wrong-provider',provider:'libtv'},{...credit,id:'wrong-tts',service:'tts'},{...credit,id:'wrong-postproduction',service:'postproduction'}])assert.equal((await writePrice(invalid)).data.error.code,'budget_invalid_price');
 f.authorize(1,100);const limit={operation_id:randomUUID(),expected_revision:0,currency:'LTV',limit_minor:10000,allow_estimates:true,allow_task_envelopes:true};assert.equal((await call('/muse/budget/projects/2',limit,'PUT')).status,200);
 for(const [projectId,currency] of [[1,'LTV'],[2,'CNY']])assert.equal((await call('/muse/budget/projects/'+projectId,{...limit,operation_id:randomUUID(),expected_revision:1,currency},'PUT')).data.error.code,'budget_currency_changed');
 const spec={project_id:2,service:'image',provider:'libtv-cli',model:credit.model,origin:credit.origin,quantity:1};
 assert.equal((await call('/muse/budget/quote',{...spec,provider:'libtv'})).data.error.code,'budget_credit_provider_required');assert.equal((await call('/muse/budget/quote',{...spec,service:'tts'})).data.error.code,'budget_credit_provider_required');
 assert.throws(()=>f.reserve('native-cannot-use-credits',{...spec,source:'native'}),{code:'budget_credit_provider_required'});assert.equal(f.budget.readProject(f.db,f.cfg,2).reserved_minor,0);
 const stored=f.budget.catalog(f.db,f.cfg).items;assert.equal(stored.length,1);assert.equal(stored[0].currency,'LTV');assert.equal(f.budget.readProject(f.db,f.cfg,1).currency,'CNY');assert.equal(f.budget.readProject(f.db,f.cfg,2).currency,'LTV');
});

test('stale browser mutations cannot write a replacement tenant with matching project IDs and revisions',{skip:!available},async t=>{
 const a=await fixture(t),b=await fixture(t);a.authorize();b.authorize();const call=await b.http(),oldDatabase=a.budget.databaseId(a.db,a.cfg),newDatabase=b.budget.databaseId(b.db,b.cfg);assert.notEqual(oldDatabase,newDatabase);
 const body={database_id:oldDatabase,operation_id:randomUUID(),expected_revision:1,currency:'CNY',limit_minor:200,allow_estimates:true,allow_task_envelopes:false};const rejected=await call('/muse/budget/projects/1',body,'PUT');assert.equal(rejected.status,409);assert.equal(rejected.data.error.code,'budget_database_changed');assert.equal(b.budget.readProject(b.db,b.cfg,1).limit_minor,100);
 const price={...profile('image'),database_id:oldDatabase,operation_id:randomUUID(),operator_accepted:true,expected_revision:0};assert.equal((await call('/muse/budget/catalog/fixture-image',price,'PUT')).data.error.code,'budget_database_changed');
 const missing=await fetch(call.base+'/api/v1/muse/budget/projects/1',{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({...body,database_id:undefined})});assert.equal(missing.status,409);assert.equal(b.budget.readProject(b.db,b.cfg,1).limit_minor,100);
});

test('an approved 69 to 78 credit increase preserves spending and replays without replacing a later budget',{skip:!available},async t=>{
 const common={provider:'libtv-cli',currency:'LTV',origin:'https://api.liblib.tv'};
 const initial=profile('image',{...common,id:'initial-credit-plan',model:'initial-plan',reserve_minor:6900});
 const repair=profile('image',{...common,id:'repair-credit-image',model:'repair-image',reserve_minor:900});
 const f=await fixture(t,{cfg:{muse_budget:{prices:[initial,repair]}}}),call=await f.http();
 f.authorize(1,6900,{currency:'LTV'});
 f.reserve('completed-initial-credit-plan',{source:'libtv-cli',service:'image',...common,model:initial.model});
 const before=(await call('/muse/budget/projects/1')).data.data;
 const quote={project_id:1,service:'image',provider:common.provider,model:repair.model,origin:common.origin,quantity:1};
 assert.equal((await call('/muse/budget/quote',quote)).data.data.within_limit,false);
 const increase={operation_id:'approved-credit-increase-69-to-78',expected_revision:before.revision,currency:before.currency,limit_minor:7800,allow_estimates:before.allow_estimates,allow_task_envelopes:before.allow_task_envelopes};
 const saved=await call('/muse/budget/projects/1',increase,'PUT');assert.equal(saved.status,200);
 assert.equal(saved.data.data.limit_minor,7800);assert.equal(saved.data.data.reserved_minor,6900);assert.equal(saved.data.data.settled_minor,0);assert.equal(saved.data.data.available_minor,900);
 assert.equal(saved.data.data.allow_task_envelopes,false);assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM muse_budget_entries').get().n,1);
 assert.equal((await call('/muse/budget/projects/2')).data.data.limit_minor,null);
 assert.equal((await call('/muse/budget/quote',quote)).data.data.within_limit,true);
 f.reserve('approved-repair-credit-image',{source:'libtv-cli',service:'image',...common,model:repair.model});
 assert.equal((await call('/muse/budget/projects/1')).data.data.available_minor,0);
 const stale=await call('/muse/budget/projects/1',{...increase,operation_id:'stale-credit-increase',limit_minor:9000},'PUT');assert.equal(stale.status,409);assert.equal(stale.data.error.code,'budget_revision_conflict');
 assert.deepEqual((await call('/muse/budget/projects/1',increase,'PUT')).data,saved.data);
 const next={...increase,operation_id:'approved-later-credit-increase',expected_revision:saved.data.data.revision,limit_minor:9000};assert.equal((await call('/muse/budget/projects/1',next,'PUT')).status,200);
 assert.deepEqual((await call('/muse/budget/projects/1',increase,'PUT')).data,saved.data);
 const current=(await call('/muse/budget/projects/1')).data.data;assert.equal(current.limit_minor,9000);assert.equal(current.reserved_minor,7800);assert.equal(current.available_minor,1200);assert.equal(current.currency,'LTV');
 assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM muse_budget_entries').get().n,2);
});

test('budget review conditions reject new commitments and changed quotes inside the update transaction',{skip:!available},async t=>{
 const initial=profile('image',{id:'initial-review-image',reserve_minor:60}),extra=profile('image',{id:'extra-review-image',model:'extra-image',reserve_minor:9});
 const f=await fixture(t,{cfg:{muse_budget:{prices:[initial,extra]}}}),call=await f.http();f.authorize(1,100);
 const original=f.reserve('before-budget-review',{service:'image'});f.budget.outcome(f.db,f.cfg,'libtv',original.operation_id,'completed');
 const reviewed=(await call('/muse/budget/projects/1')).data.data;assert.equal(reviewed.budget_review_version,1);
 const spec={service:'image',provider:'fixture',model:extra.model,origin:extra.origin,quantity:1};
 const reviewedQuote=(await call('/muse/budget/quote',{...spec,project_id:1})).data.data;
 const request={operation_id:'guarded-budget-increase',expected_revision:reviewed.revision,currency:reviewed.currency,limit_minor:120,allow_estimates:true,allow_task_envelopes:false,expected_reserved_minor:reviewed.reserved_minor,expected_settled_minor:reviewed.settled_minor,expected_quote:{spec,quote:reviewedQuote}};
 f.reserve('concurrent-budget-commitment',{service:'image',model:extra.model});
 const stale=await call('/muse/budget/projects/1',request,'PUT');assert.equal(stale.status,409);assert.equal(stale.data.error.code,'budget_review_changed');
 assert.equal(f.budget.readProject(f.db,f.cfg,1).revision,reviewed.revision);assert.equal(f.budget.readProject(f.db,f.cfg,1).limit_minor,100);
 const current=f.budget.readProject(f.db,f.cfg,1),liveQuote=f.budget.quote(f.db,f.cfg,{...spec,project_id:1});
 const live={...request,expected_reserved_minor:current.reserved_minor,expected_settled_minor:current.settled_minor,expected_quote:{spec,quote:liveQuote}};
 const row=f.budget.ledger(f.db,f.cfg,1).items.find(item=>item.entry_id===original.entry_id);
 f.budget.reconcile(f.db,f.cfg,original.entry_id,{operation_id:'concurrent-reviewed-invoice',expected_revision:row.revision,amount_minor:60,source:'operator-confirmed-invoice',reference:'Synthetic review invoice',final_invoice_confirmed:true});
 const settled=await call('/muse/budget/projects/1',live,'PUT');assert.equal(settled.status,409);assert.equal(settled.data.error.code,'budget_review_changed');
 const next=f.budget.readProject(f.db,f.cfg,1),nextQuote=f.budget.quote(f.db,f.cfg,{...spec,project_id:1});
 const exact={...live,expected_reserved_minor:next.reserved_minor,expected_settled_minor:next.settled_minor,expected_quote:{spec,quote:nextQuote}};
 extra.reserve_minor=10;
 const repriced=await call('/muse/budget/projects/1',exact,'PUT');assert.equal(repriced.status,409);assert.equal(repriced.data.error.code,'budget_review_changed');
 extra.reserve_minor=9;extra.expires_at='2021-01-01T00:00:00.000Z';extra.effective_at='2020-01-01T00:00:00.000Z';
 const expired=await call('/muse/budget/projects/1',exact,'PUT');assert.equal(expired.status,409);assert.equal(expired.data.error.code,'budget_review_changed');
 extra.effective_at='2026-01-01T00:00:00.000Z';extra.expires_at='2099-01-01T00:00:00.000Z';
 const saved=await call('/muse/budget/projects/1',exact,'PUT');assert.equal(saved.status,200);assert.equal(saved.data.data.limit_minor,120);
 extra.reserve_minor=11;f.reserve('commitment-after-budget-increase',{service:'image',model:extra.model});
 assert.deepEqual((await call('/muse/budget/projects/1',exact,'PUT')).data,saved.data);
 const after=f.budget.readProject(f.db,f.cfg,1);assert.equal(after.limit_minor,120);assert.equal(after.reserved_minor,20);assert.equal(after.settled_minor,60);
 const foreign={...exact,operation_id:'foreign-project-in-review',expected_revision:after.revision,expected_reserved_minor:after.reserved_minor,expected_quote:{spec:{...spec,project_id:2},quote:nextQuote}};
 const refused=await call('/muse/budget/projects/1',foreign,'PUT');assert.equal(refused.status,400);assert.equal(refused.data.error.code,'budget_invalid_review');
 assert.equal(after.revision,f.budget.readProject(f.db,f.cfg,1).revision);
});

test('parallel HTTP reservations fit one budget once, reject overspending and retain unknown holds across restart',{skip:!available},async t=>{
 const f=await fixture(t);f.authorize();let supplierCalls=0;
 const call=await f.http(async(req,res)=>{try{f.budget.nativeCall(f.db,f.cfg,'text',{id:1,provider:'fixture',base_url:'http://127.0.0.1:1/v1'},'fixture-model');supplierCalls++;await Promise.resolve();res.json({success:true,data:{synthetic:'local response'}});}catch(error){res.status(error.status??503).json({success:false,error:{code:error.code}});}});
 const results=await Promise.all([call('/generation/story',{drama_id:1,text:'one'},'POST',{'x-muse-operation-id':'native-parallel-one'}),call('/generation/story',{drama_id:1,text:'two'},'POST',{'x-muse-operation-id':'native-parallel-two'})]);assert.deepEqual(results.map(row=>row.status).sort(),[200,402]);assert.equal(supplierCalls,1);assert.equal(f.budget.readProject(f.db,f.cfg,1).reserved_minor,60);
 const replay=await call('/generation/story',{drama_id:1,text:'one'},'POST',{'x-muse-operation-id':'native-parallel-one'});assert.equal(replay.status,200);assert.equal(supplierCalls,1);
 const other=await fixture(t,{path:join(f.home,'tenant.db')});const entry=other.budget.ledger(other.db,other.cfg,1).items[0];assert.equal(entry.reserved_minor,60);assert.equal(other.budget.readProject(other.db,other.cfg,1).reserved_minor,60);
});

test('uncertain outcomes are never refunds; only explicit final invoice confirmation settles a terminal original operation',{skip:!available},async t=>{
 const f=await fixture(t);f.authorize(1,200);const item=f.reserve('unknown-invoice-operation');f.budget.outcome(f.db,f.cfg,'libtv',item.operation_id,'unknown');let saved=f.budget.ledger(f.db,f.cfg,1).items[0];
 const invoice={operation_id:randomUUID(),expected_revision:saved.revision,amount_minor:0,source:'operator-confirmed-invoice',reference:'Synthetic final invoice',final_invoice_confirmed:true};assert.throws(()=>f.budget.reconcile(f.db,f.cfg,item.entry_id,invoice),{code:'budget_outcome_unknown'});
 assert.throws(()=>f.reserve('new-uuid-same-unknown',{request_sha256:hash(item.operation_id)}),{code:'budget_prior_operation_unresolved'});assert.equal(f.budget.readProject(f.db,f.cfg,1).reserved_minor,60);
 f.budget.outcome(f.db,f.cfg,'libtv',item.operation_id,'failed');saved=f.budget.ledger(f.db,f.cfg,1).items[0];assert.equal(f.budget.readProject(f.db,f.cfg,1).reserved_minor,60);
 assert.throws(()=>f.budget.reconcile(f.db,f.cfg,item.entry_id,{...invoice,expected_revision:saved.revision,final_invoice_confirmed:false}),{code:'budget_invoice_confirmation_required'});
 const final={...invoice,operation_id:randomUUID(),expected_revision:saved.revision,amount_minor:35};const settled=f.budget.reconcile(f.db,f.cfg,item.entry_id,final);assert.equal(settled.project.settled_minor,35);assert.equal(settled.project.reserved_minor,0);assert.equal(settled.entry.invoice.supplier_verified,false);assert.deepEqual(f.budget.reconcile(f.db,f.cfg,item.entry_id,final),settled);
 assert.equal(f.reserve(item.operation_id).dispatch_allowed,false);assert.equal(f.budget.readProject(f.db,f.cfg,1).settled_minor,35);
});

test('raw JSON transports and parameter retries cannot bypass native monetary admission or double-count the first dispatch',{skip:!available},async t=>{
 let supplierCalls=0;const supplier=createServer(async(req,res)=>{for await(const bytes of req){void bytes;}supplierCalls++;res.setHeader('content-type','application/json');res.end(JSON.stringify({usage:{prompt_tokens:3,completion_tokens:2,total_tokens:5}}));}),origin=await listen(supplier);t.after(()=>close(supplier));
 const f=await fixture(t,{cfg:{muse_budget:{prices:[profile('text',{origin})]}}});f.authorize(1,120);
 const call=await f.http(async(req,res)=>{try{
  f.budget.nativeCall(f.db,f.cfg,'text',{id:1,provider:'fixture',base_url:origin+'/v1'},'fixture-model');
  for(let index=0;index<3;index++){const body={model:'fixture-model'},observe=f.admission.startSupplierCall(origin+'/v1/chat/completions',body);const reply=await fetch(origin+'/v1/chat/completions',{method:'POST',body:JSON.stringify(body)});observe(await reply.json());}
  res.json({success:true,data:{}});
 }catch(error){res.status(error.status??503).json({success:false,error:{code:error.code}});}});
 const result=await call('/generation/story',{drama_id:1},'POST',{'x-muse-operation-id':'bounded-transports-operation'});assert.equal(result.status,402);assert.equal(supplierCalls,2);assert.equal(f.budget.readProject(f.db,f.cfg,1).reserved_minor,120);assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM muse_budget_entries').get().n,2);assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM muse_native_supplier_usage').get().n,2);assert.equal(f.admission.info(f.db,f.db.prepare('SELECT * FROM muse_native_operations WHERE operation_id=?').get('bounded-transports-operation')).state,'unknown');
});

test('an in-flight HTTP reservation owns the SQLite writer lock until its reservation commits',{skip:!available,timeout:45000},async t=>{
 const f=await fixture(t);f.authorize();f.db.exec('PRAGMA busy_timeout=0');const release=join(f.home,'release-child');
 const program=`const {createRequire}=require('node:module'),fs=require('node:fs'),http=require('node:http');const [pkg,budgetFile,file,configFile,release]=process.argv.slice(1),r=createRequire(pkg),Database=r('better-sqlite3'),db=new Database(file),budget=require(budgetFile),cfg=JSON.parse(fs.readFileSync(configFile,'utf8'));const retained=[];const prepare=db.prepare.bind(db);db.prepare=sql=>{const statement=prepare(sql);retained.push(statement);if(sql.startsWith('INSERT INTO muse_budget_entries(')){const run=statement.run.bind(statement);statement.run=(...args)=>{process.send({type:'holding'});const deadline=Date.now()+15000;while(!fs.existsSync(release)){if(Date.now()>deadline)throw Error('fixture barrier timed out');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);}return run(...args);};}return statement;};budget.schema(db,cfg);const server=http.createServer(async(req,res)=>{for await(const part of req){void part;}try{const value=budget.reserve(db,cfg,{source:'libtv',operation_id:'child-http-reservation',project_id:1,request_sha256:'a'.repeat(64),service:'text',provider:'fixture',model:'fixture-model',origin:'http://127.0.0.1:1',quantity:1});res.writeHead(201,{'content-type':'application/json'});res.end(JSON.stringify({reserved_minor:value.reserved_minor}));}catch(error){res.writeHead(error.status||503,{'content-type':'application/json'});res.end(JSON.stringify({code:error.code||'fixture_failed'}));}});server.listen(0,'127.0.0.1',()=>process.send({type:'ready',port:server.address().port}));process.on('message',message=>{if(message.type==='stop'){server.closeAllConnections();server.close(()=>{db.close();process.disconnect();});}});`;
 const configFile=join(f.home,'config.json');await writeFile(configFile,JSON.stringify(f.cfg));
 const child=spawn(process.execPath,['--input-type=commonjs','--eval',program,join(backend,'package.json'),extension('muse-budget.cjs'),join(f.home,'tenant.db'),configFile,release],{stdio:['ignore','ignore','pipe','ipc'],windowsHide:true});let diagnostics='';child.stderr.on('data',bytes=>{diagnostics+=bytes.toString();});let exitResult;const exited=new Promise(resolve=>child.once('close',(code,signal)=>{exitResult={code,signal};resolve(exitResult);}));
 owners.get(t).cleanups.push(async()=>{await writeFile(release,'release');if(child.connected)child.send({type:'stop'});const timer=setTimeout(()=>child.kill(),10000);try{await exited;}finally{clearTimeout(timer);}});
 const wait=type=>new Promise((resolve,reject)=>{const timer=setTimeout(()=>{child.off('message',onMessage);reject(Error('Child fixture did not reach '+type));},20000);const onMessage=message=>{if(message.type===type){clearTimeout(timer);child.off('message',onMessage);resolve(message);}};child.on('message',onMessage);});
 const ready=await wait('ready'),holding=wait('holding'),request=fetch('http://127.0.0.1:'+ready.port,{method:'POST',body:'synthetic'});await holding;
 assert.throws(()=>f.db.prepare('UPDATE muse_project_budgets SET limit_minor=limit_minor WHERE project_id=1').run(),error=>error.code==='SQLITE_BUSY');
 await writeFile(release,'release');const response=await request;assert.equal(response.status,201,diagnostics);assert.deepEqual(await response.json(),{reserved_minor:60});assert.throws(()=>f.reserve('second-process-over-cap'),{code:'budget_limit_exceeded'});assert.equal(f.budget.readProject(f.db,f.cfg,1).reserved_minor,60);
 child.send({type:'stop'});await exited;assert.deepEqual(exitResult,{code:0,signal:null});
});

test('opaque Agent tasks require a separately accepted envelope and operator termination stays distinct',{skip:!available},async t=>{
 const f=await fixture(t,{cfg:{muse_budget:{prices:[profile('agent-task')]}}});f.authorize(1,200);const spec={service:'agent-task'};assert.throws(()=>f.reserve('opaque-agent-operation',spec),{code:'budget_task_envelope_not_authorized'});f.authorize(1,200,{allow_task_envelopes:true});const entry=f.reserve('opaque-agent-operation',spec);assert.equal(entry.profile.estimate_kind,'operator-task-envelope');assert.equal(entry.cannot_enforce_supplier_cap,true);assert.throws(()=>f.reserve('opaque-many-agent-ops',{...spec,quantity:2}),{code:'budget_task_envelope_not_authorized'});
 f.budget.outcome(f.db,f.cfg,'libtv',entry.operation_id,'operator-confirmed');const row=f.budget.ledger(f.db,f.cfg,1).items[0];assert.equal(row.outcome,'operator-confirmed');assert.equal(row.settled_minor,null);assert.equal(row.billing_verified,false);
});

test('schema-bounded CLI reservations retain their own quantity and never inherit another transport outcome',{skip:!available},async t=>{
 const f=await fixture(t,{cfg:{muse_budget:{prices:[profile('image',{provider:'libtv-cli',model:'fixture-cli-model',origin:'https://www.liblib.tv',reserve_minor:20})]}}});f.authorize(1,100);const spec={source:'libtv-cli',service:'image',provider:'libtv-cli',model:'fixture-cli-model',origin:'https://www.liblib.tv',quantity:3},entry=f.reserve('cli-three-results-operation',spec);assert.equal(entry.reserved_minor,60);f.budget.outcome(f.db,f.cfg,'libtv-cli',entry.operation_id,'unknown');const before=f.budget.ledger(f.db,f.cfg,1).items[0];assert.equal(before.outcome,'unknown');assert.equal(before.source,'libtv-cli');assert.equal(f.reserve(entry.operation_id,spec).dispatch_allowed,false);assert.throws(()=>f.reserve('cli-new-uuid-same-unknown',{...spec,request_sha256:hash(entry.operation_id)}),{code:'budget_prior_operation_unresolved'});assert.equal(f.budget.readProject(f.db,f.cfg,1).reserved_minor,60);
});

test('the owner receipt distinguishes authorization, unknown holds and an operator-confirmed invoice',{skip:!available},async t=>{
 const f=await fixture(t,{cfg:{muse_budget:{prices:[profile('tts')]}}});f.authorize();const entry=f.reserve('expected-receipt-operation',{source:'tts',service:'tts'}),replay=f.reserve('expected-receipt-operation',{source:'tts',service:'tts'});f.budget.outcome(f.db,f.cfg,'tts',entry.operation_id,'unknown');let row=f.budget.ledger(f.db,f.cfg,1).items[0];const unknown=f.budget.readProject(f.db,f.cfg,1);let code;
 try{f.budget.reconcile(f.db,f.cfg,entry.entry_id,{operation_id:randomUUID(),expected_revision:row.revision,amount_minor:0,source:'operator-confirmed-invoice',reference:'Synthetic invoice',final_invoice_confirmed:true});}catch(error){code=error.code;}
 f.budget.outcome(f.db,f.cfg,'tts',entry.operation_id,'completed');row=f.budget.ledger(f.db,f.cfg,1).items[0];const final=f.budget.reconcile(f.db,f.cfg,entry.entry_id,{operation_id:randomUUID(),expected_revision:row.revision,amount_minor:35,source:'operator-confirmed-invoice',reference:'Synthetic invoice',final_invoice_confirmed:true});
 assert.deepEqual({scope:'one authenticated tenant and one project',currency:final.project.currency,initialLimitMinor:unknown.limit_minor,reservationMinor:entry.reserved_minor,replayDispatchAllowed:replay.dispatch_allowed,unknownReservedMinor:unknown.reserved_minor,unknownInvoiceCode:code,settledMinor:final.project.settled_minor,remainingReservedMinor:final.project.reserved_minor,invoiceSource:final.entry.invoice.source,supplierVerified:final.entry.invoice.supplier_verified,supplierHardCapGuaranteed:!entry.cannot_enforce_supplier_cap},JSON.parse(await readFile(new URL('./expected/muse-budget.json',import.meta.url),'utf8')));
});

test('task completion and supplier tokens yield estimates while all money stays reserved until invoice confirmation',{skip:!available},async t=>{
 const f=await fixture(t,{cfg:{muse_budget:{prices:[profile('text',{rates:{input_per_million_minor:1000000,output_per_million_minor:2000000}})]}}});f.authorize(1,200);const operationId='native-usage-operation';f.admission.reserve(f.db,f.cfg,operationId,'/generation/story',{drama_id:1});f.budget.bindNative(f.db,f.cfg,operationId,hash('native'),'/generation/story',{drama_id:1});
 const entry=f.reserve('budget-native-call',{source:'native',parent_operation_id:operationId});f.db.prepare('INSERT INTO muse_native_supplier_usage VALUES(?,?,?,?)').run(operationId,'one',JSON.stringify({input_tokens:3,prompt_tokens:999,output_tokens:2,total_tokens:null}),new Date().toISOString());f.db.prepare("UPDATE muse_native_operations SET state='completed' WHERE operation_id=?").run(operationId);f.admission.getActiveOperationCount(f.db);const row=f.budget.ledger(f.db,f.cfg,1).items[0];assert.equal(row.usage_estimate_minor,7);assert.equal(row.usage_estimate_is_bill,false);assert.equal(row.settled_minor,null);assert.equal(f.budget.readProject(f.db,f.cfg,1).reserved_minor,60);assert.equal(entry.billing_verified,false);
});

test('TTS and segmented Fal reservations count their actual planned units and stay isolated by tenant and project',{skip:!available},async t=>{
 const f=await fixture(t,{cfg:{muse_budget:{prices:[profile('tts',{reserve_minor:10,rates:{characters_per_thousand_minor:50}}),profile('postproduction',{reserve_minor:30})]}}});f.authorize(1,200);f.authorize(2,200);
 const tts=f.reserve('tts-generation-operation',{source:'tts',service:'tts',usage_basis:{characters:1200}}),fal=f.reserve('fal-segments-operation',{source:'fal',service:'postproduction',quantity:3});assert.equal(tts.reserved_minor,60);assert.equal(fal.reserved_minor,90);assert.equal(f.budget.readProject(f.db,f.cfg,1).reserved_minor,150);assert.equal(f.budget.readProject(f.db,f.cfg,2).reserved_minor,0);assert.equal(f.budget.ledger(f.db,f.cfg,1).items.find(row=>row.source==='tts').usage_estimate_minor,60);
 const b=await fixture(t);b.authorize(1,100);assert.equal(b.budget.readProject(b.db,b.cfg,1).reserved_minor,0);assert.throws(()=>f.budget.projectForRequest(f.db,'/storyboards/200/generate',{drama_id:1}),{code:'budget_project_required'});
});

test('immutable inputs, monotonic schema and explicit over-budget invoices survive reopen',{skip:!available},async t=>{
 const f=await fixture(t);f.authorize();const entry=f.reserve('final-overrun-operation');assert.throws(()=>f.db.prepare('UPDATE muse_budget_entries SET reserved_minor=1').run(),/budget_input_immutable/);assert.throws(()=>f.authorize(1,40),{code:'budget_limit_below_commitments'});f.budget.outcome(f.db,f.cfg,'libtv',entry.operation_id,'completed');const saved=f.budget.ledger(f.db,f.cfg,1).items[0];f.budget.reconcile(f.db,f.cfg,entry.entry_id,{operation_id:randomUUID(),expected_revision:saved.revision,amount_minor:120,source:'operator-confirmed-invoice',reference:'Synthetic actual overrun',final_invoice_confirmed:true});assert.equal(f.budget.readProject(f.db,f.cfg,1).over_limit,true);assert.throws(()=>f.reserve(),{code:'budget_limit_exceeded'});
 const second=await fixture(t,{path:join(f.home,'tenant.db')});assert.equal(second.budget.readProject(second.db,second.cfg,1).settled_minor,120);assert.equal(second.reserve(entry.operation_id).dispatch_allowed,false);second.db.prepare('UPDATE muse_budget_schema SET version=2').run();const third=compile(extension('muse-budget.cjs'),second.require,{'./museAdmission':second.admission});assert.throws(()=>third.schema(second.db,second.cfg),{code:'budget_unsupported_schema'});
});

test('planner installs all gates against staged source and rejects changed or repeated anchors',async t=>{
 const home=await mkdtemp(join(tmpdir(),'muse-budget-plan-'));t.after(async()=>{assert.equal(dirname(resolve(home)),resolve(tmpdir()));await rm(home,{recursive:true,force:true});});
 const stage=resolve('.local/muse-cloud/studio-source-20261112-final');if(!existsSync(join(stage,'backend-node/src/services/aiClient.js'))){t.skip('The complete pinned compatibility stage is not installed');return;}
 const source=file=>{const name=relative(home,file).replaceAll('\\','/');if(name==='backend-node/src/services/museAudioService.js')return readFileSync(extension('muse-audio.cjs'),'utf8');if(name==='backend-node/src/services/musePostproduction.js')return readFileSync(extension('muse-postproduction.cjs'),'utf8');return readFileSync(resolve(stage,name),'utf8');};
 const changes=planMuseBudget(home,source);assert.ok(changes.some(([file,text])=>file.endsWith('museBudget.js')&&text.includes('BEGIN')===false));assert.ok(changes.some(([file,text])=>file.endsWith('imageClient.js')&&text.includes("'image', config, model, opts")));assert.ok(changes.some(([file,text])=>file.endsWith('museAudioService.js')&&text.indexOf("source:'tts'")>text.indexOf('tts_prior_operation_unresolved')));
 const mapped=new Map(changes);assert.throws(()=>planMuseBudget(home,file=>mapped.get(file)??source(file)),/does not match|selection changed|observers changed/);assert.throws(()=>planMuseBudget(home,file=>source(file).replace('  const model = getModelFromConfig(config, preferredModel);','  const changed = true;')),/does not match/);
});

test('the real budget dialog saves owner authorization and prices, reconciles an invoice and fits 390px',{skip:!available||!chromium,timeout:45000},async t=>{
 const f=await fixture(t);f.authorize(1,300);const pending=f.reserve('browser-unknown-operation');f.budget.outcome(f.db,f.cfg,pending.source,pending.operation_id,'unknown');const completed=f.reserve('browser-completed-operation');f.budget.outcome(f.db,f.cfg,completed.source,completed.operation_id,'completed');const api=await f.http();
 const web=join(f.home,'web'),source=join(web,'src');await mkdir(join(source,'components'),{recursive:true});await mkdir(join(source,'utils'));
 await symlink(resolve(backend,'../frontweb/node_modules'),join(web,'node_modules'),process.platform==='win32'?'junction':'dir');
 await writeFile(join(web,'index.html'),'<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><div id="app"></div><script type="module" src="/src/main.js"></script>');
 await writeFile(join(source,'main.js'),"import{createApp}from'vue';import ElementPlus from'element-plus';import'element-plus/dist/index.css';import Panel from'./components/MuseBudgetPanel.vue';createApp(Panel,{projectId:Number(new URLSearchParams(location.search).get('project')||1)}).use(ElementPlus).mount('#app');");
 await writeFile(join(source,'components/MuseBudgetPanel.vue'),readFileSync(extension('muse-budget-panel.vue')));await writeFile(join(source,'utils/museBudget.js'),readFileSync(extension('muse-budget-client.js')));await writeFile(join(source,'utils/museAdmissionCatalog.json'),JSON.stringify(museAdmissionRoutes));
 await writeFile(join(source,'utils/museStudioPath.js'),readFileSync(resolve('.local/muse-cloud/studio-source-20261112-final/frontweb/src/utils/museStudioPath.js')));
 const frontRequire=createRequire(resolve(backend,'../frontweb/package.json')),vite=await import(pathToFileURL(frontRequire.resolve('vite')).href),vue=(await import(pathToFileURL(frontRequire.resolve('@vitejs/plugin-vue')).href)).default;
 await (vite.build??vite.default.build)({root:web,base:'/studio/',logLevel:'silent',plugins:[vue()],resolve:{alias:{'@':source}},build:{outDir:join(web,'dist'),chunkSizeWarningLimit:2000}});
 const express=f.require('express'),app=express();app.use('/studio/api',(req,res)=>{const upstream=httpRequest(new URL('/api'+req.url,api.base),{method:req.method,headers:{'content-type':req.headers['content-type']||'application/json',...req.headers['x-muse-operation-id']?{'x-muse-operation-id':req.headers['x-muse-operation-id']}:{}}},incoming=>{res.writeHead(incoming.statusCode,incoming.headers);incoming.pipe(res);});upstream.on('error',()=>{if(!res.headersSent)res.writeHead(503);res.end();});req.pipe(upstream);});app.use('/studio',express.static(join(web,'dist')));
 const server=createServer(app);owners.get(t).servers.push(server);const url=await listen(server),browser=await chromium.launch({headless:true});owners.get(t).cleanups.push(()=>browser.close());const page=await browser.newPage({viewport:{width:390,height:844}}),errors=[];page.on('pageerror',error=>errors.push(error.message));await page.goto(url+'/studio/');await page.getByText('本项目总预算（金额，非 Token；人工核销可记录已发生的超额费用）').waitFor();
 await page.locator('.el-form-item').filter({hasText:'本项目总预算'}).locator('input').fill('2.00');await page.getByRole('button',{name:'明确保存本项目预算授权'}).click();await page.waitForFunction(()=>document.body.textContent.includes('上限 2.00'));
 await page.getByText('模型能力、价格来源与本账户估价设置',{exact:true}).click();await page.getByPlaceholder('本账户价格标识，如 seedance-video').fill('owner-video-price');await page.getByPlaceholder('实际 provider，须与 API 配置完全相同').fill('fixture');await page.getByPlaceholder('实际 model，须与派发值完全相同').fill('fixture-video');await page.getByPlaceholder('实际 API Origin，如 https://api.example.com').fill('https://supplier.fixture.test');await page.getByPlaceholder('每次派发/整任务的预占金额').fill('0.50');await page.getByPlaceholder('过期 ISO UTC 时间').fill('2099-01-01T00:00:00.000Z');await page.getByText('这是我明确接受的本账户估价与有效期，不是供应商核验后的账单',{exact:true}).click();await page.getByRole('button',{name:'保存本账户估价',exact:true}).click();await page.waitForFunction(()=>document.body.textContent.includes('fixture-video'));
 assert.equal(f.budget.catalog(f.db,f.cfg).items.find(row=>row.id==='owner-video-price').reserve_minor,50);assert.doesNotMatch(await page.locator('body').innerText(),/PRIVATE PROVIDER KEY|api_key/);
 await page.getByRole('button',{name:'按最终供应商账单人工核销',exact:true}).click();await page.getByPlaceholder('最终费用金额').fill('0.35');await page.getByPlaceholder('账单/订单核对依据，不填密码或密钥').fill('Synthetic invoice reviewed in browser');await page.getByText('我已核对最终账单，明确确认此金额与依据',{exact:true}).click();await page.getByRole('button',{name:'明确核销并保留原预占记录',exact:true}).click();await page.waitForFunction(()=>document.body.textContent.includes('已人工核销 0.35'));
 assert.equal(f.budget.readProject(f.db,f.cfg,1).settled_minor,35);assert.equal(f.budget.readProject(f.db,f.cfg,1).reserved_minor,60);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true);assert.deepEqual(errors,[]);
 await page.goto(url+'/studio/?project=2');await page.locator('.el-form-item').filter({hasText:'预算计价单位'}).locator('.el-select').click();await page.getByRole('option',{name:'LibTV 积分',exact:true}).click();
 await page.getByText('本项目总预算（LibTV 积分）',{exact:true}).waitFor();await page.locator('.el-form-item').filter({hasText:'本项目总预算'}).locator('input').fill('100');await page.getByText('我接受按模型预估金额预占；实际收费可能更高，且未结预占不会自动释放',{exact:true}).click();await page.getByRole('button',{name:'明确保存本项目预算授权'}).click();await page.waitForFunction(()=>document.body.textContent.includes('上限 100.00'));
 assert.equal(f.budget.readProject(f.db,f.cfg,2).currency,'LTV');assert.equal(f.budget.readProject(f.db,f.cfg,2).limit_minor,10000);assert.equal(await page.locator('.el-form-item').filter({hasText:'预算计价单位'}).locator('input').isDisabled(),true);
 await page.getByText('模型能力、价格来源与本账户估价设置',{exact:true}).click();const provider=page.getByPlaceholder('实际 provider，须与 API 配置完全相同');assert.equal(await provider.inputValue(),'libtv-cli');assert.equal(await provider.isDisabled(),true);
 await page.getByPlaceholder('本账户价格标识，如 seedance-video').fill('owner-cli-credit-price');await page.getByPlaceholder('实际 model，须与派发值完全相同').fill('seedance-credit-test');await page.getByPlaceholder('每次派发/整任务的预占积分').fill('69');await page.getByPlaceholder('过期 ISO UTC 时间').fill('2099-01-01T00:00:00.000Z');await page.getByText('这是我明确接受的本账户估价与有效期，不是供应商核验后的账单',{exact:true}).click();await page.getByRole('button',{name:'保存本账户估价',exact:true}).click();await page.waitForFunction(()=>document.body.textContent.includes('seedance-credit-test'));
 const credit=f.budget.catalog(f.db,f.cfg).items.find(row=>row.id==='owner-cli-credit-price');assert.equal(credit.currency,'LTV');assert.equal(credit.provider,'libtv-cli');assert.equal(credit.reserve_minor,6900);assert.match(await page.locator('body').innerText(),/LibTV 积分 69.00/);assert.doesNotMatch(await page.locator('body').innerText(),/fixture-video/);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true);assert.deepEqual(errors,[]);
});

test('the actual global API configuration page selects a budget project for one paid text test and keeps media checks free',{skip:!available||!chromium,timeout:60000},async t=>{
 let supplierCalls=0;const supplier=createServer(async(req,res)=>{for await(const bytes of req){void bytes;}supplierCalls++;res.setHeader('content-type','application/json');res.end(JSON.stringify({choices:[{message:{content:'synthetic connectivity response'}}],usage:{prompt_tokens:2,completion_tokens:1,total_tokens:3}}));}),origin=await listen(supplier);t.after(()=>close(supplier));
 const f=await fixture(t,{cfg:{muse_budget:{prices:[profile('text',{provider:'openai',origin})]}}});f.authorize(1,100);const planRoot=join(f.home,'plan'),stage=resolve('.local/muse-cloud/studio-source-20261112-final');
 const source=file=>{const name=relative(planRoot,file).replaceAll('\\','/');if(name==='backend-node/src/services/museAudioService.js')return readFileSync(extension('muse-audio.cjs'),'utf8');if(name==='backend-node/src/services/musePostproduction.js')return readFileSync(extension('muse-postproduction.cjs'),'utf8');return readFileSync(resolve(stage,name),'utf8');},changes=new Map(planMuseBudget(planRoot,source));
 const load=(file,overrides)=>{const module=new Module(file);module.filename=file;const resolver=createRequire(join(backend,'src/services/aiConfigService.js'));module.require=name=>Object.hasOwn(overrides,name)?overrides[name]:resolver(name);module._compile(changes.get(file),file);return module.exports;};
 const service=load(join(planRoot,'backend-node/src/services/aiConfigService.js'),{'./museAdmission':f.admission,'./museModelCapabilities':{capabilitiesForConfig:()=>({})},'./jimengMaterialHubService':{normalizeMaterialHubToken:value=>value}}),routeFactory=load(join(planRoot,'backend-node/src/routes/aiConfig.js'),{'../services/aiConfigService':service,'../response':f.require(join(backend,'src/response.js'))});
 const config={id:1,name:'Fixture text connection',service_type:'text',provider:'openai',base_url:origin+'/v1',model:['fixture-model'],api_key:'fixture-supplier-only',is_active:true,is_default:true,priority:1,settings:'{}'};
 const api=await f.http(undefined,router=>{router.get('/dramas',(req,res)=>res.json({success:true,data:{items:[{id:1,title:'Fixture budget project'}]}}));router.get('/ai-configs',(req,res)=>res.json({success:true,data:[config]}));router.get('/ai-configs/vendor-lock',(req,res)=>res.json({success:true,data:{enabled:false}}));router.post('/ai-configs/test',routeFactory(f.db,{error(){}},f.cfg).testConnection);router.get('*',(req,res)=>res.json({success:true,data:[]}));});
 const media=await api('/ai-configs/test',{...config,service_type:'image',model:'fixture-image'});assert.equal(media.status,200);assert.equal(media.data.data.verification,'configuration_only');assert.equal(supplierCalls,0);assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM muse_budget_entries').get().n,0);
 const web=join(f.home,'global-web');await mkdir(web);await cp(join(stage,'frontweb/src'),join(web,'src'),{recursive:true});await symlink(resolve(backend,'../frontweb/node_modules'),join(web,'node_modules'),process.platform==='win32'?'junction':'dir');
 for(const[file,text]of changes){const path=relative(planRoot,file).replaceAll('\\','/');if(path.startsWith('frontweb/src/')){const destination=join(web,path.slice('frontweb/'.length));await mkdir(dirname(destination),{recursive:true});await writeFile(destination,text);}}
 await writeFile(join(web,'src/utils/museAdmission.js'),readFileSync(extension('muse-admission-client.js')));await writeFile(join(web,'src/utils/museAdmissionCatalog.json'),JSON.stringify(museAdmissionRoutes));
 await writeFile(join(web,'index.html'),'<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><div id="app"></div><script type="module" src="/src/main.js"></script>');await writeFile(join(web,'src/main.js'),"import{createApp}from'vue';import ElementPlus from'element-plus';import'element-plus/dist/index.css';import Page from'./components/AIConfigContent.vue';createApp(Page).use(ElementPlus).mount('#app');");
 const frontRequire=createRequire(resolve(backend,'../frontweb/package.json')),vite=await import(pathToFileURL(frontRequire.resolve('vite')).href),vue=(await import(pathToFileURL(frontRequire.resolve('@vitejs/plugin-vue')).href)).default;await (vite.build??vite.default.build)({root:web,base:'/studio/',logLevel:'silent',plugins:[vue()],resolve:{alias:{'@':join(web,'src')}},build:{outDir:join(web,'dist'),chunkSizeWarningLimit:2000}});
 const express=f.require('express'),app=express();app.use('/studio/api',(req,res)=>{const upstream=httpRequest(new URL('/api'+req.url,api.base),{method:req.method,headers:{'content-type':req.headers['content-type']||'application/json',...req.headers['x-muse-operation-id']?{'x-muse-operation-id':req.headers['x-muse-operation-id']}:{}}},incoming=>{res.writeHead(incoming.statusCode,incoming.headers);incoming.pipe(res);});upstream.on('error',()=>res.destroy());req.pipe(upstream);});app.use('/studio',express.static(join(web,'dist')));const server=createServer(app);owners.get(t).servers.push(server);const base=await listen(server),browser=await chromium.launch({headless:true});owners.get(t).cleanups.push(()=>browser.close());const page=await browser.newPage();await page.goto(base+'/studio/');await page.getByText('Fixture text connection',{exact:true}).waitFor();
 await page.getByRole('button',{name:'测试',exact:true}).click();assert.equal(supplierCalls,0);await page.getByText('请先选择文本测试费用归属项目，并明确设置预算与有效估价',{exact:true}).waitFor();
 await page.locator('.budget-test-project .el-select').click();await page.getByRole('option',{name:'Fixture budget project',exact:true}).click();const tested=page.waitForResponse(response=>response.url().endsWith('/api/v1/ai-configs/test'));await page.getByRole('button',{name:'测试',exact:true}).click();const testedResponse=await tested,testedBody=await testedResponse.json();assert.equal(testedResponse.status(),200,JSON.stringify(testedBody));await page.getByText('文本生成接口已正常响应。',{exact:true}).waitFor();assert.equal(supplierCalls,1);assert.equal(f.budget.readProject(f.db,f.cfg,1).reserved_minor,60);assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM muse_native_supplier_usage').get().n,1);
});

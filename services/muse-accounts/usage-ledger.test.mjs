/** Provider usage remains account-bound, durable and distinct from unreported requests. */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,readFile,readdir,mkdir} from 'node:fs/promises';
import {tmpdir as systemTmpdir} from 'node:os';
import {realpathSync as realpathOfTmpdir} from 'node:fs';
// Private-directory checks compare real paths; the system temp directory can be reached through a link (macOS /var).
const tmpdir=()=>realpathOfTmpdir(systemTmpdir());
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {openUsageLedger} from './usage-ledger.mjs';
import {createModelRequestMetadata} from './model-request-metadata.mjs';

const alice='a'.repeat(16),bob='b'.repeat(16),now=()=>Date.UTC(2026,10,12);
async function fixture(t,options={}){const root=await mkdtemp(join(tmpdir(),'muse-usage-'));t.after(()=>rm(root,{recursive:true,force:true}));const reports=[];const ledger=await openUsageLedger(root,{now,onError:()=>reports.push('failed'),...options});return {root,ledger,reports};}
const input=(accountId=alice)=>({accountId,requestId:randomUUID(),channel:'desktop-relay',route:'writer'});
const metadata=(ticket,usage=null,extra={})=>({server_request_id:ticket.requestId,client_status:200,upstream_status:200,eof:true,usage,...extra});

test('concurrent authenticated requests survive reopening; absent usage stays null and cached fields are not double counted',async t=>{
 const {root,ledger}=await fixture(t);const tickets=await Promise.all([input(),input(),input(bob)].map(value=>ledger.begin(value)));
 await Promise.all(tickets.map((ticket,index)=>ledger.finish(ticket,metadata(ticket,index===0?{prompt_tokens:100,completion_tokens:30,total_tokens:130,prompt_tokens_details:{cached_tokens:70},private:'MUST_NOT_PERSIST'}:index===2?{input_tokens:0,output_tokens:0,total_tokens:0}:null))));
 await ledger.flush();const again=await openUsageLedger(root,{now});const own=await again.query({accountId:alice});
 assert.equal(own.summary.requests,2);assert.equal(own.summary.inputTokens,100);assert.equal(own.summary.outputTokens,30);assert.equal(own.summary.totalTokens,130);assert.equal(own.summary.unreportedUsageRequests,1);
 assert.equal(own.items.find(row=>row.requestId===tickets[1].requestId).usage,null);assert.doesNotMatch(JSON.stringify(own),/MUST_NOT_PERSIST/);
 const other=await again.query({accountId:bob});assert.equal(other.summary.totalTokens,0);assert.equal(other.summary.reportedUsageRequests,1);
 const onlyUnknown=await again.query({accountId:'c'.repeat(16)});assert.equal(onlyUnknown.summary.totalTokens,null);assert.equal(onlyUnknown.summary.requests,0);
});

test('a reservation interrupted before settlement reopens as unknown; stable settlement is idempotent',async t=>{
 const {root,ledger}=await fixture(t),ticket=await ledger.begin(input());
 assert.equal((await ledger.query({accountId:alice})).items[0].state,'pending');
 const reopened=await openUsageLedger(root,{now});assert.equal((await reopened.query({accountId:alice})).items[0].state,'unknown');
 const result=metadata(ticket,{total_tokens:8});await ledger.finish(ticket,result);await ledger.finish(ticket,result);await ledger.flush();
 assert.equal((await reopened.query({accountId:alice})).summary.requests,1);
 await assert.rejects(ledger.finish(ticket,metadata(ticket,{total_tokens:9})),{code:'usage_record_conflict'});
 assert.equal((await reopened.query({accountId:alice})).summary.totalTokens,8);
});

test('failed settlement remains visible and blocks flush without converting unknown use to zero',async t=>{
 const {root,ledger,reports}=await fixture(t),ticket=await ledger.begin(input());
 const folder=join(root,ticket.startedAt.slice(0,10),alice,ticket.requestId);await mkdir(join(folder,'result.json'));
 await assert.rejects(ledger.finish(ticket,metadata(ticket,{total_tokens:40})),{code:'usage_unavailable'});assert.equal(reports.length,1);
 await assert.rejects(ledger.flush(),{code:'usage_unavailable'});
 await rm(join(folder,'result.json'),{recursive:true});const query=await ledger.query({accountId:alice});assert.equal(query.health.state,'degraded');assert.equal(query.items[0].state,'unknown');assert.equal(query.summary.totalTokens,null);
});

test('query pagination, limits and private schema validation reject invalid input',async t=>{
 const {root,ledger}=await fixture(t);const tickets=await Promise.all(Array.from({length:3},()=>ledger.begin(input())));await Promise.all(tickets.map(ticket=>ledger.finish(ticket,metadata(ticket))));
 const first=await ledger.query({accountId:alice,limit:2}),second=await ledger.query({accountId:alice,limit:2,cursor:first.nextCursor});assert.equal(first.items.length,2);assert.equal(second.items.length,1);assert.equal(new Set([...first.items,...second.items].map(row=>row.requestId)).size,3);
 for(const options of [{accountId:'../outside'},{from:'2026-13-12'},{from:'2020-01-01',to:'2026-11-12'},{limit:0},{limit:101},{cursor:'invalid'}])await assert.rejects(ledger.query(options),{code:'invalid_usage_query'});
 assert.deepEqual(JSON.parse(await readFile(join(root,'schema.json'),'utf8')),{version:1});await writeFile(join(root,'schema.json'),JSON.stringify({version:2}));await assert.rejects(openUsageLedger(root),{code:'usage_record_conflict'});
 assert.ok((await readdir(root)).includes('2026-11-12'));
});

test('a supplier key reused as a valid client UUID is absent from both reservation and settlement',async t=>{
 const {root,ledger}=await fixture(t),secret=randomUUID(),request=createModelRequestMetadata({clientId:secret,route:'writer',sink:()=>{}});
 const ticket=await ledger.begin({...input(),requestId:request.serverRequestId,clientRequestId:secret});
 const reservation=await readFile(join(root,ticket.startedAt.slice(0,10),alice,ticket.requestId,'request.json'),'utf8');assert.ok(!reservation.includes(secret));
 request.forwarded({model:'writer',bytes:1,stream:false,secret});request.eof();await ledger.finish(ticket,request.finish(200));
 const query=await ledger.query({accountId:alice});assert.equal(query.items[0].clientRequestId,null);assert.ok(!JSON.stringify(query).includes(secret));
});

test('unpublished staging leftovers cannot hide confirmed records or poison usage after restart',async t=>{
 const {root,ledger}=await fixture(t),ticket=await ledger.begin(input());await ledger.finish(ticket,metadata(ticket,{total_tokens:5}));
 const abandoned=join(root,'2026-11-12',alice,randomUUID());await mkdir(abandoned);await writeFile(join(abandoned,'request.json.'+randomUUID()+'.tmp'),'interrupted before publication');
 const reopened=await openUsageLedger(root,{now,maxQueryDays:1});assert.equal((await reopened.query({accountId:alice})).summary.totalTokens,5);
 await writeFile(join(abandoned,'result.json'),'{}');await assert.rejects(reopened.query({accountId:alice}),{code:'usage_corrupt'});
});

test('overflowing provider counters never become rounded token totals',async t=>{
 const {ledger}=await fixture(t),tickets=await Promise.all([ledger.begin(input()),ledger.begin(input())]);
 await Promise.all(tickets.map(ticket=>ledger.finish(ticket,metadata(ticket,{total_tokens:Number.MAX_SAFE_INTEGER}))));
 const query=await ledger.query({accountId:alice});assert.equal(query.summary.reportedUsageRequests,2);assert.equal(query.summary.totalTokens,null);
});

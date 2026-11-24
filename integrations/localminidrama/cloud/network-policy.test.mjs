/** Deterministic DNS answer sets; no public hosts or cloud metadata are contacted. */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createOutboundPolicy} from './outbound.mjs';
import {createRequire} from 'node:module';
import {resolve,join} from 'node:path';
import {existsSync} from 'node:fs';

const backend=resolve(process.env.LOCALMINIDRAMA_SOURCE||'.local/localminidrama','backend-node'),installed=existsSync(join(backend,'node_modules/ipaddr.js'));
const publicOrigin='https://supplier.fixture.test';
function fixture(records,trustedLocalOrigins=[]){
 const ipaddr=createRequire(join(backend,'package.json'))('ipaddr.js'),queries=[];
 const policy=createOutboundPolicy({outboundOrigins:[publicOrigin,'http://127.0.0.1:43210'],trustedLocalOrigins:['http://127.0.0.1:43210',...trustedLocalOrigins]},
  {lookup:(host,options,done)=>{queries.push({host,options});queueMicrotask(()=>done(null,records));},isPublicAddress:address=>ipaddr.process(address).range()==='unicast'});
 const lookup=(options={})=>new Promise((resolve,reject)=>policy.pinned(new URL(publicOrigin))('supplier.fixture.test',options,(error,...values)=>error?reject(error):resolve(values)));
 return {policy,lookup,queries};
}

test('every DNS answer must be public and the actual socket receives one checked address',{skip:!installed},async()=>{
 const f=fixture([{address:'8.8.8.8',family:4},{address:'1.1.1.1',family:4}]);assert.deepEqual(await f.lookup(),['8.8.8.8',4]);assert.deepEqual(await f.lookup({all:true}),[[{address:'8.8.8.8',family:4}]]);assert.deepEqual(f.queries[0].options,{all:true,verbatim:true});
 for(const address of ['127.0.0.1','10.0.0.1','172.16.1.1','192.168.0.1','169.254.169.254','100.64.0.1','::1','fe80::1','fc00::1','::ffff:127.0.0.1'])await assert.rejects(fixture([{address:'8.8.8.8',family:4},{address,family:address.includes(':')?6:4}]).lookup(),{code:'studio_outbound_rejected'});
 await assert.rejects(fixture([]).lookup(),{code:'studio_outbound_rejected'});
});

test('each connection rechecks DNS, exact-origin exceptions cannot authorize metadata or Unix sockets',{skip:!installed},async()=>{
 const f=fixture([{address:'127.0.0.1',family:4}]);await assert.rejects(f.lookup(),{code:'studio_outbound_rejected'});assert.equal(f.queries.length,1);
 const local=f.policy.target('http://127.0.0.1:43210/v1');assert.equal(local.origin,'http://127.0.0.1:43210');
 const result=await new Promise((resolve,reject)=>f.policy.pinned(local)('127.0.0.1',{},(error,...values)=>error?reject(error):resolve(values)));assert.deepEqual(result,['127.0.0.1',4]);
 for(const url of ['http://169.254.169.254/latest','http://127.0.0.1:43211','http://supplier.fixture.test','https://user:password@supplier.fixture.test','file:///private','http+unix://private'])assert.throws(()=>f.policy.target(url),{code:'studio_outbound_rejected'});
 assert.throws(()=>f.policy.socket('169.254.169.254',80),{code:'studio_outbound_rejected'});assert.throws(()=>f.policy.socket('127.0.0.1',43211),{code:'studio_outbound_rejected'});
});

test('private numeric origins need an explicit administrator exception even when allowlisted',{skip:!installed},()=>{
 const ipaddr=createRequire(join(backend,'package.json'))('ipaddr.js');for(const origin of ['https://169.254.169.254','https://127.0.0.1','https://[::1]'])assert.throws(()=>createOutboundPolicy({outboundOrigins:[origin],trustedLocalOrigins:[]},{isPublicAddress:address=>ipaddr.process(address).range()==='unicast'}),{code:'studio_outbound_rejected'});
});

/** Administrator totals distinguish accounts from authenticated desktop connections. */
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {fixture} from './desktop-test-fixture.mjs';

function overview(markup){
 const section=markup.match(/<section aria-label="使用概览">[\s\S]*?<\/section>/)?.[0];
 assert.ok(section,'Administrator page includes usage totals');
 return [...section.matchAll(/<strong>(\d+)<\/strong>/g)].map(match=>Number(match[1]));
}

test('only administrators see account totals and live desktops are deduplicated by account',async t=>{
 const f=await fixture(t);
 await f.store.create('operator','password',{admin:true});
 const admin=await f.login('operator');
 const read=async()=>{const response=await fetch(f.base+'/admin',{headers:{cookie:admin}});assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');return overview(await response.text());};
 assert.equal((await fetch(f.base+'/admin',{redirect:'manual'})).status,303);
 assert.equal((await fetch(f.base+'/admin',{headers:{cookie:f.alice}})).status,403);
 assert.deepEqual(await read(),[3,3,0,1,0,0,0,0,0]);
 const first=await f.desktop(f.alice,(_req,res)=>res.end('Alice desktop one'));
 const second=await f.desktop(f.alice,(_req,res)=>res.end('Alice desktop two'));
 const third=await f.desktop(f.bob,(_req,res)=>res.end('Bob desktop'));
 assert.deepEqual(await read(),[3,3,0,1,2,3,0,0,0]);
 await first.tunnel.stop();
 assert.deepEqual(await read(),[3,3,0,1,2,2,0,0,0]);
 const bob=f.store.list().find(account=>account.username==='bob');
 await f.store.setDisabled(bob.id,true);
 assert.deepEqual(await read(),[3,2,1,1,1,1,0,0,0]);
 await second.tunnel.stop();await third.tunnel.stop();
 assert.deepEqual(await read(),[3,2,1,1,0,0,0,0,0]);
});

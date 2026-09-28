import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
test('self password change verifies and updates atomically and revokes once',async()=>{
 const {openStore}=await import('./store.mjs');const dir=await mkdtemp(join(tmpdir(),'muse-password-'));
 try{const s=await openStore(join(dir,'accounts.json')),a=await s.create('person','old');let changes=0;s.on('change',()=>changes++);
 assert.equal(typeof s.changePassword,'function');
 await assert.rejects(s.changePassword(a.id,'wrong','new'));assert.equal(s.get(a.id).revision,1);
 const results=await Promise.allSettled([s.changePassword(a.id,'old','new-a'),s.changePassword(a.id,'old','new-b')]);
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(changes,1);assert.equal(s.get(a.id).revision,2);
 assert.equal(await s.authenticate('person','old'),null);
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('account store validates, serializes, persists and revokes',async()=>{
 const {openStore}=await import('./store.mjs');
 const dir=await mkdtemp(join(tmpdir(),'muse-test-'));try{
 const file=join(dir,'accounts.json'),s=await openStore(file);
 const outcomes=await Promise.allSettled([s.create('测试A','1234'),s.create('测试Ａ','1234')]);
 assert.equal(outcomes.filter(x=>x.status==='fulfilled').length,1);
 const a=outcomes.find(x=>x.status==='fulfilled').value;assert.match(a.id,/^[a-f0-9]{16}$/);
 assert.equal((await s.authenticate('测试a','1234')).id,a.id);
 assert.equal(await s.authenticate('测试a','wrong'),null);
 await assert.rejects(s.create('../x','pw'));await assert.rejects(s.create('ok',''));
 await assert.rejects(s.create('ok','x'.repeat(129)));await assert.rejects(s.setDisabled('../x',true));
 await s.resetPassword(a.id,'new');assert.equal(s.get(a.id).revision,2);
 assert.equal(await s.authenticate('测试a','1234'),null);
 await s.setDisabled(a.id,true);assert.equal(await s.authenticate('测试a','new'),null);
 const reopened=await openStore(file);assert.equal(reopened.get(a.id).disabled,true);
 assert.equal((await readFile(file,'utf8')).includes('1234'),false);
 }finally{await rm(dir,{recursive:true,force:true});}
});

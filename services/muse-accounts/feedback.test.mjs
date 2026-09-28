import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';import {join} from 'node:path';import {tmpdir} from 'node:os';
const alice={id:'aaaaaaaaaaaaaaaa',username:'编辑甲'},bob={id:'bbbbbbbbbbbbbbbb',username:'编辑乙'},admin={id:'cccccccccccccccc',username:'管理员',admin:true};
const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=';
test('feedback persists raw user text with ownership, attachments and administrator workflow',async t=>{
 const mod=await import('./feedback.mjs').catch(()=>({}));assert.equal(typeof mod.openFeedback,'function');
 const root=await mkdtemp(join(tmpdir(),'muse-feedback-'));t.after(()=>rm(root,{recursive:true,force:true}));const store=await mod.openFeedback(root);
 const item=await store.create(alice,{category:'bug',title:'下载失败',body:'<script>alert(1)</script>\n原文保留',attachments:[{name:'截图.png',data:png}]});
 assert.equal(item.username,'编辑甲');assert.equal(item.status,'new');assert.equal(item.body,'<script>alert(1)</script>\n原文保留');
 assert.equal((await store.list(bob)).items.length,0);assert.equal((await store.list(alice)).items.length,1);assert.equal((await store.list(admin)).items.length,1);
 await assert.rejects(store.get(bob,item.id),/不存在/);await assert.rejects(store.attachment(bob,item.id,0),/不存在/);
 assert.deepEqual((await store.attachment(alice,item.id,0)).data,Buffer.from(png,'base64'));assert.doesNotMatch(JSON.stringify(await store.list(admin)),/iVBOR/);
 await assert.rejects(store.update(bob,item.id,{status:'resolved',reply:'no',revision:1}),/管理员/);
 const updated=await store.update(admin,item.id,{status:'planned',reply:'下个版本处理',revision:1});assert.equal(updated.revision,2);assert.equal(updated.history.length,2);
 await assert.rejects(store.update(admin,item.id,{status:'resolved',revision:1}),/刷新/);
 assert.equal((await(await mod.openFeedback(root)).get(alice,item.id)).reply,'下个版本处理');
});
test('feedback refuses malformed bodies, forged owners, paths and non-image attachments',async t=>{
 const mod=await import('./feedback.mjs').catch(()=>({}));assert.equal(typeof mod.openFeedback,'function');const root=await mkdtemp(join(tmpdir(),'muse-feedback-'));t.after(()=>rm(root,{recursive:true,force:true}));const store=await mod.openFeedback(root);
 const draft={title:'建议',category:'suggestion',body:'说明'};
 for(const input of [{...draft,title:' '},{...draft,body:'x'.repeat(8001)},{...draft,category:'evil'},{...draft,attachments:[{name:'a.svg',data:Buffer.from('<svg/>').toString('base64')}]},{...draft,attachments:Array(4).fill({name:'x.png',data:png})}])await assert.rejects(store.create(alice,input));
 const saved=await store.create(alice,{...draft,ownerId:bob.id,username:bob.username,status:'resolved'});assert.equal(saved.ownerId,alice.id);assert.equal(saved.status,'new');
 await assert.rejects(store.get(admin,'../accounts.json'));await assert.rejects(store.update(admin,saved.id,{status:'bad',revision:1}));
});

/** Persisted computer ownership and public mount parsing use no live credentials. */
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomUUID} from 'node:crypto';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {openStore} from './store.mjs';
import {desktopRoute,desktopPrefix} from './desktop-route.mjs';
import {desktopPicker} from './desktop-picker.mjs';

test('legacy single-device records remain readable and new registrations retain all installations',async t=>{
 const root=await mkdtemp(join(tmpdir(),'muse-computer-store-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const file=join(root,'accounts.json');let store=await openStore(file);
 const alice=await store.create('alice','password'),bob=await store.create('bob','password'),old=randomUUID(),next=randomUUID();
 const original=JSON.parse(await readFile(file,'utf8'));original.accounts[0].desktopDeviceId=old;await writeFile(file,JSON.stringify(original));
 store=await openStore(file);assert.equal(store.desktopDevices(alice.id)[0].id,old);assert.equal(store.desktopDevices(alice.id)[0].lastSeenAt,null);
 await store.bindDesktop(alice.id,{id:next,name:'编辑电脑',platform:'win32',lastSeenAt:1234},{maxDevices:2});
 await store.bindDesktop(alice.id,{id:old,name:'外出 Mac',platform:'darwin',lastSeenAt:5678},{maxDevices:2});
 const reopened=await openStore(file);assert.deepEqual(reopened.desktopDevices(alice.id).map(d=>[d.id,d.name]),[[old,'外出 Mac'],[next,'编辑电脑']]);
 assert.deepEqual(reopened.desktopDevices(bob.id),[]);
 const devices=reopened.desktopDevices(alice.id);devices[0].name='mutated';assert.equal(reopened.desktopDevices(alice.id)[0].name,'外出 Mac');
 await assert.rejects(reopened.bindDesktop(alice.id,{id:randomUUID(),name:'第三台',platform:'linux',lastSeenAt:9999},{maxDevices:2}),/limit/);
 assert.equal(reopened.desktopDevices(alice.id).length,2);assert.equal((await reopened.authenticate('alice','password')).id,alice.id);
});

test('corrupt persisted device records fail at account-store load',async t=>{
 const root=await mkdtemp(join(tmpdir(),'muse-computer-invalid-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const file=join(root,'accounts.json'),store=await openStore(file);await store.create('alice','password');
 const data=JSON.parse(await readFile(file,'utf8'));data.accounts[0].desktopDevices=[{id:randomUUID(),name:'\ninvalid',platform:'win32',lastSeenAt:1}];await writeFile(file,JSON.stringify(data));
 await assert.rejects(openStore(file),/desktop device records/);
});

test('mounts preserve request queries and cannot normalize out of the selected desktop',()=>{
 const id=randomUUID(),prefix=desktopPrefix(id);
 assert.deepEqual(desktopRoute(prefix+'api/read?path=%2Fwork%2Fa.md'),{deviceId:id,prefix,path:'/api/read?path=%2Fwork%2Fa.md'});
 assert.equal(desktopRoute('/api/desktop/devices'),null);
 for(const raw of ['/desktop/not-a-device/',prefix+'../../api/write','/desktop/'+id+'/../../../login','/desktop/%2f/'])assert.throws(()=>desktopRoute(raw),/Invalid desktop mount/);
});

test('computer names render as text and offline devices cannot be entered',()=>{
 const id=randomUUID(),markup=desktopPicker([{id,name:'<script>computer</script>',platform:'darwin',state:'offline',lastSeenAt:null}]);
 assert.match(markup,/&lt;script&gt;computer&lt;\/script&gt;/);assert.doesNotMatch(markup,/<script>computer/);
 assert.match(markup,/disabled/);assert.doesNotMatch(markup,new RegExp('href="'+desktopPrefix(id)));
});

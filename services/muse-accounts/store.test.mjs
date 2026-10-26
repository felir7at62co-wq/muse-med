import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,stat,rm} from 'node:fs/promises';
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

const feishuProfile=(overrides={})=>({appId:'cli_synthetic_app',tenantKey:'synthetic_tenant',openId:'ou_synthetic_person',unionId:'on_synthetic_union',name:'张三（编剧）',avatarUrl:'https://example.test/avatar.png',...overrides});
async function feishuFixture(t){
 const {openStore}=await import('./store.mjs'),dir=await mkdtemp(join(tmpdir(),'muse-feishu-store-'));
 t.after(()=>rm(dir,{recursive:true,force:true}));const file=join(dir,'accounts.json');
 return {openStore,file,store:await openStore(file)};
}

test('Feishu resolution deduplicates stable identities and never creates an administrator from a name',async t=>{
 const {store,file,openStore}=await feishuFixture(t),admin=await store.create('ylk','existing-secret',{admin:true});
 const resolved=await Promise.all(Array.from({length:8},()=>store.resolveFeishuIdentity(feishuProfile({name:'ylk',accessToken:'synthetic-sensitive-token'}))));
 assert.equal(new Set(resolved.map(a=>a.id)).size,1);assert.equal(store.list().length,2);
 const account=resolved[0];assert.equal(account.admin,false);assert.equal(account.passwordLogin,false);assert.notEqual(account.id,admin.id);assert.notEqual(account.username,'ylk');
 assert.equal(account.lastLoginAt,null);assert.equal(account.feishuIdentities[0].lastLoginAt,null);
 assert.equal(store.get(admin.id).admin,true);assert.equal(store.get(admin.id).revision,1);
 assert.equal(await store.authenticate(account.username,''),null);assert.equal(await store.authenticate(account.username,'anything'),null);
 await assert.rejects(store.changePassword(account.id,'anything','new-secret'),/原密码/);
 const persisted=JSON.parse(await readFile(file,'utf8')),row=persisted.accounts.find(a=>a.id===account.id);
 assert.equal(persisted.version,2);assert.equal(row.hash,undefined);assert.equal(row.salt,undefined);
 assert.equal((await readFile(file,'utf8')).includes('synthetic-sensitive-token'),false);assert.equal((await stat(file)).mode&0o777,0o600);
 const refreshed=await store.resolveFeishuIdentity(feishuProfile({name:'更新显示名'}));
 assert.equal(refreshed.id,account.id);assert.equal(refreshed.feishuIdentities[0].name,'更新显示名');assert.equal(refreshed.feishuIdentities[0].boundAt,account.feishuIdentities[0].boundAt);
 refreshed.feishuIdentities[0].name='caller mutation';assert.equal(store.get(account.id).feishuIdentities[0].name,'更新显示名');
 const reopened=await openStore(file);assert.equal((await reopened.resolveFeishuIdentity(feishuProfile())).id,account.id);assert.equal(reopened.get(admin.id).admin,true);
});

test('Feishu identities remain distinct across enterprises, applications and personal accounts',async t=>{
 const {store}=await feishuFixture(t);
 const first=await store.resolveFeishuIdentity(feishuProfile());
 const otherTenant=await store.resolveFeishuIdentity(feishuProfile({tenantKey:'another_tenant'}));
 const otherApp=await store.resolveFeishuIdentity(feishuProfile({appId:'cli_another_app'}));
 const personal=await store.resolveFeishuIdentity(feishuProfile({tenantKey:undefined}));
 const personalAgain=await store.resolveFeishuIdentity(feishuProfile({tenantKey:null}));
 const otherOpen=await store.resolveFeishuIdentity(feishuProfile({openId:'ou_other_person'}));
 assert.equal(new Set([first,otherTenant,otherApp,personal,otherOpen].map(a=>a.id)).size,5);
 assert.equal(personal.id,personalAgain.id);assert.equal(personal.feishuIdentities[0].tenantKey,null);
 assert.equal(store.list().length,5);
});

test('authenticated binding preserves the original administrator, password and account revision',async t=>{
 const {store,openStore,file}=await feishuFixture(t),admin=await store.create('ylk','existing-secret',{admin:true});let changes=0;store.on('change',()=>changes++);
 const bound=await store.resolveFeishuIdentity(feishuProfile(),{bindAccountId:admin.id,bindRevision:admin.revision});
 assert.equal(bound.id,admin.id);assert.equal(bound.admin,true);assert.equal(bound.username,'ylk');assert.equal(bound.revision,1);assert.equal(bound.passwordLogin,true);assert.equal(changes,0);
 assert.equal((await store.authenticate('ylk','existing-secret')).id,admin.id);
 assert.equal((await store.resolveFeishuIdentity(feishuProfile())).id,admin.id);
 assert.equal((await openStore(file)).get(admin.id).admin,true);assert.equal(store.list().length,1);
});

test('concurrent Feishu binding belongs to one account and stale or disabled accounts cannot bind',async t=>{
 const {store}=await feishuFixture(t),alice=await store.create('alice','password'),bob=await store.create('bob','password');
 const attempts=await Promise.allSettled([alice,bob].map(a=>store.resolveFeishuIdentity(feishuProfile(),{bindAccountId:a.id,bindRevision:a.revision})));
 assert.equal(attempts.filter(a=>a.status==='fulfilled').length,1);assert.equal(attempts.find(a=>a.status==='rejected').reason.code,'FEISHU_IDENTITY_CONFLICT');
 assert.equal(store.list().reduce((n,a)=>n+a.feishuIdentities.length,0),1);
 const reset=store.resetPassword(alice.id,'replacement');
 const stale=store.resolveFeishuIdentity(feishuProfile({openId:'ou_new_person'}),{bindAccountId:alice.id,bindRevision:alice.revision});
 await reset;await assert.rejects(stale,{code:'ACCOUNT_REVISION_CHANGED'});
 await store.setDisabled(bob.id,true);
 await assert.rejects(store.resolveFeishuIdentity(feishuProfile({openId:'ou_disabled_bind'}),{bindAccountId:bob.id,bindRevision:store.get(bob.id).revision}),{code:'ACCOUNT_DISABLED'});
 const owner=attempts.find(a=>a.status==='fulfilled').value;
 await store.setDisabled(owner.id,true);await assert.rejects(store.resolveFeishuIdentity(feishuProfile()),{code:'ACCOUNT_DISABLED'});
 await assert.rejects(store.resolveFeishuIdentity(feishuProfile(),{bindAccountId:'../invalid'}),{code:'ACCOUNT_NOT_FOUND'});
});

test('account usage separates login from task activity and ignores older event times',async t=>{
 const {store,openStore,file}=await feishuFixture(t),user=await store.create('writer','password');
 assert.equal(user.lastLoginAt,null);assert.equal(user.lastActivityAt,null);
 const loggedIn=await store.recordLogin(user.id,{at:'2026-10-26T00:00:00.000Z'});assert.equal(loggedIn.lastActivityAt,null);
 await store.recordActivity(user.id,{at:'2026-10-26T01:00:00.000Z'});await store.recordActivity(user.id,{at:'2026-10-25T01:00:00.000Z'});
 await store.recordLogin(user.id,{at:'2026-10-25T00:00:00.000Z'});
 const current=store.get(user.id);assert.equal(current.lastActivityAt,'2026-10-26T01:00:00.000Z');assert.equal(current.lastLoginAt,'2026-10-26T00:00:00.000Z');assert.equal(current.revision,1);
 await assert.rejects(store.recordActivity(user.id,{at:'not a date'}),/activity time/);
 const reopened=await openStore(file);assert.equal(reopened.get(user.id).lastActivityAt,current.lastActivityAt);
 await reopened.setDisabled(user.id,true);await assert.rejects(reopened.recordActivity(user.id),{code:'ACCOUNT_DISABLED'});await assert.rejects(reopened.recordLogin(user.id),{code:'ACCOUNT_DISABLED'});
});

test('queued Feishu binding rechecks the original login after a session is revoked',async t=>{
 const {store}=await feishuFixture(t),account=await store.create('writer','password');let authenticated=true;
 const pending=store.create('queued-writer','password');
 const binding=store.resolveFeishuIdentity(feishuProfile(),{bindAccountId:account.id,bindRevision:account.revision,validateBinding:()=>authenticated});
 authenticated=false;await pending;await assert.rejects(binding,{code:'ACCOUNT_REVISION_CHANGED'});
 assert.equal(store.get(account.id).feishuIdentities.length,0);assert.equal(store.get(account.id).revision,1);
});

test('successful Feishu login timestamps follow explicit session issuance and stay attached to the matching identity',async t=>{
 const {store,openStore,file}=await feishuFixture(t),profile=feishuProfile(),account=await store.resolveFeishuIdentity(profile);
 await store.resolveFeishuIdentity(feishuProfile({openId:'ou_second'}),{bindAccountId:account.id,bindRevision:account.revision});
 assert.equal(store.get(account.id).lastLoginAt,null);assert.ok(store.get(account.id).feishuIdentities.every(identity=>identity.lastLoginAt===null));
 const timestamp='2026-10-26T00:00:00.000Z';
 const loggedIn=await store.recordLogin(account.id,{at:timestamp,feishuIdentity:profile,expectedRevision:account.revision,validateLogin:()=>true});
 assert.equal(loggedIn.lastLoginAt,timestamp);assert.equal(loggedIn.feishuIdentities[0].lastLoginAt,timestamp);assert.equal(loggedIn.feishuIdentities[1].lastLoginAt,null);
 await store.resolveFeishuIdentity({...profile,name:'New name'});assert.equal(store.get(account.id).feishuIdentities[0].lastLoginAt,timestamp);
 await assert.rejects(store.recordLogin(account.id,{feishuIdentity:feishuProfile({openId:'ou_unbound'})}),{code:'FEISHU_IDENTITY_CONFLICT'});
 await assert.rejects(store.recordLogin(account.id,{feishuIdentity:profile,expectedRevision:99}),{code:'ACCOUNT_REVISION_CHANGED'});
 await assert.rejects(store.recordLogin(account.id,{feishuIdentity:profile,validateLogin:()=>false}),{code:'ACCOUNT_REVISION_CHANGED'});
 assert.equal(store.get(account.id).lastLoginAt,timestamp);
 const reopened=await openStore(file);assert.equal(reopened.get(account.id).feishuIdentities[1].lastLoginAt,null);assert.equal(reopened.get(account.id).lastLoginAt,timestamp);
});

test('queued successful-login recording does not outlive its revoked authorization',async t=>{
 const {store}=await feishuFixture(t),profile=feishuProfile(),account=await store.resolveFeishuIdentity(profile);let valid=true;
 const pending=store.create('queued-credential','password');
 const recording=store.recordLogin(account.id,{feishuIdentity:profile,expectedRevision:account.revision,validateLogin:()=>valid});
 valid=false;await pending;await assert.rejects(recording,{code:'ACCOUNT_REVISION_CHANGED'});
 assert.equal(store.get(account.id).lastLoginAt,null);assert.equal(store.get(account.id).feishuIdentities[0].lastLoginAt,null);
});

test('legacy account data loads unchanged and migrates without changing password, role or devices',async t=>{
 const {store,openStore,file}=await feishuFixture(t),admin=await store.create('ylk','legacy-secret',{admin:true});
 await store.bindDesktop(admin.id,{id:'bc70cb71-1edc-4caa-a22a-d0d319362cad',name:'原电脑',platform:'darwin',lastSeenAt:1234});
 const data=JSON.parse(await readFile(file,'utf8'));data.version=1;const original=JSON.stringify(data);await writeFile(file,original);
 const reopened=await openStore(file);assert.equal(await readFile(file,'utf8'),original);
 assert.equal((await reopened.authenticate('ylk','legacy-secret')).id,admin.id);
 await reopened.resolveFeishuIdentity(feishuProfile(),{bindAccountId:admin.id,bindRevision:1});
 const migrated=JSON.parse(await readFile(file,'utf8'));assert.equal(migrated.version,2);
 for(const key of ['id','key','username','admin','disabled','createdAt','revision','salt','hash','desktopDevices'])assert.deepEqual(migrated.accounts[0][key],data.accounts[0][key]);
});

test('Feishu-only accounts can receive an explicit password reset without replacing their identity',async t=>{
 const {store,openStore,file}=await feishuFixture(t),user=await store.resolveFeishuIdentity(feishuProfile());
 const updated=await store.resetPassword(user.id,'new-secret');assert.equal(updated.passwordLogin,true);assert.equal(updated.revision,2);
 assert.equal((await store.authenticate(user.username,'new-secret')).id,user.id);
 const reopened=await openStore(file);assert.equal((await reopened.resolveFeishuIdentity(feishuProfile())).id,user.id);assert.equal(reopened.get(user.id).passwordLogin,true);
});

test('invalid profiles and ambiguous persisted identities fail without creating accounts',async t=>{
 const {store,openStore,file}=await feishuFixture(t);
 for(const profile of [feishuProfile({appId:''}),feishuProfile({openId:'../invalid'}),feishuProfile({tenantKey:''}),feishuProfile({name:'name\ninvalid'}),feishuProfile({avatarUrl:'javascript:alert(1)'}),feishuProfile({avatarUrl:'https://user:secret@example.test/avatar.png'})])await assert.rejects(store.resolveFeishuIdentity(profile),{code:'FEISHU_PROFILE_INVALID'});
 assert.equal(store.list().length,0);
 await store.resolveFeishuIdentity(feishuProfile());await store.resolveFeishuIdentity(feishuProfile({openId:'ou_another'}));
 const data=JSON.parse(await readFile(file,'utf8'));data.accounts[1].feishuIdentities[0]=structuredClone(data.accounts[0].feishuIdentities[0]);await writeFile(file,JSON.stringify(data));
 await assert.rejects(openStore(file),/duplicate Feishu identity/);
 data.accounts[1].feishuIdentities=[];await writeFile(file,JSON.stringify(data));await assert.rejects(openStore(file),/Invalid account record/);
 data.version=3;await writeFile(file,JSON.stringify(data));await assert.rejects(openStore(file),/Invalid account store/);
});

test('public Feishu identity fields never project unknown persisted credentials',async t=>{
 const {store,openStore,file}=await feishuFixture(t),account=await store.resolveFeishuIdentity(feishuProfile());
 const data=JSON.parse(await readFile(file,'utf8'));data.accounts[0].feishuIdentities[0].accessToken='synthetic-private-value';await writeFile(file,JSON.stringify(data));
 const reopened=await openStore(file);assert.equal(JSON.stringify(reopened.get(account.id)).includes('synthetic-private-value'),false);
 assert.equal(reopened.list()[0].feishuIdentities[0].accessToken,undefined);
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

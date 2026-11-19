import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import {accountProfile} from './account-profile.mjs';
import {openStore} from './store.mjs';
import {createAccountServer} from './gateway.mjs';

const at='2026-11-17T02:00:00.000Z';
const owner='1111111111111111',other='2222222222222222';
const department={id:'od_writer',name:'创作组',path:'公司 / 创作组',pathIds:['0','od_writer']};
const synced=()=>({status:'available',syncedAt:at,departments:[structuredClone(department)]});
const identity=()=>({appId:'cli_private',openId:'ou_private',unionId:'on_private',name:'编剧',tenantKey:'tenant_fixture',boundAt:at,lastLoginAt:null,avatarUrl:'https://private.test/avatar',organization:synced()});
const account=()=>({id:owner,username:'writer',createdAt:at,revision:1,admin:true,disabled:false,passwordLogin:true,salt:'private-salt',hash:'private-hash',feishuIdentities:[identity()],groups:[{name:'编剧一组',description:'负责长剧'}]});
const snapshot=()=>({status:'ready',updatedAt:at,departments:[{id:'0',name:'公司',parentId:null},{id:'od_writer',name:'创作组',parentId:'0'},{id:'od_other',name:'另一组',parentId:'0'}],accounts:{[owner]:{status:'ready',departmentIds:['od_writer']},[other]:{status:'ready',departmentIds:['od_other']}}});
const missing={status:'unavailable',updatedAt:null,departments:[]};

test('profile returns one account and copies only safe profile and group fields',()=>{
 const source=account(),value=accountProfile(source);
 assert.equal(value.version,1);assert.equal(value.account.id,owner);assert.equal(value.account.feishuIdentities[0].name,'编剧');
 assert.equal(value.groups[0].name,'编剧一组');assert.match(value.groups[0].id,/^group-[a-f0-9]{16}$/);
 assert.doesNotMatch(JSON.stringify(value),/private|appId|openId|unionId|avatarUrl|salt|hash|revision|passwordLogin|admin|disabled/);
 value.account.feishuIdentities[0].organization.departments[0].pathIds.push('changed');value.groups[0].description='changed';value.organization.departments[0].pathIds.push('changed');
 assert.deepEqual(source.feishuIdentities[0].organization.departments[0].pathIds,['0','od_writer']);assert.equal(source.groups[0].description,'负责长剧');
});

test('snapshot projects only current memberships and their complete ancestor paths',()=>{
 const source=snapshot();source.status='partial';source.accounts[owner].departmentIds.push('od_writer');
 const value=accountProfile(account(),{organizationSnapshot:source});
 assert.deepEqual(value.organization,{status:'available',updatedAt:at,departments:[department]});
 assert.doesNotMatch(JSON.stringify(value),/另一组|od_other|2222222222222222/);
 value.organization.departments[0].pathIds.push('changed');assert.equal(source.departments.length,3);
});

test('missing and cyclic ancestors discard the entire current department projection',()=>{
 for(const parentId of ['od_missing','od_writer']){
  const source=snapshot();source.departments.find(row=>row.id==='od_writer').parentId=parentId;
  assert.deepEqual(accountProfile(account(),{organizationSnapshot:source}).organization,missing);
 }
 const source=snapshot();source.accounts[owner].departmentIds.push('od_missing');
 assert.deepEqual(accountProfile(account(),{organizationSnapshot:source}).organization,missing);
 source.accounts[owner].departmentIds=['od_writer'];source.departments=source.departments.filter(row=>row.id!=='0');
 assert.deepEqual(accountProfile(account(),{organizationSnapshot:source}).organization,missing);
});

test('an unavailable or missing current membership does not use another account or stale identity data',()=>{
 const absent=snapshot();delete absent.accounts[owner];
 const unknown=snapshot();unknown.accounts[owner].status='unknown';
 const unavailable=snapshot();unavailable.status='unavailable';
 for(const source of [absent,unknown,unavailable,null])assert.deepEqual(accountProfile(account(),{organizationSnapshot:source}).organization,missing);
});

test('verified empty memberships and old records keep true empty groups distinct from unavailable departments',()=>{
 const source=snapshot();source.accounts[owner].departmentIds=[];
 const legacy={id:owner,username:'writer',createdAt:at};
 const value=accountProfile(legacy,{organizationSnapshot:source});
 assert.deepEqual(value.groups,[]);assert.deepEqual(value.account.feishuIdentities,[]);
 assert.equal(value.account.lastLoginAt,null);assert.equal(value.account.lastActivityAt,null);
 assert.deepEqual(value.organization,{status:'available',updatedAt:at,departments:[]});
 assert.deepEqual(accountProfile(legacy).organization,missing);
});

test('identity caches merge only complete verified organization records',()=>{
 const source=account(),second=identity();second.organization.syncedAt='2026-11-17T03:00:00.000Z';source.feishuIdentities.push(second);
 assert.deepEqual(accountProfile(source).organization,{status:'available',updatedAt:second.organization.syncedAt,departments:[department]});
 source.feishuIdentities[1].organization.departments[0].name='另一名称';assert.deepEqual(accountProfile(source).organization,missing);
 source.feishuIdentities[1].organization={status:'permission-required',syncedAt:at,departments:[]};assert.deepEqual(accountProfile(source).organization,missing);
 delete source.feishuIdentities[1].organization;assert.deepEqual(accountProfile(source).organization,missing);
 source.feishuIdentities=[identity()];source.feishuIdentities[0].organization.departments=[];
 assert.deepEqual(accountProfile(source).organization,{status:'available',updatedAt:at,departments:[]});
});

test('personal profile HTTP access follows the login, Origin, method and query rules',async t=>{
 const root=await mkdtemp(join(tmpdir(),'muse-account-profile-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const store=await openStore(join(root,'accounts.json')),writer=await store.create('writer','pw'),another=await store.create('another','pw');
 await store.setGroups(writer.id,[{name:'编剧一组',description:'负责长剧'}]);await store.setGroups(another.id,[{name:'另一组',description:'不可见'}]);
 await store.resolveFeishuIdentity(identity(),{bindAccountId:writer.id});
 const origin='https://muse.test',server=createAccountServer({store,workspaceMode:'desktop',publicOrigin:origin});
 t.after(async()=>{await server.closeFeishuLogin();server.closeAllConnections();await new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()));});
 server.listen(0,'127.0.0.1');await once(server,'listening');const base='http://127.0.0.1:'+server.address().port;
 const login=await fetch(base+'/login',{method:'POST',headers:{origin},body:new URLSearchParams({username:'writer',password:'pw'}),redirect:'manual'});
 assert.equal(login.status,303);const cookie=login.headers.get('set-cookie').split(';')[0];
 const call=(path='',options={})=>fetch(base+'/api/muse/profile'+path,{...options,headers:{cookie,origin,...options.headers},redirect:'manual'});
 assert.equal((await fetch(base+'/api/muse/profile',{redirect:'manual'})).status,401);
 const response=await call(),value=await response.json();assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');
 assert.equal(value.account.id,writer.id);assert.equal(value.groups[0].name,'编剧一组');assert.deepEqual(value.organization.departments,[department]);
 assert.doesNotMatch(JSON.stringify(value),new RegExp(another.id+'|另一组|不可见|private|password|openId|unionId|appId'));
 assert.equal((await call('?accountId='+another.id)).status,400);assert.equal((await call('?unexpected=1')).status,400);
 const post=await call('',{method:'POST'});assert.equal(post.status,405);assert.equal(post.headers.get('allow'),'GET');
 assert.equal((await call('',{headers:{origin:'https://other.test'}})).status,403);
 assert.equal((await fetch(base+'/api/muse/profile',{headers:{cookie,'sec-fetch-site':'cross-site'},redirect:'manual'})).status,403);
 await store.setDisabled(writer.id,true);assert.equal((await call()).status,401);
});

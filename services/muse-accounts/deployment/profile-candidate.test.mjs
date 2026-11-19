/** Synthetic account cases run against the exact profile modules in a local candidate. */
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {dirname,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';

const modules=process.env.MUSE_PROFILE_CANDIDATE??resolve(dirname(fileURLToPath(import.meta.url)),'..');
const {accountProfile}=await import(pathToFileURL(resolve(modules,'account-profile.mjs')));
const {accountGroups}=await import(pathToFileURL(resolve(modules,'account-groups.mjs')));
const at='2026-11-17T00:00:00.000Z',owner='1111111111111111',other='2222222222222222';
const account=(id=owner)=>({id,username:id===owner?'ordinary_writer':'another_writer',createdAt:at,feishuIdentities:[],groups:[]});
const organization=()=>({status:'available',syncedAt:at,departments:[{id:'od_own',name:'Writers',path:'Company / Writers',pathIds:['0','od_own']}]});
const identity=(name='Writer')=>({name,tenantKey:'tenant_fixture',boundAt:at,lastLoginAt:null,organization:organization()});

test('new and legacy ordinary accounts retain empty groups and unavailable directory information',()=>{
 const value=accountProfile(account());
 assert.equal(value.account.id,owner);assert.deepEqual(value.groups,[]);assert.deepEqual(value.account.feishuIdentities,[]);
 assert.equal(value.account.lastLoginAt,null);assert.deepEqual(value.organization,{status:'unavailable',updatedAt:null,departments:[]});
});

test('the current account selects only its complete department paths from a shared organization snapshot',()=>{
 const snapshot={status:'ready',updatedAt:at,departments:[{id:'0',name:'Company',parentId:null},
  {id:'od_own',name:'Writers',parentId:'0'},{id:'od_other',name:'Other private team',parentId:'0'}],
 accounts:{[owner]:{status:'ready',departmentIds:['od_own']},[other]:{status:'ready',departmentIds:['od_other']}}};
 const value=accountProfile(account(),{organizationSnapshot:snapshot});
 assert.deepEqual(value.organization.departments,organization().departments);
 assert.doesNotMatch(JSON.stringify(value),/Other private team|od_other|2222222222222222/);
 snapshot.departments[1].parentId='od_missing';assert.equal(accountProfile(account(),{organizationSnapshot:snapshot}).organization.status,'unavailable');
 snapshot.departments[1].parentId='od_own';assert.equal(accountProfile(account(),{organizationSnapshot:snapshot}).organization.status,'unavailable');
});

test('multiple verified bindings deduplicate paths and refuse incomplete or conflicting memberships',()=>{
 const source=account();source.feishuIdentities=[identity(),identity('Another binding')];
 const value=accountProfile(source);assert.equal(value.account.feishuIdentities.length,2);assert.equal(value.organization.departments.length,1);
 source.feishuIdentities[1].organization.status='unavailable';source.feishuIdentities[1].organization.departments=[];
 assert.equal(accountProfile(source).organization.status,'unavailable');
 source.feishuIdentities[1]=identity();source.feishuIdentities[1].organization.departments[0].name='Conflicting department';
 assert.equal(accountProfile(source).organization.status,'unavailable');
});

test('profiles omit credentials and role flags, and group assignment does not grant authority',()=>{
 const source={...account(),admin:true,disabled:false,revision:7,hash:'private-fixture-hash',cookie:'private-fixture-cookie',
  groups:[{name:'Writers',description:'Long-form scripts'}],feishuIdentities:[{...identity(),openId:'private-fixture-id',accessToken:'private-fixture-token'}]};
 const value=accountProfile(source);
 assert.equal(value.groups[0].name,'Writers');assert.doesNotMatch(JSON.stringify(value),/private-fixture|admin|disabled|revision|openId|accessToken|cookie|hash/);
 value.organization.departments[0].pathIds.push('changed');assert.deepEqual(source.feishuIdentities[0].organization.departments[0].pathIds,['0','od_own']);
 assert.throws(()=>accountGroups([{name:'duplicate',description:''},{name:'duplicate',description:''}]));
 assert.throws(()=>accountGroups([{name:'',description:''}]));
});

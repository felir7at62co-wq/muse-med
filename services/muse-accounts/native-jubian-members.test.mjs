/** Feishu company discovery uses only the account owner's verified bindings and explicit operator limits. */
import assert from 'node:assert/strict';
import test from 'node:test';
import {resolveNativeJubianMemberDirectory,nativeJubianMember} from './native-jubian-members.mjs';

const alice='a'.repeat(16),bob='b'.repeat(16);
const directory={kind:'feishu',appId:'cli_company',tenantKey:'company-tenant',active:true,role:'editor',limitMinor:0,maxParallel:2};
const owner={accountId:alice,active:true,role:'owner',limitMinor:100,maxParallel:5};

test('an absent directory preserves explicit membership and a configured directory admits only verified matching account bindings',()=>{
 assert.equal(resolveNativeJubianMemberDirectory(undefined),undefined);
 const accounts={get:id=>id===bob?{id:bob,disabled:false,feishuIdentities:[{appId:directory.appId,tenantKey:directory.tenantKey,openId:'employee'}]}:undefined};
 assert.equal(nativeJubianMember({members:[owner]},bob,accounts),undefined);
 const company={members:[owner],memberDirectory:resolveNativeJubianMemberDirectory(directory)};
 assert.deepEqual(nativeJubianMember(company,bob,accounts),{accountId:bob,active:true,role:'editor',limitMinor:0,maxParallel:2});
 assert.deepEqual(nativeJubianMember(company,alice,accounts),owner);
 assert.equal(JSON.stringify(company).includes('openId'),false);
});

test('an explicit inactive member wins over automatic Feishu membership',()=>{
 const denied={accountId:bob,active:false,role:'editor',limitMinor:0,maxParallel:1};
 const accounts={get:()=>({disabled:false,feishuIdentities:[{appId:directory.appId,tenantKey:directory.tenantKey}]})};
 assert.deepEqual(nativeJubianMember({members:[owner,denied],memberDirectory:directory},bob,accounts),denied);
 assert.equal(nativeJubianMember({members:[owner],memberDirectory:{...directory,active:false}},bob,accounts),undefined);
});

test('foreign tenants, another app, disabled accounts and password-only accounts never acquire directory membership',()=>{
 const company={members:[owner],memberDirectory:directory};
 for(const record of [{disabled:true,feishuIdentities:[{appId:directory.appId,tenantKey:directory.tenantKey}]},
  {disabled:false,feishuIdentities:[{appId:'other-app',tenantKey:directory.tenantKey}]},
  {disabled:false,feishuIdentities:[{appId:directory.appId,tenantKey:'other-tenant'}]},
  {disabled:false,feishuIdentities:[{appId:directory.appId,tenantKey:null}]},{disabled:false},undefined]){
  assert.equal(nativeJubianMember(company,bob,{get:()=>record}),undefined);
 }
});

test('directory configuration cannot grant owner or administrator roles, omit limits or contain caller credentials',()=>{
 const parsed=resolveNativeJubianMemberDirectory(directory);assert.deepEqual(parsed,directory);assert.notEqual(parsed,directory);
 for(const edit of [{role:'owner'},{role:'admin'},{kind:'model-supplied'},{active:undefined},{maxParallel:0},
  {limitMinor:-1},{limitMinor:Number.MAX_SAFE_INTEGER+1},{appId:''},{tenantKey:null},{tenantKey:' bad '},
  {token:'not-an-operator-identity'},{members:[bob]}]){
  assert.throws(()=>resolveNativeJubianMemberDirectory({...directory,...edit}),{code:'native_jubian_admission_invalid_member_directory'});
 }
});

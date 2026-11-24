/** Optional native admission configuration cannot consume an unrelated production store. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,access} from 'node:fs/promises';
import {join,resolve,sep} from 'node:path';
import {tmpdir as systemTmpdir} from 'node:os';
import {realpathSync as realpathOfTmpdir} from 'node:fs';
// Private-directory checks compare real paths; the system temp directory can be reached through a link (macOS /var).
const tmpdir=()=>realpathOfTmpdir(systemTmpdir());
import {loadNativeJubianAdmission} from './native-jubian-config.mjs';

async function fixture(t){
 const root=await mkdtemp(join(tmpdir(),'muse-native-config-')),owners=[];
 t.after(async()=>{for(const owner of owners)owner.close();const parent=resolve(tmpdir()),target=resolve(root);
  assert.ok(target.startsWith(parent+sep)&&target!==parent);await rm(target,{recursive:true,force:true,maxRetries:5,retryDelay:50});});
 const accountId='a'.repeat(16),config={version:1,databaseFile:join(root,'admission.sqlite'),busyTimeoutMs:5000,maxBatchItems:10,
  policy:{revision:1,companies:[{id:'company',limitMinor:1000,maxParallel:2,
   members:[{accountId,role:'owner',active:true,limitMinor:1000,maxParallel:2}],
   projects:[{providerOrigin:'https://web.jubianai.net',scriptId:7,active:true,limitMinor:1000,maxParallel:2}]}]}};
 return {root,owners,config,accountId,accounts:{get:id=>id===accountId?{id,revision:1,disabled:false}:undefined}};
}

test('absent configuration opens no authority and a private explicit policy opens its dedicated store',async t=>{
 const f=await fixture(t);
 assert.equal(await loadNativeJubianAdmission(undefined,{accounts:f.accounts}),undefined);
 await assert.rejects(access(f.config.databaseFile));
 const path=join(f.root,'policy.json');await writeFile(path,JSON.stringify(f.config),{mode:0o600});
 const owner=await loadNativeJubianAdmission(path,{accounts:f.accounts});f.owners.push(owner);
 const value=owner.request({accountId:f.accountId,sessionId:'b'.repeat(64),deviceId:null},{type:'policy',company_id:'company'});
 assert.equal(value.company_id,'company');assert.equal(value.policy_revision,1);
});

test('relative, directory and oversized policy files are rejected before a store is created',async t=>{
 const f=await fixture(t);
 await assert.rejects(loadNativeJubianAdmission('relative.json',{accounts:f.accounts}),{code:'native_jubian_admission_private_configuration_required'});
 await assert.rejects(loadNativeJubianAdmission(f.root,{accounts:f.accounts}),{code:'native_jubian_admission_private_configuration_required'});
 const path=join(f.root,'oversized.json');await writeFile(path,' '.repeat(1048577),{mode:0o600});
 await assert.rejects(loadNativeJubianAdmission(path,{accounts:f.accounts}),{code:'native_jubian_admission_private_configuration_required'});
 await assert.rejects(access(f.config.databaseFile));
});

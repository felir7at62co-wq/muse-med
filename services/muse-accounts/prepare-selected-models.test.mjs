import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {createHash} from 'node:crypto';
import {promisify} from 'node:util';
import {chmod,mkdir,mkdtemp,readFile,readdir,rm,stat,symlink,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {prepareSelectedModelsFiles,readPrivateModelFile} from './prepare-selected-models.mjs';

const run=promisify(execFile),cli=fileURLToPath(new URL('./prepare-selected-models.mjs',import.meta.url));
async function fixture(t){
 const root=await mkdtemp(join(tmpdir(),'muse-selected-private-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const source=join(root,'original.native'),output=join(root,'selected.native'),keyFile=join(root,'deepseek.key'),zhipuFile=join(root,'zhipu.key');
 const raw=JSON.stringify({version:2,revision:3,metadataRevision:8,providers:{old:{api:'openai-completions',baseURL:'https://wy6688.token6688.com/v1',
  apiKeyEnv:'OLD_KEY',models:[{id:'gpt-6-sol'},{id:'removed'}]}},credentials:{OLD_KEY:'private-yunying-fixture'}})+'\n';
 await writeFile(source,raw,{mode:0o600});await writeFile(keyFile,'private-official-fixture\n',{mode:0o600});
 await writeFile(zhipuFile,'private-zhipu-fixture\n',{mode:0o600});
 return {root,source,output,keyFile,zhipuFile,raw,args:['--source',source,'--output',output,'--deepseek-key-file',keyFile,'--zhipu-key-file',zhipuFile]};
}

test('offline CLI creates owner-only candidate and exact backup without modifying source or printing keys',async t=>{
 const f=await fixture(t),result=await run(process.execPath,[cli,...f.args],{env:{},timeout:20000});
 assert.equal(result.stderr,'');assert.doesNotMatch(result.stdout,/private-|wy6688\.token6688\.com|api\.deepseek/);
 const receipt=JSON.parse(result.stdout);assert.equal(receipt.prepared,true);assert.equal(receipt.deployed,false);
 assert.equal(receipt.providers.flatMap(provider=>provider.models).length,11);
 assert.equal(await readFile(f.source,'utf8'),f.raw);assert.equal(await readFile(f.output+'.source-backup','utf8'),f.raw);
 const candidate=JSON.parse(await readFile(f.output,'utf8'));assert.equal(candidate.credentials.MUSE_DEEPSEEK_API_KEY,'private-official-fixture');
 assert.equal(candidate.credentials.MUSE_YUNYING_API_KEY,'private-yunying-fixture');
 assert.equal(candidate.credentials.MUSE_ZHIPU_API_KEY,'private-zhipu-fixture');assert.equal(candidate.revision,4);
 assert.equal(candidate.providers['zhipu-official'].apiKeyEnv,'MUSE_ZHIPU_API_KEY');
 assert.equal(receipt.sourceSha256,createHash('sha256').update(f.raw).digest('hex'));
 assert.equal(receipt.candidateSha256,createHash('sha256').update(await readFile(f.output)).digest('hex'));
 if(process.platform!=='win32')for(const path of [f.output,f.output+'.source-backup'])assert.equal((await stat(path)).mode&0o777,0o600);
 assert.deepEqual((await readdir(f.root)).filter(name=>name.endsWith('.tmp')),[]);
});

test('operator environment credentials and explicit supplier settings need no local user configuration',async t=>{
 const f=await fixture(t),receipt=await prepareSelectedModelsFiles(['--source',f.source,'--output',f.output,
  '--yunying-base-url','https://wy6688.token6688.com/override/v1'],{DEEPSEEK_API_KEY:'environment-official',MUSE_YUNYING_API_KEY:'environment-cloud',MUSE_ZHIPU_API_KEY:'environment-zhipu'});
 assert.equal(receipt.prepared,true);const candidate=JSON.parse(await readFile(f.output,'utf8'));
 assert.equal(candidate.providers.yunying.baseURL,'https://wy6688.token6688.com/override/v1');
 assert.equal(candidate.credentials.MUSE_DEEPSEEK_API_KEY,'environment-official');assert.equal(candidate.credentials.MUSE_YUNYING_API_KEY,'environment-cloud');
 assert.equal(candidate.credentials.MUSE_ZHIPU_API_KEY,'environment-zhipu');
 const f2=await fixture(t),cloudFile=join(f2.root,'yunying.key');await writeFile(cloudFile,'file-cloud\n',{mode:0o600});
 await prepareSelectedModelsFiles([...f2.args,'--yunying-key-file',cloudFile],{DEEPSEEK_API_KEY:'ignored-environment',MUSE_YUNYING_API_KEY:'ignored-environment'});
 assert.equal(JSON.parse(await readFile(f2.output,'utf8')).credentials.MUSE_YUNYING_API_KEY,'file-cloud');
 assert.equal(JSON.parse(await readFile(f2.output,'utf8')).credentials.MUSE_ZHIPU_API_KEY,'private-zhipu-fixture');
});

test('options, existing outputs, malformed JSON and missing keys leave all input files intact',async t=>{
 const f=await fixture(t);
 await assert.rejects(prepareSelectedModelsFiles(['--source',f.source,'--output',f.output,'--deepseek-key-file',f.keyFile],{}),/credentials/);
 for(const args of [[],['--source',f.source],['--source',f.source,'--output',f.output,'--output',f.output],
  [...f.args,'--unknown','value'],['--source',f.source,'--output','relative'],['--source',f.source,'--output',f.source],
  ['--source',f.output+'.source-backup','--output',f.output],['--source',f.source,'--output',f.output],
 ])await assert.rejects(prepareSelectedModelsFiles(args,{}));
 await writeFile(f.output,'retained',{mode:0o600});await assert.rejects(prepareSelectedModelsFiles(f.args,{}),/exists/);
 assert.equal(await readFile(f.output,'utf8'),'retained');await assert.rejects(stat(f.output+'.source-backup'));
 await rm(f.output);await writeFile(f.source,'{"key":"private-invalid-json"',{mode:0o600});
 await assert.rejects(prepareSelectedModelsFiles(f.args,{}),/valid JSON/);await assert.rejects(stat(f.output));
 await writeFile(f.source,f.raw);await writeFile(f.output+'.source-backup','keep-backup',{mode:0o600});
 await assert.rejects(prepareSelectedModelsFiles(f.args,{}),/exists/);assert.equal(await readFile(f.output+'.source-backup','utf8'),'keep-backup');
 assert.equal(await readFile(f.source,'utf8'),f.raw);
});

test('failure output contains only a fixed code even when a private input is malformed',async t=>{
 const f=await fixture(t);await writeFile(f.source,'{"private":"private-malformed-secret"',{mode:0o600});
 await assert.rejects(run(process.execPath,[cli,...f.args],{env:{},timeout:20000}),error=>{
  assert.equal(error.killed,false);assert.equal(error.signal,null);assert.equal(error.code,1);assert.equal(error.stdout,'');
  assert.deepEqual(JSON.parse(error.stderr),{prepared:false,deployed:false,code:'selected_model_preparation_failed'});return true;
 });
});

test('private input reads reject relative paths, directories, links and oversized files',async t=>{
 const f=await fixture(t);await assert.rejects(readPrivateModelFile('relative'),/absolute/);
 await assert.rejects(readPrivateModelFile(f.root),/regular/);
 const linked=join(f.root,'linked');let linkedCreated=true;
 try{await symlink(f.source,linked);}catch(error){if(process.platform!=='win32'||error.code!=='EPERM')throw error;linkedCreated=false;}
 if(linkedCreated)await assert.rejects(readPrivateModelFile(linked),/regular/);
 const huge=join(f.root,'huge');await writeFile(huge,'x'.repeat(8*1024*1024+1),{mode:0o600});await assert.rejects(readPrivateModelFile(huge),/eight MiB/);
 const malformed=join(f.root,'malformed');await writeFile(malformed,Buffer.from([0xff]),{mode:0o600});await assert.rejects(readPrivateModelFile(malformed),/UTF-8/);
 if(process.platform!=='win32'){
  await chmod(f.keyFile,0o644);await assert.rejects(prepareSelectedModelsFiles(f.args,{}),/owner-only/);
  await chmod(f.keyFile,0o600);await chmod(f.root,0o755);await assert.rejects(prepareSelectedModelsFiles(f.args,{}),/owner-only/);await chmod(f.root,0o700);
 }
});

test('candidate credentials cannot be prepared in a repository or a product distribution tree',async t=>{
 const f=await fixture(t),repository=await mkdtemp(join(dirname(cli),'.selected-model-test-'));t.after(()=>rm(repository,{recursive:true,force:true}));
 for(const directory of [repository,join(f.root,'dist'),join(f.root,'Demo.app','Resources'),join(f.root,'public')]){
  await mkdir(directory,{recursive:true,mode:0o700});
  await assert.rejects(prepareSelectedModelsFiles(['--source',f.source,'--output',join(directory,'candidate'),
   '--deepseek-key-file',f.keyFile],{}),/outside repositories|distribution/);
  assert.deepEqual(await readdir(directory),[]);
 }
 const other=join(f.root,'another-repo');await mkdir(other,{mode:0o700});await writeFile(join(other,'.git'),'gitdir: elsewhere');
 await assert.rejects(prepareSelectedModelsFiles(['--source',f.source,'--output',join(other,'candidate'),'--deepseek-key-file',f.keyFile],{}),/outside repositories/);
});

test('concurrent CLI preparations acquire one candidate and never overwrite its backup',async t=>{
 const f=await fixture(t),results=await Promise.allSettled(Array.from({length:2},()=>run(process.execPath,[cli,...f.args],{env:{},timeout:20000})));
 assert.equal(results.filter(result=>result.status==='fulfilled').length,1);
 const failure=results.find(result=>result.status==='rejected').reason;
 assert.equal(failure.killed,false);assert.equal(failure.signal,null);assert.equal(failure.code,1);
 assert.equal(await readFile(f.source,'utf8'),f.raw);assert.equal(await readFile(f.output+'.source-backup','utf8'),f.raw);
 assert.equal(JSON.parse(await readFile(f.output,'utf8')).providers.yunying.models.length,7);
 assert.equal(JSON.parse(await readFile(f.output,'utf8')).providers['zhipu-official'].models.length,2);
 assert.deepEqual((await readdir(f.root)).filter(name=>name.endsWith('.tmp')),[]);
});

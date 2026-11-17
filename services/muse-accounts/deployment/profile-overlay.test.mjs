/** Local candidate construction refuses unknown inputs and never rewrites its release source. */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,mkdir,readFile,readdir,rm,writeFile,copyFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {buildProfileOverlay,inspectProfileOverlay,preflightProfileOverlay} from './profile-overlay.mjs';

const home=dirname(fileURLToPath(import.meta.url)),digest=value=>createHash('sha256').update(value).digest('hex');
async function fixture(t){
 const root=await mkdtemp(join(tmpdir(),'muse-profile-overlay-test-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const source=join(root,'source'),output=join(root,'candidate'),patchRoot=join(root,'patches'),moduleRoot=resolve(home,'..');
 await mkdir(source);await mkdir(patchRoot);
 const definition={version:1,baseRelease:'synthetic-base',verifiedRelease:'synthetic-profile',patchedFiles:{},modules:{}};
 for(const name of ['gateway.mjs','store.mjs','account-pages.mjs']){
  const before="export const feature='base';\n",after="export const feature='profile';\n",patch=name+'.patch';
  await writeFile(join(source,name),before);await writeFile(join(patchRoot,patch),`--- base/${name}\n+++ patched/${name}\n@@ -1 +1 @@\n-${before}+${after}`);
  definition.patchedFiles[name]={before:digest(before),after:digest(after),patch};
 }
 for(const name of ['account-profile.mjs','account-groups.mjs'])definition.modules[name]=digest(await readFile(join(moduleRoot,name)));
 return {root,source,output,patchRoot,moduleRoot,definition};
}

test('a candidate contains only five patched modules and a deterministic manifest, preserving all source files',async t=>{
 const f=await fixture(t);await writeFile(join(f.source,'unrelated-config.json'),'synthetic-private-value');
 const before=await readFile(join(f.source,'gateway.mjs'),'utf8'),manifest=await buildProfileOverlay(f);
 assert.equal(await readFile(join(f.source,'gateway.mjs'),'utf8'),before);
 assert.deepEqual((await readdir(f.output)).sort(),['account-groups.mjs','account-pages.mjs','account-profile.mjs','gateway.mjs','profile-overlay.json','store.mjs']);
 assert.equal(manifest.base,'synthetic-base');assert.equal((await inspectProfileOverlay({...f,source:f.output})).alreadyCurrent,true);
 await preflightProfileOverlay({...f,candidate:f.output});
 const again=join(f.root,'again'),second=await buildProfileOverlay({...f,source:f.output,output:again});
 assert.deepEqual(second.files,manifest.files);assert.equal(second.base,'current-overlay');
});

test('unknown, missing and mixed-version sources fail before creating an output directory',async t=>{
 for(const mutation of ['changed','missing','mixed']){
  const f=await fixture(t);
  if(mutation==='changed')await writeFile(join(f.source,'store.mjs'),"export const feature='unknown';\n");
  if(mutation==='missing')await rm(join(f.source,'store.mjs'));
  if(mutation==='mixed')await copyFile(join(f.moduleRoot,'account-groups.mjs'),join(f.source,'account-groups.mjs'));
  await assert.rejects(buildProfileOverlay(f),/Unsupported source/);
  await assert.rejects(readdir(f.output),error=>error.code==='ENOENT');
 }
});

test('a nonregular source refuses before a candidate can be created',async t=>{
 const f=await fixture(t);await rm(join(f.source,'store.mjs'));await mkdir(join(f.source,'store.mjs'));
 await assert.rejects(buildProfileOverlay(f),/Expected a regular source file/);
 await assert.rejects(readdir(f.output),error=>error.code==='ENOENT');
});

test('existing outputs and source containment refuse without removing user files',async t=>{
 const f=await fixture(t);await mkdir(f.output);await writeFile(join(f.output,'keep'),'existing-content');
 await assert.rejects(buildProfileOverlay(f),error=>error.code==='EEXIST');assert.equal(await readFile(join(f.output,'keep'),'utf8'),'existing-content');
 for(const output of [f.source,join(f.source,'nested'),f.root])await assert.rejects(buildProfileOverlay({...f,output}),/must be separate/);
});

test('a verified prior profile release can rebuild with reviewed newer profile modules',async t=>{
 const f=await fixture(t);await buildProfileOverlay(f);
 const moduleRoot=join(f.root,'new-modules');await mkdir(moduleRoot);
 for(const name of Object.keys(f.definition.modules))await writeFile(join(moduleRoot,name),Buffer.concat([await readFile(join(f.moduleRoot,name)),Buffer.from('\n// Synthetic module revision.\n')]));
 const inspection=await inspectProfileOverlay({...f,source:f.output,moduleRoot});assert.equal(inspection.baseline,'synthetic-profile');
 const upgraded=join(f.root,'upgraded');await buildProfileOverlay({...f,source:f.output,output:upgraded,moduleRoot});
 assert.equal((await inspectProfileOverlay({...f,source:upgraded,moduleRoot})).alreadyCurrent,true);
});

test('changed patches cannot publish a candidate with an unpinned output',async t=>{
 const f=await fixture(t),path=join(f.patchRoot,'store.mjs.patch');
 await writeFile(path,(await readFile(path,'utf8')).replace("feature='profile'","feature='unexpected'"));
 await assert.rejects(buildProfileOverlay(f),/Candidate hashes differ/);
 await assert.rejects(readdir(f.output),error=>error.code==='ENOENT');
});

test('production metadata identifies both verified releases and exactly three patch files',async()=>{
 const definition=JSON.parse(await readFile(join(home,'baselines.json'),'utf8'));
 assert.equal(definition.baseRelease,'20261117-r24-native-company');assert.equal(definition.verifiedRelease,'20261117-r25-account-profile');
 assert.deepEqual(Object.keys(definition.patchedFiles).sort(),['account-pages.mjs','gateway.mjs','store.mjs']);
 for(const [name,item] of Object.entries(definition.patchedFiles)){
  assert.match(item.before,/^[a-f0-9]{64}$/);assert.match(item.after,/^[a-f0-9]{64}$/);
  const patch=await readFile(join(home,'patches',item.patch),'utf8');
  assert.equal((patch.match(/^--- /gm)??[]).length,1);assert.equal((patch.match(/^\+\+\+ /gm)??[]).length,1);
  assert.ok(patch.startsWith('--- base/'+name+'\n+++ patched/'+name+'\n'));
 }
});

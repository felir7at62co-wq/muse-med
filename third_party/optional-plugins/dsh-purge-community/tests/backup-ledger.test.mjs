import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {importPackage, temporaryDirectory} from './support.mjs';
const {BackupLedger, backupContentHash} = await importPackage('lib/backup-ledger.js');

const suiteRoot = path.join(temporaryDirectory, 'backup-fixtures');
fs.mkdirSync(suiteRoot,{recursive:true});
process.env.DSH_HOME=path.join(suiteRoot,'home');
process.env.MUSE_HOME=process.env.DSH_HOME;
process.env.DSH_PROFILE='desktop';
process.env.TEMP=path.join(suiteRoot,'temp');process.env.TMP=process.env.TEMP;
fs.mkdirSync(process.env.DSH_HOME,{recursive:true});fs.mkdirSync(process.env.TEMP,{recursive:true});
fs.mkdirSync(path.join(process.env.DSH_HOME,'profiles/desktop'),{recursive:true});
process.env.PURGE_PROFILE_DIR=path.join(process.env.DSH_HOME,'profiles/desktop');
fs.writeFileSync(path.join(process.env.PURGE_PROFILE_DIR,'package.json'),'{}');
fs.writeFileSync(path.join(process.env.PURGE_PROFILE_DIR,'cordis.patch.yml'),'plugins: []\n');
let number=0;
function fixture(){
  const base=path.join(suiteRoot,String(++number),'@deepseek-ai');
  for(const pkg of ['dsh-base','dsh-agent-loop','dsh-system-prompt','dsh-agent-instructions']){
    fs.mkdirSync(path.join(base,pkg,'lib'),{recursive:true});
    fs.writeFileSync(path.join(base,pkg,'package.json'),JSON.stringify({name:'@deepseek-ai/'+pkg,version:'0.2.1-alpha.1'}));
  }
  const file=path.join(base,'dsh-agent-instructions/lib/index.js');
  const original="export const fixture = 'ORIGINAL';\n";
  fs.writeFileSync(file,original);
  process.env.DSH_BASE=base;
  return {base,file,original,bak:file+'.dshpurge.bak'};
}
function desktopFixture(){
  const app=path.join(suiteRoot,'desktop-'+(++number),'resources/app');
  const base=path.join(app,'dsh/node_modules/@deepseek-ai');
  for(const pkg of ['dsh-base','dsh-agent-loop','dsh-system-prompt','dsh-agent-instructions','dsh-desktop-host']){
    fs.mkdirSync(path.join(base,pkg,'lib'),{recursive:true});
    fs.writeFileSync(path.join(base,pkg,'package.json'),JSON.stringify({name:'@deepseek-ai/'+pkg,version:'0.2.1-alpha.1'}));
  }
  fs.writeFileSync(path.join(base,'dsh-desktop-host/lib/cli.js'),'export {};');
  fs.mkdirSync(path.join(app,'lib'),{recursive:true});
  fs.writeFileSync(path.join(app,'package.json'),JSON.stringify({name:'muse-med',version:'1.2.8',main:'lib/main.js'}));
  const file=path.join(app,'lib/main.js'),original='export const shell = true;\n';
  fs.writeFileSync(file,original);process.env.DSH_BASE=base;
  return {app,base,file,original,bak:file+'.dshpurge.bak'};
}
const first=fixture();
const core = await importPackage('lib/core.js');
const patches=[{id:50001,name:'FIXTURE_MARKERLESS',file:'agent-instructions',marker:'PATCHED',replacements:[{pattern:'ORIGINAL',replace:'PATCHED'}]}];

test('backup/apply/repeat/revert preserves exact markerless original',async()=>{
  const f=fixture();
  assert.deepEqual((await core.backupAll(f.base)).errors,[]);
  const backup=fs.readFileSync(f.bak);
  const applied=await core.applyPatches(f.base,patches,{surface:'desktop'});
  assert.equal(applied[0].status,'applied');
  assert.equal(fs.readFileSync(f.file,'utf8').includes('dsh-purge'),false);
  assert.equal(fs.readFileSync(f.file,'utf8').includes('PATCHED'),true);
  const second=await core.applyPatches(f.base,patches,{surface:'desktop'});
  assert.equal(second.some(x=>x.status==='failed'),false);
  assert.deepEqual(fs.readFileSync(f.bak),backup);
  assert.equal(core.refreshStaleBaksForUpgrade(f.base).conflicts.length,0);
  assert.deepEqual((await core.revertAll(f.base)).errors,[]);
  assert.equal(fs.readFileSync(f.file,'utf8'),f.original);
});

test('multiple patches on one file record final output, not an intermediate state',async()=>{
  const f=fixture();await core.backupAll(f.base);
  const more=[...patches,{id:50002,name:'FIXTURE_SECOND',file:'agent-instructions',marker:'DONE',replacements:[{pattern:'PATCHED',replace:'DONE'}]}];
  await core.applyPatches(f.base,more,{surface:'desktop'});
  const entry=new BackupLedger(f.base).doc.entries[path.resolve(f.file)];
  assert.equal(entry.outputs.at(-1),backupContentHash(fs.readFileSync(f.file)));
  assert.equal(entry.outputs.length,1);
  assert.deepEqual((await core.revertAll(f.base)).errors,[]);
  assert.equal(fs.readFileSync(f.file,'utf8'),f.original);
});

test('manual edits are neither adopted as backups nor overwritten by apply/revert',async()=>{
  const f=fixture();await core.backupAll(f.base);await core.applyPatches(f.base,patches,{surface:'desktop'});
  const manual=fs.readFileSync(f.file,'utf8')+'// user edit\n';fs.writeFileSync(f.file,manual);
  const result=await core.applyPatches(f.base,patches,{surface:'desktop'});
  assert.match(result[0].error,/unrecognized_current_content/);
  assert.ok((await core.revertAll(f.base)).errors.length);
  assert.equal(fs.readFileSync(f.file,'utf8'),manual);
  assert.equal(fs.readFileSync(f.bak,'utf8'),f.original);
});

test('changed host version needs an explicit new baseline and cannot restore old code',async()=>{
  const f=fixture();await core.backupAll(f.base);await core.applyPatches(f.base,patches,{surface:'desktop'});
  fs.writeFileSync(path.join(f.base,'dsh-agent-loop/package.json'),JSON.stringify({name:'@deepseek-ai/dsh-agent-loop',version:'0.2.2'}));
  fs.writeFileSync(f.file,'export const newHost = true;\n');
  assert.match(core.refreshStaleBaksForUpgrade(f.base).conflicts[0][1],/host_upgrade_requires_rebaseline/);
  assert.ok((await core.revertAll(f.base)).errors.length);
  assert.equal(fs.readFileSync(f.file,'utf8'),'export const newHost = true;\n');
  assert.equal(fs.readFileSync(f.bak,'utf8'),f.original);
});

test('untracked legacy modified content is preserved; identical legacy backup can be adopted',async()=>{
  const f=fixture();fs.copyFileSync(f.file,f.bak);fs.writeFileSync(f.file,'LEGACY PATCH WITHOUT MARKER');
  assert.match(core.refreshStaleBaksForUpgrade(f.base).conflicts[0][1],/untracked_backup/);
  assert.ok((await core.backupAll(f.base)).errors.length);
  assert.equal(fs.readFileSync(f.bak,'utf8'),f.original);
  fs.writeFileSync(f.file,f.original);
  assert.deepEqual((await core.backupAll(f.base)).errors,[]);
  assert.equal(new BackupLedger(f.base).inspect(f.file).ok,true);
});

test('corrupt ledger and changed backup fail closed with original evidence intact',async()=>{
  const f=fixture();await core.backupAll(f.base);
  const ledger=new BackupLedger(f.base);
  fs.writeFileSync(f.bak,'CORRUPT');
  assert.match(core.refreshStaleBaksForUpgrade(f.base).conflicts[0][1],/backup_hash_changed/);
  assert.ok((await core.revertAll(f.base)).errors.length);
  fs.writeFileSync(ledger.file,'{broken');
  assert.match((await core.applyPatches(f.base,patches))[0].error,/ledger unreadable/);
  assert.ok((await core.backupAll(f.base)).errors.length);
  assert.equal(fs.readFileSync(f.file,'utf8'),f.original);
  assert.equal(fs.readFileSync(f.bak,'utf8'),'CORRUPT');
});

test('atomic ledger failure is reported and keeps the valid backup',()=>{
  const f=fixture();fs.copyFileSync(f.file,f.bak);
  const io={...fs,renameSync(){const e=new Error('fixture permission denied');e.code='EACCES';throw e;}};
  const ledger=new BackupLedger(f.base,{fs:io});
  assert.throws(()=>ledger.baseline(f.file,{created:true}),/fixture permission denied/);
  assert.equal(fs.readFileSync(f.bak,'utf8'),f.original);
});

test('a concurrent ledger change is reported instead of overwritten',()=>{
  const f=fixture();fs.copyFileSync(f.file,f.bak);
  const first=new BackupLedger(f.base);first.baseline(f.file,{created:true});
  const other=new BackupLedger(f.base);
  const initial=fs.readFileSync(first.file,'utf8');
  fs.writeFileSync(first.file,initial+'\n');
  assert.throws(()=>other.save(),/changed during/);
  assert.equal(fs.readFileSync(first.file,'utf8'),initial+'\n');
});

test('missing original never restores a tampered backup through direct, boot or revert paths',async()=>{
  const f=fixture();await core.backupAll(f.base);
  fs.writeFileSync(f.bak,'CHANGED_BACKUP');fs.unlinkSync(f.file);
  assert.match(core.refreshStaleBaksForUpgrade(f.base).conflicts[0][1],/backup_hash_changed/);
  assert.ok(core.restoreMissingOriginalsFromBak(f.base).errors.length);
  assert.ok(core.restoreMissingOriginalsAllHosts({boot:true}).errors.length);
  assert.ok((await core.revertAll(f.base)).errors.length);
  assert.equal(fs.existsSync(f.file),false);
  assert.equal(fs.readFileSync(f.bak,'utf8'),'CHANGED_BACKUP');
});

test('missing original plus changed host identity is retained for review',async()=>{
  const f=fixture();await core.backupAll(f.base);fs.unlinkSync(f.file);
  fs.writeFileSync(path.join(f.base,'dsh-agent-loop/package.json'),'{}');
  assert.match(core.refreshStaleBaksForUpgrade(f.base).conflicts[0][1],/host_upgrade_requires_rebaseline/);
  assert.ok(core.restoreMissingOriginalsFromBak(f.base).errors.length);
  assert.equal(fs.existsSync(f.file),false);
});

test('missing original with its verified backup still restores exact bytes',async()=>{
  const f=fixture();await core.backupAll(f.base);fs.unlinkSync(f.file);
  const restored=core.restoreMissingOriginalsFromBak(f.base);
  assert.deepEqual(restored.errors,[]);
  assert.ok(restored.includes(f.file));
  assert.equal(fs.readFileSync(f.file,'utf8'),f.original);
});

test('deleted backup cannot be recreated from patched content or reset an existing baseline',async()=>{
  const f=fixture();await core.backupAll(f.base);await core.applyPatches(f.base,patches,{surface:'desktop'});
  const ledger=new BackupLedger(f.base), originalLedger=fs.readFileSync(ledger.file,'utf8');
  fs.unlinkSync(f.bak);
  const result=await core.backupAll(f.base);
  assert.ok(result.errors.some(([file,error])=>file===f.file&&/missing_original_backup/.test(error)));
  assert.equal(fs.existsSync(f.bak),false);
  assert.equal(fs.readFileSync(ledger.file,'utf8'),originalLedger);
  assert.ok((await core.revertAll(f.base)).errors.length);
  assert.ok(fs.readFileSync(f.file,'utf8').includes('PATCHED'));
  // The low-level API also cannot launder an already-patched file as baseline.
  fs.copyFileSync(f.file,f.bak);
  assert.throws(()=>ledger.baseline(f.file,{created:true}),/backup_hash_changed/);
  assert.equal(fs.readFileSync(ledger.file,'utf8'),originalLedger);
});

test('deleted backup can be rebuilt only from the exact registered original',async()=>{
  const f=fixture();await core.backupAll(f.base);fs.unlinkSync(f.bak);
  assert.deepEqual((await core.backupAll(f.base)).errors,[]);
  assert.equal(fs.readFileSync(f.bak,'utf8'),f.original);
});

test('ledger cannot inject an external file into missing-original recovery',async()=>{
  const f=fixture();await core.backupAll(f.base);
  const outside=path.join(suiteRoot,'outside.txt');fs.writeFileSync(outside,'outside');
  const ledger=new BackupLedger(f.base), doc=JSON.parse(fs.readFileSync(ledger.file,'utf8'));
  doc.entries[outside]={...doc.entries[path.resolve(f.file)]};fs.writeFileSync(ledger.file,JSON.stringify(doc));
  assert.throws(()=>new BackupLedger(f.base),/outside this host/);
  assert.ok(core.restoreMissingOriginalsFromBak(f.base).errors.length);
  assert.equal(fs.readFileSync(outside,'utf8'),'outside');
});

test('interleaving at the former compare/rename gap rejects the competing writer under a lock',()=>{
  const f=fixture();fs.copyFileSync(f.file,f.bak);
  const first=new BackupLedger(f.base);first.baseline(f.file);
  const other=new BackupLedger(f.base);
  let armed=false, conflict;
  const io={...fs,readFileSync(file,...args){
    const value=fs.readFileSync(file,...args);
    if(armed&&file===first.file){
      armed=false;
      other.doc.entries[path.resolve(f.file)].outputs.push('b'.repeat(64));
      try{other.save();}catch(error){conflict=error;}
    }
    return value;
  }};
  const writer=new BackupLedger(f.base,{fs:io});
  writer.doc.entries[path.resolve(f.file)].outputs.push('a'.repeat(64));armed=true;writer.save();
  assert.equal(conflict?.code,'MAINTENANCE_BUSY');
  assert.deepEqual(new BackupLedger(f.base).doc.entries[path.resolve(f.file)].outputs,['a'.repeat(64)]);
});

test('the exact manifest-declared missing desktop shell can be restored outside the package root',async()=>{
  const f=desktopFixture();assert.deepEqual((await core.backupAll(f.base)).errors,[]);
  fs.unlinkSync(f.file);
  assert.deepEqual(core.refreshStaleBaksForUpgrade(f.base).conflicts,[]);
  const restored=core.restoreMissingOriginalsFromBak(f.base);
  assert.deepEqual(restored.errors,[]);
  assert.ok(restored.includes(f.file));
  assert.equal(fs.readFileSync(f.file,'utf8'),f.original);
});

test('a modified app manifest cannot make an old shell backup authoritative',async()=>{
  const f=desktopFixture();await core.backupAll(f.base);fs.unlinkSync(f.file);
  fs.writeFileSync(path.join(f.app,'package.json'),JSON.stringify({name:'muse-med',version:'9',main:'lib/main.js'}));
  assert.ok(core.restoreMissingOriginalsFromBak(f.base).errors.length);
  assert.equal(fs.existsSync(f.file),false);
});

test('an app manifest cannot grant a missing shell permission outside its app',async()=>{
  const f=desktopFixture();await core.backupAll(f.base);fs.unlinkSync(f.file);
  const outside=path.join(suiteRoot,'outside-shell.js');fs.writeFileSync(outside+'.dshpurge.bak','external');
  fs.writeFileSync(path.join(f.app,'package.json'),JSON.stringify({name:'muse-med',main:path.relative(f.app,outside)}));
  assert.ok(core.restoreMissingOriginalsFromBak(f.base).errors.length);
  assert.equal(fs.existsSync(outside),false);
  assert.equal(fs.existsSync(f.file),false);
});

test('a parent junction cannot redirect declared missing-shell restoration outside the app',async()=>{
  const f=desktopFixture();await core.backupAll(f.base);fs.unlinkSync(f.file);
  const outside=path.join(suiteRoot,'junction-outside-'+number);fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside,'main.js.dshpurge.bak'),'external');
  fs.renameSync(path.join(f.app,'lib'),path.join(f.app,'lib-original'));
  fs.symlinkSync(outside,path.join(f.app,'lib'),'junction');
  assert.ok(core.restoreMissingOriginalsFromBak(f.base).errors.length);
  assert.equal(fs.existsSync(path.join(outside,'main.js')),false);
  assert.equal(fs.readFileSync(path.join(outside,'main.js.dshpurge.bak'),'utf8'),'external');
});

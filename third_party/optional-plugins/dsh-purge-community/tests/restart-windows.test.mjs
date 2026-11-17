import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import test from 'node:test';
import vm from 'node:vm';
import {importPackage, packageFile, temporaryDirectory, onceWithin, readyProcess} from './support.mjs';
const {officialRestartScript} = await importPackage('lib/desktop.js');

if (process.env.DSH_PURGE_RESTART) throw new Error('Restart payload must be absent during tests');
const {
  normalizeWindowsExecutable, selectWindowsProcessRecords,
  readWindowsDesktopProcesses, terminateWindowsDesktopProcesses,
  windowsTerminateScript, formatRestartError,
} = await importPackage('lib/restart-desktop.js');

const target = 'E:\\isolated app\\muse-med.exe';
const row = (pid, executablePath = target, startTime = '133000000000000000') => ({
  pid, executablePath, startTime, name: 'muse-med',
});

function legacyFunctions(exe, records, run=()=>0) {
  const rows=records;
  const prefix=officialRestartScript(exe,'E:\\isolated app\\resources\\app.asar','E:\\isolated home').split("log('begin');")[0];
  const sh={Run:run};
  const ctx={
    ActiveXObject:function(name){
      if(name==='Scripting.FileSystemObject') return {GetFileName:x=>path.win32.basename(x),OpenTextFile:()=>({WriteLine:()=>{},Close:()=>{}})};
      if(name==='WScript.Shell') return sh;
      if(name==='ADODB.Stream') return {Open(){},Close(){},WriteText(s){this.text=s;},Read(){return Buffer.from(this.text,'utf16le');}};
      if(name==='MSXML2.DOMDocument.6.0') return {createElement:()=>({set nodeTypedValue(b){this.text=Buffer.from(b).toString('base64');}})};
      throw new Error('Unexpected COM object '+name);
    },
    GetObject:()=>({ExecQuery:()=>rows}),
    Enumerator:function(items){let i=0;this.atEnd=()=>i>=items.length;this.moveNext=()=>i++;this.item=()=>items[i];},
  };
  vm.runInNewContext(prefix,ctx);
  return ctx;
}

test('exact Windows paths accept casing/device spelling but reject prefix neighbours and other installations', () => {
  assert.equal(normalizeWindowsExecutable('\\\\?\\E:\\ISOLATED APP\\muse-med.exe'), target.toLowerCase());
  const selected = selectWindowsProcessRecords([
    row(21), row(22, 'E:\\isolated app old\\muse-med.exe'),
    row(23, 'D:\\production\\muse-med.exe'), row(24, 'E:/ISOLATED APP/muse-med.exe'),
  ], target);
  assert.deepEqual(selected.map(x => x.pid), [21,24]);
  for (const invalid of ['', 'muse-med.exe', '..\\muse-med.exe', '\\root-relative\\muse-med.exe', 'E:\\bad\npath.exe']) {
    assert.throws(() => normalizeWindowsExecutable(invalid));
  }
});

test('unknown or inconsistent identities cannot become termination candidates', () => {
  assert.throws(() => selectWindowsProcessRecords([row(21, null)], target), /Cannot identify/);
  assert.throws(() => selectWindowsProcessRecords([row(21, target, '')], target), /creation time/);
  assert.throws(() => selectWindowsProcessRecords([row(21, target, 133000000000000000)], target), /creation time/);
  assert.throws(() => selectWindowsProcessRecords([row(21), row(21, target, '999')], target), /Conflicting/);
  assert.throws(() => readWindowsDesktopProcesses(target, {execFileSync:()=>{throw new Error('access denied');}}), /access denied/);
  assert.throws(() => readWindowsDesktopProcesses(target, {execFileSync:()=>'not json'}), /Cannot parse/);
});

test('standalone helper without a restart payload fails instead of claiming a restart', () => {
  const env={...process.env};delete env.DSH_PURGE_RESTART;
  const result=spawnSync(process.execPath,[packageFile('lib/restart-desktop.js')],{env,windowsHide:true,encoding:'utf8'});
  assert.equal(result.status,1);
});

test('termination dispatch uses only captured records and skips the helper PID', () => {
  let invocations=0;
  const killed=terminateWindowsDesktopProcesses(target,[row(21),row(22)], [22], {
    execFileSync:(program,args)=>{
      invocations++;
      assert.equal(program,'powershell.exe');
      assert.ok(args.includes('-NonInteractive'));
      assert.equal(args.some(x=>/taskkill|IMAGENAME/i.test(x)),false);
      return '';
    },
  });
  assert.equal(invocations,1);
  assert.deepEqual(killed,[21]);
  terminateWindowsDesktopProcesses(target,[row(22)],[22],{execFileSync:()=>assert.fail('excluded PID must not run a helper')});
});

test('restart failures retain the OS status and stderr without dumping the generated command',()=>{
  const detail=formatRestartError({message:'Command failed: powershell.exe\nSECRET SCRIPT BODY',status:7,stderr:Buffer.from('fixture access denied\n')});
  assert.match(detail,/status=7/);assert.match(detail,/fixture access denied/);assert.doesNotMatch(detail,/SECRET SCRIPT BODY/);
});

test('legacy Windows helper uses the exact executable and a creation-time-checked handle',()=>{
  const records=[
    {ProcessId:20,Name:'muse-med.exe',ExecutablePath:target,CreationDate:'20261110110000.000000+480'},
    {ProcessId:21,Name:'muse-med.exe',ExecutablePath:'E:\\isolated app old\\muse-med.exe',CreationDate:'20261110110000.000000+480'},
    {ProcessId:22,Name:'muse-med.exe',ExecutablePath:'D:\\production\\muse-med.exe',CreationDate:'20261110110000.000000+480'},
  ];
  let command;
  const api=legacyFunctions(target,records,(text,hidden,wait)=>{command=text;assert.equal(hidden,0);assert.equal(wait,true);return 0;});
  const selected=api.pids();
  assert.deepEqual(Array.from(selected,x=>x.pid),[20]);
  api.terminateObserved(selected[0]);
  const body=Buffer.from(command.split(' -EncodedCommand ')[1],'base64').toString('utf16le');
  assert.match(body,/\[void\]\$p.Handle/);
  assert.match(body,/StartTime/);
  assert.match(body,/GetProcessById\(20\)/);
  assert.doesNotMatch(body,/taskkill|Stop-Process/);
  assert.throws(()=>legacyFunctions(target,[{ProcessId:23,Name:'muse-med.exe'}]).pids(),/Cannot identify/);
});

test('two real isolated installations: stale identity is refused, exact target terminates, other instance survives', {skip:process.platform!=='win32', timeout:60000}, async () => {
  const fixtureBase = path.join(temporaryDirectory, 'restart-fixtures 中文');
  const root=path.resolve(fixtureBase,`${process.pid}-${Date.now()}`);
  const executableA=path.join(root,"instance-a's",'muse-med.exe');
  const executableB=path.join(root,'instance-b','muse-med.exe');
  const children=[];
  fs.mkdirSync(path.dirname(executableA),{recursive:true});
  fs.mkdirSync(path.dirname(executableB),{recursive:true});
  fs.copyFileSync(process.execPath,executableA);
  fs.copyFileSync(process.execPath,executableB);
  const fixture=path.join(root,'fixture.cjs');
  fs.writeFileSync(fixture,'process.stdout.write("ready\\n"); setInterval(()=>{},1000);');
  try {
    for(const exe of [executableA,executableB]){
      const child=spawn(exe,[fixture],{windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...process.env,DSH_PURGE_RESTART:''}});
      children.push(child);
      await readyProcess(child);
    }
    const observed=readWindowsDesktopProcesses(executableA);
    assert.deepEqual(observed.map(x=>x.pid),[children[0].pid]);
    const stale=observed.map(x=>({...x,startTime:'1'}));
    assert.throws(()=>terminateWindowsDesktopProcesses(executableA,stale),/failed|identity changed|Command/i);
    process.kill(children[0].pid,0);
    process.kill(children[1].pid,0);
    const exited=onceWithin(children[0],'exit');
    assert.deepEqual(terminateWindowsDesktopProcesses(executableA,observed),[children[0].pid]);
    await exited;
    assert.doesNotThrow(()=>process.kill(children[1].pid,0));
    assert.deepEqual(readWindowsDesktopProcesses(executableA),[]);
    assert.deepEqual(terminateWindowsDesktopProcesses(executableA,observed),[children[0].pid]);
    const legacyChild=spawn(executableA,[fixture],{windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...process.env,DSH_PURGE_RESTART:''}});
    children.push(legacyChild);await readyProcess(legacyChild);
    const created=execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',`(Get-CimInstance Win32_Process -Filter 'ProcessId = ${legacyChild.pid}').CreationDate | ForEach-Object { [Management.ManagementDateTimeConverter]::ToDmtfDateTime($_) }`],{encoding:'utf8',windowsHide:true,stdio:['ignore','pipe','pipe']}).trim();
    const api=legacyFunctions(executableA,[],command=>{
      try {execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-WindowStyle','Hidden','-EncodedCommand',command.split(' -EncodedCommand ')[1]],{windowsHide:true,stdio:['ignore','pipe','pipe']});return 0;}
      catch(error){return error.status;}
    });
    api.terminateObserved({pid:legacyChild.pid,created:'20000101000000.000000+000'});
    assert.doesNotThrow(()=>process.kill(legacyChild.pid,0));
    const legacyExit=onceWithin(legacyChild,'exit');api.terminateObserved({pid:legacyChild.pid,created});await legacyExit;
    assert.doesNotThrow(()=>process.kill(children[1].pid,0));
    const reports=path.resolve(fixtureBase,'../restart-results');fs.mkdirSync(reports,{recursive:true});
    fs.writeFileSync(path.join(reports,path.basename(root)+'.json'),JSON.stringify({targetPid:children[0].pid,otherPid:children[1].pid,staleIdentityRefused:true,otherInstanceSurvived:true,legacyPid:legacyChild.pid,legacyStaleIdentityRefused:true,legacyOtherInstanceSurvived:true},null,2));
  } finally {
    for(const child of children){if(child.exitCode===null&&child.signalCode===null){const exit=onceWithin(child,'exit');child.kill();await exit;}}
  }
});

test('real parent-child termination tolerates descendants exiting and preserves the other installation', {skip:process.platform!=='win32',timeout:60000}, async()=>{
  const root=path.join(temporaryDirectory, 'restart-fixtures 中文', `tree-${process.pid}-${Date.now()}`);
  const exe=path.join(root,'target','muse-med.exe'),otherExe=path.join(root,'other','muse-med.exe');
  for(const value of [exe,otherExe]){fs.mkdirSync(path.dirname(value),{recursive:true});fs.copyFileSync(process.execPath,value);}
  const script=path.join(root,'tree.cjs');
  fs.writeFileSync(script,`const {fork}=require('child_process');\nif(process.argv[2]==='child'){process.on('disconnect',()=>process.exit(0));process.send({ready:true});setInterval(()=>{},1000);}else{const child=fork(__filename,['child'],{execPath:process.execPath,stdio:['ignore','ignore','ignore','ipc']});child.once('message',()=>process.stdout.write(JSON.stringify({pid:process.pid,child:child.pid})+'\\n'));setInterval(()=>{},1000);}`);
  const children=[];
  const start=async(value)=>{const child=spawn(value,[script],{windowsHide:true,stdio:['ignore','pipe','pipe']});children.push(child);const [data]=await readyProcess(child);return {child,ids:JSON.parse(String(data))};};
  try{
    const other=await start(otherExe);
    for(const mode of ['node','legacy']){
      const current=await start(exe);const observed=readWindowsDesktopProcesses(exe);
      assert.deepEqual(new Set(observed.map(x=>x.pid)),new Set([current.ids.pid,current.ids.child]));
      const parentExit=onceWithin(current.child,'exit');
      if(mode==='node'){
        const ordered=[observed.find(x=>x.pid===current.ids.pid),observed.find(x=>x.pid===current.ids.child)];
        terminateWindowsDesktopProcesses(exe,ordered);
      }else{
        const api=legacyFunctions(exe,[],command=>{try{execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',command.split(' -EncodedCommand ')[1]],{windowsHide:true,stdio:['ignore','pipe','pipe']});return 0;}catch(error){return error.status;}});
        for(const pid of [current.ids.pid,current.ids.child]){
          const created=execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',`$p=Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}';if($p){[Management.ManagementDateTimeConverter]::ToDmtfDateTime($p.CreationDate)}`],{windowsHide:true,encoding:'utf8'}).trim();
          if(created)api.terminateObserved({pid,created});
        }
      }
      await parentExit;
      for(let i=0;i<30&&readWindowsDesktopProcesses(exe).length;i++)await new Promise(r=>setTimeout(r,100));
      assert.deepEqual(readWindowsDesktopProcesses(exe),[]);
      assert.doesNotThrow(()=>process.kill(other.ids.pid,0));assert.doesNotThrow(()=>process.kill(other.ids.child,0));
    }
  }finally{
    for(const child of children)if(child.exitCode===null&&child.signalCode===null){const exit=onceWithin(child,'exit');child.kill();await exit;}
  }
});

test('exiting after lookup but before handle query succeeds; live identity/access errors remain failures', {skip:process.platform!=='win32',timeout:60000},async()=>{
  const root=path.join(temporaryDirectory, 'restart-fixtures 中文', `lookup-race-${process.pid}-${Date.now()}`);
  const exe=path.join(root,'muse-med.exe');fs.mkdirSync(root,{recursive:true});fs.copyFileSync(process.execPath,exe);
  const script=path.join(root,'wait.cjs');fs.writeFileSync(script,'process.stdout.write("ready\\n");setInterval(()=>{},1000);');
  const children=[];
  const start=async()=>{const child=spawn(exe,[script],{windowsHide:true,stdio:['ignore','pipe','pipe']});children.push(child);await readyProcess(child);return child;};
  async function runPaused(body,child){
    const guarded=body.replace('[void]$p.Handle',`[Console]::WriteLine('before-handle');[Console]::Out.Flush();Start-Sleep -Milliseconds 800;[void]$p.Handle`);
    assert.notEqual(guarded,body);
    const ps=spawn('powershell.exe',['-NoProfile','-NonInteractive','-Command',guarded],{windowsHide:true,stdio:['ignore','pipe','pipe']});
    const exit=onceWithin(ps,'exit');let errors='';ps.stderr.on('data',b=>errors+=b);
    await onceWithin(ps.stdout,'data');const gone=onceWithin(child,'exit');child.kill();await gone;
    const [code]=await exit;assert.equal(code,0,errors);
  }
  try{
    const a=await start();await runPaused(windowsTerminateScript(exe,readWindowsDesktopProcesses(exe)),a);
    const b=await start();let command;
    const api=legacyFunctions(exe,[],value=>{command=value;return 0;});
    const created=execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',`[Management.ManagementDateTimeConverter]::ToDmtfDateTime((Get-CimInstance Win32_Process -Filter 'ProcessId = ${b.pid}').CreationDate)`],{windowsHide:true,encoding:'utf8'}).trim();
    api.terminateObserved({pid:b.pid,created});await runPaused(Buffer.from(command.split(' -EncodedCommand ')[1],'base64').toString('utf16le'),b);
    const c=await start();const body=windowsTerminateScript(exe,readWindowsDesktopProcesses(exe));
    const denied=body.replace('$actual=Normalize-Exe $p.MainModule.FileName',`throw [UnauthorizedAccessException]::new('fixture access denied')`);
    const result=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',denied],{windowsHide:true,encoding:'utf8'});
    assert.notEqual(result.status,0);assert.match(result.stderr,/fixture access denied/);assert.doesNotThrow(()=>process.kill(c.pid,0));
  }finally{
    for(const child of children)if(child.exitCode===null&&child.signalCode===null){const exit=onceWithin(child,'exit');child.kill();await exit;}
  }
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import {importPackage} from './support.mjs';
const {museHostProcessSource, verifiedMuseClose, musePatchDisposition} = await importPackage('lib/muse-compat.js');

const fixture = readFileSync(new URL('./fixtures/muse-1.2.8-desktop-host.js', import.meta.url), 'utf8');

test('only the behavior-tested native shutdown is recognized', () => {
  assert.equal(verifiedMuseClose(fixture), true);
  assert.equal(verifiedMuseClose(fixture.replaceAll('\n', '\r\n')), true);
  assert.equal(verifiedMuseClose(fixture.replace('!this.stopping', 'this.stopping')), false);
  assert.equal(verifiedMuseClose(fixture.replace('!this.shutdownCompleted', 'false')), false);
  assert.equal(verifiedMuseClose(fixture.replace('"--expose-internals",', '"--expose-internals", "--max-http-header-size=65536",')), true);
  assert.equal(museHostProcessSource(fixture + fixture), null);
});

test('native disposition is limited to the correct product and shell entry', () => {
  const entry = path.resolve('virtual/app/lib/main.js');
  let manifest = {name:'muse-med', version:'1.2.8', main:'lib/main.js'};
  let source = fixture;
  const io = {readFileSync(file) {
    if (file.endsWith('package.json')) return JSON.stringify(manifest);
    if (file === entry) return source;
    throw Error('Unexpected read');
  }};
  const files = {'desktop-shell':[entry]};
  for (const id of [83,84]) assert.equal(musePatchDisposition({id}, files, io).reason, 'verified_native_muse_shutdown');
  for (const id of [45,46]) assert.equal(musePatchDisposition({id}, files, io).reason, 'muse_owns_desktop_updates');
  source = fixture.replace('!this.stopping', 'false');
  assert.equal(musePatchDisposition({id:83}, files, io), null);
  manifest = {...manifest, version:'1.2.9'};
  assert.equal(musePatchDisposition({id:83}, files, io), null);
  manifest = {...manifest, name:'dsh-desktop'};
  assert.equal(musePatchDisposition({id:45}, files, io), null);
  manifest = {...manifest, name:'muse-med', main:'different.js'};
  assert.equal(musePatchDisposition({id:45}, files, io), null);
  assert.equal(musePatchDisposition({id:83}, {'desktop-shell':[entry,entry]}, io), null);
  assert.equal(musePatchDisposition({id:40}, files, io), null);
});

function harness(mode='graceful') {
  const failures=[], calls=[];
  const child = new EventEmitter();
  Object.assign(child,{pid:1234,connected:true,exitCode:null,signalCode:null,stdout:new PassThrough(),stderr:new PassThrough()});
  let exits=0;
  function close(code, signal=null) {
    child.exitCode=code;child.signalCode=signal;child.connected=false;child.emit('close',code,signal);
  }
  child.send=(request, done)=>{
    calls.push(request.type);done?.(null);
    if(request.type==='shutdown' && mode!=='forced') setImmediate(()=>{
      if(mode!=='no-ack')child.emit('message',{type:'shutdown-complete'});
      close(0);
    });
  };
  child.kill=(signal)=>{calls.push(signal);setImmediate(()=>close(null,signal));};
  const Native = vm.runInNewContext(fixture + '\nDesktopHostProcess;', {
    Promise,Map,Error,console,setTimeout,clearTimeout,join:path.join,process:{env:{},stdout:new PassThrough(),stderr:new PassThrough()},
    spawn:()=>{setImmediate(()=>child.emit('message',{type:'ready',url:'http://127.0.0.1:1',injections:[]}));return child;},
    desktopNodeEnvironment:()=>({}),isDesktopHostEvent:()=>true,
    parseDouyinDataRequest:()=>undefined,parseDouyinRequest:()=>undefined,
    DesktopHostUncleanExitError:class extends Error{},DesktopHostFatalError:class extends Error{},
    DESKTOP_HOST_SHUTDOWN_DEADLINE_MS:10,QUIT_INSPECTION_DEADLINE_MS:10,
    exitsWithin:async(promise)=>{exits++;if(mode==='forced'&&exits===1)return false;await promise;return true;}
  });
  let cleanups=0;
  const instance=new Native('fixture.exe','fixture-runtime','fixture-profile',undefined,{},e=>failures.push(e),undefined,undefined,undefined,undefined,undefined,()=>{cleanups++;});
  instance.readyPromise.catch(()=>{});
  return {instance,child,close,failures,calls,get cleanups(){return cleanups;}};
}

test('native requested close does not report a crash and cleans up once', async()=>{
  const h=harness();await h.instance.start();await h.instance.stop(true);
  h.child.emit('disconnect');h.child.emit('close',0);await Promise.resolve();
  assert.equal(h.failures.length,0);assert.equal(h.cleanups,1);assert.deepEqual(h.calls,['shutdown']);
});

for(const [name,code,signal] of [['unexpected nonzero',2,null],['unexpected zero',0,null],['unexpected signal',null,'SIGTERM']]) {
  test(name+' exit remains visible',async()=>{
    const h=harness();await h.instance.start();h.close(code,signal);await h.instance.exitPromise;
    assert.equal(h.failures.length,1);assert.match(h.failures[0].message,/host (exited|stopped)/);
  });
}

test('startup error still reports a failure',async()=>{
  const h=harness();const started=h.instance.start();h.child.emit('error',new Error('fixture start failed'));
  await assert.rejects(started,/fixture start failed/);assert.equal(h.failures.length,1);
});

test('missing shutdown acknowledgement rejects update handoff',async()=>{
  const h=harness('no-ack');await h.instance.start();await assert.rejects(h.instance.stop(true),/did not complete graceful/);
  assert.equal(h.failures.length,0);assert.equal(h.cleanups,1);
});

test('forced termination cannot pass as a clean update handoff',async()=>{
  const h=harness('forced');await h.instance.start();await assert.rejects(h.instance.stop(true),/did not complete graceful/);
  assert.equal(h.failures.length,0);assert.equal(h.cleanups,1);assert.ok(h.calls.includes('SIGTERM'));
});

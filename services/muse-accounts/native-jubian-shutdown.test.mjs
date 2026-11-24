/** Gateway shutdown drains native requests before closing shared admission and signing stores. */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {EventEmitter} from 'node:events';
import {installGatewayShutdown} from './gateway.mjs';

test('native admission and the shared fee issuer outlive both HTTP and studio consumers',async t=>{
 const nativeEntered=Promise.withResolvers(),nativeRelease=Promise.withResolvers(),studioEntered=Promise.withResolvers(),studioRelease=Promise.withResolvers();
 const events=[],server=http.createServer((_req,res)=>res.end('fixture')),signals=new EventEmitter();
 server.stopAdmission=()=>events.push('stopped');
 server.closeNativeJubian=async()=>{nativeEntered.resolve();await nativeRelease.promise;events.push('native drained');};
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const controller=installGatewayShutdown({accountServer:server,signals,
  studioRuntime:{close:async()=>{studioEntered.resolve();await studioRelease.promise;events.push('studio drained');}},
  nativeJubianAdmission:{close:()=>{assert.ok(events.includes('native drained'));events.push('native store closed');}},
  productionFees:{close:()=>{assert.ok(events.includes('native drained'));assert.ok(events.includes('studio drained'));events.push('fees closed');}}});
 t.after(async()=>{nativeRelease.resolve();studioRelease.resolve();await controller.close();});
 const first=controller.close();assert.equal(first,controller.close());
 await Promise.all([nativeEntered.promise,studioEntered.promise]);
 assert.deepEqual(events,['stopped']);assert.equal(events.includes('fees closed'),false);
 studioRelease.resolve();nativeRelease.resolve();await first;
 assert.equal(server.listening,false);assert.ok(events.indexOf('native store closed')>events.indexOf('native drained'));
 assert.ok(events.indexOf('fees closed')>events.indexOf('studio drained'));
 assert.equal(signals.listenerCount('SIGTERM'),0);assert.equal(signals.listenerCount('SIGINT'),0);
});

test('failed native drainage retains its stores while closing sockets and signal listeners',async t=>{
 const server=http.createServer(),signals=new EventEmitter();let storesClosed=0;
 server.stopAdmission=()=>{};server.closeNativeJubian=async()=>{throw Error('native drain unavailable');};
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const controller=installGatewayShutdown({accountServer:server,signals,nativeJubianAdmission:{close:()=>storesClosed++},productionFees:{close:()=>storesClosed++}});
 t.after(async()=>{await controller.close().catch(()=>{});});
 await assert.rejects(controller.close(),/native drain unavailable/);
 assert.equal(storesClosed,0);assert.equal(server.listening,false);assert.equal(signals.listenerCount('SIGTERM'),0);
});

/** Exercise isolated-Mac hooks against synthetic byte-addressed memory. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('./enable-target-debug-mac-269602.js', import.meta.url), 'utf8');
function fixture(options = {}) {
  const memory = new Map(), writes = [], hooks = [], events = [], calls = [];
  const base = 0x10000000n, appId = 'wx404dde55fb12df78';
  function put(address, bytes) { for (const [i,v] of bytes.entries()) memory.set(BigInt(address)+BigInt(i),v); }
  function u32(address,value) { const b=Buffer.alloc(4);b.writeInt32LE(value);put(address,b); }
  function pointer(address,value) { const b=Buffer.alloc(8);b.writeBigUInt64LE(BigInt(value));put(address,b); }
  class Pointer {
    constructor(value) { this.value=BigInt(value); }
    add(n) { return new Pointer(this.value+BigInt(n)); }
    and(p) { return new Pointer(this.value&p.value); }
    or(p) { return new Pointer(this.value|p.value); }
    equals(p) { return this.value===p.value; }
    isNull() { return this.value===0n; }
    toUInt32() { return Number(this.value&0xffffffffn); }
    readVolatile(n) { const b=new Uint8Array(n);for(let i=0;i<n;i++){const v=memory.get(this.value+BigInt(i));if(v===undefined)return null;b[i]=v;}return b.buffer; }
    writeVolatile(bytes) { if(options.writeFails)throw Error('synthetic-write-failure');writes.push(this.value);put(this.value,new Uint8Array(bytes)); }
  }
  put(base+0x571ffacn,Buffer.from(options.badEntry?'00'.repeat(16):'ff0306d1f65715a9f44f16a9fd7b17a9','hex'));
  put(base+0x92e7230n,Buffer.from('ff0302d1f44f06a9fd7b07a9fdc30191','hex'));
  pointer(0x1038n,0x2000);const text=Buffer.alloc(24);text.write(options.foreign?'wx0000000000000000':appId);text[23]=18;put(0x2098n,text);
  pointer(0x2610n,0x3000);pointer(0x3008n,0x4000);pointer(0x45d0n,0x5000);pointer(0x5010n,0x6000);
  u32(0x61c8n,options.scene??1256);u32(0x7008n,6);
  const sandbox={rpc:{exports:{}},ptr:v=>new Pointer(v),Process:{platform:'darwin',arch:'arm64',getModuleByName:()=>({path:'/isolated/framework',base:new Pointer(base)})},
    Interceptor:{attach(p,handlers){hooks.push({p,handlers});return {detach(){calls.push('detach');}};},flush(){calls.push('flush');}},
    send:v=>events.push(JSON.parse(JSON.stringify(v))),setTimeout(){}};
  vm.runInNewContext(source.replace('@@CONFIG@@',JSON.stringify({appId,modulePath:'/isolated/framework',expectedScenes:[1256],maxCallbacks:2,maxFilterCallbacks:2,durationMs:60000})),sandbox,{timeout:1000});
  const args=[new Pointer(0x1000),new Pointer(0x1234567800n)];
  return {writes,events,calls,args,launch(){hooks[0].handlers.onEnter(args);},filter(qualified=true){const self={returnAddress:new Pointer(base+(qualified?0x92f1614n:0x99n))};hooks[1].handlers.onEnter.call(self);hooks[1].handlers.onLeave.call(self,new Pointer(0x7000));},dispose(){return sandbox.rpc.exports.dispose();}};
}

test('only an exact target and scene can enable launch and the qualified filter caller',()=>{
  for(const options of [{foreign:true},{scene:1027}]){const h=fixture(options);h.launch();h.filter();assert.deepEqual(h.writes,[]);h.dispose();}
  const h=fixture();h.filter();assert.deepEqual(h.writes,[]);h.launch();assert.equal(h.args[1].value,0x1234567801n);assert.deepEqual(h.writes,[0x61c8n]);
  h.filter(false);assert.equal(h.writes.length,1);h.filter();assert.deepEqual(h.writes,[0x61c8n,0x7008n]);
  const result=h.dispose();assert.equal(result.detached,true);assert.equal(result.flushed,true);assert.deepEqual(h.calls,['detach','detach','flush']);h.filter();assert.equal(h.writes.length,2);
});
test('entry changes reject before hooks and failed writes never enable filtering',()=>{
  assert.throws(()=>fixture({badEntry:true}),/entry-mismatch/);
  const h=fixture({writeFails:true});h.launch();h.filter();assert.deepEqual(h.writes,[]);assert.ok(!h.events.some(v=>v.type==='target-enabled'));h.dispose();
});

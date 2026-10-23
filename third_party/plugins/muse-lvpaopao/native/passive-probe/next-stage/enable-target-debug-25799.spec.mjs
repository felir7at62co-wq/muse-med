/** Exercise the qualified adapter with byte-addressed memory, never a real process. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('./enable-target-debug-25799.js', import.meta.url), 'utf8');
const config = {expectedAppId:'wx404dde55fb12df78',modulePath:'C:\\runtime\\flue.dll',loadStartRva:0x2d5a240,
  expectedEntryBytes:'415741565657534881ec9001000089d34889ce833d3619f70a020f8ffd010000',
  cdpFilterRva:0x385e1d0,expectedFilterEntryBytes:'4157415641554154565755534881ecb8020000440f298424a00200000f29bc24',
  durationMs:60000,maxCallbacks:256,expectedScenes:[1256]};
function run(options={}) {
  const memory=new Map(),writes=[],events=[],timers=[],calls=[];let launch,replacement;
  function put(address,bytes){for(const [i,v] of bytes.entries())memory.set(BigInt(address)+BigInt(i),v);}
  function u32(address,value){const b=Buffer.alloc(4);b.writeInt32LE(value);put(address,b);}
  function ptrAt(address,value){const b=Buffer.alloc(8);b.writeBigUInt64LE(BigInt(value));put(address,b);}
  class Pointer {
    constructor(value){this.value=BigInt(value);}
    add(n){return new Pointer(this.value+BigInt(n));}
    and(p){return new Pointer(this.value&p.value);}
    or(p){return new Pointer(this.value|p.value);}
    readVolatile(n){const b=new Uint8Array(n);for(let i=0;i<n;i++){const v=memory.get(this.value+BigInt(i));if(v===undefined)return null;b[i]=v;}return b.buffer;}
    writeVolatile(b){if(options.writeFails)throw Error('write-failed');writes.push(this.value);put(this.value,new Uint8Array(b));}
  }
  const base=0x10000000n,first=0x2000n,remote=0x4000n;
  put(base+BigInt(config.loadStartRva),Buffer.from(options.badEntry?'00'.repeat(32):config.expectedEntryBytes,'hex'));
  put(base+BigInt(config.cdpFilterRva),Buffer.from(config.expectedFilterEntryBytes,'hex'));
  put(base+0x9f0abb0n,Buffer.from('5657534881ec800100004889ce0f57c00f110148c74110000000004c8b02488b','hex'));
  ptrAt(0x1040,first);ptrAt(first+1512n,0x3000);ptrAt(0x3010,remote);
  for(const offset of [176n,208n])put(first+offset,Buffer.from((options.foreign?'wx0000000000000000':config.expectedAppId)+'\0'));
  u32(remote+456n,options.scene??1256);u32(remote+724n,0);
  for(const address of [remote+416n,first+624n])put(address,new Uint8Array(24));
  const sandbox={rpc:{exports:{}},ptr:v=>new Pointer(v),Process:{platform:'windows',arch:'x64',getModuleByName:()=>({path:config.modulePath,base:new Pointer(base)})},
    Interceptor:{attach(_p,handlers){launch=handlers.onEnter;return {detach(){calls.push('detach');}};},replace(_p,callback){replacement=callback;calls.push('replace');},revert(){calls.push('revert');},flush(){calls.push('flush');}},
    NativeFunction:function(p){return (...args)=>{calls.push(p.value===base+0x9f0abb0n?'cast':'original');return args[1];};},
    NativeCallback:function(fn){return fn;},send:v=>events.push(JSON.parse(JSON.stringify(v))),setTimeout:(f,ms)=>{timers.push({f,ms});return timers.length;},clearTimeout(){}};
  vm.runInNewContext(source.replace('@@CONFIG@@',JSON.stringify(config)),sandbox,{timeout:1000});
  const args=[new Pointer(0x1000),new Pointer(0x1234567802n)];
  return {events,writes,calls,args,enter(){launch(args);},filter(){return replacement(new Pointer(1),new Pointer(2),new Pointer(3));},dispose(){return sandbox.rpc.exports.dispose();},memory};
}

test('entry mismatches and foreign identities cannot rewrite the launch',()=>{
  const bad=run({badEntry:true});assert.equal(bad.events[0].type,'observation-error');assert.deepEqual(bad.writes,[]);
  for(const options of [{foreign:true},{scene:1027}]){const h=run(options);h.enter();assert.deepEqual(h.writes,[]);assert.equal(h.args[1].value,0x1234567802n);assert.ok(!h.calls.includes('replace'));h.dispose();}
});
test('one target launch sets loopback strings and preserves argument high bits; cleanup reverts the filter',()=>{
  const h=run();h.enter();assert.equal(h.args[1].value,0x1234567801n);
  const writes=h.writes.length;h.enter();assert.equal(h.writes.length,writes);
  assert.equal(h.filter().value,2n);assert.ok(h.calls.includes('cast'));
  const result=h.dispose();assert.equal(result.sceneWrites,1);assert.equal(result.argumentWrites,1);assert.equal(result.writeOutcomeUnknown,false);assert.ok(h.calls.includes('revert'));
  h.filter();assert.equal(h.calls.at(-1),'original');
});
test('a failed write reports uncertain outcome and releases installed hooks',()=>{
  const h=run({writeFails:true});h.enter();const result=h.dispose();assert.equal(result.writeOutcomeUnknown,true);assert.equal(result.detached,true);assert.ok(h.calls.includes('revert'));assert.ok(!h.events.some(v=>v.type==='target-enabled'));
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {createModelKeyPool,resolveModelKeyPoolPolicy} from './model-key-pool.mjs';

const policy={concurrency:1,maxQueued:10,waitMs:1000};
test('two account keys admit two requests and reuse only a released slot',async t=>{
 const pool=createModelKeyPool({keys:()=>['one','two'],...policy});t.after(()=>pool.close());
 const a=await pool.acquire(),b=await pool.acquire();assert.notEqual(a.key,b.key);
 let admitted=false;const waiting=pool.acquire().then(slot=>{admitted=true;return slot;});
 await Promise.resolve();assert.equal(admitted,false);
 a.release();const c=await waiting;assert.equal(c.key,a.key);
 a.release();let secondAdmitted=false;const next=pool.acquire().then(slot=>{secondAdmitted=true;return slot;});
 await Promise.resolve();assert.equal(secondAdmitted,false);
 b.release();const d=await next;assert.equal(d.key,b.key);c.release();d.release();
});

test('one account key admits twenty streams then queues instead of dispatching twice',async t=>{
 const pool=createModelKeyPool({keys:()=>['account-one'],...policy,concurrency:20});t.after(()=>pool.close());
 const slots=await Promise.all(Array.from({length:20},()=>pool.acquire()));
 let admitted=false;const pending=pool.acquire().then(slot=>{admitted=true;return slot;});
 await Promise.resolve();assert.equal(admitted,false);slots[9].release();const next=await pending;
 assert.equal(next.key,'account-one');for(const slot of slots)slot.release();next.release();
});

test('queued cancellation and overflow never take a supplier slot',async t=>{
 const pool=createModelKeyPool({keys:()=>['one'],...policy,maxQueued:1});t.after(()=>pool.close());
 const first=await pool.acquire(),controller=new AbortController();
 const cancelled=assert.rejects(pool.acquire(controller.signal),/cancelled/);
 await assert.rejects(pool.acquire(),/queue is full/);controller.abort(Error('cancelled'));await cancelled;
 const next=pool.acquire();first.release();(await next).release();
 const stopped=new AbortController();stopped.abort(Error('already cancelled'));
 await assert.rejects(pool.acquire(stopped.signal),/already cancelled/);
});

test('shutdown rejects queued requests and remains closed after active streams release',async()=>{
 const pool=createModelKeyPool({keys:()=>['one'],...policy}),slot=await pool.acquire();
 const pending=assert.rejects(pool.acquire(),/closed/);pool.close();await pending;
 slot.release();await assert.rejects(pool.acquire(),/closed/);
});

test('waiting timeout removes a request and does not issue a late lease',async t=>{
 const pool=createModelKeyPool({keys:()=>['one'],...policy,waitMs:15});t.after(()=>pool.close());
 const first=await pool.acquire();await assert.rejects(pool.acquire(),/timed out/);first.release();
 const next=await pool.acquire();next.release();await delay(20);
});

test('waiting requests use the currently configured distinct credentials',async t=>{
 let keys=['one','one'];const pool=createModelKeyPool({keys:()=>keys,...policy});t.after(()=>pool.close());
 const slot=await pool.acquire();const waiting=pool.acquire();keys=['two'];slot.release();
 const next=await waiting;assert.equal(next.key,'two');next.release();
});

test('new credential capacity serves queued requests before later arrivals',async t=>{
 let keys=['one'];const pool=createModelKeyPool({keys:()=>keys,...policy});t.after(()=>pool.close());
 const first=await pool.acquire(),earlier=pool.acquire();keys=['one','two'];
 let laterAdmitted=false;const later=pool.acquire().then(slot=>{laterAdmitted=true;return slot;});
 const queued=await earlier;assert.equal(queued.key,'two');assert.equal(laterAdmitted,false);
 first.release();const last=await later;assert.equal(last.key,'one');queued.release();last.release();
});

test('deployment policy validates provider capacity and bounded queue configuration',()=>{
 assert.equal(resolveModelKeyPoolPolicy().concurrency,20);
 assert.deepEqual(resolveModelKeyPoolPolicy({MUSE_ZHIPU_KEY_CONCURRENCY:'7',MUSE_ZHIPU_QUEUE_LIMIT:'0',MUSE_ZHIPU_QUEUE_TIMEOUT_MS:'5'}),{concurrency:7,maxQueued:0,waitMs:5});
 for(const [key,values]of Object.entries({MUSE_ZHIPU_KEY_CONCURRENCY:['0','-1','1.5','secret'],MUSE_ZHIPU_QUEUE_LIMIT:['-1','100001'],MUSE_ZHIPU_QUEUE_TIMEOUT_MS:['0','2147483648','']})){
  for(const value of values)assert.throws(()=>resolveModelKeyPoolPolicy({[key]:value}),new RegExp(key));
 }
});

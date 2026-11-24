/** Bounded admission for independently provisioned supplier-account credentials. */
import {createHash} from 'node:crypto';
const fingerprint=key=>createHash('sha256').update(key).digest('hex');
/** Admission stopped before a supplier request was dispatched. */
export class ModelKeyPoolError extends Error {}

/** Validate operator-owned concurrency and waiting limits before accepting requests.
 * @param {object} env Deployment environment values.
 * @returns {object} Positive concurrency, nonnegative waiting capacity and timeout milliseconds.
 */
export function resolveModelKeyPoolPolicy(env={}){
 const fields=[['concurrency','MUSE_ZHIPU_KEY_CONCURRENCY',20,1,100000],
  ['maxQueued','MUSE_ZHIPU_QUEUE_LIMIT',1000,0,100000],
  ['waitMs','MUSE_ZHIPU_QUEUE_TIMEOUT_MS',120000,1,2147483647]];
 return Object.fromEntries(fields.map(([name,key,fallback,min,max])=>{
  const raw=env[key],value=raw===undefined?fallback:Number(raw);
  if(raw!==undefined&&!/^\d+$/.test(raw)||!Number.isSafeInteger(value)||value<min||value>max)throw Error('Invalid '+key);
  return [name,value];
 }));
}

/** Count whole active streams per credential and wait fairly for a free slot.
 * @param {object} options Current private keys and validated deployment limits.
 * @returns {object} Cancellable acquisition, durable fingerprint reservation restoration, and queued-request shutdown.
 */
export function createModelKeyPool({keys,...limits}){
 const {concurrency,maxQueued,waitMs}=resolveModelKeyPoolPolicy({MUSE_ZHIPU_KEY_CONCURRENCY:limits.concurrency,
  MUSE_ZHIPU_QUEUE_LIMIT:limits.maxQueued,MUSE_ZHIPU_QUEUE_TIMEOUT_MS:limits.waitMs});
 const active=new Map(),queue=[];let cursor=0,closed=false;
 function lease(){
  const available=[...new Set(keys())];if(!available.length)return;
  let selected,lowest=concurrency;
  for(let i=0;i<available.length;i++){
   const index=(cursor+i)%available.length,key=available[index],used=active.get(fingerprint(key))??0;
   if(used<lowest){selected={key,index};lowest=used;}
  }
  if(!selected)return;
  cursor=(selected.index+1)%available.length;
  const key=selected.key,hash=fingerprint(key);active.set(hash,lowest+1);let released=false;
  return {key,release(){
   if(released)return;released=true;
   const count=active.get(hash)-1;if(count)active.set(hash,count);else active.delete(hash);
   drain();
  }};
 }
 function drain(){
  while(!closed&&queue.length){const slot=lease();if(!slot)return;const waiter=queue.shift();waiter.cleanup();waiter.resolve(slot);}
 }
 return {
  restore(hash){
   if(!/^[a-f0-9]{64}$/.test(hash)||closed)throw new ModelKeyPoolError('Invalid restored model reservation');
   active.set(hash,(active.get(hash)??0)+1);let released=false;
   return ()=>{if(released)return;released=true;const count=active.get(hash)-1;if(count)active.set(hash,count);else active.delete(hash);drain();};
  },
  acquire(signal){
   if(closed)return Promise.reject(new ModelKeyPoolError('Model key pool is closed'));
   if(signal?.aborted)return Promise.reject(signal.reason);
   drain();
   const immediate=queue.length?undefined:lease();if(immediate)return Promise.resolve(immediate);
   if(queue.length>=maxQueued)return Promise.reject(new ModelKeyPoolError('Model request waiting queue is full'));
   return new Promise((resolve,reject)=>{
    const remove=()=>{const index=queue.indexOf(waiter);if(index!==-1)queue.splice(index,1);waiter.cleanup();};
    const abort=()=>{remove();reject(signal.reason);};
    const timer=setTimeout(()=>{remove();reject(new ModelKeyPoolError('Model request waiting timed out'));},waitMs);
    const waiter={resolve,reject,cleanup(){clearTimeout(timer);signal?.removeEventListener('abort',abort);}};
    queue.push(waiter);signal?.addEventListener('abort',abort,{once:true});
   });
  },
  close(){closed=true;for(const waiter of queue.splice(0)){waiter.cleanup();waiter.reject(new ModelKeyPoolError('Model key pool is closed'));}},
 };
}

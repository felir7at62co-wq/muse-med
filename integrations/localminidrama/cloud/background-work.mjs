/** Track asynchronous work descending from studio-owned setImmediate jobs. */
import {AsyncLocalStorage,createHook} from 'node:async_hooks';

/** Retain background work through provider calls even after a task row is marked cancelled.
 * @returns {object} A conservative outstanding-resource count and owned cleanup.
 */
export function trackBackgroundWork(){
 const scope=new AsyncLocalStorage(),tracked=new Set(),original=globalThis.setImmediate;let scheduling=false;
 const hook=createHook({init(id,type,trigger){if((type==='PROMISE'||type==='Immediate')&&(scheduling||scope.getStore()===true||tracked.has(trigger)))tracked.add(id);},destroy(id){tracked.delete(id);},promiseResolve(id){tracked.delete(id);}});
 hook.enable();
 function immediate(callback,...args){scheduling=true;try{return original(function(...values){return scope.run(true,()=>Reflect.apply(callback,this,values));},...args);}finally{scheduling=false;}}
 globalThis.setImmediate=immediate;
 return {count:()=>tracked.size,close(){if(globalThis.setImmediate===immediate)globalThis.setImmediate=original;hook.disable();scope.disable();tracked.clear();}};
}

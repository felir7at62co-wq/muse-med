/* Exact isolated arm64 runtime; target identity is checked before any writes. */
(function(){
'use strict';
const config=@@CONFIG@@;
const m=Process.getModuleByName('WeChatAppEx Framework');
if(Process.platform!=='darwin'||Process.arch!=='arm64'||m.path!==config.modulePath)throw Error('module-mismatch');
function read(p,n){const b=p.readVolatile(n);if(b===null||b.byteLength!==n)throw Error('unreadable');return new Uint8Array(b);}
function pointer(p){return ptr('0x'+new DataView(read(p,8).buffer).getBigUint64(0,true).toString(16));}
function integer(p){return new DataView(read(p,4).buffer).getInt32(0,true);}
function text(p){const b=read(p,24);const long=b[23]>=128;const n=long?Number(new DataView(b.buffer).getBigUint64(8,true)):b[23];if(n!==18)return null;return String.fromCharCode(...(long?read(pointer(p),n):b).slice(0,n));}
function pin(rva,expected){const p=m.base.add(rva);if(Array.from(read(p,16)).map(v=>v.toString(16).padStart(2,'0')).join('')!==expected)throw Error('entry-mismatch');return p;}
function writeInt(p,v){const b=new ArrayBuffer(4);new DataView(b).setInt32(0,v,true);p.writeVolatile(b);if(integer(p)!==v)throw Error('write-unconfirmed');}
const load=pin(0x571ffac,'ff0306d1f65715a9f44f16a9fd7b17a9');
const filter=pin(0x92e7230,'ff0302d1f44f06a9fd7b07a9fdc30191');
let enabled=false,disposed=false,callbacks=0,filterCallbacks=0,filterPatches=0;
const listeners=[];
listeners.push(Interceptor.attach(load,{onEnter(args){
 if(disposed||++callbacks>config.maxCallbacks)return;
 try{
  const first=pointer(args[0].add(56));if(text(first.add(152))!==config.appId)return;
  const launch=pointer(pointer(first.add(1552)).add(8));const remote=pointer(pointer(launch.add(1488)).add(16));
  const field=remote.add(456),scene=integer(field);
  send({type:'target-observed',scene,debugLowByte:args[1].and(ptr(255)).toUInt32()});
  if(!config.expectedScenes.includes(scene)){send({type:'scene-rejected',scene});return;}
  writeInt(field,1101);args[1]=args[1].and(ptr('0xffffffffffffff00')).or(ptr(1));enabled=true;
  send({type:'target-enabled',scene,guardsVerified:true});
 }catch(error){send({type:'observation-error',stage:'launch'});}
}}));
listeners.push(Interceptor.attach(filter,{onEnter(){this.fromFilter=this.returnAddress.equals(m.base.add(0x92f1614));},onLeave(retval){
 if(!this.fromFilter||!enabled||disposed||retval.isNull())return;
 if(++filterCallbacks>config.maxFilterCallbacks){enabled=false;send({type:'observation-error',stage:'filter-budget'});return;}
 try{const type=integer(retval.add(8));if(type===6){writeInt(retval.add(8),0);filterPatches++;if(filterPatches===1||filterPatches%128===0)send({type:'cdp-filter-patched',count:filterPatches});}}
 catch(error){send({type:'filter-read-rejected'});}
}}));
function dispose(){if(!disposed){disposed=true;enabled=false;for(const l of listeners)l.detach();Interceptor.flush();}return{callbacks,filterCallbacks,filterPatches,detached:true,flushed:true};}
rpc.exports={dispose};
setTimeout(()=>{dispose();send({type:'disposed'});},config.durationMs);
send({type:'ready',active:true,guardsVerified:true});
})();

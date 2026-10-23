/* Exact-build WMPF 25799 target launch adapter; no generic process scanning. */
(function () {
  'use strict';
  const config = @@CONFIG@@;
  const state={active:false,claimed:false,enabled:false,disposed:false,listener:null,replaced:false,
    callbacks:0,rejected:0,filterCallbacks:0,filterPatches:0,sceneWrites:0,argumentWrites:0,
    sceneWriteAttempted:false,argumentWriteAttempted:false,filterWriteAttempts:0,
    writeOutcomeUnknown:false,detached:true,flushed:true,summary:null};
  const normalize=p=>p.replace(/\//g,'\\').toLowerCase();
  let timer=null,filterAddress=null,originalFilter=null,cast=null,replacement=null;
  function dispose(reason) {
    if(state.disposed)return state.summary;
    state.disposed=true;state.active=false;state.enabled=false;
    if(timer!==null){clearTimeout(timer);timer=null;}
    try{if(state.listener){state.listener.detach();state.listener=null;}if(state.replaced){Interceptor.revert(filterAddress);state.replaced=false;}}catch(e){state.detached=false;}
    try{Interceptor.flush();}catch(e){state.flushed=false;}
    state.summary={type:'disposed',reason,callbacks:state.callbacks,rejected:state.rejected,
      eligibleLaunches:state.claimed?1:0,sceneWriteAttempted:state.sceneWriteAttempted,
      argumentWriteAttempted:state.argumentWriteAttempted,sceneWrites:state.sceneWrites,
      argumentWrites:state.argumentWrites,filterCallbacks:state.filterCallbacks,
      filterWriteAttempts:state.filterWriteAttempts,filterPatches:state.filterPatches,
      writeOutcomeUnknown:state.writeOutcomeUnknown,detached:state.detached,flushed:state.flushed};
    send(state.summary);return state.summary;
  }
  rpc.exports={dispose:()=>dispose('requested')};
  function fail(code){send({type:'observation-error',code});dispose('failed');}
  function read(p,n){const b=p.readVolatile(n);if(b===null||b.byteLength!==n)throw Error('unreadable');return new Uint8Array(b);}
  function pointer(p){return ptr('0x'+new DataView(read(p,8).buffer).getBigUint64(0,true).toString(16));}
  function integer(p){return new DataView(read(p,4).buffer).getInt32(0,true);}
  function writeInt(p,n){const b=new ArrayBuffer(4);new DataView(b).setInt32(0,n,true);p.writeVolatile(b);}
  function hex(p){return Array.from(read(p,32)).map(x=>x.toString(16).padStart(2,'0')).join('');}
  function identity(p,offset){const b=read(p.add(offset),19);return b[18]===0&&Array.from(config.expectedAppId).every((c,i)=>b[i]===c.charCodeAt(0));}
  function stringInfo(p){const b=read(p,24),v=new DataView(b.buffer);return b[23]<128?{short:true,length:b[23],p}:{short:false,length:Number(v.getBigUint64(8,true)),capacity:v.getBigUint64(16,true)&0x7fffffffffffffffn,p:pointer(p)};}
  function setLoopback(p,info){
    const url='ws://127.0.0.1:9421',b=new Uint8Array(info.short?24:url.length+1);
    Array.from(url).forEach((c,i)=>b[i]=c.charCodeAt(0));
    if(info.short){b[23]=url.length;p.writeVolatile(b.buffer);}
    else{if(info.capacity<BigInt(url.length+1))throw Error('capacity');info.p.writeVolatile(b.buffer);const n=new ArrayBuffer(8);new DataView(n).setBigUint64(0,BigInt(url.length),true);p.add(8).writeVolatile(n);}
  }
  const keys=['expectedAppId','modulePath','loadStartRva','expectedEntryBytes','cdpFilterRva','expectedFilterEntryBytes','durationMs','maxCallbacks','expectedScenes'];
  if(!config||Object.keys(config).length!==keys.length||!keys.every(k=>Object.hasOwn(config,k))||
    !/^wx[0-9a-f]{16}$/.test(config.expectedAppId)||config.loadStartRva!==0x2d5a240||config.cdpFilterRva!==0x385e1d0||
    !Number.isInteger(config.durationMs)||config.durationMs<60000||config.durationMs>14400000||
    !Number.isInteger(config.maxCallbacks)||config.maxCallbacks<1||config.maxCallbacks>16384||
    !Array.isArray(config.expectedScenes)||!config.expectedScenes.length||config.expectedScenes.some(x=>!Number.isInteger(x)||x<1000||x>2000)) {fail('invalid-config');return;}
  let m;
  try{
    m=Process.getModuleByName('flue.dll');
    if(Process.platform!=='windows'||Process.arch!=='x64'||normalize(m.path)!==normalize(config.modulePath))throw Error('module');
    if(hex(m.base.add(config.loadStartRva))!==config.expectedEntryBytes||hex(m.base.add(config.cdpFilterRva))!==config.expectedFilterEntryBytes||
      hex(m.base.add(0x9f0abb0))!=='5657534881ec800100004889ce0f57c00f110148c74110000000004c8b02488b')throw Error('entry');
    filterAddress=m.base.add(config.cdpFilterRva);
    originalFilter=new NativeFunction(filterAddress,'pointer',['pointer','pointer','pointer'],{exceptions:'propagate'});
    cast=new NativeFunction(m.base.add(0x9f0abb0),'pointer',['pointer','pointer'],{exceptions:'propagate'});
    replacement=new NativeCallback(function(thiz,out,input){
      if(!state.active||!state.enabled||state.disposed||state.callbacks>=config.maxCallbacks)return originalFilter(thiz,out,input);
      state.callbacks++;state.filterCallbacks++;cast(out,input);state.filterPatches++;return out;
    },'pointer',['pointer','pointer','pointer']);
    state.listener=Interceptor.attach(m.base.add(config.loadStartRva),{onEnter(args){
      if(!state.active||state.claimed||state.disposed)return;
      if(++state.callbacks>config.maxCallbacks){dispose('limit');return;}
      let first,remote,scene,url,info,seed;
      try{
        first=pointer(args[0].add(64));
        if(!identity(first,176)||!identity(first,208)){state.rejected++;return;}
        remote=pointer(pointer(first.add(1512)).add(16));scene=integer(remote.add(456));
        if(!config.expectedScenes.includes(scene)){state.rejected++;return;}
        if(integer(remote.add(724))!==0)throw Error('existing-debug-session');
        seed=stringInfo(remote.add(416));
        url=first.add(624);info=stringInfo(url);
        if(seed.length<0||seed.length>4096||(!seed.short&&seed.capacity<20n))throw Error('debug-seed');
        if(info.length<0||info.length>4096||(!info.short&&info.capacity<20n))throw Error('url');
      }catch(e){fail(['existing-debug-session','debug-seed','url'].includes(e.message)?'launch-'+e.message:'launch-predicate-unreadable');return;}
      state.claimed=true;
      try{
        Interceptor.replace(filterAddress,replacement);state.replaced=true;
        state.sceneWriteAttempted=true;writeInt(remote.add(456),1101);state.sceneWrites++;
        setLoopback(url,info);
        if(seed.length===0)setLoopback(remote.add(416),seed);
        writeInt(remote.add(724),1);
        state.argumentWriteAttempted=true;args[1]=args[1].and(ptr('0xffffffffffffff00')).or(ptr(1));state.argumentWrites++;
        state.enabled=true;
        send({type:'target-enabled',sceneBefore:scene,sceneAfter:1101,debugLowByte:1,oneShot:true});
        setTimeout(function(){if(state.listener){state.listener.detach();state.listener=null;Interceptor.flush();send({type:'launch-hook-disabled',detached:true,flushed:true});}},0);
      }catch(e){state.writeOutcomeUnknown=true;fail('launch-write-failed');}
    }});
    timer=setTimeout(()=>dispose('watchdog'),config.durationMs);state.active=true;
    send({type:'ready',active:true,guardsVerified:true,durationMs:config.durationMs,maxCallbacks:config.maxCallbacks});
  }catch(e){fail('attach-failed');}
})();

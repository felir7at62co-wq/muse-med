// Loaded before the native client. Context is immutable and session-bound.
(()=>{
 const {context,label,expiry}=document.currentScript.dataset;
 if(!/^[a-f0-9]{64}$/.test(context))throw Error('Invalid administrator context');
 const attach=value=>{const url=new URL(value,location.href);if(url.host===location.host&&['http:','https:','ws:','wss:'].includes(url.protocol)&&!/^\/(?:admin|account|login|logout|feedback)(?:\/|$)/.test(url.pathname)){const search=url.search.replace(/([?&])muse_admin=[a-f0-9]{64}(?=&|$)/g,(_m,sep)=>sep==='?'?'?':'').replace('?&','?').replace(/\?$/,'');url.search=search+(search?'&':'?')+'muse_admin='+context;}return url.href;};
 const nativeFetch=window.fetch.bind(window);window.fetch=(input,options)=>{if(input instanceof Request)return nativeFetch(new Request(attach(input.url),input),options);return nativeFetch(attach(input),options);};
 const nativeOpen=XMLHttpRequest.prototype.open;XMLHttpRequest.prototype.open=function(method,url,...args){return nativeOpen.call(this,method,attach(url),...args);};
 const NativeSocket=window.WebSocket;window.WebSocket=class extends NativeSocket{constructor(url,protocols){super(attach(url),protocols);}};
 const NativeEvents=window.EventSource;window.EventSource=class extends NativeEvents{constructor(url,options){super(attach(url),options);}};
 for(const [type,key]of [[HTMLScriptElement,'src'],[HTMLLinkElement,'href'],[HTMLImageElement,'src']]){const descriptor=Object.getOwnPropertyDescriptor(type.prototype,key);Object.defineProperty(type.prototype,key,{...descriptor,set(value){descriptor.set.call(this,attach(value));}});}
 const setAttribute=Element.prototype.setAttribute;Element.prototype.setAttribute=function(key,value){if((key==='src'||key==='href')&&['SCRIPT','LINK','IMG'].includes(this.tagName))value=attach(value);return setAttribute.call(this,key,value);};
 for(const method of ['pushState','replaceState']){const original=history[method].bind(history);history[method]=(state,title,url)=>original(state,title,url?attach(url):url);}
 document.addEventListener('click',event=>{const link=event.target.closest?.('a[href]');if(link&&new URL(link.href).origin===location.origin&&!/^\/(?:admin|account|login|logout|feedback)(?:\/|$)/.test(new URL(link.href).pathname))link.href=attach(link.href);},true);
 document.addEventListener('DOMContentLoaded',()=>{
  const banner=document.createElement('div');banner.id='muse-admin-context';banner.style.cssText='position:fixed;z-index:2147483647;top:0;left:50%;transform:translateX(-50%);max-width:75vw;padding:5px 14px;background:#242b20;color:white;border-radius:0 0 9px 9px;font:12px system-ui;box-shadow:0 2px 8px #0002;';
  const text=document.createElement('span');text.textContent='管理员完整版 · '+label+' · ';const link=document.createElement('a');link.href='/admin/control';link.textContent='管理中心';link.style.color='inherit';banner.append(text,link);document.body.append(banner);
 });
 setTimeout(()=>{location.href='/admin/control';},Math.max(1,Number(expiry)-Date.now()));
})();

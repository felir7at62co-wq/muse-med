/** Audited-origin, DNS-pinned networking for the cloud companion process. */
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import {lookup as dnsLookup} from 'node:dns';
import {syncBuiltinESMExports} from 'node:module';
import {StudioError} from './security.mjs';

const rejected=()=>new StudioError('studio_outbound_rejected',400);
const port=url=>Number(url.port||(url.protocol==='https:'?443:80));

/** Decide exact origins and pin every connection to a fully checked DNS answer set.
 * @param {object} config Audited origins and explicit local exceptions.
 * @param {object} dependencies DNS resolver and maintained IP-range classifier.
 * @returns {object} URL validation and per-origin socket lookup operations.
 */
export function createOutboundPolicy({outboundOrigins,trustedLocalOrigins},{lookup=dnsLookup,isPublicAddress}){
 const allowed=new Set(outboundOrigins),trusted=new Set(trustedLocalOrigins),urls=outboundOrigins.map(value=>new URL(value));
 function target(value){let url;try{url=new URL(value);}catch(error){throw rejected();}const host=url.hostname.replace(/^\[|\]$/g,'');if(url.username||url.password||!allowed.has(url.origin)||net.isIP(host)&&!trusted.has(url.origin)&&!isPublicAddress(host))throw rejected();return url;}
 function pinned(url){return (hostname,options,callback)=>{
  if(hostname.replace(/^\[|\]$/g,'')!==url.hostname.replace(/^\[|\]$/g,'')){callback(rejected());return;}
  const accept=records=>{if(!records.length||records.some(record=>!net.isIP(record.address)||!trusted.has(url.origin)&&!isPublicAddress(record.address))){callback(rejected());return;}
   const record=records.find(value=>value.family===4)??records[0];if(options?.all)callback(null,[record]);else callback(null,record.address,record.family);};
  const host=hostname.replace(/^\[|\]$/g,'');if(net.isIP(host)){accept([{address:host,family:net.isIP(host)}]);return;}
  lookup(host,{all:true,verbatim:true},(error,records)=>{if(error){callback(rejected());return;}accept(records);});
 };}
 for(const url of urls)target(url);
 return {target,pinned,
  socket(hostname,number){const url=urls.find(value=>value.hostname.replace(/^\[|\]$/g,'')===String(hostname).replace(/^\[|\]$/g,'')&&port(value)===Number(number));if(!url)throw rejected();target(url);return pinned(url);},
 };
}

/** Install worker-owned HTTP, HTTPS, raw socket and fetch guards before loading backend providers.
 * @param {object} config Audited origin policy.
 * @param {Function} require Dependency resolver rooted at the pinned backend package.
 * @returns {object} URL policy and asynchronous cleanup after backend work finishes.
 */
export function installOutboundGuard(config,require){
 if(!Number.isSafeInteger(config.maxOutboundRequests)||config.maxOutboundRequests<1)throw new Error('Invalid studio outbound concurrency');
 const ipaddr=require('ipaddr.js'),undici=require('undici');
 const policy=createOutboundPolicy(config,{isPublicAddress:address=>{try{return ipaddr.process(address).range()==='unicast';}catch(error){return false;}}});
 const original={httpRequest:http.request,httpGet:http.get,httpsRequest:https.request,httpsGet:https.get,socketConnect:net.Socket.prototype.connect,fetch:globalThis.fetch,dispatcher:undici.getGlobalDispatcher()},agents=new Map();
 let active=0;function acquire(){if(active>=config.maxOutboundRequests)throw new StudioError('studio_outbound_capacity',429);active++;let released=false;return ()=>{if(!released){released=true;active--;}};}
 function socketConnect(...args){
  if(Array.isArray(args[0]))args=args[0];let options,callback;
  if(args[0]&&typeof args[0]==='object'){options={...args[0]};callback=args[1];}
  else if(typeof args[0]==='number'||typeof args[0]==='string'&&/^\d+$/.test(args[0])){options={port:Number(args[0]),host:typeof args[1]==='string'?args[1]:'localhost'};callback=typeof args[1]==='function'?args[1]:args[2];}
  else throw rejected();
  if(options.path||options.socketPath||options.fd!==undefined||!options.port)throw rejected();
  const host=options.hostname??options.host??'localhost';options.lookup=policy.socket(host,options.port);delete options.createConnection;return Reflect.apply(original.socketConnect,this,[options,...typeof callback==='function'?[callback]:[]]);
 }
 net.Socket.prototype.connect=socketConnect;
 function request(protocol,args){
  let url,options,callback;
  if(typeof args[0]==='string'||args[0] instanceof URL){url=policy.target(args[0]);options=args[1]&&typeof args[1]==='object'?{...args[1]}:{};callback=typeof args[1]==='function'?args[1]:args[2];}
  else{options={...args[0]};callback=args[1];const host=options.hostname??options.host??'localhost';url=policy.target(`${protocol}//${host}${options.port?':'+options.port:''}`);}
  if(options.socketPath||options.createConnection||options.socket)throw rejected();
  const actual=options.hostname??options.host;if(actual&&String(actual)!==url.hostname||options.port&&Number(options.port)!==port(url))throw rejected();
  const key=protocol+url.origin;if(!agents.has(key))agents.set(key,protocol==='https:'?new https.Agent({keepAlive:true}):new http.Agent({keepAlive:true}));
  options={...options,agent:agents.get(key),lookup:policy.pinned(url),hostname:url.hostname,host:url.hostname,port:port(url),rejectUnauthorized:true,headers:{...options.headers,host:url.host}};delete options.createConnection;
  const release=acquire();let result;try{result=Reflect.apply(protocol==='https:'?original.httpsRequest:original.httpRequest,protocol==='https:'?https:http,[url,options,...typeof callback==='function'?[callback]:[]]);}catch(error){release();throw error;}result.once('close',release);return result;
 }
 http.request=function(...args){return request('http:',args);};https.request=function(...args){return request('https:',args);};
 http.get=function(...args){const result=http.request(...args);result.end();return result;};https.get=function(...args){const result=https.request(...args);result.end();return result;};
 const fetchAgents=new Map(),dispatcher={dispatch(options,handler){let url,release;try{url=policy.target(options.origin);release=acquire();}catch(error){queueMicrotask(()=>handler.onError(error));return false;}
   if(!fetchAgents.has(url.origin))fetchAgents.set(url.origin,new undici.Agent({connect:{lookup:policy.pinned(url),rejectUnauthorized:true}}));
   const guarded=new Proxy(handler,{get(target,key){const value=Reflect.get(target,key,target);if(typeof value!=='function')return value;return (...args)=>{if(key==='onComplete'||key==='onError'||key==='onUpgrade'||key==='onResponseEnd'||key==='onResponseError')release();return Reflect.apply(value,target,args);};}});
   try{return fetchAgents.get(url.origin).dispatch(options,guarded);}catch(error){release();throw error;}
  },async close(){await Promise.all([...fetchAgents.values()].map(agent=>agent.close()));},async destroy(){await Promise.all([...fetchAgents.values()].map(agent=>agent.destroy()));}};
 undici.setGlobalDispatcher(dispatcher);
 globalThis.fetch=(input,init={})=>{policy.target(typeof input==='string'||input instanceof URL?input:input.url);return undici.fetch(input,{...init,dispatcher}).catch(error=>{if(error.cause instanceof StudioError)throw error.cause;throw error;});};syncBuiltinESMExports();
 return {policy,async close(){await dispatcher.destroy();for(const agent of agents.values())agent.destroy();http.request=original.httpRequest;http.get=original.httpGet;https.request=original.httpsRequest;https.get=original.httpsGet;net.Socket.prototype.connect=original.socketConnect;globalThis.fetch=original.fetch;undici.setGlobalDispatcher(original.dispatcher);syncBuiltinESMExports();}};
}

/** Account-scoped transport for the pinned outbound Muse desktop bridge. */
import { randomUUID } from 'node:crypto';
import { WebSocket, WebSocketServer } from 'ws';

const hiddenHeaders = new Set(['cookie','authorization','host','origin','connection','upgrade','keep-alive','proxy-authenticate','proxy-authorization','te','trailer','transfer-encoding','set-cookie']);
function publicHeaders(headers) {
 const result={};
 for(const [name,value] of Object.entries(headers??{})) {
  const key=name.toLowerCase();
  if(!hiddenHeaders.has(key)&&!key.startsWith('x-muse-')&&!key.startsWith('x-forwarded-')&&!['x-real-ip','x-account-id','forwarded'].includes(key))result[key]=value;
 }
 return result;
}
function send(ws,value) {
 if(ws.readyState!==WebSocket.OPEN)return Promise.reject(Error('Desktop disconnected'));
 return new Promise((resolve,reject)=>ws.send(JSON.stringify(value),error=>error?reject(error):resolve()));
}
function decodeChunk(message,maximum) {
 if(typeof message.data!=='string'||message.data.length>Math.ceil(maximum/3)*4||! /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(message.data))throw Error('Invalid chunk');
 const bytes=Buffer.from(message.data,'base64');
 if(bytes.length>maximum)throw Error('Oversized chunk');
 return bytes;
}

/**
 * Create a relay without listening on another port. Every desktop and browser is authenticated by the gateway.
 * @param {object} options Account store, session validity and bounded transfer settings.
 * @returns {object} Upgrade, forwarding and revocation operations owned by the gateway lifetime.
 */
export function createDesktopRelay({store,validSession,publicOrigin,now=Date.now,chunkBytes=32768,ackTimeoutMs=15000,maxRequests=64,maxControlBytes=262144,maxUploadBytes=1073741824,heartbeatIntervalMs=15000,heartbeatTimeoutMs=30000}) {
 for(const [name,value,min,max]of [['chunkBytes',chunkBytes,1024,32768],['ackTimeoutMs',ackTimeoutMs,100,120000],['maxRequests',maxRequests,1,1024],['maxControlBytes',maxControlBytes,65536,1048576],['maxUploadBytes',maxUploadBytes,1,1099511627776],['heartbeatIntervalMs',heartbeatIntervalMs,100,120000],['heartbeatTimeoutMs',heartbeatTimeoutMs,100,120000]])if(!Number.isSafeInteger(value)||value<min||value>max)throw Error('Invalid desktop '+name);
 const wss=new WebSocketServer({noServer:true,maxPayload:maxControlBytes,perMessageDeflate:false});
 const desktops=new Map();
 let closed=false;
 function fail(state,code=503) {
  if(state.done)return;state.done=true;
  state.rejectAck?.(Error('Desktop request closed'));clearTimeout(state.expiry);
  state.desktop.requests.delete(state.id);
  if(state.kind==='http') {
   if(!state.res.headersSent&&!state.res.destroyed)state.res.writeHead(code,{'content-type':'application/json','cache-control':'no-store'}).end(JSON.stringify({error:'desktop-unavailable'}));
   else state.res.destroy();
  } else state.socket.destroy();
  if(state.desktop.ws.readyState===WebSocket.OPEN)void send(state.desktop.ws,{type:state.kind==='http'?'request-cancel':'ws-close',...(state.kind==='http'?{id:state.id}:{wsId:state.id})}).catch(()=>{});
 }
 function disconnect(desktop) {
  for(const state of [...desktop.requests.values()])fail(state);
  clearTimeout(desktop.expiry);clearTimeout(desktop.handshake);clearInterval(desktop.heartbeat);clearTimeout(desktop.pongDeadline);
  if(desktops.get(desktop.accountId)===desktop)desktops.delete(desktop.accountId);
  desktop.ws.terminate();
 }
 function ack(state,seq) {
  return new Promise((resolve,reject)=>{
   const timer=setTimeout(()=>{state.rejectAck=undefined;reject(Error('Desktop acknowledgement timeout'));},ackTimeoutMs);timer.unref();
   state.ackSeq=seq;
   state.resolveAck=()=>{clearTimeout(timer);state.resolveAck=undefined;state.rejectAck=undefined;resolve();};
   state.rejectAck=error=>{clearTimeout(timer);state.resolveAck=undefined;state.rejectAck=undefined;reject(error);};
  });
 }
 function write(state,bytes) {
  return new Promise((resolve,reject)=>{
   const output=state.kind==='http'?state.res:state.socket;
   if(state.done||output.destroyed){reject(Error('Browser disconnected'));return;}
   output.write(bytes,error=>error?reject(error):resolve());
  });
 }
 async function message(desktop,msg) {
  if(!validSession(desktop.session)){disconnect(desktop);return;}
  if(!desktop.ready) {
   if(msg?.type!=='connect'||msg.version!==1||typeof msg.deviceId!=='string'||!/^[a-f0-9-]{36}$/.test(msg.deviceId))throw Error('Invalid desktop handshake');
   const existing=desktops.get(desktop.accountId);
   if(existing&&existing!==desktop&&existing.deviceId!==msg.deviceId){await send(desktop.ws,{type:'rejected',reason:'device-conflict'});desktop.ws.close(1008,'Another desktop is connected');return;}
   if(existing&&existing!==desktop)disconnect(existing);
   desktop.deviceId=msg.deviceId;desktops.set(desktop.accountId,desktop);
   try{await store.bindDesktop(desktop.accountId,msg.deviceId);}catch(error){disconnect(desktop);throw error;}
   if(closed||desktop.ws.readyState!==WebSocket.OPEN||desktops.get(desktop.accountId)!==desktop||!validSession(desktop.session)){disconnect(desktop);return;}
   desktop.ready=true;clearTimeout(desktop.handshake);
   desktop.heartbeat=setInterval(()=>{
    if(desktop.pongDeadline)return;
    if(desktop.ws.readyState!==WebSocket.OPEN){disconnect(desktop);return;}
    desktop.pongDeadline=setTimeout(()=>disconnect(desktop),heartbeatTimeoutMs);desktop.pongDeadline.unref();
    desktop.ws.ping(error=>{if(error)disconnect(desktop);});
   },heartbeatIntervalMs);desktop.heartbeat.unref();
   await send(desktop.ws,{type:'ready',publicUrl:publicOrigin});return;
  }
  if(msg?.type==='ping'){await send(desktop.ws,{type:'pong'});return;}
  const id=msg?.id??msg?.wsId,state=desktop.requests.get(id);
  if(!state)return;
  if(!validSession(state.session)){fail(state,401);return;}
  switch(msg.type) {
   case 'request-ack':
   case 'ws-ack':
    if(msg.seq!==state.ackSeq||!state.resolveAck)throw Error('Unexpected desktop acknowledgement');
    state.resolveAck();break;
   case 'response-start': {
    if(state.kind!=='http'||state.res.headersSent||!Number.isInteger(msg.status)||msg.status<200||msg.status>599||!msg.headers||typeof msg.headers!=='object'||Array.isArray(msg.headers))throw Error('Invalid desktop response');
    const headers=publicHeaders(msg.headers);
    if(state.entryPage&&msg.status===200&&/^text\/html(?:;|$)/i.test(String(headers['content-type']))&&!headers['content-encoding']) {
     state.observePresence=true;
     for(const name of ['content-length','etag','content-md5','digest','content-digest','repr-digest','last-modified'])delete headers[name];
     headers['cache-control']='private, no-store';
    }
    if(headers.location) {const location=new URL(headers.location,'http://127.0.0.1');if(['127.0.0.1','localhost'].includes(location.hostname))headers.location=location.pathname+location.search+location.hash;}
    state.res.writeHead(msg.status,headers);break;
   }
   case 'response-chunk':
   case 'ws-frame': {
    if(msg.seq!==state.nextResponse++||((msg.type==='response-chunk')!==(state.kind==='http'))||state.incoming)throw Error('Invalid desktop response sequence');
    if(state.kind==='http'&&!state.res.headersSent)throw Error('Response body before headers');
    state.incoming=true;
    try {await write(state,decodeChunk(msg,chunkBytes));if(!state.done)await send(desktop.ws,{type:state.kind==='http'?'response-ack':'ws-ack',...(state.kind==='http'?{id}:{wsId:id}),seq:msg.seq});}
    finally {state.incoming=false;}
    break;
   }
   case 'response-end':
    if(state.kind!=='http'||!state.res.headersSent||state.incoming)throw Error('Invalid desktop response end');
    state.done=true;clearTimeout(state.expiry);desktop.requests.delete(id);state.res.end(state.observePresence?'<script src="/desktop-presence.js"></script>':undefined);break;
   case 'ws-accept': {
    if(state.kind!=='ws'||state.accepted||!Number.isInteger(msg.statusCode)||(msg.statusCode!==101&&(msg.statusCode<200||msg.statusCode>599))||!msg.replyHeaders||typeof msg.replyHeaders!=='object'||Array.isArray(msg.replyHeaders))throw Error('Invalid desktop WebSocket upgrade');
    const accepted=msg.statusCode===101;
    const headers={...publicHeaders(msg.replyHeaders),connection:accepted?'Upgrade':'close',...(accepted?{upgrade:'websocket'}:{'content-length':'0'})};
    const text=`HTTP/1.1 ${msg.statusCode} ${accepted?'Switching Protocols':'Rejected'}\r\n`+Object.entries(headers).map(([key,value])=>`${key}: ${value}\r\n`).join('')+'\r\n';
    if(text.length>16384||Object.entries(headers).some(([key,value])=>/[\r\n]/.test(key)||/[\r\n]/.test(String(value))))throw Error('Invalid upgrade headers');
    if(!accepted) {
     state.done=true;clearTimeout(state.expiry);desktop.requests.delete(id);state.rejectAck?.(Error('Desktop upgrade refused'));
     state.socket.end(text);await send(desktop.ws,{type:'ws-close',wsId:id});break;
    }
    state.accepted=true;await write(state,Buffer.from(text));state.socket.resume();break;
   }
   case 'response-error':
   case 'ws-error':
   case 'ws-close':fail(state);break;
   default:throw Error('Unknown desktop response');
  }
 }
 function control(req,socket,head,session) {
  if(closed){socket.destroy();return;}
  wss.handleUpgrade(req,socket,head,ws=>{
   const desktop={ws,session,accountId:session.id,ready:false,requests:new Map()};
   desktop.handshake=setTimeout(()=>disconnect(desktop),ackTimeoutMs);desktop.handshake.unref();
   desktop.expiry=setTimeout(()=>disconnect(desktop),Math.max(1,session.expiry-now()));desktop.expiry.unref();
   ws.on('message',bytes=>{
    let parsed;try{parsed=JSON.parse(bytes.toString());}catch(error){ws.close(1008,'Invalid control JSON');return;}
    void message(desktop,parsed).catch(()=>{ws.close(1008,'Invalid desktop message');disconnect(desktop);});
   });
   ws.on('close',()=>disconnect(desktop));ws.on('error',()=>disconnect(desktop));
   ws.on('pong',()=>{clearTimeout(desktop.pongDeadline);desktop.pongDeadline=undefined;});
  });
 }
 function active(session) {const desktop=desktops.get(session.id);return desktop?.ready&&validSession(desktop.session)&&desktop.ws.readyState===WebSocket.OPEN?desktop:null;}
 function createState(desktop,session,kind,target) {
  if(desktop.requests.size>=maxRequests)return null;
  const id=randomUUID(),state={id,desktop,session,kind,...target,nextResponse:0,done:false,incoming:false};
  state.expiry=setTimeout(()=>fail(state,401),Math.max(1,session.expiry-now()));state.expiry.unref();
  desktop.requests.set(id,state);return state;
 }
 async function upload(state,source,bytesType='request-chunk') {
  let seq=0,total=0;
  for await(const chunk of source) {
   for(let offset=0;offset<chunk.length;offset+=chunkBytes) {
    if(state.done)return;
    const bytes=chunk.subarray(offset,offset+chunkBytes);total+=bytes.length;
    if(total>maxUploadBytes)throw Error('Desktop upload limit exceeded');
    const waiting=ack(state,seq);
    // Register the rejection observer before a control send can fail.
    const observed=waiting.catch(error=>{throw error;});observed.catch(()=>{});
    await send(state.desktop.ws,{type:bytesType,...(state.kind==='http'?{id:state.id}:{wsId:state.id}),seq,data:bytes.toString('base64')});
    await observed;seq++;
   }
  }
  if(!state.done&&state.kind==='http')await send(state.desktop.ws,{type:'request-end',id:state.id});
 }
 async function forward(req,res,session) {
  const desktop=active(session);if(!desktop)return false;
  const path=new URL(req.url,publicOrigin).pathname;
  const entryPage=(req.method==='GET'||req.method==='HEAD')&&(path==='/'||path==='/index.html');
  const state=createState(desktop,session,'http',{req,res,entryPage:entryPage&&req.method==='GET'});
  if(!state){res.writeHead(429,{'retry-after':'5'}).end();return true;}
  req.once('aborted',()=>fail(state));res.once('close',()=>{if(!state.done)fail(state);});
  try{await send(desktop.ws,{type:'request-start',id:state.id,method:req.method,url:req.url,headers:{...publicHeaders(req.headers),...(entryPage?{'accept-encoding':'identity'}:{})}});await upload(state,req);}catch(error){fail(state);}
  return true;
 }
 function upgrade(req,socket,head,session) {
  const desktop=active(session);if(!desktop)return false;
  const state=createState(desktop,session,'ws',{socket,accepted:false});
  if(!state){socket.end('HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');return true;}
  socket.pause();socket.once('close',()=>fail(state));socket.once('error',()=>fail(state));
  void (async()=>{
   const headers={...publicHeaders(req.headers),connection:'Upgrade',upgrade:'websocket'};
   await send(desktop.ws,{type:'ws-open',wsId:state.id,path:req.url,headers});
   if(head.length) {
    const source=(async function*(){yield head;})();await upload(state,source,'ws-frame');
   }
   await upload(state,socket,'ws-frame');
  })().catch(()=>fail(state));return true;
 }
 return {
  control,forward,upgrade,
  status:session=>({state:active(session)?'online':'offline'}),
  revoke:token=>{for(const desktop of [...desktops.values()]){if(desktop.session.token===token)disconnect(desktop);else for(const state of [...desktop.requests.values()])if(state.session.token===token)fail(state,401);}},
  close:()=>{closed=true;for(const desktop of [...desktops.values()])disconnect(desktop);for(const ws of wss.clients)ws.terminate();wss.close();},
 };
}

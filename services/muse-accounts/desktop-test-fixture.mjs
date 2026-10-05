/** Isolated account gateway and pinned bridge fixtures; cleanup awaits every owned connection. */
import assert from 'node:assert/strict';
import {once} from 'node:events';
import http from 'node:http';
import {cp,mkdtemp,rm,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {randomUUID} from 'node:crypto';
import {openStore} from './store.mjs';
import {createAccountServer} from './gateway.mjs';
import {applyBridgeDesktopCompatibility} from '../../third_party/plugins/compatibility/bridge-desktop.mjs';

const repository=fileURLToPath(new URL('../../',import.meta.url));

async function listen(server){server.listen(0,'127.0.0.1');await once(server,'listening');return `http://127.0.0.1:${server.address().port}`;}
/** @param {object} t Awaited cleanup owner. @param {object} desktopRelayOptions Relay settings. @param {boolean} browserOrigin Use the bound loopback origin for Chromium. @returns {Promise<object>} Authenticated test clients and temporary Host factory. */
export async function fixture(t,desktopRelayOptions={},browserOrigin=false){
 const root=await mkdtemp(join(tmpdir(),'muse-real-desktop-')),tunnels=[],servers=[],wsServers=[];
 t.after(async()=>{await Promise.allSettled(tunnels.map(x=>x.stop()));for(const wss of wsServers){for(const ws of wss.clients)ws.terminate();await new Promise(r=>wss.close(r));}for(const server of servers){server.closeAllConnections();await new Promise(r=>server.close(r));}await rm(join(root,'plugin/node_modules'),{force:true});await rm(root,{recursive:true,force:true});});
 const plugin=join(root,'plugin');await cp(join(repository,'third_party/plugins/dsh-bridge'),plugin,{recursive:true});applyBridgeDesktopCompatibility(plugin);
 await symlink(join(repository,'third_party/plugins/toolchain/node_modules'),join(plugin,'node_modules'),process.platform==='win32'?'junction':'dir');
 const {createMuseDesktopTunnel}=await import(pathToFileURL(join(plugin,'lib/muse-desktop-tunnel.mjs')).href);
 const store=await openStore(join(root,'accounts.json'));await store.create('alice','password');await store.create('bob','password');
 const listener=http.createServer();servers.push(listener);const base=await listen(listener);
 const origin=browserOrigin?base:'https://muse.test',gateway=createAccountServer({store,workspaceMode:'desktop',publicOrigin:origin,desktopRelayOptions});
 // The already-bound listener supplies an exact origin without releasing a reserved port.
 for(const event of ['request','upgrade','close'])for(const handler of gateway.listeners(event))listener.on(event,handler);
 async function login(username){const r=await fetch(base+'/login',{method:'POST',headers:{origin},body:new URLSearchParams({username,password:'password'}),redirect:'manual'});assert.equal(r.status,303);return r.headers.get('set-cookie').split(';')[0];}
 const alice=await login('alice'),bob=await login('bob');
 async function desktop(cookie,handler,deviceId=randomUUID(),metadata={}){
  const host=http.createServer(handler);servers.push(host);await listen(host);
  const tunnel=createMuseDesktopTunnel({serverUrl:base.replace('http:','ws:')+'/api/desktop/connect',headers:{cookie,origin},localPort:host.address().port,loopbackCookie:'host=local-private',deviceId,chunkBytes:32768,ackTimeoutMs:5000,reconnectMaxIntervalMs:1000,...metadata});tunnels.push(tunnel);await tunnel.start();return {tunnel,host,deviceId};
 }
 async function connect(cookie,hostUrl,loopbackCookie,deviceId=randomUUID(),metadata={}){
  const tunnel=createMuseDesktopTunnel({serverUrl:base.replace('http:','ws:')+'/api/desktop/connect',headers:{cookie,origin},localPort:Number(new URL(hostUrl).port),loopbackCookie,deviceId,chunkBytes:32768,ackTimeoutMs:5000,reconnectMaxIntervalMs:1000,...metadata});tunnels.push(tunnel);await tunnel.start();return {tunnel,deviceId};
 }
 return {base,origin,alice,bob,store,desktop,connect,wsServers,login};
}

/** Account routing for a user's connected desktop rather than a second cloud agent. */
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {openStore} from './store.mjs';
import {createAccountServer} from './gateway.mjs';

async function listen(server){await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});return `http://127.0.0.1:${server.address().port}`;}
async function fixture(t){
 const dir=await mkdtemp(join(tmpdir(),'muse-desktop-routing-'));const servers=[];
 t.after(async()=>{for(const server of servers){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}await rm(dir,{recursive:true,force:true});});
 const upstream=http.createServer((req,res)=>{if(req.url==='/bootstrap'){res.setHeader('set-cookie','dsh=private-local');res.end();}else res.end('WRONG CLOUD WORKROOM');});servers.push(upstream);
 const target=await listen(upstream),bootstrapPath=join(dir,'bootstrap');await writeFile(bootstrapPath,target+'/bootstrap');
 const store=await openStore(join(dir,'accounts.json'));const account=await store.create('editor','pw');let cloudStarts=0;
 const origin='https://muse.test',server=createAccountServer({store,publicOrigin:origin,workspaceMode:'desktop',runtime:{ensure:async()=>{cloudStarts++;return {upstream:target,bootstrapPath};}}});servers.push(server);
 const base=await listen(server);const login=await fetch(base+'/login',{method:'POST',headers:{origin},body:new URLSearchParams({username:'editor',password:'pw'}),redirect:'manual'});
 const cookie=login.headers.get('set-cookie').split(';')[0];return {base,origin,cookie,account,store,cloudStarts:()=>cloudStarts};
}

test('desktop website login opens an offline Muse page without starting a cloud agent',async t=>{
 const f=await fixture(t);const response=await fetch(f.base+'/',{headers:{cookie:f.cookie}});
 assert.equal(response.status,200);assert.match(await response.text(),/您的电脑上的 Muse 未启动/);assert.equal(f.cloudStarts(),0);
});

test('desktop status is private and reports no connected computer without a device picker',async t=>{
 const f=await fixture(t);assert.equal((await fetch(f.base+'/api/desktop/status',{redirect:'manual'})).status,303);
 const response=await fetch(f.base+'/api/desktop/status',{headers:{cookie:f.cookie}});assert.equal(response.status,200);
 assert.deepEqual(await response.json(),{state:'offline'});assert.equal(f.cloudStarts(),0);
});

test('invalid workspace mode fails before listening rather than silently launching another runtime',async t=>{
 const f=await fixture(t);
 assert.throws(()=>createAccountServer({store:f.store,publicOrigin:f.origin,workspaceMode:'invalid',runtime:{ensure:async()=>{throw Error('Unexpected runtime');}}}),/workspace mode/i);
});

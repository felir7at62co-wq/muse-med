import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,rm} from 'node:fs/promises';import {join} from 'node:path';import {tmpdir} from 'node:os';import {openStore} from './store.mjs';import {openFeedback} from './feedback.mjs';import {createAccountServer} from './gateway.mjs';
test('feedback HTTP authenticates, fences ownership/CSRF and exports only to administrators',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'muse-feedback-http-'));t.after(()=>rm(dir,{recursive:true,force:true}));const store=await openStore(join(dir,'accounts'));for(const username of ['alice','bob','admin'])await store.create(username,'pw',{admin:username==='admin'});
 const feedback=await openFeedback(join(dir,'feedback')),origin='https://muse.test',server=createAccountServer({store,feedback,runtime:{ensure:async()=>{throw Error('feedback independent of model runtime');}},publicOrigin:origin});await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));const base='http://127.0.0.1:'+server.address().port;
 const login=async username=>(await fetch(base+'/login',{method:'POST',headers:{origin},body:new URLSearchParams({username,password:'pw'}),redirect:'manual'})).headers.get('set-cookie').split(';')[0];const alice=await login('alice'),bob=await login('bob'),admin=await login('admin');
 const req=(path,cookie,opts={})=>fetch(base+path,{redirect:'manual',...opts,headers:{origin,cookie,...opts.headers}});
 assert.equal((await fetch(base+'/feedback',{redirect:'manual'})).status,303);
 const page=await req('/feedback',alice);assert.equal(page.status,200);assert.match(await page.text(),/意见箱/);assert.match(page.headers.get('content-security-policy'),/script-src 'self'/);
 const submitted=await req('/api/muse.feedback',alice,{method:'POST',body:JSON.stringify({title:'页面问题',category:'bug',body:'<script>坏内容</script>'})});assert.equal(submitted.status,201);const item=await submitted.json();
 assert.equal((await req('/api/muse.feedback/'+item.id,bob)).status,404);assert.equal((await(await req('/api/muse.feedback',bob)).json()).total,0);
 assert.equal((await req('/api/muse.feedback/export',bob)).status,403);assert.equal((await req('/api/muse.feedback/export',admin)).status,200);
 assert.equal((await req('/api/muse.feedback/'+item.id,alice,{method:'PATCH',body:'{}'})).status,403);
 assert.equal((await req('/api/muse.feedback',alice,{method:'POST',headers:{origin:'https://evil.test'},body:'{}'})).status,403);
 assert.equal((await req('/api/muse.feedback/'+item.id,admin,{method:'PATCH',body:JSON.stringify({status:'planned',reply:'已安排',revision:1})})).status,200);
 assert.equal((await(await req('/api/muse.feedback/'+item.id,alice)).json()).reply,'已安排');
 const invalid=await req('/api/muse.feedback',alice,{method:'POST',body:'not-json'});assert.equal(invalid.status,400);
});

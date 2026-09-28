import {mkdtemp,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes,randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import assert from 'node:assert/strict';
import {openStore} from './store.mjs';
import {createAccountServer} from './gateway.mjs';
import {createRuntime} from './runtime.mjs';
const dir=await mkdtemp(join(tmpdir(),'muse-live-'));
const store=await openStore(join(dir,'accounts.json')),runtime=createRuntime();
const origin='https://muse.aigc-pipeline.cn';
const a=await store.create('验收甲',randomBytes(20).toString('hex')),b=await store.create('验收乙',randomBytes(20).toString('hex'));
const server=createAccountServer({store,runtime,publicOrigin:origin});
await new Promise(resolve=>server.listen(19390,'127.0.0.1',resolve));
const base='http://127.0.0.1:19390';
try{
  const users=[];
  for(const account of [a,b]){
    const password=randomBytes(20).toString('hex');await store.resetPassword(account.id,password);
    const login=await fetch(base+'/login',{method:'POST',headers:{origin},body:new URLSearchParams({username:account.username,password}),redirect:'manual'});assert.equal(login.status,303);
    const cookie=login.headers.get('set-cookie').split(';')[0];
    const status=await fetch(base+'/api/editor.status',{headers:{cookie}});assert.equal(status.status,200,await status.clone().text());
    const body=await status.json();assert.equal(body.workspace,'/workspace');assert.equal(body.version,'0.2.1');
    users.push({id:account.id,cookie});
  }
  const [ua,ub]=users;
  execFileSync('docker',['exec',`muse-${ua.id}`,'node','-e',"require('fs').writeFileSync('/workspace/only-a.txt','private-A')"]);
  assert.equal(await (await fetch(base+'/api/muse.file-download?path=/workspace/only-a.txt',{headers:{cookie:ua.cookie}})).text(),'private-A');
  assert.equal((await fetch(base+'/api/muse.file-download?path=/workspace/only-a.txt',{headers:{cookie:ub.cookie}})).status,404);
  const sessionId='isolation-'+randomUUID();
  const created=await fetch(base+'/api/session/create',{method:'POST',headers:{cookie:ua.cookie,origin,'content-type':'application/json'},body:JSON.stringify({type:'client-request',rpcId:randomUUID(),method:'session/create',payload:{args:{request:{sessionId,cwd:'/workspace',agentPreset:'editor'}}}})});
  assert.equal(created.status,200);assert.equal((await created.json()).result.ok,true);
  const sa=await(await fetch(base+'/api/editor.status?sessionId='+sessionId,{headers:{cookie:ua.cookie}})).json();
  const sb=await(await fetch(base+'/api/editor.status?sessionId='+sessionId,{headers:{cookie:ub.cookie}})).json();
  assert.deepEqual(sa.tools,['bash','edit','llm_wiki','read','web_search','write']);assert.equal(sb.sessionFound,false);
  assert.equal((await fetch(base+'/admin',{headers:{cookie:ua.cookie}})).status,403);
  assert.equal((await fetch(base+'/api/muse.file-download?path=/home/editor/.dsh/muse-bootstrap',{headers:{cookie:ua.cookie}})).status,404);
  await writeFile('/opt/editor-dsh/verification/live-accounts.json',JSON.stringify({ids:[a.id,b.id],ok:true}),{mode:0o600});
  console.log(JSON.stringify({ok:true,privateFiles:true,privateSessions:true,tools:sa.tools,adminDenied:true,bootstrapDownloadDenied:true}));
}finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));for(const user of [a,b])await runtime.stop(user.id).catch(()=>{});}

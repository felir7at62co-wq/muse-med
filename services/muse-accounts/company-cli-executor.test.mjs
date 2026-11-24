import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {createHash} from 'node:crypto';
import {createCompanyCliExecutor,decodeCompanyCliArgv,companyCliDigest} from './company-cli-executor.mjs';

const owner={user_uuid:'user-a',account_id:'account-a',team_id:null};
const status={cliVersion:'1.2.0',apiHost:'https://api.liblib.tv',auth:{loggedIn:true,userUuid:'user-a',activeAccountId:'account-a',activeTeamId:null}};
const node={nodeKey:'node-a',data:{type:'image',params:{model:'Model A',count:1,prompt:'A tiny blue bird'}}};
const metadata={modelKey:'model-a',modelName:'Model A',schema:{properties:{count:{enum:[1,2]}}}};
const fixture=String.raw`
import {appendFile,readFile} from 'node:fs/promises';
const [root,url,...args]=process.argv.slice(2);
await appendFile(root+'/calls.jsonl',JSON.stringify({args,cwd:process.cwd(),token:process.env.LIBTV_TOKEN??null,otherSecret:process.env.MUSE_FIXTURE_SECRET??null})+'\n');
if(args[0]==='status')console.log(JSON.stringify(${JSON.stringify(status)}));
else if(args[0]==='model')console.log(JSON.stringify(${JSON.stringify(metadata)}));
else if(args.includes('--run'))console.log(JSON.stringify({nodeKey:args[1],status:2,token:'never-return-me'}));
else if(args[1]==='node-a')console.log(JSON.stringify(${JSON.stringify(node)}));
else if(args[1]==='nonzero'){console.log(JSON.stringify({message:'denied',authorization:'never-return-me'}));process.exitCode=9;}
else if(args[1]==='garbage')console.log('not structured, password=never-return-me');
else if(args[1]==='overflow')console.log('x'.repeat(200000));
else if(args[1]==='wait') {await fetch(url+'/wait');console.log(JSON.stringify({nodeKey:'wait'}));}
else if(args[1]==='first'||args[1]==='second'){await fetch(url+'/barrier');console.log(JSON.stringify({nodeKey:args[1],token:'never-return-me',nested:{api_key:'never-return-me',ok:true}}));}
else console.log(JSON.stringify({ok:true,args}));
`;

async function setup(t,{maxConcurrent=4,maxOutputBytes=65536,timeoutMs=10000}={}){
 const root=await mkdtemp(join(tmpdir(),'muse-company-cli-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const file=join(root,'fixture.mjs');await writeFile(file,fixture);const credentialsDir=join(root,'credentials');await mkdir(credentialsDir);
 const responses=[];let waitSeen;const waitReady=new Promise(resolve=>{waitSeen=resolve;});
 const server=createServer((request,response)=>{if(request.url==='/barrier'){responses.push(response);if(responses.length===2)for(const res of responses)res.end('go');}else if(request.url==='/wait'){waitSeen();responses.push(response);}else response.end();});
 server.listen(0,'127.0.0.1');await once(server,'listening');
 const executor=createCompanyCliExecutor({executable:process.execPath,prefixArgs:[file,root,`http://127.0.0.1:${server.address().port}`],workRoot:join(root,'work'),maxConcurrent,maxOutputBytes,timeoutMs,graceMs:100});
 t.after(async()=>{await executor.close();for(const response of responses)response.destroy();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
 const binding={companyId:'company-a',projectId:'project-a',connectionId:'connection-a',connectionRevision:1,credentialsDir,owner,canvasUuid:'canvas-a'};
 return {root,executor,binding,waitReady,calls:async()=>{try{return (await readFile(join(root,'calls.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);}catch(error){if(error.code==='ENOENT')return [];throw error;}}};
}

test('decoder covers the workflow command forms and rejects unknown shell/context capabilities',()=>{
 assert.deepEqual(decodeCompanyCliArgv(['node','--x','10','create','Bird','--type','image','--project','canvas-a','--prompt','A bird','--set','model=Model A','--set','count=1','--left','source-a']),{method:'node_create',body:{name:'Bird',x:'10',type:'image',project_uuid:'canvas-a',prompt:'A bird',params:{model:'Model A',count:'1'},left_node_ids:['source-a']}});
 assert.equal(decodeCompanyCliArgv(['node','node-a','--project','canvas-a','--run']).method,'node_run');
 assert.equal(decodeCompanyCliArgv(['node','node-a','--project','canvas-a','--left-rm','old-a']).method,'node_edit');
 assert.equal(decodeCompanyCliArgv(['video','hd','--node','node-a','--project','canvas-a']).method,'video_hd');
 assert.equal(decodeCompanyCliArgv(['script','storyboard','node-a','--project','canvas-a']).method,'script_storyboard');
 assert.equal(decodeCompanyCliArgv(['download','--node','node-a','--project','canvas-a','--watermark','false','--out','/server-staged']).body.directory,'/server-staged');
 assert.throws(()=>decodeCompanyCliArgv(['download','--node','node-a','--project','canvas-a','--watermark','false','--dir','/server-staged']),{code:'company_cli_unknown_argument'});
 for(const argv of [['login','web'],['account','use','other'],['status','--debug','true'],['node','node-a','--project','canvas-a','--eval','evil'],['node','node-a','--project','canvas-a','--run','--set','count=99'],['node','node-a','--project','canvas-a','--project','canvas-b']])assert.throws(()=>decodeCompanyCliArgv(argv),error=>error.code.startsWith('company_cli_'));
});

test('real processes for different nodes overlap, use private cwd, and remove secret fields',async t=>{
 const {executor,binding,calls}=await setup(t);
 const first=await executor.prepare(decodeCompanyCliArgv(['node','first','--project','canvas-a']),binding),second=await executor.prepare(decodeCompanyCliArgv(['node','second','--project','canvas-a']),binding);
 const results=await Promise.all([executor.execute(first,{operationId:'op-first'}),executor.execute(second,{operationId:'op-second'})]);
 assert.deepEqual(results.map(result=>result.state),['completed','completed']);assert.equal(JSON.stringify(results).includes('never-return-me'),false);
 const runs=(await calls()).filter(call=>call.args[0]==='node');assert.equal(runs.length,2);assert.notEqual(runs[0].cwd,runs[1].cwd);assert.ok(runs.every(call=>call.token===null));
});

test('native children inherit only the operating system environment allowlist',async t=>{
 const {executor,binding,calls}=await setup(t),before=process.env.MUSE_FIXTURE_SECRET;
 process.env.MUSE_FIXTURE_SECRET='fixture-private-value';
 try{
  const prepared=await executor.prepare({method:'status',body:{}},binding);await executor.execute(prepared,{operationId:'environment'});
  assert.ok((await calls()).every(call=>call.otherSecret===null));
 }finally{if(before===undefined)delete process.env.MUSE_FIXTURE_SECRET;else process.env.MUSE_FIXTURE_SECRET=before;}
});

test('same operation shares its real process and rejects a changed request',async t=>{
 const {executor,binding,calls}=await setup(t);
 const command=await executor.prepare({method:'node_read',body:{node_id:'ordinary',project_uuid:'canvas-a'}},binding);
 const first=executor.execute(command,{operationId:'same-op'}),second=executor.execute(command,{operationId:'same-op'});assert.equal(first,second);
 const changed=await executor.prepare({method:'node_read',body:{node_id:'changed',project_uuid:'canvas-a'}},binding);
 assert.throws(()=>executor.execute(changed,{operationId:'same-op'}),{code:'company_cli_operation_conflict'});
 await first;assert.equal(executor.execute(command,{operationId:'same-op'}),first);
 assert.equal((await calls()).filter(call=>call.args[0]==='node').length,1);
 assert.throws(()=>executor.execute({...command},{operationId:'forged'}),{code:'company_cli_unprepared_command'});
});

test('process exit, malformed output and output overflow stay separate from success',async t=>{
 const {executor,binding}=await setup(t,{maxOutputBytes:2048});
 async function run(id){const command=await executor.prepare({method:'node_read',body:{node_id:id,project_uuid:'canvas-a'}},binding);return executor.execute(command,{operationId:id});}
 const exited=await run('nonzero');assert.equal(exited.state,'failed');assert.equal(exited.exitCode,9);assert.equal(exited.timedOut,false);assert.equal(exited.cancelled,false);assert.equal(JSON.stringify(exited).includes('never-return-me'),false);
 const malformed=await run('garbage');assert.equal(malformed.state,'unknown');assert.equal(malformed.parseError,true);assert.deepEqual(malformed.records,[]);
 const overflow=await run('overflow');assert.equal(overflow.state,'unknown');assert.equal(overflow.outputTruncated,true);assert.deepEqual(overflow.records,[]);
});

test('capacity rejects instead of placing every employee behind one running process',async t=>{
 const {executor,binding,waitReady}=await setup(t,{maxConcurrent:1});
 const first=await executor.prepare({method:'node_read',body:{node_id:'wait',project_uuid:'canvas-a'}},binding),second=await executor.prepare({method:'node_read',body:{node_id:'ordinary',project_uuid:'canvas-a'}},binding);
 const controller=new AbortController(),running=executor.execute(first,{operationId:'first'},controller.signal);await waitReady;
 await assert.rejects(executor.execute(second,{operationId:'second'}),{code:'company_cli_capacity_reached'});controller.abort();const result=await running;assert.equal(result.cancelled,true);assert.equal(result.state,'unknown');
});

test('close terminates and drains owned subprocesses without claiming supplier cancellation',async t=>{
 const {executor,binding,waitReady}=await setup(t);
 const command=await executor.prepare({method:'node_read',body:{node_id:'wait',project_uuid:'canvas-a'}},binding);const running=executor.execute(command,{operationId:'wait'});await waitReady;await executor.close();
 const result=await running;assert.equal(result.cancelled,true);assert.equal(result.state,'unknown');await assert.rejects(executor.prepare({method:'status',body:{}},binding),{code:'company_cli_executor_closed'});
});

test('a process deadline reports timeout separately from user cancellation',async t=>{
 const {executor,binding,waitReady}=await setup(t,{timeoutMs:2500});
 const command=await executor.prepare({method:'node_read',body:{node_id:'wait',project_uuid:'canvas-a'}},binding);
 const running=executor.execute(command,{operationId:'deadline'});await waitReady;const result=await running;
 assert.equal(result.timedOut,true);assert.equal(result.cancelled,false);assert.equal(result.state,'unknown');
});

test('server bindings refuse other canvases, account drift, catalogs, and unstaged paths',async t=>{
 const {executor,binding,calls,root}=await setup(t);
 await assert.rejects(executor.prepare({method:'node_read',body:{node_id:'node-a',project_uuid:'canvas-b'}},binding),{code:'company_cli_project_scope_mismatch'});
 await assert.rejects(executor.prepare({method:'project_list',body:{}},binding),{code:'company_cli_catalog_admin_required'});
 await assert.rejects(executor.prepare({method:'upload',body:{name:'secret',type:'image',file:join(root,'secret'),project_uuid:'canvas-a'}},binding),{code:'company_cli_unstaged_file'});
 const command=await executor.prepare({method:'node_read',body:{node_id:'ordinary',project_uuid:'canvas-a'}},{...binding,owner:{...owner,account_id:'other'}});
 await assert.rejects(executor.execute(command,{operationId:'other-account'}),{code:'company_cli_account_changed'});assert.ok((await calls()).every(call=>call.args[0]==='status'));
});

test('staged upload fingerprint is checked again immediately before dispatch',async t=>{
 const {executor,binding,root,calls}=await setup(t);const file=join(root,'asset.png');await writeFile(file,'original');
 const staged={path:file,bytes:8,sha256:createHash('sha256').update('original').digest('hex')};
 const command=await executor.prepare({method:'upload',body:{name:'asset',type:'image',file,project_uuid:'canvas-a'}},{...binding,stagedAssets:[staged]});await writeFile(file,'modified');
 await assert.rejects(executor.execute(command,{operationId:'upload'}),{code:'company_cli_staged_file_changed'});assert.ok((await calls()).every(call=>call.args[0]==='status'));
});

test('paid execution derives model count from reviewed data and rereads inputs before one submission',async t=>{
 const {executor,binding,calls}=await setup(t);
 const command={method:'node_run',body:{node_id:'node-a',project_uuid:'canvas-a'}};
 await assert.rejects(executor.prepare(command,binding),{code:'company_cli_generation_review_required'});
 const prepared=await executor.prepare(command,{...binding,generation:{node,metadata,executionModelName:'Model A',references:[]}});
 assert.equal(prepared.service,'image');assert.equal(prepared.model,'model-a');assert.equal(prepared.quantity,1);assert.deepEqual(prepared.inputCapture.metadata,metadata);assert.equal(prepared.requestSha256.length,64);assert.ok(Object.isFrozen(prepared.inputCapture.node.data.params));
 const result=await executor.execute(prepared,{operationId:'paid'});assert.equal(result.state,'completed');assert.equal((await calls()).filter(call=>call.args.includes('--run')).length,1);
 const changed=await executor.prepare(command,{...binding,generation:{node:{...node,data:{...node.data,params:{...node.data.params,prompt:'Changed'}}},metadata,executionModelName:'Model A',references:[]}});
 await assert.rejects(executor.execute(changed,{operationId:'changed-paid'}),{code:'company_cli_generation_inputs_changed'});assert.equal((await calls()).filter(call=>call.args.includes('--run')).length,1);
 assert.equal(companyCliDigest({b:2,a:1}),companyCliDigest({a:1,b:2}));
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,readdir,rm,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createCompanyCliExecutor,companyCliDigest,validateCompanyAdvancedPlan,companyAdvancedMetadataCommand} from './company-cli-executor.mjs';

const owner={user_uuid:'fixture-user',account_id:'fixture-account',team_id:null};
const kinds=['video_hd','video_final','image_shortcut','script_storyboard','group_run','clip_run'];
const fixture=String.raw`
import {readFile,appendFile,writeFile} from 'node:fs/promises';
const [file,...args]=process.argv.slice(2),s=JSON.parse(await readFile(file,'utf8'));
await appendFile(file+'.calls',JSON.stringify({args,cwd:process.cwd()})+'\n');
const emit=value=>console.log(JSON.stringify(value));
if(args[0]==='status')emit({cliVersion:'1.2.0',apiHost:'https://api.liblib.tv',auth:{loggedIn:true,userUuid:'fixture-user',activeAccountId:'fixture-account',activeTeamId:null}});
else if(args[0]==='project')emit(s.plan.snapshot.project);
else if(args[0]==='video'&&args[2]==='list'||args[0]==='image'&&args[2]==='list')emit(s.plan.metadata);
else if(args[0]==='model')emit(args[1]==='search'?[s.plan.metadata]:s.plan.metadata);
else if(args[0]==='node'&&!args.includes('--run'))emit(s.generated?.[args[1]]??s.plan.snapshot.nodes.find(node=>node.nodeKey===args[1]));
else if(args[0]==='download'){
 if(!args.includes('--out')||args.includes('--dir'))throw Error('Expected official --out flag');
 if(s.downloadMode==='watermark'){console.error('请改传 --watermark true；private-token-never-return');process.exitCode=1;}
 else if(s.downloadMode==='outside')console.log('/outside/secret.mp4');
 else{const target=args[args.indexOf('--out')+1]+'/delivery.txt';await writeFile(target,'downloaded payload');console.log(target);}
}
else {
 const failed=s.outcome==='failed',status=failed?3:2,source=s.plan.spec.node_id;
 let result;
 if(s.plan.command_kind==='group_run'){
  const ids=['child-a','child-b'];emit({action:'query',groupNodeKey:source,executionPlan:ids,childNodeIds:ids});
  result={mode:'group',groupNodeKey:source,completed:failed?['child-a']:ids,skipped:[],failed:failed?'child-b':null,
   steps:ids.map((id,index)=>({nodeKey:id,nodeType:'image',taskId:'task-'+id,outcome:failed&&index===1?'failed':'success',status:failed&&index===1?3:2}))};
  if(s.outcome==='partial'){result.steps.pop();result.completed.pop();}
 }else if(s.plan.command_kind==='script_storyboard'){
  result={scriptNodeKey:source,groupNodeKey:'new-group',imageGenerationRan:true,imageNodeKeys:['new-a','new-b'],imageRuns:[{nodeKey:'new-a',taskId:'task-new-a',ok:true,status:2},{nodeKey:'new-b',taskId:'task-new-b',ok:!failed,status}]};
  if(s.outcome==='partial')result.imageRuns.pop();
 }else {
  const same=s.plan.command_kind==='clip_run'||s.plan.command_kind==='image_shortcut'&&s.plan.metadata.items[0].gridType===9;
  result={nodeKey:same?source:'new-result',sourceNodeKey:source,status,token:'never-return',url:['https://fixture.invalid/media.mp4']};
  if(s.outcome==='partial'){result.nodeKey='wrong-original';result.status=1;}
  if(s.captureMode==='large-original')result.padding='x'.repeat(8500);
 }
 if(result.imageRuns||result.steps){
  s.generated={};for(const row of result.imageRuns??result.steps){s.generated[row.nodeKey]={nodeKey:row.nodeKey,data:{type:s.captureMode==='wrong-type'?'video':'image',taskInfo:{taskId:s.captureMode==='wrong-task'?'external-task':row.taskId},url:['https://fixture.invalid/'+row.nodeKey+'-0.png','https://fixture.invalid/'+row.nodeKey+'-1.png']}};}
  if(s.captureMode==='missing')delete s.generated[Object.keys(s.generated)[0]];
  if(s.captureMode==='large-capture')for(const row of Object.values(s.generated))row.data.padding='x'.repeat(2600);
  await writeFile(file,JSON.stringify(s));
 }
 emit(result);if(failed)process.exitCode=1;
}
`;

function planFor(kind,{inPlace=false}={}){
 const spec={kind,project_uuid:'canvas-a',node_id:'source-a'};
 const type={video_hd:'video',video_final:'video',image_shortcut:'image',script_storyboard:'script',group_run:'group',clip_run:'video-clip'}[kind];
 const node={nodeKey:'source-a',data:{type,params:{},url:['https://fixture.invalid/source.mp4']}};
 const nodes=[node],edges=[];
 let metadata=null;
 if(kind==='video_hd'){spec.model_name='HD exact';metadata={models:[{modelKey:'hd-exact',modelName:'HD exact'}]};}
 if(kind==='video_final')node.data.taskInfo={taskId:'fixture-draft-task',status:2};
 if(kind==='image_shortcut'){spec.scene='lighting';metadata={items:[{scene:'lighting',...inPlace?{gridType:9}:{}}]};}
 if(kind==='script_storyboard'){spec.params={model:'Image exact',ratio:'16:9'};node.data.rows=[{scriptRowHiddenUuid:'row-a'},{scriptRowHiddenUuid:'row-b'}];metadata={modelKey:'image-exact',modelName:'Image exact',schema:{properties:{ratio:{enum:['16:9']}}}};}
 if(kind==='group_run')for(const id of ['child-a','child-b'])nodes.push({nodeKey:id,parentId:'source-a',data:{type:'image',params:{model:'Image exact',count:1,prompt:id}}});
 const snapshot={project:{nodes:nodes.map(item=>({id:item.nodeKey,...item.parentId?{parentId:item.parentId}:{}})),edges},nodes};
 return {protocol:'libtv-cli-advanced-input-v1',command_kind:kind,spec,snapshot,snapshot_sha256:companyCliDigest(snapshot),node,node_sha256:companyCliDigest(node),metadata,metadata_sha256:companyCliDigest(metadata),budget_model:`advanced:${kind}`,service:'agent-task',quantity:1,warning:'A task envelope is not a supplier spending cap.'};
}
function commandFor(plan){const {kind,...body}=plan.spec;return {method:kind,body};}

async function setup(t,plan,outcome='completed',captureMode='complete',maxOutputBytes=262144){
 const root=await mkdtemp(join(tmpdir(),'muse-advanced-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const file=join(root,'fixture.mjs'),state=join(root,'state.json'),workRoot=join(root,'operations');await writeFile(file,fixture);await writeFile(state,JSON.stringify({plan,outcome,captureMode}));await mkdir(join(root,'credentials'));
 const executor=createCompanyCliExecutor({executable:process.execPath,prefixArgs:[file,state],workRoot,maxConcurrent:4,maxOutputBytes,timeoutMs:10000,graceMs:100});t.after(()=>executor.close());
 const binding={companyId:'company-a',projectId:'project-a',connectionId:'connection-a',connectionRevision:1,credentialsDir:join(root,'credentials'),owner,canvasUuid:'canvas-a',advancedPlan:plan};
 return {executor,binding,root,workRoot,state,calls:async()=>{try{return(await readFile(state+'.calls','utf8')).trim().split('\n').map(JSON.parse);}catch(error){if(error.code==='ENOENT')return [];throw error;}}};
}

test('all six approved advanced methods run literal commands and identify their original terminal outputs',async t=>{
 for(const kind of kinds)await t.test(kind,async child=>{
  const plan=planFor(kind),{executor,binding,workRoot,calls}=await setup(child,plan);
  const prepared=await executor.prepare(commandFor(plan),binding);assert.equal(prepared.paid,true);assert.equal(prepared.model,`advanced:${kind}`);assert.equal(prepared.quantity,1);
  const task=executor.execute(prepared,{operationId:'advanced-job'}),result=await task;assert.equal(result.state,'completed');assert.equal(JSON.stringify(result).includes('never-return'),false);
  assert.equal(result.mediaOutputs.length,['script_storyboard','group_run'].includes(kind)?4:1);
  assert.ok(result.mediaOutputs.every(item=>item.nodeSha256===companyCliDigest(item.node)));
  if(['script_storyboard','group_run'].includes(kind))assert.deepEqual(result.mediaOutputs.map(item=>[item.nodeKey,item.outputIndex]),(kind==='group_run'?['child-a','child-b']:['new-a','new-b']).flatMap(id=>[[id,0],[id,1]]));
  assert.equal(executor.execute(prepared,{operationId:'advanced-job'}),task);assert.deepEqual(await readdir(workRoot),[]);
  const invocations=await calls();assert.ok(invocations.some(call=>call.args[0]==='project'));assert.ok(invocations.every(call=>call.cwd===invocations[0].cwd));
  assert.equal(invocations.filter(call=>call.args.includes('--run')||call.args[0]==='script'||call.args[0]==='video'&&!call.args.includes('list')||call.args[0]==='image'&&!call.args.includes('list')).length,1);
 });
});

test('unconfirmed batch media is excluded without changing the paid terminal result',async t=>{
 for(const mode of ['missing','wrong-type','wrong-task'])await t.test(mode,async child=>{
  const plan=planFor('script_storyboard'),{executor,binding}=await setup(child,plan,'completed',mode);
  const result=await executor.execute(await executor.prepare(commandFor(plan),binding),{operationId:'capture'});
  assert.equal(result.state,'completed');assert.ok(result.mediaCaptureErrors.length>0);
  assert.equal(result.mediaOutputs.some(item=>item.nodeKey==='new-a'),false);
 });
});

test('aggregate capture and original terminal records fit the configured output budget',async t=>{
 const plan=planFor('script_storyboard'),{executor,binding}=await setup(t,plan,'completed','large-capture',16384);
 const result=await executor.execute(await executor.prepare(commandFor(plan),binding),{operationId:'large-capture'});
 assert.equal(result.state,'completed');assert.equal(result.mediaOutputs.length,2);
 assert.equal(result.mediaCaptureErrors[0].capture_error,'company_cli_output_capture_limit');
 assert.ok(Buffer.byteLength(JSON.stringify(result))<=16384);
});

test('a nearly full original terminal is retained without appending large media snapshots',async t=>{
 const plan=planFor('video_hd'),{executor,binding}=await setup(t,plan,'completed','large-original',12288);
 const result=await executor.execute(await executor.prepare(commandFor(plan),binding),{operationId:'large-original'});
 assert.equal(result.state,'completed');assert.equal(result.records[0].padding.length,8500);assert.deepEqual(result.mediaOutputs,[]);
 assert.equal(result.mediaCaptureErrors[0].capture_error,'company_cli_output_capture_limit');assert.ok(Buffer.byteLength(JSON.stringify(result))<=12288);
});

test('in-place image shortcuts keep the selected node and preserve the prior input snapshot',async t=>{
 const plan=planFor('image_shortcut',{inPlace:true}),{executor,binding}=await setup(t,plan);
 const prepared=await executor.prepare(commandFor(plan),binding),result=await executor.execute(prepared,{operationId:'in-place'});
 assert.equal(result.state,'completed');assert.equal(result.records[0].nodeKey,plan.spec.node_id);assert.equal(prepared.inputCapture.node_sha256,plan.node_sha256);
});

test('advanced plan hashes, selected type, catalogue choices and command fields are all required',()=>{
 for(const kind of kinds){const plan=planFor(kind),command=commandFor(plan);assert.equal(validateCompanyAdvancedPlan(command,plan).model,`advanced:${kind}`);
  assert.throws(()=>validateCompanyAdvancedPlan(command,{...plan,node_sha256:'0'.repeat(64)}),{code:'company_cli_advanced_inputs_changed'});
  assert.throws(()=>validateCompanyAdvancedPlan({...command,body:{...command.body,node_id:'other'}},plan),{code:'company_cli_advanced_spec_changed'});
  assert.throws(()=>validateCompanyAdvancedPlan(command,{...plan,quantity:2}),{code:'company_cli_invalid_advanced_plan'});
 }
 const plan=planFor('video_hd');plan.metadata.models[0].modelName='unapproved';plan.metadata_sha256=companyCliDigest(plan.metadata);
 assert.throws(()=>validateCompanyAdvancedPlan(commandFor(plan),plan),{code:'company_cli_advanced_model_unconfirmed'});
 assert.deepEqual(companyAdvancedMetadataCommand({kind:'script_storyboard'}),{method:'model_search',body:{type:'image'}});
});

test('sample-to-final rejects an absent or unfinished source before any budget admission',()=>{
 for(const change of [node=>{node.data.url=[];},node=>{delete node.data.taskInfo;},node=>{node.data.taskInfo.taskId='';},node=>{node.data.taskInfo.status=1;},node=>{node.data.taskInfo.status=3;}]){
  const plan=planFor('video_final');change(plan.node);plan.node_sha256=companyCliDigest(plan.node);plan.snapshot_sha256=companyCliDigest(plan.snapshot);
  assert.throws(()=>validateCompanyAdvancedPlan(commandFor(plan),plan),{code:'company_cli_final_source_not_ready'});
 }
});

test('fresh node, canvas and metadata changes stop before advanced dispatch',async t=>{
 for(const field of ['node','canvas','metadata'])await t.test(field,async child=>{
  const plan=planFor('video_hd'),{executor,binding,state,calls,workRoot}=await setup(child,plan),prepared=await executor.prepare(commandFor(plan),binding),changed=structuredClone(plan);
  if(field==='node')changed.snapshot.nodes[0].data.url=['https://fixture.invalid/changed.mp4'];
  if(field==='canvas')changed.snapshot.project.edges=[{source:'source-a',target:'source-a'}];
  if(field==='metadata')changed.metadata.models[0].modelName='Changed';
  await writeFile(state,JSON.stringify({plan:changed,outcome:'completed'}));
  await assert.rejects(executor.execute(prepared,{operationId:'stale'}),{code:'company_cli_generation_inputs_changed'});
  assert.equal((await calls()).some(call=>call.args[0]==='video'&&!call.args.includes('list')),false);assert.deepEqual(await readdir(workRoot),[]);
 });
});

test('known failed advanced outcomes remain failed and incomplete batches remain unknown',async t=>{
 for(const kind of ['video_hd','script_storyboard','group_run'])for(const outcome of ['failed','partial'])await t.test(`${kind}-${outcome}`,async child=>{
  const plan=planFor(kind),{executor,binding}=await setup(child,plan,outcome),prepared=await executor.prepare(commandFor(plan),binding);
  const result=await executor.execute(prepared,{operationId:'result'});assert.equal(result.state,outcome==='failed'?'failed':'unknown');
 });
});

test('cleaning the temporary cwd retains separate downloaded payloads for retrieval',async t=>{
 const plan=planFor('clip_run'),{executor,binding,root,workRoot}=await setup(t,plan),directory=join(root,'download');await mkdir(directory);
 const prepared=await executor.prepare({method:'download',body:{project_uuid:'canvas-a',node_id:'source-a',watermark:false,directory}},{...binding,downloadDir:directory});
 const result=await executor.execute(prepared,{operationId:'download'});assert.equal(result.state,'completed');assert.equal(await readFile(result.records[0].local_file,'utf8'),'downloaded payload');assert.deepEqual(await readdir(workRoot),[]);
});

test('download uses the official output option and never exposes rejected output or raw membership errors',async t=>{
 for(const mode of ['watermark','outside'])await t.test(mode,async child=>{
  const plan=planFor('clip_run'),{executor,binding,root,state,calls}=await setup(child,plan),directory=join(root,'download');await mkdir(directory);
  await writeFile(state,JSON.stringify({plan,downloadMode:mode}));
  const prepared=await executor.prepare({method:'download',body:{project_uuid:'canvas-a',node_id:'source-a',watermark:false,directory}},{...binding,downloadDir:directory});
  const result=await executor.execute(prepared,{operationId:'download-'+mode});
  assert.deepEqual(result.records,[]);assert.equal(JSON.stringify(result).includes('private-token-never-return'),false);
  if(mode==='watermark'){assert.equal(result.state,'failed');assert.equal(result.error_code,'company_cli_download_watermark_required');}
  else{assert.equal(result.state,'unknown');assert.equal(result.parseError,true);}
  const run=(await calls()).find(call=>call.args[0]==='download');assert.ok(run.args.includes('--out'));assert.ok(!run.args.includes('--dir'));
 });
});

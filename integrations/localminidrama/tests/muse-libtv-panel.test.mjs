/** The original panel preserves pending identities through refused and uncertain HTTP outcomes. */
import test from 'node:test'
import assert from 'node:assert/strict'
import {existsSync,readFileSync} from 'node:fs'
import {createRequire} from 'node:module'
import {resolve} from 'node:path'
import {compileFunction} from 'node:vm'

const database='00000000-0000-4000-8000-000000000001'
const component=readFileSync(new URL('../extensions/muse-libtv-panel.vue',import.meta.url),'utf8').split('<script setup>')[1].split('</script>')[0].replace(/^import .*$/mg,'')
async function fixture({bound=true}={}){
 const storage=new Map(),statuses=new Map(),requests=[],messages=[];let sequence=0,refuse=true,loseAbandonment=false,deferredBinding=null,deferredPreview=null
 let savedBinding=bound?{session_id:'original-session',remote_project_id:'remote-project',context_mode:'selected_session',binding_sha256:'a'.repeat(64)}:null
 const request=async value=>{requests.push(value);const route=value.url.replace('/muse/libtv','');if(route==='/configs')return {database_id:database,items:[]};if(route==='/tasks'&&value.method==='get')return [...statuses.values()].flatMap(v=>v.task?[v.task]:[])
  const bindingRoute=/^\/projects\/(\d+)\/binding(?:\?config_id=(\d+)|\/preview)?$/.exec(route)
  if(bindingRoute){const project_id=Number(bindingRoute[1]),config_id=Number(bindingRoute[2]??value.data?.config_id),base={database_id:database,project_id,config_id};if(value.method==='get'){if(deferredBinding){const deferred=deferredBinding;deferredBinding=null;return await deferred}return {...base,binding:savedBinding}}
   if(route.endsWith('/preview')){if(deferredPreview){const deferred=deferredPreview;deferredPreview=null;return await deferred}return {...base,session_id:value.data.session_id||'shared-session',remote_project_id:'remote-project',context_mode:value.data.session_id?'selected_session':'shared_default',expected_binding_sha256:savedBinding?.binding_sha256??null,preview_sha256:'b'.repeat(64)}}
   assert.equal(value.data.acknowledge_context,true);if(value.data.context_mode==='shared_default')assert.equal(value.data.acknowledge_shared_default,true);savedBinding={session_id:value.data.session_id,remote_project_id:value.data.remote_project_id,context_mode:value.data.context_mode,binding_sha256:'c'.repeat(64)};return {...base,binding:savedBinding}}
  if(route==='/tasks'){if(refuse){const error=Error('budget refused');error.response={data:{error:{code:'budget_price_unknown',message:'请先设置项目预算'}}};throw error}const task={database_id:database,operation_id:value.data.operation_id,state:'unknown',messages:[],results:[]};statuses.set(task.operation_id,{database_id:database,operation_id:task.operation_id,state:'recorded',can_abandon:false,task});throw Error('lost submission acknowledgement')}
  const match=/^\/submissions\/([^/]+)(\/abandon)?$/.exec(route);assert.ok(match);const id=match[1],status=statuses.get(id)||{database_id:database,operation_id:id,state:'not_recorded',can_abandon:true,task:null};if(match[2]){assert.equal(status.can_abandon,true);statuses.set(id,{...status,state:'abandoned',can_abandon:false});if(loseAbandonment)throw Error('lost abandonment acknowledgement')}return statuses.get(id)||status
 };request.get=async()=>[]
 const localStorage={getItem:key=>storage.get(key)??null,setItem:(key,value)=>storage.set(key,value),removeItem:key=>storage.delete(key)}
 const build=compileFunction(component+'\nreturn {form,databaseId,pending,pendingCheck,error,tasks,submit,load,inspectPending,restorePending,abandonPending,finishRecovery,binding,bindingPreview,bindingVerified,bindingSession,bindingAcknowledged,sharedDefaultAcknowledged,readBinding,inspectBinding,saveBinding,selectionChanged,clearBindingPreview};',['ref','reactive','onMounted','request','ElMessage','ElMessageBox','crypto','localStorage','watch','onBeforeUnmount'])
 const mount=()=>{const watchers=[];let unmount=()=>{};const panel=build(value=>({value}),value=>value,()=>{},request,{success:value=>messages.push(value)},{confirm:async()=>{}},{randomUUID:()=> 'fixture-operation-'+(++sequence)},localStorage,(_source,callback)=>{watchers.push(callback)},callback=>{unmount=callback});panel.databaseId.value=database;panel.sessionInputChanged=()=>watchers[1]();panel.unmount=()=>unmount();return panel}
 const panel=mount();Object.assign(panel.form,{project_id:1,config_id:1,prompt:'original prompt',references:[{local_path:'image/original.png',sha256:'a'.repeat(64)}],acknowledge_agent_mode:true})
 await panel.readBinding()
 return {panel,mount,storage,statuses,requests,messages,allow(){refuse=false},loseAbandonment(){loseAbandonment=true},deferBinding(promise){deferredBinding=promise},deferPreview(promise){deferredPreview=promise}}
}

test('a definite budget refusal can be explicitly abandoned and corrected without manually clearing storage',async()=>{
 const f=await fixture(),p=f.panel;await p.submit();const id=p.pending.value.operation_id;assert.match(p.error.value,/设置项目预算/);assert.equal(f.storage.size,1);p.form.prompt='corrected prompt';await p.load();await p.submit();assert.equal(f.requests.filter(v=>v.url==='/muse/libtv/tasks'&&v.method==='post').length,1)
 await p.inspectPending();assert.equal(p.pendingCheck.value.state,'not_recorded');await p.restorePending();assert.equal(p.form.prompt,'original prompt');await p.abandonPending();assert.equal(f.statuses.get(id).state,'abandoned');assert.equal(p.pending.value,null);assert.equal(f.storage.size,0)
 p.form.prompt='corrected prompt';f.allow();await p.submit();assert.notEqual(p.pending.value.operation_id,id);assert.equal(f.requests.filter(v=>v.url==='/muse/libtv/tasks'&&v.method==='post').length,2)
})

test('a remounted unknown submission restores its input and resumes its original task without abandoning or resending',async()=>{
 const f=await fixture();f.allow();await f.panel.submit();const id=f.panel.pending.value.operation_id,p=f.mount();await p.load();assert.equal(p.pending.value.operation_id,id);await p.restorePending();assert.equal(p.form.prompt,'original prompt');assert.equal(p.form.references[0].local_path,'image/original.png');await p.inspectPending();assert.equal(p.pendingCheck.value.task.state,'unknown');await p.abandonPending();assert.match(p.error.value,/不能放弃/);assert.equal(f.storage.size,1)
 await p.finishRecovery();assert.equal(p.pending.value,null);assert.equal(f.storage.size,0);assert.equal(p.tasks.value.find(v=>v.operation_id===id).state,'unknown');assert.equal(f.requests.filter(v=>v.url==='/muse/libtv/tasks'&&v.method==='post').length,1);assert.equal(f.requests.filter(v=>v.url.endsWith('/abandon')).length,0)
})

test('a lost abandonment acknowledgement retains the ID until the same server record confirms it',async()=>{
 const f=await fixture(),p=f.panel;await p.submit();const id=p.pending.value.operation_id;await p.inspectPending();f.loseAbandonment();await p.abandonPending();assert.equal(p.pending.value.operation_id,id);assert.equal(f.storage.size,1);assert.equal(f.statuses.get(id).state,'abandoned');await p.inspectPending();assert.equal(p.pendingCheck.value.state,'abandoned');await p.finishRecovery();assert.equal(f.storage.size,0);assert.equal(p.pending.value,null);assert.equal(f.requests.filter(v=>v.url.endsWith('/abandon')).length,1)
})

test('an unbound project cannot submit and inspecting a selected session remains free',async()=>{
 const f=await fixture({bound:false}),p=f.panel;await p.submit();assert.match(p.error.value,/会话绑定/);assert.equal(f.storage.size,0)
 p.bindingSession.value='selected-session';await p.inspectBinding();assert.equal(p.bindingPreview.value.session_id,'selected-session');assert.equal(p.bindingPreview.value.context_mode,'selected_session');assert.equal(p.binding.value,null)
 assert.equal(f.requests.filter(v=>v.url==='/muse/libtv/tasks'&&v.method==='post').length,0)
 await p.saveBinding();assert.match(p.error.value,/明确确认/);assert.equal(f.requests.filter(v=>v.url==='/muse/libtv/projects/1/binding'&&v.method==='post').length,0)
 p.bindingAcknowledged.value=true;await p.saveBinding();assert.equal(p.binding.value.session_id,'selected-session');assert.equal(p.bindingPreview.value,null)
 assert.deepEqual({native_project:p.form.project_id,config:p.form.config_id,session:p.binding.value.session_id,remote_project:p.binding.value.remote_project_id,context:p.binding.value.context_mode,confirmation:f.messages.at(-1),paid_requests:f.requests.filter(v=>v.url==='/muse/libtv/tasks'&&v.method==='post').length},JSON.parse(readFileSync(new URL('./expected/muse-libtv-binding.json',import.meta.url),'utf8')))
 await p.submit();const sent=f.requests.find(v=>v.url==='/muse/libtv/tasks'&&v.method==='post');assert.equal(sent.data.binding_sha256,'c'.repeat(64));assert.equal(Object.hasOwn(sent.data,'session_id'),false)
})

test('the shared default requires its own explicit acknowledgement and is never described as an isolated session',async()=>{
 const f=await fixture({bound:false}),p=f.panel;await p.inspectBinding();assert.equal(p.bindingPreview.value.context_mode,'shared_default');assert.equal(p.bindingAcknowledged.value,false);assert.equal(p.sharedDefaultAcknowledged.value,false)
 p.bindingAcknowledged.value=true;await p.saveBinding();assert.match(p.error.value,/明确确认/);assert.equal(p.binding.value,null)
 p.sharedDefaultAcknowledged.value=true;await p.saveBinding();assert.equal(p.binding.value.context_mode,'shared_default')
 const sent=f.requests.find(v=>v.url==='/muse/libtv/projects/1/binding'&&v.method==='post');assert.equal(sent.data.acknowledge_shared_default,true);assert.equal(sent.data.session_id,'shared-session')
 assert.equal(f.requests.filter(v=>v.url==='/muse/libtv/tasks'&&v.method==='post').length,0)
})

test('changing the selected project refuses an old preview and an old verified binding',async()=>{
 const f=await fixture(),p=f.panel;p.bindingSession.value='selected-session';await p.inspectBinding();p.bindingAcknowledged.value=true;p.form.project_id=2
 await p.saveBinding();assert.match(p.error.value,/明确确认/);assert.equal(f.requests.filter(v=>v.url==='/muse/libtv/projects/2/binding'&&v.method==='post').length,0)
 p.clearBindingPreview();await p.submit();assert.match(p.error.value,/会话绑定/);assert.equal(f.storage.size,0)
})

test('a late binding read cannot replace the current project and refresh preserves original pending references',async()=>{
 const f=await fixture(),p=f.panel;let complete;const late=new Promise(resolve=>{complete=resolve});f.deferBinding(late);const first=p.readBinding();p.form.project_id=2;await p.readBinding()
 complete({database_id:database,project_id:1,config_id:1,binding:{session_id:'late-old-session'}});await first;assert.equal(p.binding.value.session_id,'original-session');assert.equal(p.bindingVerified.value,true)
 p.form.project_id=1;await p.readBinding();await p.submit();await p.restorePending();assert.equal(p.form.references[0].local_path,'image/original.png');await p.load();assert.equal(p.form.references[0].local_path,'image/original.png')
})

test('a pending preview must be confirmed or explicitly left before submitting to an existing binding',async()=>{
 const f=await fixture(),p=f.panel;p.bindingSession.value='selected-session';await p.inspectBinding();await p.submit();assert.match(p.error.value,/会话绑定/);assert.equal(f.storage.size,0)
 p.clearBindingPreview();await p.submit();assert.equal(f.storage.size,1)
})

test('editing a session ID while its preview is loading discards the old response and acknowledgements',async()=>{
 const f=await fixture(),p=f.panel;let complete;f.deferPreview(new Promise(resolve=>{complete=resolve}));p.bindingSession.value='first-session';const reading=p.inspectBinding();p.bindingSession.value='second-session';p.sessionInputChanged()
 complete({database_id:database,project_id:1,config_id:1,session_id:'first-session',remote_project_id:'remote-project',context_mode:'selected_session',expected_binding_sha256:'a'.repeat(64),preview_sha256:'b'.repeat(64)});await reading
 assert.equal(p.bindingPreview.value,null);assert.equal(p.bindingAcknowledged.value,false);assert.equal(p.sharedDefaultAcknowledged.value,false)
})

test('closing the panel fences an in-flight binding read',async()=>{
 const f=await fixture(),p=f.panel;let complete;f.deferBinding(new Promise(resolve=>{complete=resolve}));const reading=p.readBinding();p.unmount();complete({database_id:database,project_id:1,config_id:1,binding:{session_id:'late-session'}});await reading;assert.equal(p.binding.value.session_id,'original-session');assert.equal(p.bindingVerified.value,false)
})

const frontend=resolve(process.env.LOCALMINIDRAMA_SOURCE||'.local/localminidrama','frontweb')
test('the project-binding panel compiles as a Vue component',{skip:!existsSync(resolve(frontend,'node_modules/@vue/compiler-sfc'))},()=>{
 const require=createRequire(resolve(frontend,'package.json')),{parse,compileScript,compileTemplate}=require('@vue/compiler-sfc')
 const filename='MuseLibtvPanel.vue',source=readFileSync(new URL('../extensions/muse-libtv-panel.vue',import.meta.url),'utf8'),{descriptor,errors}=parse(source,{filename});assert.deepEqual(errors,[])
 const script=compileScript(descriptor,{id:'libtv-binding'});assert.deepEqual(compileTemplate({source:descriptor.template.content,filename,id:'libtv-binding',compilerOptions:{bindingMetadata:script.bindings}}).errors,[])
})

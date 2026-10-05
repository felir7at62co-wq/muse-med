import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openGlobalModels,restrictModelSchema} from './global-models.mjs';
import {desktopModelCatalog} from './desktop-models.mjs';

const model={id:'glm-5.3-flash',contextWindow:200000,maxTokens:32768,input:['text'],reasoningEfforts:{low:'wire-low',high:'wire-high'},defaultReasoningEffort:'low'};
const provider={baseURL:'https://provider.example/v1',api:'openai-completions',apiKeyEnv:'GLM_KEY',models:[model]};

test('admin schema offers per-model enabled defaults in inline and referenced schemas',()=>{
 const inline={type:'object',dict:{providers:{type:'dict',inner:{type:'object',dict:{api:{type:'union',list:[{type:'const',value:'openai-completions'},{type:'const',value:'other'}]},models:{type:'array',inner:{type:'object',dict:{id:{type:'string'},compat:{type:'object'}}}}}}}}};
 const refs={},store=value=>{const id=Object.keys(refs).length+1;refs[id]=value;return id;};
 const convert=value=>{const copy={...value};if(value.dict)copy.dict=Object.fromEntries(Object.entries(value.dict).map(([key,child])=>[key,convert(child)]));if(value.inner)copy.inner=convert(value.inner);if(value.list)copy.list=value.list.map(convert);return store(copy);};
 const uid=convert(inline);
 for(const source of [inline,{uid,refs}]){
  const original=structuredClone(source),restricted=restrictModelSchema(source),node=value=>restricted.refs?restricted.refs[value]:value;
  const root=restricted.refs?node(restricted.uid):restricted,profile=node(node(root.dict.providers).inner),entry=node(node(profile.dict.models).inner);
  assert.deepEqual(node(entry.dict.defaultReasoningEffort).list.map(value=>node(value).value),['minimal','low','medium','high','xhigh','max']);assert.equal(entry.dict.compat,undefined);assert.deepEqual(source,original);
 }
});

test('per-model effort defaults survive private storage and public metadata without credentials',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'muse-model-default-'));t.after(()=>rm(dir,{recursive:true,force:true}));const file=join(dir,'models');
 const directory=await openGlobalModels(file);
 await directory.mutate({ns:'llm-pi-ai',expectedRevision:0,ops:[{op:'set',path:['providers','studio'],value:provider}]});
 await directory.setCredential('GLM_KEY','synthetic-private-key');
 const reopened=await openGlobalModels(file),resolved=reopened.resolve('studio','glm-5.3-flash');
 assert.equal(resolved.defaultReasoningEffort,'low');assert.equal(resolved.maxTokens,32768);assert.equal(resolved.apiKey,'synthetic-private-key');
 const catalog=desktopModelCatalog(reopened);assert.equal(catalog.providers[0].models[0].defaultReasoningEffort,'low');
 assert.doesNotMatch(JSON.stringify(catalog),/synthetic-private-key|GLM_KEY|provider.example/);
});

test('model defaults require an offered enabled effort',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'muse-model-default-invalid-'));t.after(()=>rm(dir,{recursive:true,force:true}));const directory=await openGlobalModels(join(dir,'models'));
 for(const entry of [
  {...model,defaultReasoningEffort:'medium'}, {...model,defaultReasoningEffort:'off',reasoningEfforts:{off:null,low:'low'}},
  {...model,reasoningEfforts:false}, {...model,reasoningEfforts:{low:'low'},defaultReasoningEffort:'wire-low'},
 ])await assert.rejects(directory.mutate({ns:'llm-pi-ai',expectedRevision:0,ops:[{op:'set',path:['providers','studio'],value:{...provider,models:[entry]}}]}),/默认思考档位/);
 assert.equal(directory.view().revision,0);
});

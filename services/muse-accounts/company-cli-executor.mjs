/** Fixed LibTV commands, server-owned account scope and bounded concurrent native processes. */
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdir,mkdtemp,lstat,realpath,readFile,rm} from 'node:fs/promises';
import {isAbsolute,join,resolve,relative} from 'node:path';

const record=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const fail=(code,status=400)=>Object.assign(new Error(code),{code,status});
const secretKey=/^(?:token|access[_-]?token|access[_-]?key|api[_-]?key|secret|password|cookies?|authorization|headers|credentials|credentialsFile|credentialsPath|savedAt|webid|__proto__|prototype|constructor)$/iu;
const common={project_uuid:'--project',group_id:'--group'};
const paging={page:'--page',page_size:'--page-size',name:'--name',order_by:'--order-by'};
const description={description:'--description',cover_url:'--cover-url'};
const workspace={workspace_id:'--workspace',team_id:'--team-id'};
const nodeFields={...common,name:'--name',params:'--set',data:'--update',left_node_ids:'--left',left_add_ids:'--left-add',left_remove_ids:'--left-rm',x:'--x',y:'--y',link:'--link',attachment:'--attachment',prompt:'--prompt'};
const specs={
 status:{prefix:['status'],pos:[],flags:{}},
 account_info:{prefix:['account','info'],pos:[],flags:{}},
 account_list:{prefix:['account','list'],pos:[],flags:{},admin:true},
 model_search:{prefix:['model','search'],pos:['keywords?'],flags:{type:'--type'}},
 model_schema:{prefix:['model'],pos:['model_key'],flags:{}},
 project_list:{prefix:['project','list'],pos:[],flags:{...paging,...workspace},admin:true},
 project_create:{prefix:['project','create'],pos:['name'],flags:{...description,...workspace},write:true},
 project_read:{prefix:['project'],pos:['project_uuid'],flags:{}},
 project_update:{prefix:['project','update'],pos:['project_uuid'],flags:{name:'--name',...description,folder_id:'--folder-id'},write:true},
 workspace_list:{prefix:['workspace','list'],pos:[],flags:{...paging,team_id:'--team-id'},admin:true},
 workspace_read:{prefix:['workspace'],pos:['workspace_id'],flags:{},admin:true},
 workspace_create:{prefix:['workspace','create'],pos:['name'],flags:{...description,team_id:'--team-id'},admin:true,write:true},
 workspace_update:{prefix:['workspace','update'],pos:['workspace_id'],flags:{name:'--name',...description,team_id:'--team-id'},admin:true,write:true},
 node_list:{prefix:['node','list'],pos:[],flags:common},
 node_read:{prefix:['node'],pos:['node_id'],flags:common},
 node_create:{prefix:['node','create'],pos:['name'],flags:{...nodeFields,type:'--type'},write:true},
 node_edit:{prefix:['node'],pos:['node_id'],flags:nodeFields,write:true},
 node_delete:{prefix:['node','delete'],pos:['node_id'],flags:common,write:true},
 node_run:{prefix:['node'],pos:['node_id'],flags:common,run:true,write:true},
 clip_run:{prefix:['node'],pos:['node_id'],flags:common,run:true,write:true},
 group_list:{prefix:['group','list'],pos:[],flags:common},
 group_read:{prefix:['group'],pos:['node_id'],flags:common},
 group_create:{prefix:['group','create'],pos:['name'],flags:{...common,node_ids:'--node'},write:true},
 group_edit:{prefix:['group'],pos:['node_id'],flags:{...common,node_ids:'--node',remove_node_ids:'--node-rm'},write:true},
 group_run:{prefix:['group'],pos:['node_id'],flags:common,run:true,write:true},
 image_shortcuts:{prefix:['image','shortcut','list'],pos:[],flags:{}},
 image_shortcut:{prefix:['image','shortcut'],pos:['scene'],flags:{...common,node_id:'--node',x:'--x',y:'--y'},run:true,write:true},
 video_hd_models:{prefix:['video','hd','list'],pos:[],flags:{}},
 video_hd:{prefix:['video','hd'],pos:[],flags:{...common,node_id:'--node',model_name:'--model',x:'--x',y:'--y'},run:true,write:true},
 video_final:{prefix:['video','final'],pos:[],flags:{...common,node_id:'--node',x:'--x',y:'--y'},run:true,write:true},
 script_storyboard:{prefix:['script','storyboard'],pos:['node_id'],flags:{...common,params:'--set'},run:true,write:true},
 upload:{prefix:['upload'],pos:['name'],flags:{project_uuid:'--project',type:'--type',file:'--file'},write:true},
 download:{prefix:['download'],pos:[],flags:{...common,node_id:'--node',watermark:'--watermark',directory:'--out'}},
};
const arrays=new Set(['left_node_ids','left_add_ids','left_remove_ids','node_ids','remove_node_ids']);
const maps=new Set(['params','data']);
const maintainedFields=new Set(['type','params','label','action','taskInfo','prevTaskInfo','generatorType','isStale']);
const numbers=new Set(['page','page_size','x','y']);
const ids=new Set(['node_id','project_uuid','group_id','workspace_id','team_id','folder_id']);

function textValue(value,key){
 if(typeof value!=='string'||!value||value.length>65536||value.includes('\0')||key!=='prompt'&&/[\r\n]/u.test(value))throw fail('company_cli_invalid_argument');
 if(ids.has(key)&&!/^[-\w]{1,256}$/u.test(value))throw fail('company_cli_invalid_identifier');
 return value;
}
function canonical(value){
 if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
 if(record(value))return '{'+Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>JSON.stringify(key)+':'+canonical(item)).join(',')+'}';
 return JSON.stringify(value);
}
function frozen(value){if(value!==null&&typeof value==='object'){for(const child of Object.values(value))frozen(child);Object.freeze(value);}return value;}
/** Produce the same stable SHA-256 used by Muse's frozen native CLI inputs. @param {unknown} value JSON data. @returns {string} Lowercase SHA-256. */
export function companyCliDigest(value){return createHash('sha256').update(canonical(value)).digest('hex');}
function scalar(value,key){
 if(numbers.has(key)){const n=typeof value==='string'?Number(value):value;if(!Number.isFinite(n)||Math.abs(n)>1e8||(['page','page_size'].includes(key)&&(!Number.isSafeInteger(n)||n<1)))throw fail('company_cli_invalid_argument');return String(n);}
 if(key==='watermark'){if(value===true||value==='true')return 'true';if(value===false||value==='false')return 'false';throw fail('company_cli_invalid_argument');}
 return textValue(value,key);
}
function normalize(command){
 if(!record(command)||Object.keys(command).some(key=>!['method','body'].includes(key))||!Object.hasOwn(specs,command.method)||!record(command.body))throw fail('company_cli_unknown_command');
 const spec=specs[command.method],body={},allowed=new Set([...spec.pos.map(key=>key.replace(/\?$/u,'')),...Object.keys(spec.flags)]);
 for(const [key,value] of Object.entries(command.body)){
  if(!allowed.has(key))throw fail('company_cli_unknown_argument');
  if(arrays.has(key)){if(!Array.isArray(value)||value.length>128)throw fail('company_cli_invalid_argument');body[key]=value.map(item=>textValue(item,'node_id'));}
  else if(maps.has(key)){if(!record(value)||Object.keys(value).length>128)throw fail('company_cli_invalid_argument');body[key]={};for(const [field,item] of Object.entries(value)){if(!/^[a-zA-Z][\w.]{0,127}$/u.test(field)||secretKey.test(field)||maintainedFields.has(field.split('.')[0])||!['string','number','boolean'].includes(typeof item)||typeof item==='number'&&!Number.isFinite(item))throw fail('company_cli_invalid_parameter');body[key][field]=textValue(String(item),'prompt');}}
  else body[key]=scalar(value,key);
 }
 for(const key of spec.pos)if(!key.endsWith('?')&&!Object.hasOwn(body,key))throw fail('company_cli_missing_argument');
 if(spec.flags.project_uuid&&!body.project_uuid)throw fail('company_cli_project_required');
 if(['node_create','upload'].includes(command.method)&&!body.type)throw fail('company_cli_missing_argument');
 if(command.method==='upload'&&!['image','video','audio'].includes(body.type))throw fail('company_cli_invalid_media_type');
 if(command.method==='node_create'&&!['image','video','audio','text','script','storyboard','video-clip'].includes(body.type))throw fail('company_cli_invalid_node_type');
 if(spec.run&&!body.node_id)throw fail('company_cli_missing_argument');
 if(command.method==='upload'&&!body.file||command.method==='download'&&(!body.node_id||!body.directory))throw fail('company_cli_missing_argument');
 return {method:command.method,body};
}
function compile(command){
 const spec=specs[command.method],argv=[...spec.prefix];
 for(const key of spec.pos){const value=command.body[key.replace(/\?$/u,'')];if(value!==undefined)argv.push(value);}
 for(const [key,flag] of Object.entries(spec.flags)){
  const value=command.body[key];if(value===undefined)continue;
  if(arrays.has(key))for(const item of value)argv.push(flag,item);
  else if(maps.has(key))for(const [field,item] of Object.entries(value))argv.push(flag,`${field}=${item}`);
  else argv.push(flag,value);
 }
 if(['node_run','clip_run','group_run'].includes(command.method))argv.push('--run');
 return argv;
}

/**
 * Decode only documented explicit-scope commands; never forward caller argv to a process.
 * @param {string[]} argv Native CLI arguments, without an executable.
 * @returns {{method:string,body:object}} Validated semantic command; unknown flags and context mutation throw.
 */
export function decodeCompanyCliArgv(argv){
 if(!Array.isArray(argv)||argv.length<1||argv.length>600||argv.some(item=>typeof item!=='string'||item.includes('\0')||item.length>65536))throw fail('company_cli_invalid_argv');
 const positional=[],options=new Map();let run=false;
 for(let i=0;i<argv.length;i++){
  const token=argv[i];
  if(token==='--run'){if(run)throw fail('company_cli_duplicate_argument');run=true;continue;}
  if(token.startsWith('-')){if(!token.startsWith('--')||i+1>=argv.length)throw fail('company_cli_unknown_argument');const value=argv[++i];if(value.startsWith('--'))throw fail('company_cli_invalid_argument');options.set(token,[...(options.get(token)||[]),value]);}
  else positional.push(token);
 }
 const first=positional[0],second=positional[1];let method;
 if(first==='status'&&positional.length===1)method='status';
 else if(first==='account'&&['info','list'].includes(second))method=second==='info'?'account_info':'account_list';
 else if(first==='model')method=second==='search'?'model_search':'model_schema';
 else if(first==='project')method=['list','create','update'].includes(second)?`project_${second}`:'project_read';
 else if(first==='workspace')method=['list','create','update'].includes(second)?`workspace_${second}`:'workspace_read';
 else if(first==='node')method=['list','create','delete'].includes(second)?`node_${second}`:run?'node_run':[...options.keys()].some(key=>!['--project','--group'].includes(key))?'node_edit':'node_read';
 else if(first==='group')method=['list','create'].includes(second)?`group_${second}`:run?'group_run':[...options.keys()].some(key=>!['--project','--group'].includes(key))?'group_edit':'group_read';
 else if(first==='image'&&second==='shortcut')method=positional[2]==='list'?'image_shortcuts':'image_shortcut';
 else if(first==='video'&&second==='hd')method=positional[2]==='list'?'video_hd_models':'video_hd';
 else if(first==='video'&&second==='final')method='video_final';
 else if(first==='script'&&second==='storyboard')method='script_storyboard';
 else if(first==='upload'||first==='download')method=first;
 else throw fail('company_cli_unknown_command');
 const spec=specs[method];if(!spec)throw fail('company_cli_unknown_command');
 if(run&&!['node_run','group_run'].includes(method))throw fail('company_cli_unknown_argument');
 const remaining=positional.slice(spec.prefix.length),body={};
 if(remaining.length>spec.pos.length)throw fail('company_cli_unknown_argument');
 spec.pos.forEach((key,index)=>{if(remaining[index]!==undefined)body[key.replace(/\?$/u,'')]=remaining[index];});
 for(const [flag,values] of options){const field=Object.keys(spec.flags).find(key=>spec.flags[key]===flag);if(!field)throw fail('company_cli_unknown_argument');
  if(maps.has(field)){body[field]={};for(const value of values){const equal=value.indexOf('=');if(equal<1)throw fail('company_cli_invalid_parameter');const key=value.slice(0,equal);if(Object.hasOwn(body[field],key))throw fail('company_cli_duplicate_argument');body[field][key]=value.slice(equal+1);}}
  else if(arrays.has(field))body[field]=values;
  else {if(values.length!==1)throw fail('company_cli_duplicate_argument');body[field]=values[0];}
 }
 return normalize({method,body});
}

function safeOutput(value){
 if(Array.isArray(value))return value.map(safeOutput);
 if(record(value)){const result={};for(const [key,item] of Object.entries(value))if(!secretKey.test(key))result[key]=safeOutput(item);return result;}
 if(typeof value==='string')return value.replace(/\bBearer\s+[^\s"']+/giu,'Bearer [redacted]').replace(/\b(?:access[_-]?token|api[_-]?key|password|authorization)\s*[:=]\s*[^\s,;]+/giu,'[redacted]');
 return value;
}
function parseOutput(text){
 if(!text.trim())return [];
 try{return [JSON.parse(text)];}catch(error){if(!(error instanceof SyntaxError))throw error;}
 try{return text.trim().split(/\r?\n/u).map(line=>JSON.parse(line));}catch(error){if(!(error instanceof SyntaxError))throw error;throw fail('company_cli_invalid_output',502);}
}
function ownerFromStatus(value){
 const auth=value?.auth;
 if(value?.cliVersion!=='1.2.0'||!auth||auth.loggedIn!==true||typeof auth.userUuid!=='string'||auth.activeAccountId===undefined)throw fail('company_cli_login_required',409);
 let origin;try{origin=new URL(value.apiHost).origin;}catch{throw fail('company_cli_invalid_status',502);}
 if(origin!=='https://api.liblib.tv')throw fail('company_cli_invalid_status',502);
 return {user_uuid:auth.userUuid,account_id:String(auth.activeAccountId),team_id:auth.activeTeamId==null?null:String(auth.activeTeamId)};
}
function checkOwner(actual,expected){if(!record(expected)||['user_uuid','account_id','team_id'].some(key=>actual[key]!==expected[key]))throw fail('company_cli_account_changed',409);}

function validateGeneration(method,body,generation){
 if(!record(generation))throw fail('company_cli_generation_review_required',428);
 if(method!=='node_run')throw fail('company_cli_advanced_review_required',428);
 const {node,metadata,executionModelName}=generation,type=node?.data?.type,params=node?.data?.params;
 if(!record(node)||node.nodeKey!==body.node_id||!['image','video','audio','text','script','storyboard'].includes(type)||!record(params)||typeof params.prompt!=='string'||!record(metadata)||typeof metadata.modelKey!=='string'||typeof metadata.modelName!=='string'||!record(metadata.schema?.properties)||typeof executionModelName!=='string'||!executionModelName||![executionModelName,metadata.modelKey].includes(params.model))throw fail('company_cli_invalid_generation_review',428);
 const countSchema=metadata.schema.properties.count,implicitAudio=type==='audio'&&countSchema===undefined,quantity=implicitAudio?1:params.count;
 if(!Number.isSafeInteger(quantity)||quantity<1||quantity>1000||implicitAudio&&params.count!==undefined&&params.count!==1)throw fail('company_cli_invalid_generation_count',428);
 const choices=Array.isArray(countSchema)?countSchema:countSchema?.enum;
 if(!implicitAudio&&(!Array.isArray(choices)||!choices.some(item=>item===quantity||record(item)&&item.value===quantity)))throw fail('company_cli_invalid_generation_count',428);
 const references=generation.references??[];if(!Array.isArray(references)||references.length>128)throw fail('company_cli_invalid_generation_review',428);
 return {service:type==='audio'?'agent-task':['script','storyboard'].includes(type)?'text':type,model:metadata.modelKey,quantity,inputCapture:{node,metadata,executionModelName,references}};
}

const advancedKinds=new Set(['video_hd','video_final','image_shortcut','script_storyboard','group_run','clip_run']);

/**
 * Select the fixed free catalogue needed by a reviewed advanced operation.
 * Storyboard callers resolve the exact image modelName in this catalogue, then read its model schema.
 * @param {object} spec Explicit advanced command fields.
 * @returns {object|null} Fixed metadata command, or null for commands without a model catalogue.
 */
export function companyAdvancedMetadataCommand(spec){
 if(!record(spec)||!advancedKinds.has(spec.kind))throw fail('company_cli_invalid_advanced_spec');
 if(spec.kind==='video_hd')return {method:'video_hd_models',body:{}};
 if(spec.kind==='image_shortcut')return {method:'image_shortcuts',body:{}};
 if(spec.kind==='script_storyboard')return {method:'model_search',body:{type:'image'}};
 return null;
}

function advancedCommand(spec){
 if(!record(spec)||Object.keys(spec).some(key=>!['kind','project_uuid','node_id','group_id','model_name','scene','x','y','params'].includes(key))||!advancedKinds.has(spec.kind))throw fail('company_cli_invalid_advanced_spec');
 const {kind,...body}=spec;
 return normalize({method:kind,body});
}

function snapshotNodes(snapshot){
 if(!record(snapshot)||!record(snapshot.project)||!Array.isArray(snapshot.project.nodes)||!Array.isArray(snapshot.project.edges)||!Array.isArray(snapshot.nodes))throw fail('company_cli_invalid_advanced_snapshot',428);
 const ids=snapshot.project.nodes.map(node=>textValue(node.id??node.nodeKey,'node_id'));
 if(new Set(ids).size!==ids.length||snapshot.nodes.length!==ids.length||snapshot.nodes.some((node,index)=>!record(node)||node.nodeKey!==ids[index]))throw fail('company_cli_invalid_advanced_snapshot',428);
 for(const edge of snapshot.project.edges)if(!record(edge)||!ids.includes(edge.source)||!ids.includes(edge.target))throw fail('company_cli_invalid_advanced_snapshot',428);
 return ids;
}

/**
 * Validate a freshly reconstructed advanced plan and derive its one-task budget identity.
 * No amount or model billing identity from a caller is trusted; the controller owns the current price and explicit expense approval.
 * @param {object} command Fixed method/body decoded by the company controller.
 * @param {object} plan Complete libtv-cli-advanced-input-v1 snapshot read by that controller.
 * @returns {object} Server-derived billing fields and immutable input evidence.
 */
export function validateCompanyAdvancedPlan(command,plan){
 const normalized=normalize(command);
 if(!record(plan)||plan.protocol!=='libtv-cli-advanced-input-v1'||!advancedKinds.has(normalized.method)||plan.command_kind!==normalized.method||plan.budget_model!==`advanced:${normalized.method}`||plan.service!=='agent-task'||plan.quantity!==1)throw fail('company_cli_invalid_advanced_plan',428);
 if(companyCliDigest(advancedCommand(plan.spec))!==companyCliDigest(normalized))throw fail('company_cli_advanced_spec_changed',409);
 if(companyCliDigest(plan.snapshot)!==plan.snapshot_sha256||companyCliDigest(plan.node)!==plan.node_sha256||companyCliDigest(plan.metadata)!==plan.metadata_sha256)throw fail('company_cli_advanced_inputs_changed',409);
 const ids=snapshotNodes(plan.snapshot),index=ids.indexOf(normalized.body.node_id);
 if(index<0||companyCliDigest(plan.snapshot.nodes[index])!==plan.node_sha256)throw fail('company_cli_invalid_advanced_snapshot',428);
 const data=plan.node.data,type=data?.type,metadata=plan.metadata;
 if(!record(data))throw fail('company_cli_invalid_advanced_node',428);
 if(normalized.body.group_id){
  const group=plan.snapshot.nodes.find(item=>item.nodeKey===normalized.body.group_id);
  if(group?.data?.type!=='group'||!Array.isArray(group.data.childNodeIds)||!group.data.childNodeIds.includes(normalized.body.node_id))throw fail('company_cli_group_scope_mismatch',403);
 }
 if(['video_hd','video_final'].includes(normalized.method)){
  if(type!=='video')throw fail('company_cli_invalid_advanced_node',428);
  if(normalized.method==='video_hd'&&(!record(metadata)||!Array.isArray(metadata.models)||metadata.models.filter(item=>item?.modelName===normalized.body.model_name).length!==1))throw fail('company_cli_advanced_model_unconfirmed',428);
  if(normalized.method==='video_final'&&metadata!==null)throw fail('company_cli_invalid_advanced_metadata',428);
  if(normalized.method==='video_final'&&(!Array.isArray(data.url)||typeof data.url[0]!=='string'||!data.url[0]||!record(data.taskInfo)||typeof data.taskInfo.taskId!=='string'||!data.taskInfo.taskId||data.taskInfo.status!==2))throw fail('company_cli_final_source_not_ready',428);
 }else if(normalized.method==='image_shortcut'){
  if(type!=='image'||!record(metadata)||!Array.isArray(metadata.items)||metadata.items.filter(item=>item?.scene===normalized.body.scene).length!==1)throw fail('company_cli_advanced_shortcut_unconfirmed',428);
 }else if(normalized.method==='script_storyboard'){
  if(type!=='script'||!Array.isArray(data.rows)||!data.rows.length||typeof normalized.body.params?.model!=='string'||!record(metadata)||typeof metadata.modelKey!=='string'||!record(metadata.schema?.properties))throw fail('company_cli_advanced_storyboard_unconfirmed',428);
 }else if(normalized.method==='group_run'){
  if(type!=='group'||data.sourceScriptNodeId&&data.storyboardGroupType!=='image'||metadata!==null)throw fail('company_cli_invalid_advanced_node',428);
 }else if(type!=='video-clip'||metadata!==null)throw fail('company_cli_invalid_advanced_node',428);
 return {service:'agent-task',model:`advanced:${normalized.method}`,quantity:1,inputCapture:plan};
}

function groupOutcome(result,body){
 const rows=result.records;
 if(rows.length!==2||!record(rows[0])||rows[0].action!=='query'||rows[0].groupNodeKey!==body.node_id||!Array.isArray(rows[0].executionPlan)||!record(rows[1]))return 'unknown';
 const terminal=rows[1],plan=rows[0].executionPlan;
 if(terminal.mode!=='group'||terminal.groupNodeKey!==body.node_id||!Array.isArray(terminal.completed)||!Array.isArray(terminal.skipped)||!Array.isArray(terminal.steps)||new Set(plan).size!==plan.length||terminal.steps.length!==plan.length)return 'unknown';
 const steps=terminal.steps;
 if(steps.some((step,index)=>!record(step)||step.nodeKey!==plan[index]||!['success','failed','skipped'].includes(step.outcome)))return 'unknown';
 const successful=steps.filter(step=>step.outcome==='success').map(step=>step.nodeKey),skipped=steps.filter(step=>step.outcome==='skipped').map(step=>step.nodeKey),failed=steps.filter(step=>step.outcome==='failed');
 if(companyCliDigest(successful)!==companyCliDigest(terminal.completed)||companyCliDigest(skipped)!==companyCliDigest(terminal.skipped))return 'unknown';
 if(failed.length===0&&skipped.length===0&&terminal.failed===null&&steps.every(step=>step.status===2)&&result.exitCode===0)return 'completed';
 if(failed.length>0&&failed.every(step=>[3,4].includes(step.status))&&terminal.failed===failed[0].nodeKey&&result.exitCode!==null&&result.exitCode!==0)return 'failed';
 return 'unknown';
}

function advancedOutcome(result,prepared){
 const body=prepared.body,kind=prepared.method;
 if(kind==='group_run')return groupOutcome(result,body);
 if(result.records.length!==1||!record(result.records[0]))return 'unknown';
 const value=result.records[0];
 if(kind==='script_storyboard'){
  if(value.scriptNodeKey!==body.node_id||value.imageGenerationRan!==true||!Array.isArray(value.imageNodeKeys)||value.imageNodeKeys.length!==prepared.inputCapture.node.data.rows.length||!Array.isArray(value.imageRuns)||value.imageRuns.length!==value.imageNodeKeys.length||new Set(value.imageNodeKeys).size!==value.imageNodeKeys.length||new Set(value.imageRuns.map(row=>row?.nodeKey)).size!==value.imageRuns.length||value.imageRuns.some(row=>!record(row)||!value.imageNodeKeys.includes(row.nodeKey)||typeof row.ok!=='boolean'))return 'unknown';
  if(value.imageRuns.every(row=>row.ok&&row.status===2)&&result.exitCode===0)return 'completed';
  if(value.imageRuns.some(row=>[3,4].includes(row.status))&&result.exitCode!==null&&result.exitCode!==0)return 'failed';
  return 'unknown';
 }
 if(typeof value.nodeKey!=='string'||!value.nodeKey||!Number.isInteger(value.status))return 'unknown';
 if(kind==='clip_run'&&value.nodeKey!==body.node_id)return 'unknown';
 if(['video_hd','video_final'].includes(kind)&&(value.nodeKey===body.node_id||kind==='video_final'&&value.sourceNodeKey!==body.node_id))return 'unknown';
 if(kind==='image_shortcut'){
  const shortcut=prepared.inputCapture.metadata.items.find(item=>item.scene===body.scene),inPlace=[4,9,16,25].includes(shortcut.gridType);
  if(inPlace?value.nodeKey!==body.node_id:value.nodeKey===body.node_id)return 'unknown';
 }
 if(value.status===2&&result.exitCode===0)return 'completed';
 if([3,4].includes(value.status)&&result.exitCode!==null&&result.exitCode!==0)return 'failed';
 return 'unknown';
}

function resultMediaCandidates(prepared,result){
 if(prepared.method==='script_storyboard')return result.records[0].imageRuns.map(row=>({nodeKey:row.nodeKey,kind:'image',taskId:row.taskId}));
 if(prepared.method==='group_run')return result.records[1].steps.filter(row=>row.outcome==='success'&&['image','video','audio'].includes(row.nodeType)).map(row=>({nodeKey:row.nodeKey,kind:row.nodeType,taskId:row.taskId}));
 const kind=['video_hd','video_final','clip_run'].includes(prepared.method)?'video':prepared.method==='image_shortcut'?'image':prepared.inputCapture?.node?.data?.type;
 if(!['image','video','audio'].includes(kind))return [];
 const terminal=result.records[0];
 return [{nodeKey:terminal.nodeKey,kind,taskId:terminal.taskId,terminal}];
}

function urlsIn(node){return Array.isArray(node?.url)?node.url:Array.isArray(node?.data?.url)?node.data.url:[];}
function validMediaUrl(value){try{const parsed=new URL(value);return parsed.protocol==='https:'&&!parsed.username&&!parsed.password;}catch{return false;}}
async function checkedFile(path,stagedAssets){
 const supplied=Array.isArray(stagedAssets)?stagedAssets.find(item=>record(item)&&item.path===path):undefined;
 if(!supplied||!isAbsolute(path)||typeof supplied.sha256!=='string'||!Number.isSafeInteger(supplied.bytes)||supplied.bytes<1)throw fail('company_cli_unstaged_file',403);
 const info=await lstat(path);if(!info.isFile()||info.isSymbolicLink()||info.size!==supplied.bytes||await realpath(path)!==resolve(path))throw fail('company_cli_unstaged_file',403);
 if(createHash('sha256').update(await readFile(path)).digest('hex')!==supplied.sha256)throw fail('company_cli_staged_file_changed',409);
 return supplied.sha256;
}

/**
 * Create one gateway-owned executor. Configuration and bindings must never come from request JSON.
 * The controller must claim its SQLite job exactly once before execute; settled operation IDs are not retained in this process.
 * @param {object} config Absolute executable/work root, explicit limits and optional fixed prefixArgs; onCleanupError records a cleanup failure without discarding an original result.
 * @returns {object} prepare/execute/close methods; close drains every owned subprocess and operation directory.
 */
export function createCompanyCliExecutor({executable,workRoot,maxConcurrent,maxOutputBytes,timeoutMs,graceMs,prefixArgs=[],onCleanupError=()=>console.error('[muse-company-cli] An operation directory could not be cleaned.')}){
 if(!isAbsolute(executable)||/\.(?:cmd|bat|ps1|sh)$/iu.test(executable)||!isAbsolute(workRoot)||!Number.isSafeInteger(maxConcurrent)||maxConcurrent<1||!Number.isSafeInteger(maxOutputBytes)||maxOutputBytes<128||!Number.isSafeInteger(timeoutMs)||timeoutMs<1||!Number.isSafeInteger(graceMs)||graceMs<1||!Array.isArray(prefixArgs)||prefixArgs.some(item=>typeof item!=='string'))throw fail('company_cli_invalid_configuration',500);
 const preparedStates=new WeakMap(),operations=new Map(),children=new Set(),lifecycle=new AbortController();let closed=false,active=0;
 async function prepare(command,binding){
  if(closed)throw fail('company_cli_executor_closed',503);
  const normalized=normalize(command),spec=specs[normalized.method],body=normalized.body;
  if(!record(binding)||!isAbsolute(binding.credentialsDir)||!record(binding.owner)||!['companyId','projectId','connectionId'].every(key=>typeof binding[key]==='string'&&binding[key])||!Number.isSafeInteger(binding.connectionRevision))throw fail('company_cli_invalid_binding',500);
  if(spec.admin&&!binding.catalogAdmin)throw fail('company_cli_catalog_admin_required',403);
  if(body.project_uuid!==undefined&&body.project_uuid!==binding.canvasUuid)throw fail('company_cli_project_scope_mismatch',403);
  for(const [field,source] of [['workspace_id','workspaceId'],['team_id','teamId']])if(body[field]!==undefined&&String(body[field])!==String(binding[source]))throw fail('company_cli_account_scope_mismatch',403);
  if(['project_create','workspace_create'].includes(normalized.method)){
   if(binding.canvasUuid&&normalized.method==='project_create')throw fail('company_cli_project_already_bound',409);
   if(binding.teamId===undefined)throw fail('company_cli_explicit_team_required',428);
   body.team_id=String(binding.teamId);
   if(normalized.method==='project_create'){if(binding.workspaceId===undefined)throw fail('company_cli_explicit_workspace_required',428);body.workspace_id=String(binding.workspaceId);}
  }
  if(normalized.method==='project_update'&&body.folder_id!==undefined&&body.folder_id!==String(binding.workspaceId))throw fail('company_cli_account_scope_mismatch',403);
  let uploadSha=null;
  if(normalized.method==='upload')uploadSha=await checkedFile(body.file,binding.stagedAssets);
  if(normalized.method==='node_edit'&&body.attachment&&body.attachment!=='none'&&!/^https:\/\//u.test(body.attachment))uploadSha=await checkedFile(body.attachment,binding.stagedAssets);
  if(normalized.method==='download'&&(!isAbsolute(body.directory)||body.directory!==binding.downloadDir))throw fail('company_cli_unstaged_directory',403);
  const billing=spec.run?(advancedKinds.has(normalized.method)?validateCompanyAdvancedPlan(normalized,binding.advancedPlan):validateGeneration(normalized.method,body,binding.generation)):{service:null,model:null,quantity:0,inputCapture:null};
  const resourceKey=`${binding.canvasUuid?'canvas:'+binding.canvasUuid:'project:'+binding.projectId}:${body.node_id?'node:'+body.node_id:spec.write?'write':'read'}`;
  const requestSha256=companyCliDigest({command:normalized,companyId:binding.companyId,projectId:binding.projectId,connectionId:binding.connectionId,connectionRevision:binding.connectionRevision,owner:binding.owner,inputCapture:billing.inputCapture,uploadSha});
  const prepared=frozen(structuredClone({...normalized,body,requestSha256,resourceKey,paid:!!spec.run,...billing}));
  preparedStates.set(prepared,{binding:structuredClone(binding),argv:compile(normalized),uploadSha});return prepared;
 }
 async function native(argv,binding,cwd,signal){
  const env={};
  for(const [key,value] of Object.entries(process.env))if(/^(?:PATH|SystemRoot|WINDIR|TEMP|TMP|PATHEXT|COMSPEC|LANG|LC_ALL|LC_CTYPE|TZ)$/iu.test(key)&&value!==undefined)env[key]=value;
  env.HOME=cwd;env.USERPROFILE=cwd;env.LIBTV_CONFIG_DIR=binding.credentialsDir;
  if(signal?.aborted)return {exitCode:null,exit_code:null,signal:null,timedOut:false,cancelled:true,outputTruncated:false,records:[],started:false,parseError:false};
  let child;try{child=spawn(executable,[...prefixArgs,...argv],{cwd,env,shell:false,windowsHide:true,stdio:['ignore','pipe','pipe']});}catch{throw fail('company_cli_process_unavailable',503);}
  let output=[],downloadErrors=[],bytes=0,stderrBytes=0,truncated=false,timedOut=false,cancelled=false,spawnError=false,killTimer;
  const stop=()=>{if(child.exitCode===null&&child.signalCode===null){child.kill();killTimer??=setTimeout(()=>child.kill('SIGKILL'),graceMs);killTimer.unref();}};
  const owned={child,stop,done:null};children.add(owned);
  const onAbort=()=>{cancelled=true;stop();};signal?.addEventListener('abort',onAbort,{once:true});
  const timer=setTimeout(()=>{timedOut=true;stop();},timeoutMs);timer.unref();
  child.stdout.on('data',chunk=>{bytes+=chunk.length;if(bytes<=maxOutputBytes)output.push(chunk);else{truncated=true;stop();}});
  child.stderr.on('data',chunk=>{stderrBytes+=chunk.length;if(stderrBytes>maxOutputBytes){truncated=true;stop();}else if(argv[0]==='download')downloadErrors.push(chunk);});
  owned.done=new Promise(resolveDone=>{child.once('error',()=>{spawnError=true;});child.once('close',(code,processSignal)=>{clearTimeout(timer);clearTimeout(killTimer);signal?.removeEventListener('abort',onAbort);children.delete(owned);let records=[],parseError=false;
    if(!truncated){try{const text=Buffer.concat(output).toString('utf8');
     if(argv[0]==='download'){
      const directory=argv[argv.indexOf('--out')+1];
      records=text.trim().split(/\r?\n/u).filter(Boolean).map(file=>{const rel=relative(directory,file);if(!isAbsolute(file)||!rel||rel.startsWith('..')||isAbsolute(rel))throw fail('company_cli_invalid_output',502);return {local_file:file};});
     }else records=parseOutput(text).map(safeOutput);
    }catch(error){parseError=true;records=[];}}
    let error_code;
    if(argv[0]==='download'&&code!==0){const message=Buffer.concat(downloadErrors).toString('utf8');error_code=/请改传 --watermark true/u.test(message)?'company_cli_download_watermark_required':/请改传 --watermark false/u.test(message)?'company_cli_download_watermark_mismatch':/无法确认账号会员态/u.test(message)?'company_cli_download_membership_unavailable':'company_cli_download_cli_failed';}
    resolveDone({exitCode:code,exit_code:code,signal:processSignal,timedOut,cancelled,outputTruncated:truncated,records,started:!spawnError,parseError,...error_code?{error_code}:{}});});});
  return owned.done;
 }
 async function perform(prepared,state,signal){
  if(closed)throw fail('company_cli_executor_closed',503);if(active>=maxConcurrent)throw fail('company_cli_capacity_reached',429);active++;
  let cwd,output;
  try{
   await mkdir(workRoot,{recursive:true,mode:0o700});cwd=await mkdtemp(join(workRoot,'operation-'));await mkdir(join(cwd,'.libtv'),{mode:0o700});
   const operationSignal=signal?AbortSignal.any([signal,lifecycle.signal]):lifecycle.signal;
   const status=await native(['status'],state.binding,cwd,operationSignal);
   if(status.exitCode!==0||status.records.length!==1||status.parseError||status.timedOut||status.cancelled)throw fail('company_cli_status_unavailable',503);
   checkOwner(ownerFromStatus(status.records[0]),state.binding.owner);
   if(state.uploadSha!==null&&state.uploadSha!==await checkedFile(prepared.body.file??prepared.body.attachment,state.binding.stagedAssets))throw fail('company_cli_staged_file_changed',409);
   if(prepared.method==='status'){output={...status,state:'completed'};return output;}
   const readOne=async argv=>{
    const value=await native(argv,state.binding,cwd,operationSignal);
    if(value.exitCode!==0||value.records.length!==1||value.timedOut||value.cancelled||value.parseError||value.outputTruncated)throw fail('company_cli_generation_inputs_unavailable',409);
    return value.records[0];
   };
   if(prepared.paid&&advancedKinds.has(prepared.method)){
    const capture=prepared.inputCapture,project=state.binding.canvasUuid;
    const currentProject=await readOne(['project',project]);
    if(companyCliDigest(currentProject)!==companyCliDigest(capture.snapshot.project))throw fail('company_cli_generation_inputs_changed',409);
    for(const node of capture.snapshot.nodes){const current=await readOne(['node',node.nodeKey,'--project',project]);if(companyCliDigest(current)!==companyCliDigest(node))throw fail('company_cli_generation_inputs_changed',409);}
    const metadataCommand=companyAdvancedMetadataCommand(capture.spec);
    if(metadataCommand){
     let current=await readOne(compile(normalize(metadataCommand)));
     if(prepared.method==='script_storyboard'){
      const models=Array.isArray(current)?current:record(current)&&Array.isArray(current.models)?current.models:record(current)&&Array.isArray(current.matches)?current.matches:[];
      const selected=models.filter(model=>model?.modelName===prepared.body.params.model);
      if(selected.length!==1||selected[0].modelKey!==capture.metadata.modelKey)throw fail('company_cli_advanced_model_unconfirmed',409);
      current=await readOne(['model',capture.metadata.modelKey]);
     }
     if(companyCliDigest(current)!==capture.metadata_sha256)throw fail('company_cli_generation_inputs_changed',409);
    }
    if(companyCliDigest(await readOne(['project',project]))!==companyCliDigest(capture.snapshot.project))throw fail('company_cli_generation_inputs_changed',409);
   }else if(prepared.paid){
    const capture=prepared.inputCapture,reads=[['node',prepared.body.node_id,'--project',state.binding.canvasUuid],['model',capture.metadata.modelKey],...capture.references.map(reference=>['node',textValue(reference.nodeKey,'node_id'),'--project',state.binding.canvasUuid])];
    for(let index=0;index<reads.length;index++){
     const current=await native(reads[index],state.binding,cwd,operationSignal),expected=index===0?capture.node:index===1?capture.metadata:capture.references[index-2];
     if(current.exitCode!==0||current.records.length!==1||current.timedOut||current.cancelled||current.parseError||companyCliDigest(current.records[0])!==companyCliDigest(expected))throw fail('company_cli_generation_inputs_changed',409);
    }
   }
   if(prepared.paid)checkOwner(ownerFromStatus(await readOne(['status'])),state.binding.owner);
   const result=await native(state.argv,state.binding,cwd,operationSignal);let outcome='unknown';
   if(!result.timedOut&&!result.cancelled&&!result.outputTruncated&&!result.parseError&&result.started){
    if(!prepared.paid)outcome=result.exitCode===0?'completed':'failed';
    else if(advancedKinds.has(prepared.method))outcome=advancedOutcome(result,prepared);
    else if(result.records.length===1&&result.records[0]?.nodeKey===prepared.body.node_id){const status=result.records[0].status;if(status===2&&result.exitCode===0)outcome='completed';else if([3,4].includes(status)&&result.exitCode!==null&&result.exitCode!==0)outcome='failed';}
   }
   output={...result,state:outcome};
   if(prepared.paid&&outcome==='completed'){
    const mediaOutputs=[],mediaCaptureErrors=[];
    const captureLimit=Math.max(0,Math.min(Math.floor(maxOutputBytes/2),maxOutputBytes-Buffer.byteLength(JSON.stringify(output))-4096));
    let captureBytes=2,failedCaptures=0;
    for(const candidate of resultMediaCandidates(prepared,result)){
     try{
      const direct=candidate.terminal&&urlsIn(candidate.terminal).length>0;
      const node=direct?candidate.terminal:await readOne(['node',textValue(candidate.nodeKey,'node_id'),'--project',state.binding.canvasUuid]);
      if(node?.nodeKey!==candidate.nodeKey||!direct&&node?.data?.type!==candidate.kind)throw fail('company_cli_output_node_mismatch',409);
      if(!direct&&typeof candidate.taskId==='string'){
       const task=node.data?.taskInfo,current=task?.taskId??task?.id??task?.uuid;
       if(current!==candidate.taskId)throw fail('company_cli_output_task_unconfirmed',409);
      }
      const urls=urlsIn(node);if(!urls.length||urls.length>100||urls.some(url=>typeof url!=='string'||!validMediaUrl(url)))throw fail('company_cli_output_url_unconfirmed',409);
      const nodeBytes=Buffer.byteLength(JSON.stringify(node)),estimatedBytes=urls.reduce((total,url)=>total+nodeBytes+Buffer.byteLength(url)+candidate.nodeKey.length+256,0);
      if(captureBytes+estimatedBytes>captureLimit)throw fail('company_cli_output_capture_limit',413);
      const captured=urls.map((url,outputIndex)=>({nodeKey:candidate.nodeKey,kind:candidate.kind,url,node,nodeSha256:companyCliDigest(node),outputIndex}));
      const combinedBytes=Buffer.byteLength(JSON.stringify([...mediaOutputs,...captured]));
      if(combinedBytes>captureLimit)throw fail('company_cli_output_capture_limit',413);
      captureBytes=combinedBytes;
      mediaOutputs.push(...captured);
     }catch(error){failedCaptures++;const failure={nodeKey:candidate.nodeKey,capture_error:error.code??'company_cli_output_capture_unavailable'};if(Buffer.byteLength(JSON.stringify([...mediaCaptureErrors,failure]))<=2048)mediaCaptureErrors.push(failure);}
    }
    output.mediaOutputs=mediaOutputs;
    if(mediaCaptureErrors.length)output.mediaCaptureErrors=mediaCaptureErrors;
    if(failedCaptures>mediaCaptureErrors.length)output.mediaCaptureErrorCount=failedCaptures;
   }
   return output;
  }finally{
   if(cwd){
    const rel=relative(resolve(workRoot),resolve(cwd));
    if(!rel||rel.startsWith('..')||isAbsolute(rel))throw fail('company_cli_invalid_cleanup_path',500);
    try{await rm(cwd,{recursive:true,force:true,maxRetries:3,retryDelay:50});}
    catch(error){if(output)output.cleanupPending=true;try{onCleanupError({code:'company_cli_cleanup_failed',errorCode:error.code??'unknown'});}catch(reportError){console.error('[muse-company-cli] Operation cleanup and its reporting need inspection.');}}
   }
   active--;
  }
 }
 function execute(prepared,{operationId},signal){
  const state=preparedStates.get(prepared);if(!state)throw fail('company_cli_unprepared_command',403);if(typeof operationId!=='string'||!/^[-\w]{1,128}$/u.test(operationId))throw fail('company_cli_invalid_operation_id');
  if(state.promise){if(state.operationId!==operationId)throw fail('company_cli_operation_conflict',409);return state.promise;}
  const key=`${state.binding.companyId}:${operationId}`,existing=operations.get(key);if(existing){if(existing.sha!==prepared.requestSha256)throw fail('company_cli_operation_conflict',409);state.promise=existing.promise;state.operationId=operationId;return existing.promise;}
  const promise=perform(prepared,state,signal);state.promise=promise;state.operationId=operationId;operations.set(key,{sha:prepared.requestSha256,promise});
  const settled=()=>operations.delete(key);void promise.then(settled,settled);return promise;
 }
 async function close(){closed=true;lifecycle.abort();for(const owned of children)owned.stop();await Promise.allSettled([...operations.values()].map(operation=>operation.promise));}
 return {prepare,execute,close};
}

/** Add project budget reservations after native admission, audio and postproduction planners. */
import {existsSync,readFileSync} from 'node:fs';
import {resolve} from 'node:path';
const replace=(source,before,after,file)=>{if(source.split(before).length!==2)throw Error('Muse budget patch does not match staged source: '+file);return source.replace(before,after);};

/** Plan monetary admission, task hooks and a studio-owned budget dialog without touching live data.
 * @param root Pinned upstream source root.
 * @param readSource Latest staged source after admission, audio, postproduction and package planners.
 * @returns File replacements; the caller owns publication and planner ordering.
 */
export function planMuseBudget(root,readSource=path=>readFileSync(path,'utf8')){
 const result=[];
 for(const[owned,destination]of [['muse-budget.cjs','backend-node/src/services/museBudget.js'],['muse-budget-routes.cjs','backend-node/src/routes/museBudgetRoutes.js'],['muse-budget-client.js','frontweb/src/utils/museBudget.js'],['muse-budget-panel.vue','frontweb/src/components/MuseBudgetPanel.vue'],['muse-budget-test-project.vue','frontweb/src/components/MuseBudgetTestProject.vue']]){
  const file=resolve(root,destination);if(existsSync(file))throw Error('Muse budget owned file already exists: '+destination);result.push([file,readFileSync(new URL('../extensions/'+owned,import.meta.url),'utf8').replaceAll('\r\n','\n')]);
 }
 const patch=(file,fn)=>{const path=resolve(root,file);result.push([path,fn(readSource(path).replaceAll('\r\n','\n'),file)]);};
 patch('backend-node/src/routes/index.js',(source,file)=>replace(source,"  const museAdmission = require('../services/museAdmission').register(r, db, cfg);","  const museAdmission = require('../services/museAdmission').register(r, db, cfg);\n  require('./museBudgetRoutes').register(r, db, cfg);",file));
 patch('backend-node/src/services/imageClient.js',(source,file)=>replace(source,'  const model = getModelFromConfig(config, preferredModel);',"  const model = getModelFromConfig(config, preferredModel);\n  require('./museBudget').nativeCall(db, require('../config').loadConfig(), 'image', config, model, opts);",file));
 patch('backend-node/src/services/videoClient.js',(source,file)=>replace(source,'  const model = normalizeVolcModel(getModelFromConfig(config, preferredModel), config);',"  const model = normalizeVolcModel(getModelFromConfig(config, preferredModel), config);\n  require('./museBudget').nativeCall(db, require('../config').loadConfig(), 'video', config, model, opts);",file));
 patch('backend-node/src/services/aiClient.js',(source,file)=>{
  const observer="require('./museAdmission').startSupplierCall();";if(source.split(observer).length!==4)throw Error('Muse budget supplier observers changed: '+file);source=source.replaceAll(observer,"require('./museAdmission').startSupplierCall(url,body);");
  const anchor='  const model = getModelFromConfig(config, effectivePreferredModel);';if(source.split(anchor).length!==3)throw Error('Muse budget text model selection changed: '+file);
  source=source.replaceAll(anchor,anchor+"\n  require('./museBudget').nativeCall(db, require('../config').loadConfig(), 'text', config, model);");
  return replace(source,'  const model = getModelFromConfig(config, preferredModel);',"  const model = getModelFromConfig(config, preferredModel);\n  require('./museBudget').nativeCall(db, require('../config').loadConfig(), 'text', config, model);",file);
 });
 patch('backend-node/src/services/aiConfigService.js',(source,file)=>{
  source=replace(source,'async function testConnection(opts) {','async function testConnection(opts, db, cfg) {',file);
  source=replace(source,'  const response = await fetch(url, {',"  const observeBudgetUsage=require('./museAdmission').startSupplierCall(url,body);\n  const response = await fetch(url, {",file);
  return replace(source,"  const data = await response.json().catch(() => null);","  const data = await response.json().catch(() => null);\n  observeBudgetUsage(data);",file);
 });
 patch('backend-node/src/routes/aiConfig.js',(source,file)=>{
  source=replace(source,'function testConnection(log) {','function testConnection(log, db, cfg) {',file);
  source=replace(source,'    testConnection: testConnection(log),','    testConnection: testConnection(log, db, cfg),',file);
  source=replace(source,'        api_protocol: body.api_protocol,\n      });','        api_protocol: body.api_protocol,\n      }, db, cfg);',file);
  return replace(source,"      log.error('AI config test connection failed', { error: err.message });","      if(typeof err.code==='string'&&err.code.startsWith('budget_'))return res.status(err.status??503).json({success:false,error:{code:err.code,message:'预算未批准本次文本测试，请选择项目并核对预算与有效价格。'}});\n      log.error('AI config test connection failed', { error: err.message });",file);
 });
 patch('backend-node/src/services/museAudioService.js',(source,file)=>replace(source," db.prepare('INSERT INTO muse_tts_generations(",` const budgetEntry=require('./museBudget').reserve(db,cfg,{source:'tts',operation_id:id,project_id:require('./museBudget').projectForRequest(db,'',{storyboard_id:sb.id}),request_sha256:hash,service:'tts',config_id:config.id,provider:config.provider,model:config.model,origin:new URL(config.base_url).origin,quantity:1,usage_basis:{characters:[...text].length}});
 if(!budgetEntry.dispatch_allowed)throw fail('budget_operation_requires_reconciliation',409);
 db.prepare('INSERT INTO muse_tts_generations(`,file));
 patch('backend-node/src/services/musePostproduction.js',(source,file)=>{
  source=replace(source,'  db.prepare(`INSERT INTO muse_postproduction_tasks(',`  const budgetEntry=require('./museBudget').reserve(db,cfg,{source:'fal',operation_id:id,project_id:current.drama_id,request_sha256:requestHash,service:'postproduction',config_id:provider.id,provider:'fal',model:fal.models[kind],origin:'https://queue.fal.run',quantity:segments.length});
 if(!budgetEntry.dispatch_allowed)throw fail('budget_operation_requires_reconciliation',409);
  db.prepare(\`INSERT INTO muse_postproduction_tasks(`,file);
  return replace(source,'async function continueSubmission(db,cfg,id,input){database(db,input.database_id);return await engine(db,cfg).dispatch(operation(id));}',`async function continueSubmission(db,cfg,id,input){database(db,input.database_id);const row=task(db,operation(id)),segments=parts(db,id);
 if(row.state!=='completed'&&!segments.some(part=>part.state==='unknown')&&segments.some(part=>['pending','upload_failed'].includes(part.state)))require('./museBudget').requireFalReservation(db,cfg,{operation_id:id,project_id:row.drama_id,request_sha256:row.request_sha256,config_id:row.config_id,model:row.model,quantity:segments.length});
 return await engine(db,cfg).dispatch(id);}`,file);
 });
 patch('frontweb/src/utils/request.js',(source,file)=>{
  source="import { withMuseBudgetProject } from './museBudget'\n"+source;
  return replace(source,"request.interceptors.request.use(async config => {\n  config.headers = { ...config.headers, ...await prepareMuseAdmission(config.url, config.method, config.data) }", "request.interceptors.request.use(async config => {\n  config=withMuseBudgetProject(config)\n  config.headers = { ...config.headers, ...await prepareMuseAdmission(config.url, config.method, config.data) }",file);
 });
 patch('frontweb/src/views/FilmCreate.vue',(source,file)=>{
  source=replace(source,'<script setup>\n',"<script setup>\nimport MuseBudgetPanel from '@/components/MuseBudgetPanel.vue'\nimport { setMuseBudgetProject } from '@/utils/museBudget'\nimport { watch as museBudgetWatch, unref as museBudgetUnref, onBeforeUnmount as museBudgetUnmount } from 'vue'\nconst museBudgetVisible=ref(false)\n",file);
  source=replace(source,'        <div class="header-actions">','        <div class="header-actions">\n          <el-button :disabled="!dramaId" @click="museBudgetVisible=true">项目预算与账目</el-button>',file);
  source=replace(source,'</script>',"const museBudgetStop=museBudgetWatch(()=>Number(museBudgetUnref(dramaId)),value=>setMuseBudgetProject(value),{immediate:true})\nmuseBudgetUnmount(()=>{museBudgetStop();setMuseBudgetProject(0)})\n</script>",file);
  return replace(source,'    <!-- 图片放大预览：点击遮罩或图片关闭 -->',`    <el-dialog v-model="museBudgetVisible" title="项目预算与账目" width="min(1060px, 94vw)" destroy-on-close :close-on-click-modal="false">
      <MuseBudgetPanel v-if="dramaId" :project-id="Number(dramaId)" />
    </el-dialog>

    <!-- 图片放大预览：点击遮罩或图片关闭 -->`,file);
 });
 patch('frontweb/src/components/AIConfigContent.vue',(source,file)=>{
  source=replace(source,'  <div class="ai-config-content">','  <div class="ai-config-content">\n    <MuseBudgetTestProject v-model="museBudgetTestProject" />',file);
  source=replace(source,'<script setup>\n',"<script setup>\nimport MuseBudgetTestProject from '@/components/MuseBudgetTestProject.vue'\nimport {museBudgetConnectionIsPaid} from '@/utils/museBudget'\nconst museBudgetTestProject=ref(null)\n",file);
  source=replace(source,'  testVisible.value = true',"  if(museBudgetConnectionIsPaid(row)&&!Number.isSafeInteger(museBudgetTestProject.value)){ElMessage.warning('请先选择文本测试费用归属项目，并明确设置预算与有效估价');return}\n  testVisible.value = true",file);
  return replace(source,'    const verification = await aiAPI.testConnection({','    const verification = await aiAPI.testConnection({\n      ...(museBudgetConnectionIsPaid(row)?{drama_id:museBudgetTestProject.value}:{}),',file);
 });
 return result;
}

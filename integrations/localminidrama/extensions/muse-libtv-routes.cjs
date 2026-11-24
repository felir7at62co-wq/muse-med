/** Account-local LibTV settings and task routes; no API keys appear in task responses. */
const service=require('../services/museLibTv'),http=require('../services/museLibTvHttp');
const answer=(res,status,value)=>res.status(status).json(value);
const messages={libtv_database_changed:'账号或制作数据库已变化，请刷新并重新选择项目。',libtv_submission_abandoned:'此提交编号已明确放弃，不会再派发；请读取原操作状态。',libtv_submission_not_abandonable:'原任务已经记录或结果未知，不能放弃提交编号；请接续原任务并查询供应商。',libtv_submission_abandonment_required:'请明确确认仅放弃尚未派发的提交编号。',libtv_previous_task_still_open:'这份 LibTV 凭据还有未结束任务，请继续查询原会话并核对供应商。',libtv_precise_controls_not_supported:'公开 LibTV Agent API 不提供可验证的模型、片长或正式声线参数，请使用受支持的直连协议。',libtv_not_configured:'请在当前账号的 LibTV API 配置中保存有效 Access Key。',libtv_credentials_changed:'此任务的供应商凭据已变化，请核对原配置，不能用新账号继续读取旧任务。',libtv_origin_refused:'请求来源不在审核通过的 API 或媒体列表中。',libtv_outbound_not_allowed:'管理员尚未允许此 LibTV API 或媒体来源出站，请先配置云端来源。',budget_limit_required:'请先在项目预算中明确设置本项目额度。',budget_price_unknown:'没有匹配的有效价格档案，请在项目预算中配置 LibTV 整任务预占估价。',budget_limit_exceeded:'项目可用预算不足，未知任务的预占不会自动释放；请先核对原账单。'};
Object.assign(messages,{libtv_project_binding_required:'请先预览并确认当前 Muse 项目的 LibTV 会话绑定，再提交任务。',libtv_binding_changed:'项目会话绑定已变化，请重新预览并确认。',libtv_binding_preview_changed:'会话预览或供应商凭据已变化，请重新读取。',libtv_context_acknowledgement_required:'请明确确认会话归属；默认会话还需要确认共享上下文风险。',libtv_session_already_bound:'此供应商会话或画布已绑定另一 Muse 项目，请选择独立会话。',libtv_project_changed:'供应商会话或画布身份不一致，请保留原任务编号并核对结果。'});
function register(router,db,cfg,log){
 service.schema(db);
 const route=(method,path,run)=>router[method](path,async(req,res)=>{try{const data=await run(req);answer(res,method==='post'&&path==='/muse/libtv/tasks'?202:200,{success:true,data})}catch(error){const known=/^(?:libtv_|budget_)/.test(error.code||'');answer(res,known?error.status||409:503,{success:false,error:{code:known?error.code:'libtv_operation_unconfirmed',message:messages[error.code]||'LibTV 操作未确认。请查看原任务和预算记录；不要重新提交生成。'}})}});
 const configurations=()=>require('../services/aiConfigService').listConfigs(db,'libtv').filter(c=>c.provider==='libtv').map(c=>({id:c.id,name:c.name,base_url:c.base_url,is_active:c.is_active,configured:Boolean(c.api_key)}));
 route('get','/muse/libtv/configs',()=>({database_id:service.schema(db),items:configurations(),protocol:'libtv-agent-im',documented_api_origin:'https://im.liblib.tv',precise_model_controls:false,supplier_terminal_reported:false}));
 route('post','/muse/libtv/configs',req=>{const b=req.body||{};if(b.database_id!==service.schema(db))throw http.fail('libtv_database_changed',409);const limits=http.limits(cfg),address=http.url(b.base_url||'https://im.liblib.tv',limits.api_origins,limits);if(address.pathname!=='/'||address.search||typeof b.name!=='string'||!b.name.trim()||b.name.length>100||typeof b.api_key!=='string'||!b.api_key||b.api_key.length>4096||/[\r\n]/.test(b.api_key))throw http.fail('libtv_invalid_config',400);
  const entry=require('../services/aiConfigService').createConfig(db,log,{name:b.name,service_type:'libtv',provider:'libtv',base_url:address.origin,api_key:b.api_key,model:[],is_active:true});return {id:entry.id,name:entry.name,configured:true};
 });
 route('get','/muse/libtv/tasks',req=>service.list(db,req.query.project_id));
 route('get','/muse/libtv/projects/:id/binding',req=>service.projectBinding(db,cfg,req.params.id,req.query));
 route('post','/muse/libtv/projects/:id/binding/preview',req=>service.previewBinding(db,cfg,req.params.id,req.body||{}));
 route('post','/muse/libtv/projects/:id/binding',req=>service.bindProject(db,cfg,req.params.id,req.body||{}));
 route('get','/muse/libtv/submissions/:id',req=>service.submission(db,req.params.id));
 route('post','/muse/libtv/submissions/:id/abandon',req=>service.abandonSubmission(db,req.params.id,req.body||{}));
 route('get','/muse/libtv/references',req=>service.referenceSources(db,req.query.project_id));
 route('post','/muse/libtv/references/resolve',req=>service.resolveReference(db,cfg,req.body||{}));
 route('post','/muse/libtv/tasks',req=>service.start(db,cfg,req.body||{}));
 route('get','/muse/libtv/tasks/:id',req=>service.get(db,req.params.id));
 route('post','/muse/libtv/tasks/:id/observe',req=>service.observe(db,cfg,req.params.id));
 route('post','/muse/libtv/tasks/:id/confirm',req=>service.confirm(db,cfg,req.params.id,req.body||{}));
 route('post','/muse/libtv/tasks/:id/results/:result/import',req=>service.importResult(db,cfg,req.params.id,req.params.result,req.body||{}));
}
module.exports={register};

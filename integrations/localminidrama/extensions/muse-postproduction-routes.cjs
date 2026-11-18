/** Private provider configuration and public, credential-free video operation HTTP adapters. */
const response=require('../response'),service=require('../services/musePostproduction');
function register(router,db,cfg,log){
 service.schema(db);service.limits(cfg);
 const call=work=>async(req,res)=>{try{response.success(res,await work(req));}catch(error){
  const code=typeof error.code==='string'&&/^[a-z_]+$/.test(error.code)?error.code:'postproduction_unconfirmed';
  response.error(res,error.status||503,code,'视频后期未确认（'+code+'）。请核对原任务；未配置、超过去字幕时长或媒体未通过校验时不会自动提交新请求。');}};
 router.get('/muse/postproduction/capabilities',call(()=>service.capabilities(db,cfg)));
 router.post('/muse/postproduction/config',call(req=>service.saveConfig(db,cfg,log,req.body||{})));
 router.get('/muse/postproduction/sources',call(req=>service.sources(db,req.query)));
 router.get('/muse/postproduction/sources/:id/inspect',call(req=>service.inspect(db,cfg,req.params.id)));
 router.get('/muse/postproduction/tasks',call(req=>service.history(db,req.query)));
 router.post('/muse/postproduction/tasks',call(req=>service.submit(db,cfg,req.body||{})));
 router.post('/muse/postproduction/tasks/:id/continue',call(req=>service.continueSubmission(db,cfg,req.params.id,req.body||{})));
 router.get('/muse/postproduction/tasks/:id',call(req=>service.readTask(db,req.params.id)));
 router.post('/muse/postproduction/tasks/:id/refresh',call(req=>service.refresh(db,cfg,req.params.id)));
 router.post('/muse/postproduction/tasks/:id/adopt',call(req=>service.adopt(db,cfg,req.params.id,req.body||{})));
}
module.exports={register};

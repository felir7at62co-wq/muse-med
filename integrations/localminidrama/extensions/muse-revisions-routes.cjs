/** Read and restore only the current worker's whitelisted business revisions. */
const response=require('../response');
const revisions=require('../services/museRevisions');
function register(router,db,cfg){
 revisions.schema(db,cfg);
 const handle=run=>(req,res)=>{try{response.success(res,run(req));}catch(error){const code=typeof error.code==='string'&&/^[a-z_]+$/.test(error.code)?error.code:'revision_operation_not_confirmed';
  response.error(res,error.status??503,code,'编辑记录操作未确认（'+code+'）。请刷新当前版本后重试。');}};
 router.get('/muse/revisions/entities',handle(req=>revisions.listEntities(db,cfg,req.query)));
 router.get('/muse/revisions/history',handle(req=>revisions.history(db,cfg,req.query)));
 router.get('/muse/revisions/usage',handle(req=>revisions.usage(db,cfg,req.query)));
 router.post('/muse/revisions/restore',handle(req=>revisions.restore(db,cfg,req.body||{})));
}
module.exports={register};

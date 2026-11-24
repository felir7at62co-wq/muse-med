/** Authenticated tenant CLI receipts and verified uploads; no server process or supplier request is launched. */
const service=require('../services/museLibTvCli');
function register(router,db,cfg){service.schema(db,cfg);const handle=fn=>async(req,res)=>{try{res.json({success:true,data:await fn(req)})}catch(error){const known=typeof error.code==='string'&&/^(?:libtv_cli_|budget_)/.test(error.code);res.status(known?error.status??409:503).json({success:false,error:{code:known?error.code:'libtv_cli_operation_unconfirmed',message:'CLI 记录或媒体导入未确认，请保留原操作与分块；未知预占不会自动释放，不要重新运行生成。'}});}};
 router.get('/muse/libtv-cli/capabilities',handle(()=>service.capabilities(db,cfg)));
 router.post('/muse/libtv-cli/operations/reserve',handle(req=>service.reserve(db,cfg,req.body??{})));
 router.get('/muse/libtv-cli/operations/:id',handle(req=>service.get(db,cfg,req.params.id)));
 router.post('/muse/libtv-cli/operations/:id/review',handle(req=>service.review(db,cfg,req.params.id,req.body??{})));
 router.post('/muse/libtv-cli/operations/:id/status',handle(req=>service.status(db,cfg,req.params.id,req.body??{})));
 router.post('/muse/libtv-cli/operations/:id/chunks',handle(req=>service.chunk(db,cfg,req.params.id,req.body??{})));
 router.post('/muse/libtv-cli/operations/:id/import',handle(req=>service.importResult(db,cfg,req.params.id,req.body??{})));
}
module.exports={register};

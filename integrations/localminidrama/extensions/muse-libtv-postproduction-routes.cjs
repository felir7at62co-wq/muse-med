/** Source inspection is public to its tenant; only the internal account gateway imports paid LibTV results. */
const service=require('../services/museLibTvPostproduction');
function register(router,db,cfg){
 const handle=fn=>async(req,res)=>{try{res.json({success:true,data:await fn(req)})}catch(error){const known=typeof error.code==='string'&&/^(libtv_postproduction_|postproduction_)/.test(error.code);res.status(known?error.status??409:503).json({success:false,error:{code:known?error.code:'libtv_postproduction_import_unconfirmed',message:'去字幕结果尚未确认，请保留原任务与原片；导入可免费重试，勿重复付费生成。'}});}};
 router.get('/muse/libtv-postproduction/sources/:id/inspect',handle(req=>service.inspect(db,cfg,Number(req.params.id))));
 router.post('/muse/libtv-postproduction/internal/imports',handle(req=>service.importResult(db,cfg,req.body??{})));
}
module.exports={register};

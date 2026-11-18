/** Authenticated tenant-local structured-plan operations; no generation dispatch occurs here. */
const plans=require('../services/museProductionPlan');
const adoption=require('../services/museProductionAdoption');
function register(router,db,cfg){
 const route=(method,path,action)=>router[method](path,(req,res)=>{
  try{res.json({success:true,data:action(req)})}
  catch(error){if(typeof error.code==='string'&&/^(?:plan|adoption)_/.test(error.code))res.json({success:true,data:{status:error.code.endsWith('_snapshot_changed')?'conflict':'refused',code:error.code,message:error.message,issues:error.issues??[],paid_requests:0}});
   else res.status(500).json({success:false,error:{code:'plan_storage_unavailable',message:'Plan storage is unavailable; inspect the original operation before continuing.'}})}
 });
 const base='/muse/production-plans';
 route('get',base+'/capabilities',()=>plans.capabilities(db,cfg));
 route('get',base+'/cli/:id',req=>plans.readCli(db,cfg,req.params.id));
 route('get',base+'/imports/:id',req=>plans.getImport(db,cfg,req.params.id));
 route('get',base+'/adoptions/:id',req=>adoption.get(db,{operation_id:req.params.id}));
 route('get',base+'/namespaces/:namespace',req=>plans.current(db,cfg,req.params.namespace));
 route('post',base+'/preview',req=>plans.preview(db,cfg,req.body??{}));
 route('post',base+'/apply',req=>plans.apply(db,cfg,req.body??{}));
 route('post',base+'/adopt-preview',req=>adoption.preview(db,cfg,req.body??{}));
 route('post',base+'/adopt-apply',req=>adoption.apply(db,cfg,req.body??{}));
}
module.exports={register};

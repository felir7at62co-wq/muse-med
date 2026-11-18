/** Tenant-local Studio editing and trace reads never dispatch a supplier generation. */
const inputs=require('../services/museStudioInputs'),studio=require('../services/museStudio');
function register(router,db,cfg){inputs.schema(db,cfg);const route=(method,path,work)=>router[method](path,async(req,res)=>{try{res.json({success:true,data:await work(req)})}catch(error){res.status(error.status??503).json({success:false,error:{code:typeof error.code==='string'&&error.code.startsWith('studio_')?error.code:'studio_operation_unconfirmed',message:'版本操作未确认，请保留原输入和操作标识，核对原记录后再继续。',committed:error.committed??'unknown'}})}});
 route('get','/muse/studio/capabilities',()=>({schemaVersion:2,databaseId:inputs.schema(db,cfg),boundPromptVersion:1,immutableAssetVersions:true,assetKinds:['character','scene','prop','storyboard'],storyboardAssetVersion:1,chunkBytes:inputs.limits(cfg).chunk_bytes}));
 route('get','/muse/studio/projects/:id/trace',req=>studio.projectTrace(db,cfg,req.params.id,req.query));
 route('get','/muse/studio/packages/:id',req=>studio.packageTrace(db,cfg,req.params.id,req.query));
 route('post','/muse/studio/packages/:id/revisions',req=>inputs.saveRevision(db,cfg,req.params.id,req.body??{}));
 route('post','/muse/studio/packages/:id/prepare',req=>inputs.prepare(db,cfg,req.params.id,req.body??{}));
 route('post','/muse/studio/packages/:id/adopt',req=>studio.adopt(db,cfg,req.params.id,req.body??{}));
 route('post','/muse/studio/assets/versions',req=>inputs.assetVersion(db,cfg,req.body??{}));
 route('get','/muse/studio/assets/versions/:id',req=>{const row=db.prepare('SELECT * FROM muse_studio_asset_versions WHERE version_id=?').get(req.params.id);if(!row)throw inputs.fail('studio_binding_unknown',404);inputs.project(db,row.project_id);return inputs.publicVersion(row,cfg)});
 route('get','/muse/studio/assets/versions/:id/chunks',req=>inputs.chunk(db,cfg,req.params.id,req.query.index));
 route('get','/muse/studio/operations/:id',req=>inputs.getOperation(db,cfg,req.params.id));
 router.use(inputs.middleware(db,cfg));
}
module.exports={register};

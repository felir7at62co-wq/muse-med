/** Authenticated account-worker routes for explicit, free exchange import and chunk recovery. */
const service=require('../services/museJubianImport');
function register(router,db,cfg){
 service.schema(db,cfg);
 const call=work=>(req,res)=>{try{res.json({success:true,data:work(req)})}catch(error){const code=typeof error.code==='string'&&/^[a-z_]+$/.test(error.code)?error.code:'migration_not_confirmed';res.status(error.status??503).json({success:false,error:{code,message:'迁移未确认（'+code+'）。请保留原清单、分块及操作编号，核对后继续；未覆盖原项目或源文件。'}})}};
 router.get('/muse/migration/jubian/capabilities',call(()=>service.capabilities(db,cfg)));
 router.get('/muse/migration/jubian/uploads/:id',call(req=>service.uploadInfo(db,req.params.id)));
 router.post('/muse/migration/jubian/chunks',call(req=>service.uploadChunk(db,cfg,req.body||{})));
 router.post('/muse/migration/jubian/preview',call(req=>service.preview(db,cfg,req.body?.manifest)));
 router.post('/muse/migration/jubian/reserve',call(req=>service.reserve(db,cfg,req.body||{})));
 router.post('/muse/migration/jubian/import',call(req=>service.importProject(db,cfg,req.body||{})));
 router.get('/muse/migration/jubian/imports/:id',call(req=>{const found=db.prepare('SELECT mapping_json FROM muse_jubian_imports WHERE operation_id=?').get(req.params.id);if(!found)throw Object.assign(Error('migration_import_not_found'),{code:'migration_import_not_found',status:404});return JSON.parse(found.mapping_json)}));
}
module.exports={register};

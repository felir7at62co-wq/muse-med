/** Account-selected project archives expose bounded free reads, checkpoints and new-project restores. */
const archive=require('../services/museProjectArchive');
function number(value){if(typeof value!=='string'||!/^\d+$/.test(value)||!Number.isSafeInteger(Number(value))||Number(value)<1)throw Object.assign(Error('project_archive_invalid_id'),{code:'project_archive_invalid_id',status:400});return Number(value);}
function body(value,keys){if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!keys.includes(key)))throw Object.assign(Error('project_archive_invalid_request'),{code:'project_archive_invalid_request',status:400});return value;}
function register(router,db,cfg){const service=archive.service(db,cfg),root='/muse/project-archives';
 const route=(method,path,work)=>router[method](root+path,async(req,res)=>{try{res.json({success:true,data:await work(req)});}catch(error){res.status(error.status??503).json({success:false,error:{code:typeof error.code==='string'&&error.code.startsWith('project_archive_')?error.code:'project_archive_unavailable'}});}});
 route('get','/capabilities',()=>service.capabilities());
 route('get','/projects',req=>service.listProjects(req.query.page===undefined?1:number(req.query.page),req.query.page_size===undefined?50:number(req.query.page_size)));
 route('get','/projects/:id/manifests',req=>service.list(number(req.params.id),req.query.page===undefined?1:number(req.query.page),req.query.page_size===undefined?50:number(req.query.page_size)));
 route('get','/projects/:id/manifests/:revision',req=>service.get(number(req.params.id),number(req.params.revision)));
 route('post','/projects/:id/checkpoint',req=>{body(req.body??{},[]);return service.checkpoint(number(req.params.id));});
 route('post','/projects/:id/documents',req=>service.document(number(req.params.id),body(req.body,['operation_id','name','mime_type','sha256','data_base64'])));
 route('post','/projects/:id/manifests/:revision/verify',req=>{body(req.body??{},[]);return service.verify(number(req.params.id),number(req.params.revision));});
 route('get','/projects/:id/manifests/:revision/files/:sha/chunks',req=>service.chunk(number(req.params.id),number(req.params.revision),req.params.sha,req.query.index===undefined?0:Number(req.query.index)));
 route('get','/projects/:id/manifests/:revision/export/chunks',req=>service.manifestChunk(number(req.params.id),number(req.params.revision),req.query.index===undefined?0:Number(req.query.index)));
 route('post','/restore',req=>service.restore(body(req.body,['operation_id','source_project_id','revision','title'])));
}
module.exports={register};

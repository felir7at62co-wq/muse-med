/** Disable supplier access while retaining native project, asset and history storage. */
const catalog=require('./museAdmissionCatalog.json');
const additional=[
 /^\/ai-configs\/(?:test|jimeng2-list-assets|model-ark-asset)$/,
 /^\/characters\/[0-9]+\/(?:sd2-certify(?:\/refresh)?|sd2-voice-upload|sd2-voice-refresh|add-to-material-library)$/,
 /^\/(?:props|scenes)\/[0-9]+\/add-to-material-library$/,
 /^\/episodes\/[0-9]+\/characters\/extract$/,
 /^\/images\/(?:episode\/[0-9]+\/batch|scene\/[0-9]+|[0-9]+\/resume-download)$/,
 /^\/videos\/(?:image\/[0-9]+|episode\/[0-9]+\/batch|[0-9]+\/resume-poll)$/,
 /^\/storyboards\/(?:batch-infer-params|[0-9]+\/(?:upscale|rebuild-video-prompt|split-by-audio))$/,
 /^\/audio\/extract(?:\/batch)?$/,
 /^\/agent\/(?:chat|approve)$/,
 /^\/muse\/audio\/tts(?:\/[0-9]+\/recover)?$/,
 /^\/muse\/postproduction\/tasks(?:\/[0-9]+\/(?:continue|refresh))?$/,
];

/** Resolve the deployment-owned switch; an environment disable cannot be enabled by stored model credentials. */
function enabled(cfg,env=process.env){
 const flag=env.MUSE_STANDALONE_NO_AI;
 if(flag!==undefined&&flag!=='0'&&flag!=='1')throw Error('MUSE_STANDALONE_NO_AI must be 0 or 1');
 const configured=cfg?.muse_generation?.enabled;
 if(configured!==undefined&&typeof configured!=='boolean')throw Error('muse_generation.enabled must be a boolean');
 return flag!=='1'&&configured!==false;
}

/** Refuse a direct supplier client call even when it did not enter through an HTTP route. */
function assertEnabled(cfg){
 if(!enabled(cfg))throw Object.assign(Error('生成后端尚未配置。'),{code:'generation_backend_not_configured',status:503});
}

/** Resolve startup-recovery eligibility from the same deployment file used by native services. */
function backgroundEnabled(){return enabled(require('../config').loadConfig());}

/** Match requests that can contact a generation supplier, including reads which poll existing provider tasks. */
function blocks(req){
 const pathname=decodeURIComponent(req.path.split('?')[0]).replace(/\/+$/,'').toLowerCase()||'/';
 if(/^\/muse\/jubian(?:\/|$)/.test(pathname))return true;
 if(req.method==='GET'&&/^\/storyboards\/episode\/[0-9]+\/generate$/.test(pathname))return true;
 if(req.method!=='POST')return false;
 if(pathname==='/dramas/import-novel')return req.body?.ai_summarize===true||req.body?.ai_summarize==='true';
 return catalog.some(item=>new RegExp(item.pattern).test(pathname))||additional.some(pattern=>pattern.test(pathname));
}

/** Install before model routes so disabled generation never reads model credentials or creates a task. */
function register(router,cfg){
 const active=enabled(cfg);
 router.get('/muse/generation/status',(_req,res)=>res.json({success:true,data:{enabled:active,backend:active?'configured':'unconfigured'}}));
 const guard=(req,res,next)=>{
  if(active)return next();
  let denied;
  try{denied=blocks(req);}catch(_error){return res.status(400).json({success:false,error:{code:'invalid_generation_path',message:'The request path is invalid.'}});}
  if(!denied)return next();
  return res.status(503).json({success:false,error:{code:'generation_backend_not_configured',message:'生成后端尚未配置，项目、资产和历史仍可管理。'}});
 };
 router.use(guard);
 return guard;
}

module.exports={enabled,assertEnabled,backgroundEnabled,blocks,register};

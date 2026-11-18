/** HTTP adapters for durable audio operations; public failures never include provider bodies or credentials. */
const response=require('../response');
const audio=require('../services/museAudioService');
function routes(db,log,cfg){
 audio.schema(db);
 const call=work=>async(req,res)=>{try{response.success(res,await work(req));}catch(error){const code=typeof error.code==='string'&&/^[a-z_]+$/.test(error.code)?error.code:'audio_operation_failed';
  response.error(res,error.status??503,code,'声音操作未确认（'+code+'）。请核对原操作记录，不要重复提交生成。');}};
 const handlers={
  extract:call(req=>audio.generate(db,log,cfg,req.body||{})),
  extractBatch:call(async req=>{const body=req.body||{};if(!/^[A-Za-z0-9_-]{1,96}$/.test(body.operation_id)||!Array.isArray(body.storyboard_ids)||body.storyboard_ids.length>100)throw Object.assign(Error('invalid_audio_batch'),{code:'invalid_audio_batch',status:400});
   const items=[];for(const id of body.storyboard_ids)items.push(await audio.generate(db,log,cfg,{...body,storyboard_id:id,operation_id:body.operation_id+'-'+id}));return {items};}),
 };
 handlers.register=r=>{
  r.get('/muse/audio/capabilities',call(req=>audio.capabilities(db,req.query)));
  r.get('/muse/audio/voices',call(req=>audio.listVoices(db,req.query)));
  r.post('/muse/audio/voices',require('./upload').multerAudioSingle,call(req=>audio.uploadVoice(db,cfg,req.body||{},req.file?.buffer)));
  r.post('/muse/audio/voices/:id/adopt',call(req=>audio.adoptVoice(db,cfg,req.params.id,req.body||{})));
  r.get('/muse/audio/video-bindings/:id',call(req=>audio.getVideoBinding(db,req.params.id)));
  r.put('/muse/audio/video-bindings/:id',call(req=>audio.bindVideo(db,cfg,req.params.id,req.body||{})));
  r.get('/muse/audio/video-inputs',call(req=>audio.listVideoInputs(db,req.query)));
  r.get('/muse/audio/tts',call(req=>audio.listTts(db,req.query)));
  r.post('/muse/audio/tts',handlers.extract);
  r.get('/muse/audio/tts/:id',call(req=>audio.ttsRow(db,req.params.id)));
  r.post('/muse/audio/tts/:id/recover',call(req=>audio.recover(db,cfg,req.params.id,req.body||{})));
  r.post('/muse/audio/tts/:id/cancel',call(req=>audio.cancelTts(db,req.params.id,req.body||{})));
  r.post('/muse/audio/tts/:id/adopt',call(req=>audio.adoptTts(db,cfg,req.params.id,req.body||{})));
 };
 return handlers;
}
module.exports=routes;

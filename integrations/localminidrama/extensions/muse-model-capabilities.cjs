/** Public model limits from explicit configuration or an exact documented Ark model profile. */
const officialSource='https://docs.volcengine.com/docs/ark/create-video-generation-task-api?lang=zh&redirect=1';
function isSeedance25(model){return /^doubao-seedance-2[._-]5-\d{6}$/i.test(String(model||''));}
function settings(config){if(config.settings&&typeof config.settings==='object')return config.settings;try{return JSON.parse(config.settings||'{}');}catch(error){return {};}}
function configured(config,model){return settings(config)?.muse_model_capabilities?.[model];}
function seedance25(config,model){return isSeedance25(model)||configured(config||{},model)?.profile==='seedance-2.5';}
function seedance25Duration(value){
 if(value===undefined||value===null||value==='')return 5;
 const duration=Number(value);
 if(!Number.isInteger(duration)||duration!==-1&&(duration<4||duration>30))throw new Error('Seedance 2.5 单包时长必须是 4–30 整数秒或 -1 自动时长；请拆成多个制作包，不要截短整集');
 return duration;
}
function capabilitiesForConfig(config){
 const protocol=String(config.api_protocol||config.provider||'').toLowerCase();
 const volc=['volcengine','volcengine_omni','volces','volc'].includes(protocol);
 let official=false;try{official=new URL(config.base_url).origin==='https://ark.cn-beijing.volces.com';}catch(error){/* Unknown endpoints have no inferred official profile. */}
 return (Array.isArray(config.model)?config.model:[]).map(model=>{
  const explicit=configured(config,model),profile=volc&&((official&&isSeedance25(model))||explicit?.profile==='seedance-2.5');
  if(profile)return {model,protocol,profile:'seedance-2.5',max_duration_seconds:30,min_duration_seconds:4,default_resolution:'720p',source:explicit?'configured':officialSource};
  if(explicit&&Number.isInteger(explicit.max_duration_seconds)&&explicit.max_duration_seconds>=1&&explicit.max_duration_seconds<=3600
    &&typeof explicit.default_resolution==='string'&&/^[A-Za-z0-9_-]{1,32}$/.test(explicit.default_resolution)){
   return {model,protocol,profile:null,max_duration_seconds:explicit.max_duration_seconds,default_resolution:explicit.default_resolution,source:'configured'};
  }
  return {model,protocol,profile:null,max_duration_seconds:null,default_resolution:null,source:'unknown'};
 });
}
module.exports={isSeedance25,seedance25,seedance25Duration,capabilitiesForConfig};

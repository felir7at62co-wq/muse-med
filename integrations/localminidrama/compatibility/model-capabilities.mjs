/** Preserve Seedance 2.5 request duration and expose documented or explicitly configured per-model limits. */
import {existsSync,readFileSync} from 'node:fs'
import {resolve} from 'node:path'
const replace=(source,before,after,file)=>{if(source.split(before).length!==2)throw Error('Muse model capability patch does not match pinned source: '+file);return source.replace(before,after)}
/**
 * Plan model capability metadata and exact Seedance 2.5 duration handling.
 * @param root - Pinned upstream checkout.
 * @param readSource - Current sources after the existing compatibility planners.
 * @returns Complete replacements without supplier calls or credential exposure.
 */
export function planModelCapabilities(root,readSource=path=>readFileSync(path,'utf8')){
 const result=[],owned=resolve(root,'backend-node/src/services/museModelCapabilities.js');
 if(existsSync(owned))throw Error('Muse model capability owned module already exists');
 result.push([owned,readFileSync(new URL('../extensions/muse-model-capabilities.cjs',import.meta.url),'utf8')]);
 const patch=(file,fn)=>{const path=resolve(root,file);result.push([path,fn(readSource(path).replaceAll('\r\n','\n'),file)])};
 patch('backend-node/src/services/videoClient.js',(source,file)=>{
  source=replace(source,"const fs = require('fs');","const fs = require('fs');\nconst {seedance25,seedance25Duration}=require('./museModelCapabilities');",file);
  source=replace(source,'function normalizeVolcengineDuration(modelName, durationNum) {',"function normalizeVolcengineDuration(modelName, durationNum, config) {\n  if(seedance25(config,modelName))return seedance25Duration(durationNum);",file);
  source=replace(source,'function normalizeVolcOmniDuration(modelName, durationNum) {\n  return normalizeVolcengineDuration(modelName, durationNum);','function normalizeVolcOmniDuration(modelName, durationNum, config) {\n  return normalizeVolcengineDuration(modelName, durationNum, config);',file);
  source=replace(source,'normalizeVolcOmniDuration(finalModel, duration);','normalizeVolcOmniDuration(finalModel, duration, config);',file);
  source=replace(source,'normalizeVolcengineDuration(finalModel, rounded);','normalizeVolcengineDuration(finalModel, seedance25(config,finalModel)?duration:rounded, config);',file);
  source=replace(source,"  if (volcTaskType) body.task_type = volcTaskType;","  if (volcTaskType) body.task_type = volcTaskType;\n  if (isVolc && seedance25(config,finalModel) && hasAnyFrame) { body.ratio='adaptive'; delete body.aspect_ratio; }",file);
  source=replace(source,'      if (isKling) {\n        if (data.code',`      try { require('./museAdmission').recordResourceUsage(db,'video',videoGenId,data,taskId); }
      catch(error){if(error.code!=='supplier_usage_not_saved')throw error;log.warn('Supplier usage could not be saved; original video observation continues', {video_gen_id:videoGenId});}
      if (isKling) {
        if (data.code`,file);
  return source;
 });
 patch('backend-node/src/services/aiConfigService.js',(source,file)=>{
  source=replace(source,"const fs = require('fs');","const fs = require('fs');\nconst {capabilitiesForConfig}=require('./museModelCapabilities');",file);
  return replace(source,'  // TTS 配置：从 settings JSON 展开 voice_id / group_id 供 ttsService 直接读取','  cfg.model_capabilities=capabilitiesForConfig(cfg);\n  // TTS 配置：从 settings JSON 展开 voice_id / group_id 供 ttsService 直接读取',file);
 });
 return result;
}

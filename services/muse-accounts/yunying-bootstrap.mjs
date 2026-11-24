/** Optional startup-only bootstrap for an already-open globalModels instance; isolated prototype. */
import {lstat,open} from 'node:fs/promises';
import {constants} from 'node:fs';
import {dirname,basename} from 'node:path';
const route='yunying';
const ids=['gemini-3.1-pro','gpt-6.1-sol'];
function validProvider(provider,ref){
 if(!Array.isArray(provider?.models)||provider.models.some(m=>!m||typeof m!=='object'))return false;
 if(!/^MUSE_YUNYING_RECOVERY_[A-F0-9]{24,64}$/.test(ref)||!provider||provider.api!=='openai-completions'||provider.baseURL!=='https://wy6688.token6688.com/v1'||provider.apiKeyEnv!==ref||!Array.isArray(provider.models)||JSON.stringify(provider.models.map(x=>x.id).sort())!==JSON.stringify(ids))return false;
 return provider.models.every(m=>Number.isSafeInteger(m.contextWindow)&&Number.isSafeInteger(m.maxTokens)&&m.maxTokens>0&&m.maxTokens<m.contextWindow&&m.contextWindow<=2000000);
}
/** All failures are redacted and do not prevent the caller's normal startup; uncertain writes are not retried. */
export async function bootstrap({models,provider,ref,keyPath,expectedUid=process.getuid()}){
 let wrote=false;
 try{
  if(!validProvider(provider,ref))return {status:'invalid-candidate'};
  const before=models.view(),providers=before.value.providers;
  if(Object.hasOwn(providers,route))return {status:'provider-exists-skipped'};
  if(Object.values(providers).some(p=>p.apiKeyEnv===ref)||models.describeCredentials([ref])[ref].configured)return {status:'credential-ref-occupied'};
  if(typeof keyPath!=='string'||basename(keyPath)!=='key')return {status:'private-file-rejected'};
  const parent=await lstat(dirname(keyPath)),st=await lstat(keyPath);
  if(!parent.isDirectory()||parent.isSymbolicLink()||parent.uid!==expectedUid||(parent.mode&0o777)!==0o700||!st.isFile()||st.isSymbolicLink()||st.uid!==expectedUid||(st.mode&0o777)!==0o600||st.nlink!==1)return {status:'private-file-rejected'};
  const file=await open(keyPath,constants.O_RDONLY|constants.O_NOFOLLOW);let key;
  try{const current=await file.stat();if(current.dev!==st.dev||current.ino!==st.ino||!current.isFile()||current.uid!==expectedUid||(current.mode&0o777)!==0o600||current.nlink!==1)return {status:'private-file-rejected'};key=await file.readFile('utf8');}finally{await file.close();}
  if(!key||key.length>4096||/[^\x21-\x7e]/.test(key))return {status:'credential-rejected'};
  const latest=models.view();if(latest.revision!==before.revision||Object.hasOwn(latest.value.providers,route)||Object.values(latest.value.providers).some(p=>p.apiKeyEnv===ref)||models.describeCredentials([ref])[ref].configured)return {status:'changed-before-write'};
  wrote=true;await models.setCredential(ref,key);
  await models.mutate({ns:'llm-pi-ai',expectedRevision:before.revision,ops:[{op:'set',path:['providers',route],value:provider}]});
  const view=models.view();
  if(view.revision!==before.revision+1||JSON.stringify(view.value.providers[route])!==JSON.stringify(provider))return {status:'reconcile-required'};
  return {status:'configured',revision:view.revision};
 }catch{return {status:wrote?'reconcile-required':'unavailable'};}
}

/** Release-bound proposal; capacities are provisional channel assumptions requiring long-context validation. */
export const RECOVERY_REF='MUSE_YUNYING_RECOVERY_F3B0D79D1AF1B9E461ECE6EEFF9E3FF8';
export const RECOVERY_KEY_PATH='/var/lib/muse/accounts/yunying-bootstrap-20261030/key';
export const RECOVERY_PROVIDER=Object.freeze({displayName:'云映',baseURL:'https://wy6688.token6688.com/v1',api:'openai-completions',apiKeyEnv:RECOVERY_REF,models:[
 {id:'gpt-6.1-sol',name:'GPT-6.1 Sol',contextWindow:1050000,maxTokens:128000,input:['text','image']},
 {id:'gemini-3.1-pro',name:'Gemini 3.1 Pro',contextWindow:1048576,maxTokens:65536,input:['text','image']},
]});
export async function bootstrapRelease({models,keyPath,expectedUid=process.getuid(),allowedPath=RECOVERY_KEY_PATH}){
 if(keyPath!==allowedPath)return {status:'private-file-rejected'};
 return bootstrap({models,keyPath,expectedUid,provider:RECOVERY_PROVIDER,ref:RECOVERY_REF});
}

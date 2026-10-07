/** Selected Muse account models; vendor credentials never belong in this module. */
import {baseAddress} from './model-relay.mjs';
import {validateGlobalModelDocument} from './global-models.mjs';

/** Public wire IDs supplied by the selected Yunying account route. */
export const YUNYING_MODEL_IDS = Object.freeze([
 'gpt-6-sol', 'gpt-6-astra', 'claude-opus-5-5',
 'claude-fable-5-1', 'claude-sonnet-5', 'gemini-3.1-pro',
]);

/** Verified supplier origin; inherited credentials cannot move to another host. */
export const YUNYING_API_ORIGIN = 'https://wy6688.token6688.com';

function yunyingAddress(value){
 const address=baseAddress(value);
 if(new URL(address).origin!==YUNYING_API_ORIGIN)throw Error('Yunying API root must retain the verified supplier origin');
 return address;
}

/** Build the eight-model account catalog with explicit output and reasoning settings.
 * @param {string} yunyingBaseURL The operator's configured Yunying Chat Completions API root.
 * @returns {object} Detached provider settings containing credential references, never keys.
 */
export function selectedModelProviders(yunyingBaseURL){
 const official = (id,name,input) => ({id,name,contextWindow:1048576,maxTokens:393216,input,
  reasoningEfforts:{off:null,low:'low',high:'high',max:'max'},defaultReasoningEffort:'low'});
 const cloud = (id) => ({id,name:id,
  contextWindow:id.startsWith('claude-')?1000000:128000,maxTokens:32768,
  input:id.startsWith('claude-')?['text','image']:['text'],
  reasoningEfforts:id.startsWith('gpt-')?{low:'low'}:false,
  ...id.startsWith('gpt-')?{defaultReasoningEffort:'low'}:{}});
 return {
  'deepseek-official':{displayName:'DeepSeek 官方',baseURL:'https://api.deepseek.com/v1',
   api:'openai-completions',apiKeyEnv:'MUSE_DEEPSEEK_API_KEY',models:[
    official('deepseek-flash','DeepSeek Flash',['text','image']),
    official('deepseek-v4-pro','DeepSeek V4 Pro',['text']),
   ]},
  yunying:{displayName:'云映',baseURL:yunyingAddress(yunyingBaseURL),api:'openai-completions',
   apiKeyEnv:'MUSE_YUNYING_API_KEY',models:YUNYING_MODEL_IDS.map(cloud)},
 };
}

const keyOK = value => typeof value==='string'&&value.length>0&&value.length<=4096&&!/[^\x21-\x7e]/.test(value);

/** Prepare a private replacement directory while retaining unrelated stored credentials.
 * @param {object} current Valid version-two directory, unchanged by this operation.
 * @param {object} inputs Optional operator overrides; omitted Yunying settings reuse a matching private route.
 * @returns {object} A new directory with exactly eight shared models and incremented revisions.
 * @throws {Error} Required credentials, a unique Yunying endpoint, or a valid directory are missing.
 */
export function prepareSelectedModels(current,{yunyingBaseURL,yunyingKey,deepseekKey}={}){
 validateGlobalModelDocument(current);
 const inherited=Object.values(current.providers).filter(provider=>new URL(provider.baseURL).origin===YUNYING_API_ORIGIN
  &&provider.models.some(model=>YUNYING_MODEL_IDS.includes(model.id)));
 const endpoints=new Set(inherited.map(provider=>baseAddress(provider.baseURL)));
 const keys=new Set(inherited.map(provider=>current.credentials[provider.apiKeyEnv]).filter(keyOK));
 const base=yunyingBaseURL??(endpoints.size===1?[...endpoints][0]:undefined);
 const cloudKey=yunyingKey??current.credentials.MUSE_YUNYING_API_KEY??(keys.size===1?[...keys][0]:undefined);
 const officialKey=deepseekKey??current.credentials.MUSE_DEEPSEEK_API_KEY??current.credentials.DEEPSEEK_API_KEY;
 if(!base)throw Error('Yunying API root is missing or ambiguous');
 if(!keyOK(cloudKey)||!keyOK(officialKey))throw Error('Selected model credentials are missing or invalid');
 if(current.revision===Number.MAX_SAFE_INTEGER||current.metadataRevision===Number.MAX_SAFE_INTEGER)throw Error('Model directory revision cannot be incremented');
 const next={...structuredClone(current),revision:current.revision+1,metadataRevision:current.metadataRevision+1,
  providers:selectedModelProviders(base),credentials:{...current.credentials,
   MUSE_DEEPSEEK_API_KEY:officialKey,MUSE_YUNYING_API_KEY:cloudKey}};
 validateGlobalModelDocument(next);
 return next;
}

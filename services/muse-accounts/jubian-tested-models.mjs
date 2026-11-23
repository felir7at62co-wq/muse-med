/** Add the approved Jubian models to an isolated native model directory. */
import {validateGlobalModelDocument} from './global-models.mjs';

/** Account gateway route ID for the verified Jubian model catalog. */
export const JUBIAN_TESTED_PROVIDER = 'jubian-tested';
const origin = 'https://gw.jubianai.net';
const source = origin+'/v1';
const testedModels = [
 ...[
  ['claude-haiku-5-5','Claude Haiku 5.5'], ['claude-sonnet-5-5','Claude Sonnet 5.5'],
  ['claude-opus-5-5','Claude Opus 5.5'], ['claude-fable-5-2','Claude Fable 5.2'],
 ].map(([id,name])=>({id,name,contextWindow:200000,maxTokens:32000,input:['text'],reasoningEfforts:false})),
];

/** Build an additive private directory for the model pilot.
 * @param {object} current Valid native model directory, kept unchanged.
 * @param {object} options Existing Jubian credential reference in the isolated directory.
 * @returns {object} New directory with one additional provider and incremented revisions.
 * @throws {Error} The pilot route exists, the key is missing, or the directory is invalid.
 */
export function addJubianTestedModels(current,{credentialRef}){
 validateGlobalModelDocument(current);
 if(Object.hasOwn(current.providers,JUBIAN_TESTED_PROVIDER))throw Error('Jubian pilot route already exists');
 if(typeof credentialRef!=='string'||!Object.hasOwn(current.credentials,credentialRef)
  ||typeof current.credentials[credentialRef]!=='string'||!/^[\x21-\x7e]{1,4096}$/.test(current.credentials[credentialRef])){
  throw Error('Jubian pilot requires a private credential reference');
 }
 const belongsToJubian=Object.values(current.providers).some(provider=>provider.apiKeyEnv===credentialRef
  &&new URL(provider.baseURL).origin===origin);
 if(!belongsToJubian)throw Error('Jubian pilot requires a credential already bound to the Jubian origin');
 if(current.revision===Number.MAX_SAFE_INTEGER||current.metadataRevision===Number.MAX_SAFE_INTEGER){
  throw Error('Model directory revision cannot be incremented');
 }
 const next=structuredClone(current);
 next.revision++;
 next.metadataRevision++;
 next.providers[JUBIAN_TESTED_PROVIDER]={displayName:'Jubian',baseURL:source,api:'openai-completions',
  apiKeyEnv:credentialRef,models:structuredClone(testedModels)};
 validateGlobalModelDocument(next);
 return next;
}

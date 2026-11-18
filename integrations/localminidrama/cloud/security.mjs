/** Cloud-only request admission for the pinned studio's local media and API routes. */
import {posix} from 'node:path';

/** Studio failures expose only fixed codes, never child output or private paths. */
export class StudioError extends Error{
 constructor(code,status=503){super(code);this.name='StudioError';this.code=code;this.status=status;}
}
const apiRoots=new Set(['dramas','episodes','ai-configs','generation','character-library','scene-library','prop-library','characters','props','extract-description-from-image','upload','tasks','scenes','images','videos','video-merges','assets','storyboards','audio','settings','scene-model-map']);

/** Validate a stripped worker URL and refuse helpers outside the production UI.
 * @param {string} raw URL after removing exactly one /studio prefix.
 * @returns {string} Original validated URL, preserving query bytes.
 */
export function workerPath(raw){
 if(typeof raw!=='string'||!raw.startsWith('/')||raw.startsWith('//'))throw new StudioError('studio_invalid_path',400);
 let decoded;try{decoded=decodeURIComponent(raw.split('?')[0]);}catch(error){throw new StudioError('studio_invalid_path',400);}
 if(decoded.includes('\\')||/[\x00-\x1f\x7f]/.test(decoded)||decoded.split('/').some(part=>part==='.'||part==='..'))throw new StudioError('studio_invalid_path',400);
 const url=new URL(raw,'http://127.0.0.1');for(const key of url.searchParams.keys())if(/^(?:account_?id|tenant(?:_?id)?|user_?id)$/i.test(key))throw new StudioError('studio_invalid_path',400);
 const lower=decoded.toLowerCase();
 if(lower.startsWith('/api/')&&(!lower.startsWith('/api/v1/')||!apiRoots.has(lower.slice('/api/v1/'.length).split('/')[0])&&!/^\/api\/v1\/muse\/(?:audio|packages|admission|revisions|postproduction|budget|jubian|edit|migration|production-plans|project-archives|studio)(?:\/|$)/.test(lower)))throw new StudioError('studio_route_unavailable',404);
 if(/^\/(?:agent|mastra|cloud|admin|account|helper)(?:\/|\.|$)/i.test(decoded))throw new StudioError('studio_route_unavailable',404);
 return raw;
}
function mediaReference(value){
 if(typeof value!=='string'||!value.trim())return;const text=value.trim();
 if(/^https?:\/\//i.test(text)){const url=new URL(text);if(url.username||url.password)throw new StudioError('studio_invalid_media_path',400);return;}
 if(/^data:(?:image|audio|video)\//i.test(text)||/^asset:\/\//i.test(text))return;
 let local;try{local=decodeURIComponent(text);}catch(error){throw new StudioError('studio_invalid_media_path',400);}
 local=local.replace(/^\/(?:studio\/)?static\//,'');
 if(local.includes('\\')||local.includes('\0')||local.startsWith('/')||/^[A-Za-z][A-Za-z0-9+.-]*:/.test(local)||local.split('/').some(part=>part==='..'||part==='.'))throw new StudioError('studio_invalid_media_path',400);
 if(posix.normalize(local)!==local)throw new StudioError('studio_invalid_media_path',400);
}

/** Refuse local-media references escaping the caller's storage; transcript strings stay untouched.
 * @param {unknown} body Already parsed request JSON.
 */
export function validateLocalMedia(body){
 function visit(value,key=''){
  if(value===null)return;
  const local=/(?:local_?path|file_?path)$/i.test(key)||key==='path';
  const media=/^(?:url|image_url|video_url|audio_url|first_frame_url|last_frame_url|reference_image_urls|reference_urls|reference_images|extra_images)$/i.test(key);
  if((local||media)&&typeof value==='string'){
   if((key==='extra_images'||key==='reference_images')&&value.trim().startsWith('[')){let items;try{items=JSON.parse(value);}catch(error){throw new StudioError('studio_invalid_media_path',400);}if(!Array.isArray(items))throw new StudioError('studio_invalid_media_path',400);for(const item of items){mediaReference(item);if(item&&typeof item==='object')visit(item);}}
   else mediaReference(value);
  }
  if(Array.isArray(value)){for(const item of value){if(local||media)mediaReference(item);if(!local&&!media||item&&typeof item==='object')visit(item);}return;}
  if(typeof value==='object')for(const [name,item]of Object.entries(value))visit(item,name);
 }
 visit(body);
}

/** Resolve this account's temporary generation references locally, without changing adopted asset fields.
 * @param {unknown} body Parsed generation JSON, updated in place.
 * @param {string} path Worker API pathname.
 * @param {string} publicOrigin Configured Muse Origin.
 */
export function localGenerationReferences(body,path,publicOrigin){
 if(!body||typeof body!=='object'||!/^\/api\/v1\/(?:images(?:\/|$)|videos(?:\/|$)|[^?]*generate)/.test(path))return;
 const local=value=>{if(typeof value!=='string')return value;if(value.startsWith('/studio/static/'))return new URL(value,publicOrigin).pathname.slice('/studio'.length);if(!/^https?:\/\//i.test(value))return value;const url=new URL(value);return url.origin===publicOrigin&&url.pathname.startsWith('/studio/static/')?url.pathname.slice('/studio'.length):value;};
 for(const name of ['image_url','first_frame_url','last_frame_url'])if(Object.hasOwn(body,name))body[name]=local(body[name]);
 for(const name of ['reference_urls','reference_image_urls','reference_images'])if(Array.isArray(body[name]))body[name]=body[name].map(local);
}

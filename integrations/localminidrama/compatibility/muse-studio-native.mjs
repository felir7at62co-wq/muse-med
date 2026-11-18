/** Capture final native adapter arguments after legacy reference/prompt resolution. */
import {existsSync,readFileSync} from 'node:fs';
import {resolve} from 'node:path';
function once(source,before,after,label){if(source.split(before).length!==2)throw Error('Studio native dispatch patch differs from pinned source: '+label);return source.replace(before,after);}
/**
 * Pin bound inputs and record actual native dispatches without changing CLI execution.
 * @param root Pinned companion checkout.
 * @param readSource Earlier compatibility planners' complete source.
 * @returns One owned adapter plus exact image/video service patches.
 */
export function planMuseStudioNative(root,readSource=path=>readFileSync(path,'utf8')){
 const file=resolve(root,'backend-node/src/services/museStudioNative.js');if(existsSync(file))throw Error('Studio native adapter already exists');const result=[[file,readFileSync(new URL('../extensions/muse-studio-native.cjs',import.meta.url),'utf8')]];
 const image=resolve(root,'backend-node/src/services/imageService.js');let value=readSource(image).replaceAll('\r\n','\n');
 value=once(value,"    const imageServiceType = row.storyboard_id ? 'storyboard_image' : 'image';","    const imageServiceType = row.storyboard_id ? 'storyboard_image' : 'image';\n    const museStudioNative=require('./museStudioNative');\n    const museStudioBound=museStudioNative.bound(db,require('../config').loadConfig(),'image',imageGenId);",'image bound input');
 value=once(value,'    if (isSingleStoryboard && row.prompt) {','    if (!museStudioBound && isSingleStoryboard && row.prompt) {','bound image polish');
 value=once(value,'    const result = await imageClient.callImageApi(db, log, {',"    const result = await imageClient.callImageApi(db, log, museStudioNative.capture(db,require('../config').loadConfig(),'image',imageGenId,{",'image adapter input');
 value=once(value,"      frame_identity_lock: isFrameIdentityLock,\n    });","      frame_identity_lock: isFrameIdentityLock,\n    },museStudioBound));",'image adapter result');result.push([image,value]);
 const video=resolve(root,'backend-node/src/services/videoService.js');value=readSource(video).replaceAll('\r\n','\n');
 value=once(value,'    const result = await videoClient.callVideoApi(db, log, {',"    const result = await videoClient.callVideoApi(db, log, require('./museStudioNative').capture(db,require('../config').loadConfig(),'video',videoGenId,{",'video adapter input');
 value=once(value,'      video_gen_id: videoGenId,\n    });','      video_gen_id: videoGenId,\n    }));','video adapter result');result.push([video,value]);return result;
}

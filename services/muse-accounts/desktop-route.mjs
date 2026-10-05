/** Device-specific public mounts keep every browser tab on its own desktop. */
const uuid=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;

/** @param {unknown} value Installation identifier. @returns {boolean} Whether it is a canonical UUID. */
export const validDeviceId=value=>typeof value==='string'&&uuid.test(value);

/** @param {string} id Validated installation identifier. @returns {string} Public mount with its trailing slash. */
export function desktopPrefix(id){if(!validDeviceId(id))throw Error('Invalid desktop identifier');return `/desktop/${id}/`;}

/**
 * Parse a device mount without accepting normalized paths that escape it.
 * @param {string} raw Browser request target.
 * @returns {{deviceId:string,prefix:string,path:string}|null} Mount and origin request target, or null for central routes.
 */
export function desktopRoute(raw){
 if(!raw.startsWith('/desktop/'))return null;
 const url=new URL(raw,'http://muse.invalid');
 const match=/^\/desktop\/([^/]+)(\/.*)?$/.exec(url.pathname);
 if(!match||!validDeviceId(match[1])||!raw.startsWith(`/desktop/${match[1]}`))throw Object.assign(Error('Invalid desktop mount'),{status:400});
 const prefix=desktopPrefix(match[1]);
 if(match[2]&& !raw.startsWith(prefix))throw Object.assign(Error('Invalid desktop mount'),{status:400});
 return {deviceId:match[1],prefix,path:(match[2]||'/')+url.search};
}

/** Optional private deployment policy for native Jubian company admission. */
import {lstat,readFile} from 'node:fs/promises';
import {isAbsolute} from 'node:path';
import {openNativeJubianAdmission} from './native-jubian-admission.mjs';

/** Read an explicitly configured administrator policy without changing existing project or fee stores.
 * @param {string|undefined} file Absolute private JSON configuration; absence disables this authority.
 * @param {object} options Current account reader and optional native signature verifier.
 * @returns {Promise<object|undefined>} Dedicated admission owner, or undefined when not configured.
 */
export async function loadNativeJubianAdmission(file,options){
 if(file===undefined)return;
 const invalid=()=>Object.assign(Error('native_jubian_admission_private_configuration_required'),{code:'native_jubian_admission_private_configuration_required',status:500});
 if(typeof file!=='string'||!isAbsolute(file)||file.includes('\0'))throw invalid();
 const info=await lstat(file);
 if(!info.isFile()||info.isSymbolicLink()||info.size>1048576||process.platform!=='win32'&&(info.mode&0o077)!==0)throw invalid();
 return openNativeJubianAdmission({...options,config:JSON.parse(await readFile(file,'utf8'))});
}

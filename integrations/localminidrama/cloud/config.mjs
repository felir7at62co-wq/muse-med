/** Private, optional deployment configuration for account-isolated studio workers. */
import {readFile,lstat,realpath} from 'node:fs/promises';
import {isAbsolute,resolve,relative,join,sep} from 'node:path';
import {createRequire} from 'node:module';

const fields=['version','nodeExecutable','backendRoot','webDistRoot','tenantRoot','outboundOrigins','trustedLocalOrigins','limits'];
const limits=['maxActiveInstances','maxConcurrentStarts','maxRequestsPerAccount','maxRequestsTotal','maxOutboundRequests','maxRequestBytes','maxTenantBytes','startupTimeoutMs','requestTimeoutMs','idleTimeoutMs','idleSweepMs','shutdownGraceMs'];
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const within=(root,path)=>{const value=relative(root,path);return value===''||value!=='..'&&!value.startsWith('..'+sep)&&!isAbsolute(value);};

/** Validate the complete studio deployment JSON without opening any tenant database.
 * @param {unknown} value Administrator-authored configuration.
 * @returns {object} Detached deployment fields and validated limits.
 */
export function resolveStudioConfig(value){
 if(!object(value)||Object.keys(value).some(key=>!fields.includes(key))||fields.some(key=>!Object.hasOwn(value,key))||value.version!==1)throw new Error('Invalid Muse studio configuration');
 const result={version:1};for(const key of ['nodeExecutable','backendRoot','webDistRoot','tenantRoot']){if(typeof value[key]!=='string'||!isAbsolute(value[key])||value[key].includes('\0'))throw new Error('Muse studio paths must be absolute');result[key]=resolve(value[key]);}
 for(const key of ['outboundOrigins','trustedLocalOrigins']){if(!Array.isArray(value[key])||value[key].length>256||new Set(value[key]).size!==value[key].length)throw new Error('Invalid Muse studio outbound origins');result[key]=value[key].map(raw=>{if(typeof raw!=='string')throw new Error('Invalid Muse studio outbound origin');const url=new URL(raw);if(!['https:','http:'].includes(url.protocol)||url.origin!==raw||url.username||url.password)throw new Error('Invalid Muse studio outbound origin');return raw;});}
 if(result.trustedLocalOrigins.some(raw=>!result.outboundOrigins.includes(raw))||result.outboundOrigins.some(raw=>new URL(raw).protocol!=='https:'&&!result.trustedLocalOrigins.includes(raw)))throw new Error('HTTP studio providers require an explicit trusted local origin');
 if(!object(value.limits)||Object.keys(value.limits).some(key=>!limits.includes(key))||limits.some(key=>!Number.isSafeInteger(value.limits[key])||value.limits[key]<(key==='idleTimeoutMs'?0:1)))throw new Error('Muse studio limits must be explicitly configured');
 result.limits={...value.limits};if(result.limits.maxConcurrentStarts>result.limits.maxActiveInstances||result.limits.maxRequestsPerAccount>result.limits.maxRequestsTotal||result.limits.maxRequestBytes>result.limits.maxTenantBytes)throw new Error('Inconsistent Muse studio limits');
 if(within(result.backendRoot,result.tenantRoot)||within(result.tenantRoot,result.backendRoot)||within(result.webDistRoot,result.tenantRoot)||within(result.tenantRoot,result.webDistRoot))throw new Error('Muse studio data must be separate from served source');
 return result;
}

/** Load an optional owner-only studio configuration; absence leaves studio routes disabled.
 * @param {string|undefined} file MUSE_STUDIO_CONFIG absolute JSON filename.
 * @returns {Promise<object|undefined>} Validated deployment, or undefined when not configured.
 */
export async function loadStudioConfig(file){
 if(file===undefined)return;if(typeof file!=='string'||!isAbsolute(file))throw new Error('MUSE_STUDIO_CONFIG must be absolute');
 const info=await lstat(file);if(!info.isFile()||info.isSymbolicLink()||info.size>65536||process.platform!=='win32'&&(info.mode&0o077)!==0)throw new Error('MUSE_STUDIO_CONFIG must be a private regular JSON file');
 const config=resolveStudioConfig(JSON.parse(await readFile(file,'utf8')));
 for(const [key,type]of [['nodeExecutable','file'],['backendRoot','directory'],['webDistRoot','directory']]){const path=await realpath(config[key]),entry=await lstat(path);if(type==='file'?!entry.isFile():!entry.isDirectory())throw new Error('Muse studio deployment path unavailable');config[key]=path;}
 for(const path of [join(config.backendRoot,'src/app.js'),join(config.backendRoot,'package.json'),join(config.webDistRoot,'index.html')])if(!(await lstat(path)).isFile())throw new Error('Muse studio deployment is incomplete');
 const require=createRequire(join(config.backendRoot,'package.json'));for(const dependency of ['express','js-yaml','better-sqlite3','undici','ipaddr.js'])require.resolve(dependency);
 return resolveStudioConfig(config);
}

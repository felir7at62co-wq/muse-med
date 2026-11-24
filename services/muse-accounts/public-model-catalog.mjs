/** Expose the selected company models, or every configured provider by explicit opt-in, while retaining private route resolution. */
const catalogs=['selected','all'];
// Reroute target of saved yunying/gpt-6.1-sol sessions in global-models.mjs; never listed on its own.
const hiddenRoutes=['jubian-gpt'];

/** Validate a public catalog policy.
 * @param {string} catalog `selected` lists only the company's chosen routes and models; `all` lists every configured provider.
 * @returns {string} The validated policy.
 * @throws {Error} Any other value.
 */
export function publicModelCatalog(catalog){
 if(!catalogs.includes(catalog))throw Error('Invalid public model catalog: expected selected or all');
 return catalog;
}

/** Read `MUSE_PUBLIC_MODEL_CATALOG`; absence keeps the selected company models.
 * @param {object} env Deployment settings.
 * @returns {string} `selected` or `all`.
 * @throws {Error} The setting is present with any other value, including an empty one.
 */
export function resolvePublicModelCatalog(env={}){
 const value=env.MUSE_PUBLIC_MODEL_CATALOG;
 if(value===undefined)return 'selected';
 if(!catalogs.includes(value))throw Error('MUSE_PUBLIC_MODEL_CATALOG must be selected or all; remove it to publish only the selected company models');
 return value;
}

/** Project the published providers of a private model directory.
 * @param {object|undefined} metadata Private directory metadata.
 * @param {string} [catalog] Validated policy; defaults to the selected company models.
 * @returns {object|undefined} Metadata with only published providers, or undefined without a directory.
 */
export function publicModelMetadata(metadata,catalog='selected'){
 publicModelCatalog(catalog);
 if(metadata===undefined)return;
 if(catalog==='all'){
  if(!hiddenRoutes.some(route=>Object.hasOwn(metadata.providers??{},route)))return metadata;
  return {...metadata,providers:Object.fromEntries(Object.entries(metadata.providers).filter(([route])=>!hiddenRoutes.includes(route)))};
 }
 const providers={};
 if(metadata.providers?.['deepseek-official'])providers['deepseek-official']=metadata.providers['deepseek-official'];
 const ark=metadata.providers?.['volcengine-ark'];
 if(ark){const models=ark.models.filter(model=>['glm-5.3-flash-260828','deepseek-v4-1-flash-261017'].includes(model.id));if(models.length)providers['volcengine-ark']={...ark,models};}
 const yunying=metadata.providers?.yunying;
 if(yunying){const allowed=new Set(['gpt-6.1-sol','gemini-3.1-pro']);const models=yunying.models.filter(model=>allowed.has(model.id));if(models.length)providers.yunying={...yunying,models};}
 const bailian=metadata.providers?.['alibaba-bailian'];
 if(bailian){const models=bailian.models.filter(model=>model.id==='deepseek-v4.1-flash-1017');if(models.length)providers['alibaba-bailian']={...bailian,models};}
 {const p=metadata.providers?.jubian;if(p?.models?.length)providers.jubian=p;}
 return {...metadata,providers};
}

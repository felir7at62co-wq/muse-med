/** Validated application ownership and explicitly granted shared ASR capacity. */
const positive=value=>Number.isSafeInteger(value)&&value>0;
const identifier=value=>typeof value==='string'&&/^[a-z][a-z0-9-]{0,63}$/.test(value);
const text=value=>typeof value==='string'&&value.trim().length>0;
const application=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(value);
const invalid=()=>{throw Error('Invalid MUSE ASR resource configuration');};

/**
 * Resolve a single legacy application or a declared pool without multiplying shared grants.
 * @param input Private deployment configuration or injected provider options.
 * @param privateCredentials Whether every resource must contain server-only access credentials.
 * @returns Resources, shared quota groups, a stable legacy default and the total worker limit.
 */
export function resolveAsrResources(input,privateCredentials=false){
 const legacy=input.resources===undefined;
 const resources=legacy?[{poolId:'default',appId:input.appId??'legacy-default',accessToken:input.accessToken,quotaGroup:'default',maxConcurrentJobs:input.maxConcurrentJobs??5,provider:input.provider}]:input.resources;
 const quotaGroups=legacy?[{id:'default',maxConcurrentJobs:input.maxConcurrentJobs??5}]:input.quotaGroups;
 const defaultPoolId=legacy?'default':input.defaultPoolId;
 if(!Array.isArray(resources)||!resources.length||!Array.isArray(quotaGroups)||!quotaGroups.length||!identifier(defaultPoolId))invalid();
 const groups=new Map(),pools=new Map(),applications=new Map();
 for(const group of quotaGroups){
  if(!group||!identifier(group.id)||groups.has(group.id)||!positive(group.maxConcurrentJobs)||['maxDailyJobs','maxDailySeconds'].some(key=>group[key]!==undefined&&!positive(group[key])))invalid();
  groups.set(group.id,{...group});
 }
 for(const resource of resources){
  if(!resource||!identifier(resource.poolId)||pools.has(resource.poolId)||!application(resource.appId)||!groups.has(resource.quotaGroup)||!positive(resource.maxConcurrentJobs)||privateCredentials&&!text(resource.accessToken))invalid();
  const prior=applications.get(resource.appId);
  // Different keys for one application retain the same capacity and billing group.
  if(prior&&(prior.quotaGroup!==resource.quotaGroup||prior.maxConcurrentJobs!==resource.maxConcurrentJobs))invalid();
  applications.set(resource.appId,resource);pools.set(resource.poolId,{...resource});
 }
 if(!pools.has(defaultPoolId)||legacy&&(input.maxConcurrentJobs??5)>5)invalid();
 if(!legacy&&input.appId!==undefined&&input.appId!==pools.get(defaultPoolId).appId)invalid();
 let capacity=0;
 for(const group of groups.values()){
  const apps=new Map();
  for(const resource of pools.values())if(resource.quotaGroup===group.id)apps.set(resource.appId,Math.max(apps.get(resource.appId)??0,resource.maxConcurrentJobs));
  if(!apps.size)invalid();
  capacity+=Math.min(group.maxConcurrentJobs,[...apps.values()].reduce((sum,value)=>sum+value,0));
 }
 const maxConcurrentJobs=input.maxConcurrentJobs??capacity;
 if(!positive(capacity)||!positive(maxConcurrentJobs)||maxConcurrentJobs>capacity)invalid();
 const legacyAppId=input.legacyAppId??input.appId??(legacy?pools.get(defaultPoolId).appId:undefined);
 if(legacyAppId!==undefined&&!application(legacyAppId))invalid();
 return {resources:[...pools.values()],quotaGroups:[...groups.values()],defaultPoolId,maxConcurrentJobs,legacyAppId};
}

/**
 * Resolve a durable application's exact provider; old receipts use only the configured default.
 * @param job Private durable job receipt.
 * @param resources Map of currently configured resource IDs.
 * @param defaultPoolId Application retained for receipts written before resource pooling.
 * @returns The original resource; missing or changed referents stop recovery.
 */
export function resourceForJob(job,resources,defaultPoolId){
 const legacy=job.poolId===undefined&&job.appId===undefined&&job.quotaGroup===undefined;
 const resource=resources.get(legacy?defaultPoolId:job.poolId);
 if(!resource)throw Error('ASR receipt resource is missing from configuration');
 if(!legacy&&job.appId!==resource.appId)throw Error('ASR receipt application has changed');
 if(!legacy&&job.quotaGroup!==resource.quotaGroup)throw Error('ASR receipt quota group has changed');
 return resource;
}

/** Validated application ownership and explicitly granted shared ASR capacity. */
const positive=value=>Number.isSafeInteger(value)&&value>0;
const identifier=value=>typeof value==='string'&&/^[a-z][a-z0-9-]{0,63}$/.test(value);
const text=value=>typeof value==='string'&&value.trim().length>0;
const application=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(value);
const invalid=()=>{throw Error('Invalid MUSE ASR resource configuration');};
const serviceIds={flash:'volc.bigasr.auc_turbo','standard-v1':'volc.bigasr.auc','standard-v2':'volc.seedasr.auc'};

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
  if((group.rollingAudioWindowSeconds===undefined)!==(group.maxRollingAudioSeconds===undefined)||group.rollingAudioWindowSeconds!==undefined&&(!positive(group.rollingAudioWindowSeconds)||!positive(group.maxRollingAudioSeconds)))invalid();
  groups.set(group.id,{...group});
 }
 for(const resource of resources){
  if(!resource||!identifier(resource.poolId)||pools.has(resource.poolId)||!application(resource.appId)||!groups.has(resource.quotaGroup)||!positive(resource.maxConcurrentJobs)||privateCredentials&&!text(resource.accessToken))invalid();
  const serviceVersion=resource.serviceVersion??(input.providerKind==='flash'?'flash':'standard-v1'),resourceId=resource.resourceId??serviceIds[serviceVersion];
  if(!Object.hasOwn(serviceIds,serviceVersion)||resourceId!==serviceIds[serviceVersion])invalid();
  const applicationService=resource.appId+'\0'+resourceId,prior=applications.get(applicationService);
  // Different keys for one application retain the same capacity and billing group.
  if(prior&&(prior.quotaGroup!==resource.quotaGroup||prior.maxConcurrentJobs!==resource.maxConcurrentJobs))invalid();
  applications.set(applicationService,resource);pools.set(resource.poolId,{...resource,serviceVersion,resourceId});
 }
 if(!pools.has(defaultPoolId)||legacy&&(input.maxConcurrentJobs??5)>5)invalid();
 if(!legacy&&input.appId!==undefined&&input.appId!==pools.get(defaultPoolId).appId)invalid();
 let capacity=0;
 for(const group of groups.values()){
  const apps=new Map();
  for(const resource of pools.values())if(resource.quotaGroup===group.id)apps.set(resource.appId+'\0'+resource.resourceId,Math.max(apps.get(resource.appId+'\0'+resource.resourceId)??0,resource.maxConcurrentJobs));
  if(!apps.size)invalid();
  if([...pools.values()].some(resource=>resource.quotaGroup===group.id&&resource.serviceVersion!=='flash')){
   group.submitQps??=10;group.queryQps??=10;
   if(!positive(group.submitQps)||!positive(group.queryQps)||group.submitQps+group.queryQps>20)invalid();
  }else if(group.submitQps!==undefined||group.queryQps!==undefined)invalid();
  capacity+=Math.min(group.maxConcurrentJobs,[...apps.values()].reduce((sum,value)=>sum+value,0));
 }
 const maxConcurrentJobs=input.maxConcurrentJobs??capacity;
 if(!positive(capacity)||!positive(maxConcurrentJobs)||maxConcurrentJobs>capacity)invalid();
 const legacyAppId=input.legacyAppId??input.appId??(legacy?pools.get(defaultPoolId).appId:undefined);
 if(legacyAppId!==undefined&&!application(legacyAppId))invalid();
 const mixed=[...pools.values()].some(resource=>resource.serviceVersion!==pools.get(defaultPoolId).serviceVersion);
 const routes=input.routes??(mixed?{subtitles:'flash',screenplay:'standard-v2'}:{subtitles:pools.get(defaultPoolId).serviceVersion,screenplay:pools.get(defaultPoolId).serviceVersion});
 if(!routes||Object.keys(routes).some(key=>!['subtitles','screenplay'].includes(key))||['subtitles','screenplay'].some(key=>!Object.hasOwn(serviceIds,routes[key])||![...pools.values()].some(resource=>resource.serviceVersion===routes[key])))invalid();
 if(mixed&&(routes.subtitles!=='flash'||!['standard-v1','standard-v2'].includes(routes.screenplay)))invalid();
 return {resources:[...pools.values()],quotaGroups:[...groups.values()],defaultPoolId,maxConcurrentJobs,legacyAppId,routes};
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
 const serviceVersion=job.serviceVersion??(job.providerKind==='flash'?'flash':'standard-v1');
 if(job.serviceVersion!==undefined&&(job.providerKind==='flash')!==(serviceVersion==='flash'))throw Error('ASR receipt provider kind conflicts with its service version');
 if(job.purpose!==undefined&&!['subtitles','screenplay'].includes(job.purpose))throw Error('Invalid ASR receipt purpose');
 if(resource.serviceVersion!==serviceVersion||job.resourceId!==undefined&&job.resourceId!==resource.resourceId)throw Error('ASR receipt service version has changed');
 return resource;
}

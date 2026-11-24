/** Keep synchronization bound to a verified enterprise administrator identity. */
import {createFeishuOrgSync} from './feishu-organization.mjs';
const id=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,256}$/.test(value);
const empty=()=>({status:'unavailable',updatedAt:null,departments:[],accounts:{}});

/**
 * Keep organization synchronization bound to the enabled administrators' current verified Feishu identities.
 * @param {object} options Feishu app credentials, account store, optional fetch and clock, and concurrency limit.
 * @returns {object} Synchronous fail-closed snapshot, serialized refresh, and async close.
 */
export function createFeishuOrgCoordinator({config,store,fetchImpl=fetch,now=Date.now,concurrency=4}={}){
 if(!config||config.appType!=='custom'||!id(config.appId)||typeof config.appSecret!=='string'||config.appSecret.length<16||!store||typeof store.list!=='function')throw Error('Invalid Feishu organization coordinator configuration');
 let active,pending,pendingKey,rerun=false,closed=false,closing=Promise.resolve();
 const unavailable=()=>({...empty(),syncing:Boolean(pending)});
 function anchor(){
  try{
   const administrators=store.list().filter(account=>account.admin&&!account.disabled);
   const identities=administrators.flatMap(admin=>(admin.feishuIdentities??[]).filter(identity=>identity.appId===config.appId).map(identity=>({adminId:admin.id,openId:identity.openId,tenantKey:identity.tenantKey})));
   if(!identities.length||identities.some(identity=>!id(identity.adminId)||!id(identity.openId)||!id(identity.tenantKey)))return null;
   const tenants=new Set(identities.map(identity=>identity.tenantKey));if(tenants.size!==1)return null;
   const tenantKey=identities[0].tenantKey;
   const key=JSON.stringify([tenantKey,identities.map(identity=>JSON.stringify([identity.adminId,identity.openId])).sort()]);
   return {key,tenantKey};
  }catch{return null;}
 }
 function getSnapshot(){
  if(closed)return unavailable();
  const before=anchor();
  if(!before||active&&before.key!==active.key){if(active)invalidate();return unavailable();}
  if(!active)return unavailable();
  const result=active.sync.getSnapshot(),after=anchor();
  if(!after||after.key!==before.key){invalidate();return unavailable();}
  return {...result,syncing:Boolean(pending)||result.syncing};
 }
 async function discard(){
  if(active){const previous=active;active=undefined;closing=Promise.all([closing,previous.sync.close()]).then(()=>{});}
  await closing;
 }
 function invalidate(){
  rerun=true;
  void discard().catch(error=>{
   // The old cache stays inaccessible even if cleanup fails.
   void error;
  });
 }
 async function run(){
  for(let attempt=0;attempt<3&&!closed;attempt++){
   rerun=false;const trusted=anchor();pendingKey=trusted?.key;
   if(!trusted){await discard();if(rerun||anchor())continue;return unavailable();}
   if(active&&active.key!==trusted.key)await discard();
   await closing;if(closed)return unavailable();
   const latest=anchor();if(!latest||latest.key!==trusted.key)continue;
   if(!active)active={key:trusted.key,sync:createFeishuOrgSync({config,expectedTenantKey:trusted.tenantKey,store,fetchImpl,now,concurrency})};
   const selected=active;await selected.sync.refresh();
   const after=anchor();
   if(closed||rerun||!after||after.key!==trusted.key){if(active===selected)await discard();continue;}
   const result=selected.sync.getSnapshot(),verified=anchor();
   if(!verified||verified.key!==trusted.key){if(active===selected)await discard();continue;}
   return result;
  }
  await discard();return unavailable();
 }
 return {getSnapshot,refresh(){
  if(closed)return Promise.reject(Error('Feishu organization coordinator is closed'));
  if(pending){
   if(anchor()?.key!==pendingKey){rerun=true;if(active)invalidate();}
   return pending;
  }
  pending=run().catch(async()=>{await discard();return unavailable();}).finally(()=>{pending=undefined;pendingKey=undefined;});
  return pending;
 },async close(){closed=true;if(active)await active.sync.close();await pending;await discard();}};
}

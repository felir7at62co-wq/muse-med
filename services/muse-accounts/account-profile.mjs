/** Current-account profile and department paths independent of usage storage. */
import {accountGroups} from './account-groups.mjs';

const unavailable=()=>({status:'unavailable',updatedAt:null,departments:[]});
const copyDepartment=({id,name,path,pathIds})=>({id,name,path,pathIds:[...pathIds]});
const copyOrganization=({status,syncedAt,departments})=>({status,syncedAt,departments:departments.map(copyDepartment)});

function snapshotOrganization(accountId,snapshot){
 if(!['ready','partial'].includes(snapshot?.status)||!Object.hasOwn(snapshot.accounts??{},accountId))return unavailable();
 const membership=snapshot.accounts[accountId];
 if(membership.status!=='ready')return unavailable();
 const nodes=new Map(snapshot.departments.map(department=>[department.id,department])),departments=[];
 for(const id of new Set(membership.departmentIds)){
  const path=[],seen=new Set();let next=id;
  while(next!==null){
   if(seen.has(next)||seen.size>=64)return unavailable();
   const node=nodes.get(next);if(!node)return unavailable();
   seen.add(next);path.unshift(node);next=node.parentId;
  }
  departments.push({id,name:path.at(-1).name,path:path.map(node=>node.name).join(' / '),pathIds:path.map(node=>node.id)});
 }
 return {status:'available',updatedAt:snapshot.updatedAt??null,departments};
}

function identityOrganization(identities){
 if(!identities.length||identities.some(identity=>identity.organization?.status!=='available'))return unavailable();
 const departments=new Map();let updatedAt=null;
 for(const {organization} of identities){
  if(updatedAt===null||organization.syncedAt>updatedAt)updatedAt=organization.syncedAt;
  for(const department of organization.departments){
   const copy=copyDepartment(department),previous=departments.get(copy.id);
   if(previous&&JSON.stringify(previous)!==JSON.stringify(copy))return unavailable();
   departments.set(copy.id,copy);
  }
 }
 return {status:'available',updatedAt,departments:[...departments.values()]};
}

/**
 * Project one validated account without credentials, other accounts, or usage assumptions.
 * @param {object} account Current public account record from the account store.
 * @param {object} options Optional account-indexed organization snapshot; an unavailable supplied snapshot takes precedence over identity caches.
 * @returns {object} Versioned safe profile, informational Muse groups, and complete current-account department paths; unavailable paths are never partial lists.
 */
export function accountProfile(account,{organizationSnapshot}={}){
 const identities=account.feishuIdentities??[];
 return {version:1,account:{id:account.id,username:account.username,createdAt:account.createdAt,lastLoginAt:account.lastLoginAt??null,lastActivityAt:account.lastActivityAt??null,
  feishuIdentities:identities.map(({name,tenantKey,boundAt,lastLoginAt,organization})=>({name,tenantKey:tenantKey??null,boundAt,lastLoginAt:lastLoginAt??null,...organization===undefined?{}:{organization:copyOrganization(organization)}}))},
  groups:accountGroups(account.groups??[]),organization:organizationSnapshot===undefined?identityOrganization(identities):snapshotOrganization(account.id,organizationSnapshot)};
}

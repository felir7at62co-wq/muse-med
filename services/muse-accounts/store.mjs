import {randomBytes,scrypt as derive,timingSafeEqual} from 'node:crypto';
import {promisify} from 'node:util';
import {readFile,writeFile,rename,mkdir,chmod} from 'node:fs/promises';
import {dirname} from 'node:path';
import {EventEmitter} from 'node:events';
import {validDeviceId} from './desktop-route.mjs';
const scrypt=promisify(derive);
export const validId=id=>typeof id==='string'&&/^[a-f0-9]{16}$/.test(id);
function name(value){if(typeof value!=='string')throw Error('用户名格式不正确');const display=value.normalize('NFKC');if(!/^[\p{Script=Han}A-Za-z0-9_-]{2,32}$/u.test(display))throw Error('用户名须为 2–32 位中文、字母、数字、下划线或连字符');return {display,key:display.toLowerCase()};}
function password(value){if(typeof value!=='string'||value.length<1||value.length>128)throw Error('密码须为 1–128 位');return value;}
async function hash(value){const salt=randomBytes(24).toString('hex');return {salt,hash:(await scrypt(password(value),salt,64)).toString('hex')};}
const hasPassword=a=>typeof a.salt==='string'&&typeof a.hash==='string';
const publicIdentity=({appId,tenantKey=null,openId,unionId,name,avatarUrl,boundAt,lastLoginAt})=>({appId,tenantKey,openId,...unionId!==undefined?{unionId}:{},name,...avatarUrl!==undefined?{avatarUrl}:{},boundAt,lastLoginAt});
const publicRecord=a=>a?(({id,username,admin,disabled,createdAt,revision,lastLoginAt=null,lastActivityAt=null,feishuIdentities=[]})=>({id,username,admin,disabled,createdAt,revision,passwordLogin:hasPassword(a),lastLoginAt,lastActivityAt,feishuIdentities:feishuIdentities.map(publicIdentity)}))(a):null;
function reject(code,message){throw Object.assign(Error(message),{code});}
const externalId=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,256}$/.test(value);
const instant=value=>typeof value==='string'&&Number.isFinite(new Date(value).getTime())&&new Date(value).toISOString()===value;
function feishuProfile(value){
 if(!value||!externalId(value.appId)||!externalId(value.openId)||value.tenantKey!=null&&!externalId(value.tenantKey)
  ||value.unionId!==undefined&&!externalId(value.unionId)||typeof value.name!=='string'||!value.name.trim()||value.name.length>200||/[\x00-\x1f\x7f-\x9f]/.test(value.name))reject('FEISHU_PROFILE_INVALID','Invalid Feishu identity profile');
 const profile={appId:value.appId,tenantKey:value.tenantKey??null,openId:value.openId,name:value.name};
 if(value.unionId!==undefined)profile.unionId=value.unionId;
 if(value.avatarUrl!==undefined){
  let avatar;try{avatar=new URL(value.avatarUrl);}catch{reject('FEISHU_PROFILE_INVALID','Invalid Feishu avatar URL');}
  if(typeof value.avatarUrl!=='string'||value.avatarUrl.length>2048||avatar.protocol!=='https:'||avatar.username||avatar.password||avatar.hash)reject('FEISHU_PROFILE_INVALID','Invalid Feishu avatar URL');
  profile.avatarUrl=value.avatarUrl;
 }
 return profile;
}
const identityKey=value=>JSON.stringify([value.appId,value.tenantKey??null,value.openId]);
function validateIdentityRecords(a,keys){
 if(a.feishuIdentities===undefined)return;
 if(!Array.isArray(a.feishuIdentities))throw Error('Invalid Feishu identity records');
 for(const identity of a.feishuIdentities){
  feishuProfile(identity);
  if(!instant(identity.boundAt)||identity.lastLoginAt!==null&&!instant(identity.lastLoginAt)||keys.has(identityKey(identity)))throw Error('Invalid or duplicate Feishu identity records');
  keys.add(identityKey(identity));
 }
}
const desktops=a=>a.desktopDevices??(validDeviceId(a.desktopDeviceId)?[{id:a.desktopDeviceId,name:`电脑 · ${a.desktopDeviceId.slice(0,8)}`,platform:'unknown',lastSeenAt:null}]:[]);
function validateDevices(a){
 if(a.desktopDevices===undefined)return;
 const list=a.desktopDevices;
 if(!Array.isArray(list)||list.length>1000||new Set(list.map(d=>d?.id)).size!==list.length||list.some(d=>!d||!validDeviceId(d.id)
  ||typeof d.name!=='string'||!d.name.trim()||d.name.length>80||/[\x00-\x1f\x7f]/.test(d.name)||!['win32','darwin','linux','unknown'].includes(d.platform)
  ||d.lastSeenAt!==null&&(!Number.isSafeInteger(d.lastSeenAt)||d.lastSeenAt<0||!Number.isFinite(new Date(d.lastSeenAt).getTime()))))throw Error('Invalid desktop device records');
}
export async function openStore(file){
 await mkdir(dirname(file),{recursive:true,mode:0o700});let accounts=[];
 try{
  const data=JSON.parse(await readFile(file,'utf8'));if(![1,2].includes(data.version)||!Array.isArray(data.accounts))throw Error('Invalid account store');accounts=data.accounts;
  const identities=new Set(),ids=new Set(),usernames=new Set();
  for(const a of accounts){
   const credentials=hasPassword(a)&&a.salt.length>0&&/^[a-f0-9]{128}$/.test(a.hash);
   const feishuOnly=data.version===2&&a.passwordLogin===false&&a.salt===undefined&&a.hash===undefined&&Array.isArray(a.feishuIdentities)&&a.feishuIdentities.length>0;
   if(!validId(a.id)||ids.has(a.id)||typeof a.key!=='string'||usernames.has(a.key)||!credentials&&!feishuOnly)throw Error('Invalid account record');
   if(a.lastLoginAt!==undefined&&!instant(a.lastLoginAt)||a.lastActivityAt!==undefined&&!instant(a.lastActivityAt))throw Error('Invalid account activity record');
   ids.add(a.id);usernames.add(a.key);validateDevices(a);validateIdentityRecords(a,identities);
  }
 }catch(e){if(e.code!=='ENOENT')throw e;}
 const events=new EventEmitter();let queue=Promise.resolve();
 function transaction(fn){const run=queue.then(async()=>{const next=structuredClone(accounts);const result=await fn(next);const temp=file+'.'+randomBytes(8).toString('hex')+'.tmp';await writeFile(temp,JSON.stringify({version:2,accounts:next}),{mode:0o600});await chmod(temp,0o600);await rename(temp,file);accounts=next;return result;});queue=run.catch(()=>{});return run;}
 function find(rows,id){if(!validId(id))throw Error('Invalid account id');const a=rows.find(x=>x.id===id);if(!a)throw Error('Account not found');return a;}
 return Object.assign(events,{
 get:id=>publicRecord(accounts.find(a=>a.id===id)),list:()=>accounts.map(publicRecord),
 create:(username,secret,{admin=false}={})=>transaction(async rows=>{const n=name(username);password(secret);if(rows.some(a=>a.key===n.key))throw Error('用户名已被使用');const a={id:randomBytes(8).toString('hex'),username:n.display,key:n.key,admin:!!admin,disabled:false,createdAt:new Date().toISOString(),revision:1,...await hash(secret)};rows.push(a);return publicRecord(a);}),
 authenticate:async(username,secret)=>{let n;try{n=name(username);password(secret);}catch{return null;}const a=accounts.find(x=>x.key===n.key);const candidate=await scrypt(secret,a?.salt||'muse-invalid-user-constant-salt',64);if(!a||!hasPassword(a)||!timingSafeEqual(candidate,Buffer.from(a.hash,'hex')))return null;const current=accounts.find(x=>x.id===a.id);return current&&!current.disabled&&current.revision===a.revision?publicRecord(current):null;},
 /** Resolve one verified application/tenant/open-ID identity without merging names. */
 resolveFeishuIdentity:(value,{bindAccountId,bindRevision,validateBinding}={})=>transaction(rows=>{
  const profile=feishuProfile(value),key=identityKey(profile),at=new Date().toISOString();
  let account;
  if(bindAccountId!==undefined){
   if(!validId(bindAccountId))reject('ACCOUNT_NOT_FOUND','Account not found');
   account=rows.find(a=>a.id===bindAccountId);if(!account)reject('ACCOUNT_NOT_FOUND','Account not found');
   if(account.disabled)reject('ACCOUNT_DISABLED','Account disabled');
   if(bindRevision!==undefined&&account.revision!==bindRevision)reject('ACCOUNT_REVISION_CHANGED','Account authorization changed');
   if(validateBinding!==undefined&&!validateBinding())reject('ACCOUNT_REVISION_CHANGED','Account authorization changed');
  }
  const owner=rows.find(a=>a.feishuIdentities?.some(identity=>identityKey(identity)===key));
  if(owner&&account&&owner.id!==account.id)reject('FEISHU_IDENTITY_CONFLICT','Feishu identity is already bound');
  account??=owner;
  if(account?.disabled)reject('ACCOUNT_DISABLED','Account disabled');
  if(!account){
   let id,username;do{id=randomBytes(8).toString('hex');username='feishu_'+id;}while(rows.some(a=>a.id===id||a.key===username));
   account={id,username,key:username,admin:false,disabled:false,createdAt:at,revision:1,passwordLogin:false,feishuIdentities:[]};rows.push(account);
  }
  const identities=account.feishuIdentities??[],previous=identities.find(identity=>identityKey(identity)===key);
  const identity={...profile,boundAt:previous?.boundAt??at,lastLoginAt:previous?.lastLoginAt??null};
  if(previous)identities.splice(identities.indexOf(previous),1,identity);else identities.push(identity);
  account.feishuIdentities=identities;
  return publicRecord(account);
 }),
 /** Record successful authentication; it does not revoke account sessions. */
 recordLogin:(id,{at=new Date().toISOString(),feishuIdentity,expectedRevision,validateLogin}={})=>transaction(rows=>{
  if(!instant(at))throw Error('Invalid account login time');const a=find(rows,id);if(a.disabled)reject('ACCOUNT_DISABLED','Account disabled');
  if(expectedRevision!==undefined&&a.revision!==expectedRevision||validateLogin!==undefined&&!validateLogin())reject('ACCOUNT_REVISION_CHANGED','Account authorization changed');
  if(feishuIdentity!==undefined){
   if(!externalId(feishuIdentity?.appId)||!externalId(feishuIdentity.openId)||feishuIdentity.tenantKey!=null&&!externalId(feishuIdentity.tenantKey))reject('FEISHU_PROFILE_INVALID','Invalid Feishu identity profile');
   const identity=a.feishuIdentities?.find(value=>identityKey(value)===identityKey(feishuIdentity));
   if(!identity)reject('FEISHU_IDENTITY_CONFLICT','Feishu identity is not bound to this account');
   if(!identity.lastLoginAt||identity.lastLoginAt<at)identity.lastLoginAt=at;
  }
  if(!a.lastLoginAt||a.lastLoginAt<at)a.lastLoginAt=at;return publicRecord(a);
 }),
 /** Record an explicit user task operation, excluding background heartbeats. */
 recordActivity:(id,{at=new Date().toISOString()}={})=>transaction(rows=>{
  if(!instant(at))throw Error('Invalid account activity time');const a=find(rows,id);if(a.disabled)reject('ACCOUNT_DISABLED','Account disabled');
  if(!a.lastActivityAt||a.lastActivityAt<at)a.lastActivityAt=at;return publicRecord(a);
 }),
 setDisabled:async(id,disabled)=>{const a=await transaction(rows=>{const a=find(rows,id);a.disabled=!!disabled;a.revision++;return publicRecord(a);});events.emit('change',id);return a;},
 resetPassword:async(id,secret)=>{const a=await transaction(async rows=>{const a=find(rows,id);Object.assign(a,await hash(secret));if(a.passwordLogin===false)a.passwordLogin=true;a.revision++;return publicRecord(a);});events.emit('change',id);return a;},
 // Verification and replacement share the serialized transaction, so a stale
 // original password cannot win a race against another password change.
 changePassword:async(id,original,secret)=>{const a=await transaction(async rows=>{const a=find(rows,id);password(original);password(secret);const candidate=await scrypt(original,a.salt||'muse-invalid-user-constant-salt',64);if(a.disabled||!hasPassword(a)||!timingSafeEqual(candidate,Buffer.from(a.hash,'hex')))throw Error('原密码不正确');Object.assign(a,await hash(secret));a.revision++;return publicRecord(a);});events.emit('change',id);return a;},
 desktopDevices:id=>structuredClone(desktops(find(accounts,id))),
 // Installation metadata belongs only to its authenticated account.
 bindDesktop:(id,device,{maxDevices=20}={})=>transaction(rows=>{
  if(!validDeviceId(device.id)||typeof device.name!=='string'||!device.name.trim()||device.name.length>80||/[\x00-\x1f\x7f]/.test(device.name)
   ||!['win32','darwin','linux','unknown'].includes(device.platform)||!Number.isSafeInteger(device.lastSeenAt)||device.lastSeenAt<0)throw Error('Invalid desktop metadata');
  const a=find(rows,id);if(a.disabled)throw Error('Account disabled');
  const list=desktops(a),existing=list.find(d=>d.id===device.id);
  if(!existing&&list.length>=maxDevices)throw Error('Desktop device limit reached');
  if(existing)Object.assign(existing,device);else list.push({...device});
  a.desktopDevices=list;
 })
 });
}

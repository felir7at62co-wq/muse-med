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
const publicRecord=a=>a?(({id,username,admin,disabled,createdAt,revision})=>({id,username,admin,disabled,createdAt,revision}))(a):null;
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
 try{const data=JSON.parse(await readFile(file,'utf8'));if(data.version!==1||!Array.isArray(data.accounts))throw Error('Invalid account store');accounts=data.accounts;for(const a of accounts){if(!validId(a.id)||!a.salt||!/^[a-f0-9]{128}$/.test(a.hash))throw Error('Invalid account record');validateDevices(a);}}catch(e){if(e.code!=='ENOENT')throw e;}
 const events=new EventEmitter();let queue=Promise.resolve();
 function transaction(fn){const run=queue.then(async()=>{const next=structuredClone(accounts);const result=await fn(next);const temp=file+'.'+randomBytes(8).toString('hex')+'.tmp';await writeFile(temp,JSON.stringify({version:1,accounts:next}),{mode:0o600});await chmod(temp,0o600);await rename(temp,file);accounts=next;return result;});queue=run.catch(()=>{});return run;}
 function find(rows,id){if(!validId(id))throw Error('Invalid account id');const a=rows.find(x=>x.id===id);if(!a)throw Error('Account not found');return a;}
 return Object.assign(events,{
 get:id=>publicRecord(accounts.find(a=>a.id===id)),list:()=>accounts.map(publicRecord),
 create:(username,secret,{admin=false}={})=>transaction(async rows=>{const n=name(username);password(secret);if(rows.some(a=>a.key===n.key))throw Error('用户名已被使用');const a={id:randomBytes(8).toString('hex'),username:n.display,key:n.key,admin:!!admin,disabled:false,createdAt:new Date().toISOString(),revision:1,...await hash(secret)};rows.push(a);return publicRecord(a);}),
 authenticate:async(username,secret)=>{let n;try{n=name(username);password(secret);}catch{return null;}const a=accounts.find(x=>x.key===n.key);const candidate=await scrypt(secret,a?.salt||'muse-invalid-user-constant-salt',64);if(!a||!timingSafeEqual(candidate,Buffer.from(a.hash,'hex')))return null;const current=accounts.find(x=>x.id===a.id);return current&&!current.disabled&&current.revision===a.revision?publicRecord(current):null;},
 setDisabled:async(id,disabled)=>{const a=await transaction(rows=>{const a=find(rows,id);a.disabled=!!disabled;a.revision++;return publicRecord(a);});events.emit('change',id);return a;},
 resetPassword:async(id,secret)=>{const a=await transaction(async rows=>{const a=find(rows,id);Object.assign(a,await hash(secret));a.revision++;return publicRecord(a);});events.emit('change',id);return a;},
 // Verification and replacement share the serialized transaction, so a stale
 // original password cannot win a race against another password change.
 changePassword:async(id,original,secret)=>{const a=await transaction(async rows=>{const a=find(rows,id);password(original);password(secret);const candidate=await scrypt(original,a.salt,64);if(a.disabled||!timingSafeEqual(candidate,Buffer.from(a.hash,'hex')))throw Error('原密码不正确');Object.assign(a,await hash(secret));a.revision++;return publicRecord(a);});events.emit('change',id);return a;},
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

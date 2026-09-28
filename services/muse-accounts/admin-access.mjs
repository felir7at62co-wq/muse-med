// Administrator elevation and immutable per-tab contexts.
import {mkdir,readFile,writeFile,rename,appendFile} from 'node:fs/promises';
import {join} from 'node:path';import {randomBytes,scryptSync,timingSafeEqual} from 'node:crypto';
const reject=(message,status=403)=>{throw Object.assign(Error(message),{status});};
export async function openAdminAccess(root,{now=Date.now,ttlMs=15*60*1000}={}){
 await mkdir(root,{recursive:true,mode:0o700});let credential;
 try{credential=JSON.parse(await readFile(join(root,'credential.json'),'utf8'));if(!/^[a-f0-9]{48}$/.test(credential.salt)||!/^[a-f0-9]{128}$/.test(credential.hash))throw Error('Invalid admin credential');}catch(e){if(e.code!=='ENOENT')throw e;}
 const grants=new Map(),contexts=new Map(),failures=new Map();let serial=Promise.resolve();
 const transaction=fn=>{const p=serial.then(fn);serial=p.catch(()=>{});return p;};
 const audit=(actor,event,target)=>appendFile(join(root,'audit.jsonl'),JSON.stringify({at:new Date(now()).toISOString(),actor:actor.id,username:actor.username,event,target})+'\n',{mode:0o600});
 function admin(actor){if(!actor?.admin)reject('仅管理员可使用');}
 function prune(){for(const [k,v]of contexts)if(v.expiry<=now())contexts.delete(k);for(const [k,v]of grants)if(v<=now())grants.delete(k);}
 return {
  configured:()=>!!credential,
  configure:secret=>transaction(async()=>{if(typeof secret!=='string'||!secret||secret.length>128)reject('口令格式不正确',400);const salt=randomBytes(24).toString('hex'),next={salt,hash:scryptSync(secret,salt,64).toString('hex')};await writeFile(join(root,'credential.tmp'),JSON.stringify(next),{mode:0o600});await rename(join(root,'credential.tmp'),join(root,'credential.json'));credential=next;grants.clear();contexts.clear();}),
  unlock:(actor,session,secret)=>transaction(async()=>{admin(actor);if(!credential)reject('独立管理员口令尚未配置',503);const fail=failures.get(actor.id)||{count:0,until:0};if(fail.until>now())reject('连续验证失败，已锁定 15 分钟',429);if(fail.until&&fail.until<=now()){fail.count=0;fail.until=0;}
   if(typeof secret!=='string'||secret.length>128||!timingSafeEqual(scryptSync(secret,credential.salt,64),Buffer.from(credential.hash,'hex'))){fail.count++;if(fail.count>=5)fail.until=now()+15*60*1000;failures.set(actor.id,fail);await audit(actor,'unlock-failed');reject('管理员口令不正确',401);}
   failures.delete(actor.id);prune();await audit(actor,'unlock');grants.set(session,now()+ttlMs);return {expiry:now()+ttlMs};}),
  elevated:(actor,session)=>!!actor?.admin&&(grants.get(session)||0)>now(),
  create:(actor,session,target)=>transaction(async()=>{admin(actor);prune();if((grants.get(session)||0)<=now())reject('请先验证管理员口令');if(!target||!/^([a-f0-9]{16}|server|local)$/.test(target.id))reject('无效的管理目标',400);if(contexts.size>=1000)reject('管理标签页过多',429);const token=randomBytes(32).toString('hex'),expiry=grants.get(session);await audit(actor,'open',target.id);contexts.set(token,{actor:actor.id,session,target:structuredClone(target),expiry});return {token,expiry};}),
  resolve:(actor,session,token)=>{admin(actor);const context=contexts.get(token);if(!context||context.actor!==actor.id||context.session!==session||context.expiry<=now())reject('管理授权已过期，请重新验证');return structuredClone(context);},
  revoke:session=>{grants.delete(session);for(const [key,c]of contexts)if(c.session===session)contexts.delete(key);},
  record:(actor,event,target)=>audit(actor,event,target),
 };
}

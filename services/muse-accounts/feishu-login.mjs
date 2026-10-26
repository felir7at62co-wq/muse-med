/** Server-side Feishu login with browser-bound, single-use authorization attempts. */
import {createHash,randomBytes,timingSafeEqual} from 'node:crypto';
import {open} from 'node:fs/promises';
import {constants} from 'node:fs';
import {isAbsolute} from 'node:path';

const AUTHORIZATION_URL='https://accounts.feishu.cn/open-apis/authen/v1/authorize';
const TOKEN_URL='https://accounts.feishu.cn/oauth/v3/token';
const USER_INFO_URL='https://open.feishu.cn/open-apis/authen/v1/user_info';
const CALLBACK_PATH='/auth/feishu/callback';
const digest=value=>createHash('sha256').update(value).digest();
const token=()=>randomBytes(32).toString('base64url');
const validToken=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{43}$/.test(value);
const identifier=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,256}$/.test(value);
const text=(value,max)=>typeof value==='string'&&value.length>0&&value.length<=max&&!/[\x00-\x1f\x7f]/.test(value);
const attribute=value=>String(value).replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const pageHeaders={'content-type':'text/html; charset=utf-8','referrer-policy':'no-referrer','content-security-policy':"default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'"};

function resolveConfig(value,publicOrigin){
 if(!value||typeof value!=='object'||Array.isArray(value)
  ||Object.keys(value).some(key=>!['appId','appSecret','appType','redirectUri','requestTimeoutMs','attemptTtlMs','maxAttempts','requestRatePerMinute'].includes(key))
  ||!/^cli_[A-Za-z0-9_-]{1,128}$/.test(value.appId)||!text(value.appSecret,4096)||value.appSecret.length<16||!['custom','store'].includes(value.appType))throw Error('Invalid Feishu login configuration');
 let origin,redirect;
 try{origin=new URL(publicOrigin);redirect=new URL(value.redirectUri);}catch{throw Error('Invalid Feishu login callback');}
 if(origin.protocol!=='https:'||origin.username||origin.password||redirect.href!==origin.origin+CALLBACK_PATH)throw Error('Feishu login requires the exact HTTPS callback on the public origin');
 const config={...value,requestTimeoutMs:value.requestTimeoutMs??15000,attemptTtlMs:value.attemptTtlMs??300000,maxAttempts:value.maxAttempts??1000,requestRatePerMinute:value.requestRatePerMinute??60};
 if(!Number.isSafeInteger(config.requestTimeoutMs)||config.requestTimeoutMs<1000||config.requestTimeoutMs>60000
  ||!Number.isSafeInteger(config.attemptTtlMs)||config.attemptTtlMs<60000||config.attemptTtlMs>600000
  ||!Number.isSafeInteger(config.maxAttempts)||config.maxAttempts<1||config.maxAttempts>10000
  ||!Number.isSafeInteger(config.requestRatePerMinute)||config.requestRatePerMinute<1||config.requestRatePerMinute>1000)throw Error('Invalid Feishu login policy');
 return Object.freeze(config);
}

/** Load the optional server-only Feishu app credentials and bounded OAuth policy.
 * @param {string|undefined} file Absolute private JSON file, omitted when login is disabled.
 * @param {object} options Public HTTPS gateway origin used to validate the callback.
 * @returns {Promise<object|undefined>} Validated credentials and policy, or undefined when disabled.
 */
export async function loadFeishuLoginConfig(file,{publicOrigin}={}){
 if(file===undefined)return;
 if(typeof file!=='string'||!isAbsolute(file))throw Error('MUSE_FEISHU_LOGIN_CONFIG must be an absolute private file');
 const handle=await open(file,constants.O_RDONLY|constants.O_NOFOLLOW);
 try{
  const info=await handle.stat();
  if(!info.isFile()||info.size>16384||process.platform!=='win32'&&(info.mode&0o077)!==0)throw Error('Feishu login configuration must be an owner-only regular file');
  let value;try{value=JSON.parse(await handle.readFile('utf8'));}catch{throw Error('Invalid Feishu login configuration JSON');}
  return resolveConfig(value,publicOrigin);
 }finally{await handle.close();}
}

function cookieValue(req,name){
 const values=(req.headers.cookie??'').split(';').map(part=>part.trim()).filter(part=>part.startsWith(name+'='));
 return values.length===1?values[0].slice(name.length+1):undefined;
}

async function responseJson(response){
 if(!response.ok)throw Error('Feishu request rejected');
 const chunks=[];let size=0;
 for await(const chunk of response.body){size+=chunk.length;if(size>65536)throw Error('Feishu response exceeds limit');chunks.push(chunk);}
 const value=JSON.parse(Buffer.concat(chunks).toString('utf8'));
 if(!value||typeof value!=='object'||Array.isArray(value)||value.code!==0)throw Error('Feishu request rejected');
 return value;
}

function profileOf(data,appId){
 if(!data||!identifier(data.open_id)||!text(data.name,200)
  ||data.tenant_key!=null&&data.tenant_key!==''&&!identifier(data.tenant_key)
  ||data.union_id!=null&&data.union_id!==''&&!identifier(data.union_id))throw Error('Invalid Feishu profile');
 let avatarUrl;
 if(data.avatar_url!=null&&data.avatar_url!==''){
  if(!text(data.avatar_url,2048))throw Error('Invalid Feishu profile');
  try{const url=new URL(data.avatar_url);if(url.protocol!=='https:'||url.username||url.password)throw Error('Invalid avatar');avatarUrl=url.href;}catch{throw Error('Invalid Feishu profile');}
 }
 return {appId,openId:data.open_id,name:data.name,...data.tenant_key?{tenantKey:data.tenant_key}:{},...data.union_id?{unionId:data.union_id}:{},...avatarUrl?{avatarUrl}:{}};
}

/** Create browser OAuth routes; access tokens never leave the current callback operation.
 * @param {object} options Gateway account, session, HTTP and validated Feishu configuration dependencies.
 * @returns {object} Route handler and shutdown method; disabled configuration handles no routes.
 */
export function createFeishuLogin({config,publicOrigin,store,session,sessionStore,sessionTtlMs,cookieName,originOK,rate,form,reply,page,returnPath,now=Date.now,fetchImpl=fetch,allowAccount=()=>true}){
 if(config===undefined)return {enabled:false,handle:async()=>false,close:async()=>{}};
 config=resolveConfig(config,publicOrigin);
 if(!/^__Host-[A-Za-z0-9_-]+$/.test(cookieName)||!Number.isSafeInteger(sessionTtlMs)||sessionTtlMs<=0)throw Error('Invalid Feishu session policy');
 const nonceCookie=cookieName+'-feishu',attempts=new Map(),usedCodes=new Map(),operations=new Set(),controllers=new Set();let closed=false;
 const clearCookie=`${nonceCookie}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0`;
 function prune(){const time=now();for(const[id,a]of attempts)if(a.expiresAt<=time)attempts.delete(id);for(const[key,expiresAt]of usedCodes)if(expiresAt<=time)usedCodes.delete(key);}
 function failure(res,status,message){reply(res,status,page('飞书登录未完成',`<h1>飞书登录未完成</h1><p>${message}</p><p><a href="/login">返回登录</a></p>`,true),pageHeaders);}
 function bindCurrent(a){
  if(a.bindAccountId===undefined)return true;
  const current=sessionStore.get(a.browserToken),account=store.get(a.bindAccountId);
  return !!current&&current.id===a.bindAccountId&&current.revision===a.bindRevision&&!!account&&!account.disabled&&account.revision===a.bindRevision;
 }
 async function callback(req,res,url){
  prune();const state=url.searchParams.get('state'),a=validToken(state)&&attempts.get(state),nonce=cookieValue(req,nonceCookie);
  if(!a||!validToken(nonce)||!timingSafeEqual(a.nonceHash,digest(nonce))||url.searchParams.getAll('state').length!==1){failure(res,410,'登录链接已失效，请重新发起。');return;}
  // Consume before the first await so concurrent callbacks cannot redeem the same attempt.
  attempts.delete(state);res.setHeader('set-cookie',clearCookie);
  if(url.searchParams.has('error')){failure(res,400,'已取消飞书授权，请按需要重新登录。');return;}
  const code=url.searchParams.get('code');
  if(typeof code!=='string'||!/^[A-Za-z0-9_-]{1,2048}$/.test(code)||url.searchParams.getAll('code').length!==1){failure(res,400,'授权信息无效，请重新发起登录。');return;}
  const codeHash=digest(code).toString('hex');
  if(usedCodes.has(codeHash)){failure(res,410,'授权信息已使用，请重新发起登录。');return;}
  if(usedCodes.size>=config.maxAttempts){failure(res,503,'登录繁忙，请稍后重新发起。');return;}
  usedCodes.set(codeHash,now()+300000);
  if(!bindCurrent(a)){failure(res,403,'原 Muse 登录已失效，请重新登录后绑定飞书。');return;}
  const controller=new AbortController(),abort=()=>controller.abort();controllers.add(controller);
  req.once('aborted',abort);res.once('close',abort);
  const signal=AbortSignal.any([controller.signal,AbortSignal.timeout(config.requestTimeoutMs)]);
  let credential;
  try{
   const tokenResult=await responseJson(await fetchImpl(TOKEN_URL,{method:'POST',redirect:'error',signal,headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'authorization_code',client_id:config.appId,client_secret:config.appSecret,redirect_uri:config.redirectUri,code,code_verifier:a.verifier})}));
   if(!text(tokenResult.access_token,16384)||tokenResult.token_type!=='Bearer')throw Error('Invalid Feishu token');
   const userResult=await responseJson(await fetchImpl(USER_INFO_URL,{method:'GET',redirect:'error',signal,headers:{authorization:'Bearer '+tokenResult.access_token}}));
   signal.throwIfAborted();if(closed||!bindCurrent(a))throw Object.assign(Error('Account revision changed'),{code:'ACCOUNT_REVISION_CHANGED'});
   const profile=profileOf(userResult.data,config.appId);
   const account=await store.resolveFeishuIdentity(profile,a.bindAccountId===undefined?{}:{bindAccountId:a.bindAccountId,bindRevision:a.bindRevision,validateBinding:()=>!signal.aborted&&!closed&&bindCurrent(a)});
   signal.throwIfAborted();if(closed||!bindCurrent(a)||account.disabled||!allowAccount(account)||store.get(account.id)?.revision!==account.revision)throw Object.assign(Error('Account unavailable'),{code:'ACCOUNT_DISABLED'});
   credential=await sessionStore.issue({id:account.id,revision:account.revision,expiry:now()+sessionTtlMs});
   const loginValid=()=>{const current=store.get(account.id),issued=sessionStore.get(credential);return !signal.aborted&&!closed&&!!current&&!current.disabled&&current.revision===account.revision&&!!issued&&issued.id===account.id&&issued.revision===account.revision&&bindCurrent(a);};
   if(!loginValid())throw Object.assign(Error('Account unavailable'),{code:'ACCOUNT_REVISION_CHANGED'});
   await store.recordLogin(account.id,{at:new Date(now()).toISOString(),feishuIdentity:profile,expectedRevision:account.revision,validateLogin:loginValid});
   if(!loginValid())throw Object.assign(Error('Account unavailable'),{code:'ACCOUNT_REVISION_CHANGED'});
   const destination=attribute(a.bindAccountId===undefined?returnPath(a.desktopLogin):'/account?feishu=bound');
   // A rendered first-party document starts the next navigation with the Strict session cookie.
   reply(res,200,page('已登录 Muse',`<h1>已登录 Muse</h1><p>正在返回 Muse。</p><p><a href="${destination}">继续 →</a></p><meta http-equiv="refresh" content="0;url=${destination}">`,true),{...pageHeaders,'set-cookie':[clearCookie,`${cookieName}=${credential}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(sessionTtlMs/1000)}`]});
  }catch(error){
   if(credential){
    try{await sessionStore.revoke(credential);}catch(revokeError){
     // A failed durable revocation must not be presented as a completed login.
     void revokeError;if(!res.destroyed)failure(res,500,'登录未完成，请稍后重新发起。');return;
    }
   }
   if(res.destroyed)return;
   if(error.code==='FEISHU_IDENTITY_CONFLICT')failure(res,409,'这个飞书身份已绑定其他 Muse 账号，请使用原账号登录。');
   else if(['ACCOUNT_DISABLED','ACCOUNT_REVISION_CHANGED','ACCOUNT_NOT_FOUND'].includes(error.code))failure(res,403,'Muse 账号不可用或原登录已失效，请重新登录后重试。');
   else failure(res,502,'未能完成飞书身份验证，请重新发起；如仍失败，请联系管理员检查应用配置和可用范围。');
  }finally{controllers.delete(controller);req.off('aborted',abort);res.off('close',abort);}
 }
 async function handle(req,res,path){
  if(!['/auth/feishu/start','/auth/feishu/bind',CALLBACK_PATH].includes(path))return false;
  if(closed){failure(res,503,'登录服务正在重启，请稍后重试。');return true;}
  const expectedMethod=path==='/auth/feishu/bind'?'POST':'GET';
  if(req.method!==expectedMethod){reply(res,405,'',{allow:expectedMethod});return true;}
  if(!rate(req,'feishu-login:'+path,config.requestRatePerMinute)){reply(res,429,'请稍后再试',{'retry-after':'60'});return true;}
  const url=new URL(req.url,publicOrigin);
  if(path===CALLBACK_PATH){const work=callback(req,res,url);operations.add(work);try{await work;}finally{operations.delete(work);}return true;}
  if(!originOK(req,path==='/auth/feishu/bind')){reply(res,403);return true;}
  const browser=path==='/auth/feishu/bind'?session(req):undefined;
  if(path==='/auth/feishu/bind'&&!browser){reply(res,303,'',{location:'/login'});return true;}
  const fields=path==='/auth/feishu/bind'?await form(req):url.searchParams;
  if(closed){failure(res,503,'登录服务正在重启，请稍后重试。');return true;}
  prune();if(attempts.size>=config.maxAttempts){failure(res,503,'登录繁忙，请稍后重试。');return true;}
  const state=token(),nonce=token(),verifier=token();
  attempts.set(state,{nonceHash:digest(nonce),verifier,expiresAt:now()+config.attemptTtlMs,desktopLogin:fields.get('desktop_login'),...browser?{bindAccountId:browser.id,bindRevision:browser.account.revision,browserToken:browser.token}:{}});
  const authorize=new URL(AUTHORIZATION_URL);
  for(const[key,value]of Object.entries({client_id:config.appId,response_type:'code',redirect_uri:config.redirectUri,state,code_challenge:digest(verifier).toString('base64url'),code_challenge_method:'S256',...browser?{prompt:'consent'}:{}}))authorize.searchParams.set(key,value);
  reply(res,303,'',{location:authorize.href,'set-cookie':`${nonceCookie}=${nonce}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${Math.ceil(config.attemptTtlMs/1000)}`});return true;
 }
 return {enabled:true,appType:config.appType,handle,async close(){closed=true;attempts.clear();usedCodes.clear();for(const controller of controllers)controller.abort();await Promise.allSettled([...operations]);}};
}

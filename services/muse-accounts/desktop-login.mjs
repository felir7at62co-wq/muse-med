/** Browser approval and private, short-lived Desktop session redemption. */
import {createHash,randomBytes,timingSafeEqual} from 'node:crypto';

const digest=value=>createHash('sha256').update(value).digest();
const token=()=>randomBytes(32).toString('base64url');
const validToken=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{43}$/.test(value);

/** Create one gateway's bounded, restart-ephemeral login attempts.
 * @param {object} options Gateway session, page, response and admission dependencies.
 * @returns {object} HTTP handler, return-path validator and browser-bound Feishu consent hooks; no callback URL is accepted.
 */
export function createDesktopLogin({publicOrigin,store,sessionStore,sessionTtlMs,cookieName,session,originOK,rate,form,reply,html,page,loginPage,escape,feishuEnabled=false,now=Date.now,ttlMs=600000,maxAttempts=1000,pollIntervalMs=2000}){
 if(!Number.isSafeInteger(ttlMs)||ttlMs<60000||!Number.isSafeInteger(maxAttempts)||maxAttempts<1||!Number.isSafeInteger(pollIntervalMs)||pollIntervalMs<1000)throw Error('Invalid Desktop login policy');
 const attempts=new Map();
 function prune(){for(const[id,a]of attempts)if(a.expiresAt<=now())attempts.delete(id);}
 function find(id){prune();return attempts.get(id);}
 function returnPath(id){return validToken(id)&&find(id)?'/desktop-login?attempt='+id:'/';}
 const consentCookie=cookieName+'-desktop-consent';
 function consumeFeishuConsent(req,fields){
  const id=fields.get('desktop_login'),intent=fields.get('desktop_intent'),a=validToken(id)&&find(id);
  const values=(req.headers.cookie??'').split(';').map(value=>value.trim()).filter(value=>value.startsWith(consentCookie+'=')),nonce=values.length===1?values[0].slice(consentCookie.length+1):undefined;
  if(!a||a.state!=='pending'||!validToken(intent)||!validToken(nonce)||!a.intentHash||!a.nonceHash||fields.getAll('desktop_login').length!==1||fields.getAll('desktop_intent').length!==1||!timingSafeEqual(a.intentHash,digest(intent))||!timingSafeEqual(a.nonceHash,digest(nonce)))return;
  delete a.intentHash;delete a.nonceHash;
  const consent={id,attempt:a};a.feishuConsent=consent;return consent;
 }
 function feishuConsentCurrent(consent){return !!consent&&find(consent.id)===consent.attempt&&consent.attempt.state==='pending'&&consent.attempt.feishuConsent===consent;}
 function approveFeishuConsent(consent,{token:browserToken,account}){
  if(!feishuConsentCurrent(consent))return false;
  const a=consent.attempt;a.state='approved';a.browserToken=browserToken;a.revision=account.revision;delete a.feishuConsent;return true;
 }
 function json(res,status,value,headers={}){reply(res,status,JSON.stringify(value),{'content-type':'application/json; charset=utf-8',...headers});}
 async function handle(req,res,path){
  if(path!=='/desktop-login'&&!path.startsWith('/api/desktop-login/'))return false;
  if(path.startsWith('/api/desktop-login/')){
   if(req.method!=='POST'){reply(res,405,'',{allow:'POST'});return true;}
   if(!originOK(req,true)){reply(res,403);return true;}
   const limit=path.endsWith('/start')?60:Math.ceil(maxAttempts*60000/pollIntervalMs);
   if(!rate(req,'desktop-login:'+path,limit)){json(res,429,{state:'rate-limited'});return true;}
   const f=await form(req);
   if(path==='/api/desktop-login/start'){
    prune();if(attempts.size>=maxAttempts){json(res,503,{state:'unavailable'});return true;}
    const id=token(),secret=token(),code=randomBytes(4).toString('hex').toUpperCase(),expiresAt=now()+ttlMs;
    attempts.set(id,{secretHash:digest(secret),code,expiresAt,state:'pending'});
    const authorizePath=feishuEnabled&&f.get('provider')==='feishu'?'/auth/feishu/start?desktop_login=':'/desktop-login?attempt=';
    json(res,200,{id,secret,code,expiresAt,pollIntervalMs,authorizeUrl:publicOrigin+authorizePath+id});return true;
   }
   if(!['/api/desktop-login/check','/api/desktop-login/cancel'].includes(path)){reply(res,404);return true;}
   const id=f.get('id'),secret=f.get('secret'),a=validToken(id)&&find(id);
   if(!a||!validToken(secret)||!timingSafeEqual(a.secretHash,digest(secret))){json(res,410,{state:'expired'});return true;}
   if(path.endsWith('/cancel')){attempts.delete(id);json(res,200,{state:'cancelled'});return true;}
   if(a.state==='pending'){json(res,200,{state:'pending'});return true;}
   // Delete before asynchronous issuance: concurrent redemption cannot mint a second session.
   attempts.delete(id);
   if(a.state==='cancelled'){json(res,200,{state:'cancelled'});return true;}
   const browser=sessionStore.get(a.browserToken),account=browser&&store.get(browser.id);
   if(!browser||!account||account.disabled||account.revision!==a.revision||browser.revision!==a.revision){json(res,410,{state:'expired'});return true;}
   const credential=await sessionStore.issue({id:account.id,revision:account.revision,expiry:now()+sessionTtlMs});
   if(store.get(account.id)?.revision!==a.revision||store.get(account.id)?.disabled||!sessionStore.get(a.browserToken)){
    await sessionStore.revoke(credential);json(res,410,{state:'expired'});return true;
   }
   json(res,200,{state:'signed-in'},{'set-cookie':`${cookieName}=${credential}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(sessionTtlMs/1000)}`});return true;
  }
  const id=req.method==='GET'?new URL(req.url,publicOrigin).searchParams.get('attempt'):null;
  if(req.method==='GET'){
   const a=validToken(id)&&find(id);
   if(!a||a.state!=='pending'){html(res,410,page('登录链接已失效','<p>请返回 Muse 重新发起登录。</p>',true));return true;}
   const s=session(req);
   if(!s){
    let consent;
    if(feishuEnabled){
     const intent=token(),nonce=token();a.intentHash=digest(intent);a.nonceHash=digest(nonce);delete a.feishuConsent;consent={intent,code:a.code};
     res.setHeader('set-cookie',`${consentCookie}=${nonce}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${Math.ceil((a.expiresAt-now())/1000)}`);
    }
    html(res,200,loginPage(false,id,consent),{feishuForm:!!consent});return true;
   }
   html(res,200,page('MUSE',`<h1>MUSE</h1><p>当前账号：${escape(s.account.username)}</p><p>请核对桌面端的设备码：<strong>${a.code}</strong>。仅在你本人发起登录时确认。</p><form action="/desktop-login" method="post"><input type="hidden" name="attempt" value="${id}"><button name="decision" value="approve">确认登录此设备</button><button name="decision" value="deny">取消</button></form>`,true));return true;
  }
  if(req.method!=='POST'){reply(res,405,'',{allow:'GET, POST'});return true;}
  if(!originOK(req,true)){reply(res,403);return true;}
  const s=session(req);if(!s){reply(res,303,'',{location:'/login'});return true;}
  const f=await form(req),a=find(f.get('attempt'));
  if(!a||a.state!=='pending'){reply(res,410);return true;}
  if(f.get('decision')==='deny')a.state='cancelled';
  else if(f.get('decision')==='approve'){a.state='approved';a.browserToken=s.token;a.revision=s.account.revision;}
  else{reply(res,400);return true;}
  html(res,200,page('MUSE',a.state==='approved'?'<h1>登录成功</h1><p>请返回 MUSE，桌面端将自动完成登录。</p>':'<h1>已取消登录</h1><p>可以关闭此页面。</p>',true));return true;
 }
 return {handle,returnPath,consumeFeishuConsent,feishuConsentCurrent,approveFeishuConsent};
}

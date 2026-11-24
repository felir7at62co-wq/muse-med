import {createStudioUsageReader} from '../../integrations/localminidrama/cloud/studio-usage.mjs';
import {studioUsageRoute} from './studio-usage-http.mjs';
import {loadStudioConfig} from '../../integrations/localminidrama/cloud/config.mjs';
import {createStudioRuntime} from '../../integrations/localminidrama/cloud/runtime.mjs';
import {studioRoute} from '../../integrations/localminidrama/cloud/proxy.mjs';
import {loadCompanyCliService} from './company-cli-service.mjs';
import {loadProductionFees} from './production-fees.mjs';
import {productionFeeRoute} from './production-fee-http.mjs';
import {createNativeJubianHttp} from './native-jubian-http.mjs';
import {loadNativeJubianAdmission} from './native-jubian-config.mjs';
import {loadMarket,marketPage} from './market.mjs';
import {renderSitePage} from './site-shell.mjs';
import http from 'node:http';
import {createDesktopLogin} from './desktop-login.mjs';
import {createWorkbenchLogin,loadWorkbenchClients} from './workbench-login.mjs';
import {createFeishuLogin,loadFeishuLoginConfig} from './feishu-login.mjs';
import {renderAccountIdentity,renderAdminAccounts,renderAccountDetails,renderAccountGroups} from './account-pages.mjs';
import {resolveFeishuOnlyLogin} from './auth-policy.mjs';
import {createFeishuOrgCoordinator} from './feishu-organization-coordinator.mjs';
import {randomBytes} from 'node:crypto';
import {readFile,access,stat} from 'node:fs/promises';
import {realpathSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {dirname,join,resolve} from 'node:path';
import {openFeedback} from './feedback.mjs';
import {feedbackRoute} from './feedback-http.mjs';
import {openFeedbackAutomation} from './feedback-automation.mjs';
import {loadFeedbackAiConfig,createFeedbackAnalyzer} from './feedback-analyzer.mjs';
import {openAdminAccess} from './admin-access.mjs';
import {openStore,validId} from './store.mjs';
import {scheduleSessionExpiry} from './session-expiry.mjs';
import {createMemorySessionStore,DEFAULT_SESSION_TTL_MS,openSessionStore,resolveSessionFile,resolveSessionTtlMs} from './session-store.mjs';
import {createKbMcp} from './kb-mcp.mjs';
import {loadDocumentGrants} from './kb-grants.mjs';
import {verifyPersonalRoot} from './kb-personal.mjs';
import {loadPortfolioReaders} from './kb-portfolio-config.mjs';
// Cloud knowledge base endpoint (bearer-token authenticated).
import {openModelConfig,createModelRelay} from './model-relay.mjs';
import {openGlobalModels,restrictModelSchema} from './global-models.mjs';
import {createDesktopModels} from './desktop-models.mjs';
import {openDeepSeekFlashRouting} from './deepseek-flash-routing.mjs';
import {resolvePublicModelCatalog} from './public-model-catalog.mjs';
import {createWebSearch} from './web-search.mjs';
import {openModelUsage,modelUsageQuery} from './model-usage.mjs';
import {renderModelUsage} from './model-usage-pages.mjs';
import {resolveModelKeyPoolPolicy,createModelKeyPool} from './model-key-pool.mjs';
import {createDesktopRelay} from './desktop-relay.mjs';
import {createWorkbench} from './workbench.mjs';
import {renderWorkbench} from './workbench-pages.mjs';
import {createBotCoordination} from './bot-coordination.mjs';
import {desktopRoute,desktopPrefix} from './desktop-route.mjs';
import {openUsageLedger} from './usage-ledger.mjs';
import {openSessionArchives} from './session-archives.mjs';
import {accountDataRoute,createAccountDataAdmission} from './account-data-http.mjs';
import {accountProfile} from './account-profile.mjs';
import {renderAccountData} from './account-data-page.mjs';
import {desktopPicker} from './desktop-picker.mjs';
import {createVoiceSlots,createJubianVoiceVerifier,resolveVoiceSlotOptions} from './voice-slots.mjs';

/** Load account Wiki storage and administrator grants without opening legacy vector files.
 * @param {object} environment Gateway environment containing the KB directory and credential-file paths.
 * @returns {Promise<object|undefined>} Wiki configuration, or undefined when disabled or its secret is invalid.
 * @throws {Error} Invalid document grants or portfolio readers, or an unavailable, overlapping, or permissive private root.
 */
export async function loadKnowledgeBase(environment = process.env) {
 if(!environment.MUSE_KB_VAULT||!environment.MUSE_KB_SECRET)return;
 const secret=(await readFile(environment.MUSE_KB_SECRET,'utf8').catch(()=>'')).trim();
 if(secret.length<32){console.error('[muse-kb] 知识库密钥缺失或过短，云端知识库接口已停用');return;}
 const documentGrants=environment.MUSE_KB_DOCUMENT_GRANTS?await loadDocumentGrants(environment.MUSE_KB_DOCUMENT_GRANTS,{vaultRoot:environment.MUSE_KB_VAULT}):new Map();
 await verifyPersonalRoot(environment.MUSE_KB_USER_ROOT,environment.MUSE_KB_VAULT);
 const portfolioReaders=environment.MUSE_KB_PORTFOLIO_READERS?await loadPortfolioReaders(environment.MUSE_KB_PORTFOLIO_READERS,{vaultRoot:environment.MUSE_KB_VAULT,personalRoot:environment.MUSE_KB_USER_ROOT}):new Set();
 return {vaultRoot:environment.MUSE_KB_VAULT,personalRoot:environment.MUSE_KB_USER_ROOT,secret,documentGrants,portfolioReaders};
}

const escape=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function page(title,body,auth=false,context={}){
 const active=context.active??(title==='模型用量'?'usage':title.includes('管理员')||title.includes('模型配置')?'users':title==='选择电脑'?'computers':'account');
 return renderSitePage({title,body,auth,active,admin:context.admin??(active==='users'||active==='usage'),username:context.username,mainClass:'site-panel'});
}
function loginPage(register=false,desktopLogin,feishuEnabled=false,feishuAppType,consent){
 const continuation=desktopLogin?`?desktop_login=${encodeURIComponent(desktopLogin)}`:'';
 const passwordForm=`<form action="/${register?'register':'login'}" method="post">${desktopLogin?`<input type="hidden" name="desktop_login" value="${escape(desktopLogin)}">`:''}<label>用户名<input name="username" autocomplete="username" minlength="2" maxlength="32" required${feishuEnabled?'':' autofocus'}></label><label>密码<input name="password" type="password" autocomplete="${register?'new-password':'current-password'}" maxlength="128" required></label><button>${register?'注册并进入工作间':'进入工作间 →'}</button></form>`;
 const issuerConsent=consent?.feeIssuer?`<fieldset><legend>费用确认设备</legend><p>${escape(consent.feeIssuer.deviceName)}</p><small>${escape(consent.feeIssuer.fingerprint)}</small><label><input style="width:auto" type="checkbox" name="fee_issuer_consent" value="approve" required>允许此设备逐次请求付费确认；仍须每笔确认，不会立即扣费，也不授予无限额度。</label></fieldset>`:'';
 const feishuAction=consent?`<p>请核对 MUSE 中的设备码：<strong>${escape(consent.code)}</strong>。仅在你本人发起登录时授权。</p><form action="/auth/feishu/start" method="post"><input type="hidden" name="desktop_login" value="${escape(desktopLogin)}"><input type="hidden" name="desktop_intent" value="${escape(consent.intent)}">${issuerConsent}<button class="feishu-login">使用飞书授权并登录此设备</button></form>`:`<p><a class="feishu-login" href="/auth/feishu/start${continuation}">使用飞书登录</a></p>`;
 const legacy=feishuEnabled?'':passwordForm+`<p>${register?`已有账号？<a href="/login${continuation}">登录</a>`:`<a href="/register${continuation}">免费注册个人工作间</a>`}</p>`;
 return page('MUSE',`<img src="/spider.png" alt="MUSE"><h1>MUSE</h1><p>让灵感成形，让故事发生。</p>${feishuEnabled?`${feishuAction}<small>飞书授权后即可使用，无需另设 MUSE 密码。${feishuAppType==='custom'?'仅限本企业应用可用范围内的成员。':''}</small>`:''}${legacy}<small>每个账号拥有独立的文档与会话。</small>`,true);
}
/** Create the account gateway on a new or supplied HTTP carrier.
 * @param {object} options Account, session, service and deployment options.
 * @param {import('node:http').Server} [options.httpServer] Unhandled carrier, optionally already listening; the factory installs gateway handlers and owns their close cleanup.
 * @returns {import('node:http').Server} The supplied carrier or a new HTTP server.
 */
export function createAccountServer({store,runtime={},workspaceMode='cloud',desktopRelayOptions={},workbenchOptions={},botTeamOptions,botCoordination:providedBotCoordination,productionBoard:providedProductionBoard,desktopLoginOptions={},feishuLoginOptions={},workbenchClients,feishuOnlyLogin=false,feishuOrgSync,modelConfig,globalModels,flashRouting,modelCatalog='selected',modelForward,modelUsage,usageLedger,sessionArchives,studioRuntime,companyCli,studioUsage,productionFees,productionFeeReadRatePerMinute=120,nativeJubianAdmission,nativeJubianApprovals,nativeJubianMaxRequestBytes=262144,nativeJubianRequestRatePerMinute=120,archiveAdmissionOptions={},httpServer,modelKeyPoolPolicy=resolveModelKeyPoolPolicy(),modelKeyPool,feedback,feedbackAutomation,adminAccess,adminHosts={},publicOrigin='https://muse.aigc-pipeline.cn',logoPath,kb,asr,asrStorage,asrRequestRatePerMinute=60,activityRequestRatePerMinute=120,voiceSlots,market,webSearchOptions={},now=Date.now,sessionTtlMs=DEFAULT_SESSION_TTL_MS,sessionStore=createMemorySessionStore({now}),devOnlyAdmin=process.env.MUSE_DEV_ONLY_ADMIN==='true',environment=process.env.MUSE_ENVIRONMENT||(devOnlyAdmin?'development':'production'),maintenanceFile=process.env.MUSE_MAINTENANCE_FILE,cookieName=process.env.MUSE_COOKIE_NAME||'__Host-muse'}){
 if(httpServer&&(httpServer.listenerCount('request')!==0||httpServer.listenerCount('upgrade')!==0))throw Error('Account HTTP carrier must have no request or upgrade handlers');
 if(!Number.isSafeInteger(nativeJubianRequestRatePerMinute)||nativeJubianRequestRatePerMinute<1||nativeJubianRequestRatePerMinute>10000)throw Error('Invalid native Jubian metadata rate');
 if(!Number.isSafeInteger(productionFeeReadRatePerMinute)||productionFeeReadRatePerMinute<1||productionFeeReadRatePerMinute>10000)throw Error('Invalid production fee metadata rate');
 const nativeJubianHttp=createNativeJubianHttp({admission:nativeJubianAdmission,fees:nativeJubianApprovals,maxRequestBytes:nativeJubianMaxRequestBytes});
 if(typeof feishuOnlyLogin!=='boolean')throw Error('Invalid Feishu-only login policy');
 if(feishuOnlyLogin&&!feishuLoginOptions.config)throw Error('Feishu-only login requires configured Feishu login');

 if(!Number.isSafeInteger(activityRequestRatePerMinute)||activityRequestRatePerMinute<1||activityRequestRatePerMinute>10000)throw Error('Invalid activity request rate');
 if(!['cloud','desktop'].includes(workspaceMode))throw Error('Invalid workspace mode');
 if(!['development','production'].includes(environment))throw Error('Invalid environment');
 if(!/^__Host-[A-Za-z0-9_-]+$/.test(cookieName))throw Error('Invalid secure session cookie name');
 if(!Number.isSafeInteger(sessionTtlMs)||sessionTtlMs<=0)throw Error('Invalid session TTL');
 if(!Number.isSafeInteger(asrRequestRatePerMinute)||asrRequestRatePerMinute<=0)throw Error('Invalid ASR request rate');
  function authorizeKbToken(token){const grant=kbAccessTokens.get(token);if(!grant)return null;const active=sessionStore.get(grant.sessionToken),account=active&&store.get(active.id);if(!active||!account||account.disabled||account.revision!==active.revision||active.id!==grant.accountId||active.expiry<=now()||grant.expiry<=now()){kbAccessTokens.delete(token);return null;}return {account,mode:'account'};}
  const kbEndpoint=kb?.vaultRoot&&typeof kb.secret==='string'&&kb.secret.length>=32?createKbMcp({vaultRoot:kb.vaultRoot,personalRoot:kb.personalRoot,accounts:store,secret:kb.secret,documentGrants:kb.documentGrants,portfolioReaders:kb.portfolioReaders,authorize:authorizeKbToken,embedder:kb.embedder,vectors:kb.vectors,semanticWeight:kb.semanticWeight,semanticFloor:kb.semanticFloor,onWarn:message=>console.error('[muse-kb]',message)}):null;
 async function maintenance(){if(!maintenanceFile)return false;try{await access(maintenanceFile);return true;}catch(e){if(e.code==='ENOENT')return false;throw e;}}
 function workspaceMutation(path){return /^\/api\/workspace[./](create|delete|rename|update|change|insertBefore)(?:\/|$)/.test(decodeURIComponent(path));}
 const validWebSearchSession=s=>{const current=sessionStore.get(s.token),account=current&&store.get(current.id);return !!current&&current.id===s.id&&current.expiry>now()&&!!account&&!account.disabled&&account.revision===current.revision;};
 const webSearch=createWebSearch({...webSearchOptions,globalModels,now,validSession:validWebSearchSession});
 const desktopModels=createDesktopModels({globalModels,flashRouting,modelCatalog,modelConfig,forward:modelForward,now,keyPoolPolicy:modelKeyPoolPolicy,keyPool:modelKeyPool,modelUsage,usageLedger});
 const archiveAdmission=createAccountDataAdmission(archiveAdmissionOptions);

 publicOrigin=new URL(publicOrigin).origin;const rates=new Map(),connections=new Map(),cookies=new Map(),httpStreams=new Map(),kbAccessTokens=new Map(),activeTokens=new Map(),accountRevocations=new Map();
 let desktopRelay,admissionStopped=false;
 function disconnect(token){desktopRelay?.revoke(token);desktopModels.revoke(token);webSearch.revoke(token);activeTokens.delete(token);for(const [key,grant] of kbAccessTokens)if(grant.sessionToken===token)kbAccessTokens.delete(key);adminAccess?.revoke(token);for(const socket of connections.get(token)||[])socket.destroy();connections.delete(token);for(const stream of httpStreams.get(token)||[])stream.destroy();httpStreams.delete(token);}
 async function revoke(token){disconnect(token);await sessionStore.revoke(token);}
 function sessionWriteFailed(){console.error('[muse-accounts] Session revocation persistence failed');}
 function revokeSoon(token){void revoke(token).catch(sessionWriteFailed);}
 function touchAccount(id){try{Promise.resolve(runtime.touch?.(id)).catch(()=>{});}catch{}}
 const changed=id=>{for(const [token,accountId] of activeTokens)if(accountId===id)disconnect(token);cookies.delete(id);const pending=sessionStore.revokeAccount(id);pending.catch(sessionWriteFailed);accountRevocations.set(id,pending);};store.on('change',changed);
 function session(req){const token=((req.url?.split('?')[0]==='/studio'||req.url?.startsWith('/studio/')||req.url?.startsWith('/api/desktop-models/')||req.url?.startsWith('/api/jubian/voice-slots')||req.url?.startsWith('/api/muse/')||req.url?.startsWith('/api/admin/usage')||req.url?.startsWith('/api/admin/accounts')||req.url?.startsWith('/api/admin/studio-usage'))?req.headers.authorization?.match(/^Bearer ([A-Za-z0-9_-]+)$/)?.[1]:undefined)??req.headers.cookie?.split(';').map(x=>x.trim()).find(x=>x.startsWith(cookieName+'='))?.slice(cookieName.length+1);const s=sessionStore.get(token),a=s&&store.get(s.id);if(s&&a&&!a.disabled&&a.revision===s.revision&&(!devOnlyAdmin||a.admin)){activeTokens.set(token,s.id);return {token,...s,account:a};}if(token)revokeSoon(token);return null;}
 function originOK(req,required=false){return req.headers.origin?req.headers.origin===publicOrigin:!required&&req.headers['sec-fetch-site']!=='cross-site';}
 desktopRelay=createDesktopRelay({...desktopRelayOptions,store,publicOrigin,now,validSession:s=>{const current=sessionStore.get(s.token),account=store.get(s.id);return !!current&&current.id===s.id&&!!account&&!account.disabled&&account.revision===current.revision;}});
 const botCoordination=providedBotCoordination??(botTeamOptions===undefined?undefined:createBotCoordination({...botTeamOptions,store,now,authorizeDevice:request=>desktopRelay.authorizeDevice(request),onlineDevices:accountId=>desktopRelay.devices({id:accountId}).filter(device=>device.state==='online')}));
 let productionBoard=providedProductionBoard,botClosed=false;
 const workbench=createWorkbench({store,desktopRelay,orgSnapshot:()=>feishuOrgSync?.getSnapshot(),botSnapshot:(session,query)=>botCoordination?.snapshot(session,query),productionSnapshot:session=>productionBoard?.read(session),usage:modelUsage,now,cloudDeviceId:workbenchOptions.cloudDeviceId});
 function reply(res,status,text='',extra={}){res.writeHead(status,{'cache-control':'no-store','x-content-type-options':'nosniff','referrer-policy':'no-referrer',...extra});res.end(text);}
 // Same-origin form navigation retains Origin for the CSRF check.
 function html(res,status,text,{feishuForm=false,accountData=false}={}){const formAction=feishuForm&&feishuLoginOptions.config?"'self' https://accounts.feishu.cn":"'self'";reply(res,status,text,{'referrer-policy':'same-origin','content-type':'text/html; charset=utf-8','content-security-policy':`default-src 'none'; img-src 'self'; style-src 'self' 'unsafe-inline'; ${accountData?"script-src 'self'; connect-src 'self'; ":''}form-action ${formAction}; frame-ancestors 'none'; base-uri 'none'`});}
 function appendAccountData(document,admin){if(!document.includes('</main>'))throw Error('Account document has no main region');return document.replace('</main>',renderAccountData({admin,escape})+'</main>');}
 function accountDataPage(admin){return (title,body,...options)=>page(title,body+renderAccountData({admin,escape}),...options);}

 function rate(req,type,limit){const time=now();for(const[k,v]of rates)if(time-v.start>=60000)rates.delete(k);const key=type+':'+(req.headers['x-real-ip']||req.socket.remoteAddress);if(!rates.has(key)&&rates.size>=10000)return false;const entry=rates.get(key)||{start:time,count:0};rates.set(key,entry);return ++entry.count<=limit;}
 async function form(req,maxBytes=8192){let size=0;const chunks=[];for await(const chunk of req){size+=chunk.length;if(size>maxBytes){const e=Error('请求内容过大');e.status=413;throw e;}chunks.push(chunk);}return new URLSearchParams(Buffer.concat(chunks).toString('utf8'));}
 async function newSession(res,a,location='/'){
  const token=await sessionStore.issue({id:a.id,revision:a.revision,expiry:now()+sessionTtlMs});
  try{
   const loginValid=()=>{const current=store.get(a.id),issued=sessionStore.get(token);return !res.destroyed&&!!current&&!current.disabled&&current.revision===a.revision&&!!issued&&issued.id===a.id&&issued.revision===a.revision;};
   await store.recordLogin(a.id,{at:new Date(now()).toISOString(),expectedRevision:a.revision,validateLogin:loginValid});
   const current=store.get(a.id);if(!current||current.disabled||current.revision!==a.revision)throw Error('Account authorization changed');
   activeTokens.set(token,a.id);for(const active of activeTokens.keys())if(!sessionStore.get(active))disconnect(active);
   reply(res,303,'',{location,'set-cookie':`${cookieName}=${token}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(sessionTtlMs/1000)}`});
  }catch(error){await revoke(token);throw error;}
 }
 async function backend(id){if(!validId(id)&&!adminHosts[id])throw Error('Invalid account');const config=adminHosts[id]||await runtime.ensure(id);const target=new URL(config.upstream);if(target.protocol!=='http:'||target.hostname!=='127.0.0.1'||target.username||target.password)throw Error('Invalid backend');const url=(await readFile(config.bootstrapPath,'utf8')).trim();if(new URL(url).origin!==target.origin)throw Error('Invalid bootstrap');let cached=cookies.get(id);if(!cached||cached.url!==url){const promise=(async()=>{const r=await fetch(url,{redirect:'manual',signal:AbortSignal.timeout(10000)});const c=r.headers.getSetCookie().map(x=>x.split(';')[0]).join('; ');if(r.status>=400||!c)throw Error('Bootstrap failed');return c;})();cached={url,promise};cookies.set(id,cached);promise.catch(()=>{if(cookies.get(id)===cached)cookies.delete(id);});while(cookies.size>1000)cookies.delete(cookies.keys().next().value);}return {target,cookie:await cached.promise};}
 function scope(req,s){const value=new URL(req.url,publicOrigin).searchParams.get('muse_admin');if(value===null)return null;if(!adminAccess)throw Object.assign(Error('管理员完整版未开启'),{status:403});return {...adminAccess.resolve(s.account,s.token,value),token:value};}
 function cleanUrl(req){return req.url.replace(/([?&])muse_admin=[a-f0-9]{64}(?=&|$)/g,(_m,sep)=>sep==='?'?'?':'').replace('?&','?').replace(/\?$/,'');}
 function scopeValid(req,s){try{const current=session(req);if(!current||current.token!==s.token)return false;scope(req,current);return true;}catch{return false;}}
 function headers(req,backend){const h={...req.headers};for(const k of Object.keys(h))if(['cookie','authorization','host','forwarded','x-real-ip'].includes(k)||k.startsWith('x-forwarded-')||k.startsWith('x-muse-')||k==='x-account-id')delete h[k];h.host=backend.target.host;h.cookie=backend.cookie;if(h.origin)h.origin=backend.target.origin;return h;}
 function fetchHeaders(req,b){const h=headers(req,b);for(const k of ['connection','upgrade','keep-alive','transfer-encoding','te','trailer','proxy-authorization','proxy-authenticate','content-length'])delete h[k];return h;}
 function responseHeaders(h,target){const result={...h};delete result['set-cookie'];if(result.location){const u=new URL(result.location,target);if(u.origin===target.origin)result.location=u.pathname+u.search+u.hash;}return result;}
 const renderLoginPage=(register,continuation,consent)=>loginPage(register,continuation,!!feishuLoginOptions.config,feishuLoginOptions.config?.appType,consent);
 const desktopLogin=createDesktopLogin({...desktopLoginOptions,publicOrigin,store,sessionStore,sessionTtlMs,cookieName,session,originOK,rate,form,reply,html,page,loginPage:renderLoginPage,escape,feishuEnabled:!!feishuLoginOptions.config,feeIssuers:productionFees,now});
 const feishuLogin=createFeishuLogin({...feishuLoginOptions,publicOrigin,environment,store,session,sessionStore,sessionTtlMs,cookieName,originOK,rate,form,reply,page,returnPath:desktopLogin.returnPath,desktopConsent:desktopLogin,now,allowAccount:account=>!devOnlyAdmin||account.admin});
 const workbenchLogin=createWorkbenchLogin({clients:workbenchClients,publicOrigin,session,sessionStore,store,now,rate,form,reply,page,escape,cookieName});
 const server=http.createServer(async(req,res)=>{try{
  if(!req.url.startsWith('/')||req.url.startsWith('//')){reply(res,400);return;}
  const mount=workspaceMode==='desktop'?desktopRoute(req.url):null,path=new URL(mount?.path??req.url,'http://localhost').pathname;
  if(!mount&&await workbenchLogin(req,res,path))return;
  if(await feishuLogin.handle(req,res,path))return;
  if(await desktopLogin.handle(req,res,path))return;
  if(asrStorage&&await asrStorage.handle(req,res))return;
  if(!mount&&(path==='/market'||path.startsWith('/market/')||path.startsWith('/api/market/'))){
   if(!market){reply(res,404);return;}
   if(!originOK(req,!['GET','HEAD'].includes(req.method))){reply(res,403);return;}
   if(!rate(req,'market',120)){reply(res,429,JSON.stringify({error:'rate-limited'}),{'content-type':'application/json','retry-after':'60'});return;}
   if(req.method==='GET'&&path==='/market'){reply(res,200,marketPage,{'content-type':'text/html; charset=utf-8','content-security-policy':"default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'"});return;}
   if(req.method==='GET'&&['/market/client.js','/market/style.css'].includes(path)){reply(res,200,await readFile(new URL(path.endsWith('.js')?'./market-client.js':'./market.css',import.meta.url)),{'content-type':path.endsWith('.js')?'text/javascript; charset=utf-8':'text/css; charset=utf-8'});return;}
   if(path.startsWith('/api/market/v1/')){
    const current=session(req);let prepared;
    if(path==='/api/market/v1/publishers'&&req.method==='POST'){
     if(!current?.account.admin){req.resume();reply(res,current?403:401,JSON.stringify({error:current?'admin-required':'login-required'}),{'content-type':'application/json'});return;}
     const chunks=[];let size=0;
     for await(const chunk of req.iterator({destroyOnReturn:false})){size+=chunk.length;if(size>16384){req.resume();reply(res,413);return;}chunks.push(chunk);}
     prepared=Buffer.concat(chunks);let invitation;try{invitation=JSON.parse(prepared.toString('utf8'));}catch{reply(res,400);return;}
     const member=invitation&&validId(invitation.accountId)&&store.get(invitation.accountId);
     if(!member||member.disabled){reply(res,400,JSON.stringify({error:'invalid-publisher-account'}),{'content-type':'application/json'});return;}
    }
    await market.handle(req,res,current?current.account:null,prepared);return;
   }
   reply(res,404);return;
  }
  if(['/assets/admin-accounts.css','/assets/site-shell.css'].includes(path)){
   if(!['GET','HEAD'].includes(req.method)){reply(res,405,'',{allow:'GET, HEAD'});return;}
   const content=await readFile(new URL(path.endsWith('site-shell.css')?'./site-shell.css':'./admin-accounts.css',import.meta.url));
   reply(res,200,req.method==='HEAD'?'':content,{'content-type':'text/css; charset=utf-8','content-length':String(content.byteLength),'cache-control':'no-cache'});return;
  }
  if(path==='/register'&&devOnlyAdmin){reply(res,403,'开发环境仅供管理员使用');return;}
  if(['/login','/register'].includes(path)&&req.method==='GET'){const requested=new URL(req.url,publicOrigin).searchParams.get('desktop_login'),continuation=desktopLogin.returnPath(requested)==='/'?undefined:requested;let content=devOnlyAdmin?renderLoginPage(false,continuation).replace('<a href="/register">免费注册个人工作间</a>','开发验证环境 · 管理员登录'):renderLoginPage(path==='/register',continuation);if(environment==='development')content=content.replace('<h1>MUSE</h1>','<h1>MUSE</h1><div class="eyebrow">开发验证环境</div>');html(res,200,content);return;}
  if(['/spider.png','/favicon.ico'].includes(path)&&req.method==='GET'){if(logoPath)reply(res,200,await readFile(logoPath),{'content-type':'image/png'});else reply(res,204);return;}
  if(['/login','/register'].includes(path)&&req.method==='POST'){
   if(!originOK(req,true)){reply(res,403);return;}if(!rate(req,path,path==='/login'?10:5)){reply(res,429,'请稍后再试',{'retry-after':'60'});return;}
   if(feishuOnlyLogin){reply(res,409,JSON.stringify({error:'请更新 Muse 并使用飞书登录',error_code:'feishu_login_required'}),{'content-type':'application/json; charset=utf-8'});return;}
   const f=await form(req);let a;if(path==='/register'){try{a=await store.create(f.get('username'),f.get('password'));}catch(e){html(res,400,page('注册失败',`<p>${escape(e.message)}</p><a href="/register?desktop_login=${encodeURIComponent(f.get('desktop_login')||'')}">返回注册</a>`,true));return;}}else a=await store.authenticate(f.get('username'),f.get('password'));
   if(!a||devOnlyAdmin&&!a.admin){html(res,401,page('登录失败',`<p>用户名或密码不正确，或账号不可用。</p><a href="/login?desktop_login=${encodeURIComponent(f.get('desktop_login')||'')}">返回登录</a>`,true));return;}await newSession(res,a,desktopLogin.returnPath(f.get('desktop_login')));return;
  }
  // Machine entry point for the cloud knowledge base. It must be answered before
  // the browser session gate: a local agent has a bearer token, not a cookie.
  if(path==='/api/kb/mcp'){
   if(!kbEndpoint){reply(res,503,JSON.stringify({error:'云端知识库未配置'}),{'content-type':'application/json'});return;}
   if(!rate(req,'kb',300)){reply(res,429,JSON.stringify({error:'请求过于频繁，请稍后再试'}),{'content-type':'application/json','retry-after':'60'});return;}
   const chunks=[];let size=0,tooLarge=false;
   for await(const chunk of req){size+=chunk.length;if(size>2*1024*1024+1){tooLarge=true;break;}chunks.push(chunk);}
   const result=tooLarge?{status:413,headers:{'content-type':'application/json'},body:null}:await kbEndpoint({method:req.method,headers:req.headers,body:Buffer.concat(chunks).toString('utf8')});
   reply(res,result.status,result.body??'',result.headers);
   return;
  }
  const s=session(req);if(!s){if(path==='/studio'||path.startsWith('/studio/')||path.startsWith('/api/muse/')||path==='/api/admin/usage'||path==='/api/admin/accounts'||path==='/api/admin/studio-usage'){reply(res,401,JSON.stringify({error:{code:'account_session_expired'}}),{'content-type':'application/json','cache-control':'no-store'});return;}if(path==='/api/web/search'||path==='/api/muse.activity'||path==='/api/workbench'||path.startsWith('/api/bot-team/')||path==='/api/production'||path.startsWith('/api/production/')||path==='/api/admin/model-usage'||path.startsWith('/api/jubian/voice-slots'))reply(res,401,JSON.stringify({error:'Please sign in to Muse',error_code:'account_session_expired'}),{'content-type':'application/json'});else if(path.startsWith('/api/desktop-models/'))reply(res,401,JSON.stringify({error:{message:'请先登录 Muse'}}),{'content-type':'application/json'});else reply(res,303,'',{location:'/login'});return;}if(!originOK(req,!['GET','HEAD','OPTIONS'].includes(req.method))){reply(res,403);return;}if(workspaceMode==='cloud')touchAccount(s.id);
  if(!mount&&(path==='/api/muse/native-jubian'||path.startsWith('/api/muse/native-jubian/'))){
   if(admissionStopped){reply(res,503,JSON.stringify({code:'native_jubian_draining'}),{'content-type':'application/json; charset=utf-8'});return;}
   if(await nativeJubianHttp.route(req,res,{path,session:s,currentSession:()=>session(req),publicOrigin,rate:()=>rate(req,'native-jubian:'+s.id,nativeJubianRequestRatePerMinute)}))return;
  }
  if(!mount&&await productionFeeRoute(req,res,{path,session:s,fees:productionFees,reply,rate:()=>rate(req,'production-fee:'+s.id,productionFeeReadRatePerMinute)}))return;
  if(path.startsWith('/studio/api/v1/muse/company-cli/')){
   if(!rate(req,'company-cli',240)){reply(res,429,JSON.stringify({success:false,error:{code:'company_cli_rate_limited'}}),{'content-type':'application/json','retry-after':'60'});return;}
   if(!companyCli){reply(res,503,JSON.stringify({success:false,error:{code:'company_cli_not_configured'}}),{'content-type':'application/json'});return;}
   await companyCli.handle(req,res,{actor:{id:s.id},isAuthorized:()=>session(req)?.token===s.token});return;
  }
  if(!mount&&(path==='/studio'||path.startsWith('/studio/'))){
   const controller=new AbortController(),stream={destroy:()=>controller.abort()};
   if(!httpStreams.has(s.token))httpStreams.set(s.token,new Set());httpStreams.get(s.token).add(stream);
   const cancelExpiry=scheduleSessionExpiry(s.expiry,()=>controller.abort(),{now});
   try{await studioRoute(req,res,{runtime:studioRuntime,session:s,isAuthorized:()=>{const current=session(req);return current?.token===s.token&&current.id===s.id;},publicOrigin,signal:controller.signal});}
   finally{cancelExpiry();controller.abort();const active=httpStreams.get(s.token);active?.delete(stream);if(active?.size===0)httpStreams.delete(s.token);}
   return;
  }
  if(!mount&&await studioUsageRoute(req,res,{path,session:s,currentSession:()=>session(req),store,reader:studioUsage,publicOrigin}))return;
  if(!mount&&path==='/api/muse/profile'){
   if(req.method!=='GET'){reply(res,405,'',{allow:'GET'});return;}
   if(new URL(req.url,publicOrigin).search){reply(res,400);return;}
   const profile=accountProfile(s.account,{organizationSnapshot:feishuOrgSync?.getSnapshot()});
   if(session(req)?.token!==s.token){reply(res,401);return;}
   reply(res,200,JSON.stringify(profile),{'content-type':'application/json; charset=utf-8'});return;
  }
  if(!mount&&await accountDataRoute(req,res,{path,publicOrigin,session:s,currentSession:()=>session(req),usageLedger,sessionArchives,store,admission:archiveAdmission}))return;
  if(['/account-data-client.js','/account-data.css'].includes(path)&&req.method==='GET'){reply(res,200,await readFile(new URL('.'+path,import.meta.url)),{'content-type':path.endsWith('.js')?'text/javascript; charset=utf-8':'text/css; charset=utf-8'});return;}
  if(!mount&&path.startsWith('/api/bot-team/')){
   if(!botCoordination){reply(res,503,JSON.stringify({ok:false,error:'Bot coordination is not configured'}),{'content-type':'application/json; charset=utf-8'});return;}
   await botCoordination.handle(req,res,s,path);return;
  }
  if(!mount&&(path==='/api/production'||path.startsWith('/api/production/'))){
   const answer=(status,value)=>reply(res,status,JSON.stringify(value),{'content-type':'application/json; charset=utf-8'});
   if(!productionBoard){answer(503,{ok:false,error:'Production board is not configured'});return;}
   try{
    if(path==='/api/production'&&req.method==='GET'){answer(200,{ok:true,value:productionBoard.read(s)});return;}
    if(path==='/api/production/script'&&req.method==='GET'){
     const params=new URL(req.url,publicOrigin).searchParams,value=await productionBoard.download(s,{key:params.get('key'),revision:params.get('revision'),fileToken:params.get('fileToken')});
     const type=/^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+$/.test(value.contentType??'')?value.contentType:'application/octet-stream';
     reply(res,200,value.bytes,{'content-type':type,'content-disposition':`attachment; filename="script"; filename*=UTF-8''${encodeURIComponent(value.filename).replace(/['()*]/g,char=>'%'+char.charCodeAt(0).toString(16).toUpperCase())}`,'x-content-type-options':'nosniff'});return;
    }
    if(req.method==='POST'&&['/api/production/sync','/api/production/decision'].includes(path)){
     if(!s.account.admin){answer(403,{ok:false,error:'Administrator access required'});return;}
     if(req.headers['content-type']?.split(';')[0].trim()!=='application/json'){answer(415,{ok:false,error:'JSON body required'});return;}
     const chunks=[];let bytes=0;for await(const chunk of req){bytes+=chunk.length;if(bytes>32768){answer(413,{ok:false,error:'Production request too large'});return;}chunks.push(chunk);}
     let body;try{body=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch(error){answer(400,{ok:false,error:'Invalid JSON'});return;}
     if(!body||typeof body!=='object'||Array.isArray(body)){answer(400,{ok:false,error:'Invalid production request'});return;}
     const value=path.endsWith('/sync')?await productionBoard.sync():await productionBoard.decide(s,body);answer(200,{ok:true,value});return;
    }
    reply(res,405,'',{allow:path.endsWith('/script')||path==='/api/production'?'GET':'POST'});return;
   }catch(error){const status=[400,401,403,404,409,413,415,429,502,503].includes(error.status)?error.status:503;answer(status,{ok:false,error:status===409?'制作表或审批已更新，请刷新后核对':status===403?'当前账号没有操作权限':'制作服务暂不可用，请核对原记录后重试'});return;}
  }
  if(!mount&&workspaceMode==='desktop'&&['/workbench','/api/workbench','/workbench.js','/workbench.css'].includes(path)){
   if(req.method!=='GET'){reply(res,405,'',{allow:'GET'});return;}
   if(path==='/workbench.js'||path==='/workbench.css'){reply(res,200,await readFile(new URL('.'+path,import.meta.url)),{'content-type':path.endsWith('.css')?'text/css; charset=utf-8':'text/javascript; charset=utf-8'});return;}
   let model;try{model=workbench.read(s,Object.fromEntries(new URL(req.url,publicOrigin).searchParams));}
   catch(error){reply(res,error.status??500,JSON.stringify({error:error.status===403?'Administrator access required':error.status===400?'Invalid workbench filters':'Workbench temporarily unavailable'}),{'content-type':'application/json; charset=utf-8'});return;}
   if(path==='/api/workbench')reply(res,200,JSON.stringify(model),{'content-type':'application/json; charset=utf-8'});
   else reply(res,200,renderWorkbench(model),{'content-type':'text/html; charset=utf-8','content-security-policy':"default-src 'none'; img-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'"});
   return;
  }
  if(path==='/api/admin/model-usage'||path==='/admin/usage'){
   const answer=(status,value)=>reply(res,status,JSON.stringify(value),{'content-type':'application/json; charset=utf-8'});
   if(!s.account.admin){answer(403,{error:'Administrator access required'});return;}
   if(req.method!=='GET'){reply(res,405,'',{allow:'GET'});return;}
   if(!modelUsage){answer(503,{error:'Model usage recording is not configured'});return;}
   const params=new URL(req.url,publicOrigin).searchParams;let filters;
   try{filters=modelUsageQuery(Object.fromEntries(['from','to','accountId','provider','model'].filter(key=>params.has(key)).map(key=>[key,params.get(key)])),now());}
   catch(error){answer(400,{error:'Invalid model usage filters; use a range of 1 to 366 Beijing calendar days'});return;}
   const summary=modelUsage.summary(filters);
   const accounts=store.list().map(account=>({id:account.id,username:account.username,feishuIdentities:(account.feishuIdentities??[]).map(identity=>({name:identity.name}))}));
   if(path==='/api/admin/model-usage'){const labels=new Map(accounts.map(account=>[account.id,account]));answer(200,{...summary,users:summary.users.map(row=>({...row,username:labels.get(row.accountId)?.username??null,feishuNames:labels.get(row.accountId)?.feishuIdentities.map(identity=>identity.name)??[]}))});}
   else html(res,200,renderModelUsage({summary,accounts,escape,page:(title,body)=>page(title,body,false,{active:'usage',admin:s.account.admin,username:s.account.username})}));
   return;
  }
  if(path==='/api/web/search'){await webSearch.handle(req,res,s);return;}

  if(path==='/api/muse.activity'){
   if(req.method!=='POST'){reply(res,405,'',{allow:'POST'});return;}
   if(req.headers['content-type']?.split(';')[0].trim()!=='application/json'){reply(res,415);return;}
   if(!rate(req,'activity:'+s.id,activityRequestRatePerMinute)){reply(res,429,'',{'retry-after':'60'});return;}
   const chunks=[];let size=0;
   for await(const chunk of req){size+=chunk.length;if(size>1024){reply(res,413);return;}chunks.push(chunk);}
   let value;try{value=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch(_error){reply(res,400);return;}
   if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==1||value.activity!=='task-start'){reply(res,400);return;}
   const current=session(req);if(!current||current.token!==s.token){reply(res,401);return;}
   await store.recordActivity(s.id,{at:new Date(now()).toISOString()});reply(res,204);return;
  }
  if(mount){
   if(!store.desktopDevices(s.id).some(device=>device.id===mount.deviceId)){reply(res,404,'电脑不存在');return;}
   if(new URL(req.url,publicOrigin).searchParams.has('muse_admin')){reply(res,400,'请从管理员中心打开管理目标');return;}
   if(new URL(req.url,publicOrigin).pathname===mount.prefix.slice(0,-1)){if(req.method==='GET'||req.method==='HEAD')reply(res,303,'',{location:mount.prefix+new URL(req.url,publicOrigin).search});else reply(res,400);return;}
  }
  if(['/api/desktop/status','/api/desktop/devices'].includes(path)&&workspaceMode==='desktop'){if(req.method!=='GET'){reply(res,405,'',{allow:'GET'});return;}reply(res,200,JSON.stringify(path.endsWith('/devices')?{devices:desktopRelay.devices(s)}:desktopRelay.status(s,mount?.deviceId)),{'content-type':'application/json; charset=utf-8'});return;}
  if(['/desktop-offline.js','/desktop-presence.js','/desktop-picker.js'].includes(path)&&workspaceMode==='desktop'&&req.method==='GET'){reply(res,200,await readFile(new URL('.'+path,import.meta.url)),{'content-type':'text/javascript; charset=utf-8'});return;}
  if(path.startsWith('/api/desktop-models/')){await desktopModels.handle(req,res,s,path);return;}
  if(path==='/api/jubian/voice-slots'){
   const answer=(status,value)=>reply(res,status,JSON.stringify(value),{'content-type':'application/json; charset=utf-8'});
   if(!voiceSlots){answer(503,{error:'Shared voice registration is not configured',error_code:'coordination_unavailable'});return;}
   if(req.method!=='POST'){answer(405,{error:'Expected POST voice reservation request',error_code:'invalid_request'});return;}
   if(req.headers['content-type']!=='application/json'){answer(415,{error:'Expected JSON voice reservation request',error_code:'invalid_request'});return;}
   let value;
   try{const chunks=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>16384){answer(413,{error:'Voice reservation request is too large',error_code:'invalid_request'});return;}chunks.push(chunk);}value=JSON.parse(Buffer.concat(chunks).toString('utf8'));}
   catch(_error){answer(400,{error:'Unreadable voice reservation request',error_code:'invalid_request'});return;}
   try{const result=await voiceSlots.request(s.id,req.headers['x-jubian-token'],value,{isAuthorized:()=>session(req)?.token===s.token});answer(200,result);}
   catch(error){answer(error.status||503,{error:error.status?error.message:'Shared voice registration is temporarily unavailable',error_code:error.status?error.code:'coordination_unavailable'});}
   return;
  }
  if(path==='/api/kb/access'){
   if(req.method!=='POST'){reply(res,405,'',{allow:'POST'});return;}
   if(!kbEndpoint){reply(res,503,JSON.stringify({error:'云端知识库未配置'}),{'content-type':'application/json'});return;}
   if(!rate(req,'kb-access:'+s.id,30)){reply(res,429,'请求过于频繁',{'retry-after':'60'});return;}
   while(kbAccessTokens.size>=10000)kbAccessTokens.delete(kbAccessTokens.keys().next().value);
   const token=randomBytes(32).toString('base64url'),expiresAt=Math.min(s.expiry,now()+15*60_000);
   kbAccessTokens.set(token,{sessionToken:s.token,accountId:s.id,expiry:expiresAt});
   reply(res,200,JSON.stringify({url:publicOrigin+'/api/kb/mcp',token,expiresAt}),{'content-type':'application/json; charset=utf-8'});return;
  }
  if(path==='/api/admin/asr/diagnostics'){
   const answer=(status,value)=>reply(res,status,JSON.stringify(value),{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});
   if(req.method!=='GET'){answer(405,{error:'Unsupported ASR diagnostics method'});return;}
   if(!s.account.admin){answer(403,{error:'Administrator access required'});return;}
   if(!adminAccess||!adminAccess.elevated(s.account,s.token)){answer(403,{error:'Elevated administrator access required'});return;}
   if(!asr){answer(503,{error:'Muse cloud transcription is not configured on this server'});return;}
   if(!rate(req,'asr-diagnostics:'+s.id,12)){answer(429,{error:'ASR diagnostics request rate exceeded'});return;}
   await adminAccess.record(s.account,'GET /api/admin/asr/diagnostics','server');
   if(res.destroyed)return;
   const current=session(req);
   if(!current||current.token!==s.token||!current.account.admin||!adminAccess.elevated(current.account,current.token)){answer(403,{error:'Elevated administrator access required'});return;}
   answer(200,asr.diagnostics());return;
  }
  if(path==='/api/asr/jobs'||path.startsWith('/api/asr/jobs/')){
   const answer=(status,value,retryAfter)=>reply(res,status,JSON.stringify(value),{'content-type':'application/json; charset=utf-8',...retryAfter?{'retry-after':String(retryAfter)}:{}});
   if(!asr){answer(503,{error:'Muse cloud transcription is not configured on this server'});return;}
   if(!rate(req,'asr:'+s.id,asrRequestRatePerMinute)){answer(429,{error:'Cloud transcription request rate exceeded',error_code:'request_rate',retry_after:60},60);return;}
   try{
    if(path==='/api/asr/jobs'&&req.method==='POST'){
     if(admissionStopped){req.resume();answer(503,{error:'Cloud transcription is draining',error_code:'server_draining',retry_after:2},2);return;}
     if(!['audio/mpeg','audio/wav'].includes(req.headers['content-type'])){answer(415,{error:'Expected MP3 or PCM WAV audio'});return;}
     const job=await asr.submit(s.id,req.headers['idempotency-key'],req.headers['x-audio-sha256'],req.headers['x-audio-language'],req,req.headers['x-muse-asr-purpose']);
     answer(202,job);return;
    }
    const match=/^\/api\/asr\/jobs\/([0-9a-f-]{36})$/i.exec(path);
    if(match&&req.method==='GET'){answer(200,await asr.get(s.id,match[1]));return;}
    answer(405,{error:'Unsupported ASR method or path'});return;
   }catch(error){
    const code=['queue_full','upload_busy','daily_quota','provider_rate','invalid_request','idempotency_conflict'].includes(error.code)?error.code:undefined;
    const retryAfter=Number.isSafeInteger(error.retryAfter)&&error.retryAfter>0?error.retryAfter:undefined;
    answer(error.status||503,{error:error.status?error.message:'Cloud transcription is temporarily unavailable; retry the same job ID',...code?{error_code:code}:{},...retryAfter?{retry_after:retryAfter}:{}},retryAfter);return;
   }
  }
  let context;try{context=scope(req,s);}catch(error){reply(res,error.status||403,'管理授权已失效，请返回管理员中心重新验证。');return;}
  const targetId=context?.target.id||s.id;
  // An administrator lands in their own workroom; machine and account contexts are
  // entered deliberately from the administrator center.
  if(context&&validId(targetId)&&!store.get(targetId)){reply(res,404,'账户不存在');return;}
  if(path==='/admin/context-client.js'&&req.method==='GET'){if(!s.account.admin){reply(res,403);return;}reply(res,200,await readFile(new URL('./admin-context-client.js',import.meta.url)),{'content-type':'text/javascript; charset=utf-8'});return;}
  if(path==='/admin/control'||path.startsWith('/admin/control/')){
   if(!s.account.admin){reply(res,403);return;}if(!adminAccess){reply(res,503,'管理员完整版尚未配置');return;}
   if(path==='/admin/control'&&req.method==='GET'){
    const elevated=adminAccess.elevated(s.account,s.token),button=(id,label)=>`<form action="/admin/control/open" method="post" target="_blank"><input type="hidden" name="target" value="${escape(id)}"><button>${escape(label)} ↗</button></form>`;
    const targets=Object.keys(adminHosts).map(id=>button(id,id==='server'?'服务器 · 完整 DSH':'本机 Windows · 完整 DSH')).join('');
    html(res,200,page('管理员完整版',`<div class="eyebrow">MUSE / ADMIN · ${environment==='development'?'开发版':'正式版'}</div><h1>管理员完整版</h1><nav><a href="/">我的工作间</a><a href="/admin">账户管理</a></nav><p>整机入口保留原生工作间选择、会话管理和工具。每个管理标签页绑定一个目标，不影响其他标签页；编辑的会话与私人文稿不在管理页面展示。</p>${elevated?`<div class="notice">短时授权已开启，15 分钟后需重新验证。目标中的改动即时生效，请谨慎操作。</div><h2>机器</h2>${targets}${adminHosts.local?'':'<p>本机 Windows 尚未连接，不能访问本机文件。</p>'}<p>需要进入某个编辑的工作间时，请在 <a href="/admin">账户管理</a> 里对该账号使用“进入其工作间”。</p><form action="/admin/control/lock" method="post"><button>锁定并退出全部管理标签页</button></form>`:`<p>访问整机前，请输入独立管理员口令。连续错误 5 次锁定 15 分钟。</p><form action="/admin/control/unlock" method="post"><label>独立管理员口令<input type="password" name="password" autocomplete="current-password" maxlength="128" required></label><button>验证并解锁</button></form>`}`));return;
   }
   if(['/admin/control/unlock','/admin/control/lock','/admin/control/open'].includes(path)&&['GET','HEAD'].includes(req.method)){reply(res,303,'',{location:'/admin/control'});return;}
   if(req.method!=='POST'){reply(res,405,'',{allow:'POST'});return;}
   if(!rate(req,'admin-control:'+s.id,12)){reply(res,429,'请稍后再试');return;}
   const f=await form(req);
   try{
    if(path==='/admin/control/unlock'){await adminAccess.unlock(s.account,s.token,f.get('password'));reply(res,303,'',{location:adminHosts.server?'/':'/admin/control'});return;}
    if(path==='/admin/control/lock'){await revoke(s.token);reply(res,303,'',{location:'/login'});return;}
    if(path==='/admin/control/open'){const id=f.get('target'),user=validId(id)?store.get(id):null;if(!user&&!adminHosts[id]){reply(res,404,'目标不存在');return;}const sessionId=f.get('sessionId');if(sessionId&&!/^[a-zA-Z0-9_-]{1,128}$/.test(sessionId)){reply(res,400);return;}const grant=await adminAccess.create(s.account,s.token,{id,label:user?user.username:id==='server'?'服务器':'本机 Windows'});reply(res,303,'',{location:'/?muse_admin='+grant.token+(sessionId?'&muse_session='+encodeURIComponent(sessionId):'')});return;}
    reply(res,404);return;
   }catch(error){html(res,error.status||500,page('管理员验证',`<p>${escape(error.status?error.message:'操作失败，请重试')}</p><a href="/admin/control">返回管理员中心</a>`));return;}
  }
  if(context){touchAccount(targetId);await adminAccess.record(s.account,req.method+' '+path,context.target.id);}
  if(await feedbackRoute({req,res,path,actor:s.account,environment,feedback,feedbackAutomation,rate}))return;
  if(workspaceMode==='cloud'&&!s.account.admin&&/^\/api\/(settings[/.]|credentials[/.]|llm[/.](?:discoverModels|listConfigurableProviders)(?:\/|$))/.test(decodeURIComponent(path))){reply(res,403,'模型配置仅管理员可修改');return;}
  let bufferedBody;
  const rpcMethod=decodeURIComponent(path).replace(/^\/api\//,'').replace(/\./g,'/');
  if(workspaceMode==='cloud'&&globalModels&&['settings/describe','settings/mutate','settings/update','settings/replace','credentials/describe','credentials/set','credentials/unset','llm/listProviders','llm/listConfigurableProviders','llm/discoverModels'].includes(rpcMethod)){
   if(req.method!=='POST'){reply(res,405,'',{allow:'POST'});return;}
   let size=0,chunks=[];for await(const chunk of req){size+=chunk.length;if(size>1024*1024){reply(res,413);return;}chunks.push(chunk);}bufferedBody=Buffer.concat(chunks);
   let envelope;try{envelope=JSON.parse(bufferedBody.toString('utf8'));}catch{reply(res,400);return;}
   if(envelope?.type!=='client-request'||envelope.method!==rpcMethod||!['string','number'].includes(typeof envelope.rpcId)||!envelope.payload?.args||typeof envelope.payload.args!=='object'){reply(res,400);return;}
   const args=envelope.payload.args;
   const respond=result=>reply(res,200,JSON.stringify({type:'server-response',rpcId:envelope.rpcId,result}),{'content-type':'application/json; charset=utf-8'});
   if(!rpcMethod.startsWith('settings/')||rpcMethod==='settings/describe'||['llm-pi-ai','llm-deepseek'].includes(args.ns)){
    try{let value;
     if(rpcMethod==='settings/describe'){
      value=globalModels.describe();
      // Keep unrelated native settings visible. Tenant startup failure must not block central administration.
      try{const b=await backend(targetId);const response=await fetch(new URL('/api/settings/describe',b.target),{method:'POST',headers:fetchHeaders(req,b),body:bufferedBody,signal:AbortSignal.timeout(10000)});const upstream=await response.json();if(upstream.result?.ok&&Array.isArray(upstream.result.value?.namespaces)){const owned=value.namespaces;value={...upstream.result.value,namespaces:[...upstream.result.value.namespaces.filter(n=>!owned.some(g=>g.ns===n.ns)),...owned]};}}catch{}
     }else if(rpcMethod==='settings/mutate')value=await globalModels.mutate(args);
     else if(rpcMethod==='settings/update'||rpcMethod==='settings/replace')throw Object.assign(Error('请使用原生模型页面的路径编辑保存配置'),{code:'settings/rejected'});
     else if(rpcMethod==='credentials/describe')value=globalModels.describeCredentials(args.refs);
     else if(rpcMethod==='credentials/set')await globalModels.setCredential(args.ref,args.value);
     else if(rpcMethod==='credentials/unset')await globalModels.unsetCredential(args.ref);
     else if(rpcMethod==='llm/listProviders')value=globalModels.listProviders();
     else if(rpcMethod==='llm/listConfigurableProviders')value=globalModels.listConfigurableProviders();
     else if(rpcMethod==='llm/discoverModels')value=await globalModels.discoverModels(args);
     else throw Object.assign(Error('此环境暂不支持自动发现，请手动添加供应商模型 ID。'),{code:'llm/discovery-unsupported'});
     respond({ok:true,...value===undefined?{}:{value}});
    }catch(error){const discovered=rpcMethod==='llm/discoverModels';respond({ok:false,error:{code:error.code||(discovered?'llm/discovery-rejected':'settings/rejected'),message:error.code||discovered?error.message:'配置保存失败，请检查输入或稍后重试。',details:discovered?{settingsNs:args.settingsNs}:{}}});}return;
   }
  }
  if(path==='/logout'){if(req.method!=='POST'){reply(res,405,'',{allow:'POST'});return;}await revoke(s.token);reply(res,303,'',{location:'/login','set-cookie':`${cookieName}=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0`});return;}
  if(path==='/api/muse.account'&&req.method==='GET'){reply(res,200,JSON.stringify({username:s.account.username,admin:s.account.admin,environment,workspace:'/workspace',workspaceLabel:context?.target.label||s.account.username,fullAdmin:!!context,targetId:context?.target.id,targetLabel:context?.target.label,accountId:s.account.id,accountUrl:'/account',adminUrl:s.account.admin?'/admin':null}),{'content-type':'application/json; charset=utf-8'});return;}
  if(path==='/account'&&req.method==='GET'){html(res,200,accountDataPage(false)('我的账户',`<h1>我的账户</h1>${devOnlyAdmin?'<p>开发验证环境</p>':''}<p>${escape(s.account.username)}</p><nav><a href="/">进入工作间</a>${s.account.admin?'<a href="/admin">管理账户</a>':''}<form action="/logout" method="post"><button>退出登录</button></form></nav>${renderAccountDetails({profile:accountProfile(s.account,{organizationSnapshot:feishuOrgSync?.getSnapshot()}),escape})}${renderAccountIdentity({account:s.account,feishuEnabled:feishuLogin.enabled,feishuAppType:feishuLogin.appType,escape})}${s.account.passwordLogin&&!feishuOnlyLogin?`<h2>修改密码</h2><form action="/account/password" method="post"><label>原密码<input name="originalPassword" type="password" autocomplete="current-password" maxlength="128" required></label><label>新密码<input name="password" type="password" autocomplete="new-password" maxlength="128" required></label><button>修改密码</button></form><small>修改后需要重新登录。</small>`:'<p>此账号使用飞书登录，无需 Muse 密码。</p>'}`,false,{active:'account',admin:s.account.admin,username:s.account.username}),{feishuForm:feishuLogin.enabled,accountData:true});return;}

  if(path==='/account/password'){
   if(feishuOnlyLogin){reply(res,409,'当前仅开放飞书登录，账号密码操作已关闭');return;}
   if(req.method!=='POST'){reply(res,405,'',{allow:'POST'});return;}
   if(!rate(req,'password:'+s.id,5)){reply(res,429,'请稍后再试',{'retry-after':'60'});return;}
   const f=await form(req);try{await store.changePassword(s.id,f.get('originalPassword'),f.get('password'));}catch{html(res,400,page('修改密码失败','<p>原密码不正确，或新密码不符合要求。</p><a href="/account">返回我的账户</a>',true));return;}await accountRevocations.get(s.id);
   reply(res,303,'',{location:'/login','set-cookie':`${cookieName}=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0`});return;
  }
  if(path==='/admin'||path.startsWith('/admin/')){
   if(!s.account.admin){reply(res,403);return;}
   if(path==='/admin/groups'){
    if(req.method==='GET'){
     const account=store.get(new URL(req.url,publicOrigin).searchParams.get('id'));
     if(!account){reply(res,404);return;}html(res,200,renderAccountGroups({account,escape,page:(title,body)=>page(title,body,false,{active:'users',admin:true,username:s.account.username})}));return;
    }
    if(req.method!=='POST'){reply(res,405,'',{allow:'GET, POST'});return;}
    const fields=await form(req,131072),id=fields.get('id'),names=fields.getAll('groupName'),descriptions=fields.getAll('groupDescription');
    if(!validId(id)||!store.get(id)||names.length!==descriptions.length){reply(res,400);return;}
    const authorized=()=>{const current=session(req);return current?.token===s.token&&current.account.admin;};
    if(!authorized()){reply(res,403);return;}
    try{await store.setGroups(id,names.map((name,index)=>({name,description:descriptions[index]})).filter(group=>group.name.trim()!==''),{validateAssignment:authorized});}
    catch(error){void error;reply(res,400,'分组名称或说明无效，请返回检查');return;}
    reply(res,303,'',{location:'/admin'});return;
   }
   if(path==='/admin/models'&&globalModels){if(req.method==='GET')html(res,200,page('模型配置',`<h1>模型配置已移至设置</h1><p>请进入工作间的“设置 → 模型”管理当前环境所有编辑共用的供应商、模型与思考档位。</p><p>当前支持 OpenAI Chat Completions；请手动填写模型 ID。</p><a href="/">进入工作间</a>`));else reply(res,409,'请在工作间的设置 → 模型保存统一配置');return;}
   if(path==='/admin/models'&&modelConfig){
    if(req.method==='POST'){
     const fields=Object.fromEntries(await form(req));
     try{await modelConfig.update(fields);}catch(error){html(res,400,page('配置未保存',`<h1>配置未保存</h1><p>${escape(error.message)}</p><a href="/admin/models">返回模型设置</a>`,true));return;}
     reply(res,303,'',{location:'/admin/models?saved=1'});return;
    }
    if(req.method==='GET'){
     const value=modelConfig.view(),input=(label,key,type='text')=>`<label>${label}<input name="${key}" type="${type}" value="${escape(value[key])}" required></label>`;
     html(res,200,page('统一模型配置',`<div class="eyebrow">MUSE / ADMIN</div><h1>统一模型配置</h1><nav><a href="/">返回工作间</a><a href="/admin">用户管理</a></nav><p>${environment==='development'?'开发':'正式'}环境 · 所有编辑共用，另一环境不受影响。</p>${new URL(req.url,publicOrigin).searchParams.get('saved')==='1'?'<div class="notice">已保存。后续统一模型请求使用新配置，进行中的请求不会切换。</div>':''}<form class="model-form" action="/admin/models" method="post"><input type="hidden" name="revision" value="${value.revision}">${input('显示名称','name')}${input('服务地址（OpenAI 兼容 Chat Completions，例如 https://api.example.com/v1）','baseURL','url')}${input('供应商模型 ID','model')}<label>API Key · ${value.keyConfigured?'已配置，留空保持原值':'尚未配置'}<input name="apiKey" type="password" autocomplete="new-password" maxlength="4096" ${value.keyConfigured?'':'required'} placeholder="不回显已保存密钥"></label><div class="form-grid">${input('上下文容量（tokens）','contextWindow','number')}${input('单次最大输出（tokens）','maxTokens','number')}</div><button>保存统一配置</button></form><small>目前接入 OpenAI 兼容 Chat Completions；不支持把 Responses 或 Anthropic 地址直接填入。API Key 不下发到编辑工作间。新会话默认使用统一模型；旧会话需在模型选择器切换到“编辑部统一模型”。首次配置后请先做小规模验证。</small>`));return;
    }
    reply(res,405);return;
   }
   if(path==='/admin/organization/refresh'&&req.method==='POST'){
    if(!feishuOrgSync){reply(res,503,'组织信息同步尚未配置');return;}
    if(!rate(req,'organization-refresh:'+s.id,5)){reply(res,429,'请稍后再试',{'retry-after':'60'});return;}
    void feishuOrgSync.refresh().catch(()=>console.error('MUSE organization synchronization failed'));
    reply(res,303,'',{location:'/admin?org_refresh=started'});return;
   }
   if(path==='/admin'&&req.method==='GET'){const accounts=store.list(),adminCentre=!!adminAccess&&Object.keys(adminHosts).length>0;html(res,200,appendAccountData(renderAdminAccounts({accounts,session:s,devicesOf:id=>desktopRelay.devices({id}),adminCentre,adminHosts,now:now(),feishuEnabled:feishuLogin.enabled,passwordAuthEnabled:!feishuOnlyLogin,orgData:feishuOrgSync?.getSnapshot(),filters:Object.fromEntries(new URL(req.url,publicOrigin).searchParams),escape,page,environment,modelUsageEnabled:!!modelUsage}),true),{accountData:true});return;}
   if(req.method==='POST'&&['/admin/disable','/admin/reset'].includes(path)){if(path==='/admin/reset'&&feishuOnlyLogin){reply(res,409,'当前仅开放飞书登录，账号密码操作已关闭');return;}const f=await form(req),id=f.get('id');if(!validId(id)||!store.get(id)||id===s.id){reply(res,400,'操作不可用');return;}try{if(path==='/admin/disable'){await store.setDisabled(id,f.get('disabled')==='true');if(workspaceMode==='cloud'&&f.get('disabled')==='true')await runtime.stop?.(id);}else await store.resetPassword(id,f.get('password'));await accountRevocations.get(id);}catch{reply(res,400,'操作失败');return;}reply(res,303,'',{location:'/admin'});return;}

   reply(res,404);return;
  }
  if(workspaceMode==='desktop'&&!context){
   if(!mount&&path==='/'&&req.method==='GET'){reply(res,303,'',{location:'/workbench'});return;}
   if(await maintenance()){reply(res,503,'Muse 正在维护，请稍后重试。',{'retry-after':'30'});return;}
   const devices=desktopRelay.devices(s),available=devices.filter(device=>device.state==='online');
   if(!mount&&path==='/computers'&&req.method==='GET'){
    reply(res,200,page('选择电脑',desktopPicker(devices),false,{active:'computers',admin:s.account.admin,username:s.account.username}),{'content-type':'text/html; charset=utf-8','content-security-policy':"default-src 'none'; img-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'"});return;
   }
   if(await desktopRelay.forward(req,res,s))return;
   if(path==='/'&&req.method==='GET'){
    reply(res,200,page('选择电脑',desktopPicker(devices,mount?.deviceId),false,{active:'computers',admin:s.account.admin,username:s.account.username}),{'content-type':'text/html; charset=utf-8','content-security-policy':"default-src 'none'; img-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'"});
   }else reply(res,503,JSON.stringify({error:!mount&&available.length>1?'desktop-selection-required':'desktop-offline',message:!mount&&available.length>1?'请先选择要操作的电脑':'您的电脑上的 Muse 未启动'}),{'content-type':'application/json; charset=utf-8','retry-after':'5'});
   return;
  }
  if(workspaceMutation(path)&&!context){reply(res,403,'每个账户仅使用自己的工作间');return;}
  if(await maintenance()){reply(res,503,'工作间维护中，请稍后刷新。',{'retry-after':'30'});return;}
  const b=await backend(targetId);if(!scopeValid(req,s)){reply(res,403,'管理授权或登录已失效');return;}
  if(context&&path==='/'&&req.method==='GET'){
   const response=await fetch(new URL('/',b.target),{headers:{...fetchHeaders(req,b),'accept-encoding':'identity'},redirect:'manual',signal:AbortSignal.timeout(15000)});const body=await response.text();if(!scopeValid(req,s)){reply(res,403);return;}
   const script=`<script src="/admin/context-client.js" data-context="${context.token}" data-label="${escape(context.target.label)}" data-expiry="${context.expiry}"></script>`;
   const scopedBody=body.replace(/\b(src|href)=(['"])(\/[^'"]*)\2/g,(match,key,quote,path)=>{if(path.startsWith('//'))return match;const value=path.replaceAll('&amp;','&');return key+'='+quote+escape(value+(value.includes('?')?'&':'?')+'muse_admin='+context.token)+quote;});
   reply(res,response.status,scopedBody.replace(/<head([^>]*)>/i,match=>match+script),{'content-type':'text/html; charset=utf-8'});return;
  }
  let upstreamResponse;
  const proxy=http.request({hostname:b.target.hostname,port:b.target.port,path:cleanUrl(req),method:req.method,headers:headers(req,b)},out=>{upstreamResponse=out;if(!scopeValid(req,s)||res.destroyed){out.destroy();res.destroy();return;}out.on('error',()=>res.destroy());res.writeHead(out.statusCode,responseHeaders(out.headers,b.target));out.pipe(res);});
  const stream={destroy(){upstreamResponse?.destroy();proxy.destroy();res.destroy();}};
  if(!httpStreams.has(s.token))httpStreams.set(s.token,new Set());httpStreams.get(s.token).add(stream);
  const cancelExpiry=scheduleSessionExpiry(Math.min(s.expiry,context?.expiry??Infinity),()=>context?stream.destroy():revokeSoon(s.token),{now});
  const activity=setInterval(()=>touchAccount(targetId),30000);activity.unref();
  proxy.on('error',()=>{if(res.destroyed)return;if(!res.headersSent)reply(res,503,'工作间暂时不可用，请稍后刷新。');else res.destroy();});req.on('aborted',()=>stream.destroy());res.on('close',()=>{cancelExpiry();clearInterval(activity);const active=httpStreams.get(s.token);active?.delete(stream);if(active?.size===0)httpStreams.delete(s.token);upstreamResponse?.destroy();proxy.destroy();});if(bufferedBody)proxy.end(bufferedBody);else req.pipe(proxy);
 }catch(e){if(!res.headersSent)reply(res,e.status||503,e.status===413?'请求内容过大':'工作间正在准备或暂时繁忙，请稍后刷新。',{'content-type':'text/plain; charset=utf-8','retry-after':'10'});else res.destroy();}});
 server.on('upgrade',async(req,socket,head)=>{
  const reject=code=>socket.end(`HTTP/1.1 ${code} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);const s=session(req);if(!s){reject(401);return;}if(!originOK(req,true)){reject(403);return;}if(!req.url.startsWith('/')||req.url.startsWith('//')){reject(400);return;}
  if(workspaceMode==='desktop'&&new URL(req.url,publicOrigin).pathname==='/api/desktop/connect'){desktopRelay.control(req,socket,head,s);return;}
  if(workspaceMode==='desktop'&&!new URL(req.url,publicOrigin).searchParams.has('muse_admin')){
   let mount;try{mount=desktopRoute(req.url);}catch(error){reject(400);return;}
   if(mount&&!store.desktopDevices(s.id).some(device=>device.id===mount.deviceId)){reject(404);return;}
   if(!desktopRelay.upgrade(req,socket,head,s))reject(503);return;
  }
  try{const context=scope(req,s),targetId=context?.target.id||s.id;if(workspaceMutation(new URL(req.url,'http://localhost').pathname)&&!context){reject(403);return;}if(await maintenance()){reject(503);return;}const b=await backend(targetId);if(!scopeValid(req,s)){reject(401);return;}touchAccount(targetId);const proxy=http.request({hostname:b.target.hostname,port:b.target.port,path:cleanUrl(req),headers:headers(req,b)});
   proxy.on('upgrade',(response,upstream,backendHead)=>{if(!scopeValid(req,s)){upstream.destroy();reject(401);return;}if(!connections.has(s.token))connections.set(s.token,new Set());connections.get(s.token).add(socket);const cancelExpiry=scheduleSessionExpiry(Math.min(s.expiry,context?.expiry??Infinity),()=>context?socket.destroy():revokeSoon(s.token),{now});const touch=setInterval(()=>touchAccount(targetId),30000);touch.unref();socket.on('close',()=>{cancelExpiry();clearInterval(touch);connections.get(s.token)?.delete(socket);upstream.destroy();});socket.on('error',()=>upstream.destroy());upstream.on('error',()=>socket.destroy());upstream.on('close',()=>socket.destroy());socket.write(`HTTP/1.1 101 Switching Protocols\r\n${Object.entries(responseHeaders(response.headers,b.target)).map(([k,v])=>`${k}: ${v}\r\n`).join('')}\r\n`);if(head.length)upstream.write(head);if(backendHead.length)socket.write(backendHead);upstream.pipe(socket);socket.pipe(upstream);});proxy.on('response',r=>{r.resume();reject(502);});proxy.on('error',()=>reject(503));proxy.end();
  }catch{reject(503);}
 });
 server.botCoordination=botCoordination;
 server.attachProductionBoard=board=>{if(server.listening||productionBoard)throw Error('Attach the production board once before listening');productionBoard=board;};
 server.closeProductionBoard=()=>productionBoard?.close();
 server.closeBotCoordination=()=>{if(!botClosed){botClosed=true;botCoordination?.close();}};
 server.on('close',()=>{desktopRelay.close();desktopModels.close();void webSearch.close();store.off('change',changed);for(const token of activeTokens.keys())disconnect(token);void Promise.resolve(server.closeProductionBoard()).catch(()=>console.error('MUSE production board shutdown failed'));server.closeBotCoordination();});
 server.stopAdmission=()=>{admissionStopped=true;};server.closeFeishuLogin=()=>feishuLogin.close();server.closeWebSearch=()=>webSearch.close();server.closeFeishuOrganization=()=>feishuOrgSync?.close();server.closeNativeJubian=()=>nativeJubianHttp.close();return server;
}

/**
 * Stop task admission and release owned sockets and signals after synchronous responses settle.
 * @param options Listening gateway, feedback worker, provider service, and owned model resources.
 * @returns An idempotent close operation rejecting only after cleanup completes.
 */
export function installGatewayShutdown({accountServer,asr,market,modelRelay,modelKeyPool,flashRouting,modelUsage,usageLedger,sessionArchives,studioRuntime,companyCli,productionFees,nativeJubianAdmission,feedbackAutomation,stopSweep=()=>{},signals=process,onError=()=>console.error('MUSE gateway shutdown failed')}){

 const sockets=new Set();let completion;
 const connection=socket=>{sockets.add(socket);socket.once('close',()=>sockets.delete(socket));};
 accountServer.on('connection',connection);
 const closeServer=server=>new Promise((resolve,reject)=>{server.close(error=>error?reject(error):resolve());server.closeAllConnections();});
 function close(){
  if(completion)return completion;
  accountServer.stopAdmission();stopSweep();
  completion=(async()=>{
   let failure;try{await feedbackAutomation?.close();}catch(error){failure=error;}
   try{await accountServer.closeFeishuLogin?.();}catch(error){failure??=error;}
   try{await accountServer.closeFeishuOrganization?.();}catch(error){failure??=error;}
   try{await accountServer.closeProductionBoard?.();}catch(error){failure??=error;}
   try{await accountServer.closeWebSearch?.();}catch(error){failure??=error;}
   try{await asr?.close();}catch(error){failure??=error;}
   try{await companyCli?.close();}catch(error){failure??=error;}
   try{await market?.close();}catch(error){failure??=error;}
   for(const socket of sockets)socket.destroy();
   let nativeDrained=false;
   const closed=await Promise.allSettled([Promise.resolve().then(()=>studioRuntime?.close()),Promise.resolve().then(async()=>{await accountServer.closeNativeJubian?.();nativeDrained=true;}),closeServer(accountServer),...modelRelay?[closeServer(modelRelay)]:[]]);
   const stored=await Promise.allSettled([usageLedger?.flush(),sessionArchives?.flush(),flashRouting?.flush()]);
   if(nativeDrained){try{await nativeJubianAdmission?.close();}catch(error){failure??=error;}try{await productionFees?.close();}catch(error){failure??=error;}}
   modelKeyPool?.close();try{await modelUsage?.close();}catch(error){failure??=error;}accountServer.off('connection',connection);

   signals.off('SIGTERM',signal);signals.off('SIGINT',signal);
   if(failure)throw failure;for(const result of [...closed,...stored])if(result.status==='rejected')throw result.reason;
  })();
  return completion;
 }
 function signal(){void close().catch(()=>{process.exitCode=1;onError();});}
 signals.on('SIGTERM',signal);signals.on('SIGINT',signal);
 return {close};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(realpathSync(process.argv[1])).href){
 if(process.env.MUSE_DESKTOP_MODEL_TRANSPORT!==undefined&&process.env.MUSE_DESKTOP_MODEL_TRANSPORT!=='relay')throw Error('MUSE_DESKTOP_MODEL_TRANSPORT only accepts relay: Desktop direct model access was removed and supplier credentials never leave the gateway. Remove the setting and rotate every supplier key that direct access distributed');
 for(const name of ['MUSE_DESKTOP_MODEL_MAX_ACTIVE','MUSE_DESKTOP_MODEL_MAX_TOTAL'])if(process.env[name]!==undefined)throw Error(name+' is no longer supported; remove it to use unrestricted model relay concurrency');
 for(const name of ['MUSE_ZHIPU_DIRECT_TOKEN_MS','MUSE_ZHIPU_DIRECT_REQUEST_MS','MUSE_ZHIPU_DIRECT_CHECK_MS','MUSE_ZHIPU_DIRECT_GRACE_MS','MUSE_USAGE_RATE_PER_MINUTE'])if(process.env[name]!==undefined)throw Error(name+' is no longer supported; Desktop direct model access and its usage reports were removed');
 const modelCatalog=resolvePublicModelCatalog(process.env);
 const desktopRelayOptions=process.env.MUSE_DESKTOP_MAX_DEVICES===undefined?{}:{maxDevices:Number(process.env.MUSE_DESKTOP_MAX_DEVICES)};
 const workspaceMode=process.env.MUSE_WORKSPACE_MODE||'desktop';
 const studioConfig=await loadStudioConfig(process.env.MUSE_STUDIO_CONFIG);
 const studioRuntime=studioConfig?await createStudioRuntime(studioConfig,{publicOrigin:process.env.MUSE_PUBLIC_ORIGIN||'https://muse.aigc-pipeline.cn'}):undefined;
 const studioUsage=studioConfig?createStudioUsageReader(studioConfig):undefined;
 const accountFile=resolve(process.env.MUSE_ACCOUNTS_FILE||'/var/lib/muse/accounts.json');
 const sessionStore=await openSessionStore(resolveSessionFile(accountFile,process.env.MUSE_SESSIONS_FILE));
 const sessionTtlMs=resolveSessionTtlMs();
 const activityRequestRatePerMinute=process.env.MUSE_ACTIVITY_RATE_PER_MINUTE===undefined?120:Number(process.env.MUSE_ACTIVITY_RATE_PER_MINUTE);
 const feishuConfig=await loadFeishuLoginConfig(process.env.MUSE_FEISHU_LOGIN_CONFIG,{publicOrigin:process.env.MUSE_PUBLIC_ORIGIN||'https://muse.aigc-pipeline.cn',environment:process.env.MUSE_ENVIRONMENT||(process.env.MUSE_DEV_ONLY_ADMIN==='true'?'development':'production')});
 const feishuOnlyLogin=resolveFeishuOnlyLogin(process.env.MUSE_FEISHU_ONLY_LOGIN,!!feishuConfig);
 const workbenchClients=await loadWorkbenchClients(process.env.MUSE_WORKBENCH_LOGIN_CONFIG);
 const {createRuntime}=await import('./runtime.mjs');const store=await openStore(accountFile);const runtime=await createRuntime();
 const productionFees=await loadProductionFees(process.env.MUSE_PRODUCTION_APPROVAL_CONFIG,{accounts:store,publicOrigin:process.env.MUSE_PUBLIC_ORIGIN||'https://muse.aigc-pipeline.cn'});
 let nativeJubianAdmission;
 try{nativeJubianAdmission=await loadNativeJubianAdmission(process.env.MUSE_NATIVE_JUBIAN_ADMISSION_CONFIG,{accounts:store,nativeApprovals:productionFees?{verify:productionFees.verifyNativeJubian.bind(productionFees),verifyObservation:productionFees.verifyNativeJubianObservation.bind(productionFees),verifyBudget:productionFees.verifyNativeJubianBudget.bind(productionFees),verifySourceConsent:productionFees.verifyNativeJubianSourceConsent.bind(productionFees),verifySourceManaged:productionFees.verifyNativeJubianSourceManaged.bind(productionFees)}:undefined});}
 catch(error){productionFees?.close();throw error;}
 const usageLedger=await openUsageLedger(process.env.MUSE_USAGE_ROOT||join(dirname(accountFile),'usage'),{maxQueryDays:process.env.MUSE_USAGE_QUERY_DAYS===undefined?366:Number(process.env.MUSE_USAGE_QUERY_DAYS)});
 const sessionArchives=await openSessionArchives(process.env.MUSE_SESSION_ARCHIVES_ROOT||join(dirname(accountFile),'session-archives'),{
  ...process.env.MUSE_ARCHIVE_REVISION_BYTES===undefined?{}:{maxRevisionBytes:Number(process.env.MUSE_ARCHIVE_REVISION_BYTES)},
  ...process.env.MUSE_ARCHIVE_ATTACHMENT_BYTES===undefined?{}:{maxAttachmentBytes:Number(process.env.MUSE_ARCHIVE_ATTACHMENT_BYTES)},
  ...process.env.MUSE_ARCHIVE_EVENT_LIMIT===undefined?{}:{maxEvents:Number(process.env.MUSE_ARCHIVE_EVENT_LIMIT)},
  ...process.env.MUSE_ARCHIVE_ATTACHMENT_LIMIT===undefined?{}:{maxAttachmentsPerRevision:Number(process.env.MUSE_ARCHIVE_ATTACHMENT_LIMIT)},
  ...process.env.MUSE_ARCHIVE_REVISION_LIMIT===undefined?{}:{maxRevisionsPerSession:Number(process.env.MUSE_ARCHIVE_REVISION_LIMIT)},
  ...process.env.MUSE_ARCHIVE_ACCOUNT_BYTES===undefined?{}:{maxAccountBytes:Number(process.env.MUSE_ARCHIVE_ACCOUNT_BYTES)},
 });
 const archiveAdmissionOptions={
  ...process.env.MUSE_ARCHIVE_UPLOADS_PER_ACCOUNT===undefined?{}:{maxUploadsPerAccount:Number(process.env.MUSE_ARCHIVE_UPLOADS_PER_ACCOUNT)},
  ...process.env.MUSE_ARCHIVE_UPLOADS_TOTAL===undefined?{}:{maxUploadsTotal:Number(process.env.MUSE_ARCHIVE_UPLOADS_TOTAL)},
 };
 const orgInterval=Number(process.env.MUSE_FEISHU_ORG_SYNC_INTERVAL_MS??900000);
 if(!Number.isSafeInteger(orgInterval)||orgInterval<60000||orgInterval>86400000)throw Error('Invalid Feishu organization sync interval');
 const feishuOrgSync=feishuConfig?.appType==='custom'?createFeishuOrgCoordinator({config:feishuConfig,store}):undefined;

 const modelConfig=process.env.MUSE_MODEL_CONFIG?await openModelConfig(process.env.MUSE_MODEL_CONFIG):undefined;
 let globalModels,modelRelay,modelSecret;
 if(modelConfig){const {Config,discoverModels}=await import('../node_modules/@deepseek-ai/dsh-llm-pi-ai/lib/index.js');globalModels=await openGlobalModels(process.env.MUSE_MODEL_CONFIG+'.native',{legacyConfig:modelConfig,schema:restrictModelSchema(Config.toJSON()),discover:discoverModels});modelSecret=(await readFile(process.env.MUSE_MODEL_SECRET,'utf8')).trim();if(modelSecret.length<32)throw Error('Invalid model relay secret');}
 if(globalModels&&process.env.MUSE_YUNYING_BOOTSTRAP_FILE){
  try{const {bootstrapRelease}=await import('./yunying-bootstrap.mjs');const result=await bootstrapRelease({models:globalModels,keyPath:process.env.MUSE_YUNYING_BOOTSTRAP_FILE});console.log('[muse-yunying-bootstrap] '+result.status);}
  catch{console.error('[muse-yunying-bootstrap] unavailable');}
 }
 const flashRouting=await openDeepSeekFlashRouting({configFile:process.env.MUSE_DEEPSEEK_FLASH_ROUTING,
  affinityFile:join(dirname(accountFile),'deepseek-flash-affinity.json'),globalModels});
 const modelUsage=await openModelUsage(process.env.MUSE_MODEL_USAGE_FILE??join(dirname(accountFile),'model-usage','requests.sqlite'));
 const modelKeyPoolPolicy=resolveModelKeyPoolPolicy(process.env);
 const modelKeyPool=createModelKeyPool({keys:()=>globalModels?.credentialPool?.('zhipu-official')??[],...modelKeyPoolPolicy});
 const feedbackRoot=join(dirname(accountFile),'feedback');
 const feedback=await openFeedback(feedbackRoot);
 const feedbackAiConfig=await loadFeedbackAiConfig(process.env.MUSE_FEEDBACK_AI_CONFIG);
 const feedbackAnalyzer=feedbackAiConfig?createFeedbackAnalyzer(feedbackAiConfig,{auditRoot:join(feedbackRoot,'.automation','audit'),readAttachment:(id,index)=>feedback.attachment({admin:true},id,index)}):null;
 const feedbackAutomation=await openFeedbackAutomation({root:join(feedbackRoot,'.automation'),feedback,analyze:feedbackAnalyzer,config:{analysisTimeoutMs:feedbackAiConfig?.timeoutMs??60000}});
 const adminAccess=process.env.MUSE_ADMIN_ROOT?await openAdminAccess(process.env.MUSE_ADMIN_ROOT):undefined;
 const adminHosts=process.env.MUSE_ADMIN_HOSTS?JSON.parse(await readFile(process.env.MUSE_ADMIN_HOSTS,'utf8')):{};
 const kb=await loadKnowledgeBase();
 const market=await loadMarket();
 const voiceSlotOptions=resolveVoiceSlotOptions();
 const voiceSlots=voiceSlotOptions?createVoiceSlots({...voiceSlotOptions,...createJubianVoiceVerifier({timeoutMs:voiceSlotOptions.timeoutMs})}):undefined;
 if(voiceSlots)await voiceSlots.ready();
 let asr,asrStorage,asrSweepIntervalSeconds,asrRequestRatePerMinute;
 if(process.env.MUSE_ASR_CONFIG){
  const metadata=await stat(process.env.MUSE_ASR_CONFIG);
  if(!metadata.isFile()||(process.platform!=='win32'&&(metadata.mode&0o077)!==0))throw Error('MUSE ASR configuration file must be private');
  const {createAsrService,resolveAsrConfig}=await import('./asr-service.mjs');
  const config=resolveAsrConfig(JSON.parse(await readFile(process.env.MUSE_ASR_CONFIG,'utf8')));
  const {submitAsr,queryAsr,recognizeFlashAsr}=await import('./asr-provider.mjs');
  let storage;
  if(config.resources.some(row=>row.serviceVersion!=='flash')&&config.storageKind==='gateway'){
   const {createGatewayAudioStore}=await import('./asr-gateway-storage.mjs');
   storage=createGatewayAudioStore({...config.gatewayStorage,signedUrlTtlSeconds:config.signedUrlTtlSeconds,timeoutMs:config.timeoutMs});
   await storage.ready();asrStorage=storage;
  }else if(config.resources.some(row=>row.serviceVersion!=='flash')||config.accessKeyId){
   const {createTosAudioStore}=await import('./asr-storage.mjs');const sdk=await import('@volcengine/tos-sdk');
   storage=createTosAudioStore(config,sdk.default??sdk);
  }
  const resources=config.resources.map(resource=>{
   const credentials={appId:resource.appId,accessToken:resource.accessToken,resourceId:resource.resourceId,timeoutMs:config.timeoutMs,speakerDiarization:config.speakerDiarization,speakerDiarizationVersion:config.speakerDiarizationVersion,speakerLongAudioSeconds:config.speakerLongAudioSeconds};
   return {...resource,provider:{submit:input=>submitAsr(credentials,input),query:id=>queryAsr(credentials,id),recognize:input=>recognizeFlashAsr(credentials,input)}};
  });
  asr=createAsrService({root:config.root,storage,storageKind:config.storageKind,resources,quotaGroups:config.quotaGroups,defaultPoolId:config.defaultPoolId,legacyAppId:config.legacyAppId,routes:config.routes,providerKind:config.providerKind,autoStart:false,pollIntervalMs:config.pollIntervalMs,queryBackoffMaxMs:config.queryBackoffMaxMs,queryBlockedRetryMs:config.queryBlockedRetryMs,terminalQueryConfirmations:config.terminalQueryConfirmations,maxConcurrentJobs:config.maxConcurrentJobs,maxQueuedJobs:config.maxQueuedJobs,maxPendingUploadsPerAccount:config.maxPendingUploadsPerAccount,probe:file=>import('./asr-service.mjs').then(module=>module.probeAudio(file,config.ffprobePath)),maxAudioBytes:config.maxAudioBytes,maxDurationSeconds:config.maxDurationSeconds,maxDailySeconds:config.maxDailySeconds,maxDailyJobs:config.maxDailyJobs,maxActiveJobs:config.maxActiveJobs,retentionSeconds:config.retentionSeconds});
  await asr.ready();
  asrSweepIntervalSeconds=config.sweepIntervalSeconds;asrRequestRatePerMinute=config.requestRatePerMinute;
 }
 const companyCli=await loadCompanyCliService(process.env.MUSE_COMPANY_CLI_CONFIG,{accounts:store,studioRuntime,publicOrigin:process.env.MUSE_PUBLIC_ORIGIN||'https://muse.aigc-pipeline.cn'});
 const accountServer=createAccountServer({store,runtime,workspaceMode,desktopRelayOptions,workbenchOptions:{cloudDeviceId:process.env.MUSE_CLOUD_BOT_DEVICE_ID},botTeamOptions:process.env.MUSE_BOT_TEAM_DB?{file:process.env.MUSE_BOT_TEAM_DB,...process.env.MUSE_BOT_STATUS_TTL_MS?{statusTtlMs:Number(process.env.MUSE_BOT_STATUS_TTL_MS)}:{}}:undefined,feishuLoginOptions:{config:feishuConfig},workbenchClients,feishuOnlyLogin,feishuOrgSync,modelConfig,globalModels,flashRouting,modelCatalog,modelUsage,usageLedger,sessionArchives,studioRuntime,companyCli,studioUsage,productionFees,nativeJubianAdmission,nativeJubianApprovals:productionFees,nativeJubianMaxRequestBytes:process.env.MUSE_NATIVE_JUBIAN_REQUEST_BYTES===undefined?262144:Number(process.env.MUSE_NATIVE_JUBIAN_REQUEST_BYTES),nativeJubianRequestRatePerMinute:process.env.MUSE_NATIVE_JUBIAN_RATE_PER_MINUTE===undefined?120:Number(process.env.MUSE_NATIVE_JUBIAN_RATE_PER_MINUTE),productionFeeReadRatePerMinute:process.env.MUSE_FEE_READ_RATE_PER_MINUTE===undefined?120:Number(process.env.MUSE_FEE_READ_RATE_PER_MINUTE),archiveAdmissionOptions,modelKeyPoolPolicy,modelKeyPool,feedback,feedbackAutomation,adminAccess,adminHosts,kb,asr,asrStorage,asrRequestRatePerMinute,activityRequestRatePerMinute,voiceSlots,market,sessionStore,sessionTtlMs,publicOrigin:process.env.MUSE_PUBLIC_ORIGIN,logoPath:process.env.MUSE_LOGO_PATH});
 if(modelConfig)modelRelay=createModelRelay({config:modelConfig,globalModels,flashRouting,modelCatalog,secret:modelSecret,accounts:store,keyPool:modelKeyPool,keyPoolPolicy:modelKeyPoolPolicy,modelUsage,usageLedger}).listen(Number(process.env.MUSE_MODEL_PORT),process.env.MUSE_MODEL_HOST);
 let sweepInterval,orgTimer,productionTimer;
 if(process.env.MUSE_PRODUCTION_BOARD_CONFIG||process.env.MUSE_PRODUCTION_BOARD_DB){
  if(!process.env.MUSE_PRODUCTION_BOARD_CONFIG||!process.env.MUSE_PRODUCTION_BOARD_DB||!accountServer.botCoordination||!feishuConfig)throw Error('Production board requires its mapping, database, Bot coordination and existing Feishu identity');
  const {loadProductionConfig,createFeishuProductionSource}=await import('./production-source.mjs');
  const {openProductionBoard}=await import('./production-board.mjs');
  const config=await loadProductionConfig(process.env.MUSE_PRODUCTION_BOARD_CONFIG),source=createFeishuProductionSource({credentials:feishuConfig,config});
  const coordination=accountServer.botCoordination,board=await openProductionBoard({file:process.env.MUSE_PRODUCTION_BOARD_DB,config,source,proposeTask:input=>coordination.dispatchTask(input),taskById:id=>coordination.task(id),lookupTask:request=>coordination.findProposal(request),deviceOwner:id=>coordination.readyDeviceOwner(id)});
  accountServer.attachProductionBoard(board);
  const synchronize=()=>void board.sync().catch(()=>console.error('MUSE production source synchronization failed'));
  synchronize();productionTimer=setInterval(synchronize,config.intervalMs);productionTimer.unref();
 }
 installGatewayShutdown({accountServer,asr,market,modelRelay,modelKeyPool,flashRouting,modelUsage,usageLedger,sessionArchives,studioRuntime,companyCli,productionFees,nativeJubianAdmission,feedbackAutomation,stopSweep:()=>{clearInterval(sweepInterval);clearInterval(orgTimer);clearInterval(productionTimer);}});
 accountServer.listen(Number(process.env.MUSE_PORT||19388),'127.0.0.1',()=>{
  console.log('MUSE accounts gateway listening on loopback:'+accountServer.address().port);
  void feedbackAutomation.start().catch(()=>console.error('MUSE feedback automation startup failed'));
  if(asr)void asr.start().catch(()=>console.error('MUSE ASR startup failed'));
  if(feishuOrgSync){const sync=()=>void feishuOrgSync.refresh().catch(()=>console.error('MUSE organization synchronization failed'));sync();orgTimer=setInterval(sync,orgInterval);orgTimer.unref();}
 });

 if(asr){
  const sweep=()=>void asr.sweep().catch(()=>console.error('MUSE ASR retention cleanup failed'));
  sweep();sweepInterval=setInterval(sweep,asrSweepIntervalSeconds*1000);sweepInterval.unref();
 }
}

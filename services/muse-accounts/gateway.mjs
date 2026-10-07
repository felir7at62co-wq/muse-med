import http from 'node:http';
import {randomBytes} from 'node:crypto';
import {readFile,access,stat} from 'node:fs/promises';
import {realpathSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {dirname,join,isAbsolute} from 'node:path';
import {openFeedback} from './feedback.mjs';
import {feedbackRoute} from './feedback-http.mjs';
import {openAdminAccess} from './admin-access.mjs';
import {openStore,validId} from './store.mjs';
import {createKbMcp} from './kb-mcp.mjs';
import {loadDocumentGrants} from './kb-grants.mjs';
import {verifyPersonalRoot} from './kb-personal.mjs';
import {loadPortfolioReaders} from './kb-portfolio-config.mjs';
// Cloud knowledge base endpoint (bearer-token authenticated).
import {openModelConfig,createModelRelay} from './model-relay.mjs';
import {openGlobalModels,restrictModelSchema} from './global-models.mjs';
import {createDesktopModels} from './desktop-models.mjs';
import {createDesktopRelay} from './desktop-relay.mjs';
import {desktopRoute,desktopPrefix} from './desktop-route.mjs';
import {desktopPicker} from './desktop-picker.mjs';

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
const style='*{box-sizing:border-box}body{margin:0;background:#f7f6f2;color:#191919;font:16px system-ui,sans-serif}main{max-width:960px;margin:8vh auto;padding:36px;background:white;border:1px solid #e8e7e1;border-radius:24px}.auth{max-width:430px}img{width:72px;height:72px}h1{letter-spacing:5px}p,small{color:#777}label{display:block;margin-top:18px;font-size:14px}input,button{padding:12px;border-radius:8px;font:inherit;border:1px solid #ddd}.auth input,.auth button{width:100%}button{background:#202020;color:white;cursor:pointer;margin:12px 0}a{color:#444}nav{display:flex;gap:24px;align-items:center}td,th{text-align:left;padding:12px;border-bottom:1px solid #eee}table{width:100%;border-collapse:collapse}.row{display:flex;gap:8px;align-items:center}.row input{width:140px}@media(max-width:700px){main{margin:20px 12px;padding:22px}.scroll{overflow-x:auto}}';
const polish='body{background:#f5f5f3;-webkit-font-smoothing:antialiased}main{box-shadow:0 16px 70px #00000005}h1{font-size:30px;letter-spacing:-.04em;margin:16px 0}h2{font-size:20px;margin-top:32px}nav{flex-wrap:wrap;margin:24px 0}nav a{font-size:14px;text-decoration:none;border:1px solid #e3e3df;padding:9px 14px;border-radius:10px}a:hover{color:#000}input{background:#fafafa;transition:border-color .15s}input:focus{outline:2px solid #222;outline-offset:2px}button:hover{background:#404040}button:focus-visible,a:focus-visible{outline:2px solid #222;outline-offset:3px}.eyebrow{font-size:11px;letter-spacing:.2em;color:#888}.model-form{max-width:680px;margin:30px 0}.model-form input{display:block;width:100%;margin-top:8px}.form-grid{display:grid;grid-template-columns:1fr 1fr;gap:20px}.notice{padding:14px 18px;border:1px solid #d5dfd6;background:#f4f8f4;border-radius:12px;font-size:14px}small{display:block;line-height:1.8}th{color:#777;font-size:12px;font-weight:500}td{font-size:14px}.auth h1{letter-spacing:.14em}.auth>img{display:block;margin-bottom:22px}.auth form{margin:24px 0}.auth input{margin-top:8px}.auth small{font-size:12px}.auth>p{line-height:1.7}main:not(.auth)>form:not(.model-form){max-width:520px}main:not(.auth)>form>label input{display:block;width:100%;margin-top:8px}@media(max-width:600px){.form-grid{grid-template-columns:1fr;gap:0}h1{font-size:26px}main{border-radius:18px}}';
function page(title,body,auth=false){return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" href="/favicon.ico"><title>${escape(title)} · MUSE</title><style>${style}${polish}</style><main class="${auth?'auth':''}">${body}</main></html>`;}
function loginPage(register=false){return page(register?'注册':'登录',`<img src="/spider.png" alt="MUSE"><h1>MUSE</h1><p>让灵感成形，让故事发生。</p><form action="/${register?'register':'login'}" method="post"><label>用户名<input name="username" autocomplete="username" minlength="2" maxlength="32" required autofocus></label><label>密码<input name="password" type="password" autocomplete="${register?'new-password':'current-password'}" maxlength="128" required></label><button>${register?'注册并进入工作间':'进入工作间 →'}</button></form><p>${register?'已有账号？<a href="/login">登录</a>':'<a href="/register">免费注册个人工作间</a>'}</p><small>每个账号拥有独立的文档与会话。</small>`,true);}
export function createAccountServer({store,runtime={},workspaceMode='cloud',desktopRelayOptions={},modelConfig,globalModels,modelForward,feedback,adminAccess,adminHosts={},publicOrigin='https://muse.aigc-pipeline.cn',logoPath,kb,asr,asrStorage,now=Date.now,sessionTtlMs=43200000,devOnlyAdmin=process.env.MUSE_DEV_ONLY_ADMIN==='true',environment=process.env.MUSE_ENVIRONMENT||(devOnlyAdmin?'development':'production'),maintenanceFile=process.env.MUSE_MAINTENANCE_FILE,cookieName=process.env.MUSE_COOKIE_NAME||'__Host-muse'}){
 if(!['cloud','desktop'].includes(workspaceMode))throw Error('Invalid workspace mode');
 if(!['development','production'].includes(environment))throw Error('Invalid environment');
 if(!/^__Host-[A-Za-z0-9_-]+$/.test(cookieName))throw Error('Invalid secure session cookie name');
  function authorizeKbToken(token){const grant=kbAccessTokens.get(token);if(!grant)return null;const active=sessions.get(grant.sessionToken),account=active&&store.get(active.id);if(!active||!account||account.disabled||account.revision!==active.revision||active.id!==grant.accountId||active.expiry<=now()||grant.expiry<=now()){kbAccessTokens.delete(token);return null;}return {account,mode:'account'};}
  const kbEndpoint=kb?.vaultRoot&&typeof kb.secret==='string'&&kb.secret.length>=32?createKbMcp({vaultRoot:kb.vaultRoot,personalRoot:kb.personalRoot,accounts:store,secret:kb.secret,documentGrants:kb.documentGrants,portfolioReaders:kb.portfolioReaders,authorize:authorizeKbToken,embedder:kb.embedder,vectors:kb.vectors,semanticWeight:kb.semanticWeight,semanticFloor:kb.semanticFloor,onWarn:message=>console.error('[muse-kb]',message)}):null;
 async function maintenance(){if(!maintenanceFile)return false;try{await access(maintenanceFile);return true;}catch(e){if(e.code==='ENOENT')return false;throw e;}}
 function workspaceMutation(path){return /^\/api\/workspace[./](create|delete|rename|update|change|insertBefore)(?:\/|$)/.test(decodeURIComponent(path));}
 const desktopModels=createDesktopModels({globalModels,modelConfig,forward:modelForward,now});
 publicOrigin=new URL(publicOrigin).origin;const sessions=new Map(),rates=new Map(),connections=new Map(),cookies=new Map(),httpStreams=new Map(),kbAccessTokens=new Map();
 let desktopRelay;
 function revoke(token){desktopRelay?.revoke(token);desktopModels.revoke(token);sessions.delete(token);for(const [key,grant] of kbAccessTokens)if(grant.sessionToken===token)kbAccessTokens.delete(key);adminAccess?.revoke(token);for(const socket of connections.get(token)||[])socket.destroy();connections.delete(token);for(const stream of httpStreams.get(token)||[])stream.destroy();httpStreams.delete(token);}
 function touchAccount(id){try{Promise.resolve(runtime.touch?.(id)).catch(()=>{});}catch{}}
 const changed=id=>{for(const [token,s]of sessions)if(s.id===id)revoke(token);cookies.delete(id);};store.on('change',changed);
 function session(req){const token=(req.url?.startsWith('/api/desktop-models/')?req.headers.authorization?.match(/^Bearer ([A-Za-z0-9_-]+)$/)?.[1]:undefined)??req.headers.cookie?.split(';').map(x=>x.trim()).find(x=>x.startsWith(cookieName+'='))?.slice(cookieName.length+1);const s=sessions.get(token),a=s&&store.get(s.id);if(s&&s.expiry>now()&&a&&!a.disabled&&a.revision===s.revision&&(!devOnlyAdmin||a.admin))return {token,...s,account:a};if(token)revoke(token);return null;}
 function originOK(req,required=false){return req.headers.origin?req.headers.origin===publicOrigin:!required&&req.headers['sec-fetch-site']!=='cross-site';}
 desktopRelay=createDesktopRelay({...desktopRelayOptions,store,publicOrigin,now,validSession:s=>{const current=sessions.get(s.token),account=store.get(s.id);return !!current&&current.id===s.id&&current.expiry>now()&&!!account&&!account.disabled&&account.revision===current.revision;}});
 function reply(res,status,text='',extra={}){res.writeHead(status,{'cache-control':'no-store','x-content-type-options':'nosniff','referrer-policy':'no-referrer',...extra});res.end(text);}
 // Same-origin form navigation retains Origin for the CSRF check.
 function html(res,status,text){reply(res,status,text,{'referrer-policy':'same-origin','content-type':'text/html; charset=utf-8','content-security-policy':"default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'"});}
 function rate(req,type,limit){const time=now();for(const[k,v]of rates)if(time-v.start>=60000)rates.delete(k);const key=type+':'+(req.headers['x-real-ip']||req.socket.remoteAddress);if(!rates.has(key)&&rates.size>=10000)return false;const entry=rates.get(key)||{start:time,count:0};rates.set(key,entry);return ++entry.count<=limit;}
 async function form(req){let size=0;const chunks=[];for await(const chunk of req){size+=chunk.length;if(size>8192){const e=Error('请求内容过大');e.status=413;throw e;}chunks.push(chunk);}return new URLSearchParams(Buffer.concat(chunks).toString('utf8'));}
 function newSession(res,a){for(const[t,s]of sessions)if(s.expiry<=now())revoke(t);while(sessions.size>=10000)revoke(sessions.keys().next().value);const token=randomBytes(32).toString('base64url');sessions.set(token,{id:a.id,revision:a.revision,expiry:now()+sessionTtlMs});reply(res,303,'',{location:'/','set-cookie':`${cookieName}=${token}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(sessionTtlMs/1000)}`});}
 async function backend(id){if(!validId(id)&&!adminHosts[id])throw Error('Invalid account');const config=adminHosts[id]||await runtime.ensure(id);const target=new URL(config.upstream);if(target.protocol!=='http:'||target.hostname!=='127.0.0.1'||target.username||target.password)throw Error('Invalid backend');const url=(await readFile(config.bootstrapPath,'utf8')).trim();if(new URL(url).origin!==target.origin)throw Error('Invalid bootstrap');let cached=cookies.get(id);if(!cached||cached.url!==url){const promise=(async()=>{const r=await fetch(url,{redirect:'manual',signal:AbortSignal.timeout(10000)});const c=r.headers.getSetCookie().map(x=>x.split(';')[0]).join('; ');if(r.status>=400||!c)throw Error('Bootstrap failed');return c;})();cached={url,promise};cookies.set(id,cached);promise.catch(()=>{if(cookies.get(id)===cached)cookies.delete(id);});while(cookies.size>1000)cookies.delete(cookies.keys().next().value);}return {target,cookie:await cached.promise};}
 function scope(req,s){const value=new URL(req.url,publicOrigin).searchParams.get('muse_admin');if(value===null)return null;if(!adminAccess)throw Object.assign(Error('管理员完整版未开启'),{status:403});return {...adminAccess.resolve(s.account,s.token,value),token:value};}
 function cleanUrl(req){return req.url.replace(/([?&])muse_admin=[a-f0-9]{64}(?=&|$)/g,(_m,sep)=>sep==='?'?'?':'').replace('?&','?').replace(/\?$/,'');}
 function scopeValid(req,s){try{const current=session(req);if(!current||current.token!==s.token)return false;scope(req,current);return true;}catch{return false;}}
 function headers(req,backend){const h={...req.headers};for(const k of Object.keys(h))if(['cookie','authorization','host','forwarded','x-real-ip'].includes(k)||k.startsWith('x-forwarded-')||k.startsWith('x-muse-')||k==='x-account-id')delete h[k];h.host=backend.target.host;h.cookie=backend.cookie;if(h.origin)h.origin=backend.target.origin;return h;}
 function fetchHeaders(req,b){const h=headers(req,b);for(const k of ['connection','upgrade','keep-alive','transfer-encoding','te','trailer','proxy-authorization','proxy-authenticate','content-length'])delete h[k];return h;}
 function responseHeaders(h,target){const result={...h};delete result['set-cookie'];if(result.location){const u=new URL(result.location,target);if(u.origin===target.origin)result.location=u.pathname+u.search+u.hash;}return result;}
 const server=http.createServer(async(req,res)=>{try{
  if(!req.url.startsWith('/')||req.url.startsWith('//')){reply(res,400);return;}
  const mount=workspaceMode==='desktop'?desktopRoute(req.url):null,path=new URL(mount?.path??req.url,'http://localhost').pathname;
  if(asrStorage&&await asrStorage.handle(req,res))return;
  if(path==='/register'&&devOnlyAdmin){reply(res,403,'开发环境仅供管理员使用');return;}
  if(['/login','/register'].includes(path)&&req.method==='GET'){let content=devOnlyAdmin?loginPage(false).replace('<a href="/register">免费注册个人工作间</a>','开发验证环境 · 管理员登录'):loginPage(path==='/register');if(environment==='development')content=content.replace('<h1>MUSE</h1>','<h1>MUSE</h1><div class="eyebrow">开发验证环境</div>');html(res,200,content);return;}
  if(['/spider.png','/favicon.ico'].includes(path)&&req.method==='GET'){if(logoPath)reply(res,200,await readFile(logoPath),{'content-type':'image/png'});else reply(res,204);return;}
  if(['/login','/register'].includes(path)&&req.method==='POST'){
   if(!originOK(req,true)){reply(res,403);return;}if(!rate(req,path,path==='/login'?10:5)){reply(res,429,'请稍后再试',{'retry-after':'60'});return;}
   const f=await form(req);let a;if(path==='/register'){try{a=await store.create(f.get('username'),f.get('password'));}catch(e){html(res,400,page('注册失败',`<p>${escape(e.message)}</p><a href="/register">返回注册</a>`,true));return;}}else a=await store.authenticate(f.get('username'),f.get('password'));
   if(!a||devOnlyAdmin&&!a.admin){html(res,401,page('登录失败','<p>用户名或密码不正确，或账号不可用。</p><a href="/login">返回登录</a>',true));return;}newSession(res,a);return;
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
  const s=session(req);if(!s){if(path.startsWith('/api/desktop-models/'))reply(res,401,JSON.stringify({error:{message:'请先登录 Muse'}}),{'content-type':'application/json'});else reply(res,303,'',{location:'/login'});return;}if(!originOK(req,!['GET','HEAD','OPTIONS'].includes(req.method))){reply(res,403);return;}if(workspaceMode==='cloud')touchAccount(s.id);
  if(mount){
   if(!store.desktopDevices(s.id).some(device=>device.id===mount.deviceId)){reply(res,404,'电脑不存在');return;}
   if(new URL(req.url,publicOrigin).searchParams.has('muse_admin')){reply(res,400,'请从管理员中心打开管理目标');return;}
   if(new URL(req.url,publicOrigin).pathname===mount.prefix.slice(0,-1)){if(req.method==='GET'||req.method==='HEAD')reply(res,303,'',{location:mount.prefix+new URL(req.url,publicOrigin).search});else reply(res,400);return;}
  }
  if(['/api/desktop/status','/api/desktop/devices'].includes(path)&&workspaceMode==='desktop'){if(req.method!=='GET'){reply(res,405,'',{allow:'GET'});return;}reply(res,200,JSON.stringify(path.endsWith('/devices')?{devices:desktopRelay.devices(s)}:desktopRelay.status(s,mount?.deviceId)),{'content-type':'application/json; charset=utf-8'});return;}
  if(['/desktop-offline.js','/desktop-presence.js','/desktop-picker.js'].includes(path)&&workspaceMode==='desktop'&&req.method==='GET'){reply(res,200,await readFile(new URL('.'+path,import.meta.url)),{'content-type':'text/javascript; charset=utf-8'});return;}
  if(path.startsWith('/api/desktop-models/')){await desktopModels.handle(req,res,s,path);return;}
  if(path==='/api/kb/access'){
   if(req.method!=='POST'){reply(res,405,'',{allow:'POST'});return;}
   if(!kbEndpoint){reply(res,503,JSON.stringify({error:'云端知识库未配置'}),{'content-type':'application/json'});return;}
   if(!rate(req,'kb-access:'+s.id,30)){reply(res,429,'请求过于频繁',{'retry-after':'60'});return;}
   while(kbAccessTokens.size>=10000)kbAccessTokens.delete(kbAccessTokens.keys().next().value);
   const token=randomBytes(32).toString('base64url'),expiresAt=Math.min(s.expiry,now()+15*60_000);
   kbAccessTokens.set(token,{sessionToken:s.token,accountId:s.id,expiry:expiresAt});
   reply(res,200,JSON.stringify({url:publicOrigin+'/api/kb/mcp',token,expiresAt}),{'content-type':'application/json; charset=utf-8'});return;
  }
  if(path==='/api/asr/jobs'||path.startsWith('/api/asr/jobs/')){
   const answer=(status,value,retryAfter)=>reply(res,status,JSON.stringify(value),{'content-type':'application/json; charset=utf-8',...retryAfter?{'retry-after':String(retryAfter)}:{}});
   if(!asr){answer(503,{error:'Muse cloud transcription is not configured on this server'});return;}
   if(!rate(req,'asr:'+s.id,60)){answer(429,{error:'Cloud transcription request rate exceeded',error_code:'request_rate',retry_after:60},60);return;}
   try{
    if(path==='/api/asr/jobs'&&req.method==='POST'){
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
    if(path==='/admin/control/lock'){revoke(s.token);reply(res,303,'',{location:'/login'});return;}
    if(path==='/admin/control/open'){const id=f.get('target'),user=validId(id)?store.get(id):null;if(!user&&!adminHosts[id]){reply(res,404,'目标不存在');return;}const sessionId=f.get('sessionId');if(sessionId&&!/^[a-zA-Z0-9_-]{1,128}$/.test(sessionId)){reply(res,400);return;}const grant=await adminAccess.create(s.account,s.token,{id,label:user?user.username:id==='server'?'服务器':'本机 Windows'});reply(res,303,'',{location:'/?muse_admin='+grant.token+(sessionId?'&muse_session='+encodeURIComponent(sessionId):'')});return;}
    reply(res,404);return;
   }catch(error){html(res,error.status||500,page('管理员验证',`<p>${escape(error.status?error.message:'操作失败，请重试')}</p><a href="/admin/control">返回管理员中心</a>`));return;}
  }
  if(context){touchAccount(targetId);await adminAccess.record(s.account,req.method+' '+path,context.target.id);}
  if(await feedbackRoute({req,res,path,actor:s.account,environment,feedback,rate}))return;
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
  if(path==='/logout'){if(req.method!=='POST'){reply(res,405,'',{allow:'POST'});return;}revoke(s.token);reply(res,303,'',{location:'/login','set-cookie':`${cookieName}=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0`});return;}
  if(path==='/api/muse.account'&&req.method==='GET'){reply(res,200,JSON.stringify({username:s.account.username,admin:s.account.admin,environment,workspace:'/workspace',workspaceLabel:context?.target.label||s.account.username,fullAdmin:!!context,targetId:context?.target.id,targetLabel:context?.target.label,accountId:s.account.id,accountUrl:'/account',adminUrl:s.account.admin?'/admin':null}),{'content-type':'application/json; charset=utf-8'});return;}
  if(path==='/account'&&req.method==='GET'){html(res,200,page('我的账户',`<h1>我的账户</h1>${devOnlyAdmin?'<p>开发验证环境</p>':''}<p>${escape(s.account.username)}</p><nav><a href="/">进入工作间</a>${s.account.admin?'<a href="/admin">管理账户</a>':''}<form action="/logout" method="post"><button>退出登录</button></form></nav><h2>修改密码</h2><form action="/account/password" method="post"><label>原密码<input name="originalPassword" type="password" autocomplete="current-password" maxlength="128" required></label><label>新密码<input name="password" type="password" autocomplete="new-password" maxlength="128" required></label><button>修改密码</button></form><small>修改后需要重新登录。</small>`));return;}
  if(path==='/account/password'){
   if(req.method!=='POST'){reply(res,405,'',{allow:'POST'});return;}
   if(!rate(req,'password:'+s.id,5)){reply(res,429,'请稍后再试',{'retry-after':'60'});return;}
   const f=await form(req);try{await store.changePassword(s.id,f.get('originalPassword'),f.get('password'));}catch{html(res,400,page('修改密码失败','<p>原密码不正确，或新密码不符合要求。</p><a href="/account">返回我的账户</a>',true));return;}
   reply(res,303,'',{location:'/login','set-cookie':`${cookieName}=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0`});return;
  }
  if(path==='/admin'||path.startsWith('/admin/')){
   if(!s.account.admin){reply(res,403);return;}
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
   if(path==='/admin'&&req.method==='GET'){const adminCentre=!!adminAccess&&Object.keys(adminHosts).length>0,rows=store.list().map(a=>`<tr><td>${escape(a.username)}${a.admin?'（管理员）':''}</td><td>${escape(a.createdAt.slice(0,10))}</td><td>${a.disabled?'已停用':'正常'}</td><td>${a.id===s.id?'当前账号':`<form action="/admin/disable" method="post"><input type="hidden" name="id" value="${a.id}"><input type="hidden" name="disabled" value="${!a.disabled}"><button>${a.disabled?'启用':'停用'}</button></form>`}</td><td>${a.id===s.id?'<a href="/account">修改密码</a>':`<form class="row" action="/admin/reset" method="post"><input type="hidden" name="id" value="${a.id}"><input type="password" name="password" maxlength="128" required placeholder="新密码" autocomplete="new-password"><button>修改密码</button></form>`}</td><td>${adminCentre&&s.account.admin?`<form class="row" action="/admin/control/open" method="post" target="_blank"><input type="hidden" name="target" value="${a.id}"><button>进入其工作间 ↗</button></form>`:''}</td></tr>`).join('');
    const machines=adminCentre?Object.keys(adminHosts).map(id=>`<form action="/admin/control/open" method="post" target="_blank"><input type="hidden" name="target" value="${escape(id)}"><button>${escape(id==='server'?'服务器 · 完整 DSH':'本机 Windows · 完整 DSH')} ↗</button></form>`).join(''):'';
    html(res,200,page('账户管理',`<h1>账户管理</h1><nav><a href="/">我的工作间</a><a href="/account">我的账户</a>${adminCentre?'<a href="/admin/control">管理员中心</a>':''}</nav><p>管理账号状态与密码；私人文档和会话不在此展示。</p><div class="scroll"><table><thead><tr><th>用户名</th><th>注册日期</th><th>状态</th><th>账号操作</th><th>密码操作</th></tr></thead><tbody>${rows}</tbody></table></div>${machines?`<h2>整机入口</h2><p>需要先通过管理员中心验证独立口令，验证后这些入口才可用。</p>${machines}`:''}`));return;}
   if(req.method==='POST'&&['/admin/disable','/admin/reset'].includes(path)){const f=await form(req),id=f.get('id');if(!validId(id)||!store.get(id)||id===s.id){reply(res,400,'操作不可用');return;}try{if(path==='/admin/disable'){await store.setDisabled(id,f.get('disabled')==='true');if(f.get('disabled')==='true')await runtime.stop?.(id);}else await store.resetPassword(id,f.get('password'));}catch{reply(res,400,'操作失败');return;}reply(res,303,'',{location:'/admin'});return;}
   reply(res,404);return;
  }
  if(workspaceMode==='desktop'&&!context){
   if(await maintenance()){reply(res,503,'Muse 正在维护，请稍后重试。',{'retry-after':'30'});return;}
   const devices=desktopRelay.devices(s),available=devices.filter(device=>device.state==='online');
   if(!mount&&path==='/'&&req.method==='GET'&&available.length===1){reply(res,303,'',{location:desktopPrefix(available[0].id)+new URL(req.url,publicOrigin).search});return;}
   if(!mount&&path==='/computers'&&req.method==='GET'){
    reply(res,200,page('选择电脑',desktopPicker(devices)),{'content-type':'text/html; charset=utf-8','content-security-policy':"default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; script-src 'self'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'"});return;
   }
   if(await desktopRelay.forward(req,res,s))return;
   if(path==='/'&&req.method==='GET'){
    reply(res,200,page('选择电脑',desktopPicker(devices,mount?.deviceId)),{'content-type':'text/html; charset=utf-8','content-security-policy':"default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; script-src 'self'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'"});
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
  const expiry=setTimeout(()=>context?stream.destroy():revoke(s.token),Math.max(1,Math.min(s.expiry,context?.expiry??Infinity)-now()));expiry.unref();
  const activity=setInterval(()=>touchAccount(targetId),30000);activity.unref();
  proxy.on('error',()=>{if(res.destroyed)return;if(!res.headersSent)reply(res,503,'工作间暂时不可用，请稍后刷新。');else res.destroy();});req.on('aborted',()=>stream.destroy());res.on('close',()=>{clearTimeout(expiry);clearInterval(activity);const active=httpStreams.get(s.token);active?.delete(stream);if(active?.size===0)httpStreams.delete(s.token);upstreamResponse?.destroy();proxy.destroy();});if(bufferedBody)proxy.end(bufferedBody);else req.pipe(proxy);
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
   proxy.on('upgrade',(response,upstream,backendHead)=>{if(!scopeValid(req,s)){upstream.destroy();reject(401);return;}if(!connections.has(s.token))connections.set(s.token,new Set());connections.get(s.token).add(socket);const timer=setTimeout(()=>context?socket.destroy():revoke(s.token),Math.max(1,Math.min(s.expiry,context?.expiry??Infinity)-now()));timer.unref();const touch=setInterval(()=>touchAccount(targetId),30000);touch.unref();socket.on('close',()=>{clearTimeout(timer);clearInterval(touch);connections.get(s.token)?.delete(socket);upstream.destroy();});socket.on('error',()=>upstream.destroy());upstream.on('error',()=>socket.destroy());upstream.on('close',()=>socket.destroy());socket.write(`HTTP/1.1 101 Switching Protocols\r\n${Object.entries(responseHeaders(response.headers,b.target)).map(([k,v])=>`${k}: ${v}\r\n`).join('')}\r\n`);if(head.length)upstream.write(head);if(backendHead.length)socket.write(backendHead);upstream.pipe(socket);socket.pipe(upstream);});proxy.on('response',r=>{r.resume();reject(502);});proxy.on('error',()=>reject(503));proxy.end();
  }catch{reject(503);}
 });server.on('close',()=>{desktopRelay.close();desktopModels.close();store.off('change',changed);for(const token of sessions.keys())revoke(token);});return server;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(realpathSync(process.argv[1])).href){
 for(const name of ['MUSE_DESKTOP_MODEL_MAX_ACTIVE','MUSE_DESKTOP_MODEL_MAX_TOTAL'])if(process.env[name]!==undefined)throw Error(name+' is no longer supported; remove it to use unrestricted model relay concurrency');
 const workspaceMode=process.env.MUSE_WORKSPACE_MODE||'desktop';
 const {createRuntime}=await import('./runtime.mjs');const store=await openStore(process.env.MUSE_ACCOUNTS_FILE||'/var/lib/muse/accounts.json');const runtime=await createRuntime();
 const modelConfig=process.env.MUSE_MODEL_CONFIG?await openModelConfig(process.env.MUSE_MODEL_CONFIG):undefined;
 let globalModels;
 if(modelConfig){const {Config,discoverModels}=await import('../node_modules/@deepseek-ai/dsh-llm-pi-ai/lib/index.js');globalModels=await openGlobalModels(process.env.MUSE_MODEL_CONFIG+'.native',{legacyConfig:modelConfig,schema:restrictModelSchema(Config.toJSON()),discover:discoverModels});const secret=(await readFile(process.env.MUSE_MODEL_SECRET,'utf8')).trim();if(secret.length<32)throw Error('Invalid model relay secret');createModelRelay({config:modelConfig,globalModels,secret,accounts:store}).listen(Number(process.env.MUSE_MODEL_PORT),process.env.MUSE_MODEL_HOST);}
 const feedback=await openFeedback(join(dirname(process.env.MUSE_ACCOUNTS_FILE||'/var/lib/muse/accounts.json'),'feedback'));
 const adminAccess=process.env.MUSE_ADMIN_ROOT?await openAdminAccess(process.env.MUSE_ADMIN_ROOT):undefined;
 const adminHosts=process.env.MUSE_ADMIN_HOSTS?JSON.parse(await readFile(process.env.MUSE_ADMIN_HOSTS,'utf8')):{};
 const kb=await loadKnowledgeBase();
 let asr,asrStorage,asrSweepIntervalSeconds;
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
  asr=createAsrService({root:config.root,storage,storageKind:config.storageKind,resources,quotaGroups:config.quotaGroups,defaultPoolId:config.defaultPoolId,legacyAppId:config.legacyAppId,routes:config.routes,providerKind:config.providerKind,autoStart:false,pollIntervalMs:config.pollIntervalMs,maxConcurrentJobs:config.maxConcurrentJobs,maxQueuedJobs:config.maxQueuedJobs,maxPendingUploadsPerAccount:config.maxPendingUploadsPerAccount,probe:file=>import('./asr-service.mjs').then(module=>module.probeAudio(file,config.ffprobePath)),maxAudioBytes:config.maxAudioBytes,maxDurationSeconds:config.maxDurationSeconds,maxDailySeconds:config.maxDailySeconds,maxDailyJobs:config.maxDailyJobs,maxActiveJobs:config.maxActiveJobs,retentionSeconds:config.retentionSeconds});
  await asr.ready();
  asrSweepIntervalSeconds=config.sweepIntervalSeconds;
 }
 const accountServer=createAccountServer({store,runtime,workspaceMode,modelConfig,globalModels,feedback,adminAccess,adminHosts,kb,asr,asrStorage,publicOrigin:process.env.MUSE_PUBLIC_ORIGIN,logoPath:process.env.MUSE_LOGO_PATH});
 accountServer.listen(Number(process.env.MUSE_PORT||19388),'127.0.0.1',()=>{console.log('MUSE accounts gateway listening on loopback:'+accountServer.address().port);if(asr)void asr.start().catch(()=>console.error('MUSE ASR startup failed'));});
 if(asr){
  const sweep=()=>void asr.sweep().catch(()=>console.error('MUSE ASR retention cleanup failed'));
  sweep();setInterval(sweep,asrSweepIntervalSeconds*1000).unref();
 }
}

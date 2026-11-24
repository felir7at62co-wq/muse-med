/** Optional account-authorized routes to the independent Bot and Skill catalog. */
import {readFile,lstat} from 'node:fs/promises';
import {isAbsolute} from 'node:path';
import {PassThrough} from 'node:stream';
import {createMarketProxy,validMarketRequestTarget} from './market-proxy.mjs';
import {validId} from './store.mjs';

/** Load an explicitly configured catalog proxy; absence leaves market routes disabled.
 * @param {object} environment Gateway environment with an optional administrator-owned policy filename.
 * @returns {Promise<object|undefined>} Owned proxy, or undefined when not configured.
 */
export async function loadMarket(environment=process.env){
 if(environment.MUSE_MARKET_CONFIG===undefined||environment.MUSE_MARKET_CONFIG==='')return;
 if(!isAbsolute(environment.MUSE_MARKET_CONFIG))throw Error('Market policy filename must be absolute');
 const metadata=await lstat(environment.MUSE_MARKET_CONFIG);
 if(!metadata.isFile()||metadata.isSymbolicLink()||(process.platform!=='win32'&&(metadata.mode&0o022)!==0))throw Error('Market policy must be a regular administrator-owned file');
 return await createMarketProxy(JSON.parse(await readFile(environment.MUSE_MARKET_CONFIG,'utf8')));
}

/** Bot and Skill catalog page (policy `web: "bots-and-skills"`, the default); all publication text is rendered through textContent. */
export const marketPage=`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Bot 与 Skills 市场 · MUSE</title><link rel="stylesheet" href="/market/catalog.css"><script type="module" src="/market/client.js"></script></head><body><header><a class="brand" href="/market">MUSE <span>创作市场</span></a><nav><a href="/">工作间</a><a href="/account">我的账号</a><a href="/login" id="login">登录</a></nav></header><main><section class="hero"><div class="eyebrow">由创作者共建</div><h1>把好方法，变成创作能力。</h1><p>发现制作团队分享的 Bot 与 Skills，下载到 Muse 使用。</p></section><section class="toolbar" aria-label="筛选"><div class="tabs"><button data-view="public" aria-pressed="true">发现</button><button data-view="mine" aria-pressed="false">创作者中心</button></div><form id="search"><label class="sr" for="query">搜索市场</label><input id="query" type="search" maxlength="200" placeholder="搜索名称、用途或制作团队"><label class="sr" for="kind">类型</label><select id="kind"><option value="">全部类型</option><option value="bot">Bot</option><option value="skill">Skills</option></select><button>搜索</button></form></section><p id="notice" role="status" aria-live="polite"></p><section id="creator" hidden><h2>上传新版本</h2><p>上传完整的 Muse 发布包（ZIP）。上传后保存为私有草稿，请检查详情后提交审核。</p><form id="upload"><label>发布团队<select id="publisher" required></select></label><label>发布包<input id="package" type="file" accept=".zip,application/zip" required></label><button>上传为私有草稿</button></form><details id="invite" hidden><summary>管理员：开通发布团队</summary><form id="invitation"><label>团队名称<input id="team" maxlength="100" required></label><label>成员账号 ID<input id="member" pattern="[a-f0-9]{16}" required></label><button>开通发布权限</button></form></details></section><section id="catalog" class="grid" aria-label="市场内容"></section><dialog id="detail"><button id="close" aria-label="关闭详情">×</button><div id="detail-body"></div></dialog><footer>Bot 提供一套创作工作方式，Skill 提供可复用的方法与资源。发布内容经过审核，版本保持独立。</footer></main></body></html>`;

/** Skill publication page (policy `web: "skills"`); authenticated API policy remains server-owned. */
export const skillMarketPage=`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Skill 市场 · MUSE</title><link rel="stylesheet" href="/market/style.css"><script type="module" src="/market/client.js"></script></head>
<body><header><a class="brand" href="/">MUSE</a><nav><a href="/" data-copy="home">工作间</a><a href="/account" data-copy="account">我的账号</a><a href="/login" id="market-login" data-copy="login">登录</a><button type="button" id="market-logout" data-copy="logout" hidden>退出登录</button></nav><div class="preferences"><label class="sr-only" for="market-language">Language</label><select id="market-language" aria-label="Language"><option value="zh">简体中文</option><option value="en">English</option></select><label class="sr-only" for="market-theme">Theme</label><select id="market-theme" aria-label="Theme"><option value="auto" data-copy="themeAuto">跟随系统</option><option value="light" data-copy="themeLight">浅色</option><option value="dark" data-copy="themeDark">深色</option></select></div></header>
<main id="market-root"><section class="heading"><p class="eyebrow">MUSE · SKILLS</p><h1 data-copy="title">Skill 市场</h1><p class="intro" data-copy="intro">发现可以带回创作流程的 Skill，查看版本、说明与发布状态</p><p id="market-identity" class="muted"></p></section><div id="market-status" class="notice" role="status" aria-live="polite"></div>
<div class="market-layout"><section aria-labelledby="catalog-heading"><div class="section-heading"><h2 id="catalog-heading" data-copy="catalog">探索 Skill</h2><button id="catalog-refresh" type="button" data-copy="refresh">刷新</button></div><div id="market-tabs" class="tabs"><button type="button" data-tab="public" aria-pressed="true" data-copy="public">已发布</button><button type="button" data-tab="mine" aria-pressed="false" data-copy="mine" disabled>我的发布</button></div><form id="catalog-search-form" class="search"><label class="sr-only" for="catalog-search" data-copy="searchLabel">名称、发布编号或关键词</label><input id="catalog-search" type="search" maxlength="200" autocomplete="off"><button type="submit" data-copy="search">搜索</button></form><p class="muted small" data-copy="bounded">每次展示最多 100 条；可按名称或发布编号搜索，不代表完整目录</p><div id="catalog-list" class="catalog-list" aria-live="polite"></div></section>
<aside class="creator" aria-labelledby="creator-heading"><p class="eyebrow">CREATE & SHARE</p><h2 id="creator-heading" data-copy="creator">发布你的 Skill</h2><p class="muted" data-copy="creatorIntro">选择已准备好的 Skill ZIP。上传后是私有草稿，需另行提交审核</p><p id="publisher-status" class="small muted"></p><form id="market-upload-form"><label for="publisher-select" data-copy="publisher">发布团队</label><select id="publisher-select" required disabled></select><label for="archive-input" data-copy="archive">Skill ZIP</label><input id="archive-input" type="file" accept=".zip,application/zip" disabled><p id="archive-facts" class="small muted"></p><button id="upload-button" class="primary" type="submit" data-copy="upload" disabled>上传私有草稿</button></form><div class="upload-recovery"><button id="upload-retry" type="button" data-copy="retryUpload" hidden>沿用原编号重试</button><button id="upload-cancel" type="button" data-copy="cancelUpload" hidden>放弃本次上传</button></div><p id="upload-status" class="notice" role="status" aria-live="polite"></p><div id="draft-result"></div><p class="small muted" data-copy="downloadOnly">网页下载经校验的 ZIP；安装和默认 Skill 选择在 Muse 桌面端完成</p></aside></div><footer data-copy="footer">上传、提交审核与下载分别由你发起；发布不会自动启用或执行 Skill</footer></main></body></html>`;

/** Stylesheet of the Bot and Skill catalog page, served as `/market/catalog.css`. */
export const catalogStyle=':root{color-scheme:light;font:15px/1.65 system-ui,-apple-system,"Segoe UI",sans-serif;color:#252622;background:#f5f5f0}*{box-sizing:border-box}body{margin:0}header{max-width:1200px;margin:auto;padding:24px 36px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid #dddfd6}a{color:inherit;text-underline-offset:4px}.brand{text-decoration:none;font-size:22px;font-weight:750;letter-spacing:.06em}.brand span{font-size:13px;font-weight:450;letter-spacing:0;margin-left:14px;color:#6a7063}nav{display:flex;gap:24px;font-size:13px}main{max-width:1200px;margin:auto;padding:0 36px}.hero{padding:68px 0 40px;max-width:750px}.eyebrow{font-size:12px;letter-spacing:.16em;color:#667352}h1{font-size:clamp(26px,4vw,42px);line-height:1.3;letter-spacing:-.04em;margin:16px 0}h2{font-size:20px;line-height:1.4;margin:12px 0}p{color:#63695e}.toolbar{display:flex;flex-wrap:wrap;gap:20px;align-items:center;justify-content:space-between;margin-bottom:24px}.tabs{display:flex;gap:8px}button,input,select{font:inherit;border:1px solid #d7dbcf;border-radius:9px;padding:9px 13px;background:#fff;color:inherit}button{cursor:pointer;font-size:13px}button:hover{border-color:#737e60}button[aria-pressed=true],button.primary{background:#34452a;color:white;border-color:#34452a}button:disabled{opacity:.5;cursor:wait}button:focus-visible,a:focus-visible,input:focus-visible,select:focus-visible,summary:focus-visible{outline:3px solid #8d9e6e;outline-offset:3px}form{display:flex;flex-wrap:wrap;gap:12px;align-items:end}label{display:flex;flex-direction:column;gap:6px;font-size:13px}#query{width:min(340px,55vw)}.grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:18px}.card{background:#fff;border:1px solid #dce0d3;border-radius:16px;padding:24px;display:flex;flex-direction:column;align-items:start;gap:10px}.card h2{margin:0}.card p{font-size:14px;margin:0;white-space:pre-wrap;overflow-wrap:anywhere;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}.card .meta{font-size:12px;color:#737b68}.card button{margin-top:auto}.badge{display:inline-block;padding:3px 9px;border-radius:6px;background:#eef1e7;font-size:11px;color:#526341}#creator{padding:24px;margin:20px 0;background:#eef1e8;border:1px solid #dce0d3;border-radius:16px}#invite{margin-top:20px}#invite form{margin-top:16px}#notice{min-height:26px;margin:0 0 16px;color:#665237;white-space:pre-wrap}dialog{border:1px solid #dce0d3;border-radius:20px;padding:32px;width:min(660px,calc(100vw - 32px));max-height:85vh;overflow:auto;background:#fff;color:inherit}dialog::backdrop{background:#17211277}#close{float:right;font-size:22px;padding:2px 12px}.facts{font-size:13px;overflow-wrap:anywhere}.facts p{white-space:pre-wrap}.actions{display:flex;gap:12px;flex-wrap:wrap;margin-top:24px}footer{padding:64px 0 32px;font-size:12px;color:#737b68}.sr{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}@media(max-width:900px){.grid{grid-template-columns:repeat(2,minmax(0,1fr))}}@media(max-width:600px){header{padding:18px}header nav{gap:12px}.brand span{display:none}main{padding:0 18px}.hero{padding-top:40px}.grid{grid-template-columns:1fr}.toolbar form{width:100%}#query{flex:1;width:100%;min-width:120px}dialog{padding:24px}}';

async function prepareInvitation(req,res,maximum,deadline){
 const remaining=deadline-performance.now();if(remaining<=0)return {status:504,error:'market-timeout'};
 const input=new PassThrough(),chunks=[];let size=0,timedOut=false;
 const cancelled=()=>input.destroy(Error('request-closed'));
 const timer=setTimeout(()=>{timedOut=true;input.destroy(Error('market-timeout'));},remaining);timer.unref();
 req.once('aborted',cancelled);req.once('error',cancelled);res.once('close',cancelled);req.pipe(input);
 try{
  for await(const chunk of input){size+=chunk.length;if(size>maximum)return {status:413,error:'request-too-large'};chunks.push(chunk);}
  return {bytes:Buffer.concat(chunks)};
 }catch(error){
  if(timedOut)return {status:504,error:'market-timeout'};
  if(req.aborted||res.destroyed)return {aborted:true};
  throw error;
 }finally{
  clearTimeout(timer);req.off('aborted',cancelled);req.off('error',cancelled);res.off('close',cancelled);
  req.unpipe(input);input.destroy();req.resume();
 }
}

/** Handle public market reads and account-authorized mutations before workspace routing.
 * @param {object} req Raw account-gateway request.
 * @param {object} res Account-gateway response.
 * @param {object} context Existing account/session, CSRF, rate, admission and reply capabilities.
 * @returns {Promise<boolean>} Whether this request belongs to the market routes.
 */
export async function marketRoute(req,res,{market,path,currentSession,originOK,rate,store,reply,admissionStopped}){
 if(path!=='/market'&&!path.startsWith('/market/')&&!path.startsWith('/api/market/'))return false;
 const answer=(status,error,headers={})=>{req.resume();reply(res,status,JSON.stringify({error}),{'content-type':'application/json',...headers});};
 if(!market){answer(404,'market-disabled');return true;}
 if(admissionStopped){answer(503,'server-draining');return true;}
 if(typeof req.url!=='string'||!/^\/(?:market(?:[/?]|$)|api\/market\/)/u.test(req.url)||/[\\#\s\u0000-\u001f\u007f]/u.test(req.url)){
  answer(400,'invalid-request');return true;
 }
 if(!originOK(!['GET','HEAD'].includes(req.method))){answer(403,'origin-rejected');return true;}
 if(!rate(market.policy.requestRatePerMinute)){answer(429,'rate-limited',{'retry-after':'60'});return true;}
 if((req.method==='GET'||req.method==='HEAD')&&path==='/market'){
  reply(res,200,req.method==='HEAD'?'':market.policy.web==='skills'?skillMarketPage:marketPage,{'content-type':'text/html; charset=utf-8','content-security-policy':"default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'"});return true;
 }
 if((req.method==='GET'||req.method==='HEAD')&&path.startsWith('/market/')){
  const skills=market.policy.web==='skills',assets={'/market/client.js':['./market-client.js','text/javascript; charset=utf-8'],'/market/style.css':['./market.css','text/css; charset=utf-8'],...skills?{'/market/protocol.js':['../../packages/host/muse-market/lib/cloud-values.browser.js','text/javascript; charset=utf-8']}:{}};
  if(path==='/market/catalog.css'){reply(res,200,req.method==='HEAD'?'':catalogStyle,{'content-type':'text/css; charset=utf-8'});return true;}
  if(skills&&path==='/market/config.json'){
   const {archiveBytes,jsonRequestBytes,jsonResponseBytes,requestTimeoutMs}=market.policy;
   reply(res,200,req.method==='HEAD'?'':JSON.stringify({archiveBytes,jsonRequestBytes,jsonResponseBytes,requestTimeoutMs}),{'content-type':'application/json; charset=utf-8'});return true;
  }
  if(assets[path]){const[file,type]=assets[path];reply(res,200,req.method==='HEAD'?'':await readFile(new URL(file,import.meta.url)),{'content-type':type});return true;}
  answer(404,'not-found');return true;
 }
 if(!path.startsWith('/api/market/v1/')){answer(404,'not-found');return true;}
 if(!validMarketRequestTarget(req.url)){answer(400,'invalid-request');return true;}
 const parsed=new URL(req.url,'http://localhost'),current=currentSession(),deadline=performance.now()+market.policy.requestTimeoutMs;let prepared;
 const privateRead=path==='/api/market/v1/me'||path.endsWith('/download')||path==='/api/market/v1/catalog'&&parsed.searchParams.get('mine')==='true';
 if((privateRead||!['GET','HEAD'].includes(req.method))&&!current){answer(401,'login-required');return true;}
 if(!['GET','HEAD'].includes(req.method)&&req.headers['x-muse-market-account']!==undefined&&req.headers['x-muse-market-account']!==current.account.id){answer(409,'account-changed');return true;}
 if(path==='/api/market/v1/publishers'&&req.method==='POST'){
  if(!current.account.admin){answer(403,'admin-required');return true;}
  if(req.headers['content-type']?.split(';')[0].trim()!=='application/json'){answer(415,'invalid-content-type');return true;}
  const result=await prepareInvitation(req,res,market.policy.jsonRequestBytes,deadline);
  if(result.aborted)return true;
  if(result.error){answer(result.status,result.error,{'connection':'close'});return true;}
  prepared=result.bytes;let invitation;
  try{invitation=JSON.parse(prepared.toString('utf8'));}catch{answer(400,'invalid-request');return true;}
  const member=invitation&&validId(invitation.accountId)&&store.get(invitation.accountId);
  if(!member||member.disabled){answer(400,'invalid-publisher-account');return true;}
 }
 const active=currentSession();
 if(current&&(!active||active.token!==current.token)){answer(401,'login-required');return true;}
 await market.handle(req,res,active?.account??null,prepared,deadline);return true;
}

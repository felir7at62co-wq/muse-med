/** Optional account-authorized routes to the independent Skill catalog. */
import {readFile,lstat} from 'node:fs/promises';
import {isAbsolute} from 'node:path';
import {PassThrough} from 'node:stream';
import {createMarketProxy,validMarketRequestTarget} from './market-proxy.mjs';
import {validId} from './store.mjs';

/** Load an explicitly configured catalog proxy; absence leaves market routes disabled.
 * @param {object} environment Gateway environment with an optional private policy filename.
 * @returns {Promise<object|undefined>} Owned proxy, or undefined when not configured.
 */
export async function loadMarket(environment=process.env){
 if(environment.MUSE_MARKET_CONFIG===undefined||environment.MUSE_MARKET_CONFIG==='')return;
 if(!isAbsolute(environment.MUSE_MARKET_CONFIG))throw Error('Market policy filename must be absolute');
 const metadata=await lstat(environment.MUSE_MARKET_CONFIG);
 if(!metadata.isFile()||metadata.isSymbolicLink()||(process.platform!=='win32'&&(metadata.mode&0o077)!==0))throw Error('Market policy must be private');
 return await createMarketProxy(JSON.parse(await readFile(environment.MUSE_MARKET_CONFIG,'utf8')));
}

/** Static document owned by the market web entry; authenticated API policy remains server-owned. */
export const marketPage=`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Skill 市场 · MUSE</title><link rel="stylesheet" href="/market/style.css"><script type="module" src="/market/client.js"></script></head>
<body><header><a class="brand" href="/">MUSE</a><nav><a href="/" data-copy="home">工作间</a><a href="/account" data-copy="account">我的账号</a><a href="/login" id="market-login" data-copy="login">登录</a><button type="button" id="market-logout" data-copy="logout" hidden>退出登录</button></nav><div class="preferences"><label class="sr-only" for="market-language">Language</label><select id="market-language" aria-label="Language"><option value="zh">简体中文</option><option value="en">English</option></select><label class="sr-only" for="market-theme">Theme</label><select id="market-theme" aria-label="Theme"><option value="auto" data-copy="themeAuto">跟随系统</option><option value="light" data-copy="themeLight">浅色</option><option value="dark" data-copy="themeDark">深色</option></select></div></header>
<main id="market-root"><section class="heading"><p class="eyebrow">MUSE · SKILLS</p><h1 data-copy="title">Skill 市场</h1><p class="intro" data-copy="intro">发现可以带回创作流程的 Skill，查看版本、说明与发布状态</p><p id="market-identity" class="muted"></p></section><div id="market-status" class="notice" role="status" aria-live="polite"></div>
<div class="market-layout"><section aria-labelledby="catalog-heading"><div class="section-heading"><h2 id="catalog-heading" data-copy="catalog">探索 Skill</h2><button id="catalog-refresh" type="button" data-copy="refresh">刷新</button></div><div id="market-tabs" class="tabs"><button type="button" data-tab="public" aria-pressed="true" data-copy="public">已发布</button><button type="button" data-tab="mine" aria-pressed="false" data-copy="mine" disabled>我的发布</button></div><form id="catalog-search-form" class="search"><label class="sr-only" for="catalog-search" data-copy="searchLabel">名称、发布编号或关键词</label><input id="catalog-search" type="search" maxlength="200" autocomplete="off"><button type="submit" data-copy="search">搜索</button></form><p class="muted small" data-copy="bounded">每次展示最多 100 条；可按名称或发布编号搜索，不代表完整目录</p><div id="catalog-list" class="catalog-list" aria-live="polite"></div></section>
<aside class="creator" aria-labelledby="creator-heading"><p class="eyebrow">CREATE & SHARE</p><h2 id="creator-heading" data-copy="creator">发布你的 Skill</h2><p class="muted" data-copy="creatorIntro">选择已准备好的 Skill ZIP。上传后是私有草稿，需另行提交审核</p><p id="publisher-status" class="small muted"></p><form id="market-upload-form"><label for="publisher-select" data-copy="publisher">发布团队</label><select id="publisher-select" required disabled></select><label for="archive-input" data-copy="archive">Skill ZIP</label><input id="archive-input" type="file" accept=".zip,application/zip" disabled><p id="archive-facts" class="small muted"></p><button id="upload-button" class="primary" type="submit" data-copy="upload" disabled>上传私有草稿</button></form><div class="upload-recovery"><button id="upload-retry" type="button" data-copy="retryUpload" hidden>沿用原编号重试</button><button id="upload-cancel" type="button" data-copy="cancelUpload" hidden>放弃本次上传</button></div><p id="upload-status" class="notice" role="status" aria-live="polite"></p><div id="draft-result"></div><p class="small muted" data-copy="downloadOnly">网页下载经校验的 ZIP；安装和默认 Skill 选择在 Muse 桌面端完成</p></aside></div><footer data-copy="footer">上传、提交审核与下载分别由你发起；发布不会自动启用或执行 Skill</footer></main></body></html>`;

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
  reply(res,200,req.method==='HEAD'?'':marketPage,{'content-type':'text/html; charset=utf-8','content-security-policy':"default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'"});return true;
 }
 if((req.method==='GET'||req.method==='HEAD')&&path.startsWith('/market/')){
  const assets={'/market/client.js':['./market-client.js','text/javascript; charset=utf-8'],'/market/style.css':['./market.css','text/css; charset=utf-8'],'/market/protocol.js':['../../packages/host/muse-market/lib/cloud-values.browser.js','text/javascript; charset=utf-8']};
  if(path==='/market/config.json'){
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

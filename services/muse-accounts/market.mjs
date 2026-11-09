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
export const marketPage='<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Skill 市场 · MUSE</title></head><body><header><a href="/">MUSE</a><nav><a href="/login">登录</a><a href="/account">我的账号</a></nav></header><main id="market-root"><h1>Skill 市场</h1></main></body></html>';

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
 if(!path.startsWith('/api/market/v1/')){answer(404,'not-found');return true;}
 if(!validMarketRequestTarget(req.url)){answer(400,'invalid-request');return true;}
 const parsed=new URL(req.url,'http://localhost'),current=currentSession(),deadline=performance.now()+market.policy.requestTimeoutMs;let prepared;
 const privateRead=path==='/api/market/v1/me'||path.endsWith('/download')||path==='/api/market/v1/catalog'&&parsed.searchParams.get('mine')==='true';
 if((privateRead||!['GET','HEAD'].includes(req.method))&&!current){answer(401,'login-required');return true;}
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

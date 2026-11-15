/** Same-origin Skill market; archives are validated by the server and downloaded without local installation. */
export class MarketWebError extends Error{
 constructor(code,status=503,details={}){super(code);this.name='MarketWebError';this.code=code;this.status=status;this.details=details;}
}

/** Validate the four credential-free transport limits returned by the gateway.
 * @param {unknown} value Public configuration JSON.
 * @returns {object} Explicit byte budgets and request lifetime.
 */
export function marketWebPolicy(value){
 const keys=['archiveBytes','jsonRequestBytes','jsonResponseBytes','requestTimeoutMs'];
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==keys.length||!keys.every(key=>Object.hasOwn(value,key)&&Number.isSafeInteger(value[key])&&value[key]>0&&value[key]<=(key==='requestTimeoutMs'?300000:64*1024*1024)))throw new MarketWebError('invalid-policy',400);
 return Object.freeze({...value});
}

/** Consume a complete bounded response and release its reader on failure or completion.
 * @param {Response} response Owned fetch response.
 * @param {number} maximum Maximum complete decoded body bytes.
 * @returns {Promise<Uint8Array>} Original complete response bytes.
 */
export async function readMarketBody(response,maximum){
 const declared=response.headers.get('content-length');
 if(declared!==null&&(!/^\d+$/u.test(declared)||!Number.isSafeInteger(Number(declared))||Number(declared)>maximum)){await response.body?.cancel();throw new MarketWebError('response-too-large',413);}
 const reader=response.body?.getReader();if(!reader)throw new MarketWebError('invalid-response',502);
 const chunks=[];let size=0;
 try{for(;;){const part=await reader.read();if(part.done)break;size+=part.value.byteLength;if(size>maximum)throw new MarketWebError('response-too-large',413);chunks.push(part.value);}}
 finally{try{await reader.cancel();}catch(_error){/* Keep the original transport or byte-budget failure. */}reader.releaseLock();}
 const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}return bytes;
}
function jsonValue(bytes){try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{throw new MarketWebError('invalid-response',502);}}
const hexDigest=bytes=>Array.from(new Uint8Array(bytes),value=>value.toString(16).padStart(2,'0')).join('');

/** Create an owned browser transport using the shared public publication parsers.
 * @param {object} policy Validated gateway policy.
 * @param {object} protocol Shared browser-safe cloud-values exports.
 * @param {object} options Instance-local fetch, crypto and lost-authority notification.
 * @returns {object} Explicit catalog, upload, review and download operations with quiescent close.
 */
export function createMarketBrowserClient(policy,protocol,{fetcher=globalThis.fetch,crypto=globalThis.crypto,onAccessLost=()=>{}}={}){
 policy=marketWebPolicy(policy);const lifetime=new AbortController(),pending=new Set(),limits={archiveBytes:policy.archiveBytes,recordBytes:policy.jsonResponseBytes};
 const publication=value=>protocol.parseMarketPublication(value,limits);
 async function request(path,options={},maximum=policy.jsonResponseBytes){
  const work=(async()=>{
   lifetime.signal.throwIfAborted();const signal=AbortSignal.any([lifetime.signal,AbortSignal.timeout(policy.requestTimeoutMs)]);
   let response;
   try{response=await fetcher(path,{...options,credentials:'same-origin',mode:'same-origin',cache:'no-store',redirect:'manual',signal});}
   catch(error){if(lifetime.signal.aborted)throw error;throw new MarketWebError(signal.aborted?'request-timeout':'network-unavailable');}
   if(response.type==='opaqueredirect'||response.status>=300&&response.status<400){await response.body?.cancel();throw new MarketWebError('login-required',401);}
   if(!response.ok){
    let code=response.status===401?'login-required':response.status===403?'permission-denied':response.status===409?'cloud-conflict':response.status===413?'request-too-large':response.status===429?'rate-limited':'cloud-unavailable';
    try{const value=jsonValue(await readMarketBody(response,policy.jsonResponseBytes));if(value&&typeof value.error==='string')code=value.error;}
    catch(_error){/* Preserve the HTTP refusal when its error document is absent or invalid. */}
    throw new MarketWebError(code,response.status);
   }
   const bytes=await readMarketBody(response,maximum);lifetime.signal.throwIfAborted();return {response,bytes};
  })();pending.add(work);
  try{return await work;}
  catch(error){
   if(!lifetime.signal.aborted&&(error.status===401||error.status===403||error.code==='account-changed'||error.status>=500||!(error instanceof MarketWebError)))onAccessLost(error);
   throw error;
  }finally{pending.delete(work);}
 }
 const json=async(path,options)=>{const value=await request('/api/market/v1'+path,options);if(value.response.headers.get('content-type')?.split(';')[0].trim()!=='application/json')throw new MarketWebError('invalid-response',502);return jsonValue(value.bytes);};
 const accountHeaders=accountId=>{
  if(typeof accountId!=='string'||!/^[a-f0-9]{16}$/u.test(accountId))throw new MarketWebError('login-required',401);
  return {'x-muse-market-account':accountId};
 };
 const mutation=(accountId,body)=>{
  const text=JSON.stringify(body);if(new TextEncoder().encode(text).byteLength>policy.jsonRequestBytes)throw new MarketWebError('request-too-large',413);
  return {method:'POST',headers:{...accountHeaders(accountId),'content-type':'application/json'},body:text};
 };
 const getPublication=async id=>{protocol.parseMarketPublicationId(id);const value=publication(await json('/releases/'+id));if(value.id!==id)throw new MarketWebError('invalid-response',502);return value;};
 let closePromise;
 return {
  async catalog(q,mine){
   if(typeof q!=='string'||q.length>200||typeof mine!=='boolean')throw new MarketWebError('invalid-query',400);
   const value=await json('/catalog?'+new URLSearchParams({q,mine:String(mine)}));
   if(!value||typeof value!=='object'||Object.keys(value).length!==1||!Array.isArray(value.items)||value.items.length>100)throw new MarketWebError('invalid-response',502);
   const items=value.items.map(publication);if(!mine&&items.some(item=>item.status!=='published'))throw new MarketWebError('invalid-response',502);return items;
  },
  async identity(){return protocol.parseMarketIdentity(await json('/me'));},
  getPublication,
  async upload(bytes,publisherId,key,accountId){
   protocol.parseMarketPublisherId(publisherId);protocol.parseMarketUploadRequestId(key);
   if(!(bytes instanceof Uint8Array)||!bytes.byteLength||bytes.byteLength>policy.archiveBytes)throw new MarketWebError('request-too-large',413);
   const options={method:'POST',headers:{...accountHeaders(accountId),'content-type':'application/zip','x-market-publisher':publisherId,'idempotency-key':key},body:new Blob([bytes])};
   return publication(await json('/uploads',options));
  },
  async review(item,action,note,accountId){
   const original=publication(item),id=original.id,revision=original.revision;
   if(!['submit','approve','reject','withdraw'].includes(action)||typeof note!=='string'||note.length>2000||action==='reject'&&!note.trim())throw new MarketWebError('invalid-review',400);
   const expected={submit:'pending',approve:'published',reject:'rejected',withdraw:'withdrawn'}[action];
   try{
    const next=publication(await json('/releases/'+id+'/review',mutation(accountId,{revision,action,note})));
    if(next.id!==id||next.revision!==revision+1||next.status!==expected||next.reviewNote!==note)throw new MarketWebError('invalid-response',502);return next;
   }catch(error){
    if(error.code==='account-changed')throw error;
    if(error.status<500&&error.status!==409)throw error;
    let observed;try{observed=await getPublication(id);}catch(_readError){throw new MarketWebError('review-unconfirmed',503,{id,revision});}
    if(error.status>=500&&observed.revision===revision+1&&observed.status===expected&&observed.reviewNote===note)return observed;
    throw new MarketWebError(error.status===409?'cloud-conflict':'review-unconfirmed',error.status===409?409:503,{id,revision,observed});
   }
  },
  async download(item){
   const selected=publication(item),{response,bytes}=await request('/api/market/v1/releases/'+selected.id+'/download',{},policy.archiveBytes);
   if(response.headers.get('content-type')?.split(';')[0].trim()!=='application/zip'||response.headers.get('x-content-sha256')!==selected.sha256||bytes.byteLength!==selected.bytes||hexDigest(await crypto.subtle.digest('SHA-256',bytes))!==selected.sha256)throw new MarketWebError('archive-mismatch',502);
   lifetime.signal.throwIfAborted();return {name:selected.manifest.name+'-'+selected.manifest.version+'.zip',bytes};
  },
  async logout(accountId){try{await request('/logout',{method:'POST',headers:accountHeaders(accountId)});}catch(error){if(error.status!==401)throw error;}},
  close(){if(!closePromise){lifetime.abort();closePromise=Promise.allSettled([...pending]).then(()=>undefined);}return closePromise;},
 };
}

/** Retain immutable selected bytes, publisher, account and the original upload key until explicitly discarded.
 * @param {object} input Selected bytes and the fresh identity that owns this attempt.
 * @param {Crypto} crypto Browser cryptography, optionally supplied by the test owner.
 * @returns {Promise<object>} Metadata facts and a retry operation that cannot change its identity or bytes.
 */
export async function createUploadAttempt({bytes,publisherId,accountId,fileName},crypto=globalThis.crypto){
 const archive=new Uint8Array(bytes),key=crypto.randomUUID(),sha256=hexDigest(await crypto.subtle.digest('SHA-256',archive));
 const facts=Object.freeze({publisherId,accountId,fileName,bytes:archive.byteLength,sha256});
 return Object.freeze({key,facts,async send(client,identity){
  if(!identity||identity.accountId!==accountId)throw new MarketWebError('account-changed',409);
  if(!identity.admin&&!identity.publishers.some(item=>item.id===publisherId))throw new MarketWebError('permission-denied',403);
  const value=await client.upload(archive,publisherId,key,accountId);
  if(value.publisherId!==publisherId||value.sha256!==sha256||value.bytes!==archive.byteLength)throw new MarketWebError('publication-mismatch',502);return value;
 }});
}

const words={
 zh:{home:'工作间',account:'我的账号',login:'登录',logout:'退出登录',themeAuto:'跟随系统',themeLight:'浅色',themeDark:'深色',title:'Skill 市场',intro:'发现可以带回创作流程的 Skill，查看版本、说明与发布状态',catalog:'探索 Skill',refresh:'刷新',public:'已发布',mine:'我的发布',searchLabel:'名称、发布编号或关键词',search:'搜索',bounded:'每次展示最多 100 条；可按名称或发布编号搜索，不代表完整目录',creator:'发布你的 Skill',creatorIntro:'选择已准备好的 Skill ZIP。上传后是私有草稿，需另行提交审核',publisher:'发布团队',archive:'Skill ZIP',upload:'上传私有草稿',retryUpload:'沿用原编号重试',cancelUpload:'放弃本次上传',downloadOnly:'网页下载经校验的 ZIP；安装和默认 Skill 选择在 Muse 桌面端完成',footer:'上传、提交审核与下载分别由你发起；发布不会自动启用或执行 Skill',anonymous:'登录后可下载和查看自己的发布',member:'已登录，可按发布团队上传',notPublisher:'当前账号尚未加入发布团队，请联系管理员',admin:'管理员 · 可审核待审发布',empty:'没有匹配的 Skill',details:'包详情',version:'版本',revision:'修订',license:'许可',examples:'使用示例',requirements:'使用要求',digest:'SHA-256',download:'校验并下载',submit:'提交审核',approve:'批准',reject:'拒绝',withdraw:'下架',reviewNote:'审核说明',chooseFile:'请选择一个 Skill ZIP',fileTooLarge:'文件超过本次上传的大小上限',uploadSuccess:'私有草稿已保存，可在下方单独提交审核',uploadUnknown:'上传结果尚未确认，请保留当前选择并沿用原编号重试',attemptLocked:'原上传仍保留，请切回原账号后恢复；当前账号不会复用它',attemptRetained:'原上传已暂存，重新登录原账号后可恢复',cancelled:'已放弃本次上传；若服务器曾收到它，可在我的发布中核对',reviewSaved:'发布状态已更新',downloadSaved:'ZIP 已校验并开始下载',signedOut:'已退出登录；原上传仍保留，切回原账号后可恢复',unavailable:'服务暂时不可用，请刷新后重试',loginRequired:'请先登录，再刷新当前页面',permission:'权限已变化，请刷新当前账号状态',conflict:'状态已经变化，请检查当前修订后重新决定',uncertainReview:'审核结果尚未确认，已读取原发布物；请检查状态后再决定',invalidArchive:'ZIP 未通过校验，未开始下载',invalidResponse:'服务返回的数据不完整，请刷新后重试',rate:'请求较多，请稍后重试',timeout:'请求超时，请刷新状态后重试',invalidReview:'拒绝时请填写审核说明',draft:'私有草稿',pending:'待审核',published:'已发布',rejected:'已退回',withdrawn:'已下架'},
 en:{home:'Workspace',account:'My account',login:'Sign in',logout:'Sign out',themeAuto:'System theme',themeLight:'Light',themeDark:'Dark',title:'Skill market',intro:'Find Skills for your creative workflow. Inspect versions, instructions and publication status.',catalog:'Explore Skills',refresh:'Refresh',public:'Published',mine:'My publications',searchLabel:'Name, publication ID or keywords',search:'Search',bounded:'Up to 100 records per request. Search by name or publication ID; this is not a complete directory.',creator:'Publish your Skill',creatorIntro:'Choose a prepared Skill ZIP. Upload creates a private draft; submission for review is a separate action.',publisher:'Publishing team',archive:'Skill ZIP',upload:'Upload private draft',retryUpload:'Retry original upload',cancelUpload:'Discard this attempt',downloadOnly:'This website downloads verified ZIPs. Install and choose default Skills in Muse Desktop.',footer:'You initiate upload, submission and download separately. Publication never activates or executes a Skill.',anonymous:'Sign in to download and view your publications',member:'Signed in; choose an admitted publishing team to upload',notPublisher:'This account has no publishing team. Contact an administrator.',admin:'Administrator · pending publications can be reviewed',empty:'No matching Skills',details:'Package details',version:'Version',revision:'Revision',license:'License',examples:'Examples',requirements:'Requirements',digest:'SHA-256',download:'Verify and download',submit:'Submit for review',approve:'Approve',reject:'Reject',withdraw:'Withdraw',reviewNote:'Review note',chooseFile:'Choose one Skill ZIP',fileTooLarge:'This file exceeds the upload size limit',uploadSuccess:'Private draft saved. Submit it for review separately below.',uploadUnknown:'Upload is unconfirmed. Keep this selection and retry the original upload.',attemptLocked:'The original attempt is retained. Return to its account to resume; this account cannot reuse it.',attemptRetained:'The original upload is retained. Sign in to its original account to resume.',cancelled:'Attempt discarded. If the server received it, check My publications.',reviewSaved:'Publication status updated',downloadSaved:'ZIP verified; download started',signedOut:'Signed out. The original attempt remains available when its account signs in again.',unavailable:'Service unavailable. Refresh before trying again.',loginRequired:'Sign in, then refresh this page',permission:'Access changed. Refresh the current account status.',conflict:'The state changed. Inspect its current revision before choosing another action.',uncertainReview:'Review is unconfirmed. The original publication was read; inspect its state before another action.',invalidArchive:'ZIP verification failed; download did not start',invalidResponse:'The service returned incomplete data. Refresh and try again.',rate:'Too many requests. Try again later.',timeout:'Request timed out. Refresh its state before retrying.',invalidReview:'Enter a review note when rejecting a publication',draft:'Private draft',pending:'Pending review',published:'Published',rejected:'Rejected',withdrawn:'Withdrawn'},
};

async function startMarketPage(){
 const $=selector=>document.querySelector(selector),root=$('#market-root');if(!root)return;
 let locale='zh',identity=null,rows=[],tab='public',rowsPermit=null,generation=0,accessGeneration=0,authorityEpoch=0,disposed=false,loggingOut=false,attempt=null,attemptResult=null,attemptResultPermit=null,attemptState='empty',uploadBusy=false,client;
 const downloads=new Map(),lifetime=new AbortController();
 window.addEventListener('pagehide',()=>{disposed=true;generation++;accessGeneration++;authorityEpoch++;lifetime.abort();for(const[url,timer]of downloads){clearTimeout(timer);URL.revokeObjectURL(url);}downloads.clear();attempt=null;attemptResult=null;void client?.close();},{once:true});
 try{locale=localStorage.getItem('muse-market-locale')==='en'?'en':'zh';const theme=localStorage.getItem('muse-market-theme');if(['light','dark'].includes(theme))document.documentElement.dataset.theme=theme;$('#market-theme').value=['light','dark'].includes(theme)?theme:'auto';}catch(_error){/* Preferences remain usable when browser storage is disabled. */}
 const t=key=>words[locale][key]??words[locale].unavailable;
 const element=(tag,text,className)=>{const node=document.createElement(tag);if(text!==undefined)node.textContent=text;if(className)node.className=className;return node;};
 function note(node,message,kind=''){if(disposed)return;node.textContent=message;node.dataset.kind=kind;}
 function message(error){
  if(error.code==='login-required')return t('loginRequired');if(error.status===403)return t('permission');if(error.code==='account-changed'||error.status===409)return t('conflict');
  if(error.code==='review-unconfirmed')return t('uncertainReview');if(error.code==='archive-mismatch')return t('invalidArchive');if(error.code==='invalid-response')return t('invalidResponse');
  if(error.status===429)return t('rate');if(error.code==='request-timeout'||error.code==='market-timeout')return t('timeout');if(error.code==='invalid-review')return t('invalidReview');if(error.status===413)return t('fileTooLarge');return t('unavailable');
 }
 const permit=()=>identity?{accountId:identity.accountId,epoch:authorityEpoch}:null;
 const currentPermit=value=>!disposed&&root.isConnected&&value!==null&&value!==undefined&&identity?.accountId===value.accountId&&authorityEpoch===value.epoch;
 function loseAccess(error){const admitted=identity!==null;identity=null;accessGeneration++;authorityEpoch++;attemptResult=null;attemptResultPermit=null;if(attempt&&attemptState==='confirmed')attemptState='uncertain';if(!disposed){renderAuthority();if(tab==='mine')renderRows();if(error&&(error.status!==401||admitted))note($('#market-status'),message(error),'error');}}
 function copy(){document.documentElement.lang=locale==='en'?'en':'zh-CN';document.title=t('title')+' · MUSE';document.querySelectorAll('[data-copy]').forEach(node=>{node.textContent=t(node.dataset.copy);});$('#market-language').value=locale;$('#catalog-search').placeholder=t('searchLabel');}
 function renderAuthority(){
  const admitted=!!identity,ownsAttempt=attempt&&identity?.accountId===attempt.facts.accountId,canResume=ownsAttempt&&(identity.admin||identity.publishers.some(item=>item.id===attempt.facts.publisherId)),canUpload=admitted&&identity.publishers.length>0&&!attempt&&!uploadBusy;
  $('#market-login').hidden=admitted;$('#market-login').target='_blank';$('#market-login').rel='noopener';$('#market-logout').hidden=!admitted;
  $('#market-identity').textContent=t(!admitted?'anonymous':identity.admin?'admin':identity.publishers.length?'member':'notPublisher');
  $('#publisher-status').textContent=t(!admitted?'loginRequired':identity.publishers.length?'member':'notPublisher');
  const select=$('#publisher-select'),prior=ownsAttempt?attempt.facts.publisherId:select.value;select.replaceChildren();for(const publisher of identity?.publishers??[]){const option=element('option',publisher.title);option.value=publisher.id;select.append(option);}if([...select.options].some(option=>option.value===prior))select.value=prior;
  select.disabled=!canUpload;$('#archive-input').disabled=!canUpload;$('#upload-button').disabled=!canUpload;
  $('#market-tabs [data-tab=mine]').disabled=!admitted;$('#upload-retry').hidden=!attempt||attemptState==='confirmed';$('#upload-retry').disabled=!canResume||uploadBusy;
  $('#upload-cancel').hidden=!attempt;$('#upload-cancel').disabled=uploadBusy;
  if(attempt&&!ownsAttempt){$('#archive-facts').textContent=t(admitted?'attemptLocked':'attemptRetained');$('#draft-result').replaceChildren();}
  else if(attempt){$('#archive-facts').textContent=attempt.facts.fileName+' · '+attempt.facts.bytes.toLocaleString(locale)+' bytes';if(attemptResult&&currentPermit(attemptResultPermit))$('#draft-result').replaceChildren(card(attemptResult));else $('#draft-result').replaceChildren();}
  document.querySelectorAll('button[data-private-action]').forEach(button=>{button.disabled=!capable(button.dataset.action,button.dataset.publisherId,button.dataset.status);});
 }
 async function access(){
  if(loggingOut)return null;
  const mine=++accessGeneration;
  try{const value=await client.identity();if(disposed||mine!==accessGeneration)return null;if(JSON.stringify(identity)!==JSON.stringify(value)){authorityEpoch++;identity=value;if(tab==='mine')renderRows();}else identity=value;renderAuthority();return value;}
  catch(error){if(disposed||mine!==accessGeneration)return null;loseAccess();if(error.status!==401)note($('#market-status'),message(error),'error');return null;}
 }
 function replaceRecord(item,permission){if(!currentPermit(permission))return;rows=rows.map(row=>row.id===item.id?item:row);if(attemptResult?.id===item.id){attemptResult=item;attemptResultPermit=permission;}renderRows();renderAuthority();}
 function capable(action,publisherId,status){if(!identity)return false;const owns=identity.admin||identity.publishers.some(item=>item.id===publisherId);return action==='download'?status==='published':action==='approve'||action==='reject'?identity.admin&&status==='pending':action==='submit'?owns&&(status==='draft'||status==='rejected'):action==='withdraw'&&owns&&status==='published';}
 function privateButton(label,action,item,handler){const button=element('button',t(label));button.type='button';button.dataset.action=action;button.dataset.publicationId=item.id;button.dataset.publisherId=item.publisherId;button.dataset.status=item.status;button.dataset.privateAction='true';button.disabled=!capable(action,item.publisherId,item.status);button.addEventListener('click',handler,{signal:lifetime.signal});return button;}
 function card(item){
  const article=element('article',undefined,'market-card');article.dataset.publicationId=item.id;
  const top=element('div',undefined,'card-top'),badge=element('span',t(item.status),'badge');badge.dataset.status=item.status;top.append(element('span',item.publisher),badge);
  const title=element('h3',item.manifest.title),facts=element('div',undefined,'card-facts');facts.append(element('span',t('version')+' '+item.manifest.version),element('span',t('revision')+' '+item.revision));
  article.append(top,title,facts,element('p',item.manifest.description,'card-description'));
  const details=element('details'),summary=element('summary',t('details')),list=element('dl');
  for(const[label,value]of [['license',item.manifest.license],['examples',item.manifest.examples.join('\n')],['requirements',item.manifest.requirements.join('\n')],['digest',item.sha256]]){const dd=element('dd',value);if(label==='digest')dd.className='digest';list.append(element('dt',t(label)),dd);}details.append(summary,list);article.append(details);
  if(item.reviewNote)article.append(element('p',item.reviewNote,'small muted'));
  const result=element('p','','card-message notice'),actions=element('div',undefined,'card-actions');result.setAttribute('role','status');result.setAttribute('aria-live','polite');
  if(item.status==='published')actions.append(privateButton('download','download',item,async event=>{
   const button=event.currentTarget;button.disabled=true;let permission;
   try{const fresh=await access();if(!fresh||disposed)return;permission=permit();const download=await client.download(item);if(!currentPermit(permission))return;const url=URL.createObjectURL(new Blob([download.bytes],{type:'application/zip'})),anchor=element('a');anchor.href=url;anchor.download=download.name;document.body.append(anchor);anchor.click();anchor.remove();const timer=setTimeout(()=>{URL.revokeObjectURL(url);downloads.delete(url);},1000);downloads.set(url,timer);note(result,t('downloadSaved'),'success');}
   catch(error){if(!disposed&&(!permission||currentPermit(permission))){loseAccess(error);note(result,message(error),'error');}}finally{if(!disposed)button.disabled=!identity;}
  }));
  const owns=identity&&(identity.admin||identity.publishers.some(publisher=>publisher.id===item.publisherId)),allowed=[];
  if(owns&&(item.status==='draft'||item.status==='rejected'))allowed.push('submit');if(identity?.admin&&item.status==='pending')allowed.push('approve','reject');if(owns&&item.status==='published')allowed.push('withdraw');
  if(allowed.length){
   const label=element('label',t('reviewNote'),'review-note'),input=element('textarea');input.maxLength=2000;input.rows=2;input.setAttribute('aria-label',t('reviewNote'));label.append(input);article.append(label);
   for(const action of allowed)actions.append(privateButton(action,action,item,async event=>{
    const button=event.currentTarget;button.disabled=true;
    let permission;
    try{const fresh=await access();if(!fresh||disposed)return;if(!capable(action,item.publisherId,item.status))throw new MarketWebError('permission-denied',403);permission=permit();const value=await client.review(item,action,action==='submit'?'':input.value,fresh.accountId);if(!currentPermit(permission))return;replaceRecord(value,permission);note($('#market-status'),t('reviewSaved'),'success');}
    catch(error){if(disposed||permission&&!currentPermit(permission))return;if(error.details?.observed)replaceRecord(error.details.observed,permission);if(error.status===401||error.status===403||error.code==='account-changed'||error.status>=500)loseAccess();note($('#market-status'),message(error),'error');}
    finally{if(!disposed)button.disabled=!capable(action,item.publisherId,item.status);}
   }));
  }
  article.append(actions,result);return article;
 }
 function renderRows(){if(disposed)return;const visible=tab==='mine'&&!currentPermit(rowsPermit)?[]:rows;$('#catalog-list').replaceChildren(...(visible.length?visible.map(card):[element('div',t(tab==='mine'&&!identity?'loginRequired':'empty'),'empty')]));}
 async function load(){
  const mine=++generation;$('#catalog-refresh').disabled=true;$('#catalog-list').setAttribute('aria-busy','true');if(!rows.length)$('#catalog-list').replaceChildren(element('div',undefined,'skeleton'),element('div',undefined,'skeleton'));
  try{
   const fresh=await access();if(disposed||mine!==generation)return;if(tab==='mine'&&!fresh){tab='public';document.querySelectorAll('[data-tab]').forEach(button=>button.setAttribute('aria-pressed',String(button.dataset.tab===tab)));}
   const privateRead=tab==='mine',permission=privateRead?permit():null,value=await client.catalog($('#catalog-search').value,privateRead);if(disposed||mine!==generation||privateRead&&!currentPermit(permission))return;rows=value;rowsPermit=permission;renderRows();
  }catch(error){if(!disposed&&mine===generation){loseAccess();if(rows.length)renderRows();else $('#catalog-list').replaceChildren(element('div',message(error),'empty'));note($('#market-status'),message(error),'error');}}
  finally{if(!disposed&&mine===generation){$('#catalog-refresh').disabled=false;$('#catalog-list').setAttribute('aria-busy','false');}}
 }
 async function sendUpload(){
  if(uploadBusy)return;uploadBusy=true;renderAuthority();let permission;
  try{
   const fresh=await access();if(!fresh||disposed)return;permission=permit();
   if(!attempt){
    const file=$('#archive-input').files[0],publisherId=$('#publisher-select').value;if(!file)throw new MarketWebError('choose-file',400);if(!file.size||file.size>policy.archiveBytes)throw new MarketWebError('request-too-large',413);
    const bytes=new Uint8Array(await file.arrayBuffer());if(!currentPermit(permission))return;const selected=await createUploadAttempt({bytes,publisherId,accountId:fresh.accountId,fileName:file.name});if(!currentPermit(permission))return;attempt=selected;attemptState='prepared';
   }
   const value=await attempt.send(client,fresh);if(!currentPermit(permission)){attemptState='uncertain';return;}attemptResult=value;attemptResultPermit=permission;attemptState='confirmed';note($('#upload-status'),t('uploadSuccess'),'success');
  }catch(error){if(disposed)return;attemptState=error.status===400||error.status===413?'rejected':'uncertain';if(error.status===401||error.status===403||error.code==='account-changed'||error.status>=500||!error.status)loseAccess();if(!identity||!permission||currentPermit(permission))note($('#upload-status'),error.code==='choose-file'?t('chooseFile'):attempt&&error.status>=500||attempt&&!error.status?t('uploadUnknown'):message(error),'error');}
  finally{uploadBusy=false;if(!disposed)renderAuthority();}
 }
 let policy;
 try{
  copy();const response=await fetch('/market/config.json',{credentials:'same-origin',mode:'same-origin',cache:'no-store',redirect:'manual',signal:lifetime.signal});if(!response.ok)throw new MarketWebError('unavailable');policy=marketWebPolicy(jsonValue(await readMarketBody(response,4096)));const protocol=await import('./protocol.js');if(disposed)return;
  client=createMarketBrowserClient(policy,protocol,{onAccessLost:loseAccess});
 }catch(error){note($('#market-status'),message(error),'error');return;}
 $('#market-upload-form').addEventListener('submit',event=>{event.preventDefault();void sendUpload();},{signal:lifetime.signal});$('#upload-retry').addEventListener('click',()=>void sendUpload(),{signal:lifetime.signal});
 $('#upload-cancel').addEventListener('click',()=>{attempt=null;attemptResult=null;attemptResultPermit=null;attemptState='empty';$('#archive-input').value='';$('#archive-facts').textContent='';$('#draft-result').replaceChildren();note($('#upload-status'),t('cancelled'));renderAuthority();},{signal:lifetime.signal});
 $('#archive-input').addEventListener('change',()=>{const file=$('#archive-input').files[0];$('#archive-facts').textContent=file?file.name+' · '+file.size.toLocaleString(locale)+' bytes':'';},{signal:lifetime.signal});
 $('#catalog-search-form').addEventListener('submit',event=>{event.preventDefault();void load();},{signal:lifetime.signal});$('#catalog-refresh').addEventListener('click',()=>void load(),{signal:lifetime.signal});
 document.querySelectorAll('[data-tab]').forEach(button=>button.addEventListener('click',()=>{if(tab===button.dataset.tab)return;tab=button.dataset.tab;rows=[];document.querySelectorAll('[data-tab]').forEach(node=>node.setAttribute('aria-pressed',String(node===button)));void load();},{signal:lifetime.signal}));
 $('#market-logout').addEventListener('click',async()=>{
  const current=identity;loggingOut=true;generation++;loseAccess();rows=[];rowsPermit=null;tab='public';document.querySelectorAll('[data-tab]').forEach(button=>button.setAttribute('aria-pressed',String(button.dataset.tab===tab)));renderRows();
  try{if(current)await client.logout(current.accountId);if(!disposed){loggingOut=false;note($('#market-status'),t('signedOut'),'success');await load();}}
  catch(error){if(!disposed)note($('#market-status'),message(error),'error');}
  finally{loggingOut=false;if(!disposed){$('#catalog-refresh').disabled=false;$('#catalog-list').setAttribute('aria-busy','false');}}
 },{signal:lifetime.signal});
 $('#market-language').addEventListener('change',()=>{locale=$('#market-language').value==='en'?'en':'zh';try{localStorage.setItem('muse-market-locale',locale);}catch(_error){/* Keep the page preference when storage is unavailable. */}copy();renderRows();renderAuthority();},{signal:lifetime.signal});
 $('#market-theme').addEventListener('change',()=>{const theme=$('#market-theme').value;if(theme==='auto')delete document.documentElement.dataset.theme;else document.documentElement.dataset.theme=theme;try{localStorage.setItem('muse-market-theme',theme);}catch(_error){/* Keep the page preference when storage is unavailable. */}},{signal:lifetime.signal});
 window.addEventListener('focus',()=>void load(),{signal:lifetime.signal});
 await load();
}
if(typeof document!=='undefined')void startMarketPage();

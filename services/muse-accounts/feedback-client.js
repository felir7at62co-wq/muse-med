// Feedback and analysis are untrusted text; neither is interpreted as markup.
const $=selector=>document.querySelector(selector),admin=document.body.dataset.admin==='true';
const statusNames={new:'待查看',reviewing:'处理中',planned:'已排期',resolved:'已解决',closed:'已关闭'},categoryNames={bug:'问题反馈',suggestion:'功能建议',other:'其他意见'};
const analysisCategoryNames={bug:'程序问题',experience:'体验问题',suggestion:'功能建议',question:'使用咨询',invalid:'无效内容'},priorityNames={high:'高优先级',normal:'普通优先级',low:'低优先级'},confidenceNames={low:'低',medium:'中',high:'高'};
let offset=0,loading=false,generation=0,automationDirty=false,automationState,pollTimer,listRefreshNeeded=false,composeSession=0;
let packageGeneration=0,packageSignature,packageItems=new Map();
const packageReceipts=new Map(),packageMessages=new Map(),packageDownloads=new Set(),downloadUrls=new Set(),downloadControllers=new Set();
const editorDrafts=new Map();
const expandedDetails=new Map(),expandedEditors=new Map();
function el(tag,text,className){const node=document.createElement(tag);if(text!==undefined)node.textContent=text;if(className)node.className=className;return node;}
async function api(path,options={}){const response=await fetch(path,{credentials:'same-origin',...options,headers:{'content-type':'application/json',...options.headers}});if(response.redirected||response.status===401)throw Error('登录已过期，请返回工作间重新登录');const body=await response.json().catch(()=>({error:'服务暂时不可用，请稍后重试'}));if(!response.ok)throw Object.assign(Error(body.error||'请求失败'),{status:response.status});return body;}
function note(node,message,error=false){node.textContent=message;node.classList.toggle('error',error);node.classList.toggle('success',!error);}
function dateText(value){return value?new Date(value).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false}):'暂无';}
function feedbackPath(item){return '/api/muse.feedback/'+encodeURIComponent(item.id);}
function bodyExcerpt(body){
 const text=body.replace(/\r\n?/g,'\n'),observed=/^[ \t]*(?:#{1,6}[ \t]+)?(?:\*\*)?Observed(?:\*\*)?[ \t]*:[ \t]*([\s\S]*)/im.exec(text);
 const section=observed?observed[1].split(/^[ \t]*(?:#{1,6}[ \t]+)?(?:\*\*)?(?:Expected|Observed steps|Acceptance checks)(?:\*\*)?[ \t]*:/im)[0]:text.split('\n').filter(line=>!/^\s*(?:Source|URL|Environment|Page|Browser|Date|Time|Version|Submitted by|Reporter|User|Category|Title|来源|页面|环境|浏览器|时间|版本|提交者|分类)\s*[:：]/i.test(line)).join('\n').trim().split(/\n[ \t]*\n/)[0];
 const excerpt=section.replace(/^\s*(?:Summary|摘要)\s*[:：]\s*/i,'').replace(/\s+/g,' ').trim();return excerpt.length>240?excerpt.slice(0,240)+'…':excerpt;
}
function rememberExpansion(){for(const details of document.querySelectorAll('.feedback-detail')){expandedDetails.set(details.dataset.feedbackId,details.open);const editor=details.querySelector('.admin-editor');if(editor)expandedEditors.set(details.dataset.feedbackId,editor.open);}}
function actionButton(label,handler,className='quiet'){const button=el('button',label,className);button.type='button';button.addEventListener('click',handler);return button;}
function focusFeedback(cardId){const target=document.getElementById(cardId)?.querySelector('.feedback-detail > summary')||$('#records-heading');target.focus({preventScroll:true});}
async function itemAction(button,message,path,body){const cardId=button.closest('.feedback-item').id;button.disabled=true;note(message,'正在保存…');try{await api(path,{method:'POST',body:JSON.stringify(body)});await load(true);if(admin)await loadAutomation();focusFeedback(cardId);}catch(error){note(message,error.message,true);}finally{button.disabled=false;}}
function textList(container,title,values){if(!values?.length)return;const heading=el('h5',title),list=el('ul');for(const value of values)list.append(el('li',value));container.append(heading,list);}
function analysisCard(item,editor){
 const section=el('section',undefined,'analysis-card'),heading=el('div',undefined,'analysis-heading'),triage=item.triage;
 heading.append(el('h4','自动排查'));section.append(heading);
 const stateNames={pending:'等待排查',running:'正在排查',done:'排查完成',failed:'排查失败'};
 heading.append(el('span',!triage&&['resolved','closed'].includes(item.status)?'已结案，无需自动排查':stateNames[triage?.state]||'等待排查','badge'));
 if(triage?.analyzedAt)section.append(el('p','分析时间：'+dateText(triage.analyzedAt),'meta'));
 if(triage?.state==='failed')section.append(el('p',triage.error||'排查失败，请重试。','error'));
 const result=triage?.result;
 if(result){
  const labels=el('div',undefined,'analysis-labels');labels.append(el('span',analysisCategoryNames[result.category]||result.category,'badge'),el('span',priorityNames[result.priority]||result.priority,'badge'),el('span','置信度：'+(confidenceNames[result.confidence]||result.confidence),'badge'));section.append(labels,el('p',result.summary,'analysis-text'));
  textList(section,'可能原因（尚未验证）',result.possibleCauses);textList(section,'反馈中的证据',result.evidence);textList(section,'需要补充的信息',result.missingInfo);
  if(result.duplicateOf){
   const duplicate=el('div',undefined,'duplicate-candidate'),message=el('p');duplicate.append(el('h5','疑似重复意见'),el('p','候选编号：'+result.duplicateOf,'meta'));
   const button=actionButton('查看候选意见',async()=>{button.disabled=true;note(message,'正在读取…');try{const candidate=await api('/api/muse.feedback/'+encodeURIComponent(result.duplicateOf));const detail=el('div',undefined,'duplicate-detail');detail.append(el('strong',candidate.title),el('p',candidate.body,'analysis-text'));duplicate.append(detail);button.hidden=true;note(message,'');}catch(error){note(message,error.message,true);}finally{button.disabled=false;}});duplicate.append(button,message);section.append(duplicate);
  }
  if(result.suggestedReply){const draft=el('div',undefined,'reply-draft');draft.append(el('h5','回复草稿'),el('p',result.suggestedReply,'analysis-text'),actionButton('使用回复草稿',()=>{editor.reply.value=result.suggestedReply;editor.details.open=true;editor.remember();editor.reply.focus();note(editor.message,'已填入草稿，请检查后保存回复。');}));section.append(draft);}
 }
 const actions=el('div',undefined,'analysis-actions'),message=el('p');message.setAttribute('role','status');message.setAttribute('aria-live','polite');
 if(triage?.state==='done'&&triage.review==='pending')for(const [action,label]of [['accept','采纳分析'],['ignore','忽略分析']]){const button=actionButton(label,()=>itemAction(button,message,feedbackPath(item)+'/triage',{action,revision:triage.revision}));actions.append(button);}
 if(triage?.review==='accepted')section.append(el('p','已采纳分析；回复与处理状态以手动保存为准。','review-note'));
 if(triage?.review==='ignored')section.append(el('p','已忽略这次分析。','review-note'));
 if(triage&&triage.state!=='running'&&!item.archivedAt&&!['resolved','closed'].includes(item.status)){const button=actionButton(triage.state==='failed'?'重试排查':'重新排查',()=>itemAction(button,message,feedbackPath(item)+'/triage',{action:'retry',revision:triage.revision}));button.disabled=!automationState?.available;actions.append(button);}
 if(actions.children.length)section.append(actions);section.append(message);return section;
}
function adminEditor(item){
 const details=el('details',undefined,'admin-editor');details.append(el('summary','处理这条意见'));const form=el('form'),select=el('select'),reply=el('textarea'),message=el('p'),button=el('button','保存处理结果');
 for(const [value,label]of Object.entries(statusNames)){const option=el('option',label);option.value=value;select.append(option);}select.value=item.status;reply.value=item.reply;reply.maxLength=2000;reply.rows=3;
 const savedDraft=editorDrafts.get(item.id),expectedRevision=savedDraft?.revision??item.revision;details.open=expandedEditors.get(item.id)===true;if(savedDraft){reply.value=savedDraft.reply;select.value=savedDraft.status;details.open=true;}
 const discard=actionButton('放弃草稿并刷新',async()=>{editorDrafts.delete(item.id);await load(true);focusFeedback('feedback-'+item.id);});discard.hidden=!savedDraft;
 const remember=()=>{editorDrafts.set(item.id,{reply:reply.value,status:select.value,revision:expectedRevision});discard.hidden=false;const outer=details.closest('.feedback-detail');if(outer)outer.open=true;};form.addEventListener('input',remember);form.addEventListener('change',remember);
 const stateLabel=el('label','处理状态'),replyLabel=el('label','回复用户');stateLabel.append(select);replyLabel.append(reply);message.setAttribute('role','status');message.setAttribute('aria-live','polite');form.append(stateLabel,replyLabel,button,discard,message);
 form.addEventListener('submit',async event=>{event.preventDefault();button.disabled=true;try{await api(feedbackPath(item),{method:'PATCH',body:JSON.stringify({revision:expectedRevision,status:select.value,reply:reply.value})});editorDrafts.delete(item.id);await load(true);await loadAutomation();focusFeedback('feedback-'+item.id);}catch(error){note(message,error.message,true);}finally{button.disabled=false;}});details.append(form);return {details,reply,message,remember};
}
function render(item){
 const card=el('article',undefined,'feedback-item fb-row'),top=el('div',undefined,'item-top'),badges=el('div',undefined,'item-badges'),badge=el('span',statusNames[item.status],'badge'),title=el('h3',item.title);card.id='feedback-'+item.id;title.id='feedback-title-'+item.id;badge.dataset.status=item.status;badges.append(badge);if(item.archivedAt)badges.append(el('span','已归档','badge archived-badge'));top.append(el('span',categoryNames[item.category],'category'),badges);card.append(top,title,el('p',bodyExcerpt(item.body),'item-excerpt'),el('p',(admin?item.username+' · ':'')+dateText(item.createdAt)+' · '+item.attachments.length+' 张截图','meta'));
 const details=el('details',undefined,'feedback-detail'),summary=el('summary',admin?'查看详情与处理':'查看详情'),content=el('div',undefined,'feedback-detail-content');details.dataset.feedbackId=item.id;details.open=editorDrafts.has(item.id)||expandedDetails.get(item.id)===true;summary.id='feedback-detail-label-'+item.id;summary.setAttribute('aria-labelledby',summary.id+' '+title.id);details.append(summary,content);content.append(el('p',item.body,'item-body'));
 if(item.attachments.length){const images=el('div',undefined,'screenshots');item.attachments.forEach((shot,index)=>{const link=el('a'),img=el('img');link.href=feedbackPath(item)+'/attachments/'+index;link.target='_blank';link.rel='noopener';img.src=link.href;img.alt=shot.name;img.loading='lazy';link.append(img,el('span','下载截图 '+(index+1)));images.append(link);});content.append(images);}
 if(item.reply){const reply=el('div',undefined,'response');reply.append(el('strong','管理员回复'),el('span',item.reply));content.append(reply);}
 if(admin){
  const editor=adminEditor(item);content.append(analysisCard(item,editor),editor.details);
  if(item.archivedAt||['resolved','closed'].includes(item.status)){const row=el('div',undefined,'archive-actions'),message=el('p'),button=actionButton(item.archivedAt?'恢复到意见列表':'归档这条意见',()=>itemAction(button,message,feedbackPath(item)+'/archive',{archived:!item.archivedAt,revision:item.revision}));message.setAttribute('role','status');message.setAttribute('aria-live','polite');row.append(button,message);content.append(row);}
 }
 card.append(details);return card;
}
function listInteractionActive(){return composeDialog.open||editorDrafts.size>0||Boolean(document.activeElement?.closest('.feedback-item'));}
async function load(reset=false,automatic=false){
 if(loading&&!reset)return;const mine=++generation;loading=true;$('#more').disabled=true;const start=reset?0:offset;note($('#list-status'),'加载中…');
 try{const params=new URLSearchParams({offset:String(start),status:$('#status-filter').value});if(admin)params.set('view',$('#view-filter').value);const data=await api('/api/muse.feedback?'+params);if(mine!==generation)return;if(automatic&&listInteractionActive()){listRefreshNeeded=true;note($('#list-status'),'列表有更新，结束当前操作后自动刷新。');return;}if(reset){rememberExpansion();$('#feedback-list').replaceChildren();}for(const item of data.items)$('#feedback-list').append(render(item));offset=start+data.items.length;$('#more').hidden=offset>=data.total;note($('#list-status'),data.total?'共 '+data.total+' 条意见':'');if(!data.total){const empty=el('div',undefined,'empty');empty.append(el('div',admin?'当前筛选下没有意见':'还没有意见'),el('p',admin?'切换视图或处理状态查看其他意见。':'写下你的第一条反馈，让 MUSE 更懂你的工作。'));$('#feedback-list').append(empty);}}
 catch(error){if(mine===generation)note($('#list-status'),error.message,true);}finally{if(mine===generation){loading=false;$('#more').disabled=false;}}
}
function packageButtonLabel(item){return packageReceipts.has(item.date)?'重试确认':item.downloadedAt?'再次下载':'下载意见包';}
function renderPackages(items){
 const section=$('#feedback-packages'),focusedDate=section.contains(document.activeElement)?document.activeElement.dataset.packageDate:null,active=$('#packages-list'),archived=$('#packages-archived-list'),archive=$('#packages-archive');active.replaceChildren();archived.replaceChildren();
 const archivedCount=items.filter(item=>item.archivedAt).length;archive.hidden=archivedCount===0;archive.querySelector('summary').textContent='已归档意见包（'+archivedCount+'）';
 for(const item of items){
  const row=el('li',undefined,'package-item'),heading=el('div',undefined,'package-item-heading'),date=el('time',item.date),badge=el('span',item.downloadedAt?'已解决':'未解决','badge');date.dateTime=item.date;badge.dataset.status=item.downloadedAt?'resolved':'new';heading.append(date,badge);
  const message=el('p',undefined,'package-message'),saved=packageMessages.get(item.date);message.setAttribute('role','status');message.setAttribute('aria-live','polite');if(saved)note(message,saved.text,saved.error);
  const button=actionButton(packageButtonLabel(item),()=>void downloadPackage(item,button,message),'quiet package-download');button.dataset.packageDate=item.date;button.setAttribute('aria-label',item.date+' '+packageButtonLabel(item));button.disabled=packageDownloads.size>0;
  row.append(heading,el('p',item.count+' 条意见 · '+item.groups+' 组问题','small muted'),button,message);if(item.downloadedAt)row.append(el('p','下载于 '+dateText(item.downloadedAt),'small muted'));(item.archivedAt?archived:active).append(row);
 }
 if(focusedDate){const button=[...section.querySelectorAll('.package-download')].find(node=>node.dataset.packageDate===focusedDate);if(button?.closest('#packages-archive'))archive.open=true;button?.focus({preventScroll:true});}
}
async function loadPackages(){
 const mine=++packageGeneration;
 try{const data=await api('/api/muse.feedback/packages');if(mine!==packageGeneration)return;const items=data.items.sort((a,b)=>b.date.localeCompare(a.date)),signature=JSON.stringify(items);packageItems=new Map(items.map(item=>[item.date,item]));if(signature!==packageSignature){renderPackages(items);packageSignature=signature;}note($('#packages-status'),items.some(item=>!item.archivedAt)?'':items.length?'暂无当前意见包，可展开查看已归档意见包。':'暂无意见包。每天 09:00 生成后会显示在这里。');}
 catch(error){if(mine===packageGeneration)note($('#packages-status'),error.message,true);}
 finally{if(mine===packageGeneration)$('#feedback-packages').dataset.loaded='true';}
}
async function downloadPackage(item,button,message){
 if(packageDownloads.size)return;packageDownloads.add(item.date);for(const pending of $('#feedback-packages').querySelectorAll('.package-download'))pending.disabled=true;for(const url of downloadUrls)URL.revokeObjectURL(url);downloadUrls.clear();
 const update=(text,error=false)=>{packageMessages.set(item.date,{text,error});note(message,text,error);};
 let confirmed=false;
 try{
  if(!packageReceipts.has(item.date)){
   update('正在下载意见包…');const controller=new AbortController();downloadControllers.add(controller);
   let response,blob;try{response=await fetch('/api/muse.feedback/packages/'+encodeURIComponent(item.date)+'/download',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:'{}',signal:controller.signal});if(response.redirected||response.status===401)throw Error('登录已过期，请返回工作间重新登录');if(!response.ok){const body=await response.json().catch(()=>({}));throw Error(body.error||'意见包下载失败，请重试');}blob=await response.blob();}finally{downloadControllers.delete(controller);}
   if(!blob.size)throw Error('意见包内容为空，请重试');const url=URL.createObjectURL(blob);downloadUrls.add(url);const link=el('a');link.href=url;link.download='muse-feedback-'+item.date+'.zip';link.hidden=true;document.body.append(link);try{link.click();}finally{link.remove();}setTimeout(()=>{URL.revokeObjectURL(url);downloadUrls.delete(url);},60000);
   const receipt=response.headers.get('X-Muse-Download-Receipt');if(receipt)packageReceipts.set(item.date,receipt);
  }
  if(packageReceipts.has(item.date)){update('文件已下载，正在更新状态…');await api('/api/muse.feedback/packages/'+encodeURIComponent(item.date)+'/confirm-download',{method:'POST',body:JSON.stringify({receipt:packageReceipts.get(item.date)})});packageReceipts.delete(item.date);confirmed=true;}
  update('意见包已下载。');packageSignature=undefined;await loadPackages();if(confirmed){listRefreshNeeded=true;await loadAutomation();}
 }catch(error){if(packageReceipts.has(item.date)&&error.status===409){packageReceipts.delete(item.date);update('文件已下载，但确认回执已失效，请重新下载意见包。',true);}else update(packageReceipts.has(item.date)?'文件已下载，状态未更新，请重试。'+error.message:error.message,true);}
 finally{packageDownloads.delete(item.date);for(const current of $('#feedback-packages').querySelectorAll('.package-download')){const currentItem=packageItems.get(current.dataset.packageDate);current.disabled=false;if(currentItem){const label=packageButtonLabel(currentItem);current.textContent=label;current.setAttribute('aria-label',currentItem.date+' '+label);}}}
}
function schedulePoll(){clearTimeout(pollTimer);if(!document.hidden)pollTimer=setTimeout(()=>{void loadAutomation();void loadPackages();},5000);}
async function loadAutomation(){
 try{
  const data=await api('/api/muse.feedback/automation'),previous=automationState;automationState=data;const settings=data.settings;
  if(previous&&(previous.lastRun?.at!==data.lastRun?.at||JSON.stringify(previous.summary)!==JSON.stringify(data.summary)||previous.running&&!data.running))listRefreshNeeded=true;
  if(!automationDirty){$('#automation-enabled').checked=settings.enabled;$('#automation-interval').value=settings.intervalMinutes;$('#automation-archive-days').value=settings.archiveAfterDays;}
  $('#automation-enabled').disabled=!data.available;$('#automation-interval').disabled=false;$('#automation-archive-days').disabled=false;$('#automation-save').disabled=false;$('#automation-run').disabled=!data.available||data.running;$('#automation-retry').disabled=!data.available||data.running||!data.summary.failed;
  $('#automation-state').textContent=!data.available?'模型未配置':data.running?'巡检进行中':settings.enabled?'定时巡检已开启':'定时巡检已暂停';
  $('#automation-schedule').textContent=(data.available?'':'尚未配置排查模型，暂不能启动分析。')+'开启后每日 '+settings.archiveTime+' 归档已结案意见，'+settings.digestTime+' 生成摘要和意见包（北京时间）。'+(data.nextRunAt?'下次巡检：'+dateText(data.nextRunAt)+'。':'');
  const summary=$('#automation-summary');summary.replaceChildren();for(const [key,label]of [['active','列表意见'],['pending','待排查'],['needsReview','待确认'],['duplicates','疑似重复'],['failed','排查失败'],['archived','已归档']]){const cell=el('div');cell.append(el('dt',label),el('dd',data.summary[key]??0));summary.append(cell);}
  const attachmentBytes=data.summary.attachmentBytes,attachmentCapacity=256*1024*1024;$('#automation-storage').textContent='附件空间：'+(attachmentBytes/(1024*1024)).toFixed(1)+' / 256 MiB';$('#automation-storage-warning').hidden=attachmentBytes<attachmentCapacity*.8;$('#automation-storage-warning').textContent='附件空间已达到 80%。归档不会释放附件空间；请先导出反馈留存，再由管理员处理附件。';
  $('#automation-last-run').textContent=data.lastRun?'最近巡检：'+dateText(data.lastRun.at)+' · 已分析 '+data.lastRun.analyzed+' 条 · 失败 '+data.lastRun.failed+' 条 · 已归档 '+data.lastRun.archived+' 条':'尚无巡检记录。';
  $('#automation-digest').textContent=data.digest?'每日摘要（'+dateText(data.digest.at)+'）：待确认 '+(data.digest.needsReview??0)+' 条，排查失败 '+(data.digest.failed??0)+' 条，已归档 '+(data.digest.archived??0)+' 条。':'每日摘要尚未生成。';schedulePoll();
  for(const button of document.querySelectorAll('.analysis-actions button'))if(button.textContent.includes('排查'))button.disabled=!data.available;
  if(listRefreshNeeded&&!listInteractionActive()){listRefreshNeeded=false;await load(true,true);}
 }catch(error){note($('#automation-message'),error.message,true);schedulePoll();}
}
const composeDialog=$('#compose-dialog');
$('#compose-open').addEventListener('click',()=>{composeSession++;composeDialog.showModal();});$('#compose-close').addEventListener('click',()=>composeDialog.close());composeDialog.addEventListener('close',()=>$('#compose-open').focus({preventScroll:true}));
$('#feedback-form').addEventListener('submit',async event=>{
 event.preventDefault();const button=$('#submit'),submittedSession=composeSession;button.disabled=true;note($('#form-status'),'正在提交…');
 try{const files=[...$('#attachments').files];if(files.length>3)throw Error('最多上传 3 张截图');const attachments=[];for(const file of files){if(file.size>2*1024*1024)throw Error('每张截图最多 2 MB');const data=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onerror=()=>reject(Error('截图读取失败'));reader.onload=()=>resolve(reader.result.split(',')[1]);reader.readAsDataURL(file);});attachments.push({name:file.name,data});}
 await api('/api/muse.feedback',{method:'POST',body:JSON.stringify({title:$('#title').value,category:$('#category').value,body:$('#body').value,attachments})});if(submittedSession===composeSession){event.target.reset();note($('#form-status'),'');if(composeDialog.open)composeDialog.close();}note($('#page-notice'),'意见已提交，感谢你的反馈。');$('#status-filter').value='';await load(true,true);if(admin)await loadAutomation();
 }catch(error){note($('#form-status'),error.message,true);}finally{button.disabled=false;}
});
$('#refresh').addEventListener('click',()=>{void load(true);if(admin){void loadAutomation();void loadPackages();}});$('#status-filter').addEventListener('change',()=>void load(true));$('#more').addEventListener('click',()=>void load());
if(admin){
 $('#view-filter').addEventListener('change',()=>void load(true));$('#automation-form').addEventListener('input',()=>{automationDirty=true;});
 $('#automation-form').addEventListener('submit',async event=>{event.preventDefault();const button=$('#automation-save');button.disabled=true;try{await api('/api/muse.feedback/automation',{method:'PATCH',body:JSON.stringify({enabled:$('#automation-enabled').checked,intervalMinutes:Number($('#automation-interval').value),archiveAfterDays:Number($('#automation-archive-days').value)})});automationDirty=false;note($('#automation-message'),'巡检设置已保存。');await loadAutomation();}catch(error){note($('#automation-message'),error.message,true);}finally{button.disabled=false;}});
 async function runAutomation(retryFailed){const button=retryFailed?$('#automation-retry'):$('#automation-run');button.disabled=true;try{await api('/api/muse.feedback/automation/run',{method:'POST',body:JSON.stringify({retryFailed})});note($('#automation-message'),'巡检已启动，完成后可刷新意见列表查看结果。');await loadAutomation();}catch(error){note($('#automation-message'),error.message,true);}finally{button.disabled=!automationState?.available||automationState?.running||Boolean(retryFailed&&!automationState?.summary.failed);}}
 $('#automation-run').addEventListener('click',()=>void runAutomation(false));$('#automation-retry').addEventListener('click',()=>void runAutomation(true));
 $('#packages-refresh').addEventListener('click',()=>void loadPackages());document.addEventListener('visibilitychange',()=>{if(document.hidden)clearTimeout(pollTimer);else{void loadAutomation();void loadPackages();}});window.addEventListener('pagehide',()=>{clearTimeout(pollTimer);for(const controller of downloadControllers)controller.abort();for(const url of downloadUrls)URL.revokeObjectURL(url);downloadUrls.clear();});void loadAutomation();void loadPackages();
}
void load(true);

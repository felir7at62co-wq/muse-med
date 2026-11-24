/** Same-origin account usage and archive metadata; no transcript or credential fields are read. */

const states={completed:'已完成',failed:'失败',pending:'处理中',unknown:'结果未知'};
const usageStates={reported:'供应商已回报',partial:'部分回报',unreported:'未回报'};
const errors={request_rejected:'请求被拒绝',upstream_http:'供应商 HTTP 错误',invalid_content_type:'返回格式不符',transport:'连接中断',cancelled:'已取消'};
const count=value=>Number.isSafeInteger(value)&&value>=0;
const record=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const token=value=>value===null||count(value);
const date=value=>typeof value==='string'&&Number.isFinite(Date.parse(value));
const day=value=>date(value)&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&new Date(value).toISOString().slice(0,10)===value;
const number=value=>value===null?'未回报':value.toLocaleString('zh-CN');
const stamp=value=>typeof value==='string'&&Number.isFinite(Date.parse(value))?new Date(value).toISOString().replace('T',' ').replace('.000Z',' UTC'):'未记录';
const labels={requests:'请求次数',completedRequests:'已完成请求',failedRequests:'失败请求',pendingRequests:'处理中请求',unknownRequests:'结果未知请求',
 inputTokens:'已回报输入 token',outputTokens:'已回报输出 token',totalTokens:'已回报总 token'};
const studioStates={authorized:'已许可未提交',reserved:'已预占',accepted:'已接收',completed:'本地记录完成',failed:'操作失败',unknown:'结果未知','operator-confirmed':'用户结束追踪','awaiting-review':'等待核对'};
const studioSources={native:'原生生成',tts:'独立配音',fal:'视频后期',libtv:'LibTV API','libtv-cli':'LibTV CLI'};
const studioKinds={image:'图片',video:'视频',text:'文本',stream:'流式文本',batch:'批量制作',novel:'小说改写',tts:'配音',audio:'音频',script:'剧本',storyboard:'分镜',upscale:'转高清',erase_subtitles:'去字幕','postproduction':'视频后期','agent-task':'整次任务','budget-reservation':'预算预占记录'};
const studioLabels={operations:'制作提交记录',reportedUsageOperations:'有用量回报的操作',unreportedUsageOperations:'未回报用量的操作',usageErrorOperations:'用量记录异常的操作',supplierReports:'供应商用量快照',inputTokens:'已回报输入 token',outputTokens:'已回报输出 token',totalTokens:'已回报总 token'};

function usageReply(value){
 if(!record(value)||value.version!==1||value.coverage?.transport!=='relay-only'||value.coverage?.direct!=='unobserved'
  ||!record(value.summary)||!Array.isArray(value.items)||!['ok','degraded'].includes(value.health?.state)
  ||!day(value.from)||!day(value.to)||!(value.nextCursor===null||typeof value.nextCursor==='string'))throw Error('invalid_reply');
 for(const key of ['requests','completedRequests','failedRequests','pendingRequests','unknownRequests','reportedUsageRequests','partialUsageRequests','unreportedUsageRequests'])if(!count(value.summary[key]))throw Error('invalid_reply');
 for(const key of ['inputTokens','outputTokens','totalTokens'])if(!token(value.summary[key]))throw Error('invalid_reply');
 for(const row of value.items)if(!record(row)||!['completed','failed','pending','unknown'].includes(row.state)||!['reported','partial','unreported'].includes(row.usageStatus)
  ||!date(row.startedAt)||typeof row.requestId!=='string'||!(row.usage===null||record(row.usage))
  ||['responseModel','forwardedModel','requestedModel','route','channel'].some(key=>row[key]!==undefined&&row[key]!==null&&typeof row[key]!=='string'))throw Error('invalid_reply');
 return value;
}

function archiveReply(value){
 if(!record(value)||!Array.isArray(value.items)||!(value.nextCursor===null||typeof value.nextCursor==='string'))throw Error('invalid_reply');
 for(const row of value.items)if(!record(row)||row.version!==1||typeof row.deviceId!=='string'||typeof row.sessionId!=='string'
  ||!/^([a-f0-9]{64})$/.test(row.digest)||!date(row.storedAt)||!count(row.eventCount)||!Array.isArray(row.attachments)
  ||row.attachments.some(item=>!record(item)||!count(item.sizeBytes)||typeof item.mediaType!=='string'))throw Error('invalid_reply');
 return value;
}

function studioReply(value){
 if(!record(value)||value.version!==2||value.scope!=='studio-all'||value.billingVerified!==false||typeof value.accountId!=='string'
  ||!Array.isArray(value.coveredSources)||value.coveredSources.some(source=>!Object.hasOwn(studioSources,source))
  ||!day(value.from)||!day(value.to)||!['recorded','no-database','not-instrumented'].includes(value.status)||!record(value.summary)
  ||!Array.isArray(value.items)||!(value.nextCursor===null||typeof value.nextCursor==='string')||!['ok','degraded'].includes(value.health?.state)||!count(value.health.invalidUsageReports))throw Error('invalid_reply');
 const resources=value=>record(value)&&['images','videos','audios','tasks'].every(key=>count(value[key]));
 const budgets=value=>Array.isArray(value)&&value.every(item=>record(item)&&typeof item.currency==='string'&&/^[A-Z]{3}$/.test(item.currency)&&['entries','unsettledEntries','settledEntries'].every(key=>count(item[key]))&&record(item.overflows)&&['reservedMinor','heldMinor','settledMinor'].every(key=>token(item[key])&&typeof item.overflows[key]==='boolean')&&typeof item.overflow==='boolean');
 for(const key of ['operations','reportedUsageOperations','unreportedUsageOperations','usageErrorOperations','supplierReports'])if(!count(value.summary[key]))throw Error('invalid_reply');
 if(!record(value.summary.states)||Object.keys(studioStates).some(key=>!count(value.summary.states[key]))||!record(value.summary.sources)||Object.keys(studioSources).some(key=>!count(value.summary.sources[key]))||!resources(value.summary.resources)||!budgets(value.summary.budgetTotals))throw Error('invalid_reply');
 for(const key of ['inputTokens','outputTokens','totalTokens'])if(!token(value.summary[key]))throw Error('invalid_reply');
 for(const key of ['input','output','total']){const coverage=value.summary.tokenCoverage?.[key];if(!record(coverage)||!count(coverage.reportedReports)||!count(coverage.unreportedReports)||typeof coverage.overflow!=='boolean')throw Error('invalid_reply');}
 for(const row of value.items)if(!record(row)||typeof row.operationId!=='string'||typeof row.kind!=='string'||!Object.hasOwn(studioSources,row.source)||typeof row.recordedState!=='string'||!Object.hasOwn(studioStates,row.state)||!date(row.createdAt)||!date(row.updatedAt)
  ||!['reported','unreported','error'].includes(row.usageStatus)||!count(row.supplierReports)||!resources(row.resources)
  ||!budgets(row.budgetTotals)||['inputTokens','outputTokens','totalTokens'].some(key=>!token(row[key]))||!(row.httpStatus===null||count(row.httpStatus))||!(row.errorCode===null||typeof row.errorCode==='string'))throw Error('invalid_reply');
 return value;
}

function budgetText(items){
 if(!items.length)return '未记录预算金额';
 const amount=(value,currency)=>{if(value===null)return '未回报';if(!['CNY','USD'].includes(currency))return number(value)+' 最小货币单位';const raw=BigInt(value);return (raw/100n).toLocaleString('zh-CN')+'.'+String(raw%100n).padStart(2,'0');};
 return items.map(item=>`${item.currency}：预占 ${amount(item.reservedMinor,item.currency)}，待核销 ${amount(item.heldMinor,item.currency)}，已核销 ${amount(item.settledMinor,item.currency)}${item.overflow?'（合计溢出）':''}`).join('；');
}

/**
 * Mount the authenticated page fragment without retaining data across account-page navigation.
 * @param {HTMLElement} root Rendered account data section.
 * @param {object} options Instance-local request function and clock for the owning page or fixture.
 * @returns {() => void} Abort reads and remove listeners owned by this page.
 */
export function mountAccountData(root,{fetcher=window.fetch.bind(window),now=()=>new Date()}={}){
 const doc=root.ownerDocument,admin=root.dataset.admin==='true',form=root.querySelector('[data-usage-filter]');
 const usageNotice=root.querySelector('[data-usage-notice]'),archiveNotice=root.querySelector('[data-archives-notice]');
 const usageNext=root.querySelector('[data-usage-next]'),archiveNext=root.querySelector('[data-archives-next]');
 const studioNotice=root.querySelector('[data-studio-notice]'),studioNext=root.querySelector('[data-studio-next]'),studioRefresh=root.querySelector('[data-studio-refresh]');
 let closed=false,locked=false,usageGeneration=0,archiveGeneration=0,usageCursor=null,archiveCursor=null,usageQuery=null,usageController,archiveController;
 let studioGeneration=0,studioCursor=null,studioQuery=null,studioController;
 const names=new Map(),listeners=[];
 const listen=(element,event,callback)=>{if(element){element.addEventListener(event,callback);listeners.push(()=>element.removeEventListener(event,callback));}};
 const element=(tag,text)=>{const node=doc.createElement(tag);if(text!==undefined)node.textContent=text;return node;};
 const cell=(row,text)=>{const node=element('td',text);row.append(node);return node;};
 const message=(node,text)=>{if(node)node.textContent=text;};
 const clearStudio=()=>{studioCursor=null;studioQuery=null;studioNext.hidden=true;for(const selector of ['[data-studio-items]','[data-studio-summary]'])root.querySelector(selector).replaceChildren();for(const selector of ['[data-studio-period]','[data-studio-coverage]','[data-studio-state-summary]','[data-studio-sources]','[data-studio-budget]'])message(root.querySelector(selector),'');root.querySelector('[data-studio-health]').hidden=true;};
 const clearUsage=()=>{usageCursor=null;usageQuery=null;usageNext.hidden=true;for(const selector of ['[data-usage-items]','[data-usage-summary]'])root.querySelector(selector).replaceChildren();message(root.querySelector('[data-usage-period]'),'');root.querySelector('[data-usage-health]').hidden=true;};
 const clearPrivate=()=>{locked=true;usageGeneration++;archiveGeneration++;studioGeneration++;usageController?.abort();archiveController?.abort();studioController?.abort();clearStudio();message(studioNotice,'登录或权限已变化，请重新登录后查看。');
  for(const selector of ['[data-usage-items]','[data-usage-summary]','[data-archives-items]'])root.querySelector(selector)?.replaceChildren();
  names.clear();const select=form.elements.namedItem('accountId');if(select){select.replaceChildren(element('option','请重新登录'));select.disabled=true;}
  for(const button of root.querySelectorAll('button'))button.disabled=true;
  usageNext.hidden=true;if(archiveNext)archiveNext.hidden=true;message(root.querySelector('[data-usage-period]'),'');root.querySelector('[data-usage-health]').hidden=true;};
 const failure=(error,label)=>error.message==='expired'?'登录已失效，请重新登录后查看。':error.message==='forbidden'?'当前账号没有查看权限。'
  :error.message==='unavailable'?`${label}服务尚未提供或暂时不可用，请稍后重试。`:`无法更新${label}，请重试；如有旧结果，仍显示上次已读取的数据。`;
 async function get(path,signal){
  const response=await fetcher(path,{credentials:'same-origin',cache:'no-store',headers:{Accept:'application/json'},signal});
  if(!response.ok){let details;if([400,404,503].includes(response.status)){try{details=await response.json();}catch(error){void error;}}if(['studio_usage_not_configured','studio_usage_account_not_found','studio_usage_invalid_query','studio_usage_account_required'].includes(details?.error?.code))throw Error(details.error.code);throw Error(response.status===401?'expired':response.status===403?'forbidden':[404,503].includes(response.status)?'unavailable':'request_failed');}
  return await response.json();
 }
 function usageTokens(usage,names){for(const name of names)if(count(usage?.[name]))return number(usage[name]);return '未回报';}
 function drawUsage(data){
  const summary=root.querySelector('[data-usage-summary]');summary.replaceChildren();
  for(const [key,label]of Object.entries(labels)){const item=element('div');item.append(element('dt',label),element('dd',number(data.summary[key])));summary.append(item);}
  message(root.querySelector('[data-usage-period]'),`统计区间：${data.from} 至 ${data.to}（含首尾日期，UTC）。当前页 ${data.items.length} 条请求。`);
  const health=root.querySelector('[data-usage-health]');
  const incomplete=data.summary.partialUsageRequests>0||data.summary.unreportedUsageRequests>0||data.summary.unknownRequests>0;
  health.hidden=data.health.state==='ok'&&!incomplete;
  message(health,(data.health.state==='degraded'?'统计记录状态异常，结果可能不完整。':'')
   +(incomplete?`部分回报 ${data.summary.partialUsageRequests} 次，未回报 ${data.summary.unreportedUsageRequests} 次，结果未知 ${data.summary.unknownRequests} 次；token 合计仅包含供应商实际回报字段。`:''));
  const body=root.querySelector('[data-usage-items]');body.replaceChildren();
  for(const item of data.items){const row=element('tr');cell(row,stamp(item.startedAt));if(admin){const account=cell(row,names.get(item.accountId)??item.accountId??'未记录');if(typeof item.accountId==='string')account.dataset.accountId=item.accountId;}
   const model=cell(row,item.responseModel??item.forwardedModel??item.requestedModel??'未回报模型');
   model.append(element('small',`${item.channel??'未记录通道'}${item.route?' · '+item.route:''}`));
   cell(row,states[item.state]);cell(row,usageTokens(item.usage,['input_tokens','prompt_tokens']));cell(row,usageTokens(item.usage,['output_tokens','completion_tokens']));cell(row,usageTokens(item.usage,['total_tokens']));
   cell(row,usageStates[item.usageStatus]);cell(row,`${item.upstreamStatus??item.clientStatus??'未记录'}${item.errorKind?' · '+(errors[item.errorKind]??'请求失败'):''}`);body.append(row);
  }
  usageCursor=data.nextCursor;usageNext.hidden=usageCursor===null;message(usageNotice,data.summary.requests===0?'此区间没有经过 Muse 中转的请求；其他通道仍未观测。':'用量已更新。缺失的 token 显示“未回报”，不会当作零。');
 }
 async function loadUsage(cursor){
  if(locked||closed)return;
  const generation=++usageGeneration;usageController?.abort();usageController=new AbortController();
  message(usageNotice,'正在读取用量…');form.querySelector('button[type="submit"]').disabled=true;usageNext.disabled=true;
  try{const params=cursor&&usageQuery?new URLSearchParams(usageQuery):new URLSearchParams({from:form.elements.namedItem('from').value,to:form.elements.namedItem('to').value,limit:'50'});
   if(params.get('from')>params.get('to'))throw Error('invalid_dates');
   if(!cursor&&admin&&form.elements.namedItem('accountId').value)params.set('accountId',form.elements.namedItem('accountId').value);
   if(!cursor&&usageQuery!==params.toString())clearUsage();
   if(cursor)params.set('cursor',cursor);
   const data=usageReply(await get((admin?'/api/admin/usage':'/api/muse/usage')+'?'+params,usageController.signal));
   if(closed||generation!==usageGeneration)return;params.delete('cursor');usageQuery=params.toString();drawUsage(data);
  }catch(error){if(closed||generation!==usageGeneration)return;message(usageNotice,error.message==='invalid_dates'?'起始日期不能晚于结束日期。':failure(error,'用量统计'));
   if(error.message==='expired'||error.message==='forbidden')clearPrivate();
  }finally{if(!closed&&generation===usageGeneration){form.querySelector('button[type="submit"]').disabled=false;usageNext.disabled=false;}}
 }
 function drawStudio(data){
  clearStudio();studioCursor=data.nextCursor;studioNext.hidden=studioCursor===null;
  message(root.querySelector('[data-studio-period]'),`统计区间：${data.from} 至 ${data.to}（含首尾日期，UTC）。当前页 ${data.items.length} 条制作提交。`);
  if(data.status!=='recorded'){studioNext.hidden=true;message(studioNotice,data.status==='no-database'?'此账号尚无制作平台数据库，尚无已接入记录；不能据此认定历史用量为零。':'此制作库尚未接入提交用量记录，不包含接入前历史；不能据此认定历史用量为零。');return;}
  const summary=root.querySelector('[data-studio-summary]');for(const[key,label]of Object.entries(studioLabels)){const item=element('div');item.append(element('dt',label),element('dd',number(data.summary[key])));summary.append(item);}
  const coverage=['input','output','total'].map((key,index)=>{const item=data.summary.tokenCoverage[key];return `${['输入','输出','总计'][index]}字段：${item.reportedReports} 次回报、${item.unreportedReports} 次缺失${item.overflow?'（合计溢出，显示未回报）':''}`;}).join('；');
  message(root.querySelector('[data-studio-coverage]'),'已保存供应商快照中的字段覆盖：'+coverage+'。只求实际回报字段之和，不推算缺失总 token，不与中转用量合并。');
  message(root.querySelector('[data-studio-state-summary]'),'持久记录状态：'+Object.entries(studioStates).map(([key,label])=>`${label} ${data.summary.states[key]}`).join(' · ')+`。关联记录：图片 ${data.summary.resources.images} · 视频 ${data.summary.resources.videos} · 音频 ${data.summary.resources.audios} · 任务 ${data.summary.resources.tasks}（不是成功成片数）。`);
  message(root.querySelector('[data-studio-sources]'),'渠道记录：'+Object.entries(studioSources).map(([key,label])=>`${label} ${data.summary.sources[key]}${data.coveredSources.includes(key)?'':'（尚未接入）'}`).join(' · '));
  message(root.querySelector('[data-studio-budget]'),budgetText(data.summary.budgetTotals)+'。金额来自预算账本；预占不是已扣费用，核销不是已验证的供应商账单。');
  const health=root.querySelector('[data-studio-health]');health.hidden=data.health.state==='ok';const issues=[];if(data.health.invalidUsageReports)issues.push(`${data.health.invalidUsageReports} 份供应商回报无效`);if(data.summary.usageErrorOperations)issues.push(`${data.summary.usageErrorOperations} 个操作的用量记录异常`);if(['input','output','total'].some(key=>data.summary.tokenCoverage[key].overflow))issues.push('部分 token 合计溢出');message(health,`制作平台用量观测异常：${issues.join('；')||'记录可能不完整'}。请核对原供应商记录，当前数值不能视为全部用量。`);
  const body=root.querySelector('[data-studio-items]');for(const item of data.items){const row=element('tr');cell(row,stamp(item.createdAt));const name=cell(row,item.operationId);name.append(element('small',studioSources[item.source]+' · '+(studioKinds[item.kind]??'其他制作操作')));cell(row,studioStates[item.state]);cell(row,number(item.inputTokens));cell(row,number(item.outputTokens));cell(row,number(item.totalTokens));cell(row,`${item.supplierReports} 份 · ${item.usageStatus==='error'?'记录异常':usageStates[item.usageStatus]}`);cell(row,`${item.resources.images} / ${item.resources.videos} / ${item.resources.audios} / ${item.resources.tasks}`);cell(row,budgetText(item.budgetTotals));cell(row,`${item.httpStatus??'未记录'}${item.errorCode?' · '+item.errorCode:''}`);body.append(row);}
  message(studioNotice,data.summary.operations?'制作平台用量已更新。仅包含已接入记录的实际回报，未回报不当作零。':'此区间未找到已接入的制作提交记录，不包含接入前历史。');
 }
 async function loadStudio(cursor){
  if(locked||closed)return;const generation=++studioGeneration;studioController?.abort();studioController=new AbortController();
  const selected=admin?form.elements.namedItem('accountId').value:null;
  if(!cursor)clearStudio();if(admin&&!selected){studioRefresh.disabled=false;studioNext.disabled=false;message(studioNotice,'请选择具体账号后查看制作平台用量。');return;}
  message(studioNotice,'正在读取制作平台用量…');studioRefresh.disabled=true;studioNext.disabled=true;
  try{const params=cursor&&studioQuery?new URLSearchParams(studioQuery):new URLSearchParams({from:form.elements.namedItem('from').value,to:form.elements.namedItem('to').value,limit:'50'});if(params.get('from')>params.get('to'))throw Error('invalid_dates');if(admin)params.set('accountId',selected);if(cursor)params.set('cursor',cursor);
   const data=studioReply(await get((admin?'/api/admin/studio-usage':'/api/muse/studio-usage')+'?'+params,studioController.signal));if(closed||generation!==studioGeneration||admin&&form.elements.namedItem('accountId').value!==selected)return;
   if(data.from!==params.get('from')||data.to!==params.get('to')||admin&&data.accountId!==selected)throw Error('invalid_reply');params.delete('cursor');drawStudio(data);studioQuery=params.toString();
  }catch(error){if(closed||generation!==studioGeneration)return;clearStudio();const specific={studio_usage_not_configured:'制作平台用量读取尚未配置，请联系管理员配置后重试。',studio_usage_account_not_found:'所选账号已不存在，请刷新账号列表并重新选择。',studio_usage_invalid_query:'日期或分页条件无效，请重新选择 UTC 日期后查询。',studio_usage_account_required:'请选择具体账号后查看制作平台用量。',invalid_dates:'起始日期不能晚于结束日期。',expired:'登录已失效，请重新登录后查看。',forbidden:'当前账号没有查看此制作平台用量的权限。'};message(studioNotice,specific[error.message]??'制作平台用量读取失败，当前筛选结果不可用，请重试。');if(error.message==='expired'||error.message==='forbidden')clearPrivate();
  }finally{if(!closed&&generation===studioGeneration&&!locked){studioRefresh.disabled=false;studioNext.disabled=false;}}
 }
 async function loadArchives(cursor){
  if(admin||closed||locked)return;const generation=++archiveGeneration;archiveController?.abort();archiveController=new AbortController();message(archiveNotice,'正在读取云存档…');archiveNext.disabled=true;
  try{const params=new URLSearchParams({limit:'50'});if(cursor)params.set('cursor',cursor);
   const data=archiveReply(await get('/api/muse/session-archives?'+params,archiveController.signal));if(closed||generation!==archiveGeneration)return;
   const body=root.querySelector('[data-archives-items]');body.replaceChildren();
   for(const item of data.items){const row=element('tr');cell(row,item.sessionId);cell(row,item.deviceId);cell(row,stamp(item.storedAt));cell(row,number(item.eventCount));
    cell(row,`${item.attachments.length} 个 · ${item.attachments.reduce((sum,file)=>sum+file.sizeBytes,0).toLocaleString('zh-CN')} 字节${item.attachments.length?' · '+[...new Set(item.attachments.map(file=>file.mediaType))].join('、'):''}`);cell(row,item.digest);body.append(row);}
   archiveCursor=data.nextCursor;archiveNext.hidden=archiveCursor===null;message(archiveNotice,data.items.length?'以下会话已收到云存确认，仅展示索引。':'此账号尚无已确认的会话云存档。');
  }catch(error){if(closed||generation!==archiveGeneration)return;message(archiveNotice,failure(error,'云存档'));if(error.message==='expired'||error.message==='forbidden')clearPrivate();}
  finally{if(!closed&&generation===archiveGeneration)archiveNext.disabled=false;}
 }
 const to=now(),from=new Date(to);from.setUTCDate(from.getUTCDate()-29);form.elements.namedItem('to').value=to.toISOString().slice(0,10);form.elements.namedItem('from').value=from.toISOString().slice(0,10);
 const accountsController=new AbortController();
 let accountsLoading=false;
 async function loadAccounts(){if(!admin||accountsLoading||closed||locked)return;accountsLoading=true;const notice=root.querySelector('[data-accounts-notice]'),button=root.querySelector('[data-accounts-refresh]');button.disabled=true;
  try{const data=await get('/api/admin/accounts',accountsController.signal);if(closed)return;
   if(!record(data)||data.version!==1||!Array.isArray(data.items)||data.items.some(item=>!record(item)||typeof item.id!=='string'||typeof item.username!=='string'))throw Error('invalid_reply');
   if(locked)return;const select=form.elements.namedItem('accountId'),previous=select.value;select.replaceChildren(element('option','全部账号'));select.firstElementChild.value='';names.clear();
   for(const item of data.items){names.set(item.id,item.username);const option=element('option',item.username+(item.disabled?'（已停用）':''));option.value=item.id;select.append(option);}select.value=names.has(previous)?previous:'';
   if(previous!==select.value){studioGeneration++;studioController?.abort();clearStudio();message(studioNotice,'请选择具体账号后查看制作平台用量。');usageGeneration++;usageController?.abort();clearUsage();message(usageNotice,'账号已变化，请重新查询用量。');}
   for(const cell of root.querySelectorAll('[data-account-id]'))if(names.has(cell.dataset.accountId))cell.textContent=names.get(cell.dataset.accountId);message(notice,'账号列表已更新。');
  }catch(error){if(!closed){message(notice,failure(error,'账号列表'));if(error.message==='expired'||error.message==='forbidden')clearPrivate();}}
  finally{accountsLoading=false;if(!closed&&!locked)button.disabled=false;}
 }
 if(admin)void loadAccounts();
 listen(form,'submit',event=>{event.preventDefault();void loadUsage(null);void loadStudio(null);});listen(usageNext,'click',()=>{void loadUsage(usageCursor);});
 listen(form,'change',event=>{usageGeneration++;usageController?.abort();clearUsage();message(usageNotice,'筛选已变化，请重新查询用量。');form.querySelector('button[type="submit"]').disabled=false;usageNext.disabled=false;studioGeneration++;studioController?.abort();clearStudio();studioRefresh.disabled=false;studioNext.disabled=false;message(studioNotice,admin&&!form.elements.namedItem('accountId').value?'请选择具体账号后查看制作平台用量。':'筛选已变化，请重新查询制作平台用量。');if(event.target===form.elements.namedItem('accountId'))void loadStudio(null);});listen(root.querySelector('[data-accounts-refresh]'),'click',()=>{void loadAccounts();});
 listen(studioRefresh,'click',()=>{void loadStudio(null);});listen(studioNext,'click',()=>{void loadStudio(studioCursor);});
 listen(root.querySelector('[data-archives-refresh]'),'click',()=>{void loadArchives(null);});listen(archiveNext,'click',()=>{void loadArchives(archiveCursor);});
 void loadUsage(null);void loadArchives(null);void loadStudio(null);
 return ()=>{closed=true;usageGeneration++;archiveGeneration++;studioGeneration++;usageController?.abort();archiveController?.abort();studioController?.abort();accountsController.abort();for(const remove of listeners)remove();};
}

if(typeof document!=='undefined')for(const root of document.querySelectorAll('[data-muse-account-data]')){
 const dispose=mountAccountData(root);window.addEventListener('pagehide',dispose,{once:true});
}

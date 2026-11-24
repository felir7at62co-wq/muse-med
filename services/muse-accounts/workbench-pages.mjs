import {renderSitePage} from './site-shell.mjs';
/** Muse Bot workbench presentation; all account and device strings are escaped. */

const escape=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const number=value=>value===null||value===undefined?'未回报':Number(value).toLocaleString('zh-CN');
const platform={win32:'Windows',darwin:'macOS',linux:'Linux',unknown:'电脑'};
const botStatus={idle:'空闲',running:'正在执行',waiting:'等待处理',error:'需要处理',unreported:'状态未上报'};
const taskStatus={offered:'待本人接受',accepted:'已接受，等待本地处理',declined:'已拒绝',dispatching:'正在送达',delivered:'已送达本地 Bot',completed:'Bot 回合已结束',failed:'执行失败',unknown:'结果待核对'};
const stageNames={project:'项目',assets:'资产',video:'视频',editing:'剪辑',delivery:'交付'};
const copy={title:'云端工作台',mine:'我的本地 Bot',refresh:'刷新',retry:'重新加载',failed:'暂时无法更新，当前内容已保留',updated:'已更新',waiting:'主 Bot 未上报',noRequests:'暂无已记录请求',unavailable:'用量尚未接入',unknown:'用量待核对'};
// Star geometry: DS Bot, Fei2411 and contributors, Apache-2.0; see third_party/plugins/ds-bot/LICENSE.
const star='<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" aria-hidden="true"><path fill="currentColor" d="M40.1 4.4l1.5-.4 1.9.1 5.2 1.1 1.9.9 13.2 14.9 17.1-.8 5.2 1.1 1.8.9 1.7 1.6.7 2.4-.4 1.9-9.7 23.6 5.6 23.7.1 1.9-.6 1.4-2.1 1.8-2.3.5-19.9-1.8-16.6 15.5-1.9 1-1.9.3-7-1.5-2.6-2.1-.9-2.4-2.8-24.1-16-13.6-1.1-1.5-.5-1.9.4-1.9 1.2-1.5 18.9-13.6 7.1-24.6 1-1.7z"/><g fill="#fff" transform="rotate(-10 60 51)"><rect x="50" y="44" width="7" height="19" rx="3.5"/><rect x="62" y="40" width="7" height="19" rx="3.5"/></g></svg>';

function usageText(usage){
 if(usage.status==='no-requests')return copy.noRequests;
 if(usage.status==='unavailable')return copy.unavailable;
 if(usage.status==='unknown')return copy.unknown;
 return `${number(usage.metrics.totalTokens)} <span>tokens · ${number(usage.metrics.requests)} 次请求</span>`;
}

function deviceCard(device){
 const remote=device.canOpenRemote===true?`<a class="wb-button wb-button-quiet" href="${escape(device.remotePath)}">${device.role==='cloud'?'打开云端主 Bot':'远程操作本地 Bot'}<span aria-hidden="true">↗</span></a>`:'<span class="wb-remote-unavailable">仅查看连接状态</span>';
 const proposal=device.canPropose?`<details class="wb-proposal"><summary>分配任务</summary><form data-wb-action="proposal" action="/api/bot-team/proposals" method="post"><input type="hidden" name="deviceId" value="${escape(device.id)}"><label>给 ${escape(device.mainBot.name)} 的任务<textarea name="prompt" maxlength="12000" rows="4" required placeholder="写清目标、交付内容和限制"></textarea></label><p>提出任务后由所属用户决定是否接受</p><button class="wb-button wb-button-quiet" type="submit">提出任务</button></form></details>`:'';
 const identity=device.mainBot?`<strong class="wb-main-bot-name">${escape(device.mainBot.name)}</strong><p>设备已连接 · ${escape(device.statusFresh?botStatus[device.botStatus]??botStatus.unreported:'状态已过期，待更新')} · ${number(device.activeTasks)} 个已接受任务</p>`:`<p>设备已连接 · ${copy.waiting}</p>`;
 return `<li class="wb-device"><div class="wb-device-head"><span class="wb-dot" aria-hidden="true"></span><strong>${escape(device.role==='cloud'?'云端主 Bot':device.name)}</strong><span>${escape(platform[device.platform]??platform.unknown)}</span></div>${identity}${remote}${proposal}</li>`;
}

function memberCard(member){
 const departments=member.departmentPaths===null?'部门待同步':member.departmentPaths.length?member.departmentPaths.map(path=>path.map(node=>node.name).join(' / ')).join(' · '):'未分配部门';
 return `<article class="wb-member" data-account="${escape(member.id)}"><header class="wb-member-head"><div class="wb-avatar">${star}</div><div><h3>${escape(member.name)}</h3><p>${escape(departments)}</p></div>${member.current?'<span class="wb-tag">我</span>':''}</header><div class="wb-account-usage"><span>账号用量</span><strong>${usageText(member.usage)}</strong>${member.usage.metrics?`<small>输入 ${number(member.usage.metrics.inputTokens)} · 输出 ${number(member.usage.metrics.outputTokens)} · 未回报 ${number(member.usage.metrics.unknown)} · 部分 ${number(member.usage.metrics.partial)}</small>`:''}</div>${member.disabled?'<p class="wb-empty-device">账号已停用</p>':member.devices.length?`<ul class="wb-devices">${member.devices.map(deviceCard).join('')}</ul>`:'<p class="wb-empty-device">暂无在线电脑</p>'}</article>`;
}

function progressView(reports=[]){
 const latest=new Map();for(const report of reports)if(Object.hasOwn(stageNames,report.stage))latest.set(report.stage,report);
 return `<div class="wb-stages">${Object.entries(stageNames).map(([id,name])=>{
  const report=latest.get(id),status=!report?'未上报':report.status==='blocked'?'遇到阻塞':report.status==='running'?'执行中':'Bot 已回报';
  return `<div data-stage="${id}"><span>${name}</span><strong>${status}</strong></div>`;
 }).join('')}</div>${reports.length?`<details class="wb-progress-details"><summary>查看 Bot 上报的进度与证据</summary><ul>${reports.map(report=>`<li><strong>${escape(stageNames[report.stage]??report.stage)}</strong><p>${escape(report.summary)}</p><small>${escape(report.reportedAt)} · Bot 回报，待验收</small>${report.artifacts?.length?`<ul>${report.artifacts.map(artifact=>`<li>${escape(artifact.name)} <code>${escape(artifact.path??artifact.url??'')}</code></li>`).join('')}</ul>`:''}</li>`).join('')}</ul></details>`:''}`;
}

function tasksPanel(model){
 if(!model.coordination?.available)return '<section class="wb-section"><h2>云端任务</h2><p class="wb-empty-device">任务协作服务尚未接入</p></section>';
 const tasks=model.coordination.tasks;
 return `<section class="wb-section" aria-label="云端任务"><div class="wb-section-title"><h2>云端任务</h2><span>${tasks.length} 条任务</span></div>${tasks.length?`<div class="wb-task-grid">${tasks.map(task=>`<article class="wb-task" data-task-id="${escape(task.id)}"><header><span class="wb-tag">${escape(taskStatus[task.state]??'结果待核对')}</span><small>${escape(task.updatedAt)}</small></header><h3>${escape(task.ownerName)} · ${escape(task.mainBotName??'主 Bot 未上报')}</h3><p class="wb-target">目标电脑：${escape(task.deviceName)}</p><details class="wb-task-text"${task.state==='offered'?' open':''}><summary>查看任务内容</summary><p>${escape(task.prompt)}</p></details>${task.canDecide?`<form data-wb-action="decision" action="/api/bot-team/decision" method="post"><input type="hidden" name="taskId" value="${escape(task.id)}"><input type="hidden" name="deviceId" value="${escape(task.deviceId)}"><label>本地执行细节<textarea name="details" rows="2" maxlength="4000" placeholder="可补充工作目录、制作要求或限制"></textarea></label><div class="wb-actions"><button class="wb-button" type="submit" name="accept" value="true">接受任务</button><button class="wb-button wb-button-quiet" type="submit" name="accept" value="false">拒绝</button></div></form>`:''}${progressView(task.progress)}${task.result?`<details class="wb-task-text"><summary>查看执行回报（待验收）</summary><p>${escape(task.result)}</p></details>`:''}${task.remotePath?`<a class="wb-text-link" href="${escape(task.remotePath)}">进入自己的本地 Bot ↗</a>`:''}</article>`).join('')}</div>`:'<p class="wb-empty-device">还没有任务提案</p>'}<p class="wb-metering">接受前不执行；“Bot 回合已结束”不代表资产、成片或交付已经验收</p></section>`;
}

function productionPanel(model){
 const board=model.production;
 if(!board)return '<section class="wb-section"><h2>制作项目</h2><p class="wb-empty-device">制作表监测尚未接入</p></section>';
 const ranks={idle:0,waiting:1,running:2,error:3,unreported:4};
 const targets=model.members.flatMap(member=>member.devices.filter(device=>device.mainBot&&device.statusFresh).map(device=>({id:device.id,status:device.botStatus,activeTasks:device.activeTasks,name:member.name+' · '+device.name+' · '+device.mainBot.name+' · '+(botStatus[device.botStatus]??botStatus.unreported)+' · '+device.activeTasks+' 个已接受任务'}))).sort((a,b)=>(ranks[a.status]??4)-(ranks[b.status]??4)||a.activeTasks-b.activeTasks||a.name.localeCompare(b.name,'zh-CN'));
 const approvals={rejected:'管理员已拒绝',offered:'已提出任务，待本人接受',dispatching:'正在派发',dispatch_unknown:'派发结果待核对'};
 return `<section class="wb-section" aria-label="制作项目"><div class="wb-section-title"><div><h2>${escape(board.scopeGroup)} · 制作项目</h2><p>${escape(board.sync.status==='ready'?'制作表已同步':board.sync.status==='error'?'制作表同步失败，保留上次记录':'等待首次同步')}${board.sync.lastSuccessAt?' · '+escape(board.sync.lastSuccessAt):''}</p></div>${model.administrator?'<form data-wb-action="sync" action="/api/production/sync" method="post"><button class="wb-button wb-button-quiet" type="submit">同步制作表</button></form>':''}</div>${board.sync.error?`<p class="wb-notice">${escape(board.sync.error)}</p>`:''}<div class="wb-production-counts"><span>当前可见 ${number(board.counts.total)}</span><span>待确认 ${number(board.counts.ready)}</span><span>已有审批 ${number(board.counts.approved)}</span><span>已拒绝 ${number(board.counts.rejected)}</span></div><p class="wb-metering">飞书源每 ${number(board.sync.intervalMs/1000)} 秒同步，前台页面每 15 秒刷新。管理员批准后只提出任务，由本地用户接受；视频生成、剪辑发布或对外发送需另行决定</p>${board.rows.length?`<div class="wb-production-grid">${board.rows.map(row=>{
  const changed=row.sourceChanged||row.sourceRemoved,canApprove=model.administrator&&row.eligible&&(!row.approval||row.approval.state==='rejected')&&!row.sourceRemoved;
  const reconcile=model.administrator&&['dispatch_unknown','dispatching'].includes(row.approval?.state)?`<form data-wb-action="production" action="/api/production/decision" method="post"><input type="hidden" name="key" value="${escape(row.key)}"><input type="hidden" name="revision" value="${escape(row.approval.revision)}"><input type="hidden" name="deviceId" value="${escape(row.approval.deviceId)}"><input type="hidden" name="details" value="${escape(row.approval.details)}"><p>保留原审批与请求，核对已有派发回执</p><button class="wb-button wb-button-quiet" type="submit" name="decision" value="approve">核对原派发</button></form>`:'';
  const files=row.scripts.map(file=>{
   const authorized=model.administrator||row.approval?.ownerAccountId===model.me.id;
   const path='/api/production/script?'+new URLSearchParams({key:row.key,revision:row.revision,fileToken:file.token});
   return `<li>${authorized&&!row.sourceRemoved&&(model.administrator||!changed)?`<a href="${escape(path)}">${escape(file.name)}</a>`:escape(file.name)}${file.size?`<small>${number(Math.ceil(file.size/1024))} KB</small>`:''}</li>`;
  }).join('');
  return `<article class="wb-production" data-production-key="${escape(row.key)}"><header><span class="wb-tag">${escape(row.tableName)}</span><span>${escape(row.sourceStatus)}</span></header><h3>${escape(row.title)}</h3><p>${escape(row.sourceRemoved?'来源记录已移除':row.sourceChanged?'来源已更新，请核对原审批':row.approval?approvals[row.approval.state]??'已有审批记录':row.eligible?'资料齐备，等待管理员确认':row.reason??'启动条件待核对')}</p>${row.assignees?.length?`<p>飞书负责人：${row.assignees.map(person=>escape(person.name||'未命名负责人')).join('、')}（仅作来源信息）</p>`:''}<ul class="wb-script-files">${files||'<li>没有可用剧本附件</li>'}</ul><a class="wb-text-link" href="${escape(row.sourceUrl)}" target="_blank" rel="noopener noreferrer">查看飞书原始记录 ↗</a>${canApprove?`<form data-wb-action="production" action="/api/production/decision" method="post"><input type="hidden" name="key" value="${escape(row.key)}"><input type="hidden" name="revision" value="${escape(row.revision)}"><label>执行 Bot<select name="deviceId" required><option value="">选择在线且已登记的本地主 Bot</option>${targets.map(target=>`<option value="${escape(target.id)}">${escape(target.name)}</option>`).join('')}</select></label><label>制作说明<textarea name="details" rows="2" maxlength="4000" placeholder="可补充制作细节"></textarea></label><div class="wb-actions"><button class="wb-button" type="submit" name="decision" value="approve"${targets.length?'':' disabled'}>批准并提出任务</button><button class="wb-button wb-button-quiet" type="submit" name="decision" value="reject" formnovalidate>拒绝</button></div></form>`:''}${reconcile}${row.task?`<p class="wb-task-state">任务：${escape(taskStatus[row.task.state]??'结果待核对')}</p>`:''}${progressView(row.task?.progress??[])}${row.task?.result?`<details class="wb-task-text"><summary>查看 Bot 回报（待验收）</summary><p>${escape(row.task.result)}</p></details>`:''}</article>`;
 }).join('')}</div>`:'<p class="wb-empty-device">当前账号暂无可见制作记录</p>'}</section>`;
}

/** Render an authenticated workbench using the provider's already scoped projection.
 * @param {object} model Validated account/device/usage projection from createWorkbench().read().
 * @returns {string} A complete document with relative navigation and external same-origin assets only.
 */
export function renderWorkbench(model){
 const scope=model.scope==='organization'?'组织总览':'我的 Bot',total=model.usage.totals;
 const stats=[['当前筛选账号',model.counts.accounts],['已连接账号',model.counts.connectedAccounts],['在线电脑',model.counts.onlineDevices],['已回报 tokens',model.usage.available?total.totalTokens:null]];
 const options=model.organization.departments.map(node=>`<option value="${escape(node.id)}"${model.filters.department===node.id?' selected':''}>${escape(node.name)}</option>`).join('');
 return renderSitePage({title:copy.title,active:'workbench',admin:model.administrator,username:model.me.name,mainClass:'wb-main',mainAttributes:`data-wb-account="${escape(model.me.id)}"`,styles:['/workbench.css'],scripts:['/workbench.js'],body:`<section class="wb-intro"><div><span class="wb-eyebrow">MUSE / BOT TEAM</span><h1>${scope}</h1><p>连接每个人的本地主 Bot，保留各自的工作区和执行决定</p></div><a class="wb-button" href="/computers">进入我的本地 Bot <span aria-hidden="true">↗</span></a></section>
<form class="wb-filters" action="/workbench" method="get" aria-label="筛选工作台">${model.administrator?`<label>查看范围<select name="scope"><option value="organization"${model.scope==='organization'?' selected':''}>组织总览</option><option value="self"${model.scope==='self'?' selected':''}>仅我自己</option></select></label>`:'<input type="hidden" name="scope" value="self">'}<label class="wb-search">查找用户<input type="search" name="q" value="${escape(model.filters.q)}" placeholder="姓名或账号" maxlength="200"></label>${model.scope==='organization'?`<label>部门<select name="department"><option value="">全部部门</option>${options}</select></label>`:''}<label>用量开始<input type="date" name="from" value="${escape(model.filters.from)}" required></label><label>结束<input type="date" name="to" value="${escape(model.filters.to)}" required></label><button class="wb-button wb-button-quiet" type="submit">筛选</button></form>
<div class="wb-refresh-line"><p id="wb-refresh-status" role="status" data-failed="${copy.failed}" data-updated="${copy.updated}">${model.organization.status==='unavailable'?'部门信息尚未同步':`部门信息${model.organization.status==='partial'?'部分同步':'已同步'}${model.organization.updatedAt?' · '+escape(model.organization.updatedAt):''}`}</p><button id="wb-refresh" class="wb-text-button" type="button">${copy.refresh}</button></div>
<div data-workbench-content><section class="wb-stats" aria-label="工作台概览">${stats.map(([label,value])=>`<article><span>${label}</span><strong>${number(value)}</strong></article>`).join('')}</section>
${!model.usage.available?'<p class="wb-notice">服务端用量尚未接入，暂不显示消耗数据</p>':`<p class="wb-metering">按账号汇总服务器转发的请求，不拆分或重复计入多台电脑。统计始于 ${escape(model.usage.recordingSince)}；未回报和部分回报保留为未知</p>`}${model.usage.writeFailures||model.usage.limited?'<p class="wb-notice">用量记录存在缺口或超出展示范围，请在 Token 用量页进一步筛选</p>':''}
<section class="wb-team" aria-label="用户的本地主 Bot">${model.members.length?model.members.map(memberCard).join(''):'<div class="wb-empty"><h2>没有匹配的账号</h2><p>调整姓名或部门筛选后重试</p></div>'}</section>${tasksPanel(model)}${productionPanel(model)}<footer class="wb-footnote">设备在线只代表连接正常；工作状态以上报时间为准。任务须由所属用户明确接受，Bot 回报与制作验收分开展示</footer></div>`,afterMain:`<div id="wb-toast" class="wb-toast" role="status" hidden data-success="已保存" data-pending="正在提交" data-failed="请求结果待核对，请保留页面并核对原记录" data-conflict="记录已更新或已有决定，请刷新后核对" data-forbidden="当前账号没有这项操作权限"><span></span><button type="button" data-wb-toast-close aria-label="关闭提示">×</button></div>`});
}

/** Escaped account identity and administrator usage pages without network access. */

const cstOffset=8*60*60*1000,dayMs=24*60*60*1000;

function time(value,escape){
 const milliseconds=typeof value==='string'?Date.parse(value):NaN;
 return Number.isFinite(milliseconds)?`<time datetime="${escape(new Date(milliseconds).toISOString())}">${escape(new Date(milliseconds).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false}))}</time>`:'未记录';
}

function identityNames(account,escape){
 const identities=account.feishuIdentities??[];
 return identities.length?identities.map(identity=>escape(identity.name)).join('<br>'):'未绑定';
}

function identityOrganizations(account,escape){
 const identities=account.feishuIdentities??[];
 return identities.length?identities.map(identity=>identity.tenantKey?escape(identity.tenantKey):'未提供组织标识').join('<br>'):'—';
}

function organizationDetails(organization,escape){
 if(!organization)return '<p>重新使用飞书登录后，可同步部门和组织路径。</p>';
 const synced='<small>同步时间：'+time(organization.syncedAt,escape)+'</small>';
 switch(organization.status){
  case 'available':return organization.departments.length?'<ul>'+organization.departments.map(department=>'<li>'+escape(department.path||department.name)+'<small>部门标识：'+escape(department.id)+'</small></li>').join('')+'</ul>'+synced:'<p>飞书未返回部门信息。</p>'+synced;
  case 'permission-required':return '<p>尚未开放飞书部门权限，请联系管理员后重新使用飞书登录。</p>'+synced;
  case 'unavailable':return '<p>本次未能同步飞书部门，可重新使用飞书登录重试。</p>'+synced;
 }
}

/**
 * Render the signed-in account's verified Feishu identities and binding action.
 * @param {object} options Account, enabled-login flag, and the gateway HTML escape function.
 * @returns {string} A section for the existing account page; external avatar URLs are not rendered.
 */
export function renderAccountIdentity({account,feishuEnabled,feishuAppType,escape}){
 const identities=account.feishuIdentities??[];
 const entries=identities.map(identity=>`<li><strong>${escape(identity.name)}</strong><small>组织标识：${identity.tenantKey?escape(identity.tenantKey):'未提供组织标识'}</small><small>首次绑定：${time(identity.boundAt,escape)} · 最近飞书登录：${time(identity.lastLoginAt,escape)}</small><h3>飞书部门</h3>${organizationDetails(identity.organization,escape)}</li>`).join('');
 return `<section aria-label="飞书身份"><h2>飞书身份</h2>${feishuAppType==='custom'?'<p>仅限本企业应用可用范围内的成员。</p>':''}${entries?`<p>已绑定飞书账号。</p><ul>${entries}</ul>`:'<p>尚未绑定飞书账号。</p>'}${account.passwordLogin===false?'<p>此账号使用飞书登录，尚未设置密码。</p>':''}${feishuEnabled?`<form action="/auth/feishu/bind" method="post"><button>${identities.length?'绑定其他飞书账号':'绑定飞书账号'}</button></form><small>绑定后继续使用当前 Muse 账号及其工作间；账号权限保持不变。</small>`:'<small>飞书登录暂未启用。</small>'}</section>`;
}

/** Render the owner's assigned groups and measured token counts without exposing other accounts.
 * @param {object} options Safe account details, selected query and the gateway HTML escape function.
 * @returns {string} Account-page sections with period selection and bounded request pagination.
 */
export function renderAccountDetails({details,query,escape}){
 const {groups,usage}=details,number=value=>value===null?'未提供':escape(value.toLocaleString('zh-CN'));
 const rows=items=>items.map(item=>`<tr><td>${escape(item.provider)}</td><td>${escape(item.model)}</td><td>${number(item.requests)}</td><td>${number(item.inputTokens)}</td><td>${number(item.outputTokens)}</td><td>${number(item.totalTokens)}</td><td>${number(item.cachedInputTokens)}</td><td>${number(item.reasoningTokens)}</td></tr>`).join('');
 const headers='<th>供应商</th><th>模型</th><th>请求数</th><th>输入 Token</th><th>输出 Token</th><th>总 Token</th><th>缓存输入</th><th>推理输出</th>';
 const periods=[['today','今日'],['7d','近 7 天'],['30d','近 30 天'],['all','全部记录']].map(([value,label])=>`<option value="${value}"${query.period===value?' selected':''}>${label}</option>`).join('');
 const recent=usage.recent.map(item=>`<tr><td>${time(item.at,escape)}<small>${escape(item.id)}</small></td><td>${escape(item.provider)}<br>${escape(item.model)}</td><td>${item.source==='desktop-direct'?'桌面直连上报':'网关记录'}</td><td>${number(item.status)}</td>${['inputTokens','outputTokens','totalTokens','cachedInputTokens','reasoningTokens'].map(field=>`<td>${number(item[field])}</td>`).join('')}</tr>`).join('');
 const page=(offset,label)=>`<a href="/account?period=${query.period}&offset=${offset}&limit=${query.limit}#token-requests">${label}</a>`;
 return `<section aria-label="我的分组"><h2>我的分组</h2>${groups.length?`<ul>${groups.map(group=>`<li><strong>${escape(group.name)}</strong><p>${escape(group.description||'暂无分组说明')}</p><small>分组标识：${escape(group.id)}</small></li>`).join('')}</ul>`:'<p>暂未分配分组，请联系管理员。</p>'}<small>Muse 分组由管理员分配；飞书组织标识见下方身份信息，分组不代表额外授权。</small></section><section aria-label="Token 用量"><h2>Token 用量</h2><form action="/account" method="get"><label>统计范围<select name="period">${periods}</select></label><button>查看用量</button></form><p>已记录请求：${number(usage.summary.requests)} · 有 Token 数据：${number(usage.summary.reportedRequests)} · 总 Token：${number(usage.summary.totalTokens)}</p><small>记录起点：${time(usage.since,escape)}。按北京时间统计。汇总只累加已提供的计数；未提供不等于零。缓存输入和推理输出是相关输入、输出中的细分，不重复加入总量。网关记录与桌面直连上报均可能缺少供应商用量；接入前历史、离线或上报失败的直连请求无法补记，不能用作供应商账单。</small><h3>按模型</h3>${usage.byModel.length?`<div class="scroll"><table aria-label="按模型的 Token 用量"><thead><tr>${headers}</tr></thead><tbody>${rows(usage.byModel)}</tbody></table></div>`:'<p>此范围内暂无用量记录。</p>'}<h3>每日明细</h3>${usage.byDay.length?`<div class="scroll"><table aria-label="每日 Token 用量"><thead><tr><th>日期（北京）</th><th>请求数</th><th>输入 Token</th><th>输出 Token</th><th>总 Token</th><th>缓存输入</th><th>推理输出</th></tr></thead><tbody>${usage.byDay.map(item=>`<tr><td>${escape(item.date)}</td>${['requests','inputTokens','outputTokens','totalTokens','cachedInputTokens','reasoningTokens'].map(field=>`<td>${number(item[field])}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`:'<p>此范围内暂无每日记录。</p>'}<h3 id="token-requests">逐次请求</h3>${recent?`<div class="scroll"><table aria-label="逐次请求 Token 用量"><thead><tr><th>时间与请求标识</th><th>供应商与模型</th><th>来源</th><th>HTTP 状态</th><th>输入 Token</th><th>输出 Token</th><th>总 Token</th><th>缓存输入</th><th>推理输出</th></tr></thead><tbody>${recent}</tbody></table></div>`:'<p>暂无请求记录。</p>'}<nav aria-label="用量分页">${query.offset>0?page(Math.max(0,query.offset-query.limit),'上一页'):''}${usage.pagination.hasMore?page(query.offset+query.limit,'下一页'):''}<small>共 ${number(usage.pagination.total)} 条请求</small></nav></section>`;
}

/** Render administrator-owned informational group assignment fields.
 * @param {object} options Target account and gateway page helpers.
 * @returns {string} Complete server-rendered group-edit form; an empty name removes that row.
 */
export function renderAccountGroups({account,escape,page}){
 const groups=[...(account.groups??[]),...((account.groups??[]).length<20?[{name:'',description:''}]:[])];
 return page('分组管理',`<h1>分组管理</h1><nav><a href="/admin">返回账户管理</a></nav><p>${escape(account.username)}</p><p>编辑此用户的 Muse 分组和说明。留空名称可移除该分组；保存新增分组后可继续添加，最多 20 个分组。</p><form action="/admin/groups" method="post"><input type="hidden" name="id" value="${escape(account.id)}">${groups.map((group,index)=>`<fieldset><legend>分组 ${index+1}</legend><label>分组名称<input name="groupName" maxlength="80" value="${escape(group.name)}"></label><label>分组说明<input name="groupDescription" maxlength="500" value="${escape(group.description)}"></label></fieldset>`).join('')}<button>保存分组</button></form><small>分组用于信息展示，不授予管理员权限，也不修改飞书部门。</small>`);
}

/**
 * Render administrator account controls and deduplicated current-use statistics.
 * @param {object} options Accounts, authorized administrator session, device lookup by account ID, existing page helpers, current milliseconds and environment metadata.
 * @returns {string} A complete administrator document with server-side Asia/Shanghai day ranges.
 */
export function renderAdminAccounts({accounts,session,devicesOf,adminCentre,adminHosts,now,feishuEnabled,escape,page,environment}){
 if(!session.account.admin)throw Error('Administrator account required');
 const current=typeof now==='function'?now():now;
 const todayStart=Math.floor((current+cstOffset)/dayMs)*dayMs-cstOffset,weekStart=todayStart-6*dayMs;
 const enabled=accounts.filter(account=>!account.disabled);
 const online=new Map(accounts.map(account=>[account.id,account.disabled?0:new Set(devicesOf(account.id).filter(device=>device.state==='online').map(device=>device.id)).size]));
 const activeSince=start=>enabled.filter(account=>{const at=Date.parse(account.lastActivityAt);return Number.isFinite(at)&&at>=start&&at<=current;}).length;
 const rows=accounts.map(account=>`<tr><td>${escape(account.username)}${account.admin?'（管理员）':''}</td><td>${identityNames(account,escape)}</td><td>${identityOrganizations(account,escape)}</td><td>${(account.groups??[]).map(group=>escape(group.name)).join('<br>')||'未分组'}<br><a href="/admin/groups?id=${encodeURIComponent(account.id)}">编辑分组</a></td><td>${escape(account.createdAt.slice(0,10))}</td><td>${time(account.lastLoginAt,escape)}</td><td>${time(account.lastActivityAt,escape)}</td><td>${online.get(account.id)}</td><td>${account.disabled?'已停用':'正常'}</td><td>${account.id===session.id?'当前账号':`<form action="/admin/disable" method="post"><input type="hidden" name="id" value="${escape(account.id)}"><input type="hidden" name="disabled" value="${!account.disabled}"><button>${account.disabled?'启用':'停用'}</button></form>`}</td><td>${account.id===session.id?(account.passwordLogin===false?'飞书登录':'<a href="/account">修改密码</a>'):`<form class="row" action="/admin/reset" method="post"><input type="hidden" name="id" value="${escape(account.id)}"><input type="password" name="password" maxlength="128" required placeholder="新密码" autocomplete="new-password"><button>修改密码</button></form>`}</td>${adminCentre?`<td><form class="row" action="/admin/control/open" method="post" target="_blank"><input type="hidden" name="target" value="${escape(account.id)}"><button>进入其工作间 ↗</button></form></td>`:''}</tr>`).join('');
 const machines=adminCentre?Object.keys(adminHosts).map(id=>`<form action="/admin/control/open" method="post" target="_blank"><input type="hidden" name="target" value="${escape(id)}"><button>${escape(id==='server'?'服务器 · 完整 DSH':'本机 Windows · 完整 DSH')} ↗</button></form>`).join(''):'';
 const bound=accounts.filter(account=>account.feishuIdentities?.length>0).length;
 const onlineCounts=enabled.map(account=>online.get(account.id));
 const overview=`<section aria-label="使用概览"><h2>使用概览</h2><p>注册账号：<strong>${accounts.length}</strong> · 正常账号：<strong>${enabled.length}</strong> · 已停用：<strong>${accounts.length-enabled.length}</strong> · 管理员：<strong>${accounts.filter(account=>account.admin).length}</strong></p><p>当前在线账号（已连接桌面）：<strong>${onlineCounts.filter(count=>count>0).length}</strong> · 在线桌面：<strong>${onlineCounts.reduce((sum,count)=>sum+count,0)}</strong></p><p>飞书绑定账号：<strong>${bound}</strong> · 今日使用账号：<strong>${activeSince(todayStart)}</strong> · 近 7 天使用账号：<strong>${activeSince(weekStart)}</strong></p><small>在线表示 Muse 桌面已连接且登录有效；一个账号连接多台电脑只计一次。注册数含测试账号，不等于独立用户人数。飞书绑定数按 Muse 账号去重，包含已停用账号。使用人数只统计正常账号主动发起或继续任务的最近记录，按北京时间计算今日与含今天的近 7 天；后台心跳不计使用，接入统计前的操作没有补记。页面刷新时更新。</small></section>`;
 return page('账户管理',`<h1>账户管理</h1>${environment==='development'?'<p>开发验证环境</p>':''}<nav><a href="/">我的工作间</a><a href="/account">我的账户</a>${adminCentre?'<a href="/admin/control">管理员中心</a>':''}</nav><p>管理账号状态、分组与密码；私人文档和会话不在此展示。</p>${!feishuEnabled?'<p>飞书登录暂未启用。</p>':''}${overview}<div class="scroll"><table><thead><tr><th>用户名</th><th>飞书姓名</th><th>组织标识</th><th>Muse 分组</th><th>注册日期</th><th>最近登录</th><th>最近使用</th><th>在线桌面</th><th>状态</th><th>账号操作</th><th>密码操作</th>${adminCentre?'<th>管理入口</th>':''}</tr></thead><tbody>${rows}</tbody></table></div>${machines?`<h2>整机入口</h2><p>需要先通过管理员中心验证独立口令，验证后这些入口才可用。</p>${machines}`:''}`);
}

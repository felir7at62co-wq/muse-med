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

/**
 * Render the signed-in account's verified Feishu identities and binding action.
 * @param {object} options Account, enabled-login flag, and the gateway HTML escape function.
 * @returns {string} A section for the existing account page; external avatar URLs are not rendered.
 */
export function renderAccountIdentity({account,feishuEnabled,feishuAppType,escape}){
 const identities=account.feishuIdentities??[];
 const entries=identities.map(identity=>`<li><strong>${escape(identity.name)}</strong><small>组织标识：${identity.tenantKey?escape(identity.tenantKey):'未提供组织标识'}</small><small>首次绑定：${time(identity.boundAt,escape)} · 最近飞书登录：${time(identity.lastLoginAt,escape)}</small></li>`).join('');
 return `<section aria-label="飞书身份"><h2>飞书身份</h2>${feishuAppType==='custom'?'<p>仅限本企业应用可用范围内的成员。</p>':''}${entries?`<p>已绑定飞书账号。</p><ul>${entries}</ul>`:'<p>尚未绑定飞书账号。</p>'}${account.passwordLogin===false?'<p>此账号使用飞书登录，尚未设置密码。</p>':''}${feishuEnabled?`<form action="/auth/feishu/bind" method="post"><button>${identities.length?'绑定其他飞书账号':'绑定飞书账号'}</button></form><small>绑定后继续使用当前 Muse 账号及其工作间；账号权限保持不变。</small>`:'<small>飞书登录暂未启用。</small>'}</section>`;
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
 const rows=accounts.map(account=>`<tr><td>${escape(account.username)}${account.admin?'（管理员）':''}</td><td>${identityNames(account,escape)}</td><td>${identityOrganizations(account,escape)}</td><td>${escape(account.createdAt.slice(0,10))}</td><td>${time(account.lastLoginAt,escape)}</td><td>${time(account.lastActivityAt,escape)}</td><td>${online.get(account.id)}</td><td>${account.disabled?'已停用':'正常'}</td><td>${account.id===session.id?'当前账号':`<form action="/admin/disable" method="post"><input type="hidden" name="id" value="${escape(account.id)}"><input type="hidden" name="disabled" value="${!account.disabled}"><button>${account.disabled?'启用':'停用'}</button></form>`}</td><td>${account.id===session.id?(account.passwordLogin===false?'飞书登录':'<a href="/account">修改密码</a>'):`<form class="row" action="/admin/reset" method="post"><input type="hidden" name="id" value="${escape(account.id)}"><input type="password" name="password" maxlength="128" required placeholder="新密码" autocomplete="new-password"><button>修改密码</button></form>`}</td>${adminCentre?`<td><form class="row" action="/admin/control/open" method="post" target="_blank"><input type="hidden" name="target" value="${escape(account.id)}"><button>进入其工作间 ↗</button></form></td>`:''}</tr>`).join('');
 const machines=adminCentre?Object.keys(adminHosts).map(id=>`<form action="/admin/control/open" method="post" target="_blank"><input type="hidden" name="target" value="${escape(id)}"><button>${escape(id==='server'?'服务器 · 完整 DSH':'本机 Windows · 完整 DSH')} ↗</button></form>`).join(''):'';
 const bound=accounts.filter(account=>account.feishuIdentities?.length>0).length;
 const onlineCounts=enabled.map(account=>online.get(account.id));
 const overview=`<section aria-label="使用概览"><h2>使用概览</h2><p>注册账号：<strong>${accounts.length}</strong> · 正常账号：<strong>${enabled.length}</strong> · 已停用：<strong>${accounts.length-enabled.length}</strong> · 管理员：<strong>${accounts.filter(account=>account.admin).length}</strong></p><p>当前在线账号（已连接桌面）：<strong>${onlineCounts.filter(count=>count>0).length}</strong> · 在线桌面：<strong>${onlineCounts.reduce((sum,count)=>sum+count,0)}</strong></p><p>飞书绑定账号：<strong>${bound}</strong> · 今日使用账号：<strong>${activeSince(todayStart)}</strong> · 近 7 天使用账号：<strong>${activeSince(weekStart)}</strong></p><small>在线表示 Muse 桌面已连接且登录有效；一个账号连接多台电脑只计一次。注册数含测试账号，不等于独立用户人数。飞书绑定数按 Muse 账号去重，包含已停用账号。使用人数只统计正常账号主动发起或继续任务的最近记录，按北京时间计算今日与含今天的近 7 天；后台心跳不计使用，接入统计前的操作没有补记。页面刷新时更新。</small></section>`;
 return page('账户管理',`<h1>账户管理</h1>${environment==='development'?'<p>开发验证环境</p>':''}<nav><a href="/">我的工作间</a><a href="/account">我的账户</a>${adminCentre?'<a href="/admin/control">管理员中心</a>':''}</nav><p>管理账号状态与密码；私人文档和会话不在此展示。</p>${!feishuEnabled?'<p>飞书登录暂未启用。</p>':''}${overview}<div class="scroll"><table><thead><tr><th>用户名</th><th>飞书姓名</th><th>组织标识</th><th>注册日期</th><th>最近登录</th><th>最近使用</th><th>在线桌面</th><th>状态</th><th>账号操作</th><th>密码操作</th>${adminCentre?'<th>管理入口</th>':''}</tr></thead><tbody>${rows}</tbody></table></div>${machines?`<h2>整机入口</h2><p>需要先通过管理员中心验证独立口令，验证后这些入口才可用。</p>${machines}`:''}`);
}

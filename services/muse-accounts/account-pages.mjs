import {renderSitePage} from './site-shell.mjs';
/** Escaped account identity and administrator usage pages without network access. */

const cstOffset=8*60*60*1000,dayMs=24*60*60*1000,pageSize=25;

function time(value,escape){
 const milliseconds=typeof value==='string'?Date.parse(value):NaN;
 return Number.isFinite(milliseconds)?`<time datetime="${escape(new Date(milliseconds).toISOString())}">${escape(new Date(milliseconds).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false}))}</time>`:'未记录';
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

function stamp(value){return typeof value==='string'?Date.parse(value):NaN;}
function shortTime(value,escape){
 const milliseconds=stamp(value);
 if(!Number.isFinite(milliseconds))return '<span class="muted">未记录</span>';
 const date=new Date(milliseconds),label=date.toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false});
 return `<time datetime="${escape(date.toISOString())}" title="${escape(date.toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false}))}">${escape(label)}</time>`;
}
function bound(account){return (account.feishuIdentities??[]).length>0;}
function loginMode(account){return bound(account)?(account.passwordLogin===false?'feishu-only':'both'):(account.passwordLogin===false?'none':'password-only');}
function option(value,label,current,escape){return `<option value="${escape(value)}"${value===current?' selected':''}>${escape(label)}</option>`;}
function choice(value,allowed){return typeof value==='string'&&allowed.includes(value)?value:allowed[0];}
function select(name,label,items,current,escape){return `<label class="filter-field"><span>${label}</span><select name="${name}">${items.map(([value,text])=>option(value,text,current,escape)).join('')}</select></label>`;}
function statistic(id,label,value,detail){return `<article class="stat-card"><p>${label}</p><strong data-stat="${id}">${value}</strong><span>${detail}</span></article>`;}
function statusTag(label,tone='neutral'){return `<span class="tag tag-${tone}">${label}</span>`;}

function organization(orgData,accounts){
 const nodes=new Map((orgData?.departments??[]).map(department=>[department.id,department]));
 function path(id){
  const result=[],visited=new Set();let next=id;
  while(next!==null&&next!==undefined&&next!==''){
   if(next==='0'&&!nodes.has(next))break;
   if(visited.has(next)||!nodes.has(next))return null;
   visited.add(next);const node=nodes.get(next);result.unshift(node);next=node.parentId;
  }
  return result.length?result:null;
 }
 const paths=new Map([...nodes.keys()].map(id=>[id,path(id)]).filter(([,value])=>value));
 const accountPaths=new Map(accounts.map(account=>{
  const membership=orgData?.accounts&&Object.hasOwn(orgData.accounts,account.id)?orgData.accounts[account.id]:undefined;
  if(!membership||membership.status!=='ready'||!Array.isArray(membership.departmentIds))return [account.id,null];
  const uniqueIds=[...new Set(membership.departmentIds)];
  if(uniqueIds.some(id=>!paths.has(id)))return [account.id,null];
  return [account.id,uniqueIds.map(id=>paths.get(id))];
 }));
 const contains=(account,id)=>accountPaths.get(account.id)?.some(value=>value.some(node=>node.id===id))??false;
 return {paths,accountPaths,contains};
}

/**
 * Render the administrator directory with account-scoped statistics and GET-only filters.
 * @param {object} options Accounts, administrator identity, device lookup, optional organization data, current time, deployment flags and query filters. Password forms are absent when passwordAuthEnabled is false.
 * @returns {string} A complete escaped document using the same-origin administrator stylesheet; account actions retain their existing POST routes.
 */
export function renderAdminAccounts({accounts,session,devicesOf,adminCentre,adminHosts,now,feishuEnabled,escape,environment,filters={},passwordAuthEnabled=true,orgData,modelUsageEnabled=false}){
 if(!session.account.admin)throw Error('Administrator account required');
 const current=typeof now==='function'?now():now;
 const todayStart=Math.floor((current+cstOffset)/dayMs)*dayMs-cstOffset,weekStart=todayStart-6*dayMs;
 const enabled=accounts.filter(account=>!account.disabled);
 const online=new Map(accounts.map(account=>[account.id,account.disabled?0:new Set(devicesOf(account.id).filter(device=>device.state==='online').map(device=>device.id)).size]));
 const usedSince=(account,start)=>{const at=stamp(account.lastActivityAt);return !account.disabled&&Number.isFinite(at)&&at>=start&&at<=current;};
 const activeSince=start=>accounts.filter(account=>usedSince(account,start)).length;
 const onlineCounts=enabled.map(account=>online.get(account.id));
 const boundCount=accounts.filter(bound).length,disabledCount=accounts.length-enabled.length,administratorCount=accounts.filter(account=>account.admin).length;
 const org=organization(orgData,accounts),orgAvailable=orgData?.status==='ready'||orgData?.status==='partial';
 const orgOptions=orgAvailable?[...org.paths].map(([id,path])=>[id,path.map(node=>node.name).join(' / ')]).sort((a,b)=>a[1].localeCompare(b[1],'zh-CN')):[];
 const department=orgAvailable&&typeof filters.department==='string'&&org.paths.has(filters.department)?filters.department:'all';
 const query=typeof filters.q==='string'?filters.q.trim().slice(0,200):'';
 const status=choice(filters.status,['all','enabled','disabled']),login=choice(filters.login,['all','feishu-only','password-only','both']),activity=choice(filters.activity,['all','online','today','week','never']),role=choice(filters.role,['all','admin','member']),sort=choice(filters.sort,['activity','login','created','name']);
 const matches=accounts.filter(account=>{
  if(query&&!`${account.username} ${(account.feishuIdentities??[]).map(identity=>identity.name).join(' ')}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()))return false;
  if(status!=='all'&&Boolean(account.disabled)!==(status==='disabled'))return false;
  if(login!=='all'&&loginMode(account)!==login)return false;
  if(role!=='all'&&Boolean(account.admin)!==(role==='admin'))return false;
  if(department!=='all'&&(!bound(account)||!org.contains(account,department)))return false;
  if(activity==='online'&&online.get(account.id)===0)return false;
  if(activity==='today'&&!usedSince(account,todayStart))return false;
  if(activity==='week'&&!usedSince(account,weekStart))return false;
  if(activity==='never'&&Number.isFinite(stamp(account.lastActivityAt)))return false;
  return true;
 });
 const numeric=value=>Number.isFinite(stamp(value))?stamp(value):0;
 matches.sort((a,b)=>sort==='name'?a.username.localeCompare(b.username,'zh-CN'):numeric(sort==='created'?b.createdAt:sort==='login'?b.lastLoginAt:b.lastActivityAt)-numeric(sort==='created'?a.createdAt:sort==='login'?a.lastLoginAt:a.lastActivityAt)||a.username.localeCompare(b.username,'zh-CN'));
 const pageCount=Math.max(1,Math.ceil(matches.length/pageSize));
 const requestedPage=typeof filters.page==='string'&&/^[1-9]\d{0,5}$/.test(filters.page)?Number(filters.page):1;
 const currentPage=Math.min(requestedPage,pageCount),start=(currentPage-1)*pageSize,visible=matches.slice(start,start+pageSize);
 const filterValues={q:query,status,login,activity,role,sort,department};
 const pageLink=number=>{const parameters=new URLSearchParams({...filterValues,page:String(number)});return `/admin?${escape(parameters.toString())}`;};
 const rows=visible.map(account=>{
  const identities=account.feishuIdentities??[],names=identities.map(identity=>identity.name).filter(Boolean),display=names[0]||account.username,mode=loginMode(account),isCurrent=account.id===session.id;
  const modes={'feishu-only':'飞书登录','both':'飞书 + 密码','password-only':'密码登录','none':'无可用登录方式'};
  const accountStatus=statusTag(account.disabled?'已停用':'正常',account.disabled?'muted':'success');
  const paths=org.accountPaths.get(account.id);
  const organizationCell=!bound(account)?'<span class="muted">未关联飞书</span>':!orgAvailable||paths===null?'<span class="muted">待同步或无权限</span>':paths.length?paths.map(value=>`<span class="organization-path">${value.map(node=>escape(node.name)).join(' / ')}</span>`).join(''):'<span class="muted">未分配部门</span>';
  const metadata=names.length?`<span class="secondary">账号 · ${escape(account.username)}</span>${names.length>1?`<span class="secondary">其他飞书身份 · ${names.slice(1).map(escape).join('、')}</span>`:''}`:`<span class="secondary">尚未绑定飞书</span>`;
  const stateForm=isCurrent?'<p class="action-note">当前管理员账号不可在此停用</p>':`<form action="/admin/disable" method="post"><input type="hidden" name="id" value="${escape(account.id)}"><input type="hidden" name="disabled" value="${!account.disabled}"><button class="button ${account.disabled?'button-secondary':'button-danger'}" type="submit">${account.disabled?'启用账号':'停用账号'}</button></form>`;
  const passwordForm=!passwordAuthEnabled?'<p class="action-note">当前仅开放飞书登录，密码操作已关闭</p>':isCurrent?(account.passwordLogin===false?'<p class="action-note">当前账号使用飞书登录</p>':'<a class="button button-secondary" href="/account">修改密码</a>'):`<form class="password-form" action="/admin/reset" method="post"><input type="hidden" name="id" value="${escape(account.id)}"><label>重置登录密码<input type="password" name="password" maxlength="128" required placeholder="新密码" autocomplete="new-password"></label><button class="button button-secondary" type="submit">修改密码</button></form>`;
  const workroom=adminCentre?`<form action="/admin/control/open" method="post" target="_blank"><input type="hidden" name="target" value="${escape(account.id)}"><button class="button button-secondary" type="submit">进入其工作间 ↗</button></form>`:'';
  return `<tr${isCurrent?' data-current-account="true"':''}><td><div class="identity"><span class="avatar" aria-hidden="true">${escape(Array.from(display)[0]||'M')}</span><div><div class="identity-title">${escape(display)}${isCurrent?statusTag('当前账号','accent'):''}</div>${metadata}<span class="secondary">注册于 ${escape(account.createdAt.slice(0,10))}</span></div></div></td><td><div class="tag-stack">${accountStatus}${statusTag(account.admin?'管理员':'普通成员')}</div></td><td><span class="login-mode">${modes[mode]}</span>${bound(account)?'<span class="secondary">已绑定飞书身份</span>':''}</td><td>${organizationCell}</td><td>${shortTime(account.lastActivityAt,escape)}</td><td>${shortTime(account.lastLoginAt,escape)}</td><td>${online.get(account.id)>0?`<span class="connection-count"><i aria-hidden="true"></i>${online.get(account.id)} 台已连接</span>`:'<span class="muted">未连接</span>'}</td><td><details class="account-actions"><summary>管理账号</summary><div class="action-content">${stateForm}${passwordForm}${workroom}<a class="button button-secondary" href="/admin/groups?id=${encodeURIComponent(account.id)}">编辑 Muse 分组</a></div></details></td></tr>`;
 }).join('');
 const overview=`<section aria-label="使用概览" class="overview">${statistic('accounts','注册账号',accounts.length,`正常 ${enabled.length} · 已停用 ${disabledCount}`)}${statistic('feishu','已绑定飞书',boundCount,`未绑定 ${accounts.length-boundCount} · 管理员 ${administratorCount}`)}${statistic('today','今日使用账号',activeSince(todayStart),`近 7 天使用 ${activeSince(weekStart)}`)}${statistic('online','当前连接账号',onlineCounts.filter(count=>count>0).length,`已连接桌面 ${onlineCounts.reduce((sum,count)=>sum+count,0)} 台`)}</section>`;
 const notes=`<details class="statistics-notes"><summary>这些数字如何统计？</summary><div><p>注册数含测试账号，不等于独立用户人数。当前缺少可靠的测试账号标记，因此不会根据账号名称推断真人或测试身份。</p><p>飞书绑定数按 Muse 账号去重，包含已停用账号；同一账号绑定多个飞书身份仍只计一个账号。管理员 ${administratorCount} 个，正常账号 ${enabled.length} 个，已停用 ${disabledCount} 个。</p><p>在线表示 Muse 桌面已连接且登录有效；一个账号连接多台电脑只计一次。当前连接 ${onlineCounts.filter(count=>count>0).length} 个账号，共 ${onlineCounts.reduce((sum,count)=>sum+count,0)} 台桌面；未连接不等于没有注册或没有使用。</p><p>使用账号只统计正常账号主动发起或继续任务的最近记录，按北京时间计算今日与含今天的近 7 天；后台心跳不计使用，接入统计前的操作没有补记。最近登录与最近使用是不同记录，未记录不代表从未登录。</p></div></details>`;
 const filterForm=`<form action="/admin" method="get" class="filters" role="search"><label class="search-field"><span>查找账号</span><input type="search" name="q" value="${escape(query)}" maxlength="200" placeholder="搜索账号或飞书姓名" autocomplete="off"></label>${select('department','所属部门',[['all','全部部门'],...orgOptions],department,escape)}${select('status','账号状态',[['all','全部状态'],['enabled','正常'],['disabled','已停用']],status,escape)}${select('login','登录方式',[['all','全部方式'],['feishu-only','仅飞书'],['password-only','仅密码'],['both','飞书 + 密码']],login,escape)}${select('activity','使用情况',[['all','全部记录'],['online','桌面已连接'],['today','今日使用'],['week','近 7 天使用'],['never','无使用记录']],activity,escape)}${select('role','账号角色',[['all','全部角色'],['admin','管理员'],['member','普通成员']],role,escape)}${select('sort','排序',[['activity','最近使用'],['login','最近登录'],['created','注册时间'],['name','账号名称']],sort,escape)}<div class="filter-actions"><button class="button button-primary" type="submit">筛选</button><a class="reset-link" href="/admin">重置</a></div></form>`;
 const unknownOrganization=accounts.filter(account=>bound(account)&&(!orgAvailable||org.accountPaths.get(account.id)===null)).length;
 const organizationRows=orgAvailable?orgOptions.map(([id,label])=>{
  const members=accounts.filter(account=>bound(account)&&org.contains(account,id));
  const parameters=new URLSearchParams({department:id});
  return `<tr><td><a href="/admin?${escape(parameters.toString())}">${escape(label)}</a></td><td>${members.length}</td><td>${members.filter(account=>usedSince(account,todayStart)).length}</td><td>${members.filter(account=>usedSince(account,weekStart)).length}</td></tr>`;
 }).join(''):'';
 const organizationState=orgData?.syncing?'组织信息正在同步':!orgAvailable?'组织信息尚未同步或暂不可用':orgData.status==='partial'?'组织信息部分同步':'组织信息已同步';
 const refreshNotice=filters.org_refresh==='started'?'<p class="notice" role="status">组织同步已启动，请稍后刷新查看进度</p>':'';
 const organizationSummary=`${refreshNotice}<details class="organization-summary"><summary>按部门查看使用情况 <span>${organizationState}</span></summary><div class="organization-content"><p>${organizationState}${orgData?.updatedAt?` · 上次同步 ${shortTime(orgData.updatedAt,escape)}`:''}。${unknownOrganization} 个已关联飞书的账号暂未取得完整部门信息，未计入部门统计。</p><p>统计 Muse 账号，包含下级部门；同一账号在同一部门范围内只计一次。不同账号可能属于同一人，不能直接作为自然人人数或飞书通讯录总人数。</p><form action="/admin/organization/refresh" method="post"><button class="button button-secondary" type="submit"${orgData?.syncing?' disabled':''}>${orgData?.syncing?'正在同步':'同步组织信息'}</button></form>${organizationRows?`<p class="table-hint">左右滑动查看完整表格</p><div class="organization-table-scroll"><table class="organization-table"><thead><tr><th scope="col">部门</th><th scope="col">Muse 账号</th><th scope="col">今日使用</th><th scope="col">近 7 天使用</th></tr></thead><tbody>${organizationRows}</tbody></table></div>`:'<p>暂无可展示的部门统计</p>'}</div></details>`;
 const from=matches.length?start+1:0,to=Math.min(start+pageSize,matches.length);
 const pagination=`<footer class="table-footer"><p>显示 ${from}–${to} 条，共 ${matches.length} 个账号${matches.length!==accounts.length?` · 全部 ${accounts.length} 个`:''}</p><nav class="pagination" aria-label="账号列表分页">${currentPage>1?`<a class="button button-secondary" href="${pageLink(currentPage-1)}" rel="prev">上一页</a>`:'<span class="button button-secondary" aria-disabled="true">上一页</span>'}<span>第 ${currentPage} / ${pageCount} 页</span>${currentPage<pageCount?`<a class="button button-secondary" href="${pageLink(currentPage+1)}" rel="next">下一页</a>`:'<span class="button button-secondary" aria-disabled="true">下一页</span>'}</nav></footer>`;
 const machines=adminCentre?Object.keys(adminHosts).map(id=>`<form action="/admin/control/open" method="post" target="_blank"><input type="hidden" name="target" value="${escape(id)}"><button class="button button-secondary" type="submit">${escape(id==='server'?'服务器 · 完整 DSH':'本机 Windows · 完整 DSH')} ↗</button></form>`).join(''):'';
 return renderSitePage({title:'用户管理',active:'users',admin:true,username:session.account.username,mainClass:'admin-main',styles:['/assets/admin-accounts.css'],body:`<div class="page-heading"><div><p class="eyebrow">ACCOUNT OVERVIEW</p><h1>用户与使用</h1><p class="page-description">了解谁已注册、如何登录，以及最近的实际使用情况</p></div><div class="heading-actions">${environment==='development'?statusTag('开发验证环境','accent'):''}<span class="refreshed">更新于 ${shortTime(new Date(current).toISOString(),escape)}</span><a href="${pageLink(currentPage)}" class="button button-secondary">刷新数据</a></div></div>${!feishuEnabled?'<p class="notice">飞书登录暂未启用</p>':''}${!passwordAuthEnabled?'<p class="notice">当前仅开放飞书登录；历史账号的登录方式仍按已有记录展示，密码入口与密码操作已关闭</p>':''}${overview}${notes}${organizationSummary}<section class="directory" aria-labelledby="directory-title"><div class="section-heading"><div><h2 id="directory-title">账号目录 <span>${accounts.length}</span></h2><p>管理账号状态与访问权限；私人文档和会话不在此展示</p></div><span class="timezone">时间均为北京时间</span></div>${filterForm}<div class="table-scroll"><table><thead><tr><th scope="col">成员 / 账号</th><th scope="col">状态与角色</th><th scope="col">登录方式</th><th scope="col">所属部门</th><th scope="col">最近使用</th><th scope="col">最近登录</th><th scope="col">连接桌面</th><th scope="col">操作</th></tr></thead><tbody>${rows||'<tr><td colspan="8" class="empty-state"><h3>没有找到符合条件的账号</h3><p>试试其他姓名、账号或筛选条件</p><a href="/admin" class="button button-secondary">查看全部账号</a></td></tr>'}</tbody></table></div>${pagination}</section>${machines?`<section class="machine-section"><div><h2>整机入口</h2><p>需要先通过管理员中心验证独立口令，验证后这些入口才可用</p></div><div class="machine-actions">${machines}</div></section>`:''}<p class="page-footnote">统计按 MUSE 账号计算，不能直接当作独立人数；页面刷新时更新数据</p>`});
}

/** Render administrator-owned informational group assignment fields.
 * @param {object} options Target account and gateway page helpers.
 * @returns {string} Complete server-rendered group-edit form; an empty name removes that row.
 */
export function renderAccountGroups({account,escape,page}){
 const groups=[...(account.groups??[]),...((account.groups??[]).length<20?[{name:'',description:''}]:[])];
 return page('分组管理',`<h1>分组管理</h1><nav><a href="/admin">返回账户管理</a></nav><p>${escape(account.username)}</p><p>编辑此用户的 Muse 分组和说明。留空名称可移除该分组；保存新增分组后可继续添加，最多 20 个分组。</p><form action="/admin/groups" method="post"><input type="hidden" name="id" value="${escape(account.id)}">${groups.map((group,index)=>`<fieldset><legend>分组 ${index+1}</legend><label>分组名称<input name="groupName" maxlength="80" value="${escape(group.name)}"></label><label>分组说明<input name="groupDescription" maxlength="500" value="${escape(group.description)}"></label></fieldset>`).join('')}<button>保存分组</button></form><small>分组用于信息展示，不授予管理员权限，也不修改飞书部门。</small>`);
}

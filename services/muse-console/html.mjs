/** Server-rendered console pages. Every dynamic value passes through `escape`; pages carry no script. */

export const escape=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const number=value=>value===null||value===undefined?'—':Number(value).toLocaleString('zh-CN');
const yuan=value=>value===null||value===undefined?'—':'¥'+(value<1?value.toFixed(4):value.toLocaleString('zh-CN',{minimumFractionDigits:2,maximumFractionDigits:2}));
const time=ms=>ms?new Date(ms).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}):'—';
const seconds=ms=>ms===null||ms===undefined?'—':(ms/1000).toFixed(1)+' 秒';
const percent=(part,whole)=>whole?(100*part/whole).toFixed(2)+'%':'—';

const STYLE=`:root{--bg:#fff;--fg:#1f2328;--muted:#6b7280;--line:#e5e7eb;--soft:#f6f7f9;--accent:#2f6feb;--bad:#c62828;--warn:#b26a00;--good:#1a7f37}
@media (prefers-color-scheme:dark){:root{--bg:#16181c;--fg:#e6e8eb;--muted:#9aa0a8;--line:#2c3036;--soft:#1e2126;--accent:#6ea2ff;--bad:#ff7b72;--warn:#e3b341;--good:#56d364}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif}
header{display:flex;align-items:center;gap:24px;padding:12px 16px;border-bottom:1px solid var(--line);position:sticky;top:0;background:var(--bg);z-index:1}
header b{font-size:15px}nav{display:flex;gap:4px;overflow-x:auto}nav a{padding:6px 12px;border-radius:6px;color:var(--muted);text-decoration:none;white-space:nowrap}
nav a[aria-current]{background:var(--soft);color:var(--fg)}header .me{margin-left:auto;color:var(--muted);white-space:nowrap}
main{padding:16px;max-width:1400px}h2{font-size:14px;margin:24px 0 8px;color:var(--muted);font-weight:500}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:8px}.card{background:var(--soft);border-radius:8px;padding:10px 12px}
.card span{display:block;color:var(--muted);font-size:12px}.card strong{font-size:20px;font-weight:600}
.scroll{overflow-x:auto;border:1px solid var(--line);border-radius:8px}table{border-collapse:collapse;width:100%;white-space:nowrap}
th,td{padding:7px 10px;border-bottom:1px solid var(--line);text-align:left}th{color:var(--muted);font-weight:500;background:var(--soft)}tr:last-child td{border-bottom:0}
td.n{text-align:right;font-variant-numeric:tabular-nums}.bad{color:var(--bad)}.warn{color:var(--warn)}.good{color:var(--good)}.muted{color:var(--muted)}
form{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin:8px 0}select,button{font:inherit;padding:5px 8px;border:1px solid var(--line);border-radius:6px;background:var(--bg);color:var(--fg)}
button{cursor:pointer}.tabs{display:flex;gap:4px}.tabs a{padding:4px 10px;border:1px solid var(--line);border-radius:6px;color:var(--fg);text-decoration:none}.tabs a[aria-current]{background:var(--soft)}
.more{display:inline-block;margin-top:8px;color:var(--accent)}`;

/** Navigation: the console's own pages plus existing pages of the same site, reached with the same sign-in. */
const NAV=[['tasks','/workbench','任务'],['records',null,'生成记录'],['services',null,'服务'],['accounts','/admin','账号'],['usage','/admin/usage','用量'],['feedback','/feedback','意见']];

/**
 * Wrap a page body in the console shell.
 * @param {{base:string,active:'records'|'services',viewer:{name:string},title:string,body:string}} page Page parts.
 * @returns {string} Complete HTML document.
 */
export function layout({base,active,viewer,title,body}){
 const links=NAV.map(([id,href,label])=>`<a href="${escape(href??base+'/'+id)}"${active===id?' aria-current="page"':''}>${label}</a>`).join('');
 return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)} · Muse 管理台</title><style>${STYLE}</style></head>
<body><header><b>Muse 管理台</b><nav>${links}</nav><span class="me">${escape(viewer.name)}</span></header><main>${body}</main></body></html>`;
}

/**
 * A full-page message such as sign-in required or forbidden.
 * @param {{title:string,text:string,href?:string,label?:string}} message Message parts.
 * @returns {string} Complete HTML document.
 */
export function messagePage({title,text,href,label}){
 return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)}</title><style>${STYLE}</style></head>
<body><main><h1 style="font-size:18px">${escape(title)}</h1><p class="muted">${escape(text)}</p>${href?`<p><a class="more" href="${escape(href)}">${escape(label)}</a></p>`:''}</main></body></html>`;
}

const table=(head,rows)=>`<div class="scroll"><table><thead><tr>${head.map(cell=>`<th>${cell}</th>`).join('')}</tr></thead><tbody>${rows.length?rows.join(''):`<tr><td colspan="${head.length}" class="muted">没有记录</td></tr>`}</tbody></table></div>`;
const card=(label,value,tone='')=>`<div class="card"><span>${label}</span><strong class="${tone}">${value}</strong></div>`;

const STATUS={failed:'失败',completed:'成功',active:'进行中',interrupted:'中断'};
const outcome=row=>row.failed?['失败'+(row.http_status?' '+row.http_status:''),'bad']:row.outcome==='active'?['进行中','warn']:row.outcome==='interrupted'?['中断','muted']:['成功',''];

/**
 * The generation-record page: totals for the chosen range, spend by person and department, and one row per request.
 * @param {object} data Prepared query results and filter state.
 * @returns {string} Page body.
 */
export function recordsBody({base,range,ranges,totals,filters,options,rows,next,people,departments,nameOf,departmentOf,exportedAt,priceVersion,query}){
 const tabs=ranges.map(item=>`<a href="${escape(base+'/records?'+query({range:item.id,before:null}))}"${item.id===range?' aria-current="page"':''}>${item.label}</a>`).join('');
 const select=(name,label,values,current)=>`<select name="${name}" aria-label="${label}"><option value="">${label}</option>${values.map(([value,text])=>`<option value="${escape(value)}"${value===current?' selected':''}>${escape(text)}</option>`).join('')}</select>`;
 const form=`<form method="get" action="${escape(base+'/records')}"><input type="hidden" name="range" value="${escape(range)}">
${select('department','全部部门',options.departments,filters.department)}${select('account','全部人',options.accounts,filters.account)}${select('provider','全部线路',options.providers.map(value=>[value,value]),filters.provider)}${select('model','全部模型',options.models.map(value=>[value,value]),filters.model)}${select('status','全部状态',Object.entries(STATUS),filters.status)}<button type="submit">筛选</button>
<a class="more" href="${escape(base+'/records.csv?'+query({before:null}))}">导出</a></form>`;
 const spend=(items,label)=>table([label,'调用','失败','估算花费'],items.slice(0,20).map(item=>`<tr><td>${escape(item.label)}</td><td class="n">${number(item.requests)}</td><td class="n${item.failed?' bad':''}">${number(item.failed)}</td><td class="n">${yuan(item.yuan)}</td></tr>`));
 const lines=rows.map(row=>{const [label,tone]=outcome(row);return `<tr><td>${time(row.started_at)}</td><td>${escape(nameOf(row.account_id))}</td><td>${escape(departmentOf(row.account_id))}</td><td>${escape(row.model)}</td><td>${escape(row.provider)}</td><td class="${tone}">${escape(label)}</td><td class="n">${number(row.input_tokens)}</td><td class="n">${number(row.cache_read_tokens)}</td><td class="n">${number(row.output_tokens)}</td><td class="n">${seconds(row.finished_at?row.finished_at-row.started_at:null)}</td><td class="n">${yuan(row.cost)}</td></tr>`;});
 return `<div class="tabs">${tabs}</div>
<div class="cards" style="margin-top:12px">${card('调用',number(totals.requests))}${card('人数',number(totals.people))}${card('失败',number(totals.failed),totals.failed?'bad':'')}${card('进行中',number(totals.active))}${card(totals.cost.unpricedRequests?`估算花费 · ${number(totals.cost.unpricedRequests)} 次未定价`:'估算花费',yuan(totals.cost.yuan))}</div>
${form}
<h2>按人</h2>${spend(people,'人')}
<h2>按部门</h2>${spend(departments,'部门')}
<h2>每一次调用</h2>${table(['时间','人','部门','模型','线路','状态','输入','缓存命中','输出','耗时','估算'],lines)}
${next?`<a class="more" href="${escape(base+'/records?'+query({before:next.startedAt+'.'+next.id}))}">更早</a>`:''}
<p class="muted">价目 ${escape(priceVersion)} · 数据更新于 ${time(exportedAt)}</p>`;
}

const SERVICE_STATE={running:['运行中','good'],failed:['已停止（失败）','bad'],inactive:['已停止','bad'],activating:['启动中','warn'],deactivating:['停止中','warn'],unknown:['读不到','muted']};

/**
 * The service page: own services and model routes over the last 24 hours.
 * @param {{services:object[],routes:object[]}} data Service states and route statistics.
 * @returns {string} Page body.
 */
export function servicesBody({services,routes}){
 const serviceRows=services.map(item=>{const [label,tone]=SERVICE_STATE[item.state]??[item.state,'warn'];return `<tr><td>${escape(item.name)}</td><td class="${tone}">${escape(label)}</td><td>${escape(item.since??'—')}</td><td>${escape(item.version??'—')}</td><td class="n">${number(item.restarts)}</td></tr>`;});
 const routeRows=routes.map(route=>{const rate=route.requests?route.failed/route.requests:0;return `<tr><td>${escape(route.provider)}</td><td class="n">${number(route.requests)}</td><td class="n">${number(route.people)}</td><td class="n ${rate>0.05?'bad':rate>0.01?'warn':''}">${percent(route.failed,route.requests)}</td><td class="n">${seconds(route.averageMs)}</td></tr>`;});
 return `<h2>服务</h2>${table(['服务','状态','启动于','版本','重启次数'],serviceRows)}
<h2>模型线路 · 最近 24 小时</h2>${table(['线路','调用','人数','失败率','平均耗时'],routeRows)}`;
}

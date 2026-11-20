/**
 * Server-rendered console pages in the console design's look (left navigation, cards, rows).
 * Every dynamic value passes through `escape`; pages carry no script, and dark mode follows the system setting.
 */

export const escape=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const number=value=>value===null||value===undefined?'—':Number(value).toLocaleString('zh-CN');
const yuan=value=>value===null||value===undefined?'—':'¥'+(value>0&&value<1?value.toFixed(4):value.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2}));
const time=ms=>ms?new Date(ms).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}):'—';
const clock=ms=>ms?new Date(ms).toLocaleTimeString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false}):'—';
const day=ms=>new Date(ms).toLocaleDateString('zh-CN',{timeZone:'Asia/Shanghai',month:'numeric',day:'numeric'});
const seconds=ms=>ms===null||ms===undefined?'—':(ms/1000).toFixed(1)+' 秒';
const percent=(part,whole)=>whole?(100*part/whole).toFixed(part/whole<0.01&&part>0?2:1)+'%':'—';
const PALETTE=['#4d6bfe','#e8770e','#16a36a','#8a63d2','#d6457a','#0e9aa7','#6b6b6b'];
const tint=key=>{let hash=0;for(const char of String(key))hash=(hash*31+char.codePointAt(0))>>>0;return PALETTE[hash%PALETTE.length];};
const initial=name=>[...String(name||'?').replace(/^账号 /,'')][0]??'?';

const STYLE=`:root{--ink:#141414;--ink2:rgba(20,20,20,.62);--main:#fcfcfc;--side:#f7f7f7;--card:#fff;--line:rgba(20,20,20,.08);--line2:rgba(20,20,20,.15);--hover:rgba(119,119,119,.09);--active:rgba(119,119,119,.17);--accent:#4d6bfe;--soft:rgba(77,107,254,.14);--danger:#d61f33;--green:#00a35a;--amber:#b46d00;--tag:rgba(20,20,20,.06);--rim:rgba(20,20,20,.09);--shadow:0 1px 2px rgba(20,20,20,.03),inset 0 1px 0 rgba(255,255,255,.65);--thumb:#fff;--thumb-shadow:0 1px 2px rgba(20,20,20,.06),inset 0 .5px 0 rgba(255,255,255,.8)}
@media (prefers-color-scheme:dark){:root{--ink:#f2f2f2;--ink2:rgba(242,242,242,.62);--main:#141414;--side:#1b1b1b;--card:#1f1f1f;--line:rgba(255,255,255,.08);--line2:rgba(255,255,255,.15);--hover:rgba(160,160,160,.12);--active:rgba(160,160,160,.2);--accent:#6e8bff;--soft:rgba(91,123,255,.2);--danger:#ff6b78;--green:#2fcf86;--amber:#f0b84a;--tag:rgba(255,255,255,.09);--rim:rgba(255,255,255,.11);--shadow:0 1px 3px rgba(0,0,0,.22),inset 0 .5px 0 rgba(255,255,255,.07);--thumb:#2a2a2a;--thumb-shadow:0 1px 3px rgba(0,0,0,.28),inset 0 .5px 0 rgba(255,255,255,.12)}}
*{box-sizing:border-box}
body{margin:0;background:var(--main);color:var(--ink);font:13px/18px -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;-webkit-font-smoothing:antialiased}
a{color:inherit}:focus-visible{outline:2px solid var(--accent);outline-offset:-2px}
.app{min-height:100vh;display:flex;flex-wrap:wrap;align-items:stretch}
.side{flex:1 1 232px;max-width:232px;padding:14px 10px 12px;background:var(--side);border-right:.5px solid var(--line);display:flex;flex-direction:column;gap:14px}
.brand{display:flex;align-items:center;gap:8px;height:36px;padding:0 8px;font-size:15px;font-weight:600}
.logo{flex:none;width:22px;height:22px;border-radius:7px;background:var(--ink);color:var(--main);display:inline-flex;align-items:center;justify-content:center;font-size:12px;font-weight:700}
.nav{display:flex;flex-direction:column;gap:2px}
.nav a{display:flex;align-items:center;gap:10px;min-height:40px;padding:0 10px;border-radius:10px;color:var(--ink2);text-decoration:none;font-weight:450;white-space:nowrap}
.nav a:hover{background:var(--hover);color:var(--ink)}
.nav a[aria-current=page]{background:var(--thumb);box-shadow:var(--thumb-shadow);color:var(--ink);font-weight:500}
.nav a[aria-current=page] svg{color:var(--accent)}
.nav hr{width:100%;border:0;border-top:.5px solid var(--line);margin:6px 0}
.foot{margin-top:auto;display:flex;align-items:center;gap:6px}
.cap{display:inline-flex;align-items:center;gap:8px;height:36px;padding:0 12px 0 4px;border-radius:999px;background:var(--hover);font-weight:500;min-width:0;max-width:100%}
.cap b{font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.av{flex:none;width:28px;height:28px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;color:#fff;font-size:12px;font-weight:600}
.av.sq{border-radius:9px;width:32px;height:32px}
.main{flex:999 1 560px;min-width:0;padding:22px 32px 40px;display:flex;flex-direction:column;gap:16px}
.head{display:flex;align-items:center;gap:10px;flex-wrap:wrap;min-height:36px}
h1{margin:0;font-size:20px;line-height:28px;font-weight:600}
.tag{font-size:12px;line-height:16px;padding:1px 6px;border-radius:4px;background:var(--tag);color:var(--ink2);white-space:nowrap}
.sp{flex:1}
.seg{display:inline-flex;gap:2px;padding:3px;border-radius:999px;background:var(--hover);flex-wrap:wrap}
.seg a{display:inline-flex;align-items:center;height:28px;padding:0 12px;border-radius:999px;color:var(--ink2);font-size:12px;text-decoration:none;white-space:nowrap}
.seg a[aria-current=page]{background:var(--thumb);box-shadow:var(--thumb-shadow);color:var(--ink);font-weight:500}
.btn{display:inline-flex;align-items:center;gap:6px;height:34px;padding:0 14px;border-radius:999px;border:0;background:var(--hover);color:var(--ink);font:inherit;font-weight:500;cursor:pointer;text-decoration:none;white-space:nowrap}
.btn:hover{background:var(--active)}
.stats{display:grid;grid-template-columns:1.6fr 1fr 1fr 1fr;gap:1px;background:var(--line);border:1px solid var(--line);border-radius:16px;overflow:hidden}
.stat{display:flex;flex-direction:column;justify-content:flex-end;gap:6px;padding:16px 18px;min-width:0;background:var(--card);text-decoration:none;color:inherit}
a.stat:hover{background:color-mix(in srgb,var(--card) 92%,var(--ink))}
.sl{font-size:12px;line-height:16px;color:var(--ink2)}
.sv{font-size:22px;line-height:28px;font-weight:600;letter-spacing:-.01em;font-variant-numeric:tabular-nums;white-space:nowrap}
.sv.big{font-size:34px;line-height:40px;letter-spacing:-.025em}
.sv.bad{color:var(--danger)}
.bar{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.bar form{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
select{height:34px;padding:0 10px;border-radius:10px;border:.5px solid var(--line2);background:var(--card);color:var(--ink);font:inherit;max-width:220px}
.card{border:.5px solid var(--rim);border-radius:12px;background:var(--card);box-shadow:var(--shadow)}
.tw{overflow-x:auto;border-radius:12px}
.row{display:grid;gap:16px;align-items:center;padding:8px 16px;min-height:58px;border-top:.5px solid var(--line)}
.row.th{min-height:38px;font-size:12px;color:var(--ink2);border-top:0}
.rec{grid-template-columns:76px minmax(150px,1fr) minmax(210px,1.6fr) minmax(180px,1.2fr) 70px 90px 16px;min-width:960px}
.svc{grid-template-columns:16px minmax(180px,1.4fr) minmax(200px,1.4fr) 90px minmax(160px,1fr);min-width:760px}
.rt{grid-template-columns:16px minmax(180px,1.4fr) 110px 90px 90px 100px;min-width:640px}
.tm{font-variant-numeric:tabular-nums;color:var(--ink2)}
.two{display:flex;flex-direction:column;gap:2px;min-width:0}
.two b{font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.two span{font-size:12px;color:var(--ink2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.two span.err{color:var(--danger)}
.who{display:flex;align-items:center;gap:10px;min-width:0}
.l1{display:flex;align-items:center;gap:6px;min-width:0}
.num{text-align:right;font-variant-numeric:tabular-nums;font-weight:500}
.num.off{color:var(--ink2);font-weight:400}.num.bad{color:var(--danger)}.num.warn{color:var(--amber)}
.mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;color:var(--ink2)}
.dot{display:block;width:8px;height:8px;border-radius:50%;justify-self:center}
.dot.ok{background:var(--green)}.dot.bad{background:var(--danger)}.dot.warn{background:var(--amber)}.dot.off{background:var(--line2)}
.dot.run{background:var(--accent);box-shadow:0 0 0 4px var(--soft)}
.more{display:flex;justify-content:center;padding:10px;border-top:.5px solid var(--line)}
.note{font-size:12px;color:var(--ink2);margin:0}
.st{font-size:12px;color:var(--ink2);margin:0 0 6px 2px}
.chart{padding:16px 18px 12px;display:flex;flex-direction:column;gap:8px}
.plot{display:grid;grid-template-columns:64px minmax(0,1fr);column-gap:8px}
.yax{position:relative;height:168px}.yax span{position:absolute;right:0;transform:translateY(50%);font-size:11px;color:var(--ink2);font-variant-numeric:tabular-nums}
.area{position:relative;height:168px}.grid{position:absolute;left:0;right:0;height:0;border-top:1px dashed var(--line)}.grid.base{border-top:1px solid var(--line2)}
.bars{position:absolute;inset:0;display:flex;align-items:stretch;gap:4px}
.col{flex:1;min-width:4px;display:flex;align-items:flex-end;justify-content:center}
.bv{display:block;width:72%;max-width:22px;border-radius:4px 4px 0 0;background:var(--accent)}
.col:hover .bv{opacity:.75}
.xax{display:flex;gap:4px;margin-left:72px}.xax span{flex:1;min-width:4px;text-align:center;font-size:11px;color:var(--ink2);white-space:nowrap;font-variant-numeric:tabular-nums}
.bh{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:14px 16px 6px}
.rows{display:flex;flex-direction:column;padding:0 8px 8px}
.line{display:flex;align-items:center;gap:12px;padding:10px 8px;border-radius:12px}
.line:hover{background:var(--hover)}
.rbody{flex:1;min-width:0;display:flex;flex-direction:column;gap:7px}
.rline{display:flex;align-items:baseline;gap:8px;min-width:0}
.rline b{font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.rline span{font-size:12px;color:var(--ink2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.track{display:block;height:4px;border-radius:999px;background:var(--hover);overflow:hidden}.track i{display:block;height:100%;border-radius:999px;background:var(--accent)}
.rnum{flex:none;display:flex;flex-direction:column;align-items:flex-end;gap:1px;min-width:96px;font-variant-numeric:tabular-nums}
.rnum b{font-weight:500}.rnum span{font-size:12px;color:var(--ink2)}
.msg{max-width:440px;margin:15vh auto 0;padding:28px;display:flex;flex-direction:column;gap:12px}
.msg h1{font-size:18px}
@media (max-width:760px){.side{max-width:none;flex-basis:100%;border-right:0;border-bottom:.5px solid var(--line);flex-direction:row;align-items:center;gap:8px;padding:10px 12px}.nav{flex-direction:row;overflow-x:auto}.nav hr{display:none}.foot{display:none}.main{padding:16px}.stats{grid-template-columns:1fr 1fr}.stat:first-child{grid-column:1 / -1}}`;

const icon=path=>`<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`;
const ICONS={
 records:'<path d="M6 4h7.5M6 8h7.5M6 12h7.5M2.5 4h.01M2.5 8h.01M2.5 12h.01"></path>',
 tasks:'<circle cx="8" cy="8" r="5.8"></circle><path d="M8 4.8V8l2.2 1.6"></path>',
 spend:'<path d="M2 13.5h12M4 13.5V9M8 13.5V3.5M12 13.5V6.5"></path>',
 services:'<rect x="2" y="2.5" width="12" height="4.5" rx="1.3"></rect><rect x="2" y="9" width="12" height="4.5" rx="1.3"></rect><path d="M4.6 4.75h.01M4.6 11.25h.01"></path>',
 accounts:'<circle cx="8" cy="5.5" r="2.6"></circle><path d="M3 13.5c.6-2.6 2.6-4 5-4s4.4 1.4 5 4"></path>',
 usage:'<path d="M2.5 11.5a5.5 5.5 0 1 1 11 0"></path><path d="M8 11.5l2.6-3.4"></path>',
 feedback:'<path d="M3 3.5h10a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H7l-3 2.5v-2.5H3a1 1 0 0 1-1-1v-6a1 1 0 0 1 1-1z"></path>',
 download:'<path d="M8 2.5v8M4.5 7 8 10.5 11.5 7M3 13.5h10"></path>',
};

/**
 * Wrap a page body in the console shell: navigation to the console's own pages and to existing site pages.
 * @param {{base:string,active:'records'|'spend'|'services',viewer:{id?:string,name:string},title:string,body:string}} page Page parts.
 * @returns {string} Complete HTML document.
 */
export function layout({base,active,viewer,title,body}){
 const link=(id,href,label)=>`<a href="${escape(href)}"${active===id?' aria-current="page"':''}>${icon(ICONS[id])}${label}</a>`;
 return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><title>${escape(title)} · Muse 云端</title><style>${STYLE}</style></head>
<body><div class="app"><nav class="side" aria-label="控制台"><div class="brand"><span class="logo" aria-hidden="true">M</span><span>Muse 云端</span></div>
<div class="nav">${link('records',base+'/records','生成记录')}${link('tasks','/workbench','任务')}${link('spend',base+'/spend','花费')}${link('services',base+'/services','服务')}<hr>${link('accounts','/admin','账号')}${link('usage','/admin/usage','用量')}${link('feedback','/feedback','意见')}</div>
<div class="foot"><span class="cap"><span class="av" style="background:${tint(viewer.id??viewer.name)}" aria-hidden="true">${escape(initial(viewer.name))}</span><b>${escape(viewer.name)}</b><span class="tag">管理员</span></span></div></nav>
<main class="main">${body}</main></div></body></html>`;
}

/**
 * A full-page message such as sign-in required or forbidden.
 * @param {{title:string,text:string,href?:string,label?:string}} message Message parts.
 * @returns {string} Complete HTML document.
 */
export function messagePage({title,text,href,label}){
 return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><title>${escape(title)}</title><style>${STYLE}</style></head>
<body><div class="card msg"><h1>${escape(title)}</h1>${text?`<p class="note" style="font-size:13px">${escape(text)}</p>`:''}${href?`<p style="margin:0"><a class="btn" href="${escape(href)}">${escape(label)}</a></p>`:''}</div></body></html>`;
}

const seg=(items,label)=>`<div class="seg" role="group" aria-label="${label}">${items.map(item=>`<a href="${escape(item.href)}"${item.on?' aria-current="page"':''}>${item.label}</a>`).join('')}</div>`;
const outcome=row=>row.failed?['bad','失败'+(row.http_status?' '+row.http_status:'')]:row.outcome==='active'?['run','进行中']:row.outcome==='interrupted'?['off','中断']:['ok','成功'];

/**
 * The generation-record page: totals for the chosen range, filters and one row per model request.
 * @param {object} data Prepared query results, filter state and link builders.
 * @returns {string} Page body.
 */
export function recordsBody({base,range,ranges,totals,filters,options,rows,next,nameOf,departmentOf,exportedAt,priceVersion,query}){
 const select=(name,label,values,current)=>`<label><span hidden>${label}</span><select name="${name}" aria-label="${label}"><option value="">${label}</option>${values.map(([value,text])=>`<option value="${escape(value)}"${value===current?' selected':''}>${escape(text)}</option>`).join('')}</select></label>`;
 const link=changes=>base+'/records?'+query({before:null,...changes});
 const cost=totals.cost.unpricedRequests?`估算花费 · ${number(totals.cost.unpricedRequests)} 次未定价`:'估算花费';
 const lines=rows.map(row=>{
  const [state,label]=outcome(row),name=nameOf(row.account_id);
  const hit=row.input_tokens?Math.round(100*Number(row.cache_read_tokens??0)/Number(row.input_tokens))+'%':'—';
  return `<div class="row rec"><span class="tm">${clock(row.started_at)}</span>
<span class="who"><span class="av" style="background:${tint(row.account_id)}" aria-hidden="true">${escape(initial(name))}</span><span class="two"><b>${escape(name)}</b><span>${escape(departmentOf(row.account_id))}</span></span></span>
<span class="two"><span class="l1"><span class="tag">${escape(row.provider)}</span><b>${escape(row.model)}</b></span><span${row.failed?' class="err"':''}>${row.failed?escape(label):escape(time(row.started_at))}</span></span>
<span class="two"><b class="mono" style="color:var(--ink)">输入 ${number(row.input_tokens)} · 输出 ${number(row.output_tokens)}</b><span>缓存命中 ${hit}</span></span>
<span class="num off">${seconds(row.finished_at?row.finished_at-row.started_at:null)}</span>
<span class="num${row.cost?'':' off'}">${yuan(row.cost)}</span>
<span class="dot ${state}" role="img" aria-label="${escape(label)}"></span></div>`;
 });
 return `<div class="head"><h1>生成记录</h1><span class="sp"></span>${seg(ranges.map(item=>({label:item.label,on:item.id===range,href:link({range:item.id})})),'时间')}
<a class="btn" href="${escape(base+'/records.csv?'+query({before:null}))}">${icon(ICONS.download)}导出</a></div>
<div class="stats"><a class="stat" href="${escape(base+'/spend?range='+(range==='today'?'7d':range))}"><span class="sl">${cost}</span><span class="sv big">${yuan(totals.cost.yuan)}</span></a>
<a class="stat" href="${escape(link({status:''}))}"><span class="sl">调用 · ${number(totals.people)} 人</span><span class="sv">${number(totals.requests)}</span></a>
<a class="stat" href="${escape(link({status:'failed'}))}"><span class="sl">失败</span><span class="sv${totals.failed?' bad':''}">${number(totals.failed)}</span></a>
<a class="stat" href="${escape(link({status:'active'}))}"><span class="sl">进行中</span><span class="sv">${number(totals.active)}</span></a></div>
<div class="bar">${seg([['','全部'],['failed','失败'],['active','进行中']].map(([id,label])=>({label,on:filters.status===id,href:link({status:id})})),'状态')}
<form method="get" action="${escape(base+'/records')}"><input type="hidden" name="range" value="${escape(range)}"><input type="hidden" name="status" value="${escape(filters.status)}">
${select('department','部门',options.departments,filters.department)}${select('account','人',options.accounts,filters.account)}${select('provider','线路',options.providers.map(value=>[value,value]),filters.provider)}${select('model','模型',options.models.map(value=>[value,value]),filters.model)}<button class="btn" type="submit">筛选</button></form></div>
<div class="card"><div class="tw"><div class="row rec th"><span>时间</span><span>人</span><span>模型</span><span>用量</span><span style="text-align:right">耗时</span><span style="text-align:right">花费</span><span></span></div>
${lines.length?lines.join(''):'<div class="row" style="grid-template-columns:1fr"><span class="note">没有记录</span></div>'}</div>
${next?`<div class="more"><a class="btn" href="${escape(base+'/records?'+query({before:next.startedAt+'.'+next.id}))}">更早</a></div>`:''}</div>
<p class="note">价目 ${escape(priceVersion)} · 数据更新于 ${escape(time(exportedAt))}</p>`;
}

/**
 * The spend page: totals, one bar per day and a ranking by department, person or model.
 * @param {object} data Prepared totals, daily series, ranking rows and link builders.
 * @returns {string} Page body.
 */
export function spendBody({base,range,ranges,group,totals,series,ranking,priceVersion}){
 const max=Math.max(...series.map(item=>item.yuan),0);
 const top=max>0?(()=>{const step=10**Math.floor(Math.log10(max));return Math.ceil(max/step)*step;})():1;
 const n=series.length;
 const bars=series.map((item,index)=>{const label=day(item.dayStart)+' '+yuan(item.yuan)+' · '+number(item.requests)+' 次';
  return `<span class="col" title="${escape(label)}" role="img" aria-label="${escape(label)}"><span class="bv" style="height:${(item.yuan/top*100).toFixed(1)}%"></span></span>`;}).join('');
 const xs=series.map((item,index)=>`<span>${index%7===0||index===n-1?escape(day(item.dayStart)):''}</span>`).join('');
 const lead=ranking[0]?.yuan||0,sum=ranking.reduce((total,item)=>total+item.yuan,0);
 const lines=ranking.slice(0,30).map(item=>`<div class="line"><span class="av${group==='model'?' sq':''}" style="background:${tint(item.key)}" aria-hidden="true">${escape(initial(item.label))}</span>
<span class="rbody"><span class="rline"><b>${escape(item.label)}</b><span>${escape(item.sub)}</span></span><span class="track"><i style="width:${lead?(100*item.yuan/lead).toFixed(1):0}%"></i></span></span>
<span class="rnum"><b>${yuan(item.yuan)}</b><span>${number(item.requests)} 次 · ${percent(item.yuan,sum)}</span></span></div>`);
 return `<div class="head"><h1>花费</h1><span class="sp"></span>${seg(ranges.map(item=>({label:item.label,on:item.id===range,href:base+'/spend?range='+item.id+'&group='+group})),'时间')}</div>
<div class="stats"><div class="stat"><span class="sl">估算花费</span><span class="sv big">${yuan(totals.cost.yuan)}</span></div>
<div class="stat"><span class="sl">调用</span><span class="sv">${number(totals.requests)}</span></div>
<div class="stat"><span class="sl">人数</span><span class="sv">${number(totals.people)}</span></div>
<div class="stat"><span class="sl">未定价调用</span><span class="sv">${number(totals.cost.unpricedRequests)}</span></div></div>
<div class="card chart"><div class="plot"><div class="yax" aria-hidden="true"><span style="bottom:0%">¥0</span><span style="bottom:50%">${escape(yuan(top/2).replace(/\.00$/,''))}</span><span style="bottom:100%">${escape(yuan(top).replace(/\.00$/,''))}</span></div>
<div class="area"><span class="grid base" style="bottom:0%"></span><span class="grid" style="bottom:50%"></span><span class="grid" style="bottom:100%"></span><div class="bars">${bars}</div></div></div>
<div class="xax" aria-hidden="true">${xs}</div></div>
<div class="card"><div class="bh">${seg([['department','按部门'],['person','按人'],['model','按模型']].map(([id,label])=>({label,on:group===id,href:base+'/spend?range='+range+'&group='+id})),'分组')}</div>
<div class="rows">${lines.length?lines.join(''):'<p class="note" style="padding:10px 8px">没有记录</p>'}</div></div>
<p class="note">估算只含语言模型；视频、图片、配音接上镜流后再加。价目 ${escape(priceVersion)}</p>`;
}

const SERVICE_STATE={running:['ok','运行中'],failed:['bad','已停止（失败）'],inactive:['bad','已停止'],activating:['warn','启动中'],deactivating:['warn','停止中'],reloading:['warn','重新加载'],unknown:['off','读不到']};

/**
 * The service page: own services and model routes over the last 24 hours.
 * @param {{services:object[],routes:object[]}} data Service states and route statistics.
 * @returns {string} Page body.
 */
export function servicesBody({services,routes}){
 const serviceRows=services.map(item=>{const [state,label]=SERVICE_STATE[item.state]??['warn',item.state];return `<div class="row svc"><span class="dot ${state}" role="img" aria-label="${escape(label)}"></span><span class="two"><b>${escape(item.name)}</b><span>${escape(label)}${item.restarts?' · 重启 '+number(item.restarts)+' 次':''}</span></span><span class="tm">${escape(item.since??'—')}</span><span class="num off">${number(item.restarts)}</span><span class="mono" style="text-align:right;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escape(item.version??'—')}</span></div>`;});
 const routeRows=routes.map(route=>{const rate=route.requests?route.failed/route.requests:0,state=rate>0.05?'bad':rate>0.01?'warn':'ok';return `<div class="row rt"><span class="dot ${state}" role="img" aria-label="失败率 ${percent(route.failed,route.requests)}"></span><span class="two"><b>${escape(route.provider)}</b><span>${number(route.people)} 人在用</span></span><span class="num">${number(route.requests)}</span><span class="num ${state==='ok'?'':state}">${percent(route.failed,route.requests)}</span><span class="num off">${number(route.failed)}</span><span class="num off">${seconds(route.averageMs)}</span></div>`;});
 const empty='<div class="row" style="grid-template-columns:1fr"><span class="note">没有记录</span></div>';
 return `<div class="head"><h1>服务</h1></div>
<div><p class="st">我们的服务</p><div class="card"><div class="tw"><div class="row svc th"><span></span><span>服务</span><span>启动于</span><span style="text-align:right">重启</span><span style="text-align:right">版本</span></div>${serviceRows.length?serviceRows.join(''):empty}</div></div></div>
<div><p class="st">模型线路 · 最近 24 小时</p><div class="card"><div class="tw"><div class="row rt th"><span></span><span>线路</span><span style="text-align:right">调用</span><span style="text-align:right">失败率</span><span style="text-align:right">失败</span><span style="text-align:right">平均耗时</span></div>${routeRows.length?routeRows.join(''):empty}</div></div></div>`;
}

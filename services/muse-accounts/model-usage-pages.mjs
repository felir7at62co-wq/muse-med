/** Escaped administrator-only model token reporting, rendered without scripts or supplier access. */

/** Render a provider-reported usage summary, with missing reports distinct from zero and without estimated billing.
 * @param {object} options Validated summary, public account labels, HTML escaping and existing page renderer.
 * @returns {string} Complete read-only administrator document.
 */
export function renderModelUsage({summary,accounts,escape,page}){
 const labels=new Map(accounts.map(account=>[account.id,(account.feishuIdentities??[]).map(identity=>identity.name).filter(Boolean).join(' / ')||account.username]));
 const number=value=>value===null?'未回报':Number(value).toLocaleString('zh-CN');
 const token=(row,field)=>`${number(row[field])}<small>${number(row[field+'Reports'])} 次有报告</small>`;
 const metrics=row=>`<td>${number(row.requests)}</td><td>${token(row,'inputTokens')}</td><td>${token(row,'outputTokens')}</td><td>${token(row,'totalTokens')}</td><td>${number(row.unknown)} / ${number(row.partial)}</td>`;
 const table=(title,head,rows,label)=>`<section><h2>${title}</h2><div class="scroll"><table><thead><tr><th>${head}</th><th>请求</th><th>输入 tokens</th><th>输出 tokens</th><th>总 tokens</th><th>未回报 / 部分</th></tr></thead><tbody>${rows.length?rows.map(row=>`<tr><td>${label(row)}</td>${metrics(row)}</tr>`).join(''):'<tr><td colspan="6">此范围暂无已记录请求</td></tr>'}</tbody></table></div></section>`;
 const option=(value,label)=>`<option value="${escape(value)}"${summary.filters.accountId===value?' selected':''}>${escape(label)}</option>`;
 const total=summary.totals;
 const providers={'deepseek-official':'DeepSeek 统一线路','volcengine-ark':'火山引擎 · GLM（历史）','zhipu-official':'智谱官方（历史）'};
 const models={'deepseek-flash':'DeepSeek Flash（官方）','deepseek-v4-1-flash-261017':'DeepSeek V4.1 Flash（火山历史）','deepseek-v4.1-flash-261017':'DeepSeek V4.1 Flash','glm-5-3-flash-260828':'GLM 5.3 Flash（历史）','glm-5.3-flashx':'GLM 5.3 FlashX（历史）'};
 const suggestions=(rows,field,labels)=>[...new Set(rows.map(row=>row[field]).filter(value=>typeof value==='string'&&value))].sort().map(value=>`<option value="${escape(value)}">${escape(labels[value]??value)}</option>`).join('');
 const since=Date.parse(summary.recordingSince);
 const recordedSince=Number.isFinite(since)?`<time datetime="${escape(new Date(since).toISOString())}">${escape(new Date(since).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}))}</time>`:'尚未记录';
 return page('模型用量',`
  <div class="eyebrow">MUSE / ADMIN</div><h1>模型用量</h1>
  <p>按实际登录账号统计服务器转发的模型请求。统计始于 ${recordedSince}（北京时间）。不含接入前历史、直连供应商或未经过该网关的调用。</p>
  <form class="usage-filters" action="/admin/usage" method="get"><label>开始日期<input type="date" name="from" value="${escape(summary.filters.from)}" required></label><label>结束日期<input type="date" name="to" value="${escape(summary.filters.to)}" required></label>
  <label>用户<select name="accountId"><option value="">全部用户</option>${accounts.map(account=>option(account.id,labels.get(account.id))).join('')}${summary.filters.accountId&&!labels.has(summary.filters.accountId)?option(summary.filters.accountId,'已移除账号 '+summary.filters.accountId):''}</select></label>
  <label>供应商<input name="provider" list="usage-providers" value="${escape(summary.filters.provider??'')}" maxlength="200" placeholder="全部供应商"><datalist id="usage-providers">${suggestions(summary.models,'provider',providers)}</datalist></label><label>模型<input name="model" list="usage-models" value="${escape(summary.filters.model??'')}" maxlength="200" placeholder="全部模型"><datalist id="usage-models">${suggestions(summary.models,'model',models)}</datalist></label><div class="usage-filter-actions"><button>筛选</button><a class="button button-secondary" href="/admin/usage">重置</a></div></form>
  ${summary.health.writeFailures?'<p class="usage-warning">计量存储发生写入失败，部分请求可能未入账。下列数据不代表完整用量。</p>':''}${summary.limited?'<p class="usage-warning">分组超过展示上限，请缩小日期或添加筛选。</p>':''}
  <div class="usage-grid"><article>模型请求<strong>${number(total.requests)}</strong></article><article>输入 tokens（已回报）<strong>${number(total.inputTokens)}</strong></article><article>输出 tokens（已回报）<strong>${number(total.outputTokens)}</strong></article><article>总 tokens（已回报）<strong>${number(total.totalTokens)}</strong></article><article>完整报告 / 部分报告<strong>${number(total.reported)} / ${number(total.partial)}</strong></article><article>未回报请求<strong>${number(total.unknown)}</strong></article></div>
  <small>每次通过校验并进入供应商转发的 HTTP 请求计一次；模型重试会另计请求，不等于人的任务数。完整报告要求响应正常结束且供应商报告 usage；中断后的已报告数列为部分报告，未报告保持未知，不能当作 0。总数只累加已报告字段，可能低于实际消耗。缓存和推理 tokens 属于输入或输出的细分，不重复叠加。此页不提供费用。共享同一登录账号的云端 Bot 计入该账号。</small>
  <p>完成 ${number(total.completed)} · 失败 ${number(total.failed)} · 中断 ${number(total.interrupted)} · 进行中 ${number(total.active)}</p>
  ${table('按用户','用户',summary.users,row=>`${escape(labels.get(row.accountId)??'已移除账号')}<small>${escape(row.accountId)}</small>`)}
  ${table('按模型','供应商 / 模型',summary.models,row=>`${escape(models[row.model]??row.model)}<small>${escape(row.model)}</small><small>${escape(providers[row.provider]??row.provider)} · ${escape(row.provider)}</small>`)}
  ${table('按日期','日期',summary.days,row=>escape(row.date))}`);
}

/** Account-private usage and archive index mount points; data arrives only through authenticated same-origin reads. */

/**
 * Render usage filters and, on the personal page, the caller's archive index.
 * @param {object} options Administrator-page flag and the owning HTML escape function.
 * @returns {string} An accessible page fragment with external same-origin assets.
 */
export function renderAccountData({admin,escape}) {
 const accountFilter=admin?'<label>账号<select name="accountId" aria-label="统计账号"><option value="">全部账号</option></select></label><button type="button" data-accounts-refresh>刷新账号列表</button>':'';
 return `<link rel="stylesheet" href="/account-data.css"><section class="account-data" data-muse-account-data data-admin="${escape(admin?'true':'false')}" aria-label="${admin?'账号用量统计':'我的用量和云存档'}">
 <section aria-label="模型用量"><h2>${admin?'账号模型用量':'我的模型用量'}</h2><p>仅统计经过 Muse 中转服务的请求。直连、自定义与租用通道未观测；这里不是全部用量或费用账单。</p>
 <form data-usage-filter class="account-data-filters">${accountFilter}<label>起始日期（UTC）<input type="date" name="from" required></label><label>结束日期（UTC）<input type="date" name="to" required></label><button type="submit">查询用量</button></form>
 ${admin?'<p data-accounts-notice role="status"></p>':''}<p data-usage-notice role="status">正在读取用量…</p><p data-usage-health class="account-data-warning" hidden></p><p data-usage-period></p><dl data-usage-summary class="account-data-summary"></dl>
 <div class="scroll"><table><thead><tr><th>请求时间（UTC）</th>${admin?'<th>账号</th>':''}<th>模型 / 通道</th><th>请求状态</th><th>输入 token</th><th>输出 token</th><th>总 token</th><th>用量回报</th><th>HTTP / 失败原因</th></tr></thead><tbody data-usage-items></tbody></table></div>
 <button type="button" data-usage-next hidden>下一页请求</button></section>
 <section aria-label="制作平台用量" data-studio-usage><div class="account-data-heading"><h2>制作平台用量</h2><button type="button" data-studio-refresh>查询制作平台用量</button></div><p>汇总已接入的原生生成、独立配音、视频后期、LibTV API 和 CLI 操作，供应商未回报的 token 保留未知，不与上方中转用量相加。预算预占和用户核销金额分别列出，均不代表经过验证的供应商账单。接入前未记录的历史、免费导入和本地合成不计为付费请求。沿用上方账号和 UTC 日期筛选；持久状态不证明任务仍在运行或供应商已经结束，关联资源数不代表成功成片数。</p>
 <p data-studio-notice role="status">${admin?'请选择具体账号后查看制作平台用量。':'正在读取制作平台用量…'}</p><p data-studio-health class="account-data-warning" hidden></p><p data-studio-period></p><p data-studio-coverage></p><p data-studio-state-summary></p><p data-studio-sources></p><p data-studio-budget></p><dl data-studio-summary class="account-data-summary"></dl>
 <div class="scroll"><table><thead><tr><th>操作时间（UTC）</th><th>操作标识 / 渠道 / 类型</th><th>持久记录状态</th><th>输入 token</th><th>输出 token</th><th>总 token</th><th>供应商回报 / 完整性</th><th>关联图片 / 视频 / 音频 / 任务</th><th>预算金额</th><th>HTTP / 记录状态</th></tr></thead><tbody data-studio-items></tbody></table></div><button type="button" data-studio-next hidden>下一页制作记录</button></section>
 ${admin?'':`<section aria-label="我的会话云存档"><div class="account-data-heading"><h2>我的会话云存档</h2><button type="button" data-archives-refresh>刷新存档</button></div><p>仅显示当前账号已确认云存的索引，不读取或展开对话正文。待同步的本地会话请在 Muse 账号设置中检查。</p><p data-archives-notice role="status">正在读取云存档…</p><div class="scroll"><table><thead><tr><th>会话标识</th><th>设备标识</th><th>已云存时间（UTC）</th><th>事件数</th><th>附件</th><th>版本摘要</th></tr></thead><tbody data-archives-items></tbody></table></div><button type="button" data-archives-next hidden>下一页存档</button></section>`}
 </section><script type="module" src="/account-data-client.js"></script>`;
}

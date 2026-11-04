/** Synthetic SSR metadata with the public page's observed DOM classes; no copyrighted chapter text. */
const escape = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const labels = { hot: '大热榜', new: '新书榜', over: '完结榜', collect: '收藏榜', update: '更新榜' };

export function rankingHtml({ channel = 'boy', board = 'hot', period = 'date', ids = ['101'], heat = '10万 热度', title = '年代样例', activeBoard = board } = {}) {
  return `<!doctype html><html><head><title>七猫公开排行榜</title></head><body>
    <div class="qm-switch-tab"><span class="item active">${channel === 'boy' ? '男生榜' : '女生榜'}</span></div>
    <div class="child-tabs-item active"><a href="/paihang/${channel}/${activeBoard}/${period}/">${labels[activeBoard]}</a></div>
    <div class="date-type-tabs"><a class="tab active">${period === 'date' ? '日榜' : '月榜'}</a></div>
    <ul class="rank-list">${ids.map((id, index) => `<li class="rank-list-item"><span class="rank-number">${index + 1}</span>
      <a class="s-book-title" href="https://www.qimao.com/shuku/${id}/">${escape(title)}${index || ''}</a>
      <span class="s-book-info"><a href="https://www.qimao.com/zuozhe/test/">样例作者</a><a href="https://www.qimao.com/shuku/a-1-2-a-a-a-a-click-1/">年代</a><em>连载中</em><em>20万字</em></span>
      <span class="s-book-intro">公开简介</span><span class="s-book-update">2026-11-04 12:00:00</span><div class="other-info">${escape(heat)}</div>
    </li>`).join('')}</ul><script>globalThis.qimaoPageExecuted = true;</script></body></html>`;
}

export function libraryHtml({ page = 1, maxPage = 3, ids = ['201'], title = '3天内更新-30万以下-连载中-七猫', sort = '按点击量' } = {}) {
  return `<!doctype html><html><head><title>${escape(title)}</title></head><body><div class="tab-inner active">${escape(sort)}</div>
    <ul>${ids.map(id => `<li class="qm-cover-text-item"><span class="s-tit"><a href="https://www.qimao.com/shuku/${id}/">书库样例</a></span>
      <a class="s-category">年代</a><em class="s-status">连载中</em><em class="s-words-num">12.3万字</em><span class="s-desc">书库简介</span>
      <a class="s-author">书库作者</a><em class="s-update-time">2026-11-04更新</em></li>`).join('')}</ul>
    <div class="qm-page"><span class="page-btn num active">${page}</span><span class="page-btn num">${maxPage}</span></div></body></html>`;
}

export function detailHtml({ id = '101', title = '年代样例', popularity = '8.2万累计人气值', reads = '5.1万次阅读' } = {}) {
  return `<!doctype html><html><head><title>七猫书籍详情</title></head><body>
    <div class="book-information"><div class="title"><span class="txt">${escape(title)}</span></div>
      <div class="tags-wrap"><em>连载中</em><a href="https://www.qimao.com/shuku/a-1-2-a-a-a-a-click-1/">年代</a></div>
      <div class="statistics"><span>20万字</span><span>${escape(popularity)}</span><span>${escape(reads)}</span></div>
      <span class="update-chapter-title"><a href="https://www.qimao.com/shuku/${id}-987/">章节标题</a></span><span class="update-time">2026-11-04 12:00:00</span>
    </div><div class="author-information"><div class="author-name"><a href="https://www.qimao.com/zuozhe/test/">样例作者</a></div></div>
    <div class="book-introduction"><p class="intro">公开简介</p></div><div class="chapter-body">NEVER_RETURN_CHAPTER_BODY</div>
    <script>window.__NUXT__ = (function(){throw new Error('NEVER_EXECUTE_PAGE_SCRIPT')})()</script></body></html>`;
}

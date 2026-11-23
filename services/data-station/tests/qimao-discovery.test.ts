import { describe, expect, it, vi } from 'vitest';
import { createQimaoDiscovery } from '../src/server/discovery/qimao.ts';
import { metadataUrl, readMetadata } from '../src/server/collectors/qimao/transport.js';
import type { DiscoveryTask } from '../src/server/discovery/crawler.ts';

const ORIGIN = 'https://www.qimao.com';
const observedAt = '2026-11-13T11:00:00.000Z';
const cycle = '21600000:100';
const signal = () => new AbortController().signal;
const categories = [
  { id: 'a', name: '全部', type: 'category', children: [] },
  { id: '202', name: '玄幻奇幻', type: '0', children: [{ id: '37', name: '东方玄幻', type: '0' }, { id: '39', name: '异世大陆', type: '0' }] },
  { id: '1', name: '现代言情', type: '1', children: [{ id: '8', name: '总裁豪门', type: '1' }] },
  { id: '240', name: '文学艺术', type: '2', children: [{ id: '247', name: '人物传记', type: '2' }] },
];

function row(id = '9000000000000001234_0', index = 1, parent = '202', category = '37', categoryName = '东方玄幻') {
  return { index: String(index), book_id: id, read_url: `${ORIGIN}/shuku/${id}/`, title: `公开小说 ${id}`,
    author: '来源作者', category2_name: categoryName, category_url: `${ORIGIN}/shuku/a-${parent}-${category}-a-a-a-a-click-1/`,
    is_over_txt: '完结', words_num: '12.34万字', intro: '公开简介，不包含章节正文',
    image_link: 'https://cdn.qimao.com/bookimg/public/sample.jpg', update_time: '2026-11-12更新',
    update_time_txt: '2026-11-12 08:09:10' };
}

interface FixtureOptions {
  page?: number; total?: number; order?: 'click' | 'update_time'; parent?: string; category?: string;
  rows?: ReturnType<typeof row>[]; tree?: typeof categories; changes?: Record<string, unknown>;
  domRows?: ReturnType<typeof row>[]; activePage?: number; nextDisabled?: boolean; mutateScript?: (script: string) => string;
}

function escape(value: string): string { return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;'); }
function fixture({ page = 1, total = 16, order = 'click', parent = 'a', category = 'a', tree = categories,
  rows = Array.from({ length: Math.min(15, Math.max(0, total - (page - 1) * 15)) }, (_, index) => row(`${9000000 + (page - 1) * 15 + index}_0`, (page - 1) * 15 + index + 1,
    parent === 'a' ? '202' : parent, category === 'a' ? '37' : category,
    tree.find(item => item.id === parent)?.children.find(item => item.id === category)?.name ?? '东方玄幻')),
  changes = {}, domRows = rows, activePage = page, nextDisabled = page >= Math.ceil(total / 15), mutateScript = value => value,
}: FixtureOptions = {}): string {
  const data = { categoryFormData: { channel: 'a', category1: parent, category2: category, words: 'a', update_time: 'a',
    is_vip: 'a', is_over: 'a', order, page: String(page) }, categoryList: tree, bookList: rows,
    pageConfig: { count: String(total), page: String(page), page_size: '15' }, ...changes };
  const script = `window.__NUXT__=(function(a,b){return {fetch:{library:${JSON.stringify(data)}},extra:[a,b]};}("literal alias",-1));`;
  return `<!doctype html><title>七猫官方公开书库</title><ul>${domRows.map(item => `<li class="qm-cover-text-item">
    <span class="s-tit"><a href="${escape(item.read_url)}">${escape(item.title)}</a></span>
    <a class="s-author">${escape(item.author)}</a><a class="s-category" href="${escape(item.category_url)}">${escape(item.category2_name)}</a>
    <em class="s-status">${item.is_over_txt}</em><em class="s-words-num">${item.words_num}</em>
    <span class="s-desc">${escape(item.intro)}</span><em class="s-update-time">${item.update_time}</em></li>`).join('')}</ul>
    <span class="page-btn num active">${activePage}</span><span class="next-btn${nextDisabled ? ' disabled' : ''}">下一页</span>
    <script>${mutateScript(script)}</script><script>throw new Error('NEVER_EXECUTE');</script>`;
}

function html(body: string, status = 200, headers: HeadersInit = {}): Response {
  return new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8', ...headers } });
}

function adapter(fetchPage: typeof fetch, options: Partial<Parameters<typeof createQimaoDiscovery>[0]> = {}) {
  return createQimaoDiscovery({ requestIntervalMs: 0, now: () => new Date(observedAt), fetch: fetchPage, ...options });
}

async function root(discovery: ReturnType<typeof adapter>, order: 'click' | 'update_time' = 'click', currentCycle = cycle): Promise<DiscoveryTask> {
  return (await discovery.seeds(currentCycle, signal())).find(item => item.data.order === order)!;
}

function requested(value: string | URL | Request): Pick<FixtureOptions, 'parent' | 'category' | 'order' | 'page'> {
  const url = new URL(String(value));
  const match = /^\/shuku\/a-(a|\d+)-(a|\d+)-a-a-a-a-(click|update_time)-(\d+)\/$/.exec(url.pathname)!;
  return { parent: match[1], category: match[2], order: match[3] as 'click' | 'update_time', page: Number(match[4]) };
}

describe('Qimao original-fiction catalog discovery', () => {
  it('seeds only the canonical all-library and latest heads without fetching', async () => {
    const fetchPage = vi.fn<typeof fetch>();
    const discovery = adapter(fetchPage);
    const seeds = await discovery.seeds(cycle, signal());
    expect(seeds.map(item => item.url)).toEqual(['click', 'update_time'].map(order => `${ORIGIN}/shuku/a-a-a-a-a-a-a-${order}-1/`));
    expect(seeds.every(item => item.priority === 'front')).toBe(true);
    expect((await discovery.seeds('21600000:101', signal()))[0]!.uniqueKey).not.toBe(seeds[0]!.uniqueKey);
    expect(fetchPage).not.toHaveBeenCalled();
  });

  it('preserves full suffixed IDs, verified metadata and source update time without rank, heat or publication guesses', async () => {
    const source = row();
    const fetchPage = vi.fn<typeof fetch>().mockResolvedValue(html(fixture({ total: 1, rows: [source] })));
    const discovery = adapter(fetchPage);
    const result = await discovery.handle(await root(discovery), signal());
    expect(result.batch?.works[0]).toMatchObject({ id: `qimao:${source.book_id}`, sourceId: source.book_id, title: source.title,
      sourceUrl: source.read_url, author: source.author, description: source.intro, coverUrl: source.image_link,
      tags: ['玄幻奇幻', '东方玄幻'], category: '东方玄幻', wordCount: 123_400, serialStatus: '完结',
      observedAt, sourceUpdatedAt: '2026-11-12 08:09:10', publishedAt: null, board: '', rank: null, rankChange: null });
    expect(result.batch?.works[0]!.metrics.every(metric => metric.value === null)).toBe(true);
    expect(JSON.stringify(result)).not.toContain('NEVER_EXECUTE');
    expect(result.coverage).toContain('不是七猫全库');
    expect(fetchPage.mock.calls[0]![1]).toMatchObject({ redirect: 'error', credentials: 'omit' });
    expect(fetchPage.mock.calls[0]![1]!.headers).not.toHaveProperty('cookie');
  });

  it('compares state text in its rendered whitespace form and stores the displayed title and author', async () => {
    // Observed on 2026-11-15: official state kept "闪婚成宠  爆改千亿总裁", "沈悦 " and "韩紫云   雨" while the page displayed collapsed text.
    const spaced = { ...row('1885065', 1), title: '闪婚成宠  爆改千亿总裁', author: '韩紫云   雨 ', words_num: '12.34万字 ', update_time: '2026-11-12 更新' };
    const result = await adapter(async () => html(fixture({ total: 1, rows: [spaced] }))).handle(await root(adapter(vi.fn())), signal());
    expect(result.batch?.works[0]).toMatchObject({ sourceId: '1885065', title: '闪婚成宠 爆改千亿总裁', author: '韩紫云 雨', wordCount: 123_400 });
    for (const domRow of [{ ...spaced, title: '闪婚成宠爆改千亿总裁' }, { ...spaced, author: '韩紫云雨' }]) {
      const rejected = adapter(async () => html(fixture({ total: 1, rows: [spaced], domRows: [domRow] })));
      await expect(rejected.handle(await root(rejected), signal())).rejects.toThrow('differs from its state');
    }
  });

  it('marks verification and access refusals as not retryable while network failures stay retryable', async () => {
    const outcome = async (fetchPage: typeof fetch) => {
      const discovery = adapter(fetchPage);
      return discovery.handle(await root(discovery), signal()).then(() => null, (error: unknown) => error);
    };
    expect(await outcome(async () => html(fixture({ total: 1, rows: [row()], domRows: [{ ...row(), author: '其他作者' }] })))).toMatchObject({ retryable: false });
    expect(await outcome(async () => html('denied', 403))).toMatchObject({ retryable: false });
    expect(await outcome(async () => { throw new TypeError('fetch failed'); })).toMatchObject({ retryable: true });
    expect(await outcome(async () => html('unavailable', 503))).toMatchObject({ retryable: true });
  });

  it('discovers only source-advertised male/female leaf pairs and excludes publication rows', async () => {
    const fiction = row('14124273_0');
    const publication = row('1711', 2, '240', '247', '人物传记');
    const discovery = adapter(async () => html(fixture({ total: 2, rows: [fiction, publication] })));
    const result = await discovery.handle(await root(discovery), signal());
    expect(result.batch?.works.map(item => item.sourceId)).toEqual([fiction.book_id]);
    expect(result.next.map(item => item.url).toSorted()).toEqual([
      `${ORIGIN}/shuku/a-1-8-a-a-a-a-click-1/`, `${ORIGIN}/shuku/a-202-37-a-a-a-a-click-1/`, `${ORIGIN}/shuku/a-202-39-a-a-a-a-click-1/`,
    ]);
    expect(result.next.every(item => item.data.cycle === null)).toBe(true);
    expect(result.coverage).toContain('排除 1 部出版分类作品');
  });

  it('rotates bounded latest categories each cycle while retaining stable historical keys and newly advertised categories', async () => {
    let tree = categories;
    const discovery = adapter(async value => html(fixture({ ...requested(value), tree })), { latestCategoriesPerCycle: 1 });
    const first = await discovery.handle(await root(discovery), signal());
    const latest = await discovery.handle(await root(discovery, 'update_time'), signal());
    const periodic = latest.next.filter(item => item.priority === 'front');
    expect(periodic).toHaveLength(1);
    const nextCycle = await discovery.handle(await root(discovery, 'update_time', '21600000:101'), signal());
    expect(nextCycle.next.find(item => item.priority === 'front')!.url).not.toBe(periodic[0]!.url);
    const repeated = await discovery.handle(await root(discovery, 'click', '21600000:101'), signal());
    expect(repeated.next.map(item => item.uniqueKey)).toEqual(first.next.map(item => item.uniqueKey));
    tree = categories.map(item => item.id === '202' ? { ...item, children: [...item.children, { id: '41', name: '西方奇幻', type: '0' }] } : item);
    const expanded = await discovery.handle(await root(discovery, 'click', '21600000:102'), signal());
    expect(expanded.next.map(item => item.url)).toContain(`${ORIGIN}/shuku/a-202-41-a-a-a-a-click-1/`);
    for (const item of first.next) expect(expanded.next.some(next => next.uniqueKey === item.uniqueKey)).toBe(true);
  });

  it('returns a stable next-page task and publishes the complete short final page without rebuilding earlier pages', async () => {
    const fetchPage = vi.fn<typeof fetch>().mockImplementation(async value => html(fixture(requested(value))));
    const discovery = adapter(fetchPage);
    const first = await discovery.handle(await root(discovery), signal());
    const next = first.next.find(item => item.data.page === 2)!;
    expect(next.data.cycle).toBeNull();
    const last = await discovery.handle(next, signal());
    expect(last.batch?.works).toHaveLength(1);
    expect(last.batch?.works[0]!.sourceId).toBe('9000015_0');
    expect(last.next).toEqual([]);
    expect(last.coverage).toContain('第 2/2 页');
    expect(last.coverage).toContain('当前可见窗口已结束');
    expect(fetchPage.mock.calls).toHaveLength(2);
  });

  it('keeps an interrupted page task unchanged and retries that page without skipping its cursor', async () => {
    let fail = true;
    const fetchPage = vi.fn<typeof fetch>().mockImplementation(async value => {
      const request = requested(value);
      if (request.page === 2 && fail) throw new Error('Temporary source failure');
      return html(fixture(request));
    });
    const discovery = adapter(fetchPage);
    const first = await discovery.handle(await root(discovery), signal());
    const pending = first.next.find(item => item.data.page === 2)!;
    const saved = structuredClone(pending);
    await expect(discovery.handle(pending, signal())).rejects.toThrow('Temporary source failure');
    expect(pending).toEqual(saved);
    fail = false;
    expect((await discovery.handle(pending, signal())).batch?.works).toHaveLength(1);
    expect(fetchPage.mock.calls.slice(1).map(([value]) => String(value))).toEqual([pending.url, pending.url]);
  });

  it('rejects repeated page content before publishing another page or advancing its cursor', async () => {
    const discovery = adapter(async value => {
      const request = requested(value);
      return html(fixture({ ...request, total: 30,
        rows: Array.from({ length: 15 }, (_, index) => row(`${9000000 + index}_0`, (request.page! - 1) * 15 + index + 1)) }));
    });
    const first = await discovery.handle(await root(discovery), signal());
    await expect(discovery.handle(first.next.find(item => item.data.page === 2)!, signal())).rejects.toMatchObject({
      message: expect.stringContaining('分页内容与已读页面重复'), retryable: false });
  });

  it('accepts a validated empty source window without publishing an empty batch or claiming an empty platform', async () => {
    const discovery = adapter(async () => html(fixture({ total: 0 })));
    const result = await discovery.handle(await root(discovery), signal());
    expect(result.batch).toBeUndefined();
    expect(result.next.every(item => item.data.page === 1)).toBe(true);
    expect(result.coverage).toContain('当前空目录');
    expect(result.coverage).not.toContain('1/0');
    expect(result.coverage).toContain('当前窗口 0 部');
    expect(result.coverage).toContain('不是七猫全库');
  });

  it('requires the bounded preceding-page cursor before requesting a persisted later page', async () => {
    const fetchPage = vi.fn<typeof fetch>(); const discovery = adapter(fetchPage);
    const seed = await root(discovery);
    await expect(discovery.handle({ ...seed, url: seed.url.replace('click-1/', 'click-2/'),
      data: { ...seed.data, page: 2, cycle: null, previousSignatures: [] } }, signal())).rejects.toThrow('书库任务参数');
    expect(fetchPage).not.toHaveBeenCalled();
  });

  it.each([
    { changes: { pageConfig: { count: '16', page: '2', page_size: '15' } } },
    { changes: { pageConfig: { count: '16', page: '1', page_size: '20' } } },
    { changes: { pageConfig: { count: '150001', page: '1', page_size: '15' } } },
    { changes: { categoryFormData: { channel: 'a', category1: 'a', category2: 'a', words: 'a', update_time: 'a', is_vip: 'a', is_over: 'a', order: 'update_time', page: '1' } } },
    { activePage: 2 }, { nextDisabled: true }, { rows: [] },
    { rows: Array.from({ length: 15 }, (_, index) => row('same-id', index + 1)) },
    { domRows: Array.from({ length: 15 }, (_, index) => row(`different-${index}`, index + 1)) },
  ] satisfies FixtureOptions[])('rejects mismatched paging, filters or rendered book identities: %j', async options => {
    const discovery = adapter(async () => html(fixture(options)));
    await expect(discovery.handle(await root(discovery), signal())).rejects.toThrow();
  });

  it.each([
    ['title', '"changed title"'], ['read_url', '"https://evil.example/shuku/1/"'], ['book_id', '14124273'],
    ['book_id', '"14124273_1"'], ['category_url', '"https://www.qimao.com/shuku/a-202-39-a-a-a-a-click-1/"'],
  ])('rejects changed state %s without a matching canonical DOM identity', async (field, value) => {
    const source = row();
    const discovery = adapter(async () => html(fixture({ total: 1, rows: [source], mutateScript: script => script.replace(`"${field}":${JSON.stringify(source[field as keyof typeof source])}`, `"${field}":${value}`) })));
    await expect(discovery.handle(await root(discovery), signal())).rejects.toThrow();
  });

  it.each([
    (script: string) => script.replace('"literal alias",-1', 'globalThis.secret,-1'),
    (script: string) => script.replace('"literal alias",-1', '(()=>"alias")(),-1'),
    (script: string) => script.replace('extra:[a,b]', 'extra:globalThis.secret'),
    (script: string) => script.replace('extra:[a,b]', 'extra:(()=>{throw new Error("NEVER_EXECUTE")})()'),
    (script: string) => script.replace('extra:[a,b]', 'extra:{__proto__:{polluted:true}}'),
    (script: string) => script.replace('extra:[a,b]', 'extra:{[a]:1}'),
    (script: string) => script.replace('extra:[a,b]', 'extra:{...a}'),
    (script: string) => script.replace('extra:[a,b]', 'extra:{get value(){return 1;}}'),
    (script: string) => script.replace('return {fetch:', 'console.log("NEVER_EXECUTE");return {fetch:'),
    (script: string) => `${script}globalThis.sideEffect=true;`,
  ])('rejects executable, computed, prototype and nonliteral Nuxt expressions without executing them', async mutateScript => {
    const discovery = adapter(async () => html(fixture({ mutateScript })));
    await expect(discovery.handle(await root(discovery), signal())).rejects.toThrow();
  });

  it.each([
    `${ORIGIN}/shuku/a-a-a-a-a-a-a-click-0/`, `${ORIGIN}/shuku/a-a-a-a-a-a-a-click-10001/`,
    `${ORIGIN}/shuku/0-202-37-a-a-a-a-click-1/`, `${ORIGIN}/shuku/a-202-a-a-a-a-a-click-1/`,
    `${ORIGIN}/shuku/a-a-a-1-a-a-a-click-1/`, `${ORIGIN}/shuku/a-a-a-a-a-a-a-favorite_uv-1/`,
    `${ORIGIN}/shuku/a-a-a-a-a-a-a-click-1/?page=2`, `${ORIGIN}/shuku/a-a-a-a-a-a-a-click-1/#tab`,
    'https://evil.example/shuku/a-a-a-a-a-a-a-click-1/', `${ORIGIN}/shuku/14124273_0-1/`,
  ])('rejects unsupported durable task URL before any network access: %s', async url => {
    const fetchPage = vi.fn<typeof fetch>(); const discovery = adapter(fetchPage);
    await expect(discovery.handle({ ...await root(discovery), url }, signal())).rejects.toThrow();
    expect(fetchPage).not.toHaveBeenCalled();
  });

  it('keeps the fixed metadata whitelist and legacy compatibility checks for the new catalog paths', async () => {
    for (const path of ['/shuku/a-a-a-a-a-a-a-click-1/', '/shuku/a-202-37-a-a-a-a-update_time-10000/', '/shuku/14124273_0/']) expect(metadataUrl(path).origin).toBe(ORIGIN);
    for (const path of ['/shuku/a-202-a-a-a-a-a-click-1/', '/shuku/a-a-a-a-a-a-a-click-10001/', '/shuku/14124273_0-1/', '//evil.example/']) expect(() => metadataUrl(path)).toThrow();
    const legacyRequest = vi.fn(async () => fixture());
    const error = new TypeError('Header parse failure', { cause: { code: 'HPE_INVALID_HEADER_TOKEN' } });
    const result = await readMetadata('/shuku/a-a-a-a-a-a-a-click-1/', { maxResponseBytes: 5_242_880, allowLegacyResponseHeaders: true }, signal(),
      { fetch: async () => { throw error; }, legacyRequest });
    expect(result.transport).toBe('https_legacy_headers'); expect(legacyRequest).toHaveBeenCalledTimes(1);
    await expect(readMetadata('/shuku/a-a-a-a-a-a-a-click-1/', { maxResponseBytes: 5_242_880, allowLegacyResponseHeaders: false }, signal(),
      { fetch: async () => { throw error; }, legacyRequest })).rejects.toThrow('Header parse failure');
    expect(legacyRequest).toHaveBeenCalledTimes(1);
  });

  it('preserves cancellation, response byte limits and blocked-response behavior', async () => {
    const cancelled = new AbortController(); cancelled.abort(new Error('Stopped'));
    const fetchPage = vi.fn<typeof fetch>(); const discovery = adapter(fetchPage);
    await expect(discovery.seeds(cycle, cancelled.signal)).rejects.toThrow('Stopped');
    await expect(discovery.handle(await root(discovery), cancelled.signal)).rejects.toThrow('Stopped');
    expect(fetchPage).not.toHaveBeenCalled();
    for (const response of [html('blocked', 403), html('large', 200, { 'content-length': '2048' }), new Response('{}', { headers: { 'content-type': 'application/json' } })]) {
      const source = vi.fn<typeof fetch>().mockResolvedValue(response);
      const bounded = adapter(source, { maxResponseBytes: 1024 });
      await expect(bounded.handle(await root(bounded), signal())).rejects.toThrow();
      expect(source).toHaveBeenCalledTimes(1);
    }
  });
});

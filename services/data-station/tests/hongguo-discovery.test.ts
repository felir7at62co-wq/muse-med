import { describe, expect, it, vi } from 'vitest';
import { createHongguoDiscovery } from '../src/server/discovery/hongguo.ts';
import type { DiscoveryTask } from '../src/server/discovery/crawler.ts';

const origin = 'https://hongguoduanju.com';
const path = '/category/real-drama';
const observedAt = '2026-11-13T10:00:00.000Z';
const ids = ['7703408432757361688', '7701935931787316286', '7698674192157247488'];
const signal = () => new AbortController().signal;
const task = (url = `${origin}${path}`): DiscoveryTask => ({ url, uniqueKey: url, data: {} });

function row(id: string | number = ids[0]!, title = '公开分类作品') {
  return { series_id: id, series_name: title, series_intro: '来源简介', series_cover: 'https://example.com/cover.jpg',
    tags: ['家庭', '成长'], episode_right_text: '全63集', series_episode_info: { episode_total_cnt: 63 },
    vid_list: ['preview-only'], accessible_episode_cnt: 3 };
}

function html({
  categoryPath = path, page = 1, total = 3, pageSize = 2,
  rows = [row(ids[0]), row(ids[1])] as Record<string, unknown>[], changes = {} as Record<string, unknown>, links = undefined as string[] | undefined,
} = {}): string {
  const canonical = `${origin}${categoryPath}${page > 1 ? `?page=${page}` : ''}`;
  const data = { isSuccess: true, canonicalUrl: canonical, query: { page },
    categoryRoute: { canonicalPath: categoryPath, contentType: categoryPath.split('/')[2], contentTypeLabel: '真人剧',
      displayName: categoryPath === path ? '真人剧' : '爱情', enabled: true },
    pagination: { total, pageNum: page, pageSize, totalPages: Math.ceil(total / pageSize) }, recommendList: rows, ...changes };
  const anchors = links ?? [ ...(page < Math.ceil(total / pageSize) ? [`${categoryPath}?page=${page + 1}`] : []),
    '/category/real-drama/romance' ];
  return `<script>_ROUTER_DATA = ${JSON.stringify({ loaderData: { 'category_$': data } })}</script>`
    + anchors.map(href => `<a href="${href}">官方目录</a>`).join('');
}

function response(body: string, status = 200): Response {
  return new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8' } });
}

function adapter(fetchPage: typeof fetch) {
  return createHongguoDiscovery({ fetch: fetchPage, requestIntervalMs: 0, now: () => new Date(observedAt) });
}

describe('Hongguo category discovery', () => {
  it('seeds only the three verified drama directories without network or cycle-bound discovered keys', async () => {
    const fetchPage = vi.fn<typeof fetch>();
    const discovery = adapter(fetchPage);
    const first = await discovery.seeds('cycle-a', signal());
    expect(discovery.platform).toBe('hongguo');
    expect(first.map(item => item.url)).toEqual(['real-drama', 'comic-drama', 'ai-drama'].map(type => `${origin}/category/${type}`));
    expect(await discovery.seeds('cycle-b', signal())).toEqual(first);
    expect(fetchPage).not.toHaveBeenCalled();
  });

  it('returns a complete page with source metadata and unknown metrics before any queue acknowledgement', async () => {
    const fetchPage = vi.fn<typeof fetch>().mockResolvedValue(response(html()));
    const result = await adapter(fetchPage).handle(task(), signal());
    expect(result.batch?.works).toHaveLength(2);
    expect(result.batch).toMatchObject({ platform: 'hongguo', observedAt });
    expect(result.batch?.works[0]).toMatchObject({
      id: `hongguo:${ids[0]}`, sourceId: ids[0], title: '公开分类作品', origin: 'live',
      sourceUrl: `${origin}/detail?series_id=${ids[0]}`, description: '来源简介', tags: ['家庭', '成长'],
      board: '', rank: null, rankChange: null, episodeCount: 63, serialStatus: '全63集',
      author: null, publishedAt: null, sourceUpdatedAt: null, observedAt,
      metrics: [{ key: 'heat', label: '热度', value: null }, { key: 'collection', label: '收藏', value: null },
        { key: 'likes', label: '点赞', value: null }],
    });
    expect(result.batch?.works[0]?.metadataNote).toContain(`${origin}${path}`);
    expect(result.coverage).toContain('第 1/2 页');
    expect(result.coverage).toContain('不是红果全库');
    expect(result.next.map(item => item.url)).toEqual([`${origin}${path}?page=2`, `${origin}${path}/romance`]);
    expect(fetchPage).toHaveBeenCalledOnce();
    expect(fetchPage.mock.calls[0]?.[1]).toMatchObject({ method: 'GET', redirect: 'error' });
    expect(fetchPage.mock.calls[0]?.[1]?.headers).not.toHaveProperty('cookie');
  });

  it('follows the declared next page and ends on the complete shorter last page', async () => {
    const fetchPage = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response(html()))
      .mockResolvedValueOnce(response(html({ page: 2, rows: [row(ids[2], '下一页新增作品')], links: [] })));
    const discovery = adapter(fetchPage);
    const first = await discovery.handle(task(), signal());
    const nextPage = first.next.find(item => item.url.endsWith('?page=2'))!;
    const last = await discovery.handle(nextPage, signal());
    expect(last.batch?.works.map(work => work.sourceId)).toEqual([ids[2]]);
    expect(last.next).toEqual([]);
    expect(last.coverage).toContain('第 2/2 页');
    expect(fetchPage.mock.calls.map(([url]) => String(url))).toEqual([`${origin}${path}`, `${origin}${path}?page=2`]);
  });

  it('acknowledges a verified empty category without publishing or clearing a work batch', async () => {
    const result = await adapter(async () => response(html({ total: 0, rows: [], links: [] }))).handle(task(), signal());
    expect(result).not.toHaveProperty('batch');
    expect(result.next).toEqual([]);
    expect(result.coverage).toContain('合法空分类');
    expect(result.coverage).toContain('不清除已有作品');
    for (const invalid of [
      html({ total: 0, rows: [row()], links: [] }),
      html({ total: 0, rows: [], changes: { pagination: { total: 0, pageNum: 1, pageSize: 24, totalPages: 1 } } }),
      html({ total: 0, rows: [], page: 2 }),
    ]) await expect(adapter(async () => response(invalid)).handle(task(), signal())).rejects.toThrow();
  });

  it('discovers topic paths only from actual supported same-origin anchors', async () => {
    const links = [`${path}?page=2`, `${path}/romance`, '/category/comic-drama/creative',
      '/category/ai-drama', '/category/comic/creative', `${path}/romance`,
      `https://evil.example${path}/family`, `${path}/family?sort=new`, `${path}/family#tab`];
    const body = html({ links }) + '<script>const invented = "/category/real-drama/invented";</script>'
      + '<template><a href="/category/real-drama/hidden">hidden</a></template>';
    const discovery = adapter(async () => response(body));
    const first = await discovery.handle(task(), signal());
    const second = await discovery.handle({ ...task(), uniqueKey: 'hongguo:cycle-b:seed' }, signal());
    expect(first.next.map(item => item.url)).toEqual([`${origin}${path}?page=2`, `${origin}${path}/romance`, `${origin}/category/comic-drama/creative`]);
    expect(second.next.map(item => item.uniqueKey)).toEqual(first.next.map(item => item.uniqueKey));
    const topic = first.next.find(item => item.url.endsWith('/romance'))!;
    expect(await adapter(async () => response(html({ categoryPath: `${path}/romance` }))).handle(topic, signal()))
      .toMatchObject({ batch: { works: [{ board: '', rank: null }, { board: '', rank: null }] } });
  });

  it.each([
    `https://evil.example${path}`, `http://hongguoduanju.com${path}`, `https://user@hongguoduanju.com${path}`,
    `${origin}/category/comic`, `${origin}/rank/hot-drama`, `${origin}${path}?sort=new`,
    `${origin}${path}?page=2&page=3`, `${origin}${path}?page=0`, `${origin}${path}?page=10001`, `${origin}${path}#fragment`,
  ])('rejects an unsupported persisted URL before fetching: %s', async url => {
    const fetchPage = vi.fn<typeof fetch>();
    await expect(adapter(fetchPage).handle(task(url), signal())).rejects.toThrow();
    expect(fetchPage).not.toHaveBeenCalled();
  });

  it.each([
    { canonicalUrl: `${origin}/category/ai-drama` },
    { canonicalUrl: `${origin}${path}?page=2` },
    { categoryRoute: { canonicalPath: '/category/ai-drama', contentType: 'real-drama', contentTypeLabel: '真人剧', displayName: '真人剧', enabled: true } },
    { categoryRoute: { canonicalPath: path, contentType: 'ai-drama', contentTypeLabel: 'AI剧', displayName: 'AI剧', enabled: true } },
    { query: { page: 2 } },
    { pagination: { total: 3, pageNum: 2, pageSize: 2, totalPages: 2 } },
    { pagination: { total: 3, pageNum: 1, pageSize: 2, totalPages: 3 } },
    { pagination: { total: 3, pageNum: 1, pageSize: 0, totalPages: 2 } },
    { pagination: { total: 0, pageNum: 1, pageSize: 2, totalPages: 1 } },
    { isSuccess: false },
  ])('rejects inconsistent source identity or pagination without returning a batch: %j', async changes => {
    await expect(adapter(async () => response(html({ changes }))).handle(task(), signal())).rejects.toThrow();
  });

  it.each([
    { rows: [row(ids[0])] }, { rows: [] }, { rows: [row(ids[0]), row(ids[0])] },
    { rows: [row(Number(ids[0])), row(ids[1])] }, { rows: [row(ids[0], ''), row(ids[1])] },
  ])('rejects missing, duplicate or unidentifiable entries before discovering next pages: %j', async ({ rows }) => {
    await expect(adapter(async () => response(html({ rows }))).handle(task(), signal())).rejects.toThrow();
  });

  it('rejects a page whose declared next-page link is absent instead of skipping forward', async () => {
    await expect(adapter(async () => response(html({ links: [`${path}?page=3`] }))).handle(task(), signal()))
      .rejects.toThrow(/next-page link/);
  });

  it('does not treat a player preview list as the total episode count', async () => {
    const rows = [{ ...row(ids[0]), series_episode_info: undefined }, row(ids[1])];
    const result = await adapter(async () => response(html({ rows }))).handle(task(), signal());
    expect(result.batch?.works[0]?.episodeCount).toBeNull();
  });

  it.each(['<html>请完成验证</html>', '<script>_ROUTER_DATA = (() => { throw new Error("do not execute"); })()</script>'])
    ('rejects access shells and executable loader assignments', async body => {
      await expect(adapter(async () => response(body)).handle(task(), signal())).rejects.toThrow();
    });

  it('rejects unfinished streamed loader data even when some entries are present', async () => {
    const args = JSON.stringify(['category_$', [{ key: 'recommendList', routerDataFnName: 's', routerDataFnArgs: ['"pending"'] }]])
      .replaceAll('&', '&amp;').replaceAll('"', '&quot;');
    const body = html() + `<script data-fn-name="mergeLoaderData" data-fn-args="${args}"></script>`;
    await expect(adapter(async () => response(body)).handle(task(), signal())).rejects.toThrow(/streamed data/);
  });

  it('does not retry a blocked response or accept non-HTML data', async () => {
    for (const result of [response('blocked', 403), new Response('{}', { headers: { 'content-type': 'application/json' } })]) {
      const fetchPage = vi.fn<typeof fetch>().mockResolvedValue(result);
      await expect(adapter(fetchPage).handle(task(), signal())).rejects.toThrow(/Category response unavailable/);
      expect(fetchPage).toHaveBeenCalledOnce();
    }
  });

  it('bounds declared and chunked response bytes before parsing', async () => {
    for (const declared of [true, false]) {
      const result = response('a'.repeat(2048));
      if (declared) result.headers.set('content-length', '2048');
      const discovery = createHongguoDiscovery({ fetch: async () => result, maxResponseBytes: 1024 });
      await expect(discovery.handle(task(), signal())).rejects.toThrow(/大小限制/);
    }
  });

  it('honors cancellation before seed generation or HTTP access and after a response arrives', async () => {
    const controller = new AbortController();
    const fetchPage = vi.fn<typeof fetch>();
    const discovery = adapter(fetchPage);
    controller.abort(new Error('stop discovery'));
    await expect(discovery.seeds('cycle', controller.signal)).rejects.toThrow('stop discovery');
    await expect(discovery.handle(task(), controller.signal)).rejects.toThrow('stop discovery');
    expect(fetchPage).not.toHaveBeenCalled();
    const active = new AbortController();
    const late = adapter(async () => { active.abort(new Error('stop after fetch')); return response(html()); });
    await expect(late.handle(task(), active.signal)).rejects.toThrow('stop after fetch');
  });

  it('validates HTTP bounds before exposing the adapter', () => {
    for (const options of [{ requestIntervalMs: -1 }, { requestTimeoutMs: 0 }, { maxResponseBytes: 0 }]) {
      expect(() => createHongguoDiscovery(options)).toThrow(/must be an integer/);
    }
  });
});

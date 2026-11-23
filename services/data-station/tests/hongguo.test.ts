import { describe, expect, it, vi } from 'vitest';
import { collectHongguo } from '../src/server/collectors/hongguo.ts';
import { parseCount, parseRanking, parseRating } from '../src/server/collectors/hongguo-parser.js';

const origin = 'https://hongguoduanju.com';
const date = new Date('2026-11-13T05:00:00.000Z');
const longId = '7698674192157247488';

function embedded({
  board = 'hot-drama', page = 1, totalPages = 1, title = '榜单样例',
  seriesId = longId as string | number, favoriteText = '120.5万收藏' as string | null,
  likeText = '0点赞' as string | null, heatText = '200万热度' as string | null,
  primaryMetricText = null as string | null, shareText = '2万分享' as string | null,
  scoreText = '9.4分' as string | null, scoreCountText = '7971人评分' as string | null,
} = {}): string {
  return `<script>_ROUTER_DATA = ${JSON.stringify({ loaderData: {
    [`rank_${board}/page`]: { updatedText: '11月13日已更新', content: {
      isSuccess: true, pagination: { pageNum: page, totalPages },
      rankList: [{ seriesId, title, rank: (page - 1) * 20 + 1, favoriteText, likeText, heatText, primaryMetricText, shareText, scoreText, scoreCountText,
        tags: ['穿越', '成长'], description: '这是一条测试简介', cover: 'https://example.com/cover.jpg', episodeVids: ['preview-1', 'preview-2', 'preview-3'] }],
    } },
  } })}</script>`;
}

function htmlResponse(body: string, status = 200): Response {
  return new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8' } });
}

const parserOptions = { board: 'hot-drama' as const, page: 1, sourceUrl: `${origin}/rank/hot-drama`, fetchedAt: date.toISOString() };

function rendered(board = 'hot-drama', primary = '2万热度', engagement = '<li>0收藏</li>'): string {
  const route = `rank_${board}/page`;
  const root = { loaderData: { [route]: { pageNum: 1, canonicalUrl: `${origin}/rank/${board}` } } };
  const pending = [route, [{ key: 'content', routerDataFnName: 's', routerDataFnArgs: ['"pending"'] }]];
  const args = JSON.stringify(pending).replaceAll('&', '&amp;').replaceAll('"', '&quot;');
  return `<script>_ROUTER_DATA = ${JSON.stringify(root)}</script>`
    + `<script data-fn-name="mergeLoaderData" data-fn-args="${args}"></script>`
    + `<article aria-labelledby="rank-title-${longId}"><h2 id="rank-title-${longId}">公开卡片样例</h2>`
    + `<span class="pc-badge-number-fixture">1</span><p class="pc-metrics-fixture">${primary}</p>`
    + `<ul aria-label="作品互动数据">${engagement}</ul></article>`
    + `<nav aria-label="榜单分页"><a href="/rank/${board}">1</a></nav>`;
}

describe('Hongguo read-only ranking collector', () => {
  it('does not treat ranking-card preview links as the full episode count', async () => {
    const result = await collectHongguo({ boards: ['hot-drama'], fetch: async () => htmlResponse(embedded()) });
    expect(result.works[0]?.episodeCount).toBeNull();
  });
  it('retains long string IDs, source time, board and independent metrics', async () => {
    const fetchPage = vi.fn<typeof fetch>().mockResolvedValue(htmlResponse(embedded()));
    const result = await collectHongguo({ boards: ['hot-drama'], fetch: fetchPage, now: () => date });
    expect(result.platform).toBe('hongguo');
    expect(result.observedAt).toBe(date.toISOString());
    expect(result.works).toHaveLength(1);
    expect(result.works[0]).toMatchObject({
      id: `hongguo:${longId}`, sourceId: longId, platform: 'hongguo', origin: 'live',
      board: '综合热播榜', rank: 1, rankChange: null, observedAt: date.toISOString(),
      sourceUrl: `${origin}/detail?series_id=${longId}`, sourceUpdatedAt: '11月13日已更新',
      author: null, episodeCount: null, publishedAt: null,
      metrics: [
        { key: 'heat', label: '热度', value: 2_000_000 },
        { key: 'collection', label: '收藏', value: 1_205_000 },
        { key: 'likes', label: '点赞', value: 0 },
        { key: 'shares', label: '分享', value: 20_000 },
        { key: 'rating', label: '评分', value: 9.4, unit: '分' },
        { key: 'rating_count', label: '评分人数', value: 7971 },
        { key: 'ranking_primary', label: '榜单热度', value: null },
      ],
    });
    expect(result.coverage).toContain('1/1 页');
    expect(result.coverage).toContain('不是红果全库');
    expect(fetchPage).toHaveBeenCalledWith(new URL(`${origin}/rank/hot-drama`), expect.objectContaining({ redirect: 'error', method: 'GET' }));
    const headers = fetchPage.mock.calls[0]?.[1]?.headers;
    expect(headers).not.toHaveProperty('cookie');
  });

  it('keeps shares and ratings unknown when a card does not show them', async () => {
    const result = await collectHongguo({ boards: ['hot-drama'], fetch: async () => htmlResponse(embedded({ shareText: null, scoreText: '暂无评分', scoreCountText: null })) });
    const value = (key: string) => result.works[0]?.metrics.find(metric => metric.key === key)?.value;
    expect([value('shares'), value('rating'), value('rating_count')]).toEqual([null, null, null]);
  });

  it('reads a 0–10 rating and rejects other text', () => {
    expect(['9.4分', '评分9.4', '10分', ' 8 分'].map(parseRating)).toEqual([9.4, 9.4, 10, 8]);
    expect(['11分', '9.4万', '', null, 9.4].map(parseRating)).toEqual([null, null, null, null, null]);
  });

  it('does not treat an unsafe numeric ID as the requested string ID', () => {
    expect(() => parseRanking(embedded({ seriesId: Number(longId) }), parserOptions)).toThrow(/string series ID/);
  });

  it('preserves unknown metrics separately from displayed zero', async () => {
    const result = await collectHongguo({
      boards: ['hot-drama'], fetch: async () => htmlResponse(embedded({ favoriteText: null, heatText: '暂无热度' })),
    });
    expect(result.works[0]?.metrics.map(metric => metric.value)).toEqual([null, null, 0, 20_000, 9.4, 7971, null]);
  });

  it('does not truncate unsupported numeric prefixes into known counts', () => {
    for (const source of ['-12收藏', '约1万收藏', '1e3收藏', '12+收藏', '12收藏以上']) {
      expect(parseCount(source).value).toBeNull();
    }
    expect(parseCount('0收藏').value).toBe(0);
  });

  it('preserves all board observations and explicitly declares a truncated scope', async () => {
    const urls: string[] = [];
    const result = await collectHongguo({ requestIntervalMs: 0, fetch: async input => {
      const url = new URL(String(input));
      urls.push(url.href);
      const board = url.pathname.split('/').at(-1);
      return htmlResponse(embedded({ board, totalPages: 5 }));
    } });
    expect(urls).toHaveLength(7);
    expect(urls[0]).toBe(`${origin}/rank/hot-drama`);
    expect(new Set(result.works.map(work => work.id)).size).toBe(1);
    expect(new Set(result.works.map(work => work.board)).size).toBe(7);
    expect(result.coverage).toContain('7/35 页');
    expect(result.coverage).toContain('其余分页未采集');
  });

  it('only follows declared official pagination within the configured page bound', async () => {
    const urls: string[] = [];
    const result = await collectHongguo({ boards: ['hot-drama'], maxPages: 2, requestIntervalMs: 0, fetch: async input => {
      const url = new URL(String(input));
      urls.push(url.href);
      return htmlResponse(embedded({ page: Number(url.searchParams.get('page') ?? 1), totalPages: 5 }));
    } });
    expect(urls).toEqual([`${origin}/rank/hot-drama`, `${origin}/rank/hot-drama?page=2`]);
    expect(result.works.map(work => work.rank)).toEqual([1, 21]);
    expect(result.coverage).toContain('2/5 页');
  });

  it('rejects a mixed batch when any page fails instead of publishing partial data', async () => {
    const fetchPage = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(htmlResponse(embedded({ totalPages: 2 })))
      .mockResolvedValueOnce(htmlResponse('rate limited', 429));
    await expect(collectHongguo({ boards: ['hot-drama'], maxPages: 2, requestIntervalMs: 0, transientRetryDelaysMs: [], fetch: fetchPage }))
      .rejects.toThrow(/HTTP 429/);
    expect(fetchPage).toHaveBeenCalledTimes(2);
  });

  it('rejects access shells, wrong board data and wrong page metadata', async () => {
    for (const html of ['<html>请完成验证</html>', embedded({ board: 'hot-ai-drama' }), embedded({ page: 2, totalPages: 2 })]) {
      await expect(collectHongguo({ boards: ['hot-drama'], fetch: async () => htmlResponse(html) }))
        .rejects.toThrow(/红果采集失败/);
    }
  });

  it('rejects empty rank lists rather than asserting zero works', async () => {
    const html = embedded().replace(/"rankList":\[.*?\]\}\}\}\}/, '"rankList":[]}}}}');
    await expect(collectHongguo({ boards: ['hot-drama'], fetch: async () => htmlResponse(html) }))
      .rejects.toThrow(/红果采集失败/);
  });

  it('recovers complete visible cards when streaming JSON remains pending', async () => {
    const result = await collectHongguo({ boards: ['hot-drama'], fetch: async () => htmlResponse(rendered()) });
    expect(result.works[0]).toMatchObject({ sourceId: longId, title: '公开卡片样例', rank: 1 });
    expect(result.works[0]?.metrics.map(metric => metric.value)).toEqual([20_000, 0, null, null, null, null, 20_000]);
  });

  it.each([
    { board: 'new-drama' as const, primary: '8203万热度', label: '榜单热度', value: 82_030_000 },
    { board: 'followed-drama' as const, primary: '1893.4万收藏', label: '榜单收藏', value: 18_934_000 },
    { board: 'must-watch-drama' as const, primary: '2亿最高热度', label: '最高热度', value: 200_000_000 },
  ])('keeps the $board primary value separate from all interaction fields', async ({ board, primary, label, value }) => {
    const fetchPage = vi.fn<typeof fetch>().mockResolvedValue(htmlResponse(embedded({
      board, primaryMetricText: primary, favoriteText: '1893.5万收藏', likeText: '3708.8万点赞', heatText: '4353万热度',
    })));
    const result = await collectHongguo({ boards: [board], fetch: fetchPage });
    expect(String(fetchPage.mock.calls[0]?.[0])).toBe(`${origin}/rank/${board}`);
    expect(result.works[0]?.metrics).toEqual([
      { key: 'heat', label: '热度', value: 43_530_000 },
      { key: 'collection', label: '收藏', value: 18_935_000 },
      { key: 'likes', label: '点赞', value: 37_088_000 },
      { key: 'shares', label: '分享', value: 20_000 },
      { key: 'rating', label: '评分', value: 9.4, unit: '分' },
      { key: 'rating_count', label: '评分人数', value: 7971 },
      { key: 'ranking_primary', label, value },
    ]);
  });

  it.each([
    { board: 'must-watch-drama' as const, primary: '2亿最高热度', label: '最高热度', value: 200_000_000 },
    { board: 'followed-drama' as const, primary: '1893.4万收藏', label: '榜单收藏', value: 18_934_000 },
  ])('does not infer hidden heat or collection from the $board rendered primary', async ({ board, primary, label, value }) => {
    const result = await collectHongguo({ boards: [board], fetch: async () => htmlResponse(rendered(board, primary,
      '<li>70万分享</li><li>3708.8万点赞</li>')) });
    expect(result.works[0]?.metrics).toEqual([
      { key: 'heat', label: '热度', value: null },
      { key: 'collection', label: '收藏', value: null },
      { key: 'likes', label: '点赞', value: 37_088_000 },
      { key: 'shares', label: '分享', value: 700_000 },
      { key: 'rating', label: '评分', value: null, unit: '分' },
      { key: 'rating_count', label: '评分人数', value: null },
      { key: 'ranking_primary', label, value },
    ]);
  });

  it('preserves an unsupported primary display as unknown instead of using another metric', async () => {
    const html = embedded({ board: 'must-watch-drama', primaryMetricText: '约2亿最高热度' });
    const parsed = parseRanking(html, { ...parserOptions, board: 'must-watch-drama' });
    expect(parsed.items[0]?.rankingPrimary).toMatchObject({ raw: '约2亿最高热度', value: null, label: '最高热度' });
    expect(parsed.items[0]?.heat.value).toBe(2_000_000);
  });

  it('retries only unfinished page JSON and never evaluates executable assignments', async () => {
    const pending = rendered().replace(/<article[\s\S]*<\/article>/, '');
    const fetchPage = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(htmlResponse(pending))
      .mockResolvedValueOnce(htmlResponse(embedded()));
    const result = await collectHongguo({ boards: ['hot-drama'], requestIntervalMs: 0, fetch: fetchPage });
    expect(result.works).toHaveLength(1);
    expect(fetchPage).toHaveBeenCalledTimes(2);
    const executable = '<script>_ROUTER_DATA = (() => { throw new Error("must never execute"); })()</script>';
    await expect(collectHongguo({ boards: ['hot-drama'], fetch: async () => htmlResponse(executable) }))
      .rejects.toThrow(/JSON, not executable code/);
  });

  it('repeats a page answered with HTTP 503 or 429 after a wait, and fails with the last status once the repeats run out', async () => {
    const busy = () => new Response('busy', { status: 503, headers: { 'content-type': 'text/html' } });
    const fetchPage = vi.fn<typeof fetch>().mockResolvedValueOnce(busy()).mockResolvedValueOnce(new Response('', { status: 429 })).mockResolvedValueOnce(htmlResponse(embedded()));
    const result = await collectHongguo({ boards: ['hot-drama'], requestIntervalMs: 0, transientRetryDelaysMs: [0, 0], fetch: fetchPage });
    expect(result.works).toHaveLength(1);
    expect(fetchPage).toHaveBeenCalledTimes(3);
    const always = vi.fn<typeof fetch>(async () => busy());
    await expect(collectHongguo({ boards: ['hot-drama'], requestIntervalMs: 0, transientRetryDelaysMs: [0, 0], fetch: always }))
      .rejects.toThrow('返回 HTTP 503（已重试 2 次）');
    expect(always).toHaveBeenCalledTimes(3);
    const missing = vi.fn<typeof fetch>(async () => new Response('', { status: 404 }));
    await expect(collectHongguo({ boards: ['hot-drama'], requestIntervalMs: 0, fetch: missing })).rejects.toThrow('返回 HTTP 404，');
    expect(missing).toHaveBeenCalledTimes(1);
  });

  it('rejects unsupported boards and invalid bounds before fetching', async () => {
    const fetchPage = vi.fn<typeof fetch>();
    // This is the untrusted model/config boundary, so the invalid runtime value is intentional.
    await expect(collectHongguo({ boards: JSON.parse('["https://example.com"]'), fetch: fetchPage })).rejects.toThrow(/boards/);
    await expect(collectHongguo({ maxPages: 6, fetch: fetchPage })).rejects.toThrow(/maxPages/);
    expect(fetchPage).not.toHaveBeenCalled();
  });

  it('honors caller cancellation before network access', async () => {
    const controller = new AbortController();
    controller.abort(new Error('test cancelled'));
    const fetchPage = vi.fn<typeof fetch>();
    await expect(collectHongguo({ signal: controller.signal, fetch: fetchPage })).rejects.toThrow('test cancelled');
    expect(fetchPage).not.toHaveBeenCalled();
  });

  it('rejects a declared oversized response before reading its body', async () => {
    const response = htmlResponse(embedded());
    response.headers.set('content-length', '10000000');
    await expect(collectHongguo({ boards: ['hot-drama'], maxResponseBytes: 1024, fetch: async () => response }))
      .rejects.toThrow(/大小限制/);
  });

  it('rejects a chunked oversized response with no trustworthy content length', async () => {
    const response = htmlResponse('a'.repeat(2048));
    await expect(collectHongguo({ boards: ['hot-drama'], maxResponseBytes: 1024, fetch: async () => response }))
      .rejects.toThrow(/大小限制/);
  });

  it('rejects non-HTML success responses', async () => {
    await expect(collectHongguo({ boards: ['hot-drama'], fetch: async () => new Response('{}', { headers: { 'content-type': 'application/json' } }) }))
      .rejects.toThrow(/没有返回 HTML/);
  });
});

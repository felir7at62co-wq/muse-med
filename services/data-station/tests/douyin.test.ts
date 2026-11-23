import { describe, expect, it, vi } from 'vitest';
import { collectDouyin, parseDouyinPublicPage } from '../src/server/collectors/douyin.ts';
import { DEFAULT_MANAGED_DOUYIN_SOURCES } from '../src/shared/douyin-sources.ts';

const longId = '7706738013220539657';
const secondId = '7707485490567548160';
const author = '测试短剧创作者';
const observedAt = '2026-11-13T07:00:00.000Z';
const source = { videoId: longId, mode: 'creator' as const, expectedAuthor: author };

function html(options: {
  id?: string | number; title?: string; author?: string; authorId?: number; plays?: number | null;
  likes?: number | null; candidates?: { gid: string | number; title: string }[]; forbidden?: boolean;
} = {}): string {
  return `<html><script>window._SSR_DATA = ${JSON.stringify({ data: { storeState: {
    detail: {
      isForbiden: { result: options.forbidden ?? false },
      videoData: { result: {
        gid: options.id ?? longId, title: options.title ?? '原创短剧《测试故事》 第1集', publish_time: 1_794_500_000,
        cover_image_url: 'https://p26-sign.douyinpic.com/cover.jpeg?x-signature=public',
        play_count: options.plays === undefined ? 100 : options.plays,
        digg_count: options.likes === undefined ? 0 : options.likes,
        media_user: { screen_name: options.author ?? author, id: options.authorId ?? 12345 },
      } },
    },
    'user-page': { videoList: { result: options.candidates ?? [{ gid: secondId, title: '原创短剧《测试故事》 第2集' }] } },
  } } })};</script></html>`;
}

function response(body: string, status = 200): Response {
  return new Response(body, { status, headers: { 'content-type': 'text/html' } });
}

describe('public Douyin video and selected-creator metadata', () => {
  it('keeps string IDs and separate actual metrics without making a drama ranking', async () => {
    const payload = await collectDouyin({ sources: [{ videoId: longId, mode: 'video' }], fetch: async () => response(html()), now: () => new Date(observedAt) });
    expect(payload.works[0]).toMatchObject({ sourceId: longId, author, rank: null, rankChange: null, episodeCount: null, origin: 'live', observedAt });
    expect(payload.works[0]?.board).toContain('非榜单');
    expect(payload.works[0]?.description).toContain('单条公开视频，非整部剧');
    expect(payload.works[0]?.metrics.map(item => item.value)).toEqual([100, 0, null, null, null]);
    expect(payload.works[0]?.metrics[0]?.label).toBe('精选页播放');
    expect(payload.works[0]?.coverUrl).toContain('p26-sign.douyinpic.com');
    expect(payload.coverage).toContain('不是全站短剧榜');
  });

  it('monitors the current creator window rather than importing the old identity seed', async () => {
    const fetchPage = vi.fn<typeof fetch>().mockResolvedValueOnce(response(html())).mockResolvedValueOnce(response(html({ id: secondId })));
    const payload = await collectDouyin({ sources: [source], fetch: fetchPage, requestIntervalMs: 0 });
    expect(payload.works.map(item => item.sourceId)).toEqual([secondId]);
    expect(payload.coverage).toContain('公开窗口 1 条中的 1 条');
    expect(fetchPage.mock.calls[0]?.[0]).toBe(`https://jingxuan.douyin.com/m/video/${longId}`);
    expect(fetchPage.mock.calls[0]?.[1]).toMatchObject({ redirect: 'error' });
    expect(fetchPage.mock.calls[0]?.[1]?.headers).not.toHaveProperty('cookie');
  });

  it('filters tutorial posts before reading their details and preserves unknown counts', async () => {
    const first = html({ candidates: [{ gid: secondId, title: '原创短片《长夜》' }, { gid: '7707485490567548161', title: '原创短片制作教程' }] });
    const fetchPage = vi.fn<typeof fetch>().mockResolvedValueOnce(response(first)).mockResolvedValueOnce(response(html({ id: secondId, title: '原创短片《长夜》', plays: null, likes: null })));
    const payload = await collectDouyin({ sources: [{ ...source, includeKeywords: ['原创'], excludeKeywords: ['教程'] }], fetch: fetchPage, requestIntervalMs: 0 });
    expect(fetchPage).toHaveBeenCalledTimes(2);
    expect(payload.works[0]?.metrics.every(metric => metric.value === null)).toBe(true);
    expect(payload.coverage).toContain('按配置关键词筛选');
  });

  it('keeps a named series episode about a livestream while excluding its production tutorial', async () => {
    const selected = DEFAULT_MANAGED_DOUYIN_SOURCES.find(source => source.expectedAuthor === 'Fel');
    if (!selected) throw new Error('Missing verified series source');
    const title = '安宁大厦生存守则 第26集 奇怪的直播间';
    const identity = { author: selected.expectedAuthor, authorId: Number(selected.expectedAuthorId) };
    const fetchPage = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response(html({ ...identity, id: selected.videoId, candidates: [{ gid: secondId, title }, { gid: longId, title: '安宁大厦生存守则 制作教程' }] })))
      .mockResolvedValueOnce(response(html({ ...identity, id: secondId, title })));
    const payload = await collectDouyin({ sources: [selected], fetch: fetchPage, requestIntervalMs: 0 });
    expect(payload.works.map(work => work.sourceId)).toEqual([secondId]);
    expect(fetchPage).toHaveBeenCalledTimes(2);
  });

  it('refuses numeric IDs instead of rounding them into another work', () => {
    expect(() => parseDouyinPublicPage(html({ id: Number(longId) }), longId)).toThrow(/字符串作品 ID/);
  });

  it('rejects unrelated authors instead of treating a recommendation feed as their posts', async () => {
    const fetchPage = vi.fn<typeof fetch>().mockResolvedValueOnce(response(html())).mockResolvedValueOnce(response(html({ id: secondId, author: '其他作者', authorId: 9 })));
    await expect(collectDouyin({ sources: [source], fetch: fetchPage, requestIntervalMs: 0 })).rejects.toThrow(/包含其他作者/);
  });

  it('rejects an author identity change and does not continue collecting', async () => {
    const fetchPage = vi.fn<typeof fetch>().mockResolvedValue(response(html({ author: '其他作者' })));
    await expect(collectDouyin({ sources: [source], fetch: fetchPage })).rejects.toThrow(/创作者与公开页面作者不一致/);
    expect(fetchPage).toHaveBeenCalledTimes(1);
  });

  it('uses a saved author ID across nickname changes and refuses a same-name different author', async () => {
    const fetchPage = vi.fn<typeof fetch>().mockResolvedValueOnce(response(html({ author: '新昵称' }))).mockResolvedValueOnce(response(html({ id: secondId, author: '新昵称' })));
    const payload = await collectDouyin({ sources: [{ ...source, expectedAuthorId: '12345' }], fetch: fetchPage, requestIntervalMs: 0 });
    expect(payload.works[0]?.author).toBe('新昵称');
    const wrong = vi.fn<typeof fetch>().mockResolvedValue(response(html({ authorId: 666 })));
    await expect(collectDouyin({ sources: [{ ...source, expectedAuthorId: '12345' }], fetch: wrong })).rejects.toThrow(/作者 ID/);
    expect(wrong).toHaveBeenCalledTimes(1);
  });

  it('keeps 32-source coverage bounded and respects the selected source sample limit', async () => {
    const fetchPage = vi.fn<typeof fetch>().mockResolvedValue(response(html({ author: '作'.repeat(100) })));
    const payload = await collectDouyin({ sources: Array.from({ length: 32 }, () => ({ videoId: longId, mode: 'video' })), fetch: fetchPage, requestIntervalMs: 0 });
    expect(payload.coverage.length).toBeLessThanOrEqual(2000);
    expect(payload.coverage).toContain('另 24 个');
    expect(payload.works).toHaveLength(1);
    expect(fetchPage).toHaveBeenCalledTimes(1);
  });

  it('does not turn an empty layout or verification page into a successful empty batch', async () => {
    for (const body of ['<title>验证码中间页</title>', '<script>window._SSR_DATA = {"data": {"storeState": {}}}</script>', html({ title: '' }), html({ forbidden: true })]) {
      await expect(collectDouyin({ sources: [source], fetch: async () => response(body) })).rejects.toThrow(/抖音公开数据采集失败/);
    }
  });

  it('never evaluates executable script text or accepts mismatched work IDs', () => {
    expect(() => parseDouyinPublicPage('<script>window._SSR_DATA = (globalThis.__collectorExecuted=true,{})</script>', longId)).toThrow(/格式已变化/);
    expect('__collectorExecuted' in globalThis).toBe(false);
    expect(() => parseDouyinPublicPage(html({ id: secondId }), longId)).toThrow(/作品 ID 与请求不一致/);
  });

  it('fails the complete collection on access restriction without repeated retries', async () => {
    const fetchPage = vi.fn<typeof fetch>().mockResolvedValue(response('denied', 403));
    await expect(collectDouyin({ sources: [source], fetch: fetchPage })).rejects.toThrow(/HTTP 403/);
    expect(fetchPage).toHaveBeenCalledTimes(1);
  });

  it('bounds page sizes and rejects non-HTML content', async () => {
    await expect(collectDouyin({ sources: [source], maxResponseBytes: 1024, fetch: async () => response('x'.repeat(1025)) })).rejects.toThrow(/超过大小限制/);
    await expect(collectDouyin({ sources: [source], fetch: async () => new Response('{}', { headers: { 'content-type': 'application/json' } }) })).rejects.toThrow(/没有返回公开 HTML/);
  });

  it('rejects unsafe source input before any network access', async () => {
    const fetchPage = vi.fn<typeof fetch>();
    await expect(collectDouyin({ sources: [{ videoId: 'https://127.0.0.1/private', mode: 'video' }], fetch: fetchPage })).rejects.toThrow(/字符串作品 ID/);
    await expect(collectDouyin({ sources: [], fetch: fetchPage })).rejects.toThrow(/sources/);
    expect(fetchPage).not.toHaveBeenCalled();
  });

  it('honors cancellation without requesting another source', async () => {
    const controller = new AbortController(); controller.abort();
    const fetchPage = vi.fn<typeof fetch>();
    await expect(collectDouyin({ sources: [source], signal: controller.signal, fetch: fetchPage })).rejects.toThrow();
    expect(fetchPage).not.toHaveBeenCalled();
  });

  it('retries transient fetch failures on the same URL before publishing the verified page', async () => {
    const transient = new TypeError('fetch failed', { cause: Object.assign(new Error('socket closed'), { code: 'ECONNRESET' }) });
    const fetchPage = vi.fn<typeof fetch>().mockRejectedValueOnce(transient).mockResolvedValueOnce(response(html()));
    const payload = await collectDouyin({ sources: [{ ...source, mode: 'video' }], fetch: fetchPage, requestIntervalMs: 0, retryDelayMs: 0 });
    expect(fetchPage).toHaveBeenCalledTimes(2);
    expect(fetchPage.mock.calls[0]?.[0]).toBe(fetchPage.mock.calls[1]?.[0]);
    expect(payload.works).toHaveLength(1);
    expect(payload.coverage).toContain('2 次官方公开页面请求');
  });

  it.each([429, 500, 503])('retries HTTP %i with a bounded attempt count', async status => {
    const fetchPage = vi.fn<typeof fetch>().mockResolvedValueOnce(response('temporary', status)).mockResolvedValueOnce(response(html()));
    const payload = await collectDouyin({ sources: [{ ...source, mode: 'video' }], fetch: fetchPage, requestIntervalMs: 0, retryDelayMs: 0 });
    expect(payload.works).toHaveLength(1);
    expect(fetchPage).toHaveBeenCalledTimes(2);
    const unavailable = vi.fn<typeof fetch>().mockImplementation(async () => response('temporary', status));
    await expect(collectDouyin({ sources: [source], fetch: unavailable, requestIntervalMs: 0, retryDelayMs: 0 })).rejects.toThrow(new RegExp(`HTTP ${status}.*3 次尝试`));
    expect(unavailable).toHaveBeenCalledTimes(3);
  });

  it('creates a separate deadline for each timeout attempt', async () => {
    const signals: AbortSignal[] = [];
    const fetchPage = vi.fn<typeof fetch>().mockImplementationOnce(async (_url, init) => {
      const signal = init?.signal;
      if (!signal) throw new Error('Expected deadline signal');
      signals.push(signal);
      return await new Promise<Response>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    }).mockImplementationOnce(async (_url, init) => {
      if (!init?.signal) throw new Error('Expected second deadline signal');
      signals.push(init.signal);
      return response(html());
    });
    const result = await collectDouyin({ sources: [{ ...source, mode: 'video' }], fetch: fetchPage, requestTimeoutMs: 100, requestIntervalMs: 0, retryDelayMs: 0 });
    expect(signals[0]?.aborted).toBe(true);
    expect(signals[1]?.aborted).toBe(false);
    expect(signals[0]).not.toBe(signals[1]);
    expect(result.works).toHaveLength(1);
  });

  it('retries a transient body-read failure and identifies the exact candidate when retries exhaust', async () => {
    const transient = Object.assign(new Error('body socket closed'), { code: 'UND_ERR_SOCKET' });
    const broken = () => new Response(new ReadableStream({ start(controller) { controller.error(transient); } }), { headers: { 'content-type': 'text/html' } });
    const recovered = vi.fn<typeof fetch>().mockResolvedValueOnce(broken()).mockResolvedValueOnce(response(html()));
    await expect(collectDouyin({ sources: [{ ...source, mode: 'video' }], fetch: recovered, requestIntervalMs: 0, retryDelayMs: 0 })).resolves.toHaveProperty('works.length', 1);
    expect(recovered).toHaveBeenCalledTimes(2);
    const failed = vi.fn<typeof fetch>().mockResolvedValueOnce(response(html())).mockImplementation(async () => broken());
    const result = collectDouyin({ sources: [source], fetch: failed, requestIntervalMs: 0, retryDelayMs: 0 });
    await expect(result).rejects.toThrow(`来源 「${author}」`);
    await expect(result).rejects.toThrow(`视频 ${secondId}，read 阶段`);
    await expect(result).rejects.toThrow('3 次尝试，原因 UND_ERR_SOCKET');
    expect(failed).toHaveBeenCalledTimes(4);
  });

  it('keeps the timeout active through body reads and reports the read stage', async () => {
    const fetchPage = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
      const signal = init?.signal;
      if (!signal) throw new Error('Expected deadline signal');
      return new Response(new ReadableStream({
        start(controller) { signal.addEventListener('abort', () => controller.error(signal.reason), { once: true }); },
      }), { headers: { 'content-type': 'text/html' } });
    });
    await expect(collectDouyin({ sources: [source], fetch: fetchPage, requestTimeoutMs: 100, requestRetries: 1, retryDelayMs: 0, requestIntervalMs: 0 }))
      .rejects.toThrow(/read 阶段：请求超时（2 次尝试，原因 TimeoutError）/);
    expect(fetchPage).toHaveBeenCalledTimes(2);
  });

  it('preserves access refusal when cancelling the response body also fails', async () => {
    const fetchPage = vi.fn<typeof fetch>().mockImplementation(async () => new Response(new ReadableStream({
      cancel() { throw Object.assign(new Error('socket closed while cleaning up'), { code: 'ECONNRESET' }); },
    }), { status: 403, headers: { 'content-type': 'text/html' } }));
    await expect(collectDouyin({ sources: [source], fetch: fetchPage, requestIntervalMs: 0, retryDelayMs: 0 })).rejects.toThrow(/HTTP 403.*1 次尝试/);
    expect(fetchPage).toHaveBeenCalledTimes(1);
  });

  it('does not retry access restrictions, redirects or structurally invalid pages', async () => {
    for (const result of [response('missing', 404), response('<title>verify</title>'), response(html({ id: secondId })),
      new Response('{}', { headers: { 'content-type': 'application/json' } })]) {
      const fetchPage = vi.fn<typeof fetch>().mockResolvedValueOnce(result);
      await expect(collectDouyin({ sources: [source], fetch: fetchPage, retryDelayMs: 0 })).rejects.toThrow(/抖音公开数据采集失败/);
      expect(fetchPage).toHaveBeenCalledTimes(1);
    }
    const redirected = vi.fn<typeof fetch>().mockRejectedValue(new TypeError('fetch failed', { cause: new Error('unexpected redirect') }));
    await expect(collectDouyin({ sources: [source], fetch: redirected, retryDelayMs: 0 })).rejects.toThrow(/fetch 阶段/);
    expect(redirected).toHaveBeenCalledTimes(1);
  });

  it('stops immediately when the caller cancels a request or retry delay', async () => {
    const duringFetch = new AbortController();
    const reason = new Error('stop collecting');
    const abortFetch = vi.fn<typeof fetch>().mockImplementation(async () => { duringFetch.abort(reason); throw reason; });
    await expect(collectDouyin({ sources: [source], fetch: abortFetch, signal: duringFetch.signal, retryDelayMs: 0 })).rejects.toBe(reason);
    expect(abortFetch).toHaveBeenCalledTimes(1);
    const duringBackoff = new AbortController();
    const transient = Object.assign(new Error('socket failed'), { code: 'ECONNRESET' });
    const retryFetch = vi.fn<typeof fetch>().mockImplementation(async () => {
      setTimeout(() => duringBackoff.abort(reason), 10);
      throw transient;
    });
    await expect(collectDouyin({ sources: [source], fetch: retryFetch, signal: duringBackoff.signal, retryDelayMs: 1000 })).rejects.toThrow(/aborted/i);
    expect(retryFetch).toHaveBeenCalledTimes(1);
  });

  it('validates retry limits before network access and can disable retries explicitly', async () => {
    const fetchPage = vi.fn<typeof fetch>().mockRejectedValue(Object.assign(new Error('network failure'), { code: 'ECONNRESET' }));
    await expect(collectDouyin({ sources: [source], fetch: fetchPage, requestRetries: 4 })).rejects.toThrow(/requestRetries/);
    await expect(collectDouyin({ sources: [source], fetch: fetchPage, retryDelayMs: -1 })).rejects.toThrow(/retryDelayMs/);
    expect(fetchPage).not.toHaveBeenCalled();
    await expect(collectDouyin({ sources: [source], fetch: fetchPage, requestRetries: 0 })).rejects.toThrow(/1 次尝试，原因 ECONNRESET/);
    expect(fetchPage).toHaveBeenCalledTimes(1);
  });

  it('does not publish a batch when cancellation arrives between cached sources or before return', async () => {
    for (const sourceCount of [1, 2]) {
      const controller = new AbortController();
      const reason = new Error('stop before publishing');
      const fetchPage = vi.fn<typeof fetch>().mockResolvedValue(response(html()));
      await expect(collectDouyin({ sources: Array.from({ length: sourceCount }, () => ({ ...source, mode: 'video' })),
        fetch: fetchPage, signal: controller.signal,
        onVerifiedSource: () => sourceCount === 2 ? queueMicrotask(() => controller.abort(reason)) : controller.abort(reason),
      })).rejects.toBe(reason);
      expect(fetchPage).toHaveBeenCalledTimes(1);
    }
  });
});

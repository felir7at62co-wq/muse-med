import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { DataRepository } from '../src/server/repository.ts';
import { createApp } from '../src/server/app.ts';
import { MetricRefresher } from '../src/server/metrics/refresher.ts';
import { createFanqieMetricSource, createHongguoMetricSource, createQimaoMetricSource, type MetricSource } from '../src/server/metrics/sources.ts';
import type { Metric, Platform, UserIdentity, Work } from '../src/shared/types.ts';

const HOUR = 3_600_000;
const at = (hours: number) => new Date(Date.parse('2026-11-15T00:00:00.000Z') + hours * HOUR).toISOString();
const id = (n: number) => `95000000000000000${String(n).padStart(2, '0')}`;

function work(platform: Platform, sourceId: string, observedAt: string, options: { board?: string; metrics?: Metric[] } = {}): Work {
  return {
    id: `${platform}:${sourceId}`, sourceId, platform, kind: platform === 'hongguo' ? 'drama' : 'novel', title: `指标作品${sourceId.slice(-2)}`, author: null,
    description: '指标刷新测试', coverUrl: null, sourceUrl: 'https://example.com/work', tags: [], category: '都市', episodeCount: null, wordCount: null,
    serialStatus: null, publishedAt: null, metrics: options.metrics ?? [{ key: 'heat', label: '热度', value: null }, { key: 'collection', label: '收藏', value: null }],
    rank: options.board ? 1 : null, rankChange: null, board: options.board ?? '', origin: 'live', observedAt, sourceUpdatedAt: null,
  };
}

function response(body: string, type: string, status = 200): Response {
  return new Response(body, { status, headers: { 'content-type': type } });
}

describe('detail-page metric sources', () => {
  const options = { requestTimeoutMs: 5_000, maxResponseBytes: 1_048_576, now: () => new Date(at(0)) };

  it('reads Fanqie readers from the book information API and reports a removed book as missing', async () => {
    const requested: string[] = [];
    const replies = [
      JSON.stringify({ code: 0, data: { bookId: id(1), readCount: '395015', bookName: '书' } }),
      JSON.stringify({ code: -1, message: '查无此书', data: null }),
      JSON.stringify({ code: 0, data: { bookId: id(9), readCount: '1' } }),
    ];
    const source = createFanqieMetricSource({ ...options, fetch: async url => { requested.push(String(url)); return response(replies.shift()!, 'application/json'); } });
    expect(await source.read(work('fanqie', id(1), at(0)), AbortSignal.timeout(5_000)))
      .toEqual({ measuredAt: at(0), metrics: [{ key: 'currentReaders', label: '在读人数', value: 395015 }] });
    expect(await source.read(work('fanqie', id(2), at(0)), AbortSignal.timeout(5_000))).toBeNull();
    await expect(source.read(work('fanqie', id(3), at(0)), AbortSignal.timeout(5_000))).rejects.toThrow('identity');
    expect(requested[0]).toBe(`https://fanqienovel.com/api/book/info?bookId=${id(1)}`);
  });

  it('reads Hongguo heat, saves, likes, rating and review count from the detail page route data', async () => {
    // Observed on 2026-11-15: some detail pages end while reviews are still streaming; the series counts are already present.
    const streaming = `<script data-fn-name="mergeLoaderData" data-fn-args='${JSON.stringify(['detail_page', [{ key: 'reviews', routerDataFnName: 's', routerDataFnArgs: ['reviews'] }]])}'></script>`;
    const page = (seriesId: string, social: unknown, tail = '') => `<html><script>window._ROUTER_DATA = ${JSON.stringify({ loaderData: { detail_layout: null,
      detail_page: { isSuccess: true, seriesDetail: { series_id: seriesId, series_name: '剧' }, seriesSocialInfo: social, recommendations: [] } } })}</script>${tail}</html>`;
    const replies = [
      response(page(id(1), { series_favorite_count: '963000', series_like_count: '1637000', hot_score_data: { score: 87525086, text: '8752万热度' },
        rating: 9.4, rating_count: '7971', reviews: { total_count: '2016', reviews: [] } }, streaming), 'text/html'),
      response(page(id(2), { series_like_count: '12', rating: 'nine', reviews: { total_count: -1 } }), 'text/html'),
      response('', 'text/html', 404),
      response(page(id(9), {}), 'text/html'),
      response(page(id(5), undefined, streaming), 'text/html'),
    ];
    const source = createHongguoMetricSource({ ...options, fetch: async () => replies.shift()! });
    const values = (reading: Awaited<ReturnType<MetricSource['read']>>) => reading?.metrics.map(metric => [metric.key, metric.value]);
    expect(values(await source.read(work('hongguo', id(1), at(0)), AbortSignal.timeout(5_000)))).toEqual([['heat', 87525086], ['collection', 963000], ['likes', 1637000],
      ['rating', 9.4], ['rating_count', 7971], ['review_count', 2016]]);
    expect(values(await source.read(work('hongguo', id(2), at(0)), AbortSignal.timeout(5_000)))).toEqual([['heat', null], ['collection', null], ['likes', 12],
      ['rating', null], ['rating_count', null], ['review_count', null]]);
    expect(await source.read(work('hongguo', id(3), at(0)), AbortSignal.timeout(5_000))).toBeNull();
    await expect(source.read(work('hongguo', id(4), at(0)), AbortSignal.timeout(5_000))).rejects.toThrow('identity');
    await expect(source.read(work('hongguo', id(5), at(0)), AbortSignal.timeout(5_000))).rejects.toThrow();
  });

  it('reads Qimao popularity and reads with the unit the page renders, leaving unrendered values unknown', async () => {
    const page = (bookId: string, rendered: string) => `<html><body><div class="statistics">${rendered}</div>`
      + `<script>window.__NUXT__=(function(E,F){E.bookDetail={book_id:"${bookId}",hot_value:"1935.7",pursue_count:"48.6"};E.authorOtherBook=F;F[0]={id:"1"};return {state:{common:{bookRelatedInfo:E}}};}({},Array(1)));</script></body></html>`;
    const replies = [page('1834789', '<span>48.6万</span><span>次阅读</span> <span>1935.7万累计人气值</span>'), page('1834790', '<span>累计人气值</span>'), page('1', '')];
    const source = createQimaoMetricSource({ ...options, fetch: async () => new Response(replies.shift()!, { headers: { 'content-type': 'text/html; charset=utf-8' } }) });
    const read = async (sourceId: string) => (await source.read(work('qimao', sourceId, at(0)), AbortSignal.timeout(5_000)))?.metrics.map(metric => [metric.key, metric.value]);
    expect(await read('1834789')).toEqual([['cumulativePopularity', 19357000], ['readOccurrences', 486000]]);
    expect(await read('1834790')).toEqual([['cumulativePopularity', null], ['readOccurrences', null]]);
    await expect(read('1834791')).rejects.toThrow('identity');
  });
});

describe('scheduled metric refresh', () => {
  let database: PGlite, repository: DataRepository, now: number;
  let readings: Map<string, number | null | Error>;
  let reads: string[];
  const source: MetricSource = {
    platform: 'hongguo',
    async read(item) {
      reads.push(item.sourceId);
      const value = readings.get(item.sourceId);
      if (value instanceof Error) throw value;
      if (value === null) return null;
      return { measuredAt: new Date(now).toISOString(), metrics: [{ key: 'heat', label: '热度', value: value ?? 1 }, { key: 'likes', label: '点赞', value: 7 }] };
    },
  };
  const collections = { busy: false, requestTask: async (_platform: Platform, task: (signal: AbortSignal) => Promise<void>) => {
    if (collections.busy) return false;
    void task(new AbortController().signal);
    return true;
  } };
  const refresher = () => new MetricRefresher(repository, collections, { hongguo: source },
    { batchSize: 3, intervalMs: 10 * 60_000, maxAgeMs: 72 * HOUR, retryMs: 6 * HOUR, requestIntervalMs: 0, now: () => now });
  const ingest = (item: Work) => repository.ingestBatch({ platform: item.platform, observedAt: item.observedAt, coverage: '测试', works: [item] });
  const current = async (sourceId: string) => (await repository.getWork(`hongguo:${sourceId}`))!.work;

  beforeEach(async () => {
    database = new PGlite(); repository = new DataRepository(database); await repository.initialize({ seedDemo: false });
    now = Date.parse(at(200)); readings = new Map(); reads = []; collections.busy = false;
    await ingest(work('hongguo', id(1), at(150)));
    await ingest(work('hongguo', id(2), at(100)));
    await ingest(work('hongguo', id(3), at(10), { metrics: [{ key: 'heat', label: '热度', value: 5 }] }));
    await ingest(work('hongguo', id(4), at(190), { metrics: [{ key: 'heat', label: '热度', value: 6 }] }));
    await ingest(work('hongguo', id(5), at(1)));
    await ingest(work('hongguo', id(6), at(199), { board: '综合热播榜', metrics: [{ key: 'heat', label: '热度', value: null }] }));
  }, 30_000);
  afterEach(async () => { await database.close(); });

  it('reads never-measured works first, then the oldest readings, and never ranked or fresh works', async () => {
    const job = refresher(); await job.initialize();
    readings.set(id(2), 42);
    expect(await job.request('hongguo')).toBe(true); await job.waitForIdle();
    expect(reads).toEqual([id(1), id(2), id(5)]);
    const refreshed = await current(id(2));
    expect(refreshed.observedAt).toBe(at(200));
    expect(refreshed.metricsObservedAt).toBeUndefined();
    expect(refreshed.metrics.map(metric => [metric.key, metric.value])).toEqual([['heat', 42], ['collection', null], ['likes', 7]]);
    expect((await job.list()).find(status => status.platform === 'hongguo')).toMatchObject({ state: 'success', due: 1, refreshed: 3, lastRunRefreshed: 3, lastRunFailed: 0,
      nextRunAt: new Date(now + 10 * 60_000).toISOString() });
    reads = [];
    expect(await job.request('hongguo')).toBe(true); await job.waitForIdle();
    expect(reads).toEqual([id(3)]);
  });

  it('waits before retrying failed or missing works and retries them after the retry time', async () => {
    const job = refresher(); await job.initialize();
    readings.set(id(1), new Error('page changed')); readings.set(id(2), null);
    await job.request('hongguo'); await job.waitForIdle();
    expect((await job.list()).find(status => status.platform === 'hongguo')).toMatchObject({ state: 'failed', lastRunRefreshed: 1, lastRunFailed: 1 });
    reads = []; readings.clear();
    await job.request('hongguo'); await job.waitForIdle();
    expect(reads).toEqual([id(3)]);
    now += 6 * HOUR; reads = [];
    await job.request('hongguo'); await job.waitForIdle();
    expect(reads).toEqual([id(1), id(2)]);
  });

  it('keeps refreshed metrics when discovery lists the work again without metrics, and records the listing as observed', async () => {
    const job = refresher(); await job.initialize();
    readings.set(id(1), 900);
    await job.request('hongguo'); await job.waitForIdle();
    await repository.ingestDiscoveryPage({ platform: 'hongguo', observedAt: at(205), coverage: '目录', works: [work('hongguo', id(1), at(205))] }, async () => {});
    const listed = await current(id(1));
    expect(listed.observedAt).toBe(at(205));
    expect(listed.metricsObservedAt).toBe(at(200));
    expect(listed.metrics.find(metric => metric.key === 'heat')?.value).toBe(900);
    const observations = (await repository.getWork(`hongguo:${id(1)}`))!.observations;
    expect(observations.at(-1)).toMatchObject({ observedAt: at(205) });
    expect(observations.at(-1)!.metrics.every(metric => metric.value === null)).toBe(true);
  });

  it('leaves the platform to its running job and runs only when due on schedule', async () => {
    const job = refresher(); await job.initialize();
    collections.busy = true;
    expect(await job.request('hongguo')).toBe(false);
    collections.busy = false;
    await job.request('hongguo'); await job.waitForIdle();
    reads = [];
    expect(await job.request('hongguo', true)).toBe(false);
    now += 10 * 60_000;
    expect(await job.request('hongguo', true)).toBe(true); await job.waitForIdle();
    expect(reads.length).toBeGreaterThan(0);
    await expect(job.request('fanqie')).rejects.toThrow('指标来源');
  });

  it('exposes progress and manual runs to administrators only', async () => {
    const job = refresher(); await job.initialize();
    let user: UserIdentity = { id: 'member', name: '成员', role: 'member' };
    const { app } = createApp({ repository, metricRefresh: job, identity: async () => user, mode: 'server', publicOrigin: 'https://data.example.com', port: 4317 });
    const call = (path: string, init: RequestInit = {}) => app.request(`http://127.0.0.1:4317${path}`, { ...init, headers: { origin: 'https://data.example.com', 'content-type': 'application/json', ...init.headers } });
    expect((await call('/api/admin/metric-refresh')).status).toBe(403);
    expect((await call('/api/admin/metric-refresh/hongguo/run', { method: 'POST', body: '{}' })).status).toBe(403);
    user = { id: 'admin', name: '管理员', role: 'admin' };
    const statuses = await (await call('/api/admin/metric-refresh')).json();
    expect(statuses.map((status: { platform: string; state: string }) => [status.platform, status.state])).toEqual([['hongguo', 'idle'], ['douyin', 'not_configured'], ['fanqie', 'not_configured'], ['qimao', 'not_configured']]);
    expect((await call('/api/admin/metric-refresh/fanqie/run', { method: 'POST', body: '{}' })).status).toBe(503);
    expect((await call('/api/admin/metric-refresh/hongguo/run', { method: 'POST', body: '{}' })).status).toBe(202);
    await job.waitForIdle();
    expect(reads).toEqual([id(1), id(2), id(5)]);
  });
});

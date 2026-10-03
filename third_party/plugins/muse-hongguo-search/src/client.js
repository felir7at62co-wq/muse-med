/** Bounded, read-only client for official public Hongguo metadata pages. */
import { setTimeout as delay } from 'node:timers/promises';
import { BOARDS, ORIGIN, parseRanking, parseDetail, parseSearch, IncompletePageError } from './parser.js';

const DEFAULTS = Object.freeze({ requestTimeoutMs: 15000, maxResponseBytes: 8388608, cacheTtlMs: 300000, maxPages: 5, requestIntervalMs: 1000, maxCacheEntries: 128, incompletePageRetries: 2 });
const LIMITS = { requestTimeoutMs: [100, 120000], maxResponseBytes: [1024, 33554432], cacheTtlMs: [0, 3600000], maxPages: [1, 20], requestIntervalMs: [0, 60000], maxCacheEntries: [1, 1024], incompletePageRetries: [0, 4] };
const note = '仅覆盖所选官方公开热播榜的已抓取分页，不是红果全库；榜单按热度排序，已遍历所有配置范围分页。收藏展示值可能取整，不同页面不是同一时刻快照。';

/** Validate deployment settings before any network access. */
export function resolveConfig(config = {}) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new TypeError('Plugin config must be an object');
  const result = { ...DEFAULTS };
  for (const [key, value] of Object.entries(config)) {
    const range = Object.hasOwn(LIMITS, key) ? LIMITS[key] : null;
    if (!range) throw new TypeError(`Unknown plugin config: ${key}`);
    if (!Number.isInteger(value) || value < range[0] || value > range[1]) throw new TypeError(`${key} must be an integer in ${range[0]}..${range[1]}`);
    result[key] = value;
  }
  return result;
}
function pagination(options) {
  const limit = options.limit ?? 20, offset = options.offset ?? 0;
  if (!Number.isInteger(limit) || limit < 1 || limit > 400 || !Number.isInteger(offset) || offset < 0 || offset > 100000) throw new TypeError('limit must be 1..400 and offset 0..100000');
  return { limit, offset };
}
function assertRefresh(value) { if (value !== undefined && typeof value !== 'boolean') throw new TypeError('refresh must be boolean'); }
function boardsFor(boards) {
  if (boards === undefined) return [...BOARDS];
  if (!Array.isArray(boards) || !boards.length || boards.some(x => !BOARDS.includes(x))) throw new TypeError('boards must be a non-empty list of supported boards');
  return [...new Set(boards)];
}

/** Merge repeated series conservatively and preserve every source observation. */
export function deduplicate(items) {
  const result = new Map();
  for (const item of items) {
    const { observation, ...value } = item;
    const existing = result.get(item.seriesId);
    if (!existing) result.set(item.seriesId, { ...value, observations: [observation], conflicts: [], collectionSelection: 'minimum_observed' });
    else {
      existing.observations.push(observation);
      if (item.collection.value !== null && (existing.collection.value === null || item.collection.value < existing.collection.value)) existing.collection = item.collection;
      const counts = [...new Set(existing.observations.map(x => x.collection.value).filter(x => x !== null))];
      existing.conflicts = counts.length > 1 ? [{ field: 'collection', values: counts.sort((a, b) => a - b) }] : [];
    }
  }
  return [...result.values()];
}

/** Compare all observed collection counts; rounded values close to the threshold remain uncertain. */
export function thresholdStatus(item, minimum) {
  const counts = item.observations.map(x => x.collection).filter(x => x.value !== null);
  if (!counts.length) return 'unknown';
  if (counts.length !== item.observations.length) return 'uncertain';
  const states = counts.map(x => {
    if (!x.approximate) return x.value >= minimum ? 'meets' : 'below';
    const step = x.precisionStep ?? 0;
    if (x.value > minimum && x.value - step >= minimum) return 'meets';
    if (x.value < minimum && x.value + step <= minimum) return 'below';
    return 'uncertain';
  });
  if (states.every(x => x === 'meets')) return 'meets';
  if (states.every(x => x === 'below')) return 'below';
  return 'uncertain';
}

/** Await an owned operation without leaving abort listeners attached. */
function abortable(promise, signal) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const aborted = () => { signal.removeEventListener('abort', aborted); reject(signal.reason); };
    signal.addEventListener('abort', aborted, { once: true });
    promise.then(value => { signal.removeEventListener('abort', aborted); resolve(value); },
      error => { signal.removeEventListener('abort', aborted); reject(error); });
  });
}

/** Network/cache owner. Each call has independent cancellation; dispose aborts all work. */
export class HongguoClient {
  constructor(config = {}, dependencies = {}) {
    this.config = resolveConfig(config);
    this.fetch = dependencies.fetch ?? globalThis.fetch;
    this.now = dependencies.now ?? Date.now;
    this.cache = new Map();
    this.queue = Promise.resolve();
    this.lastRequestAt = -Infinity;
    this.lifetime = new AbortController();
  }

  dispose() { this.lifetime.abort(); this.cache.clear(); }

  async page(path, refresh, signal) {
    assertRefresh(refresh);
    const url = new URL(path, ORIGIN);
    if (url.origin !== ORIGIN || !/^\/(rank\/hot-(?:drama|real-drama|ai-drama|comic-drama)|detail|search\/[^/]+)$/.test(url.pathname)) throw new Error('Only supported official public URLs are allowed');
    const activeSignal = signal ? AbortSignal.any([signal, this.lifetime.signal]) : this.lifetime.signal;
    activeSignal.throwIfAborted();
    const cached = this.cache.get(url.href);
    if (!refresh && cached && this.now() - cached.at < this.config.cacheTtlMs) return { ...cached.value, fromCache: true };
    let release;
    const previous = this.queue;
    this.queue = new Promise(resolve => { release = resolve; });
    let acquired = false;
    try {
      await abortable(previous, activeSignal);
      acquired = true;
      activeSignal.throwIfAborted();
      const wait = this.config.requestIntervalMs - (this.now() - this.lastRequestAt);
      if (wait > 0) await delay(wait, undefined, { signal: activeSignal });
      this.lastRequestAt = this.now();
      const requestSignal = AbortSignal.any([activeSignal, AbortSignal.timeout(this.config.requestTimeoutMs)]);
      const response = await this.fetch(url.href, { signal: requestSignal, redirect: 'error', headers: { accept: 'text/html', 'user-agent': 'Muse-Hongguo-Search/0.1 (+https://github.com/felir7at62co-wq/muse-hongguo-serch)' } });
      const rejectResponse = async message => { await response.body?.cancel(); throw new Error(message); };
      if (!response.ok) await rejectResponse(`Official site HTTP ${response.status}`);
      if (response.redirected || (response.url && new URL(response.url).origin !== ORIGIN)) await rejectResponse('Unexpected response redirect');
      const contentType = response.headers.get('content-type') ?? '';
      if (!contentType.toLowerCase().includes('text/html')) await rejectResponse('Expected a public HTML page');
      const contentLength = Number(response.headers.get('content-length'));
      if (Number.isFinite(contentLength) && contentLength > this.config.maxResponseBytes) { await response.body?.cancel(); throw new Error('Response exceeds maxResponseBytes'); }
      if (!response.body) throw new Error('Empty HTML response');
      const reader = response.body.getReader();
      const chunks = [];
      let size = 0;
      try {
        while (true) {
          requestSignal.throwIfAborted();
          const chunk = await abortable(reader.read(), requestSignal);
          if (chunk.done) break;
          size += chunk.value.byteLength;
          if (size > this.config.maxResponseBytes) throw new Error('Response exceeds maxResponseBytes');
          chunks.push(chunk.value);
        }
      } catch (error) { await reader.cancel().catch(() => {}); throw error; }
      finally { reader.releaseLock(); }
      requestSignal.throwIfAborted();
      const html = Buffer.concat(chunks).toString('utf8');
      const value = { html, sourceUrl: url.href, fetchedAt: new Date(this.now()).toISOString(), fromCache: false };
      if (this.config.cacheTtlMs > 0) {
        this.cache.delete(url.href);
        this.cache.set(url.href, { at: this.now(), value });
        while (this.cache.size > this.config.maxCacheEntries) this.cache.delete(this.cache.keys().next().value);
      }
      return value;
    } finally {
      // An aborted waiter must not unlock successors ahead of its predecessor.
      if (acquired) release();
      else void previous.then(release);
    }
  }

  parseFetched(parser, fetched, options) {
    try { return parser(fetched.html, { ...options, ...fetched }); }
    catch (error) { this.cache.delete(fetched.sourceUrl); throw error; }
  }

  async loadParsed(path, refresh, parser, options, signal) {
    for (let attempt = 0; ; attempt++) {
      const fetched = await this.page(path, attempt > 0 || refresh, signal);
      try { return { fetched: { ...fetched, attempts: attempt + 1 }, parsed: this.parseFetched(parser, fetched, options) }; }
      catch (error) {
        if (!(error instanceof IncompletePageError) || attempt >= this.config.incompletePageRetries) throw error;
        // A retry only repairs an incomplete streaming response. Access errors are never retried.
        signal?.throwIfAborted(); this.lifetime.signal.throwIfAborted();
      }
    }
  }

  async rankings(options = {}, signal) {
    const boards = boardsFor(options.boards);
    assertRefresh(options.refresh);
    const pages = [], failures = [], all = [];
    let expected = 0, truncated = false, allCached = true;
    for (const board of boards) {
      let total = this.config.maxPages;
      for (let page = 1; page <= Math.min(total, this.config.maxPages); page++) {
        signal?.throwIfAborted(); this.lifetime.signal.throwIfAborted();
        const path = `/rank/${board}${page === 1 ? '' : `?page=${page}`}`;
        try {
          const { fetched, parsed } = await this.loadParsed(path, options.refresh, parseRanking, { board, page }, signal);
          total = parsed.totalPages;
          truncated ||= total > this.config.maxPages;
          all.push(...parsed.items);
          allCached &&= fetched.fromCache;
          pages.push({ board, page, sourceUrl: fetched.sourceUrl, fetchedAt: fetched.fetchedAt, updateDate: parsed.updateDate, fromCache: fetched.fromCache, attempts: fetched.attempts, itemCount: parsed.items.length });
        } catch (error) {
          if (signal?.aborted || this.lifetime.signal.aborted) throw error;
          failures.push({ board, page, sourceUrl: `${ORIGIN}${path}`, error: error instanceof Error ? error.message : String(error) });
        }
      }
      expected += total;
    }
    if (!pages.length) throw new Error(`All official ranking pages failed: ${failures.map(x => `${x.board}/${x.page}: ${x.error}`).join('; ')}`);
    const items = deduplicate(all);
    return { scope: 'public_rankings', items, coverage: { boards, pagesFetched: pages.length, pagesExpected: expected, uniqueSeries: items.length, complete: failures.length === 0 && !truncated, failures, truncated, pages }, fetchedAt: new Date(this.now()).toISOString(), fromCache: allCached, note };
  }

  async search(options, signal) {
    if (typeof options?.query !== 'string' || !options.query.trim() || options.query.length > 100) throw new TypeError('query must be 1..100 characters');
    const query = options.query.trim();
    if (/[\u0000-\u001f\u007f]/.test(query)) throw new TypeError('query must not contain control characters');
    const { limit, offset } = pagination({ ...options, limit: options.limit ?? 10 });
    if (limit > 10) throw new TypeError('search limit must be 1..10');
    const { fetched, parsed } = await this.loadParsed(`/search/${encodeURIComponent(query)}`, options.refresh, parseSearch, { query }, signal);
    return { scope: 'public_keyword_search_initial_window', query, items: parsed.items.slice(offset, offset + limit), availableInWindow: parsed.items.length, sourceReportedTotal: parsed.sourceReportedTotal, offset, limit, sourceUrl: fetched.sourceUrl, fetchedAt: fetched.fetchedAt, fromCache: fetched.fromCache,
      complete: false, truncated: parsed.sourceReportedTotal !== null && Number(parsed.sourceReportedTotal) > parsed.items.length, note: '官网关键词搜索首屏结果（当前最多10条），可能含语义推荐，不保证精确标题匹配；offset/limit 只切分已返回窗口，未验证搜索翻页，不保证全量命中。' };
  }

  async detail(options, signal) {
    if (typeof options?.seriesId !== 'string' || !/^\d{1,30}$/.test(options.seriesId)) throw new TypeError('seriesId must be a decimal string');
    const { fetched, parsed } = await this.loadParsed(`/detail?series_id=${options.seriesId}`, options.refresh, parseDetail, { seriesId: options.seriesId }, signal);
    return { ...parsed, fromCache: fetched.fromCache };
  }

  async collections(options = {}, signal) {
    const minCollections = options.minCollections ?? 1000000;
    if (!Number.isSafeInteger(minCollections) || minCollections < 0) throw new TypeError('minCollections must be a nonnegative safe integer');
    if (options.includeUncertain !== undefined && typeof options.includeUncertain !== 'boolean') throw new TypeError('includeUncertain must be boolean');
    const { limit, offset } = pagination(options);
    const data = await this.rankings(options, signal);
    const sorted = data.items.map(item => ({ ...item, thresholdStatus: thresholdStatus(item, minCollections) }))
      .sort((a, b) => (b.collection.value ?? -1) - (a.collection.value ?? -1) || a.seriesId.localeCompare(b.seriesId));
    const matched = sorted.filter(item => item.thresholdStatus === 'meets');
    const uncertain = sorted.filter(item => item.thresholdStatus === 'uncertain' || item.thresholdStatus === 'unknown');
    const results = options.includeUncertain ? sorted.filter(item => item.thresholdStatus !== 'below') : matched;
    return { ...data, items: results.slice(offset, offset + limit), minCollections, totalMatched: matched.length, totalUncertain: uncertain.length,
      uncertain: uncertain.map(item => ({ seriesId: item.seriesId, title: item.title, collection: item.collection, thresholdStatus: item.thresholdStatus, conflicts: item.conflicts })), offset, limit,
      thresholdNote: 'meets 是页面数值筛选，非后台精确人数证明。万/亿缩写在阈值上下一个显示单位内、跨页冲突跨越阈值或缺失值，列为待核实；默认不混入达标列表。' };
  }
}

/** Public metadata collection with bounded requests, explicit coverage and expiring per-page caches. */
import { setTimeout as delay } from 'node:timers/promises';
import { ORIGIN, CHANNELS, BOARDS, PERIODS, METRIC_LABELS, QimaoError, bookId, parseRanking, parseLibrary, parseDetail } from './parser.js';
import { abortable, readMetadata } from './transport.js';

const defaults = Object.freeze({ requestTimeoutMs: 15000, maxResponseBytes: 5242880, requestIntervalMs: 800, cacheTtlMs: 300000, maxCacheEntries: 128, maxPages: 3, allowLegacyResponseHeaders: true });
const bounds = { requestTimeoutMs: [100, 120000], maxResponseBytes: [1024, 16777216], requestIntervalMs: [0, 60000], cacheTtlMs: [0, 3600000], maxCacheEntries: [1, 1024], maxPages: [1, 10] };

/**
 * Validate all deployment choices before network activity.
 * @param config Supplied deployment settings.
 * @returns Frozen complete settings, rejecting unknown keys and invalid bounds.
 */
export function resolveConfig(config = {}) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new TypeError('Qimao config must be an object');
  const result = { ...defaults };
  for (const [key, value] of Object.entries(config)) {
    if (key === 'allowLegacyResponseHeaders') { if (typeof value !== 'boolean') throw new TypeError(`${key} must be boolean`); }
    else if (!Object.hasOwn(bounds, key) || !Number.isInteger(value) || value < bounds[key][0] || value > bounds[key][1]) throw new TypeError(`Invalid Qimao config: ${key}`);
    result[key] = value;
  }
  return Object.freeze(result);
}

function keys(value, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) throw new TypeError('Unknown Qimao request field');
}
function list(value, choices, fallback, name) {
  const result = value ?? fallback;
  if (!Array.isArray(result) || !result.length || result.some(item => !Object.hasOwn(choices, item))) throw new TypeError(`Invalid Qimao ${name}`);
  return [...new Set(result)];
}
function refresh(value) { if (value !== undefined && typeof value !== 'boolean') throw new TypeError('refresh must be boolean'); }

/**
 * Resolve the requested public windows without accepting arbitrary URLs or claiming global coverage.
 * @param options Public selection fields.
 * @param config Validated page budget.
 * @returns The bounded public-page plan.
 */
export function resolvePlan(options, config) {
  keys(options, ['source', 'channels', 'boards', 'periods', 'pages', 'refresh']);
  refresh(options.refresh);
  const source = options.source ?? 'rank';
  if (!['rank', 'library'].includes(source)) throw new TypeError('source must be rank or library');
  if (source === 'library') {
    if (options.channels !== undefined || options.boards !== undefined || options.periods !== undefined) throw new TypeError('Library filters do not accept ranking selections');
    const pages = options.pages ?? config.maxPages;
    if (!Number.isInteger(pages) || pages < 1 || pages > config.maxPages) throw new TypeError('Library pages exceed configured maxPages');
    return { source, targets: Array.from({ length: pages }, (_, index) => ({ page: index + 1, path: `/shuku/a-a-a-1-1-a-0-click-${index + 1}/` })) };
  }
  if (options.pages !== undefined) throw new TypeError('Ranking pagination is unverified; pages is available only for the library');
  const channels = list(options.channels, CHANNELS, Object.keys(CHANNELS), 'channels');
  const boards = list(options.boards, BOARDS, Object.keys(BOARDS), 'boards');
  const periods = list(options.periods, PERIODS, Object.keys(PERIODS), 'periods');
  return { source, targets: channels.flatMap(channel => boards.flatMap(board => (board === 'hot' ? periods : ['date']).map(period => ({ channel, board, period, page: 1, path: `/paihang/${channel}/${board}/${period}/` })))) };
}

/**
 * Keep all observations and select metadata and known metrics by their own observation times.
 * @param items Fetched book observations in traversal order.
 * @returns Independent books with complete observations and the newest known fields.
 */
export function deduplicate(items) {
  const merged = new Map();
  for (const item of items) {
    const previous = merged.get(item.bookId);
    if (!previous) merged.set(item.bookId, structuredClone(item));
    else {
      const observations = [...previous.observations, ...item.observations];
      const next = structuredClone(Date.parse(item.fetchedAt) >= Date.parse(previous.fetchedAt) ? item : previous);
      for (const field of Object.keys(METRIC_LABELS)) {
        const candidates = [previous.metrics[field], item.metrics[field]].filter(metric => metric.value !== null);
        if (candidates.length) next.metrics[field] = structuredClone(candidates.reduce((a, b) => Date.parse(b.observedAt) >= Date.parse(a.observedAt) ? b : a));
      }
      const words = [previous.wordCount, item.wordCount].filter(metric => metric.value !== null);
      if (words.length) next.wordCount = structuredClone(words.reduce((a, b) => Date.parse(b.observedAt) >= Date.parse(a.observedAt) ? b : a));
      next.missingMetrics = Object.entries(next.metrics).filter(([, value]) => value.value === null).map(([field, value]) => ({ field, reason: value.missingReason }));
      merged.set(item.bookId, { ...next, observations });
    }
  }
  return [...merged.values()];
}

function metricCoverage(items) {
  const observations = items.flatMap(item => item.observations);
  const fields = Object.fromEntries(Object.keys(METRIC_LABELS).map(field => {
    const known = observations.filter(item => item.metrics[field].value !== null).length;
    return [field, { known, missing: observations.length - known, complete: known === observations.length }];
  }));
  return { scope: 'fetched_public_observations', observations: observations.length, complete: Object.values(fields).every(field => field.complete), fields };
}

function failure(error) {
  return error instanceof QimaoError ? { code: error.code, message: error.message }
    : { code: 'network_error', message: 'The public metadata request failed; no cached response substituted' };
}

/** One plugin instance owns request admission, cancellation and expiring metadata pages. */
export class QimaoClient {
  /** @param config Deployment settings. @param dependencies Clock and transport implementations. */
  constructor(config = {}, dependencies = {}) {
    this.config = resolveConfig(config);
    this.dependencies = dependencies;
    this.now = dependencies.now ?? Date.now;
    this.lifetime = new AbortController();
    this.cache = new Map();
    this.queue = Promise.resolve();
    this.lastRequestAt = -Infinity;
    this.running = new Set();
  }

  /** Stop admission and cancel owned I/O. @returns Completion after admitted page operations settle. */
  async dispose() { this.lifetime.abort(); this.cache.clear(); await Promise.allSettled([...this.running]); }

  page(path, parser, options, renew, callSignal) {
    const pending = this.readPage(path, parser, options, renew, callSignal);
    this.running.add(pending);
    pending.then(() => { this.running.delete(pending); }, () => { this.running.delete(pending); });
    return pending;
  }

  async readPage(path, parser, options, renew, callSignal) {
    const signal = AbortSignal.any([this.lifetime.signal, ...(callSignal ? [callSignal] : [])]);
    signal.throwIfAborted();
    const cached = this.cache.get(path);
    if (!renew && cached && this.now() - cached.at < this.config.cacheTtlMs) return { ...structuredClone(cached.value), fromCache: true };
    const previous = this.queue;
    let release;
    let acquired = false;
    this.queue = new Promise(resolve => { release = resolve; });
    try {
      await abortable(previous, signal);
      acquired = true;
      signal.throwIfAborted();
      const wait = this.config.requestIntervalMs - (this.now() - this.lastRequestAt);
      if (wait > 0) await delay(wait, undefined, { signal });
      this.lastRequestAt = this.now();
      const active = AbortSignal.any([signal, AbortSignal.timeout(this.config.requestTimeoutMs)]);
      const raw = await readMetadata(path, this.config, active, this.dependencies);
      active.throwIfAborted();
      const fetchedAt = new Date(this.now()).toISOString(), sourceUrl = ORIGIN + path;
      const parsed = parser(raw.html, { ...options, sourceUrl, fetchedAt });
      const value = { ...parsed, sourceUrl, fetchedAt, fromCache: false, transport: raw.transport };
      if (this.config.cacheTtlMs > 0) {
        this.cache.delete(path);
        this.cache.set(path, { at: this.now(), value: structuredClone(value) });
        while (this.cache.size > this.config.maxCacheEntries) this.cache.delete(this.cache.keys().next().value);
      }
      return value;
    } finally {
      if (acquired) release();
      else void previous.then(release);
    }
  }

  /**
   * Collect only requested public ranking windows or explicitly filtered library pages.
   * @param options Public selection and cache refresh fields.
   * @param signal Optional caller cancellation.
   * @returns Deduplicated metadata with page and metric coverage, retaining partial failures.
   */
  async rankings(options = {}, signal) {
    const plan = resolvePlan(options, this.config), items = [], pages = [], failures = [], signatures = new Set();
    let allCached = true, expected = plan.targets.length;
    for (const target of plan.targets) {
      signal?.throwIfAborted(); this.lifetime.signal.throwIfAborted();
      try {
        const value = await this.page(target.path, plan.source === 'rank' ? parseRanking : parseLibrary, target, options.refresh, signal);
        const signature = value.items.map(item => item.bookId).join('|');
        if (plan.source === 'library' && signatures.has(signature)) throw new QimaoError('duplicate_page', 'A requested library page repeated an earlier book-ID sequence');
        signatures.add(signature);
        items.push(...value.items);
        allCached &&= value.fromCache;
        pages.push({ ...target, sourceUrl: value.sourceUrl, fetchedAt: value.fetchedAt, fromCache: value.fromCache, transport: value.transport, itemCount: value.items.length, paginationVerified: value.paginationVerified });
        if (plan.source === 'library' && value.maxPage < expected) expected = value.maxPage;
        if (plan.source === 'library' && target.page >= value.maxPage) break;
      } catch (error) {
        if (signal?.aborted || this.lifetime.signal.aborted) throw error;
        this.cache.delete(target.path);
        failures.push({ ...target, sourceUrl: ORIGIN + target.path, ...failure(error) });
      }
    }
    if (!pages.length) throw new QimaoError('all_pages_failed', `No requested Qimao metadata page succeeded: ${failures.map(item => `${item.code}: ${item.message}`).join('; ')}`);
    const unique = deduplicate(items);
    return { scope: plan.source === 'rank' ? 'public_rank_initial_windows' : 'public_filtered_library_pages', items: unique,
      selection: plan.source === 'rank' ? { source: plan.source } : { source: plan.source, filter: 'recent_short_ongoing', updatedWithinDays: 3, wordCountBelow: 300000, status: '连载中', sort: 'click' },
      coverage: { completeFor: 'requested_public_pages', siteWide: false, pagesRequested: expected, pagesFetched: pages.length, uniqueBooks: unique.length, complete: failures.length === 0 && pages.length === expected, failures, pages, metrics: metricCoverage(unique) },
      fetchedAt: new Date(this.now()).toISOString(), fromCache: allCached,
      note: '只覆盖所选公开窗口；榜单仅首屏，未验证榜单翻页。书库限定近3天更新、30万字以下、连载中并按点击量排序。热度、累计人气值、次阅读分别保存；在读人数和金选未知。' };
  }

  /**
   * Filter titles and authors within declared collected public windows; this is not global site search.
   * @param options Window selection, query and result paging.
   * @param signal Optional caller cancellation.
   * @returns Matches with the original scan coverage and complete:false.
   */
  async search(options, signal) {
    keys(options, ['source', 'channels', 'boards', 'periods', 'pages', 'refresh', 'query', 'offset', 'limit']);
    const { query, offset = 0, limit = 20, ...selection } = options;
    if (typeof query !== 'string' || !query.trim() || query.length > 100 || /[\u0000-\u001f\u007f]/u.test(query)) throw new TypeError('query must be 1..100 non-control characters');
    if (!Number.isInteger(offset) || offset < 0 || offset > 100000 || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new TypeError('Invalid Qimao result offset or limit');
    const data = await this.rankings(selection, signal), term = query.trim().toLowerCase();
    const matched = data.items.filter(item => `${item.title}\n${item.author}`.toLowerCase().includes(term));
    return { ...data, scope: 'collected_public_window_search', query: query.trim(), complete: false, matchedInWindow: matched.length, availableInWindow: data.items.length,
      offset, limit, items: matched.slice(offset, offset + limit), note: '仅在所选公开榜单首屏或已抓取的筛选书库页面内匹配书名、作者；不是七猫全站关键词搜索。' };
  }

  /**
   * Read a verified primary metadata panel without following any chapter link.
   * @param options Book ID and optional cache refresh.
   * @param signal Optional caller cancellation.
   * @returns The verified book metadata and original page observation time.
   */
  async detail(options, signal) {
    keys(options, ['bookId', 'refresh']); refresh(options.refresh);
    const id = bookId(options.bookId);
    return this.page(`/shuku/${id}/`, parseDetail, { bookId: id }, options.refresh, signal);
  }
}

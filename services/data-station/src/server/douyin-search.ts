import type { Work } from '../shared/types.ts';
import type { DouyinAccount, DouyinMix, DouyinPage, DouyinPost, DouyinSearchSettings, DouyinSearchState, HongguoMatch } from '../shared/douyin-search.ts';

/** A refused or failed Douyin search, carrying the HTTP status and the member-facing reason. */
export class DouyinSearchError extends Error {
  /** @param code DTK error code when DTK refused the read, such as `UPSTREAM_RISK_CONTROL`. */
  constructor(message: string, readonly status: 400 | 429 | 502 | 503 | 504, readonly code?: string) {
    super(message);
    this.name = 'DouyinSearchError';
  }
}

/** DTK error codes a member can act on, and what to tell them. */
const DTK_FAILURES: Readonly<Record<string, { status: 429 | 502 | 503 | 504; message: string }>> = {
  IDENTITY_LOGIN_REQUIRED: { status: 503, message: '抖音搜索账号暂不可用，可能登录已过期，请联系数据站管理员' },
  IDENTITY_POOL_EXHAUSTED: { status: 503, message: '抖音搜索账号正忙或不可用，请稍后再试' },
  RATE_LIMITED: { status: 429, message: '抖音搜索太频繁，请稍等一会儿再试' },
  UPSTREAM_RISK_CONTROL: { status: 503, message: '抖音要求验证，暂时无法搜索，请过几分钟再试' },
  CIRCUIT_OPEN: { status: 503, message: '抖音搜索暂时暂停，请过几分钟再试' },
  NOT_FOUND: { status: 502, message: '抖音没有返回这个内容' },
};

/**
 * Validates the private DTK origin: plain HTTP on a loopback host with an explicit port and nothing else.
 * @param value Configured origin such as `http://127.0.0.1:19580`.
 * @returns The normalized origin without a trailing slash.
 */
export function dtkOrigin(value: string): string {
  const url = new URL(value);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(url.hostname) || !url.port
    || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('MUSE_DATA_DTK_ORIGIN must be http://127.0.0.1:<port>');
  return url.origin;
}

/**
 * Validates a DTK API key read from its private file.
 * @param value File contents.
 * @returns The key without surrounding whitespace.
 */
export function dtkKey(value: string): string {
  const key = value.trim();
  if (!/^[A-Za-z0-9_-]{16,4096}$/.test(key)) throw new Error('MUSE_DATA_DTK_KEY_FILE does not hold a DTK API key');
  return key;
}

type Fetch = (input: string, init: RequestInit) => Promise<Response>;

/** Reads DTK REST list endpoints with a read-only key, following a queued task until it settles. */
export class DtkReader {
  readonly #fetch: Fetch;
  readonly #waitSeconds: number;
  readonly #pollMs: number;
  readonly #maxWaitMs: number;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #now: () => number;

  constructor(readonly origin: string, readonly key: string, options: {
    fetch?: Fetch; waitSeconds?: number; pollMs?: number; maxWaitMs?: number; sleep?: (ms: number) => Promise<void>; now?: () => number;
  } = {}) {
    this.#fetch = options.fetch ?? ((input, init) => fetch(input, init));
    this.#waitSeconds = options.waitSeconds ?? 20;
    this.#pollMs = options.pollMs ?? 2_000;
    this.#maxWaitMs = options.maxWaitMs ?? 60_000;
    this.#sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
    this.#now = options.now ?? Date.now;
  }

  async #get(path: string): Promise<{ status: number; body: Record<string, unknown> }> {
    let response: Response;
    try {
      response = await this.#fetch(`${this.origin}${path}`, {
        headers: { authorization: `Bearer ${this.key}`, accept: 'application/json' },
        redirect: 'error', signal: AbortSignal.timeout((this.#waitSeconds + 15) * 1000),
      });
    } catch {
      throw new DouyinSearchError('抖音搜索服务暂时连不上，请稍后再试', 503);
    }
    let body: unknown;
    try { body = await response.json(); } catch { throw new DouyinSearchError('抖音搜索服务返回了无法识别的内容', 502); }
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new DouyinSearchError('抖音搜索服务返回了无法识别的内容', 502);
    return { status: response.status, body: body as Record<string, unknown> };
  }

  static #failure(error: unknown): DouyinSearchError {
    const code = error && typeof error === 'object' && 'code' in error ? String((error as { code: unknown }).code) : '';
    const known = DTK_FAILURES[code];
    return known ? new DouyinSearchError(known.message, known.status, code) : new DouyinSearchError('抖音搜索暂时不可用，请稍后再试', 502, code || undefined);
  }

  /**
   * Reads one Douyin list endpoint.
   * @param path Path under `/api/v1/douyin/`, for example `search/posts`.
   * @param query Query parameters for that endpoint.
   * @returns The endpoint's `data` value.
   */
  async read(path: string, query: Record<string, string>): Promise<unknown> {
    const search = new URLSearchParams({ ...query, wait: String(this.#waitSeconds) });
    const { status, body } = await this.#get(`/api/v1/douyin/${path}?${search}`);
    if (body.success !== true) throw DtkReader.#failure(body.error);
    if (status === 200) return body.data;
    const task = status === 202 && body.data && typeof body.data === 'object' ? (body.data as { task_id?: unknown }).task_id : undefined;
    if (typeof task !== 'string' || !/^[0-9a-f-]{36}$/.test(task)) throw new DouyinSearchError('抖音搜索服务返回了无法识别的内容', 502);
    const deadline = this.#now() + this.#maxWaitMs;
    while (this.#now() < deadline) {
      await this.#sleep(this.#pollMs);
      const polled = await this.#get(`/api/v1/tasks/${task}`);
      if (polled.body.success !== true) throw DtkReader.#failure(polled.body.error);
      const view = polled.body.data as { state?: unknown; data?: unknown; error?: unknown } | undefined;
      if (view?.state === 'done') return view.data;
      if (view?.state === 'failed') throw DtkReader.#failure(view.error);
    }
    throw new DouyinSearchError('抖音搜索还在排队，请稍后再试', 504);
  }
}

const HOUR = 3_600_000;
const beijingTime = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });

/** Limits shared by every Douyin search the station makes, because one signed-in Douyin account serves them all. */
export interface DouyinSearchBudgetOptions {
  /** Searches allowed in any rolling hour. */
  perHour: number;
  /** Searches allowed in any rolling 24 hours. */
  perDay: number;
  /** How long every search stops after Douyin asks for verification. */
  pauseMs: number;
  now?: () => number;
  /** Receives the settings after every change, so they survive a restart. */
  save?: (settings: DouyinSearchSettings) => Promise<void>;
}

/**
 * Wraps a DTK reader so `search/*` reads, from members and from hit selection alike, stay within an hourly and a daily
 * budget and stop for `pauseMs` after DTK reports `UPSTREAM_RISK_CONTROL`. Other reads pass through unchanged.
 * The administrator can change the limits, stop every search and end a verification pause; those settings and the pause
 * are passed to `save`. The search counts live in memory and start over when the station restarts.
 */
export class DouyinSearchBudget {
  #starts: number[] = [];
  #pausedUntil = 0;
  #lastRiskAt: number | null = null;
  #stopped = false;
  #perHour: number;
  #perDay: number;
  readonly #now: () => number;

  constructor(readonly reader: Pick<DtkReader, 'read'>, readonly options: DouyinSearchBudgetOptions) {
    DouyinSearchBudget.#check(options.perHour, options.perDay);
    if (!Number.isInteger(options.pauseMs) || options.pauseMs < 0) throw new Error('Invalid Douyin search budget');
    this.#perHour = options.perHour;
    this.#perDay = options.perDay;
    this.#now = options.now ?? Date.now;
  }

  static #check(perHour: number, perDay: number): void {
    if (!Number.isInteger(perHour) || perHour < 1 || perHour > 600 || !Number.isInteger(perDay) || perDay < perHour || perDay > 10_000) throw new Error('Invalid Douyin search budget');
  }

  /** Restores settings saved before a restart. */
  restore(saved: DouyinSearchSettings): void {
    DouyinSearchBudget.#check(saved.perHour, saved.perDay);
    this.#perHour = saved.perHour;
    this.#perDay = saved.perDay;
    this.#stopped = saved.stopped;
    this.#pausedUntil = saved.pausedUntil ? Date.parse(saved.pausedUntil) : 0;
    this.#lastRiskAt = saved.lastRiskAt ? Date.parse(saved.lastRiskAt) : null;
  }

  #settings(): DouyinSearchSettings {
    const now = this.#now();
    return { perHour: this.#perHour, perDay: this.#perDay, stopped: this.#stopped,
      pausedUntil: now < this.#pausedUntil ? new Date(this.#pausedUntil).toISOString() : null,
      lastRiskAt: this.#lastRiskAt === null ? null : new Date(this.#lastRiskAt).toISOString() };
  }

  /** Current limits, pause, stop switch and the searches started in the last hour and day. */
  state(): DouyinSearchState {
    const now = this.#now();
    this.#starts = this.#starts.filter(at => now - at < 24 * HOUR);
    return { ...this.#settings(), lastHour: this.#starts.filter(at => now - at < HOUR).length, lastDay: this.#starts.length,
      pauseMinutes: Math.round(this.options.pauseMs / 60_000) };
  }

  /**
   * Applies an administrator's change and saves the settings.
   * @param change New limits, the stop switch, or `resume` to end a verification pause after the account was verified.
   * @throws When the limits are out of range; nothing changes then.
   */
  async configure(change: { perHour?: number; perDay?: number; stopped?: boolean; resume?: boolean }): Promise<DouyinSearchState> {
    const perHour = change.perHour ?? this.#perHour, perDay = change.perDay ?? this.#perDay;
    DouyinSearchBudget.#check(perHour, perDay);
    this.#perHour = perHour;
    this.#perDay = perDay;
    if (change.stopped !== undefined) this.#stopped = change.stopped;
    if (change.resume) this.#pausedUntil = 0;
    await this.options.save?.(this.#settings());
    return this.state();
  }

  /**
   * Reads one DTK endpoint; a search is refused before it reaches DTK while paused or over budget.
   * @param path Path under `/api/v1/douyin/`.
   * @param query Query parameters for that endpoint.
   */
  async read(path: string, query: Record<string, string>): Promise<unknown> {
    if (!path.startsWith('search/')) return this.reader.read(path, query);
    const { lastHour, lastDay, pausedUntil } = this.state();
    if (this.#stopped) throw new DouyinSearchError('管理员已暂停抖音搜索', 503, 'SEARCH_STOPPED');
    if (pausedUntil) throw new DouyinSearchError(`抖音要求验证，全站搜索暂停到 ${beijingTime.format(new Date(pausedUntil))}`, 503, 'SEARCH_PAUSED');
    if (lastHour >= this.#perHour) throw new DouyinSearchError(`抖音搜索已达每小时 ${this.#perHour} 次的上限，请稍后再试`, 429, 'SEARCH_BUDGET');
    if (lastDay >= this.#perDay) throw new DouyinSearchError(`抖音搜索已达每天 ${this.#perDay} 次的上限，请明天再试`, 429, 'SEARCH_BUDGET');
    this.#starts.push(this.#now());
    try { return await this.reader.read(path, query); }
    catch (error) {
      if (error instanceof DouyinSearchError && error.code === 'UPSTREAM_RISK_CONTROL') {
        this.#lastRiskAt = this.#now();
        this.#pausedUntil = this.#lastRiskAt + this.options.pauseMs;
        console.error(`[muse-data-web] douyin search paused until ${new Date(this.#pausedUntil).toISOString()}: risk control`);
        await this.options.save?.(this.#settings()).catch(() => console.error('[muse-data-web] douyin search pause was not saved'));
      }
      throw error;
    }
  }
}

const text = (value: unknown, limit = 2_000): string => typeof value === 'string' ? value.slice(0, limit) : '';
const optionalText = (value: unknown, limit = 2_000): string | null => typeof value === 'string' && value ? value.slice(0, limit) : null;
const count = (value: unknown): number | null => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
const positive = (value: unknown): number | null => typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const httpsUrl = (value: unknown): string | null => typeof value === 'string' && value.startsWith('https://') && value.length <= 4_096 ? value : null;
const DOUYIN_PAGE = /^https:\/\/www\.douyin\.com\//;

function mixOf(raw: Record<string, unknown>): DouyinMix | null {
  const mix = record(raw.mix_info);
  const id = typeof mix.mix_id === 'string' && /^\d{1,32}$/.test(mix.mix_id) ? mix.mix_id : null;
  if (!id) return null;
  const statis = record(mix.statis);
  return { id, name: text(mix.mix_name, 200), episode: positive(statis.current_episode), episodes: positive(statis.updated_to_episode) };
}

/**
 * Projects one DTK Douyin `Content` (requested with `include_raw`) into the station's post fields.
 * @param value One item of a DTK page.
 * @returns The post without a Hongguo match, or null when it carries no post id.
 */
export function douyinPost(value: unknown): (DouyinPost & { tags: string[] }) | null {
  const item = record(value);
  const id = typeof item.content_id === 'string' && /^\d{1,32}$/.test(item.content_id) ? item.content_id : null;
  if (!id) return null;
  const author = record(item.author);
  const stats = record(item.stats);
  const covers = Array.isArray(record(item.media).covers) ? record(item.media).covers as unknown[] : [];
  const webUrl = typeof item.web_url === 'string' && DOUYIN_PAGE.test(item.web_url) ? item.web_url : `https://www.douyin.com/video/${id}`;
  return {
    id, title: text(item.title), description: text(item.description), url: webUrl.split('?')[0]!,
    coverUrl: httpsUrl(record(covers[0]).url), durationMs: positive(item.duration_ms), createdAt: optionalText(item.created_at, 64),
    author: { name: text(author.nickname, 200), secUid: optionalText(author.sec_uid, 256), handle: optionalText(author.unique_id, 200) },
    stats: { likes: count(stats.digg_count), comments: count(stats.comment_count), shares: count(stats.share_count), saves: count(stats.collect_count) },
    mix: mixOf(record(item.raw)), hongguo: null,
    tags: Array.isArray(item.tags) ? item.tags.filter((tag): tag is string => typeof tag === 'string').slice(0, 30) : [],
  };
}

/**
 * Projects one DTK Douyin `Author` into the station's account fields.
 * @param value One item of a DTK account page.
 * @returns The account, or null when it carries no stable id.
 */
export function douyinAccount(value: unknown): DouyinAccount | null {
  const item = record(value);
  const secUid = optionalText(item.sec_uid, 256) ?? optionalText(item.uid, 256);
  if (!secUid || !/^[A-Za-z0-9_.-]+$/.test(secUid)) return null;
  const stats = record(item.stats);
  return {
    secUid, name: text(item.nickname, 200), handle: optionalText(item.unique_id, 200), signature: optionalText(item.signature, 500),
    avatarUrl: httpsUrl(record(item.avatar).url), followers: count(stats.follower_count), posts: count(stats.content_count),
    url: `https://www.douyin.com/user/${secUid}`,
  };
}

/**
 * Normalizes a drama title for matching: width-folded, lower-case, without spaces, punctuation or symbols.
 * @param title Any title or candidate.
 * @returns The comparison key.
 */
export function titleKey(title: string): string {
  return title.normalize('NFKC').toLocaleLowerCase().replace(/[\s\p{P}\p{S}]/gu, '');
}

const PROMOTION_SUFFIX = /(完整版|超长版|后续|全集|看全集|一口气看完|大结局|合集|短剧|漫剧|动漫|动画|第[0-9一二三四五六七八九十百]+集|[0-9]+集)$/u;

function stripPromotion(key: string): string {
  let previous = '';
  while (previous !== key) { previous = key; key = key.replace(PROMOTION_SUFFIX, ''); }
  return key;
}

/**
 * Drama-name candidates a Douyin post states: its series name, 《》 titles, its leading phrase and its hashtags.
 * @param post The post's text fields.
 * @returns Distinct comparison keys in that priority order.
 */
export function hongguoCandidates(post: { title: string; description: string; tags: string[]; mix: DouyinMix | null }): string[] {
  const keys: string[] = [];
  const add = (value: string | undefined) => {
    const key = stripPromotion(titleKey(value ?? ''));
    if (key.length >= 3 && key.length <= 30 && !keys.includes(key)) keys.push(key);
  };
  if (post.mix) add(post.mix.name);
  for (const match of `${post.title} ${post.description}`.matchAll(/《([^》]{2,40})》/g)) add(match[1]);
  add(post.title.replace(/《[^》]*》/g, ' ').trim().split(/[\s#，,。！!？?|｜]/u)[0]);
  for (const tag of post.tags) add(tag);
  return keys;
}

function match(work: Work): HongguoMatch {
  return { workId: work.id, title: work.title ?? '', episodeCount: work.episodeCount, serialStatus: work.serialStatus };
}

/** Douyin search for members: rate-limited per member, projected, and matched against this station's Hongguo works. */
export class DouyinSearchService {
  readonly #recent = new Map<string, number[]>();
  #inFlight = 0;
  readonly #perMinute: number;
  readonly #maxInFlight: number;
  readonly #now: () => number;

  constructor(readonly reader: Pick<DtkReader, 'read'>, readonly findHongguo: (keys: readonly string[], key: (title: string) => string) => Promise<ReadonlyMap<string, Work>>, options: {
    perMinute?: number; maxInFlight?: number; now?: () => number;
  } = {}) {
    this.#perMinute = options.perMinute ?? 20;
    this.#maxInFlight = options.maxInFlight ?? 4;
    this.#now = options.now ?? Date.now;
  }

  async #admit<T>(member: string, work: () => Promise<T>): Promise<T> {
    const now = this.#now();
    const recent = (this.#recent.get(member) ?? []).filter(at => now - at < 60_000);
    if (recent.length >= this.#perMinute) throw new DouyinSearchError('一分钟内搜索太多次了，请稍等一会儿再试', 429);
    if (this.#inFlight >= this.#maxInFlight) throw new DouyinSearchError('抖音搜索正忙，请稍后再试', 429);
    recent.push(now);
    this.#recent.set(member, recent);
    this.#inFlight++;
    try { return await work(); } finally { this.#inFlight--; }
  }

  static #keyword(value: string): string {
    const keyword = value.trim();
    if (!keyword || keyword.length > 100 || /[\u0000-\u001f\u007f]/.test(keyword)) throw new DouyinSearchError('请输入 1–100 个字的搜索词', 400);
    return keyword;
  }

  static #cursor(value: string | undefined): Record<string, string> {
    if (value === undefined || value === '') return {};
    if (value.length > 512 || !/^[\x21-\x7e]+$/.test(value)) throw new DouyinSearchError('翻页位置无效，请重新搜索', 400);
    return { cursor: value };
  }

  static #page(data: unknown): { items: unknown[]; cursor: string | null; hasMore: boolean } {
    const page = record(data);
    const items = Array.isArray(page.items) ? page.items : null;
    if (!items) throw new DouyinSearchError('抖音搜索服务返回了无法识别的内容', 502);
    const hasMore = page.has_more === true;
    const cursor = hasMore && typeof page.cursor === 'string' && page.cursor.length <= 512 ? page.cursor : null;
    return { items, cursor, hasMore: hasMore && cursor !== null };
  }

  async #posts(data: unknown): Promise<DouyinPage<DouyinPost>> {
    const page = DouyinSearchService.#page(data);
    const posts = page.items.map(douyinPost).filter(post => post !== null);
    const candidates = posts.map(hongguoCandidates);
    const found = await this.findHongguo([...new Set(candidates.flat())], titleKey);
    return {
      items: posts.map(({ tags: _tags, ...post }, index) => {
        const key = candidates[index]!.find(candidate => found.has(candidate));
        return { ...post, hongguo: key ? match(found.get(key)!) : null };
      }),
      cursor: page.cursor, hasMore: page.hasMore,
    };
  }

  /**
   * One page of posts a keyword finds, each with its series and any matching Hongguo work.
   * @param member Signed-in member id that the rate limit counts against.
   * @param keyword Search words.
   * @param cursor Cursor from the previous page.
   */
  searchPosts(member: string, keyword: string, cursor?: string): Promise<DouyinPage<DouyinPost>> {
    const query = { keyword: DouyinSearchService.#keyword(keyword), count: '10', include_raw: 'true', ...DouyinSearchService.#cursor(cursor) };
    return this.#admit(member, async () => this.#posts(await this.reader.read('search/posts', query)));
  }

  /**
   * One page of accounts a keyword finds.
   * @param member Signed-in member id that the rate limit counts against.
   * @param keyword Search words.
   * @param cursor Cursor from the previous page.
   */
  searchAccounts(member: string, keyword: string, cursor?: string): Promise<DouyinPage<DouyinAccount>> {
    const query = { keyword: DouyinSearchService.#keyword(keyword), count: '10', ...DouyinSearchService.#cursor(cursor) };
    return this.#admit(member, async () => {
      const page = DouyinSearchService.#page(await this.reader.read('search/users', query));
      return { items: page.items.map(douyinAccount).filter(account => account !== null), cursor: page.cursor, hasMore: page.hasMore };
    });
  }

  /**
   * One page of a series' posts in the author's order.
   * @param member Signed-in member id that the rate limit counts against.
   * @param mixId Douyin series id.
   * @param cursor Cursor from the previous page.
   */
  mixPosts(member: string, mixId: string, cursor?: string): Promise<DouyinPage<DouyinPost>> {
    if (!/^\d{1,32}$/.test(mixId)) throw new DouyinSearchError('合集编号无效', 400);
    const query = { mix_id: mixId, count: '20', include_raw: 'true', ...DouyinSearchService.#cursor(cursor) };
    return this.#admit(member, async () => this.#posts(await this.reader.read('mix/posts', query)));
  }
}

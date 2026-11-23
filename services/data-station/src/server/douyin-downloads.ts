/**
 * Saves public Douyin posts to the `muse` TOS bucket: a fresh no-watermark address from DTK, a bounded server-side
 * download with a SHA-256, a no-overwrite upload checked with HeadObject, and one database record per post.
 * Up to `concurrency` downloads run at once; the next post goes to the member with the fewest running downloads,
 * and each member's posts, including whole series, keep their request and episode order.
 */
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, rm } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import type { PGlite } from '@electric-sql/pglite';
import type { DouyinDownload, DouyinDownloadRequestResult, DouyinDownloadState, DouyinDownloadStatus } from '../shared/douyin-downloads.ts';
import { displayName, type UserIdentity } from '../shared/types.ts';
import { DouyinSearchError, douyinPost, type DtkReader } from './douyin-search.ts';

/** A refused download request, with the HTTP status and the member-facing reason. */
export class DouyinDownloadError extends Error {
  constructor(message: string, readonly status: 400 | 404 | 409 | 429 | 502 | 503,
    readonly retryable = status === 429 || status >= 500, readonly code = 'DOWNLOAD_FAILED') { super(message); this.name = 'DouyinDownloadError'; }
}

// ---------------------------------------------------------------- credentials and TOS

/** Access key pair; never logged or returned. */
export interface TosCredentials { readonly accessKeyId: string; readonly secretAccessKey: string; }

/**
 * Reads `VOLCENGINE_ACCESS_KEY_ID` and `VOLCENGINE_SECRET_ACCESS_KEY` from a private env-style file:
 * absolute, a regular file without symbolic links, mode 0600 or 0640, at most 4 KiB. Errors never include file contents.
 */
export async function readTosCredentials(path: string): Promise<TosCredentials> {
  const invalid = (reason: string) => new Error(`MUSE_DATA_TOS_ENV_FILE ${reason}`);
  if (!isAbsolute(path) || resolve(path) !== path) throw invalid('must be an absolute path');
  const stat = await lstat(path).catch(() => null);
  if (!stat?.isFile() || await realpath(path) !== path) throw invalid('must be a regular file without symbolic links');
  if (![0o600, 0o640].includes(stat.mode & 0o7777)) throw invalid('must have mode 0600 or 0640');
  if (stat.size === 0 || stat.size > 4_096) throw invalid('must hold the two key lines');
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(await handle.readFile()); }
  catch { throw invalid('must be UTF-8 text'); }
  finally { await handle.close(); }
  const values = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!match || line.trim().startsWith('#')) continue;
    values.set(match[1]!, match[2]!.replace(/^(['"])(.*)\1$/, '$2'));
  }
  const accessKeyId = values.get('VOLCENGINE_ACCESS_KEY_ID') ?? '';
  const secretAccessKey = values.get('VOLCENGINE_SECRET_ACCESS_KEY') ?? '';
  if (!/^[\x21-\x7e]{8,256}$/.test(accessKeyId) || !/^[\x21-\x7e]{8,256}$/.test(secretAccessKey)) throw invalid('must set VOLCENGINE_ACCESS_KEY_ID and VOLCENGINE_SECRET_ACCESS_KEY');
  return { accessKeyId, secretAccessKey };
}

/** The bucket operations the downloader uses; the binding exposes no delete. */
export interface ObjectStore {
  head(key: string): Promise<{ bytes: number; sha256: string | null } | null>;
  upload(key: string, path: string, sha256: string, contentType: string, signal: AbortSignal): Promise<void>;
  /** A GET link: time-limited and signed for private objects, the plain object address for public ones. */
  link(key: string, seconds: number): string;
}

export interface TosSettings { bucket: string; region: string; endpoint: string; access: 'private' | 'public'; }

const META_SHA256 = 'sha256';
const status = (error: unknown): number | null => error && typeof error === 'object' && typeof (error as { statusCode?: unknown }).statusCode === 'number' ? (error as { statusCode: number }).statusCode : null;

/** Public address of an object in a bucket served from `<bucket>.<endpoint>`. */
export function publicObjectUrl(settings: Pick<TosSettings, 'bucket' | 'endpoint'>, key: string): string {
  return `https://${settings.bucket}.${settings.endpoint}/${key.split('/').map(encodeURIComponent).join('/')}`;
}

/**
 * Binds `@volcengine/tos-sdk` (pinned 2.9.1, the same binding as Muse's `drama_tos_upload`): CRC checks on,
 * no-overwrite uploads with the SHA-256 in object metadata, and private or public-read object ACL by setting.
 */
export async function createTosObjectStore(settings: TosSettings, credentials: TosCredentials): Promise<ObjectStore> {
  const loaded = await import('@volcengine/tos-sdk') as unknown as { TosClient?: unknown; default?: { TosClient?: unknown } };
  type Client = {
    headObject(input: { bucket: string; key: string }): Promise<{ data: Record<string, unknown> }>;
    uploadFile(input: Record<string, unknown>): Promise<unknown>;
    getPreSignedUrl(input: Record<string, unknown>): string;
  };
  type Constructor = { new (options: Record<string, unknown>): Client; CancelToken: { source(): { token: unknown; cancel(message?: string): void } } };
  const TosClient = (loaded.TosClient ?? loaded.default?.TosClient) as Constructor | undefined;
  if (typeof TosClient !== 'function') throw new Error('TOS SDK is unavailable');
  const client = new TosClient({ accessKeyId: credentials.accessKeyId, accessKeySecret: credentials.secretAccessKey, region: settings.region,
    endpoint: settings.endpoint, secure: true, enableCRC: true, maxRetryCount: 2, requestTimeout: 120_000, connectionTimeout: 10_000 });
  const { bucket } = settings;
  return {
    async head(key) {
      try {
        const data = (await client.headObject({ bucket, key })).data;
        const bytes = Number(data['content-length']);
        const sha256 = data[`x-tos-meta-${META_SHA256}`];
        return { bytes: Number.isSafeInteger(bytes) ? bytes : -1, sha256: typeof sha256 === 'string' && /^[0-9a-f]{64}$/.test(sha256) ? sha256 : null };
      } catch (error) {
        if (status(error) === 404) return null;
        const code = status(error);
        throw new DouyinDownloadError(`TOS 文件检查失败（${code ?? '连接中断'}）`, 502,
          code === null || code === 408 || code === 429 || code >= 500, 'TOS_READ_FAILED');
      }
    },
    async upload(key, path, sha256, contentType, signal) {
      signal.throwIfAborted();
      const cancel = TosClient.CancelToken.source();
      const abort = () => cancel.cancel('cancelled');
      signal.addEventListener('abort', abort, { once: true });
      try {
        await client.uploadFile({ bucket, key, file: path, contentType, meta: { [META_SHA256]: sha256 }, forbidOverwrite: true,
          acl: settings.access === 'private' ? 'private' : 'public-read', partSize: 20 * 1024 * 1024, taskNum: 2, cancelToken: cancel.token });
      } catch (error) {
        signal.throwIfAborted();
        const code = status(error);
        throw new DouyinDownloadError(code === 409 || code === 412 ? 'TOS 已有同名文件，不会覆盖' : code === 401 || code === 403 ? 'TOS 拒绝访问，请检查密钥权限' : `TOS 上传失败（${code ?? '连接中断'}）`,
          502, code === null || code === 408 || code === 429 || code >= 500, 'TOS_UPLOAD_FAILED');
      } finally { signal.removeEventListener('abort', abort); }
    },
    link(key, seconds) {
      return settings.access === 'private' ? client.getPreSignedUrl({ bucket, key, method: 'GET', expires: seconds }) : publicObjectUrl(settings, key);
    },
  };
}

// ---------------------------------------------------------------- source video

/** A post's fresh no-watermark addresses and its text, read through DTK just before downloading. */
export interface DouyinVideo { awemeId: string; title: string; urls: string[]; mixId: string | null; mixName: string | null; episode: number | null; }

const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
function videoAddress(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 8_192) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || /^(\d+\.){3}\d+$|^\[|^localhost$/i.test(url.hostname)) return null;
    return url.href;
  } catch { return null; }
}

/**
 * Reads `GET /api/v1/douyin/video?aweme_id=` with the station's read-only DTK key.
 * @returns The post with its current play addresses (`media.video.url`, then `media.video.urls`), which expire soon.
 */
export async function readDouyinVideo(reader: Pick<DtkReader, 'read'>, awemeId: string): Promise<DouyinVideo> {
  const data = await reader.read('video', { aweme_id: awemeId, include_raw: 'true' });
  const post = douyinPost(data);
  if (!post || post.id !== awemeId) throw new DouyinDownloadError('抖音没有返回这个作品', 502, false, 'VIDEO_NOT_FOUND');
  const video = record(record(record(data).media).video);
  const urls = [video.url, ...(Array.isArray(video.urls) ? video.urls : [])].map(videoAddress).filter((url): url is string => url !== null);
  if (!urls.length) throw new DouyinDownloadError('抖音没有返回可下载的视频地址', 502);
  return { awemeId, title: post.title || post.description.slice(0, 200), urls: [...new Set(urls)], mixId: post.mix?.id ?? null, mixName: post.mix?.name ?? null, episode: post.mix?.episode ?? null };
}

const DOWNLOAD_HEADERS = {
  referer: 'https://www.douyin.com/',
  'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  accept: '*/*',
};

/**
 * Downloads the first address that answers with a video, writing at most `maxBytes` and hashing as it goes.
 * @throws When every address fails, a response is not a video, or the file exceeds the limit.
 */
export async function downloadVideo(urls: string[], path: string, options: { maxBytes: number; timeoutMs: number; fetch?: typeof globalThis.fetch; signal: AbortSignal }): Promise<{ bytes: number; sha256: string }> {
  const fetcher = options.fetch ?? globalThis.fetch;
  let last = '视频地址不可用';
  for (const url of urls) {
    options.signal.throwIfAborted();
    const signal = AbortSignal.any([options.signal, AbortSignal.timeout(options.timeoutMs)]);
    let response: Response;
    try { response = await fetcher(url, { headers: DOWNLOAD_HEADERS, redirect: 'follow', signal }); }
    catch { options.signal.throwIfAborted(); last = '视频地址连接失败'; continue; }
    const type = response.headers.get('content-type')?.toLowerCase() ?? '';
    const declared = Number(response.headers.get('content-length'));
    if (!response.ok || !response.body || !(type.startsWith('video/') || type.startsWith('application/octet-stream') || type === '')
      || (response.url && !response.url.startsWith('https://'))) { await response.body?.cancel(); last = `视频地址返回 HTTP ${response.status}`; continue; }
    if (Number.isFinite(declared) && declared > options.maxBytes) { await response.body.cancel(); throw new DouyinDownloadError('视频超过大小上限', 400, false, 'VIDEO_TOO_LARGE'); }
    const hash = createHash('sha256');
    let bytes = 0;
    const file = await open(path, 'wx', 0o600);
    try {
      try {
        const reader = response.body.getReader();
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          bytes += chunk.value.byteLength;
          if (bytes > options.maxBytes) { await reader.cancel(); throw new DouyinDownloadError('视频超过大小上限', 400, false, 'VIDEO_TOO_LARGE'); }
          hash.update(chunk.value);
          await file.write(chunk.value);
        }
        await file.sync();
      } finally { await file.close(); }
    } catch (error) {
      await rm(path, { force: true });
      if (options.signal.aborted || error instanceof DouyinDownloadError && !error.retryable) throw error;
      last = '视频下载中断';
      continue;
    }
    if (!bytes) { await rm(path, { force: true }); last = '视频地址返回空文件'; continue; }
    return { bytes, sha256: hash.digest('hex') };
  }
  throw new DouyinDownloadError(last, 502, true, 'VIDEO_TRANSFER_FAILED');
}

// ---------------------------------------------------------------- records and queue

export interface DouyinDownloadOptions {
  access: 'private' | 'public';
  linkSeconds: number;
  dailyLimit: number;
  maxMixEpisodes: number;
  maxVideoBytes: number;
  /** Pause a worker takes after each download. */
  intervalMs: number;
  /** Downloads that run at once, 1–16; defaults to 1. */
  concurrency?: number;
  /** Attempts in one group before entering a longer cooldown. */
  maxAttempts: number;
  /** Wait between attempts within a group; defaults to 5 seconds. */
  retryDelayMs?: number;
  /** First cooldown after a failed group; defaults to 5 minutes. */
  cooldownMs?: number;
  /** Maximum cooldown as later failed groups double the wait; defaults to 1 hour. */
  maxCooldownMs?: number;
  /** Private scratch directory for partial files, inside the data directory. */
  workDirectory: string;
  /** Top folder of `<root>/douyin/<YYYYMMDD>/…`; defaults to `download-video-date`. */
  keyRoot?: string;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
}

interface Row {
  id: string; aweme_id: string; mix_id: string | null; mix_name: string | null; episode: number | null; title: string; state: DouyinDownloadState;
  object_key: string; bytes: number | null; sha256: string | null; error: string | null; attempts: number; requested_by_id: string; requested_by: string;
  created_at: Date | string; started_at: Date | string | null; finished_at: Date | string | null;
  retry_at: Date | string | null; retry_rounds: number; round_attempts: number; error_code: string | null;
}
const iso = (value: Date | string | null) => value === null ? null : new Date(value).toISOString();
function view(row: Row, url: (key: string) => string | null = () => null): DouyinDownload {
  return { id: row.id, awemeId: row.aweme_id, mixId: row.mix_id, mixName: row.mix_name, episode: row.episode, title: row.title, state: row.state,
    key: row.object_key, bytes: row.bytes === null ? null : Number(row.bytes), sha256: row.sha256, error: row.error, attempts: row.attempts,
    errorCode: row.error_code, nextRetryAt: iso(row.retry_at), cooldownRounds: row.retry_rounds,
    requestedBy: row.requested_by, url: row.state === 'done' ? url(row.object_key) : null, createdAt: iso(row.created_at)!, startedAt: iso(row.started_at), finishedAt: iso(row.finished_at) };
}

/** Beijing calendar day `YYYYMMDD` and the UTC instant of its midnight. */
function beijingDay(now: number): { compact: string; start: string } {
  const shifted = new Date(now + 8 * 3_600_000);
  const date = shifted.toISOString().slice(0, 10);
  return { compact: date.replaceAll('-', ''), start: new Date(Date.parse(`${date}T00:00:00.000Z`) - 8 * 3_600_000).toISOString() };
}

/** Owns `douyin_downloads`, the per-member daily limit, and the in-process download workers. */
export class DouyinDownloadManager {
  private readonly now: () => number;
  private readonly root: string;
  private readonly retryDelayMs: number;
  private readonly cooldownMs: number;
  private readonly maxCooldownMs: number;
  private running: Promise<void> | null = null;
  private closing = false;
  private readonly abort = new AbortController();
  /** Ends the pause of every waiting worker; used by `stop`. */
  private readonly waiting = new Set<() => void>();
  /** Ends the pause of workers that found nothing to do; a new request wakes them. */
  private readonly idle = new Set<() => void>();

  constructor(private readonly database: PGlite, private readonly reader: Pick<DtkReader, 'read'>, private readonly store: ObjectStore, private readonly options: DouyinDownloadOptions) {
    if (!Number.isInteger(options.dailyLimit) || options.dailyLimit < 1 || !Number.isInteger(options.maxMixEpisodes) || options.maxMixEpisodes < 1
      || !Number.isInteger(options.maxAttempts) || options.maxAttempts < 1 || options.maxVideoBytes < 1
      || (options.concurrency !== undefined && (!Number.isInteger(options.concurrency) || options.concurrency < 1 || options.concurrency > 16))) throw new Error('Invalid Douyin download limits');
    this.now = options.now ?? Date.now;
    this.root = options.keyRoot ?? 'download-video-date';
    this.retryDelayMs = options.retryDelayMs ?? 5_000;
    this.cooldownMs = options.cooldownMs ?? 300_000;
    this.maxCooldownMs = options.maxCooldownMs ?? 3_600_000;
    if (!Number.isSafeInteger(this.retryDelayMs) || this.retryDelayMs < 0 || this.retryDelayMs > 60_000
      || !Number.isSafeInteger(this.cooldownMs) || this.cooldownMs < 1_000 || this.cooldownMs > 86_400_000
      || !Number.isSafeInteger(this.maxCooldownMs) || this.maxCooldownMs < this.cooldownMs || this.maxCooldownMs > 86_400_000) throw new Error('Invalid Douyin retry limits');
  }

  async initialize(): Promise<void> {
    await this.database.exec(`
      CREATE TABLE IF NOT EXISTS douyin_downloads (
        id text PRIMARY KEY, aweme_id text NOT NULL, mix_id text, mix_name text, episode integer, title text NOT NULL,
        state text NOT NULL CHECK (state IN ('queued','downloading','uploading','done','failed')),
        object_key text NOT NULL, bytes bigint, sha256 text, error text, attempts integer NOT NULL DEFAULT 0,
        requested_by_id text NOT NULL, requested_by text NOT NULL,
        created_at timestamptz NOT NULL, started_at timestamptz, finished_at timestamptz);
      CREATE UNIQUE INDEX IF NOT EXISTS douyin_downloads_post ON douyin_downloads(aweme_id);
      CREATE INDEX IF NOT EXISTS douyin_downloads_queue ON douyin_downloads(state, created_at);
      CREATE INDEX IF NOT EXISTS douyin_downloads_requester ON douyin_downloads(requested_by_id, created_at);
      ALTER TABLE douyin_downloads ADD COLUMN IF NOT EXISTS retry_at timestamptz;
      ALTER TABLE douyin_downloads ADD COLUMN IF NOT EXISTS retry_rounds integer NOT NULL DEFAULT 0;
      ALTER TABLE douyin_downloads ADD COLUMN IF NOT EXISTS round_attempts integer NOT NULL DEFAULT 0;
      ALTER TABLE douyin_downloads ADD COLUMN IF NOT EXISTS error_code text;
      CREATE INDEX IF NOT EXISTS douyin_downloads_retry ON douyin_downloads(state, retry_at);
    `);
    // A restart cannot resume a transfer owned by the old process; it starts that post again.
    await this.database.query("UPDATE douyin_downloads SET state='queued',started_at=NULL WHERE state IN ('downloading','uploading')");
    await mkdir(this.options.workDirectory, { recursive: true, mode: 0o700 });
  }

  private time(): string { return new Date(this.now()).toISOString(); }

  private async usedToday(userId: string): Promise<number> {
    return (await this.database.query<{ count: number }>('SELECT count(*)::int AS count FROM douyin_downloads WHERE requested_by_id=$1 AND created_at >= $2',
      [userId, beijingDay(this.now()).start])).rows[0]!.count;
  }

  async status(user: UserIdentity): Promise<DouyinDownloadStatus> {
    return { enabled: true, access: this.options.access, linkSeconds: this.options.linkSeconds, dailyLimit: this.options.dailyLimit,
      usedToday: await this.usedToday(user.id), unlimited: user.role === 'admin', maxMixEpisodes: this.options.maxMixEpisodes };
  }

  /** Latest records, newest first; `mine` limits them to the member's own requests. */
  async list(user: UserIdentity, options: { mine: boolean; mixId?: string; awemeIds?: string[]; limit: number }): Promise<DouyinDownload[]> {
    const where = ['TRUE'], values: unknown[] = [];
    if (options.mine) { values.push(user.id); where.push(`requested_by_id=$${values.length}`); }
    if (options.mixId) { values.push(options.mixId); where.push(`mix_id=$${values.length}`); }
    if (options.awemeIds) { values.push(options.awemeIds); where.push(`aweme_id=ANY($${values.length}::text[])`); }
    values.push(options.limit);
    const url = (key: string) => this.options.access === 'public' ? this.store.link(key, this.options.linkSeconds) : null;
    return (await this.database.query<Row>(`SELECT * FROM douyin_downloads WHERE ${where.join(' AND ')} ORDER BY created_at DESC, episode ASC NULLS LAST, id LIMIT $${values.length}`, values)).rows.map(row => view(row, url));
  }

  async get(id: string): Promise<DouyinDownload | null> {
    if (!/^[0-9a-f-]{36}$/.test(id)) return null;
    const row = (await this.database.query<Row>('SELECT * FROM douyin_downloads WHERE id=$1', [id])).rows[0];
    return row ? view(row) : null;
  }

  /** A GET link for a saved file. */
  async link(id: string): Promise<{ url: string; expiresAt: string | null }> {
    const download = await this.get(id);
    if (!download) throw new DouyinDownloadError('下载记录不存在', 404);
    if (download.state !== 'done') throw new DouyinDownloadError('文件还没有存入 TOS', 409);
    return { url: this.store.link(download.key, this.options.linkSeconds),
      expiresAt: this.options.access === 'private' ? new Date(this.now() + this.options.linkSeconds * 1000).toISOString() : null };
  }

  /** `download-video-date/douyin/<YYYYMMDD>/<mix or post id>/video/<episode>-<post id>.mp4` */
  objectKey(post: { awemeId: string; mixId: string | null; episode: number | null }): string {
    return `${this.root}/douyin/${beijingDay(this.now()).compact}/${post.mixId ?? post.awemeId}/video/${String(post.episode ?? 1).padStart(3, '0')}-${post.awemeId}.mp4`;
  }

  /**
   * Queues posts not yet saved, re-queues failed ones, and leaves queued, running and saved ones alone.
   * New records count against the member's daily limit; administrators are not limited.
   */
  private async enqueue(user: UserIdentity, posts: { awemeId: string; mixId: string | null; mixName: string | null; episode: number | null; title: string }[], partial: boolean): Promise<DouyinDownloadRequestResult> {
    const result: DouyinDownloadRequestResult = { queued: [], existing: [], skipped: 0 };
    let remaining = user.role === 'admin' ? Number.POSITIVE_INFINITY : Math.max(0, this.options.dailyLimit - await this.usedToday(user.id));
    for (const post of posts) {
      const current = (await this.database.query<Row>('SELECT * FROM douyin_downloads WHERE aweme_id=$1', [post.awemeId])).rows[0];
      if (current && current.state !== 'failed') { result.existing.push(view(current)); continue; }
      if (current) {
        const row = (await this.database.query<Row>(`UPDATE douyin_downloads SET state='queued',attempts=0,error=NULL,error_code=NULL,retry_at=NULL,retry_rounds=0,round_attempts=0,started_at=NULL,finished_at=NULL,requested_by=$2
          WHERE id=$1 AND state='failed' RETURNING *`, [current.id, displayName(user)])).rows[0];
        if (row) result.queued.push(view(row));
        continue;
      }
      if (remaining <= 0) {
        if (!partial) throw new DouyinDownloadError(`今天已下载 ${this.options.dailyLimit} 条，明天再试`, 429);
        result.skipped++;
        continue;
      }
      const row = (await this.database.query<Row>(`INSERT INTO douyin_downloads(id,aweme_id,mix_id,mix_name,episode,title,state,object_key,requested_by_id,requested_by,created_at)
        VALUES($1,$2,$3,$4,$5,$6,'queued',$7,$8,$9,$10) ON CONFLICT(aweme_id) DO NOTHING RETURNING *`,
      [randomUUID(), post.awemeId, post.mixId, post.mixName?.slice(0, 200) ?? null, post.episode, post.title.slice(0, 500), this.objectKey(post), user.id, displayName(user), this.time()])).rows[0];
      if (row) { result.queued.push(view(row)); remaining--; }
      else result.existing.push(view((await this.database.query<Row>('SELECT * FROM douyin_downloads WHERE aweme_id=$1', [post.awemeId])).rows[0]!));
    }
    if (result.queued.length) for (const wake of [...this.idle]) wake();
    return result;
  }

  /** Queues one post. Its series and episode come from DTK. */
  async requestPost(user: UserIdentity, awemeId: string): Promise<DouyinDownloadRequestResult> {
    if (!/^\d{1,32}$/.test(awemeId)) throw new DouyinDownloadError('作品编号无效', 400);
    const existing = (await this.database.query<Row>("SELECT * FROM douyin_downloads WHERE aweme_id=$1 AND state<>'failed'", [awemeId])).rows[0];
    if (existing) return { queued: [], existing: [view(existing)], skipped: 0 };
    const video = await readDouyinVideo(this.reader, awemeId);
    return this.enqueue(user, [video], false);
  }

  /**
   * Lists a whole series through DTK and queues every episode in order.
   * @throws When the series has more than `maxMixEpisodes` posts.
   */
  async requestMix(user: UserIdentity, mixId: string): Promise<DouyinDownloadRequestResult> {
    if (!/^\d{1,32}$/.test(mixId)) throw new DouyinDownloadError('合集编号无效', 400);
    const posts = new Map<string, { awemeId: string; mixId: string; mixName: string | null; episode: number | null; title: string }>();
    let cursor: string | null = null;
    for (let page = 0; ; page++) {
      if (page > Math.ceil(this.options.maxMixEpisodes / 20) + 5) throw new DouyinDownloadError('合集翻页没有结束，请稍后再试', 502);
      const data = record(await this.reader.read('mix/posts', { mix_id: mixId, count: '20', include_raw: 'true', ...(cursor ? { cursor } : {}) }));
      const items = Array.isArray(data.items) ? data.items : null;
      if (!items) throw new DouyinDownloadError('抖音合集返回了无法识别的内容', 502);
      for (const item of items) {
        const post = douyinPost(item);
        if (post && !posts.has(post.id)) posts.set(post.id, { awemeId: post.id, mixId, mixName: post.mix?.name ?? null, episode: post.mix?.episode ?? null, title: post.title || post.description.slice(0, 200) });
      }
      if (posts.size > this.options.maxMixEpisodes) throw new DouyinDownloadError(`合集超过 ${this.options.maxMixEpisodes} 集，请改为单集下载`, 400);
      cursor = data.has_more === true && typeof data.cursor === 'string' && data.cursor ? data.cursor : null;
      if (!cursor) break;
    }
    if (!posts.size) throw new DouyinDownloadError('合集里没有作品', 404);
    const ordered = [...posts.values()].map((post, index) => ({ ...post, episode: post.episode ?? index + 1 }))
      .sort((a, b) => a.episode - b.episode || a.awemeId.localeCompare(b.awemeId));
    return this.enqueue(user, ordered, true);
  }

  /** Downloads one due post; cooling posts release their worker slot and keep the same record and object key. */
  async processNext(signal: AbortSignal = this.abort.signal): Promise<boolean> {
    const row = (await this.database.query<Row>(`UPDATE douyin_downloads SET state='downloading',attempts=attempts+1,round_attempts=round_attempts+1,started_at=$1,error=NULL,error_code=NULL,retry_at=NULL
      WHERE id=(SELECT q.id FROM douyin_downloads q WHERE q.state='queued' AND (q.retry_at IS NULL OR q.retry_at <= $1)
        ORDER BY (SELECT count(*) FROM douyin_downloads r WHERE r.requested_by_id=q.requested_by_id AND r.state IN ('downloading','uploading')),
          q.created_at, q.episode NULLS LAST, q.id LIMIT 1) AND state='queued' RETURNING *`, [this.time()])).rows[0];
    if (!row) return false;
    const path = resolve(this.options.workDirectory, `${row.id}.part`);
    try {
      signal.throwIfAborted();
      // A lost upload acknowledgement may already have stored the exact verified bytes.
      if (row.bytes !== null && row.sha256) {
        const saved = await this.store.head(row.object_key);
        signal.throwIfAborted();
        if (saved && (saved.bytes !== Number(row.bytes) || saved.sha256 !== row.sha256)) throw new DouyinDownloadError('TOS 已有同名但内容不同的文件，没有覆盖', 409, false, 'OBJECT_CONFLICT');
        if (saved) {
          await this.database.query("UPDATE douyin_downloads SET state='done',finished_at=$2 WHERE id=$1", [row.id, this.time()]);
          return true;
        }
      }
      const video = await readDouyinVideo(this.reader, row.aweme_id);
      await rm(path, { force: true });
      const file = await downloadVideo(video.urls, path, { maxBytes: this.options.maxVideoBytes, timeoutMs: 15 * 60_000, fetch: this.options.fetch, signal });
      await this.database.query("UPDATE douyin_downloads SET state='uploading',bytes=$2,sha256=$3 WHERE id=$1", [row.id, file.bytes, file.sha256]);
      const before = await this.store.head(row.object_key);
      signal.throwIfAborted();
      if (before && (before.bytes !== file.bytes || before.sha256 !== file.sha256)) throw new DouyinDownloadError('TOS 已有同名但内容不同的文件，没有覆盖', 409, false, 'OBJECT_CONFLICT');
      if (!before) await this.store.upload(row.object_key, path, file.sha256, 'video/mp4', signal);
      const after = await this.store.head(row.object_key);
      signal.throwIfAborted();
      if (!after || after.bytes !== file.bytes || after.sha256 !== file.sha256) throw new DouyinDownloadError('TOS 上的文件大小或 SHA-256 与下载不一致', 502, false, 'OBJECT_MISMATCH');
      await this.database.query("UPDATE douyin_downloads SET state='done',finished_at=$2 WHERE id=$1", [row.id, this.time()]);
    } catch (error) {
      if (signal.aborted) { await this.database.query("UPDATE douyin_downloads SET state='queued',started_at=NULL,attempts=attempts-1,round_attempts=GREATEST(0,round_attempts-1) WHERE id=$1", [row.id]); throw error; }
      const known = error instanceof DouyinDownloadError || error instanceof DouyinSearchError;
      const message = known ? error.message.replace(/https?:\/\/\S+/g, '[地址]').slice(0, 300) : '下载未完成，请联系管理员检查存储或服务状态';
      const searchBlocked = error instanceof DouyinSearchError
        && ['IDENTITY_LOGIN_REQUIRED', 'UPSTREAM_RISK_CONTROL', 'SEARCH_STOPPED', 'SEARCH_PAUSED', 'NOT_FOUND'].includes(error.code ?? '');
      const retry = error instanceof DouyinDownloadError ? error.retryable : error instanceof DouyinSearchError
        && error.status !== 400 && !searchBlocked;
      const errorCode = error instanceof DouyinDownloadError ? error.code : searchBlocked ? error.code : 'SOURCE_UNAVAILABLE';
      const cooldown = retry && row.round_attempts >= this.options.maxAttempts;
      const rounds = row.retry_rounds + (cooldown ? 1 : 0);
      const delay = cooldown ? Math.min(this.maxCooldownMs, this.cooldownMs * 2 ** Math.min(rounds - 1, 20)) : this.retryDelayMs;
      const retryAt = retry ? new Date(this.now() + delay).toISOString() : null;
      await this.database.query(`UPDATE douyin_downloads SET state=$2,error=$3,error_code=$4,finished_at=$5,retry_at=$6,retry_rounds=$7,round_attempts=$8 WHERE id=$1`,
        [row.id, retry ? 'queued' : 'failed', message, known ? errorCode : 'DOWNLOAD_INTERNAL', retry ? null : this.time(), retryAt, rounds, cooldown ? 0 : row.round_attempts]);
      console.error(`[muse-data-web] douyin download ${retry ? 'will retry' : 'failed'}:`, message);
    } finally { await rm(path, { force: true }); }
    return true;
  }

  /** Runs `concurrency` workers; each pauses `intervalMs` after a download and wakes on new requests or every 30 seconds when idle. */
  start(): void {
    if (this.running || this.closing) return;
    this.running = Promise.all(Array.from({ length: this.options.concurrency ?? 1 }, () => this.work())).then(() => undefined);
  }

  private async work(): Promise<void> {
    while (!this.closing) {
      let worked = false;
      try { worked = await this.processNext(); }
      catch (error) { if (this.closing) break; console.error('[muse-data-web] douyin download worker:', error instanceof Error ? error.name : 'Error'); }
      if (this.closing) break;
      const next = worked ? null : (await this.database.query<{ retry_at: Date | string | null }>("SELECT min(retry_at) AS retry_at FROM douyin_downloads WHERE state='queued'")).rows[0]?.retry_at;
      const wait = worked ? this.options.intervalMs : next ? Math.max(0, Math.min(30_000, new Date(next).getTime() - this.now())) : 30_000;
      if (this.closing) break;
      // Cooldowns are durable timestamps, not worker-held sleeps; new posts can still wake an idle worker.
      await new Promise<void>(done => {
        const finish = () => { this.waiting.delete(finish); this.idle.delete(finish); clearTimeout(timer); done(); };
        const timer = setTimeout(finish, wait);
        timer.unref();
        this.waiting.add(finish);
        if (!worked) this.idle.add(finish);
      });
    }
  }

  async stop(): Promise<void> {
    this.closing = true;
    this.abort.abort();
    for (const finish of [...this.waiting]) finish();
    await this.running;
  }
}

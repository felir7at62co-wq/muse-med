import { createHash } from 'node:crypto';
import type { PGlite } from '@electric-sql/pglite';
import { z } from 'zod';
import type { CollectionBatch, DiscoveryStatus, Platform } from '../../shared/types.ts';
import type { CollectionManager } from '../collection-manager.ts';
import type { DataRepository } from '../repository.ts';
import { runDiscoveryQueue, type DiscoveryTask } from './crawler.ts';

export type { DiscoveryStatus } from '../../shared/types.ts';

/** One platform's explicit public entry points and page extraction. */
export interface DiscoveryAdapter {
  platform: Platform;
  seeds(cycle: string, signal: AbortSignal): Promise<DiscoveryTask[]>;
  handle(task: DiscoveryTask, signal: AbortSignal): Promise<{ batch?: CollectionBatch; next: DiscoveryTask[]; coverage: string }>;
}

interface Options {
  directory: string;
  intervalMs: number;
  pageBudget: number;
  requestsPerMinute: number;
  maxRetries: number;
  resumeDelayMs: number;
  now?: () => number;
  runQueue?: typeof runDiscoveryQueue;
}

/** Platforms with catalog discovery state; 绿泡泡 is fed by its Mac collector instead. */
const platforms = ['hongguo', 'douyin', 'fanqie', 'qimao'] as const;
type DiscoveryPlatform = typeof platforms[number];
/** Upper bound on retained failed pages per platform; past it the oldest failure is dropped so the queue never stalls. */
const MAX_FAILURES = 5_000;
/** Failed pages re-queued per run; the rest stay marked for the following runs. */
const MAX_RETRY_SEEDS = 200;
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const date = z.string().datetime().nullable();
const taskSchema = z.object({
  url: z.string().url().refine(value => ['http:', 'https:'].includes(new URL(value).protocol)),
  uniqueKey: z.string().min(1).max(500),
  data: z.record(z.string(), z.json()),
  priority: z.literal('front').optional(),
}).strict().refine(task => JSON.stringify(task).length <= 65_536, 'Discovery task exceeds saved size limit');
const statusSchema = z.object({
  platform: z.enum(platforms), state: z.enum(['idle', 'running', 'success', 'failed', 'not_configured']),
  count, newWorks: count, lastRunNewWorks: count, pending: count, failed: count,
  lastAttemptAt: date, lastSuccessAt: date, lastPublishedAt: date, nextRunAt: date,
  coverage: z.string().max(2_000), message: z.string().max(400),
}).strict();
const savedSchema = z.object({
  version: z.literal(1), intervalMs: z.number().int().positive(), cycle: z.string().max(80).nullable(),
  complete: z.boolean(), seeds: z.array(taskSchema).max(1_000), status: statusSchema,
  /** Failed pages saved before they moved to `discovery_failures`; initialization moves them and leaves this empty. */
  failures: z.array(z.object({ task: taskSchema, round: count, retryKey: z.string().min(1).max(500).nullable() }).strict()).max(100),
}).strict();
type SavedState = z.infer<typeof savedSchema>;

function key(platform: Platform): string { return `discovery_state_v1:${platform}`; }
function hash(value: string): string { return createHash('sha256').update(value).digest('hex'); }

/** Durable discovery progress; Crawlee owns page cursors and CollectionManager owns platform cancellation. */
export class DiscoveryManager {
  private initializing: Promise<void> | undefined;
  private readonly active = new Map<Platform, Promise<void>>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private closing = false;
  private ticking = false;
  private periodMs: number;
  private readonly now: () => number;
  private readonly runQueue: typeof runDiscoveryQueue;

  constructor(private readonly repository: DataRepository,
    private readonly collections: Pick<CollectionManager, 'requestTask'>,
    private readonly adapters: Partial<Record<Platform, DiscoveryAdapter>>,
    private readonly options: Options) {
    z.object({ directory: z.string().min(1), intervalMs: z.number().int().positive(), pageBudget: z.number().int().min(1).max(10_000),
      requestsPerMinute: z.number().int().min(1).max(120), maxRetries: z.number().int().min(0).max(3),
      resumeDelayMs: z.number().int().positive() }).parse(options);
    for (const platform of platforms) if (adapters[platform] && adapters[platform]!.platform !== platform) throw new Error('Discovery adapter platform mismatch');
    this.periodMs = options.intervalMs;
    this.now = options.now ?? Date.now;
    this.runQueue = options.runQueue ?? runDiscoveryQueue;
  }

  private cycle(): string { return `${this.periodMs}:${Math.floor(this.now() / this.periodMs)}`; }
  private time(): string { return new Date(this.now()).toISOString(); }

  private initial(platform: DiscoveryPlatform): SavedState {
    return { version: 1, intervalMs: this.periodMs, cycle: null, complete: true, seeds: [], failures: [],
      status: { platform, state: 'not_configured', count: 0, newWorks: 0, lastRunNewWorks: 0, pending: 0, failed: 0,
        lastAttemptAt: null, lastSuccessAt: null, lastPublishedAt: null, nextRunAt: null,
        coverage: '尚无真实发现覆盖', message: '该平台尚未接入发现入口' } };
  }

  private parse(value: unknown, platform: Platform): SavedState {
    const parsed = savedSchema.safeParse(value);
    if (!parsed.success || parsed.data.status.platform !== platform) throw new Error(`Invalid saved discovery state: ${platform}`);
    const saved = parsed.data;
    if (new Set(saved.failures.map(item => item.task.uniqueKey)).size !== saved.failures.length
      || new Set(saved.seeds.map(item => item.uniqueKey)).size !== saved.seeds.length
      || saved.status.lastRunNewWorks > saved.status.newWorks || (!saved.complete && saved.cycle === null)) {
      throw new Error(`Inconsistent saved discovery state: ${platform}`);
    }
    return saved;
  }

  private async read(platform: Platform, client: Pick<PGlite, 'query'> = this.repository.database): Promise<SavedState> {
    const result = await client.query<{ value: unknown }>('SELECT value FROM data_settings WHERE key=$1', [key(platform)]);
    return this.parse(result.rows[0]?.value, platform);
  }

  private async update(platform: Platform, change: (saved: SavedState) => void, client?: Pick<PGlite, 'query'>): Promise<SavedState> {
    const write = async (transaction: Pick<PGlite, 'query'>) => {
      const result = await transaction.query<{ value: unknown }>('SELECT value FROM data_settings WHERE key=$1 FOR UPDATE', [key(platform)]);
      const saved = this.parse(result.rows[0]?.value, platform);
      change(saved);
      this.parse(saved, platform);
      await transaction.query('UPDATE data_settings SET value=$2::jsonb WHERE key=$1', [key(platform), JSON.stringify(saved)]);
      return saved;
    };
    return client ? write(client) : this.repository.database.transaction(write);
  }

  /** Unfinished queues resume after the short delay; failed pages alone wait for the next cycle. */
  private nextRun(saved: SavedState): string {
    const next = !saved.complete || saved.status.pending > 0
      ? this.now() + this.options.resumeDelayMs
      : saved.cycle !== this.cycle() ? this.now() : (Math.floor(this.now() / this.periodMs) + 1) * this.periodMs;
    return new Date(next).toISOString();
  }

  /** Validates saved JSON without replacing corrupt progress or clearing Crawlee queues. */
  async initialize(): Promise<void> {
    this.initializing ??= this.initializeStates();
    return this.initializing;
  }

  /** Counts a platform's retained failed pages. */
  private async failedCount(platform: Platform, client: Pick<PGlite, 'query'> = this.repository.database): Promise<number> {
    return count.parse((await client.query<{ total: number }>('SELECT count(*)::integer AS total FROM discovery_failures WHERE platform=$1', [platform])).rows[0]!.total);
  }

  private async initializeStates(): Promise<void> {
    await this.repository.database.exec(`CREATE TABLE IF NOT EXISTS discovery_failures (platform text NOT NULL, unique_key text NOT NULL,
      task jsonb NOT NULL, round integer NOT NULL CHECK (round >= 0), retry_key text, failed_at timestamptz NOT NULL, PRIMARY KEY(platform,unique_key));
      CREATE INDEX IF NOT EXISTS discovery_failures_retry ON discovery_failures(platform,retry_key);`);
    for (const platform of platforms) {
      await this.repository.database.query('INSERT INTO data_settings(key,value) VALUES($1,$2::jsonb) ON CONFLICT DO NOTHING',
        [key(platform), JSON.stringify(this.initial(platform))]);
      await this.repository.database.transaction(async transaction => {
        const saved = await this.read(platform, transaction);
        if (!saved.failures.length) return;
        for (const failure of saved.failures) {
          await transaction.query(`INSERT INTO discovery_failures(platform,unique_key,task,round,retry_key,failed_at) VALUES($1,$2,$3::jsonb,$4,$5,$6)
            ON CONFLICT DO NOTHING`, [platform, failure.task.uniqueKey, JSON.stringify(failure.task), failure.round, failure.retryKey, this.time()]);
        }
        const failed = await this.failedCount(platform, transaction);
        await this.update(platform, state => { state.failures = []; state.status.failed = failed; }, transaction);
      });
      await this.update(platform, saved => {
        const changedInterval = saved.intervalMs !== this.periodMs;
        saved.intervalMs = this.periodMs;
        if (!this.adapters[platform]) {
          saved.status.state = 'not_configured'; saved.status.nextRunAt = null;
          saved.status.message = '该平台尚未接入发现入口；已保存数据与队列保留';
        } else if (saved.status.state === 'running') {
          saved.status.state = 'failed';
          if (saved.cycle !== null) saved.complete = false;
          saved.status.nextRunAt = this.nextRun(saved);
          saved.status.message = '服务在上次发现任务中停止；已保存数据与队列保留，等待续采';
        } else if (saved.status.state === 'not_configured') {
          saved.status.state = 'idle'; saved.status.nextRunAt = this.time();
          saved.status.message = '发现入口已接入，等待采集公开页面';
        } else if (changedInterval || saved.status.nextRunAt === null) saved.status.nextRunAt = this.nextRun(saved);
      });
    }
  }

  /** Returns persisted per-platform progress, including unconfigured platforms. */
  async list(): Promise<DiscoveryStatus[]> {
    await this.initialize();
    return Promise.all(platforms.map(async platform => (await this.read(platform)).status));
  }

  /** Changes future scheduling without discarding the current cycle, failures, or queue. */
  async setIntervalHours(hours: number): Promise<void> {
    if (!Number.isInteger(hours) || hours < 1 || hours > 168) throw new Error('更新间隔必须是 1 至 168 小时的整数');
    await this.initialize();
    this.periodMs = hours * 3_600_000;
    for (const platform of platforms) await this.update(platform, saved => {
      saved.intervalMs = this.periodMs;
      if (this.adapters[platform]) saved.status.nextRunAt = !saved.complete || saved.status.pending > 0
        ? new Date(this.now() + this.options.resumeDelayMs).toISOString()
        : saved.status.lastAttemptAt ? new Date(Date.parse(saved.status.lastAttemptAt) + this.periodMs).toISOString() : this.time();
    });
  }

  /** Claims the ranking collector's platform lock; completion continues in its owned task. */
  async request(platform: Platform, scheduled = false): Promise<boolean> {
    if (this.closing) return false;
    if (!this.adapters[platform]) throw new Error('该平台尚未配置发现入口');
    if (this.active.has(platform)) return false;
    let release: () => void = () => {};
    const done = new Promise<void>(resolve => { release = resolve; });
    this.active.set(platform, done);
    try {
      await this.initialize();
      const saved = await this.read(platform);
      if (this.closing || (scheduled && (!saved.status.nextRunAt || Date.parse(saved.status.nextRunAt) > this.now()))) {
        this.active.delete(platform); release(); return false;
      }
      const accepted = await this.collections.requestTask(platform, async signal => {
        try { await this.run(platform, signal, scheduled); }
        finally { this.active.delete(platform); release(); }
      });
      if (!accepted) { this.active.delete(platform); release(); }
      return accepted;
    } catch (error) { this.active.delete(platform); release(); throw error; }
  }

  private scope(tasks: DiscoveryTask[], platform: Platform, cycle: string): z.infer<typeof taskSchema>[] {
    const prefix = `${platform}:${cycle}:`;
    return z.array(taskSchema).max(1_000).parse(tasks).map(task => ({ ...task,
      uniqueKey: task.uniqueKey.startsWith(prefix) ? task.uniqueKey : `${prefix}${hash(task.uniqueKey)}` }));
  }

  private async run(platform: Platform, signal: AbortSignal, scheduled: boolean): Promise<void> {
    const adapter = this.adapters[platform]!;
    let handled = 0;
    try {
      let saved = await this.update(platform, state => {
        state.status.state = 'running'; state.status.lastAttemptAt = this.time(); state.status.lastRunNewWorks = 0;
        state.status.message = '正在发现公开页面；已发布作品可继续查询';
      });
      signal.throwIfAborted();
      const newCycle = saved.cycle !== this.cycle();
      if (newCycle) {
        const cycle = this.cycle();
        const seeds = this.scope(await adapter.seeds(cycle, signal), platform, cycle);
        signal.throwIfAborted();
        saved = await this.update(platform, state => { state.cycle = cycle; state.seeds = seeds; state.complete = false; });
      }
      // Exhausted pages get one new retry round per cycle or administrator request, never per scheduled short resume.
      // The same retry key survives a crash before enqueue or acknowledgement.
      saved = await this.repository.database.transaction(async transaction => {
        if (newCycle || !scheduled) {
          const waiting = await transaction.query<{ unique_key: string; round: number }>('SELECT unique_key,round FROM discovery_failures WHERE platform=$1 AND retry_key IS NULL', [platform]);
          for (const failure of waiting.rows) {
            await transaction.query('UPDATE discovery_failures SET round=$3,retry_key=$4 WHERE platform=$1 AND unique_key=$2',
              [platform, failure.unique_key, failure.round + 1, `retry:${platform}:${hash(failure.unique_key)}:${failure.round + 1}`]);
          }
        }
        return this.update(platform, state => { state.complete = false; }, transaction);
      });
      const retries = await this.repository.database.query<{ task: unknown; retry_key: string }>(`SELECT task,retry_key FROM discovery_failures
        WHERE platform=$1 AND retry_key IS NOT NULL ORDER BY failed_at,unique_key LIMIT $2`, [platform, MAX_RETRY_SEEDS]);
      const result = await this.runQueue({ directory: this.options.directory, platform, seeds: [
        ...saved.seeds, ...retries.rows.map(row => ({ ...taskSchema.parse(row.task), uniqueKey: row.retry_key })),
      ], prioritizeSeeds: true, maxRequests: this.options.pageBudget, maxRequestsPerMinute: this.options.requestsPerMinute,
      maxRetries: this.options.maxRetries, signal,
      handle: async task => {
        signal.throwIfAborted();
        const extracted = await adapter.handle(task, signal);
        const next = z.array(taskSchema).max(1_000).parse(extracted.next);
        const coverage = z.string().min(1).max(2_000).parse(extracted.coverage);
        signal.throwIfAborted();
        const publish = async (client: Pick<PGlite, 'query'>, added: number) => {
          await client.query('DELETE FROM discovery_failures WHERE platform=$1 AND (unique_key=$2 OR retry_key=$2)', [platform, task.uniqueKey]);
          const failed = await this.failedCount(platform, client);
          await this.update(platform, state => {
            state.status.count++; state.status.newWorks += added; state.status.lastRunNewWorks += added;
            state.status.coverage = coverage;
            if (extracted.batch) state.status.lastPublishedAt = new Date(Math.max(this.now(),
              state.status.lastPublishedAt ? Date.parse(state.status.lastPublishedAt) + 1 : 0)).toISOString();
            state.status.failed = failed;
            state.status.message = `本轮已采集 ${handled + 1} 页，新增 ${state.status.lastRunNewWorks} 部作品；覆盖以页面说明为准`;
          }, client);
        };
        if (extracted.batch) {
          if (extracted.batch.platform !== platform) throw new Error('Discovery batch platform mismatch');
          await this.repository.ingestDiscoveryPage(extracted.batch, publish);
        } else await this.repository.database.transaction(transaction => publish(transaction, 0));
        handled++;
        return next;
      },
      onFailed: async task => {
        const parsed = taskSchema.parse(task);
        await this.repository.database.transaction(async transaction => {
          const previous = await transaction.query('UPDATE discovery_failures SET retry_key=NULL,failed_at=$3 WHERE platform=$1 AND (retry_key=$2 OR unique_key=$2) RETURNING unique_key',
            [platform, task.uniqueKey, this.time()]);
          if (!previous.rows.length) {
            await transaction.query('INSERT INTO discovery_failures(platform,unique_key,task,round,retry_key,failed_at) VALUES($1,$2,$3::jsonb,0,NULL,$4)',
              [platform, parsed.uniqueKey, JSON.stringify(parsed), this.time()]);
          }
          const dropped = await transaction.query(`DELETE FROM discovery_failures WHERE platform=$1 AND unique_key IN (SELECT unique_key FROM discovery_failures
            WHERE platform=$1 ORDER BY failed_at DESC,unique_key OFFSET $2) RETURNING unique_key`, [platform, MAX_FAILURES]);
          if (dropped.rows.length) console.error(`[muse-data-web] ${platform} discovery dropped ${dropped.rows.length} oldest failed pages beyond ${MAX_FAILURES}`);
          const failed = await this.failedCount(platform, transaction);
          await this.update(platform, state => { state.status.failed = failed; }, transaction);
        });
      } });
      await this.update(platform, state => {
        state.status.pending = count.parse(result.pending);
        state.complete = result.pending === 0 && !signal.aborted;
        const failed = signal.aborted || result.failed > 0 || state.status.failed > 0;
        state.status.state = failed ? 'failed' : 'success';
        if (!failed) state.status.lastSuccessAt = this.time();
        state.status.nextRunAt = this.nextRun(state);
        state.status.message = `${signal.aborted ? '本轮已停止' : failed ? '本轮部分页面未完成' : '本轮采集完成'}：成功 ${handled} 页，新增 ${state.status.lastRunNewWorks} 部作品；待续采 ${state.status.pending} 页，待重试 ${state.status.failed} 页${state.status.failed ? '（下个周期或手动继续时重试）' : ''}；仅覆盖已发现的公开页面`;
      });
    } catch (error) {
      await this.update(platform, state => {
        state.status.state = 'failed';
        if (state.cycle !== null) state.complete = false;
        state.status.nextRunAt = new Date(this.now() + this.options.resumeDelayMs).toISOString();
        state.status.message = `本轮发现任务中断：已成功 ${handled} 页，新增 ${state.status.lastRunNewWorks} 部作品；已保存数据、失败页与队列保留，等待续采`;
      });
      if (!signal.aborted) console.error(`[muse-data-web] ${platform} discovery run failed:`, error instanceof Error
        ? `${error.name}: ${error.message.replace(/https?:\/\/\S+/g, '[来源地址]').slice(0, 300)}` : 'Error');
    }
  }

  /** Starts due platforms independently so one slow or failed source cannot block another. */
  async tick(): Promise<void> {
    if (this.closing || this.ticking) return;
    this.ticking = true;
    try {
      await Promise.all(platforms.map(async platform => {
        if (!this.adapters[platform]) return;
        try { if (await this.request(platform, true)) await this.active.get(platform); }
        catch (error) { console.error('[muse-data-web] discovery schedule failed:', error instanceof Error ? error.name : 'Error'); }
      }));
    } finally { this.ticking = false; }
  }

  /** Polls persisted due dates; the shorter continuation delay applies between bounded batches. */
  start(): void {
    if (this.closing || this.timer) return;
    const poll = async () => {
      try { await this.tick(); }
      finally {
        if (!this.closing) {
          this.timer = setTimeout(() => { void poll(); }, Math.min(60_000, this.periodMs, this.options.resumeDelayMs));
          this.timer.unref();
        }
      }
    };
    this.timer = setTimeout(() => { void poll(); }, 0); this.timer.unref();
  }

  /** Waits for owned workflows after the collection manager has cancelled them, when needed. */
  async waitForIdle(): Promise<void> { await Promise.all([...this.active.values()]); }

  /** Stops discovery scheduling. CollectionManager.stop cancels and joins all platform workflows. */
  async stop(): Promise<void> {
    this.closing = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}

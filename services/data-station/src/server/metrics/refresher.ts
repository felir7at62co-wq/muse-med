/**
 * Scheduled detail-page metric refresh for catalog-only works.
 * Rankings refresh their own works' metrics; works found only through catalog discovery have no metrics until this job reads them.
 */
import type { PGlite } from '@electric-sql/pglite';
import { z } from 'zod';
import type { Metric, MetricRefreshStatus, Platform, Work } from '../../shared/types.ts';
import type { CollectionManager } from '../collection-manager.ts';
import type { DataRepository } from '../repository.ts';
import { metricsMeasuredAt } from '../../shared/metrics.ts';
import { pace, type MetricSource } from './sources.ts';

/** Deployment-tunable pacing; validated by the server configuration. */
export interface MetricRefreshOptions {
  /** Works read per platform per run. */
  batchSize: number;
  /** Time between two runs of one platform. */
  intervalMs: number;
  /** Metrics measured longer ago than this are read again. */
  maxAgeMs: number;
  /** Wait before reading a work again after a failed or missing reading. */
  retryMs: number;
  /** Spacing between two works of one run. */
  requestIntervalMs: number;
  now?: () => number;
}

const platforms = ['hongguo', 'douyin', 'fanqie', 'qimao'] as const;
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const date = z.string().datetime().nullable();
const statusSchema = z.object({
  platform: z.enum(platforms), state: z.enum(['idle', 'running', 'success', 'failed', 'not_configured']),
  due: count, refreshed: count, lastRunRefreshed: count, lastRunFailed: count,
  lastAttemptAt: date, lastSuccessAt: date, nextRunAt: date, message: z.string().max(400),
}).strict();

function key(platform: Platform): string { return `metric_refresh_v1:${platform}`; }

/** Replaces the values this reading measured; every other metric is unknown at the reading time. */
function merge(previous: Metric[], measured: Metric[]): Metric[] {
  const read = new Map(measured.map(metric => [metric.key, metric]));
  const kept = previous.map(metric => read.get(metric.key) ?? { ...metric, value: null });
  return [...kept, ...measured.filter(metric => !previous.some(old => old.key === metric.key))];
}


/**
 * Reads due works' detail pages in small paced batches under each platform's collection lock,
 * so a refresh never overlaps that platform's ranking collection or discovery.
 */
export class MetricRefresher {
  private initializing: Promise<void> | undefined;
  private readonly active = new Map<Platform, Promise<void>>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private closing = false;
  private ticking = false;
  private readonly now: () => number;

  constructor(private readonly repository: DataRepository,
    private readonly collections: Pick<CollectionManager, 'requestTask'>,
    private readonly sources: Partial<Record<Platform, MetricSource>>,
    private readonly options: MetricRefreshOptions) {
    z.object({ batchSize: z.number().int().min(1).max(500), intervalMs: z.number().int().min(60_000), maxAgeMs: z.number().int().min(3_600_000),
      retryMs: z.number().int().min(60_000), requestIntervalMs: z.number().int().min(0).max(60_000) }).parse(options);
    for (const platform of platforms) if (sources[platform] && sources[platform]!.platform !== platform) throw new Error('Metric source platform mismatch');
    this.now = options.now ?? Date.now;
  }

  private time(offset = 0): string { return new Date(this.now() + offset).toISOString(); }
  private get database(): PGlite { return this.repository.database; }

  private async read(platform: Platform): Promise<MetricRefreshStatus> {
    const result = await this.database.query<{ value: unknown }>('SELECT value FROM data_settings WHERE key=$1', [key(platform)]);
    const status = statusSchema.parse(result.rows[0]?.value);
    if (status.platform !== platform) throw new Error(`Inconsistent metric refresh state: ${platform}`);
    return status;
  }

  private async update(platform: Platform, change: (status: MetricRefreshStatus) => void): Promise<MetricRefreshStatus> {
    const status = await this.read(platform);
    change(status);
    await this.database.query('UPDATE data_settings SET value=$2::jsonb WHERE key=$1', [key(platform), JSON.stringify(statusSchema.parse(status))]);
    return status;
  }

  /** Creates the attempt table and per-platform status; a run interrupted by a stop is reported as failed. */
  async initialize(): Promise<void> {
    this.initializing ??= (async () => {
      await this.database.exec(`CREATE TABLE IF NOT EXISTS metric_refresh_attempts (work_id text PRIMARY KEY,
        attempted_at timestamptz NOT NULL, outcome text NOT NULL CHECK (outcome IN ('success','missing','failed')))`);
      for (const platform of platforms) {
        const initial: MetricRefreshStatus = { platform, state: 'not_configured', due: 0, refreshed: 0, lastRunRefreshed: 0, lastRunFailed: 0,
          lastAttemptAt: null, lastSuccessAt: null, nextRunAt: null, message: '该平台没有作品详情指标来源' };
        await this.database.query('INSERT INTO data_settings(key,value) VALUES($1,$2::jsonb) ON CONFLICT DO NOTHING', [key(platform), JSON.stringify(initial)]);
        await this.update(platform, status => {
          if (!this.sources[platform]) { status.state = 'not_configured'; status.nextRunAt = null; status.message = '该平台没有作品详情指标来源'; }
          else if (status.state === 'running') { status.state = 'failed'; status.nextRunAt = this.time(); status.message = '服务在上次指标刷新中停止；已保存的指标保留，等待下次运行'; }
          else if (status.state === 'not_configured') { status.state = 'idle'; status.nextRunAt = this.time(); status.message = '等待首次指标刷新'; }
          else status.nextRunAt ??= this.time();
        });
      }
    })();
    return this.initializing;
  }

  /** Returns each platform's persisted refresh progress. */
  async list(): Promise<MetricRefreshStatus[]> {
    await this.initialize();
    return Promise.all(platforms.map(platform => this.read(platform)));
  }

  /**
   * Selects catalog-only live works whose metrics are missing or older than `maxAgeMs`, skipping recent attempts.
   * Never-measured works come first, newest discovered first; then the longest-unmeasured works.
   */
  private async candidates(platform: Platform): Promise<{ due: number; works: Work[] }> {
    const now = this.now();
    const attempts = new Map((await this.database.query<{ work_id: string; attempted_at: Date | string; outcome: string }>(
      'SELECT work_id,attempted_at,outcome FROM metric_refresh_attempts WHERE work_id LIKE $1', [`${platform}:%`])).rows
      .map(row => [row.work_id, { at: new Date(row.attempted_at).getTime(), outcome: row.outcome }]));
    const due = (await this.repository.catalogOnlyWorks(platform)).filter(work => {
      const measured = metricsMeasuredAt(work);
      if (measured !== null && now - Date.parse(measured) < this.options.maxAgeMs) return false;
      const attempt = attempts.get(work.id);
      return !attempt || now - attempt.at >= (attempt.outcome === 'success' ? this.options.maxAgeMs : this.options.retryMs);
    }).sort((a, b) => {
      const ma = metricsMeasuredAt(a), mb = metricsMeasuredAt(b);
      if ((ma === null) !== (mb === null)) return ma === null ? -1 : 1;
      if (ma === null) return b.observedAt.localeCompare(a.observedAt) || a.id.localeCompare(b.id);
      return Date.parse(ma) - Date.parse(mb!) || a.id.localeCompare(b.id);
    });
    return { due: due.length, works: due.slice(0, this.options.batchSize) };
  }

  private async attempt(workId: string, outcome: 'success' | 'missing' | 'failed'): Promise<void> {
    await this.database.query(`INSERT INTO metric_refresh_attempts(work_id,attempted_at,outcome) VALUES($1,$2,$3)
      ON CONFLICT(work_id) DO UPDATE SET attempted_at=EXCLUDED.attempted_at,outcome=EXCLUDED.outcome`, [workId, this.time(), outcome]);
  }

  /**
   * Starts one run under the platform's collection lock.
   * @param platform Platform with a metric source.
   * @param scheduled When true, runs only once the saved next run time has passed.
   * @returns False while the platform is busy, already refreshing, or not yet due.
   */
  async request(platform: Platform, scheduled = false): Promise<boolean> {
    if (this.closing) return false;
    if (!this.sources[platform]) throw new Error('该平台没有作品详情指标来源');
    if (this.active.has(platform)) return false;
    await this.initialize();
    const status = await this.read(platform);
    if (scheduled && (!status.nextRunAt || Date.parse(status.nextRunAt) > this.now())) return false;
    let release: () => void = () => {};
    this.active.set(platform, new Promise<void>(resolve => { release = resolve; }));
    const accepted = await this.collections.requestTask(platform, async signal => {
      try { await this.run(platform, signal); }
      finally { this.active.delete(platform); release(); }
    });
    if (!accepted) { this.active.delete(platform); release(); }
    return accepted;
  }

  private async run(platform: Platform, signal: AbortSignal): Promise<void> {
    const source = this.sources[platform]!;
    let refreshed = 0, failed = 0, due = 0;
    try {
      await this.update(platform, status => { status.state = 'running'; status.lastAttemptAt = this.time(); status.message = '正在读取作品详情页指标'; });
      const selected = await this.candidates(platform);
      due = selected.due;
      for (const [index, work] of selected.works.entries()) {
        if (index) await pace(this.options.requestIntervalMs, signal);
        signal.throwIfAborted();
        let reading;
        try { reading = await source.read(work, signal); }
        catch (error) {
          if (signal.aborted) throw error;
          failed++;
          await this.attempt(work.id, 'failed');
          console.error(`[muse-data-web] ${platform} metric reading failed:`, error instanceof Error ? `${error.name}: ${error.message.replace(/https?:\/\/\S+/g, '[来源地址]').slice(0, 200)}` : 'Error');
          continue;
        }
        if (!reading) { await this.attempt(work.id, 'missing'); continue; }
        const { metricsObservedAt: _measured, ...current } = work;
        await this.repository.ingestBatch({ platform, observedAt: reading.measuredAt, coverage: '作品详情页指标刷新',
          works: [{ ...current, metrics: merge(work.metrics, reading.metrics), observedAt: reading.measuredAt }] });
        await this.attempt(work.id, 'success');
        refreshed++;
      }
      await this.update(platform, status => {
        status.state = failed ? 'failed' : 'success';
        status.due = Math.max(0, due - refreshed);
        status.refreshed += refreshed; status.lastRunRefreshed = refreshed; status.lastRunFailed = failed;
        if (!failed) status.lastSuccessAt = this.time();
        status.nextRunAt = this.time(this.options.intervalMs);
        status.message = `本轮读取 ${refreshed + failed} 部作品详情：更新指标 ${refreshed} 部${failed ? `，失败 ${failed} 部（${Math.round(this.options.retryMs / 3_600_000)} 小时后重试）` : ''}；仍待刷新 ${Math.max(0, due - refreshed)} 部`;
      });
    } catch (error) {
      await this.update(platform, status => {
        status.state = 'failed';
        status.refreshed += refreshed; status.lastRunRefreshed = refreshed; status.lastRunFailed = failed;
        status.nextRunAt = this.time(this.options.intervalMs);
        status.message = `${signal.aborted ? '指标刷新已停止' : '指标刷新中断'}：已更新 ${refreshed} 部；已保存的指标保留`;
      });
      if (!signal.aborted) console.error(`[muse-data-web] ${platform} metric refresh failed:`, error instanceof Error ? error.name : 'Error');
    }
  }

  /** Starts due platforms independently. */
  async tick(): Promise<void> {
    if (this.closing || this.ticking) return;
    this.ticking = true;
    try {
      await Promise.all(platforms.map(async platform => {
        if (!this.sources[platform]) return;
        try { if (await this.request(platform, true)) await this.active.get(platform); }
        catch (error) { console.error('[muse-data-web] metric refresh schedule failed:', error instanceof Error ? error.name : 'Error'); }
      }));
    } finally { this.ticking = false; }
  }

  /** Polls saved due times every minute; a platform busy with another job is tried again at the next poll. */
  start(): void {
    if (this.closing || this.timer) return;
    const poll = async () => {
      try { await this.tick(); }
      finally {
        if (!this.closing) { this.timer = setTimeout(() => { void poll(); }, Math.min(60_000, this.options.intervalMs)); this.timer.unref(); }
      }
    };
    this.timer = setTimeout(() => { void poll(); }, 0); this.timer.unref();
  }

  /** Waits for owned runs after the collection manager has cancelled them. */
  async waitForIdle(): Promise<void> { await Promise.all([...this.active.values()]); }

  /** Stops scheduling; CollectionManager.stop cancels and joins running tasks. */
  async stop(): Promise<void> {
    this.closing = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}

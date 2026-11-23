import type { CollectionBatch, CollectorStatus, Platform } from '../shared/types.ts';
import { PLATFORM_LABELS } from '../shared/types.ts';
import type { DataRepository } from './repository.ts';
import { sliceText } from '../shared/text.ts';

export type Collector = (signal: AbortSignal) => Promise<CollectionBatch>;
export type Collectors = Partial<Record<Platform, Collector>>;

/** Delay before retrying a failed attempt; doubles per consecutive failure and never exceeds the regular interval. */
export interface CollectionRetryOptions { retryDelayMs?: number; }

function sourceReason(error: unknown): string {
  const raw = error instanceof Error ? error.message : '';
  return /^(红果|七猫|番茄|抖音)/.test(raw) ? sliceText(raw.replace(/https?:\/\/\S+/g, '[来源地址]'), 0, 400) : '来源访问或数据解析未完成，请稍后重试';
}

/** Coordinates manual and scheduled collections using the same per-platform lock and durable status. */
export class CollectionManager {
  private readonly active = new Map<Platform, { done: Promise<void>; abort: AbortController }>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private closing = false;
  private ticking = false;
  private readonly retryDelayMs: number;

  constructor(private readonly repository: DataRepository, private readonly collectors: Collectors,
    private periodMs = 6 * 60 * 60 * 1000, private readonly now: () => number = Date.now, options: CollectionRetryOptions = {}) {
    if (!Number.isFinite(periodMs) || periodMs < 1) throw new Error('Invalid collection interval');
    this.retryDelayMs = options.retryDelayMs ?? 30 * 60_000;
    if (!Number.isInteger(this.retryDelayMs) || this.retryDelayMs < 1) throw new Error('Invalid collection retry delay');
  }

  get intervalMs(): number { return this.periodMs; }

  async setIntervalHours(hours: number): Promise<void> {
    if (!Number.isInteger(hours) || hours < 1 || hours > 168) throw new Error('更新间隔必须是 1 至 168 小时的整数');
    await this.repository.saveCollectionInterval(hours, Object.keys(this.collectors) as Platform[], new Date(this.now()).toISOString());
    this.periodMs = hours * 3_600_000;
  }

  /** Keeps previous success data and derives the next due time across application restarts. */
  async initialize(): Promise<void> {
    for (const previous of await this.repository.collectors()) {
      if (!this.collectors[previous.platform]) continue;
      const attempted = previous.lastAttemptAt ? Date.parse(previous.lastAttemptAt) : NaN;
      const next = previous.nextRunAt ? Date.parse(previous.nextRunAt) : NaN;
      const nextAt = Number.isFinite(next) && previous.intervalHours === this.intervalMs / 3_600_000
        ? next : Number.isFinite(attempted) ? attempted + this.intervalMs : this.now();
      await this.repository.updateCollector({ ...previous,
        state: previous.state === 'not_configured' ? 'idle' : previous.state,
        message: previous.state === 'not_configured' ? '已接入公开数据，等待首次采集' : previous.message,
        nextRunAt: new Date(nextAt).toISOString(), intervalHours: this.intervalMs / 3_600_000,
      });
    }
  }

  has(platform: Platform): boolean { return Boolean(this.collectors[platform]); }

  /** Runs discovery under the same platform lock and shutdown signal as ranking collection. */
  async requestTask(platform: Platform, task: (signal: AbortSignal) => Promise<void>): Promise<boolean> {
    if (this.closing || this.active.has(platform)) return false;
    let release: () => void = () => {};
    const done = new Promise<void>(resolve => { release = resolve; });
    const abort = new AbortController();
    this.active.set(platform, { done, abort });
    void Promise.resolve().then(() => task(abort.signal)).catch(error => {
      console.error('[muse-data-web] discovery task failed:', error instanceof Error ? error.name : 'Error');
    }).finally(() => { this.active.delete(platform); release(); });
    return true;
  }

  /** Starts one attempt, or returns false while the platform already has an owned job. */
  async request(platform: Platform, scheduled = false): Promise<boolean> {
    if (this.closing) throw new Error('数据站正在停止，请稍后重试');
    const collect = this.collectors[platform];
    if (!collect) throw new Error('该平台尚未配置真实采集器');
    if (this.active.has(platform)) return false;
    let release: () => void = () => {};
    const done = new Promise<void>(resolve => { release = resolve; });
    const abort = new AbortController();
    this.active.set(platform, { done, abort });
    const attemptedAt = new Date(this.now()).toISOString();
    let running: CollectorStatus;
    try {
      const claimed = await this.repository.beginCollection(platform, attemptedAt, this.intervalMs / 3_600_000, scheduled);
      if (!claimed) {
        this.active.delete(platform); release();
        if (scheduled) return false;
        throw new Error('采集状态尚未初始化');
      }
      running = claimed;
    } catch (error) {
      this.active.delete(platform); release(); throw error;
    }
    const label = PLATFORM_LABELS[platform];
    void (async () => {
      try {
        const batch = await collect(abort.signal);
        if (batch.platform !== platform) throw new Error('采集结果的平台与任务不一致');
        const count = await this.repository.ingestBatch(batch);
        await this.repository.patchCollector(platform, { state: 'success', lastSuccessAt: batch.observedAt, consecutiveFailures: 0,
          count, coverage: batch.coverage, message: `成功采集 ${count} 部作品；${batch.coverage}` });
        console.log(`[muse-data-web] ${label}榜单已发布：${count} 部作品；${batch.coverage}`);
      } catch (error) {
        const reason = sourceReason(error);
        if (abort.signal.aborted) {
          await this.repository.patchCollector(platform, { state: 'failed', message: `${reason}；上次成功数据已保留` });
          return;
        }
        // Retry sooner than the regular interval so one transient failure does not leave the rankings a full period stale.
        const failures = (running.consecutiveFailures ?? 0) + 1;
        const delay = Math.min(this.periodMs, this.retryDelayMs * 2 ** Math.min(failures - 1, 20));
        const retryAt = new Date(this.now() + delay).toISOString();
        await this.repository.recordCollectorFailure(platform, `${reason}；上次成功数据已保留；预计 ${retryAt} 重试`, failures, retryAt);
        const detail = error instanceof Error ? `${error.name}: ${error.message.replace(/https?:\/\/\S+/g, '[来源地址]').slice(0, 300)}` : 'Error';
        console.error(`[muse-data-web] ${label}榜单未发布（连续失败 ${failures} 次，预计 ${retryAt} 重试）：${detail}`);
      } finally {
        this.active.delete(platform); release();
      }
    })().catch(error => { console.error('[muse-data-web] collector status write failed:', error instanceof Error ? error.name : 'Error'); });
    return true;
  }

  /** Runs due platforms one by one so a failed source does not prevent the next one. */
  async tick(): Promise<void> {
    if (this.ticking || this.closing) return;
    this.ticking = true;
    try {
      for (const status of await this.repository.collectors()) {
        if (this.closing) break;
        if (!this.has(status.platform) || !status.nextRunAt || Date.parse(status.nextRunAt) > this.now()) continue;
        if (await this.request(status.platform, true)) await this.active.get(status.platform)?.done;
      }
    } finally { this.ticking = false; }
  }

  /** Keeps a bounded local timer; persisted due dates provide restart continuity. */
  start(): void {
    if (this.timer || this.closing) return;
    const poll = async () => {
      try { await this.tick(); }
      catch (error) { console.error('[muse-data-web] collection schedule failed:', error instanceof Error ? error.name : 'Error'); }
      if (!this.closing) { this.timer = setTimeout(() => { void poll(); }, Math.min(60_000, this.intervalMs)); this.timer.unref(); }
    };
    this.timer = setTimeout(() => { void poll(); }, 0);
    this.timer.unref();
  }

  async waitForIdle(): Promise<void> { await Promise.all([...this.active.values()].map(job => job.done)); }

  /** Cancels only this data station's owned requests and waits before closing its database. */
  async stop(): Promise<void> {
    this.closing = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    for (const job of this.active.values()) job.abort.abort(new Error('数据站正在停止'));
    await this.waitForIdle();
  }
}

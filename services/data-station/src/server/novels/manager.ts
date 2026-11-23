/** One independent, restartable original-novel worker; it never occupies the collection platform locks. */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { NovelJob, NovelState } from '../../shared/novels.ts';
import type { Work } from '../../shared/types.ts';
import type { DataRepository } from '../repository.ts';
import { NovelFileError, NovelLibrary } from './library.ts';
import { NovelSourceError, type NovelDirectory, type NovelSourceAdapter } from './source.ts';

const jobSchema = z.object({ id: z.string().uuid(), workId: z.string().max(100), state: z.enum(['queued', 'running', 'ready', 'failed']),
  completedChapters: z.number().int().nonnegative(), totalChapters: z.number().int().nonnegative(),
  createdAt: z.string().datetime(), updatedAt: z.string().datetime(),
  errorCode: z.enum(['authorization_required', 'unavailable', 'invalid_source', 'storage_limit']).nullable(),
  message: z.string().max(400), artifactId: z.string().uuid().nullable() }).strict();

/** Public request coordination limits; file and chapter limits belong to NovelLibrary. */
export interface NovelManagerOptions { maxQueued?: number; now?: () => Date; }

export class NovelDownloadManager {
  private initializing: Promise<void> | undefined;
  private worker: Promise<void> | undefined;
  private abort: AbortController | undefined;
  private started = false;
  private closing = false;
  private wake = false;
  private readonly maxQueued: number;
  private readonly now: () => Date;

  constructor(private readonly repository: DataRepository, private readonly library: NovelLibrary,
    private readonly adapters: Partial<Record<'fanqie' | 'qimao', NovelSourceAdapter>>, options: NovelManagerOptions = {}) {
    this.maxQueued = options.maxQueued ?? 50;
    if (!Number.isInteger(this.maxQueued) || this.maxQueued < 1 || this.maxQueued > 50) throw new Error('Invalid original-novel queue limit');
    for (const platform of ['fanqie', 'qimao'] as const) if (adapters[platform] && adapters[platform]!.platform !== platform) throw new Error('Novel source platform mismatch');
    this.now = options.now ?? (() => new Date());
  }

  async initialize(): Promise<void> {
    this.initializing ??= (async () => {
      await this.library.initialize();
      await this.repository.database.exec(`CREATE TABLE IF NOT EXISTS novel_jobs (id text PRIMARY KEY,work_id text NOT NULL REFERENCES works(id),
        ordinal bigint GENERATED ALWAYS AS IDENTITY,payload jsonb NOT NULL);
        CREATE UNIQUE INDEX IF NOT EXISTS novels_active_work ON novel_jobs(work_id) WHERE payload->>'state' IN ('queued','running');`);
      const rows = await this.repository.database.query<{ payload: unknown }>('SELECT payload FROM novel_jobs');
      for (const row of rows.rows) {
        const job = this.parse(row.payload);
        if (job.state === 'running') await this.patch(job.id, { state: 'queued', errorCode: null, message: '服务已恢复，等待校验已有章节后续传' });
      }
    })();
    return this.initializing;
  }

  private parse(value: unknown): NovelJob {
    const job = jobSchema.parse(value);
    if (job.completedChapters > job.totalChapters || (job.state === 'failed') !== (job.errorCode !== null)
      || job.state === 'ready' && (job.artifactId === null || job.totalChapters === 0 || job.completedChapters !== job.totalChapters)
      || job.state !== 'ready' && job.artifactId !== null) throw new Error('Invalid saved original-novel progress');
    return job;
  }

  private async patch(id: string, fields: Partial<NovelJob>): Promise<void> {
    await this.repository.database.query('UPDATE novel_jobs SET payload=payload || $2::jsonb WHERE id=$1',
      [id, JSON.stringify({ ...fields, updatedAt: this.now().toISOString() })]);
  }

  private supported(work: Work): boolean {
    return work.kind === 'novel' && work.origin === 'live' && (work.platform === 'fanqie' || work.platform === 'qimao') && Boolean(this.adapters[work.platform]);
  }

  async status(workId: string): Promise<NovelState> {
    await this.initialize();
    const [detail, artifact, result] = await Promise.all([this.repository.getWork(workId), this.library.current(workId),
      this.repository.database.query<{ payload: unknown }>('SELECT payload FROM novel_jobs WHERE work_id=$1 ORDER BY ordinal DESC LIMIT 1', [workId])]);
    return { available: Boolean(artifact || detail && this.supported(detail.work)), job: result.rows[0] ? this.parse(result.rows[0].payload) : null, artifact };
  }

  /** Reads one sanitized public job without exposing its private chapter cache or worker resources. */
  async job(id: string): Promise<NovelJob | null> {
    await this.initialize();
    if (!z.string().uuid().safeParse(id).success) return null;
    const row = (await this.repository.database.query<{ payload: unknown }>('SELECT payload FROM novel_jobs WHERE id=$1', [id])).rows[0];
    return row ? this.parse(row.payload) : null;
  }

  /** Atomically reuses active work and bounds the independent global queue. */
  async request(work: Work): Promise<NovelState> {
    await this.initialize();
    if (this.closing) throw new NovelFileError('原文下载正在停止，请稍后重试', 409);
    if (!this.supported(work)) throw new NovelSourceError('unavailable', '该作品尚未接入原文下载来源');
    const stored = await this.repository.getWork(work.id);
    if (!stored || stored.work.sourceId !== work.sourceId || stored.work.platform !== work.platform || !this.supported(stored.work)) throw new NovelSourceError('invalid_source', '原文任务的作品身份不一致');
    await this.repository.database.transaction(async transaction => {
      const active = await transaction.query('SELECT id FROM novel_jobs WHERE work_id=$1 AND payload->>\'state\' IN (\'queued\',\'running\')', [work.id]);
      if (active.rows.length) return;
      const queued = await transaction.query<{ count: number }>("SELECT count(*)::int AS count FROM novel_jobs WHERE payload->>'state' IN ('queued','running')");
      if (queued.rows[0]!.count >= this.maxQueued) throw new NovelFileError('原文下载队列已满，请稍后重试', 429);
      const time = this.now().toISOString();
      const job: NovelJob = { id: randomUUID(), workId: work.id, state: 'queued', completedChapters: 0, totalChapters: 0,
        createdAt: time, updatedAt: time, errorCode: null, message: '已加入原文下载队列', artifactId: null };
      await transaction.query('INSERT INTO novel_jobs(id,work_id,payload) VALUES($1,$2,$3::jsonb)', [job.id, work.id, JSON.stringify(job)]);
    });
    this.pump();
    return this.status(work.id);
  }

  start(): void { if (this.closing) return; this.started = true; this.pump(); }

  private pump(): void {
    if (!this.started || this.closing) return;
    if (this.worker) { this.wake = true; return; }
    this.wake = false;
    this.worker = this.drain().catch(() => {
      // A database failure leaves durable running state for validated restart recovery; no provider payload is logged.
      this.started = false;
    }).finally(() => {
      this.worker = undefined;
      if (this.wake && !this.closing) this.pump();
    });
  }

  private async drain(): Promise<void> {
    await this.initialize();
    while (!this.closing) {
      const rows = await this.repository.database.query<{ payload: unknown }>("SELECT payload FROM novel_jobs WHERE payload->>'state'='queued' ORDER BY ordinal LIMIT 1");
      if (!rows.rows[0]) return;
      const job = this.parse(rows.rows[0].payload);
      this.abort = new AbortController();
      await this.patch(job.id, { state: 'running', message: '正在核对原始目录与章节', errorCode: null });
      try {
        const detail = await this.repository.getWork(job.workId);
        if (!detail || !this.supported(detail.work)) throw new NovelSourceError('unavailable', '原文来源尚未配置');
        const adapter = this.adapters[detail.work.platform as 'fanqie' | 'qimao']!;
        let directory: NovelDirectory | undefined;
        try {
          const source = await adapter.directory(detail.work, this.abort.signal);
          directory = source;
          const checked = this.library.validateDirectory(source, detail.work);
          directory = checked;
          await this.patch(job.id, { totalChapters: checked.chapters.length, completedChapters: 0 });
          for (const [index, chapter] of checked.chapters.entries()) {
            this.abort.signal.throwIfAborted();
            if (await this.library.cachedChapter(checked, chapter) === null) {
              const text = await adapter.chapter(checked, chapter, this.abort.signal);
              this.abort.signal.throwIfAborted(); await this.library.saveChapter(checked, chapter, text);
            }
            await this.patch(job.id, { completedChapters: index + 1, message: `已校验 ${index + 1}/${checked.chapters.length} 章；完成前不会发布下载文件` });
          }
        } finally { if (directory) await adapter.release?.(directory); }
        this.abort.signal.throwIfAborted();
        const artifact = await this.library.publish(directory!);
        await this.patch(job.id, { state: 'ready', artifactId: artifact.id, errorCode: null,
          message: artifact.scope === 'complete-book' ? '来源已完结目录的全部章节已核验，可下载原文' : '当前已发布目录的全部章节已核验；连载作品，不表示全本' });
      } catch (error) {
        if (this.abort.signal.aborted) await this.patch(job.id, { state: 'queued', errorCode: null, message: '下载已暂停，已核验章节保留，重启后续传' });
        else {
          const code = error instanceof NovelSourceError ? error.code : error instanceof NovelFileError && error.status === 413 ? 'storage_limit'
            : error instanceof z.ZodError ? 'invalid_source' : 'unavailable';
          const message = code === 'authorization_required' ? '来源要求授权或付费，未发布原文；已核验章节和旧版本保留'
            : code === 'invalid_source' ? '来源目录、章节身份或正文完整性校验未通过；未发布原文，旧版本保留'
              : code === 'storage_limit' ? '原文大小或私有存储达到配置上限；未发布新版本，旧版本保留'
                : '原文暂时不可用；已核验章节和旧版本保留，可稍后重试';
          await this.patch(job.id, { state: 'failed', errorCode: code, message });
        }
      } finally { this.abort = undefined; }
    }
  }

  async waitForIdle(): Promise<void> { while (this.worker) await this.worker; }

  /** Cancels the owned provider operation, joins release, and retains queued work for restart. */
  async stop(): Promise<void> {
    this.closing = true; this.started = false;
    this.abort?.abort(new Error('Original-novel worker stopping'));
    await this.waitForIdle();
  }
}

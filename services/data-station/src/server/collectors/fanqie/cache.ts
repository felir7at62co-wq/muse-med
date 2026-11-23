import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';
import type { FanqieDetail } from './parser.ts';

const detailSchema = z.object({
  title: z.string().min(1).max(500), author: z.string().max(500).nullable(),
  description: z.string().max(30_000), tags: z.array(z.string().max(100)).max(100),
  wordCount: z.number().int().nonnegative().safe().nullable(), status: z.string().max(100).nullable(), coverUrl: z.string().url().nullable(),
});
const entrySchema = z.object({ bookId: z.string().regex(/^\d{1,30}$/), fetchedAt: z.string().datetime(), detail: detailSchema });
const cacheSchema = z.object({ version: z.literal(1), entries: z.array(entrySchema).max(20_000) });
type Entry = z.infer<typeof entrySchema>;

/** Checkpoints verified plaintext metadata; incomplete rank batches never enter this cache. */
export class FanqieDetailCache {
  private entries = new Map<string, Entry>();
  private loaded: Promise<void> | null = null;
  private dirty = 0;
  readonly ttlHours: number;

  constructor(private readonly filePath: string, options: { ttlHours?: number } = {}) {
    this.ttlHours = options.ttlHours ?? 24;
    if (!Number.isInteger(this.ttlHours) || this.ttlHours < 1 || this.ttlHours > 168) throw new Error('番茄详情缓存有效期必须是 1 至 168 小时');
  }

  private async load(): Promise<void> {
    if (!this.loaded) this.loaded = this.read();
    try { await this.loaded; }
    catch (error) { this.loaded = null; throw error; }
  }

  private async read(): Promise<void> {
    try {
      const info = await stat(this.filePath);
      if (info.size > 67_108_864) throw new Error('番茄详情缓存超过大小限制');
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return;
      throw error;
    }
    const parsed = cacheSchema.parse(JSON.parse(await readFile(this.filePath, 'utf8')));
    const entries = new Map<string, Entry>();
    for (const entry of parsed.entries) {
      if (entries.has(entry.bookId) || /[\uE000-\uF8FF]/u.test(entry.detail.title + (entry.detail.author ?? ''))) throw new Error('番茄详情缓存身份重复或包含未解码名称');
      entries.set(entry.bookId, entry);
    }
    this.entries = entries;
  }

  /** Returns only metadata fetched within the configured TTL, never refreshing its date on reuse. */
  async get(bookId: string, now: Date): Promise<FanqieDetail | null> {
    await this.load();
    const entry = this.entries.get(bookId);
    const age = entry ? now.getTime() - Date.parse(entry.fetchedAt) : Infinity;
    return entry && age >= 0 && age < this.ttlHours * 3_600_000 ? entry.detail : null;
  }

  /** Records a validated book and atomically checkpoints every 25 new details. */
  async put(bookId: string, detail: FanqieDetail, fetchedAt: Date): Promise<void> {
    await this.load();
    const entry = entrySchema.parse({ bookId, detail, fetchedAt: fetchedAt.toISOString() });
    if (/[\uE000-\uF8FF]/u.test(detail.title + (detail.author ?? ''))) throw new Error('番茄详情缓存拒绝未解码名称');
    if (!this.entries.has(bookId) && this.entries.size === 20_000) {
      let oldest: Entry | undefined;
      for (const value of this.entries.values()) if (!oldest || value.fetchedAt < oldest.fetchedAt) oldest = value;
      if (oldest) this.entries.delete(oldest.bookId);
    }
    this.entries.set(bookId, entry);
    if (++this.dirty >= 25) await this.flush();
  }

  /** Saves successful metadata even when the surrounding rank batch is cancelled or incomplete. */
  async flush(): Promise<void> {
    if (!this.dirty) return;
    const data = JSON.stringify({ version: 1, entries: [...this.entries.values()] });
    if (Buffer.byteLength(data) > 67_108_864) throw new Error('番茄详情缓存超过大小限制');
    await mkdir(dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, data, { flag: 'wx', mode: 0o600 });
      await rename(temporary, this.filePath);
    }
    catch (error) {
      try { await unlink(temporary); }
      catch (cleanupError) {
        if (!(cleanupError instanceof Error && 'code' in cleanupError && cleanupError.code === 'ENOENT')) throw new AggregateError([error, cleanupError], '番茄详情缓存写入和临时文件清理失败');
      }
      throw error;
    }
    this.dirty = 0;
  }
}

import { randomUUID } from 'node:crypto';
import type { PGlite } from '@electric-sql/pglite';
import { z } from 'zod';
import { DEFAULT_MANAGED_DOUYIN_SOURCES, MAX_DOUYIN_SOURCES } from '../shared/douyin-sources.ts';
import type { DouyinSourceInput, DouyinSourceValidation, ManagedDouyinSource } from '../shared/types.ts';
import { collectDouyin } from './collectors/douyin.ts';
import type { DouyinOptions } from './collectors/douyin.ts';

const key = 'douyin_public_sources_v1';
const keywords = z.array(z.string().trim().min(1).max(80)).max(30);
const inputSchema = z.object({
  label: z.string().trim().max(100).default(''), videoId: z.string().trim().min(1).max(1_000),
  mode: z.enum(['creator', 'video']), expectedAuthor: z.string().trim().max(100).default(''),
  includeKeywords: keywords.default([]), excludeKeywords: keywords.default([]),
  enabled: z.boolean().default(true), maxVideos: z.number().int().min(1).max(20).default(8),
}).strict();
const storedSchema = inputSchema.extend({
  id: z.string().regex(/^[a-zA-Z0-9-]{1,100}$/),
  expectedAuthor: z.string().min(1).max(100), expectedAuthorId: z.string().regex(/^\d{1,30}$/).nullable(),
  updatedAt: z.string().datetime(), validatedAt: z.string().datetime().nullable(),
});
const savedSchema = z.object({ version: z.literal(1), sources: z.array(storedSchema).max(MAX_DOUYIN_SOURCES) }).strict();

/** An actionable source-management failure without remote payload or request credentials. */
export class DouyinSourceError extends Error {
  constructor(message: string, readonly status: 400 | 404 | 409 | 422) { super(message); this.name = 'DouyinSourceError'; }
}

/** Normalizes only supported official video links to their unchanged string video ID. */
export function normalizeDouyinVideoId(value: string): string {
  if (/^\d{8,30}$/.test(value)) return value;
  try {
    const url = new URL(value);
    const match = /^\/(?:m\/)?video\/(\d{8,30})\/?$/.exec(url.pathname);
    if (url.protocol === 'https:' && ['jingxuan.douyin.com', 'www.douyin.com', 'douyin.com'].includes(url.hostname)
      && !url.username && !url.password && !url.port && match) return match[1]!;
  } catch (_error) { /* Non-URL input is rejected below. */ }
  throw new DouyinSourceError('请填写字符串视频 ID，或抖音官方的完整视频链接；暂不支持短链接', 400);
}

/** Validates administrator JSON before any network request or settings write. */
export function parseDouyinSourceInput(value: unknown): DouyinSourceInput {
  const input = inputSchema.parse(value);
  return { ...input, videoId: normalizeDouyinVideoId(input.videoId),
    includeKeywords: [...new Set(input.includeKeywords)], excludeKeywords: [...new Set(input.excludeKeywords)] };
}

/** Verifies one current sample without importing it into the data library. */
export async function verifyDouyinSource(input: DouyinSourceInput, options: DouyinOptions = {}, expectedAuthorId?: string | null): Promise<DouyinSourceValidation> {
  let author = '', authorId: string | null = null;
  const batch = await collectDouyin({ ...options, sources: [{ ...input, expectedAuthor: input.expectedAuthor || undefined, expectedAuthorId, maxVideos: 1 }],
    onVerifiedSource: identity => { author = identity.author; authorId = identity.authorId; } });
  return { author, authorId, count: batch.works.length, coverage: batch.coverage, observedAt: batch.observedAt,
    works: batch.works.map(({ sourceId, title, sourceUrl, publishedAt }) => ({ sourceId, title, sourceUrl, publishedAt })) };
}

type Verification = (input: DouyinSourceInput, expectedAuthorId?: string | null) => Promise<DouyinSourceValidation>;

/** Persistent administrator choices; an explicitly empty or disabled set never falls back to presets. */
export class DouyinSourceStore {
  private initializing: Promise<void> | undefined;
  constructor(private readonly database: PGlite, private readonly verify: Verification = (input, id) => verifyDouyinSource(input, {}, id),
    private readonly now: () => Date = () => new Date()) {}

  /** Installs presets only when the setting has never existed. */
  async initialize(): Promise<void> {
    this.initializing ??= this.database.query('INSERT INTO data_settings(key,value) VALUES($1,$2::jsonb) ON CONFLICT DO NOTHING',
      [key, JSON.stringify({ version: 1, sources: DEFAULT_MANAGED_DOUYIN_SOURCES.map(source => ({ ...source, updatedAt: this.now().toISOString() })) })]).then(async () => { await this.read(); });
    return this.initializing;
  }

  private async read(client: Pick<PGlite, 'query'> = this.database): Promise<ManagedDouyinSource[]> {
    const result = await client.query<{ value: unknown }>('SELECT value FROM data_settings WHERE key=$1 FOR UPDATE', [key]);
    const parsed = savedSchema.safeParse(result.rows[0]?.value);
    if (!parsed.success) throw new Error('Invalid saved Douyin source configuration');
    const sources = parsed.data.sources;
    if (new Set(sources.map(source => source.id)).size !== sources.length) throw new Error('Duplicate saved Douyin source identifiers');
    for (const source of sources) if (normalizeDouyinVideoId(source.videoId) !== source.videoId) throw new Error('Noncanonical saved Douyin video identifier');
    return sources;
  }

  /** Reads the latest saved configuration for administration or a new collection attempt. */
  async list(): Promise<ManagedDouyinSource[]> { await this.initialize(); return this.read(); }

  /** Uses a detached enabled-source snapshot for one attempt; later edits apply to the next attempt. */
  async active(): Promise<ManagedDouyinSource[]> {
    const enabled = (await this.list()).filter(source => source.enabled);
    if (!enabled.length) throw new DouyinSourceError('抖音没有启用的来源，请先在采集管理中添加或启用来源', 422);
    return enabled;
  }

  /** Validates a draft against the public source without saving or importing its sample. */
  async validate(value: unknown): Promise<DouyinSourceValidation> {
    const input = parseDouyinSourceInput(value);
    const existing = (await this.list()).find(source => source.videoId === input.videoId && source.mode === input.mode);
    return existing?.expectedAuthorId ? this.verify(input, existing.expectedAuthorId) : this.verify(input);
  }

  /** Creates or replaces a source, binding its official author ID after successful verification. */
  async save(value: unknown, id?: string, expectedUpdatedAt?: string): Promise<ManagedDouyinSource> {
    const input = parseDouyinSourceInput(value);
    const initial = await this.list();
    const previous = id ? initial.find(source => source.id === id) : undefined;
    if (id && !previous) throw new DouyinSourceError('来源不存在，请刷新列表', 404);
    if (previous && expectedUpdatedAt !== undefined && previous.updatedAt !== expectedUpdatedAt) throw new DouyinSourceError('来源已被其他操作修改，请刷新后重试', 409);
    if (!id && initial.length >= MAX_DOUYIN_SOURCES) throw new DouyinSourceError(`最多保存 ${MAX_DOUYIN_SOURCES} 个来源`, 409);
    if (initial.some(source => source.id !== id && source.videoId === input.videoId && source.mode === input.mode)) throw new DouyinSourceError('这个视频或作者窗口已在来源列表中，请编辑已有来源', 409);
    const unchangedIdentity = previous && previous.videoId === input.videoId && previous.mode === input.mode
      && previous.expectedAuthor === input.expectedAuthor
      && JSON.stringify(previous.includeKeywords) === JSON.stringify(input.includeKeywords)
      && JSON.stringify(previous.excludeKeywords) === JSON.stringify(input.excludeKeywords);
    const boundId = previous?.videoId === input.videoId ? previous.expectedAuthorId : null;
    const verification = unchangedIdentity ? null : boundId ? await this.verify(input, boundId) : await this.verify(input);
    const time = new Date(Math.max(this.now().getTime(), previous ? Date.parse(previous.updatedAt) + 1 : 0)).toISOString();
    const source: ManagedDouyinSource = { ...input, id: id ?? randomUUID(), label: input.label || verification?.author || previous!.expectedAuthor,
      expectedAuthor: verification?.author ?? previous!.expectedAuthor, expectedAuthorId: verification ? verification.authorId : previous!.expectedAuthorId,
      updatedAt: time, validatedAt: verification ? verification.observedAt : previous!.validatedAt };
    return this.database.transaction(async transaction => {
      const sources = await this.read(transaction);
      if (id && !sources.some(item => item.id === id)) throw new DouyinSourceError('来源已被移除，请刷新列表', 409);
      if (!id && sources.length >= MAX_DOUYIN_SOURCES) throw new DouyinSourceError(`最多保存 ${MAX_DOUYIN_SOURCES} 个来源`, 409);
      if (sources.some(item => item.id !== source.id && item.videoId === source.videoId && item.mode === source.mode)) throw new DouyinSourceError('这个视频或作者窗口已在来源列表中，请编辑已有来源', 409);
      if (previous && sources.find(item => item.id === id)?.updatedAt !== previous.updatedAt) throw new DouyinSourceError('来源已被其他操作修改，请刷新后重试', 409);
      const updated = id ? sources.map(item => item.id === id ? source : item) : [...sources, source];
      await transaction.query('UPDATE data_settings SET value=$2::jsonb WHERE key=$1', [key, JSON.stringify({ version: 1, sources: updated })]);
      return source;
    });
  }

  /** Changes only the enable flag against the latest row, never resubmitting stale editor fields. */
  async setEnabled(id: string, enabled: boolean): Promise<ManagedDouyinSource> {
    await this.initialize();
    return this.database.transaction(async transaction => {
      const sources = await this.read(transaction);
      const previous = sources.find(source => source.id === id);
      if (!previous) throw new DouyinSourceError('来源不存在，请刷新列表', 404);
      const updated: ManagedDouyinSource = { ...previous, enabled,
        updatedAt: new Date(Math.max(this.now().getTime(), Date.parse(previous.updatedAt) + 1)).toISOString() };
      await transaction.query('UPDATE data_settings SET value=$2::jsonb WHERE key=$1', [key, JSON.stringify({ version: 1, sources: sources.map(source => source.id === id ? updated : source) })]);
      return updated;
    });
  }

  /** Removes a configured source without deleting collected works, history, or scripts. */
  async remove(id: string): Promise<boolean> {
    await this.initialize();
    return this.database.transaction(async transaction => {
      const sources = await this.read(transaction);
      if (!sources.some(source => source.id === id)) return false;
      await transaction.query('UPDATE data_settings SET value=$2::jsonb WHERE key=$1', [key, JSON.stringify({ version: 1, sources: sources.filter(source => source.id !== id) })]);
      return true;
    });
  }
}

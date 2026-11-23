import { z } from 'zod';
import type { BoardDayList, BoardPeriodView, CatalogResponse, Platform, SessionInfo, TopicFacets } from '../shared/types';
import { DATA_PLATFORMS } from '../shared/types';
import { platformSchema, workSchema } from '../shared/work-schema';

const prefix = 'muse-data:catalog-display:v1:';
const maxBytes = 2_000_000;
const maxAgeMs = 24 * 3_600_000;

const boardSchema = z.object({ boards: z.array(z.string().max(200)).max(300), defaultBoard: z.string().max(200).nullable() }).strict();
const topicSchema = z.object({ id: z.string().max(120), label: z.string().max(120), group: z.string().max(120), source: z.enum(['platform', 'text']), evidence: z.string().max(1000) });
const catalogSchema = z.object({
  items: z.array(workSchema.safeExtend({ topics: z.array(topicSchema).max(200).optional() })).max(100),
  total: z.number().int().nonnegative(), page: z.number().int().positive(), limit: z.number().int().positive().max(100),
  categories: z.array(z.string().max(200)).max(500), boards: z.array(z.string().max(200)).max(300),
  batch: z.object({ observedAt: z.string().datetime({ offset: true }), previousObservedAt: z.string().datetime({ offset: true }).nullable() }).strict().nullable().optional(),
}).strict();
const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const boardDaySchema = z.object({ date: dateSchema, observedAt: z.string().datetime({ offset: true }) }).strict();
const periodSchema = z.object({
  platform: platformSchema, board: z.string().max(200), origin: z.enum(['live', 'demo']), period: z.enum(['day', 'week', 'month']),
  date: dateSchema, start: dateSchema, end: dateSchema, daysInPeriod: z.number().int().min(1).max(31),
  days: z.array(boardDaySchema).max(31), previous: boardDaySchema.nullable(),
  items: z.array(z.object({ position: z.number().int().positive().nullable(), daysOnBoard: z.number().int().min(1).max(31),
    averageRank: z.number().positive().nullable(), bestRank: z.number().int().positive().nullable(), lastDate: dateSchema,
    work: workSchema.safeExtend({ topics: z.array(topicSchema).max(200).optional() }) }).strict()).max(1000),
}).strict();
const facetsSchema = z.object({ groups: z.array(z.object({ id: z.string().max(120), label: z.string().max(120),
  items: z.array(z.object({ id: z.string().max(120), label: z.string().max(120), count: z.number().int().nonnegative() })).max(500),
})).max(30) }).strict();
const selectionSchema = z.object({ board: z.string().max(200), page: z.number().int().min(1).max(100_000),
  sort: z.enum(['rank', 'rising', 'recent', 'plays', 'published']), tag: z.string().max(120), period: z.enum(['day', 'week', 'month']).optional(),
  format: z.enum(['真人剧', '漫剧', 'AI剧']).optional() }).strict();
const saved = <T extends z.ZodType>(value: T) => z.object({ key: z.string().max(2000), savedAt: z.number().finite(), value }).strict();
const envelopeSchema = z.object({ version: z.literal(1), origin: z.string().max(2000), userId: z.string().max(500), role: z.enum(['admin', 'member']),
  platform: platformSchema, selections: z.partialRecord(platformSchema, selectionSchema),
  directories: z.array(saved(boardSchema)).max(4), catalogs: z.array(saved(catalogSchema)).max(12), facets: z.array(saved(facetsSchema)).max(12),
  periods: z.array(saved(periodSchema)).max(12).default([]),
}).strict();
type Envelope = z.infer<typeof envelopeSchema>;
type Selection = z.infer<typeof selectionSchema>;
export type BoardDirectory = z.infer<typeof boardSchema>;
export interface DisplaySnapshot<T> { value: T; savedAt: number; }
/** A board period held for display; `version` is the data version it was read at, or -1 for a copy restored from storage. */
export interface PeriodSnapshot extends DisplaySnapshot<BoardPeriodView> { version: number; }
type CacheStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/** Opens optional browser storage; blocked storage never prevents fresh network reads. */
export function catalogStorage(): CacheStorage | null {
  try { return window.localStorage; }
  catch (_error) { return null; }
}

/** Bounded public display copies partitioned by a freshly confirmed origin, account and role. */
export class CatalogDisplayCache {
  readonly scope: string;
  private readonly key: string;
  private invalid = false;
  private data: Envelope;
  /** This tab's board periods and day lists by request query, so returning to a board needs no request. */
  private readonly periods = new Map<string, PeriodSnapshot>();
  private readonly days = new Map<string, { value: BoardDayList; version: number }>();
  private readonly pending = new Map<string, Promise<unknown>>();

  constructor(private readonly storage: CacheStorage | null, private readonly origin: string,
    private readonly actor: Pick<SessionInfo, 'id' | 'role'>, private readonly now: () => number = Date.now) {
    this.scope = JSON.stringify([origin, actor.id, actor.role]);
    this.key = prefix + encodeURIComponent(this.scope);
    this.data = { version: 1, origin, userId: actor.id, role: actor.role, platform: 'hongguo', selections: {}, directories: [], catalogs: [], facets: [], periods: [] };
    try {
      const raw = storage?.getItem(this.key);
      if (!raw) return;
      if (new TextEncoder().encode(raw).byteLength > maxBytes) throw new Error('Display cache is too large');
      const parsed = envelopeSchema.parse(JSON.parse(raw));
      if (parsed.origin !== origin || parsed.userId !== actor.id || parsed.role !== actor.role) throw new Error('Display cache owner changed');
      this.data = parsed;
    } catch (_error) { this.remove(); }
  }

  private remove(): void {
    try { this.storage?.removeItem(this.key); }
    catch (_error) { /* Private or full storage must not stop ordinary page reads. */ }
  }

  private persist(): void {
    if (this.invalid) return;
    let raw = JSON.stringify(this.data);
    while (new TextEncoder().encode(raw).byteLength > maxBytes && (this.data.catalogs.length || this.data.periods.length || this.data.facets.length)) {
      if (this.data.catalogs.length) this.data.catalogs.shift();
      else if (this.data.periods.length) this.data.periods.shift();
      else this.data.facets.shift();
      raw = JSON.stringify(this.data);
    }
    try { this.storage?.setItem(this.key, raw); }
    catch (_error) { /* Keep this tab's copy and continue without persistent storage. */ }
  }

  private fresh<T>(entries: Array<{ key: string; savedAt: number; value: T }>, key: string): DisplaySnapshot<T> | null {
    if (this.invalid) return null;
    const entry = entries.find(value => value.key === key);
    const age = entry ? this.now() - entry.savedAt : Infinity;
    return entry && age >= 0 && age < maxAgeMs ? { value: entry.value, savedAt: entry.savedAt } : null;
  }

  get platform(): Platform { return DATA_PLATFORMS.some(platform => platform === this.data.platform) ? this.data.platform : 'hongguo'; }
  selection(platform: Platform): Selection | undefined { return this.invalid ? undefined : this.data.selections[platform]; }
  directory(platform: Platform): DisplaySnapshot<BoardDirectory> | null { return this.fresh(this.data.directories, platform); }
  catalog(query: string): DisplaySnapshot<CatalogResponse> | null {
    const snapshot = this.fresh(this.data.catalogs, query);
    return snapshot && this.matchesQuery(query, snapshot.value) ? snapshot : null;
  }
  facet(query: string): DisplaySnapshot<TopicFacets> | null { return this.fresh(this.data.facets, query); }

  /** Remembers navigation without changing any snapshot's original save or source observation time. */
  remember(platform: Platform, selection?: Selection): void {
    if (this.invalid) return;
    this.data.platform = platform;
    if (selection) this.data.selections[platform] = selectionSchema.parse(selection);
    this.persist();
  }

  saveDirectory(platform: Platform, value: BoardDirectory): void {
    if (this.invalid) return;
    const parsed = boardSchema.safeParse(value);
    if (!parsed.success) return;
    this.data.directories = this.data.directories.filter(entry => entry.key !== platform);
    this.data.directories.push({ key: platform, savedAt: this.now(), value: parsed.data });
    this.persist();
  }

  /** Stores only source display fields; script metadata, file bytes and personal records are excluded. */
  saveCatalog(query: string, value: CatalogResponse): number {
    const savedAt = this.now();
    if (this.invalid || query.length > 2000) return savedAt;
    const parsed = catalogSchema.safeParse(value);
    if (!parsed.success || !this.matchesQuery(query, parsed.data)) return savedAt;
    this.data.catalogs = this.data.catalogs.filter(entry => entry.key !== query).slice(-11);
    this.data.catalogs.push({ key: query, savedAt, value: parsed.data });
    this.persist();
    return savedAt;
  }

  saveFacets(query: string, value: TopicFacets): void {
    if (this.invalid || query.length > 2000) return;
    const parsed = facetsSchema.safeParse(value);
    if (!parsed.success) return;
    this.data.facets = this.data.facets.filter(entry => entry.key !== query).slice(-11);
    this.data.facets.push({ key: query, savedAt: this.now(), value: parsed.data });
    this.persist();
  }

  /**
   * Returns a board period by its request query from this tab's memory, else a stored copy marked for revalidation.
   * @param query Board period request query (platform, board, origin, period and optional date).
   */
  period(query: string): PeriodSnapshot | null {
    if (this.invalid) return null;
    const held = this.periods.get(query);
    if (held) return held;
    const stored = this.fresh(this.data.periods, query);
    return stored && this.matchesPeriod(query, stored.value) ? { ...stored, version: -1 } : null;
  }

  /**
   * Holds a board period for this tab and stores its source display fields; script metadata stays in memory only.
   * @returns The save time.
   */
  savePeriod(query: string, value: BoardPeriodView, version: number): number {
    const savedAt = this.now();
    if (this.invalid || query.length > 2000 || !this.matchesPeriod(query, value)) return savedAt;
    this.periods.set(query, { value, savedAt, version });
    const parsed = periodSchema.safeParse(value);
    if (!parsed.success) return savedAt;
    this.data.periods = this.data.periods.filter(entry => entry.key !== query).slice(-11);
    this.data.periods.push({ key: query, savedAt, value: parsed.data });
    this.persist();
    return savedAt;
  }

  /** Returns this tab's collected-day list of one board. */
  boardDays(query: string): { value: BoardDayList; version: number } | null { return this.invalid ? null : this.days.get(query) ?? null; }
  saveBoardDays(query: string, value: BoardDayList, version: number): void { if (!this.invalid) this.days.set(query, { value, version }); }

  /** Shares one in-flight request per key, so a prefetch and a click never read the same board twice. */
  once<T>(key: string, start: () => Promise<T>): Promise<T> {
    const existing = this.pending.get(key);
    if (existing) return existing as Promise<T>;
    const request = start().finally(() => { if (this.pending.get(key) === request) this.pending.delete(key); });
    this.pending.set(key, request);
    return request;
  }

  /** Invalidates this instance as well as disk data so late requests cannot repopulate a signed-out account. */
  clear(): void { this.invalid = true; this.periods.clear(); this.days.clear(); this.pending.clear(); this.remove(); }

  private matchesPeriod(query: string, value: BoardPeriodView): boolean {
    const params = new URLSearchParams(query);
    return value.platform === params.get('platform') && value.board === params.get('board') && value.origin === (params.get('origin') ?? 'live')
      && value.period === (params.get('period') ?? 'day') && (!params.has('date') || value.date === params.get('date'))
      && value.items.every(item => item.work.platform === value.platform && item.work.origin === value.origin && item.work.board === value.board);
  }

  private matchesQuery(query: string, value: CatalogResponse): boolean {
    const params = new URLSearchParams(query);
    const platform = params.get('platform'), origin = params.get('origin'), board = params.get('board'), at = params.get('at');
    return (!at || (value.batch != null && Date.parse(value.batch.observedAt) === Date.parse(at)))
      && (!params.has('page') || value.page === Number(params.get('page')))
      && (!params.has('limit') || value.limit === Number(params.get('limit')))
      && value.items.every(work => (!platform || work.platform === platform) && (!origin || work.origin === origin) && (!board || work.board === board));
  }
}

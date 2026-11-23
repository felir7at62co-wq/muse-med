import { PGlite } from '@electric-sql/pglite';
import type { DouyinSearchSettings } from '../shared/douyin-search.ts';
import { z } from 'zod';
import type { BoardBatch, BoardBatchList, BoardComparison, BoardDayList, BoardPeriod, BoardPeriodView, CatalogQuery, CatalogResponse, CollectionBatch, CollectorStatus, Dashboard, DataOrigin, Observation, Platform, Selection, SelectionItem, SelectionStatus, TopicFacets, Work, WorkDetail } from '../shared/types.ts';
import { createDemoWorks } from './seed.ts';
import { PLATFORMS } from '../shared/types.ts';
import { platformSchema, workSchema } from '../shared/work-schema.ts';
import { buildTopicFacets, classifyTopics } from './taxonomy.ts';
import { availableBoards, compareBoardBatches, listBoardBatches, projectBoardBatch, projectBoardWorks } from './board-catalog.ts';
import { listBoardDays, projectBoardPeriod } from './board-periods.ts';

const platforms: readonly Platform[] = PLATFORMS;
/** Upper bound on held board periods and on held day lists. */
const CACHED_BOARD_VIEWS = 300;
const batchSchema = z.object({ platform: platformSchema, works: z.array(workSchema).min(1).max(20_000), coverage: z.string().min(1).max(2_000), observedAt: z.string().datetime({ offset: true }) });

interface WorkRow { payload: Work; }
interface SelectionRow { payload: Selection; }

function queryWorks(works: Work[], query: CatalogQuery): CatalogResponse {
  const q = query.q?.toLocaleLowerCase().trim();
  const scoped = works.filter(work => (!query.platform || work.platform === query.platform)
    && (!query.kind || work.kind === query.kind) && (!query.origin || work.origin === query.origin)
    && (!q || [work.title ?? '', work.sourceId, work.author ?? '', work.description, ...work.tags].join(' ').toLocaleLowerCase().includes(q)));
  const boards = [...new Set(scoped.map(work => work.board).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'zh-CN'));
  const inBoard = scoped.filter(work => !query.board || work.board === query.board);
  const categories = [...new Set(inBoard.map(work => work.category).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'zh-CN'));
  const filtered = inBoard.filter(work => (!query.category || work.category === query.category)
    && (!query.tag || (query.tag === 'unclassified' ? !work.topics?.length : work.topics?.some(topic => topic.id === query.tag))));
  filtered.sort((a, b) => {
    if (query.sort === 'plays' && query.platform === 'douyin') {
      const plays = (work: Work) => work.metrics.find(metric => metric.key === 'video_plays')?.value ?? -Infinity;
      return plays(b) - plays(a) || a.id.localeCompare(b.id);
    }
    if (query.sort === 'published' && query.platform === 'douyin') return (b.publishedAt ?? '').localeCompare(a.publishedAt ?? '') || a.id.localeCompare(b.id);
    if (query.sort === 'recent') return b.observedAt.localeCompare(a.observedAt) || a.id.localeCompare(b.id);
    if (query.sort === 'rising') return (b.rankChange ?? -Infinity) - (a.rankChange ?? -Infinity) || (a.rank ?? Infinity) - (b.rank ?? Infinity) || a.id.localeCompare(b.id);
    return (a.rank ?? Infinity) - (b.rank ?? Infinity) || a.platform.localeCompare(b.platform) || a.id.localeCompare(b.id);
  });
  const page = query.page ?? 1;
  const limit = query.limit ?? 20;
  return { items: filtered.slice((page - 1) * limit, page * limit), total: filtered.length, page, limit, categories, boards };
}

/** Local-preview PostgreSQL store. Every observed board and origin keeps a separate history. */
export class DataRepository {
  /** Every work with derived topics, keyed by ID; loaded once and refreshed per changed ID rather than reloaded. */
  private worksSnapshot: Promise<Map<string, Work>> | null = null;
  private readonly staleWorks = new Set<string>();
  private refreshing: Promise<void> = Promise.resolve();
  /** Historical board names per search scope; only ranked observations add boards, so catalog pages keep it valid. */
  private readonly boardsCache = new Map<string, string[]>();
  /**
   * Computed board periods by query. An entry stays valid until its board gains an observation or one of its listed works changes;
   * `ids` is null while the computation runs, and any change drops such an entry.
   */
  private readonly periodCache = new Map<string, { board: string; ids: ReadonlySet<string> | null; value: Promise<BoardPeriodView | null> }>();
  /** Collected-day lists by scope; valid until the board gains an observation. */
  private readonly daysCache = new Map<string, { board: string; value: Promise<BoardDayList> }>();
  constructor(readonly database: PGlite) {}

  /** Creates schema version one and optionally installs fictional preview data once. */
  async initialize(options: { seedDemo?: boolean } = {}): Promise<void> {
    await this.database.exec(`
      CREATE TABLE IF NOT EXISTS data_meta (key text PRIMARY KEY, value text NOT NULL);
      CREATE TABLE IF NOT EXISTS works (id text PRIMARY KEY, payload jsonb NOT NULL);
      CREATE TABLE IF NOT EXISTS observations (
        work_id text NOT NULL REFERENCES works(id), board text NOT NULL, origin text NOT NULL,
        observed_at timestamptz NOT NULL, payload jsonb NOT NULL,
        PRIMARY KEY(work_id, board, origin, observed_at)
      );
      -- Previous-batch and latest-batch lookups filter one board and origin by time; without this they scan all history.
      CREATE INDEX IF NOT EXISTS observations_board_origin_time ON observations(board, origin, observed_at);
      CREATE TABLE IF NOT EXISTS selections (work_id text PRIMARY KEY REFERENCES works(id), payload jsonb NOT NULL);
      CREATE TABLE IF NOT EXISTS collector_status (platform text PRIMARY KEY, payload jsonb NOT NULL);
      CREATE TABLE IF NOT EXISTS data_settings (key text PRIMARY KEY, value jsonb NOT NULL);
    `);
    const version = await this.database.query<{ value: string }>("SELECT value FROM data_meta WHERE key='schema_version'");
    if (version.rows[0] && !['1', '2'].includes(version.rows[0].value)) throw new Error('Unsupported data database schema version');
    await this.database.query("INSERT INTO data_meta(key,value) VALUES('schema_version','2') ON CONFLICT(key) DO UPDATE SET value='2'");
    for (const platform of platforms) {
      const status: CollectorStatus = {
        platform, state: platform === 'hongguo' ? 'idle' : 'not_configured', lastSuccessAt: null, lastAttemptAt: null,
        message: platform === 'hongguo' ? '尚未采集，可手动获取红果公开榜单' : '数据源尚未接入，当前仅展示示例作品',
        coverage: platform === 'hongguo' ? '红果公开榜单；实际覆盖以采集结果为准' : '无真实采集覆盖', count: 0,
      };
      await this.database.query('INSERT INTO collector_status(platform,payload) VALUES($1,$2::jsonb) ON CONFLICT DO NOTHING', [platform, JSON.stringify(status)]);
    }
    const seeded = await this.database.query("SELECT key FROM data_meta WHERE key='demo_seeded'");
    if (options.seedDemo !== false && seeded.rows.length === 0) {
      const today = new Date();
      today.setUTCHours(0, 0, 0, 0);
      for (let day = 0; day < 7; day++) {
        const observedAt = new Date(today.getTime() - (6 - day) * 86_400_000).toISOString();
        await this.saveWorks(createDemoWorks(observedAt, day));
      }
      await this.database.query("INSERT INTO data_meta(key,value) VALUES('demo_seeded','1') ON CONFLICT DO NOTHING");
    }
    // A restart cannot safely resume an in-flight collection owned by the old process.
    for (const status of await this.collectors()) {
      if (status.state === 'running') await this.updateCollector({ ...status, state: 'failed', message: '服务在上次采集中停止，请重新采集；已保存数据仍保留' });
    }
  }

  private async allWorks(): Promise<Work[]> {
    return [...(await this.worksById()).values()];
  }

  /**
   * Lists one platform's live works whose current record comes from catalog discovery rather than a ranking.
   * @returns Shared current records; callers must not modify them.
   */
  async catalogOnlyWorks(platform: Platform): Promise<Work[]> {
    return [...(await this.worksById()).values()].filter(work => work.platform === platform && work.origin === 'live' && work.board === '');
  }

  /**
   * Lists one platform's live works, ranked and catalog-only.
   * @returns Shared current records; callers must not modify them.
   */
  async liveWorks(platform: Platform): Promise<Work[]> {
    return [...(await this.worksById()).values()].filter(work => work.platform === platform && work.origin === 'live');
  }

  /** The current in-memory work map; callers must not modify it. */
  private async worksById(): Promise<ReadonlyMap<string, Work>> {
    if (!this.worksSnapshot) {
      this.staleWorks.clear();
      const loading = this.database.query<WorkRow>('SELECT payload FROM works')
        .then(result => new Map(result.rows.map(row => [row.payload.id, { ...row.payload, topics: classifyTopics(row.payload) }])));
      this.worksSnapshot = loading;
      void loading.catch(() => { if (this.worksSnapshot === loading) this.worksSnapshot = null; });
    }
    const snapshot = this.worksSnapshot;
    const works = await snapshot;
    if (this.staleWorks.size) {
      const ids = [...this.staleWorks];
      this.staleWorks.clear();
      // Refreshes run in order; a failure drops the snapshot so the next read reloads everything instead of serving stale rows.
      this.refreshing = this.refreshing.then(async () => {
        try {
          const result = await this.database.query<WorkRow>('SELECT payload FROM works WHERE id = ANY($1::text[])', [ids]);
          for (const row of result.rows) works.set(row.payload.id, { ...row.payload, topics: classifyTopics(row.payload) });
        } catch {
          if (this.worksSnapshot === snapshot) this.worksSnapshot = null;
        }
      });
    }
    await this.refreshing;
    return works;
  }

  /**
   * Marks committed rows for refresh; ranked observations can add boards, so they also clear the board-name cache.
   * Board periods and day lists of the observed boards, and periods listing a changed work, are dropped.
   */
  private changed(works: Work[]): void {
    for (const work of works) this.staleWorks.add(work.id);
    if (works.some(work => work.board.trim() !== '')) this.boardsCache.clear();
    const boards = new Set(works.map(work => work.board));
    for (const [key, entry] of this.periodCache) {
      if (!entry.ids || boards.has(entry.board) || works.some(work => entry.ids!.has(work.id))) this.periodCache.delete(key);
    }
    for (const [key, entry] of this.daysCache) if (boards.has(entry.board)) this.daysCache.delete(key);
  }

  /** Keeps a cache at most `CACHED_BOARD_VIEWS` entries by dropping the oldest. */
  private static bound(cache: Map<string, unknown>): void {
    while (cache.size >= CACHED_BOARD_VIEWS) cache.delete(cache.keys().next().value!);
  }

  private async saveWorks(works: Work[]): Promise<void> {
    await this.database.transaction(transaction => this.writeWorks(transaction, works));
    this.changed(works);
  }

  private async writeWorks(transaction: Pick<PGlite, 'query'>, works: Work[]): Promise<void> {
    for (const input of works) {
      let work: Work = { ...input, topics: classifyTopics(input) };
      const observation: Observation = { observedAt: work.observedAt, board: work.board, rank: work.rank, metrics: input.metrics, origin: work.origin, sourceUpdatedAt: work.sourceUpdatedAt };
      // A catalog listing carries no metrics; the current record keeps metrics measured earlier, with their measurement time.
      if (work.board === '' && work.metrics.every(metric => metric.value === null)) {
        const existing = (await transaction.query<WorkRow>('SELECT payload FROM works WHERE id=$1', [work.id])).rows[0]?.payload;
        if (existing?.board === '' && existing.metrics.some(metric => metric.value !== null) && Date.parse(existing.observedAt) < Date.parse(work.observedAt)) {
          work = { ...work, metrics: existing.metrics, metricsObservedAt: existing.metricsObservedAt ?? existing.observedAt };
        }
      }
      await transaction.query(`INSERT INTO works(id,payload) VALUES($1,$2::jsonb)
        ON CONFLICT(id) DO UPDATE SET payload=EXCLUDED.payload
        WHERE ((works.payload->>'board') = '' AND (EXCLUDED.payload->>'board') <> '')
          OR ((works.payload->>'observedAt')::timestamptz < (EXCLUDED.payload->>'observedAt')::timestamptz
            AND ((EXCLUDED.payload->>'board') <> '' OR (works.payload->>'board') = ''))
        RETURNING id`, [work.id, JSON.stringify(work)]);
      await transaction.query(`INSERT INTO observations(work_id,board,origin,observed_at,payload)
        VALUES($1,$2,$3,$4,$5::jsonb) ON CONFLICT DO NOTHING RETURNING work_id`,
        [work.id, work.board, work.origin, work.observedAt, JSON.stringify(observation)]);
    }
    for (const id of new Set(works.map(work => work.id))) {
      const current = await transaction.query<WorkRow>('SELECT payload FROM works WHERE id=$1', [id]);
      const work = current.rows[0]!.payload;
      const previous = await transaction.query<{ payload: Observation }>(`SELECT payload FROM observations
        WHERE work_id=$1 AND board=$2 AND origin=$3 AND observed_at = (
          SELECT max(observed_at) FROM observations WHERE board=$2 AND origin=$3 AND observed_at < $4
        )`, [work.id, work.board, work.origin, work.observedAt]);
      const priorRank = previous.rows[0]?.payload.rank;
      const rankChange = priorRank != null && work.rank != null ? priorRank - work.rank : null;
      await transaction.query('UPDATE works SET payload=jsonb_set(payload,\'{rankChange}\',$2::jsonb) WHERE id=$1', [work.id, JSON.stringify(rankChange)]);
    }
  }

  private prepareBatch(batch: CollectionBatch): Work[] {
    const parsed = batchSchema.parse(batch);
    for (const work of parsed.works) {
      if (work.platform !== parsed.platform || work.origin !== 'live' || work.sourceId.startsWith('demo-')) throw new Error('Live batch contains inconsistent platform or origin');
      if (work.observedAt !== parsed.observedAt) throw new Error('Live batch observation timestamps must match');
    }
    return parsed.works.map(work => ({ ...work, id: `${work.platform}:${work.sourceId}`, rankChange: null }));
  }

  /**
   * Appends a validated live collection; repeated batches do not add observations.
   * An empty-board catalog observation preserves an existing ranked work's fields, metrics and original observation time.
   * Its own observation is retained separately; ranked observations can replace catalog-only records.
   */
  async ingestBatch(batch: CollectionBatch): Promise<number> {
    const works = this.prepareBatch(batch);
    await this.saveWorks(works);
    return new Set(works.map(work => work.id)).size;
  }

  /**
   * Publishes a validated discovery page and its progress in one transaction.
   * Catalog observations follow the same preservation rules as ingestBatch; retained ranking metrics keep their original dates.
   * @param batch Live page records and observation time.
   * @param commit Writes progress using the supplied transaction and number of previously absent unique identities. Must not open another database transaction.
   * @returns Newly inserted unique identities, after records, observations and progress have all committed. A rejected callback rolls everything back.
   */
  async ingestDiscoveryPage(batch: CollectionBatch, commit: (client: Pick<PGlite, 'query'>, added: number) => Promise<void>): Promise<number> {
    const works = this.prepareBatch(batch);
    const ids = [...new Set(works.map(work => work.id))];
    const added = await this.database.transaction(async transaction => {
      const existing = await transaction.query<{ id: string }>('SELECT id FROM works WHERE id=ANY($1::text[])', [ids]);
      const newCount = ids.length - existing.rows.length;
      await this.writeWorks(transaction, works);
      await commit(transaction, newCount);
      return newCount;
    });
    this.changed(works);
    return added;
  }

  /**
   * Returns a filtered, stable page of current observations without combining platform metrics.
   * A board query with one origin reads one batch of that board (`at`, or the latest) and reports it as `batch`.
   */
  async listWorks(query: CatalogQuery = {}): Promise<CatalogResponse> {
    if (query.at !== undefined && (!query.board || !query.origin)) throw new Error('A batch time requires a board and one data origin');
    const all = await this.allWorks();
    const scope = queryWorks(all, { ...query, board: undefined, category: undefined, tag: undefined, page: 1, limit: Number.MAX_SAFE_INTEGER }).items;
    let works = scope;
    let batch: BoardBatch | null | undefined;
    if (query.board && query.origin) {
      ({ batch, works } = await projectBoardBatch(this.database, scope, { board: query.board, origin: query.origin, ...(query.platform ? { platform: query.platform } : {}) }, query.at));
    } else if (query.board) works = await projectBoardWorks(this.database, scope, query.board);
    const result = queryWorks(works, query);
    const boardsKey = JSON.stringify([query.platform ?? null, query.kind ?? null, query.origin ?? null, query.q?.toLocaleLowerCase().trim() || null]);
    let boards = this.boardsCache.get(boardsKey);
    if (!boards) {
      boards = await availableBoards(this.database, scope);
      while (this.boardsCache.size >= 200) this.boardsCache.delete(this.boardsCache.keys().next().value!);
      this.boardsCache.set(boardsKey, boards);
    }
    result.boards = [...boards];
    if (batch !== undefined) result.batch = batch;
    return result;
  }

  /**
   * Finds one platform's works by normalized title.
   * @param platform Platform whose works are searched.
   * @param keys Normalized titles to find.
   * @param key Normalizes a work title the same way the keys were made.
   * @returns For each key found, the first work with that title; callers must not modify it.
   */
  async worksByTitle(platform: Platform, keys: readonly string[], key: (title: string) => string): Promise<ReadonlyMap<string, Work>> {
    const wanted = new Set(keys);
    const found = new Map<string, Work>();
    if (!wanted.size) return found;
    for (const work of (await this.worksById()).values()) {
      if (work.platform !== platform || !work.title) continue;
      const title = key(work.title);
      if (wanted.has(title) && !found.has(title)) found.set(title, work);
    }
    return found;
  }

  /** Lists collection times of one platform's board within one origin, newest first. */
  async boardBatches(scope: { platform: Platform; board: string; origin: DataOrigin }): Promise<BoardBatchList> {
    return listBoardBatches(this.database, scope);
  }

  /** Lists collected Beijing days of one platform's board within one origin, newest first, with each day's last collection. */
  async boardDays(scope: { platform: Platform; board: string; origin: DataOrigin }): Promise<BoardDayList> {
    const key = JSON.stringify([scope.platform, scope.board, scope.origin]);
    const held = this.daysCache.get(key);
    if (held) return held.value;
    const value = listBoardDays(this.database, { platform: scope.platform, board: scope.board, origin: scope.origin });
    DataRepository.bound(this.daysCache);
    const entry = { board: scope.board, value };
    this.daysCache.set(key, entry);
    value.catch(() => { if (this.daysCache.get(key) === entry) this.daysCache.delete(key); });
    return value;
  }

  /**
   * Computes one platform's day, week or month board from the last collection of each collected day.
   * Results are shared until the board gains an observation or a listed work changes; callers must not modify them.
   * @returns The view, or null when the board has never been collected for that platform and origin.
   */
  async boardPeriod(query: { platform: Platform; board: string; origin: DataOrigin; period: BoardPeriod; date?: string }): Promise<BoardPeriodView | null> {
    const key = JSON.stringify([query.platform, query.board, query.origin, query.period, query.date ?? null]);
    const held = this.periodCache.get(key);
    if (held) return held.value;
    const entry: { board: string; ids: ReadonlySet<string> | null; value: Promise<BoardPeriodView | null> } = { board: query.board, ids: null, value: Promise.resolve(null) };
    entry.value = this.worksById().then(works => projectBoardPeriod(this.database, id => works.get(id),
      { platform: query.platform, board: query.board, origin: query.origin }, query.period, query.date));
    DataRepository.bound(this.periodCache);
    this.periodCache.set(key, entry);
    entry.value.then(view => { entry.ids = new Set(view?.items.map(item => item.work.id) ?? []); },
      () => { if (this.periodCache.get(key) === entry) this.periodCache.delete(key); });
    return entry.value;
  }

  /**
   * Compares two batches of one platform's board within one origin.
   * @returns Normalized batch times and entries, or null when either time is not a batch containing that platform's works.
   */
  async compareBoardBatches(query: { platform: Platform; board: string; origin: DataOrigin; from: string; to: string }): Promise<BoardComparison | null> {
    const works = (await this.allWorks()).filter(work => work.platform === query.platform && work.origin === query.origin);
    const entries = await compareBoardBatches(this.database, works, { board: query.board, origin: query.origin }, query.from, query.to);
    if (!entries) return null;
    return { platform: query.platform, board: query.board, origin: query.origin,
      from: new Date(query.from).toISOString(), to: new Date(query.to).toISOString(), entries };
  }

  /** Counts verified live records without decoding the complete collection. */
  async countLiveWorks(platform: Platform): Promise<number> {
    const result = await this.database.query<{ count: number }>("SELECT count(*)::integer AS count FROM works WHERE payload->>'platform'=$1 AND payload->>'origin'='live'", [platform]);
    return result.rows[0]!.count;
  }

  /** Returns non-inferred category counts within the currently requested source scope. */
  async facets(query: CatalogQuery = {}): Promise<TopicFacets> {
    const scope = await this.listWorks({ ...query, tag: undefined, page: 1, limit: Number.MAX_SAFE_INTEGER });
    return buildTopicFacets(scope.items);
  }

  /** Returns the current work and its matching-board, matching-origin history. An explicit empty board selects catalog observations. */
  async getWork(id: string, board?: string): Promise<WorkDetail | null> {
    const result = await this.database.query<WorkRow>('SELECT payload FROM works WHERE id=$1', [id]);
    const stored = result.rows[0]?.payload;
    if (!stored) return null;
    let work = { ...stored, topics: classifyTopics(stored) };
    if (board !== undefined) {
      const projected = (await projectBoardWorks(this.database, [work], board, work.origin, true))[0];
      if (!projected) return null;
      work = { ...projected, topics: classifyTopics(projected) };
    }
    const observations = await this.database.query<{ payload: Observation }>('SELECT payload FROM observations WHERE work_id=$1 AND board=$2 AND origin=$3 ORDER BY observed_at', [id, work.board, work.origin]);
    const selection = await this.database.query<SelectionRow>('SELECT payload FROM selections WHERE work_id=$1', [id]);
    return { work, observations: observations.rows.map(row => row.payload), selection: selection.rows[0]?.payload ?? null };
  }

  /** Reads persistent local-preview team selections, newest first. */
  async selections(): Promise<SelectionItem[]> {
    const result = await this.database.query<{ work: Work; selection: Selection }>(`SELECT w.payload AS work,s.payload AS selection
      FROM selections s JOIN works w ON w.id=s.work_id ORDER BY s.payload->>'updatedAt' DESC`);
    return result.rows;
  }

  /** Stores a preview user's notes and review status for an existing work. */
  async putSelection(workId: string, status: SelectionStatus, note: string): Promise<Selection | null> {
    if (!(await this.getWork(workId))) return null;
    const selection: Selection = { workId, status, note, owner: '本地预览', updatedAt: new Date().toISOString() };
    await this.database.query('INSERT INTO selections(work_id,payload) VALUES($1,$2::jsonb) ON CONFLICT(work_id) DO UPDATE SET payload=EXCLUDED.payload', [workId, JSON.stringify(selection)]);
    return selection;
  }

  /** Removes a local-preview selection, leaving its source work intact. */
  async deleteSelection(workId: string): Promise<void> {
    await this.database.query('DELETE FROM selections WHERE work_id=$1', [workId]);
  }

  /** Reads independent collection status for all four platforms. */
  async collectors(): Promise<CollectorStatus[]> {
    const results = await this.database.query<{ payload: CollectorStatus }>('SELECT payload FROM collector_status');
    return platforms.flatMap(platform => results.rows.filter(row => row.payload.platform === platform).map(row => row.payload));
  }

  /** Persists a collector attempt without modifying existing works on a failure. */
  async updateCollector(status: CollectorStatus): Promise<void> {
    await this.database.query('INSERT INTO collector_status(platform,payload) VALUES($1,$2::jsonb) ON CONFLICT(platform) DO UPDATE SET payload=EXCLUDED.payload', [status.platform, JSON.stringify(status)]);
  }

  /** Applies completion fields without overwriting an administrator's concurrent scheduling change. */
  async patchCollector(platform: Platform, fields: Partial<Pick<CollectorStatus, 'state' | 'lastSuccessAt' | 'message' | 'count' | 'coverage' | 'consecutiveFailures'>>): Promise<void> {
    await this.database.query('UPDATE collector_status SET payload=payload || $2::jsonb WHERE platform=$1', [platform, JSON.stringify(fields)]);
  }

  /**
   * Records a failed attempt and moves its due time earlier to the retry time, never later than the persisted schedule.
   * @param platform Collector whose attempt failed.
   * @param message Sanitized failure text for the status display.
   * @param failures Consecutive failed attempts including this one.
   * @param retryAt ISO time of the bounded retry.
   */
  async recordCollectorFailure(platform: Platform, message: string, failures: number, retryAt: string): Promise<void> {
    await this.database.query(`UPDATE collector_status SET payload=payload || jsonb_build_object('state','failed','message',$2::text,
      'consecutiveFailures',$3::int,'nextRunAt',CASE WHEN payload->>'nextRunAt' IS NOT NULL AND (payload->>'nextRunAt')::timestamptz <= ($4::text)::timestamptz
        THEN payload->>'nextRunAt' ELSE $4::text END) WHERE platform=$1`, [platform, message, failures, retryAt]);
  }

  /** Claims a due attempt atomically against the latest persisted due date and interval. */
  async beginCollection(platform: Platform, attemptedAt: string, defaultHours: number, scheduled: boolean): Promise<CollectorStatus | null> {
    const result = await this.database.query<{ payload: CollectorStatus }>(`UPDATE collector_status SET payload=payload || jsonb_build_object(
      'state','running','lastAttemptAt',$2::text,
      'intervalHours',COALESCE((SELECT (value #>> '{}')::double precision FROM data_settings WHERE key='collection_interval_hours'),$3::double precision),
      'nextRunAt',to_char(($2::timestamptz + COALESCE((SELECT (value #>> '{}')::double precision FROM data_settings WHERE key='collection_interval_hours'),$3::double precision)*interval '1 hour') AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'message','正在采集公开数据') WHERE platform=$1 AND (NOT $4::boolean OR (payload->>'nextRunAt')::timestamptz <= $2::timestamptz) RETURNING payload`,
    [platform, attemptedAt, defaultHours, scheduled]);
    return result.rows[0]?.payload ?? null;
  }

  async collectionIntervalHours(): Promise<number | null> {
    const result = await this.database.query<{ value: number }>("SELECT value FROM data_settings WHERE key='collection_interval_hours'");
    const value = result.rows[0]?.value;
    if (value === undefined) return null;
    if (!Number.isInteger(value) || value < 1 || value > 168) throw new Error('Invalid saved collection interval');
    return value;
  }

  /** The administrator's saved Douyin search settings, or null before the first save. */
  async douyinSearchSettings(): Promise<DouyinSearchSettings | null> {
    const result = await this.database.query<{ value: DouyinSearchSettings }>("SELECT value FROM data_settings WHERE key='douyin_search'");
    return result.rows[0]?.value ?? null;
  }

  async saveDouyinSearchSettings(settings: DouyinSearchSettings): Promise<void> {
    await this.database.query("INSERT INTO data_settings(key,value) VALUES('douyin_search',$1::jsonb) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value", [JSON.stringify(settings)]);
  }

  /** Persists the administrator interval and updates only scheduling fields, keeping in-flight results intact. */
  async saveCollectionInterval(hours: number, platforms: Platform[], now: string): Promise<void> {
    await this.database.transaction(async transaction => {
      await transaction.query("INSERT INTO data_settings(key,value) VALUES('collection_interval_hours',$1::jsonb) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value", [JSON.stringify(hours)]);
      await transaction.query(`UPDATE collector_status SET payload=payload || jsonb_build_object('intervalHours',$1::int,
        'nextRunAt',to_char(CASE WHEN payload->>'lastAttemptAt' IS NULL THEN $3::timestamptz ELSE (payload->>'lastAttemptAt')::timestamptz + $1::int*interval '1 hour' END AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) WHERE platform=ANY($2::text[])`, [hours, platforms, now]);
    });
  }

  /** Summarizes current library counts and ranking movements while preserving demo/live counts. */
  async dashboard(query: Pick<CatalogQuery, 'origin'> = {}): Promise<Dashboard> {
    const works = (await this.allWorks()).filter(work => !query.origin || work.origin === query.origin);
    const selections = await this.selections();
    return {
      totalWorks: works.length, liveWorks: works.filter(work => work.origin === 'live').length,
      demoWorks: works.filter(work => work.origin === 'demo').length, selections: selections.length,
      risingWorks: works.filter(work => (work.rankChange ?? 0) > 0).length,
      platformCounts: Object.fromEntries(platforms.map(platform => [platform, works.filter(work => work.platform === platform).length])) as Record<Platform, number>,
      featured: queryWorks(works, { limit: 8 }).items,
      rising: queryWorks(works.filter(work => (work.rankChange ?? 0) > 0), { ...query, sort: 'rising', limit: 5 }).items,
      collectors: await this.collectors(),
    };
  }
}

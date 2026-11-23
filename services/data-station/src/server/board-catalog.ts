import type { PGlite } from '@electric-sql/pglite';
import type { BoardBatch, BoardBatchList, BoardComparisonEntry, ComparedWork, DataOrigin, Observation, Platform, Work } from '../shared/types.ts';

/**
 * One board within one data origin, optionally limited to one platform's works.
 * Batches are listed, selected and compared only inside such a scope.
 */
export interface BoardScope { board: string; origin: DataOrigin; platform?: Platform; }

/** Upper bound on the batch times returned by one listing. */
export const MAX_LISTED_BATCHES = 2000;

interface HistoricalRow {
  work_id: string;
  origin: DataOrigin;
  payload: Observation;
  previous: Observation | null;
  previous_is_adjacent: boolean | null;
}

interface BatchRow {
  observed_at: string;
  previous_observed_at: string | null;
  work_id: string | null;
  payload: Observation | null;
  previous: Observation | null;
}

function scopeJson(works: Work[]): string {
  return JSON.stringify(works.map(work => ({ id: work.id, origin: work.origin })));
}

function key(id: string, origin: DataOrigin): string {
  return `${id}\u0000${origin}`;
}

/** Formats a timestamptz column as the millisecond UTC ISO text used for batch times. */
export function isoText(column: string): string {
  return `to_char(${column} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
}

/** Matches a stored time against a listed batch time, which is truncated to milliseconds. */
function inBatch(column: string, parameter: string): string {
  return `(${column} >= ${parameter}::timestamptz AND ${column} < ${parameter}::timestamptz + interval '1 millisecond')`;
}

/**
 * Builds parameters $1 board, $2 origin and, for a platform scope, $3 platform.
 * `where(alias)` limits an observations alias to the scope; `add` appends a further parameter and returns its placeholder.
 */
export function scopedQuery(scope: BoardScope): { params: unknown[]; where: (alias: string) => string; add: (value: unknown) => string } {
  const params: unknown[] = [scope.board, scope.origin];
  if (scope.platform) params.push(scope.platform);
  const platform: (alias: string) => string = scope.platform
    // OFFSET 0 keeps the check a per-row filter on the board-time index scan; as a semi-join the planner may instead walk every work of the platform.
    ? alias => ` AND EXISTS (SELECT 1 FROM works w WHERE w.id=${alias}.work_id AND w.payload->>'platform'=$3 OFFSET 0)`
    : () => '';
  return {
    params,
    where: alias => `${alias}.board=$1 AND ${alias}.origin=$2${platform(alias)}`,
    add: value => { params.push(value); return `$${params.length}`; },
  };
}

/** Copies a work with one observation's board, rank, metrics and time; the change needs an adjacent previous observation with both ranks known. */
export function project(work: Work, payload: Observation, previous: Observation | null, previousIsAdjacent: boolean): Work {
  const previousRank = previous?.rank;
  const rankChange = previousIsAdjacent && previousRank != null && payload.rank != null ? previousRank - payload.rank : null;
  return { ...work, board: payload.board, rank: payload.rank, metrics: payload.metrics,
    observedAt: payload.observedAt, sourceUpdatedAt: payload.sourceUpdatedAt ?? null, rankChange };
}

/**
 * Lists the collection times of one board, newest first, as millisecond UTC ISO text.
 * Each step reads the board-time index, so the cost follows the number of batches rather than the stored rows.
 * @param database Store holding `observations` and, for a platform scope, `works`.
 * @param scope Board and origin; a platform limits batches to those containing that platform's works.
 * @param limit Maximum number of times returned.
 * @returns At most `limit` times and whether older batches were left out.
 */
export async function listBoardBatches(database: PGlite, scope: BoardScope, limit = MAX_LISTED_BATCHES): Promise<BoardBatchList> {
  const { params, where, add } = scopedQuery(scope);
  const max = add(limit + 1);
  const result = await database.query<{ observed_at: string }>(`
    WITH RECURSIVE batches(observed_at) AS (
      (SELECT o.observed_at FROM observations o WHERE ${where('o')} ORDER BY o.observed_at DESC LIMIT 1)
      UNION ALL
      SELECT (SELECT o.observed_at FROM observations o WHERE ${where('o')} AND o.observed_at < b.observed_at ORDER BY o.observed_at DESC LIMIT 1)
      FROM batches b WHERE b.observed_at IS NOT NULL
    )
    SELECT ${isoText('observed_at')} AS observed_at FROM batches WHERE observed_at IS NOT NULL LIMIT ${max}::integer
  `, params);
  const batches = result.rows.map(row => row.observed_at);
  return { batches: batches.slice(0, limit), truncated: batches.length > limit };
}

/**
 * Returns the members of one board batch with their ranks, metrics and rank change against the batch immediately before it.
 * A work counts as moved only when it is also in that previous batch with a known rank; otherwise its change is null.
 * @param database Store holding `observations` and, for a platform scope, `works`.
 * @param works Candidate works; only those of the scope's origin can become members, and members keep this order.
 * @param scope Board and origin, optionally limited to one platform.
 * @param at A listed batch time; omitted selects the latest batch.
 * @returns The resolved batch and its members, or a null batch when the scope has no batch at `at`.
 */
export async function projectBoardBatch(database: PGlite, works: Work[], scope: BoardScope, at?: string): Promise<{ batch: BoardBatch | null; works: Work[] }> {
  const candidates = works.filter(work => work.origin === scope.origin);
  const { params, where, add } = scopedQuery(scope);
  const members = add(JSON.stringify(candidates.map(work => work.id)));
  const selected = at === undefined ? '' : ` AND ${inBatch('o.observed_at', add(at))}`;
  const result = await database.query<BatchRow>(`
    WITH candidates AS (
      SELECT DISTINCT id FROM jsonb_array_elements_text(${members}::jsonb) AS supplied(id)
    ), batch AS (
      SELECT c.observed_at,
        (SELECT o.observed_at FROM observations o WHERE ${where('o')} AND o.observed_at < c.observed_at
          ORDER BY o.observed_at DESC LIMIT 1) AS previous_observed_at
      FROM (SELECT o.observed_at FROM observations o WHERE ${where('o')}${selected} ORDER BY o.observed_at DESC LIMIT 1) c
    )
    SELECT ${isoText('b.observed_at')} AS observed_at, ${isoText('b.previous_observed_at')} AS previous_observed_at,
      m.work_id, m.payload, p.payload AS previous
    FROM batch b
    LEFT JOIN (observations m JOIN candidates s ON s.id=m.work_id) ON m.board=$1 AND m.origin=$2 AND m.observed_at=b.observed_at
    LEFT JOIN observations p ON p.work_id=m.work_id AND p.board=$1 AND p.origin=$2 AND p.observed_at=b.previous_observed_at
  `, params);
  const first = result.rows[0];
  if (!first) return { batch: null, works: [] };
  const rows = new Map(result.rows.flatMap(row => row.work_id !== null && row.payload ? [[row.work_id, row] as const] : []));
  return {
    batch: { observedAt: first.observed_at, previousObservedAt: first.previous_observed_at },
    works: candidates.flatMap(work => {
      const row = rows.get(work.id);
      return row?.payload ? [project(work, row.payload, row.previous, true)] : [];
    }),
  };
}

/**
 * Returns members of the latest selected-board batch and their previous observed ranks.
 * Entity details may include a dropped work's last known observation; charts retain current membership.
 * Metadata and result order follow the supplied works; observations never cross their data origin.
 */
export async function projectBoardWorks(database: PGlite, works: Work[], board: string, origin?: DataOrigin, includeHistorical = false): Promise<Work[]> {
  const scoped = origin ? works.filter(work => work.origin === origin) : works;
  if (!scoped.length) return [];
  if (!includeHistorical) {
    const projected = new Map<string, Work>();
    for (const value of new Set(scoped.map(work => work.origin))) {
      for (const work of (await projectBoardBatch(database, scoped, { board, origin: value })).works) projected.set(key(work.id, work.origin), work);
    }
    return scoped.flatMap(work => projected.get(key(work.id, work.origin)) ?? []);
  }
  const result = await database.query<HistoricalRow>(`
    WITH scope AS (
      SELECT DISTINCT id, origin
      FROM jsonb_to_recordset($1::jsonb) AS supplied(id text, origin text)
    ), latest AS (
      SELECT origin,max(observed_at) AS observed_at,
        (array_agg(observed_at ORDER BY observed_at DESC))[2] AS previous_observed_at
      FROM (SELECT DISTINCT origin,observed_at FROM observations WHERE board=$2) batches GROUP BY origin
    ), ranked AS (
      SELECT o.work_id, o.origin, o.observed_at, o.payload,
        lag(o.payload) OVER (
          PARTITION BY o.work_id,o.board,o.origin ORDER BY o.observed_at
        ) AS previous,
        row_number() OVER (
          PARTITION BY o.work_id,o.board,o.origin ORDER BY o.observed_at DESC
        ) AS ordinal
      FROM observations o JOIN scope s ON s.id=o.work_id AND s.origin=o.origin
      WHERE o.board=$2
    )
    SELECT r.work_id,r.origin,r.payload,r.previous,
      r.observed_at=l.observed_at AND (r.previous->>'observedAt')::timestamptz=l.previous_observed_at AS previous_is_adjacent FROM ranked r
    JOIN latest l ON l.origin=r.origin WHERE ordinal=1
  `, [scopeJson(scoped), board]);
  const observations = new Map(result.rows.map(row => [key(row.work_id, row.origin), row]));
  return scoped.flatMap(work => {
    const row = observations.get(key(work.id, work.origin));
    return row ? [project(work, row.payload, row.previous, row.previous_is_adjacent === true)] : [];
  });
}

function comparedWork(work: Work): ComparedWork {
  return { id: work.id, sourceId: work.sourceId, title: work.title, author: work.author,
    ...(work.metadataStatus ? { metadataStatus: work.metadataStatus } : {}), ...(work.metadataNote ? { metadataNote: work.metadataNote } : {}) };
}

/** Orders known ranks ascending with unknown ranks last. */
export function byRank(a: number | null, b: number | null): number {
  return (a ?? Infinity) - (b ?? Infinity);
}

/**
 * Compares the members of two batches of one board.
 * Works present in both batches keep their two ranks; works present in only one are entered or dropped.
 * Batches in between are not consulted, so a work that left and returned in between still counts as stayed.
 * @param database Store holding `observations`.
 * @param works Candidate works; only those of the scope's origin are compared, and both batches must contain at least one of them.
 * @param scope Board and origin; the caller limits `works` to one platform.
 * @param from Earlier listed batch time.
 * @param to Later listed batch time.
 * @returns Entries of the later batch by rank, then dropped entries by their earlier rank; null when either time has no candidate members.
 */
export async function compareBoardBatches(database: PGlite, works: Work[], scope: Omit<BoardScope, 'platform'>, from: string, to: string): Promise<BoardComparisonEntry[] | null> {
  const candidates = new Map(works.filter(work => work.origin === scope.origin).map(work => [work.id, work]));
  if (!candidates.size) return null;
  const { params, where, add } = scopedQuery(scope);
  const members = add(JSON.stringify([...candidates.keys()]));
  const fromTime = add(from), toTime = add(to);
  const side = (label: string, time: string) => `SELECT '${label}' AS side, o.work_id, o.payload->'rank' AS rank
    FROM observations o JOIN candidates s ON s.id=o.work_id WHERE ${where('o')} AND ${inBatch('o.observed_at', time)}`;
  const result = await database.query<{ side: 'from' | 'to'; work_id: string; rank: number | null }>(`
    WITH candidates AS (SELECT DISTINCT id FROM jsonb_array_elements_text(${members}::jsonb) AS supplied(id))
    ${side('from', fromTime)} UNION ALL ${side('to', toTime)}
  `, params);
  const earlier = new Map<string, number | null>(), later = new Map<string, number | null>();
  for (const row of result.rows) (row.side === 'from' ? earlier : later).set(row.work_id, row.rank ?? null);
  if (!earlier.size || !later.size) return null;
  const entries: BoardComparisonEntry[] = [];
  for (const [id, toRank] of later) {
    const stayed = earlier.has(id);
    const fromRank = earlier.get(id) ?? null;
    entries.push({ work: comparedWork(candidates.get(id)!), status: stayed ? 'stayed' : 'entered', fromRank, toRank,
      rankChange: stayed && fromRank !== null && toRank !== null ? fromRank - toRank : null });
  }
  const dropped: BoardComparisonEntry[] = [];
  for (const [id, fromRank] of earlier) {
    if (!later.has(id)) dropped.push({ work: comparedWork(candidates.get(id)!), status: 'dropped', fromRank, toRank: null, rankChange: null });
  }
  entries.sort((a, b) => byRank(a.toRank, b.toRank) || a.work.id.localeCompare(b.work.id));
  dropped.sort((a, b) => byRank(a.fromRank, b.fromRank) || a.work.id.localeCompare(b.work.id));
  return [...entries, ...dropped];
}

/** Returns all historically observed boards within the supplied work and origin scope. */
export async function availableBoards(database: PGlite, works: Work[]): Promise<string[]> {
  if (!works.length) return [];
  const result = await database.query<{ board: string }>(`
    WITH scope AS (
      SELECT DISTINCT id,origin
      FROM jsonb_to_recordset($1::jsonb) AS supplied(id text,origin text)
    )
    SELECT DISTINCT o.board
    FROM observations o JOIN scope s ON s.id=o.work_id AND s.origin=o.origin
    WHERE btrim(o.board) <> ''
  `, [scopeJson(works)]);
  return result.rows.map(row => row.board).sort((a, b) => a.localeCompare(b, 'zh-CN'));
}

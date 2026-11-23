import type { PGlite } from '@electric-sql/pglite';
import type { BoardDay, BoardDayList, BoardPeriod, BoardPeriodItem, BoardPeriodView, Observation, Work } from '../shared/types.ts';
import { addDays, BEIJING_OFFSET_MS, beijingDate, periodRange } from '../shared/board-period.ts';
import { byRank, isoText, project, scopedQuery, type BoardScope } from './board-catalog.ts';

/** Upper bound on the collected days returned by one listing. */
export const MAX_LISTED_DAYS = 400;

/** A board scope that always names its platform. */
export type PlatformBoardScope = BoardScope & Required<Pick<BoardScope, 'platform'>>;

/** Returns the UTC instant of Beijing midnight at the start of `date`. */
function beijingMidnight(date: string): string {
  return new Date(Date.parse(`${date}T00:00:00.000Z`) - BEIJING_OFFSET_MS).toISOString();
}

/** SQL for Beijing midnight at the start of the day containing a timestamptz expression. */
function dayStart(column: string): string {
  return `((date_trunc('day', (${column} AT TIME ZONE 'UTC') + interval '8 hours') - interval '8 hours') AT TIME ZONE 'UTC')`;
}

/**
 * Lists the collected Beijing days of one platform's board with each day's last collection, newest first.
 * Each step reads the board-time index once per day, so the cost follows the number of collected days.
 * @param database Store holding `observations` and `works`.
 * @param scope Board, origin and platform; only collections containing that platform's works count.
 * @param limit Maximum number of days returned.
 * @returns At most `limit` days and whether older collected days were left out.
 */
export async function listBoardDays(database: PGlite, scope: PlatformBoardScope, limit = MAX_LISTED_DAYS): Promise<BoardDayList> {
  const { params, where, add } = scopedQuery(scope);
  const max = add(limit + 1);
  const result = await database.query<{ observed_at: string }>(`
    WITH RECURSIVE days(observed_at) AS (
      (SELECT o.observed_at FROM observations o WHERE ${where('o')} ORDER BY o.observed_at DESC LIMIT 1)
      UNION ALL
      SELECT (SELECT o.observed_at FROM observations o WHERE ${where('o')} AND o.observed_at < ${dayStart('d.observed_at')}
        ORDER BY o.observed_at DESC LIMIT 1)
      FROM days d WHERE d.observed_at IS NOT NULL
    )
    SELECT ${isoText('observed_at')} AS observed_at FROM days WHERE observed_at IS NOT NULL LIMIT ${max}::integer
  `, params);
  const days = result.rows.map(row => ({ date: beijingDate(row.observed_at), observedAt: row.observed_at }));
  return { days: days.slice(0, limit), truncated: days.length > limit };
}

interface DayMember { date: string; payload: Observation; }

interface Aggregate { work: Work; days: DayMember[]; known: number[]; }

function compareAggregates(a: Aggregate, b: Aggregate): number {
  if (b.days.length !== a.days.length) return b.days.length - a.days.length;
  if (a.known.length && b.known.length) {
    // Cross-multiplied sums compare averages exactly.
    const difference = a.known.reduce((sum, rank) => sum + rank, 0) * b.known.length - b.known.reduce((sum, rank) => sum + rank, 0) * a.known.length;
    if (difference !== 0) return difference;
  } else if (a.known.length !== b.known.length) return a.known.length ? -1 : 1;
  return byRank(a.known.length ? Math.min(...a.known) : null, b.known.length ? Math.min(...b.known) : null);
}

/**
 * Computes one platform's board for a day, week or month from the last collection of each collected Beijing day.
 * A day lists that collection with rank changes against the previous calendar day's last collection, when that day was collected.
 * A week or month orders works by days on board, then average known rank, then best known rank; equal works share a position.
 * Uncollected days are neither filled nor counted, and unknown ranks never become numbers.
 * @param database Store holding `observations` and `works`.
 * @param lookup Returns a current work by ID; observations of works outside the scope's platform and origin are ignored.
 * @param scope Board, origin and platform.
 * @param period Day, week or month.
 * @param date Beijing date inside the period; omitted selects the latest collected day.
 * @returns The computed view, or null when the scope has never been collected.
 */
export async function projectBoardPeriod(database: PGlite, lookup: (id: string) => Work | undefined, scope: PlatformBoardScope, period: BoardPeriod, date?: string): Promise<BoardPeriodView | null> {
  if (date === undefined) {
    const latest = await database.query<{ observed_at: string }>(`SELECT ${isoText('o.observed_at')} AS observed_at FROM observations o
      WHERE ${scopedQuery(scope).where('o')} ORDER BY o.observed_at DESC LIMIT 1`, scopedQuery(scope).params);
    if (!latest.rows[0]) return null;
    date = beijingDate(latest.rows[0].observed_at);
  }
  const range = periodRange(period, date);
  const { params, where, add } = scopedQuery(scope);
  const lower = add(beijingMidnight(period === 'day' ? addDays(range.start, -1) : range.start));
  const upper = add(beijingMidnight(addDays(range.end, 1)));
  const result = await database.query<{ observed_at: string; work_id: string; payload: Observation }>(`
    WITH RECURSIVE days(observed_at) AS (
      (SELECT o.observed_at FROM observations o WHERE ${where('o')}
        AND o.observed_at >= ${lower}::timestamptz AND o.observed_at < ${upper}::timestamptz ORDER BY o.observed_at DESC LIMIT 1)
      UNION ALL
      SELECT (SELECT o.observed_at FROM observations o WHERE ${where('o')}
        AND o.observed_at >= ${lower}::timestamptz AND o.observed_at < ${dayStart('d.observed_at')} ORDER BY o.observed_at DESC LIMIT 1)
      FROM days d WHERE d.observed_at IS NOT NULL
    )
    SELECT ${isoText('d.observed_at')} AS observed_at, o.work_id, o.payload
    FROM days d JOIN observations o ON o.board=$1 AND o.origin=$2 AND o.observed_at=d.observed_at
    WHERE d.observed_at IS NOT NULL
  `, params);
  const collected = new Map<string, BoardDay>();
  const members = new Map<string, Map<string, Observation>>();
  for (const row of result.rows) {
    const day = beijingDate(row.observed_at);
    collected.set(day, { date: day, observedAt: row.observed_at });
    const work = lookup(row.work_id);
    if (work?.platform !== scope.platform || work.origin !== scope.origin) continue;
    const listed = members.get(day) ?? new Map<string, Observation>();
    listed.set(row.work_id, row.payload);
    members.set(day, listed);
  }
  const view = { platform: scope.platform, board: scope.board, origin: scope.origin, period, date, ...range };
  if (period === 'day') {
    const today = collected.get(date);
    if (!today) return { ...view, days: [], previous: null, items: [] };
    const previous = collected.get(addDays(date, -1)) ?? null;
    const before = previous ? members.get(previous.date) : undefined;
    const items = [...(members.get(date) ?? new Map<string, Observation>())].map(([id, payload]): BoardPeriodItem => {
      const prior = before?.get(id) ?? null;
      return { position: payload.rank, daysOnBoard: 1, averageRank: payload.rank, bestRank: payload.rank, lastDate: date,
        work: project(lookup(id)!, payload, prior, prior !== null) };
    }).sort((a, b) => byRank(a.position, b.position) || a.work.id.localeCompare(b.work.id));
    return { ...view, days: [today], previous, items };
  }
  const days = [...collected.values()].sort((a, b) => a.date.localeCompare(b.date));
  const aggregates = new Map<string, Aggregate>();
  for (const day of days) {
    for (const [id, payload] of members.get(day.date) ?? []) {
      const aggregate = aggregates.get(id) ?? { work: lookup(id)!, days: [], known: [] };
      aggregate.days.push({ date: day.date, payload });
      if (payload.rank != null) aggregate.known.push(payload.rank);
      aggregates.set(id, aggregate);
    }
  }
  const ordered = [...aggregates.values()].sort((a, b) => compareAggregates(a, b) || a.work.id.localeCompare(b.work.id));
  const items: BoardPeriodItem[] = [];
  ordered.forEach((aggregate, index) => {
    const last = aggregate.days.at(-1)!;
    const tied = index > 0 && compareAggregates(ordered[index - 1]!, aggregate) === 0;
    items.push({
      position: tied ? items[index - 1]!.position : index + 1,
      daysOnBoard: aggregate.days.length,
      averageRank: aggregate.known.length ? aggregate.known.reduce((sum, rank) => sum + rank, 0) / aggregate.known.length : null,
      bestRank: aggregate.known.length ? Math.min(...aggregate.known) : null,
      lastDate: last.date,
      work: project(aggregate.work, last.payload, null, false),
    });
  });
  return { ...view, days, previous: null, items };
}

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { DataRepository } from '../src/server/repository.ts';
import { createApp } from '../src/server/app.ts';
import { listBoardDays, projectBoardPeriod } from '../src/server/board-periods.ts';
import { beijingDate, periodRange } from '../src/shared/board-period.ts';
import type { BoardDayList, BoardPeriodView, Platform, Work } from '../src/shared/types.ts';

const board = '综合热播榜';
const [A, B, C, D, E, F, G] = ['01', '02', '03', '04', '05', '06', '07'].map(n => `92000000000000000${n}`) as [string, string, string, string, string, string, string];

/** Converts a Beijing wall-clock time to the stored UTC instant. */
const bj = (local: string) => new Date(`${local.replace(' ', 'T')}:00.000+08:00`).toISOString();

function work(platform: Platform, sourceId: string, rank: number | null, observedAt: string): Work {
  return {
    id: `${platform}:${sourceId}`, sourceId, platform, kind: platform === 'hongguo' ? 'drama' : 'novel',
    title: `周期作品${sourceId.slice(-2)}`, author: null, description: '日榜周榜月榜测试', coverUrl: null,
    sourceUrl: 'https://example.com/work', tags: [], category: '都市', episodeCount: null, wordCount: null,
    serialStatus: null, publishedAt: null, metrics: [{ key: 'heat', label: '热度', value: rank === null ? null : 1000 - rank }],
    rank, rankChange: null, board, origin: 'live', observedAt, sourceUpdatedAt: null,
  };
}

async function ingest(repository: DataRepository, platform: Platform, observedAt: string, rows: Array<[string, number | null]>): Promise<void> {
  await repository.ingestBatch({ platform, observedAt, coverage: '周期测试', works: rows.map(([id, rank]) => work(platform, id, rank, observedAt)) });
}

const ranked = (view: BoardPeriodView | null) => view?.items.map(item => [item.work.sourceId, item.position, item.work.rankChange]);
const summary = (view: BoardPeriodView | null) => view?.items.map(item => [item.work.sourceId, item.position, item.daysOnBoard, item.averageRank, item.bestRank, item.lastDate]);

describe('day, week and month boards', () => {
  let database: PGlite;
  let repository: DataRepository;
  const live = { platform: 'hongguo' as const, board, origin: 'live' as const };
  beforeAll(async () => {
    database = new PGlite();
    repository = new DataRepository(database);
    await repository.initialize({ seedDemo: false });
    await ingest(repository, 'hongguo', bj('2026-10-31 23:00'), [[G, 1]]);
    await ingest(repository, 'hongguo', bj('2026-11-09 10:00'), [[A, 1], [B, 2], [C, 3]]);
    await ingest(repository, 'hongguo', bj('2026-11-09 22:00'), [[B, 1], [A, 2], [C, 3]]);
    // 07:30 in Beijing is still the previous day in UTC.
    await ingest(repository, 'hongguo', bj('2026-11-10 07:30'), [[A, 1], [C, 2], [F, 3], [D, null]]);
    await ingest(repository, 'hongguo', bj('2026-11-12 23:59'), [[A, 1], [E, 2], [C, 3]]);
    await ingest(repository, 'hongguo', bj('2026-11-13 00:00'), [[E, 1], [B, 2], [A, 3]]);
    await ingest(repository, 'hongguo', bj('2026-12-01 00:30'), [[G, 1]]);
    // Another platform reusing the board name and demo rows on the uncollected day must not fill it.
    await ingest(repository, 'fanqie', bj('2026-11-11 12:00'), [[A, 1]]);
    const demo: Work = { ...work('hongguo', '9200000000000000099', 1, bj('2026-11-11 12:00')), id: 'demo-hongguo-period', origin: 'demo' };
    await database.query('INSERT INTO works(id,payload) VALUES($1,$2::jsonb)', [demo.id, JSON.stringify(demo)]);
    await database.query('INSERT INTO observations(work_id,board,origin,observed_at,payload) VALUES($1,$2,$3,$4,$5::jsonb)',
      [demo.id, board, 'demo', demo.observedAt, JSON.stringify({ observedAt: demo.observedAt, board, rank: 1, metrics: demo.metrics, origin: 'demo' })]);
  }, 30_000);
  afterAll(async () => { await database.close(); });

  it('derives Beijing dates and Monday-to-Sunday weeks and calendar months', () => {
    expect(beijingDate(bj('2026-11-10 07:30'))).toBe('2026-11-10');
    expect(beijingDate('2026-11-12T16:00:00.000Z')).toBe('2026-11-13');
    expect(periodRange('day', '2026-11-11')).toEqual({ start: '2026-11-11', end: '2026-11-11', daysInPeriod: 1 });
    expect(periodRange('week', '2026-11-15')).toEqual({ start: '2026-11-09', end: '2026-11-15', daysInPeriod: 7 });
    expect(periodRange('week', '2026-11-09')).toEqual({ start: '2026-11-09', end: '2026-11-15', daysInPeriod: 7 });
    expect(periodRange('week', '2026-12-31')).toEqual({ start: '2026-12-28', end: '2027-01-03', daysInPeriod: 7 });
    expect(periodRange('month', '2026-11-14')).toEqual({ start: '2026-11-01', end: '2026-11-30', daysInPeriod: 30 });
    expect(periodRange('month', '2028-02-03')).toEqual({ start: '2028-02-01', end: '2028-02-29', daysInPeriod: 29 });
  });

  it('lists each collected Beijing day once with its last collection, newest first, per platform and origin', async () => {
    expect(await repository.boardDays(live)).toEqual({ truncated: false, days: [
      { date: '2026-12-01', observedAt: bj('2026-12-01 00:30') }, { date: '2026-11-13', observedAt: bj('2026-11-13 00:00') },
      { date: '2026-11-12', observedAt: bj('2026-11-12 23:59') }, { date: '2026-11-10', observedAt: bj('2026-11-10 07:30') },
      { date: '2026-11-09', observedAt: bj('2026-11-09 22:00') }, { date: '2026-10-31', observedAt: bj('2026-10-31 23:00') },
    ] });
    expect(await listBoardDays(database, live, 2)).toEqual({ truncated: true, days: [
      { date: '2026-12-01', observedAt: bj('2026-12-01 00:30') }, { date: '2026-11-13', observedAt: bj('2026-11-13 00:00') }] });
    expect((await repository.boardDays({ ...live, platform: 'fanqie' })).days.map(day => day.date)).toEqual(['2026-11-11']);
    expect((await repository.boardDays({ ...live, origin: 'demo' })).days.map(day => day.date)).toEqual(['2026-11-11']);
    expect(await repository.boardDays({ ...live, platform: 'qimao' })).toEqual({ days: [], truncated: false });
  });

  it('shows a day from its last collection with rank changes against the previous calendar day', async () => {
    const day = await repository.boardPeriod({ ...live, period: 'day', date: '2026-11-10' });
    expect(day).toMatchObject({ period: 'day', date: '2026-11-10', start: '2026-11-10', end: '2026-11-10', daysInPeriod: 1,
      days: [{ date: '2026-11-10', observedAt: bj('2026-11-10 07:30') }], previous: { date: '2026-11-09', observedAt: bj('2026-11-09 22:00') } });
    expect(ranked(day)).toEqual([[A, 1, 1], [C, 2, 1], [F, 3, null], [D, null, null]]);
    expect(day?.items.find(item => item.work.sourceId === D)).toMatchObject({ averageRank: null, bestRank: null, work: { rank: null, metrics: [{ value: null }] } });
    expect(day?.items.every(item => item.work.observedAt === bj('2026-11-10 07:30'))).toBe(true);
    // The earlier same-day collection is not the day's board.
    expect(ranked(await repository.boardPeriod({ ...live, period: 'day', date: '2026-11-09' }))).toEqual([[B, 1, null], [A, 2, null], [C, 3, null]]);
  });

  it('does not compare across an uncollected day or fill a missing day from another platform or origin', async () => {
    const afterGap = await repository.boardPeriod({ ...live, period: 'day', date: '2026-11-12' });
    expect(afterGap?.previous).toBeNull();
    expect(ranked(afterGap)).toEqual([[A, 1, null], [E, 2, null], [C, 3, null]]);
    expect(await repository.boardPeriod({ ...live, period: 'day', date: '2026-11-11' })).toMatchObject({ date: '2026-11-11', days: [], previous: null, items: [] });
    expect(await repository.boardPeriod({ ...live, period: 'day', date: '2027-01-01' })).toMatchObject({ days: [], items: [] });
  });

  it('defaults to the latest collected day and returns null for a board that was never collected', async () => {
    const latest = await repository.boardPeriod({ ...live, period: 'day' });
    expect(latest).toMatchObject({ date: '2026-12-01', previous: null });
    expect(ranked(latest)).toEqual([[G, 1, null]]);
    expect(await repository.boardPeriod({ ...live, board: '没有采集的榜', period: 'day' })).toBeNull();
    expect(await repository.boardPeriod({ ...live, platform: 'qimao', period: 'week' })).toBeNull();
  });

  it('orders a week by days on board, average rank and best rank, sharing positions on full ties', async () => {
    const week = await repository.boardPeriod({ ...live, period: 'week', date: '2026-11-11' });
    expect(week).toMatchObject({ start: '2026-11-09', end: '2026-11-15', daysInPeriod: 7, previous: null });
    expect(week?.days.map(day => day.date)).toEqual(['2026-11-09', '2026-11-10', '2026-11-12', '2026-11-13']);
    expect(summary(week)).toEqual([
      [A, 1, 4, 1.75, 1, '2026-11-13'],
      [C, 2, 3, 8 / 3, 2, '2026-11-12'],
      [B, 3, 2, 1.5, 1, '2026-11-13'],
      [E, 3, 2, 1.5, 1, '2026-11-13'],
      [F, 5, 1, 3, 3, '2026-11-10'],
      [D, 6, 1, null, null, '2026-11-10'],
    ]);
    const a = week?.items[0]?.work;
    expect(a).toMatchObject({ rank: 3, rankChange: null, observedAt: bj('2026-11-13 00:00'), metrics: [{ value: 997 }] });
  });

  it('keeps month boundaries in Beijing time and counts only collected days', async () => {
    const november = await repository.boardPeriod({ ...live, period: 'month', date: '2026-11-30' });
    expect(november).toMatchObject({ start: '2026-11-01', end: '2026-11-30', daysInPeriod: 30 });
    expect(november?.days.map(day => day.date)).toEqual(['2026-11-09', '2026-11-10', '2026-11-12', '2026-11-13']);
    expect(november?.items.map(item => item.work.sourceId)).not.toContain(G);
    expect(summary(await repository.boardPeriod({ ...live, period: 'month', date: '2026-12-15' }))).toEqual([[G, 1, 1, 1, 1, '2026-12-01']]);
    expect(summary(await repository.boardPeriod({ ...live, period: 'month', date: '2026-10-01' }))).toEqual([[G, 1, 1, 1, 1, '2026-10-31']]);
    expect(await repository.boardPeriod({ ...live, period: 'week', date: '2026-11-18' })).toMatchObject({ days: [], items: [] });
    expect(summary(await repository.boardPeriod({ ...live, origin: 'demo', period: 'week', date: '2026-11-11' }))).toEqual([['9200000000000000099', 1, 1, 1, 1, '2026-11-11']]);
    expect(summary(await repository.boardPeriod({ ...live, platform: 'fanqie', period: 'week', date: '2026-11-11' }))).toEqual([[A, 1, 1, 1, 1, '2026-11-11']]);
  });

  it('serves days and periods over HTTP with script metadata and validated parameters', async () => {
    const { app } = createApp({ repository });
    const get = (path: string, query: Record<string, string>) => app.request(`http://127.0.0.1:4317${path}?${new URLSearchParams(query)}`);
    const days = await get('/api/boards/days', { platform: 'hongguo', board });
    expect(days.status).toBe(200);
    expect(((await days.json()) as BoardDayList).days[0]).toEqual({ date: '2026-12-01', observedAt: bj('2026-12-01 00:30') });
    const week = await get('/api/boards/period', { platform: 'hongguo', board, period: 'week', date: '2026-11-11' });
    expect(week.status).toBe(200);
    const body = await week.json() as BoardPeriodView;
    expect(summary(body)?.[0]).toEqual([A, 1, 4, 1.75, 1, '2026-11-13']);
    expect(body.items.every(item => item.work.script === null)).toBe(true);
    expect((await (await get('/api/boards/period', { platform: 'hongguo', board })).json() as BoardPeriodView)).toMatchObject({ period: 'day', date: '2026-12-01', origin: 'live' });
    expect((await get('/api/boards/period', { platform: 'hongguo', board: '没有采集的榜' })).status).toBe(404);
    for (const query of [{ date: '2026-02-30' }, { date: '2026-1-1' }, { period: 'year' }, { at: '2026-11-11' }, { board: ' ' }] as Record<string, string>[]) {
      expect((await get('/api/boards/period', { platform: 'hongguo', board, ...query })).status).toBe(400);
    }
    expect((await get('/api/boards/days', { platform: 'hongguo', board, date: '2026-11-11' })).status).toBe(400);
  });
});

describe('board period index use', () => {
  it('reads collected days and period members through the board-time index without scanning history', async () => {
    const database = new PGlite();
    try {
      const repository = new DataRepository(database);
      await repository.initialize({ seedDemo: false });
      await database.exec(`INSERT INTO works(id,payload) SELECT 'hongguo:'||g, jsonb_build_object('id','hongguo:'||g,'platform','hongguo','origin','live') FROM generate_series(1,500) g;
        INSERT INTO observations(work_id,board,origin,observed_at,payload)
        SELECT 'hongguo:'||(1+(b*20+k+w) % 500), 'B'||k, 'live', timestamptz '2026-09-01' + b*interval '6 hours', jsonb_build_object('rank',w)
        FROM generate_series(0,239) b, generate_series(0,19) k, generate_series(1,40) w ON CONFLICT DO NOTHING; ANALYZE;`);
      const spy = vi.spyOn(database, 'query');
      const scope = { platform: 'hongguo' as const, board: 'B3', origin: 'live' as const };
      expect((await listBoardDays(database, scope)).days).toHaveLength(61);
      expect((await projectBoardPeriod(database, () => undefined, scope, 'month', '2026-10-15'))?.days).toHaveLength(31);
      const calls = spy.mock.calls.filter(([sql]) => sql.includes('WITH RECURSIVE'));
      spy.mockRestore();
      expect(calls).toHaveLength(2);
      for (const [sql, params] of calls) {
        const plan = (await database.query<{ 'QUERY PLAN': string }>(`EXPLAIN ${sql}`, params)).rows.map(row => row['QUERY PLAN']).join('\n');
        expect(plan).toContain('observations_board_origin_time');
        expect(plan).not.toMatch(/Seq Scan on observations/);
      }
    } finally { await database.close(); }
  }, 60_000);
});

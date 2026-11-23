import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { availableBoards, projectBoardWorks } from '../src/server/board-catalog.ts';
import type { Observation, Work } from '../src/shared/types.ts';

const firstId = 'hongguo:9000000000000000011';
const otherId = 'hongguo:9000000000000000022';
function work(id = firstId, origin: Work['origin'] = 'live'): Work {
  return {
    id, sourceId: id.split(':')[1]!, platform: 'hongguo', kind: 'drama', title: '原始作品名称',
    author: '原始作者', description: '保留的作品简介', coverUrl: 'https://example.com/cover.jpg',
    sourceUrl: 'https://hongguoduanju.com/', tags: ['年代'], category: '年代',
    episodeCount: null, wordCount: null, serialStatus: null, publishedAt: null,
    metrics: [{ key: 'heat', label: '热度', value: 999 }], board: '综合榜', rank: 99,
    rankChange: 88, origin, observedAt: '2026-11-13T00:00:00.000Z', sourceUpdatedAt: '来源原文',
  };
}

describe('catalog board projections', () => {
  let database: PGlite;
  const insert = async (id: string, board: string, rank: number | null, date: string, origin: Work['origin'] = 'live') => {
    const observation: Observation = { board, rank, observedAt: date, origin, metrics: [{ key: 'heat', label: '热度', value: rank === null ? null : 1000 - rank }] };
    await database.query('INSERT INTO observations(work_id,board,origin,observed_at,payload) VALUES($1,$2,$3,$4,$5::jsonb)', [id, board, origin, date, JSON.stringify(observation)]);
  };
  beforeAll(async () => {
    database = new PGlite();
    await database.exec(`CREATE TABLE observations (
      work_id text NOT NULL, board text NOT NULL, origin text NOT NULL,
      observed_at timestamptz NOT NULL, payload jsonb NOT NULL,
      PRIMARY KEY(work_id,board,origin,observed_at)
    )`);
    await insert(firstId, '综合榜', 10, '2026-11-10T00:00:00.000Z');
    await insert(firstId, '综合榜', 5, '2026-11-12T00:00:00.000Z');
    await insert(firstId, '综合榜', 6, '2026-11-11T00:00:00.000Z');
    await insert(firstId, '真人榜', 8, '2026-11-11T00:00:00.000Z');
    await insert(firstId, '真人榜', 2, '2026-11-13T00:00:00.000Z');
    await insert(firstId, '仅示例榜', 1, '2026-11-13T00:00:00.000Z', 'demo');
    await insert(firstId, '真人榜', 50, '2026-11-14T00:00:00.000Z', 'demo');
    await insert(otherId, '不在范围的榜', 1, '2026-11-13T00:00:00.000Z');
    await insert(otherId, '真人榜', null, '2026-11-13T00:00:00.000Z');
  });
  afterAll(async () => { await database.close(); });

  it('projects one shared work into each selected board without replacing its metadata', async () => {
    const original = work();
    const [real] = await projectBoardWorks(database, [original], '真人榜');
    expect(real).toMatchObject({ id: firstId, sourceId: '9000000000000000011', title: original.title,
      author: original.author, coverUrl: original.coverUrl, description: original.description,
      board: '真人榜', rank: 2, rankChange: 6, observedAt: '2026-11-13T00:00:00.000Z' });
    expect(real?.metrics[0]?.value).toBe(998);
    expect(original.rank).toBe(99);
  });

  it('uses observation times rather than insertion order for prior-rank changes', async () => {
    const [overall] = await projectBoardWorks(database, [work()], '综合榜');
    expect(overall?.rank).toBe(5);
    expect(overall?.rankChange).toBe(1);
    expect(overall?.observedAt).toBe('2026-11-12T00:00:00.000Z');
  });

  it('does not keep dropped works in a newer board batch, even when a search excludes current members', async () => {
    try {
      await insert(firstId, '批次验收榜', 1, '2026-11-10T00:00:00.000Z');
      await insert(otherId, '批次验收榜', 1, '2026-11-13T00:00:00.000Z');
      expect((await projectBoardWorks(database, [work(), work(otherId)], '批次验收榜')).map(item => item.id)).toEqual([otherId]);
      expect(await projectBoardWorks(database, [work()], '批次验收榜')).toEqual([]);
    } finally { await database.query('DELETE FROM observations WHERE board=$1', ['批次验收榜']); }
  });

  it('can read a dropped work for historical details without returning it to the current chart', async () => {
    try {
      await insert(firstId, '历史详情榜', 8, '2026-11-10T00:00:00.000Z');
      await insert(otherId, '历史详情榜', 1, '2026-11-11T00:00:00.000Z');
      expect(await projectBoardWorks(database, [work()], '历史详情榜')).toEqual([]);
      expect((await projectBoardWorks(database, [work()], '历史详情榜', 'live', true))[0]).toMatchObject({ rank: 8, rankChange: null, observedAt: '2026-11-10T00:00:00.000Z' });
    } finally { await database.query('DELETE FROM observations WHERE board=$1', ['历史详情榜']); }
  });

  it('does not treat re-entering after a missing batch as a continuous rank increase', async () => {
    try {
      await insert(firstId, '重返榜', 8, '2026-11-10T00:00:00.000Z');
      await insert(otherId, '重返榜', 1, '2026-11-11T00:00:00.000Z');
      await insert(firstId, '重返榜', 2, '2026-11-12T00:00:00.000Z');
      expect((await projectBoardWorks(database, [work()], '重返榜'))[0]?.rankChange).toBeNull();
    } finally { await database.query('DELETE FROM observations WHERE board=$1', ['重返榜']); }
  });

  it('leaves a legacy observation date unknown instead of using a different canonical board date', async () => {
    expect((await projectBoardWorks(database, [work()], '真人榜'))[0]?.sourceUpdatedAt).toBeNull();
  });

  it('keeps later demo observations out of live projections and respects an explicit origin', async () => {
    expect((await projectBoardWorks(database, [work()], '真人榜'))[0]?.rank).toBe(2);
    expect(await projectBoardWorks(database, [work()], '真人榜', 'demo')).toEqual([]);
    const [demo] = await projectBoardWorks(database, [work(firstId, 'demo')], '真人榜', 'demo');
    expect(demo?.rank).toBe(50);
    expect(demo?.rankChange).toBeNull();
  });

  it('does not add out-of-scope works or boards belonging to another origin', async () => {
    const scoped = [work()];
    expect(await availableBoards(database, scoped)).toEqual(['综合榜', '真人榜'].sort((a, b) => a.localeCompare(b, 'zh-CN')));
    expect(await projectBoardWorks(database, scoped, '不在范围的榜')).toEqual([]);
    const all = await projectBoardWorks(database, [work(otherId), work()], '真人榜');
    expect(all.map(item => item.id)).toEqual([otherId, firstId]);
    expect(all[0]?.rank).toBeNull();
    expect(all[0]?.rankChange).toBeNull();
  });

  it('uses one parameterized query for any supplied work count and inert board strings', async () => {
    const spy = vi.spyOn(database, 'query');
    try {
      expect(await projectBoardWorks(database, [work(), work(otherId)], "真人榜' OR 1=1 --")).toEqual([]);
      expect(spy).toHaveBeenCalledTimes(1);
      const query = spy.mock.calls[0]!;
      expect(query[0]).not.toContain("真人榜' OR 1=1 --");
      expect(query[1]).toContain("真人榜' OR 1=1 --");
    } finally { spy.mockRestore(); }
  });

  it('returns empty results for empty scopes without querying the database', async () => {
    const spy = vi.spyOn(database, 'query');
    try {
      expect(await availableBoards(database, [])).toEqual([]);
      expect(await projectBoardWorks(database, [], '综合榜')).toEqual([]);
      expect(spy).not.toHaveBeenCalled();
    } finally { spy.mockRestore(); }
  });
});

describe('observation history index', () => {
  it('creates the board-time index on new and existing databases and uses it for previous-batch lookups', async () => {
    const { DataRepository } = await import('../src/server/repository.ts');
    const database = new PGlite();
    try {
      await new DataRepository(database).initialize({ seedDemo: false });
      await database.exec('DROP INDEX observations_board_origin_time');
      await new DataRepository(database).initialize({ seedDemo: false });
      await new DataRepository(database).initialize({ seedDemo: false });
      const indexes = await database.query<{ indexdef: string }>("SELECT indexdef FROM pg_indexes WHERE indexname='observations_board_origin_time'");
      expect(indexes.rows.map(row => row.indexdef)).toEqual([expect.stringContaining('(board, origin, observed_at)')]);
      await database.exec(`INSERT INTO works(id,payload) SELECT 'fanqie:'||g, '{}'::jsonb FROM generate_series(1,500) g;
        INSERT INTO observations(work_id,board,origin,observed_at,payload)
        SELECT 'fanqie:'||(1+(b*20+k+w) % 500), 'B'||k, 'live', timestamptz '2026-11-01' + b*interval '6 hours', '{}'::jsonb
        FROM generate_series(0,19) b, generate_series(0,19) k, generate_series(1,50) w ON CONFLICT DO NOTHING; ANALYZE observations;`);
      const plan = await database.query<{ 'QUERY PLAN': string }>(`EXPLAIN SELECT max(observed_at) FROM observations
        WHERE board=$1 AND origin=$2 AND observed_at < $3`, ['B3', 'live', '2026-12-01T00:00:00.000Z']);
      expect(plan.rows.map(row => row['QUERY PLAN']).join('\n')).toContain('observations_board_origin_time');
    } finally { await database.close(); }
  });
});

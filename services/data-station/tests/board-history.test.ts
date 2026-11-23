import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { DataRepository } from '../src/server/repository.ts';
import { createApp } from '../src/server/app.ts';
import { listBoardBatches, projectBoardBatch } from '../src/server/board-catalog.ts';
import type { BoardBatchList, BoardComparison, CatalogResponse, Platform, Work } from '../src/shared/types.ts';

const board = '综合热播榜';
const [t1, t2, t3] = ['2026-11-12T00:00:00.000Z', '2026-11-12T06:00:00.000Z', '2026-11-12T12:00:00.000Z'];
const otherPlatformTime = '2026-11-12T18:00:00.000Z';
const demoTime = '2026-11-13T00:00:00.000Z';
const [A, B, C, D] = ['9100000000000000001', '9100000000000000002', '9100000000000000003', '9100000000000000004'];

function work(platform: Platform, sourceId: string, rank: number | null, observedAt: string, heat: number | null = 1000): Work {
  return {
    id: `${platform}:${sourceId}`, sourceId, platform, kind: platform === 'hongguo' ? 'drama' : 'novel',
    title: `批次作品${sourceId.slice(-2)}`, author: null, description: '批次历史测试', coverUrl: null,
    sourceUrl: 'https://example.com/work', tags: [], category: '都市', episodeCount: null, wordCount: null,
    serialStatus: null, publishedAt: null, metrics: [{ key: 'heat', label: '热度', value: heat }],
    rank, rankChange: null, board, origin: 'live', observedAt, sourceUpdatedAt: null,
  };
}

async function ingest(repository: DataRepository, platform: Platform, observedAt: string, rows: Array<[string, number | null, (number | null)?]>): Promise<void> {
  await repository.ingestBatch({ platform, observedAt, coverage: '批次历史测试', works: rows.map(([id, rank, heat]) => work(platform, id, rank, observedAt, heat === undefined ? 1000 : heat)) });
}

const rows = (items: Work[]) => items.map(item => [item.sourceId, item.rank, item.rankChange]);
const entries = (comparison: BoardComparison | null) => comparison?.entries.map(entry => [entry.work.sourceId, entry.status, entry.fromRank, entry.toRank, entry.rankChange]);

describe('board batch history', () => {
  let database: PGlite;
  let repository: DataRepository;
  beforeAll(async () => {
    database = new PGlite();
    repository = new DataRepository(database);
    await repository.initialize({ seedDemo: false });
    await ingest(repository, 'hongguo', t1, [[A, 1], [B, 2], [C, 3, null]]);
    await ingest(repository, 'hongguo', t3, [[A, 1], [C, 2], [D, null]]);
    await ingest(repository, 'hongguo', t2, [[B, 1], [A, 2], [D, 3]]);
    // A different platform reusing the board name must not become a Hongguo batch.
    await ingest(repository, 'fanqie', otherPlatformTime, [[A, 1]]);
    const demo: Work = { ...work('hongguo', '9100000000000000009', 1, demoTime), id: 'demo-hongguo-board-history', origin: 'demo' };
    await database.query('INSERT INTO works(id,payload) VALUES($1,$2::jsonb)', [demo.id, JSON.stringify(demo)]);
    await database.query('INSERT INTO observations(work_id,board,origin,observed_at,payload) VALUES($1,$2,$3,$4,$5::jsonb)',
      [demo.id, board, 'demo', demoTime, JSON.stringify({ observedAt: demoTime, board, rank: 1, metrics: demo.metrics, origin: 'demo' })]);
  }, 30_000);
  afterAll(async () => { await database.close(); });

  it('lists batch times newest first within one platform, board and origin', async () => {
    expect(await repository.boardBatches({ platform: 'hongguo', board, origin: 'live' })).toEqual({ batches: [t3, t2, t1], truncated: false });
    expect(await repository.boardBatches({ platform: 'fanqie', board, origin: 'live' })).toEqual({ batches: [otherPlatformTime], truncated: false });
    expect(await repository.boardBatches({ platform: 'hongguo', board, origin: 'demo' })).toEqual({ batches: [demoTime], truncated: false });
    expect(await repository.boardBatches({ platform: 'qimao', board, origin: 'live' })).toEqual({ batches: [], truncated: false });
    expect(await repository.boardBatches({ platform: 'hongguo', board: '不存在的榜', origin: 'live' })).toEqual({ batches: [], truncated: false });
    expect(await listBoardBatches(database, { platform: 'hongguo', board, origin: 'live' }, 2)).toEqual({ batches: [t3, t2], truncated: true });
  });

  it('returns a past batch with its own ranks and metrics and rank changes against the batch before it', async () => {
    const second = await repository.listWorks({ platform: 'hongguo', board, origin: 'live', at: t2 });
    expect(second.batch).toEqual({ observedAt: t2, previousObservedAt: t1 });
    expect(rows(second.items)).toEqual([[B, 1, 1], [A, 2, -1], [D, 3, null]]);
    expect(second.items.every(item => item.observedAt === t2 && item.board === board)).toBe(true);

    const first = await repository.listWorks({ platform: 'hongguo', board, origin: 'live', at: t1 });
    expect(first.batch).toEqual({ observedAt: t1, previousObservedAt: null });
    expect(rows(first.items)).toEqual([[A, 1, null], [B, 2, null], [C, 3, null]]);
    expect(first.items.find(item => item.sourceId === C)?.metrics).toEqual([{ key: 'heat', label: '热度', value: null }]);
  });

  it('defaults to the latest batch of the selected platform and keeps unknown ranks and re-entries without a change', async () => {
    const latest = await repository.listWorks({ platform: 'hongguo', board, origin: 'live' });
    expect(latest.batch).toEqual({ observedAt: t3, previousObservedAt: t2 });
    expect(rows(latest.items)).toEqual([[A, 1, 1], [C, 2, null], [D, null, null]]);
    expect(await repository.listWorks({ platform: 'hongguo', board, origin: 'live', at: t3 })).toEqual(latest);
    expect(rows((await repository.listWorks({ platform: 'hongguo', board, origin: 'live', at: t2, sort: 'rising' })).items)).toEqual([[B, 1, 1], [A, 2, -1], [D, 3, null]]);
  });

  it('never mixes demo and live batches or another origin\'s times', async () => {
    const demo = await repository.listWorks({ platform: 'hongguo', board, origin: 'demo' });
    expect(demo.batch).toEqual({ observedAt: demoTime, previousObservedAt: null });
    expect(demo.items.map(item => item.id)).toEqual(['demo-hongguo-board-history']);
    const missing = await repository.listWorks({ platform: 'hongguo', board, origin: 'live', at: demoTime });
    expect(missing).toMatchObject({ batch: null, items: [], total: 0 });
    expect(await repository.listWorks({ platform: 'hongguo', board, origin: 'live', at: otherPlatformTime })).toMatchObject({ batch: null, items: [] });
    await expect(repository.listWorks({ platform: 'hongguo', board, at: t2 })).rejects.toThrow('one data origin');
  });

  it('matches a listed millisecond batch time against a stored time with finer precision', async () => {
    const fine = '2026-11-11T00:00:00.123456Z';
    const { batches } = await listBoardBatches(database, { board: '精度榜', origin: 'live' });
    expect(batches).toEqual([]);
    try {
      await database.query('INSERT INTO observations(work_id,board,origin,observed_at,payload) VALUES($1,$2,$3,$4,$5::jsonb)',
        [`hongguo:${A}`, '精度榜', 'live', fine, JSON.stringify({ observedAt: fine, board: '精度榜', rank: 4, metrics: [], origin: 'live' })]);
      const listed = await listBoardBatches(database, { platform: 'hongguo', board: '精度榜', origin: 'live' });
      expect(listed.batches).toEqual(['2026-11-11T00:00:00.123Z']);
      const scope = (await repository.listWorks({ platform: 'hongguo', origin: 'live' })).items;
      const projected = await projectBoardBatch(database, scope, { platform: 'hongguo', board: '精度榜', origin: 'live' }, listed.batches[0]);
      expect(projected.batch?.observedAt).toBe('2026-11-11T00:00:00.123Z');
      expect(projected.works.map(item => item.rank)).toEqual([4]);
    } finally { await database.query('DELETE FROM observations WHERE board=$1', ['精度榜']); }
  });

  it('compares two batches by membership and known ranks, ignoring batches in between', async () => {
    const wide = await repository.compareBoardBatches({ platform: 'hongguo', board, origin: 'live', from: t1, to: t3 });
    expect(wide).toMatchObject({ platform: 'hongguo', board, origin: 'live', from: t1, to: t3 });
    expect(entries(wide)).toEqual([[A, 'stayed', 1, 1, 0], [C, 'stayed', 3, 2, 1], [D, 'entered', null, null, null], [B, 'dropped', 2, null, null]]);
    expect(wide?.entries[0]?.work).toEqual({ id: `hongguo:${A}`, sourceId: A, title: '批次作品01', author: null });
    const adjacent = await repository.compareBoardBatches({ platform: 'hongguo', board, origin: 'live', from: t2, to: t3 });
    expect(entries(adjacent)).toEqual([[A, 'stayed', 2, 1, 1], [C, 'entered', null, 2, null], [D, 'stayed', 3, null, null], [B, 'dropped', 1, null, null]]);
  });

  it('refuses comparisons with a time that is not a batch of the same platform, board and origin', async () => {
    const compare = (from: string, to: string, platform: Platform = 'hongguo') => repository.compareBoardBatches({ platform, board, origin: 'live', from, to });
    expect(await compare('2026-11-11T00:00:00.000Z', t3)).toBeNull();
    expect(await compare(t1, otherPlatformTime)).toBeNull();
    expect(await compare(t1, demoTime)).toBeNull();
    expect(await compare(t1, t3, 'qimao')).toBeNull();
    expect(await repository.compareBoardBatches({ platform: 'hongguo', board, origin: 'demo', from: t1, to: demoTime })).toBeNull();
  });
});

describe('board history API', () => {
  let database: PGlite;
  let repository: DataRepository;
  const origin = 'http://127.0.0.1:4317';
  beforeAll(async () => {
    database = new PGlite();
    repository = new DataRepository(database);
    await repository.initialize({ seedDemo: false });
    await ingest(repository, 'hongguo', t1, [[A, 1], [B, 2], [C, 3]]);
    await ingest(repository, 'hongguo', t2, [[B, 1], [A, 2], [D, 3]]);
  }, 30_000);
  afterAll(async () => { await database.close(); });
  const get = (path: string, query: Record<string, string>) => createApp({ repository }).app.request(`${origin}${path}?${new URLSearchParams(query)}`);

  it('lists batch times and validates the board scope', async () => {
    const response = await get('/api/boards/batches', { platform: 'hongguo', board });
    expect(response.status).toBe(200);
    expect(await response.json() as BoardBatchList).toEqual({ batches: [t2, t1], truncated: false });
    expect(await (await get('/api/boards/batches', { platform: 'hongguo', board, origin: 'demo' })).json()).toEqual({ batches: [], truncated: false });
    expect((await get('/api/boards/batches', { board })).status).toBe(400);
    expect((await get('/api/boards/batches', { platform: 'hongguo', board: ' ' })).status).toBe(400);
    expect((await get('/api/boards/batches', { platform: 'hongguo', board, limit: '5' })).status).toBe(400);
  });

  it('returns the selected batch of a board listing and rejects times that are not batches', async () => {
    const response = await get('/api/works', { platform: 'hongguo', board, at: t1 });
    expect(response.status).toBe(200);
    const body = await response.json() as CatalogResponse;
    expect(body.batch).toEqual({ observedAt: t1, previousObservedAt: null });
    expect(rows(body.items)).toEqual([[A, 1, null], [B, 2, null], [C, 3, null]]);
    const latest = await (await get('/api/works', { platform: 'hongguo', board })).json() as CatalogResponse;
    expect(latest.batch).toEqual({ observedAt: t2, previousObservedAt: t1 });
    const offset = await (await get('/api/works', { platform: 'hongguo', board, at: '2026-11-12T14:00:00+08:00' })).json() as CatalogResponse;
    expect(offset.batch?.observedAt).toBe(t2);
    const missing = await get('/api/works', { platform: 'hongguo', board, at: '2026-11-11T00:00:00.000Z' });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: '所选采集批次不存在' });
    expect((await get('/api/works', { platform: 'hongguo', at: t1 })).status).toBe(400);
    expect((await get('/api/works', { platform: 'hongguo', board, at: '昨天' })).status).toBe(400);
    expect(await (await get('/api/works', { platform: 'hongguo' })).json()).not.toHaveProperty('batch');
  });

  it('filters facets and exports by the selected batch', async () => {
    const csv = await (await get('/api/export', { platform: 'hongguo', board, at: t1 })).text();
    expect(csv).toContain(`"'${C}"`);
    expect(csv).not.toContain(`"'${D}"`);
    expect(csv).toContain(t1);
    expect((await get('/api/export', { platform: 'hongguo', board, at: '2026-11-11T00:00:00.000Z' })).status).toBe(404);
    expect((await get('/api/facets', { platform: 'hongguo', board, at: t1 })).status).toBe(200);
  });

  it('compares an earlier batch with a later one', async () => {
    const response = await get('/api/boards/compare', { platform: 'hongguo', board, from: t1, to: t2 });
    expect(response.status).toBe(200);
    const body = await response.json() as BoardComparison;
    expect(entries(body)).toEqual([[B, 'stayed', 2, 1, 1], [A, 'stayed', 1, 2, -1], [D, 'entered', null, 3, null], [C, 'dropped', 3, null, null]]);
    expect((await get('/api/boards/compare', { platform: 'hongguo', board, from: t2, to: t1 })).status).toBe(400);
    expect((await get('/api/boards/compare', { platform: 'hongguo', board, from: t1, to: t1 })).status).toBe(400);
    expect((await get('/api/boards/compare', { platform: 'hongguo', board, from: '2026-11-11T00:00:00.000Z', to: t2 })).status).toBe(404);
    expect((await get('/api/boards/compare', { platform: 'hongguo', board, from: t1, to: t2, origin: 'demo' })).status).toBe(404);
    expect((await get('/api/boards/compare', { platform: 'hongguo', board, from: t1 })).status).toBe(400);
  });
});

describe('board history index use', () => {
  it('reads batch times and batch members through the board-time index', async () => {
    const database = new PGlite();
    try {
      await new DataRepository(database).initialize({ seedDemo: false });
      await database.exec(`INSERT INTO works(id,payload) SELECT 'fanqie:'||g, jsonb_build_object('platform','fanqie') FROM generate_series(1,500) g;
        INSERT INTO observations(work_id,board,origin,observed_at,payload)
        SELECT 'fanqie:'||(1+(b*20+k+w) % 500), 'B'||k, 'live', timestamptz '2026-11-01' + b*interval '6 hours', jsonb_build_object('rank',w)
        FROM generate_series(0,19) b, generate_series(0,19) k, generate_series(1,50) w ON CONFLICT DO NOTHING; ANALYZE observations;`);
      const scope = { platform: 'fanqie' as const, board: 'B3', origin: 'live' as const };
      const spy = vi.spyOn(database, 'query');
      let listed: BoardBatchList;
      try {
        listed = await listBoardBatches(database, scope);
        await projectBoardBatch(database, [], scope, listed.batches[4]);
      } finally { spy.mockRestore(); }
      expect(listed.batches).toHaveLength(20);
      expect(listed.batches[0]).toBe('2026-11-05T18:00:00.000Z');
      for (const [sql, params] of spy.mock.calls) {
        const plan = await database.query<{ 'QUERY PLAN': string }>(`EXPLAIN ${sql}`, params);
        expect(plan.rows.map(row => row['QUERY PLAN']).join('\n')).toContain('observations_board_origin_time');
      }
    } finally { await database.close(); }
  });
});

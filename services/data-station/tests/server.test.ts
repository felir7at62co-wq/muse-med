import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { mkdtemp, mkdir, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DataRepository } from '../src/server/repository.ts';
import { createApp } from '../src/server/app.ts';
import { resolveConfig } from '../src/server/config.ts';
import { acquireDatabaseLock } from '../src/server/lock.ts';
import type { CollectionBatch, Work } from '../src/shared/types.ts';

const date = '2026-11-13T02:00:00.000Z';
it('filters rising works by source before taking the dashboard shortlist', async () => {
  const database = new PGlite();
  try {
    const repository = new DataRepository(database);
    await repository.initialize();
    const first = liveWork({ sourceId: '9000000000000000051', observedAt: date, rank: 999 });
    await repository.ingestBatch(batch([first]));
    await repository.ingestBatch(batch([{ ...first, rank: 998, observedAt: '2026-11-14T02:00:00.000Z' }]));
    const dashboard = await repository.dashboard({ origin: 'live' });
    expect(dashboard.rising).toHaveLength(1);
    expect(dashboard.rising[0]?.sourceId).toBe(first.sourceId);
    expect(dashboard.rising[0]?.origin).toBe('live');
    expect(dashboard.demoWorks).toBe(0);
  } finally {
    await database.close();
  }
});

it('preserves each board date and leaves a returning work without a continuous rank change', async () => {
  const database = new PGlite();
  try {
    const repository = new DataRepository(database);
    await repository.initialize({ seedDemo: false });
    const first = liveWork({ board: '日期日榜', rank: 8, sourceUpdatedAt: '统计截至11月12日' });
    await repository.ingestBatch(batch([first, { ...first, board: '日期月榜', sourceUpdatedAt: '统计月份10月' }]));
    expect((await repository.getWork(first.id, '日期日榜'))?.work.sourceUpdatedAt).toBe('统计截至11月12日');
    expect((await repository.getWork(first.id, '日期月榜'))?.work.sourceUpdatedAt).toBe('统计月份10月');
    await repository.ingestBatch(batch([{ ...first, sourceId: '9000000000000000022', observedAt: '2026-11-14T02:00:00.000Z' }]));
    expect((await repository.getWork(first.id, first.board))?.work).toMatchObject({ rank: 8, observedAt: date, sourceUpdatedAt: '统计截至11月12日' });
    expect((await repository.listWorks({ board: first.board })).items.map(work => work.id)).not.toContain(first.id);
    await repository.ingestBatch(batch([{ ...first, rank: 2, observedAt: '2026-11-15T02:00:00.000Z' }]));
    expect((await repository.getWork(first.id))?.work.rankChange).toBeNull();
    expect((await repository.getWork(first.id, first.board))?.work.rankChange).toBeNull();
  } finally { await database.close(); }
});

it('reuses parsed metadata, refreshes only published works and preserves it after a failed write', async () => {
  const database = new PGlite();
  try {
    const repository = new DataRepository(database);
    await repository.initialize({ seedDemo: false });
    await repository.ingestBatch(batch([liveWork()]));
    const query = vi.spyOn(database, 'query');
    const reads = () => query.mock.calls.filter(call => call[0] === 'SELECT payload FROM works').length;
    const refreshes = () => query.mock.calls.filter(call => String(call[0]).startsWith('SELECT payload FROM works WHERE id = ANY')).length;
    try {
      await repository.listWorks(); await repository.listWorks(); await repository.facets();
      expect(reads()).toBe(1);
      const next = liveWork({ title: '新批次作品', observedAt: '2026-11-14T02:00:00.000Z' });
      await repository.ingestBatch(batch([next]));
      expect((await repository.listWorks()).items[0]?.title).toBe('新批次作品');
      expect(reads()).toBe(1); expect(refreshes()).toBe(1);
      const transaction = vi.spyOn(database, 'transaction').mockRejectedValueOnce(new Error('injected write failure'));
      try { await expect(repository.ingestBatch(batch([{ ...next, title: '未发布内容' }]))).rejects.toThrow('injected write failure'); }
      finally { transaction.mockRestore(); }
      expect((await repository.listWorks()).items[0]?.title).toBe('新批次作品');
      expect(reads()).toBe(1); expect(refreshes()).toBe(1);
    } finally { query.mockRestore(); }
  } finally { await database.close(); }
});

function liveWork(overrides: Partial<Work> = {}): Work {
  return {
    id: 'hongguo:9000000000000000011', sourceId: '9000000000000000011', platform: 'hongguo', kind: 'drama',
    title: '测试作品', author: null, description: '用于隔离测试', coverUrl: null,
    sourceUrl: 'https://www.hongguo.com/', tags: ['都市'], category: '都市', episodeCount: 80,
    wordCount: null, serialStatus: '已完结', publishedAt: null,
    metrics: [{ key: 'heat', label: '热度', value: null }], rank: 10, rankChange: null,
    board: '综合榜', origin: 'live', observedAt: date, sourceUpdatedAt: '11-13更新', ...overrides,
  };
}
function batch(works: Work[]): CollectionBatch {
  return { platform: 'hongguo', works, coverage: '综合榜第1页，非全平台', observedAt: works[0]!.observedAt };
}

describe('persistent library and observation history', () => {
  let database: PGlite;
  let repository: DataRepository;
  beforeAll(async () => {
    database = new PGlite();
    repository = new DataRepository(database);
    await repository.initialize({ seedDemo: false });
  }, 30_000);
  afterAll(async () => { await database.close(); });

  it('keeps long source IDs, unknown metrics, raw source dates and repeated batches', async () => {
    const payload = batch([liveWork()]);
    expect(await repository.ingestBatch(payload)).toBe(1);
    await repository.ingestBatch(payload);
    const detail = await repository.getWork(liveWork().id);
    expect(detail?.work.sourceId).toBe('9000000000000000011');
    expect(detail?.work.metrics[0]?.value).toBeNull();
    expect(detail?.work.sourceUpdatedAt).toBe('11-13更新');
    expect(detail?.work.rankChange).toBeNull();
    expect(detail?.observations).toHaveLength(1);
  });

  it('retains board-specific observations and compares rank only within one board', async () => {
    const next = '2026-11-14T02:00:00.000Z';
    await repository.ingestBatch(batch([
      liveWork({ rank: 7, observedAt: next }),
      liveWork({ rank: 2, board: 'AI榜', observedAt: next }),
    ]));
    const detail = await repository.getWork(liveWork().id);
    expect(detail?.work.board).toBe('综合榜');
    expect(detail?.work.rankChange).toBe(3);
    expect(detail?.observations.map(item => item.rank)).toEqual([10, 7]);
    const raw = await database.query<{ count: number }>('SELECT COUNT(*)::int AS count FROM observations WHERE work_id=$1', [liveWork().id]);
    expect(raw.rows[0]?.count).toBe(3);
    await repository.ingestBatch(batch([liveWork({ rank: 1, board: 'AI榜', observedAt: '2026-11-15T02:00:00.000Z' })]));
    expect((await repository.getWork(liveWork().id))?.work.rankChange).toBe(1);
  });

  it('refuses empty or mixed-origin batches without changing existing data', async () => {
    const before = await repository.listWorks();
    await expect(repository.ingestBatch({ ...batch([liveWork()]), works: [] })).rejects.toThrow();
    await expect(repository.ingestBatch(batch([liveWork({ origin: 'demo' })]))).rejects.toThrow();
    await expect(repository.ingestBatch(batch([liveWork({ platform: 'douyin' })]))).rejects.toThrow();
    expect((await repository.listWorks()).total).toBe(before.total);
  });

  it('preserves the latest observation when an older snapshot arrives', async () => {
    await repository.ingestBatch(batch([liveWork({ observedAt: '2026-11-01T02:00:00.000Z', rank: 90 })]));
    expect((await repository.getWork(liveWork().id))?.work.observedAt).toBe('2026-11-15T02:00:00.000Z');
  });

  it('recomputes the latest rank change after a missing middle snapshot arrives', async () => {
    const work = liveWork({ sourceId: '9000000000000000077', rank: 10, observedAt: '2026-11-10T02:00:00.000Z' });
    await repository.ingestBatch(batch([work]));
    await repository.ingestBatch(batch([{ ...work, rank: 5, observedAt: '2026-11-12T02:00:00.000Z' }]));
    await repository.ingestBatch(batch([{ ...work, rank: 6, observedAt: '2026-11-11T02:00:00.000Z' }]));
    const detail = await repository.getWork(`hongguo:${work.sourceId}`);
    expect(detail?.work.rank).toBe(5);
    expect(detail?.work.rankChange).toBe(1);
    expect(detail?.observations.map(item => item.rank)).toEqual([10, 6, 5]);
  });

  it('filters by platform, origin, category and title with stable pagination', async () => {
    await repository.ingestBatch(batch([liveWork({ sourceId: '2', title: '古风第二部', category: '古风' })]));
    const filtered = await repository.listWorks({ platform: 'hongguo', origin: 'live', q: '古风', category: '古风', page: 1, limit: 1 });
    expect(filtered.total).toBe(1);
    expect(filtered.items[0]?.sourceId).toBe('2');
    expect((await repository.listWorks({ page: 2, limit: 1 })).items).toHaveLength(1);
    expect((await repository.listWorks({ platform: 'fanqie' })).total).toBe(0);
  });

  it('stores selection notes and status independently from source records', async () => {
    expect(await repository.putSelection('missing', 'pending', '')).toBeNull();
    await repository.putSelection(liveWork().id, 'reviewing', '先观察题材变化');
    expect((await repository.selections())[0]?.selection.note).toBe('先观察题材变化');
    await repository.ingestBatch(batch([liveWork({ observedAt: '2026-11-16T02:00:00.000Z' })]));
    expect((await repository.getWork(liveWork().id))?.selection?.status).toBe('reviewing');
    await repository.deleteSelection(liveWork().id);
    expect(await repository.selections()).toHaveLength(0);
  });
});

describe('same-origin local preview API', () => {
  let database: PGlite;
  let repository: DataRepository;
  beforeAll(async () => {
    database = new PGlite(); repository = new DataRepository(database);
    await repository.initialize({ seedDemo: false });
    await repository.ingestBatch(batch([liveWork()]));
  }, 30_000);
  afterAll(async () => { await database.close(); });
  const origin = 'http://127.0.0.1:4317';
  const headers = { origin, 'content-type': 'application/json' };

  it('rejects DNS rebinding hosts, cross-origin reads and mutations without Origin', async () => {
    const { app } = createApp({ repository, collectHongguo: async () => batch([liveWork()]) });
    expect((await app.request('http://attacker.example:4317/api/works')).status).toBe(403);
    expect((await app.request(`${origin}/api/works`, { headers: { origin: 'https://evil.example' } })).status).toBe(403);
    expect((await app.request(`${origin}/api/selections/${liveWork().id}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{}' })).status).toBe(403);
    expect((await app.request(`${origin}/api/selections/${liveWork().id}`, { method: 'PUT', headers: { origin, 'content-type': 'text/plain' }, body: '{}' })).status).toBe(415);
  });

  it('validates filters, JSON, note limits and missing works', async () => {
    const { app } = createApp({ repository, collectHongguo: async () => batch([liveWork()]) });
    expect((await app.request(`${origin}/api/works?limit=-1`)).status).toBe(400);
    expect((await app.request(`${origin}/api/works?platform=unknown`)).status).toBe(400);
    expect((await app.request(`${origin}/api/works/missing`)).status).toBe(404);
    expect((await app.request(`${origin}/api/selections/${liveWork().id}`, { method: 'PUT', headers, body: '{bad' })).status).toBe(400);
    expect((await app.request(`${origin}/api/selections/${liveWork().id}`, { method: 'PUT', headers, body: JSON.stringify({ status: 'pending', note: 'a'.repeat(5_001) }) })).status).toBe(400);
    const saved = await app.request(`${origin}/api/selections/${liveWork().id}`, { method: 'PUT', headers, body: JSON.stringify({ status: 'selected', note: '计划讨论' }) });
    expect(saved.status).toBe(200);
    expect((await saved.json()).status).toBe('selected');
    expect((await app.request(`${origin}/api/selections/${liveWork().id}`, { method: 'DELETE', headers: { origin } })).status).toBe(200);
    expect((await repository.getWork(liveWork().id))?.selection).toBeNull();
    expect((await app.request(`${origin}/api/works`)).headers.get('X-Frame-Options')).toBe('DENY');
  });

  it('exports filtered metadata without allowing spreadsheet formulas', async () => {
    await repository.ingestBatch(batch([liveWork({ sourceId: 'formula', title: '=HYPERLINK("https://invalid.example")' })]));
    const { app } = createApp({ repository, collectHongguo: async () => batch([liveWork()]) });
    const response = await app.request(`${origin}/api/export?platform=hongguo&limit=1`);
    const csv = await response.text();
    expect(response.headers.get('content-type')).toContain('text/csv');
    expect(csv).toContain('"\'=HYPERLINK');
    expect(csv).toContain('"\'9000000000000000011"');
    expect(csv).toContain('未知');
  });

  it('allows only one concurrent collection and preserves successful data on failure', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>(resolve => { release = resolve; });
    let calls = 0;
    const { app, waitForCollections } = createApp({ repository, collectHongguo: async () => {
      calls++; await gate; throw new Error('HTTP 429');
    } });
    const before = (await repository.listWorks()).total;
    const requests = [0, 1, 2].map(() => app.request(`${origin}/api/collectors/hongguo/run`, { method: 'POST', headers, body: '{}' }));
    expect((await Promise.all(requests)).map(item => item.status).sort()).toEqual([202, 409, 409]);
    expect(calls).toBe(1);
    release(); await waitForCollections();
    expect((await repository.collectors()).find(item => item.platform === 'hongguo')?.state).toBe('failed');
    expect((await repository.listWorks()).total).toBe(before);
  });

  it('publishes accurate coverage only after a successful atomic import', async () => {
    const { app, waitForCollections } = createApp({ repository, collectHongguo: async () => batch([liveWork({ observedAt: '2026-11-17T02:00:00.000Z' })]) });
    expect((await app.request(`${origin}/api/collectors/hongguo/run`, { method: 'POST', headers, body: '{}' })).status).toBe(202);
    await waitForCollections();
    const status = (await repository.collectors()).find(item => item.platform === 'hongguo');
    expect(status?.state).toBe('success');
    expect(status?.coverage).toBe('综合榜第1页，非全平台');
    expect(status?.count).toBe(1);
    expect(status?.lastSuccessAt).toBe('2026-11-17T02:00:00.000Z');
  });
});

describe('preview persistence and filesystem isolation', () => {
  it('refuses a second database owner until the original preview exits', async () => {
    const root = await mkdtemp(join(tmpdir(), 'muse-data-lock-'));
    try {
      const release = await acquireDatabaseLock(join(root, 'preview'));
      await expect(acquireDatabaseLock(join(root, 'preview'))).rejects.toThrow('启动锁');
      await release();
      const nextRelease = await acquireDatabaseLock(join(root, 'preview'));
      await nextRelease();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it('reopens stored selections without reseeding and labels all fictional works', async () => {
    const root = await mkdtemp(join(tmpdir(), 'muse-data-store-'));
    let database = new PGlite(join(root, 'database'));
    try {
      let repository = new DataRepository(database);
      await repository.initialize();
      const initial = await repository.dashboard();
      expect(initial.totalWorks).toBe(40);
      expect(initial.liveWorks).toBe(0);
      expect(initial.demoWorks).toBe(40);
      expect((await repository.getWork('demo-qimao-1'))?.work.metrics[0]?.value).toBeNull();
      expect((await repository.getWork('demo-hongguo-1'))?.observations).toHaveLength(7);
      await repository.putSelection('demo-hongguo-1', 'pending', '持久保存');
      await database.close();
      database = new PGlite(join(root, 'database'));
      repository = new DataRepository(database);
      await repository.initialize();
      expect((await repository.selections())[0]?.selection.note).toBe('持久保存');
      expect((await repository.listWorks()).total).toBe(40);
    } finally {
      await database.close();
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  it('rejects public binding, external database paths and symlinked data roots', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'muse-data-config-')));
    const outside = await mkdtemp(join(tmpdir(), 'muse-data-outside-'));
    try {
      expect(() => resolveConfig({ MUSE_DATA_HOST: '0.0.0.0' }, root)).toThrow();
      expect(() => resolveConfig({ MUSE_DATA_MODE: 'production' }, root)).toThrow();
      expect(() => resolveConfig({ MUSE_DATA_DIRECTORY: outside }, root)).toThrow();
      expect(() => resolveConfig({ MUSE_DATA_DIRECTORY: join(root, '.data', 'production') }, root)).toThrow();
      await mkdir(join(root, '.data'));
      await symlink(outside, join(root, '.data', 'linked'));
      expect(() => resolveConfig({ MUSE_DATA_DIRECTORY: join(root, '.data', 'linked', 'preview') }, root)).toThrow();
      const configured = resolveConfig({}, root);
      expect(configured.hostname).toBe('127.0.0.1');
      expect(configured.port).toBe(4317);
      expect(configured.dataDirectory).toBe(join(root, '.data', 'preview'));
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });
});

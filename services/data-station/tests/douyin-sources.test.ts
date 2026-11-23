import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { DataRepository } from '../src/server/repository.ts';
import { createApp } from '../src/server/app.ts';
import { CollectionManager } from '../src/server/collection-manager.ts';
import { DouyinSourceStore, normalizeDouyinVideoId, parseDouyinSourceInput, verifyDouyinSource } from '../src/server/douyin-source-store.ts';
import { collectDouyin, DouyinCollectionError } from '../src/server/collectors/douyin.ts';
import { MAX_DOUYIN_SOURCES } from '../src/shared/douyin-sources.ts';
import type { DouyinSourceInput, DouyinSourceValidation, ManagedDouyinSource, Work } from '../src/shared/types.ts';

const base = 'http://127.0.0.1:4317';
const date = '2026-11-13T10:00:00.000Z';
const input: DouyinSourceInput = { label: '新来源', videoId: '7706738013220539657', mode: 'creator', expectedAuthor: '创作者', includeKeywords: ['剧情'], excludeKeywords: ['教程'], enabled: true, maxVideos: 8 };
const validation: DouyinSourceValidation = { author: '创作者', authorId: '12345', count: 1, works: [{ sourceId: '7706738013220539658', title: '剧情第1集', sourceUrl: 'https://jingxuan.douyin.com/m/video/7706738013220539658', publishedAt: '2025-11-01T00:00:00.000Z' }], coverage: '隔离验证样本，不是全站', observedAt: date };

describe('persistent public Douyin source management', () => {
  let database: PGlite;
  let repository: DataRepository;
  let store: DouyinSourceStore;
  const verify = vi.fn<(value: DouyinSourceInput) => Promise<DouyinSourceValidation>>();
  let tick = 0;
  beforeAll(async () => { database = new PGlite(); repository = new DataRepository(database); await repository.initialize({ seedDemo: false }); });
  beforeEach(async () => {
    await database.exec("DELETE FROM data_settings WHERE key='douyin_public_sources_v1'; DELETE FROM observations; DELETE FROM works;");
    verify.mockReset().mockResolvedValue(validation);
    store = new DouyinSourceStore(database, verify, () => new Date(Date.parse(date) + tick++));
  });
  afterAll(async () => { await database.close(); });

  const app = () => createApp({ repository, douyinSources: store, identity: async request => {
    const user = request.headers.get('x-test-user');
    return user ? { id: user, name: user, role: user === 'admin' ? 'admin' : 'member' } : null;
  } }).app;
  const request = (path: string, user: string | null = 'admin', method = 'GET', body?: unknown, revision?: string) => app().request(base + path, {
    method, headers: { ...(user ? { 'x-test-user': user } : {}), ...(method === 'PUT' ? { 'if-match': revision ?? date } : {}), ...(method === 'GET' ? {} : { origin: base, 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

  it('initializes screened creators and individual compilations without replacing saved choices', async () => {
    const sources = await store.list();
    expect(sources).toHaveLength(17);
    expect(new Set(sources.map(source => source.id)).size).toBe(sources.length);
    expect(sources.every(source => source.enabled)).toBe(true);
    expect(sources.filter(source => source.mode === 'creator').every(source => source.expectedAuthorId)).toBe(true);
    expect(sources.filter(source => source.mode === 'video').map(source => source.expectedAuthor)).toEqual(['AIGC KK', '胡久AIGC', 'Fel', '悉尼年糕剧场']);
    expect(sources.filter(source => source.expectedAuthor === 'Fel').map(source => source.mode)).toEqual(['creator', 'video']);
    expect(sources.map(source => source.expectedAuthor)).toEqual(expect.arrayContaining(['屿竹影像', '小导牛敢', '似翁', 'Fel', '姜十七', '云笺AI剧场']));
    expect(sources.some(source => source.expectedAuthor === '她见四季')).toBe(false);
    expect(sources.some(source => ['陈翔六点半', '七颗猩猩'].includes(source.expectedAuthor))).toBe(false);
    expect(await new DouyinSourceStore(database, verify).list()).toEqual(sources);
  });

  it('preserves all-disabled and empty settings across a new store instance', async () => {
    for (const source of await store.list()) await store.save(draft(source, { enabled: false }), source.id);
    const reopened = new DouyinSourceStore(database, verify);
    expect((await reopened.list()).every(source => !source.enabled)).toBe(true);
    await expect(reopened.active()).rejects.toThrow(/没有启用/);
    for (const source of await reopened.list()) await reopened.remove(source.id);
    expect(await new DouyinSourceStore(database, verify).list()).toEqual([]);
    expect(verify).not.toHaveBeenCalled();
  });

  it('binds a new source identity and persists changes without importing validation works', async () => {
    const created = await store.save({ ...input, videoId: `https://www.douyin.com/video/${input.videoId}?from=share` });
    expect(created).toMatchObject({ videoId: input.videoId, expectedAuthorId: '12345', validatedAt: date });
    expect((await repository.listWorks({ platform: 'douyin' })).items).toEqual([]);
    expect(verify).toHaveBeenCalledWith(input);
    await store.save(draft(created, { enabled: false, label: '暂停中的来源', maxVideos: 2 }), created.id);
    expect(verify).toHaveBeenCalledTimes(1);
    const reopened = new DouyinSourceStore(database, verify);
    expect((await reopened.list()).find(source => source.id === created.id)).toMatchObject({ enabled: false, label: '暂停中的来源', maxVideos: 2 });
    expect(await reopened.remove(created.id)).toBe(true);
    expect(await reopened.remove(created.id)).toBe(false);
  });

  it('does not save failed verification and does not mutate choices during read-only validation', async () => {
    const before = await store.list();
    expect(await store.validate(input)).toEqual(validation);
    expect(await store.list()).toEqual(before);
    verify.mockRejectedValueOnce(new DouyinCollectionError('作者不匹配'));
    await expect(store.save(input)).rejects.toThrow(/作者不匹配/);
    expect(await store.list()).toEqual(before);
  });

  it('keeps source settings and validation administrator-only', async () => {
    for (const [path, method, body] of [
      ['/api/admin/douyin/sources', 'GET', undefined], ['/api/admin/douyin/sources', 'POST', input],
      ['/api/admin/douyin/sources/validate', 'POST', input], ['/api/admin/douyin/sources/missing', 'PUT', input],
      ['/api/admin/douyin/sources/missing', 'PATCH', { enabled: false }],
      ['/api/admin/douyin/sources/missing', 'DELETE', undefined],
    ] as const) {
      expect((await request(path, null, method, body)).status).toBe(401);
      expect((await request(path, 'member', method, body)).status).toBe(403);
    }
    expect(verify).not.toHaveBeenCalled();
    expect((await request('/api/admin/douyin/sources')).status).toBe(200);
  });

  it('exposes CRUD, read-only validation and actionable failures through the real API', async () => {
    expect((await request('/api/admin/douyin/sources/validate', 'admin', 'POST', input)).status).toBe(200);
    const response = await request('/api/admin/douyin/sources', 'admin', 'POST', input);
    expect(response.status).toBe(201);
    const saved = await response.json() as ManagedDouyinSource;
    expect((await request(`/api/admin/douyin/sources/${saved.id}`, 'admin', 'PUT', draft(saved, { enabled: false }), saved.updatedAt)).status).toBe(200);
    expect((await request('/api/admin/douyin/sources', 'admin', 'POST', input)).status).toBe(409);
    expect((await request('/api/admin/douyin/sources/missing', 'admin', 'PUT', input)).status).toBe(404);
    verify.mockRejectedValueOnce(new DouyinCollectionError('来源要求验证'));
    expect((await request('/api/admin/douyin/sources/validate', 'admin', 'POST', input)).status).toBe(422);
    expect((await request('/api/admin/douyin/sources', 'admin', 'POST', { ...input, videoId: 7706738013220539657 })).status).toBe(400);
    expect((await request(`/api/admin/douyin/sources/${saved.id}`, 'admin', 'DELETE')).status).toBe(200);
    expect((await request(`/api/admin/douyin/sources/${saved.id}`, 'admin', 'DELETE')).status).toBe(404);
  });

  it('changes only enabled on a stale-page toggle and rejects stale full edits', async () => {
    const original = (await store.list())[0]!;
    const edited = await store.save(draft(original, { maxVideos: 2, label: '新标签' }), original.id, original.updatedAt);
    const toggled = await store.setEnabled(original.id, false);
    expect(toggled).toMatchObject({ maxVideos: 2, label: '新标签', enabled: false });
    expect(Date.parse(toggled.updatedAt)).toBeGreaterThan(Date.parse(edited.updatedAt));
    expect((await request(`/api/admin/douyin/sources/${original.id}`, 'admin', 'PUT', draft(original), original.updatedAt)).status).toBe(409);
    expect((await request(`/api/admin/douyin/sources/${original.id}`, 'admin', 'PATCH', { enabled: true, maxVideos: 8 })).status).toBe(400);
    expect((await request(`/api/admin/douyin/sources/${original.id}`, 'admin', 'PATCH', { enabled: true })).status).toBe(200);
    expect((await store.list()).find(source => source.id === original.id)).toMatchObject({ maxVideos: 2, enabled: true });
  });

  it('rejects unsupported URLs and malformed limits before verification', async () => {
    for (const videoId of ['http://127.0.0.1/video/7706738013220539657', 'https://www.douyin.com.evil.example/video/7706738013220539657', 'https://user:password@www.douyin.com/video/7706738013220539657', 'https://v.douyin.com/abc/', '123', 'https://www.douyin.com:4433/video/7706738013220539657']) {
      await expect(store.save({ ...input, videoId })).rejects.toThrow();
    }
    for (const maxVideos of [0, 21, 1.5, '8']) await expect(store.save({ ...input, maxVideos })).rejects.toThrow();
    await expect(store.save({ ...input, includeKeywords: [''] })).rejects.toThrow();
    expect(verify).not.toHaveBeenCalled();
    expect(normalizeDouyinVideoId(`https://jingxuan.douyin.com/m/video/${input.videoId}`)).toBe(input.videoId);
    expect(parseDouyinSourceInput({ ...input, includeKeywords: [' 剧情 ', '剧情'] }).includeKeywords).toEqual(['剧情']);
  });

  it('bounds source count and fails invalid saved settings rather than restoring defaults', async () => {
    const remaining = MAX_DOUYIN_SOURCES - (await store.list()).length;
    for (let n = 0; n < remaining; n++) await store.save({ ...input, videoId: String(7_706_738_013_220_539_657n + BigInt(n)) });
    await expect(store.save({ ...input, videoId: '7707485490567548160' })).rejects.toThrow(/最多保存 32/);
    await database.query("UPDATE data_settings SET value='{}'::jsonb WHERE key='douyin_public_sources_v1'");
    await expect(new DouyinSourceStore(database, verify).list()).rejects.toThrow(/Invalid saved/);
  });

  it('uses the latest enabled-source snapshot for each attempt and preserves previous data on failure', async () => {
    for (const source of await store.list()) await store.remove(source.id);
    const source = await store.save(input);
    const seen: string[][] = [];
    const work = videoWork('7706738013220539658', 50);
    const manager = new CollectionManager(repository, { douyin: async () => {
      const active = await store.active(); seen.push(active.map(item => item.id));
      return { platform: 'douyin', works: [work], observedAt: work.observedAt, coverage: '单条样本' };
    } });
    await manager.initialize();
    await manager.request('douyin'); await manager.waitForIdle();
    await store.save(draft(source, { enabled: false }), source.id);
    await manager.request('douyin'); await manager.waitForIdle();
    expect(seen).toEqual([[source.id]]);
    expect((await repository.collectors()).find(status => status.platform === 'douyin')).toMatchObject({ state: 'failed', count: 1 });
    expect((await repository.listWorks({ platform: 'douyin' })).items[0]?.sourceId).toBe(work.sourceId);
    await manager.stop();
  });

  it('orders only observed selected-page play counts without assigning platform ranks', async () => {
    const works = [videoWork('7706738013220539657', null), videoWork('7706738013220539658', 0), videoWork('7706738013220539659', 900), videoWork('7706738013220539660', 100)];
    works[0]!.metrics.push({ key: 'dtk_plays', label: '其他来源播放', value: 999_999 });
    await repository.ingestBatch({ platform: 'douyin', works, coverage: '隔离排序用例', observedAt: date });
    const result = await repository.listWorks({ platform: 'douyin', sort: 'plays' });
    expect(result.items.map(work => work.metrics[0]?.value)).toEqual([900, 100, 0, null]);
    expect(result.items.every(work => work.rank === null && work.rankChange === null)).toBe(true);
    expect((await request('/api/works?platform=hongguo&sort=plays')).status).toBe(400);
    expect((await request('/api/export?platform=douyin&sort=plays')).status).toBe(200);
  });
});

function draft(source: ManagedDouyinSource, overrides: Partial<DouyinSourceInput> = {}): DouyinSourceInput {
  return { label: source.label, videoId: source.videoId, mode: source.mode, expectedAuthor: source.expectedAuthor,
    includeKeywords: source.includeKeywords, excludeKeywords: source.excludeKeywords, enabled: source.enabled, maxVideos: source.maxVideos, ...overrides };
}

function videoWork(id: string, plays: number | null): Work {
  return { id: `douyin:${id}`, sourceId: id, platform: 'douyin', kind: 'drama', title: `剧情 ${id}`, author: '创作者',
    description: '单条剧情视频，非整剧', sourceUrl: `https://jingxuan.douyin.com/m/video/${id}`, coverUrl: null, tags: ['单条视频'], category: '剧情',
    episodeCount: null, wordCount: null, serialStatus: null, publishedAt: '2025-11-01T00:00:00.000Z',
    metrics: [{ key: 'video_plays', label: '精选页播放', value: plays }], board: '公开视频监测，非榜单', rank: null, rankChange: null,
    origin: 'live', observedAt: date, sourceUpdatedAt: null };
}

it('verifies a creator sample without requiring an entered author name', async () => {
  const response = (id: string, candidates: boolean) => new Response(`<script>window._SSR_DATA = ${JSON.stringify({ data: { storeState: {
    detail: { videoData: { result: { gid: id, title: '剧情第一集', media_user: { screen_name: '实际作者', id: 55 }, play_count: 100, digg_count: 2 } } },
    'user-page': { videoList: { result: candidates ? [{ gid: '7706738013220539658', title: '剧情第一集' }] : [] } },
  } } })}</script>`, { headers: { 'content-type': 'text/html' } });
  const fetchPage = vi.fn<typeof fetch>().mockResolvedValueOnce(response(input.videoId, true)).mockResolvedValueOnce(response('7706738013220539658', false));
  expect(await verifyDouyinSource({ ...input, expectedAuthor: '' }, { fetch: fetchPage, requestIntervalMs: 0 })).toMatchObject({ author: '实际作者', authorId: '55', count: 1 });
  expect(fetchPage).toHaveBeenCalledTimes(2);
  await expect(collectDouyin({ sources: Array.from({ length: 33 }, () => ({ ...input })), fetch: fetchPage })).rejects.toThrow(/sources/);
});

it('retains an explicitly empty source list after closing and reopening the on-disk database', async () => {
  await mkdir(resolve('.data'), { recursive: true });
  const directory = await mkdtemp(resolve('.data', 'douyin-source-restart-'));
  let database = new PGlite(directory);
  try {
    let repository = new DataRepository(database);
    await repository.initialize({ seedDemo: false });
    const store = new DouyinSourceStore(database);
    for (const source of await store.list()) await store.remove(source.id);
    await database.close();
    database = new PGlite(directory);
    repository = new DataRepository(database);
    await repository.initialize({ seedDemo: false });
    const reopened = new DouyinSourceStore(database);
    await reopened.initialize();
    expect(await reopened.list()).toEqual([]);
    await expect(reopened.active()).rejects.toThrow(/没有启用/);
  } finally { await database.close(); await rm(directory, { recursive: true, force: true }); }
});

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { DataRepository } from '../src/server/repository.ts';
import { createApp } from '../src/server/app.ts';
import { CatalogDisplayCache } from '../src/client/catalog-display-cache.ts';
import { parsePageBootstrap, seedDisplayCache } from '../src/client/page-bootstrap.ts';
import { boardDaysQuery, periodQuery } from '../src/client/board-queries.ts';
import { PAGE_BOOTSTRAP_ELEMENT, type PageBootstrap, type Platform, type Work } from '../src/shared/types.ts';

const host = 'http://127.0.0.1:4317';
const hot = '综合热播榜';
const bj = (local: string) => new Date(`${local.replace(' ', 'T')}:00.000+08:00`).toISOString();

function work(platform: Platform, sourceId: string, board: string, rank: number | null, observedAt: string, title = `首屏作品${sourceId.slice(-2)}`): Work {
  return {
    id: `${platform}:${sourceId}`, sourceId, platform, kind: platform === 'hongguo' ? 'drama' : 'novel', title, author: null,
    description: '首屏数据测试', coverUrl: null, sourceUrl: 'https://example.com/work', tags: [], category: '都市',
    episodeCount: null, wordCount: null, serialStatus: null, publishedAt: null, metrics: [{ key: 'heat', label: '热度', value: rank }],
    rank, rankChange: null, board, origin: 'live', observedAt, sourceUpdatedAt: null,
  };
}

class MemoryStorage {
  values = new Map<string, string>();
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  setItem(key: string, value: string): void { this.values.set(key, value); }
  removeItem(key: string): void { this.values.delete(key); }
}

/** Extracts and parses the embedded first-screen element of a served page. */
function embedded(html: string): PageBootstrap | null {
  const match = new RegExp(`<script type="application/json" id="${PAGE_BOOTSTRAP_ELEMENT}">(.*?)</script>`, 's').exec(html);
  return match ? JSON.parse(match[1]!) as PageBootstrap : null;
}

describe('first-screen page data', () => {
  let directory: string, staticRoot: string;
  let database: PGlite, repository: DataRepository;
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'muse-data-first-screen-'));
    staticRoot = join(directory, 'static');
    await mkdir(join(staticRoot, 'assets'), { recursive: true });
    await writeFile(join(staticRoot, 'index.html'), '<!doctype html><html><head><title>Muse data</title></head><body><div id="root"></div></body></html>');
    await writeFile(join(staticRoot, 'assets', 'index-abc123.js'), `export const value = "${'x'.repeat(4096)}";\n`);
    database = new PGlite();
    repository = new DataRepository(database);
    await repository.initialize({ seedDemo: false });
  }, 30_000);
  afterAll(async () => { await database.close(); await rm(directory, { recursive: true, force: true }); });

  it('serves the page without board data while the default platform has none', async () => {
    const { app } = createApp({ repository, staticRoot });
    const data = embedded(await (await app.request(`${host}/`)).text());
    expect(data).toMatchObject({ session: { id: 'local-preview', role: 'admin', mode: 'local-preview' }, platform: 'hongguo', directory: null, period: null, days: null });
  });

  it('embeds the latest day of the default board with its day list, script fields and escaped text', async () => {
    const title = '</script><script>alert(1)</script>';
    await repository.ingestBatch({ platform: 'hongguo', observedAt: bj('2026-11-12 22:00'), coverage: '首屏测试',
      works: [work('hongguo', '9300000000000000001', hot, 1, bj('2026-11-12 22:00')), work('hongguo', '9300000000000000002', hot, 2, bj('2026-11-12 22:00'))] });
    await repository.ingestBatch({ platform: 'hongguo', observedAt: bj('2026-11-13 21:00'), coverage: '首屏测试',
      works: [work('hongguo', '9300000000000000002', hot, 1, bj('2026-11-13 21:00'), title), work('hongguo', '9300000000000000001', hot, 2, bj('2026-11-13 21:00'))] });
    await repository.ingestBatch({ platform: 'hongguo', observedAt: bj('2026-11-13 21:05'), coverage: '首屏测试',
      works: [work('hongguo', '9300000000000000003', '综合新剧榜', 1, bj('2026-11-13 21:05'))] });
    const { app } = createApp({ repository, staticRoot });
    const html = await (await app.request(`${host}/`)).text();
    expect(html).not.toContain('</script><script>alert(1)');
    const data = embedded(html)!;
    expect(data.directory).toEqual({ boards: expect.arrayContaining([hot, '综合新剧榜']), defaultBoard: hot });
    expect(data.period).toMatchObject({ platform: 'hongguo', board: hot, period: 'day', date: '2026-11-13', previous: { date: '2026-11-12' } });
    expect(data.period!.items.map(item => [item.work.title, item.position, item.work.rankChange, item.work.script])).toEqual([[title, 1, 1, null], ['首屏作品01', 2, -1, null]]);
    expect(data.days!.days.map(day => day.date)).toEqual(['2026-11-13', '2026-11-12']);
    const period = await (await app.request(`${host}/api/boards/period?${new URLSearchParams({ platform: 'hongguo', board: hot })}`)).json();
    expect(period).toEqual(data.period);
  });

  it('compresses pages and data, keeps hashed assets cached and leaves file downloads uncompressed', async () => {
    const { app } = createApp({ repository, staticRoot });
    const gzip = { 'accept-encoding': 'gzip' };
    const asset = await app.request(`${host}/assets/index-abc123.js`, { headers: gzip });
    expect(asset.headers.get('content-encoding')).toBe('gzip');
    expect(asset.headers.get('cache-control')).toBe('private, max-age=31536000, immutable');
    expect(gunzipSync(Buffer.from(await asset.arrayBuffer())).toString()).toContain('export const value');
    const page = await app.request(`${host}/`, { headers: gzip });
    expect(page.headers.get('cache-control')).toBe('no-store');
    expect(page.headers.get('content-encoding')).toBe('gzip');
    const missing = await app.request(`${host}/assets/index-gone.js`);
    expect(missing.headers.get('cache-control')).toBe('no-store');
    const period = await app.request(`${host}/api/boards/period?${new URLSearchParams({ platform: 'hongguo', board: hot })}`, { headers: gzip });
    expect(period.headers.get('content-encoding')).toBe('gzip');
    const exported = await app.request(`${host}/api/export?${new URLSearchParams({ platform: 'hongguo', board: hot, origin: 'live' })}`, { headers: gzip });
    expect(exported.status).toBe(200);
    expect(exported.headers.get('content-encoding')).toBeNull();
  });

  it('seeds a display cache so the embedded board needs no request, and ignores malformed data', async () => {
    const { app } = createApp({ repository, staticRoot });
    const text = /<script type="application\/json" id="muse-data-bootstrap">(.*?)<\/script>/s.exec(await (await app.request(`${host}/`)).text())![1]!;
    const data = parsePageBootstrap(text)!;
    const cache = new CatalogDisplayCache(new MemoryStorage(), 'http://127.0.0.1:4318', data.session);
    seedDisplayCache(cache, data, 0);
    expect(cache.directory('hongguo')?.value.defaultBoard).toBe(hot);
    expect(cache.period(periodQuery('hongguo', hot, 'day', ''))).toMatchObject({ version: 0, value: { date: '2026-11-13' } });
    expect(cache.period(periodQuery('hongguo', hot, 'day', '2026-11-13'))?.version).toBe(0);
    expect(cache.boardDays(boardDaysQuery('hongguo', hot))?.version).toBe(0);
    expect(parsePageBootstrap('{')).toBeNull();
    expect(parsePageBootstrap(JSON.stringify({ ...data, session: { ...data.session, role: 'owner' } }))).toBeNull();
    const empty = new CatalogDisplayCache(new MemoryStorage(), 'http://127.0.0.1:4318', data.session);
    seedDisplayCache(empty, { ...data, days: null }, 0);
    expect(empty.period(periodQuery('hongguo', hot, 'day', ''))).toBeNull();
  });
});

describe('cached board periods', () => {
  let database: PGlite, repository: DataRepository;
  const scope = { platform: 'hongguo' as const, board: hot, origin: 'live' as const };
  beforeAll(async () => {
    database = new PGlite();
    repository = new DataRepository(database);
    await repository.initialize({ seedDemo: false });
    await repository.ingestBatch({ platform: 'hongguo', observedAt: bj('2026-11-12 22:00'), coverage: '缓存测试',
      works: [work('hongguo', '9400000000000000001', hot, 1, bj('2026-11-12 22:00')), work('hongguo', '9400000000000000002', hot, 2, bj('2026-11-12 22:00'))] });
  }, 30_000);
  afterAll(async () => { await database.close(); });

  it('reuses a view until its board gains a collection or a listed work changes', async () => {
    const first = await repository.boardPeriod({ ...scope, period: 'day' });
    const days = await repository.boardDays(scope);
    expect(await repository.boardPeriod({ ...scope, period: 'day' })).toBe(first);
    await repository.ingestBatch({ platform: 'hongguo', observedAt: bj('2026-11-13 09:00'), coverage: '缓存测试',
      works: [work('hongguo', '9400000000000000009', '综合新剧榜', 1, bj('2026-11-13 09:00'))] });
    expect(await repository.boardPeriod({ ...scope, period: 'day' })).toBe(first);
    expect(await repository.boardDays(scope)).toBe(days);
    await repository.ingestDiscoveryPage({ platform: 'hongguo', observedAt: bj('2026-11-13 10:00'), coverage: '缓存测试',
      works: [work('hongguo', '9400000000000000002', '', null, bj('2026-11-13 10:00'))] }, async () => {});
    const rechecked = await repository.boardPeriod({ ...scope, period: 'day' });
    expect(rechecked).not.toBe(first);
    expect(rechecked).toEqual(first);
    await repository.ingestBatch({ platform: 'hongguo', observedAt: bj('2026-11-13 11:00'), coverage: '缓存测试',
      works: [work('hongguo', '9400000000000000001', '综合新剧榜', 2, bj('2026-11-13 11:00'), '新剧榜上的新标题')] });
    const renamed = await repository.boardPeriod({ ...scope, period: 'day' });
    expect(renamed!.items.map(item => item.work.title)).toContain('新剧榜上的新标题');
    expect(await repository.boardDays(scope)).toBe(days);
    await repository.ingestBatch({ platform: 'hongguo', observedAt: bj('2026-11-13 22:00'), coverage: '缓存测试',
      works: [work('hongguo', '9400000000000000002', hot, 1, bj('2026-11-13 22:00'))] });
    const latest = await repository.boardPeriod({ ...scope, period: 'day' });
    expect(latest).toMatchObject({ date: '2026-11-13', previous: { date: '2026-11-12' } });
    expect((await repository.boardDays(scope)).days.map(day => day.date)).toEqual(['2026-11-13', '2026-11-12']);
  });
});

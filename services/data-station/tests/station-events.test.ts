import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { chmod, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DataRepository } from '../src/server/repository.ts';
import { resolveHitRules } from '../src/server/hits/rules.ts';
import { HitStore } from '../src/server/hits/store.ts';
import { loadEventSecret, signDelivery, StationEventSender, urgent, type StationEvent } from '../src/server/hits/station-events.ts';
import type { Work } from '../src/shared/types.ts';

const MINUTE = 60_000;
const T0 = Date.parse('2026-11-21T00:00:00.000Z');
const SECRET = 'k'.repeat(48);
const sid = (n: number) => `76000000000000000${String(n).padStart(2, '0')}`;
const wid = (n: number) => `hongguo:${sid(n)}`;

function drama(n: number): Work {
  return { id: wid(n), sourceId: sid(n), platform: 'hongguo', kind: 'drama', title: `种田逆袭记${n}`, author: null, description: '乡村姑娘种田致富。',
    coverUrl: null, sourceUrl: `https://hongguoduanju.com/detail?series_id=${sid(n)}`, tags: ['种田'], category: '', episodeCount: 60, wordCount: null,
    serialStatus: null, publishedAt: null, metrics: [{ key: 'collection', label: '收藏', value: 500_000 }], rank: n, rankChange: null, board: '综合热播榜',
    origin: 'live', observedAt: new Date(T0).toISOString(), sourceUpdatedAt: null };
}

type Delivery = { url: string; headers: Headers; body: string };

describe('储备 push to the cloud main Bot', () => {
  let database: PGlite, store: HitStore, now: number, deliveries: Delivery[], status: number;
  const sender = () => new StationEventSender(database, { url: new URL('http://bot.test/api/muse/station-events'), secret: SECRET, batchMs: 5 * MINUTE, pollMs: 15_000,
    now: () => now, fetcher: async (input, init) => {
      deliveries.push({ url: String(input), headers: new Headers(init?.headers), body: String(init?.body) });
      if (status === 0) throw new TypeError('fetch failed');
      return new Response(null, { status });
    } });

  beforeEach(async () => {
    database = new PGlite();
    const repository = new DataRepository(database);
    await repository.initialize({ seedDemo: false });
    await repository.ingestBatch({ platform: 'hongguo', works: [drama(1), drama(2), drama(3)], observedAt: new Date(T0).toISOString(), coverage: '测试' });
    now = T0;
    store = new HitStore(database, resolveHitRules({ queue: { leaseMinutes: 10, maxAttempts: 2 } }), () => now);
    await store.initialize();
    deliveries = [];
    status = 202;
  });
  afterEach(async () => { await database.close(); });

  it('starts after the newest event, so history from before the Bot was connected is not replayed', async () => {
    await store.enqueue(wid(1), { lane: 'new', qualifiedAt: new Date(T0).toISOString(), priority: 1 });
    const push = sender();
    await push.initialize();
    await push.initialize();
    expect(await push.flush(true)).toBe(0);
    expect(deliveries).toEqual([]);
  });

  it('holds ordinary changes for the batch window and sends 立即转写 at once, signed and titled', async () => {
    const push = sender();
    await push.initialize();
    await store.enqueue(wid(1), { lane: 'new', qualifiedAt: new Date(T0).toISOString(), priority: 1 });
    expect(await push.flush()).toBe(0);
    now = T0 + MINUTE;
    await store.rush(wid(2), '成员甲', { qualifiedAt: null, priority: null });
    expect(await push.flush()).toBe(2);
    const [delivery] = deliveries;
    expect(delivery?.url).toBe('http://bot.test/api/muse/station-events');
    const timestamp = delivery!.headers.get('x-muse-station-timestamp')!;
    expect(delivery!.headers.get('x-muse-station-signature')).toBe(signDelivery(SECRET, timestamp, delivery!.body));
    const sent = JSON.parse(delivery!.body) as { deliveryId: string; events: StationEvent[] };
    expect(sent.events.map(event => [event.workId, event.title, event.to, event.actor, event.note])).toEqual([
      [wid(1), '种田逆袭记1', 'queued', 'selection', '新上榜作品入选'],
      [wid(2), '种田逆袭记2', 'queued', '成员甲', '立即转写'],
    ]);
    expect(sent.deliveryId).toBe(`${sent.events[0]!.id}-${sent.events[1]!.id}`);
    expect(await push.flush(true)).toBe(0);
  });

  it('sends ordinary changes once the oldest has waited the batch window', async () => {
    const push = sender();
    await push.initialize();
    await store.enqueue(wid(3), { lane: 'backlog', qualifiedAt: new Date(T0).toISOString(), priority: 1 });
    now = T0 + 4 * MINUTE;
    expect(await push.flush()).toBe(0);
    now = T0 + 5 * MINUTE;
    expect(await push.flush()).toBe(1);
  });

  it('keeps the cursor when the Bot refuses or is unreachable, and sends the same changes again', async () => {
    const push = sender();
    await push.initialize();
    await store.rush(wid(1), '成员甲', { qualifiedAt: null, priority: null });
    status = 503;
    expect(await push.flush()).toBe(0);
    status = 0;
    expect(await push.flush()).toBe(0);
    status = 202;
    expect(await push.flush()).toBe(1);
    expect(new Set(deliveries.map(delivery => (JSON.parse(delivery.body) as { deliveryId: string }).deliveryId)).size).toBe(1);
  });

  it('checks on a timer until stopped', async () => {
    const push = new StationEventSender(database, { url: new URL('http://bot.test/x'), secret: SECRET, batchMs: MINUTE, pollMs: 5,
      fetcher: async (input, init) => { deliveries.push({ url: String(input), headers: new Headers(init?.headers), body: String(init?.body) }); return new Response(null, { status: 200 }); } });
    await push.initialize();
    await store.rush(wid(1), '成员甲', { qualifiedAt: null, priority: null });
    push.start();
    push.start();
    await expect.poll(() => deliveries.length, { timeout: 2_000 }).toBe(1);
    await push.stop();
    push.start();
    await store.rush(wid(2), '成员甲', { qualifiedAt: null, priority: null });
    await new Promise(done => setTimeout(done, 50));
    expect(deliveries).toHaveLength(1);
  });

  it('treats 立即转写 and failures as urgent', () => {
    expect(urgent({ to: 'queued', note: '立即转写' })).toBe(true);
    expect(urgent({ to: 'needs-attention', note: '下载失败' })).toBe(true);
    expect(urgent({ to: 'failed', note: null })).toBe(true);
    expect(urgent({ to: 'queued', note: '新上榜作品入选' })).toBe(false);
    expect(urgent({ to: 'published', note: '剧本 s1' })).toBe(false);
  });
});

describe('储备 push secret file', () => {
  let directory: string;
  // macOS tmpdir() sits behind a symbolic link; the loader refuses linked paths, so the test uses the real one.
  beforeEach(async () => { directory = await realpath(await mkdtemp(join(tmpdir(), 'station-events-'))); });
  afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

  it('reads a private file and refuses loose permissions, short secrets, links and relative paths', async () => {
    const file = join(directory, 'secret');
    await writeFile(file, `${SECRET}\n`, { mode: 0o600 });
    expect(await loadEventSecret(file)).toBe(SECRET);
    await chmod(file, 0o644);
    await expect(loadEventSecret(file)).rejects.toThrow('MUSE_DATA_STATION_EVENTS_SECRET_FILE');
    const short = join(directory, 'short');
    await writeFile(short, 'too short', { mode: 0o600 });
    await expect(loadEventSecret(short)).rejects.toThrow('MUSE_DATA_STATION_EVENTS_SECRET_FILE');
    await chmod(file, 0o600);
    const link = join(directory, 'link');
    await symlink(file, link);
    await expect(loadEventSecret(link)).rejects.toThrow('MUSE_DATA_STATION_EVENTS_SECRET_FILE');
    await expect(loadEventSecret('secret')).rejects.toThrow('MUSE_DATA_STATION_EVENTS_SECRET_FILE');
  });
});

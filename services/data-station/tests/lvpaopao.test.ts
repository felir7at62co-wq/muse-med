import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { DataRepository } from '../src/server/repository.ts';
import { createApp } from '../src/server/app.ts';
import { createServiceIdentity } from '../src/server/hits/service-auth.ts';
import { LvpaopaoStore } from '../src/server/lvpaopao/store.ts';
import { LvpaopaoWatchdog } from '../src/server/lvpaopao/watchdog.ts';
import { DATA_PLATFORMS, type BoardDirectory, type CatalogResponse, type CollectorStatus, type UserIdentity } from '../src/shared/types.ts';
import type { LvpaopaoAdminStatus, LvpaopaoStatus } from '../src/shared/lvpaopao.ts';

const TOKEN = 'l'.repeat(43);
const OTHER = 't'.repeat(43);
const origin = 'http://127.0.0.1:4317';
const APP = 'wx0123456789abcdef';
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 1)]);
const users: Record<string, UserIdentity> = { member: { id: 'm1', name: '成员甲', role: 'member' }, admin: { id: 'a1', name: '管理员', role: 'admin' } };

function rankings(runId: string, observedAt: string, entries: { rank: number; dramaId: string; title?: string }[], status: 'complete' | 'failed' = 'complete') {
  return { schema: 1, runId, kind: 'rankings', slot: observedAt, startedAt: observedAt, finishedAt: observedAt, status, reason: status === 'failed' ? 'mac-asleep' : null,
    collector: { version: '1.0.0', host: 'test-mac' },
    rankings: status === 'failed' ? [] : [{ boardType: 6, boardName: '口碑榜', observedAt, total: 100, pagesRead: 1, partial: false,
      entries: entries.map(entry => ({ rank: entry.rank, title: entry.title ?? `剧${entry.dramaId}`, srcAppId: APP, dramaId: entry.dramaId })) }] };
}

function heartbeat(state = 'ok', loggedIn: boolean | null = true) {
  return { schema: 1, sentAt: new Date().toISOString(), state, message: state === 'ok' ? '已就绪' : '请扫码', wechat: { running: true, loggedIn },
    lastRun: null, nextSlot: '2026-11-15T04:00:00.000Z', pendingUploads: 0, collector: { version: '1.0.0', host: 'test-mac' } };
}

describe('绿泡泡 collector API', () => {
  let database: PGlite, repository: DataRepository, store: LvpaopaoStore, app: ReturnType<typeof createApp>['app'];
  let now = Date.parse('2026-11-15T01:00:00.000Z');
  const service = { 'x-muse-data-service-token': TOKEN };
  const call = (path: string, init: RequestInit & { json?: unknown } = {}) => app.request(`${origin}${path}`, {
    ...init, headers: { ...(init.json !== undefined ? { 'content-type': 'application/json' } : {}), ...init.headers as Record<string, string> },
    ...(init.json !== undefined ? { body: JSON.stringify(init.json) } : {}) });
  const admin = { 'test-user': 'admin', origin };
  beforeEach(async () => {
    now = Date.parse('2026-11-15T01:00:00.000Z');
    database = new PGlite();
    repository = new DataRepository(database);
    await repository.initialize({ seedDemo: false });
    store = new LvpaopaoStore(database, repository, { configured: true, offlineMs: 20 * 60_000, now: () => now });
    await store.initialize();
    ({ app } = createApp({ repository, service: createServiceIdentity(OTHER), lvpaopao: { store, service: createServiceIdentity(TOKEN, 'lvpaopao-collector') },
      identity: async request => users[request.headers.get('test-user') ?? ''] ?? null }));
  });
  afterEach(async () => { await database.close(); });

  it('lists 绿泡泡 right after 红果', () => {
    expect(DATA_PLATFORMS.slice(0, 2)).toEqual(['hongguo', 'lvpaopao']);
  });

  it('accepts only the collector token, without a browser origin', async () => {
    const body = heartbeat();
    expect((await call('/api/service/lvpaopao/heartbeat', { method: 'POST', json: body })).status).toBe(401);
    expect((await call('/api/service/lvpaopao/heartbeat', { method: 'POST', json: body, headers: { 'x-muse-data-service-token': OTHER } })).status).toBe(401);
    expect((await call('/api/service/lvpaopao/heartbeat', { method: 'POST', json: body, headers: { ...service, origin } })).status).toBe(403);
    expect((await call('/api/service/lvpaopao/heartbeat', { method: 'POST', json: body, headers: service })).status).toBe(200);
    expect((await call('/api/lvpaopao/status', { headers: service })).status).toBe(401);
  });

  it('answers 404 on collector routes when no token is configured', async () => {
    ({ app } = createApp({ repository, lvpaopao: { store }, identity: async request => users[request.headers.get('test-user') ?? ''] ?? null }));
    expect((await call('/api/service/lvpaopao/heartbeat', { method: 'POST', json: heartbeat(), headers: service })).status).toBe(404);
  });

  it('turns a ranking run into a 绿泡泡 board and accepts the same upload again without new history', async () => {
    const run = rankings('run-0001-rankings', '2026-11-15T01:00:00.000Z', [{ rank: 1, dramaId: '11' }, { rank: 2, dramaId: '12' }, { rank: 5, dramaId: '11' }]);
    const first = await call('/api/service/lvpaopao/runs', { method: 'POST', json: run, headers: service });
    expect(await first.json()).toEqual({ accepted: true, duplicate: false, works: 2 });
    expect(await (await call('/api/service/lvpaopao/runs', { method: 'POST', json: run, headers: service })).json()).toEqual({ accepted: true, duplicate: true, works: 0 });
    expect((await call('/api/service/lvpaopao/runs', { method: 'POST', json: { ...run, finishedAt: '2026-11-15T01:05:00.000Z' }, headers: service })).status).toBe(409);
    const directory = await (await call('/api/boards?platform=lvpaopao', { headers: admin })).json() as BoardDirectory;
    expect(directory).toEqual({ boards: ['绿泡泡 · 口碑榜'], defaultBoard: '绿泡泡 · 口碑榜' });
    const works = await (await call(`/api/works?platform=lvpaopao&board=${encodeURIComponent('绿泡泡 · 口碑榜')}&origin=live`, { headers: admin })).json() as CatalogResponse;
    expect(works.items.map(work => [work.sourceId, work.rank])).toEqual([[`${APP}:11`, 1], [`${APP}:12`, 2]]);
    const second = rankings('run-0002-rankings', '2026-11-15T04:00:00.000Z', [{ rank: 1, dramaId: '12' }, { rank: 2, dramaId: '11' }]);
    await call('/api/service/lvpaopao/runs', { method: 'POST', json: second, headers: service });
    const moved = await (await call(`/api/works?platform=lvpaopao&board=${encodeURIComponent('绿泡泡 · 口碑榜')}&origin=live`, { headers: admin })).json() as CatalogResponse;
    expect(moved.items.map(work => [work.sourceId, work.rankChange])).toEqual([[`${APP}:12`, 1], [`${APP}:11`, -1]]);
  });

  it('records a failed run for the gap list without writing works', async () => {
    const response = await call('/api/service/lvpaopao/runs', { method: 'POST', json: rankings('run-0003-missed', '2026-11-15T01:00:00.000Z', [], 'failed'), headers: service });
    expect(await response.json()).toEqual({ accepted: true, duplicate: false, works: 0 });
    expect(await repository.countLiveWorks('lvpaopao')).toBe(0);
    const status = await (await call('/api/admin/lvpaopao', { headers: admin })).json() as LvpaopaoAdminStatus;
    expect(status.runs).toMatchObject([{ runId: 'run-0003-missed', status: 'failed', reason: 'mac-asleep' }]);
  });

  it('attaches the latest engagement totals to later board observations', async () => {
    const engagement = { schema: 1, runId: 'run-0004-engagement', kind: 'engagement', slot: '2026-11-15T02:00:00.000Z', startedAt: '2026-11-15T02:00:00.000Z',
      finishedAt: '2026-11-15T02:10:00.000Z', status: 'partial', reason: 'budget-exhausted', collector: { version: '1.0.0', host: 'test-mac' },
      engagement: [{ srcAppId: APP, dramaId: '11', title: '剧11', observedAt: '2026-11-15T02:05:00.000Z', episodeCount: 3, partial: true, missingEpisodes: [3],
        episodes: [{ episodeNo: 1, likes: 10, comments: 2, recommendations: null, shares: 1 }, { episodeNo: 2, likes: 5, comments: null, recommendations: null, shares: 0 }] }] };
    expect((await call('/api/service/lvpaopao/runs', { method: 'POST', json: engagement, headers: service })).status).toBe(200);
    await call('/api/service/lvpaopao/runs', { method: 'POST', json: rankings('run-0005-rankings', '2026-11-15T04:00:00.000Z', [{ rank: 1, dramaId: '11' }]), headers: service });
    const work = (await repository.liveWorks('lvpaopao'))[0]!;
    expect(work.metrics.map(metric => [metric.key, metric.value])).toEqual([['likes', 15], ['comments', 2], ['recommendations', null], ['shares', 1]]);
    expect(work.metricsObservedAt).toBe('2026-11-15T02:05:00.000Z');
    expect(work.episodeCount).toBe(3);
  });

  it('delivers administrator commands with heartbeats until acknowledged', async () => {
    expect((await call('/api/admin/lvpaopao/commands', { method: 'POST', json: { action: 'start-login' }, headers: { 'test-user': 'member', origin } })).status).toBe(403);
    expect((await call('/api/admin/lvpaopao/commands', { method: 'POST', json: { action: 'start-login' }, headers: admin })).status).toBe(202);
    expect((await call('/api/collectors/lvpaopao/run', { method: 'POST', json: {}, headers: admin })).status).toBe(202);
    const { commands } = await (await call('/api/service/lvpaopao/heartbeat', { method: 'POST', json: heartbeat(), headers: service })).json() as { commands: { id: string; action: string }[] };
    expect(commands.map(command => command.action)).toEqual(['start-login', 'collect-now']);
    await call(`/api/service/lvpaopao/commands/${commands[0]!.id}/ack`, { method: 'POST', json: { result: 'done' }, headers: service });
    const next = await (await call('/api/service/lvpaopao/heartbeat', { method: 'POST', json: heartbeat(), headers: service })).json() as { commands: { action: string }[] };
    expect(next.commands.map(command => command.action)).toEqual(['collect-now']);
    now += 31 * 60_000;
    expect((await store.heartbeat(heartbeat() as never)).commands).toEqual([]);
  });

  it('shows the login screenshot to administrators only, and drops it once WeChat is logged in', async () => {
    expect((await call('/api/service/lvpaopao/login-screen', { method: 'PUT', json: { capturedAt: new Date(now).toISOString(), kind: 'qr', png: Buffer.from('not a png image at all').toString('base64') }, headers: service })).status).toBe(400);
    expect((await call('/api/service/lvpaopao/login-screen', { method: 'PUT', json: { capturedAt: new Date(now).toISOString(), kind: 'qr', png: PNG.toString('base64') }, headers: service })).status).toBe(200);
    await call('/api/service/lvpaopao/heartbeat', { method: 'POST', json: heartbeat('waiting-login', false), headers: service });
    expect((await call('/api/admin/lvpaopao/login-screen', { headers: { 'test-user': 'member' } })).status).toBe(403);
    const image = await call('/api/admin/lvpaopao/login-screen', { headers: admin });
    expect(image.headers.get('content-type')).toBe('image/png');
    expect(Buffer.from(await image.arrayBuffer()).equals(PNG)).toBe(true);
    const status = await (await call('/api/lvpaopao/status', { headers: { 'test-user': 'member' } })).json() as LvpaopaoStatus;
    expect(status).toMatchObject({ state: 'waiting-login', needsHuman: true, loginScreen: { kind: 'qr' } });
    await call('/api/service/lvpaopao/heartbeat', { method: 'POST', json: heartbeat('ok', true), headers: service });
    expect((await call('/api/admin/lvpaopao/login-screen', { headers: admin })).status).toBe(404);
  });

  it('alerts once when the Mac goes silent and reports the outage window when it returns', async () => {
    const sent: string[] = [];
    const watchdog = new LvpaopaoWatchdog(store, async text => { sent.push(text); });
    await store.heartbeat(heartbeat() as never);
    await watchdog.tick();
    now += 21 * 60_000;
    await watchdog.tick();
    await watchdog.tick();
    const card = (await repository.collectors()).find(item => item.platform === 'lvpaopao') as CollectorStatus;
    expect(card.state).toBe('failed');
    now += 60 * 60_000;
    await store.heartbeat(heartbeat('recovering', true) as never);
    await watchdog.tick();
    await store.heartbeat(heartbeat('ok', true) as never);
    await watchdog.tick();
    expect(sent).toHaveLength(2);
    expect(sent[0]).toContain('Mac 采集端失联');
    expect(sent[1]).toContain('已恢复');
    expect(sent[1]).toContain('11/15 09:21');
  });
});

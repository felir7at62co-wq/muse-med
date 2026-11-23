import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { strToU8, zipSync } from 'fflate';
import { DataRepository } from '../src/server/repository.ts';
import { createApp } from '../src/server/app.ts';
import { ScriptLibrary } from '../src/server/script-library.ts';
import { resolveHitRules, type HitRules } from '../src/server/hits/rules.ts';
import { HitStore } from '../src/server/hits/store.ts';
import { HitSelector } from '../src/server/hits/selector.ts';
import { createServiceIdentity } from '../src/server/hits/service-auth.ts';
import type { HongguoDetail } from '../src/server/collectors/hongguo-detail.ts';
import type { DouyinTopicCheck, HitBoard, TranscriptionJob } from '../src/shared/hits.ts';
import type { UserIdentity, Work } from '../src/shared/types.ts';

const HOUR = 3_600_000;
const T0 = Date.parse('2026-11-15T00:00:00.000Z');
const TOKEN = 's'.repeat(43);
const sid = (n: number) => `76000000000000000${String(n).padStart(2, '0')}`;
const wid = (n: number) => `hongguo:${sid(n)}`;

function drama(n: number, options: { title?: string; tags?: string[]; description?: string; collection?: number | null; board?: string; observedAt?: string } = {}): Work {
  const board = options.board ?? '综合热播榜';
  return { id: wid(n), sourceId: sid(n), platform: 'hongguo', kind: 'drama', title: options.title ?? `种田逆袭记${n}`, author: null,
    description: options.description ?? '乡村姑娘种田致富。', coverUrl: null, sourceUrl: `https://hongguoduanju.com/detail?series_id=${sid(n)}`,
    tags: options.tags ?? ['种田'], category: '', episodeCount: 60, wordCount: null, serialStatus: null, publishedAt: null,
    metrics: [{ key: 'heat', label: '热度', value: 1 }, { key: 'collection', label: '收藏', value: options.collection === undefined ? 500_000 : options.collection },
      { key: 'likes', label: '点赞', value: 1 }],
    rank: board ? n : null, rankChange: null, board, origin: 'live', observedAt: options.observedAt ?? new Date(T0).toISOString(), sourceUpdatedAt: null };
}

function detail(n: number, status: number | null, measuredAt: string, extra: Partial<HongguoDetail> = {}): HongguoDetail {
  return { seriesId: sid(n), title: null, description: null, tags: [], seriesStatus: status, episodeRightText: '全60集', episodeCount: 60, cast: [],
    heat: 10, collection: 300_000, likes: 5, rating: null, ratingCount: null, reviewCount: null, measuredAt, ...extra };
}

async function ingest(repository: DataRepository, works: Work[]): Promise<void> {
  const groups = new Map<string, Work[]>();
  for (const work of works) groups.set(`${work.platform}|${work.observedAt}`, [...groups.get(`${work.platform}|${work.observedAt}`) ?? [], work]);
  for (const [key, group] of groups) await repository.ingestBatch({ platform: key.split('|')[0] as Work['platform'], works: group, observedAt: group[0]!.observedAt, coverage: '测试' });
}

describe('transcription job table', () => {
  let database: PGlite, repository: DataRepository, store: HitStore, now: number, rules: HitRules;
  beforeEach(async () => {
    database = new PGlite();
    repository = new DataRepository(database);
    await repository.initialize({ seedDemo: false });
    now = T0;
    rules = resolveHitRules({ queue: { leaseMinutes: 10, maxAttempts: 2 } });
    store = new HitStore(database, rules, () => now);
    await store.initialize();
    await ingest(repository, [1, 2, 3, 4, 5].map(n => drama(n)));
  });
  afterEach(async () => { await database.close(); });

  it('orders claims: 立即转写 first, then new works oldest-qualified first, then backlog by 收藏', async () => {
    await store.enqueue(wid(1), { lane: 'backlog', qualifiedAt: new Date(T0 - 5 * HOUR).toISOString(), priority: 200_000 });
    await store.enqueue(wid(2), { lane: 'backlog', qualifiedAt: new Date(T0 - 4 * HOUR).toISOString(), priority: 900_000 });
    await store.enqueue(wid(3), { lane: 'new', qualifiedAt: new Date(T0 - 1 * HOUR).toISOString(), priority: 110_000 });
    await store.enqueue(wid(4), { lane: 'new', qualifiedAt: new Date(T0 - 2 * HOUR).toISOString(), priority: 120_000 });
    expect(await store.enqueue(wid(4), { lane: 'backlog', qualifiedAt: new Date(T0).toISOString(), priority: 1 })).toBe(false);
    await store.rush(wid(1), '成员甲', { qualifiedAt: null, priority: null });
    expect((await store.queue()).map(job => job.workId)).toEqual([wid(1), wid(4), wid(3), wid(2)]);
    const first = await store.claim({ workerId: 'w1' });
    expect(first?.job).toMatchObject({ workId: wid(1), state: 'downloading', attempts: 1, workerId: 'w1' });
  });

  it('claims idempotently per worker and never gives one drama to two workers', async () => {
    await store.enqueue(wid(1), { lane: 'new', qualifiedAt: new Date(T0).toISOString(), priority: 1 });
    await store.enqueue(wid(2), { lane: 'new', qualifiedAt: new Date(T0).toISOString(), priority: 1 });
    const a = await store.claim({ workerId: 'worker-a', workId: wid(1) });
    const again = await store.claim({ workerId: 'worker-a', workId: wid(1) });
    expect(again?.lease).toBe(a?.lease);
    expect(again?.job.attempts).toBe(1);
    await expect(store.claim({ workerId: 'worker-b', workId: wid(1) })).rejects.toMatchObject({ status: 409 });
    const both = await Promise.all([store.claim({ workerId: 'x' }), store.claim({ workerId: 'y' })]);
    expect(both.filter(Boolean).map(item => item!.job.workId)).toEqual([wid(2)]);
    expect(await store.claim({ workerId: 'z' })).toBeNull();
  });

  it('records progress as a heartbeat and resumes after a silent worker with progress kept', async () => {
    await store.enqueue(wid(1), { lane: 'new', qualifiedAt: new Date(T0).toISOString(), priority: 1 });
    const { lease } = (await store.claim({ workerId: 'w1' }))!;
    await store.progress(wid(1), lease, { state: 'transcribing', episode: 12, totalEpisodes: 65, message: '第 12 集写稿' });
    now += 9 * 60_000;
    await store.progress(wid(1), lease, {});
    now += 9 * 60_000;
    expect((await store.job(wid(1)))?.state).toBe('transcribing');
    now += 2 * 60_000;
    expect(await store.sweep()).toBe(1);
    const requeued = (await store.job(wid(1)))!;
    expect(requeued).toMatchObject({ state: 'queued', progress: { episode: 12, totalEpisodes: 65 }, lastError: { reason: '工人超过租约时间未汇报', stage: 'transcribing' } });
    await expect(store.progress(wid(1), lease, {})).rejects.toMatchObject({ status: 409 });
    const resumed = (await store.claim({ workerId: 'w2' }))!;
    expect(resumed.job).toMatchObject({ attempts: 2, progress: { episode: 12 } });
    now += 11 * 60_000;
    await store.sweep();
    expect((await store.job(wid(1)))?.state).toBe('needs-attention');
    await expect(store.progress(wid(1), resumed.lease, { episode: 70, totalEpisodes: 65 })).rejects.toThrow();
  });

  it('re-queues a retryable failure once, then fails; program-check failures go to 待处理', async () => {
    await store.enqueue(wid(1), { lane: 'new', qualifiedAt: new Date(T0).toISOString(), priority: 1 });
    let claim = (await store.claim({ workerId: 'w' }))!;
    expect((await store.fail(wid(1), claim.lease, { reason: '下载超时', stage: 'downloading' })).state).toBe('queued');
    claim = (await store.claim({ workerId: 'w' }))!;
    expect((await store.fail(wid(1), claim.lease, { reason: '下载超时' })).state).toBe('failed');
    await expect(store.claim({ workerId: 'w', workId: wid(1) })).rejects.toMatchObject({ status: 409 });
    const rushed = await store.rush(wid(1), '成员乙', { qualifiedAt: null, priority: null });
    expect(rushed).toMatchObject({ state: 'queued', attempts: 0, requestedBy: '成员乙' });
    claim = (await store.claim({ workerId: 'w' }))!;
    expect((await store.fail(wid(1), claim.lease, { reason: '检查两次未通过', needsAttention: true })).state).toBe('needs-attention');
    expect((await store.events(wid(1))).map(event => event.to)).toEqual(['queued', 'downloading', 'queued', 'downloading', 'failed', 'queued', 'downloading', 'needs-attention']);
  });

  it('accepts video archives only inside this drama’s download-video folder and builds public URLs itself', async () => {
    await store.enqueue(wid(1), { lane: 'new', qualifiedAt: new Date(T0).toISOString(), priority: 1 });
    const { lease } = (await store.claim({ workerId: 'w' }))!;
    const directory = `download-video-date/hongguo/20261115/${sid(1)}/`;
    const upload = { bucket: 'muse', date: '20261115', directory, directory_url: 'https://evil.example/x',
      objects: [{ kind: 'video', key: `${directory}video/001.mp4`, url: 'https://evil.example/1.mp4', bytes: 10, sha256: 'A'.repeat(64), status: 'uploaded' }],
      manifest: { key: `${directory}manifest.json`, url: 'https://evil.example/m' } };
    const job = await store.recordVideos(wid(1), lease, upload);
    expect(job.videos).toMatchObject({ directoryUrl: `https://muse.tos-cn-beijing.volces.com/${directory}`,
      manifest: { url: `https://muse.tos-cn-beijing.volces.com/${directory}manifest.json` },
      objects: [{ url: `https://muse.tos-cn-beijing.volces.com/${directory}video/001.mp4`, sha256: 'a'.repeat(64) }] });
    for (const bad of [{ ...upload, bucket: 'other' }, { ...upload, date: '20261332' }, { ...upload, directory: `download-video-date/hongguo/20261115/${sid(2)}/` },
      { ...upload, objects: [{ kind: 'video', key: `${directory}../x.mp4` }] }, { ...upload, objects: [{ kind: 'video', key: 'bgm/catalog.json' }] }]) {
      await expect(store.recordVideos(wid(1), lease, bad)).rejects.toMatchObject({ status: 422 });
    }
    await expect(store.recordVideos(wid(1), 'x'.repeat(32), upload)).rejects.toMatchObject({ status: 409 });
  });
});

describe('选材复核', () => {
  let database: PGlite, repository: DataRepository, store: HitStore, app: ReturnType<typeof createApp>['app'];
  const origin = 'http://127.0.0.1:4317';
  const headers = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };
  beforeEach(async () => {
    database = new PGlite();
    repository = new DataRepository(database);
    await repository.initialize({ seedDemo: false });
    // A table from before 选材复核: no rejected state, no review column.
    await database.exec(`CREATE TABLE transcription_jobs (work_id text PRIMARY KEY REFERENCES works(id),
      state text NOT NULL CHECK (state IN ('queued','downloading','transcribing','checking','published','failed','needs-attention')),
      lane text NOT NULL CHECK (lane IN ('manual','new','backlog')), priority double precision, qualified_at timestamptz NOT NULL, queued_at timestamptz NOT NULL,
      rush_at timestamptz, requested_by text, worker_id text, lease_id text, claimed_at timestamptz, heartbeat_at timestamptz, lease_expires_at timestamptz,
      attempts integer NOT NULL DEFAULT 0, progress jsonb, videos jsonb, script_id text, checks jsonb, last_error jsonb, published_at timestamptz,
      created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL)`);
    const rules = resolveHitRules({ review: { standard: '只转下沉剧' } });
    store = new HitStore(database, rules);
    await store.initialize();
    await ingest(repository, [drama(1, { tags: ['家长里短', '校园', '青春'], description: '高中生的家长里短与初恋。' }), drama(2)]);
    await store.enqueue(wid(1), { lane: 'new', qualifiedAt: new Date().toISOString(), priority: 500_000 });
    ({ app } = createApp({ repository, hits: { store, selector: new HitSelector(repository, store, null, { rules, intervalMs: 60_000 }) }, service: createServiceIdentity(TOKEN),
      identity: async () => ({ id: 'm1', name: '成员甲', role: 'member', department: '用户甲组' }) }));
  });
  afterEach(async () => { await database.close(); });

  it('gives the worker the whole drama and the standard, and ends a rejected drama for good', async () => {
    const claim = await (await app.request(`${origin}/api/service/hits/claim`, { method: 'POST', headers, body: JSON.stringify({ workerId: 'w1' }) })).json();
    expect(claim.review).toEqual({ required: true, standard: '只转下沉剧' });
    expect(claim.work).toMatchObject({ title: '种田逆袭记1', tags: ['家长里短', '校园', '青春'], description: '高中生的家长里短与初恋。', episodes: 60, collection: 500_000, ipMatch: 'none' });
    const reject = (body: unknown) => app.request(`${origin}/api/service/hits/jobs/${sid(1)}/reject`, { method: 'POST', headers, body: JSON.stringify(body) });
    expect((await reject({ lease: claim.lease, reason: '' })).status).toBe(400);
    expect((await reject({ lease: 'x'.repeat(32), reason: '受众偏年轻' })).status).toBe(409);
    const rejected = await (await reject({ lease: claim.lease, reason: '校园青春为主，整体受众偏年轻' })).json();
    expect(rejected).toMatchObject({ state: 'rejected', review: { reason: '校园青春为主，整体受众偏年轻', workerId: 'w1' }, leaseExpiresAt: null });
    expect((await reject({ lease: claim.lease, reason: '再来一次' })).status).toBe(409);
    expect(await store.enqueue(wid(1), { lane: 'new', qualifiedAt: new Date().toISOString(), priority: 1 })).toBe(false);
    expect(await (await app.request(`${origin}/api/service/hits/claim`, { method: 'POST', headers, body: JSON.stringify({ workerId: 'w2' }) })).json())
      .toEqual({ job: null, lease: null, work: null, review: null });
    const board = await (await app.request(`${origin}/api/hits/board?filter=rejected`)).json() as HitBoard;
    expect(board.items.map(item => item.work.id)).toEqual([wid(1)]);
    expect(board.summary.rejected).toBe(1);
    expect((await store.events(wid(1))).at(-1)).toMatchObject({ to: 'rejected', note: '校园青春为主，整体受众偏年轻' });

    // A member overrides the rejection: manual lane, so the next worker is not asked to review again.
    const rushed = await (await app.request(`${origin}/api/hits/${encodeURIComponent(wid(1))}/rush`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: '{}' })).json();
    expect(rushed).toMatchObject({ state: 'queued', lane: 'manual', attempts: 0, requestedBy: '成员甲（用户甲组）' });
    const again = await (await app.request(`${origin}/api/service/hits/claim`, { method: 'POST', headers, body: JSON.stringify({ workerId: 'w3' }) })).json();
    expect(again.review.required).toBe(false);
  });

  it('skips the review for a job a previous worker already accepted, and when review is off', async () => {
    const first = (await store.claim({ workerId: 'w1' }))!;
    await store.progress(wid(1), first.lease, { state: 'transcribing', episode: 3, totalEpisodes: 60 });
    await store.fail(wid(1), first.lease, { reason: '网络中断' });
    const resumed = await (await app.request(`${origin}/api/service/hits/claim`, { method: 'POST', headers, body: JSON.stringify({ workerId: 'w2' }) })).json();
    expect(resumed.review.required).toBe(false);
    const rules = resolveHitRules({ review: { enabled: false } });
    await store.enqueue(wid(2), { lane: 'backlog', qualifiedAt: new Date().toISOString(), priority: 1 });
    const { app: off } = createApp({ repository, hits: { store, selector: new HitSelector(repository, store, null, { rules, intervalMs: 60_000 }) }, service: createServiceIdentity(TOKEN), identity: async () => null });
    const claim = await (await off.request(`${origin}/api/service/hits/claim`, { method: 'POST', headers, body: JSON.stringify({ workerId: 'w4' }) })).json();
    expect(claim.review.required).toBe(false);
    expect(claim.review.standard).toContain('选材复核');
  });
});

describe('automatic selection', () => {
  let database: PGlite, repository: DataRepository, store: HitStore, now: number;
  let details: Map<string, HongguoDetail | null | Error>;
  let reads: string[];
  const rules = resolveHitRules({ detail: { requestIntervalMs: 0 }, douyin: { required: false } });
  const selector = () => new HitSelector(repository, store, null, { rules, intervalMs: 60_000, now: () => now,
    readDetail: async seriesId => { reads.push(seriesId); const value = details.get(seriesId); if (value instanceof Error) throw value; return value ?? null; } });
  beforeEach(async () => {
    database = new PGlite();
    repository = new DataRepository(database);
    await repository.initialize({ seedDemo: false });
    now = T0 + HOUR;
    store = new HitStore(database, rules, () => now);
    await store.initialize();
    details = new Map(); reads = [];
  });
  afterEach(async () => { await database.close(); });

  it('reads detail pages for 下沉 candidates and enqueues only works meeting all four conditions', async () => {
    const at = new Date(T0).toISOString();
    const old = new Date(T0 - 30 * 24 * HOUR).toISOString();
    await ingest(repository, [
      drama(1, { observedAt: old }),                                       // backlog: qualified, first seen a month ago
      drama(2),                                                            // new: first seen this hour
      drama(3, { collection: 100_000 }),                                   // 收藏 exactly 10万: not above
      drama(4),                                                            // 连载
      drama(5, { tags: ['悬疑'], title: '诡事录', description: '一桩命案。' }), // not 下沉: never read
      drama(6, { title: '傅总追妻', description: '傅承彦和温越的婚约。温越离开，傅承彦追悔。' }), // confirmed Fanqie IP
      drama(7, { title: '装穷提亲，娶到全家嫌弃的她', description: '顾承川装穷提亲。' }),  // suspected IP: still enqueued
      drama(8, { board: '', collection: null, observedAt: at }),           // catalog-only: 收藏 filled from the detail page
      { id: 'fanqie:1', sourceId: '1', platform: 'fanqie', kind: 'novel', title: '契约到期', author: null, description: '傅承彦与温越的契约婚姻。', coverUrl: null,
        sourceUrl: 'https://fanqienovel.com/', tags: [], category: '', episodeCount: null, wordCount: null, serialStatus: null, publishedAt: null,
        metrics: [], rank: 1, rankChange: null, board: '男频阅读榜', origin: 'live', observedAt: at, sourceUpdatedAt: null },
      { id: 'fanqie:2', sourceId: '2', platform: 'fanqie', kind: 'novel', title: '装穷提亲', author: null, description: '别的故事。', coverUrl: null,
        sourceUrl: 'https://fanqienovel.com/', tags: [], category: '', episodeCount: null, wordCount: null, serialStatus: null, publishedAt: null,
        metrics: [], rank: 2, rankChange: null, board: '男频阅读榜', origin: 'live', observedAt: at, sourceUpdatedAt: null },
    ]);
    const measured = new Date(now).toISOString();
    for (const n of [1, 2, 6, 7, 8]) details.set(sid(n), detail(n, 1, measured));
    details.set(sid(4), detail(4, 0, measured));
    const run = selector();
    await run.run();
    expect(reads.sort()).toEqual([1, 2, 4, 6, 7, 8].map(sid).sort());
    const candidates = await store.candidates();
    expect(candidates.get(wid(3))?.evaluation.unmet).toEqual(['收藏未超过 10万', '完结状态未知']);
    expect(candidates.get(wid(4))?.evaluation.unmet).toEqual(['连载中']);
    expect(candidates.has(wid(5))).toBe(false);
    expect(candidates.get(wid(6))?.evaluation).toMatchObject({ qualified: false, ip: { level: 'confirmed', fanqieWorkId: 'fanqie:1' } });
    expect(candidates.get(wid(7))?.evaluation).toMatchObject({ qualified: true, ip: { level: 'suspected', fanqieTitle: '装穷提亲' } });
    expect(candidates.get(wid(8))?.evaluation.collection).toMatchObject({ value: 300_000, source: 'detail' });
    expect((await repository.getWork(wid(8)))?.work.metrics.find(metric => metric.key === 'collection')?.value).toBe(300_000);
    expect((await store.qualifiedIds()).sort()).toEqual([...candidates].filter(([, record]) => record.qualified).map(([id]) => id).sort());
    expect([...(await store.candidatesFor([wid(4), wid(5), wid(7)])).entries()]).toEqual([wid(4), wid(7)].map(id => [id, candidates.get(id)]));
    expect(await store.candidatesFor([])).toEqual(new Map());
    expect((await store.detail(wid(4)))?.outcome).toBe((await store.details()).get(wid(4))?.outcome);
    expect(await store.detail(wid(5))).toBeUndefined();
    const jobs = new Map((await store.jobs()).map(job => [job.workId, job]));
    expect([...jobs.keys()].sort()).toEqual([1, 2, 7, 8].map(wid).sort());
    expect(jobs.get(wid(1))?.lane).toBe('backlog');
    expect(jobs.get(wid(2))?.lane).toBe('new');
    expect(run.status()).toMatchObject({ state: 'success', detailsRead: 6, enqueued: 4 });

    // A second run reads nothing new and keeps every job; a finished serial is re-read after the recheck interval.
    reads = [];
    await run.run();
    expect(reads).toEqual([]);
    now += 25 * HOUR;
    details.set(sid(4), detail(4, 1, new Date(now).toISOString()));
    await run.run();
    expect(reads).toEqual([sid(4)]);
    expect((await store.job(wid(4)))?.state).toBe('queued');
  });

  it('keeps going past a failed detail page and retries it later', async () => {
    await ingest(repository, [drama(1), drama(2)]);
    details.set(sid(1), new Error('HTTP 503'));
    details.set(sid(2), detail(2, 1, new Date(now).toISOString()));
    const run = selector();
    await run.run();
    expect(run.status()).toMatchObject({ detailsRead: 1, detailsFailed: 1 });
    expect((await store.candidates()).get(wid(1))?.evaluation.unmet).toEqual(['完结状态未知']);
    reads = [];
    await run.run();
    expect(reads).toEqual([]);
    now += 7 * HOUR;
    details.set(sid(1), detail(1, 1, new Date(now).toISOString()));
    await run.run();
    expect(reads).toEqual([sid(1)]);
    expect((await store.job(wid(1)))?.state).toBe('queued');
  });
});

describe('service API and 储备看板', () => {
  let database: PGlite, repository: DataRepository, store: HitStore, scripts: ScriptLibrary, app: ReturnType<typeof createApp>['app'], selector: HitSelector;
  const root = resolve(process.cwd(), '.data', `hit-tests-${randomUUID()}`);
  const origin = 'http://127.0.0.1:4317';
  const service = { authorization: `Bearer ${TOKEN}` };
  const member = { 'test-user': 'member' };
  const users: Record<string, UserIdentity> = { member: { id: 'm1', name: '成员甲', role: 'member' }, admin: { id: 'a1', name: '管理员', role: 'admin' } };
  const call = (path: string, init: RequestInit & { json?: unknown } = {}) => app.request(`${origin}${path}`, {
    ...init, headers: { ...(init.json !== undefined ? { 'content-type': 'application/json' } : {}), ...init.headers as Record<string, string> },
    ...(init.json !== undefined ? { body: JSON.stringify(init.json) } : {}) });
  beforeEach(async () => {
    database = new PGlite();
    repository = new DataRepository(database);
    await repository.initialize({ seedDemo: false });
    scripts = new ScriptLibrary(database, resolve(root, randomUUID(), 'script-files'));
    await scripts.initialize();
    const rules = resolveHitRules();
    store = new HitStore(database, rules);
    await store.initialize();
    selector = new HitSelector(repository, store, null, { rules, intervalMs: 60_000 });
    await ingest(repository, [drama(1), drama(2)]);
    await store.enqueue(wid(1), { lane: 'new', qualifiedAt: new Date(Date.now() - 2 * HOUR).toISOString(), priority: 500_000 });
    ({ app } = createApp({ repository, scripts, hits: { store, selector }, service: createServiceIdentity(TOKEN),
      identity: async request => users[request.headers.get('test-user') ?? ''] ?? null,
      accountIdentity: async request => request.headers.get('X-Muse-Account-Token') === 'a'.repeat(32) ? users.member! : { denied: 'login' } }));
  });
  afterEach(async () => { await selector.waitForIdle(); await database.close(); await rm(root, { recursive: true, force: true }); });

  it('serves desktop Muse the 数据 reads and 立即转写 through the member routes, as the account its token names', async () => {
    const desktop = (path: string, init: RequestInit & { json?: unknown } = {}, token = 'a'.repeat(32)) =>
      call(path, { ...init, headers: { 'X-Muse-Account-Token': token, ...init.headers as Record<string, string> } });
    expect((await desktop('/api/muse-client/data/hits/board?filter=all', {}, 'z'.repeat(32))).status).toBe(401);
    expect((await call('/api/muse-client/data/hits/board?filter=all', { headers: member })).status).toBe(401);
    expect((await desktop('/api/muse-client/data/hits/board?filter=all', { headers: { origin } })).status).toBe(403);
    const board = await (await desktop(`/api/muse-client/data/hits/board?filter=all&q=${sid(1)}`)).json() as HitBoard;
    expect(board.items.map(item => item.work.id)).toEqual([wid(1)]);
    expect((await desktop('/api/muse-client/data/boards?platform=hongguo')).status).toBe(200);
    expect((await desktop(`/api/muse-client/data/works/${encodeURIComponent(wid(1))}`)).status).toBe(200);
    const rushed = await desktop(`/api/muse-client/data/hits/${encodeURIComponent(wid(2))}/rush`, { method: 'POST', json: {} });
    expect(await rushed.json()).toMatchObject({ workId: wid(2), lane: 'manual', state: 'queued', requestedBy: '成员甲' });
    expect((await desktop(`/api/muse-client/data/hits/${encodeURIComponent(wid(2))}/rush`, { method: 'POST', body: '{}' })).status).toBe(415);
    expect((await desktop('/api/muse-client/data/admin/hits/run', { method: 'POST', json: {} })).status).toBe(404);
    expect((await desktop('/api/muse-client/data/service/hits/candidates')).status).toBe(404);
    expect((await desktop('/api/muse-client/data/hits/board', { method: 'POST', json: {} })).status).toBe(404);
    // A ticket header from outside names nobody, on the desktop path and on member routes alike.
    expect((await call(`/api/hits/${encodeURIComponent(wid(1))}/rush`, { method: 'POST', json: {}, headers: { 'x-muse-data-desktop-member': 'guess', origin } })).status).toBe(401);
  });

  it('accepts only the service token on service routes, and never the token on member routes', async () => {
    expect((await call('/api/service/hits/candidates')).status).toBe(401);
    expect((await call('/api/service/hits/candidates', { headers: member })).status).toBe(401);
    expect((await call('/api/service/hits/candidates', { headers: { authorization: `Bearer ${'x'.repeat(43)}` } })).status).toBe(401);
    expect((await call('/api/service/hits/candidates', { headers: { ...service, origin } })).status).toBe(403);
    expect((await call('/api/service/hits/claim', { method: 'POST', headers: service, body: 'workerId=w' })).status).toBe(415);
    const listed = await call('/api/service/hits/candidates', { headers: { 'x-muse-data-service-token': TOKEN } });
    expect(listed.status).toBe(200);
    expect((await listed.json()).queued.map((job: TranscriptionJob) => job.workId)).toEqual([wid(1)]);
    expect((await call('/api/hits/board', { headers: service })).status).toBe(401);
    const { app: without } = createApp({ repository, scripts, hits: { store, selector: new HitSelector(repository, store, null, { rules: resolveHitRules(), intervalMs: 60_000 }) },
      identity: async () => users.member! });
    expect((await without.request(`${origin}/api/service/hits/candidates`, { headers: service })).status).toBe(404);
  });

  it('runs a worker through claim, progress, videos and script upload to a downloadable script', async () => {
    const claimed = await (await call('/api/service/hits/claim', { method: 'POST', headers: service, json: { workerId: 'muse-worker-1' } })).json();
    expect(claimed.job).toMatchObject({ workId: wid(1), state: 'downloading' });
    const lease = claimed.lease as string;
    const progressed = await call(`/api/service/hits/jobs/${sid(1)}/progress`, { method: 'POST', headers: service, json: { lease, state: 'transcribing', episode: 3, totalEpisodes: 60 } });
    expect(await progressed.json()).toMatchObject({ state: 'transcribing', progress: { episode: 3, totalEpisodes: 60 } });
    const board = async (filter = 'all') => (await (await call(`/api/hits/board?filter=${filter}`, { headers: member })).json()) as HitBoard;
    expect((await board('active')).items[0]?.job).toMatchObject({ state: 'transcribing', progress: { episode: 3 } });
    expect(JSON.stringify(await board())).not.toContain(lease);
    const directory = `download-video-date/hongguo/20261115/${sid(1)}/`;
    expect((await call(`/api/service/hits/jobs/${encodeURIComponent(wid(1))}/videos`, { method: 'PUT', headers: service, json: { lease, upload: {
      bucket: 'muse', date: '20261115', directory, objects: [{ kind: 'video', key: `${directory}video/001.mp4`, bytes: 1 }], manifest: { key: `${directory}manifest.json` } } } })).status).toBe(200);
    const docx = zipSync({
      '[Content_Types].xml': strToU8('<Types><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml" /></Types>'),
      'word/document.xml': strToU8('<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>第1集</w:t></w:r></w:p></w:body></w:document>'),
    });
    const form = (checks: unknown, useLease = lease) => { const body = new FormData(); body.set('lease', useLease); body.set('checks', JSON.stringify(checks)); body.set('file', new File([new Uint8Array(docx)], '剧本.docx')); return body; };
    expect((await call(`/api/service/hits/jobs/${sid(1)}/script`, { method: 'POST', headers: service, body: form({ passed: false }) })).status).toBe(422);
    expect((await call(`/api/service/hits/jobs/${sid(1)}/script`, { method: 'POST', headers: service, body: form({ passed: true }, 'y'.repeat(32)) })).status).toBe(409);
    const published = await call(`/api/service/hits/jobs/${sid(1)}/script`, { method: 'POST', headers: service, body: form({ passed: true, summary: '60/60 集通过' }) });
    expect(published.status).toBe(201);
    const result = await published.json();
    expect(result.job).toMatchObject({ state: 'published', checks: { passed: true, summary: '60/60 集通过' } });
    expect((await call(`/api/service/hits/jobs/${sid(1)}/script`, { method: 'POST', headers: service, body: form({ passed: true }) })).status).toBe(201);
    const withScript = await board('script');
    expect(withScript.items.map(item => item.work.id)).toEqual([wid(1)]);
    expect(withScript.items[0]).toMatchObject({ script: { id: result.script.id }, job: { videos: { objects: [{ url: `https://muse.tos-cn-beijing.volces.com/${directory}video/001.mp4` }] } } });
    expect(withScript.summary).toMatchObject({ stock: 1, addedToday: 1, failures: 0, queued: 0 });
    expect(withScript.summary.averageHoursToDownload).toBeCloseTo(2, 0);
    expect((await call(`/api/scripts/${result.script.id}/download`, { headers: member })).status).toBe(200);
  });

  it('lets a member move a work to the front with 立即转写, from the page origin only', async () => {
    expect((await call(`/api/hits/${encodeURIComponent(wid(2))}/rush`, { method: 'POST', headers: member, json: {} })).status).toBe(403);
    const rushed = await call(`/api/hits/${encodeURIComponent(wid(2))}/rush`, { method: 'POST', headers: { ...member, origin }, json: {} });
    expect(await rushed.json()).toMatchObject({ workId: wid(2), lane: 'manual', state: 'queued', requestedBy: '成员甲' });
    const queue = await (await call('/api/service/hits/candidates', { headers: service })).json();
    expect(queue.queued.map((job: TranscriptionJob) => job.workId)).toEqual([wid(2), wid(1)]);
    expect((await call('/api/hits/hongguo:1/rush', { method: 'POST', headers: { ...member, origin }, json: {} })).status).toBe(404);
    expect((await call('/api/admin/hits/run', { method: 'POST', headers: { ...member, origin }, json: {} })).status).toBe(403);
    expect((await call('/api/admin/hits/run', { method: 'POST', headers: { 'test-user': 'admin', origin }, json: {} })).status).toBe(202);
  });
});

describe('Douyin topic gate', () => {
  let database: PGlite, repository: DataRepository, store: HitStore, now: number;
  let views: Map<string, DouyinTopicCheck['state'] | number>;
  let checks: { title: string; known: unknown }[];
  const rules = resolveHitRules({ detail: { requestIntervalMs: 0 }, douyin: { requestIntervalMs: 0 } });
  const check = (title: string, state: DouyinTopicCheck['state'], viewCount: number | null, manual = false, hashtagId: string | null = '1700000000000000009'): DouyinTopicCheck => ({
    state, keyword: title, topicName: state === 'not_found' ? null : title, hashtagId: state === 'not_found' ? null : hashtagId, viewCount, postCount: viewCount === null ? null : 10,
    checkedAt: new Date(now).toISOString(), manual, error: state === 'error' ? '抖音搜索太频繁，请稍等一会儿再试' : null });
  const selector = (checkTopic = true) => new HitSelector(repository, store, null, { rules, intervalMs: 60_000, now: () => now,
    readDetail: async seriesId => detail(Number(seriesId.slice(-2)), 1, new Date(now).toISOString()),
    ...(checkTopic ? { checkTopic: async (title: string, known: { hashtagId: string | null; manual: boolean } | null) => {
      checks.push({ title, known });
      const value = views.get(title) ?? 'not_found';
      if (typeof value === 'number') return check(title, value > rules.douyin.minPlays ? 'pass' : 'below', value, known?.manual ?? false, known?.hashtagId ?? '1700000000000000009');
      return check(title, value, null);
    } } : {}) });
  beforeEach(async () => {
    database = new PGlite();
    repository = new DataRepository(database);
    await repository.initialize({ seedDemo: false });
    now = T0 + HOUR;
    store = new HitStore(database, rules, () => now);
    await store.initialize();
    views = new Map(); checks = [];
    await ingest(repository, [drama(1, { title: '和离后我带女儿横扫魔域' }), drama(2, { title: '万物有声鉴宝天骄' }), drama(3, { title: '孝子归来报母恩' }),
      drama(4, { title: '谁让这个文盲修仙的' }), drama(5, { title: '种田小娘子', collection: 50_000 })]);
  });
  afterEach(async () => { await database.close(); });

  it('enqueues only dramas whose exact-name topic has more than 5000万 views, and never reads an error as a result', async () => {
    views.set('和离后我带女儿横扫魔域', 132_000_000);
    views.set('万物有声鉴宝天骄', 875_000);
    views.set('孝子归来报母恩', 'error');
    const run = selector();
    await run.run();
    expect(checks.map(item => item.title).sort()).toEqual(['万物有声鉴宝天骄', '和离后我带女儿横扫魔域', '孝子归来报母恩', '谁让这个文盲修仙的'].sort());
    const candidates = await store.candidates();
    expect(candidates.get(wid(1))?.evaluation).toMatchObject({ qualified: true, douyin: { state: 'pass', viewCount: 132_000_000 } });
    expect(candidates.get(wid(2))?.evaluation.unmet).toEqual(['抖音话题播放 87.5万 未超过 5000万']);
    expect(candidates.get(wid(3))?.evaluation.unmet).toEqual(['抖音话题查询失败：抖音搜索太频繁，请稍等一会儿再试']);
    expect(candidates.get(wid(4))?.evaluation.unmet).toEqual(['抖音没有同名话题']);
    expect(candidates.get(wid(5))?.evaluation.douyin).toBeNull();
    expect((await store.jobs()).map(job => job.workId)).toEqual([wid(1)]);

    // Errors retry after 2 hours; below and not-found dramas are rechecked after 24 hours with their known topic; passes are not rechecked.
    checks = [];
    now += 3 * HOUR;
    views.set('孝子归来报母恩', 338_000_000);
    await run.run();
    expect(checks.map(item => item.title)).toEqual(['孝子归来报母恩']);
    expect((await store.job(wid(3)))?.state).toBe('queued');
    checks = [];
    now += 24 * HOUR;
    views.set('万物有声鉴宝天骄', 60_000_000);
    await run.run();
    expect(checks.map(item => item.title).sort()).toEqual(['万物有声鉴宝天骄', '谁让这个文盲修仙的'].sort());
    expect(checks.find(item => item.title === '万物有声鉴宝天骄')?.known).toEqual({ hashtagId: '1700000000000000009', manual: false });
    expect((await store.job(wid(2)))?.state).toBe('queued');
  });

  it('keeps every drama out when topics cannot be checked, and accepts a topic set by hand', async () => {
    await selector(false).run();
    expect((await store.candidates()).get(wid(4))?.evaluation.unmet).toEqual(['抖音话题未检查']);
    expect(await store.jobs()).toEqual([]);
    const run = selector();
    views.set('谁让这个文盲修仙的', 244_000_000);
    expect(await run.setTopic(wid(4), '谁让这个文盲修仙的', '1712345678901234567')).toMatchObject({ state: 'pass', manual: true, hashtagId: '1712345678901234567' });
    await run.run();
    expect((await store.job(wid(4)))?.state).toBe('queued');
  });
});
